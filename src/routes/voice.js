const express = require('express');
const mongoose = require('mongoose');
const CallLog = require('../models/CallLog');
const School = require('../models/School');
const TourBooking = require('../models/TourBooking');
const { triggerAutomation } = require('../services/automation');
const { createCalendarEvent, getFreeSlots, isSlotAvailable, getBusySlots, getBusinessHoursRange } = require('../services/calendarService');
const { sendEmail } = require('../services/mailService');

const router = express.Router();

// Normalize phone for lookup (digits only, optional + prefix)
function normalizePhone(s) {
    if (!s || typeof s !== 'string') return '';
    const digits = s.replace(/\D/g, '');
    return digits ? `+${digits}` : '';
}

/**
 * AGENT INTEGRATION
 * Your AI voice agent (Vapi, Bland, Retell, or custom) should:
 *
 * 1. When a call starts: GET /api/voice/agent-config?to=+15551234567
 *    (use the "To" number). Response: schoolId, script, businessHours, formLink, etc.
 *
 * 2. During the call: Use script to answer; collect parentName, phone, email, childAge, reason.
 *    If they want a tour, collect preferred date/time and send it in call-end as leadData.tourScheduledAt (ISO).
 *
 * 3. When call ends: POST /api/voice/call-end with body:
 *    { schoolId, callerName, callerPhone, callType: 'inquiry'|'general', duration, recordingUrl?, leadData?: { parentName, phone, email, childAge, reason, tourScheduledAt? } }
 *    We will: create call log, send SMS/email with form link, and if tourScheduledAt present, book tour in Google/Outlook.
 */

