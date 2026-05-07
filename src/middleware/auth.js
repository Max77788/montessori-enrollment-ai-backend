const jwt = require('jsonwebtoken');
const User = require('../models/User');

const JWT_SECRET = process.env.JWT_SECRET || 'nest-ops-secret-key-2026';

async function authMiddleware(req, res, next) {
    let token = null;
    const authHeader = req.headers.authorization;

    if (authHeader && authHeader.startsWith('Bearer ')) {
        token = authHeader.split(' ')[1];
    } else if (req.query.token) {
        token = req.query.token;
    }

    if (!token) {
        return res.status(401).json({ error: 'No token provided' });
    }

    try {
        const decoded = jwt.verify(token, JWT_SECRET);

        // IMPORTANT: Don't trust schoolId/role from old tokens.
        // Always hydrate from DB to prevent stale/incorrect tenant scoping.
        const user = await User.findById(decoded.id).select('email name role schoolId').lean();
        if (!user) {
            return res.status(401).json({ error: 'Invalid or expired token' });
        }

        req.user = {
            id: user._id.toString(),
            email: user.email,
            name: user.name,
            role: user.role,
            schoolId: user.schoolId ? user.schoolId.toString() : null,
        };
        next();
    } catch (err) {
        return res.status(401).json({ error: 'Invalid or expired token' });
    }
}

function adminOnly(req, res, next) {
    if (req.user.role !== 'admin') {
        return res.status(403).json({ error: 'Admin access required' });
    }
    next();
}

function schoolOnly(req, res, next) {
    if (req.user.role !== 'school') {
        return res.status(403).json({ error: 'School access required' });
    }
    next();
}

module.exports = { authMiddleware, adminOnly, schoolOnly };
