// Small shared pieces for the routes: pagination, a rate limiter, and the
// "who is this and do they have a profile" gate.

import { User } from './models/user.js';
import { viewerSub } from './auth.js';

/**
 * page/limit from a query string, clamped.
 *
 * Skip-based paging, because that is what the endpoints were specified as
 * (?page=1&limit=20). It drifts: a post written between two requests shifts
 * every later page down by one, so a reader can see a row twice. The local
 * feed in storage.js pages by a `before` timestamp for that reason, and this
 * accepts one too when the caller would rather have stability than page numbers.
 */
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

// Fixed-window counters, per process. One web instance is the whole deployment
// today, so a shared store would be a dependency bought for nothing; if the
// service ever scales past one instance this becomes per-instance and the
// numbers below want dividing.
const buckets = new Map();
let sweptAt = Date.now();

function sweep(now) {
    if (now - sweptAt < 60_000) return;
    sweptAt = now;
    for (const [k, b] of buckets) if (b.resetAt <= now) buckets.delete(k);
}

/** Express middleware: at most `max` requests per `windowMs` from one address. */
export function rateLimit(name, windowMs, max) {
    return function limiter(req, res, next) {
        const now = Date.now();
        sweep(now);
        const key = `${name}|${req.ip}`;
        let b = buckets.get(key);
        if (!b || b.resetAt <= now) {
            b = { n: 0, resetAt: now + windowMs };
            buckets.set(key, b);
        }
        b.n += 1;
        if (b.n > max) {
            const secs = Math.ceil((b.resetAt - now) / 1000);
            res.set('Retry-After', String(secs));
            res.status(429).json({ error: `Too many requests. Try again in ${secs}s.` });
            return;
        }
        next();
    };
}

/** The body for a 401. The verifier names the check that failed, which belongs
 *  in the logs rather than in a sentence a reader is shown, so it travels as
 *  `reason` and `error` says what to do about it. */
export function authRefusal(req) {
    const why = req.authError || '';
    let error = 'Sign-in required.';
    if (why === 'expired') error = 'That sign-in has expired. Sign in again.';
    else if (why.startsWith('JWKS')) error = 'The sign-in check is not available right now. Try again shortly.';
    else if (why) error = 'That sign-in was not accepted. Sign in again.';
    return { error, reason: why || null };
}

/** Resolve the caller's profile row. Attaches req.viewer and calls next(), or
 *  answers 401/409 itself. 409 rather than 404 when the token is good but no
 *  profile exists yet: the fix is to claim a handle, not to sign in again. */
export async function requireViewer(req, res, next) {
    const sub = await viewerSub(req);
    if (!sub) {
        res.status(401).json(authRefusal(req));
        return;
    }
    const user = await User.findOne({ authSub: sub });
    if (!user) {
        res.status(409).json({ error: 'No profile yet. Claim a handle first.', needsHandle: true });
        return;
    }
    req.viewer = user;
    next();
}

/** Same, but anonymous is allowed: req.viewer is null for a signed-out reader.
 *  Used by the feed, where a token only decides whether likes look pressed. */
export async function optionalViewer(req, res, next) {
    const sub = await viewerSub(req);
    req.viewer = sub ? await User.findOne({ authSub: sub }) : null;
    next();
}
