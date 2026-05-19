const express = require('express');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const School = require('../models/School');
const User = require('../models/User');
const Integration = require('../models/Integration');
const Followup = require('../models/Followup');
const FormQuestion = require('../models/FormQuestion');
const Referral = require('../models/Referral');
const ReferralLink = require('../models/ReferralLink');
const InquirySubmission = require('../models/InquirySubmission');
const TourBooking = require('../models/TourBooking');
const PhoneNumber = require('../models/PhoneNumber');
const ElevenLabsWebhook = require('../models/ElevenLabsWebhook');
const AiNumberRequest = require('../models/AiNumberRequest');
const BillingTransaction = require('../models/BillingTransaction');
const MinuteLedger = require('../models/MinuteLedger');
const { authMiddleware, adminOnly } = require('../middleware/auth');
const { importSipTrunk, deletePhoneNumber, updatePhoneNumber } = require('../utils/elevenlabs');

const router = express.Router();

// Apply auth middleware to all admin routes
router.use(authMiddleware, adminOnly);

// GET /api/admin/dashboard - Dashboard metrics
router.get('/dashboard', async (req, res) => {
    try {
        const { month, startDate, endDate } = req.query;
        
        // Build date filter
        let dateFilter = {};
        if (month) {
            const [year, monthNum] = month.split('-');
            dateFilter = {
                received_at: {
                    $gte: new Date(year, monthNum - 1, 1),
                    $lt: new Date(year, monthNum, 1)
                }
            };
        } else if (startDate && endDate) {
            dateFilter = {
                received_at: {
                    $gte: new Date(startDate),
                    $lte: new Date(endDate)
                }
            };
        }
        const totalSchools = await School.countDocuments();
        const activeSchools = await School.countDocuments({ status: 'active' });
        const totalCalls = await ElevenLabsWebhook.countDocuments({ type: 'post_call_transcription', ...dateFilter });
        const callsWithSchoolId = await ElevenLabsWebhook.countDocuments({ type: 'post_call_transcription', schoolId: { $exists: true, $ne: null }, ...dateFilter });

        // Calculate month-over-month comparisons
        const now = new Date();
        const startOfCurrentMonth = new Date(now.getFullYear(), now.getMonth(), 1);
        const startOfLastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
        const endOfLastMonth = new Date(now.getFullYear(), now.getMonth(), 0);

        // Schools added this month
        const schoolsAddedThisMonth = await School.countDocuments({
            createdAt: { $gte: startOfCurrentMonth }
        });

        // Calls last month for comparison
        const callsLastMonth = await ElevenLabsWebhook.countDocuments({
            type: 'post_call_transcription',
            received_at: {
                $gte: startOfLastMonth,
                $lte: endOfLastMonth
            }
        });

        const callsDifference = totalCalls - callsLastMonth;
        const callsChangePercent = callsLastMonth > 0 ? Math.round((callsDifference / callsLastMonth) * 100) : 0;
        const totalFollowups = await Followup.countDocuments({ ...dateFilter });
        const sentFollowups = await Followup.countDocuments({ status: 'sent', ...dateFilter });
        const totalReferrals = await Referral.countDocuments({ ...dateFilter });
        
        // New metrics - Create proper date filter for TourBooking (uses createdAt, not received_at)
        let tourDateFilter = {};
        if (month) {
            const [year, monthNum] = month.split('-');
            tourDateFilter = {
                createdAt: {
                    $gte: new Date(year, monthNum - 1, 1),
                    $lt: new Date(year, monthNum, 1)
                }
            };
        } else if (startDate && endDate) {
            tourDateFilter = {
                createdAt: {
                    $gte: new Date(startDate),
                    $lte: new Date(endDate)
                }
            };
        }
        const totalToursBooked = await TourBooking.countDocuments({ ...tourDateFilter });
        
        // Conversion rate calculation: (total tours booked / total calls) * 100
        const conversionRate = totalCalls > 0 ? Math.round((totalToursBooked / totalCalls) * 100) : 0;
        
        // Calculate total call minutes
        const callMinutesAggregation = await ElevenLabsWebhook.aggregate([
            { $match: { type: 'post_call_transcription', ...dateFilter } },
            { 
                $group: { 
                    _id: null, 
                    totalMinutes: { 
                        $sum: { 
                            $ifNull: [
                                '$metadata.phone_call.call_duration_secs', 
                                { $ifNull: ['$metadata.call_duration_secs', { $ifNull: ['$metadata.system__call_duration_secs', 0] }] }
                            ] 
                        } 
                    } 
                } 
            }
        ]);
        const totalCallMinutes = callMinutesAggregation[0]?.totalMinutes || 0;
        
        // Get top schools by call minutes
        const topSchoolsByMinutes = await ElevenLabsWebhook.aggregate([
            { $match: { type: 'post_call_transcription', schoolId: { $exists: true, $ne: null }, ...dateFilter } },
            {
                $group: {
                    _id: '$schoolId',
                    totalMinutes: { 
                        $sum: { 
                            $ifNull: [
                                '$metadata.phone_call.call_duration_secs', 
                                { $ifNull: ['$metadata.call_duration_secs', { $ifNull: ['$metadata.system__call_duration_secs', 0] }] }
                            ] 
                        } 
                    },
                    totalCalls: { $sum: 1 }
                }
            },
            { $sort: { totalMinutes: -1 } },
            { $limit: 10 },
            {
                $lookup: {
                    from: 'schools',
                    localField: '_id',
                    foreignField: '_id',
                    as: 'school'
                }
            },
            { $unwind: '$school' },
            {
                $project: {
                    schoolId: '$_id',
                    schoolName: '$school.name',
                    totalMinutes: 1,
                    totalCalls: 1
                }
            }
        ]);
        
        // Get call minutes over time for line graph (last 30 days or filtered range)
        let dateRangeFilter = { ...dateFilter };
        
        // If no custom date filter, default to last 30 days
        if (!month && !startDate && !endDate) {
            const thirtyDaysAgo = new Date();
            thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
            dateRangeFilter = {
                received_at: { $gte: thirtyDaysAgo }
            };
        }
        
        const callMinutesOverTime = await ElevenLabsWebhook.aggregate([
            { 
                $match: { 
                    type: 'post_call_transcription',
                    ...dateRangeFilter
                } 
            },
            {
                $group: {
                    _id: { $dateToString: { format: "%Y-%m-%d", date: "$received_at" } },
                    totalMinutes: { 
                        $sum: { 
                            $ifNull: [
                                '$metadata.phone_call.call_duration_secs', 
                                { $ifNull: ['$metadata.call_duration_secs', { $ifNull: ['$metadata.system__call_duration_secs', 0] }] }
                            ] 
                        } 
                    },
                    totalCalls: { $sum: 1 }
                }
            },
            { $sort: { '_id': 1 } }
        ]);

        // Recent calls with school name
        const recentCalls = await ElevenLabsWebhook.find({ type: 'post_call_transcription', ...dateRangeFilter })
            .sort({ received_at: -1 })
            .limit(5)
            .populate('schoolId', 'name')
            .lean();

        const formattedCalls = recentCalls.map(c => ({
            id: c._id,
            school_name: c.schoolId?.name || 'Unknown',
            caller_name: c.tour_booking_extracted?.name || 'Parent',
            caller_phone: c.metadata?.phone_call?.from_number || 'Unknown',
            call_type: c.tour_booking_detected ? 'Tour Booking' : 'Inquiry',
            duration: c.metadata?.phone_call?.call_duration_secs || c.metadata?.call_duration_secs || c.metadata?.system__call_duration_secs || 0,
            timestamp: c.received_at,
        }));

        // Recent followups with school name
        const recentFollowups = await Followup.find({ ...dateRangeFilter })
            .sort({ createdAt: -1 })
            .limit(5)
            .populate('schoolId', 'name')
            .lean();

        const formattedFollowups = recentFollowups.map(f => ({
            id: f._id,
            school_name: f.schoolId?.name || 'Unknown',
            lead_name: f.leadName,
            type: f.type,
            status: f.status,
            timestamp: f.createdAt,
        }));

        // Aggregate call drop-off reasons from extractedTags
        const callDropOffReasons = await ElevenLabsWebhook.aggregate([
            { $match: { type: 'post_call_transcription', ...dateFilter } },
            { $unwind: { path: '$extractedTags', preserveNullAndEmptyArrays: true } },
            {
                $match: {
                    extractedTags: {
                        $in: ['Parent hung up', 'Call dropped', 'Nora couldn\'t answer', 'Parent requested callback', 'No child info captured', 'Price concern', 'Not ready yet', 'Wrong school']
                    }
                }
            },
            {
                $group: {
                    _id: '$extractedTags',
                    count: { $sum: 1 }
                }
            },
            { $sort: { count: -1 } }
        ]);

        const totalDropOffCalls = callDropOffReasons.reduce((sum, item) => sum + item.count, 0);
        const conversionReasons = callDropOffReasons.map(item => ({
            reason: item._id,
            count: item.count,
            percentage: totalDropOffCalls > 0 ? Math.round((item.count / totalDropOffCalls) * 100) : 0
        }));

        // Identify schools that need tuning based on "Nora couldn't answer" tags
        const schoolsNeedingTuning = await ElevenLabsWebhook.aggregate([
            { $match: { type: 'post_call_transcription', schoolId: { $exists: true, $ne: null }, ...dateFilter } },
            { $unwind: { path: '$extractedTags', preserveNullAndEmptyArrays: true } },
            {
                $match: {
                    extractedTags: 'Nora couldn\'t answer'
                }
            },
            {
                $group: {
                    _id: '$schoolId',
                    count: { $sum: 1 }
                }
            },
            { $match: { count: { $gte: 3 } } }, // Schools with 3+ Nora couldn't answer calls
            {
                $lookup: {
                    from: 'schools',
                    localField: '_id',
                    foreignField: '_id',
                    as: 'school'
                }
            },
            { $unwind: '$school' },
            {
                $project: {
                    schoolId: '$_id',
                    schoolName: '$school.name',
                    count: 1
                }
            },
            { $sort: { count: -1 } }
        ]);

        // Phone number pool count
        const phonePoolAvailable = await PhoneNumber.countDocuments({ assignedToSchoolId: { $exists: false } });
        const phonePoolTotal = await PhoneNumber.countDocuments();

        res.json({
            metrics: [
                { label: 'Total Schools', value: totalSchools },
                { label: 'Total Calls', value: totalCalls },
                { label: 'Total Tours Booked', value: totalToursBooked },
                { label: 'Total Call Minutes', value: Math.round(totalCallMinutes / 60) },
                { label: 'Phone Pool', value: phonePoolAvailable, subtitle: `${phonePoolAvailable} available / ${phonePoolTotal} total` },
            ],
            callMinutesOverTime,
            topSchoolsByMinutes,
            recentCalls: formattedCalls,
            recentFollowups: formattedFollowups,
            conversionReasons,
            schoolsNeedingTuning,
            overview: {
                totalSchools,
                activeSchools,
                totalCalls,
                callsWithSchoolId,
                totalFollowups,
                sentFollowups,
                totalReferrals,
                totalToursBooked,
                totalCallMinutes: Math.round(totalCallMinutes / 60),
                schoolsAddedThisMonth,
                callsDifference,
                callsChangePercent,
                conversionRate,
            },
        });
    } catch (err) {
        console.error('Admin dashboard error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// GET /api/admin/webhook/:id - Get specific webhook details
router.get('/webhook/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const webhook = await ElevenLabsWebhook.findById(id).lean();
        
        if (!webhook) {
            return res.status(404).json({ error: 'Webhook not found' });
        }
        
        res.json(webhook);
    } catch (err) {
        console.error('Get webhook error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// GET /api/admin/schools - List all schools
router.get('/schools', async (req, res) => {
    try {
        const schools = await School.find().sort({ createdAt: -1 }).lean();

        // Get call counts and followup counts per school
        const referralLinks = await ReferralLink.find().lean();
        const schoolIdToCode = {};
        referralLinks.forEach(rl => { schoolIdToCode[rl.schoolId.toString()] = rl.code; });

        const TourBooking = require('../models/TourBooking');
        const formatted = await Promise.all(
            schools.map(async (s) => {
                let calls = 0;
                try {
                    calls = await ElevenLabsWebhook.countDocuments({ schoolId: s._id, type: 'post_call_transcription' });
                } catch (err) {
                    console.error('Error counting calls for school:', s._id, err);
                }
                const followupsSent = await Followup.countDocuments({ schoolId: s._id, status: 'sent' });
                const tours = await TourBooking.countDocuments({ schoolId: s._id });

                return {
                    id: s._id.toString(),
                    name: s.name,
                    address: s.address,
                    aiNumber: s.aiNumber,
                    routingNumber: s.routingNumber,
                    elevenlabsAgentId: s.elevenlabsAgentId,
                    status: s.status,
                    language: s.language,
                    calls,
                    tours,
                    followupsSent,
                    referralCode: schoolIdToCode[s._id.toString()] || null,
                    createdAt: s.createdAt,
                    foundingPartner: Boolean(s.foundingPartner),
                    subscriptionStatus: s.subscriptionStatus || 'none',
                    subscriptionPlanKey: s.subscriptionPlanKey || '',
                    minuteBalance: typeof s.minuteBalance === 'number' ? s.minuteBalance : null,
                    billingMode: s.billingMode || 'none',
                };
            })
        );

        res.json(formatted);
    } catch (err) {
        console.error('Admin schools error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// POST /api/admin/schools - Create a new school + user credentials. Optional referralCode links to referrer.
router.post('/schools', async (req, res) => {
    try {
        const { name, email, password, address, aiNumber, routingNumber, elevenlabsAgentId, referralCode, referrerSchoolId } = req.body;

        if (!name || !email || !password) {
            return res.status(400).json({ error: 'Name, email, and password are required' });
        }

        const existingUser = await User.findOne({ email });
        if (existingUser) {
            return res.status(400).json({ error: 'A user with this email already exists' });
        }

        const school = new School({
            name,
            address: address || '',
            aiNumber: aiNumber || '',
            routingNumber: routingNumber || '',
            elevenlabsAgentId: elevenlabsAgentId || '',
            status: 'active',
        });

        // Auto-correct timezone based on address
        if (address) {
            const { getTimezoneFromAddress } = require('../utils/timezone');
            const detectedTz = await getTimezoneFromAddress(address);
            if (detectedTz) school.timezone = detectedTz;
        }

        await school.save();

        const hashedPassword = await bcrypt.hash(password, 10);
        await User.create({
            email,
            passwordHash: hashedPassword,
            name: name + ' Admin',
            role: 'school',
            schoolId: school._id,
        });

        await Integration.insertMany([
            { schoolId: school._id, type: 'outlook', name: 'Microsoft Outlook', connected: false },
            { schoolId: school._id, type: 'google', name: 'Google Workspace', connected: false },
        ]);

        // Phone number purchased manually by the school via Settings → "Purchase Phone Number"
        const refCode =`ref-${name.toLowerCase().replace(/\s+/g, '-')}-${Date.now().toString(36)}`;
        await ReferralLink.create({ schoolId: school._id, code: refCode });

        let referralLinked = false;
        const refId = referrerSchoolId && mongoose.Types.ObjectId.isValid(referrerSchoolId) ? referrerSchoolId : null;
        const refCodeTrim = referralCode && String(referralCode).trim() ? String(referralCode).trim() : null;

        if (refId) {
            const referrerSchool = await School.findById(refId).select('name').lean();
            const link = await ReferralLink.findOne({ schoolId: refId }).lean();
            if (referrerSchool && link) {
                await Referral.create({
                    referrerSchoolId: refId,
                    referrerSchoolName: referrerSchool.name,
                    referredSchoolId: school._id,
                    newSchoolName: name,
                    referralCode: link.code,
                    status: 'converted',
                });
                referralLinked = true;
            }
        } else if (refCodeTrim) {
            const link = await ReferralLink.findOne({ code: new RegExp(`^${refCodeTrim.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') }).populate('schoolId', 'name').lean();
            if (link && link.schoolId) {
                await Referral.create({
                    referrerSchoolId: link.schoolId._id,
                    referrerSchoolName: link.schoolId.name,
                    referredSchoolId: school._id,
                    newSchoolName: name,
                    referralCode: link.code,
                    status: 'converted',
                });
                referralLinked = true;
            }
        }

        if ((refId || refCodeTrim) && !referralLinked) {
            console.warn('[Admin] Create school: referral code/school not found:', refCodeTrim || refId);
        }

        res.status(201).json({
            message: 'School created successfully',
            referralLinked,
            school: {
                id: school._id.toString(),
                name,
                email,
                aiNumber: aiNumber || '',
                routingNumber: routingNumber || '',
                elevenlabsAgentId: elevenlabsAgentId || '',
            },
        });
    } catch (err) {
        console.error('Create school error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// GET /api/admin/billing/summary — revenue, MRR-style subscription payments, top-ups, by school
router.get('/billing/summary', async (req, res) => {
    try {
        const { month } = req.query;
        let dateFilter = {};
        if (month) {
            const [y, m] = String(month).split('-').map(Number);
            dateFilter = {
                createdAt: {
                    $gte: new Date(y, m - 1, 1),
                    $lt: new Date(y, m, 1),
                },
            };
        }

        const match = { status: 'completed', ...dateFilter };
        const byType = await BillingTransaction.aggregate([
            { $match: match },
            {
                $group: {
                    _id: '$type',
                    total: { $sum: '$amount' },
                    count: { $sum: 1 },
                },
            },
        ]);

        const revenueTotal = await BillingTransaction.aggregate([
            { $match: { ...match, type: { $in: ['subscription_payment', 'topup', 'onboarding'] } } },
            { $group: { _id: null, total: { $sum: '$amount' } } },
        ]);

        const schoolRows = await School.find()
            .select('name subscriptionPlanKey subscriptionStatus minuteBalance billingMode foundingPartner onboardingFeePaid paypalSubscriptionId lastBillingCyclePaymentAt')
            .sort({ name: 1 })
            .lean();

        res.json({
            period: month || 'all',
            revenueUsd: revenueTotal[0]?.total || 0,
            byType: byType.reduce((acc, row) => {
                acc[row._id] = { totalUsd: row.total, count: row.count };
                return acc;
            }, {}),
            schools: schoolRows.map((s) => ({
                id: s._id.toString(),
                name: s.name,
                subscriptionPlanKey: s.subscriptionPlanKey || '',
                subscriptionStatus: s.subscriptionStatus || 'none',
                billingMode: s.billingMode || 'none',
                minuteBalance: typeof s.minuteBalance === 'number' ? s.minuteBalance : null,
                foundingPartner: Boolean(s.foundingPartner),
                onboardingFeePaid: Boolean(s.onboardingFeePaid),
                paypalSubscriptionId: s.paypalSubscriptionId || '',
                lastBillingCyclePaymentAt: s.lastBillingCyclePaymentAt || null,
            })),
        });
    } catch (err) {
        console.error('Admin billing summary error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// GET /api/admin/billing/transactions — paginated ledger
router.get('/billing/transactions', async (req, res) => {
    try {
        const limit = Math.min(parseInt(req.query.limit || '50', 10), 200);
        const skip = parseInt(req.query.skip || '0', 10);
        const { schoolId, type } = req.query;

        const q = {};
        if (schoolId && mongoose.Types.ObjectId.isValid(schoolId)) q.schoolId = schoolId;
        if (type) q.type = type;

        const [items, total] = await Promise.all([
            BillingTransaction.find(q)
                .sort({ createdAt: -1 })
                .skip(skip)
                .limit(limit)
                .populate('schoolId', 'name')
                .lean(),
            BillingTransaction.countDocuments(q),
        ]);

        res.json({
            total,
            items: items.map((t) => ({
                id: t._id.toString(),
                schoolId: t.schoolId?._id?.toString() || null,
                schoolName: t.schoolId?.name || null,
                type: t.type,
                amount: t.amount,
                currency: t.currency,
                status: t.status,
                planKey: t.planKey,
                description: t.description,
                paypalSubscriptionId: t.paypalSubscriptionId,
                paypalOrderId: t.paypalOrderId,
                paypalSaleId: t.paypalSaleId,
                createdAt: t.createdAt,
            })),
        });
    } catch (err) {
        console.error('Admin billing transactions error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// GET /api/admin/billing/minutes/:schoolId — minute ledger for a school
router.get('/billing/minutes/:schoolId', async (req, res) => {
    try {
        const { schoolId } = req.params;
        if (!mongoose.Types.ObjectId.isValid(schoolId)) {
            return res.status(400).json({ error: 'Invalid school id' });
        }
        const limit = Math.min(parseInt(req.query.limit || '100', 10), 500);
        const entries = await MinuteLedger.find({ schoolId })
            .sort({ createdAt: -1 })
            .limit(limit)
            .lean();
        res.json(entries);
    } catch (err) {
        console.error('Admin minute ledger error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// PUT /api/admin/schools/:id - Update school
router.put('/schools/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { name, address, aiNumber, routingNumber, elevenlabsAgentId, status, foundingPartner, minuteBalance, billingMode } = req.body;

        const school = await School.findById(id);
        if (!school) {
            return res.status(404).json({ error: 'School not found' });
        }

        if (name !== undefined) school.name = name;
        if (address !== undefined && address !== school.address) {
            school.address = address;
            // Auto-correct timezone based on address
            const { getTimezoneFromAddress } = require('../utils/timezone');
            const detectedTz = await getTimezoneFromAddress(address);
            if (detectedTz) {
                school.timezone = detectedTz;
                console.log(`[Admin] Auto-updated timezone for ${school.name} to ${detectedTz}`);
            }
        }
        if (aiNumber !== undefined) school.aiNumber = aiNumber;
        if (routingNumber !== undefined) school.routingNumber = routingNumber;
        if (elevenlabsAgentId !== undefined) school.elevenlabsAgentId = elevenlabsAgentId;
        if (status !== undefined) school.status = status;
        if (foundingPartner !== undefined) school.foundingPartner = Boolean(foundingPartner);
        if (minuteBalance !== undefined && minuteBalance !== null && !Number.isNaN(Number(minuteBalance))) {
            school.minuteBalance = Number(minuteBalance);
        }
        if (billingMode !== undefined && ['none', 'metered'].includes(billingMode)) {
            school.billingMode = billingMode;
        }

        await school.save();

        res.json({ message: 'School updated successfully' });
    } catch (err) {
        console.error('Update school error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// --- Centralized Phone Number Management ---

// GET /api/admin/phone-numbers - List all imported phone numbers
router.get('/phone-numbers', async (req, res) => {
    try {
        const numbers = await PhoneNumber.find()
            .populate('schoolId', 'name')
            .sort({ createdAt: -1 })
            .lean();
        res.json(numbers);
    } catch (err) {
        console.error('List Phone Numbers error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// POST /api/admin/phone-numbers - Import a new phone number (Global Pool)
router.post('/phone-numbers', async (req, res) => {
    try {
        const payload = req.body;
        console.log('[Admin Phone Import] Request Body:', JSON.stringify(payload, null, 2));
        let result;

        console.log(`[Admin Phone] Importing SIP Trunk: ${payload.phone_number}`);
        result = await importSipTrunk(payload);

        if (!result || !result.phone_number_id) {
            if (result?.alreadyExists) {
                return res.status(409).json({ error: 'This phone number is already imported in ElevenLabs.' });
            }
            return res.status(500).json({ error: 'Failed to retrieve phone_number_id from ElevenLabs API' });
        }

        const newNum = await PhoneNumber.create({
            phone_number_id: result.phone_number_id,
            phone_number: payload.phone_number,
            provider: 'sip_trunk',
            label: payload.label || 'Imported Number',
        });

        res.status(201).json(newNum);
    } catch (err) {
        console.error('Import Phone Number error:', err);
        res.status(500).json({ error: err.message || 'Internal server error' });
    }
});

// DELETE /api/admin/phone-numbers/:id - Delete a phone number from ElevenLabs and Pool
router.delete('/phone-numbers/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const numDoc = await PhoneNumber.findById(id);
        if (!numDoc) return res.status(404).json({ error: 'Number not found' });

        // 1. Delete from ElevenLabs
        try {
            await deletePhoneNumber(numDoc.phone_number_id);
        } catch (err) {
            console.warn(`[Admin Phone Delete] Failed to delete from ElevenLabs:`, err.message);
        }

        // 2. If assigned to a school, clear it there too
        if (numDoc.schoolId) {
            await School.findByIdAndUpdate(numDoc.schoolId, {
                aiNumber: '',
                agentPhoneNumberId: ''
            });
        }

        await PhoneNumber.findByIdAndDelete(id);
        res.json({ success: true, message: 'Phone number deleted successfully' });
    } catch (err) {
        console.error('Delete Phone Number error:', err);
        res.status(500).json({ error: err.message || 'Internal server error' });
    }
});

// POST /api/admin/schools/:id/assign-number - Assign or Unassign an imported number to a school
router.post('/schools/:id/assign-number', async (req, res) => {
    try {
        const { id } = req.params;
        const { phoneNumberId, agentId } = req.body;

        console.log(`[Assign/Unassign Phone] Request for School: ${id}, Phone: ${phoneNumberId}, Agent: ${agentId}`);

        const school = await School.findById(id);
        if (!school) return res.status(404).json({ error: 'School not found' });

        // CASE 1: UNASSIGN TRIGGERED (If agentId is explicitly null OR phoneNumberId is explicitly null)
        if (agentId === null || phoneNumberId === null) {
            const currentPhoneId = school.agentPhoneNumberId;
            if (!currentPhoneId) {
                // If nothing to unassign, just return success
                return res.json({ success: true, message: 'No number was assigned to this school' });
            }

            console.log(`[Unassign Phone] Removing number ${currentPhoneId} from school ${school.name}...`);

            // 1. Reconcile with ElevenLabs (remove agent association)
            try {
                await updatePhoneNumber(currentPhoneId, { agent_id: null });
            } catch (elError) {
                console.warn(`[Unassign Phone] ElevenLabs dissociation warning (ignoring):`, elError.message);
            }

            // 2. Clear PhoneNumber record association
            await PhoneNumber.findOneAndUpdate(
                { phone_number_id: currentPhoneId },
                { schoolId: null }
            );

            // 3. Clear School record association
            school.aiNumber = '';
            school.agentPhoneNumberId = '';
            await school.save();

            return res.json({ success: true, message: 'Phone number unassigned successfully' });
        }

        // CASE 2: ASSIGN TRIGGERED
        if (!phoneNumberId) {
            return res.status(400).json({ error: 'phoneNumberId is required for assignment' });
        }

        const phoneNum = await PhoneNumber.findById(phoneNumberId);
        if (!phoneNum) return res.status(404).json({ error: 'Phone number record not found' });

        // Consistency check: Is this number assigned to someone else?
        if (phoneNum.schoolId && phoneNum.schoolId.toString() !== id) {
            return res.status(400).json({ error: 'This number is already assigned to another school' });
        }

        // 1. Cleanup: If the school has a DIFFERENT number assigned, unassign it first
        if (school.agentPhoneNumberId && school.agentPhoneNumberId !== phoneNum.phone_number_id) {
            console.log(`[Assign Phone] Cleaning up old assignment for school: ${school.agentPhoneNumberId}`);
            try {
                await updatePhoneNumber(school.agentPhoneNumberId, { agent_id: null });
            } catch (err) {
                console.warn(`[Assign Phone] Old dissociation warning:`, err.message);
            }
            await PhoneNumber.findOneAndUpdate(
                { phone_number_id: school.agentPhoneNumberId },
                { schoolId: null }
            );
        }

        // 2. Perform local assignment
        school.aiNumber = phoneNum.phone_number;
        school.agentPhoneNumberId = phoneNum.phone_number_id;
        await school.save();

        // 3. Reconcile with ElevenLabs
        if (school.elevenlabsAgentId) {
            console.log(`[Assign Phone] Linking Agent ${school.elevenlabsAgentId} to Number ${phoneNum.phone_number_id}...`);
            try {
                const elResult = await updatePhoneNumber(phoneNum.phone_number_id, {
                    agent_id: school.elevenlabsAgentId
                });
                console.log(`[Assign Phone] ElevenLabs Reconcile Success`);
            } catch (elError) {
                console.error(`[Assign Phone] ElevenLabs link failed:`, elError.message);
                // We return 500 here because assignment failed at the voice provider level
                return res.status(500).json({ 
                    error: `ElevenLabs Linking Failed: ${elError.message}. Please check if the Agent ID is valid in ElevenLabs.` 
                });
            }
        } else {
            console.warn(`[Assign Phone] Skipping ElevenLabs link: No agent ID configured for school ${school.name}`);
        }

        // 4. Update PhoneNumber doc mapping
        phoneNum.schoolId = school._id;
        await phoneNum.save();

        res.json({ 
            success: true, 
            message: 'Phone number assigned successfully', 
            aiNumber: school.aiNumber 
        });
    } catch (err) {
        console.error('Assign Phone Number overall error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// DELETE /api/admin/schools/:id - Delete school and all related data from DB
router.delete('/schools/:id', async (req, res) => {
    try {
        const { id } = req.params;
        if (!mongoose.Types.ObjectId.isValid(id)) {
            return res.status(400).json({ error: 'Invalid school ID' });
        }

        const school = await School.findById(id);
        if (!school) {
            return res.status(404).json({ error: 'School not found' });
        }

        const normalizePhone = (p) => String(p || '').replace(/\D/g, '');
        const schoolAiDigits = normalizePhone(school.aiNumber);
        const voiceAiParticipantId = schoolAiDigits ? `sip_+${schoolAiDigits}` : null;

        const objectId = new mongoose.Types.ObjectId(id);
        await Promise.all([
            User.deleteMany({ schoolId: objectId }),
            ElevenLabsWebhook.deleteMany({ schoolId: objectId }),
            Integration.deleteMany({ schoolId: objectId }),
            Followup.deleteMany({ schoolId: objectId }),
            FormQuestion.deleteMany({ schoolId: objectId }),
            Referral.deleteMany({ referrerSchoolId: objectId }),
            Referral.deleteMany({ referredSchoolId: objectId }),
            ReferralLink.deleteMany({ schoolId: objectId }),
            InquirySubmission.deleteMany({ schoolId: objectId }),
            TourBooking.deleteMany({ schoolId: objectId }),
            // Clear any imported number assignments in the pool
            PhoneNumber.updateMany({ schoolId: objectId }, { $set: { schoolId: null } }),
            // Delete ElevenLabs webhook data used by dashboard/insights
            ElevenLabsWebhook.deleteMany({
                $or: [
                    { schoolId: objectId },
                    ...(schoolAiDigits ? [
                        { 'metadata.phone_call.agent_number': { $regex: schoolAiDigits } },
                        { calledNumberDigits: schoolAiDigits },
                    ] : [])
                ]
            }),
            // Best-effort: purge VoiceAI logs in benny DB (if present)
            (async () => {
                if (!voiceAiParticipantId) return;
                try {
                    const bennyDb = mongoose.connection.useDb('benny');
                    const collection = bennyDb.collection('voiceAI');
                    await collection.deleteMany({ participant_id: voiceAiParticipantId });
                } catch (err) {
                    console.warn('[Admin] VoiceAI purge warning:', err.message);
                }
            })(),
        ]);
        await School.findByIdAndDelete(id);

        res.json({ message: 'School deleted successfully' });
    } catch (err) {
        console.error('Delete school error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// GET /api/admin/analytics - Analytics data
router.get('/analytics', async (req, res) => {
    try {
        const { month, startDate, endDate } = req.query;
        
        // Build date filter
        let dateFilter = {};
        if (month) {
            const [year, monthNum] = month.split('-');
            dateFilter = {
                received_at: {
                    $gte: new Date(year, monthNum - 1, 1),
                    $lt: new Date(year, monthNum, 1)
                }
            };
        } else if (startDate && endDate) {
            dateFilter = {
                received_at: {
                    $gte: new Date(startDate),
                    $lte: new Date(endDate)
                }
            };
        }
        
        // Build base match condition
        let baseMatch = { type: 'post_call_transcription', ...(Object.keys(dateFilter).length > 0 ? dateFilter : {}) };
        
        // Calls by month using aggregation
        const callsByMonth = await ElevenLabsWebhook.aggregate([
            { $match: baseMatch },
            {
                $group: {
                    _id: { $dateToString: { format: '%Y-%m', date: '$received_at' } },
                    total: { $sum: 1 },
                    tourBookings: { $sum: { $cond: [{ $eq: ['$tour_booking_detected', true] }, 1, 0] } },
                    inquiries: { $sum: { $cond: [{ $eq: ['$tour_booking_detected', false] }, 1, 0] } },
                },
            },
            { $sort: { _id: 1 } },
            { $project: { month: '$_id', total: 1, tourBookings: 1, inquiries: 1, _id: 0 } },
        ]);

        // Calls per school
        const schoolMatch = Object.keys(dateFilter).length > 0 ? dateFilter : {};
        const callsBySchool = await ElevenLabsWebhook.aggregate([
            { $match: { type: 'post_call_transcription', ...schoolMatch } },
            {
                $group: {
                    _id: '$schoolId',
                    calls: { $sum: 1 },
                    tourBookings: { $sum: { $cond: [{ $eq: ['$tour_booking_detected', true] }, 1, 0] } },
                },
            },
            {
                $lookup: {
                    from: 'schools',
                    localField: '_id',
                    foreignField: '_id',
                    as: 'school',
                },
            },
            { $unwind: '$school' },
            { $project: { name: '$school.name', calls: 1, tourBookings: 1, _id: 0 } },
            { $sort: { calls: -1 } },
        ]);

        // Followup stats
        const followupMatch = Object.keys(dateFilter).length > 0 ? dateFilter : {};
        const followupStats = await Followup.aggregate([
            { $match: followupMatch },
            {
                $group: {
                    _id: { type: '$type', status: '$status' },
                    count: { $sum: 1 },
                },
            },
            { $project: { type: '$_id.type', status: '$_id.status', count: 1, _id: 0 } },
        ]);

        // Top performing schools
        const schools = await School.find().lean();
        const topSchools = await Promise.all(
            schools.map(async (s) => {
                const totalCalls = await ElevenLabsWebhook.countDocuments({ schoolId: s._id, type: 'post_call_transcription', ...dateFilter });
                const tourBookings = await ElevenLabsWebhook.countDocuments({ schoolId: s._id, type: 'post_call_transcription', tour_booking_detected: true, ...dateFilter });
                const followupsSent = await Followup.countDocuments({ schoolId: s._id, status: 'sent', ...dateFilter });
                return {
                    name: s.name,
                    status: s.status,
                    total_calls: totalCalls,
                    tour_bookings: tourBookings,
                    followups_sent: followupsSent,
                };
            })
        );
        topSchools.sort((a, b) => b.total_calls - a.total_calls);

        res.json({
            callsByMonth,
            callsBySchool,
            followupStats,
            topSchools,
        });
    } catch (err) {
        console.error('Admin analytics error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// GET /api/admin/integrations - All integration statuses
router.get('/integrations', async (req, res) => {
    try {
        const integrations = await Integration.find()
            .populate('schoolId', 'name status')
            .lean();

        // Group by type
        const grouped = {};
        integrations.forEach(i => {
            if (!grouped[i.type]) {
                grouped[i.type] = {
                    type: i.type,
                    name: i.name,
                    schools: [],
                };
            }
            grouped[i.type].schools.push({
                schoolId: i.schoolId?._id?.toString(),
                schoolName: i.schoolId?.name || 'Unknown',
                schoolStatus: i.schoolId?.status || 'unknown',
                connected: i.connected,
                connectedAt: i.connectedAt,
                tokenExpiresOn: i.config?.expiresOn || i.config?.tokenExpiryDate || null,
                tokenEmail: i.config?.account?.username || i.config?.userEmail || null,
            });
        });

        res.json(Object.values(grouped));
    } catch (err) {
        console.error('Admin integrations error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// GET /api/admin/platform-status — Infrastructure health overview
router.get('/platform-status', async (req, res) => {
    try {
        const status = {
            timestamp: new Date().toISOString(),
            services: []
        };

        // Render (our hosting) — always "connected" if the API is responding
        status.services.push({
            name: 'Render',
            type: 'hosting',
            status: 'connected',
            detail: 'API is responding',
            accessUrl: 'https://dashboard.render.com',
            lastChecked: new Date().toISOString()
        });

        // MongoDB
        try {
            const mongoose = require('mongoose');
            const dbState = mongoose.connection.readyState;
            // 0=disconnected, 1=connected, 2=connecting, 3=disconnecting
            const dbStatus = dbState === 1 ? 'connected' : dbState === 2 ? 'connecting' : 'disconnected';
            status.services.push({
                name: 'MongoDB',
                type: 'database',
                status: dbStatus,
                detail: `State: ${dbState} (0=disconnected, 1=connected, 2=connecting)`,
                lastChecked: new Date().toISOString()
            });
        } catch (dbErr) {
            status.services.push({
                name: 'MongoDB',
                type: 'database',
                status: 'disconnected',
                detail: dbErr.message,
                lastChecked: new Date().toISOString()
            });
        }

        // ElevenLabs API
        const elevnlabsConfigured = !!(process.env.ELEVENLABS_API_URL && process.env.ELEVENLABS_API_KEY);
        status.services.push({
            name: 'ElevenLabs',
            type: 'voice_ai',
            status: elevnlabsConfigured ? 'connected' : 'disconnected',
            detail: elevnlabsConfigured ? 'API configured' : 'ELEVENLABS_API_URL or ELEVENLABS_API_KEY not set',
            accessUrl: elevnlabsConfigured ? process.env.ELEVENLABS_API_URL : null,
            lastChecked: new Date().toISOString()
        });

        // VAPI AI
        const vapiConfigured = !!process.env.VAPI_API_KEY;
        const vapiSchoolCount = await School.countDocuments({ voiceProvider: 'vapi' });
        status.services.push({
            name: 'VAPI AI',
            type: 'voice_ai',
            status: vapiConfigured ? 'connected' : 'disconnected',
            detail: vapiConfigured ? `API configured, ${vapiSchoolCount} school(s) using VAPI` : 'VAPI_API_KEY not set',
            accessUrl: 'https://dashboard.vapi.ai',
            lastChecked: new Date().toISOString()
        });

        // Twilio (or ElevenLabs SIP) — check if phone numbers exist
        const PhoneNumber = require('../models/PhoneNumber');
        const phoneCount = await PhoneNumber.countDocuments();
        status.services.push({
            name: 'Phone Numbers (SIP)',
            type: 'telephony',
            status: phoneCount > 0 ? 'connected' : 'degraded',
            detail: `${phoneCount} phone number(s) in pool`,
            lastChecked: new Date().toISOString()
        });

        // Microsoft Calendar — check connected count
        const msConnected = await Integration.countDocuments({ type: 'outlook', connected: true });
        status.services.push({
            name: 'Microsoft Calendar',
            type: 'calendar',
            status: msConnected > 0 ? 'connected' : 'disconnected',
            detail: `${msConnected} school(s) connected`,
            accessUrl: 'https://portal.azure.com',
            lastChecked: new Date().toISOString()
        });

        // Google Calendar — check connected count
        const googleConnected = await Integration.countDocuments({ type: 'google', connected: true });
        status.services.push({
            name: 'Google Calendar',
            type: 'calendar',
            status: googleConnected > 0 ? 'connected' : 'disconnected',
            detail: `${googleConnected} school(s) connected`,
            accessUrl: 'https://console.cloud.google.com',
            lastChecked: new Date().toISOString()
        });

        // PayPal
        const paypalConfigured = !!(process.env.PAYPAL_CLIENT_ID && process.env.PAYPAL_CLIENT_SECRET);
        status.services.push({
            name: 'PayPal',
            type: 'billing',
            status: paypalConfigured ? 'connected' : 'disconnected',
            detail: paypalConfigured ? 'API configured' : 'PAYPAL_CLIENT_ID or PAYPAL_CLIENT_SECRET not set',
            accessUrl: 'https://developer.paypal.com',
            lastChecked: new Date().toISOString()
        });

        // SMTP
        const smtpConfigured = !!(process.env.SMTP_HOST && process.env.SMTP_USER);
        status.services.push({
            name: 'SMTP Email',
            type: 'email',
            status: smtpConfigured ? 'connected' : 'disconnected',
            detail: smtpConfigured ? `SMTP configured (${process.env.SMTP_HOST})` : 'SMTP not configured — email fallback only',
            lastChecked: new Date().toISOString()
        });

        // OpenAI
        const openaiConfigured = !!process.env.OPENAI_API_KEY;
        status.services.push({
            name: 'OpenAI',
            type: 'ai',
            status: openaiConfigured ? 'connected' : 'disconnected',
            detail: openaiConfigured ? 'API key configured' : 'OPENAI_API_KEY not set',
            lastChecked: new Date().toISOString()
        });

        // Memory/CPU
        const memUsage = process.memoryUsage();
        const heapUsedMB = (memUsage.heapUsed / 1024 / 1024).toFixed(0);
        const heapTotalMB = (memUsage.heapTotal / 1024 / 1024).toFixed(0);
        const rssMB = (memUsage.rss / 1024 / 1024).toFixed(0);
        const uptimeH = Math.floor(process.uptime() / 3600);
        const uptimeM = Math.floor((process.uptime() % 3600) / 60);

        status.services.push({
            name: 'Server Resources',
            type: 'infrastructure',
            status: 'connected',
            detail: `Heap: ${heapUsedMB}/${heapTotalMB}MB, RSS: ${rssMB}MB, Uptime: ${uptimeH}h ${uptimeM}m`,
            lastChecked: new Date().toISOString()
        });

        res.json(status);
    } catch (err) {
        console.error('Platform status error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// GET /api/admin/referrals - All referrals
router.get('/referrals', async (req, res) => {
    try {
        const referrals = await Referral.find()
            .sort({ createdAt: -1 })
            .lean();

        const formatted = referrals.map(r => ({
            id: r._id.toString(),
            referrerSchool: r.referrerSchoolName,
            newSchool: r.newSchoolName,
            referredSchoolId: r.referredSchoolId?.toString() || null,
            date: r.date,
            status: r.status,
        }));

        res.json(formatted);
    } catch (err) {
        console.error('Admin referrals error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// GET /api/admin/ai-number-requests - Get all AI number requests
router.get('/ai-number-requests', async (req, res) => {
    try {
        const requests = await AiNumberRequest.find()
            .sort({ requestedAt: -1 })
            .populate('schoolId', 'name email')
            .populate('requestedBy', 'name email')
            .populate('resolvedBy', 'name email')
            .lean();

        res.json(requests);
    } catch (err) {
        console.error('Admin AI number requests error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// POST /api/admin/ai-number-requests/:requestId/approve - Approve an AI number request
router.post('/ai-number-requests/:requestId/approve', async (req, res) => {
    try {
        const { requestId } = req.params;
        const { aiNumber, notes } = req.body;

        if (!aiNumber) {
            return res.status(400).json({ error: 'AI number is required' });
        }

        const request = await AiNumberRequest.findById(requestId);
        if (!request) {
            return res.status(404).json({ error: 'Request not found' });
        }

        if (request.status !== 'pending') {
            return res.status(400).json({ error: 'Request has already been processed' });
        }

        // Update request
        request.status = 'approved';
        request.assignedAiNumber = aiNumber;
        request.adminNotes = notes || '';
        request.resolvedBy = req.user.id;
        request.resolvedAt = new Date();
        await request.save();

        // Update school with AI number
        await School.findByIdAndUpdate(request.schoolId, { 
            aiNumber: aiNumber 
        });

        console.log(`[Admin] AI number request ${requestId} approved. Assigned: ${aiNumber}`);

        res.json({ 
            message: 'AI number request approved successfully',
            aiNumber: aiNumber
        });
    } catch (err) {
        console.error('Admin approve AI number request error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// POST /api/admin/ai-number-requests/:requestId/reject - Reject an AI number request
router.post('/ai-number-requests/:requestId/reject', async (req, res) => {
    try {
        const { requestId } = req.params;
        const { notes } = req.body;

        const request = await AiNumberRequest.findById(requestId);
        if (!request) {
            return res.status(404).json({ error: 'Request not found' });
        }

        if (request.status !== 'pending') {
            return res.status(400).json({ error: 'Request has already been processed' });
        }

        // Update request
        request.status = 'rejected';
        request.adminNotes = notes || '';
        request.resolvedBy = req.user.id;
        request.resolvedAt = new Date();
        await request.save();

        console.log(`[Admin] AI number request ${requestId} rejected`);

        res.json({ message: 'AI number request rejected successfully' });
    } catch (err) {
        console.error('Admin reject AI number request error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// PUT /api/admin/ai-number-requests/:requestId/mark-read - Mark request as read
router.put('/ai-number-requests/:requestId/mark-read', async (req, res) => {
    try {
        const { requestId } = req.params;

        const request = await AiNumberRequest.findById(requestId);
        if (!request) {
            return res.status(404).json({ error: 'Request not found' });
        }

        // Update request to mark as read
        request.isRead = true;
        await request.save();

        console.log(`[Admin] AI number request ${requestId} marked as read`);

        res.json({ message: 'Request marked as read successfully' });
    } catch (err) {
        console.error('Admin mark as read AI number request error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// DELETE /api/admin/ai-number-requests - Clear all requests
router.delete('/ai-number-requests', async (req, res) => {
    try {
        const result = await AiNumberRequest.deleteMany({});
        
        console.log(`[Admin] Cleared ${result.deletedCount} AI number requests`);

        res.json({ 
            message: 'All AI number requests cleared successfully',
            deletedCount: result.deletedCount
        });
    } catch (err) {
        console.error('Admin clear AI number requests error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

module.exports = router;

