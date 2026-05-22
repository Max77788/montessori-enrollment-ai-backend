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
                    case 'get_current_datetime_cst': {
                        result = handleCurrentDatetimeCST();
                        break;
                    }
                    case 'get_booked_slots': {
                        result = await handleGetBookedSlots(args);
                        break;
                    }
                    case 'book_appointment': {
                        result = await handleAppointmentBooking(payload, args);
                        break;
                    }
                    case 'check_availability': {
                        result = await handleAvailabilityCheck(args);
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
 * Tool: Get current date/time in CST.
 * Called silently by Nora at the start of every call.
 */
function handleCurrentDatetimeCST() {
    const now = new Date();
    const cst = new Date(now.toLocaleString('en-US', { timeZone: 'America/Chicago' }));
    const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const monthNames = ['January', 'February', 'March', 'April', 'May', 'June',
        'July', 'August', 'September', 'October', 'November', 'December'];

    return {
        iso: cst.toISOString(),
        date: cst.toISOString().slice(0, 10),
        time: cst.toTimeString().slice(0, 5),
        day_of_week: dayNames[cst.getDay()],
        day_of_week_index: cst.getDay(),
        month: monthNames[cst.getMonth()],
        month_index: cst.getMonth() + 1,
        year: cst.getFullYear(),
        today_date: cst.toISOString().slice(0, 10),
        tomorrow_date: new Date(cst.getTime() + 86400000).toISOString().slice(0, 10),
    };
}

/**
 * Tool: Get booked slots for a given date.
 */
async function handleGetBookedSlots(args) {
    const { date } = args;
    if (!date) return { error: 'Date is required (YYYY-MM-DD)' };

    try {
        const School = require('../models/School');
        const { getBusySlots } = require('../services/calendarService');

        const school = await School.findOne({ status: 'active' }).lean();
        if (!school) return { error: 'No active school found' };

        const dayStart = new Date(date + 'T00:00:00');
        const dayEnd = new Date(date + 'T23:59:59');
        const dayOfWeek = new Date(date + 'T12:00:00').getDay();
        const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

        if (dayOfWeek === 0 || dayOfWeek === 6) {
            return { date, day_of_week: dayNames[dayOfWeek], availableSlots: [], bookedSlots: [], total_available: 0, is_weekend: true };
        }

        const busySlots = await getBusySlots(school._id, dayStart, dayEnd);
        const bizStart = school.businessHoursStart || '09:00';
        const bizEnd = school.businessHoursEnd || '17:00';
        const [sh, sm] = bizStart.split(':').map(Number);
        const [eh, em] = bizEnd.split(':').map(Number);

        const allSlots = [];
        let current = new Date(date + `T${String(sh).padStart(2,'0')}:${String(sm).padStart(2,'0')}:00`);
        const endTime = new Date(date + `T${String(eh).padStart(2,'0')}:${String(em).padStart(2,'0')}:00`);

        while (current < endTime) {
            const slotEnd = new Date(current.getTime() + 30 * 60000);
            if (slotEnd <= endTime) {
                const slotStr = current.toTimeString().slice(0, 5);
                const isBooked = busySlots.some(bs => {
                    const bsStart = new Date(bs.start || bs.startDateTime);
                    const bsEnd = new Date(bs.end || bs.endDateTime);
                    return current < bsEnd && slotEnd > bsStart;
                });
                allSlots.push({ time: slotStr, booked: isBooked });
            }
            current = new Date(current.getTime() + 30 * 60000);
        }

        return {
            date, day_of_week: dayNames[dayOfWeek],
            availableSlots: allSlots.filter(s => !s.booked).map(s => s.time),
            bookedSlots: allSlots.filter(s => s.booked).map(s => s.time),
            total_available: allSlots.filter(s => !s.booked).length,
        };
    } catch (err) {
        console.error('[GetBookedSlots] Error:', err);
        return { error: 'Unable to check availability.' };
    }
}

/**
 * Tool: Check tour availability for a given date.
 * Uses the same calendar logic as get_booked_slots but returns a simpler yes/no answer.
 */
async function handleAvailabilityCheck(args) {
    console.log('[CheckAvailability] ──────── Called ────────');
    console.log('[CheckAvailability] Args:', JSON.stringify(args));

    const { date } = args;
    if (!date) {
        console.log('[CheckAvailability] ❌ Missing date');
        return { error: 'Date is required (YYYY-MM-DD)' };
    }

    try {
        const School = require('../models/School');
        const { getBusySlots } = require('../services/calendarService');

        const school = await School.findOne({ status: 'active' }).lean();
        if (!school) {
            console.log('[CheckAvailability] ❌ No active school found');
            return { error: 'No active school found' };
        }
        console.log('[CheckAvailability] School:', school.name, '| Biz hours:', school.businessHoursStart, '-', school.businessHoursEnd);

        const dayStart = new Date(date + 'T00:00:00');
        const dayEnd = new Date(date + 'T23:59:59');
        const dayOfWeek = new Date(date + 'T12:00:00').getDay();
        const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
        console.log('[CheckAvailability] Date:', date, '| Day:', dayNames[dayOfWeek]);

        if (dayOfWeek === 0 || dayOfWeek === 6) {
            console.log('[CheckAvailability] ❌ Weekend — no tours');
            return {
                date,
                day_of_week: dayNames[dayOfWeek],
                available: false,
                reason: 'Tours are only available Monday through Friday.',
            };
        }

        console.log('[CheckAvailability] Fetching busy slots...');
        const busySlots = await getBusySlots(school._id, dayStart, dayEnd);
        console.log('[CheckAvailability] Busy slots found:', busySlots.length);
        if (busySlots.length > 0) {
            busySlots.forEach((bs, i) => {
                console.log(`[CheckAvailability]   Busy #${i + 1}:`, bs.start || bs.startDateTime, '→', bs.end || bs.endDateTime);
            });
        }

        const bizStart = school.businessHoursStart || '09:00';
        const bizEnd = school.businessHoursEnd || '17:00';
        const [sh, sm] = bizStart.split(':').map(Number);
        const [eh, em] = bizEnd.split(':').map(Number);

        const availableSlots = [];
        let current = new Date(date + `T${String(sh).padStart(2, '0')}:${String(sm).padStart(2, '0')}:00`);
        const endTime = new Date(date + `T${String(eh).padStart(2, '0')}:${String(em).padStart(2, '0')}:00`);

        while (current < endTime) {
            const slotEnd = new Date(current.getTime() + 30 * 60000);
            if (slotEnd <= endTime) {
                const isBooked = busySlots.some(bs => {
                    const bsStart = new Date(bs.start || bs.startDateTime);
                    const bsEnd = new Date(bs.end || bs.endDateTime);
                    return current < bsEnd && slotEnd > bsStart;
                });
                if (!isBooked) {
                    availableSlots.push(current.toTimeString().slice(0, 5));
                }
            }
            current = new Date(current.getTime() + 30 * 60000);
        }

        const firstSlot = availableSlots[0] || null;
        const lastSlot = availableSlots[availableSlots.length - 1] || null;
        console.log('[CheckAvailability] ✅ Available:', availableSlots.length, 'slots | First:', firstSlot, '| Last:', lastSlot);

        return {
            date,
            day_of_week: dayNames[dayOfWeek],
            available: availableSlots.length > 0,
            total_slots_open: availableSlots.length,
            earliest_slot: firstSlot,
            latest_slot: lastSlot,
        };
    } catch (err) {
        console.error('[CheckAvailability] ❌ Error:', err.message);
        console.error('[CheckAvailability] Stack:', err.stack?.split('\n').slice(0, 3).join('\n'));
        return { error: 'Unable to check availability right now.' };
    }
}

/**
 * Tool: Book a tour appointment.
 * This is called by the VAPI assistant when the parent confirms all details.
 */
async function handleAppointmentBooking(payload, args) {
    console.log('[BookAppointment] ──────── Called ────────');
    console.log('[BookAppointment] Args:', JSON.stringify(args));

    const {
        date, time, parent_name, parent_phone, parent_email,
        child_name, child_age, reason
    } = args;

    if (!date || !time || !parent_name) {
        console.log('[BookAppointment] ❌ Missing required fields:', { date: !!date, time: !!time, parent_name: !!parent_name });
        return { success: false, error: 'Missing required fields. Need date, time, and parent name.' };
    }

    // Find school from assistant metadata
    console.log('[BookAppointment] Payload assistant metadata:', JSON.stringify(payload?.message?.assistant?.metadata || {}).slice(0, 300));
    const schoolId = payload?.message?.assistant?.metadata?.schoolId;
    if (!schoolId) {
        console.log('[BookAppointment] ❌ No schoolId in assistant metadata');
        return { success: false, error: 'School not identified. Please try again.' };
    }
    console.log('[BookAppointment] School ID:', schoolId);

    try {
        // Parse date/time into UTC
        const localDateTime = new Date(`${date}T${time}:00`);
        const start = parseLocalDateTimeToUTC(localDateTime.toISOString(), 'America/Chicago')
            || localDateTime;

        console.log('[BookAppointment] Parsed date/time:', { input: `${date}T${time}:00`, startUTC: start.toISOString() });

        if (isNaN(start.getTime())) {
            console.log('[BookAppointment] ❌ Invalid date/time');
            return { success: false, error: 'Invalid date or time format.' };
        }

        const end = new Date(start.getTime() + 30 * 60 * 1000);
        console.log('[BookAppointment] Slot:', start.toISOString(), '→', end.toISOString());

        // Check availability
        console.log('[BookAppointment] Checking slot availability...');
        const { available, error: slotError } = await isSlotAvailable(schoolId, start, end);
        console.log('[BookAppointment] Availability check:', { available, slotError });
        if (!available) {
            console.log('[BookAppointment] ❌ Slot not available:', slotError);
            return { success: false, error: slotError || 'That time slot is no longer available.' };
        }

        // Create calendar event
        const title = `School Tour – ${parent_name}`;
        const description = `Tour for ${parent_name}. Phone: ${parent_phone || 'N/A'}. Email: ${parent_email || 'N/A'}. Child: ${child_name || 'N/A'} (${child_age || 'N/A'}). Reason: ${reason || 'Inquiry'}.`;

        console.log('[BookAppointment] Creating calendar event...');
        const calResult = await createCalendarEvent(schoolId, {
            title,
            startDateTime: start,
            endDateTime: end,
            description,
            parentEmail: parent_email || undefined,
        });
        console.log('[BookAppointment] Calendar result:', JSON.stringify(calResult).slice(0, 300));

        // Create tour booking record
        console.log('[BookAppointment] Creating TourBooking record...');
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
        console.log('[BookAppointment] TourBooking created:', tourBooking._id.toString());

        // Send confirmation email
        if (parent_email) {
            const { sendTourConfirmation } = require('../services/automation');
            console.log('[BookAppointment] Sending confirmation email to:', parent_email);
            sendTourConfirmation(schoolId, tourBooking).catch(err =>
                console.error('[BookAppointment] Confirmation email error:', err.message)
            );
        }

        console.log(`[BookAppointment] ✅ Tour booked: ${parent_name} on ${date} at ${time}`);
        return {
            success: true,
            message: `Tour booked for ${parent_name} on ${date} at ${time}. A confirmation email will be sent.`,
            booking_id: tourBooking._id.toString(),
            calendar_provider: calResult.success ? calResult.provider : 'none',
        };

    } catch (err) {
        console.error('[BookAppointment] ❌ Error:', err.message);
        console.error('[BookAppointment] Stack:', err.stack?.split('\n').slice(0, 5).join('\n'));
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
    // Skip the first message (system prompt / greeting template)
    const transcriptArray = messages.slice(1).map(m => ({
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
            calledNumberDigits: (message.phoneNumber?.number || '').replace(/\D/g, '').slice(-10),
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
