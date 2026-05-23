const express = require('express');
const mongoose = require('mongoose');
const { google } = require('googleapis');
const ElevenLabsWebhook = require('../models/ElevenLabsWebhook');
const School = require('../models/School');
const User = require('../models/User');
const TourBooking = require('../models/TourBooking');
const Followup = require('../models/Followup');
const Integration = require('../models/Integration');
const { processTranscript } = require('../services/openaiService');
const { generateWordCloud } = require('../utils/openai');
const { createCalendarEvent, isSlotAvailable } = require('../services/calendarService');
const { sendEmail } = require('../services/mailService');
const { generateICS } = require('../utils/ics');
const { parseLocalDateTimeToUTC } = require('../utils/timezone');
const { deductCallMinutes } = require('../services/billingService');
const jwt = require('jsonwebtoken');
const JWT_SECRET = process.env.JWT_SECRET || 'nest-ops-secret-key-2026';

const router = express.Router();

/**
 * POST /api/v1/webhook/elevenlabs
 * Webhook endpoint to receive call transcript and recording data from ElevenLabs API
 * No authentication required - called by ElevenLabs service
 */
router.post('/elevenlabs', async (req, res) => {
    const payload = req.body || {};
    // Log synchronously so Render (and other PaaS) always show something when webhook is hit
    console.log('[Webhook] Received POST type=', payload?.type || 'unknown', 'conversation_id=', payload?.data?.conversation_id || 'n/a');

    // Immediately acknowledge receipt with 200 OK
    res.status(200).json({
        status: 'received',
        message: 'Webhook received successfully'
    });

    // Process webhook asynchronously (after sending response)
    processWebhookAsync(payload).catch(err => {
        console.error('[Webhook] Async processing error:', err);
    });
});

/**
 * Asynchronously process the webhook payload
 */
