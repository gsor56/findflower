import { promises as fs } from 'node:fs';
// Node >= 20 exposes globalThis.crypto (WebCrypto) natively, same as Workers.

const src = await fs.readFile(new URL('./worker.js', import.meta.url), 'utf8');
// Load the Worker module without a bundler.
const mod = await import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'));
const worker = mod.default;

const b64url = (b) => Buffer.from(b).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

// A real RS256 keypair; its public half is served as the stub JWKS.
const kp = await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true, ['sign', 'verify']);
const pubJwk = await crypto.subtle.exportKey('jwk', kp.publicKey);
const KID = 'test-kid-1';
const JWKS = { keys: [{ ...pubJwk, kid: KID, alg: 'RS256', use: 'sig' }] };

const DOMAIN = 'findflower.au.auth0.com';
const ISS = 'https://' + DOMAIN + '/';
const AUD = 'https://api.findflower.me';

async function mint(over = {}, hdr = {}, signWith = kp.privateKey) {
    const now = Math.floor(Date.now() / 1000);
    const header = { alg: 'RS256', typ: 'JWT', kid: KID, ...hdr };
    const payload = { iss: ISS, aud: AUD, sub: 'auth0|abc123', iat: now, exp: now + 3600, ...over };
    const signing = b64url(JSON.stringify(header)) + '.' + b64url(JSON.stringify(payload));
    let sig = 'AAAA';
    if (signWith) {
        const s = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', signWith, new TextEncoder().encode(signing));
        sig = b64url(Buffer.from(s));
    }
    return signing + '.' + sig;
}

