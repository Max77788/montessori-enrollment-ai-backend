/**
 * Calendar Connection Health Check
 *
 * Periodically checks Google and Outlook calendar connections for all schools.
 * If a connection is broken (token expired, revoked, etc.), marks it as
 * disconnected and sends an email notification.
 *
 * Runs on server startup and every 6 hours thereafter.
 */

const Integration = require('../models/Integration');
const School = require('../models/School');
const { sendEmail } = require('./mailService');
const { google } = require('googleapis');

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const GOOGLE_REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI;
const SYSTEM_ADMIN_EMAIL = process.env.ALERT_ADMIN_EMAIL || '';

// ── Google health check ──────────────────────────────────────────────────────

async function checkGoogleConnection(integration) {
    if (!integration.config?.refreshToken) {
        return { ok: false, reason: 'No refresh token stored' };
    }

    try {
        const oauth2Client = new google.auth.OAuth2(
            GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI
        );
        oauth2Client.setCredentials({ refresh_token: integration.config.refreshToken });

        // Try to refresh the access token — this is the definitive test
        const { credentials } = await oauth2Client.refreshAccessToken();
        if (!credentials.access_token) {
            return { ok: false, reason: 'Token refresh returned no access token' };
        }

        // Persist the new token
        await Integration.findByIdAndUpdate(integration._id, {
            'config.accessToken': credentials.access_token,
            'config.expiry_date': credentials.expiry_date || null,
        });

        return { ok: true };
    } catch (err) {
        const msg = err.message || String(err);
        const isRevoked = msg.includes('invalid_grant') || msg.includes('Token has been revoked');
        return { ok: false, reason: isRevoked ? 'Token revoked — needs re-authorization' : msg };
    }
}

// ── Outlook health check ─────────────────────────────────────────────────────

async function checkOutlookConnection(integration) {
    try {
        // Use the existing refreshOutlookToken from calendarService
        const { pca, getMsalClient } = require('../routes/integrations');
        const schoolId = integration.schoolId;
        const account = integration.config?.account;

        if (!account) {
            return { ok: false, reason: 'No account in integration config' };
        }

        const client = getMsalClient(schoolId) || pca;
        if (!client) {
            return { ok: false, reason: 'MSAL client not configured' };
        }

        // Try silent token acquisition — if it fails, connection is broken
        const tokenCache = client.getTokenCache();
        const allAccounts = await tokenCache.getAllAccounts();

        if (allAccounts.length === 0) {
            return { ok: false, reason: 'No accounts in MSAL cache — needs re-login' };
        }

        const msalAccount = allAccounts.find(
            a => a.username?.toLowerCase() === account.username?.toLowerCase()
        ) || allAccounts[0];

        const silentRequest = {
            scopes: ['https://graph.microsoft.com/Calendars.ReadWrite', 'offline_access'],
            account: msalAccount,
        };

        const response = await client.acquireTokenSilent(silentRequest);

        if (!response?.accessToken) {
            return { ok: false, reason: 'Silent token acquisition failed — no access token returned' };
        }

        // Persist the new token
        await Integration.findByIdAndUpdate(integration._id, {
            'config.accessToken': response.accessToken,
            'config.expiresOn': response.expiresOn || null,
        });

        return { ok: true };
    } catch (err) {
        const msg = err.message || String(err);
        const isExpired = msg.includes('interaction_required') || msg.includes('AADSTS');
        return { ok: false, reason: isExpired ? 'Token expired or revoked — needs re-authorization' : msg };
    }
}

// ── Main health check runner ──────────────────────────────────────────────────

