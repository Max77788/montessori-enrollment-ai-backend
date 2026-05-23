/**
 * VAPI Inbound Routes — Dynamic Domain
 *
 * POST /vapi/assistant-request
 *   Called by VAPI when an inbound call arrives. Finds the school by
 *   the dialed phone number and returns the assistant config with
 *   school_id injected as a variable override.
 *
 * POST /vapi/webhook
 *   Receives end-of-call reports, transcripts, tool results from VAPI.
 *   Processes call data and stores in the database.
 *
 * Both routes dynamically construct their own URLs from the request.
 * NO hardcoded domains.
 */

const express = require('express');
const mongoose = require('mongoose');
const School = require('../models/School');
const ElevenLabsWebhook = require('../models/ElevenLabsWebhook');
const TourBooking = require('../models/TourBooking');
const CallLog = require('../models/CallLog');
const { processTranscript } = require('../services/openaiService');
const { createCalendarEvent, isSlotAvailable } = require('../services/calendarService');
const { sendEmail } = require('../services/mailService');
const { deductCallMinutes } = require('../services/billingService');
const { validateWebhookSignature } = require('../services/vapiService');

const router = express.Router();

// ── Helpers ────────────────────────────────────────────────────────────────

function normalizePhone(phone) {
    if (!phone || typeof phone !== 'string') return '';
    const digits = phone.replace(/\D/g, '');
    return digits.startsWith('1') && digits.length === 11 ? `+${digits}` : digits ? `+1${digits}` : '';
}

/**
 * Build the base domain from the incoming request.
 * Uses BACKEND_URL env var if set, otherwise constructs from protocol + host.
 */
function getBaseDomain(req) {
    if (process.env.BACKEND_URL) return process.env.BACKEND_URL;
    return `${req.protocol}://${req.get('host')}`;
}

