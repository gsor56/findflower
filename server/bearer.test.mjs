// Bearer credentials: the Auth0 access token a native client sends instead of
// the ff_session cookie.
//
// No Mongo and no real tenant. A throwaway RSA key signs the tokens, a local
// http server publishes its JWKS and answers /userinfo, and express runs the
// middleware in front of a stand-in for GET /api/users/me. The signature,
// issuer, audience and expiry checks are all real -- jose verifies them -- which
// is the part that has to be real, because getting any one of them wrong lets a
// forged token through.
//
// The cookie session itself is stubbed by a header: express-openid-connect's own
// verification is untouched by this change and is not what is under test here.
// What is under test is the precedence rule -- when a cookie session is present
// the bearer path must not run at all.

import http from 'node:http';
import express from 'express';
import { SignJWT, generateKeyPair, exportJWK } from 'jose';

let pass = 0, fail = 0;
function one(name, ok, detail) {
    console.log((ok ? 'PASS' : 'FAIL') + '  ' + name.padEnd(58) + (detail === undefined ? '' : detail));
    ok ? pass++ : fail++;
}

const AUDIENCE = 'https://api.findflower.me';
const SUBJECT = 'auth0|abc123';

const { publicKey, privateKey } = await generateKeyPair('RS256', { extractable: true });
const { privateKey: strangerKey } = await generateKeyPair('RS256', { extractable: true });

const jwk = await exportJWK(publicKey);
jwk.kid = 'test-key';
jwk.alg = 'RS256';
jwk.use = 'sig';

let userInfoHits = 0;
let userInfoStatus = 200;
const asked = [];

const tenant = http.createServer((req, res) => {
    asked.push(req.url);
    const json = (body, status = 200) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
    };

    if (req.url === '/.well-known/openid-configuration') {
        json({
            issuer: ISSUER,
            authorization_endpoint: `${ISSUER}authorize`,
            token_endpoint: `${ISSUER}oauth/token`,
            jwks_uri: `${ISSUER}.well-known/jwks.json`,
            userinfo_endpoint: `${ISSUER}userinfo`,
            response_types_supported: ['code', 'id_token'],
            subject_types_supported: ['public'],
            id_token_signing_alg_values_supported: ['RS256'],
            scopes_supported: ['openid', 'profile', 'email'],
        });
        return;
    }
    if (req.url === '/.well-known/jwks.json') {
        json({ keys: [jwk] });
        return;
    }
    if (req.url === '/userinfo') {
        userInfoHits++;
        if (userInfoStatus !== 200) { json({}, userInfoStatus); return; }
        json({ sub: SUBJECT, name: 'Ada Botanist', email: 'ada@example.com', picture: 'https://example.com/a.png' });
        return;
    }
    json({}, 404);
});

await new Promise((resolve) => tenant.listen(0, '127.0.0.1', resolve));
const ISSUER = `http://127.0.0.1:${tenant.address().port}/`;

// session.js reads the issuer once, at import, so the environment has to be
// right before the module is loaded.
process.env.AUTH0_ISSUER = ISSUER;
process.env.AUTH0_AUDIENCE = AUDIENCE;
delete process.env.AUTH0_CLIENT_SECRET;

const { bearerAuth, sessionUser } = await import('./session.js');
const { authRefusal, resolveViewerSub } = await import('./lib.js');

async function token({
    iss = ISSUER,
    aud = AUDIENCE,
    sub = SUBJECT,
    expiresIn = 3600,
    key = privateKey,
    kid = 'test-key',
} = {}) {
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT({ scope: 'openid profile email' })
        .setProtectedHeader({ alg: 'RS256', kid })
        .setIssuer(iss)
        .setAudience(aud)
        .setSubject(sub)
        .setIssuedAt(now)
        .setExpirationTime(now + expiresIn)
        .sign(key);
}

// A stand-in for the real route: the same two calls, resolveViewerSub then
// authRefusal, that routes/users.js makes. The Mongo lookup behind requireViewer
// is the only part left out.
const app = express();
app.use((req, res, next) => {
    req.oidc = req.headers['x-test-session']
        ? { user: { sub: 'auth0|cookie', name: 'Cookie User', email: 'c@example.com' }, isAuthenticated: () => true }
        : { isAuthenticated: () => false };
    next();
});
app.use(bearerAuth);
app.get('/api/users/me', async (req, res) => {
    const sub = await resolveViewerSub(req);
    if (!sub) { res.status(401).json(authRefusal(req)); return; }
    res.json({ sub, user: sessionUser(req) });
});

const site = app.listen(0, '127.0.0.1');
await new Promise((resolve) => site.once('listening', resolve));
const BASE = `http://127.0.0.1:${site.address().port}`;

async function get(headers) {
    const response = await fetch(`${BASE}/api/users/me`, { headers });
    let body = null;
    try { body = await response.json(); } catch { body = null; }
    return { status: response.status, body };
}

