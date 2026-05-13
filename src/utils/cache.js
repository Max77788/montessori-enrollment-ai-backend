/**
 * Simple in-memory cache with TTL.
 * Caches API responses to avoid repeated heavy DB queries.
 */
const cache = new Map();
const DEFAULT_TTL = 10000; // 10 seconds

function getCacheKey(req) {
    const schoolId = req.user?.schoolId || 'anon';
    const path = req.originalUrl || req.url;
    return `${schoolId}:${path}`;
}

function get(key) {
    const entry = cache.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
        cache.delete(key);
        return null;
    }
    return entry.data;
}

function set(key, data, ttl = DEFAULT_TTL) {
    cache.set(key, { data, expiresAt: Date.now() + ttl });
}

function middleware(ttl = DEFAULT_TTL) {
    return (req, res, next) => {
        const key = getCacheKey(req);
        const cached = get(key);
        if (cached) {
            return res.json(cached);
        }

        // Intercept res.json to cache the response
        const originalJson = res.json.bind(res);
        res.json = function (body) {
            set(key, body, ttl);
            return originalJson(body);
        };
        next();
    };
}

// Cleanup stale entries every 60s
setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of cache) {
        if (now > entry.expiresAt) cache.delete(key);
    }
}, 60000);

module.exports = { get, set, middleware, getCacheKey };