// ────────────────────────────────────────────────────────────────────────────
// POST /vapi/assistant-request
// ────────────────────────────────────────────────────────────────────────────
// VAPI calls this when an inbound call arrives. It expects a response with
// the assistantId and optional overrides (variable values injected into the
// assistant prompt).
//
// Request body (VAPI):
//   { phoneNumber: { number: "+15551234567" }, customer: { number: "+15559876543" }, ... }
//
// Response:
//   { assistantId: "vapi-xxx", assistantOverrides: { variableValues: { school_id: "...", school_name: "...", backend_url: "...", knowledge_base: "..." } } }
// ────────────────────────────────────────────────────────────────────────────
router.post('/assistant-request', async (req, res) => {
    const startTime = Date.now();
    try {
        const baseDomain = getBaseDomain(req);

        // ── Log the FULL incoming request ────────────────────────────
        console.log('══════════════════════════════════════════════════════');
        console.log('[VAPI ←] POST /vapi/assistant-request');
        console.log('[VAPI ←] Timestamp:', new Date().toISOString());
        console.log('[VAPI ←] IP:', req.ip || req.connection?.remoteAddress);
        console.log('[VAPI ←] Headers:', JSON.stringify({
            host: req.get('host'),
            origin: req.get('origin'),
            referer: req.get('referer'),
            'user-agent': req.get('user-agent'),
            'content-type': req.get('content-type'),
            'x-vapi-signature': req.get('x-vapi-signature') ? 'present (' + (req.get('x-vapi-signature') || '').slice(0, 20) + '...)' : 'missing',
        }));
        console.log('[VAPI ←] Body keys:', Object.keys(req.body || {}).join(', ') || 'EMPTY');
        console.log('[VAPI ←] Full body:', JSON.stringify(req.body, null, 2).slice(0, 2000));

        // Parse both old and new VAPI request formats.
        // New format: { message: { type: "assistant-request", call: { phoneNumberId: "...", customer: { number: "..." } } } }
        // Old format: { phoneNumber: { number: "..." }, customer: { number: "..." } }
        const msg = req.body?.message || req.body || {};
        const call = msg.call || msg;
        const calledNumber = msg.phoneNumber?.number || call.phoneNumber?.number || req.body?.to || '';
        const customerNumber = call.customer?.number || msg.customer?.number || '';
        const callId = call.id || '';

        // Hardcoded fallback assistant — always used when no school-specific assistant found
        const DEFAULT_ASSISTANT_ID = '46ac46e5-cbcb-400f-9101-b404b5351005';

        console.log('[VAPI ←] Called (to):  ', calledNumber || 'NOT PROVIDED');
        console.log('[VAPI ←] Customer (from):', customerNumber || 'NOT PROVIDED');
        console.log('[VAPI ←] Call ID:', callId || 'NOT PROVIDED');
        console.log('[VAPI ←] Base domain:', baseDomain);

        /**
         * Format qaPairs into a knowledge base text string for the AI prompt.
         */
        function formatKnowledgeBase(qaPairs) {
            if (!Array.isArray(qaPairs) || qaPairs.length === 0) return '';
            const formatted = qaPairs
                .filter(p => p.question && p.answer)
                .map((p, i) => `Q${i + 1}: ${p.question}\nA${i + 1}: ${p.answer}`)
                .join('\n\n');
            return formatted;
        }

        /**
         * Build the response for a given school document.
         * Uses the school's vapiAssistantId if set, otherwise falls back to DEFAULT_ASSISTANT_ID.
         */
        function buildResponse(school) {
            const kb = formatKnowledgeBase(school.qaPairs);
            const asstId = school.vapiAssistantId || DEFAULT_ASSISTANT_ID;
            const cleanBaseUrl = baseDomain.replace(/\/+$/, ''); // strip trailing slash
            const calendarProvider = school.preferredCalendar || 'google';
            const tourBookingLink = school.tourBookingLink || '';
            const humanTransferEnabled = !!school.enableHumanTransfer;
            const transferNumber = (humanTransferEnabled && (school.humanTransferPhoneNumber || school.escalationNumber)) || '';

            console.log('[VAPI →] Using assistantId:', asstId, school.vapiAssistantId ? '(from school)' : '(DEFAULT fallback)');
            console.log('[VAPI →] Calendar:', calendarProvider);
            console.log('[VAPI →] Human transfer:', humanTransferEnabled ? `ENABLED → ${transferNumber || 'NO NUMBER'}` : 'DISABLED');
            if (tourBookingLink) console.log('[VAPI →] Tour booking link:', tourBookingLink);

            // Transfer call tool — only when BOTH enabled AND number provided
            const tools = [];
            if (humanTransferEnabled && transferNumber) {
                tools.push({
                    type: 'transferCall',
                    destinations: [
                        {
                            type: 'number',
                            number: transferNumber,
                            message: 'Please hold while I connect you to the school.',
                        }
                    ]
                });
                console.log('[VAPI →] Transfer tool added — number:', transferNumber);
            } else if (humanTransferEnabled && !transferNumber) {
                console.log('[VAPI →] ⚠️ Human transfer enabled but no forwarding number — tool NOT added');
            }

            const response = {
                assistantId: asstId,
                assistantOverrides: {
                    variableValues: {
                        school_id: school._id.toString(),
                        school_name: school.name,
                        backend_url: cleanBaseUrl,
                        knowledge_base: kb,
                        customer_number: customerNumber || '',
                        calendar_provider: calendarProvider,
                        business_hours_start: school.businessHoursStart || '09:00',
                        business_hours_end: school.businessHoursEnd || '17:00',
                        school_address: school.address || '',
                        tour_booking_link: tourBookingLink || '[not provided]',
                        is_human_transfer: !!(humanTransferEnabled && transferNumber),
                    }
                }
            };

            if (tools.length > 0) {
                // VAPI API spec: tools are appended via "tools:append" field on assistantOverrides
                response.assistantOverrides['tools:append'] = tools;
            }

            return response;
        }

        // ── Find school by VAPI phone number ID or phone number ──────
        const vapiPhoneId = call.phoneNumberId || msg.phoneNumberId || '';
        let school = null;

        // Strategy 1: Look up by VAPI phone number ID from our PhoneNumber model
        if (vapiPhoneId && !calledNumber) {
            const PhoneNumber = require('../models/PhoneNumber');
            const phoneDoc = await PhoneNumber.findOne({ vapiPhoneId: vapiPhoneId }).lean();
            if (phoneDoc && phoneDoc.schoolId) {
                school = await School.findById(phoneDoc.schoolId)
                    .select('vapiAssistantId name _id qaPairs aiNumber preferredCalendar businessHoursStart businessHoursEnd address humanTransferPhoneNumber escalationNumber enableHumanTransfer tourBookingLink')
                    .lean();
                console.log(`[VAPI →] Found by VAPI phone ID: "${school?.name}" (phone: ${phoneDoc.phone_number})`);
            }
        }

        // Strategy 2: Look up by called phone number (old format / direct number)
        if (!school && calledNumber) {
            const normalizedCalled = normalizePhone(calledNumber);
            console.log('[VAPI →] Normalized called number:', normalizedCalled);

            const schools = await School.find({ status: 'active' })
                .select('aiNumber name vapiAssistantId _id qaPairs preferredCalendar businessHoursStart businessHoursEnd address humanTransferPhoneNumber escalationNumber enableHumanTransfer tourBookingLink')
                .lean();

            console.log(`[VAPI →] Active schools: ${schools.length}`);
            schools.forEach(s => {
                const normalizedNum = normalizePhone(s.aiNumber);
                const match = normalizedNum === normalizedCalled ? ' ← MATCH' : '';
                console.log(`[VAPI →]   "${s.name}" | aiNumber=${s.aiNumber || 'NONE'} | normalized=${normalizedNum}${match}`);
            });

            school = schools.find(s => normalizePhone(s.aiNumber) === normalizedCalled) || null;
        }

        // Strategy 3: Fallback — use first active school
        if (!school) {
            console.warn('[VAPI →] ⚠️ No school found — using first active school as fallback');
            school = await School.findOne({ status: 'active' })
                .select('vapiAssistantId name _id qaPairs preferredCalendar businessHoursStart businessHoursEnd address humanTransferPhoneNumber escalationNumber')
                .lean();

            if (!school) {
                console.error('[VAPI →] ❌ No active school found');
                return res.status(404).json({ error: 'No active school found' });
            }
        }

        console.log(`[VAPI →] School: "${school.name}" (${school._id}), vapiAssistantId: ${school.vapiAssistantId || 'NOT SET → using default'}`);

        const response = buildResponse(school);
        console.log('[VAPI →] Response:');
        console.log('[VAPI →]   assistantId:', response.assistantId);
        console.log('[VAPI →]   school_id:', response.assistantOverrides.variableValues.school_id);
        console.log('[VAPI →]   school_name:', response.assistantOverrides.variableValues.school_name);
        console.log('[VAPI →]   backend_url:', response.assistantOverrides.variableValues.backend_url);
        console.log('[VAPI →]   knowledge_base:', response.assistantOverrides.variableValues.knowledge_base.length, 'chars');
        console.log('[VAPI →] FULL RESPONSE OBJECT:', JSON.stringify(response, null, 2));
        console.log(`[VAPI →] Completed in ${Date.now() - startTime}ms`);
        console.log('══════════════════════════════════════════════════════');
        return res.json(response);

    } catch (err) {
        console.error('[VAPI →] ❌ Exception after', Date.now() - startTime, 'ms:', err.message);
        console.error('[VAPI →] Stack:', err.stack?.split('\n').slice(0, 4).join('\n'));
        console.log('══════════════════════════════════════════════════════');
        res.status(500).json({ error: 'Internal server error' });
    }
});