console.log('--- the cookie session still works ---');
{
    const cookie = await get({ 'x-test-session': '1' });
    one('a cookie session is served without any token', cookie.status === 200, 'status=' + cookie.status);
    one('...and it is the cookie identity', cookie.body.sub === 'auth0|cookie');
    one('sessionUser still prefers req.oidc.user',
        sessionUser({ oidc: { user: { sub: 'auth0|cookie' }, isAuthenticated: () => true }, bearerUser: { sub: 'auth0|other' } }).sub === 'auth0|cookie');
    one('...and returns null with neither', sessionUser({}) === null && sessionUser({ oidc: {} }) === null);

    // The precedence rule that keeps browser behaviour byte-identical: a request
    // carrying both must never reach the token verifier.
    const before = userInfoHits;
    const both = await get({ 'x-test-session': '1', authorization: 'Bearer not-a-real-token' });
    one('a cookie session ignores a junk bearer token', both.status === 200 && both.body.sub === 'auth0|cookie', 'status=' + both.status);
    one('...and the token is never even looked at', userInfoHits === before);
}

console.log('\n--- a real access token works ---');
{
    const good = await get({ authorization: 'Bearer ' + await token() });
    one('a valid token is accepted', good.status === 200, 'status=' + good.status);
    one('...and resolves to its sub claim', good.body.sub === SUBJECT);
    one('...with name, email and picture from /userinfo',
        good.body.user.name === 'Ada Botanist' && good.body.user.email === 'ada@example.com' && !!good.body.user.picture);
    one('/userinfo was consulted exactly once', userInfoHits === 1, 'hits=' + userInfoHits);

    const again = await get({ authorization: 'Bearer ' + await token() });
    one('a second request is served from the cache', again.status === 200 && userInfoHits === 1, 'hits=' + userInfoHits);

    userInfoStatus = 503;
    const fresh = await get({ authorization: 'Bearer ' + await token({ sub: 'auth0|newcomer' }) });
    one('/userinfo down still authenticates, with a plain name',
        fresh.status === 200 && fresh.body.user.name === 'Botanist', 'status=' + fresh.status + ' name=' + (fresh.body.user && fresh.body.user.name));
    userInfoStatus = 200;

    const retried = await get({ authorization: 'Bearer ' + await token({ sub: 'auth0|newcomer' }) });
    one('...and the failure was not cached', retried.body.user.name === 'Ada Botanist');
}

console.log('\n--- everything else is refused ---');
{
    const missing = await get({});
    one('no credentials at all is 401', missing.status === 401, 'status=' + missing.status);
    one('...with the existing message', missing.body.error === 'Sign-in required.');

    const expired = await get({ authorization: 'Bearer ' + await token({ expiresIn: -60 }) });
    one('an expired token is 401', expired.status === 401, 'status=' + expired.status);
    one('...and says so, the way an expired cookie does', expired.body.error === 'That sign-in has expired. Sign in again.', JSON.stringify(expired.body.error));

    const wrongAud = await get({ authorization: 'Bearer ' + await token({ aud: 'https://not-our-api.example' }) });
    one('a token for another audience is 401', wrongAud.status === 401, 'status=' + wrongAud.status);

    const wrongIss = await get({ authorization: 'Bearer ' + await token({ iss: 'https://tenant.example.com/' }) });
    one('a token from another issuer is 401', wrongIss.status === 401, 'status=' + wrongIss.status);

    const forged = await get({ authorization: 'Bearer ' + await token({ key: strangerKey }) });
    one('a token signed by the wrong key is 401', forged.status === 401, 'status=' + forged.status);

    const unknownKid = await get({ authorization: 'Bearer ' + await token({ kid: 'no-such-key' }) });
    one('a token naming an unknown key id is 401', unknownKid.status === 401, 'status=' + unknownKid.status);

    const garbage = await get({ authorization: 'Bearer not-a-jwt-at-all' });
    one('a string that is not a JWT is 401', garbage.status === 401, 'status=' + garbage.status);

    const empty = await get({ authorization: 'Bearer ' });
    one('an empty bearer value is 401', empty.status === 401, 'status=' + empty.status);

    const basic = await get({ authorization: 'Basic YWJjOmRlZg==' });
    one('a non-bearer scheme is 401', basic.status === 401, 'status=' + basic.status);

    const noSub = await get({ authorization: 'Bearer ' + await token({ sub: '' }) });
    one('a token with no subject is 401', noSub.status === 401, 'status=' + noSub.status);

    // 1 for the first valid token, 2 for the sub served while /userinfo was
    // down, 3 when that same sub retried. Nothing rejected ever got that far.
    one('only successful verifications reached /userinfo', userInfoHits === 3, 'hits=' + userInfoHits);
    one('the JWKS document was fetched', asked.includes('/.well-known/jwks.json'));
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');

// Closing and then exiting immediately trips a libuv assertion on Windows, so
// both servers are awaited before the process is allowed to end on its own.
async function closed(server) {
    await new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections();
    });
}
await closed(site);
await closed(tenant);
process.exitCode = fail ? 1 : 0;
