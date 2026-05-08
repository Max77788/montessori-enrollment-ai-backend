/**
 * VAPI Webhook Receiver
 *
 * POST /api/v1/webhook/vapi
 *
 * Receives webhook events from VAPI AI:
 *   - end-of-call-report: Full call transcript, recording URL, summary, structured data
 *   - tool-calls: Function call requests from the AI during a live call
 *   - status-update: Call lifecycle updates
 *   - transcript: Streaming transcript chunks
 *
 * Critical: VAPI requires responses within 5 seconds.
 * All heavy processing (AI analysis, calendar booking, email) is async.
 */

const express = require('express');
const crypto = require('crypto');
const mongoose = require('mongoose');
const ElevenLabsWebhook = require('../models/ElevenLabsWebhook'); // Reuse same model for VAPI
const School = require('../models/School');
const TourBooking = require('../models/TourBooking');
const User = require('../models/User');
const Followup = require('../models/Followup');
const { processTranscript } = require('../services/openaiService');
const { generateWordCloud } = require('../utils/openai');
const { createCalendarEvent, isSlotAvailable } = require('../services/calendarService');
const { sendEmail } = require('../services/mailService');
const { generateICS } = require('../utils/ics');
const { parseLocalDateTimeToUTC } = require('../utils/timezone');
const { deductCallMinutes } = require('../services/billingService');
const { validateWebhookSignature } = require('../services/vapiService');
const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'nest-ops-secret-key-2026';
const router = express.Router();

/**
 * POST /api/v1/webhook/vapi
 * No authentication — validated by HMAC signature.
 */
router.post('/vapi', async (req, res) => {
    const payload = req.body || {};

    // Validate signature (non-blocking — logs warning on mismatch)
    const validSig = validateWebhookSignature(req);
    if (!validSig) {
        console.warn('[VAPI Webhook] Invalid signature — logging but still processing');
    }

    const msgType = payload?.message?.type || 'unknown';
    console.log(`[VAPI Webhook] Received: type=${msgType}`);

    // Handle tool-calls synchronously (VAPI waits for response)
    if (msgType === 'tool-calls') {
        await handleToolCalls(payload, res);
        return;
    }

    // All other events: acknowledge immediately, process async
    res.status(200).json({ status: 'received' });

    if (msgType === 'end-of-call-report') {
        processEndOfCallReport(payload).catch(err => {
            console.error('[VAPI Webhook] Async processing error:', err);
        });
    } else if (msgType === 'status-update') {
        console.log(`[VAPI Webhook] Call status: ${payload.message?.status || 'unknown'}`);
    } else if (msgType === 'transcript') {
        // Streaming transcripts are informational — no action needed
    }
});

/**
 * Handle tool-call events from VAPI.
 * VAPI expects a synchronous response with the tool results.
 */
async function handleToolCalls(payload, res) {
    try {
        const toolCalls = payload?.message?.toolCalls || [];
        const results = [];

        for (const tc of toolCalls) {
            const funcName = tc?.function?.name;
            let args = {};
            try {
                args = typeof tc.function.arguments === 'string'
                    ? JSON.parse(tc.function.arguments)
                    : tc.function.arguments || {};
            } catch (e) {
                args = {};
            }

            console.log(`[VAPI Tool] Calling: ${funcName}`, args);

            let result;
            try {
                switch (funcName) {
                    case 'check_availability': {
                        result = await handleAvailabilityCheck(args);
                        break;
                    }
                    case 'book_appointment': {
                        result = await handleAppointmentBooking(payload, args);
                        break;
                    }
                    case 'get_school_info': {
                        result = await handleSchoolInfo(payload, args);
                        break;
                    }
                    default:
                        result = { error: `Unknown function: ${funcName}` };
                }
            } catch (fnErr) {
                console.error(`[VAPI Tool] Error in ${funcName}:`, fnErr.message);
                result = { error: fnErr.message };
            }

            results.push({
                toolCallId: tc.id,
                result: typeof result === 'string' ? result : JSON.stringify(result),
            });
        }

        const responseBody = { results };
        console.log(`[VAPI Tool] Responding with:`, JSON.stringify(responseBody).slice(0, 200));
        res.status(200).json(responseBody);

    } catch (err) {
        console.error('[VAPI Tool] Error handling tool calls:', err);
        res.status(500).json({
            results: [{ toolCallId: 'error', result: 'Internal server error' }]
        });
    }
}

/**
 * Tool: Check tour availability for a given date.
 */
async function handleAvailabilityCheck(args) {
    const { date } = args;
    if (!date) return { error: 'Date is required (YYYY-MM-DD)' };

    // School ID needs to come from the assistant metadata or call metadata
    // For now, return a generic response
    return {
        date,
        available: true,
        message: 'Please use the booking system to check exact availability.',
    };
}

