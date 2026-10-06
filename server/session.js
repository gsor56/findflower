// Server-side Auth0 session wiring for the SSR application.
//
// The browser no longer owns the login flow. express-openid-connect performs
// the OIDC dance, validates the session cookie on every request, and exposes
// the user on req.oidc. A non-browser client has no cookie to send and no way
// to get one, so the API also accepts an Auth0 access token as a bearer
// credential -- see bearerAuth below -- while same-origin pages keep using the
// session cookie, which always wins when both are present.

import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { auth } from 'express-openid-connect';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import dotenv from 'dotenv';

// Load local deployment variables before reading any Auth0 setting. `index.js`
// also imports db.js, but relying on a sibling module's dotenv side effect
// makes ESM evaluation order part of authentication correctness.
const HERE = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: [path.join(HERE, '.env'), path.join(HERE, '..', '.env')], quiet: true });

const AUTH0_DOMAIN = process.env.AUTH0_DOMAIN || 'dev-jvit0r04itv8hfjz.us.auth0.com';
const AUTH0_CLIENT_ID = process.env.AUTH0_CLIENT_ID || '9sWXgo4TtCodcmnfdr6vcSRighhkVXMy';
const AUTH0_AUDIENCE = process.env.AUTH0_AUDIENCE || 'https://api.findflower.me';
const AUTH0_ISSUER = process.env.AUTH0_ISSUER || process.env.AUTH0_ISSUER_BASE_URL;
// The confidential-client secret. The OIDC middleware needs it to exchange the
// authorization code at /callback, and left to itself it reads only the env var
// named exactly CLIENT_SECRET. Wiring it here means AUTH0_CLIENT_SECRET -- the
// name the rest of this service documents -- works as well.
const AUTH0_CLIENT_SECRET = process.env.AUTH0_CLIENT_SECRET || process.env.CLIENT_SECRET;
// Auth0's Regular Web Application default is "Post". Keep this overridable
// for tenants explicitly configured for HTTP Basic, but match the dashboard client's
// token-endpoint setting out of the box.
const AUTH0_CLIENT_AUTH_METHOD = process.env.AUTH0_CLIENT_AUTH_METHOD || 'client_secret_post';
const PORT = Number(process.env.PORT || process.env.SERVER_PORT) || 24729;

const configuredSecret = process.env.AUTH0_SECRET || process.env.SESSION_SECRET;
const isProduction = process.env.NODE_ENV === 'production';
const devSecret = crypto.createHash('sha256')
    .update(process.env.MONGO_URI || 'findflower-local-session')
    .digest('hex');
const secret = configuredSecret || devSecret;

// The public origin Auth0 redirects back to, and therefore the host in
// `redirect_uri`. Left unset on a production container this silently becomes
// `http://localhost:<port>`, which fails twice over: Auth0 rejects the callback
// as unregistered, and the transaction cookie the flow sets alongside it is
// `SameSite=None; Secure`, which no browser will store over http. Defaulting to
// the one public origin this service serves turns that into a working login.
const AUTH0_BASE_URL = process.env.AUTH0_BASE_URL
    || process.env.FF_PUBLIC_URL
    || (isProduction ? 'https://findflower.me' : `http://localhost:${PORT}`);
const secureCookies = AUTH0_BASE_URL.startsWith('https://');
if (isProduction && !configuredSecret) {
    console.warn('[auth] AUTH0_SECRET is not set; using a derived development secret. Set it in HidenCloud before production traffic.');
}

export const sessionEnabled = Boolean(configuredSecret) || !isProduction;

// `response_type` is not a taste question. The library defaults it to
// `id_token`, and that one default does three harmful things at once: it treats
// this as a public client so the client secret is never sent, it forces
// `response_mode=form_post`, and form_post in turn forces the transaction
// cookie to `SameSite=None; Secure` -- which an http origin cannot use, so the
// state that /callback checks against is gone by the time Auth0 redirects back.
// A confidential web app wants the authorization code flow: it authenticates
// with the secret, enables PKCE, and leaves the cookie on `SameSite=Lax`, which
// still arrives on the top-level GET back from Auth0.
//
// The flow follows whether a secret exists rather than being hardcoded. With no
// secret the library rejects the code flow outright, and throwing here would
// take down every page instead of just the sign-in.
const confidential = Boolean(AUTH0_CLIENT_SECRET);

