require('dotenv').config();
const { google } = require('googleapis');
const axios = require('axios');
const mongoose = require('mongoose');
const { pca, getMsalClient } = require('../routes/integrations');
const Integration = require('../models/Integration');
const TourBooking = require('../models/TourBooking');

const googleConfig = {
    clientId: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    redirectUri: process.env.GOOGLE_REDIRECT_URI,
};

function createGoogleOAuthClient() {
    return new google.auth.OAuth2(
        googleConfig.clientId,
        googleConfig.clientSecret,
        googleConfig.redirectUri
    );
}

/**
 * Get busy time slots from the school's calendar (Google or Outlook) and from TourBooking.
 * @param {string} schoolId
 * @param {Date} startDate
 * @param {Date} endDate
 * @returns {Promise<{ busySlots: Array<{ start: Date, end: Date }>, error?: string }>}
 */
async function getBusySlots(schoolId, startDate, endDate) {
    const start = startDate instanceof Date ? startDate : new Date(startDate);
    const end = endDate instanceof Date ? endDate : new Date(endDate);
    console.log(`[getBusySlots] schoolId=${schoolId}, start=${start.toISOString()}, end=${end.toISOString()}`);
    const busySlots = [];

    const School = require('../models/School');
    const school = await School.findById(schoolId).select('preferredCalendar').lean();
    const preference = school?.preferredCalendar || 'google';

    const integrationCriteria = {
        schoolId,
        connected: true,
        type: { $in: ['google', 'outlook'] },
    };

    if (preference === 'google') integrationCriteria.type = 'google';
    else if (preference === 'outlook') integrationCriteria.type = 'outlook';
    else if (preference === 'none') return { busySlots };

    const integrations = await Integration.find(integrationCriteria).lean();
    const activeIntegrations = integrations.map(i => ({
        type: i.type,
        email: i.type === 'google' ? i.config?.userEmail : i.config?.account?.username
    }));

    for (const integration of integrations) {
        if (integration.type === 'google') {
            const result = await getGoogleBusySlots(integration, start, end);
            if (result.error) console.error('[Calendar] Error fetching Google busy slots:', result.error);
            else busySlots.push(...result.busySlots);
        } else if (integration.type === 'outlook') {
            const result = await getOutlookBusySlots(integration, start, end);
            if (result.error) console.error('[Calendar] Error fetching Outlook busy slots:', result.error);
            else busySlots.push(...result.busySlots);
        }
    }

    const bookings = await TourBooking.find({
        schoolId,
        scheduledAt: { $gte: start, $lt: end },
    }).select('scheduledAt calendarProvider calendarEmail calendarEventId').lean();

    const blockMinutes = 15;
    bookings.forEach(b => {
        // GOLDEN FIX for isolation and duplicates:
        // 1. If it has a calendarEventId, it's already on the calendar. Skip it.
        if (b.calendarEventId) return;

        const isInternal = !b.calendarProvider;
        const matchingIntegration = activeIntegrations.find(ai => ai.type === b.calendarProvider);
        
        let shouldInclude = false;
        if (isInternal) {
            // Include internal bookings ONLY if no calendar is connected
            if (activeIntegrations.length === 0) {
                shouldInclude = true;
            }
        } else if (matchingIntegration && b.calendarEmail === matchingIntegration.email) {
            shouldInclude = true;
        }

        if (shouldInclude) {
            const slotStart = new Date(b.scheduledAt);
            const slotEnd = new Date(slotStart.getTime() + blockMinutes * 60 * 1000);
            busySlots.push({ start: slotStart, end: slotEnd });
        }
    });

    // Final de-duplication
    const seen = new Set();
    const uniqueBusySlots = [];
    busySlots.forEach(s => {
        const key = s.start.toISOString();
        if (!seen.has(key)) {
            uniqueBusySlots.push(s);
            seen.add(key);
        }
    });

    return { busySlots: uniqueBusySlots };
}

