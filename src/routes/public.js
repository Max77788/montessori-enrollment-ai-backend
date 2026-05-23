const express = require('express');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const FormQuestion = require('../models/FormQuestion');
const School = require('../models/School');
const User = require('../models/User');
const Integration = require('../models/Integration');
const ReferralLink = require('../models/ReferralLink');
const Referral = require('../models/Referral');
const TourBooking = require('../models/TourBooking');
const { createCalendarEvent, getFreeSlots, isSlotAvailable } = require('../services/calendarService');
const { 
    createSchoolAgent,
    registerTool,
    patchAgentPrompt,
    formatQAPairsForKB,
    ingestKnowledgeBaseDocument,
    NORA_SYSTEM_PROMPT_TEMPLATE, 
    DEFAULT_FIRST_MESSAGE_TEMPLATE 
} = require('../utils/elevenlabs');

const router = express.Router();

// GET /api/public/inquiry/:schoolId/forms - Public: get form questions for a school (no auth)
router.get('/inquiry/:schoolId/forms', async (req, res) => {
    try {
        const { schoolId } = req.params;
        if (!mongoose.Types.ObjectId.isValid(schoolId)) {
            return res.status(400).json({ error: 'Invalid school ID' });
        }

        const school = await School.findById(schoolId).select('name').lean();
        if (!school) {
            return res.status(404).json({ error: 'School not found' });
        }

        const questions = await FormQuestion.find({ schoolId })
            .sort({ position: 1 })
            .lean();

        res.json({
            schoolName: school.name,
            questions: questions.map(q => ({
                id: q._id.toString(),
                question: q.question,
                required: !!q.required,
            })),
        });
    } catch (err) {
        console.error('Public inquiry forms error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// POST /api/public/inquiry/:schoolId/submit - Public: submit inquiry form (no auth)
router.post('/inquiry/:schoolId/submit', async (req, res) => {
    try {
        const { schoolId } = req.params;
        if (!mongoose.Types.ObjectId.isValid(schoolId)) {
            return res.status(400).json({ error: 'Invalid school ID' });
        }

        const school = await School.findById(schoolId).select('name').lean();
        if (!school) {
            return res.status(404).json({ error: 'School not found' });
        }

        const { parentName, email, phone, answers } = req.body || {};
        const submission = {
            schoolId: new mongoose.Types.ObjectId(schoolId),
            parentName: parentName || 'Not provided',
            email: email || '',
            phone: phone || '',
            answers: Array.isArray(answers) ? answers : [],
            submittedAt: new Date(),
        };

        const InquirySubmission = require('../models/InquirySubmission');
        await InquirySubmission.create(submission);

        res.status(201).json({
            message: 'Thank you! Your inquiry has been submitted.',
            schoolName: school.name,
        });
    } catch (err) {
        console.error('Public inquiry submit error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// GET /api/public/book-tour/:schoolId - Get school info + business hours for booking page
router.get('/book-tour/:schoolId', async (req, res) => {
    try {
        const { schoolId } = req.params;
        if (!mongoose.Types.ObjectId.isValid(schoolId)) {
            return res.status(400).json({ error: 'Invalid school ID' });
        }
        const school = await School.findById(schoolId).select('name businessHoursStart businessHoursEnd preferredCalendar').lean();
        if (!school) {
            return res.status(404).json({ error: 'School not found' });
        }

        const preference = school.preferredCalendar || 'google';
        const integrationCriteria = { schoolId, connected: true };
        if (preference === 'google') integrationCriteria.type = 'google';
        else if (preference === 'outlook') integrationCriteria.type = 'outlook';
        else if (preference === 'both') integrationCriteria.type = { $in: ['google', 'outlook'] };
        else if (preference === 'none') {
            return res.json({
                schoolName: school.name,
                businessHoursStart: school.businessHoursStart || '09:00',
                businessHoursEnd: school.businessHoursEnd || '17:00',
                calendarConnected: false,
                calendarProvider: 'none',
            });
        }

        const integrations = await Integration.find(integrationCriteria).lean();
        const connected = integrations.length > 0;

        res.json({
            schoolName: school.name,
            businessHoursStart: school.businessHoursStart || '09:00',
            businessHoursEnd: school.businessHoursEnd || '17:00',
            calendarConnected: connected,
            calendarProvider: preference, // Return the preference as the provider info
        });
    } catch (err) {
        console.error('Book tour info error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// GET /api/public/book-tour/:schoolId/slots?date=YYYY-MM-DD - Free 30-min slots
router.get('/book-tour/:schoolId/slots', async (req, res) => {
    try {
        const { schoolId } = req.params;
        const { date } = req.query;
        if (!mongoose.Types.ObjectId.isValid(schoolId) || !date) {
            return res.status(400).json({ error: 'schoolId and date (YYYY-MM-DD) are required' });
        }
        const school = await School.findById(schoolId).select('businessHoursStart businessHoursEnd').lean();
        if (!school) return res.status(404).json({ error: 'School not found' });

        const { freeSlots, error } = await getFreeSlots(schoolId, date, {
            start: school.businessHoursStart || '09:00',
            end: school.businessHoursEnd || '17:00',
        });
        if (error) return res.status(400).json({ error });
        res.json({ date, freeSlots });
    } catch (err) {
        console.error('Tour slots error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// POST /api/public/book-tour/:schoolId - Book a tour (no auth). Creates TourBooking + calendar event.
router.post('/book-tour/:schoolId', async (req, res) => {
    try {
        const { schoolId } = req.params;
        if (!mongoose.Types.ObjectId.isValid(schoolId)) {
            return res.status(400).json({ error: 'Invalid school ID' });
        }
        const school = await School.findById(schoolId).select('name').lean();
        if (!school) return res.status(404).json({ error: 'School not found' });

        const { parentName, email, phone, childAge, childName, reason, scheduledAt } = req.body || {};
        if (!parentName?.trim() || !scheduledAt) {
            return res.status(400).json({ error: 'Parent name and scheduledAt are required' });
        }

        const start = new Date(scheduledAt);
        if (isNaN(start.getTime())) {
            return res.status(400).json({ error: 'Invalid date/time' });
        }

        // Validate that the booking date is not in the past
        const now = new Date();
        if (start < now) {
            return res.status(400).json({ error: 'Cannot book a tour for a past date. Please select a future date and time.' });
        }

        const end = new Date(start.getTime() + 30 * 60 * 1000);

        const { available, error: slotError } = await isSlotAvailable(schoolId, start, end);
        if (!available) {
            return res.status(409).json({ error: slotError || 'This time slot is no longer available.' });
        }

        const title = `School Tour – ${parentName.trim()}`;
        const calResult = await createCalendarEvent(schoolId, {
            title,
            startDateTime: start,
            endDateTime: end,
            description: `Tour for ${parentName.trim()}. Phone: ${phone || 'N/A'}. Email: ${email || 'N/A'}. Reason: ${reason || 'Inquiry'}.`,
            parentEmail: email || undefined,
            parentPhone: phone || undefined,
        });

        const booking = await TourBooking.create({
            schoolId,
            parentName: parentName.trim(),
            phone: phone || '',
            email: email || '',
            childName: childName || '',
            childAge: childAge || '',
            reason: reason || '',
            scheduledAt: start,
            calendarEventId: calResult.success ? calResult.eventId : '',
            calendarProvider: calResult.success ? calResult.provider : '',
            calendarEmail: calResult.success ? calResult.email : '',
        });

        res.status(201).json({
            message: 'Tour booked successfully!',
            booking: {
                id: booking._id.toString(),
                scheduledAt: booking.scheduledAt,
                calendarProvider: calResult.success ? calResult.provider : null,
            },
        });
    } catch (err) {
        console.error('Book tour error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// GET /api/public/refer/:code - Resolve referral code (no auth). Returns referrer school name for signup page.
router.get('/refer/:code', async (req, res) => {
    try {
        const { code } = req.params;
        const link = await ReferralLink.findOne({ code }).populate('schoolId', 'name').lean();
        if (!link || !link.schoolId) {
            return res.status(404).json({ error: 'Invalid or expired referral link' });
        }
        res.json({
            valid: true,
            referrerSchoolName: link.schoolId.name,
            code,
        });
    } catch (err) {
        console.error('Referral resolve error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// POST /api/public/refer/:code/register - Register a new school via referral (no auth). Creates School, User, Referral.
router.post('/refer/:code/register', async (req, res) => {
    try {
        const { code } = req.params;
        const { schoolName, email, password } = req.body || {};

        if (!schoolName?.trim() || !email?.trim() || !password) {
            return res.status(400).json({ error: 'School name, email, and password are required' });
        }

        const link = await ReferralLink.findOne({ code }).populate('schoolId', 'name').lean();
        if (!link || !link.schoolId) {
            return res.status(404).json({ error: 'Invalid or expired referral link' });
        }

        const existingUser = await User.findOne({ email: email.trim().toLowerCase() });
        if (existingUser) {
            return res.status(400).json({ error: 'A user with this email already exists' });
        }

        const referrerSchoolId = link.schoolId._id;
        const referrerSchoolName = link.schoolId.name;

        const defaultSystemPrompt = NORA_SYSTEM_PROMPT_TEMPLATE.replace(/{{SCHOOL_NAME}}/g, schoolName.trim());
        const defaultFirstMessage = DEFAULT_FIRST_MESSAGE_TEMPLATE.replace(/{{SCHOOL_NAME}}/g, schoolName.trim());

        const school = await School.create({
            name: schoolName.trim(),
            aiNumber: '',
            routingNumber: '',
            escalationNumber: '',
            elevenlabsAgentId: process.env.DEFAULT_ELEVENLABS_AGENT_ID || '',
            status: 'active',
            systemPrompt: defaultSystemPrompt,
            script: defaultFirstMessage
        });

        // Generate Knowledge Base for the school (if any qaPairs exist)
        let knowledgeBaseId = null;
        if (school.qaPairs && school.qaPairs.length > 0) {
            const kbText = formatQAPairsForKB(school.qaPairs);
            if (kbText) {
                knowledgeBaseId = await ingestKnowledgeBaseDocument(kbText, schoolName.trim());
                if (knowledgeBaseId) {
                    school.knowledgeBaseDocumentId = knowledgeBaseId;
                    await school.save();
                }
            }
        }

        // Create ElevenLabs Agent for the school
        const agentId = await createSchoolAgent(schoolName.trim(), school.knowledgeBaseDocumentId);
        if (agentId) {
            school.elevenlabsAgentId = agentId;

            // Register booked-slots tool
            const toolId = await registerTool(school._id.toString(), agentId);
            if (toolId) {
                const globalTimeToolId = "tool_1801kmyr9pdpemts5qr0f1xys3yy";
                // Link tools to agent (both the school-specific and global time tool)
                await patchAgentPrompt(agentId, {
                    tool_ids: [toolId, globalTimeToolId],
                    post_call_webhook_url: "https://montessori-enrollment-ai-backend.onrender.com/api/v1/webhook/elevenlabs",
                    voice_id: "jqcCZkN6Knx8BJ5TBdYR",
                });
                console.log(`[Referral Register] Tools linked to Agent ${agentId}:`, [toolId, globalTimeToolId]);
            }

            await school.save();
        }

        const passwordHash = bcrypt.hashSync(password, 10);
        await User.create({
            email: email.trim().toLowerCase(),
            passwordHash,
            name: schoolName.trim() + ' Admin',
            role: 'school',
            schoolId: school._id,
        });

        await Integration.insertMany([
            { schoolId: school._id, type: 'outlook', name: 'Microsoft Outlook', connected: false },
            { schoolId: school._id, type: 'google', name: 'Google Workspace', connected: false },
        ]);

        // Phone number purchased manually by the school via Settings → "Purchase Phone Number"
        const newRefCode =`ref-${schoolName.trim().toLowerCase().replace(/\s+/g, '-')}-${Date.now().toString(36)}`;
        await ReferralLink.create({ schoolId: school._id, code: newRefCode });

        await Referral.create({
            referrerSchoolId,
            referrerSchoolName,
            referredSchoolId: school._id,
            newSchoolName: schoolName.trim(),
            referralCode: code,
            status: 'converted',
            date: new Date(),
        });

        res.status(201).json({
            message: 'School registered successfully. You can sign in with your email and password.',
            schoolId: school._id.toString(),
        });
    } catch (err) {
        console.error('Referral register error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

module.exports = router;