// ────────────────────────────────────────────────────────────────────────────
// POST /vapi/webhook
// ────────────────────────────────────────────────────────────────────────────
// Receives post-call events from VAPI: end-of-call-report, tool-results, etc.
// Stores transcripts, runs AI analysis, deducts minutes, creates bookings.
// ────────────────────────────────────────────────────────────────────────────
router.post('/webhook', async (req, res) => {
    const payload = req.body || {};

    // Validate signature (non-blocking)
    const validSig = validateWebhookSignature(req);
    if (!validSig) {
        console.warn('[VAPI Webhook] Invalid signature — logging but still processing');
    }

    const msgType = payload?.message?.type || 'unknown';
    const callId = payload?.message?.call?.id || 'unknown';
    if (msgType !== 'transcript') {
        console.log(`[VAPI Webhook] Received: type=${msgType} callId=${callId}`);
    }

    // Immediately acknowledge
    res.status(200).json({ status: 'received' });

    // Process async
    if (msgType === 'end-of-call-report') {
        processEndOfCallReport(payload, req).catch(err =>
            console.error('[VAPI Webhook] Async error:', err)
        );
    } else if (msgType === 'tool-results') {
        console.log('[VAPI Webhook] Tool results received:', JSON.stringify(payload.message?.toolResults || {}).slice(0, 300));
    }
});

