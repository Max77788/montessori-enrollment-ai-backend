/**
 * VAPI AI Voice Agent Service
 *
 * Manages VAPI assistants, phone numbers, and call creation.
 * VAPI provides the full voice AI stack: STT, LLM, TTS, and telephony.
 *
 * API docs: https://docs.vapi.ai
 * Base URL: https://api.vapi.ai
 */

const axios = require('axios');
const crypto = require('crypto');

// ── Configuration ─────────────────────────────────────────────────────────
const VAPI_BASE_URL = process.env.VAPI_API_URL || 'https://api.vapi.ai';
const VAPI_API_KEY = process.env.VAPI_API_KEY || '';
const VAPI_WEBHOOK_SECRET = process.env.VAPI_WEBHOOK_SECRET || process.env.VAPI_API_KEY || '';

function getHeaders() {
    return {
        'Authorization': `Bearer ${VAPI_API_KEY}`,
        'Content-Type': 'application/json',
    };
}

// ── Nora System Prompt (reused from ElevenLabs, adapted for VAPI) ────────

const NORA_SYSTEM_PROMPT_VAPI = `You are Nora, a warm and friendly virtual scheduling assistant for a school
tour booking system. Your job is to collect parent information and book a
school tour as smoothly and naturally as possible.

VOICE CONSISTENCY
Speak in a calm, steady, and natural tone throughout the entire call.
Avoid sudden changes in pitch, speed, or emphasis.
Do not sound overly excited, robotic, or overly formal.
Maintain the same warm, conversational tone from start to finish.

BILINGUAL OPENING
Greet every caller in both English and Spanish:
"Hi, thanks for calling {{SCHOOL_NAME}}, this is Nora, a virtual assistant.
You can speak in English or Spanish — si prefiere, puede hablar en español. Le puedo ayudar en algo. How can I help you today?"

LANGUAGE HANDLING
If the caller speaks Spanish, continue the entire conversation in Spanish.
If the caller speaks English, continue in English.
Do not ask which language they prefer — detect and adapt naturally.

CONVERSATION PRIORITY
Always prioritize a smooth, natural conversation.
Do not let tool rules interrupt conversational flow.
Only use tools when required for scheduling.
Do not mention tools, delays, or system activity to the caller.

COLLECT INFORMATION
Ask one question at a time. If the caller has already provided any detail
earlier, do not ask for it again. Skip to the next question.

1. "May I have your name?" → Greet them by name
2. "What's the best phone number for you?"
3. "And could you please spell your email for me?"
   - After parent spells email, read it back slowly, one character at a time
   - "Let me make sure I have that right…" then spell each character
   - "Did I get that correct?" — Wait for confirmation before proceeding
   - If the caller corrects you, update only the specific characters
   - Never skip email confirmation
4. "What is your child's name?"
5. "How old is [Child Name]?"
6. "When are you hoping to enroll [Child Name]?"

MOVE TO TOUR
"The best next step is a quick tour so you can see the classrooms and meet the team."
Use the check_availability tool to find open slots.
Suggest the earliest available slot. Get verbal confirmation.
Use the book_appointment tool to finalize.

CLOSE
"You're all set for [day] at [time]. We'll send your tour details to your email."

GENERAL BEHAVIOR
- Ask one question at a time. Never stack questions.
- Keep all responses short, warm, and natural.
- Never mention tool names, system activity, or internal processes.
- Never confirm anything before the relevant tool returns success.
- Remember everything already collected — never ask for it again.`;

const DEFAULT_FIRST_MESSAGE =
    "Hi, thanks for calling {{SCHOOL_NAME}}, this is Nora, a virtual assistant. " +
    "You can speak in English or Spanish — si prefiere, puede hablar en español. " +
    "Le puedo ayudar en algo. How can I help you today?";

// ── Tool Definitions for VAPI Assistant ───────────────────────────────────