async function processWebhookAsync(payload) {
    try {
        // Log summary only; full payload can be huge (transcript + base64 audio) and gets truncated/dropped on Render
        const payloadData = payload?.data || {};
        const payloadSummary = {
            type: payload?.type,
            conversation_id: payloadData.conversation_id,
            transcript_length: Array.isArray(payloadData.transcript) ? payloadData.transcript.length : 0,
            has_audio: Boolean(payloadData.full_audio),
            metadata_keys: payloadData.metadata ? Object.keys(payloadData.metadata) : []
        };
        console.log('[Webhook] ========================================');
        console.log('[Webhook] Processing payload:', JSON.stringify(payloadSummary));
        console.log('[Webhook] ========================================');

        if (!payload || !payload.type) {
            console.warn('[Webhook] Invalid payload: missing type field');
            return;
        }

        const { type, data } = payload;

        if (!data) {
            console.warn('[Webhook] Invalid payload: missing data field');
            return;
        }

        // Extract common fields
        const conversationId = data.conversation_id || '';
        const agentId = data.agent_id || '';
        const agentName = data.agent_name || '';
        const userId = data.user_id || '';
        const status = data.status || '';
        const metadata = data.metadata || {};

        // Find associated school first to link the record
        const schoolIdString = await findSchoolForWebhook(data);
        const schoolId = schoolIdString ? new mongoose.Types.ObjectId(schoolIdString) : null;

        // Prepare webhook document based on type
        let webhookDoc = {
            type: type,
            conversation_id: conversationId,
            agent_id: agentId,
            agent_name: agentName,
            user_id: userId,
            status: status,
            metadata: metadata,
            raw_payload: payload, // Store full payload for debugging
            processed: false,
            received_at: new Date(),
            schoolId: schoolId
        };

        // Handle different webhook types
        if (type === 'post_call_transcription') {
            console.log('[Webhook] Processing post_call_transcription webhook');
            console.log('[Webhook] Conversation ID:', conversationId);
            console.log('[Webhook] Transcript entries:', Array.isArray(data.transcript) ? data.transcript.length : 0);

            webhookDoc.transcript = data.transcript || [];

            // Log transcript summary
            if (Array.isArray(data.transcript) && data.transcript.length > 0) {
                console.log('[Webhook] Transcript preview (first entry):',
                    JSON.stringify(data.transcript[0], null, 2));
            }

        } else if (type === 'post_call_audio') {
            console.log('[Webhook] Processing post_call_audio webhook');
            console.log('[Webhook] Conversation ID:', conversationId);
            console.log('[Webhook] Audio data length:',
                data.full_audio ? `${data.full_audio.length} characters (base64)` : 'missing');

            webhookDoc.audio_base64 = data.full_audio || '';

            // Log audio metadata
            if (metadata.phone_call) {
                console.log('[Webhook] Call duration:', metadata.phone_call.call_duration_secs, 'seconds');
                console.log('[Webhook] Call direction:', metadata.phone_call.direction);
                console.log('[Webhook] External number:', metadata.phone_call.external_number);
            }

        } else {
            console.warn(`[Webhook] Unknown webhook type: ${type}`);
            // Still store it for debugging
        }

        // Save to database
        const savedWebhook = await ElevenLabsWebhook.create(webhookDoc);
        console.log(`[Webhook] Saved webhook to database. ID: ${savedWebhook._id}, Type: ${type}, Conversation: ${conversationId}`);

        // Mark as processed
        savedWebhook.processed = true;
        await savedWebhook.save();
        console.log('[Webhook] Webhook marked as processed');

        if (type === 'post_call_transcription' && schoolId) {
            deductCallMinutes(savedWebhook).catch((err) => {
                console.error('[Webhook] Minute deduction error:', err);
            });
        }

        // Process transcript with OpenAI if it's a transcription webhook
        if (type === 'post_call_transcription' && Array.isArray(data.transcript) && data.transcript.length > 0) {
            console.log('[Webhook] Starting AI processing for transcript...');
            processTranscriptWithAI(savedWebhook._id, data.transcript).catch(err => {
                console.error('[Webhook] Error in AI processing:', err);
            });
            // Update word cloud for the school in the background
            if (schoolId) {
                updateWordCloudForSchool(schoolId).catch(err => {
                    console.error('[Webhook] Error updating word cloud:', err);
                });
            }
        }

    } catch (err) {
        console.error('[Webhook] Error processing webhook:', err);
        console.error('[Webhook] Error stack:', err.stack);

        // Try to save error information
        try {
            await ElevenLabsWebhook.create({
                type: payload?.type || 'unknown',
                conversation_id: payload?.data?.conversation_id || 'error',
                raw_payload: payload,
                processed: false,
                received_at: new Date(),
                metadata: {
                    error: err.message,
                    error_stack: err.stack
                }
            });
        } catch (saveErr) {
            console.error('[Webhook] Failed to save error record:', saveErr);
        }
    }
}

/**
 * Process transcript with OpenAI (summary and tour booking extraction)
 * This runs asynchronously after the webhook is saved
 */
async function processTranscriptWithAI(webhookId, transcriptArray) {
    try {
        console.log(`[Webhook AI] Processing transcript for webhook ID: ${webhookId}`);

        // Process transcript with OpenAI
        const aiResult = await processTranscript(transcriptArray);

        // Update webhook with AI results
        const updatedWebhook = await ElevenLabsWebhook.findByIdAndUpdate(
            webhookId,
            {
                summary: aiResult.summary,
                tour_booking_detected: aiResult.tour_booking_detected,
                tour_booking_date: aiResult.tour_booking_date,
                tour_booking_extracted: aiResult.tour_booking_extracted,
                ai_processed: true
            },
            { new: true }
        );

        console.log(`[Webhook AI] AI processing complete for webhook ID: ${webhookId}`);
        console.log(`[Webhook AI] Summary generated: ${aiResult.summary ? 'Yes' : 'No'}`);
        console.log(`[Webhook AI] Tour booking detected: ${aiResult.tour_booking_detected}`);

        if (aiResult.tour_booking_detected && aiResult.tour_booking_date) {
            console.log(`[Webhook AI] Tour booking date: ${aiResult.tour_booking_date}`);

            // Automatically create calendar booking
            await createTourBookingFromWebhook(updatedWebhook, aiResult).catch(err => {
                console.error('[Webhook AI] Error creating tour booking:', err);
            });
        }

        // Send email notification to admin AFTER AI processing completes (so it includes summary)
        sendAdminEmailNotification(updatedWebhook, aiResult).catch(err => {
            console.error('[Webhook AI] Error sending admin email notification:', err);
        });

        return updatedWebhook;

    } catch (err) {
        console.error(`[Webhook AI] Error processing transcript for webhook ${webhookId}:`, err);
        // Mark as AI processed even if it failed, so we don't retry indefinitely
        try {
            const existingWebhook = await ElevenLabsWebhook.findById(webhookId).select('metadata').lean();
            await ElevenLabsWebhook.findByIdAndUpdate(webhookId, {
                ai_processed: true,
                $set: {
                    'metadata.ai_processing_error': err.message
                }
            });
        } catch (updateErr) {
            console.error('[Webhook AI] Failed to update error status:', updateErr);
        }
        throw err;
    }
}

