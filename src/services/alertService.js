/**
 * Alert Service — monitors platform health and sends notifications on critical events.
 *
 * Monitors:
 *   1. Calendar disconnection — polls Integration.connected status
 *   2. Server overload — monitors memory/CPU thresholds
 *   3. Booking rate drops to zero — checks TourBooking creation rate in rolling window
 *
 * Each alert includes: what broke, which school, timestamp.
 */

const os = require('os');
const Integration = require('../models/Integration');
const School = require('../models/School');
const TourBooking = require('../models/TourBooking');
const { sendEmail } = require('./mailService');

// ── Configurable thresholds ──────────────────────────────────────────────
const CONFIG = {
    // How often to run health checks (ms). Default: every 5 minutes.
    CHECK_INTERVAL_MS: parseInt(process.env.ALERT_CHECK_INTERVAL_MS || '300000', 10),

    // Calendar: fire alert if disconnected for this many consecutive checks
    CALENDAR_DISCONNECT_CONSECUTIVE_CHECKS: 2,

    // Memory: fire alert if heap used % exceeds this
    MEMORY_HEAP_THRESHOLD_PERCENT: 85,

    // Memory: fire alert if RSS exceeds this (MB)
    MEMORY_RSS_THRESHOLD_MB: 1024, // 1GB

    // Booking: fire alert if 0 bookings in this window (hours)
    BOOKING_ZERO_WINDOW_HOURS: parseInt(process.env.ALERT_BOOKING_WINDOW_HOURS || '24', 10),

    // Booking: only check during active hours (school local time, CST rough)
    BOOKING_ACTIVE_HOURS_START: 7,  // 7am
    BOOKING_ACTIVE_HOURS_END: 20,   // 8pm

    // Super admin email to receive all alerts
    SUPER_ADMIN_EMAIL: process.env.ALERT_ADMIN_EMAIL || process.env.ADMIN_EMAIL || '',
};

// ── State tracking ────────────────────────────────────────────────────────
let checkInterval = null;

// Track consecutive disconnection counts per school (schoolId -> count)
const disconnectCounts = new Map();

// Track last alert time per school per alert type to avoid spam
const lastAlertTime = new Map(); // key: `${schoolId}:${alertType}` -> timestamp

// Track last known booking count per school for rate checking
const lastBookingCounts = new Map(); // schoolId -> { count, timestamp }

/**
 * Get a human-readable alert key.
 */
function alertKey(schoolId, type) {
    return `${schoolId}:${type}`;
}

/**
 * Rate-limit: only send one alert per school per type every 30 minutes.
 */
function shouldSendAlert(schoolId, type) {
    const key = alertKey(schoolId, type);
    const last = lastAlertTime.get(key);
    if (!last) return true;
    const cooldownMs = 30 * 60 * 1000; // 30 min
    return (Date.now() - last) > cooldownMs;
}

/**
 * Record that an alert was just sent.
 */
function recordAlertSent(schoolId, type) {
    lastAlertTime.set(alertKey(schoolId, type), Date.now());
}

// ── Alert dispatcher ──────────────────────────────────────────────────────

/**
 * Send an alert to the super admin.
 * @param {string} title - Short description of the issue
 * @param {string} body - Detailed body (plain text / HTML)
 * @param {string} [schoolId] - Affected school (if applicable)
 */
async function dispatchAlert(title, body, schoolId = null) {
    const adminEmail = CONFIG.SUPER_ADMIN_EMAIL;
    if (!adminEmail) {
        console.warn('[AlertService] No SUPER_ADMIN_EMAIL configured — alert not sent:', title);
        return;
    }

    const htmlBody = `
        <div style="font-family: sans-serif; line-height: 1.6; color: #333; max-width: 600px; border-left: 4px solid #dc2626; padding: 20px;">
            <h2 style="color: #dc2626; margin-top: 0;">🚨 ${title}</h2>
            <p><strong>Time:</strong> ${new Date().toISOString()}</p>
            ${schoolId ? `<p><strong>School ID:</strong> ${schoolId}</p>` : ''}
            <hr style="border: 0; border-top: 1px solid #eee;">
            <div style="white-space: pre-wrap;">${body}</div>
        </div>
    `;

    try {
        // Use a system-level school (first active school) as the sender context
        // or fall back to SMTP directly
        const activeSchool = await School.findOne({ status: 'active' }).select('_id').lean();
        if (activeSchool) {
            await sendEmail(activeSchool._id, {
                to: adminEmail,
                subject: `[ALERT] ${title}`,
                text: body,
                html: htmlBody,
            });
        } else {
            // Fallback: raw SMTP
            const nodemailer = require('nodemailer');
            const transporter = nodemailer.createTransport({
                host: process.env.SMTP_HOST,
                port: Number(process.env.SMTP_PORT || 587),
                secure: process.env.SMTP_SECURE === 'true',
                auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS || process.env.SMTP_PASSWORD },
            });
            await transporter.sendMail({
                from: process.env.MAIL_FROM || process.env.EMAIL_FROM || process.env.SMTP_USER || 'noreply@nestops.com',
                to: adminEmail,
                subject: `[ALERT] ${title}`,
                text: body,
                html: htmlBody,
            });
        }
        console.log(`[AlertService] Alert dispatched: "${title}"`);
    } catch (err) {
        console.error(`[AlertService] Failed to dispatch alert "${title}":`, err.message);
    }
}

