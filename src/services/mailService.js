const { google } = require('googleapis');
const axios = require('axios');
const nodemailer = require('nodemailer');
const Integration = require('../models/Integration');
const School = require('../models/School');
const { refreshOutlookToken } = require('./calendarService');

/**
 * Known internal/tenant domains. Emails to these domains are flagged
 * as possibly being re-routed by Microsoft when sent via Graph API.
 * Added aifusioniqlabs.com per Ben's report of missing emails.
 */
const SUSPECT_INTERNAL_DOMAINS = (process.env.INTERNAL_DOMAINS || '')
    .split(',')
    .map(d => d.trim().toLowerCase())
    .filter(Boolean);

/**
 * Check if a recipient domain might be treated as internal by Microsoft.
 */
function isSuspectInternalDomain(email) {
    const domain = (email || '').split('@')[1]?.toLowerCase();
    if (!domain) return false;
    if (SUSPECT_INTERNAL_DOMAINS.includes(domain)) return true;
    return false;
}

/**
 * Creates a Google OAuth2 client for a school's integration.
 */
function createGoogleOAuthClient() {
    return new google.auth.OAuth2(
        process.env.GOOGLE_CLIENT_ID,
        process.env.GOOGLE_CLIENT_SECRET,
        process.env.GOOGLE_REDIRECT_URI
    );
}

/**
 * Sends an email using the best available method for the school.
 * Priorities: 
 * 1. Gmail API (if Google connected)
 * 2. Outlook/Graph API (if Outlook connected)
 * 3. Fallback to System SMTP
 * 
 * @param {string} schoolId - MongoDB ObjectId
 * @param {object} opts - { to, subject, text, html, attachments?: [{ filename, content }] }
 */
async function sendEmail(schoolId, opts) {
    const { to, subject, text, html, attachments } = opts;
    const startTime = Date.now();

    console.log(`[MailService] ======== SEND EMAIL ========`);
    console.log(`[MailService] To: ${to}`);
    console.log(`[MailService] Subject: ${subject}`);
    console.log(`[MailService] School: ${schoolId}`);

    // Check for suspect internal domain
    if (to && isSuspectInternalDomain(to)) {
        console.warn(`[MailService] ⚠️ Recipient domain "${to.split('@')[1]}" is flagged as suspect internal domain.`);
        console.warn(`[MailService] If sent via Outlook Graph API, Microsoft may treat this as internal mail and re-route or drop silently.`);
        console.warn(`[MailService] Will prefer Gmail API or SMTP for this recipient.`);
    }

    try {
        const [school, integrations] = await Promise.all([
            School.findById(schoolId).select('preferredEmailProvider').lean(),
            Integration.find({ schoolId, connected: true }).lean()
        ]);

        const preferred = school?.preferredEmailProvider || 'google';
        const recipientIsInternal = to && isSuspectInternalDomain(to);

        // If recipient domain is suspect-internal and we'd normally use Outlook,
        // force-skip Outlook to avoid Microsoft internal routing
        let providers;
        if (recipientIsInternal && preferred === 'outlook') {
            console.log(`[MailService] Skipping Outlook (suspect internal domain) → trying Gmail then SMTP`);
            providers = ['google'];
        } else {
            providers = preferred === 'outlook' ? ['outlook', 'google'] : ['google', 'outlook'];
        }

        let lastError = null;

        for (const type of providers) {
            const integration = integrations.find(i => i.type === type);
            if (!integration) {
                console.log(`[MailService] No ${type} integration found, skipping`);
                continue;
            }

            try {
                let result;
                if (type === 'google' && integration.config?.tokens) {
                    result = await sendViaGmail(integration, opts);
                } else if (type === 'outlook' && integration.config) {
                    // Double-check: don't send to internal domain via Outlook
                    if (recipientIsInternal) {
                        console.warn(`[MailService] Skipping Outlook for internal domain ${to.split('@')[1]} — routing via next provider`);
                        continue;
                    }
                    result = await sendViaOutlook(integration, opts);
                } else {
                    continue;
                }

                if (result && result.success) {
                    const elapsed = Date.now() - startTime;
                    console.log(`[MailService] ✅ DELIVERED via ${result.method} in ${elapsed}ms`);
                    console.log(`[MailService] ==============================`);
                    return { ...result, delivered: true, deliveryMethod: result.method, latencyMs: elapsed };
                } else {
                    lastError = result?.error || 'Unknown error';
                }
            } catch (err) {
                lastError = err.message;
                console.warn(`[MailService] Send via ${type} failed for school ${schoolId}:`, err.message);
            }
        }

        // 3. Last fallback to system SMTP if configured
        console.log(`[MailService] No suitable integration found or all failed, falling back to SMTP.`);
        const smtpResult = await sendViaSMTP(opts);
        const elapsed = Date.now() - startTime;
        if (smtpResult.success) {
            console.log(`[MailService] ✅ DELIVERED via SMTP fallback in ${elapsed}ms`);
        } else {
            console.error(`[MailService] ❌ ALL DELIVERY METHODS FAILED. Last error: ${lastError || smtpResult.error}`);
        }
        console.log(`[MailService] ==============================`);
        return { ...smtpResult, delivered: smtpResult.success, deliveryMethod: 'smtp', latencyMs: elapsed };

    } catch (err) {
        const elapsed = Date.now() - startTime;
        console.error(`[MailService] ❌ Unified send error (${elapsed}ms):`, err.message);
        console.log(`[MailService] ==============================`);
        try {
            return await sendViaSMTP(opts);
        } catch (smtpErr) {
            return { success: false, delivered: false, error: smtpErr.message, deliveryMethod: 'none', latencyMs: elapsed };
        }
    }
}

