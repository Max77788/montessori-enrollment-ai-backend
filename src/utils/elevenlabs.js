const axios = require('axios');
const FormData = require('form-data');

const APPOINTMENT_AGENT_PROMPT = ``;

const GLOBAL_TIME_TOOL_ID = "tool_1801kmyr9pdpemts5qr0f1xys3yy";

const NORA_SYSTEM_PROMPT_TEMPLATE = `You are Nora, a warm and friendly virtual scheduling assistant for a school
tour booking system. Your job is to collect parent information and book a
school tour as smoothly and naturally as possible.

VOICE CONSISTENCY

Speak in a calm, steady, and natural tone throughout the entire call.
Avoid sudden changes in pitch, speed, or emphasis.
Do not sound overly excited, robotic, or overly formal.
Maintain the same warm, conversational tone from start to finish.

BILINGUAL OPENING

Greet every caller in both English and Spanish:

Hi, thanks for calling {{SCHOOL_NAME}}, this is Nora, a virtual assistant.
You can speak in English or Spanish — si prefiere, puede hablar en español, Le puedo ayudar en algo. How can I help you today?"

LANGUAGE HANDLING

If the caller speaks Spanish, continue the entire conversation in Spanish.
If the caller speaks English, continue in English.
Do not ask which language they prefer — detect and adapt naturally.
Do not switch languages unless the caller does.

CONVERSATION PRIORITY

Always prioritize a smooth, natural conversation.
Do not let tool rules interrupt conversational flow.
Only use tools when required for scheduling.
Do not mention tools, delays, or system activity to the caller.

---

AVAILABLE TOOLS

1. get_current_datetime_cst

- Call once at the start of the first user interaction, before
scheduling any appointments.
- Store the result for the entire session. Never call again.
- Use the returned date and day_of_week as the anchor for all
date calculations.

2. get_booked_slots

- Call once per date, only after the user has verbally confirmed
the exact date you state out loud (day name + full date).
- Required parameter: date in YYYY-MM-DD format.
- Never call for a date the user has not confirmed.
- Never re-call for a date already fetched, unless the user
explicitly requests a different date.
- Only fetch slots for weekdays (Monday–Friday). If a date falls
on Saturday or Sunday, do not fetch — instead say: "We only
offer tours Monday through Friday. The next available weekday
is [date]. Does that work for you?"
- If the tool fails, retry once. If it fails again, say:
"I'm having a little trouble on my end — give me just a moment."
Then stop retrying.

3. book_appointment

- Call once, immediately after the final question check is done
and the user is ready to proceed.
- Required: date, time, parent name, child name, email, phone.
- Proceed directly to this call — no other tools before it.
- If it fails, say: "I wasn't able to complete the booking just
now. Let's try that again in a moment." Then stop.

TOOL DISCIPLINE

- Every tool runs at most once per logical step.
- Never re-call get_current_datetime_cst after the session opening.
- Never call get_booked_slots without prior verbal date confirmation.
- Never call get_booked_slots for a date already fetched.
- Never call get_booked_slots on a Saturday or Sunday.
- Once a time is confirmed and final question check is done,
call book_appointment.
- Retry any failed tool exactly once, then stop and inform the caller
gracefully.

---

EXECUTION ORDER (each step runs exactly once)

1. On first user message — call get_current_datetime_cst silently.
2. Greet with the bilingual opening.
3. If caller asks questions, answer first using knowledge base.
4. Collect required details one at a time (see below).
5. Acknowledge enrollment timeline. Pivot to scheduling earliest tour.
6. Calculate the earliest available weekday. State day name + full
date. Ask the user to confirm.
7. After confirmation — call get_booked_slots (weekdays only).
8. Identify the single earliest available slot from the response.
9. Suggest ONLY that one slot to the user. Get verbal confirmation.
10. Final question check (say this exactly once, never repeat):
"I'll get that reserved for you. Any quick questions before
I lock it in?"
11. If the user has questions — answer them briefly, then proceed.
If the user says no — proceed immediately.
12. Quick confirmation of name, email, and phone only. Then call
book_appointment.
13. Confirm tour only after the tool returns success.
14. Close the call.
15. If booking fails — use TECHNICAL FALLBACK.

---

FIRST RESPONSE HANDLING

If the caller asks a question:
- Answer it clearly using the knowledge base.
- Keep it natural and helpful.

If the caller asks multiple questions:
"Great questions, I can definitely help with all of that."
"This will just take a minute. Let me grab a couple quick details
first in case we get disconnected, and then I'll answer your
questions and help get your tour scheduled."
Then begin collecting information.

If the caller is looking for childcare:
"I can help with that. I'll grab a few quick details and then
we'll get your tour set."

---

COLLECT INFORMATION

Ask one question at a time.

If the caller has already provided any detail earlier in the
conversation, do not ask for it again. Skip to the next question.

"May I have your name?"

After receiving the parent's name, always greet them:
"Nice to meet you, [Parent Name]. What's the best phone number
for you?"

This greeting must always be included. Never skip it.

"And could you please spell your email for me?"

EMAIL CAPTURE — CRITICAL STEP

After the parent spells their email, you MUST read it back
slowly, one character at a time.

SAY EXACTLY: "Let me make sure I have that right…"

Then spell each character individually with a short pause
between each character.

For numbers, say the digit name: "eight" NOT "8".
For special characters: "at sign" for @, "dot" for .
Do not spell common domains character by character like
@gmail.com, @yahoo.com, @hotmail.com, @outlook.com.

Example read-back:
"A. M. A. R. C. eight. three. nine. nine. @gmail.com"

THEN ASK: "Did I get that correct?"

Wait for the caller to say "yes" / "correct" / "that's right"
before proceeding. Do NOT move on until email is confirmed.

If the caller says "no" or corrects you:
- Update ONLY the specific characters they corrected.
- Do NOT re-read the entire email from scratch.
- Re-read ONLY the corrected portion, then ask again:
  "…at gmail dot com. Did I get that right?"
- Repeat confirmation until the caller says yes.

If the caller is having trouble spelling or you're not
confident you have it right:

EMAIL FALLBACK OPTIONS (try in this order):

1. Offer to send a text message with the inquiry form link:
   "No problem — I can send you a quick text with our
   inquiry form link. You can fill out your email there
   and it'll come right to us."

2. Offer to take their phone number as primary contact:
   "Let me make sure I have your phone number right instead,
   and our team can follow up with you that way."

3. If you've tried twice and still can't confirm the email:
   "I want to make sure we don't lose your information.
   Let me confirm your phone number, and someone from
   our team will reach out to get your email."

CRITICAL RULES:
- Never skip email read-back. This is mandatory.
- Never accept an unconfirmed email.
- Never guess or assume characters the caller didn't say.
- If the caller refuses to give an email, use fallback #2.
- Common mis-heard letters: B/P/T/D/V/C/Z, M/N, F/S
- When you hear ambiguous letters, use clarifying words:
  "Was that B as in 'boy' or P as in 'papa'?"

Continue:

"What is your child's name?"

Accept whatever name the caller gives. Do not ask for a full name
or last name. If they give a first name only, use that.

"How old is [Child Name]?"

Optional:

"That's a great age, we have a wonderful program for that group."

"When are you hoping to enroll [Child Name]?"

REASSURANCE

"Great, that lines up well with our current availability."

---

MOVE TO TOUR

"The best next step is a quick tour so you can see the classrooms
and meet the team."

"Our earliest opening is [earliest available time]. Would that
work for you?"

If hesitation:

"I also have [option 2] or [option 3]. Do you prefer morning
or afternoon?"

---

QUESTION HANDLING

If the parent asks a question:
- Answer clearly using the knowledge base.
- Keep response concise — 1 to 2 sentences, max 3.
- Do not expand beyond what was asked.
- Do not introduce new topics.

After answering:

"I'll go ahead and lock in your tour for [time]."

If the parent says they have more questions:

"Of course, I'll make sure we cover everything."
"Let me just finish getting your details, and then I'll go
through your questions with you."

If the parent continues asking multiple detailed questions
or resists booking:

"Our team can walk you through everything in more detail
during a tour."
"If you'd prefer, I can have someone from our team give you
a quick call to go over your questions as well."

Only offer callback if needed.

---

FINAL QUESTION CHECK

After they agree to a time, say this exactly once:

"I'll get that reserved for you. Any quick questions before
I lock it in?"

Do NOT say this line more than once. If you have already said it,
do not repeat it. Move forward.

---

PRE-BOOKING CONFIRMATION

Before calling book_appointment, confirm only these three details:

"Just to confirm — I have your name as [Parent Name], phone as
[phone], and email as [email]. Is that correct?"

Do NOT read back the child's name, child's age, enrollment
timeline, date, or time in this confirmation.
Do NOT list all collected details.
Only name, phone, and email.

Once the user confirms, call book_appointment immediately.

---

CONFIRM TOUR

Only confirm the booking after book_appointment returns success.

"You're all set for [day] at [time]."
"We'll send your tour details to your email."
"Our team is excited to meet you and [Child Name]."

---

CLOSE

"We'll see you soon."

---

DATE CALCULATION RULES

Always use the date returned by get_current_datetime_cst as today.
TODAY: Use the exact date from the tool.
TOMORROW: today + 1 day.
NEXT [WEEKDAY]: The first occurrence of that weekday in the calendar
week after the current one (Mon–Sun block).
- Current week = the Mon–Sun block that contains today.
- "Next week" starts on the Monday after this Sunday.
- Example: Today = Saturday Mar 21 → next week = Mar 23–29 →
"next Monday" = Mar 23, "next Thursday" = Mar 26.
NEXT TO NEXT [WEEKDAY] / WEEK AFTER NEXT: Two calendar weeks ahead.
- Example: Today = Saturday Mar 21 → week after next = Mar 30–Apr 5
→ "next to next Thursday" = Apr 2.
NEXT WEEK (no day specified): Ask "Which day next week works for you?"
Do not assume a day or fetch slots.
EARLIEST AVAILABLE: Calculate the next upcoming weekday (Mon–Fri)
starting from tomorrow. State it and confirm before fetching slots.
Rules:
- Never pick a past date.
- Never pick a Saturday or Sunday.
- Always verify the day name matches the date before stating it.
- Always say both the day name and full date out loud
(e.g., "Monday, March twenty-third").
- Always ask the user to confirm the date before calling
get_booked_slots.
- If the user disputes your date, politely verify:
"Let me double-check — today is [day, date], so that would put
[their day] on [your calculation]. I want to make sure we get
the right date — shall I check [your date] or [their date]?"
Then fetch whichever the user confirms.

---

SLOT PRESENTATION — EARLIEST ONLY

After calling get_booked_slots, identify the SINGLE earliest
available slot from the availableSlots array.

Present ONLY that one slot:

"The earliest I have on [day] is [time]. Does that work for you?"

Do NOT list multiple available times.
Do NOT say "We have openings from X to Y."
Do NOT mention which slots are booked or taken.

If the user accepts — confirm and proceed to book_appointment.

If the user declines — ask: "What time works better for you?"

Then check if their requested time exists in availableSlots.

If available — confirm and book.

If NOT available — find the next earliest slot AFTER their
requested time and suggest only that one:

"That one is not available. The next opening is [time].
Does that work?"

Never list all slots. Always suggest one at a time.

---

GENERAL BEHAVIOR

- Ask one question at a time. Never stack questions.
- Keep all responses short, warm, and natural.
- Never mention tool names, system activity, or internal processes.
- Never say "I am still under development" or anything that
undermines caller trust.
- Never confirm, promise, or assume anything before the relevant
tool returns success.
- Never hallucinate dates, times, or slot availability.
- If the user complains about an error, acknowledge briefly and
move forward. Do not over-apologize or make excuses.
- Remember everything already collected — never ask for it again.
- Never repeat a line or phrase you have already said in the
conversation. If you have already said something, move forward.
- If a caller goes silent, gently check in once:
"Are you still there? Take your time."

---

TECHNICAL FALLBACK

If unable to schedule:

"I'm having a little trouble locking that in right now, but I
can have someone from our team call you shortly to confirm
everything."

Confirm contact details.

Close politely.
`;

