const mongoose = require('mongoose');

const phoneNumberSchema = new mongoose.Schema({
    phone_number_id: { type: String, required: true, unique: true },
    phone_number: { type: String, required: true },
    provider: { type: String, enum: ['sip_trunk', 'twilio', 'vapi'], default: 'twilio' },
    label: { type: String, default: '' },
    schoolId: { type: mongoose.Schema.Types.ObjectId, ref: 'School', default: null },
    twilioSid: { type: String, default: '' },
    vapiPhoneId: { type: String, default: '' },
    metadata: { type: mongoose.Schema.Types.Mixed, default: {} }
}, { timestamps: true });

module.exports = mongoose.model('PhoneNumber', phoneNumberSchema);