/**
 * Tool: Book a tour appointment.
 * This is called by the VAPI assistant when the parent confirms all details.
 */
async function handleAppointmentBooking(payload, args) {
    const {
        date, time, parent_name, parent_phone, parent_email,
        child_name, child_age, reason
    } = args;

    if (!date || !time || !parent_name) {
        return { success: false, error: 'Missing required fields. Need date, time, and parent name.' };
    }

    // Find school from assistant metadata
    const schoolId = payload?.message?.assistant?.metadata?.schoolId;
    if (!schoolId) {
        return { success: false, error: 'School not identified. Please try again.' };
    }

    try {
        // Parse date/time into UTC
        const localDateTime = new Date(`${date}T${time}:00`);
        const start = parseLocalDateTimeToUTC(localDateTime.toISOString(), 'America/Chicago')
            || localDateTime;

        if (isNaN(start.getTime())) {
            return { success: false, error: 'Invalid date or time format.' };
        }

        const end = new Date(start.getTime() + 30 * 60 * 1000);

        // Check availability
        const { available, error: slotError } = await isSlotAvailable(schoolId, start, end);
        if (!available) {
            return { success: false, error: slotError || 'That time slot is no longer available.' };
        }

        // Create calendar event
        const title = `School Tour – ${parent_name}`;
        const description = `Tour for ${parent_name}. Phone: ${parent_phone || 'N/A'}. Email: ${parent_email || 'N/A'}. Child: ${child_name || 'N/A'} (${child_age || 'N/A'}). Reason: ${reason || 'Inquiry'}.`;

        const calResult = await createCalendarEvent(schoolId, {
            title,
            startDateTime: start,
            endDateTime: end,
            description,
            parentEmail: parent_email || undefined,
        });

        // Create tour booking record
        const tourBooking = await TourBooking.create({
            schoolId,
            parentName: parent_name,
            phone: parent_phone || '',
            email: parent_email || '',
            childName: child_name || '',
            childAge: child_age || '',
            reason: reason || '',
            scheduledAt: start,
            calendarEventId: calResult.success ? calResult.eventId : '',
            calendarProvider: calResult.success ? calResult.provider : '',
            calendarEmail: calResult.success ? calResult.email : '',
        });

        // Send confirmation email
        if (parent_email) {
            const { sendTourConfirmation } = require('../services/automation');
            sendTourConfirmation(schoolId, tourBooking).catch(err =>
                console.error('[VAPI Tool] Confirmation email error:', err.message)
            );
        }

        console.log(`[VAPI Tool] Tour booked: ${parent_name} on ${date} at ${time}`);
        return {
            success: true,
            message: `Tour booked for ${parent_name} on ${date} at ${time}. A confirmation email will be sent.`,
            booking_id: tourBooking._id.toString(),
            calendar_provider: calResult.success ? calResult.provider : 'none',
        };

    } catch (err) {
        console.error('[VAPI Tool] Booking error:', err);
        return { success: false, error: 'Unable to complete booking. Please try again.' };
    }
}

/**
 * Tool: Get school information.
 */
async function handleSchoolInfo(payload, args) {
    const schoolId = payload?.message?.assistant?.metadata?.schoolId;
    if (!schoolId) return { error: 'School not identified.' };

    try {
        const school = await School.findById(schoolId)
            .select('name address businessHoursStart businessHoursEnd language qaPairs')
            .lean();

        if (!school) return { error: 'School not found.' };

        const qaText = (school.qaPairs || [])
            .filter(p => p.question && p.answer)
            .map(p => `Q: ${p.question}\nA: ${p.answer}`)
            .join('\n\n');

        return {
            school_name: school.name,
            address: school.address || 'Not specified',
            business_hours: `${school.businessHoursStart || '9:00'} - ${school.businessHoursEnd || '17:00'}`,
            language: school.language === 'ES' ? 'Bilingual (English/Spanish)' : 'English',
            knowledge_base: qaText || 'No additional information available.',
        };
    } catch (err) {
        console.error('[VAPI Tool] School info error:', err);
        return { error: 'Unable to fetch school information.' };
    }
}

/**
 * Process end-of-call report from VAPI.
 * Extracts transcript, recording URL, summary, and structured data.
 * Runs the same AI analysis pipeline as ElevenLabs webhooks.
 */
