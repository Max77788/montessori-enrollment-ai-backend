/**
 * Auto Phone Assignment Service
 *
 * Orchestrates the full phone number provisioning flow during school registration:
 *   1. Purchase a Twilio phone number
 *   2. Import it into VAPI (or ElevenLabs SIP)
 *   3. Create a VAPI assistant (if provider is VAPI)
 *   4. Link phone → assistant → school
 *   5. Store everything in the database
 *
 * Uses dynamic domain from the request — no hardcoded URLs.
 */

const School = require('../models/School');
const PhoneNumber = require('../models/PhoneNumber');

/**
 * Auto-assign a phone number to a newly registered school.
 *
 * @param {string} schoolId - The school's MongoDB _id
 * @param {object} req - Express request (used for dynamic domain + logging)
 * @returns {Promise<{ success: boolean, phoneNumber?: string, vapiPhoneId?: string, vapiAssistantId?: string, error?: string }>}
 */
async function autoAssignPhoneNumber(schoolId, req) {
    const school = await School.findById(schoolId);
    if (!school) return { success: false, error: 'School not found' };

    const baseDomain = process.env.BACKEND_URL ||
        `${req.protocol}://${req.get('host')}`;

    console.log(`[AutoAssign] Starting for school "${school.name}" (${schoolId})`);
    console.log(`[AutoAssign] Base domain: ${baseDomain}`);
    console.log(`[AutoAssign] Voice provider: ${school.voiceProvider || 'elevenlabs'}`);

    const results = { success: false };

    try {
        // ── Step 1: Purchase a Twilio number ──────────────────────────
        const { purchasePhoneNumber } = require('./twilioService');
        const twilioResult = await purchasePhoneNumber({
            areaCode: process.env.TWILIO_DEFAULT_AREA_CODE || undefined,
        });

        if (twilioResult.error) {
            console.warn(`[AutoAssign] Twilio purchase failed: ${twilioResult.error}`);
            return { success: false, error: `Twilio: ${twilioResult.error}` };
        }

        console.log(`[AutoAssign] Twilio purchased: ${twilioResult.phoneNumber} (SID: ${twilioResult.sid})`);
        results.phoneNumber = twilioResult.phoneNumber;
        results.twilioSid = twilioResult.sid;

        // ── Step 2: Import into voice provider ────────────────────────
        const provider = school.voiceProvider || 'elevenlabs';

        if (provider === 'vapi') {
            // 2a: Create VAPI assistant if needed
            let vapiAssistantId = school.vapiAssistantId;
            if (!vapiAssistantId) {
                const { createAssistant } = require('./vapiService');
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
                    console.log(`[AutoAssign] VAPI assistant created: ${vapiAssistantId}`);
                } else {
                    console.warn('[AutoAssign] VAPI assistant creation failed, continuing without assistant');
                }
            }

            // 2b: Import Twilio number into VAPI
            const { importPhoneNumber: importVapiNumber } = require('./vapiService');
            const vapiPhone = await importVapiNumber({
                number: twilioResult.phoneNumber,
                name: `${school.name} Main`,
                assistantId: vapiAssistantId || undefined,
                serverUrl: `${baseDomain}/vapi/assistant-request`,
            });

            if (vapiPhone && vapiPhone.id) {
                school.vapiPhoneNumberId = vapiPhone.id;
                results.vapiPhoneId = vapiPhone.id;
                console.log(`[AutoAssign] VAPI phone imported: ${vapiPhone.id}`);
            } else {
                console.warn('[AutoAssign] VAPI phone import failed');
            }

            results.vapiAssistantId = vapiAssistantId || null;

        } else {
            // ElevenLabs SIP flow
            const { importSipTrunk } = require('../utils/elevenlabs');
            const sipResult = await importSipTrunk({
                phone_number: twilioResult.phoneNumber,
                label: `${school.name} Main`,
            });

            if (sipResult && sipResult.phone_number_id) {
                school.agentPhoneNumberId = sipResult.phone_number_id;
                results.sipPhoneId = sipResult.phone_number_id;
                console.log(`[AutoAssign] ElevenLabs SIP trunk imported: ${sipResult.phone_number_id}`);
            }
        }

        // ── Step 3: Save to School ────────────────────────────────────
        school.aiNumber = twilioResult.phoneNumber;
        await school.save();

        // Also store in PhoneNumber pool for tracking
        await PhoneNumber.create({
            phone_number_id: results.vapiPhoneId || results.sipPhoneId || twilioResult.sid,
            phone_number: twilioResult.phoneNumber,
            provider: provider === 'vapi' ? 'vapi' : 'sip_trunk',
            label: `${school.name} Main`,
            schoolId: schoolId,
            twilioSid: twilioResult.sid,
            vapiPhoneId: results.vapiPhoneId || '',
            metadata: { autoAssigned: true, baseDomain },
        });

        results.success = true;
        console.log(`[AutoAssign] ✅ Complete: ${school.name} → ${twilioResult.phoneNumber}`);

    } catch (err) {
        console.error('[AutoAssign] Error:', err.message);
        results.error = err.message;
        results.success = false;
    }

    return results;
}

module.exports = { autoAssignPhoneNumber };
