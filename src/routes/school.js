const express = require('express');
const mongoose = require('mongoose');
const axios = require('axios');
const FormData = require('form-data');
const School = require('../models/School');
const CallLog = require('../models/CallLog');
const Integration = require('../models/Integration');
const Followup = require('../models/Followup');
const FormQuestion = require('../models/FormQuestion');
const Referral = require('../models/Referral');
const ReferralLink = require('../models/ReferralLink');
const InquirySubmission = require('../models/InquirySubmission');
const TourBooking = require('../models/TourBooking');
const ElevenLabsWebhook = require('../models/ElevenLabsWebhook');
const voiceAISchema = require('../models/VoiceAI');
const AiNumberRequest = require('../models/AiNumberRequest');
const { authMiddleware, schoolOnly } = require('../middleware/auth');
const { getGoogleAuthUrl, getOutlookAuthUrl } = require('./integrations');
const { getCallDurationSeconds } = require('../utils/webhookHelpers');
const {
    formatQAPairsForKB,
    ingestKnowledgeBaseDocument,
    patchAgentPrompt,
    registerTool,
    createSchoolAgent,
    APPOINTMENT_AGENT_PROMPT
} = require('../utils/elevenlabs');
const {
    generateWordCloud,
    extractTourDetails
} = require('../utils/openai');


// APPOINTMENT_AGENT_PROMPT is now imported from ../utils/elevenlabs


const router = express.Router();
// Apply auth middleware to all school routes
router.use(authMiddleware, schoolOnly);

function hasStableTagCache(webhookDoc) {
    return Boolean(
        webhookDoc
        && (webhookDoc.ai_processed || webhookDoc.aiProcessed)
        && Array.isArray(webhookDoc.extractedTags)
        && webhookDoc.extractedTags.length > 0
    );
}

function buildCachedComprehensiveData(webhookDoc) {
    return {
        tags: webhookDoc.extractedTags || [],
        childName: webhookDoc.extractedChildName || webhookDoc.tour_booking_extracted?.childName || '',
        childAge: webhookDoc.extractedChildAge || webhookDoc.tour_booking_extracted?.childAge || '',
        language: webhookDoc.extractedLanguage || '',
        missingDetails: webhookDoc.extractedMissingDetails || []
    };
}

// Helper function to format Q&A pairs is now imported from elevenlabs utility

// Helper function to delete a knowledge base document from ElevenLabs
async function deleteKnowledgeBaseDocument(documentId) {
    if (!documentId) return;

    const baseUrl = process.env.ELEVENLABS_API_URL;
    if (!baseUrl) {
        console.warn('[KB] ELEVENLABS_API_URL not configured, skipping KB delete');
        return;
    }

    try {
        const url = `${baseUrl}/api/v1/knowledge-base/${documentId}`;
        console.log(`[KB DELETE] Request URL: ${url}`);
        console.log(`[KB DELETE] Document ID: ${documentId}`);

        const response = await axios.delete(url);
        console.log(`[KB DELETE] Response Status: ${response.status}`);
        console.log(`[KB DELETE] Response Data:`, JSON.stringify(response.data, null, 2));
        console.log(`[KB] Successfully deleted document ${documentId}`);
    } catch (err) {
        console.error(`[KB DELETE] Failed to delete document ${documentId}`);
        console.error(`[KB DELETE] Error Status:`, err.response?.status);
        console.error(`[KB DELETE] Error Data:`, JSON.stringify(err.response?.data || {}, null, 2));
        console.error(`[KB DELETE] Error Message:`, err.message);
        // Don't throw - we'll continue to create new document
    }
}

// PATCH agent with only knowledge_base_ids (used after questionnaire KB DELETE/POST)
async function patchAgentKnowledgeBaseOnly(agentId, documentId) {
    const baseUrl = process.env.ELEVENLABS_API_URL;
    if (!baseUrl) {
        console.warn('[Agent PATCH KB] ELEVENLABS_API_URL not configured, skipping');
        return null;
    }
    if (!agentId) {
        console.warn('[Agent PATCH KB] AGENT_ID not configured, skipping');
        return null;
    }
    try {
        const url = `${baseUrl}/api/v1/agents/${agentId}/prompt`;
        const payload = {
            knowledge_base_ids: documentId && documentId.trim() ? [documentId] : []
        };
        console.log('[Agent PATCH KB] PATCH', url, 'payload:', JSON.stringify(payload));
        const response = await axios.patch(url, payload, {
            headers: {
                'accept': 'application/json',
                'Content-Type': 'application/json',
                ...(process.env.ELEVENLABS_API_KEY && { 'Authorization': `Bearer ${process.env.ELEVENLABS_API_KEY}` })
            }
        });
        console.log('[Agent PATCH KB] Response', response.status, JSON.stringify(response.data));
        return response.data;
    } catch (err) {
        console.error('[Agent PATCH KB] Failed:', err.response?.status, err.response?.data, err.message);
        throw err;
    }
}

// Helper function to update agent with knowledge base ID (full config: first_message, prompt, knowledge_base_ids, tool_ids)
async function updateAgentWithKnowledgeBase(
    agentId,
    firstMessage,
    systemPrompt,
    knowledgeBaseId,
    toolIds = [],
    humanTransfer = { enabled: false, condition: '', phoneNumber: '' }
) {
    const baseUrl = process.env.ELEVENLABS_API_URL;
    if (!baseUrl) {
        console.warn('[Agent PATCH] ELEVENLABS_API_URL not configured, skipping agent update');
        return null;
    }

    if (!agentId) {
        console.warn('[Agent PATCH] AGENT_ID not configured, skipping agent update');
        return null;
    }

    try {
        const url = `${baseUrl}/api/v1/agents/${agentId}/prompt`;
        const patchStartedAt = new Date().toISOString();

        const fullPrompt = `${systemPrompt || ''}\n\n${APPOINTMENT_AGENT_PROMPT}`;

        const payload = {
            first_message: firstMessage || '',
            knowledge_base_ids: knowledgeBaseId && knowledgeBaseId.trim() ? [knowledgeBaseId] : [],
            language: 'en',
            system_prompt: fullPrompt,
            enable_human_transfer: Boolean(humanTransfer?.enabled),
        };

        if (humanTransfer?.enabled && humanTransfer?.condition && humanTransfer?.phoneNumber) {
            payload.human_transfer_rules = [{
                condition: humanTransfer.condition,
                phone_number: humanTransfer.phoneNumber,
                transfer_type: 'sip_refer'
            }];

            // Keep built-in transfer tool explicitly active so ElevenLabs Tools UI reflects the rule.
            payload.built_in_tools = {
                transfer_to_number: {
                    type: 'system',
                    name: 'transfer_to_number',
                    response_timeout_secs: 20,
                    disable_interruptions: false,
                    force_pre_tool_speech: false,
                    pre_tool_speech: 'auto',
                    assignments: [],
                    tool_call_sound: null,
                    tool_call_sound_behavior: 'auto',
                    tool_error_handling_mode: 'auto',
                    params: {
                        system_tool_type: 'transfer_to_number',
                        transfers: [{
                            custom_sip_headers: [],
                            transfer_destination: {
                                type: 'phone',
                                phone_number: humanTransfer.phoneNumber
                            },
                            transfer_type: 'sip_refer',
                            post_dial_digits: null,
                            phone_number: humanTransfer.phoneNumber,
                            condition: humanTransfer.condition
                        }],
                        enable_client_message: true
                    }
                }
            };
        } else {
            // Explicitly clear transfer rules AND disable the built-in tool
            payload.human_transfer_rules = [];
            payload.enable_human_transfer = false;
            payload.built_in_tools = {
                transfer_to_number: {
                    type: 'system',
                    name: 'transfer_to_number',
                    params: {
                        system_tool_type: 'transfer_to_number',
                        transfers: [],
                        enable_client_message: false
                    }
                }
            };
        }

        console.log('[Agent PATCH] ========== PATCH REQUEST ==========');
        console.log(`[Agent PATCH] HIT at ${patchStartedAt}`);
        console.log(`[Agent PATCH] Request URL: ${url}`);
        console.log(`[Agent PATCH] Agent ID: ${agentId}`);
        console.log(`[Agent PATCH] Tool IDs:`, payload.tool_ids);
        console.log('[Agent PATCH] built_in_tools.transfer_to_number enabled:', Boolean(payload?.built_in_tools?.transfer_to_number));
        console.log(`[Agent PATCH] Payload (full):`, JSON.stringify(payload, null, 2));
        console.log('[Agent PATCH] ====================================');

        const response = await axios.patch(url, payload, {
            headers: {
                'Content-Type': 'application/json',
                ...(process.env.ELEVENLABS_API_KEY && { 'Authorization': `Bearer ${process.env.ELEVENLABS_API_KEY}` })
            }
        });

        // ElevenLabs may accept human_transfer_rules on /prompt but still keep built-in transfer tool disabled.
        // Ensure transfer_to_number is explicitly enabled via /agents endpoint when human transfer is ON.
        if (humanTransfer?.enabled && humanTransfer?.condition && humanTransfer?.phoneNumber) {
            try {
                const ensureToolUrl = `${baseUrl}/api/v1/agents/${agentId}`;
                const ensureToolPayload = {
                    conversation_config: {
                        agent: {
                            prompt: {
                                built_in_tools: {
                                    transfer_to_number: {
                                        type: 'system',
                                        name: 'transfer_to_number',
                                        response_timeout_secs: 20,
                                        disable_interruptions: false,
                                        force_pre_tool_speech: false,
                                        pre_tool_speech: 'auto',
                                        assignments: [],
                                        tool_call_sound: null,
                                        tool_call_sound_behavior: 'auto',
                                        tool_error_handling_mode: 'auto',
                                        params: {
                                            system_tool_type: 'transfer_to_number',
                                            transfers: [{
                                                custom_sip_headers: [],
                                                transfer_destination: {
                                                    type: 'phone',
                                                    phone_number: humanTransfer.phoneNumber
                                                },
                                                transfer_type: 'sip_refer',
                                                post_dial_digits: null,
                                                phone_number: humanTransfer.phoneNumber,
                                                condition: humanTransfer.condition
                                            }],
                                            enable_client_message: true
                                        }
                                    }
                                }
                            }
                        }
                    }
                };

                const ensureToolResponse = await axios.patch(ensureToolUrl, ensureToolPayload, {
                    headers: {
                        'Content-Type': 'application/json',
                        ...(process.env.ELEVENLABS_API_KEY && { 'Authorization': `Bearer ${process.env.ELEVENLABS_API_KEY}` })
                    }
                });
                console.log('[Agent PATCH] transfer_to_number ensured via /agents endpoint');
                console.log('[Agent PATCH] /agents ensure status:', ensureToolResponse.status);
            } catch (ensureErr) {
                console.error('[Agent PATCH] Failed to ensure transfer_to_number via /agents endpoint:', ensureErr?.response?.status, ensureErr?.response?.data || ensureErr?.message);
            }
        } else {
            // When disabling transfer, also clear it via the /agents endpoint
            try {
                const ensureToolUrl = `${baseUrl}/api/v1/agents/${agentId}`;
                const ensureToolPayload = {
                    conversation_config: {
                        agent: {
                            prompt: {
                                built_in_tools: {
                                    transfer_to_number: {
                                        type: 'system',
                                        name: 'transfer_to_number',
                                        params: {
                                            system_tool_type: 'transfer_to_number',
                                            transfers: [],
                                            enable_client_message: false
                                        }
                                    }
                                }
                            }
                        }
                    }
                };
                const ensureToolResponse = await axios.patch(ensureToolUrl, ensureToolPayload, {
                    headers: {
                        'Content-Type': 'application/json',
                        ...(process.env.ELEVENLABS_API_KEY && { 'Authorization': `Bearer ${process.env.ELEVENLABS_API_KEY}` })
                    }
                });
                console.log('[Agent PATCH] transfer_to_number DISABLED via /agents endpoint');
            } catch (ensureErr) {
                console.error('[Agent PATCH] Failed to disable transfer_to_number via /agents endpoint:', ensureErr?.response?.status, ensureErr?.response?.data || ensureErr?.message);
            }
        }

        console.log('[Agent PATCH] ========== PATCH RESPONSE ==========');
        console.log(`[Agent PATCH] SUCCESS at ${new Date().toISOString()}`);
        console.log(`[Agent PATCH] Response Status: ${response.status}`);
        console.log(`[Agent PATCH] Response Headers:`, JSON.stringify(response.headers, null, 2));
        console.log(`[Agent PATCH] Response Data:`, JSON.stringify(response.data, null, 2));
        console.log('[Agent PATCH] Successfully updated agent');
        console.log('[Agent PATCH] =====================================');
        return response.data;
    } catch (err) {
        console.error(`[Agent PATCH] FAILED at ${new Date().toISOString()}`);
        if (err?.response?.status !== 404) {
            console.error(`[Agent PATCH] Failed to update agent`);
            console.error(`[Agent PATCH] Error Status:`, err.response?.status);
            console.error(`[Agent PATCH] Error Data:`, JSON.stringify(err.response?.data || {}, null, 2));
            console.error(`[Agent PATCH] Error Message:`, err.message);
        }
        throw err;
    }
}