async function runCalendarHealthCheck() {
    console.log('[CalendarHealth] Starting calendar connection health check...');

    try {
        const integrations = await Integration.find({
            connected: true,
            type: { $in: ['google', 'outlook'] },
        }).lean();

        if (integrations.length === 0) {
            console.log('[CalendarHealth] No connected calendar integrations found.');
            return { checked: 0, broken: [] };
        }

        console.log(`[CalendarHealth] Checking ${integrations.length} integration(s)...`);

        const broken = [];

        for (const integration of integrations) {
            const school = await School.findById(integration.schoolId)
                .select('name adminEmail')
                .lean();

            const schoolName = school?.name || integration.schoolId.toString();
            const adminEmail = school?.adminEmail || '';

            console.log(`[CalendarHealth]   Checking ${integration.type} for "${schoolName}"...`);

            let result;
            if (integration.type === 'google') {
                result = await checkGoogleConnection(integration);
            } else {
                result = await checkOutlookConnection(integration);
            }

            if (!result.ok) {
                console.warn(`[CalendarHealth]   ❌ ${schoolName} (${integration.type}): ${result.reason}`);

                // Mark as disconnected in DB
                await Integration.findByIdAndUpdate(integration._id, {
                    connected: false,
                });

                broken.push({
                    schoolName,
                    type: integration.type,
                    reason: result.reason,
                    adminEmail,
                });

                // Send notification to school admin
                if (adminEmail) {
                    await sendNotification(adminEmail, schoolName, integration.type, result.reason);
                }
            } else {
                console.log(`[CalendarHealth]   ✅ ${schoolName} (${integration.type}): OK`);
            }
        }

        // Send summary to system admin if any connections broke
        if (broken.length > 0 && SYSTEM_ADMIN_EMAIL) {
            await sendSummaryToAdmin(broken);
        }

        console.log(`[CalendarHealth] Done. ${integrations.length} checked, ${broken.length} broken.`);
        return { checked: integrations.length, broken };
    } catch (err) {
        console.error('[CalendarHealth] Error during health check:', err);
        return { checked: 0, broken: [], error: err.message };
    }
}

// ── Notifications ────────────────────────────────────────────────────────────

async function sendNotification(toEmail, schoolName, type, reason) {
    try {
        await sendEmail(null, {
            to: toEmail,
            subject: `⚠️ ${type === 'google' ? 'Google' : 'Outlook'} Calendar Connection Lost — ${schoolName}`,
            html: `
                <h2>Calendar Connection Lost</h2>
                <p>The <strong>${type === 'google' ? 'Google' : 'Outlook'}</strong> calendar connection for <strong>${schoolName}</strong> has been disconnected.</p>
                <p><strong>Reason:</strong> ${reason}</p>
                <p>Please re-connect your calendar in <a href="${process.env.FRONTEND_URL || ''}/school/integrations">Settings → Integrations</a> to restore calendar sync.</p>
                <br/>
                <p style="color:#888;font-size:12px;">This is an automated health check from Nest Ops.</p>
            `,
        });
        console.log(`[CalendarHealth] Notification sent to ${toEmail}`);
    } catch (err) {
        console.error(`[CalendarHealth] Failed to send notification to ${toEmail}:`, err.message);
    }
}

async function sendSummaryToAdmin(broken) {
    try {
        const rows = broken.map(b =>
            `<tr><td>${b.schoolName}</td><td>${b.type}</td><td>${b.reason}</td></tr>`
        ).join('');

        await sendEmail(null, {
            to: SYSTEM_ADMIN_EMAIL,
            subject: `⚠️ Calendar Health Check — ${broken.length} connection(s) broken`,
            html: `
                <h2>Calendar Connection Health Report</h2>
                <p>The following calendar connections were found broken and have been marked as disconnected:</p>
                <table border="1" cellpadding="8" cellspacing="0" style="border-collapse:collapse;width:100%">
                    <tr style="background:#f5f5f5"><th>School</th><th>Type</th><th>Reason</th></tr>
                    ${rows}
                </table>
                <br/>
                <p style="color:#888;font-size:12px;">Automated check from Nest Ops. Affected schools have been notified separately.</p>
            `,
        });
        console.log(`[CalendarHealth] Summary sent to admin: ${SYSTEM_ADMIN_EMAIL}`);
    } catch (err) {
        console.error('[CalendarHealth] Failed to send admin summary:', err.message);
    }
}

// ── Scheduler ────────────────────────────────────────────────────────────────

let healthCheckInterval = null;

function startHealthCheck(intervalMs = 6 * 60 * 60 * 1000) {
    console.log(`[CalendarHealth] Starting periodic health check (every ${intervalMs / 3600000}h)`);

    // Run immediately on startup
    runCalendarHealthCheck().catch(err =>
        console.error('[CalendarHealth] Initial check failed:', err)
    );

    // Then run periodically
    healthCheckInterval = setInterval(() => {
        runCalendarHealthCheck().catch(err =>
            console.error('[CalendarHealth] Periodic check failed:', err)
        );
    }, intervalMs);
}

function stopHealthCheck() {
    if (healthCheckInterval) {
        clearInterval(healthCheckInterval);
        healthCheckInterval = null;
        console.log('[CalendarHealth] Health check stopped.');
    }
}

module.exports = { runCalendarHealthCheck, startHealthCheck, stopHealthCheck };