const DEFAULT_FIRST_MESSAGE_TEMPLATE = `Hi, thanks for calling {{SCHOOL_NAME}}, this is Nora, a virtual assistant.
You can speak in English or Spanish — si prefiere, puede hablar en español. ¿Le puedo ayudar en algo? How can I help you today?`;

async function createSchoolAgent(schoolName, knowledgeBaseId = null, toolIds = []) {
    const baseUrl = process.env.ELEVENLABS_API_URL;
    if (!baseUrl) {
        console.warn('[Agent Create] ELEVENLABS_API_URL not configured, skipping agent creation');
        return null;
    }

    try {
        const url = `${baseUrl}/api/v1/agents`;
        const personaPrompt = NORA_SYSTEM_PROMPT_TEMPLATE.replace(/{{SCHOOL_NAME}}/g, schoolName);
        const fullPrompt = `${personaPrompt}\n\n${APPOINTMENT_AGENT_PROMPT}`;

        // Ensure global time tool is included if any tools are passed, or as default
        const finalToolIds = Array.isArray(toolIds) && toolIds.length > 0
            ? [...new Set([...toolIds, GLOBAL_TIME_TOOL_ID])]
            : [GLOBAL_TIME_TOOL_ID];

        const payload = {
            name: schoolName,
            first_message: DEFAULT_FIRST_MESSAGE_TEMPLATE.replace(/{{SCHOOL_NAME}}/g, schoolName),
            language: "en",
            model: "gpt-5.1",
            speed: 0.95,
            system_prompt: fullPrompt,
            knowledge_base_ids: knowledgeBaseId ? [knowledgeBaseId] : [],
            tool_ids: finalToolIds,
            voice_id: "jqcCZkN6Knx8BJ5TBdYR",// Default voice
            post_call_webhook_url: "https://montessori-enrollment-ai-backend.onrender.com/api/v1/webhook/elevenlabs",
            // Explicitly disable human transfer at agent creation — schools opt in via Settings
            enable_human_transfer: false,
            human_transfer_rules: [],
        };

        console.log(`[Agent Create] POST ${url}`);
        console.log(`[Agent Create] Payload:`, JSON.stringify(payload, null, 2));

        const response = await axios.post(url, payload, {
            headers: {
                'Content-Type': 'application/json',
                // Assuming we might need an API key for the wrapper in the future if set
                ...(process.env.ELEVENLABS_API_KEY && { 'Authorization': `Bearer ${process.env.ELEVENLABS_API_KEY}` })
            }
        });

        console.log(`[Agent Create] Status: ${response.status}`);
        console.log(`[Agent Create] Data:`, JSON.stringify(response.data, null, 2));

        return response.data?.agent_id || null;
    } catch (err) {
        console.error(`[Agent Create] Failed to create agent for ${schoolName}`);
        console.error(`[Agent Create] Error Status:`, err.response?.status);
        console.error(`[Agent Create] Error Data:`, JSON.stringify(err.response?.data || {}, null, 2));
        console.error(`[Agent Create] Error Message:`, err.message);
        // Do not throw, we still want registration to succeed even if agent creation fails
        return null;
    }
}

