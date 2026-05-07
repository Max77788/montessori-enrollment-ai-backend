require('dotenv').config();
process.env.TZ = 'America/Chicago'; // Force global execution context to CST timezone
const express = require('express');
const compression = require('compression');
const cors = require('cors');
const { connectDatabase, seedDatabase } = require('./src/database');

const authRoutes = require('./src/routes/auth');
const adminRoutes = require('./src/routes/admin');
const schoolRoutes = require('./src/routes/school');
const voiceRoutes = require('./src/routes/voice');
const integrationRoutes = require('./src/routes/integrations');
const translateRoutes = require('./src/routes/translate');
const publicRoutes = require('./src/routes/public');
const webhookRoutes = require('./src/routes/webhook');
const billingRoutes = require('./src/routes/billing');
const paypalWebhookRoutes = require('./src/routes/paypalWebhook');
const vapiWebhookRoutes = require('./src/routes/vapiWebhook');
const vapiInboundRoutes = require('./src/routes/vapiInbound');

const app = express();
const PORT = process.env.PORT || 5001;

// CORS: allow env CORS_ORIGINS (comma-separated) in production, else auto-detect
const corsOrigins = process.env.CORS_ORIGINS
    ? process.env.CORS_ORIGINS.split(',').map(s => s.trim()).filter(Boolean)
    : (() => {
        const origins = ['http://localhost:5173', 'http://localhost:3000', 'http://localhost:5001'];
        // Auto-include FRONTEND_URL if set
        if (process.env.FRONTEND_URL) origins.push(process.env.FRONTEND_URL);
        if (process.env.FORM_BASE_URL) origins.push(process.env.FORM_BASE_URL);
        return origins;
    })();
app.use(cors({
    origin: (origin, callback) => {
        // Allow requests with no origin (server-to-server, curl, etc.)
        if (!origin) return callback(null, true);
        if (corsOrigins.includes(origin)) return callback(null, true);
        // In production without explicit CORS_ORIGINS, allow any *.vercel.app or *.onrender.com
        if (!process.env.CORS_ORIGINS && (
            origin.endsWith('.vercel.app') ||
            origin.endsWith('.onrender.com') ||
            origin.includes('localhost')
        )) {
            return callback(null, true);
        }
        callback(new Error(`Origin ${origin} not allowed by CORS`));
    },
    credentials: true,
}));
app.use(compression());
app.use('/api/v1/webhook/paypal', express.raw({ type: 'application/json' }), paypalWebhookRoutes);
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/school', schoolRoutes);
app.use('/api/voice', voiceRoutes);
app.use('/api/integrations', integrationRoutes.router);
app.use('/api', translateRoutes);
app.use('/api/public', publicRoutes);
app.use('/api/v1/webhook', webhookRoutes);
app.use('/api/v1/webhook', vapiWebhookRoutes); // VAPI webhooks
app.use('/vapi', vapiInboundRoutes);            // VAPI inbound: /vapi/assistant-request, /vapi/webhook
app.use('/api/billing', billingRoutes);

// Health check
app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Connect to MongoDB and start server
async function start() {
    try {
        await connectDatabase();
        await seedDatabase();

        // Start background services
        const { initReminderService } = require('./src/services/reminderService');
        initReminderService();

        const { initAlertService } = require('./src/services/alertService');
        initAlertService();

        app.listen(PORT, () => {
            console.log(`\n🚀 Nest Ops Backend`);
            console.log(`   Server running on http://localhost:${PORT}`);
            console.log(`   Database: MongoDB`);
            console.log(`   API Health: http://localhost:${PORT}/api/health`);
            console.log(`\n📋 Default Credentials:`);
            console.log(`   Admin: admin@nestops.com / admin123`);
            console.log(`   School: sunshine@school.com / school123\n`);
        });
    } catch (err) {
        console.error('❌ Failed to start server:', err.message);
        process.exit(1);
    }
}

start();
