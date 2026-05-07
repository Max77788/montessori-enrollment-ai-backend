const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { OAuth2Client } = require('google-auth-library');
const User = require('../models/User');
const School = require('../models/School');
const Integration = require('../models/Integration');
const { authMiddleware } = require('../middleware/auth');
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
const JWT_SECRET = process.env.JWT_SECRET || 'nest-ops-secret-key-2026';

// Google OAuth2 Client for Authentication
// Use separate redirect URI for auth vs calendar integrations
const googleClientId = process.env.GOOGLE_CLIENT_ID;
const googleClientSecret = process.env.GOOGLE_CLIENT_SECRET;
// GOOGLE_AUTH_REDIRECT_URI for authentication (frontend), GOOGLE_REDIRECT_URI for calendar integrations (backend)
// If not set, construct from FORM_BASE_URL or default to localhost
const googleAuthRedirectUri = process.env.GOOGLE_AUTH_REDIRECT_URI
    || `${process.env.FRONTEND_URL || process.env.FORM_BASE_URL || 'http://localhost:5173'}/auth/google/callback`;

let oauth2Client = null;
if (googleClientId && googleClientSecret) {
    oauth2Client = new OAuth2Client(
        googleClientId,
        googleClientSecret,
        googleAuthRedirectUri
    );
}

