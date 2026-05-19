/**
 * Twilio Phone Number Service
 *
 * Purchases and manages phone numbers from Twilio for use with VAPI / ElevenLabs.
 * Used during school registration to auto-assign a phone number.
 */

const axios = require('axios');

const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || '';
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || '';
const TWILIO_API_BASE = 'https://api.twilio.com/2010-04-01';

function getAuthHeader() {
    const creds = Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString('base64');
    return { Authorization: `Basic ${creds}` };
}

/**
 * Search for and purchase an available US phone number from Twilio.
 *
 * @param {object} [opts]
 * @param {string} [opts.areaCode] - Preferred area code (e.g. "512")
 * @param {string} [opts.nearLatLong] - "lat,lon" for geographic proximity
 * @returns {Promise<{ phoneNumber: string, sid: string } | { error: string }>}
 */
async function purchasePhoneNumber(opts = {}) {
    if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN) {
        return { error: 'Twilio not configured. Set TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN.' };
    }

    try {
        // Step 1: Search for available numbers
        const searchParams = new URLSearchParams();
        searchParams.append('Capabilities', 'voice'); // Must support voice
        if (opts.areaCode) searchParams.append('AreaCode', opts.areaCode);
        if (opts.nearLatLong) searchParams.append('NearLatLong', opts.nearLatLong);
        searchParams.append('Limit', '1');

        console.log(`[Twilio] Searching available numbers...`, Object.fromEntries(searchParams));

        const searchRes = await axios.get(
            `${TWILIO_API_BASE}/Accounts/${TWILIO_ACCOUNT_SID}/AvailablePhoneNumbers/US/Local.json?${searchParams.toString()}`,
            { headers: getAuthHeader() }
        );

        const available = searchRes.data?.available_phone_numbers || [];
        if (available.length === 0) {
            console.warn('[Twilio] No available numbers found with these criteria, trying broader search...');
            // Retry without area code restriction
            const broadParams = new URLSearchParams();
            broadParams.append('Capabilities', 'voice');
            broadParams.append('Limit', '1');

            const broadRes = await axios.get(
                `${TWILIO_API_BASE}/Accounts/${TWILIO_ACCOUNT_SID}/AvailablePhoneNumbers/US/Local.json?${broadParams.toString()}`,
                { headers: getAuthHeader() }
            );
            const broadAvailable = broadRes.data?.available_phone_numbers || [];
            if (broadAvailable.length === 0) {
                return { error: 'No available phone numbers found in Twilio.' };
            }
            // Use the broad search result
            return await buyNumber(broadAvailable[0].phone_number);
        }

        const phoneNumber = available[0].phone_number;
        return await buyNumber(phoneNumber);

    } catch (err) {
        const detail = err.response?.data?.message || err.message;
        console.error('[Twilio] Purchase error:', detail);
        return { error: `Twilio purchase failed: ${detail}` };
    }
}

async function buyNumber(phoneNumber) {
    console.log(`[Twilio] Purchasing ${phoneNumber}...`);

    const webhookUrl = process.env.TWILIO_PHONE_NUMBER_WEBHOOK_URL
        || 'https://aifusioniqlabs.app.n8n.cloud/webhook/accept-provided-emails';

    const buyParams = new URLSearchParams();
    buyParams.append('PhoneNumber', phoneNumber);
    buyParams.append('VoiceUrl', webhookUrl);
    buyParams.append('VoiceMethod', 'POST');

    const buyRes = await axios.post(
        `${TWILIO_API_BASE}/Accounts/${TWILIO_ACCOUNT_SID}/IncomingPhoneNumbers.json`,
        buyParams.toString(),
        { headers: { ...getAuthHeader(), 'Content-Type': 'application/x-www-form-urlencoded' } }
    );

    const purchased = buyRes.data;
    console.log(`[Twilio] Purchased: ${purchased.phone_number} (SID: ${purchased.sid})`);
    console.log(`[Twilio] Voice webhook set to: ${webhookUrl}`);

    return {
        phoneNumber: purchased.phone_number,
        sid: purchased.sid,
        friendlyName: purchased.friendly_name,
    };
}

/**
 * Release a Twilio phone number (for cleanup / unassignment).
 */
async function releasePhoneNumber(sid) {
    if (!sid) return { error: 'No SID provided' };
    try {
        await axios.delete(
            `${TWILIO_API_BASE}/Accounts/${TWILIO_ACCOUNT_SID}/IncomingPhoneNumbers/${sid}.json`,
            { headers: getAuthHeader() }
        );
        console.log(`[Twilio] Released: ${sid}`);
        return { success: true };
    } catch (err) {
        console.error('[Twilio] Release error:', err.response?.data?.message || err.message);
        return { error: err.response?.data?.message || err.message };
    }
}

module.exports = { purchasePhoneNumber, releasePhoneNumber };