// Intercept outbound fetches: JWKS stubbed, Space hits counted.
let spaceHits = 0, jwksHits = 0;
globalThis.fetch = async (url) => {
    url = String(url);
    if (url.includes('jwks.json')) {
        jwksHits++;
        return new Response(JSON.stringify(JWKS), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (url.includes('/predict')) {
        spaceHits++;
        return new Response(JSON.stringify({
            flower: 'sunflower', confidence: 0.94,
            top_k: [{ name: 'sunflower', confidence: 0.94 }, { name: 'daisy', confidence: 0.03 }],
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    throw new Error('unexpected fetch: ' + url);
};

const ENV = {
    SPACE_URL: 'https://space.example', PROXY_SECRET: 's3cret',
    ALLOWED_ORIGINS: 'http://localhost:8000,https://findflower.me',
    AUTH0_DOMAIN: DOMAIN, AUTH0_AUDIENCE: AUD,
};

function post(token, { origin = 'https://findflower.me', env = ENV, raw } = {}) {
    const h = new Headers({ 'Content-Type': 'image/jpeg' });
    if (origin) h.set('Origin', origin);
    if (raw !== undefined) { if (raw) h.set('Authorization', raw); }
    else if (token) h.set('Authorization', 'Bearer ' + token);
    return worker.fetch(new Request('https://w.example', {
        method: 'POST', headers: h, body: new Uint8Array([1, 2, 3, 4]),
    }), env);
}

let pass = 0, fail = 0;
async function check(name, fn, want) {
    const before = spaceHits;
    let got;
    try { got = await fn(); } catch (e) { got = 'THREW: ' + e.message; }
    const reachedSpace = spaceHits > before;
    const ok = got === want.status && (want.space === undefined || reachedSpace === want.space);
    console.log((ok ? 'PASS' : 'FAIL') + '  ' + name.padEnd(44) + ' status=' + got +
        (want.space !== undefined ? '  space=' + reachedSpace : ''));
    ok ? pass++ : fail++;
}

console.log('--- AUTH GATE (verification active) ---');
await check('valid signed token', async () => (await post(await mint())).status, { status: 200, space: true });
await check('no Authorization header', async () => (await post(null)).status, { status: 401, space: false });
await check('empty Bearer', async () => (await post(null, { raw: 'Bearer ' })).status, { status: 401, space: false });
await check('malformed scheme (Basic)', async () => (await post(null, { raw: 'Basic abcdefghijklmnop' })).status, { status: 401, space: false });
await check('bare token, no Bearer', async () => (await post(null, { raw: 'abcdefghijklmnopqrst' })).status, { status: 401, space: false });
await check('token too short', async () => (await post('short')).status, { status: 401, space: false });
await check('opaque (non-JWT) token', async () => (await post('aaaaaaaaaaaaaaaaaaaaaaaa')).status, { status: 401, space: false });
await check('expired token', async () => (await post(await mint({ exp: Math.floor(Date.now() / 1000) - 7200 }))).status, { status: 401, space: false });
await check('wrong audience', async () => (await post(await mint({ aud: 'https://evil.example' }))).status, { status: 401, space: false });
await check('wrong issuer', async () => (await post(await mint({ iss: 'https://evil.auth0.com/' }))).status, { status: 401, space: false });
await check('alg=none downgrade', async () => (await post(await mint({}, { alg: 'none' }, null))).status, { status: 401, space: false });
await check('alg=HS256 confusion', async () => (await post(await mint({}, { alg: 'HS256' }))).status, { status: 401, space: false });
await check('tampered payload (bad sig)', async () => {
    const p = (await mint()).split('.');
    p[1] = b64url(JSON.stringify({ iss: ISS, aud: AUD, sub: 'auth0|ATTACKER', exp: Math.floor(Date.now() / 1000) + 3600 }));
    return (await post(p.join('.'))).status;
}, { status: 401, space: false });
await check('unknown kid', async () => (await post(await mint({}, { kid: 'nope' }))).status, { status: 401, space: false });
await check('aud array including ours', async () => (await post(await mint({ aud: [AUD, ISS + 'userinfo'] }))).status, { status: 200, space: true });

console.log('\n--- 401 response shape ---');
{
    const r = await post(null);
    console.log('WWW-Authenticate:', r.headers.get('WWW-Authenticate'));
    console.log('ACAO on 401     :', r.headers.get('Access-Control-Allow-Origin'));
    console.log('body            :', await r.text());
}

console.log('\n--- CORS preflight ---');
for (const [label, origin] of [['findflower.me', 'https://findflower.me'], ['localhost:8000', 'http://localhost:8000'], ['evil.example', 'https://evil.example'], ['(no Origin)', null]]) {
    const h = new Headers();
    if (origin) h.set('Origin', origin);
    const r = await worker.fetch(new Request('https://w.example', { method: 'OPTIONS', headers: h }), ENV);
    console.log('OPTIONS ' + label.padEnd(16) + r.status + '  ACAO=' + r.headers.get('Access-Control-Allow-Origin') +
        '  ACAH=' + r.headers.get('Access-Control-Allow-Headers'));
}

console.log('\n--- ALLOWED_ORIGINS misconfigured to "*" ---');
{
    const bad = { ...ENV, ALLOWED_ORIGINS: '*' };
    const h = new Headers({ Origin: 'https://evil.example' });
    const r = await worker.fetch(new Request('https://w.example', { method: 'OPTIONS', headers: h }), bad);
    console.log('ACAO with ALLOWED_ORIGINS="*":', r.headers.get('Access-Control-Allow-Origin'), '(must not be *)');
    const r2 = await post(await mint(), { origin: 'https://evil.example', env: bad });
    console.log('POST from evil origin       :', r2.status, '(403 = origin gate held)');
}

console.log('\n--- structure-only mode (AUTH0 vars unset) ---');
{
    const bare = { SPACE_URL: ENV.SPACE_URL, PROXY_SECRET: ENV.PROXY_SECRET, ALLOWED_ORIGINS: ENV.ALLOWED_ORIGINS };
    await check('no header -> 401', async () => (await post(null, { env: bare })).status, { status: 401, space: false });
    await check('fabricated token -> 200', async () => (await post('aaaaaaaaaaaaaaaaaaaa', { env: bare })).status, { status: 200, space: true });
}

console.log('\n--- JWKS caching ---');
{
    const j0 = jwksHits;
    for (let i = 0; i < 4; i++) await post(await mint());
    console.log('4 valid scans caused ' + (jwksHits - j0) + ' JWKS fetch(es) (want 0-1)');
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
