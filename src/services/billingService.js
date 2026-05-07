const School = require('../models/School');
const MinuteLedger = require('../models/MinuteLedger');
const BillingTransaction = require('../models/BillingTransaction');
const { getCallDurationSeconds } = require('../utils/webhookHelpers');
const { getPlanDef } = require('../config/billingPlans');
const { computeTopupUsd } = require('../config/topupPricing');

async function grantMinutes(schoolId, minutes, reason, meta = {}) {
    if (!minutes || minutes <= 0) return null;
    const school = await School.findById(schoolId);
    if (!school) return null;
    const prev = typeof school.minuteBalance === 'number' ? school.minuteBalance : 0;
    const next = prev + minutes;
    school.minuteBalance = next;
    school.billingMode = 'metered';
    await school.save();
    await MinuteLedger.create({
        schoolId,
        deltaMinutes: minutes,
        balanceAfter: next,
        reason,
        meta,
    });
    return { balanceAfter: next };
}

/**
 * Deduct minutes after an ElevenLabs call (canonical usage).
 * After deduction, checks if auto top-up should trigger.
 */
async function deductCallMinutes(webhookDoc) {
    const schoolId = webhookDoc.schoolId;
    if (!schoolId) return null;

    const existing = await MinuteLedger.findOne({ webhookId: webhookDoc._id, reason: 'call_usage' }).lean();
    if (existing) return existing;

    const school = await School.findById(schoolId);
    if (!school || school.billingMode !== 'metered') return null;

    const secs = getCallDurationSeconds(webhookDoc);
    const minutes = Math.max(0, Math.ceil(secs / 60));
    if (minutes === 0) return null;

    const prev = typeof school.minuteBalance === 'number' ? school.minuteBalance : 0;
    const next = prev - minutes;
    school.minuteBalance = next;
    await school.save();

    await MinuteLedger.create({
        schoolId,
        deltaMinutes: -minutes,
        balanceAfter: next,
        reason: 'call_usage',
        webhookId: webhookDoc._id,
        meta: { seconds: secs },
    });

    // ── Auto top-up check ──────────────────────────────────────────
    try {
        await checkAndTriggerAutoTopUp(school);
    } catch (err) {
        console.error(`[BillingService] Auto top-up check failed for school ${schoolId}:`, err.message);
    }

    return { deducted: minutes, balanceAfter: next };
}

/**
 * Check if a school's balance is below the auto top-up threshold, and trigger a charge if so.
 * Called after every minute deduction.
 */