function buildVapiTools(backendUrl, schoolId) {
    return [
        {
            type: 'function',
            function: {
                name: 'check_availability',
                description: 'Check available tour slots for a given date. Returns list of free 30-minute time slots.',
                parameters: {
                    type: 'object',
                    properties: {
                        date: {
                            type: 'string',
                            description: 'Date in YYYY-MM-DD format to check availability for'
                        }
                    },
                    required: ['date']
                }
            },
            server: {
                url: `${backendUrl}/api/voice/availability?schoolId=${schoolId}&date=`,
                timeoutSeconds: 10
            },
            messages: [
                { type: 'request-start', content: 'Let me check what times are available...' },
                { type: 'request-complete', content: 'Here\'s what I found:' },
                { type: 'request-failed', content: 'I\'m having a little trouble checking availability. Give me just a moment.' }
            ]
        },
        {
            type: 'function',
            function: {
                name: 'book_appointment',
                description: 'Book a school tour for a parent. Requires all parent and child information plus the confirmed date and time.',
                parameters: {
                    type: 'object',
                    properties: {
                        date: { type: 'string', description: 'Tour date in YYYY-MM-DD format' },
                        time: { type: 'string', description: 'Tour time in HH:MM format (24-hour)' },
                        parent_name: { type: 'string', description: 'Full name of the parent/guardian' },
                        parent_phone: { type: 'string', description: 'Parent phone number' },
                        parent_email: { type: 'string', description: 'Parent email address' },
                        child_name: { type: 'string', description: 'Child\'s name' },
                        child_age: { type: 'string', description: 'Child\'s age (e.g. "3 years")' },
                        reason: { type: 'string', description: 'Reason for tour / enrollment interest' }
                    },
                    required: ['date', 'time', 'parent_name', 'parent_phone', 'parent_email', 'child_name', 'child_age']
                }
            },
            server: {
                url: `${backendUrl}/api/voice/vapi-book`,
                timeoutSeconds: 15
            },
            messages: [
                { type: 'request-start', content: 'Let me lock that in for you...' },
                { type: 'request-complete', content: 'Your tour is booked!' },
                { type: 'request-failed', content: 'I wasn\'t able to complete the booking just now. Let me try that again.' }
            ]
        },
        {
            type: 'function',
            function: {
                name: 'get_school_info',
                description: 'Get information about the school including hours, address, and programs.',
                parameters: {
                    type: 'object',
                    properties: {
                        query: {
                            type: 'string',
                            description: 'What information the parent is asking about (e.g. "hours", "programs", "address", "pricing")'
                        }
                    },
                    required: ['query']
                }
            },
            server: {
                url: `${backendUrl}/api/voice/agent-config?schoolId=${schoolId}`,
                timeoutSeconds: 10
            },
            messages: [
                { type: 'request-start', content: 'Let me look that up for you...' },
                { type: 'request-complete', content: 'Here\'s what I can tell you:' },
                { type: 'request-failed', content: 'I don\'t have that information right now, but our team can help.' }
            ]
        }
    ];
}

// ── Assistant CRUD ────────────────────────────────────────────────────────

/**
 * Create a new VAPI assistant for a school.
 * @param {object} opts
 * @param {string} opts.schoolName - School display name
 * @param {string} opts.schoolId - MongoDB school ObjectId
 * @param {string} [opts.firstMessage] - Custom greeting
 * @param {string} [opts.systemPrompt] - Custom system prompt
 * @param {string} [opts.voiceId] - VAPI voice ID
 * @param {string} [opts.model] - LLM model (default: gpt-4o)
 * @param {string} opts.backendUrl - Backend URL for tool callbacks
 * @returns {Promise<{assistantId: string|null, error?: string}>}
 */
