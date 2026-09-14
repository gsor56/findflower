// Server-side Auth0 session wiring for the SSR application.
//
// The browser no longer owns the login flow. express-openid-connect performs
// the OIDC dance, validates the session cookie on every request, and exposes
// the user on req.oidc. The API keeps accepting bearer tokens as a fallback for
// non-browser clients, but same-origin pages use this session.

import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { auth } from 'express-openid-connect';
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

// A failed /callback is otherwise a single opaque line: the library collapses
// Auth0's token-endpoint answer into one generic message, and the request
// parameters that decide the outcome -- the redirect_uri, the grant type,
// whether PKCE arrived -- are invisible from outside the container. This
// wrapper reports both halves of that exchange. Credentials and one-time codes
// are stripped; issued tokens never reach the log.
const REDACTED_PARAMS = new Set(['client_secret', 'code', 'code_verifier']);
const QUOTED_TOKEN_FIELD = /\u0022(access_token|refresh_token|id_token)\u0022\s*:\s*\u0022[^\u0022]*\u0022/g;
const REDACTED_TOKEN_FIELD = '\u0022$1\u0022:\u0022<redacted>\u0022';

function summarizeTokenRequest(init, input) {
    const raw = (init && init.body) ?? (input && input.body);
    const text = typeof raw === 'string' ? raw : raw instanceof URLSearchParams ? raw.toString() : null;
    if (!text) return null;
    const summary = {};
    for (const [key, value] of new URLSearchParams(text)) {
        summary[key] = REDACTED_PARAMS.has(key) ? `<redacted len=${String(value).length}>` : value;
    }
    return summary;
}

const traceFetch = async (input, init) => {
    const href = input instanceof URL ? input.href : (input && input.url) || String(input);
    const summarize = href.includes('/oauth/token');
    const request = summarize ? summarizeTokenRequest(init, input) : null;
    const response = await globalThis.fetch(input, init);
    if (summarize) {
        response.clone().text().then((text) => {
            const line = { at: new Date().toISOString(), url: href, status: response.status, ok: response.ok, request };
            if (!response.ok) line.response = text.replace(QUOTED_TOKEN_FIELD, REDACTED_TOKEN_FIELD).slice(0, 800);
            console.error('[auth] token exchange', JSON.stringify(line));
        }).catch(() => { });
    }
    return response;
};

export const oidc = auth({
    authRequired: false,
    auth0Logout: true,
    baseURL: AUTH0_BASE_URL,
    clientID: AUTH0_CLIENT_ID,
    customFetch: traceFetch,
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
            // the HidenCloud origin hop is plaintext. Keep this explicit so a
            // platform-provided NODE_ENV or forwarded-proto value cannot make
            // the session cookie insecure in production.
            secure: true,
        },
    },
});

/** The OIDC identity in the shape the rest of the server uses. */
export function sessionUser(req) {
    const user = req.oidc && req.oidc.user;
    if (!user || !user.sub || typeof req.oidc.isAuthenticated !== 'function' || !req.oidc.isAuthenticated()) {
        return null;
    }
    return {
        sub: user.sub,
        name: user.name || user.nickname || user.given_name || user.email || 'Botanist',
        email: user.email || null,
        picture: user.picture || null,
    };
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