// ── Check 1: Calendar disconnection ───────────────────────────────────────

async function checkCalendarConnections() {
    try {
        const integrations = await Integration.find({
            connected: false,
            type: { $in: ['google', 'outlook'] }
        }).lean();

        // Also re-check "connected" integrations that might have stale tokens
        const connectedIntegrations = await Integration.find({
            connected: true,
            type: { $in: ['google', 'outlook'] }
        }).lean();

        for (const integration of connectedIntegrations) {
            let isEffectivelyDisconnected = false;

            if (integration.type === 'google') {
                if (!integration.config?.tokens?.access_token) {
                    isEffectivelyDisconnected = true;
                }
            } else if (integration.type === 'outlook') {
                if (!integration.config?.accessToken && !integration.config?.msalCache) {
                    isEffectivelyDisconnected = true;
                }
            }

            if (isEffectivelyDisconnected) {
                integrations.push(integration);
            }
        }

        // Group by school (only alert for integrations that were previously connected)
        const bySchool = new Map();
        for (const integration of integrations) {
            // Skip integrations that were never successfully connected (no connectedAt)
            if (!integration.connectedAt) continue;
            const sid = integration.schoolId.toString();
            if (!bySchool.has(sid)) bySchool.set(sid, []);
            bySchool.get(sid).push(integration);
        }

        for (const [schoolId, schoolIntegrations] of bySchool) {
            const prevCount = disconnectCounts.get(schoolId) || 0;
            const newCount = prevCount + 1;
            disconnectCounts.set(schoolId, newCount);

            if (newCount >= CONFIG.CALENDAR_DISCONNECT_CONSECUTIVE_CHECKS) {
                if (shouldSendAlert(schoolId, 'calendar_disconnect')) {
                    const school = await School.findById(schoolId).select('name').lean();
                    const schoolName = school?.name || 'Unknown School';
                    const types = schoolIntegrations.map(i => i.type).join(', ');

                    await dispatchAlert(
                        `Calendar Disconnected — ${schoolName}`,
                        `School: ${schoolName} (${schoolId})\n` +
                        `Disconnected providers: ${types}\n` +
                        `Detected at: ${new Date().toISOString()}\n` +
                        `Consecutive checks: ${newCount}\n\n` +
                        `Action required: Reconnect calendar in Integrations settings.`,
                        schoolId
                    );
                    recordAlertSent(schoolId, 'calendar_disconnect');
                }
            }
        }

        // Reset counters for schools that are now connected
        const connectedSchoolIds = new Set();
        const allConnected = await Integration.find({
            connected: true,
            type: { $in: ['google', 'outlook'] }
        }).select('schoolId').lean();
        allConnected.forEach(i => connectedSchoolIds.add(i.schoolId.toString()));

        for (const [schoolId] of disconnectCounts) {
            if (!bySchool.has(schoolId) && connectedSchoolIds.has(schoolId)) {
                disconnectCounts.delete(schoolId);
                console.log(`[AlertService] Calendar reconnected for school ${schoolId} — counter reset`);
            }
        }
    } catch (err) {
        console.error('[AlertService] checkCalendarConnections error:', err.message);
    }
}

// ── Check 2: Server resource overload ────────────────────────────────────

async function checkServerResources() {
    try {
        const memUsage = process.memoryUsage();
        const heapUsedMB = memUsage.heapUsed / 1024 / 1024;
        const heapTotalMB = memUsage.heapTotal / 1024 / 1024;
        const rssMB = memUsage.rss / 1024 / 1024;
        const heapPercent = (heapUsedMB / heapTotalMB) * 100;

        const cpus = os.cpus();
        const loadAvg = os.loadavg(); // 1, 5, 15 min
        const cpuCount = cpus.length;

        const issues = [];

        if (heapPercent > CONFIG.MEMORY_HEAP_THRESHOLD_PERCENT) {
            issues.push(`Heap usage: ${heapPercent.toFixed(1)}% (${heapUsedMB.toFixed(0)} MB / ${heapTotalMB.toFixed(0)} MB)`);
        }

        if (rssMB > CONFIG.MEMORY_RSS_THRESHOLD_MB) {
            issues.push(`RSS memory: ${rssMB.toFixed(0)} MB (threshold: ${CONFIG.MEMORY_RSS_THRESHOLD_MB} MB)`);
        }

        // Check if CPU load is critically high (load > CPU count)
        if (loadAvg[0] > cpuCount * 1.5) {
            issues.push(`CPU load (1m): ${loadAvg[0].toFixed(2)} (CPUs: ${cpuCount})`);
        }

        if (issues.length > 0) {
            const alertId = 'server_overload';
            if (shouldSendAlert('system', alertId)) {
                await dispatchAlert(
                    'Server Resource Overload',
                    `The server is experiencing high resource usage:\n\n` +
                    issues.map(i => `  • ${i}`).join('\n') +
                    `\n\nTotal memory: ${(os.totalmem() / 1024 / 1024 / 1024).toFixed(1)} GB` +
                    `\nFree memory: ${(os.freemem() / 1024 / 1024 / 1024).toFixed(1)} GB` +
                    `\nUptime: ${Math.floor(process.uptime() / 3600)}h ${Math.floor((process.uptime() % 3600) / 60)}m` +
                    `\n\nCheck Render dashboard for details.`,
                    null
                );
                recordAlertSent('system', alertId);
            }
        }
    } catch (err) {
        console.error('[AlertService] checkServerResources error:', err.message);
    }
}