async function getGoogleBusySlots(integration, start, end) {
    try {
        const oauth2Client = createGoogleOAuthClient();
        const tokens = integration.config?.tokens;
        if (!tokens?.access_token) return { busySlots: [], error: 'Google not authorized' };

        oauth2Client.setCredentials(tokens);

        // Listen for refreshed tokens
        oauth2Client.on('tokens', async (newTokens) => {
            console.log('[Calendar] Google tokens refreshed for school:', integration.schoolId);
            await Integration.updateOne(
                { _id: integration._id },
                { $set: { 'config.tokens': { ...tokens, ...newTokens } } }
            );
        });

        const calendar = google.calendar({ version: 'v3', auth: oauth2Client });
        const res = await calendar.events.list({
            calendarId: 'primary',
            timeMin: start.toISOString(),
            timeMax: end.toISOString(),
            singleEvents: true,
            orderBy: 'startTime',
        });
        const busySlots = (res.data.items || []).map(ev => {
            const s = ev.start?.dateTime || ev.start?.date;
            const e = ev.end?.dateTime || ev.end?.date;
            return { start: new Date(s), end: new Date(e) };
        });
        return { busySlots };
    } catch (err) {
        console.error('[Calendar] Google busy slots error:', err.message);
        return { busySlots: [], error: err.message };
    }
}

async function getOutlookBusySlots(integration, start, end) {
    try {
        const accessToken = await refreshOutlookToken(integration);
        if (!accessToken) return { busySlots: [], error: 'Outlook not authorized or token expired' };
        const res = await axios.get(
            'https://graph.microsoft.com/v1.0/me/calendarView',
            {
                params: {
                    startDateTime: start.toISOString(),
                    endDateTime: end.toISOString(),
                },
                headers: { Authorization: `Bearer ${accessToken}` },
            }
        );
        const busySlots = (res.data.value || []).map(ev => ({
            start: new Date(ev.start?.dateTime || ev.start),
            end: new Date(ev.end?.dateTime || ev.end),
        }));
        return { busySlots };
    } catch (err) {
        const msg = err.response?.data?.error?.message || err.message;
        console.error('[Calendar] Outlook busy slots error:', msg);
        return { busySlots: [], error: msg };
    }
}

/**
 * Check if a time slot is available (no overlap with calendar events or existing tour bookings).
 * @param {string} schoolId
 * @param {Date} start
 * @param {Date} end
 * @returns {Promise<{ available: boolean, error?: string }>}
 */
async function isSlotAvailable(schoolId, start, end) {
    const startDate = start instanceof Date ? start : new Date(start);
    const endDate = end instanceof Date ? end : new Date(end);
    if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) {
        return { available: false, error: 'Invalid date range' };
    }

    // Check if weekend (0 = Sunday, 6 = Saturday) based on local time or school timezone
    const day = startDate.getDay();
    if (day === 0 || day === 6) {
        return { available: false, error: 'Tour bookings are not available on weekends.' };
    }

    const { busySlots, error } = await getBusySlots(schoolId, startDate, endDate);
    if (error) return { available: false, error };

    const overlaps = busySlots.some(slot => {
        return startDate < slot.end && endDate > slot.start;
    });
    return { available: !overlaps };
}

/**
 * Convert local time (dateStr + hours:minutes) in a timezone to UTC Date.
 */
function toUtcFromLocal(dateStr, hours, minutes, tz) {
    const localStr = `${dateStr}T${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:00`;
    const guessUtc = new Date(localStr + 'Z');
    const formatter = new Intl.DateTimeFormat('en-US', {
        timeZone: tz,
        hour: 'numeric',
        minute: 'numeric',
        hour12: false
    });
    const parts = formatter.formatToParts(guessUtc);
    const actualH = parseInt(parts.find(p => p.type === 'hour').value);
    const actualM = parseInt(parts.find(p => p.type === 'minute').value);
    const diffMs = ((hours - actualH) * 60 + (minutes - actualM)) * 60 * 1000;
    return new Date(guessUtc.getTime() + diffMs);
}

/**
 * Get business-hours range (UTC) for a given date in the school's timezone.
 * @param {string} schoolId
 * @param {string} dateStr - YYYY-MM-DD
 * @returns {Promise<{ rangeStart: Date, rangeEnd: Date, error?: string }>}
 */