if (!confidential) {
    console.warn('[auth] AUTH0_CLIENT_SECRET is not set, so sign-in falls back to the id_token flow and will not complete. Set it in HidenCloud.');
}

// The three values that break sign-in are all invisible from outside the
// container, and its log is the only place to see them.
console.log(`[auth] tenant=${AUTH0_DOMAIN} baseURL=${AUTH0_BASE_URL} audience=${AUTH0_AUDIENCE} flow=${confidential ? 'code' : 'id_token'} clientAuth=${confidential ? AUTH0_CLIENT_AUTH_METHOD : 'none'} sessionSecret=${configuredSecret ? 'set' : 'derived'}`);

// No `customFetch` here. express-openid-connect validates its options with a Joi
// schema that rejects unknown keys, and v2 -- the version package.json pins --
// has no such option, so passing it threw `TypeError: "customFetch" is not
// allowed` while the module loaded and took the whole container down with it.
// Nothing is lost: the token-exchange diagnostics it was there for live in the
// app's own error handler (see the /callback handler in index.js), which reports
// the provider's error fields plus the forwarded host, proto and transaction
// cookie, and persists them to .auth-callback-error.json.
export const oidc = auth({
    authRequired: false,
    auth0Logout: true,
    baseURL: AUTH0_BASE_URL,
    clientID: AUTH0_CLIENT_ID,
    ...(confidential ? { clientSecret: AUTH0_CLIENT_SECRET } : {}),
    ...(confidential ? { clientAuthMethod: AUTH0_CLIENT_AUTH_METHOD } : {}),
    issuerBaseURL: AUTH0_ISSUER || `https://${AUTH0_DOMAIN}/`,
    secret,
    routes: {
        login: '/login',
        logout: '/logout',
        callback: '/callback',
        postLogoutRedirect: '/',
    },
    authorizationParams: {
        ...(confidential ? { response_type: 'code', response_mode: 'query' } : {}),
        audience: AUTH0_AUDIENCE,
        scope: 'openid profile email',
    },
    session: {
        name: 'ff_session',
        cookie: {
            httpOnly: true,
            sameSite: 'Lax',
            // HidenCloud does not set NODE_ENV=production by default. Cookie
            // security follows the public URL instead, which removes the OIDC
            // warning and keeps the session bound to HTTPS behind Cloudflare.
            // This service is deployed behind HTTPS Cloudflare even though
            // the HidenCloud origin hop is plaintext.
            secure: secureCookies,
        },
    },
});

// The JWT `iss` claim Auth0 mints carries a trailing slash, and both the JWKS
// document and /userinfo hang off that same base. Normalising it once keeps the
// three from drifting apart when AUTH0_ISSUER arrives with or without the slash.
const AUTH0_ISSUER_URL = (() => {
    const raw = AUTH0_ISSUER || `https://${AUTH0_DOMAIN}/`;
    return raw.endsWith('/') ? raw : `${raw}/`;
})();

// ---------------------------------------------------------------------------
// Bearer credentials for clients that cannot hold a cookie.
//
// The native app has no cookie jar for findflower.me, so the session cookie
// minted above is unreachable from it. It sends the Auth0 access token it
// obtained through the system browser instead, and this block turns that token
// into the same { sub, name, email, picture } shape the cookie path produces.
//
// It has to be an *access* token, not an ID token: only access tokens carry the
// https://api.findflower.me audience. The Worker has verified tokens of this
// shape since /internal/scan shipped, so the issuer, audience and algorithm
// here are deliberately identical to verifyAuth0Token in proxy/worker.js.
// ---------------------------------------------------------------------------

const jwks = createRemoteJWKSet(new URL(`${AUTH0_ISSUER_URL}.well-known/jwks.json`));

// Access tokens are deliberately anonymous -- no name, no email, no picture --
// so the display fields come from /userinfo, which costs a round trip. Ten
// minutes per sub is short enough that a changed display name shows up in the
// same session, and long enough that a scanning user is not refetching per
// request.
const userInfoCache = new Map();
const USERINFO_TTL_MS = 10 * 60 * 1000;
const USERINFO_MAX_ENTRIES = 500;
const USERINFO_TIMEOUT_MS = 5000;