/**
 * Process end-of-call report from VAPI.
 */
async function processEndOfCallReport(payload, req) {
    const baseDomain = getBaseDomain(req);
    const message = payload?.message || {};
    const callId = message.call?.id || 'unknown';
    const assistantId = message.assistant?.id || '';
    const schoolId = message.assistant?.metadata?.schoolId
        || message.assistantOverrides?.variableValues?.school_id
        || null;

    console.log(`[VAPI Webhook] Processing end-of-call — callId=${callId}`);
    console.log(`[VAPI Webhook] School: ${schoolId || 'not identified'}`);

    // Parse transcript from messages array
    const messages = message.artifact?.messages || [];
    const transcriptText = message.artifact?.transcript || '';
    const recordingUrl = message.artifact?.recordingUrl || '';

    // Skip the first message (system prompt / greeting template)
    const transcriptArray = messages.slice(1).map(m => ({
        role: m.role === 'assistant' ? 'bot' : 'user',
        message: m.message || m.content || '',
        time: m.time || 0,
    }));

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
                vapi: {
                    cost: message.cost,
                    endedReason: message.endedReason,
                    recordingUrl,
                    analysis: message.analysis || null,
                }
            },
            raw_payload: payload,
            processed: false,
            received_at: new Date(),
            schoolId: schoolObjectId,
            calledNumberDigits: (message.phoneNumber?.number || '').replace(/\D/g, '').slice(-10),
        });

        console.log(`[VAPI Webhook] Saved: ${webhookDoc._id}`);

        // Deduct call minutes
        if (schoolObjectId) {
            deductCallMinutes(webhookDoc).catch(err =>
                console.error('[VAPI Webhook] Minute deduction error:', err)
            );
        }

        // AI analysis
        if (transcriptArray.length > 0 && schoolObjectId) {
            const { processTranscriptWithAI } = require('./webhook');
            processTranscriptWithAI(webhookDoc._id, transcriptArray).catch(err =>
                console.error('[VAPI Webhook] AI analysis error:', err)
            );
        }

        // Use VAPI analysis if available
        if (message.analysis?.summary && schoolObjectId) {
            // Store summary + full structured data from VAPI analysis
            const updateData = {
                summary: message.analysis.summary || '',
                ai_processed: true,
            };
            if (message.analysis.structuredData) {
                updateData['metadata.vapi_structured_data'] = message.analysis.structuredData;
                console.log('[VAPI Webhook] Structured data stored:', JSON.stringify(message.analysis.structuredData).slice(0, 300));
            }
            if (message.analysis.successEvaluation) {
                updateData['metadata.vapi_success_evaluation'] = message.analysis.successEvaluation;
            }
            await ElevenLabsWebhook.findByIdAndUpdate(webhookDoc._id, updateData);
        }

        // Create CallLog
        if (schoolObjectId) {
            await CallLog.create({
                schoolId: schoolObjectId,
                callerName: message.customer?.name || 'Unknown',
                callerPhone: message.customer?.number || '',
                callType: 'inquiry',
                duration: message.startedAt && message.endedAt
                    ? Math.round((new Date(message.endedAt) - new Date(message.startedAt)) / 1000)
                    : 0,
                recordingUrl,
            });
        }

    } catch (err) {
        console.error('[VAPI Webhook] Error:', err);
    }
}

module.exports = router;
