const mongoose = require('mongoose');
require('dotenv').config();

// Connect to MongoDB
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/school-ai';

async function createIndexes() {
  try {
    await mongoose.connect(MONGODB_URI);
    console.log('Connected to MongoDB');

    const db = mongoose.connection.db;
    const collection = db.collection('elevenlabswebhooks');

    // Create compound indexes for daily-insights queries
    console.log('Creating index: { type: 1, schoolId: 1, received_at: -1 }');
    await collection.createIndex(
      { type: 1, schoolId: 1, received_at: -1 },
      { name: 'type_schoolId_received_at_idx' }
    );

    console.log('Creating index: { type: 1, schoolId: 1, received_at: -1, tour_booking_detected: 1, actionTaken: 1 }');
    await collection.createIndex(
      { type: 1, schoolId: 1, received_at: -1, tour_booking_detected: 1, actionTaken: 1 },
      { name: 'action_needed_query_idx' }
    );

    console.log('Creating index: { calledNumberDigits: 1, type: 1, received_at: -1 }');
    await collection.createIndex(
      { calledNumberDigits: 1, type: 1, received_at: -1 },
      { name: 'called_number_lookup_idx' }
    );

    console.log('Indexes created successfully');
  } catch (err) {
    console.error('Error creating indexes:', err);
    process.exit(1);
  } finally {
    await mongoose.disconnect();
    console.log('Disconnected from MongoDB');
  }
}

createIndexes();
