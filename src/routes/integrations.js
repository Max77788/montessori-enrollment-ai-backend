require('dotenv').config();
const express = require('express');
const { google } = require('googleapis');
const msal = require('@azure/msal-node');
const Integration = require('../models/Integration');
const { createMsalCachePlugin } = require('../utils/msalTokenCache');

const router = express.Router();

/**
 * Resolve the frontend URL dynamically.
 * Priority: FRONTEND_URL env → FORM_BASE_URL env → Referer/origin from request → localhost fallback
 */
function getFrontendUrl(req) {
    if (process.env.FRONTEND_URL) return process.env.FRONTEND_URL;
    if (process.env.FORM_BASE_URL) return process.env.FORM_BASE_URL;
    // Try to derive from the referer/origin header
    const referer = req.get('Referer') || req.get('Origin') || '';
    if (referer && referer.includes('vercel.app')) {
        return referer.replace(/\/$/, '').replace(/\/school\/integrations.*/, '');
    }
    return 'http://localhost:5173';
}

// ── Google OAuth Configuration ──
const googleConfig = {
    clientId: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    redirectUri: process.env.GOOGLE_REDIRECT_URI,
};

function createGoogleOAuthClient() {
    return new google.auth.OAuth2(
        googleConfig.clientId,
        googleConfig.clientSecret,
        googleConfig.redirectUri
    );
}

function getGoogleAuthUrl(schoolId) {
    if (!googleConfig.clientId || !googleConfig.clientSecret) {
        return null; // Not configured
    }
    const oauth2Client = createGoogleOAuthClient();
    return oauth2Client.generateAuthUrl({
        access_type: 'offline',
        scope: [
            'https://www.googleapis.com/auth/calendar.events',
            'https://www.googleapis.com/auth/userinfo.email',
        ],
        state: schoolId.toString(),
        prompt: 'consent select_account',
    });
}

// ── Microsoft Outlook OAuth Configuration ──
const msalConfig = {
    auth: {
        clientId: process.env.OUTLOOK_CLIENT_ID || 'placeholder',
        authority: `https://login.microsoftonline.com/${process.env.OUTLOOK_TENANT_ID || 'common'}`,
        clientSecret: process.env.OUTLOOK_CLIENT_SECRET || 'placeholder',
    },
};

/**
 * Helper to get a school-specific MSAL ConfidentialClientApplication with persistent caching.
 */
function getMsalClient(schoolId) {
    if (!process.env.OUTLOOK_CLIENT_ID) return null;
    
    const clientConfig = {
        ...msalConfig,
        cache: {
            cachePlugin: createMsalCachePlugin(schoolId)
        }
    };
    return new msal.ConfidentialClientApplication(clientConfig);
}

// Keep a default instance for general use (like getting auth URL if schoolId is not yet known, though we usually have it)
let pca;
try {
    pca = new msal.ConfidentialClientApplication(msalConfig);
} catch (e) {
    console.warn('[Integrations] MSAL default init skipped:', e.message);
}

async function getOutlookAuthUrl(schoolId) {
    const schoolPca = getMsalClient(schoolId) || pca;
    if (!schoolPca) return null;

    const authCodeUrlParameters = {
        scopes: ['user.read', 'calendars.readwrite', 'offline_access'],
        redirectUri: process.env.OUTLOOK_REDIRECT_URI,
        state: schoolId.toString(),
        prompt: 'select_account',
    };
    return await schoolPca.getAuthCodeUrl(authCodeUrlParameters);
}