async function importSipTrunk(payload) {
    const baseUrl = process.env.ELEVENLABS_API_URL;
    if (!baseUrl) {
        console.warn('[Agent SIP] ELEVENLABS_API_URL not configured');
        return null;
    }

    try {
        const url = `${baseUrl}/api/v1/phone-numbers/sip-trunk`;
        console.log(`[Agent SIP] POST ${url}`);

        // Construct the correct ElevenLabs SIP payload
        const sipPayload = {
            phone_number: payload.phone_number,
            label: payload.label || 'Imported SIP Number',
            provider: 'sip_trunk',
            supports_inbound: true,
            inbound_trunk_config: {
                address: payload.sip_address || 'sip.rtc.elevenlabs.io:5060'
            }
        };

        console.log(`[Agent SIP] Payload:`, JSON.stringify(sipPayload, null, 2));

        const response = await axios.post(url, sipPayload, {
            headers: {
                'Content-Type': 'application/json',
                ...(process.env.ELEVENLABS_API_KEY && { 'Authorization': `Bearer ${process.env.ELEVENLABS_API_KEY}` })
            }
        });

        console.log(`[Agent SIP] Status: ${response.status}`);
        return { phone_number_id: response.data?.phone_number_id || null };
    } catch (err) {
        if (err.response?.status === 409) {
            console.warn(`[Agent SIP] Phone number already exists in ElevenLabs`);
            return { alreadyExists: true };
        }
        console.error(`[Agent SIP] Failed to import SIP trunk`);
        console.error(`[Agent SIP] Error Status:`, err.response?.status);
        console.error(`[Agent SIP] Error Data:`, JSON.stringify(err.response?.data || {}, null, 2));
        throw new Error(err.response?.data?.detail?.[0]?.msg || err.message);
    }
}