async function createAssistant({
    schoolName,
    schoolId,
    firstMessage,
    systemPrompt,
    voiceId,
    model,
    backendUrl
}) {
    if (!VAPI_API_KEY) {
        console.warn('[VAPI] VAPI_API_KEY not configured, skipping assistant creation');
        return { assistantId: null, error: 'VAPI_API_KEY not configured' };
    }

    try {
        const url = `${VAPI_BASE_URL}/assistant`;

        const prompt = (systemPrompt || NORA_SYSTEM_PROMPT_VAPI)
            .replace(/{{SCHOOL_NAME}}/g, schoolName);

        const payload = {
            name: `${schoolName} - Nora`,
            model: {
                provider: 'openai',
                model: model || 'gpt-4o',
                systemPrompt: prompt,
                temperature: 0.7,
            },
            voice: {
                provider: '11labs',
                voiceId: voiceId || 'jqcCZkN6Knx8BJ5TBdYR',
            },
            firstMessage: (firstMessage || DEFAULT_FIRST_MESSAGE)
                .replace(/{{SCHOOL_NAME}}/g, schoolName),
            transcriber: {
                provider: 'deepgram',
                model: 'nova-2',
                language: 'multi',
                smartFormat: true,
            },
            serverUrl: `${backendUrl}/api/v1/webhook/vapi`,
            serverUrlSecret: VAPI_WEBHOOK_SECRET,
            endCallMessage: 'Thank you for calling. We look forward to seeing you!',
            silenceTimeoutSeconds: 30,
            maxDurationSeconds: 600, // 10 minutes max
            backgroundDenoisingEnabled: true,
            recordingEnabled: true,
            // Store schoolId in metadata for webhook routing
            metadata: {
                schoolId: schoolId.toString(),
                platform: 'vapi',
            },
            // Tool configuration
            tools: buildVapiTools(backendUrl, schoolId),
            // Server messages to subscribe to
            serverMessages: [
                'end-of-call-report',
                'tool-calls',
                'status-update',
                'transcript',
            ],
        };

        console.log(`[VAPI] Creating assistant: POST ${url}`);
        console.log(`[VAPI] School: ${schoolName} (${schoolId})`);

        const response = await axios.post(url, payload, {
            headers: getHeaders(),
            validateStatus: null,
        });

        if (response.status === 201) {
            console.log(`[VAPI] Assistant created: ${response.data.id}`);
            return { assistantId: response.data.id };
        }

        console.error(`[VAPI] Create assistant failed (${response.status}):`, JSON.stringify(response.data, null, 2));
        return { assistantId: null, error: response.data?.message || `HTTP ${response.status}` };

    } catch (err) {
        console.error('[VAPI] Create assistant error:', err.message);
        return { assistantId: null, error: err.message };
    }
}

/**
 * Update an existing VAPI assistant.
 * @param {string} assistantId
 * @param {object} updates - Fields to update
 */
async function updateAssistant(assistantId, updates) {
    if (!VAPI_API_KEY || !assistantId) return null;

    try {
        const url = `${VAPI_BASE_URL}/assistant/${assistantId}`;
        console.log(`[VAPI] Updating assistant: PATCH ${url}`);

        const response = await axios.patch(url, updates, {
            headers: getHeaders(),
            validateStatus: null,
        });

        if (response.status === 200) {
            console.log(`[VAPI] Assistant updated: ${assistantId}`);
            return response.data;
        }

        console.error(`[VAPI] Update assistant failed (${response.status}):`, JSON.stringify(response.data, null, 2));
        return null;

    } catch (err) {
        console.error('[VAPI] Update assistant error:', err.message);
        return null;
    }
}

/**
 * Delete a VAPI assistant.
 */
async function deleteAssistant(assistantId) {
    if (!VAPI_API_KEY || !assistantId) return null;

    try {
        const url = `${VAPI_BASE_URL}/assistant/${assistantId}`;
        const response = await axios.delete(url, { headers: getHeaders(), validateStatus: null });
        return response.status === 200 || response.status === 204;
    } catch (err) {
        console.error('[VAPI] Delete assistant error:', err.message);
        return false;
    }
}

/**
 * Get a VAPI assistant by ID.
 */
