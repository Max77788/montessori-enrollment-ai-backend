const cron = require('node-cron');
const TourBooking = require('../models/TourBooking');
const School = require('../models/School');
const Followup = require('../models/Followup');
const Integration = require('../models/Integration');
const { sendTourConfirmation } = require('./automation');
const { sendEmail } = require('./mailService');

/**
 * Initialize background cron jobs for reminders and follow-ups
 */
function initReminderService() {
    console.log('[Reminder Service] Initializing cron jobs...');

    // Run every hour to check for reminders and follow-ups
    cron.schedule('0 * * * *', async () => {
        console.log('[Reminder Service] Running hourly check...');
        await sendUpcomingReminders();
        await sendPostTourFollowups();
    });

    // Run once daily at 9:07 AM CST to check token expiry
    cron.schedule('7 9 * * *', async () => {
        console.log('[Reminder Service] Running daily token expiry check...');
        await checkMicrosoftTokenExpiry();
    });
}

/**
 * Send SMS reminders for tours happening tomorrow (24h before)
 */
async function sendUpcomingReminders() {
    try {
        const now = new Date();
        const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);
        const soon = new Date(tomorrow.getTime() + 65 * 60 * 1000); // 1h buffer

        // Find bookings scheduled between 24 and 25 hours from now
        const bookings = await TourBooking.find({
            scheduledAt: { $gte: tomorrow, $lt: soon },
            reminderSent: false
        });

        console.log(`[Reminder Service] Found ${bookings.length} upcoming tours for reminders.`);

        for (const booking of bookings) {
            const school = await School.findById(booking.schoolId);
            if (!school) continue;


            booking.reminderSent = true;
            await booking.save();
        }
    } catch (err) {
        console.error('[Reminder Service] Error in upcoming reminders:', err);
    }
}

/**
 * Send SMS/Email follow-up "Thank you" 24 hours AFTER the tour
 */
async function sendPostTourFollowups() {
    try {
        const now = new Date();
        const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
        const older = new Date(yesterday.getTime() - 65 * 60 * 1000);

        // Find bookings that happened exactly 24h ago
        const bookings = await TourBooking.find({
            scheduledAt: { $gte: older, $lt: yesterday },
            followupSent: false
        });

        console.log(`[Reminder Service] Found ${bookings.length} completed tours for follow-ups.`);

        for (const booking of bookings) {
            const school = await School.findById(booking.schoolId);
            if (!school) continue;


            booking.followupSent = true;
            await booking.save();
        }
    } catch (err) {
        console.error('[Reminder Service] Error in post-tour follow-ups:', err);
    }
}


/**
 * Check Microsoft Outlook token expiry dates and alert admin 30 days before.
 * Also logs the expiry date for visibility in admin panel.
 */
async function checkMicrosoftTokenExpiry() {
    try {
        const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
        const now = new Date();
        const alertWindow = new Date(now.getTime() + THIRTY_DAYS_MS);

        // Find all Outlook integrations with known expiry dates
        const outlookIntegrations = await Integration.find({
            type: 'outlook',
            connected: true,
            'config.expiresOn': { $exists: true, $ne: null }
        }).lean();

        for (const integration of outlookIntegrations) {
            const expiresOn = integration.config.expiresOn
                ? new Date(integration.config.expiresOn)
                : null;

            if (!expiresOn) continue;

            const daysUntilExpiry = Math.ceil((expiresOn.getTime() - now.getTime()) / (24 * 60 * 60 * 1000));

            // Log token expiry for admin visibility regardless
            console.log(`[Token Expiry] School ${integration.schoolId}: Outlook token expires in ${daysUntilExpiry} days (${expiresOn.toISOString()})`);

            // Store visible expiry date on the integration record
            if (!integration.config.tokenExpiryLogged) {
                await Integration.updateOne(
                    { _id: integration._id },
                    {
                        $set: {
                            'config.tokenExpiryDate': expiresOn,
                            'config.tokenExpiryLogged': true,
                        }
                    }
                );
            }

            // Alert if expiring within 30 days — only alert once
            if (expiresOn <= alertWindow && !integration.config.expiryWarningSent) {
                const school = await School.findById(integration.schoolId).select('name adminEmail').lean();
                const schoolName = school?.name || 'Unknown School';

                console.warn(`[Token Expiry] ⚠️ Outlook token for ${schoolName} expires in ${daysUntilExpiry} days!`);

                // Mark warning as sent
                await Integration.updateOne(
                    { _id: integration._id },
                    { $set: { 'config.expiryWarningSent': true } }
                );

                // Send alert to super admin
                const adminEmail = process.env.ALERT_ADMIN_EMAIL || process.env.ADMIN_EMAIL;
                if (adminEmail) {
                    try {
                        const activeSchool = await School.findOne({ status: 'active' }).select('_id').lean();
                        if (activeSchool) {
                            await sendEmail(activeSchool._id, {
                                to: adminEmail,
                                subject: `⚠️ Microsoft Token Expiring — ${schoolName} (${daysUntilExpiry} days)`,
                                text: `The Microsoft Outlook integration token for ${schoolName} will expire in ${daysUntilExpiry} days.\n\n` +
                                    `School: ${schoolName} (${integration.schoolId})\n` +
                                    `Expiry date: ${expiresOn.toISOString()}\n` +
                                    `Account: ${integration.config.account?.username || 'Unknown'}\n\n` +
                                    `ACTION REQUIRED: Renew the Microsoft token before expiry to prevent calendar and email disruptions.\n` +
                                    `To renew: Go to School Settings → Integrations → Disconnect and Reconnect Microsoft Outlook.`,
                                html: `<div style="font-family:sans-serif;line-height:1.6;padding:20px;border-left:4px solid #f59e0b;">
                                    <h2 style="color:#d97706;">⚠️ Microsoft Token Expiring</h2>
                                    <p>The Outlook integration for <strong>${schoolName}</strong> will expire in <strong>${daysUntilExpiry} days</strong>.</p>
                                    <p><strong>School:</strong> ${schoolName} (${integration.schoolId})<br>
                                    <strong>Expiry:</strong> ${expiresOn.toISOString()}<br>
                                    <strong>Account:</strong> ${integration.config.account?.username || 'Unknown'}</p>
                                    <hr>
                                    <p><strong>Action:</strong> Go to School Settings → Integrations → Disconnect and Reconnect Microsoft Outlook to renew.</p>
                                </div>`
                            });
                        }
                    } catch (emailErr) {
                        console.error('[Token Expiry] Failed to send expiry alert:', emailErr.message);
                    }
                }
            }
        }
    } catch (err) {
        console.error('[Reminder Service] Token expiry check error:', err.message);
    }
}

module.exports = { initReminderService, checkMicrosoftTokenExpiry };