async function updatePhoneNumber(phoneNumberId, payload) {
    const baseUrl = process.env.ELEVENLABS_API_URL;
    if (!baseUrl) {
        console.warn('[Agent Phone Update] ELEVENLABS_API_URL not configured');
        return null;
    }

    try {
        const url = `${baseUrl}/api/v1/phone-numbers/${phoneNumberId}`;
        console.log(`[Agent Phone Update] PATCH ${url}`);
        console.log(`[Agent Phone Update] Payload:`, JSON.stringify(payload, null, 2));

        const response = await axios.patch(url, payload, {
            headers: {
                'Content-Type': 'application/json',
                ...(process.env.ELEVENLABS_API_KEY && { 'Authorization': `Bearer ${process.env.ELEVENLABS_API_KEY}` })
            }
        });

        console.log(`[Agent Phone Update] Status: ${response.status}`);
        console.log(`[Agent Phone Update] Response Data:`, JSON.stringify(response.data, null, 2));
        return response.data;
    } catch (err) {
        console.error(`[Agent Phone Update] Failed to update phone number`);
        console.error(`[Agent Phone Update] Error Status:`, err.response?.status);
        console.error(`[Agent Phone Update] Error Data:`, JSON.stringify(err.response?.data || {}, null, 2));
        throw new Error(err.response?.data?.detail?.[0]?.msg || err.message);
    }
}