// Helper function to ingest knowledge base is now imported from elevenlabs utility

// GET /api/school/dashboard - School-specific metrics
router.get('/dashboard', async (req, res) => {
    try {
        const schoolId = req.user.schoolId;
        if (!schoolId) {
            return res.status(400).json({ error: 'No school associated with this user' });
        }

        const school = await School.findById(schoolId).select('aiNumber adminEmail').lean();

        // Get admin email notifications scoped to this school
        let adminEmailNotifications = [];
        const schoolObjectId = new mongoose.Types.ObjectId(schoolId);
        const adminEmailQuery = {
            schoolId: schoolObjectId,
            type: 'Email',
            leadName: 'Admin Notification'
        };

        // Helper to consistently normalize phones for matching
        const normalizePhone = (phone) => {
            if (!phone) return '';
            return phone.replace(/\D/g, '');
        };

        const schoolAiNumber = normalizePhone(school?.aiNumber || '');
        const userToken = req.headers.authorization?.split(' ')[1] || '';
        const backendUrl = process.env.BACKEND_URL || `${req.protocol}://${req.get('host')}`;

        const period = req.query.period || 'daily';
        let periodMs;
        let chartBars;
        if (period === 'monthly') {
            periodMs = 30 * 24 * 60 * 60 * 1000;
            chartBars = 30;
        } else if (period === 'weekly') {
            periodMs = 7 * 24 * 60 * 60 * 1000;
            chartBars = 7;
        } else {
            // daily
            periodMs = 24 * 60 * 60 * 1000;
            chartBars = 1; // show 24-hour bar chart (hourly)
        }
        const periodStart = new Date(Date.now() - periodMs);
        console.log(`[DASHBOARD DEBUG] Handling period: ${period}, Start date: ${periodStart.toISOString()}`);

        const [
            adminEmails,
            voiceAiCalls,
            schoolWebhooks,
            callLogEntries,
            actualToursBooked,
        ] = await Promise.all([
            Followup.find(adminEmailQuery)
                .sort({ createdAt: -1 })
                .limit(20)
                .lean(),
            (async () => {
                let voiceAiCallsInner = [];
                if (schoolAiNumber) {
                    try {
                        const digits = schoolAiNumber;
                        const normalizedNumber = `+${digits}`;
                        const participantId = `sip_${normalizedNumber}`;

                        const bennyDb = mongoose.connection.useDb('benny');
                        const collection = bennyDb.collection('voiceAI');

                        const rawLogs = await collection.find({ participant_id: participantId })
                            .sort({ created_at: -1 })
                            .toArray();

                        voiceAiCallsInner = rawLogs.map(log => ({
                            id: log._id.toString(),
                            callerPhone: log.participant_id ? log.participant_id.replace('sip_', '') : 'Unknown',
                            callerName: resolveName(log.participant_id ? log.participant_id.replace('sip_', '') : ''),
                            duration: log.duration_seconds || 0,
                            timestamp: log.created_at || log.timestamp || new Date(),
                            recordingUrl: log.recording_url || null,
                            callType: 'inquiry',
                            summary: '',
                            tourBookingDetected: false,
                            tourBookingDate: null,
                            aiProcessed: false
                        }));
                    } catch (err) {
                        console.error('[Dashboard] VoiceAI fetch error:', err);
                    }
                }
                return voiceAiCallsInner;
            })(),
            // Search by both discrete schoolId (best) and unique AI number (resilient fallback)
            ElevenLabsWebhook.find({
                type: 'post_call_transcription',
                $or: [
                    { schoolId: schoolObjectId },
                    {
                        'metadata.phone_call.agent_number': { $regex: schoolAiNumber || 'nevermatch' },
                    },
                    {
                        'metadata.phone_call.to_number': { $regex: schoolAiNumber || 'nevermatch' }
                    }
                ]
            })
                .select('-raw_payload -audio_base64')
                .sort({ received_at: -1 })
                .limit(100)
                .lean(),
            CallLog.find({ schoolId: schoolObjectId })
                .sort({ createdAt: -1 })
                .limit(100)
                .lean(),
            TourBooking.find({ schoolId })
                .select('phone parentName childName scheduledAt')
                .sort({ scheduledAt: -1 })
                .lean(),
        ]);

        // Create a lookup map for parent names based on normalized phone numbers
        const parentNameMap = new Map();
        actualToursBooked.forEach(tour => {
            const normalized = normalizePhone(tour.phone);
            if (normalized && tour.parentName && tour.parentName !== 'Parent') {
                parentNameMap.set(normalized, tour.parentName);
            }
        });

        // Helper to get name for a phone
        const resolveName = (phone, specificName = null) => {
            if (specificName && specificName !== 'Parent') return specificName;
            const normalized = normalizePhone(phone);
            return parentNameMap.get(normalized) || 'Parent';
        };

        adminEmailNotifications = adminEmails.map(email => ({
            id: email._id.toString(),
            recipient: email.recipient,
            status: email.status,
            subject: email.message?.split('\n')[0] || 'New Call Received',
            sentAt: email.createdAt || email.updatedAt,
            conversationId: email.message?.match(/Conversation ID: ([^\n\s]+)/)?.[1] || null,
            callerNumber: email.message?.match(/(?:Caller Name\/Number|Caller Number): ([^\n]+)/)?.[1] || null,
        }));

        const webhookCalls = schoolWebhooks.map(wh => {
            const callTimestamp = wh.metadata?.start_time_unix_secs
                ? new Date(wh.metadata.start_time_unix_secs * 1000)
                : wh.received_at;

            return {
                id: wh._id.toString(),
                conversationId: wh.conversation_id,
                callerPhone: wh.metadata?.phone_call?.from_number
                    || wh.tour_booking_extracted?.phone
                    || wh.user_id
                    || 'Web Widget',
                callerName: resolveName(wh.metadata?.phone_call?.from_number || wh.tour_booking_extracted?.phone || '', wh.tour_booking_extracted?.name || 'Parent'),
                duration: getCallDurationSeconds(wh),
                timestamp: callTimestamp,
                recordingUrl: `${backendUrl}/api/school/calls/${wh.conversation_id}/audio?token=${userToken}`,
                callType: 'inquiry',
                summary: wh.summary || '',
                tourBookingDetected: wh.tour_booking_detected || false,
                tourBookingDate: wh.tour_booking_date || null,
                aiProcessed: wh.ai_processed || false
            };
        });

        const callLogCalls = callLogEntries.map(cl => ({
            id: cl._id.toString(),
            conversationId: cl.conversation_id,
            callerPhone: cl.from_phone_number || 'Unknown',
            callerName: resolveName(cl.from_phone_number || '', cl.callerName || 'Parent'),
            duration: cl.duration || 0,
            timestamp: cl.createdAt,
            recordingUrl: cl.conversation_id ? `${backendUrl}/api/school/calls/${cl.conversation_id}/audio?token=${userToken}` : null,
            callType: cl.callType || 'inquiry',
            summary: cl.summary || '',
            tourBookingDetected: false, // Tour booking handled via separate collection
            tourBookingDate: null,
            aiProcessed: true
        }));

        // ── STEP 3: Merge and Deduplicate ──────────
        const allCallsMap = new Map();

        // Add VoiceAI base (usually more reliable for duration/SIP)
        voiceAiCalls.forEach(c => {
            const key = `${normalizePhone(c.callerPhone)}_${new Date(c.timestamp).getTime()}`;
            allCallsMap.set(key, c);
        });

        // Add CallLogs (The 92 synced calls etc)
        callLogCalls.forEach(clc => {
            const key = clc.conversationId || `${normalizePhone(clc.callerPhone)}_${new Date(clc.timestamp).getTime()}`;
            allCallsMap.set(key, clc);
        });

        // Add/Enrich with Webhooks (they have summaries & tour flags)
        webhookCalls.forEach(whc => {
            const key = whc.conversationId || `${normalizePhone(whc.callerPhone)}_${new Date(whc.timestamp).getTime()}`;
            if (allCallsMap.has(key)) {
                const existing = allCallsMap.get(key);
                allCallsMap.set(key, { ...existing, ...whc, id: existing.id });
            } else {
                allCallsMap.set(key, whc);
            }
        });

        const calls = Array.from(allCallsMap.values()).sort((a, b) =>
            new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
        );

        // Filter calls to the selected period
        const periodCalls = calls.filter(c => new Date(c.timestamp) >= periodStart);
        console.log(`[DASHBOARD DEBUG] Total calls: ${calls.length}, Period calls: ${periodCalls.length}`);

        // Calculate metrics from period calls
        const totalCalls = periodCalls.length;
        const totalDurationSeconds = periodCalls.reduce((acc, c) => acc + (c.duration || 0), 0);

        // ALL-TIME Minutes (usage tracker - never "resets" due to limited query windows)
        // IMPORTANT: We must compute this from the same merged/deduped `calls` array used for
        // the other dashboard metrics; summing only `CallLog` can undercount when some calls
        // only exist in VoiceAI (benny) and/or ElevenLabs webhooks.
        const allTimeDurationSeconds = calls.reduce((acc, c) => acc + (Number(c.duration) || 0), 0);
        const allTimeMinutes = Math.floor(allTimeDurationSeconds / 60);

        // Average Call Length (Period-based)
        const avgCallLengthSeconds = totalCalls > 0 ? Math.round(totalDurationSeconds / totalCalls) : 0;
        const avgCallLengthFormatted = `${Math.floor(avgCallLengthSeconds / 60)}m ${avgCallLengthSeconds % 60}s`;

        // Action Needed (Missed Tours / Needs Attention) - Period-based
        const actionNeeded = periodCalls.filter(c => !c.tourBookingDetected).length;

        // Chart Data
        const chartData = [];
        const nowDate = new Date();

        if (period === 'daily') {
            // 24 hourly buckets
            for (let i = 23; i >= 0; i--) {
                const bucketEnd = new Date(nowDate.getTime() - i * 60 * 60 * 1000);
                const bucketStart = new Date(bucketEnd.getTime() - 60 * 60 * 1000);
                const bucketCalls = calls.filter(c => {
                    const t = new Date(c.timestamp);
                    return t >= bucketStart && t < bucketEnd;
                });
                chartData.push({
                    name: bucketEnd.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false }),
                    calls: bucketCalls.length
                });
            }
        } else {
            // Daily buckets for weekly (7) or monthly (30)
            const todayAtMidnight = new Date();
            todayAtMidnight.setHours(0, 0, 0, 0);
            for (let i = chartBars - 1; i >= 0; i--) {
                const day = new Date(todayAtMidnight);
                day.setDate(day.getDate() - i);
                const nextDay = new Date(day);
                nextDay.setDate(day.getDate() + 1);
                const dayCalls = calls.filter(c => {
                    const t = new Date(c.timestamp);
                    return t >= day && t < nextDay;
                });
                chartData.push({
                    name: day.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
                    calls: dayCalls.length
                });
            }
        }

        // Recent calls: top 20 within selected period
        const recentCalls = periodCalls
            .slice(0, 20)
            .map(c => ({
                id: c.id,
                conversationId: c.conversationId || null,
                callerName: c.callerName,
                callerPhone: c.callerPhone,
                callType: c.callType,
                duration: Math.round(c.duration),
                timestamp: c.timestamp,
                recordingUrl: c.recordingUrl,
                summary: c.summary || '',
                tourBookingDetected: c.tourBookingDetected || false,
                tourBookingDate: c.tourBookingDate || null,
                aiProcessed: c.aiProcessed || false
            }));

        res.json({
            metrics: [
                { label: 'Total Calls', value: totalCalls, icon: 'PhoneCall' },
                { label: 'Action Needed', value: actionNeeded, icon: 'AlertTriangle' },
                { label: 'Tours Booked', value: actualToursBooked.filter(t => t.scheduledAt >= periodStart).length, icon: 'Calendar' },
                { label: 'Minutes Consumed', value: `${allTimeMinutes} / 600`, ticker: true, icon: 'Activity' },
                { label: 'Average Call Length', value: avgCallLengthFormatted, icon: 'Clock' },
            ],
            chartData,
            recentCalls,
            adminEmailNotifications,
            period,
        });
    } catch (err) {
        console.error('School dashboard error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// GET /api/school/tour-bookings - All tour bookings for the school
router.get('/tour-bookings', async (req, res) => {
    try {
        const schoolId = req.user.schoolId;
        const bookings = await TourBooking.find({ schoolId })
            .sort({ scheduledAt: -1 })
            .lean();
        res.json(bookings.map(b => ({
            id: b._id.toString(),
            parentName: b.parentName || '',
            phone: b.phone || '',
            email: b.email || '',
            childName: b.childName || '',
            childAge: b.childAge || '',
            reason: b.reason || '',
            scheduledAt: b.scheduledAt,
            calendarProvider: b.calendarProvider || null,
            calendarEmail: b.calendarEmail || '',
            reminderSent: b.reminderSent || false,
        })));
    } catch (err) {
        console.error('Tour bookings error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// GET /api/school/inquiry-submissions - All inquiry form submissions
router.get('/inquiry-submissions', async (req, res) => {
    try {
        const schoolId = req.user.schoolId;
        const submissions = await InquirySubmission.find({ schoolId })
            .sort({ submittedAt: -1 })
            .lean();
        res.json(submissions.map(s => ({
            id: s._id.toString(),
            parentName: s.parentName || '',
            email: s.email || '',
            phone: s.phone || '',
            answers: s.answers || [],
            submittedAt: s.submittedAt,
        })));
    } catch (err) {
        console.error('Inquiry submissions error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// GET /api/school/daily-insights - Needs-attention calls + today's tour details
router.get('/daily-insights', async (req, res) => {
    try {
        const schoolId = req.user.schoolId;
        const schoolObjectId = new mongoose.Types.ObjectId(schoolId);
        const school = await School.findById(schoolId).select('aiNumber wordCloud').lean();
        const normalizePhone = (p) => (p || '').replace(/\D/g, '');
        const schoolAiNumber = normalizePhone(school?.aiNumber || '');
        const userToken = req.headers.authorization?.split(' ')[1] || '';
        const backendUrl = process.env.BACKEND_URL || `${req.protocol}://${req.get('host')}`;

        // Date selection: use query param `date` (YYYY-MM-DD) or default to today
        const dateParam = req.query.date || '';
        const targetDate = dateParam ? new Date(dateParam + 'T12:00:00.000Z') : new Date();
        if (dateParam && isNaN(targetDate.getTime())) {
            return res.status(400).json({ error: 'Invalid date format. Use YYYY-MM-DD.' });
        }
        const todayStart = new Date(targetDate);
        todayStart.setHours(0, 0, 0, 0);
        const todayEnd = new Date(targetDate);
        todayEnd.setHours(23, 59, 59, 999);

        // Build "Common Parent Questions" from a broader window so it's actually useful.
        // 30 days tends to be stable enough to surface repeated topics like Fees/Cameras/After-school.
        const wordCloudStart = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

        // ── 1. Needs Attention: calls from today with no tour booked ──
        const todayWebhooks = await ElevenLabsWebhook.find({
            type: 'post_call_transcription',
            received_at: { $gte: todayStart, $lte: todayEnd },
            $or: [
                { schoolId: schoolObjectId },
                ...(schoolAiNumber ? [{ schoolId: null, 'metadata.phone_call.to_number': { $regex: schoolAiNumber.slice(-10) } }] : []),
            ]
        }).sort({ received_at: -1 }).lean();

        // Use cached word cloud from School model
        const wordCloud = school?.wordCloud || [];

        // Extract comprehensive data from transcripts using single prompt for needs-attention calls
        // Limit to 5 to prevent slow loads; skip if no OPENAI_API_KEY
        const hasOpenAI = !!process.env.OPENAI_API_KEY;
        const needsAttention = await Promise.all(
            todayWebhooks
                .filter(wh => !wh.tour_booking_detected && !wh.actionTaken)
                .slice(0, 5)
                .map(async (wh) => {
                    const transcriptText = Array.isArray(wh.transcript) 
                        ? wh.transcript.map(t => `${t.role}: ${t.message || t.text}`).join('\n')
                        : '';

                    let comprehensiveData = { tags: [], childName: '', childAge: '', language: '', missingDetails: [] };

                    // Use stable cached comprehensive data if available, otherwise extract once and persist.
                    if (hasStableTagCache(wh)) {
                        comprehensiveData = buildCachedComprehensiveData(wh);
                    } else if (transcriptText) {
                        try {
                            comprehensiveData = await extractTourDetails(transcriptText, {
                                childName: wh.tour_booking_extracted?.childName || '',
                                childAge: wh.tour_booking_extracted?.childAge || '',
                                purpose: wh.summary || ''
                            });
                            
                            // Post-processing: Remove "No child info captured" tag if child info is present
                            if (comprehensiveData.childName && comprehensiveData.childAge) {
                                comprehensiveData.tags = comprehensiveData.tags.filter(tag => 
                                    !tag.toLowerCase().includes('no child info')
                                );
                            }
                            
                            // Post-processing: Ensure "No child info captured" tag is applied if child info is missing
                            if ((!comprehensiveData.childName || !comprehensiveData.childAge) && 
                                (comprehensiveData.missingDetails && 
                                 (comprehensiveData.missingDetails.some(m => m.toLowerCase().includes('child name')) || 
                                  comprehensiveData.missingDetails.some(m => m.toLowerCase().includes('child age'))))) {
                                if (!comprehensiveData.tags.some(tag => tag.toLowerCase().includes('no child info'))) {
                                    comprehensiveData.tags.push('No child info captured');
                                }
                            }
                            
                            // Post-processing: Ensure "Partial call" tag is applied if missing_details has any field
                            if (comprehensiveData.missingDetails && comprehensiveData.missingDetails.length > 0) {
                                if (!comprehensiveData.tags.some(tag => tag.toLowerCase().includes('partial call'))) {
                                    comprehensiveData.tags.push('Partial call');
                                }
                            }
                            
                            // Cache the extracted data to the webhook document
                            await ElevenLabsWebhook.findByIdAndUpdate(wh._id, {
                                ai_processed: true,
                                extractedTags: comprehensiveData.tags,
                                extractedChildName: comprehensiveData.childName,
                                extractedChildAge: comprehensiveData.childAge,
                                extractedLanguage: comprehensiveData.language,
                                extractedMissingDetails: comprehensiveData.missingDetails
                            }).catch(err => console.error('[DAILY-INSIGHTS] Failed to cache comprehensive data:', err));
                        } catch (err) {
                            console.error('[DAILY-INSIGHTS] Failed to extract comprehensive data:', err);
                        }
                    } else if (wh.ai_processed || wh.aiProcessed) {
                        comprehensiveData = buildCachedComprehensiveData(wh);
                    }

                    return {
                        id: wh._id.toString(),
                        conversationId: wh.conversation_id,
                        callerName: wh.tour_booking_extracted?.name || 'Parent',
                        callerPhone: wh.metadata?.phone_call?.from_number || wh.tour_booking_extracted?.phone || 'Unknown',
                        summary: wh.summary || '',
                        timestamp: wh.metadata?.start_time_unix_secs
                            ? new Date(wh.metadata.start_time_unix_secs * 1000)
                            : wh.received_at,
                        recordingUrl: wh.conversation_id
                            ? `${backendUrl}/api/school/calls/${wh.conversation_id}/audio?token=${userToken}`
                            : null,
                        duration: getCallDurationSeconds(wh),
                        questionsAsked: wh.questions_asked || [],
                        actionTaken: wh.actionTaken || false,
                        actionTakenAt: wh.actionTakenAt || null,
                        actionTakenFeedback: wh.actionTakenFeedback || '',
                        feedbackHistory: wh.feedbackHistory || undefined,
                        tags: comprehensiveData.tags,
                        childName: comprehensiveData.childName,
                        childAge: comprehensiveData.childAge,
                        language: comprehensiveData.language,
                        missingDetails: comprehensiveData.missingDetails
                    };
                })
        );

        // ── 2. Today's Tours: full detail with questions from transcript ──
        const todaysTourDocs = await TourBooking.find({
            schoolId,
            scheduledAt: { $gte: todayStart, $lte: todayEnd }
        }).sort({ scheduledAt: 1 }).lean();

        // Separate tours that need processing from those already cached
        const toursToProcess = [];
        const enrichedToursMap = new Map();

        // First, add tours with usable cached AI insights to the map.
        todaysTourDocs.forEach(tour => {
            const hasUsableCachedInsights =
                tour.aiProcessed &&
                (
                    (Array.isArray(tour.questionsAsked) && tour.questionsAsked.length > 0) ||
                    Boolean((tour.highlights || '').trim())
                );

            if (hasUsableCachedInsights) {
                enrichedToursMap.set(tour._id.toString(), {
                    ...tour,
                    id: tour._id.toString(),
                    highlights: tour.highlights || '',
                    callSummary: '' // Will be enriched if webhook found
                });
            }
        });

        // Collect all phone numbers for unprocessed tours in a single query
        const unprocessedTours = todaysTourDocs.filter(tour => {
            const hasUsableCachedInsights =
                tour.aiProcessed &&
                (
                    (Array.isArray(tour.questionsAsked) && tour.questionsAsked.length > 0) ||
                    Boolean((tour.highlights || '').trim())
                );
            return !hasUsableCachedInsights;
        });
        const tourPhones = unprocessedTours.map(tour => normalizePhone(tour.phone)).filter(p => p);

        // Fetch recent school webhooks once; some providers omit phone metadata.
        const lookbackStart = new Date(todayStart);
        lookbackStart.setDate(lookbackStart.getDate() - 30);
        const allRelevantWebhooks = await ElevenLabsWebhook.find({
            type: 'post_call_transcription',
            $or: [
                { schoolId: schoolObjectId },
                ...(schoolAiNumber ? [{ schoolId: null, 'metadata.phone_call.to_number': { $regex: schoolAiNumber.slice(-10) } }] : []),
            ],
            received_at: { $gte: lookbackStart }
        }).sort({ received_at: -1 }).limit(500).lean();

        // Create a phone-to-webhook map for efficient lookup
        const phoneToWebhookMap = new Map();
        allRelevantWebhooks.forEach(wh => {
            const fromPhone = normalizePhone(wh.metadata?.phone_call?.from_number || '');
            const toPhone = normalizePhone(wh.metadata?.phone_call?.to_number || '');
            if (fromPhone && !phoneToWebhookMap.has(fromPhone)) {
                phoneToWebhookMap.set(fromPhone, wh);
            }
            if (toPhone && !phoneToWebhookMap.has(toPhone)) {
                phoneToWebhookMap.set(toPhone, wh);
            }
        });

        const normalizeName = (name) =>
            String(name || '')
                .toLowerCase()
                .replace(/[^a-z\s]/g, ' ')
                .replace(/\s+/g, ' ')
                .trim();

        const usedWebhookIds = new Set();

        // Process unprocessed tours using the pre-fetched webhooks
        unprocessedTours.forEach(tour => {
            const tourPhone = normalizePhone(tour.phone);
            let linkedWebhook = null;

            if (tourPhone) {
                linkedWebhook = phoneToWebhookMap.get(tourPhone) || null;
                if (!linkedWebhook) {
                    linkedWebhook = allRelevantWebhooks.find(wh => {
                        const fromPhone = normalizePhone(wh.metadata?.phone_call?.from_number || '');
                        const toPhone = normalizePhone(wh.metadata?.phone_call?.to_number || '');
                        return (
                            (fromPhone && fromPhone.includes(tourPhone)) ||
                            (tourPhone.includes(fromPhone) && !!fromPhone) ||
                            (toPhone && toPhone.includes(tourPhone)) ||
                            (tourPhone.includes(toPhone) && !!toPhone)
                        );
                    }) || null;
                }
            }

            // Fallback for transcripts without usable phone metadata:
            // match by parent name plus nearest call time.
            if (!linkedWebhook) {
                const tourName = normalizeName(tour.parentName);
                const tourTimeMs = new Date(tour.scheduledAt).getTime();

                if (tourName) {
                    const candidates = allRelevantWebhooks.filter(wh => {
                        if (usedWebhookIds.has(String(wh._id))) return false;

                        const extractedName = normalizeName(wh.comprehensive_result?.parent_name || '');
                        const summaryText = normalizeName(wh.summary || '');
                        const hasNameMatch =
                            extractedName.includes(tourName) ||
                            tourName.includes(extractedName) ||
                            summaryText.includes(tourName);

                        if (!hasNameMatch) return false;

                        const whTime = wh.metadata?.start_time_unix_secs
                            ? wh.metadata.start_time_unix_secs * 1000
                            : new Date(wh.received_at).getTime();
                        const hoursDelta = Math.abs(tourTimeMs - whTime) / (1000 * 60 * 60);
                        return hoursDelta <= 72;
                    });

                    if (candidates.length > 0) {
                        candidates.sort((a, b) => {
                            const aTime = a.metadata?.start_time_unix_secs
                                ? a.metadata.start_time_unix_secs * 1000
                                : new Date(a.received_at).getTime();
                            const bTime = b.metadata?.start_time_unix_secs
                                ? b.metadata.start_time_unix_secs * 1000
                                : new Date(b.received_at).getTime();
                            return Math.abs(tourTimeMs - aTime) - Math.abs(tourTimeMs - bTime);
                        });
                        linkedWebhook = candidates[0];
                    }
                }
            }

            if (linkedWebhook) {
                usedWebhookIds.add(String(linkedWebhook._id));
            }

            if (linkedWebhook) {
                const transcriptText = Array.isArray(linkedWebhook.transcript)
                    ? linkedWebhook.transcript.map(t => `${t.role}: ${t.message || t.text}`).join('\n')
                    : '';

                if (transcriptText) {
                    toursToProcess.push({
                        id: tour._id.toString(),
                        transcript: transcriptText,
                        existingDetails: {
                            childName: tour.childName,
                            childAge: tour.childAge,
                            purpose: tour.reason
                        },
                        tourDoc: tour,
                        linkedWebhook
                    });
                } else {
                    // No transcript but webhook exists
                    enrichedToursMap.set(tour._id.toString(), { ...tour, id: tour._id.toString(), linkedWebhook });
                }
            } else {
                // No webhook found
                enrichedToursMap.set(tour._id.toString(), { ...tour, id: tour._id.toString() });
            }
        });

        // Batch process the ones that need it (limit to 5, skip if no OpenAI key)
        if (toursToProcess.length > 0 && process.env.OPENAI_API_KEY) {
            console.log(`[DAILY-INSIGHTS] Batch processing ${toursToProcess.length} tours (limiting to 5)...`);
            const { batchExtractTourDetails } = require('../utils/openai');
            const toursToProcessNow = toursToProcess.slice(0, 5);
            const batchResults = await batchExtractTourDetails(toursToProcessNow);

            for (const item of toursToProcessNow) {
                const extracted = batchResults[item.id] || {};
                const safeStr = (v) => (v && typeof v === 'object' ? JSON.stringify(v) : String(v || ''));
                
                const aiDetails = {
                    childName: safeStr(extracted.childName || item.tourDoc.childName || ''),
                    childAge: safeStr(extracted.childAge || item.tourDoc.childAge || ''),
                    purpose: safeStr(extracted.purpose || item.tourDoc.reason || 'Enrollment Inquiry'),
                    questionsAsked: Array.isArray(extracted.questionsAsked) ? extracted.questionsAsked.map(q => safeStr(q)) : [],
                    notes: safeStr(extracted.notes || item.linkedWebhook.summary || '')
                };

                // Cache to DB (no await needed for each, can do bulk or background)
                TourBooking.findByIdAndUpdate(item.id, {
                    childName: aiDetails.childName,
                    childAge: aiDetails.childAge,
                    reason: aiDetails.purpose,
                    questionsAsked: aiDetails.questionsAsked,
                    highlights: aiDetails.notes,
                    aiProcessed: true
                }).catch(err => console.error(`[DAILY-INSIGHTS] Failed to cache tour ${item.id}:`, err));

                enrichedToursMap.set(item.id, {
                    ...item.tourDoc,
                    id: item.id,
                    childName: aiDetails.childName,
                    childAge: aiDetails.childAge,
                    reason: aiDetails.purpose,
                    questionsAsked: aiDetails.questionsAsked,
                    highlights: aiDetails.notes,
                    callSummary: item.linkedWebhook.summary || ''
                });
            }
        }

        const todaysTours = todaysTourDocs.map(tour => {
            const enriched = enrichedToursMap.get(tour._id.toString()) || { ...tour, id: tour._id.toString() };
            return {
                id: enriched.id,
                parentName: enriched.parentName || 'Parent',
                phone: enriched.phone || '',
                email: enriched.email || '',
                childName: enriched.childName || '',
                childAge: enriched.childAge || '',
                reason: enriched.reason || enriched.purpose || 'Enrollment Inquiry',
                scheduledAt: enriched.scheduledAt,
                calendarProvider: enriched.calendarProvider || null,
                questionsAsked: enriched.questionsAsked || [],
                highlights: enriched.highlights || enriched.notes || '',
                callSummary: enriched.callSummary || '',
                reminderSent: enriched.reminderSent || false,
                tags: Array.isArray(enriched.linkedWebhook?.extractedTags) ? enriched.linkedWebhook.extractedTags : [],
                language: enriched.linkedWebhook?.extractedLanguage || '',
            };
        });

        const todayCalls = todayWebhooks.map(wh => ({
            id: wh._id.toString(),
            timestamp: wh.metadata?.start_time_unix_secs
                ? new Date(wh.metadata.start_time_unix_secs * 1000)
                : wh.received_at,
        }));

        res.json({ needsAttention, todaysTours, wordCloud, todayCalls, targetDate: todayStart.toISOString() });
    } catch (err) {
        console.error('Daily insights error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// GET /api/school/action-needed - All action-needed items (not just today)
router.get('/action-needed', async (req, res) => {
    try {
        const schoolId = req.user.schoolId;
        const schoolObjectId = new mongoose.Types.ObjectId(schoolId);
        const school = await School.findById(schoolId).select('aiNumber').lean();
        const normalizePhone = (p) => (p || '').replace(/\D/g, '');
        const schoolAiNumber = normalizePhone(school?.aiNumber || '');
        const userToken = req.headers.authorization?.split(' ')[1] || '';
        const backendUrl = process.env.BACKEND_URL || `${req.protocol}://${req.get('host')}`;

        // Get calls from the last 30 days that need action
        const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

        const actionNeededWebhooks = await ElevenLabsWebhook.find({
            type: 'post_call_transcription',
            received_at: { $gte: thirtyDaysAgo },
            tour_booking_detected: { $ne: true },
            actionTaken: { $ne: true },
            $or: [
                { schoolId: schoolObjectId },
                ...(schoolAiNumber ? [{ schoolId: null, 'metadata.phone_call.to_number': { $regex: schoolAiNumber.slice(-10) } }] : []),
            ]
        }).sort({ received_at: -1 }).lean();

        // Extract comprehensive data from transcripts (limit 5, skip if no OpenAI)
        const actionNeeded = await Promise.all(
            actionNeededWebhooks.slice(0, 5).map(async (wh) => {
            const transcriptText = Array.isArray(wh.transcript) 
                ? wh.transcript.map(t => `${t.role}: ${t.message || t.text}`).join('\n')
                : '';

            let comprehensiveData = { tags: [], childName: '', childAge: '', language: '', missingDetails: [] };

            // Use stable cached comprehensive data if available, otherwise extract once and persist.
            if (hasStableTagCache(wh)) {
                comprehensiveData = buildCachedComprehensiveData(wh);
            } else if (transcriptText) {
                // Extract and cache if no cached data exists
                try {
                    comprehensiveData = await extractTourDetails(transcriptText, {
                        childName: wh.tour_booking_extracted?.childName || '',
                        childAge: wh.tour_booking_extracted?.childAge || '',
                        purpose: wh.summary || ''
                    });

                    // Post-processing: Remove "No child info captured" tag if child info is present
                    if (comprehensiveData.childName && comprehensiveData.childAge) {
                        comprehensiveData.tags = comprehensiveData.tags.filter(tag =>
                            !tag.toLowerCase().includes('no child info')
                        );
                    }

                    // Post-processing: Ensure "No child info captured" tag is applied if child info is missing
                    if ((!comprehensiveData.childName || !comprehensiveData.childAge) &&
                        (comprehensiveData.missingDetails &&
                         (comprehensiveData.missingDetails.some(m => m.toLowerCase().includes('child name')) ||
                          comprehensiveData.missingDetails.some(m => m.toLowerCase().includes('child age'))))) {
                        if (!comprehensiveData.tags.some(tag => tag.toLowerCase().includes('no child info'))) {
                            comprehensiveData.tags.push('No child info captured');
                        }
                    }

                    // Post-processing: Ensure "Partial call" tag is applied if missing_details has any field
                    if (comprehensiveData.missingDetails && comprehensiveData.missingDetails.length > 0) {
                        if (!comprehensiveData.tags.some(tag => tag.toLowerCase().includes('partial call'))) {
                            comprehensiveData.tags.push('Partial call');
                        }
                    }

                    // Cache the extracted data to the webhook document
                    await ElevenLabsWebhook.findByIdAndUpdate(wh._id, {
                        ai_processed: true,
                        extractedTags: comprehensiveData.tags,
                        extractedChildName: comprehensiveData.childName,
                        extractedChildAge: comprehensiveData.childAge,
                        extractedLanguage: comprehensiveData.language,
                        extractedMissingDetails: comprehensiveData.missingDetails
                    }).catch(err => console.error('[ACTION-NEEDED] Failed to cache comprehensive data:', err));
                } catch (err) {
                    console.error('[ACTION-NEEDED] Failed to extract comprehensive data:', err);
                }
            }

            return {
                id: wh._id.toString(),
                conversationId: wh.conversation_id,
                callerName: wh.tour_booking_extracted?.name || 'Parent',
                callerPhone: wh.metadata?.phone_call?.from_number || wh.tour_booking_extracted?.phone || 'Unknown',
                summary: wh.summary || '',
                timestamp: wh.metadata?.start_time_unix_secs
                    ? new Date(wh.metadata.start_time_unix_secs * 1000)
                    : wh.received_at,
                recordingUrl: wh.conversation_id
                    ? `${backendUrl}/api/school/calls/${wh.conversation_id}/audio?token=${userToken}`
                    : null,
                duration: getCallDurationSeconds(wh),
                questionsAsked: wh.questions_asked || [],
                actionTakenFeedback: wh.actionTakenFeedback || undefined,
                actionTakenAt: wh.actionTakenAt || undefined,
                feedbackHistory: wh.feedbackHistory || undefined,
                tags: comprehensiveData.tags,
                childName: comprehensiveData.childName,
                childAge: comprehensiveData.childAge,
                language: comprehensiveData.language,
                missingDetails: comprehensiveData.missingDetails
            };
        }));

        res.json({ actionNeeded });
    } catch (err) {
        console.error('Action needed error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// POST /api/school/action-needed/:id/mark-action-taken - Mark an item as action taken
router.post('/action-needed/:id/mark-action-taken', async (req, res) => {
    try {
        const { id } = req.params;
        const { feedback } = req.body; // Optional feedback from the user
        
        const schoolId = req.user.schoolId;
        const schoolObjectId = new mongoose.Types.ObjectId(schoolId);

        // Find and update the webhook entry
        const webhook = await ElevenLabsWebhook.findOneAndUpdate(
            {
                _id: id,
                schoolId: schoolObjectId
            },
            {
                actionTakenFeedback: feedback || '',
                $push: {
                    feedbackHistory: {
                        feedback: feedback || '',
                        timestamp: new Date().toISOString(),
                        userId: req.user.id
                    }
                }
            },
            { new: true }
        );

        if (!webhook) {
            return res.status(404).json({ error: 'Action needed item not found' });
        }

        res.json({ 
            success: true, 
            message: 'Item marked as action taken successfully',
            itemId: id 
        });
    } catch (err) {
        console.error('Mark action taken error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// DELETE /api/school/action-needed/:id - Permanently delete a webhook from the database
router.delete('/action-needed/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const schoolId = req.user.schoolId;
        const schoolObjectId = new mongoose.Types.ObjectId(schoolId);
        const webhookObjectId = new mongoose.Types.ObjectId(id);

        console.log(`[DELETE] Attempting to delete webhook: id=${id}, schoolId=${schoolId}`);
        console.log(`[DELETE] webhookObjectId=${webhookObjectId}, schoolObjectId=${schoolObjectId}`);

        // First, check if the webhook exists
        const existingWebhook = await ElevenLabsWebhook.findOne({
            _id: webhookObjectId,
            schoolId: schoolObjectId
        });

        console.log(`[DELETE] Existing webhook found:`, existingWebhook ? 'YES' : 'NO');

        if (!existingWebhook) {
            // Try to find by string ID as fallback
            const webhookByStringId = await ElevenLabsWebhook.findOne({
                _id: id,
                schoolId: schoolObjectId
            });
            console.log(`[DELETE] Webhook found by string ID:`, webhookByStringId ? 'YES' : 'NO');

            if (webhookByStringId) {
                // Delete using string ID
                await ElevenLabsWebhook.deleteOne({ _id: id, schoolId: schoolObjectId });
                console.log(`[DELETE] Deleted webhook using string ID: ${id}`);
                return res.json({ 
                    success: true, 
                    message: 'Item permanently deleted',
                    itemId: id 
                });
            }

            // Try to find without schoolId constraint
            const webhookWithoutSchool = await ElevenLabsWebhook.findOne({ _id: webhookObjectId });
            console.log(`[DELETE] Webhook found without schoolId:`, webhookWithoutSchool ? 'YES' : 'NO', webhookWithoutSchool ? `schoolId=${webhookWithoutSchool.schoolId}` : '');

            if (webhookWithoutSchool) {
                console.log(`[DELETE] Webhook exists but schoolId mismatch. Requested: ${schoolId}, Actual: ${webhookWithoutSchool.schoolId}`);
            }

            console.log(`[DELETE] Webhook not found for id: ${id}, schoolId: ${schoolId}`);
            return res.status(404).json({ error: 'Webhook not found' });
        }

        // Delete the webhook
        const webhook = await ElevenLabsWebhook.findOneAndDelete({
            _id: webhookObjectId,
            schoolId: schoolObjectId
        });

        console.log(`[DELETE] Permanently deleted webhook ${id} from school ${schoolId}`);
        
        res.json({ 
            success: true, 
            message: 'Item permanently deleted',
            itemId: id 
        });
    } catch (err) {
        console.error('Delete webhook error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// POST /api/school/wordcloud/generate - Manually trigger word cloud generation
router.post('/wordcloud/generate', async (req, res) => {
    try {
        const schoolId = req.user.schoolId;
        const schoolObjectId = new mongoose.Types.ObjectId(schoolId);
        const school = await School.findById(schoolId).select('aiNumber').lean();
        const normalizePhone = (p) => (p || '').replace(/\D/g, '');
        const schoolAiNumber = normalizePhone(school?.aiNumber || '');

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
        
        // Save to school
        await School.findByIdAndUpdate(schoolId, { wordCloud });

        res.json({ wordCloud });
    } catch (err) {
        console.error('Word cloud generation error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// GET /api/school/call-logs - Fetch detailed call logs from voiceAI collection in benny DB
// GET /api/school/call-logs - Fetch detailed call logs from both VoiceAI and ElevenLabs
router.get('/call-logs', async (req, res) => {
    try {
        const schoolId = req.user.schoolId;
        const school = await School.findById(schoolId).select('aiNumber elevenlabsAgentId').lean();

        if (!school) {
            return res.status(404).json({ error: 'School not found' });
        }

        const userToken = req.headers.authorization?.split(' ')[1] || '';
        const backendUrl = process.env.BACKEND_URL || `${req.protocol}://${req.get('host')}`;

        // Helper to normalize phones
        const normalizePhone = (phone) => {
            if (!phone) return '';
            return phone.replace(/\D/g, '');
        };
        const schoolAiNumber = normalizePhone(school.aiNumber || '');

        // ── 1. Fetch SIP Logs (VoiceAI) ──
        let voiceAiSessions = [];
        if (schoolAiNumber) {
            try {
                const digits = schoolAiNumber;
                const normalizedNumber = `+${digits}`;
                const participantId = `sip_${normalizedNumber}`;

                const bennyDb = mongoose.connection.useDb('benny');
                const collection = bennyDb.collection('voiceAI');

                const schoolLogs = await collection.find({ participant_id: participantId }).project({ session_id: 1 }).toArray();
                const sessionIds = [...new Set(schoolLogs.map(l => l.session_id))];

                if (sessionIds.length > 0) {
                    const allLogs = await collection.find({ session_id: { $in: sessionIds } }).sort({ created_at: -1 }).toArray();
                    const sessionsMap = {};
                    allLogs.forEach(log => {
                        const sid = log.session_id;
                        if (!sessionsMap[sid]) {
                            sessionsMap[sid] = {
                                id: log._id.toString(),
                                sessionId: sid,
                                participantId: log.participant_id?.replace('sip_', '') || 'Unknown',
                                transcript: [],
                                summary: log.transcript_summary || '',
                                recordingUrl: log.recording_url,
                                duration: log.duration_seconds || 0,
                                createdAt: log.created_at || log.timestamp
                            };
                        }
                        if (Array.isArray(log.transcript)) {
                            log.transcript.forEach(t => {
                                sessionsMap[sid].transcript.push({
                                    role: t.role || 'unknown',
                                    text: t.content || t.text || t.message || (typeof t === 'string' ? t : ''),
                                    timestamp: t.timestamp || log.created_at
                                });
                            });
                        }
                        if (log.recording_url && !sessionsMap[sid].recordingUrl) sessionsMap[sid].recordingUrl = log.recording_url;
                    });
                    voiceAiSessions = Object.values(sessionsMap);
                }
            } catch (err) {
                console.error('[CallLogs] VoiceAI error:', err);
            }
        }

        const schoolObjectId = new mongoose.Types.ObjectId(schoolId);
        // ── 2. Fetch AI Logs (VAPI Webhooks) ──
        // VAPI webhooks have schoolId=null — match by schoolId OR phone number
        const phoneDigits = schoolAiNumber || '';
        const orConditions = [{ schoolId: schoolObjectId }];
        // Only add phone-based matching if the school has a phone number
        if (phoneDigits) {
            // Match against last 10 digits (VAPI stores as +13363987499, +1 prefix possible)
            const digits10 = phoneDigits.slice(-10);
            orConditions.push({
                schoolId: null,
                'metadata.phone_call.to_number': { $regex: digits10 }
            });
        }
        const webhooks = await ElevenLabsWebhook.find({
            type: 'post_call_transcription',
            $or: orConditions,
        }).sort({ received_at: -1 }).limit(50).lean();

        const webhookSessions = webhooks.map((wh) => {
            const transcript = Array.isArray(wh.transcript) ? wh.transcript.map(t => ({
                role: t.role === 'agent' ? 'Assistant' : 'Parent',
                text: t.message || t.text || '',
                timestamp: t.time_in_call_secs ? new Date(wh.received_at.getTime() + t.time_in_call_secs * 1000) : wh.received_at
            })) : [];

            // Use stored VAPI structured data (no live API enrichment for speed)
            const raw = wh.metadata?.vapi_structured_data || {};
            const cn = raw.child_name;
            const ca = raw.child_age;
            const phoneCall = wh.metadata?.phone_call || {};
            const vapiMeta = wh.metadata?.vapi_metadata || wh.metadata?.vapi || {};

            return {
                id: wh._id.toString(),
                sessionId: wh.conversation_id,
                participantId: wh.metadata?.phone_call?.from_number || wh.tour_booking_extracted?.phone || 'Web Widget',
                transcript,
                summary: wh.summary || '',
                recordingUrl: vapiMeta.recordingUrl
                    || `${backendUrl}/api/school/calls/${wh.conversation_id}/audio?token=${userToken}`,
                duration: getCallDurationSeconds(wh),
                createdAt: wh.received_at,
                // VAPI structured data (normalized)
                call_state: raw.call_state || ({ tour_booked: 'complete', follow_up_needed: 'complete', incomplete: 'partial' })[raw.call_outcome] || (wh.tour_booking_detected ? 'complete' : 'unknown'),
                parent_name: raw.parent_name || null,
                parent_phone: raw.parent_phone || null,
                parent_email: raw.parent_email || null,
                child_name: cn ? (Array.isArray(cn) ? cn : [cn]) : null,
                child_age: ca ? (Array.isArray(ca) ? ca : [ca]) : null,
                tour_booked: !!raw.tour_booked || wh.tour_booking_detected || false,
                tour_date: raw.tour_date || (wh.tour_booking_date ? new Date(wh.tour_booking_date).toISOString().slice(0, 10) : null),
                tour_time: raw.tour_time || null,
                questions_asked: raw.questions_asked || [],
                topics_of_interest: raw.topics_of_interest || [],
                enrollment_urgency: raw.enrollment_urgency || raw.enrollment_timeframe || 'unknown',
                language_spoken: raw.language_spoken || 'English',
                one_pager: raw.one_pager || raw.notes || null,
                email_subject: raw.email?.subject || '',
                email_body: raw.email?.body || '',
                agent_name: wh.agent_name || 'Nora',
                conversation_id: wh.conversation_id,
                received_at: wh.received_at,
                caller_number: phoneCall.from_number || '',
                called_number: phoneCall.to_number || '',
            };
        });

        // ── 3. Merge and Deduplicate ──
        const finalSessionsMap = new Map();
        voiceAiSessions.forEach(s => {
            const key = `${normalizePhone(s.participantId)}_${new Date(s.createdAt).getTime()}`;
            finalSessionsMap.set(key, s);
        });

        webhookSessions.forEach(ws => {
            const key = `${normalizePhone(ws.participantId)}_${new Date(ws.createdAt).getTime()}`;
            if (finalSessionsMap.has(key)) {
                const existing = finalSessionsMap.get(key);
                // Merge transcript and recording if webhook has better data
                finalSessionsMap.set(key, {
                    ...existing,
                    ...ws,
                    transcript: ws.transcript.length > existing.transcript.length ? ws.transcript : existing.transcript,
                    id: existing.id // Keep original ID for stability
                });
            } else {
                finalSessionsMap.set(key, ws);
            }
        });

        const sortedLogs = Array.from(finalSessionsMap.values())
            .map(session => {
                session.transcript.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
                session.transcript = session.transcript.filter(t => t.text);
                return session;
            })
            .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

        res.json(sortedLogs);
    } catch (err) {
        console.error('Call logs error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// GET /api/school/calls/:conversationId/audio - Serve the recorded audio for a conversation
router.get('/calls/:conversationId/audio', async (req, res) => {
    try {
        const { conversationId } = req.params;
        const schoolId = req.user.schoolId;
        const schoolObjectId = new mongoose.Types.ObjectId(schoolId);

        // ── Strategy 1: Check Local Cache (Webhook base64) ────────────────
        const audioWebhook = await ElevenLabsWebhook.findOne({
            conversation_id: conversationId,
            type: 'post_call_audio',
            $or: [{ schoolId: schoolObjectId }, { schoolId: { $exists: false } }, { schoolId: null }]
        }).select('audio_base64 metadata agent_id').lean();

        if (audioWebhook && audioWebhook.audio_base64) {
            const school = await School.findById(schoolId).select('aiNumber elevenlabsAgentId').lean();
            const normalizedSchoolNum = school.aiNumber ? school.aiNumber.replace(/\D/g, '') : '';
            const whToNum = audioWebhook.metadata?.phone_call?.to_number ? audioWebhook.metadata.phone_call.to_number.replace(/\D/g, '') : '';

            if (audioWebhook.schoolId
                || (normalizedSchoolNum && whToNum.includes(normalizedSchoolNum))
                || (school.elevenlabsAgentId && audioWebhook.agent_id === school.elevenlabsAgentId)) {
                console.log(`[Audio] Serving from cache: ${conversationId}`);
                const audioBuffer = Buffer.from(audioWebhook.audio_base64, 'base64');
                res.set('Content-Type', 'audio/mpeg');
                return res.send(audioBuffer);
            }
        }

        // ── Strategy 2: Mock/Test Fallback ────────────────
        if (conversationId.startsWith('test_conv_')) {
            console.log(`[Audio] Serving mock silence for test ID: ${conversationId}`);
            // 1 second of silence (tiny valid MP3)
            const silentMp3 = Buffer.from('SUQzBAAAAAABAFRYWFgAAAASAAADbWFqb3JfYnJhbmQAZGFzaABUWFhYAAAAEQAAAD1taW5vcl92ZXJzaW9uADBUWFhYAAAAHAAAAHByZWRvbWluYW50X2JyYW5kAGlzbzZtcDQxAFRTU0UAAAAPAAADTGF2ZjYwLjMuMTAwAAAAAAAAAAAAAAD/80MUAAAAAAAAAAAAAAAAAAAAAABYaW5nAAAADwAAABIAABm6AAAAAAAAAAAAAAAAAAAAAP/zQxQEAAB8AAAAAA', 'base64');
            res.set('Content-Type', 'audio/mpeg');
            return res.send(silentMp3);
        }

        // ── Strategy 3: Fetch Directly from ElevenLabs API (Proxy) ────────
        const baseUrl = process.env.ELEVENLABS_API_URL;
        if (baseUrl) {
            try {
                console.log(`[Audio Proxy] Requesting: ${conversationId}`);
                const response = await axios.get(`${baseUrl}/api/v1/conversations/${conversationId}/audio`, {
                    responseType: 'arraybuffer',
                    timeout: 10000
                });

                if (response.status === 200) {
                    console.log(`[Audio Proxy] Success for: ${conversationId}`);
                    res.set('Content-Type', 'audio/mpeg');
                    return res.send(response.data);
                }
            } catch (proxyErr) {
                console.warn(`[Audio Proxy] Failed for ${conversationId}: ${proxyErr.response?.status || proxyErr.message}`);
                // If it's 404 and we're in dev/test, we could return silence too, 
                // but let's only do it for test_conv_ prefix for now.
            }
        }

        // ── Strategy 4: VAPI Recording URL (from end-of-call-report) ───────
        const vapiWebhook = await ElevenLabsWebhook.findOne({
            conversation_id: conversationId,
            'metadata.vapi.recordingUrl': { $exists: true, $ne: '' },
            $or: [{ schoolId: schoolObjectId }, { schoolId: { $exists: false } }, { schoolId: null }]
        }).select('metadata.vapi.recordingUrl').lean();

        if (vapiWebhook?.metadata?.vapi?.recordingUrl) {
            const recordingUrl = vapiWebhook.metadata.vapi.recordingUrl;
            console.log(`[Audio VAPI] Redirecting to: ${recordingUrl}`);
            return res.redirect(recordingUrl);
        }

        // ── Strategy 5: Check CallLog recording_url ───────────────────────
        const callLog = await CallLog.findOne({
            schoolId: schoolObjectId,
            $or: [
                { recording_url: { $exists: true, $ne: '' } },
                { recordingUrl: { $exists: true, $ne: '' } }
            ]
        }).sort({ createdAt: -1 }).lean();

        if (callLog?.recordingUrl || callLog?.recording_url) {
            const url = callLog.recordingUrl || callLog.recording_url;
            if (url && url.startsWith('http')) {
                console.log(`[Audio CallLog] Redirecting to: ${url}`);
                return res.redirect(url);
            }
        }

        return res.status(404).json({ error: 'Audio recording not found' });
    } catch (err) {
        console.error('[Audio Error]:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// GET /api/school/integrations - School's integrations
router.get('/integrations', async (req, res) => {
    try {
        const schoolId = req.user.schoolId;
        const integrations = await Integration.find({ schoolId }).lean();

        const types = ['google', 'outlook'];
        const formatted = types.map(type => {
            const existing = integrations.find(i => i.type === type);
            if (existing) {
                return {
                    id: existing._id.toString(),
                    name: existing.name,
                    type: existing.type,
                    connected: existing.connected,
                    connectedAt: existing.connectedAt,
                    email: existing.config?.userEmail || existing.config?.account?.username || null,
                };
            }
            return {
                id: type,
                name: type === 'google' ? 'Google Workspace' : 'Microsoft Outlook',
                type: type,
                connected: false,
                connectedAt: null,
                email: null,
            };
        });

        res.json(formatted);
    } catch (err) {
        console.error('School integrations error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// POST /api/school/integrations/:type/connect
router.post('/integrations/:type/connect', async (req, res) => {
    try {
        const schoolId = req.user.schoolId;
        const { type } = req.params;

        if (!['outlook', 'google'].includes(type)) {
            return res.status(400).json({ error: 'Invalid integration type' });
        }

        let authUrl = null;
        if (type === 'google') {
            authUrl = getGoogleAuthUrl(schoolId);
        } else if (type === 'outlook') {
            authUrl = await getOutlookAuthUrl(schoolId);
        }

        if (!authUrl) {
            return res.status(400).json({
                error: `${type === 'google' ? 'Google' : 'Outlook'} OAuth is not configured. Add the required credentials to the server .env file.`
            });
        }

        res.json({ message: `${type} connection initiated`, authUrl });
    } catch (err) {
        console.error('Connect integration error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// POST /api/school/integrations/:type/disconnect
router.post('/integrations/:type/disconnect', async (req, res) => {
    try {
        const schoolId = req.user.schoolId;
        const { type } = req.params;

        await Integration.deleteMany({ schoolId, type });

        res.json({ message: `${type} disconnected successfully` });
    } catch (err) {
        console.error('Disconnect integration error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// GET /api/school/detect-timezone?address=...
router.get('/detect-timezone', async (req, res) => {
    try {
        const { address } = req.query;
        if (!address || String(address).trim().length < 5) {
            return res.status(400).json({ error: 'Address is too short to detect timezone.' });
        }
        const { getTimezoneFromAddress } = require('../utils/timezone');
        const timezone = await getTimezoneFromAddress(String(address).trim());
        if (!timezone) {
            return res.status(404).json({ error: 'Could not detect timezone for this address. Please select manually.' });
        }
        res.json({ timezone });
    } catch (err) {
        console.error('[detect-timezone] Error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// GET /api/school/settings
router.get('/settings', async (req, res) => {
    try {
        const schoolId = req.user.schoolId;
        console.log('[GET /settings] schoolId:', schoolId);

        if (!schoolId) {
            return res.status(400).json({ error: 'No school associated with this account' });
        }

        const school = await School.findById(schoolId).lean();

        if (!school) {
            return res.status(404).json({ error: 'School not found' });
        }

        const qaPairs = (school.qaPairs || []).map(p => ({
            question: p.question || '',
            answer: p.answer || ''
        }));

        console.log('[GET /settings] qaPairs count:', qaPairs.length);

        const integrations = await require('../models/Integration').find({ schoolId, connected: true }).lean();
        const googleConnected = integrations.some(i => i.type === 'google');
        const outlookConnected = integrations.some(i => i.type === 'outlook');

        res.json({
            id: school._id.toString(),
            name: school.name,
            address: school.address || '',
            timezone: 'America/Chicago', // Forced global CST
            aiNumber: school.aiNumber || '',
            routingNumber: school.routingNumber || '',
            escalationNumber: school.escalationNumber || '',
            language: school.language || 'en',
            script: school.script || '',
            systemPrompt: school.systemPrompt || '',
            businessHoursStart: school.businessHoursStart || '09:00',
            businessHoursEnd: school.businessHoursEnd || '17:00',
            smsAutoFollowup: school.smsAutoFollowup || false,
            emailAutoFollowup: school.emailAutoFollowup || false,
            smsTemplate: school.smsTemplate || 'Thank you for your interest in our school! Please complete our inquiry form here: {form_link}',
            emailTemplate: school.emailTemplate || 'Dear {parent_name},\n\nThank you for contacting us regarding enrollment at {school_name}.\n\nPlease find the inquiry form at: {form_link}\n\nWarm regards,\n{school_name}',
            qaPairs,
            knowledgeBaseDocumentId: school.knowledgeBaseDocumentId || '',
            adminEmail: school.adminEmail || '',
            preferredCalendar: school.preferredCalendar || 'google',
            preferredEmailProvider: school.preferredEmailProvider || 'google',
            elevenlabsAgentId: school.elevenlabsAgentId || '',
            voiceProvider: school.voiceProvider || 'elevenlabs',
            vapiAssistantId: school.vapiAssistantId || '',
            enableHumanTransfer: Boolean(school.enableHumanTransfer),
            humanTransferCondition: school.humanTransferCondition || '',
            humanTransferPhoneNumber: school.humanTransferPhoneNumber || '',
            tourConfirmationEmailTemplate: school.tourConfirmationEmailTemplate || '',
            tourReminderSmsTemplate: school.tourReminderSmsTemplate || '',
            tourBookingLink: school.tourBookingLink || '',
            autoTopUpEnabled: school.autoTopUpEnabled || false,
            autoTopUpThreshold: school.autoTopUpThreshold || 0,
            autoTopUpAmountMinutes: school.autoTopUpAmountMinutes || 50,
            googleConnected,
            outlookConnected,
        });
    } catch (err) {
        console.error('[GET /settings] Error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// PUT /api/school/settings
router.put('/settings', async (req, res) => {
    try {
        const schoolId = req.user.schoolId;
        console.log('[PUT /settings] schoolId:', schoolId);
        console.log('[PUT /settings] body keys:', Object.keys(req.body));
        console.log('[PUT /settings] qaPairs received:', Array.isArray(req.body.qaPairs) ? req.body.qaPairs.length + ' pairs' : 'not an array / missing');

        if (!schoolId) {
            return res.status(400).json({ error: 'No school associated with this account' });
        }

        // Use findById + save() — most reliable for Mongoose subdocument arrays
        const school = await School.findById(schoolId);

        if (!school) {
            return res.status(404).json({ error: 'School not found' });
        }

        const {
            name, address, timezone, aiNumber, routingNumber, escalationNumber, language, script, systemPrompt,
            businessHoursStart, businessHoursEnd,
            smsAutoFollowup, emailAutoFollowup, smsTemplate, emailTemplate,
            qaPairs, preferredCalendar, preferredEmailProvider, adminEmail, elevenlabsAgentId,
            tourConfirmationEmailTemplate, tourReminderSmsTemplate,
            enableHumanTransfer, humanTransferCondition, humanTransferPhoneNumber,
            autoTopUpEnabled, autoTopUpThreshold, autoTopUpAmountMinutes,
            voiceProvider, vapiAssistantId, tourBookingLink
        } = req.body;

        // Capture old values BEFORE overwriting (for change detection)
        const oldAddress = school.address;
        const oldScript = school.script;
        const oldSystemPrompt = school.systemPrompt;
        const oldEnableHumanTransfer = Boolean(school.enableHumanTransfer);
        const oldHumanTransferCondition = school.humanTransferCondition || '';
        const oldHumanTransferPhoneNumber = school.humanTransferPhoneNumber || '';

        if (name !== undefined) school.name = name;
        if (address !== undefined) school.address = address;

        // Auto-detect timezone from address when address changes AND timezone not manually set
        if (address !== undefined && address.trim() && address !== oldAddress && timezone === undefined) {
            const { getTimezoneFromAddress } = require('../utils/timezone');
            const detectedTz = await getTimezoneFromAddress(address);
            if (detectedTz) {
                school.timezone = detectedTz;
                console.log(`[Settings] Auto-updated timezone for ${school.name} to ${detectedTz}`);
            }
        }

        // Apply manually supplied timezone (overrides auto-detected)
        if (timezone !== undefined) school.timezone = timezone;
        if (routingNumber !== undefined) school.routingNumber = routingNumber;
        if (escalationNumber !== undefined) school.escalationNumber = escalationNumber;
        if (language !== undefined) school.language = language;
        if (script !== undefined) school.script = script;
        if (systemPrompt !== undefined) school.systemPrompt = systemPrompt;

        const scriptChanged = script !== undefined && script !== oldScript;
        const systemPromptChanged = systemPrompt !== undefined && systemPrompt !== oldSystemPrompt;

        if (businessHoursStart !== undefined) school.businessHoursStart = businessHoursStart;
        if (businessHoursEnd !== undefined) school.businessHoursEnd = businessHoursEnd;
        if (smsAutoFollowup !== undefined) school.smsAutoFollowup = smsAutoFollowup;
        if (emailAutoFollowup !== undefined) school.emailAutoFollowup = emailAutoFollowup;
        if (smsTemplate !== undefined) school.smsTemplate = smsTemplate;
        if (emailTemplate !== undefined) school.emailTemplate = emailTemplate;
        if (preferredCalendar !== undefined) school.preferredCalendar = preferredCalendar;
        if (preferredEmailProvider !== undefined) school.preferredEmailProvider = preferredEmailProvider;
        if (adminEmail !== undefined) school.adminEmail = adminEmail;
        if (elevenlabsAgentId !== undefined) school.elevenlabsAgentId = elevenlabsAgentId;
        if (voiceProvider !== undefined && ['elevenlabs', 'vapi'].includes(voiceProvider)) {
            school.voiceProvider = voiceProvider;
        }
        if (vapiAssistantId !== undefined) school.vapiAssistantId = vapiAssistantId;
        if (autoTopUpEnabled !== undefined) school.autoTopUpEnabled = Boolean(autoTopUpEnabled);
        if (autoTopUpThreshold !== undefined) school.autoTopUpThreshold = parseInt(autoTopUpThreshold, 10) || 0;
        if (autoTopUpAmountMinutes !== undefined) {
            const amount = parseInt(autoTopUpAmountMinutes, 10);
            if (amount >= 25 && amount <= 2000) school.autoTopUpAmountMinutes = amount;
        }
        if (enableHumanTransfer !== undefined) school.enableHumanTransfer = Boolean(enableHumanTransfer);
        if (humanTransferCondition !== undefined) school.humanTransferCondition = String(humanTransferCondition || '').trim();
        if (humanTransferPhoneNumber !== undefined) {
            const normalizedTransferPhone = normalizePhone(String(humanTransferPhoneNumber || ''));
            school.humanTransferPhoneNumber = normalizedTransferPhone || '';
        }
        if (tourConfirmationEmailTemplate !== undefined) school.tourConfirmationEmailTemplate = tourConfirmationEmailTemplate;
        if (tourReminderSmsTemplate !== undefined) school.tourReminderSmsTemplate = tourReminderSmsTemplate;
        if (tourBookingLink !== undefined) school.tourBookingLink = tourBookingLink;

        // Validate using the latest values (after applying request body fields).
        if (school.enableHumanTransfer && (!school.humanTransferCondition || !school.humanTransferPhoneNumber)) {
            return res.status(400).json({ error: 'Condition and phone number are required when Human Transfer is enabled.' });
        }

        // If human transfer fields are present in payload, always sync to ElevenLabs to avoid UI/API drift.
        const humanTransferChanged =
            enableHumanTransfer !== undefined
            || humanTransferCondition !== undefined
            || humanTransferPhoneNumber !== undefined
            || school.enableHumanTransfer !== oldEnableHumanTransfer
            || (school.humanTransferCondition || '') !== oldHumanTransferCondition
            || (school.humanTransferPhoneNumber || '') !== oldHumanTransferPhoneNumber;

        // Check if qaPairs changed
        let qaPairsChanged = false;
        if (Array.isArray(qaPairs)) {
            const newQAPairs = qaPairs.map(p => ({
                question: p.question || '',
                answer: p.answer || ''
            }));

            // Compare old and new qaPairs to detect changes
            const oldQAPairs = school.qaPairs || [];
            if (oldQAPairs.length !== newQAPairs.length) {
                qaPairsChanged = true;
            } else {
                // Deep compare each pair
                for (let i = 0; i < newQAPairs.length; i++) {
                    if (oldQAPairs[i]?.question !== newQAPairs[i].question ||
                        oldQAPairs[i]?.answer !== newQAPairs[i].answer) {
                        qaPairsChanged = true;
                        break;
                    }
                }
            }

            // Update qaPairs
            school.qaPairs.splice(0, school.qaPairs.length, ...newQAPairs);
            console.log('[PUT /settings] qaPairs set on document:', school.qaPairs.length);
        }

        // Sync with ElevenLabs Knowledge Base if qaPairs changed (DELETE old KB, POST new KB)
        if (qaPairsChanged && Array.isArray(qaPairs)) {
            try {
                // Step 1: Delete old KB document only if document_id exists and is not empty
                if (school.knowledgeBaseDocumentId && school.knowledgeBaseDocumentId.trim() !== '') {
                    await deleteKnowledgeBaseDocument(school.knowledgeBaseDocumentId);
                    school.knowledgeBaseDocumentId = ''; // Clear the document_id
                }

                // Step 2: Create new KB document only if there are Q&A pairs
                if (qaPairs.length > 0) {
                    const kbText = formatQAPairsForKB(school.qaPairs);
                    if (kbText) { // Only create if we have valid text
                        // Pass school name to generate document name on backend
                        const newDocumentId = await ingestKnowledgeBaseDocument(kbText, school.name);

                        // Step 3: Store the new document_id
                        if (newDocumentId) {
                            school.knowledgeBaseDocumentId = newDocumentId;
                            console.log('[PUT /settings] KB document synced, new document_id:', newDocumentId);
                        }
                    }
                }
            } catch (err) {
                console.error('[PUT /settings] KB sync failed:', err);
                // Continue saving settings even if KB sync fails
            }
        }

        // Consolidated Agent Update: If Q&A, first message, or system prompt changed, push FULL payload
        if (qaPairsChanged || scriptChanged || systemPromptChanged || humanTransferChanged) {
            // Prefer school-specific agent ID when set; fall back to global AGENT_ID
            const agentId = (school.elevenlabsAgentId && school.elevenlabsAgentId.trim()) || process.env.AGENT_ID || null;
            console.log('[PUT /settings] Agent sync inputs:', {
                schoolId: String(school._id),
                agentId: agentId || null,
                humanTransferEnabled: Boolean(school.enableHumanTransfer),
                humanTransferCondition: school.humanTransferCondition || '',
                humanTransferPhoneNumber: school.humanTransferPhoneNumber || ''
            });
            if (agentId) {
                if (!process.env.ELEVENLABS_API_URL) {
                    console.warn('[PUT /settings] ELEVENLABS_API_URL not set — skipping agent PATCH');
                } else {
                    try {
                        await updateAgentWithKnowledgeBase(
                            agentId,
                            school.script || '',
                            school.systemPrompt || '',
                            school.knowledgeBaseDocumentId || '',
                            school.toolIds || [],
                            {
                                enabled: Boolean(school.enableHumanTransfer),
                                condition: school.humanTransferCondition || '',
                                phoneNumber: school.humanTransferPhoneNumber || ''
                            }
                        );
                        console.log('[PUT /settings] Agent updated with full payload (KB and/or Persona changes)');
                    } catch (err) {
                        const status = err?.response?.status;
                        const detail = err?.response?.data?.detail || err?.message || 'Unknown error';
                        if (status === 404) {
                            // Agent no longer exists — clear the stored ID so we don't keep retrying
                            school.elevenlabsAgentId = '';
                            console.warn(`[PUT /settings] ElevenLabs agent (${agentId}) not found — clearing stored Agent ID. Please set a valid Agent ID in Settings.`);
                        } else {
                            console.error(`[PUT /settings] Failed to update agent: [${status}] ${detail}`);
                        }
                    }
                }
            } else {
                console.warn('[PUT /settings] No agent ID — skipping agent PATCH');
            }
        }

        await school.save();
        console.log('[PUT /settings] Saved successfully. qaPairs in DB:', school.qaPairs.length);

        res.json({
            message: 'Settings updated successfully',
            qaPairsCount: school.qaPairs.length
        });
    } catch (err) {
        console.error('[PUT /settings] Error:', err);
        res.status(500).json({ error: err.message || 'Internal server error' });
    }
});

// POST /api/school/vapi/create-assistant — Create a VAPI assistant for the school
router.post('/vapi/create-assistant', async (req, res) => {
    try {
        const schoolId = req.user.schoolId;
        const school = await School.findById(schoolId);
        if (!school) return res.status(404).json({ error: 'School not found' });

        const backendUrl = process.env.BACKEND_URL ||
            `${req.protocol}://${req.get('host')}`;

        const { createAssistant } = require('../services/vapiService');
        const result = await createAssistant({
            schoolName: school.name,
            schoolId: school._id.toString(),
            firstMessage: school.script || undefined,
            systemPrompt: school.systemPrompt || undefined,
            backendUrl,
        });

        if (result.assistantId) {
            school.vapiAssistantId = result.assistantId;
            school.voiceProvider = 'vapi';
            await school.save();
            res.json({ success: true, assistantId: result.assistantId, message: 'VAPI assistant created' });
        } else {
            res.status(500).json({ error: result.error || 'Failed to create VAPI assistant' });
        }
    } catch (err) {
        console.error('[VAPI Create] Error:', err);
        res.status(500).json({ error: err.message });
    }
});

// POST /api/school/vapi/sync-assistant — Sync assistant config
router.post('/vapi/sync-assistant', async (req, res) => {
    try {
        const schoolId = req.user.schoolId;
        const school = await School.findById(schoolId);
        if (!school) return res.status(404).json({ error: 'School not found' });
        if (!school.vapiAssistantId) return res.status(400).json({ error: 'No VAPI assistant configured' });

        const backendUrl = process.env.BACKEND_URL ||
            `${req.protocol}://${req.get('host')}`;

        const { updateAssistant, buildVapiTools, NORA_SYSTEM_PROMPT_VAPI, DEFAULT_FIRST_MESSAGE } = require('../services/vapiService');

        const prompt = (school.systemPrompt || NORA_SYSTEM_PROMPT_VAPI)
            .replace(/{{SCHOOL_NAME}}/g, school.name);

        const updates = {
            name: `${school.name} - Nora`,
            model: {
                provider: 'openai',
                model: 'gpt-4o',
                systemPrompt: prompt,
                temperature: 0.7,
            },
            firstMessage: (school.script || DEFAULT_FIRST_MESSAGE)
                .replace(/{{SCHOOL_NAME}}/g, school.name),
            tools: buildVapiTools(backendUrl, schoolId),
            serverUrl: `${backendUrl}/api/v1/webhook/vapi`,
        };

        const result = await updateAssistant(school.vapiAssistantId, updates);
        if (result) {
            res.json({ success: true, message: 'VAPI assistant synced' });
        } else {
            res.status(500).json({ error: 'Failed to sync VAPI assistant' });
        }
    } catch (err) {
        console.error('[VAPI Sync] Error:', err);
        res.status(500).json({ error: err.message });
    }
});

// POST /api/school/purchase-phone
// Purchases a Twilio number, imports into VAPI/ElevenLabs, and assigns to the school.
// Called by the school user clicking "Purchase Phone Number" in Settings.
router.post('/purchase-phone', async (req, res) => {
    try {
        const schoolId = req.user.schoolId;
        const school = await School.findById(schoolId);
        if (!school) return res.status(404).json({ error: 'School not found' });

        // Already has a number?
        if (school.aiNumber) {
            return res.status(400).json({
                error: `This school already has a phone number: ${school.aiNumber}. `
                    + 'Contact support to change it.'
            });
        }

        console.log(`[Purchase Phone] Starting for school "${school.name}" (${schoolId})`);
        console.log(`[Purchase Phone] Voice provider: ${school.voiceProvider || 'elevenlabs'}`);

        const baseDomain = process.env.BACKEND_URL ||
            `${req.protocol}://${req.get('host')}`;

        // ── Step 1: Purchase from Twilio ──────────────────────────
        const { purchasePhoneNumber } = require('../services/twilioService');
        const twilioResult = await purchasePhoneNumber({
            areaCode: process.env.TWILIO_DEFAULT_AREA_CODE || undefined,
        });

        if (twilioResult.error) {
            return res.status(500).json({
                error: `Failed to purchase phone number: ${twilioResult.error}`
            });
        }

        console.log(`[Purchase Phone] Twilio: ${twilioResult.phoneNumber}`);

        // ── Step 2: Import into voice provider ────────────────────
        const provider = school.voiceProvider || 'elevenlabs';
        let vapiPhoneId = '';
        let sipPhoneId = '';

        if (provider === 'vapi') {
            // Create VAPI assistant if needed
            let vapiAssistantId = school.vapiAssistantId;
            if (!vapiAssistantId) {
                const { createAssistant } = require('../services/vapiService');
                const asstResult = await createAssistant({
                    schoolName: school.name,
                    schoolId: schoolId.toString(),
                    firstMessage: school.script || undefined,
                    systemPrompt: school.systemPrompt || undefined,
                    backendUrl: baseDomain,
                });
                if (asstResult.assistantId) {
                    vapiAssistantId = asstResult.assistantId;
                    school.vapiAssistantId = vapiAssistantId;
                    school.voiceProvider = 'vapi';
                }
            }

            // Import into VAPI
            const { importPhoneNumber: importVapi } = require('../services/vapiService');
            const vapiPhone = await importVapi({
                number: twilioResult.phoneNumber,
                name: `${school.name} Main`,
                assistantId: vapiAssistantId || undefined,
                serverUrl: `${baseDomain}/vapi/assistant-request`,
            });

            if (vapiPhone && vapiPhone.id) {
                vapiPhoneId = vapiPhone.id;
                school.vapiPhoneNumberId = vapiPhoneId;
                console.log(`[Purchase Phone] VAPI phone ID: ${vapiPhoneId}`);
            }
        } else {
            // ElevenLabs SIP import
            const { importSipTrunk } = require('../utils/elevenlabs');
            const sipResult = await importSipTrunk({
                phone_number: twilioResult.phoneNumber,
                label: `${school.name} Main`,
            });
            if (sipResult && sipResult.phone_number_id) {
                sipPhoneId = sipResult.phone_number_id;
                school.agentPhoneNumberId = sipPhoneId;
            }
        }

        // ── Step 3: Save to School ──────────────────────────────
        school.aiNumber = twilioResult.phoneNumber;
        await school.save();

        // ── Step 4: Store in PhoneNumber pool ────────────────────
        const PhoneNumber = require('../models/PhoneNumber');
        await PhoneNumber.create({
            phone_number_id: vapiPhoneId || sipPhoneId || twilioResult.sid,
            phone_number: twilioResult.phoneNumber,
            provider: provider === 'vapi' ? 'vapi' : 'sip_trunk',
            label: `${school.name} Main`,
            schoolId: school._id,
            twilioSid: twilioResult.sid,
            vapiPhoneId: vapiPhoneId || '',
            metadata: { purchasedBy: req.user.email, baseDomain },
        });

        console.log(`[Purchase Phone] ✅ Complete: ${school.name} → ${twilioResult.phoneNumber}`);

        res.json({
            success: true,
            phoneNumber: twilioResult.phoneNumber,
            provider: provider,
            vapiAssistantId: school.vapiAssistantId || null,
            message: `Phone number ${twilioResult.phoneNumber} purchased and assigned to ${school.name}.`
        });

    } catch (err) {
        console.error('[Purchase Phone] Error:', err);
        res.status(500).json({ error: err.message || 'Failed to purchase phone number.' });
    }
});

// POST /api/school/request-ai-number
router.post('/request-ai-number', async (req, res) => {
    try {
        const schoolId = req.user.schoolId;
        const { schoolName } = req.body;

        if (!schoolId) {
            return res.status(400).json({ error: 'No school associated with this account' });
        }

        // Check if there's already a pending request for this school
        const existingRequest = await AiNumberRequest.findOne({ 
            schoolId, 
            status: 'pending' 
        });
        
        if (existingRequest) {
            return res.status(400).json({ 
                error: 'You already have a pending AI number request. Please wait for admin approval.' 
            });
        }

        // Get school details
        const school = await School.findById(schoolId);
        if (!school) {
            return res.status(404).json({ error: 'School not found' });
        }

        // Create the AI number request
        const request = await AiNumberRequest.create({
            schoolId: school._id,
            schoolName: school.name || schoolName,
            requestedBy: req.user.id,
            status: 'pending'
        });

        console.log(`[AI Number Request] Created request ${request._id} for school: ${school.name} (${school._id})`);
        
        res.json({ 
            message: 'AI number request submitted successfully. An admin will review your request shortly.',
            requestId: request._id.toString()
        });
    } catch (err) {
        console.error('[AI Number Request] Error:', err);
        res.status(500).json({ error: 'Failed to submit AI number request' });
    }
});

// GET /api/school/inquiry-submissions - Form submissions from public inquiry form
router.get('/inquiry-submissions', async (req, res) => {
    try {
        const schoolId = req.user.schoolId;
        if (!schoolId) {
            return res.status(400).json({ error: 'No school associated with this user' });
        }

        const submissions = await InquirySubmission.find({ schoolId })
            .sort({ submittedAt: -1 })
            .limit(50)
            .lean();

        res.json(submissions.map(s => ({
            id: s._id.toString(),
            parentName: s.parentName,
            email: s.email,
            phone: s.phone,
            answers: s.answers || [],
            submittedAt: s.submittedAt,
        })));
    } catch (err) {
        console.error('Inquiry submissions error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// GET /api/school/tour-bookings
router.get('/tour-bookings', async (req, res) => {
    try {
        const schoolId = req.user.schoolId;
        const bookings = await TourBooking.find({ schoolId })
            .sort({ scheduledAt: -1 })
            .limit(50)
            .lean();

        res.json(bookings.map(b => ({
            id: b._id.toString(),
            parentName: b.parentName,
            phone: b.phone,
            email: b.email,
            childAge: b.childAge,
            reason: b.reason,
            scheduledAt: b.scheduledAt,
            calendarProvider: b.calendarProvider || null,
        })));
    } catch (err) {
        console.error('Tour bookings error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// GET /api/school/followups
router.get('/followups', async (req, res) => {
    try {
        const schoolId = req.user.schoolId;
        const followups = await Followup.find({ schoolId })
            .sort({ createdAt: -1 })
            .lean();

        const formatted = followups.map(f => ({
            id: f._id.toString(),
            leadName: f.leadName,
            type: f.type,
            status: f.status,
            message: f.message,
            recipient: f.recipient,
            addressed: !!f.addressed,
            addressedNote: f.addressedNote || '',
            addressedAt: f.addressedAt || null,
            timestamp: f.createdAt,
        }));

        res.json(formatted);
    } catch (err) {
        console.error('School followups error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// POST /api/school/followups/:id/addressed - mark a follow-up as addressed with a note
router.post('/followups/:id/addressed', async (req, res) => {
    try {
        const schoolId = req.user.schoolId;
        const { id } = req.params;
        const { note } = req.body || {};

        if (!id) return res.status(400).json({ error: 'Missing follow-up id' });

        const addressedNote = typeof note === 'string' ? note.trim() : '';

        const updated = await Followup.findOneAndUpdate(
            { _id: id, schoolId },
            {
                $set: {
                    addressed: true,
                    addressedNote,
                    addressedAt: new Date(),
                    addressedBy: req.user?.email ? String(req.user.email) : '',
                }
            },
            { new: true }
        ).lean();

        if (!updated) {
            return res.status(404).json({ error: 'Follow-up not found' });
        }

        res.json({
            success: true,
            followup: {
                id: updated._id.toString(),
                addressed: !!updated.addressed,
                addressedNote: updated.addressedNote || '',
                addressedAt: updated.addressedAt || null,
            }
        });
    } catch (err) {
        console.error('Mark follow-up addressed error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// GET /api/school/forms
router.get('/forms', async (req, res) => {
    try {
        const schoolId = req.user.schoolId;
        const questions = await FormQuestion.find({ schoolId })
            .sort({ position: 1 })
            .lean();

        const formatted = questions.map(q => ({
            id: q._id.toString(),
            question: q.question,
            required: q.required,
        }));

        res.json(formatted);
    } catch (err) {
        console.error('School forms error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// POST /api/school/forms - Save form questions (bulk replace)
router.post('/forms', async (req, res) => {
    try {
        const schoolId = req.user.schoolId;
        const { questions } = req.body;

        if (!Array.isArray(questions)) {
            return res.status(400).json({ error: 'Questions must be an array' });
        }

        // Delete old questions
        await FormQuestion.deleteMany({ schoolId });

        // Insert new ones
        if (questions.length > 0) {
            await FormQuestion.insertMany(
                questions.map((q, index) => ({
                    schoolId,
                    question: q.question,
                    required: q.required || false,
                    position: index,
                }))
            );
        }

        res.json({ message: 'Form questions saved successfully' });
    } catch (err) {
        console.error('Save forms error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// GET /api/school/referrals
router.get('/referrals', async (req, res) => {
    try {
        const schoolId = req.user.schoolId;

        const referralLink = await ReferralLink.findOne({ schoolId }).lean();

        const referrals = await Referral.find({ referrerSchoolId: schoolId })
            .sort({ date: -1 })
            .lean();

        const formatted = referrals.map(r => ({
            id: r._id.toString(),
            referrerSchool: r.referrerSchoolName,
            newSchool: r.newSchoolName,
            date: r.date,
            status: r.status,
        }));

        res.json({
            referralCode: referralLink ? referralLink.code : null,
            referralLink: referralLink ? `${process.env.FRONTEND_URL || process.env.FORM_BASE_URL || 'http://localhost:5173'}/refer/${referralLink.code}` : null,
            referrals: formatted,
        });
    } catch (err) {
        console.error('School referrals error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// POST /api/school/referrals/generate
router.post('/referrals/generate', async (req, res) => {
    try {
        const schoolId = req.user.schoolId;
        const school = await School.findById(schoolId);

        if (!school) {
            return res.status(404).json({ error: 'School not found' });
        }

        const code = `ref-${school.name.toLowerCase().replace(/\s+/g, '-')}-${Date.now().toString(36)}`;

        await ReferralLink.findOneAndUpdate(
            { schoolId },
            { code },
            { upsert: true, new: true }
        );

        res.json({
            referralCode: code,
            referralLink: `${process.env.FRONTEND_URL || process.env.FORM_BASE_URL || 'http://localhost:5173'}/refer/${code}`,
        });
    } catch (err) {
        console.error('Generate referral error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// POST /api/school/test-call - Simulate an incoming inquiry call for testing
router.post('/test-call', async (req, res) => {
    try {
        const schoolId = req.user.schoolId;
        const testLead = {
            parentName: 'Test Parent',
            phone: '+1 (555) 000-0000',
            email: 'test@example.com',
            childAge: '3 years',
            reason: 'Enrollment inquiry for next fall',
        };

        // 1. Create call log
        const callLog = await CallLog.create({
            schoolId,
            callerName: testLead.parentName,
            callerPhone: testLead.phone,
            callType: 'inquiry',
            duration: 125,
            recordingUrl: 'https://example.com/recording.mp3',
        });

        // 2. Trigger automation
        const { triggerAutomation } = require('../services/automation');
        await triggerAutomation(schoolId, testLead);

        res.json({ message: 'Test call simulated successfully', callLogId: callLog._id });
    } catch (err) {
        console.error('Test call error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Normalize phone to E.164 (strip spaces/dashes, ensure + prefix)
function normalizePhone(value) {
    if (!value || typeof value !== 'string') return null;
    const trimmed = value.trim().replace(/[\s\-\(\)]/g, '');
    if (!trimmed) return null;
    return trimmed.startsWith('+') ? trimmed : `+${trimmed}`;
}

// POST /api/school/test-followup - Send test SMS and/or email to YOUR number/email (no call)
// Body: { phone?: string, email?: string } - at least one required. Uses your templates + form link.
router.post('/test-followup', async (req, res) => {
    try {
        const schoolId = req.user.schoolId;
        let { phone, email } = req.body || {};

        if (!phone && !email) {
            return res.status(400).json({
                error: 'Provide at least one of phone or email to receive the test follow-up.',
            });
        }

        phone = phone ? normalizePhone(phone) : undefined;
        email = email ? String(email).trim() || undefined : undefined;

        const testLead = {
            parentName: 'Test Parent',
            phone,
            email,
            childAge: '3 years',
            reason: 'Test follow-up',
        };

        const { triggerAutomation } = require('../services/automation');
        const result = await triggerAutomation(schoolId, testLead);

        const sent = [];
        if (result.smsSent) sent.push('SMS');
        if (result.emailSent) sent.push('Email');

        const errors = [];
        if (phone && !result.smsSent && result.smsError) errors.push(`SMS: ${result.smsError}`);
        if (email && !result.emailSent && result.emailError) errors.push(`Email: ${result.emailError}`);

        if (sent.length > 0) {
            return res.json({
                message: `Test sent (${sent.join(' + ')}). Check your ${sent.includes('SMS') ? 'phone' : ''}${sent.length === 2 ? ' and ' : ''}${sent.includes('Email') ? 'inbox' : ''}.`,
                sent,
                ...(errors.length > 0 && { partialErrors: errors }),
            });
        }

        const errorMessage = errors.length > 0 ? errors.join(' ') : 'Send failed. Enable follow-ups in Settings and save SMTP settings.';
        return res.status(400).json({ error: errorMessage });
    } catch (err) {
        console.error('Test followup error:', err);
        res.status(500).json({ error: err.message || 'Internal server error' });
    }
});

// GET /api/school/recent-calls — Returns latest webhooks with VAPI structured data
router.get('/recent-calls', async (req, res) => {
    try {
        const schoolId = req.user.schoolId;
        if (!schoolId) return res.status(400).json({ error: 'No school associated' });

        const schoolObjectId = new mongoose.Types.ObjectId(schoolId);

        const school = await School.findById(schoolId).select('aiNumber').lean();
        const schoolPhoneDigits = (school?.aiNumber || '').replace(/\D/g, '').slice(-10);

        const recentCalls = await ElevenLabsWebhook.find({
            type: 'post_call_transcription',
            $or: [
                { schoolId: schoolObjectId },
                ...(schoolPhoneDigits ? [{ schoolId: null, 'metadata.phone_call.to_number': { $regex: schoolPhoneDigits } }] : []),
            ]
        })
            .select('conversation_id agent_name summary received_at metadata transcript')
            .sort({ received_at: -1 })
            .limit(20)
            .lean();

        // Normalize VAPI structured data (VAPI field names → frontend field names)
        const normalizeStructured = (s) => {
            if (!s || typeof s !== 'object') return {};
            const cn = s.child_name;
            const ca = s.child_age;
            const outcomeToState = {
                tour_booked: 'complete',
                follow_up_needed: 'complete',
                incomplete: 'partial',
            };
            return {
                parent_name: s.parent_name || null,
                parent_phone: s.parent_phone || null,
                parent_email: s.parent_email || null,
                child_name: cn ? (Array.isArray(cn) ? cn : [cn]) : null,
                child_age: ca ? (Array.isArray(ca) ? ca : [ca]) : null,
                tour_booked: !!s.tour_booked,
                tour_date: s.tour_date || null,
                tour_time: s.tour_time || null,
                call_state: s.call_state || outcomeToState[s.call_outcome] || 'unknown',
                questions_asked: s.questions_asked || [],
                topics_of_interest: s.topics_of_interest || [],
                enrollment_urgency: s.enrollment_urgency || s.enrollment_timeframe || 'unknown',
                language_spoken: s.language_spoken || 'English',
                one_pager: s.one_pager || s.notes || null,
                email_subject: s.email?.subject || '',
                email_body: s.email?.body || '',
            };
        };

        const formatted = recentCalls.map(call => {
            const structured = normalizeStructured(call.metadata?.vapi_structured_data);
            const phoneCall = call.metadata?.phone_call || {};

            return {
                id: call._id.toString(),
                conversation_id: call.conversation_id,
                agent_name: call.agent_name || 'Nora',
                received_at: call.received_at,
                duration_seconds: phoneCall.call_duration_secs || 0,
                caller_number: phoneCall.from_number || '',
                called_number: phoneCall.to_number || '',
                summary: call.summary || '',
                ...structured,
            };
        });

        // Stats
        const totalCalls = await ElevenLabsWebhook.countDocuments({
            schoolId: schoolObjectId,
            type: 'post_call_transcription',
        });
        const toursBooked = await TourBooking.countDocuments({ schoolId: schoolObjectId });
        const recentTours = await TourBooking.find({ schoolId: schoolObjectId })
            .sort({ scheduledAt: -1 })
            .limit(5)
            .lean();

        res.json({
            calls: formatted,
            stats: {
                total_calls: totalCalls,
                tours_booked: toursBooked,
                recent_tours: recentTours.map(t => ({
                    id: t._id.toString(),
                    parent_name: t.parentName,
                    phone: t.phone,
                    email: t.email,
                    child_name: t.childName,
                    child_age: t.childAge,
                    scheduled_at: t.scheduledAt,
                    calendar_provider: t.calendarProvider,
                })),
            }
        });
    } catch (err) {
        console.error('[Recent Calls] Error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

module.exports = router;