async function getAssistant(assistantId) {
    if (!VAPI_API_KEY || !assistantId) return null;

    try {
        const url = `${VAPI_BASE_URL}/assistant/${assistantId}`;
        const response = await axios.get(url, {
            headers: getHeaders(),
            validateStatus: null,
        });
        if (response.status === 200) return response.data;
        return null;
    } catch (err) {
        console.error('[VAPI] Get assistant error:', err.message);
        return null;
    }
}

// ── Phone Number Management ───────────────────────────────────────────────

/**
 * Import a purchased Twilio number into VAPI.
 * VAPI manages the Twilio number and routes calls to the assistant.
 *
 * @param {object} opts
 * @param {string} opts.number - Twilio phone number in E.164 format (+15551234567)
 * @param {string} [opts.name] - Friendly label
 * @param {string} [opts.assistantId] - VAPI assistant to link this number to
 * @param {string} [opts.serverUrl] - Webhook URL for assistant-request events
 * @returns {Promise<{ id: string, number: string } | null>}
 */
async function importPhoneNumber({ number, name, assistantId, serverUrl }) {
    if (!VAPI_API_KEY || !number) return null;

    try {
        const url = `${VAPI_BASE_URL}/phone-number`;
        const payload = {
            number,
            provider: 'twilio',
        };
        payload.name = name || '';
        payload.assistantId = assistantId || null;
        payload.serverUrl = serverUrl || '';

        // Pass Twilio credentials so VAPI can manage the number
        if (process.env.TWILIO_ACCOUNT_SID) payload.twilioAccountSid = process.env.TWILIO_ACCOUNT_SID;
        if (process.env.TWILIO_AUTH_TOKEN) payload.twilioAuthToken = process.env.TWILIO_AUTH_TOKEN;

        console.log(`[VAPI] Importing phone number: POST ${url}`);
        console.log(`[VAPI] Number: ${number}, assistantId: ${assistantId || 'none'}, twilioSid: ${(process.env.TWILIO_ACCOUNT_SID || '').slice(0, 6)}...`);

        const response = await axios.post(url, payload, {
            headers: getHeaders(),
            validateStatus: null,
        });

        if (response.status === 201 || response.status === 200) {
            const vapiPhoneId = response.data.id;
            console.log(`[VAPI] Phone number imported: id=${vapiPhoneId}, number=${response.data.number || number}`);

            // Follow-up PATCH to ensure assistantId + serverUrl persist
            const patchPayload = {
                assistantId: assistantId || null,
                serverUrl: serverUrl || '',
            };
            try {
                const patchRes = await axios.patch(`${VAPI_BASE_URL}/phone-number/${vapiPhoneId}`, patchPayload, {
                    headers: getHeaders(),
                    validateStatus: null,
                });
                console.log(`[VAPI] Post-import PATCH: status=${patchRes.status}, assistantId=${assistantId || 'null'}, serverUrl=${serverUrl || '(empty)'}`);
            } catch (patchErr) {
                console.warn('[VAPI] Post-import PATCH failed:', patchErr.message);
            }

            return response.data;
        }

        // 409 = already exists in VAPI
        if (response.status === 409) {
            console.warn(`[VAPI] Phone number ${number} already exists in VAPI — attempting to look it up...`);
            return await findPhoneNumber(number);
        }

        console.error(`[VAPI] Import phone number failed (${response.status}):`, JSON.stringify(response.data).slice(0, 300));
        return null;
    } catch (err) {
        console.error('[VAPI] Import phone number error:', err.message);
        return null;
    }
}

/**
 * Look up a VAPI phone number by its E.164 number.
 */
async function findPhoneNumber(number) {
    if (!VAPI_API_KEY || !number) return null;
    try {
        const url = `${VAPI_BASE_URL}/phone-number`;
        const response = await axios.get(url, {
            headers: getHeaders(),
            validateStatus: null,
        });
        if (response.status === 200 && Array.isArray(response.data)) {
            const found = response.data.find(
                p => p.number === number || p.phoneNumber === number
            );
            if (found) {
                console.log(`[VAPI] Found existing phone number: ${found.id}`);
                return found;
            }
        }
        return null;
    } catch (err) {
        console.error('[VAPI] Find phone number error:', err.message);
        return null;
    }
}