/**
 * Helper function to normalize phone number
 */
function normalizePhone(phone) {
    if (!phone || typeof phone !== 'string') return '';
    const trimmed = phone.trim().replace(/[\s\-\(\)]/g, '');
    if (!trimmed) return '';
    return trimmed.startsWith('+') ? trimmed : `+${trimmed}`;
}


/**
 * Find school by called phone number (aiNumber) or by elevenlabsAgentId stored on the school.
 * Priority:
 *   1. Match metadata.phone_call.to_number against school.aiNumber  (phone calls)
 *   2. Match webhook.agent_id against school.elevenlabsAgentId        (SDK / widget calls)
 * No hardcoded IDs anywhere.
 */
async function findSchoolForWebhook(webhook) {
    try {
        // ── Strategy 1: Phone-call match by called number ──────────────────
        const phoneCall = webhook.metadata?.phone_call || {};
        // INBOUND: agent_number is our AI number, external_number is the parent
        // OUTBOUND: external_number is the destination
        const calledNumber = phoneCall.agent_number || phoneCall.to_number || '';

        if (calledNumber) {
            const normalizedCalled = normalizePhone(calledNumber);
            if (normalizedCalled) {
                console.log(`[Webhook] Strategy 1 – searching by school's AI number: ${normalizedCalled}`);

                const allSchools = await School.find({}).select('_id name aiNumber elevenlabsAgentId status').lean();
                const matchedSchools = allSchools.filter(s => {
                    const schoolAiNumber = normalizePhone(s.aiNumber || '');
                    return schoolAiNumber === normalizedCalled;
                });

                if (matchedSchools.length === 1) {
                    console.log(`[Webhook] Found single school by aiNumber: "${matchedSchools[0].name}" (${matchedSchools[0]._id}, status: ${matchedSchools[0].status})`);
                    return matchedSchools[0]._id;
                } else if (matchedSchools.length > 1) {
                    console.log(`[Webhook] Multiple schools match aiNumber ${normalizedCalled}. Attempting to disambiguate...`);

                    // Disambiguate by agentId
                    const agentId = webhook.agent_id || '';
                    if (agentId) {
                        const byAgentId = matchedSchools.find(s => s.elevenlabsAgentId === agentId);
                        if (byAgentId) {
                            console.log(`[Webhook] Disambiguated by elevenlabsAgentId: "${byAgentId.name}"`);
                            return byAgentId._id;
                        }
                    }

                    // Disambiguate by school_id in metadata (useful if passing via React SDK)
                    const webhookSchoolId = webhook.metadata?.school_id || webhook.metadata?.schoolId;
                    if (webhookSchoolId) {
                        const bySchoolId = matchedSchools.find(s => s._id.toString() === webhookSchoolId);
                        if (bySchoolId) {
                            console.log(`[Webhook] Disambiguated by custom metadata school_id: "${bySchoolId.name}"`);
                            return bySchoolId._id;
                        }
                    }

                    // Fallback to first if no disambiguation matches
                    console.log(`[Webhook] Could not definitively disambiguate. Defaulting to first match: "${matchedSchools[0].name}"`);
                    return matchedSchools[0]._id;
                }

                console.warn(`[Webhook] No school matched called number: ${normalizedCalled}`);
            }
        }

        // ── Strategy 2: Agent ID match via elevenlabsAgentId on school ─────
        const agentId = webhook.agent_id || '';
        if (agentId) {
            console.log(`[Webhook] Strategy 2 – searching by elevenlabsAgentId: ${agentId}`);

            const matchedSchools = await School.find({ elevenlabsAgentId: agentId })
                .select('_id name status')
                .lean();

            if (matchedSchools.length === 1) {
                console.log(`[Webhook] Found single school by elevenlabsAgentId: "${matchedSchools[0].name}" (${matchedSchools[0]._id}, status: ${matchedSchools[0].status})`);
                return matchedSchools[0]._id;
            } else if (matchedSchools.length > 1) {
                console.log(`[Webhook] Multiple schools match elevenlabsAgentId ${agentId}. Attempting to disambiguate...`);

                // Disambiguate by school_id in metadata (useful if passing via React SDK)
                const webhookSchoolId = webhook.metadata?.school_id || webhook.metadata?.schoolId;
                if (webhookSchoolId) {
                    const bySchoolId = matchedSchools.find(s => s._id.toString() === webhookSchoolId);
                    if (bySchoolId) {
                        console.log(`[Webhook] Disambiguated by custom metadata school_id: "${bySchoolId.name}"`);
                        return bySchoolId._id;
                    }
                }

                console.log(`[Webhook] Could not definitively disambiguate. Defaulting to first match: "${matchedSchools[0].name}"`);
                return matchedSchools[0]._id;
            }

            console.warn(`[Webhook] No school has elevenlabsAgentId = "${agentId}"`);
        }

        // ── No school found – log helpful debug info ───────────────────────
        const allSchools = await School.find({}).select('_id name aiNumber elevenlabsAgentId').lean();
        console.warn('[Webhook] Could not find school for this webhook.');
        console.warn('[Webhook] Webhook data:', {
            agent_id: webhook.agent_id,
            called_number: calledNumber || '(none – SDK call)',
            user_id: webhook.user_id,
        });
        console.warn('[Webhook] All schools in DB:');
        allSchools.forEach(s => {
            console.warn(`  - "${s.name}" (${s._id}): aiNumber="${s.aiNumber || 'N/A'}", elevenlabsAgentId="${s.elevenlabsAgentId || 'NOT SET'}"`);
        });

        return null;
    } catch (err) {
        console.error('[Webhook] Error finding school:', err);
        return null;
    }
}