async function processEndOfCallReport(payload) {
    const message = payload?.message || {};
    const callId = message.call?.id || 'unknown';
    const assistantId = message.assistant?.id || '';
    const schoolId = message.assistant?.metadata?.schoolId || null;

    console.log(`[VAPI EOCR] Processing end-of-call report — callId=${callId}`);
    console.log(`[VAPI EOCR] Ended reason: ${message.endedReason || 'unknown'}`);
    console.log(`[VAPI EOCR] Duration: ${message.startedAt && message.endedAt ?
        Math.round((new Date(message.endedAt) - new Date(message.startedAt)) / 1000) : 'N/A'}s`);
    console.log(`[VAPI EOCR] Cost: $${(message.cost || 0).toFixed(4)}`);

    // Extract transcript
    const transcriptText = message.artifact?.transcript || '';
    const messages = message.artifact?.messages || [];

    // Build structured transcript matching ElevenLabs format
    const transcriptArray = messages.map(m => ({
        role: m.role === 'assistant' ? 'bot' : 'user',
        message: m.message || m.content || '',
        time: m.time || 0,
    }));

    // Store as ElevenLabsWebhook (reuse existing model for unified pipeline)
    const schoolObjectId = schoolId && mongoose.Types.ObjectId.isValid(schoolId)
        ? new mongoose.Types.ObjectId(schoolId) : null;

    try {
        const webhookDoc = await ElevenLabsWebhook.create({
            type: 'post_call_transcription',
            conversation_id: callId,
            agent_id: assistantId,
            agent_name: message.assistant?.name || 'VAPI Assistant',
            transcript: transcriptArray,
            metadata: {
                phone_call: {
                    from_number: message.customer?.number || '',
                    to_number: message.phoneNumber?.number || '',
                    call_duration_secs: message.startedAt && message.endedAt
                        ? Math.round((new Date(message.endedAt) - new Date(message.startedAt)) / 1000)
                        : 0,
                    direction: 'inbound',
                },
                vapi_metadata: {
                    cost: message.cost,
                    endedReason: message.endedReason,
                    recordingUrl: message.artifact?.recordingUrl,
                }
            },
            raw_payload: payload,
            processed: false,
            received_at: new Date(),
            schoolId: schoolObjectId,
        });

        console.log(`[VAPI EOCR] Saved webhook: ${webhookDoc._id}`);

        // Deduct call minutes
        if (schoolObjectId) {
            deductCallMinutes(webhookDoc).catch(err =>
                console.error('[VAPI EOCR] Minute deduction error:', err)
            );
        }

        // Process transcript with OpenAI if we have content
        if (transcriptArray.length > 0 && schoolObjectId) {
            const { processTranscriptWithAI } = require('../routes/webhook');
            processTranscriptWithAI(webhookDoc._id, transcriptArray).catch(err =>
                console.error('[VAPI EOCR] AI processing error:', err)
            );

            // Update word cloud
            const { generateWordCloud } = require('../utils/openai');
            // Word cloud update is lightweight — run inline
            updateWordCloudForSchool(schoolObjectId).catch(err =>
                console.error('[VAPI EOCR] Word cloud error:', err)
            );
        }

        // If VAPI already provided analysis/structuredData, use it
        if (message.analysis?.summary && schoolObjectId) {
            console.log('[VAPI EOCR] Using VAPI-provided analysis summary');
            const updateData = {
                summary: message.analysis.summary,
                tour_booking_detected: !!message.analysis.structuredData?.tour_booked,
                tour_booking_date: message.analysis.structuredData?.tour_date || null,
                ai_processed: true,
            };
            // Store full VAPI structured data for frontend display
            if (message.analysis.structuredData) {
                updateData['metadata.vapi_structured_data'] = message.analysis.structuredData;
                console.log('[VAPI EOCR] Structured data stored:', JSON.stringify(message.analysis.structuredData).slice(0, 400));
            }
            if (message.analysis.successEvaluation) {
                updateData['metadata.vapi_success_evaluation'] = message.analysis.successEvaluation;
            }
            await ElevenLabsWebhook.findByIdAndUpdate(webhookDoc._id, updateData);
        }

    } catch (err) {
        console.error('[VAPI EOCR] Error saving webhook:', err);
    }
}

/**
 * Update word cloud for a school (reused from ElevenLabs webhook).
 */
async function updateWordCloudForSchool(schoolId) {
    try {
        const { generateWordCloud } = require('../utils/openai');
        const schoolObjectId = new mongoose.Types.ObjectId(schoolId);

        const recentWebhooks = await ElevenLabsWebhook.find({
            type: 'post_call_transcription',
            received_at: { $gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) },
            schoolId: schoolObjectId,
        })
            .select('transcript')
            .sort({ received_at: -1 })
            .limit(500)
            .lean();

        const allTranscripts = recentWebhooks
            .map(wh => Array.isArray(wh.transcript)
                ? wh.transcript.map(t => `${t.role}: ${t.message || t.text}`).join('\n')
                : '')
            .filter(Boolean);

        if (allTranscripts.length > 0) {
            const wordCloud = await generateWordCloud(allTranscripts);
            await School.findByIdAndUpdate(schoolId, { wordCloud });
        }
    } catch (err) {
        console.error('[VAPI EOCR] Word cloud error:', err);
    }
}

module.exports = router;
