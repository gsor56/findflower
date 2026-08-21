// Who is calling. Auth0 RS256 tokens, verified against the tenant's JWKS.
//
// No dependency: node's crypto reads a JWK directly (createPublicKey with
// format 'jwk'), which is the only awkward part of checking an RS256 signature
// by hand, so a jose/jsonwebtoken install buys nothing here.
//
// The domain and client id below are the same public values auth.js already
// ships to the browser -- SPA config, not secrets. Set AUTH0_AUDIENCE once an
// API is registered in the Auth0 dashboard and access tokens issued for it will
// be accepted; until then the only token the SPA can produce is its ID token,
// whose audience is the client id, and that is what this accepts. Either way the
// signature and issuer are checked, so a caller cannot name themselves.

import crypto from 'node:crypto';

const AUTH0_DOMAIN = process.env.AUTH0_DOMAIN || 'findflower.au.auth0.com';
const AUTH0_CLIENT_ID = process.env.AUTH0_CLIENT_ID || '6L1pckrnAw9csi0ZyHEX1CC3vo1lcgxK';
// Both derived from the domain in normal use. Overridable because a staging
// tenant and the test harness need a different issuer and key set, and because
// the alternative is a switch that skips verification -- which is not a thing
// this file is willing to have.
const ISSUER = process.env.AUTH0_ISSUER || `https://${AUTH0_DOMAIN}/`;
const JWKS_URL = process.env.AUTH0_JWKS_URL || `${ISSUER}.well-known/jwks.json`;
const SKEW_SECONDS = 60;

let keyCache = new Map();
let keyCacheAt = 0;
const KEY_TTL_MS = 10 * 60 * 1000;

async function loadKeys(force) {
    const fresh = Date.now() - keyCacheAt < KEY_TTL_MS;
    if (!force && fresh && keyCache.size) return keyCache;
    const res = await fetch(JWKS_URL, { headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`JWKS fetch failed (${res.status})`);
    const body = await res.json();
    const next = new Map();
    for (const jwk of body.keys || []) {
        if (jwk.kty !== 'RSA' || (jwk.alg && jwk.alg !== 'RS256')) continue;
        next.set(jwk.kid, crypto.createPublicKey({ key: jwk, format: 'jwk' }));
    }
    if (!next.size) throw new Error('JWKS held no usable RS256 key');
    keyCache = next;
    keyCacheAt = Date.now();
    return keyCache;
}

function b64urlJson(part) {
    return JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
}

/** Verify one bearer token and return its payload, or throw. */
export async function verifyToken(token) {
    const parts = String(token).split('.');
    if (parts.length !== 3) throw new Error('not a JWT');
    const header = b64urlJson(parts[0]);
    if (header.alg !== 'RS256') throw new Error(`unexpected alg ${header.alg}`);

    // A rotated signing key is a cache miss, not a bad token: refetch once
    // before rejecting it.
    let keys = await loadKeys(false);
    let key = keys.get(header.kid);
    if (!key) {
        keys = await loadKeys(true);
        key = keys.get(header.kid);
    }
    if (!key) throw new Error('no JWKS key for kid');

    const signed = Buffer.from(`${parts[0]}.${parts[1]}`, 'utf8');
    const sig = Buffer.from(parts[2], 'base64url');
    if (!crypto.verify('RSA-SHA256', signed, key, sig)) throw new Error('bad signature');

    const claims = b64urlJson(parts[1]);
    if (claims.iss !== ISSUER) throw new Error('wrong issuer');
    const now = Math.floor(Date.now() / 1000);
    if (typeof claims.exp === 'number' && claims.exp + SKEW_SECONDS < now) throw new Error('expired');
    if (typeof claims.nbf === 'number' && claims.nbf - SKEW_SECONDS > now) throw new Error('not yet valid');

    const want = process.env.AUTH0_AUDIENCE || AUTH0_CLIENT_ID;
    const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!aud.includes(want)) throw new Error('wrong audience');
    if (!claims.sub) throw new Error('no sub');
    return claims;
}

/** The Auth0 `sub` behind this request, or null. Never throws: a route decides
 *  whether anonymous is allowed, and a public feed read is. */
export async function viewerSub(req) {
    const header = req.get('Authorization') || '';
    const m = header.match(/^Bearer\s+(.+)$/i);
    if (!m) return null;
    try {
        return (await verifyToken(m[1])).sub;
    } catch (err) {
        req.authError = err.message;
        return null;
    }
}