/**
 * Create tour booking from webhook when OpenAI detects a booking
 */
async function createTourBookingFromWebhook(webhook, aiResult) {
    try {
        console.log('[Webhook Booking] Starting automatic tour booking creation...');

        // Find school
        const schoolId = await findSchoolForWebhook(webhook);
        if (!schoolId) {
            console.warn('[Webhook Booking] Cannot create booking: school not found');
            return;
        }

        // Use AI results already extracted
        const extracted = aiResult.tour_booking_extracted || {};
        console.log('[Webhook Booking] Using extracted info:', extracted);

        // Parent's phone is 'from_number' for inbound calls
        const phoneCall = webhook.metadata?.phone_call || {};
        const callerPhone = phoneCall.from_number || '';
        const phone = extracted.phone || callerPhone || '';
        const parentName = extracted.name || 'Parent';

        // Get tour booking date — interpret as school local time if no timezone in string (fixes parent seeing wrong time)
        const tourDate = aiResult.tour_booking_date;
        if (!tourDate || isNaN(new Date(tourDate).getTime())) {
            console.warn('[Webhook Booking] Invalid tour booking date');
            return;
        }

        const schoolForTz = await School.findById(schoolId).select('timezone').lean();
        const schoolTz = 'America/Chicago'; // Forced global CST
        console.log('[Webhook Booking] Using school timezone for tour time:', schoolTz, '| raw datetime from AI:', tourDate);
        const start = parseLocalDateTimeToUTC(tourDate, schoolTz) || new Date(tourDate);
        const end = new Date(start.getTime() + 30 * 60 * 1000); // 30-minute slot

        // Validate that the booking date is not in the past
        const now = new Date();
        if (start < now) {
            console.warn(`[Webhook Booking] Cannot create booking for past date: ${start.toISOString()}. Current time: ${now.toISOString()}`);
            return;
        }

        // Check slot availability
        const { available, error: slotError } = await isSlotAvailable(schoolId, start, end);
        if (!available) {
            console.warn(`[Webhook Booking] Slot not available: ${slotError || 'Time slot is already booked'}`);
            // Still create the booking record but mark it as unavailable
            await TourBooking.create({
                schoolId,
                parentName,
                phone: phone || '',
                email: extracted.email || '',
                childName: extracted.childName || '',
                childAge: extracted.childAge || '',
                reason: extracted.notes || '',
                scheduledAt: start,
                calendarEventId: '',
                calendarProvider: '',
            });
            console.log('[Webhook Booking] Tour booking created but calendar event not created (slot unavailable)');
            return;
        }

        // Get school name and preferred calendar for event title
        const school = await School.findById(schoolId).select('name preferredCalendar address').lean();
        const title = `School Tour – ${parentName}`;
        const description = `Tour for ${parentName}. Phone: ${phone || 'N/A'}. Email: ${extracted.email || 'N/A'}. Reason: ${extracted.notes || 'Inquiry'}.${extracted.notes ? ` Notes: ${extracted.notes}` : ''}`;

        console.log(`[Webhook Booking] School: ${school?.name || 'Unknown'}`);
        console.log(`[Webhook Booking] Preferred Calendar: ${school?.preferredCalendar || 'google'}`);
        console.log(`[Webhook Booking] Tour Date/Time: ${start.toISOString()}`);
        console.log(`[Webhook Booking] Event Title: ${title}`);

        // Check for connected integrations before attempting to create event
        const Integration = require('../models/Integration');
        const integrations = await Integration.find({
            schoolId,
            connected: true,
            type: { $in: ['google', 'outlook'] }
        }).select('type connected').lean();

        console.log(`[Webhook Booking] Found ${integrations.length} connected integration(s):`,
            integrations.map(i => `${i.type} (connected: ${i.connected})`).join(', ') || 'None');

        // Create calendar event (include parent email so they receive a calendar invite)
        const parentEmail = extracted.email || '';
        console.log(`[Webhook Booking] Attempting to create calendar event with preference: ${school?.preferredCalendar || 'google'}...`);
        if (parentEmail) {
            console.log(`[Webhook Booking] Adding parent as attendee for calendar invite: ${parentEmail}`);
        }

        const calResult = await createCalendarEvent(schoolId, {
            title,
            startDateTime: start,
            endDateTime: end,
            description,
            parentEmail: parentEmail || undefined,
            parentPhone: phone || undefined,
            location: school.address || '',
        });

        console.log(`[Webhook Booking] Calendar event creation result:`, JSON.stringify(calResult, null, 2));

        // Create the official TourBooking record exactly once here
        const tourBooking = await TourBooking.create({
            schoolId,
            parentName,
            phone: phone || '',
            email: extracted.email || '',
            childName: extracted.childName || '',
            childAge: extracted.childAge || '',
            reason: extracted.reason || extracted.notes || '',
            scheduledAt: start,
            calendarEventId: calResult.success ? calResult.eventId : '',
            calendarProvider: calResult.success ? calResult.provider : '',
            calendarEmail: calResult.success ? calResult.email : '',
        });

        // Send confirmation communications (email + optional SMS)
        const { sendTourConfirmation } = require('../services/automation');
        await sendTourConfirmation(schoolId, tourBooking).catch(err => {
            console.error('[Webhook Booking] Error sending confirmation:', err);
        });

        // Send calendar invite to parent email (ICS attachment) so they can add the event to their calendar
        if (parentEmail && calResult.success) {
            try {
                const school = await School.findById(schoolId).select('name address timezone').lean();
                const tourDateStr = new Date(start).toLocaleString('en-US', {
                    dateStyle: 'full',
                    timeStyle: 'short',
                    timeZone: school?.timezone || 'UTC'
                });
                const icsContent = generateICS({
                    title,
                    start,
                    end,
                    description: description || `School tour at ${school?.name || 'our school'}. ${description || ''}`,
                    location: school?.address || ''
                });
                await sendEmail(schoolId, {
                    to: parentEmail,
                    subject: `Calendar invite: ${title} – ${school?.name || 'School'}`,
                    text: `Your school tour is confirmed for ${tourDateStr}. Please find the calendar invite attached – add it to your calendar to receive reminders.\n\nWe look forward to seeing you!`,
                    attachments: [{ filename: 'invite.ics', content: icsContent }]
                });
                console.log('[Webhook Booking] Calendar invite email sent to parent:', parentEmail);
            } catch (err) {
                console.error('[Webhook Booking] Error sending calendar invite to parent:', err.message);
            }
        }

        console.log(`[Webhook Booking] Tour booking created successfully!`);
        console.log(`[Webhook Booking] Tour Booking ID: ${tourBooking._id}`);
        console.log(`[Webhook Booking] Scheduled At: ${start}`);
        console.log(`[Webhook Booking] Calendar Event Created: ${calResult.success ? 'Yes' : 'No'}`);
        if (calResult.success) {
            console.log(`[Webhook Booking] Calendar Provider: ${calResult.provider}`);
            console.log(`[Webhook Booking] Calendar Event ID: ${calResult.eventId}`);
        }

        return tourBooking;

    } catch (err) {
        console.error('[Webhook Booking] Error creating tour booking:', err);
        throw err;
    }
}