async function getBusinessHoursRange(schoolId, dateStr) {
    const [y, m, d] = dateStr.split('-').map(Number);
    if (!y || !m || !d) return { rangeStart: null, rangeEnd: null, error: 'Invalid date. Use YYYY-MM-DD.' };

    const School = require('../models/School');
    const school = await School.findById(schoolId).select('businessHoursStart businessHoursEnd timezone').lean();
    const tz = 'America/Chicago'; // Forced Global CST
    console.log(`[getBusinessHoursRange] schoolId=${schoolId}, tz=${tz}`);

    const weekdayStr = new Intl.DateTimeFormat('en-US', { weekday: 'short', timeZone: tz }).format(new Date(`${dateStr}T12:00:00Z`));
    if (weekdayStr === 'Sun' || weekdayStr === 'Sat') {
        return { rangeStart: null, rangeEnd: null, error: 'Weekend bookings are not allowed.' };
    }

    const [startH, startM] = (school?.businessHoursStart || '09:00').split(':').map(Number);
    const [endH, endM] = (school?.businessHoursEnd || '17:00').split(':').map(Number);

    const rangeStart = toUtcFromLocal(dateStr, startH || 9, startM || 0, tz);
    const rangeEnd = toUtcFromLocal(dateStr, endH || 17, endM || 0, tz);
    console.log(`[getBusinessHoursRange] result: rangeStart=${rangeStart.toISOString()}, rangeEnd=${rangeEnd.toISOString()}`);
    return { rangeStart, rangeEnd };
}

/**
 * Get free slots for a given day (business hours, 30-min blocks, excluding busy slots).
 * @param {string} schoolId
 * @param {string} dateStr - YYYY-MM-DD
 * @param {object} businessHours - { start: '09:00', end: '17:00' }
 * @returns {Promise<{ freeSlots: Array<{ start: string, end: string }>, error?: string }>}
 */
async function getFreeSlots(schoolId, dateStr, businessHours = { start: '09:00', end: '17:00' }) {
    const { rangeStart, rangeEnd, error: rangeError } = await getBusinessHoursRange(schoolId, dateStr);
    if (rangeError) return { freeSlots: [], error: rangeError };

    const { busySlots, error } = await getBusySlots(schoolId, rangeStart, rangeEnd);
    if (error) return { freeSlots: [], error };

    const freeSlots = [];
    const blockMs = 30 * 60 * 1000;
    const now = new Date();
    
    // Add a 30-min buffer if checking for today
    const minTime = now.getTime() + (30 * 60 * 1000); 

    let slotStart = new Date(rangeStart);
    while (slotStart.getTime() + blockMs <= rangeEnd.getTime()) {
        const slotEnd = new Date(slotStart.getTime() + blockMs);
        
        // Use the strict overlap check: any intersect with a busy slot blocks the interval
        const isBooked = busySlots.some(b => slotStart < b.end && slotEnd > b.start);
        
        // Also skip slots in the past (if the date is today)
        const isPast = slotStart.getTime() < minTime;

        if (!isBooked && !isPast) {
            freeSlots.push({
                start: slotStart.toISOString(),
                end: slotEnd.toISOString(),
            });
        }
        slotStart = slotEnd;
    }
    return { freeSlots };
}

/**
 * Create a calendar event for a school (Google or Outlook).
 * @param {string} schoolId - MongoDB ObjectId string
 * @param {object} opts - { title, startDateTime (Date or ISO string), endDateTime (Date or ISO string), description }
 * @returns {Promise<{ success: boolean, eventId?: string, provider?: 'google'|'outlook', error?: string }>}
 */
