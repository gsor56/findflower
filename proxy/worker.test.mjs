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
    ENFORCE_AUTH: 'true',
};
// The rollout state: same everything, but the gate evaluates and serves
// instead of evaluating and refusing. Every rejecting case below must PASS as
// a 200 in dry-run, with the verdict visible in X-FF-Auth.
const DRY = { ...ENV, ENFORCE_AUTH: 'false' };

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

console.log('\n--- health check (GET/HEAD, gate armed) ---');
{
    // The frontend's status dot polls this with no Authorization header. If it
    // ever 401s, every visitor sees the model reported as down.
    const g = (m, env = ENV) => worker.fetch(new Request('https://w.example', {
        method: m, headers: new Headers({ Origin: 'https://findflower.me' }),
    }), env);
    await check('GET -> 200 without a token', async () => (await g('GET')).status, { status: 200, space: false });
    await check('HEAD -> 200 without a token', async () => (await g('HEAD')).status, { status: 200, space: false });
    await check('PUT -> 405 (still not a free door)', async () => (await g('PUT')).status, { status: 405, space: false });
    const r = await g('GET');
    console.log('      body          :', await r.text());
    console.log('      ACAO          :', r.headers.get('Access-Control-Allow-Origin'));
    console.log('      Cache-Control :', r.headers.get('Cache-Control'));
    const hb = await (await g('HEAD')).text();
    console.log((hb === '' ? 'PASS' : 'FAIL') + '  HEAD carries no body');
    hb === '' ? pass++ : fail++;
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

console.log('\n--- structure-only mode (AUTH0 vars unset, enforcing) ---');
{
    const bare = {
        SPACE_URL: ENV.SPACE_URL, PROXY_SECRET: ENV.PROXY_SECRET,
        ALLOWED_ORIGINS: ENV.ALLOWED_ORIGINS, ENFORCE_AUTH: 'true',
    };
    await check('no header -> 401', async () => (await post(null, { env: bare })).status, { status: 401, space: false });
    await check('fabricated token -> 200', async () => (await post('aaaaaaaaaaaaaaaaaaaa', { env: bare })).status, { status: 200, space: true });
    const r = await post('aaaaaaaaaaaaaaaaaaaa', { env: bare });
    console.log('      X-FF-Auth on unverified pass:', r.headers.get('X-FF-Auth'));
}

console.log('\n--- ROLLOUT STEP 1: ENFORCE_AUTH=false (dry run) ---');
console.log('    every case must serve 200; the verdict rides on X-FF-Auth');
await check('no header -> served', async () => (await post(null, { env: DRY })).status, { status: 200, space: true });
await check('malformed scheme -> served', async () => (await post(null, { raw: 'Basic abcdefghijklmnop', env: DRY })).status, { status: 200, space: true });
await check('expired token -> served', async () => (await post(await mint({ exp: Math.floor(Date.now() / 1000) - 7200 }), { env: DRY })).status, { status: 200, space: true });
await check('forged token -> served', async () => (await post('aaaaaaaaaaaaaaaaaaaaaaaa', { env: DRY })).status, { status: 200, space: true });
await check('valid token -> served', async () => (await post(await mint(), { env: DRY })).status, { status: 200, space: true });
{
    // The header is the whole point of the dry run: it is how you confirm the
    // frontend is sending a token that WILL survive step 3 before you arm it.
    const cases = [
        ['no header', await post(null, { env: DRY })],
        ['expired token', await post(await mint({ exp: Math.floor(Date.now() / 1000) - 7200 }), { env: DRY })],
        ['valid token', await post(await mint(), { env: DRY })],
    ];
    for (const [label, r] of cases) {
        console.log('      ' + label.padEnd(16) + 'X-FF-Auth: ' + r.headers.get('X-FF-Auth'));
    }
    const ok = cases[2][1].headers.get('X-FF-Auth') === 'ok';
    console.log((ok ? 'PASS' : 'FAIL') + '  valid token reports exactly "ok" in dry run');
    ok ? pass++ : fail++;
}

console.log('\n--- ROLLOUT STEP 3: same requests, ENFORCE_AUTH=true ---');
await check('no header -> 401', async () => (await post(null)).status, { status: 401, space: false });
await check('forged token -> 401', async () => (await post('aaaaaaaaaaaaaaaaaaaaaaaa')).status, { status: 401, space: false });
await check('valid token -> 200', async () => (await post(await mint())).status, { status: 200, space: true });
{
    // A missing or garbled var must FAIL CLOSED -- only "false" may disarm.
    const checks = [];
    for (const v of [undefined, '', 'false', 'FALSE', 'False', 'true', 'yes', '1', 'no', 'flase']) {
        const env = { ...ENV }; if (v === undefined) delete env.ENFORCE_AUTH; else env.ENFORCE_AUTH = v;
        checks.push([JSON.stringify(v), (await post(null, { env })).status]);
    }
    console.log('      ENFORCE_AUTH value -> status for a tokenless request:');
    for (const [v, s] of checks) console.log('        ' + String(v).padEnd(11) + ' -> ' + s);
    const open = checks.filter(([, s]) => s === 200).map(([v]) => v).join(',');
    const ok = open === '"false","FALSE","False"';
    console.log((ok ? 'PASS' : 'FAIL') + '  only "false" disarms; everything else enforces (open: ' + (open || 'none') + ')');
    ok ? pass++ : fail++;
}

console.log('\n--- TREFLE read-through (GET /trefle/...) ---');
{
    const TREFLE_ENV = { ...ENV, TREFLE_TOKEN: 'tk_SECRET_TOKEN_VALUE' };
    let lastUpstream = null;
    const realFetch = globalThis.fetch;

    // Stand in for trefle.io and record exactly what the Worker asked for.
    globalThis.fetch = async (url, init) => {
        const u = String(url);
        if (u.includes('trefle.io')) {
            lastUpstream = u;
            if (u.includes('/plants/search')) {
                return new Response(JSON.stringify({ data: [{ id: 1, common_name: 'Rose' }] }),
                    { status: 200, headers: { 'Content-Type': 'application/json' } });
            }
            if (u.includes('/plants/999999')) {
                // Trefle quoting the request back at us, token and all.
                return new Response(JSON.stringify({ error: true, messages: 'Not found: ' + u }),
                    { status: 404, headers: { 'Content-Type': 'application/json' } });
            }
            return new Response(JSON.stringify({ data: [{ id: 2, common_name: 'Tulip' }] }),
                { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
        return realFetch(url, init);
    };

    const get = (path, env = TREFLE_ENV, method = 'GET') => worker.fetch(new Request('https://w.example' + path, {
        method, headers: new Headers({ Origin: 'https://findflower.me' }),
    }), env);

    await check('GET /trefle/plants -> 200, no token needed',
        async () => (await get('/trefle/plants?page=2')).status, { status: 200, space: false });
    await check('GET /trefle/plants/search -> 200',
        async () => (await get('/trefle/plants/search?q=rosa')).status, { status: 200, space: false });
    await check('GET /trefle/plants/123 -> 200',
        async () => (await get('/trefle/plants/123')).status, { status: 200, space: false });

    // --- the allowlist is the SSRF wall ---
    // What matters is not the status but whether trefle.io was reached at all.
    // A plain `../` never even enters the Trefle branch: new URL() normalises
    // it to /admin, so it lands on the health check. The percent-encoded form
    // DOES survive normalisation and reaches the matcher, where the
    // [a-z0-9-]+ character class is what actually stops it.
    for (const [label, path] of [
        ['dot-segment traversal', '/trefle/plants/../../admin'],
        ['encoded traversal', '/trefle/plants/%2e%2e%2f%2e%2e%2fadmin'],
        ['encoded slash', '/trefle/plants/1%2Fadmin'],
        ['query smuggled into the id', '/trefle/plants/1?x=%26token%3Devil'],
        ['upstream host swap', '/trefle/plants/evil.example%2Fsteal'],
    ]) {
        lastUpstream = null;
        await get(path);
        const reached = lastUpstream !== null;
        const escaped = reached && !/^https:\/\/trefle\.io\/api\/v1\//.test(lastUpstream);
        const ok = !escaped;
        console.log((ok ? 'PASS' : 'FAIL') + '  ' + (label + ' cannot leave trefle.io').padEnd(44) +
            (reached ? 'upstream=' + lastUpstream.replace(/token=[^&]*/, 'token=***') : 'upstream=(not called)'));
        ok ? pass++ : fail++;
    }
    await check('unknown Trefle route is refused',
        async () => (await get('/trefle/kingdoms')).status, { status: 404, space: false });
    await check('absolute URL smuggling is refused',
        async () => (await get('/trefle/https://evil.example/steal')).status, { status: 404, space: false });
    await check('POST to a Trefle route -> 405 (read-only)',
        async () => (await get('/trefle/plants', TREFLE_ENV, 'POST')).status, { status: 405, space: false });
    await check('evil origin is refused before Trefle is called',
        async () => (await worker.fetch(new Request('https://w.example/trefle/plants', {
            method: 'GET', headers: new Headers({ Origin: 'https://evil.example' }),
        }), TREFLE_ENV)).status, { status: 403, space: false });

    // --- the token must never be observable by the client ---
    {
        await get('/trefle/plants?page=2');
        const sentToken = lastUpstream && lastUpstream.includes('tk_SECRET_TOKEN_VALUE');
        console.log((sentToken ? 'PASS' : 'FAIL') + '  token IS attached upstream');
        sentToken ? pass++ : fail++;

        const onlyAllowedParams = lastUpstream && lastUpstream.includes('page=2');
        console.log((onlyAllowedParams ? 'PASS' : 'FAIL') + '  allowlisted query param survives');
        onlyAllowedParams ? pass++ : fail++;

        // The family filter IS the encyclopedia's curation: without it,
        // /plants browses all 437k Trefle records (oaks, grasses, conifers)
        // instead of the twenty flowering families the site is about. Drop it
        // from the allowlist and the grid silently stops being a flower
        // encyclopedia -- a content regression with no error to notice.
        {
            await get('/trefle/plants?page=1&filter%5Bfamily_name%5D=Rosaceae%2CAsteraceae');
            const kept = lastUpstream && /filter(%5B|\[)family_name(%5D|\])=/.test(lastUpstream);
            console.log((kept ? 'PASS' : 'FAIL') + '  filter[family_name] survives (encyclopedia curation)');
            kept ? pass++ : fail++;
            const bothFamilies = lastUpstream &&
                /Rosaceae/.test(decodeURIComponent(lastUpstream)) &&
                /Asteraceae/.test(decodeURIComponent(lastUpstream));
            console.log((bothFamilies ? 'PASS' : 'FAIL') + '  ...with every family in the list intact');
            bothFamilies ? pass++ : fail++;
        }
        {
            // filter[family] is a different, unallowlisted param -- and one
            // Trefle ignores anyway. It must not reach upstream.
            await get('/trefle/plants?page=1&filter%5Bfamily%5D=Rosaceae');
            const d = decodeURIComponent(lastUpstream || '');
            const dropped = !/filter\[family\]/.test(d);
            console.log((dropped ? 'PASS' : 'FAIL') + '  non-allowlisted filter[family] is dropped');
            dropped ? pass++ : fail++;
        }

        const r = await get('/trefle/plants?page=2&filter=evil&token=attacker');
        const bodyText = await r.text();
        const leaked = bodyText.includes('tk_SECRET_TOKEN_VALUE');
        console.log((!leaked ? 'PASS' : 'FAIL') + '  token never appears in a 200 body');
        !leaked ? pass++ : fail++;

        const overridden = lastUpstream.match(/token=([^&]*)/);
        const notHijacked = overridden && overridden[1] === 'tk_SECRET_TOKEN_VALUE';
        console.log((notHijacked ? 'PASS' : 'FAIL') + "  client's ?token= cannot override ours");
        notHijacked ? pass++ : fail++;
    }
    {
        // The nastiest leak: upstream echoes our full URL inside an error body.
        const r = await get('/trefle/plants/999999');
        const body = await r.text();
        const leaked = body.includes('tk_SECRET_TOKEN_VALUE');
        console.log((!leaked ? 'PASS' : 'FAIL') + '  token is scrubbed from an upstream error body');
        !leaked ? pass++ : fail++;
        const redacted = body.includes('***');
        console.log((redacted ? 'PASS' : 'FAIL') + '  ...and replaced with ***');
        redacted ? pass++ : fail++;
    }

    // --- no token configured: 503 + fallback flag, never a hard failure ---
    {
        const r = await get('/trefle/plants', ENV); // ENV has no TREFLE_TOKEN
        const body = await r.json();
        const ok = r.status === 503 && body.fallback === true;
        console.log((ok ? 'PASS' : 'FAIL') + '  missing TREFLE_TOKEN -> 503 with fallback:true (status=' + r.status + ')');
        ok ? pass++ : fail++;
    }

    // --- the Trefle route must not disturb the paths that already worked ---
    await check('POST inference still reaches the Space',
        async () => (await post(await mint(), { env: TREFLE_ENV })).status, { status: 200, space: true });
    await check('GET / is still the health check',
        async () => (await get('/', TREFLE_ENV)).status, { status: 200, space: false });
    {
        const r = await get('/', TREFLE_ENV);
        const b = await r.json();
        const ok = b.status === 'ok';
        console.log((ok ? 'PASS' : 'FAIL') + '  health body is still { status: "ok" }');
        ok ? pass++ : fail++;
    }
    {
        const r = await worker.fetch(new Request('https://w.example/trefle/plants', {
            method: 'OPTIONS', headers: new Headers({ Origin: 'https://findflower.me' }),
        }), TREFLE_ENV);
        const m = r.headers.get('Access-Control-Allow-Methods') || '';
        const ok = m.includes('GET');
        console.log((ok ? 'PASS' : 'FAIL') + '  preflight advertises GET (' + m + ')');
        ok ? pass++ : fail++;
    }

    globalThis.fetch = realFetch;
}

console.log('\n--- JWKS caching ---');
{
    const j0 = jwksHits;
    for (let i = 0; i < 4; i++) await post(await mint());
    console.log('4 valid scans caused ' + (jwksHits - j0) + ' JWKS fetch(es) (want 0-1)');
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