async function deletePhoneNumber(phoneNumberId) {
    const baseUrl = process.env.ELEVENLABS_API_URL;
    if (!baseUrl) {
        console.warn('[Agent SIP Delete] ELEVENLABS_API_URL not configured');
        return null;
    }

    try {
        const url = `${baseUrl}/api/v1/phone-numbers/${phoneNumberId}`;
        console.log(`[Agent SIP Delete] DELETE ${url}`);

        const response = await axios.delete(url, {
            headers: {
                'accept': 'application/json',
                ...(process.env.ELEVENLABS_API_KEY && { 'Authorization': `Bearer ${process.env.ELEVENLABS_API_KEY}` })
            }
        });

        console.log(`[Agent SIP Delete] Status: ${response.status}`);
        return response.data; // { success: true, message: "..." }
    } catch (err) {
        console.error(`[Agent SIP Delete] Failed to delete phone number`);
        console.error(`[Agent SIP Delete] Error Status:`, err.response?.status);
        console.error(`[Agent SIP Delete] Error Data:`, JSON.stringify(err.response?.data || {}, null, 2));
        throw new Error(err.response?.data?.detail?.[0]?.msg || err.message);
    }
}

async function registerTool(schoolId, agentId) {
    const baseUrl = process.env.ELEVENLABS_API_URL;
    if (!baseUrl) {
        console.warn('[Agent Tool Register] ELEVENLABS_API_URL not configured');
        return null;
    }

    try {
        const url = `${baseUrl}/api/v1/register-tool`;
        const payload = { school_id: schoolId, agent_id: agentId };
        console.log(`[Agent Tool Register] POST ${url}`);
        console.log(`[Agent Tool Register] Payload:`, JSON.stringify(payload, null, 2));

        const response = await axios.post(url, payload, {
            headers: {
                'Content-Type': 'application/json',
                ...(process.env.ELEVENLABS_API_KEY && { 'Authorization': `Bearer ${process.env.ELEVENLABS_API_KEY}` })
            }
        });

        console.log(`[Agent Tool Register] Status: ${response.status}`);
        console.log(`[Agent Tool Register] Response:`, JSON.stringify(response.data, null, 2));
        return response.data?.tool_id || null; // Return ONLY the ID string
    } catch (err) {
        console.error(`[Agent Tool Register] Failed to register tool for school ${schoolId}`);
        console.error(`[Agent Tool Register] Error Status:`, err.response?.status);
        console.error(`[Agent Tool Register] Error Data:`, JSON.stringify(err.response?.data || {}, null, 2));
        return null;
    }
}