async function checkAndTriggerAutoTopUp(school) {
    // Re-fetch fresh state to avoid race conditions
    const freshSchool = await School.findById(school._id);
    if (!freshSchool) return;

    // Only trigger if auto top-up is enabled and school is metered
    if (!freshSchool.autoTopUpEnabled || freshSchool.billingMode !== 'metered') return;

    const balance = typeof freshSchool.minuteBalance === 'number' ? freshSchool.minuteBalance : 0;
    const threshold = freshSchool.autoTopUpThreshold || 0;
    const amountMinutes = freshSchool.autoTopUpAmountMinutes || 50;

    // Check if balance is at or below threshold
    if (balance > threshold) return;

    // Prevent negative balances — if we're already negative and auto top-up is failing, suspend
    if (balance < 0) {
        const lastFailed = freshSchool.autoTopUpFailedAt;
        const cooldownMs = 30 * 60 * 1000; // 30 min cooldown between retries
        if (lastFailed && (Date.now() - new Date(lastFailed).getTime()) < cooldownMs) {
            console.warn(`[BillingService] Auto top-up cooling down for ${freshSchool.name} — last attempt failed at ${lastFailed}`);
            return;
        }
    }

    console.log(`[BillingService] Auto top-up triggered for ${freshSchool.name}: balance=${balance}, threshold=${threshold}, amount=${amountMinutes}min`);

    // Calculate USD amount
    const usdAmount = computeTopupUsd(amountMinutes);

    try {
        // Use PayPal to process the auto top-up
        const { createOrder } = require('./paypalService');
        const order = await createOrder({
            amountUsd: usdAmount,
            currency: 'USD',
            customId: freshSchool._id.toString(),
            description: `Auto top-up: ${amountMinutes} minutes for ${freshSchool.name}`,
        });

        if (!order || !order.id) {
            throw new Error('PayPal order creation failed');
        }

        // Capture the order immediately (auto-pay)
        const { captureOrder } = require('./paypalService');
        const capture = await captureOrder(order.id);

        if (!capture || capture.status !== 'COMPLETED') {
            throw new Error(`PayPal capture failed: ${capture?.status || 'unknown'}`);
        }

        // Grant the minutes
        await grantMinutes(freshSchool._id, amountMinutes, 'auto_topup', {
            paypalOrderId: order.id,
            usdAmount,
            triggeredBy: 'auto_topup_system',
        });

        // Reset failed timestamp
        freshSchool.autoTopUpFailedAt = null;
        await freshSchool.save();

        console.log(`[BillingService] ✅ Auto top-up successful: ${amountMinutes}min added to ${freshSchool.name} ($${usdAmount})`);

        // Try to send confirmation to admin
        try {
            const { dispatchAlert } = require('./alertService');
            await dispatchAlert(
                `Auto Top-Up — ${freshSchool.name}`,
                `School: ${freshSchool.name}\n` +
                `Minutes added: ${amountMinutes}\n` +
                `Amount charged: $${usdAmount.toFixed(2)}\n` +
                `Previous balance: ${balance}\n` +
                `New balance: ${balance + amountMinutes}`,
                freshSchool._id
            );
        } catch (alertErr) {
            console.error('[BillingService] Failed to send auto top-up alert:', alertErr.message);
        }

    } catch (err) {
        console.error(`[BillingService] ❌ Auto top-up FAILED for ${freshSchool.name}:`, err.message);

        // Mark failure time
        freshSchool.autoTopUpFailedAt = new Date();
        await freshSchool.save();

        // If balance is negative, suspend outbound calls
        if (balance < 0) {
            try {
                const { dispatchAlert } = require('./alertService');
                await dispatchAlert(
                    `URGENT: Auto Top-Up Failed — ${freshSchool.name} (Balance Negative)`,
                    `School: ${freshSchool.name} (${freshSchool._id})\n` +
                    `Current balance: ${balance} minutes (NEGATIVE)\n` +
                    `Auto top-up amount attempted: ${amountMinutes} minutes ($${usdAmount.toFixed(2)})\n` +
                    `Error: ${err.message}\n\n` +
                    `ACTION REQUIRED: Outbound calls are at risk. Manually top up or check PayPal configuration.`,
                    freshSchool._id
                );
            } catch (alertErr) {
                console.error('[BillingService] Failed to send auto top-up failure alert:', alertErr.message);
            }
        }
    }
}

async function applyMonthlyPlanAllocation(schoolId) {
    const school = await School.findById(schoolId);
    if (!school || !school.subscriptionPlanKey) return null;
    const def = getPlanDef(school.subscriptionPlanKey);
    if (!def) return null;
    return grantMinutes(schoolId, def.includedMinutesPerMonth, 'monthly_allocation', {
        planKey: school.subscriptionPlanKey,
    });
}

async function recordTransaction({
    schoolId,
    type,
    amount,
    currency,
    status,
    paypalEventId,
    paypalSubscriptionId,
    paypalOrderId,
    paypalSaleId,
    planKey,
    description,
    rawEventType,
}) {
    if (paypalEventId) {
        const dup = await BillingTransaction.findOne({ paypalEventId }).lean();
        if (dup) return dup;
    }
    return BillingTransaction.create({
        schoolId,
        type,
        amount,
        currency: currency || 'USD',
        status: status || 'completed',
        paypalEventId: paypalEventId || '',
        paypalSubscriptionId: paypalSubscriptionId || '',
        paypalOrderId: paypalOrderId || '',
        paypalSaleId: paypalSaleId || '',
        planKey: planKey || '',
        description: description || '',
        rawEventType: rawEventType || '',
    });
}

module.exports = {
    grantMinutes,
    deductCallMinutes,
    applyMonthlyPlanAllocation,
    recordTransaction,
};
