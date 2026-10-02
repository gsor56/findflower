import { User } from './models/user.js';
import { sessionUser } from './session.js';

export async function resolveViewerSub(req) {
    const session = sessionUser(req);
    return session && session.sub ? session.sub : null;
}

export function pageParams(query, defLimit, maxLimit) {
    const page = Math.max(1, parseInt(query.page, 10) || 1);
    const asked = parseInt(query.limit, 10) || defLimit;
    const limit = Math.min(maxLimit, Math.max(1, asked));
    const before = query.before ? new Date(query.before) : null;

    return {
        page,
        limit,
        skip: (page - 1) * limit,
        before: before && !Number.isNaN(before.getTime()) ? before : null,
    };
}

const buckets = new Map();
let sweptAt = Date.now();

function sweep(now) {
    if (now - sweptAt < 60_000) return;
    sweptAt = now;

    for (const [key, bucket] of buckets) {
        if (bucket.resetAt <= now) buckets.delete(key);
    }
}

export function rateLimit(name, windowMs, max) {
    return function limiter(req, res, next) {
        const now = Date.now();
        sweep(now);

        const key = `${name}|${req.ip}`;
        let bucket = buckets.get(key);

        if (!bucket || bucket.resetAt <= now) {
            bucket = { n: 0, resetAt: now + windowMs };
            buckets.set(key, bucket);
        }

        bucket.n += 1;

        if (bucket.n > max) {
            const seconds = Math.ceil((bucket.resetAt - now) / 1000);
            res.set('Retry-After', String(seconds));
            res.status(429).json({
                error: `Too many requests. Try again in ${seconds}s.`,
            });
            return;
        }

        next();
    };
}

export function authRefusal(req) {
    const reason = req.authError || '';
    let error = 'Sign-in required.';

    if (reason === 'expired') {
        error = 'That sign-in has expired. Sign in again.';
    } else if (reason.startsWith('JWKS')) {
        error = 'The sign-in check is not available right now. Try again shortly.';
    } else if (reason) {
        error = 'That sign-in was not accepted. Sign in again.';
    }

    return {
        error,
        reason: reason || null,
    };
}

export async function requireViewer(req, res, next) {
    const sub = await resolveViewerSub(req);

    if (!sub) {
        res.status(401).json(authRefusal(req));
        return;
    }

    const user = await User.findOne({ authSub: sub });

    if (!user) {
        res.status(409).json({
            error: 'No profile yet. Claim a handle first.',
            needsHandle: true,
        });
        return;
    }

    req.viewer = user;
    next();
}

export async function optionalViewer(req, res, next) {
    const sub = await resolveViewerSub(req);
    req.viewer = sub ? await User.findOne({ authSub: sub }) : null;
    next();
}

/** Consent gate. Runs after attachViewer on protected page routes. If the user
 *  is signed in and has a profile but has not accepted the current terms, they
 *  are redirected to /consent. API callers get a 403 instead. The gate skips
 *  anonymous visitors, users without a profile (they will hit the handle-claim
 *  flow first), and the consent page itself. */
export function requireConsent(req, res, next) {
    if (!req.viewer) { next(); return; }
    if (req.viewer.termsAccepted) { next(); return; }
    if (req.path === '/consent') { next(); return; }
    if (req.accepts('html') && !req.path.startsWith('/api/')) {
        res.redirect(302, '/consent');
        return;
    }
    res.status(403).json({ error: 'You must accept the Terms of Service before using this feature.', redirect: '/consent' });
}
