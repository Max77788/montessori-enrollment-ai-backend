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

        const calledNumber = req.body?.phoneNumber?.number || req.body?.to || '';
        const customerNumber = req.body?.customer?.number || req.body?.from || '';
        const callId = req.body?.call?.id || '';

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
         */
        function buildResponse(school) {
            const kb = formatKnowledgeBase(school.qaPairs);
            return {
                assistantId: school.vapiAssistantId,
                assistantOverrides: {
                    variableValues: {
                        school_id: school._id.toString(),
                        school_name: school.name,
                        backend_url: baseDomain,
                        knowledge_base: kb,
                    }
                }
            };
        }

        // ── No called number → return fallback ──────────────────────
        if (!calledNumber) {
            console.warn('[VAPI →] ⚠️ No called number — using first active school as fallback');
            const school = await School.findOne({ status: 'active', vapiAssistantId: { $ne: '' } })
                .select('vapiAssistantId name _id qaPairs')
                .lean();

            if (!school) {
                console.error('[VAPI →] ❌ No active school with VAPI assistant found');
                return res.status(404).json({ error: 'No active school with VAPI assistant found' });
            }

            const response = buildResponse(school);
            console.log('[VAPI →] Fallback response:');
            console.log('[VAPI →]   school_id:', response.assistantOverrides.variableValues.school_id);
            console.log('[VAPI →]   school_name:', response.assistantOverrides.variableValues.school_name);
            console.log('[VAPI →]   backend_url:', response.assistantOverrides.variableValues.backend_url);
            console.log('[VAPI →]   knowledge_base:', response.assistantOverrides.variableValues.knowledge_base.length, 'chars');
            console.log('[VAPI →]   assistantId:', response.assistantId);
            console.log(`[VAPI →] Completed in ${Date.now() - startTime}ms`);
            console.log('══════════════════════════════════════════════════════');
            return res.json(response);
        }

        // ── Find school by phone number ──────────────────────────────
        const normalizedCalled = normalizePhone(calledNumber);
        console.log('[VAPI →] Normalized called number:', normalizedCalled);

        const schools = await School.find({ status: 'active', vapiAssistantId: { $ne: '' } })
            .select('aiNumber name vapiAssistantId _id qaPairs')
            .lean();

        console.log(`[VAPI →] Active schools with VAPI: ${schools.length}`);
        schools.forEach(s => {
            const normalizedNum = normalizePhone(s.aiNumber);
            const match = normalizedNum === normalizedCalled ? ' ← MATCH' : '';
            console.log(`[VAPI →]   "${s.name}" | aiNumber=${s.aiNumber || 'NONE'} | normalized=${normalizedNum}${match}`);
        });

        const school = schools.find(s => normalizePhone(s.aiNumber) === normalizedCalled);

        if (!school) {
            console.warn(`[VAPI →] ⚠️ No school matched called number: ${normalizedCalled}`);
            const fallback = schools[0];
            if (fallback) {
                console.warn(`[VAPI →] Using fallback: "${fallback.name}"`);
                const response = buildResponse(fallback);
                console.log('[VAPI →] Fallback response — school_id:', response.assistantOverrides.variableValues.school_id);
                console.log(`[VAPI →] Completed in ${Date.now() - startTime}ms`);
                console.log('══════════════════════════════════════════════════════');
                return res.json(response);
            }
            console.error(`[VAPI →] ❌ No schools with VAPI at all`);
            console.log('══════════════════════════════════════════════════════');
            return res.status(404).json({ error: 'No school found for this number' });
        }

        console.log(`[VAPI →] ✅ Matched: "${school.name}" (${school._id})`);
        console.log(`[VAPI →] Q&A pairs: ${(school.qaPairs || []).length}`);

        const response = buildResponse(school);
        console.log('[VAPI →] Response summary:');
        console.log('[VAPI →]   school_id:', response.assistantOverrides.variableValues.school_id);
        console.log('[VAPI →]   school_name:', response.assistantOverrides.variableValues.school_name);
        console.log('[VAPI →]   backend_url:', response.assistantOverrides.variableValues.backend_url);
        console.log('[VAPI →]   knowledge_base:', response.assistantOverrides.variableValues.knowledge_base.length, 'chars');
        console.log('[VAPI →]   assistantId:', response.assistantId);
        console.log(`[VAPI →] Completed in ${Date.now() - startTime}ms`);
        console.log('══════════════════════════════════════════════════════');

        res.json(response);

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
    console.log(`[VAPI Webhook] Received: type=${msgType} callId=${callId}`);

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

    const transcriptArray = messages.map(m => ({
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
            await ElevenLabsWebhook.findByIdAndUpdate(webhookDoc._id, {
                summary: message.analysis.summary,
                ai_processed: true,
            });
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