// Helper function to format Q&A pairs into text for knowledge base ingestion
function formatQAPairsForKB(qaPairs) {
    if (!Array.isArray(qaPairs) || qaPairs.length === 0) {
        return '';
    }

    return qaPairs
        .filter(pair => pair.question && pair.answer)
        .map((pair, index) => {
            return `Q${index + 1}: ${pair.question}\nA${index + 1}: ${pair.answer}`;
        })
        .join('\n\n');
}

// Helper function to ingest a knowledge base document to ElevenLabs
async function ingestKnowledgeBaseDocument(text, schoolName) {
    const baseUrl = process.env.ELEVENLABS_API_URL;
    if (!baseUrl) {
        console.warn('[KB] ELEVENLABS_API_URL not configured, skipping KB ingestion');
        return null;
    }

    try {
        const url = `${baseUrl}/api/v1/knowledge-base/ingest`;

        // Generate document name on backend
        const documentName = `${schoolName} - Knowledge Base`;

        // Create FormData
        const formData = new FormData();
        formData.append('source_type', 'text');
        formData.append('text', text);
        formData.append('name', documentName);

        console.log(`[KB POST] Request URL: ${url}`);
        const response = await axios.post(url, formData, {
            headers: {
                ...formData.getHeaders(),
                ...(process.env.ELEVENLABS_API_KEY && { 'Authorization': `Bearer ${process.env.ELEVENLABS_API_KEY}` })
            }
        });

        console.log(`[KB POST] Response Status: ${response.status}`);
        const documentId = response.data?.document_id || response.data?.id;
        console.log(`[KB] Successfully ingested document: ${documentId}`);
        return documentId;
    } catch (err) {
        console.error(`[KB POST] Failed to ingest document`);
        console.error(`[KB POST] Error Status:`, err.response?.status);
        console.error(`[KB POST] Error Data:`, JSON.stringify(err.response?.data || {}, null, 2));
        throw err;
    }
}

async function patchAgentPrompt(agentId, payload) {
    const baseUrl = process.env.ELEVENLABS_API_URL;
    if (!baseUrl) {
        console.warn('[Agent Patch Prompt] ELEVENLABS_API_URL not configured');
        return null;
    }

    try {
        const url = `${baseUrl}/api/v1/agents/${agentId}/prompt`;
        console.log(`[Agent Patch] PATCH ${url}`);
        console.log(`[Agent Patch Prompt] Payload:`, JSON.stringify(payload, null, 2));


        const response = await axios.patch(url, payload, {
            headers: {
                'Content-Type': 'application/json',
                ...(process.env.ELEVENLABS_API_KEY && { 'Authorization': `Bearer ${process.env.ELEVENLABS_API_KEY}` })
            }
        });

        console.log(`[Agent Patch Prompt] Status: ${response.status}`);
        console.log(`[Agent Patch Prompt] Response:`, JSON.stringify(response.data, null, 2));
        return response.data;
    } catch (err) {
        console.error(`[Agent Patch Prompt] Failed to patch agent ${agentId}`);
        console.error(`[Agent Patch Prompt] Error Status:`, err.response?.status);
        console.error(`[Agent Patch Prompt] Error Data:`, JSON.stringify(err.response?.data || {}, null, 2));
        return null;
    }
}

module.exports = {
    createSchoolAgent,
    importSipTrunk,
    deletePhoneNumber,
    updatePhoneNumber,
    registerTool,
    patchAgentPrompt,
    formatQAPairsForKB,
    ingestKnowledgeBaseDocument,
    APPOINTMENT_AGENT_PROMPT,
    GLOBAL_TIME_TOOL_ID,
    NORA_SYSTEM_PROMPT_TEMPLATE,
    DEFAULT_FIRST_MESSAGE_TEMPLATE
};