async function sendViaGmail(integration, { to, subject, text, html, attachments }) {
    const oauth2Client = createGoogleOAuthClient();
    const tokens = integration.config.tokens;
    oauth2Client.setCredentials(tokens);

    // Refresh token listener
    oauth2Client.on('tokens', async (newTokens) => {
        await Integration.updateOne(
            { _id: integration._id },
            { $set: { 'config.tokens': { ...tokens, ...newTokens } } }
        );
    });

    const gmail = google.gmail({ version: 'v1', auth: oauth2Client });
    const utf8Subject = `=?utf-8?B?${Buffer.from(subject).toString('base64')}?=`;
    const bodyContent = html || text.replace(/\n/g, '<br>');

    let rawMessage;
    if (attachments && attachments.length > 0) {
        const boundary = `boundary_${Date.now()}_${Math.random().toString(36).slice(2)}`;
        const bodyPart = [
            `Content-Type: text/html; charset=utf-8`,
            'Content-Transfer-Encoding: base64',
            '',
            Buffer.from(bodyContent).toString('base64')
        ].join('\r\n');
        const attachmentParts = attachments.map(att => {
            const content = typeof att.content === 'string' ? att.content : (att.content || '').toString();
            return [
                `Content-Type: application/ics; name="${(att.filename || 'invite.ics').replace(/"/g, '')}"`,
                'Content-Transfer-Encoding: base64',
                'Content-Disposition: attachment',
                '',
                Buffer.from(content).toString('base64')
            ].join('\r\n');
        });
        rawMessage = [
            `To: ${to}`,
            'MIME-Version: 1.0',
            `Subject: ${utf8Subject}`,
            `Content-Type: multipart/mixed; boundary="${boundary}"`,
            '',
            `--${boundary}`,
            bodyPart,
            `--${boundary}`,
            attachmentParts.join(`\r\n--${boundary}\r\n`),
            `--${boundary}--`
        ].join('\r\n');
    } else {
        rawMessage = [
            `To: ${to}`,
            'Content-Type: text/html; charset=utf-8',
            'MIME-Version: 1.0',
            `Subject: ${utf8Subject}`,
            '',
            bodyContent
        ].join('\r\n');
    }

    const encodedMessage = Buffer.from(rawMessage)
        .toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');

    const res = await gmail.users.messages.send({
        userId: 'me',
        requestBody: { raw: encodedMessage }
    });

    console.log('[MailService] Email sent via Gmail API:', res.data.id);
    return { success: true, method: 'gmail', messageId: res.data.id };
}

async function sendViaOutlook(integration, { to, subject, text, html, attachments }) {
    const accessToken = await refreshOutlookToken(integration);
    if (!accessToken) throw new Error('Outlook token refresh failed');

    const message = {
        subject: subject,
        body: {
            contentType: html ? 'HTML' : 'Text',
            content: html || text
        },
        toRecipients: [
            { emailAddress: { address: to } }
        ]
    };
    if (attachments && attachments.length > 0) {
        message.attachments = attachments.map(att => {
            const content = typeof att.content === 'string' ? att.content : (att.content || '').toString();
            return {
                '@odata.type': '#microsoft.graph.fileAttachment',
                name: att.filename || 'invite.ics',
                contentType: 'text/calendar',
                contentBytes: Buffer.from(content).toString('base64')
            };
        });
    }
    const res = await axios.post(
        'https://graph.microsoft.com/v1.0/me/sendMail',
        { message },
        {
            headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
            validateStatus: null // Don't throw — we want the status code
        }
    );

    // Graph API /sendMail returns 202 Accepted (not 200 OK).
    // 202 means Microsoft accepted the message for delivery, NOT that it was delivered.
    if (res.status === 202) {
        console.log(`[MailService:Outlook] Message accepted by Microsoft (202). Delivery is NOT confirmed.`);
        console.log(`[MailService:Outlook] If recipient doesn't receive the email, their domain may be treated as internal by the tenant.`);
        return {
            success: true,
            method: 'outlook',
            deliveryConfirmed: false, // Graph API does not confirm delivery
            note: 'Message accepted by Microsoft for delivery. Actual delivery not guaranteed.'
        };
    }

    if (res.status < 200 || res.status >= 300) {
        const errorData = res.data?.error;
        throw new Error(`Graph API returned ${res.status}: ${errorData?.message || 'Unknown error'}`);
    }

    console.log('[MailService] Email sent via Outlook API');
    return { success: true, method: 'outlook', deliveryConfirmed: false };
}

async function sendViaSMTP({ to, subject, text, html, attachments }) {
    const host = process.env.SMTP_HOST;
    const port = process.env.SMTP_PORT || 587;
    const user = process.env.SMTP_USER;
    const pass = process.env.SMTP_PASS || process.env.SMTP_PASSWORD;
    const from = process.env.MAIL_FROM || process.env.EMAIL_FROM || user || 'noreply@nestops.com';

    if (!host || !user || !pass) {
        throw new Error('SMTP not configured');
    }

    const transporter = nodemailer.createTransport({
        host,
        port: Number(port),
        secure: process.env.SMTP_SECURE === 'true',
        auth: { user, pass },
    });

    const mailOpts = { from, to, subject, text, html };
    if (attachments && attachments.length > 0) {
        mailOpts.attachments = attachments.map(att => ({
            filename: att.filename || 'invite.ics',
            content: typeof att.content === 'string' ? att.content : (att.content || '')
        }));
    }
    const info = await transporter.sendMail(mailOpts);

    console.log('[MailService] Email sent via SMTP:', info.messageId);
    return { success: true, method: 'smtp', messageId: info.messageId };
}

module.exports = { sendEmail };
