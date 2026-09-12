// Server-side Auth0 session wiring for the SSR application.
//
// The browser no longer owns the login flow. express-openid-connect performs
// the OIDC dance, validates the session cookie on every request, and exposes
// the user on req.oidc. The API keeps accepting bearer tokens as a fallback for
// non-browser clients, but same-origin pages use this session.

import crypto from 'node:crypto';
import { auth } from 'express-openid-connect';

const AUTH0_DOMAIN = process.env.AUTH0_DOMAIN || 'dev-jvit0r04itv8hfjz.us.auth0.com';
const AUTH0_CLIENT_ID = process.env.AUTH0_CLIENT_ID || '9sWXgo4TtCodcmnfdr6vcSRighhkVXMy';
const AUTH0_AUDIENCE = process.env.AUTH0_AUDIENCE || 'https://api.findflower.me';
// The confidential-client secret. The OIDC middleware needs it to exchange the
// authorization code at /callback, and left to itself it reads only the env var
// named exactly CLIENT_SECRET. Wiring it here means AUTH0_CLIENT_SECRET -- the
// name the rest of this service documents -- works as well.
const AUTH0_CLIENT_SECRET = process.env.AUTH0_CLIENT_SECRET || process.env.CLIENT_SECRET;
const PORT = Number(process.env.PORT || process.env.SERVER_PORT) || 24729;

const configuredSecret = process.env.AUTH0_SECRET || process.env.SESSION_SECRET;
const isProduction = process.env.NODE_ENV === 'production';
const devSecret = crypto.createHash('sha256')
    .update(process.env.MONGO_URI || 'findflower-local-session')
    .digest('hex');
const secret = configuredSecret || devSecret;

if (isProduction && !configuredSecret) {
    console.warn('[auth] AUTH0_SECRET is not set; using a derived development secret. Set it in HidenCloud before production traffic.');
}

export const sessionEnabled = Boolean(configuredSecret) || !isProduction;

export const oidc = auth({
    authRequired: false,
    auth0Logout: true,
    baseURL: process.env.AUTH0_BASE_URL || process.env.FF_PUBLIC_URL || `http://localhost:${PORT}`,
    clientID: AUTH0_CLIENT_ID,
    ...(AUTH0_CLIENT_SECRET ? { clientSecret: AUTH0_CLIENT_SECRET } : {}),
    issuerBaseURL: process.env.AUTH0_ISSUER || `https://${AUTH0_DOMAIN}/`,
    secret,
    routes: {
        login: '/login',
        logout: '/logout',
        callback: '/callback',
        postLogoutRedirect: '/',
    },
    authorizationParams: {
        audience: AUTH0_AUDIENCE,
        scope: 'openid profile email',
    },
    session: {
        name: 'ff_session',
        cookie: {
            httpOnly: true,
            sameSite: 'Lax',
            secure: isProduction,
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