function bearerToken(req) {
    const header = req.headers && req.headers.authorization;
    if (typeof header !== 'string') return null;
    const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
    return match ? match[1] : null;
}

// Every 401 the API returns reads req.authError to choose its message (see
// authRefusal in lib.js). These are reason strings that vocabulary already
// understands, so a rejected token explains itself rather than falling through
// to the generic "Sign-in required."
function bearerReason(err) {
    const code = err && err.code ? String(err.code) : '';
    if (code === 'ERR_JWT_EXPIRED') return 'expired';
    if (code.startsWith('ERR_JWKS') || err instanceof TypeError) return 'JWKS unavailable';
    return 'bearer rejected';
}

function anonymous(sub) {
    return { sub, name: 'Botanist', email: null, picture: null };
}

async function fetchProfile(token, sub) {
    const hit = userInfoCache.get(sub);
    if (hit && hit.expires > Date.now()) return hit.user;

    let info = null;
    try {
        const response = await fetch(`${AUTH0_ISSUER_URL}userinfo`, {
            headers: { Authorization: `Bearer ${token}` },
            signal: AbortSignal.timeout(USERINFO_TIMEOUT_MS),
        });
        if (response.ok) info = await response.json();
    } catch {
        info = null;
    }
    if (!info || typeof info !== 'object') return anonymous(sub);

    const user = {
        sub,
        name: info.name || info.nickname || info.given_name || info.email || 'Botanist',
        email: info.email || null,
        picture: info.picture || null,
    };

    // Oldest out first. A Map iterates in insertion order, and re-inserting on
    // refresh keeps the order roughly least-recently-cached.
    if (userInfoCache.size >= USERINFO_MAX_ENTRIES) {
        const oldest = userInfoCache.keys().next();
        if (!oldest.done) userInfoCache.delete(oldest.value);
    }
    userInfoCache.set(sub, { user, expires: Date.now() + USERINFO_TTL_MS });
    return user;
}

/**
 * Verifies an `Authorization: Bearer <access token>` header and leaves the
 * identity on `req.bearerUser`. Mounted straight after `oidc`, so the cookie
 * session is always resolved first and wins: a browser sending both is the
 * normal case, and its behaviour must not change.
 *
 * This never rejects a request by itself. A public page stays public even if a
 * stale token rides along; the routes that need a viewer answer their own 401,
 * and they read req.authError to say why.
 */
export async function bearerAuth(req, res, next) {
    req.bearerUser = null;

    if (req.oidc && typeof req.oidc.isAuthenticated === 'function' && req.oidc.isAuthenticated()) {
        next();
        return;
    }

    const token = bearerToken(req);
    if (!token) {
        next();
        return;
    }

    try {
        const { payload } = await jwtVerify(token, jwks, {
            issuer: AUTH0_ISSUER_URL,
            audience: AUTH0_AUDIENCE,
            algorithms: ['RS256'],
        });
        const sub = typeof payload.sub === 'string' ? payload.sub : '';
        if (!sub) {
            req.authError = 'bearer rejected';
        } else {
            req.bearerUser = await fetchProfile(token, sub);
        }
    } catch (err) {
        req.authError = bearerReason(err);
    }
    next();
}

/** The OIDC identity in the shape the rest of the server uses. */
export function sessionUser(req) {
    const user = req.oidc && req.oidc.user;
    if (user && user.sub && typeof req.oidc.isAuthenticated === 'function' && req.oidc.isAuthenticated()) {
        return {
            sub: user.sub,
            name: user.name || user.nickname || user.given_name || user.email || 'Botanist',
            email: user.email || null,
            picture: user.picture || null,
        };
    }
    // No cookie session. The only other identity a request can carry is the one
    // bearerAuth verified, and it is null unless that verification succeeded.
    return req.bearerUser || null;
}

/** Values injected into every SSR page. Never put the session secret here. */
export function sessionBootstrap(req) {
    const user = sessionUser(req);
    return {
        authenticated: !!user,
        user,
        apiBase: 'same-origin',
    };
}
