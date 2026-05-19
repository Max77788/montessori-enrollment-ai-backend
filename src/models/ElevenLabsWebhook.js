const mongoose = require('mongoose');

const elevenLabsWebhookSchema = new mongoose.Schema({
    type: { type: String, required: true }, // 'post_call_transcription' or 'post_call_audio'
    conversation_id: { type: String, required: true, index: true },
    agent_id: { type: String, default: '' },
    agent_name: { type: String, default: '' },
    user_id: { type: String, default: '' }, // phone number
    transcript: { type: mongoose.Schema.Types.Mixed, default: null }, // array for transcription webhooks
    audio_base64: { type: String, default: '' }, // base64 encoded audio for audio webhooks
    metadata: { type: mongoose.Schema.Types.Mixed, default: {} }, // full metadata object
    status: { type: String, default: '' },
    raw_payload: { type: mongoose.Schema.Types.Mixed, default: {} }, // store full webhook payload for debugging
    processed: { type: Boolean, default: false },
    received_at: { type: Date, default: Date.now },
    // AI-processed fields
    summary: { type: String, default: '' }, // OpenAI-generated summary
    tour_booking_detected: { type: Boolean, default: false }, // whether a tour booking was detected
    tour_booking_date: { type: Date, default: null }, // extracted tour booking date/time
    tour_booking_extracted: { type: mongoose.Schema.Types.Mixed, default: null }, // full extracted booking info
    ai_processed: { type: Boolean, default: false }, // whether AI processing is complete
    schoolId: { type: mongoose.Schema.Types.ObjectId, ref: 'School', index: true }, // link to the school
    calledNumberDigits: { type: String, default: '', index: true }, // last 10 digits of called number — denormalized for fast lookups
    extractedTags: { type: [String], default: [] }, // AI-extracted tags from transcript
    actionTaken: { type: Boolean, default: false }, // whether action has been taken
    actionTakenAt: { type: Date, default: null }, // when action was taken
    actionTakenFeedback: { type: String, default: '' }, // latest feedback
    actionTakenBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null }, // who took action
    feedbackHistory: { type: [new mongoose.Schema({
        feedback: { type: String, required: true },
        timestamp: { type: Date, default: Date.now },
        userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
    })], default: [] }, // history of all feedback entries
}, { timestamps: true });

// Index for faster lookups
elevenLabsWebhookSchema.index({ conversation_id: 1, type: 1 });
elevenLabsWebhookSchema.index({ received_at: -1 });
// Compound indexes for daily-insights and action-needed queries
elevenLabsWebhookSchema.index({ type: 1, schoolId: 1, received_at: -1 });
elevenLabsWebhookSchema.index({ type: 1, schoolId: 1, received_at: -1, tour_booking_detected: 1, actionTaken: 1 });

module.exports = mongoose.model('ElevenLabsWebhook', elevenLabsWebhookSchema);