// GET /api/voice/agent-config - No auth. Agent calls with the number that was dialed ("To").
// Query: to=+15551234567  OR  schoolId=507f1f77bcf86cd799439011
// Provider-aware: returns different config for ElevenLabs vs VAPI
router.get('/agent-config', async (req, res) => {
    try {
        const { to, schoolId: schoolIdParam } = req.query;
        let school = null;

        if (schoolIdParam && mongoose.Types.ObjectId.isValid(schoolIdParam)) {
            school = await School.findById(schoolIdParam)
                .select('name script businessHoursStart businessHoursEnd language routingNumber escalationNumber aiNumber voiceProvider vapiAssistantId elevenlabsAgentId qaPairs systemPrompt')
                .lean();
        }
        if (!school && to) {
            const normalizedTo = normalizePhone(to);
            if (normalizedTo) {
                const all = await School.find({})
                    .select('name script businessHoursStart businessHoursEnd language routingNumber escalationNumber aiNumber voiceProvider vapiAssistantId elevenlabsAgentId qaPairs systemPrompt')
                    .lean();
                school = all.find(s => normalizePhone(s.aiNumber) === normalizedTo) || null;
            }
        }

        if (!school) {
            return res.status(404).json({ error: 'School not found for this number. Set aiNumber in Settings.' });
        }

        const formLink = process.env.FORM_BASE_URL
            ? `${process.env.FORM_BASE_URL}/inquiry/${school._id}`
            : `https://nestops.com/inquiry/${school._id}`;

        const provider = school.voiceProvider || 'elevenlabs';

        const baseResponse = {
            schoolId: school._id.toString(),
            schoolName: school.name,
            script: school.script || "Hi, thanks for calling our school, this is Nora, a virtual assistant.\nYou can speak in English or Spanish — si prefiere, puede hablar en español. ¿Le puedo ayudar en algo? How can I help you today?",
            businessHoursStart: school.businessHoursStart || '09:00',
            businessHoursEnd: school.businessHoursEnd || '17:00',
            formLink,
            language: school.language || 'EN',
            routingNumber: school.routingNumber || '',
            escalationNumber: school.escalationNumber || '',
            voiceProvider: provider,
        };

        // Add provider-specific fields
        if (provider === 'vapi') {
            baseResponse.vapiAssistantId = school.vapiAssistantId || '';
            baseResponse.systemPrompt = school.systemPrompt || '';
            baseResponse.qaPairs = (school.qaPairs || []).map(p => ({
                question: p.question || '',
                answer: p.answer || ''
            }));
        } else {
            baseResponse.elevenlabsAgentId = school.elevenlabsAgentId || '';
        }

        res.json(baseResponse);
    } catch (err) {
        console.error('Agent config error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// GET /api/voice/availability - No auth. Agent calls to get free 30-min slots for a day (respects blocked times, no overlaps).
// Query: schoolId=xxx&date=YYYY-MM-DD
router.all('/availability', async (req, res) => {
    const startTime = Date.now();
    // VAPI tools may send params as query string OR request body for GET
    const schoolId = req.query.schoolId || (req.body && req.body.schoolId) || '';
    const date = req.query.date || (req.body && req.body.date) || '';

    console.log('══════════════════════════════════════════════════════');
    console.log('[Availability] GET /api/voice/availability');
    console.log('[Availability] Timestamp:', new Date().toISOString());
    console.log('[Availability] Query params:', JSON.stringify(req.query));
    console.log('[Availability] Body:', JSON.stringify(req.body || {}).slice(0, 500));
    console.log('[Availability] schoolId:', schoolId || 'MISSING');
    console.log('[Availability] date:', date || 'MISSING');
    console.log('[Availability] Headers:', JSON.stringify({ host: req.get('host'), origin: req.get('origin'), referer: req.get('referer'), 'user-agent': req.get('user-agent') }));

    try {
        if (!schoolId || !date) {
            console.log('[Availability] ❌ Missing params — schoolId=' + !!schoolId + ' date=' + !!date);
            console.log('[Availability] Query:', JSON.stringify(req.query));
            console.log('[Availability] Body:', JSON.stringify(req.body || {}));
            console.log(`[Availability] Completed in ${Date.now() - startTime}ms`);
            console.log('══════════════════════════════════════════════════════');
            return res.status(400).json({ error: 'schoolId and date (YYYY-MM-DD) are required' });
        }

        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
            console.log('[Availability] ❌ Invalid date format:', date);
            return res.status(400).json({ error: 'Invalid date format. Use YYYY-MM-DD' });
        }

        if (!mongoose.Types.ObjectId.isValid(schoolId)) {
            console.log(`[Availability] ❌ Invalid schoolId format: "${schoolId}"`);
            return res.status(400).json({ error: `Invalid schoolId: "${schoolId}". Expected a valid MongoDB ObjectId.` });
        }

        const school = await School.findById(schoolId).select('name businessHoursStart businessHoursEnd timezone').lean();
        if (!school) {
            console.log('[Availability] ❌ School not found:', schoolId);
            return res.status(404).json({ error: 'School not found' });
        }

        console.log('[Availability] School:', school.name);
        console.log('[Availability] Business hours:', school.businessHoursStart || '09:00', '-', school.businessHoursEnd || '17:00');
        console.log('[Availability] Timezone:', school.timezone || 'America/Chicago');

        const { freeSlots, error } = await getFreeSlots(schoolId, date, {
            start: school.businessHoursStart || '09:00',
            end: school.businessHoursEnd || '17:00',
        });

        if (error) {
            console.log('[Availability] ❌ getFreeSlots error:', error);
            console.log(`[Availability] Completed in ${Date.now() - startTime}ms`);
            console.log('══════════════════════════════════════════════════════');
            return res.status(400).json({ error });
        }

        console.log('[Availability] Raw free slots from getFreeSlots:', freeSlots.length);
        freeSlots.forEach((s, i) => {
            console.log(`[Availability]   Raw #${i + 1}: ${s.start} → ${s.end}`);
        });

        // Format slots in the school's timezone
        const tz = school.timezone || 'America/Chicago';
        const { formatInTimezone } = require('../utils/timezone');

        const formattedSlots = freeSlots.map(s => ({
            start: formatInTimezone(new Date(s.start), tz),
            end: formatInTimezone(new Date(s.end), tz),
            startUtc: s.start,
            endUtc: s.end,
        }));

        console.log('[Availability] ✅ Free slots found:', formattedSlots.length, `(timezone: ${tz})`);
        formattedSlots.forEach((s, i) => {
            console.log(`[Availability]   Slot ${i + 1}: ${s.start} → ${s.end} (${tz})`);
        });

        console.log(`[Availability] Completed in ${Date.now() - startTime}ms`);
        console.log('══════════════════════════════════════════════════════');
        res.json({ date, timezone: tz, freeSlots: formattedSlots });

    } catch (err) {
        console.error('[Availability] ❌ Exception after', Date.now() - startTime, 'ms:', err.message);
        console.error('[Availability] Stack:', err.stack?.split('\n').slice(0, 4).join('\n'));
        console.log('══════════════════════════════════════════════════════');
        res.status(500).json({ error: 'Internal server error' });
    }
});

// GET /api/voice/booked-slots - No auth. Returns both available and booked slots for a specific date.
// Query: schoolId=xxx&date=YYYY-MM-DD (date is required)
router.get('/booked-slots', async (req, res) => {
    try {
        const { schoolId, date } = req.query;
        
        if (!schoolId) {
            return res.status(400).json({ error: 'schoolId is required' });
        }
        
        if (!date) {
            return res.status(400).json({ error: 'date parameter is required (format: YYYY-MM-DD)' });
        }

        // Validate date format
        const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
        if (!dateRegex.test(date)) {
            return res.status(400).json({ error: 'Invalid date format. Use YYYY-MM-DD' });
        }

        // Get school with business hours
        const school = await School.findById(schoolId).select('businessHoursStart businessHoursEnd').lean();
        if (!school) {
            return res.status(404).json({ error: 'School not found' });
        }

        // Calculate date range for the day
        // Get business-specific UTC range for the date
        const { rangeStart, rangeEnd, error: rangeError } = await getBusinessHoursRange(schoolId, date);
        if (rangeError) {
            return res.status(400).json({ error: rangeError });
        }
        console.log(`[booked-slots] rangeStart: ${rangeStart.toISOString()}, rangeEnd: ${rangeEnd.toISOString()}`);
        console.log(`[booked-slots] rangeStart: ${rangeStart.toISOString()}, rangeEnd: ${rangeEnd.toISOString()}`);

        const businessHours = {
            start: school.businessHoursStart || '09:00',
            end: school.businessHoursEnd || '17:00'
        };

        // Get available slots using the same range logic
        const { freeSlots, error: freeSlotsError } = await getFreeSlots(schoolId, date, businessHours);
        if (freeSlotsError) {
            return res.status(400).json({ error: freeSlotsError });
        }

        // Get booked slots for the SAME window (eliminates irrelevant bookings)
        const { busySlots, error: busySlotsError } = await getBusySlots(schoolId, rangeStart, rangeEnd);
        if (busySlotsError) {
            return res.status(400).json({ error: busySlotsError });
        }

        // Format booked slots
        const bookedSlots = busySlots.map(s => ({
            start: s.start.toISOString(),
            end: s.end.toISOString()
        }));

        res.json({
            schoolId,
            date,
            businessHours,
            availableSlots: freeSlots,
            bookedSlots: bookedSlots
        });
    } catch (err) {
        console.error('Booked slots error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});


// POST /api/voice/call-end - Called by AI agent when call completes
router.post('/call-end', async (req, res) => {
    try {
        const { schoolId, callerName, callerPhone, callType, duration, recordingUrl, leadData, summary } = req.body;

        if (!schoolId) {
            return res.status(400).json({ error: 'schoolId is required' });
        }

        const school = await School.findById(schoolId).select('name adminEmail emailAutoFollowup emailTemplate').lean();
        if (!school) {
            return res.status(404).json({ error: 'School not found' });
        }

        const callLog = await CallLog.create({
            schoolId,
            callerName: callerName || 'Unknown',
            callerPhone: callerPhone || '',
            callType: callType || 'inquiry',
            duration: duration || 0,
            recordingUrl: recordingUrl || '',
        });

        const parentName = leadData?.parentName || callerName;
        const phone = leadData?.phone || callerPhone;
        const email = leadData?.email;
        const childAge = leadData?.childAge;
        const childName = leadData?.childName;
        const reason = leadData?.reason;
        const tourScheduledAt = leadData?.tourScheduledAt; // ISO date string if parent booked a tour

        if (callType === 'inquiry' && leadData) {
            await triggerAutomation(schoolId, {
                parentName,
                phone,
                email,
                childAge,
                reason,
            });
        }

        let tourBooking = null;
        let tourError = null;
        if (tourScheduledAt) {
            const start = new Date(tourScheduledAt);
            if (!isNaN(start.getTime())) {
                // Validate that the booking date is not in the past
                const now = new Date();
                if (start < now) {
                    tourError = 'Cannot book a tour for a past date. Please select a future date and time.';
                } else {
                    const end = new Date(start.getTime() + 30 * 60 * 1000); // 30-min block
                    const { available, error: slotError } = await isSlotAvailable(schoolId, start, end);
                    if (!available) {
                        tourError = slotError || 'That time is no longer available or overlaps an existing event.';
                    } else {
                        const title = `School Tour – ${parentName || 'Parent'}`;
                        const calResult = await createCalendarEvent(schoolId, {
                            title,
                            startDateTime: start,
                            endDateTime: end,
                            description: `Tour for ${parentName || 'Parent'}. Phone: ${phone || 'N/A'}. Email: ${email || 'N/A'}. Reason: ${reason || 'Inquiry'}.`,
                            parentEmail: email || null,
                            parentPhone: phone || undefined,
                        });
                        tourBooking = await TourBooking.create({
                            schoolId,
                            parentName,
                            phone: phone || '',
                            email: email || '',
                            childName: childName || '',
                            childAge: childAge || '',
                            reason: reason || '',
                            scheduledAt: start,
                            calendarEventId: calResult.success ? calResult.eventId : '',
                            calendarProvider: calResult.success ? calResult.provider : '',
                            calendarEmail: calResult.success ? calResult.email : '',
                            callLogId: callLog._id,
                        });
                    }
                }
            } else {
                // Past date validation failed - tourError already set above
            }
        }

        // Send Admin Summary Email
        if (school && school.adminEmail) {
            const summaryTitle = tourBooking ? `🎉 Tour Booked: ${parentName || 'New Parent'}` : `📞 New Call Summary: ${parentName || 'Parent'}`;
            const summaryBody = `
                <div style="font-family: sans-serif; line-height: 1.6; color: #333; max-width: 600px; border: 1px solid #eee; padding: 20px; border-radius: 12px;">
                    <h2 style="color: #2563eb; margin-top: 0;">Call Processed Successfully</h2>
                    <p><strong>Caller:</strong> ${parentName || 'Parent'} (${phone || 'N/A'})</p>
                    <p><strong>Contact Info:</strong> ${email || 'N/A'}</p>
                    <p><strong>AI Summary:</strong></p>
                    <blockquote style="background: #f8fafc; border-left: 4px solid #3b82f6; padding: 12px; margin: 0; font-style: italic;">
                        "${summary || 'No summary available.'}"
                    </blockquote>
                    ${tourBooking ? `
                        <div style="margin-top: 20px; padding: 15px; background: #ecfdf5; border: 1px solid #10b981; border-radius: 8px;">
                            <p style="color: #047857; font-weight: bold; margin: 0;">✅ Tour scheduled for: ${new Date(tourScheduledAt).toLocaleString()}</p>
                        </div>
                    ` : '<p style="margin-top: 20px; color: #64748b;">No tour was scheduled during this call.</p>'}
                    <hr style="margin: 20px 0; border: 0; border-top: 1px solid #eee;">
                    <p style="font-size: 12px; color: #94a3b8;">This is an automated notification from your Nest Ops Assistant at ${school.name || 'our school'}.</p>
                </div>
            `;
            
            sendEmail(schoolId, {
                to: school.adminEmail,
                subject: summaryTitle,
                text: `New call from ${parentName || 'Parent'}. Summary: ${summary || 'None'}`,
                html: summaryBody
            }).catch(err => console.error('[Admin Notification] Failed to send email:', err.message));
        }

        res.json({
            success: true,
            callLogId: callLog._id,
            recordingUrl: callLog.recordingUrl || undefined,
            tourBooked: !!tourBooking,
            tourBookingId: tourBooking?._id?.toString(),
            tourError: tourError || undefined,
            message: tourBooking ? 'Tour booked and invite sent' : 'Call summary processed'
        });
    } catch (err) {
        console.error('Voice call-end error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// POST /api/voice/vapi-book — VAPI tool endpoint for booking appointments
// Called by VAPI assistant when parent confirms all details.
router.post('/vapi-book', async (req, res) => {
    try {
        const {
            date, time, parent_name, parent_phone, parent_email,
            child_name, child_age, reason, schoolId
        } = req.body;

        // Accept schoolId from body OR query param (VAPI tools can append to URL)
        const effectiveSchoolId = schoolId || req.query.schoolId;

        if (!effectiveSchoolId) {
            return res.status(400).json({ error: 'schoolId is required' });
        }

        if (!date || !time || !parent_name) {
            return res.status(400).json({
                success: false,
                error: 'Missing required fields. Need date, time, and parent_name.'
            });
        }

        // Parse local datetime
        const localDateTime = new Date(`${date}T${time}:00`);
        const { parseLocalDateTimeToUTC } = require('../utils/timezone');
        const start = parseLocalDateTimeToUTC(
            localDateTime.toISOString(), 'America/Chicago'
        ) || localDateTime;

        if (isNaN(start.getTime())) {
            return res.status(400).json({
                success: false,
                error: 'Invalid date or time format. Use YYYY-MM-DD for date and HH:MM for time.'
            });
        }

        const end = new Date(start.getTime() + 30 * 60 * 1000);

        // Check availability
        const { available, error: slotError } = await isSlotAvailable(effectiveSchoolId, start, end);
        if (!available) {
            return res.status(409).json({
                success: false,
                error: slotError || 'That time slot is no longer available.'
            });
        }

        // Create calendar event
        const title = `School Tour – ${parent_name}`;
        const description = [
            `Tour for ${parent_name}`,
            `Phone: ${parent_phone || 'N/A'}`,
            `Email: ${parent_email || 'N/A'}`,
            `Child: ${child_name || 'N/A'} (${child_age || 'N/A'})`,
            `Reason: ${reason || 'Inquiry'}`
        ].join('. ');

        const calResult = await createCalendarEvent(effectiveSchoolId, {
            title,
            startDateTime: start,
            endDateTime: end,
            description,
            parentEmail: parent_email || undefined,
            parentPhone: parent_phone || undefined,
        });

        // Create tour booking record
        const tourBooking = await TourBooking.create({
            schoolId: effectiveSchoolId,
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

        // Trigger automation (follow-up emails)
        if (parent_email || parent_phone) {
            triggerAutomation(effectiveSchoolId, {
                parentName: parent_name,
                phone: parent_phone,
                email: parent_email,
                childAge: child_age,
                reason: reason,
            }).catch(err => console.error('[vapi-book] Automation error:', err));
        }

        // Send confirmation
        if (parent_email) {
            const { sendTourConfirmation } = require('../services/automation');
            sendTourConfirmation(effectiveSchoolId, tourBooking).catch(err =>
                console.error('[vapi-book] Confirmation error:', err)
            );
        }

        console.log(`[vapi-book] Tour booked: ${parent_name} on ${date} at ${time} via VAPI`);
        res.status(200).json({
            success: true,
            message: `Tour booked for ${parent_name} on ${date} at ${time}. A confirmation will be sent to ${parent_email || 'the phone number provided'}.`,
            booking_id: tourBooking._id.toString(),
            calendar_provider: calResult.provider || 'none',
            calendar_event_created: calResult.success,
        });

    } catch (err) {
        console.error('[vapi-book] Error:', err);
        res.status(500).json({
            success: false,
            error: 'Unable to complete booking. Please try again.'
        });
    }
});

// ────────────────────────────────────────────────────────────────────────────
// POST /api/voice/book-meeting — AI Agent Tool Endpoint
// ────────────────────────────────────────────────────────────────────────────
// Books a meeting/tour on the school's Google AND/OR Outlook calendar.
// Designed as a tool endpoint for ElevenLabs & VAPI voice agents.
//
// Body:
//   schoolId       (required) — MongoDB school ID
//   title          (required) — Meeting title, e.g. "School Tour – Jane Doe"
//   invitees       (optional) — Array of email strings to send calendar invites to
//   startDate      (required) — "YYYY-MM-DD"
//   startTime      (required) — "HH:MM" (24-hour)
//   timezone       (optional) — IANA timezone, defaults to "America/Chicago"
//   durationMinutes(optional) — Default 30
//   description    (optional) — Meeting body / notes
//   parentName     (optional) — For TourBooking record
//   parentPhone    (optional) — For TourBooking record
//   childName      (optional) — For TourBooking record
//   childAge       (optional) — For TourBooking record
//
// Response:
//   { success, message, providers[], eventIds{}, startTime, endTime, bookingId }
// ────────────────────────────────────────────────────────────────────────────
router.post('/book-meeting', async (req, res) => {
    const reqStartTime = Date.now();

    const {
        schoolId: bodySchoolId,
        title,
        invitees,
        startDate,
        startTime,
        timezone,
        durationMinutes,
        description,
        parentName,
        parentPhone,
        parentEmail,
        childName,
        childAge,
    } = req.body;
    // URL query param (injected by VAPI template) wins over body to prevent AI hallucinations
    const schoolId = req.query.schoolId || bodySchoolId;

    console.log('══════════════════════════════════════════════════════');
    console.log('[BookMeeting] POST /api/voice/book-meeting');
    console.log('[BookMeeting] Timestamp:', new Date().toISOString());
    console.log('[BookMeeting] Query schoolId:', req.query.schoolId || 'none');
    console.log('[BookMeeting] Body schoolId:', bodySchoolId || 'none');
    console.log('[BookMeeting] Effective schoolId:', schoolId || 'MISSING');
    console.log('[BookMeeting] Body:', JSON.stringify({
        title, invitees, startDate, startTime, timezone, durationMinutes,
        parentName, parentPhone, parentEmail, childName, childAge,
        description: description ? description.slice(0, 100) + '...' : 'N/A'
    }));
    console.log('[BookMeeting] Headers:', JSON.stringify({ host: req.get('host'), origin: req.get('origin'), 'user-agent': req.get('user-agent') }));

    try {
        // ── Validate required fields ──────────────────────────────────
        if (!schoolId) {
            console.log('[BookMeeting] ❌ Missing schoolId');
            return res.status(400).json({ success: false, error: 'schoolId is required.' });
        }
        if (!mongoose.Types.ObjectId.isValid(schoolId)) {
            console.log(`[BookMeeting] ❌ Invalid schoolId format: "${schoolId}"`);
            return res.status(400).json({ success: false, error: `Invalid schoolId: "${schoolId}". Expected a valid MongoDB ObjectId.` });
        }
        if (!title) {
            console.log('[BookMeeting] ❌ Missing title');
            return res.status(400).json({ success: false, error: 'title is required. Provide a meeting title.' });
        }
        if (!startDate || !startTime) {
            console.log('[BookMeeting] ❌ Missing startDate or startTime');
            return res.status(400).json({
                success: false,
                error: 'startDate (YYYY-MM-DD) and startTime (HH:MM) are required.'
            });
        }

        // Validate date format
        if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate)) {
            return res.status(400).json({ success: false, error: 'startDate must be YYYY-MM-DD format.' });
        }
        if (!/^\d{2}:\d{2}$/.test(startTime)) {
            return res.status(400).json({ success: false, error: 'startTime must be HH:MM format (24-hour).' });
        }

        // ── Resolve school ────────────────────────────────────────────
        const school = await School.findById(schoolId).select(
            'name preferredCalendar address timezone'
        ).lean();

        if (!school) {
            return res.status(404).json({ success: false, error: `School not found for ID: ${schoolId}` });
        }

        const tz = timezone || 'America/Chicago';
        const duration = Math.min(Math.max(parseInt(durationMinutes, 10) || 30, 15), 120); // 15–120 min

        // ── Parse start datetime in the given timezone ─────────────────
        const { parseLocalDateTimeToUTC, formatInTimezone } = require('../utils/timezone');
        const localDateTimeStr = `${startDate}T${startTime}:00`;
        const localDate = new Date(localDateTimeStr);

        if (isNaN(localDate.getTime())) {
            return res.status(400).json({ success: false, error: 'Invalid date/time values.' });
        }

        const startUtc = parseLocalDateTimeToUTC(localDate.toISOString(), tz) || localDate;
        const endUtc = new Date(startUtc.getTime() + duration * 60 * 1000);

        console.log(`[book-meeting] schoolId=${schoolId} title="${title}"`);
        console.log(`[book-meeting] local=${startDate} ${startTime} ${tz} → UTC start=${startUtc.toISOString()} end=${endUtc.toISOString()}`);
        console.log(`[book-meeting] parentEmail=${parentEmail || 'none'} invitees=${(invitees || []).join(', ') || 'none'}`);

        // ── Check for time conflicts ──────────────────────────────────
        console.log('[BookMeeting] Checking slot availability...');
        const { available, error: slotError } = await isSlotAvailable(schoolId, startUtc, endUtc);
        console.log('[BookMeeting] Slot check:', { available, conflictError: slotError || 'none' });
        if (!available) {
            console.log('[BookMeeting] ❌ Slot conflicted:', slotError);
            return res.status(409).json({
                success: false,
                error: slotError || 'This time slot conflicts with an existing booking.',
                conflicting: true
            });
        }
        console.log('[BookMeeting] ✅ Slot is free');

        // ── Create calendar event(s) ──────────────────────────────────
        const inviteesList = Array.isArray(invitees) ? invitees : (invitees ? [invitees] : []);
        const primaryInvitee = inviteesList[0] || null;

        // Determine parent email: VAPI parentEmail param wins over invitees list
        const effectiveParentEmail = parentEmail || primaryInvitee || null;

        const fullDescription = description ||
            `${title}\n` +
            (parentName ? `Parent: ${parentName}\n` : '') +
            (parentPhone ? `Phone: ${parentPhone}\n` : '') +
            (effectiveParentEmail ? `Email: ${effectiveParentEmail}\n` : '') +
            (childName ? `Child: ${childName} (${childAge || 'N/A'})\n` : '') +
            `School: ${school.name}`;

        // Build calendar event options
        const calOpts = {
            title,
            startDateTime: startUtc,
            endDateTime: endUtc,
            description: fullDescription,
            parentEmail: effectiveParentEmail || undefined,
            parentPhone: parentPhone || undefined,
        };

        // Fetch preferred calendar and connected integrations
        const Integration = require('../models/Integration');
        const preference = school.preferredCalendar || 'both';
        const integrations = await Integration.find({
            schoolId,
            connected: true,
            type: { $in: ['google', 'outlook'] }
        }).lean();

        console.log(`[book-meeting] School preference: ${preference}, connected integrations: ${integrations.map(i => i.type).join(', ') || 'none'}`);

        // Use the unified createCalendarEvent which handles all providers
        const calResult = await createCalendarEvent(schoolId, calOpts);

        console.log(`[book-meeting] Calendar result:`, JSON.stringify(calResult));

        // ── Create TourBooking record ──────────────────────────────────
        const tourBooking = await TourBooking.create({
            schoolId,
            parentName: parentName || 'Guest',
            phone: parentPhone || '',
            email: effectiveParentEmail || '',
            childName: childName || '',
            childAge: childAge || '',
            reason: 'AI Agent booking',
            scheduledAt: startUtc,
            calendarEventId: calResult.success ? calResult.eventId : '',
            calendarProvider: calResult.success ? calResult.provider : '',
            calendarEmail: calResult.success ? calResult.email : '',
        });

        console.log(`[book-meeting] TourBooking created: ${tourBooking._id}`);

        // ── Send calendar invites to additional invitees ───────────────
        if (calResult.success && inviteesList.length > 0) {
            const { sendEmail } = require('../services/mailService');
            const { generateICS } = require('../utils/ics');

            for (const invitee of inviteesList) {
                if (!invitee || invitee === effectiveParentEmail) continue; // primary already invited via calendar API

                try {
                    const icsContent = generateICS({
                        title,
                        start: startUtc,
                        end: endUtc,
                        description: fullDescription,
                        location: school.address || '',
                    });

                    await sendEmail(schoolId, {
                        to: invitee,
                        subject: `Calendar Invite: ${title}`,
                        text: `You've been invited to: ${title}\n\n` +
                            `Date: ${startDate} at ${startTime} (${tz})\n` +
                            `Location: ${school.address || school.name}\n\n` +
                            `${fullDescription}`,
                        attachments: [{ filename: 'invite.ics', content: icsContent }],
                    });

                    console.log(`[book-meeting] ICS invite sent to ${invitee}`);
                } catch (inviteErr) {
                    console.error(`[book-meeting] Failed to send invite to ${invitee}:`, inviteErr.message);
                }
            }
        }

        // ── Send confirmation email to primary invitee ─────────────────
        if (primaryInvitee && calResult.success) {
            const { sendTourConfirmation } = require('../services/automation');
            sendTourConfirmation(schoolId, tourBooking).catch(err =>
                console.error('[book-meeting] Confirmation error:', err.message)
            );
        }

        // ── Build response ────────────────────────────────────────────
        const startFormatted = formatInTimezone
            ? formatInTimezone(startUtc, tz)
            : startUtc.toISOString();
        const endFormatted = formatInTimezone
            ? formatInTimezone(endUtc, tz)
            : endUtc.toISOString();

        console.log('[BookMeeting] ✅ Response:', JSON.stringify({
            success: calResult.success,
            provider: calResult.provider,
            eventId: calResult.eventId,
            bookingId: tourBooking._id.toString(),
            startUtc: startUtc.toISOString(),
            local: `${startDate} ${startTime} ${tz}`,
        }));
        console.log(`[BookMeeting] Completed in ${Date.now() - reqStartTime}ms`);
        console.log('══════════════════════════════════════════════════════');

        res.status(200).json({
            success: calResult.success,
            message: calResult.success
                ? `Meeting "${title}" booked successfully on ${calResult.provider} calendar.`
                : `Calendar booking failed: ${calResult.error}`,
            providers: calResult.success ? [calResult.provider] : [],
            eventIds: calResult.success ? { [calResult.provider]: calResult.eventId } : {},
            startTime: startUtc.toISOString(),
            endTime: endUtc.toISOString(),
            startTimeLocal: startFormatted,
            endTimeLocal: endFormatted,
            timezone: tz,
            bookingId: tourBooking._id.toString(),
            inviteesNotified: inviteesList,
        });

    } catch (err) {
        console.error('[BookMeeting] ❌ Exception after', Date.now() - reqStartTime, 'ms:', err.message);
        console.error('[BookMeeting] Stack:', err.stack?.split('\n').slice(0, 5).join('\n'));
        console.log('══════════════════════════════════════════════════════');
        res.status(500).json({
            success: false,
            error: 'Internal server error while booking the meeting. Please try again.'
        });
    }
});

// ── Nora Tool: Get Current Date/Time in CST ──────────────────────────────
// POST /api/voice/current-datetime-cst
router.post('/current-datetime-cst', (req, res) => {
    const now = new Date();
    const cst = new Date(now.toLocaleString('en-US', { timeZone: 'America/Chicago' }));
    const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const monthNames = ['January', 'February', 'March', 'April', 'May', 'June',
        'July', 'August', 'September', 'October', 'November', 'December'];

    const result = {
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

    res.json(result);
});

// ── Nora Tool: Get Booked Slots for a Date ───────────────────────────────
// POST /api/voice/booked-slots
router.post('/booked-slots', async (req, res) => {
    try {
        const { date, schoolId } = req.body;
        if (!date) return res.status(400).json({ error: 'date is required (YYYY-MM-DD)' });

        // Find school by aiNumber or use first active school if schoolId is provided
        let schoolObjectId;
        if (schoolId && mongoose.Types.ObjectId.isValid(schoolId)) {
            schoolObjectId = new mongoose.Types.ObjectId(schoolId);
        } else {
            // Fallback: find the school with the matching AI number from the DB
            const schools = await School.find({ status: 'active' }).select('_id aiNumber').lean();
            if (schools.length > 0) {
                schoolObjectId = schools[0]._id;
            } else {
                return res.status(404).json({ error: 'No active school found' });
            }
        }

        const school = await School.findById(schoolObjectId).select('businessHoursStart businessHoursEnd timezone aiNumber').lean();
        if (!school) return res.status(404).json({ error: 'School not found' });

        const tz = school.timezone || 'America/Chicago';
        const dayStart = new Date(date + 'T00:00:00');
        const dayEnd = new Date(date + 'T23:59:59');

        // Get busy slots from calendar
        const busySlots = await getBusySlots(schoolObjectId, dayStart, dayEnd);

        // Calculate all 30-min slots within business hours
        const bizStart = school.businessHoursStart || '09:00';
        const bizEnd = school.businessHoursEnd || '17:00';
        const [sh, sm] = bizStart.split(':').map(Number);
        const [eh, em] = bizEnd.split(':').map(Number);

        const allSlots = [];
        let current = new Date(date + `T${String(sh).padStart(2, '0')}:${String(sm).padStart(2, '0')}:00`);
        const endTime = new Date(date + `T${String(eh).padStart(2, '0')}:${String(em).padStart(2, '0')}:00`);

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

        const availableSlots = allSlots.filter(s => !s.booked).map(s => s.time);
        const bookedSlots = allSlots.filter(s => s.booked).map(s => s.time);

        res.json({
            date,
            day_of_week: dayNames[new Date(date + 'T12:00:00').getDay()],
            availableSlots,
            bookedSlots,
            total_available: availableSlots.length,
        });
    } catch (err) {
        console.error('[BookedSlots] Error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

module.exports = router;