// ── Check 3: Booking rate drops to zero ───────────────────────────────────

async function checkBookingRate() {
    try {
        // Only check during active hours (rough CST check)
        const now = new Date();
        const cstHour = new Date(now.toLocaleString('en-US', { timeZone: 'America/Chicago' })).getHours();
        if (cstHour < CONFIG.BOOKING_ACTIVE_HOURS_START || cstHour > CONFIG.BOOKING_ACTIVE_HOURS_END) {
            // Outside active hours — skip check
            return;
        }

        const windowStart = new Date(Date.now() - CONFIG.BOOKING_ZERO_WINDOW_HOURS * 60 * 60 * 1000);

        // Get all active schools
        const activeSchools = await School.find({ status: 'active' }).select('_id name').lean();

        for (const school of activeSchools) {
            const bookingCount = await TourBooking.countDocuments({
                schoolId: school._id,
                createdAt: { $gte: windowStart }
            });

            const prev = lastBookingCounts.get(school._id.toString());
            lastBookingCounts.set(school._id.toString(), { count: bookingCount, timestamp: Date.now() });

            if (bookingCount === 0) {
                // Only alert if we previously had bookings (so we know the school was active)
                if (prev && prev.count > 0 && prev.timestamp > Date.now() - CONFIG.BOOKING_ZERO_WINDOW_HOURS * 2 * 60 * 60 * 1000) {
                    if (shouldSendAlert(school._id, 'booking_zero')) {
                        await dispatchAlert(
                            `Zero Bookings — ${school.name}`,
                            `School: ${school.name} (${school._id})\n` +
                            `No tour bookings in the last ${CONFIG.BOOKING_ZERO_WINDOW_HOURS} hours.\n` +
                            `Previous booking count: ${prev.count}\n` +
                            `Window checked: ${windowStart.toISOString()} → now\n\n` +
                            `Possible causes: AI agent down, phone number disconnected, calendar integration broken.`,
                            school._id
                        );
                        recordAlertSent(school._id, 'booking_zero');
                    }
                }
            }
        }
    } catch (err) {
        console.error('[AlertService] checkBookingRate error:', err.message);
    }
}

// ── Main health check runner ──────────────────────────────────────────────

async function runAllChecks() {
    console.log('[AlertService] Running health checks...');
    await Promise.allSettled([
        checkCalendarConnections(),
        checkServerResources(),
        checkBookingRate(),
    ]);
}

/**
 * Initialize the alert service. Starts the polling interval.
 */
function initAlertService() {
    if (!CONFIG.SUPER_ADMIN_EMAIL) {
        console.warn('[AlertService] No ALERT_ADMIN_EMAIL configured — alerts will be logged but NOT sent.');
    }

    console.log(`[AlertService] Initializing — check interval: ${CONFIG.CHECK_INTERVAL_MS}ms`);
    console.log(`[AlertService] Memory threshold: ${CONFIG.MEMORY_HEAP_THRESHOLD_PERCENT}% heap, ${CONFIG.MEMORY_RSS_THRESHOLD_MB}MB RSS`);
    console.log(`[AlertService] Booking window: ${CONFIG.BOOKING_ZERO_WINDOW_HOURS}h`);

    // Run immediately on startup
    runAllChecks().catch(err => console.error('[AlertService] Initial check error:', err));

    // Then run on interval
    checkInterval = setInterval(() => {
        runAllChecks().catch(err => console.error('[AlertService] Interval check error:', err));
    }, CONFIG.CHECK_INTERVAL_MS);

    // Don't let the interval keep the process alive
    if (checkInterval.unref) {
        checkInterval.unref();
    }

    console.log('[AlertService] Initialized successfully');
}

/**
 * Stop the alert service (for graceful shutdown).
 */
function stopAlertService() {
    if (checkInterval) {
        clearInterval(checkInterval);
        checkInterval = null;
        console.log('[AlertService] Stopped');
    }
}

module.exports = { initAlertService, stopAlertService, dispatchAlert };