async function createCalendarEvent(schoolId, opts) {
    const { title, startDateTime, endDateTime, description, parentEmail } = opts;
    const start = startDateTime instanceof Date ? startDateTime : new Date(startDateTime);
    const end = endDateTime instanceof Date ? endDateTime : new Date(endDateTime);

    if (!title || !start || !end || isNaN(start.getTime()) || isNaN(end.getTime())) {
        console.error('[Calendar] INVALID PARAMS:', { title, start, end });
        return { success: false, error: 'Invalid title or date range' };
    }

    const School = require('../models/School');
    const school = await School.findById(schoolId).select('preferredCalendar').lean();
    const preference = school?.preferredCalendar || 'google';

    console.log(`[Calendar] ========================================`);
    console.log(`[Calendar] CREATE EVENT — schoolId=${schoolId}, preference=${preference}`);
    console.log(`[Calendar] Title: "${title}", Start: ${start.toISOString()}, End: ${end.toISOString()}`);
    console.log(`[Calendar] Parent email: ${parentEmail || 'N/A'}`);

    if (preference === 'none') {
        console.log('[Calendar] Calendar sync disabled for this school');
        return { success: true, message: 'Calendar sync disabled' };
    }

    // Convert schoolId to ObjectId if it's a string — normalize both forms for query
    const schoolObjectId = mongoose.Types.ObjectId.isValid(schoolId)
        ? (schoolId instanceof mongoose.Types.ObjectId ? schoolId : new mongoose.Types.ObjectId(schoolId))
        : schoolId;

    // DOUBLE QUERY: try both ObjectId and string forms to catch schema mismatches
    let integrations = await Integration.find({
        schoolId: schoolObjectId,
        connected: true,
        type: preference === 'both' ? { $in: ['google', 'outlook'] } : preference
    }).lean();

    // Fallback: try string form if ObjectId query returned nothing
    if (integrations.length === 0 && typeof schoolId === 'string') {
        console.log(`[Calendar] ObjectId query returned 0 results, trying string schoolId fallback...`);
        integrations = await Integration.find({
            schoolId: schoolId,
            connected: true,
            type: preference === 'both' ? { $in: ['google', 'outlook'] } : preference
        }).lean();
    }

    console.log(`[Calendar] Found ${integrations.length} connected integration(s) for preference=${preference}`);

    if (integrations.length > 0) {
        integrations.forEach((int, idx) => {
            const hasGoogleTokens = !!int.config?.tokens?.access_token;
            const hasOutlookTokens = !!int.config?.accessToken;
            const hasMsalCache = !!int.config?.msalCache;
            console.log(`[Calendar] Integration ${idx + 1}: type=${int.type}, connected=${int.connected}, hasGoogleTokens=${hasGoogleTokens}, hasOutlookTokens=${hasOutlookTokens}, hasMsalCache=${hasMsalCache}`);
        });
    }

    if (!integrations || integrations.length === 0) {
        // Fallback: if preferred provider isn't connected, use ANY connected integration
        const fallbackIntegrations = await Integration.find({
            schoolId: schoolObjectId,
            connected: true,
            type: { $in: ['google', 'outlook'] }
        }).lean();

        // Also try string schoolId
        let allFallback = fallbackIntegrations;
        if (allFallback.length === 0 && typeof schoolId === 'string') {
            allFallback = await Integration.find({
                schoolId: schoolId,
                connected: true,
                type: { $in: ['google', 'outlook'] }
            }).lean();
        }

        if (allFallback.length > 0) {
            console.warn(`[Calendar] ⚠️ Preferred provider (${preference}) not connected — falling back to: ${allFallback.map(i => i.type).join(', ')}`);
            integrations = allFallback;
        } else {
            const allIntegrations = await Integration.find({
                $or: [
                    { schoolId: schoolObjectId },
                    ...(typeof schoolId === 'string' ? [{ schoolId: schoolId }] : [])
                ]
            }).lean();
            console.error(`[Calendar] ❌ NO CONNECTED INTEGRATION for preference=${preference}`);
            console.error(`[Calendar] Total integrations for school: ${allIntegrations.length}`);
            if (allIntegrations.length > 0) {
                allIntegrations.forEach((int, idx) => {
                    console.error(`[Calendar]   ${idx + 1}: type=${int.type}, connected=${int.connected}`);
                });
            }
            return { success: false, error: `No connected calendar integration found. Connect one in Integrations settings.` };
        }
    }

    let overallSuccess = false;
    let mainProvider = null;
    let mainEventId = null;
    let errors = [];

    for (const integration of integrations) {
        let result;
        console.log(`[Calendar] Attempting ${integration.type} event creation...`);
        if (integration.type === 'google') {
            result = await createGoogleCalendarEvent(integration, { title, start, end, description, parentEmail });
        } else if (integration.type === 'outlook') {
            result = await createOutlookCalendarEvent(integration, { title, start, end, description, parentEmail });
        }

        if (result && result.success) {
            console.log(`[Calendar] ✅ ${integration.type} event created: ${result.eventId}`);
            overallSuccess = true;
            if (!mainEventId) {
                mainEventId = result.eventId;
                mainProvider = integration.type;
            }
        } else if (result && result.error) {
            console.error(`[Calendar] ❌ ${integration.type} FAILED: ${result.error}`);
            errors.push(`${integration.type}: ${result.error}`);
        }
    }

    if (overallSuccess) {
        const email = integrations.find(i => i.type === mainProvider)?.config?.userEmail ||
                      integrations.find(i => i.type === mainProvider)?.config?.account?.username;
        console.log(`[Calendar] ✅ SUCCESS — provider=${mainProvider}, eventId=${mainEventId}, email=${email}`);
        return { success: true, eventId: mainEventId, provider: mainProvider, email };
    } else {
        const errorMsg = errors.join(' | ') || 'Failed to create calendar event';
        console.error(`[Calendar] ❌ ALL PROVIDERS FAILED: ${errorMsg}`);
        return { success: false, error: errorMsg };
    }
}