// POST /api/auth/login
router.post('/login', async (req, res) => {
    try {
        const { email, password } = req.body;

        if (!email || !password) {
            return res.status(400).json({ error: 'Email and password are required' });
        }

        const user = await User.findOne({ email });
        if (!user) {
            return res.status(401).json({ error: 'Invalid email or password' });
        }

        // Check if user is OAuth-only (no password)
        if (user.authProvider === 'google' && !user.passwordHash) {
            return res.status(401).json({ error: 'This account uses Google sign-in. Please sign in with Google instead.' });
        }

        if (!user.passwordHash) {
            return res.status(401).json({ error: 'Invalid email or password' });
        }

        const validPassword = bcrypt.compareSync(password, user.passwordHash);
        if (!validPassword) {
            return res.status(401).json({ error: 'Invalid email or password' });
        }

        const token = jwt.sign(
            {
                id: user._id.toString(),
                email: user.email,
                name: user.name,
                role: user.role,
                schoolId: user.schoolId ? user.schoolId.toString() : null,
            },
            JWT_SECRET,
            { expiresIn: '24h' }
        );

        res.json({
            token,
            user: {
                id: user._id.toString(),
                email: user.email,
                name: user.name,
                role: user.role,
                schoolId: user.schoolId ? user.schoolId.toString() : undefined,
            },
        });
    } catch (err) {
        console.error('Login error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// GET /api/auth/me
router.get('/me', authMiddleware, async (req, res) => {
    try {
        const user = await User.findById(req.user.id).select('-passwordHash');
        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }
        res.json({
            id: user._id.toString(),
            email: user.email,
            name: user.name,
            role: user.role,
            schoolId: user.schoolId ? user.schoolId.toString() : undefined,
        });
    } catch (err) {
        console.error('Auth me error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// POST /api/auth/register
router.post('/register', async (req, res) => {
    try {
        const { email, password, name, schoolName, address } = req.body;

        if (!email || !password || !name || !schoolName) {
            return res.status(400).json({ error: 'All fields are required.' });
        }

        // 1. Check if user already exists
        const existingUser = await User.findOne({ email });
        if (existingUser) {
            return res.status(400).json({ error: 'Email already registered.' });
        }

        // 2. Create the school with default AI settings for UI visibility
        const defaultSystemPrompt = NORA_SYSTEM_PROMPT_TEMPLATE.replace(/{{SCHOOL_NAME}}/g, schoolName);
        const defaultFirstMessage = DEFAULT_FIRST_MESSAGE_TEMPLATE.replace(/{{SCHOOL_NAME}}/g, schoolName);

        const school = await School.create({
            name: schoolName,
            address: address || '',
            status: 'active',
            systemPrompt: defaultSystemPrompt,
            script: defaultFirstMessage
        });

        // 2b. Generate Knowledge Base for the school (if any qaPairs exist)
        let knowledgeBaseId = null;
        if (school.qaPairs && school.qaPairs.length > 0) {
            const kbText = formatQAPairsForKB(school.qaPairs);
            if (kbText) {
                knowledgeBaseId = await ingestKnowledgeBaseDocument(kbText, schoolName);
                if (knowledgeBaseId) {
                    school.knowledgeBaseDocumentId = knowledgeBaseId;
                    await school.save();
                }
            }
        }

        // 2c. Create ElevenLabs Agent for the school
        const agentId = await createSchoolAgent(schoolName, school.knowledgeBaseDocumentId);
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
                console.log(`[Register] Tools linked to Agent ${agentId}:`, [toolId, globalTimeToolId]);
            }

            await school.save();
        }

        // 3. Create the user
        const hashedPassword = bcrypt.hashSync(password, 10);
        const user = await User.create({
            email,
            passwordHash: hashedPassword,
            name,
            role: 'school',
            schoolId: school._id
        });

        // 4. Initialize integrations
        await Integration.insertMany([
            { schoolId: school._id, type: 'google', name: 'Google Workspace', connected: false },
            { schoolId: school._id, type: 'outlook', name: 'Microsoft Outlook', connected: false }
        ]);

        // 5. Generate token (auto-login after registration)
        const token = jwt.sign(
            {
                id: user._id.toString(),
                email: user.email,
                name: user.name,
                role: user.role,
                schoolId: user.schoolId ? user.schoolId.toString() : null,
            },
            JWT_SECRET,
            { expiresIn: '24h' }
        );

        res.status(201).json({
            message: 'Registration successful!',
            token,
            user: {
                id: user._id.toString(),
                email: user.email,
                name: user.name,
                role: user.role,
                schoolId: user.schoolId ? user.schoolId.toString() : undefined,
            },
        });
    } catch (err) {
        console.error('Registration error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// GET /api/auth/google/url - Get Google OAuth URL
router.get('/google/url', (req, res) => {
    try {
        if (!oauth2Client) {
            return res.status(400).json({ error: 'Google OAuth is not configured' });
        }

        const scopes = [
            'https://www.googleapis.com/auth/userinfo.email',
            'https://www.googleapis.com/auth/userinfo.profile'
        ];

        const authUrl = oauth2Client.generateAuthUrl({
            access_type: 'offline',
            scope: scopes,
            prompt: 'consent',
            state: req.query.mode || 'signin' // 'signin' or 'signup'
        });

        res.json({ authUrl });
    } catch (err) {
        console.error('Google OAuth URL error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// POST /api/auth/google/callback - Handle Google OAuth callback
router.post('/google/callback', async (req, res) => {
    try {
        if (!oauth2Client) {
            return res.status(400).json({ error: 'Google OAuth is not configured' });
        }

        const { code, mode } = req.body; // mode: 'signin' or 'signup'

        if (!code) {
            return res.status(400).json({ error: 'Authorization code is required' });
        }

        // Exchange code for tokens
        const { tokens } = await oauth2Client.getToken(code);
        oauth2Client.setCredentials(tokens);

        let googleId, email, name, picture;

        // Try to get user info from ID token first
        if (tokens.id_token) {
            try {
                const ticket = await oauth2Client.verifyIdToken({
                    idToken: tokens.id_token,
                    audience: googleClientId
                });
                const payload = ticket.getPayload();
                googleId = payload.sub;
                email = payload.email;
                name = payload.name || payload.given_name || 'User';
                picture = payload.picture;
            } catch (err) {
                console.warn('Failed to verify ID token, falling back to userinfo API:', err.message);
            }
        }

        // Fallback: Use Google's userinfo API if ID token verification failed
        if (!email && tokens.access_token) {
            try {
                const axios = require('axios');
                const userInfoResponse = await axios.get('https://www.googleapis.com/oauth2/v2/userinfo', {
                    headers: {
                        Authorization: `Bearer ${tokens.access_token}`
                    }
                });
                const userInfo = userInfoResponse.data;
                googleId = userInfo.id;
                email = userInfo.email;
                name = userInfo.name || userInfo.given_name || 'User';
                picture = userInfo.picture;
            } catch (err) {
                console.error('Failed to fetch user info from Google API:', err);
                return res.status(500).json({ error: 'Failed to retrieve user information from Google' });
            }
        }

        if (!email) {
            return res.status(400).json({ error: 'Email not provided by Google' });
        }

        // Check if user exists
        let user = await User.findOne({
            $or: [
                { email },
                { googleId }
            ]
        });

        if (user) {
            // Existing user - sign in
            if (mode === 'signup') {
                return res.status(400).json({ error: 'An account with this email already exists. Please sign in instead.' });
            }

            // Update user with Google ID if not set
            if (!user.googleId) {
                user.googleId = googleId;
                user.authProvider = 'google';
                await user.save();
            }

            // Generate JWT token
            const token = jwt.sign(
                {
                    id: user._id.toString(),
                    email: user.email,
                    name: user.name,
                    role: user.role,
                    schoolId: user.schoolId ? user.schoolId.toString() : null,
                },
                JWT_SECRET,
                { expiresIn: '24h' }
            );

            return res.json({
                token,
                user: {
                    id: user._id.toString(),
                    email: user.email,
                    name: user.name,
                    role: user.role,
                    schoolId: user.schoolId ? user.schoolId.toString() : undefined,
                },
            });
        } else {
            // New user - sign up (only for school role)
            if (mode === 'signin') {
                return res.status(404).json({ error: 'No account found with this email. Please sign up first.' });
            }

            // For signup, we need school information
            // If schoolName is provided in the request, create school and user
            const { schoolName, address } = req.body;

            if (!schoolName) {
                return res.json({
                    requiresSchoolInfo: true,
                    email,
                    name,
                    googleId
                });
            }

            // Create school
            // Create school with default AI settings for UI visibility
            const defaultSystemPrompt = NORA_SYSTEM_PROMPT_TEMPLATE.replace(/{{SCHOOL_NAME}}/g, schoolName);
            const defaultFirstMessage = DEFAULT_FIRST_MESSAGE_TEMPLATE.replace(/{{SCHOOL_NAME}}/g, schoolName);

            const school = await School.create({
                name: schoolName,
                address: address || '',
                status: 'active',
                systemPrompt: defaultSystemPrompt,
                script: defaultFirstMessage
            });

            // Generate Knowledge Base
            let knowledgeBaseId = null;
            if (school.qaPairs && school.qaPairs.length > 0) {
                const kbText = formatQAPairsForKB(school.qaPairs);
                if (kbText) {
                    knowledgeBaseId = await ingestKnowledgeBaseDocument(kbText, schoolName);
                    if (knowledgeBaseId) {
                        school.knowledgeBaseDocumentId = knowledgeBaseId;
                        await school.save();
                    }
                }
            }

            // Create ElevenLabs Agent for the school
            const agentId = await createSchoolAgent(schoolName, school.knowledgeBaseDocumentId);
            if (agentId) {
                school.elevenlabsAgentId = agentId;

                // Register booked-slots tool
                const toolId = await registerTool(school._id.toString(), agentId);
                if (toolId) {
                    const globalTimeToolId = "tool_1801kmyr9pdpemts5qr0f1xys3yy";
                    await patchAgentPrompt(agentId, {
                        tool_ids: [toolId, globalTimeToolId],
                        post_call_webhook_url: "https://montessori-enrollment-ai-backend.onrender.com/api/v1/webhook/elevenlabs",
                        voice_id: "jqcCZkN6Knx8BJ5TBdYR",
                    });
                }

                await school.save();
            }

            // Create user with Google OAuth
            user = await User.create({
                email,
                name,
                role: 'school',
                schoolId: school._id,
                googleId,
                authProvider: 'google',
                passwordHash: null // No password for OAuth users
            });

            // Initialize integrations
            await Integration.insertMany([
                { schoolId: school._id, type: 'google', name: 'Google Workspace', connected: false },
                { schoolId: school._id, type: 'outlook', name: 'Microsoft Outlook', connected: false }
            ]);

            // Generate JWT token
            const token = jwt.sign(
                {
                    id: user._id.toString(),
                    email: user.email,
                    name: user.name,
                    role: user.role,
                    schoolId: user.schoolId ? user.schoolId.toString() : null,
                },
                JWT_SECRET,
                { expiresIn: '24h' }
            );

            return res.status(201).json({
                message: 'Registration successful!',
                token,
                user: {
                    id: user._id.toString(),
                    email: user.email,
                    name: user.name,
                    role: user.role,
                    schoolId: user.schoolId ? user.schoolId.toString() : undefined,
                },
            });
        }
    } catch (err) {
        console.error('Google OAuth callback error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// POST /api/auth/google/complete-signup - Complete signup after Google OAuth (when school info is needed)
router.post('/google/complete-signup', async (req, res) => {
    try {
        const { email, name, googleId, schoolName, address } = req.body;

        if (!email || !name || !googleId || !schoolName) {
            return res.status(400).json({ error: 'All fields are required' });
        }

        // Check if user already exists
        const existingUser = await User.findOne({
            $or: [
                { email },
                { googleId }
            ]
        });

        if (existingUser) {
            return res.status(400).json({ error: 'User already exists' });
        }

        // Create school
        // Create school with default AI settings for UI visibility
        const defaultSystemPrompt = NORA_SYSTEM_PROMPT_TEMPLATE.replace(/{{SCHOOL_NAME}}/g, schoolName);
        const defaultFirstMessage = DEFAULT_FIRST_MESSAGE_TEMPLATE.replace(/{{SCHOOL_NAME}}/g, schoolName);

        const school = await School.create({
            name: schoolName,
            address: address || '',
            status: 'active',
            systemPrompt: defaultSystemPrompt,
            script: defaultFirstMessage
        });

        // Generate Knowledge Base
        let knowledgeBaseId = null;
        if (school.qaPairs && school.qaPairs.length > 0) {
            const kbText = formatQAPairsForKB(school.qaPairs);
            if (kbText) {
                knowledgeBaseId = await ingestKnowledgeBaseDocument(kbText, schoolName);
                if (knowledgeBaseId) {
                    school.knowledgeBaseDocumentId = knowledgeBaseId;
                    await school.save();
                }
            }
        }

        // Create ElevenLabs Agent for the school
        const agentId = await createSchoolAgent(schoolName, school.knowledgeBaseDocumentId);
        if (agentId) {
            school.elevenlabsAgentId = agentId;

            // Register booked-slots tool
            const toolId = await registerTool(school._id.toString(), agentId);
            if (toolId) {
                const globalTimeToolId = "tool_1801kmyr9pdpemts5qr0f1xys3yy";
                await patchAgentPrompt(agentId, {
                    tool_ids: [toolId, globalTimeToolId],
                    post_call_webhook_url: "https://montessori-enrollment-ai-backend.onrender.com/api/v1/webhook/elevenlabs",
                    voice_id: "jqcCZkN6Knx8BJ5TBdYR",
                });
            }

            await school.save();
        }

        // Create user
        const user = await User.create({
            email,
            name,
            role: 'school',
            schoolId: school._id,
            googleId,
            authProvider: 'google',
            passwordHash: null
        });

        // Initialize integrations
        await Integration.insertMany([
            { schoolId: school._id, type: 'google', name: 'Google Workspace', connected: false },
            { schoolId: school._id, type: 'outlook', name: 'Microsoft Outlook', connected: false }
        ]);

        // Generate JWT token
        const token = jwt.sign(
            {
                id: user._id.toString(),
                email: user.email,
                name: user.name,
                role: user.role,
                schoolId: user.schoolId ? user.schoolId.toString() : null,
            },
            JWT_SECRET,
            { expiresIn: '24h' }
        );

        res.status(201).json({
            message: 'Registration successful!',
            token,
            user: {
                id: user._id.toString(),
                email: user.email,
                name: user.name,
                role: user.role,
                schoolId: user.schoolId ? user.schoolId.toString() : undefined,
            },
        });
    } catch (err) {
        console.error('Complete Google signup error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

module.exports = router;