/**
 * Send email via Gmail API using OAuth tokens from Google Calendar integration
 * @param {string|ObjectId} schoolId - School ObjectId
 * @param {string} to - Recipient email address
 * @param {string} subject - Email subject
 * @param {string} text - Email body (plain text)
 * @returns {Promise<{ success: boolean, error?: string }>}
 */
async function sendEmailViaGmail(schoolId, to, subject, text) {
    try {
        // Get Google Integration for this school
        const integration = await Integration.findOne({
            schoolId,
            type: 'google',
            connected: true
        }).lean();

        if (!integration || !integration.config?.tokens) {
            return {
                success: false,
                error: 'Google Calendar integration not connected. Please connect your Google Calendar in Settings.'
            };
        }

        const tokens = integration.config.tokens;
        const userEmail = integration.config.userEmail || null;

        // Create OAuth2 client
        const oauth2Client = new google.auth.OAuth2(
            process.env.GOOGLE_CLIENT_ID,
            process.env.GOOGLE_CLIENT_SECRET,
            process.env.GOOGLE_REDIRECT_URI
        );

        oauth2Client.setCredentials(tokens);

        // Listen for token refresh
        oauth2Client.on('tokens', async (newTokens) => {
            console.log('[Gmail] Tokens refreshed for school:', schoolId);
            await Integration.updateOne(
                { _id: integration._id },
                { $set: { 'config.tokens': { ...tokens, ...newTokens } } }
            );
        });

        // Get Gmail API client
        const gmail = google.gmail({ version: 'v1', auth: oauth2Client });

        // Use stored userEmail as "from" address, or fallback to tokens email
        const fromEmail = userEmail || tokens.email || 'noreply@nestops.com';

        // Create email message in RFC 2822 format
        const message = [
            `From: ${fromEmail}`,
            `To: ${to}`,
            `Subject: ${subject}`,
            `Content-Type: text/plain; charset=utf-8`,
            '',
            text
        ].join('\n');

        // Encode message in base64url format (Gmail API requirement)
        const encodedMessage = Buffer.from(message)
            .toString('base64')
            .replace(/\+/g, '-')
            .replace(/\//g, '_')
            .replace(/=+$/, '');

        // Send email via Gmail API
        const response = await gmail.users.messages.send({
            userId: 'me',
            requestBody: {
                raw: encodedMessage
            }
        });

        console.log(`[Gmail] Email sent successfully. Message ID: ${response.data.id}`);
        return { success: true };

    } catch (err) {
        console.error('[Gmail] Error sending email:', err.message);
        return {
            success: false,
            error: err.message || 'Failed to send email via Gmail API'
        };
    }
}

const { getCallDurationSeconds } = require('../utils/webhookHelpers');

/**
 * Send email notification to admin when webhook is received and processed
 * @param {Object} webhook - The webhook document (with AI processing results)
 * @param {Object} aiResult - The AI processing result (summary, tour booking info)
 */
async function sendAdminEmailNotification(webhook, aiResult = null) {
    try {
        // Find school by phone number or agent ID
        const schoolId = await findSchoolForWebhook(webhook);
        if (!schoolId) {
            console.warn('[Webhook Email] Cannot send email: school not found');
            return;
        }

        // schoolId might be ObjectId or string, handle both
        let schoolObjectId = schoolId;
        if (typeof schoolId === 'string' && mongoose.Types.ObjectId.isValid(schoolId)) {
            schoolObjectId = new mongoose.Types.ObjectId(schoolId);
        } else if (!(schoolId instanceof mongoose.Types.ObjectId)) {
            schoolObjectId = schoolId;
        }

        console.log(`[Webhook Email] Looking up school with ID: ${schoolObjectId} (type: ${typeof schoolObjectId})`);

        const school = await School.findById(schoolObjectId).select('name adminEmail').lean();

        console.log(`[Webhook Email] School found: ${school ? school.name : 'Not found'}`);

        if (!school) {
            console.warn('[Webhook Email] School not found in database');
            return;
        }

        // Find the user associated with this school (the school admin user)
        const schoolUser = await User.findOne({
            schoolId: schoolObjectId,
            role: 'school'
        }).select('email name').lean();

        console.log(`[Webhook Email] School user found: ${schoolUser ? schoolUser.name : 'Not found'}`);
        console.log(`[Webhook Email] School user email: "${schoolUser?.email || 'Not set'}"`);
        console.log(`[Webhook Email] School adminEmail: "${school?.adminEmail || 'Not set'}"`);

        // Determine admin email: prefer school adminEmail (set in settings), fallback to school user login email
        let adminEmail = null;
        if (school.adminEmail && school.adminEmail.trim()) {
            adminEmail = school.adminEmail.trim();
            console.log(`[Webhook Email] Using school adminEmail: ${adminEmail}`);
        } else if (schoolUser && schoolUser.email && schoolUser.email.trim()) {
            adminEmail = schoolUser.email.trim();
            console.log(`[Webhook Email] Falling back to school user email: ${adminEmail}`);
        }

        if (!adminEmail) {
            console.log('[Webhook Email] No admin email found (neither school user email nor school adminEmail), skipping notification');
            // Debug: show all school users
            const allSchoolUsers = await User.find({ role: 'school' }).select('email name schoolId').lean();
            console.log(`[Webhook Email] Total school users: ${allSchoolUsers.length}`);
            if (allSchoolUsers.length > 0) {
                const schoolsWithUsers = await School.find({ _id: { $in: allSchoolUsers.map(u => u.schoolId).filter(Boolean) } }).select('name').lean();
                const schoolMap = new Map(schoolsWithUsers.map(s => [s._id.toString(), s.name]));
                console.log(`[Webhook Email] School users:`, allSchoolUsers.map(u => `${schoolMap.get(u.schoolId?.toString()) || 'Unknown'}: ${u.email}`).join(', '));
            }
            return;
        }

        // Format call information (duration from multiple possible payload locations)
        // Transcription webhook often has no duration; duration usually comes in post_call_audio for same conversation
        let callDuration = getCallDurationSeconds(webhook);
        if (callDuration === 0 && webhook.conversation_id) {
            const audioWebhook = await ElevenLabsWebhook.findOne({
                conversation_id: webhook.conversation_id,
                type: 'post_call_audio'
            }).select('metadata raw_payload transcript').lean();
            if (audioWebhook) {
                callDuration = getCallDurationSeconds(audioWebhook);
                if (callDuration > 0) {
                    console.log(`[Webhook Email] Using duration ${callDuration}s from post_call_audio webhook for conversation ${webhook.conversation_id}`);
                }
            }
        }
        const callDurationMin = Math.floor(callDuration / 60);
        const callDurationSec = callDuration % 60;
        let callerNumber = webhook.metadata?.phone_call?.from_number
            || webhook.metadata?.phone_call?.external_number
            || aiResult?.tour_booking_extracted?.phone
            || 'Unknown (Web Widget)';

        const receivedAt = webhook.received_at ? new Date(webhook.received_at).toLocaleString() : new Date().toLocaleString();

        // Include AI processing results if available
        const summary = webhook.summary || aiResult?.summary || '';
        const tourBooked = webhook.tour_booking_detected || aiResult?.tour_booking_detected || false;
        const tourDate = webhook.tour_booking_date || aiResult?.tour_booking_date || null;
        const tourNotes = webhook.tour_booking_extracted?.notes || aiResult?.tour_booking_extracted?.notes || '';

        const backendUrl = process.env.BACKEND_URL || 'http://localhost:5001';
        const notificationToken = jwt.sign(
            { id: 'system', role: 'school', schoolId: schoolObjectId },
            JWT_SECRET,
            { expiresIn: '7d' }
        );

        const emailSubject = `New Call Received - ${school.name}${tourBooked ? ' (Tour Booked)' : ''}`;
        let emailBody = `Hello,

A new call has been received and processed for ${school.name}.

Call Details:
- Caller Name/Number: ${callerNumber}
- Call Duration: ${callDurationMin} min ${callDurationSec} sec
- Call Recording: ${backendUrl}/api/school/calls/${webhook.conversation_id}/audio?token=${notificationToken}

`;

        if (summary) {
            emailBody += `Call Summary:
${summary}

`;
        }

        if (tourBooked && tourDate) {
            const tourDateStr = new Date(tourDate).toLocaleString(undefined, {
                dateStyle: 'full',
                timeStyle: 'short'
            });
            emailBody += `Tour Booking:
- Tour Scheduled: ${tourDateStr}
${tourNotes ? `- Notes: ${tourNotes}\n` : ''}
`;
        }

        emailBody += `You can view the full call details in your dashboard.

Best regards,
Nest Ops Platform`;

        // Send email using the school's preferred provider (Google/Outlook), with SMTP fallback.
        // Note: this replaces the previous hardcoded Gmail-only flow.
        let emailResult;
        try {
            emailResult = await sendEmail(schoolObjectId, {
                to: adminEmail,
                subject: emailSubject,
                text: emailBody
            });
        } catch (err) {
            emailResult = { success: false, error: err?.message || 'Failed to send email' };
        }

        if (!emailResult.success) {
            console.error(`[Webhook Email] Failed to send email: ${emailResult.error}`);
            // Create Followup record with failed status
            await Followup.create({
                schoolId,
                leadName: 'Admin Notification',
                type: 'Email',
                status: 'failed',
                message: emailBody,
                recipient: adminEmail,
            });
            return;
        }

        // Create Followup record to track admin email notification
        await Followup.create({
            schoolId,
            leadName: 'Admin Notification',
            type: 'Email',
            status: 'sent',
            message: emailBody,
            recipient: adminEmail,
        });

        console.log(
            `[Webhook Email] Admin notification sent successfully to ${adminEmail} via ${emailResult.method || 'provider'}`
        );

    } catch (err) {
        console.error('[Webhook Email] Error sending admin email notification:', err.message);
        // Don't throw - email failure shouldn't break webhook processing
    }
}

/**
 * Update the Word Cloud for a school asynchronously
 */
async function updateWordCloudForSchool(schoolId) {
    try {
        const school = await School.findById(schoolId).select('aiNumber').lean();
        if (!school) return;

        const normalizePhone = (p) => (p || '').replace(/\D/g, '');
        const schoolAiNumber = normalizePhone(school.aiNumber || '');
        const schoolObjectId = new mongoose.Types.ObjectId(schoolId);

        const wordCloudStart = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
        const todayEnd = new Date();
        todayEnd.setHours(23, 59, 59, 999);

        const wordCloudWebhooks = await ElevenLabsWebhook.find({
            type: 'post_call_transcription',
            received_at: { $gte: wordCloudStart, $lte: todayEnd },
            schoolId: schoolObjectId
        })
            .select('transcript')
            .sort({ received_at: -1 })
            .limit(500)
            .lean();

        const allTranscripts = wordCloudWebhooks
            .map(wh =>
                Array.isArray(wh.transcript)
                    ? wh.transcript.map(t => `${t.role}: ${t.message || t.text}`).join('\n')
                    : ''
            )
            .filter(Boolean);

        const wordCloud = await generateWordCloud(allTranscripts);
        
        await School.findByIdAndUpdate(schoolId, { wordCloud });
        console.log(`[WordCloud] Successfully updated word cloud for school ${schoolId}`);
    } catch (error) {
        console.error(`[WordCloud] Error updating word cloud for school ${schoolId}:`, error);
    }
}

module.exports = router;