async function createGoogleCalendarEvent(integration, { title, start, end, description, parentEmail }) {
    try {
        const oauth2Client = createGoogleOAuthClient();
        const tokens = integration.config?.tokens;
        if (!tokens || !tokens.access_token) {
            return { success: false, error: 'Google calendar not authorized. Reconnect in Integrations.' };
        }
        oauth2Client.setCredentials(tokens);

        // Listen for refreshed tokens
        oauth2Client.on('tokens', async (newTokens) => {
            console.log('[Calendar] Google tokens refreshed (during event creation) for school:', integration.schoolId);
            await Integration.updateOne(
                { _id: integration._id },
                { $set: { 'config.tokens': { ...tokens, ...newTokens } } }
            );
        });

        // Fetch school timezone and send local time (no Z) so school calendar shows same time as parent
        const School = require('../models/School');
        const { formatInTimezone } = require('../utils/timezone');
        const school = await School.findById(integration.schoolId).select('timezone').lean();
        const tz = 'America/Chicago'; // Forced Global CST

        const calendar = google.calendar({ version: 'v3', auth: oauth2Client });
        const event = {
            summary: title,
            description: description || '',
            start: { dateTime: formatInTimezone(start, tz), timeZone: tz },
            end: { dateTime: formatInTimezone(end, tz), timeZone: tz },
            attendees: parentEmail ? [{ email: parentEmail }] : [],
        };
        const insertOptions = {
            calendarId: 'primary',
            requestBody: event,
        };
        if (parentEmail) {
            insertOptions.sendUpdates = 'all'; // Send calendar invite email to attendees
        }
        const res = await calendar.events.insert(insertOptions);
        const eventId = res.data.id || '';
        const htmlLink = res.data.htmlLink || '';
        console.log('[Calendar] Google event created:', eventId, parentEmail ? `(invite sent to ${parentEmail})` : '');
        console.log('[Calendar] View event:', htmlLink);
        return { success: true, eventId, provider: 'google', email: tokens.email || integration.config?.userEmail, htmlLink };
    } catch (err) {
        console.error('[Calendar] Google creation error:', err.message);
        return { success: false, error: err.message || 'Failed to create Google Calendar event' };
    }
}

async function createOutlookCalendarEvent(integration, { title, start, end, description, parentEmail }) {
    try {
        console.log(`[Calendar:Outlook] Starting event creation...`);
        console.log(`[Calendar:Outlook] Integration schoolId=${integration.schoolId}, hasAccessToken=${!!integration.config?.accessToken}, hasMsalCache=${!!integration.config?.msalCache}`);

        const accessToken = await refreshOutlookToken(integration);
        if (!accessToken) {
            console.error(`[Calendar:Outlook] ❌ Token refresh returned null — token expired or revoked`);
            return { success: false, error: 'Outlook not authorized or token expired. Reconnect in Integrations.' };
        }

        console.log(`[Calendar:Outlook] Token obtained (length=${accessToken.length})`);

        // Fetch school timezone and send local time so school calendar shows same time as parent
        const School = require('../models/School');
        const { formatInTimezone } = require('../utils/timezone');
        const school = await School.findById(integration.schoolId).select('timezone').lean();
        const tz = 'America/Chicago'; // Forced Global CST

        const event = {
            subject: title,
            body: { contentType: 'text', content: description || '' },
            start: { dateTime: formatInTimezone(start, tz), timeZone: tz },
            end: { dateTime: formatInTimezone(end, tz), timeZone: tz },
            attendees: parentEmail ? [
                { emailAddress: { address: parentEmail }, type: 'required' }
            ] : []
        };

        console.log(`[Calendar:Outlook] POST https://graph.microsoft.com/v1.0/me/events`);
        console.log(`[Calendar:Outlook] Event: ${JSON.stringify({ subject: event.subject, start: event.start, end: event.end, attendees: event.attendees?.length || 0 })}`);

        const res = await axios.post(
            'https://graph.microsoft.com/v1.0/me/events',
            event,
            {
                headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
                validateStatus: null // Don't throw on non-2xx — we want the full error body
            }
        );

        if (res.status < 200 || res.status >= 300) {
            const errorDetail = res.data?.error;
            const errorMsg = errorDetail?.message || `HTTP ${res.status}`;
            const errorCode = errorDetail?.code || 'UNKNOWN';
            console.error(`[Calendar:Outlook] ❌ Graph API error ${res.status}:`, JSON.stringify(res.data, null, 2));

            // Classify error for better diagnostics
            if (res.status === 401 || res.status === 403) {
                console.error(`[Calendar:Outlook] Auth error — marking integration disconnected`);
                await Integration.updateOne(
                    { _id: integration._id },
                    { $set: { connected: false, 'config.lastError': errorMsg } }
                );
                return { success: false, error: `Outlook authorization failed (${errorCode}): ${errorMsg}. Reconnect in Integrations.` };
            }

            return { success: false, error: `Outlook API error (${errorCode}): ${errorMsg}` };
        }

        const eventId = res.data.id || '';
        const webLink = res.data.webLink || '';
        console.log(`[Calendar:Outlook] ✅ Event created: id=${eventId}, webLink=${webLink || 'N/A'}`);
        return { success: true, eventId, provider: 'outlook', email: integration.config?.account?.username, htmlLink: webLink };
    } catch (err) {
        const msg = err.response?.data?.error?.message || err.message;
        const code = err.response?.data?.error?.code || err.code || 'NETWORK_ERROR';
        console.error(`[Calendar:Outlook] ❌ Exception:`, {
            message: msg,
            code: code,
            status: err.response?.status,
            stack: err.stack?.split('\n').slice(0, 3).join('\n')
        });
        return { success: false, error: `Outlook: ${msg || 'Failed to create event'} (${code})` };
    }
}