// ── Google OAuth Callback ──
router.get('/google/callback', async (req, res) => {
    const { code, state } = req.query;
    if (!code || !state) {
        return res.status(400).send('Missing code or state');
    }

    try {
        const schoolId = state;
        const oauth2Client = createGoogleOAuthClient();
        const { tokens } = await oauth2Client.getToken(code);
        oauth2Client.setCredentials(tokens);

        // Fetch user email from Google
        let userEmail = null;
        try {
            // Option 1: Try to get email from ID token
            if (tokens.id_token) {
                try {
                    const ticket = await oauth2Client.verifyIdToken({
                        idToken: tokens.id_token,
                        audience: googleConfig.clientId
                    });
                    const payload = ticket.getPayload();
                    userEmail = payload.email;
                } catch (idTokenErr) {
                    console.warn('[Integrations] Failed to verify ID token, trying userinfo API:', idTokenErr.message);
                }
            }

            // Option 2: Fallback to userinfo API
            if (!userEmail && tokens.access_token) {
                const axios = require('axios');
                const userInfoResponse = await axios.get('https://www.googleapis.com/oauth2/v2/userinfo', {
                    headers: {
                        Authorization: `Bearer ${tokens.access_token}`
                    }
                });
                userEmail = userInfoResponse.data.email;
            }
        } catch (emailErr) {
            console.error('[Integrations] Failed to fetch user email from Google:', emailErr.message);
            // Continue without email - connection still works, just won't have email stored
        }

        // Store integration with tokens and email
        const config = { tokens };
        if (userEmail) {
            config.userEmail = userEmail;
        }

        await Integration.findOneAndUpdate(
            { schoolId, type: 'google' },
            { 
                name: 'Google Workspace', 
                connected: true, 
                connectedAt: new Date(), 
                config 
            },
            { upsert: true }
        );

        res.redirect(`${getFrontendUrl(req)}/school/integrations?success=google`);
    } catch (err) {
        console.error('Google Callback Error:', err.message);

        // Detect specific Google OAuth errors for better diagnostics
        let errorCode = 'google';
        if (err.message?.includes('access_denied') || err.message?.includes('developer_email')) {
            errorCode = 'google_test_user';
            console.warn('[Integrations] Google OAuth requires test user registration. Add this email to Google Cloud Console → OAuth consent screen → Test users.');
        } else if (err.message?.includes('invalid_grant')) {
            errorCode = 'google_expired';
        }

        res.redirect(`${getFrontendUrl(req)}/school/integrations?error=${errorCode}`);
    }
});

// ── Outlook OAuth Callback ──
router.get('/outlook/callback', async (req, res) => {
    const { code, state, error, error_description } = req.query;
    if (error) {
        console.error('Outlook OAuth error:', error, error_description);
        return res.redirect(`${getFrontendUrl(req)}/school/integrations?error=outlook`);
    }
    if (!code || !state) {
        return res.redirect(`${getFrontendUrl(req)}/school/integrations?error=outlook`);
    }

    try {
        const schoolId = state;
        const schoolPca = getMsalClient(schoolId);
        if (!schoolPca) throw new Error('MSAL not configured');

        // Bug 1 Fix: Define tokenRequest before calling acquireTokenByCode
        const tokenRequest = {
            code,
            redirectUri: process.env.OUTLOOK_REDIRECT_URI,
            scopes: ['user.read', 'calendars.readwrite', 'offline_access'],
        };
        const response = await schoolPca.acquireTokenByCode(tokenRequest);

        await Integration.findOneAndUpdate(
            { schoolId, type: 'outlook' },
            {
                $set: {
                    name: 'Microsoft Outlook',
                    connected: true,
                    connectedAt: new Date(),
                    'config.account': response.account,
                    'config.accessToken': response.accessToken,
                    'config.expiresOn': response.expiresOn,
                    'config.scopes': response.scopes,
                }
            },
            { upsert: true }
        );

        // Success — the cache plugin (afterCacheAccess) already saved the MSAL cache (refresh token)
        // during the acquireTokenByCode call. Using $set above preserved it.
        console.log(`[Integrations] Outlook connected and config persisted for school: ${schoolId}`);

        res.redirect(`${getFrontendUrl(req)}/school/integrations?success=outlook`);
    } catch (err) {
        console.error('Outlook Callback Error:', err);
        res.redirect(`${getFrontendUrl(req)}/school/integrations?error=outlook`);
    }
});

module.exports = {
    router,
    getGoogleAuthUrl,
    getOutlookAuthUrl,
    getMsalClient,
    pca,
};