/**
 * Link a phone number to an assistant.
 */
async function linkPhoneToAssistant(phoneNumberId, assistantId) {
    if (!VAPI_API_KEY || !phoneNumberId || !assistantId) return null;

    try {
        const url = `${VAPI_BASE_URL}/phone-number/${phoneNumberId}`;
        const response = await axios.patch(url, {
            assistantId: assistantId,
        }, {
            headers: getHeaders(),
            validateStatus: null,
        });
        return response.status === 200 ? response.data : null;
    } catch (err) {
        console.error('[VAPI] Link phone error:', err.message);
        return null;
    }
}

// ── Call Management ───────────────────────────────────────────────────────

/**
 * Initiate an outbound call via VAPI.
 * @param {object} opts
 * @param {string} opts.assistantId - VAPI assistant ID
 * @param {string} opts.phoneNumber - Destination phone number (E.164)
 * @param {string} [opts.callerId] - VAPI phone number ID to call FROM
 * @returns {Promise<{callId: string|null, error?: string}>}
 */
async function createCall({ assistantId, phoneNumber, callerId }) {
    if (!VAPI_API_KEY || !assistantId || !phoneNumber) {
        return { callId: null, error: 'Missing assistantId or phoneNumber' };
    }

    try {
        const url = `${VAPI_BASE_URL}/call`;
        const payload = {
            assistantId: assistantId,
            customer: {
                number: phoneNumber,
            },
        };

        if (callerId) {
            payload.phoneNumberId = callerId;
        }

        console.log(`[VAPI] Creating call: POST ${url}`);
        const response = await axios.post(url, payload, {
            headers: getHeaders(),
            validateStatus: null,
        });

        if (response.status === 201) {
            console.log(`[VAPI] Call created: ${response.data.id}`);
            return { callId: response.data.id };
        }

        console.error(`[VAPI] Create call failed:`, response.data);
        return { callId: null, error: response.data?.message || `HTTP ${response.status}` };
    } catch (err) {
        console.error('[VAPI] Create call error:', err.message);
        return { callId: null, error: err.message };
    }
}

// ── Webhook Signature Validation ──────────────────────────────────────────

/**
 * Validate the VAPI webhook signature.
 * VAPI signs webhook payloads using HMAC-SHA256.
 */
function validateWebhookSignature(req) {
    if (!VAPI_WEBHOOK_SECRET) {
        console.warn('[VAPI] Webhook secret not configured — skipping signature validation');
        return true;
    }

    const signature = req.headers['x-vapi-signature'];
    if (!signature) {
        console.warn('[VAPI] No x-vapi-signature header — allowing (may be legacy)');
        return true; // Some VAPI setups don't send signatures
    }

    try {
        const hash = crypto
            .createHmac('sha256', VAPI_WEBHOOK_SECRET)
            .update(JSON.stringify(req.body))
            .digest('hex');

        const valid = crypto.timingSafeEqual(
            Buffer.from(signature),
            Buffer.from(hash)
        );
        if (!valid) {
            console.error('[VAPI] Webhook signature mismatch');
        }
        return valid;
    } catch (err) {
        console.error('[VAPI] Signature validation error:', err.message);
        return false;
    }
}

// ── Exports ────────────────────────────────────────────────────────────────

module.exports = {
    createAssistant,
    updateAssistant,
    deleteAssistant,
    getAssistant,
    importPhoneNumber,
    findPhoneNumber,
    linkPhoneToAssistant,
    createCall,
    validateWebhookSignature,
    buildVapiTools,
    NORA_SYSTEM_PROMPT_VAPI,
    DEFAULT_FIRST_MESSAGE,
};