/**
 * Helper to ensure Outlook token is valid, refreshing if needed using MSAL "acquireTokenSilent".
 * Updates the database token if a refresh occurs.
 * 
 * MAJOR FIX: Implement comprehensive token management to prevent disconnect loops
 */
async function refreshOutlookToken(integration) {
    if (!integration || integration.type !== 'outlook' || !integration.config) return null;

    let accessToken = integration.config.accessToken;
    const account = integration.config.account;
    const schoolId = integration.schoolId;

    if (!account) {
        console.warn(`[Calendar] No account found in Outlook integration for school ${schoolId}`);
        return accessToken;
    }

    const schoolPca = getMsalClient(schoolId) || pca;
    if (!schoolPca) {
        console.warn('[Calendar] MSAL not configured, returning existing token.');
        return accessToken;
    }

    try {
        // Step 1: Check if token is expired before attempting refresh
        const expiresOn = integration.config.expiresOn ? new Date(integration.config.expiresOn) : null;
        const now = new Date();
        const bufferMinutes = 5; // 5-minute buffer before expiry
        
        if (expiresOn && (expiresOn.getTime() - bufferMinutes * 60 * 1000) > now.getTime()) {
            console.log(`[Calendar] Outlook token still valid for school ${schoolId}, expires: ${expiresOn.toISOString()}`);
            return accessToken;
        }

        console.log(`[Calendar] Outlook token expired or expiring soon for school ${schoolId}, attempting refresh...`);

        // Step 2: Load accounts from MSAL's own cache with proper error handling
        const tokenCache = schoolPca.getTokenCache();
        let allAccounts = [];
        
        try {
            allAccounts = await tokenCache.getAllAccounts();
        } catch (cacheErr) {
            console.error(`[Calendar] Failed to load MSAL accounts for school ${schoolId}:`, cacheErr.message);
            // Try to clear cache and reload
            try {
                await tokenCache.clear();
                allAccounts = await tokenCache.getAllAccounts();
                console.log(`[Calendar] Cleared and reloaded MSAL cache for school ${schoolId}`);
            } catch (clearErr) {
                console.error(`[Calendar] Failed to clear MSAL cache for school ${schoolId}:`, clearErr.message);
            }
        }

        if (allAccounts.length === 0) {
            console.warn(`[Calendar] No accounts found in MSAL cache for school ${schoolId}. This usually means config.msalCache is missing or invalid.`);
            // Mark as disconnected - requires manual re-auth
            await Integration.updateOne(
                { _id: integration._id },
                { $set: { connected: false } }
            );
            return null;
        }

        // Step 3: Find matching account with multiple fallback strategies
        let cachedAccount = allAccounts.find(a => a.username === account?.username);
        if (!cachedAccount && allAccounts.length > 0) {
            console.warn(`[Calendar] Account username mismatch, using first available account. Expected: ${account?.username}, Available: ${allAccounts.map(a => a.username).join(', ')}`);
            cachedAccount = allAccounts[0];
        }

        // Step 4: Attempt silent token acquisition with comprehensive error handling
        const silentRequest = {
            account: cachedAccount,
            scopes: ['user.read', 'calendars.readwrite', 'mail.send', 'offline_access'],
            forceRefresh: true, // Force refresh to get fresh token
        };

        let response;
        try {
            response = await schoolPca.acquireTokenSilent(silentRequest);
        } catch (acquireErr) {
            console.error(`[Calendar] First acquireTokenSilent attempt failed for school ${schoolId}:`, {
                name: acquireErr.name,
                code: acquireErr.code,
                message: acquireErr.message
            });

            // Try again without forceRefresh
            try {
                delete silentRequest.forceRefresh;
                response = await schoolPca.acquireTokenSilent(silentRequest);
                console.log(`[Calendar] Second acquireTokenSilent attempt succeeded for school ${schoolId}`);
            } catch (secondErr) {
                console.error(`[Calendar] Second acquireTokenSilent attempt failed for school ${schoolId}:`, secondErr.message);
                throw secondErr;
            }
        }

        // Step 5: Validate response and update database
        if (!response || !response.accessToken) {
            throw new Error('No access token received from MSAL');
        }

        // Step 6: Update database with new token and account info
        const updateData = {
            'config.accessToken': response.accessToken,
            'config.account': response.account || cachedAccount,
            'config.expiresOn': response.expiresOn,
            'config.lastRefresh': new Date(),
        };

        await Integration.updateOne(
            { _id: integration._id },
            { $set: updateData }
        );

        console.log(`[Calendar] Outlook tokens successfully refreshed and persisted for school: ${schoolId}`);
        console.log(`[Calendar] New token expires: ${response.expiresOn ? new Date(response.expiresOn).toISOString() : 'Unknown'}`);

        // Step 7: Verify the cache plugin will persist the updated msalCache
        // The afterCacheAccess plugin should handle this automatically if cacheHasChanged is true

        return response.accessToken;

    } catch (error) {
        // Comprehensive error classification and handling
        const errorMessage = error.message || error.toString();
        const errorCode = error.name || error.code;
        
        console.error(`[Calendar] MSAL token refresh error for school ${schoolId}:`, {
            name: error.name,
            code: error.code,
            message: error.message,
            stack: error.stack
        });
        
        // Classify error types for proper handling
        const isTokenRevoked = 
            errorMessage?.includes('invalid_grant') ||
            errorMessage?.includes('invalid_token') ||
            errorMessage?.includes('unauthorized_client') ||
            errorCode === 'InvalidGrantError' ||
            errorCode === 'InvalidClientError';

        const isInteractionRequired = 
            errorCode === 'InteractionRequiredAuthError' ||
            errorMessage?.includes('interaction_required') ||
            errorMessage?.includes('consent_required');

        const isAccountNotFound = 
            errorMessage?.includes('no_tokens_found') ||
            errorMessage?.includes('account_not_found');

        if (isTokenRevoked) {
            console.warn(`[Calendar] Outlook token revoked for school ${schoolId}. Marking disconnected - requires manual re-auth.`);
            await Integration.updateOne(
                { _id: integration._id },
                { $set: { connected: false, 'config.lastError': errorMessage } }
            );
            return null;
        }

        if (isInteractionRequired || isAccountNotFound) {
            console.warn(`[Calendar] Outlook requires re-authentication for school ${schoolId}. Marking disconnected.`);
            await Integration.updateOne(
                { _id: integration._id },
                { $set: { connected: false, 'config.lastError': errorMessage } }
            );
            return null;
        }

        // For network or transient errors, return existing token optimistically
        console.warn(`[Calendar] MSAL transient error for school ${schoolId}: ${errorMessage}. Returning existing token optimistically.`);
        return accessToken;
    }

    // Final fallback - return existing token if all else fails
    return accessToken;
}


module.exports = { createCalendarEvent, getBusySlots, getFreeSlots, isSlotAvailable, getBusinessHoursRange, refreshOutlookToken };
