const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const School = require('./models/School');
const User = require('./models/User');
const Integration = require('./models/Integration');
const ReferralLink = require('./models/ReferralLink');

async function connectDatabase() {
    const uri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/nest-ops';
    await mongoose.connect(uri);
    console.log('✅ Connected to MongoDB');
}

async function seedDatabase() {
    // Check if data already exists
    const userCount = await User.countDocuments();
    if (userCount > 0) {
        console.log('ℹ️  Database already seeded, skipping...');
        return;
    }

    console.log('🌱 Seeding database...');

    const adminPasswordHash = bcrypt.hashSync('admin123', 10);
    const schoolPasswordHash = bcrypt.hashSync('school123', 10);

    // Create schools
    const schoolsData = [
        { name: 'Sunshine Childcare', aiNumber: '+1 (555) 123-4567', routingNumber: '+1 (555) 123-4568', status: 'active' },
    ];

    const schools = await School.insertMany(schoolsData);

    // Create admin user
    await User.create({
        email: 'admin@nestops.com',
        passwordHash: adminPasswordHash,
        name: 'Admin',
        role: 'admin',
        schoolId: null,
    });

    // Create school users
    const schoolUsers = [
        { email: 'sunshine@school.com', name: 'Sunshine Admin', schoolId: schools[0]._id },
    ];

    await User.insertMany(
        schoolUsers.map(u => ({
            ...u,
            passwordHash: schoolPasswordHash,
            role: 'school',
        }))
    );

    // Create integrations for each school
    const integrations = [];
    schools.forEach(school => {
        integrations.push(
            { schoolId: school._id, type: 'outlook', name: 'Microsoft Outlook', connected: false },
            { schoolId: school._id, type: 'google', name: 'Google Workspace', connected: false },
        );
    });
    await Integration.insertMany(integrations);

    // Referral links for schools (no mock referrals)
    await ReferralLink.insertMany(
        schools.map(school => ({
            schoolId: school._id,
            code: `ref-${school.name.toLowerCase().replace(/\s+/g, '-')}`,
        }))
    );

    console.log('✅ Database seeded (users, schools, integrations). No mock call/followup data.');
}

module.exports = { connectDatabase, seedDatabase };
