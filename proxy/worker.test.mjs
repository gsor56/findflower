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

// Intercept outbound fetches: JWKS stubbed, inference hits counted.
let spaceHits = 0, jwksHits = 0, warmHits = 0;
// The URL each scan was actually forwarded to, so the upstream-selection test
// can prove where the model was reached rather than only that it answered.
let lastPredict = '';
globalThis.fetch = async (url) => {
    url = String(url);
    if (url.includes('/predict')) lastPredict = url;
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
    // The warm poke targets /warm, which is the model-load endpoint on the Node
    // server. A bare-origin poke would render the homepage and warm nothing, so
    // it deliberately falls through to the throw below: the worker swallows that
    // rejection, warmHits stays put, and the assertion catches the regression.
    if (url === SPACE_ROOT + '/warm') {
        warmHits++;
        return new Response(JSON.stringify({ warming: true }), {
            status: 202, headers: { 'Content-Type': 'application/json' },
        });
    }
    throw new Error('unexpected fetch: ' + url);
};

const SPACE_ROOT = 'https://space.example';
// How many requests actually reached the Durable Object. A refusal, or a route
// that is not metered, must leave this untouched: that is the evidence that the
// shared pool was never charged.
let budgetHits = 0;
const GLOBAL_INFERENCE_BUDGET = {
    idFromName: () => 'global-inference-budget',
    get: () => ({
        fetch: async () => {
            budgetHits++;
            return new Response(JSON.stringify({
                allowed: true,
                limit: 1000000,
                remaining: 999999,
                reset: Math.floor(Date.now() / 1000) + 3600,
                window_ends: new Date(Date.now() + 3600000).toISOString(),
            }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        },
    }),
};
const ENV = {
    SPACE_URL: SPACE_ROOT, PROXY_SECRET: 's3cret',
    ALLOWED_ORIGINS: 'http://localhost:8000,https://findflower.me',
    AUTH0_DOMAIN: DOMAIN, AUTH0_AUDIENCE: AUD,
    GLOBAL_INFERENCE_BUDGET,
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

console.log('\n--- warm-up poke (/warm) ---');
{
    // /try calls this on load so the Space boots while the visitor is still
    // choosing a photo. Like the health check it carries no token, so it has to
    // sit ahead of the auth gate: ENV here has the gate ARMED, and a 401 would
    // mean every page load warmed nothing.
    const warm = (m, env = ENV, origin = 'https://findflower.me') => {
        const h = new Headers();
        if (origin) h.set('Origin', origin);
        const held = [];
        return worker.fetch(new Request('https://w.example/warm', { method: m, headers: h }), env,
            { waitUntil: (pr) => held.push(pr) }).then((r) => ({ r, held }));
    };
    const w0 = warmHits;
    const { r, held } = await warm('GET');
    const body = await r.clone().text();
    const w1 = warmHits;
    const head = (await warm('HEAD')).r;
    const headBody = await head.text();
    const w2 = warmHits;
    const evil = (await warm('GET', ENV, 'https://evil.example')).r;
    const w3 = warmHits;
    const unset = (await warm('GET', { ...ENV, SPACE_URL: '' })).r;
    for (const [name, ok, note] of [
        ['GET /warm -> 202 with the gate armed', r.status === 202, 'status=' + r.status],
        ['the model-load endpoint is poked', warmHits > w0, 'pokes=' + (w1 - w0)],
        ['the poke is handed to waitUntil', held.length === 1, 'held=' + held.length],
        ['the reply never claims it is ready', body === '{"warming":true}', 'body=' + body],
        ['HEAD /warm -> 202, no body', head.status === 202 && headBody === '', 'status=' + head.status],
        ['HEAD pokes too', warmHits > w1, 'pokes=' + (w2 - w1)],
        ['another site cannot spend our compute', evil.status === 403 && warmHits === w2, 'status=' + evil.status + ' pokes=' + (w3 - w2)],
        ['no SPACE_URL is still not an error', unset.status === 202 && warmHits === w3, 'status=' + unset.status],
    ]) {
        console.log((ok ? 'PASS' : 'FAIL') + '  ' + name.padEnd(44) + ' ' + note);
        ok ? pass++ : fail++;
    }
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
        GLOBAL_INFERENCE_BUDGET,
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

console.log('\n--- COMMUNITY PROXY ROUTING ---');
{
    const originalFetch = globalThis.fetch;
    let upstreamUrl = null;
    globalThis.fetch = async (input) => {
        upstreamUrl = String(input);
        return new Response(JSON.stringify({ status: 'ok' }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
        });
    };
    const env = { ALLOWED_ORIGINS: 'https://findflower.me' };
    const request = new Request('https://w.example/v1/community/', {
        headers: new Headers({ Origin: 'https://findflower.me' }),
    });
    const response = await worker.fetch(request, env);
    const ok = response.status === 200 && upstreamUrl === 'http://pat.hidencloud.com:24729/health';
    console.log((ok ? 'PASS' : 'FAIL') + '  /v1/community/ normalizes to /health');
    ok ? pass++ : fail++;
    globalThis.fetch = originalFetch;
}

console.log('\n--- SSR / AUTH PROXY ROUTING ---');
{
    const originalFetch = globalThis.fetch;
    let upstreamUrl = null;
    let upstreamInit = null;
    globalThis.fetch = async (input, init) => {
        upstreamUrl = String(input);
        upstreamInit = init;
        const headers = new Headers({ Location: 'https://auth.example/continue' });
        headers.append('Set-Cookie', 'transaction=one; Path=/; HttpOnly; Secure; SameSite=Lax');
        headers.append('Set-Cookie', 'session=two; Path=/; HttpOnly; Secure; SameSite=Lax');
        return new Response(null, { status: 302, headers });
    };

    const request = new Request('https://findflower.me/callback?code=abc&state=xyz', {
        headers: new Headers({
            'CF-Connecting-IP': '203.0.113.7',
            'X-Forwarded-Host': 'evil.example',
            'X-Forwarded-Proto': 'http',
            'X-Forwarded-For': '198.51.100.9',
        }),
    });
    const response = await worker.fetch(request, {
        SITE_UPSTREAM: 'http://pat.hidencloud.com:24729',
    });
    const forwarded = upstreamInit.headers;
    const assertions = [
        ['callback query reaches HidenCloud', upstreamUrl === 'http://pat.hidencloud.com:24729/callback?code=abc&state=xyz'],
        ['redirect handling stays manual', upstreamInit.redirect === 'manual'],
        ['forwarded host is canonical', forwarded.get('X-Forwarded-Host') === 'findflower.me'],
        ['forwarded protocol is https', forwarded.get('X-Forwarded-Proto') === 'https'],
        ['forwarded address uses Cloudflare IP', forwarded.get('X-Forwarded-For') === '203.0.113.7'],
        ['upstream redirect survives', response.status === 302 && response.headers.get('Location') === 'https://auth.example/continue'],
        ['both Set-Cookie headers survive', response.headers.getSetCookie().length === 2],
    ];
    for (const [name, ok] of assertions) {
        console.log((ok ? 'PASS' : 'FAIL') + '  ' + name);
        ok ? pass++ : fail++;
    }

    const fallbackHeaders = new Headers({ Location: 'https://findflower.me/' });
    fallbackHeaders.set(
        'Set-Cookie',
        'auth_verification=one; Path=/; Expires=Wed, 21 Oct 2030 07:28:00 GMT; HttpOnly; Secure, ff_session=two; Path=/; HttpOnly; Secure',
    );
    Object.defineProperty(fallbackHeaders, 'getSetCookie', { value: undefined });
    globalThis.fetch = async () => ({ status: 302, headers: fallbackHeaders, body: null });
    const fallbackResponse = await worker.fetch(
        new Request('https://findflower.me/callback?code=abc&state=xyz'),
        { SITE_UPSTREAM: 'http://pat.hidencloud.com:24729' },
    );
    const fallbackCookies = fallbackResponse.headers.getSetCookie();
    const fallbackOk = fallbackCookies.length === 2
        && fallbackCookies[0].startsWith('auth_verification=')
        && fallbackCookies[1].startsWith('ff_session=');
    console.log((fallbackOk ? 'PASS' : 'FAIL') + '  Set-Cookie fallback preserves Auth0 transaction and session cookies');
    fallbackOk ? pass++ : fail++;
    globalThis.fetch = originalFetch;
}

console.log('\n--- SSR SESSION + SSE PASSTHROUGH ---');
{
    const originalFetch = globalThis.fetch;
    for (const route of ['/api/notifications', '/api/messages/demo', '/api/events']) {
        let upstreamUrl = null;
        let upstreamInit = null;
        globalThis.fetch = async (input, init) => {
            upstreamUrl = String(input);
            upstreamInit = init;
            return new Response(route === '/api/events' ? 'event: ready\ndata: {}\n\n' : '{}', {
                status: 200,
                headers: { 'Content-Type': route === '/api/events' ? 'text/event-stream' : 'application/json' },
            });
        };
        const request = new Request(`https://findflower.me${route}`, {
            headers: {
                Cookie: 'ff_session=diagnostic-session',
                Authorization: 'Bearer diagnostic-token',
                ...(route === '/api/events' ? { Accept: 'text/event-stream' } : {}),
            },
        });
        const response = await worker.fetch(request, {
            SITE_UPSTREAM: 'http://pat.hidencloud.com:24729',
        });
        const forwarded = new Headers(upstreamInit.headers);
        const assertions = [
            [`${route} reaches HidenCloud`, upstreamUrl === `http://pat.hidencloud.com:24729${route}`],
            [`${route} preserves session cookie`, forwarded.get('Cookie') === 'ff_session=diagnostic-session'],
            [`${route} preserves Authorization`, forwarded.get('Authorization') === 'Bearer diagnostic-token'],
        ];
        if (route === '/api/events') {
            assertions.push(['SSE asks origin for an uncompressed stream', forwarded.get('Accept-Encoding') === 'identity']);
            assertions.push(['SSE response disables proxy buffering', response.headers.get('X-Accel-Buffering') === 'no']);
        }
        for (const [name, ok] of assertions) {
            console.log((ok ? 'PASS' : 'FAIL') + '  ' + name);
            ok ? pass++ : fail++;
        }
    }
    globalThis.fetch = originalFetch;
}

console.log('\n--- GLOBAL NAVIGATION ROUTING (catch-all) ---');
{
    // The regression this section exists for: /dashboard, /profile and /about
    // were answered by GitHub Pages' 404.html -- the static shell that boots the
    // SPA login client -- because the Worker only proxied an enumerated list of
    // paths. With the catch-all route, any navigation path is the server's.
    const env = { SITE_UPSTREAM: 'http://pat.hidencloud.com:24729' };
    const originalFetch = globalThis.fetch;
    let seen = null;
    globalThis.fetch = async (input, init) => {
        const url = input && input.url ? input.url : String(input);
        seen = { url, init: init || {} };
        return new Response('upstream', { status: 200, headers: { 'Content-Type': 'text/html' } });
    };
    function one(name, ok, detail) {
        console.log((ok ? 'PASS' : 'FAIL') + '  ' + name.padEnd(54) + (detail === undefined ? '' : detail));
        ok ? pass++ : fail++;
    }
    const forwarded = () => new Headers((seen && seen.init && seen.init.headers) || {});

    for (const path of ['/dashboard', '/profile', '/about', '/pricing', '/how', '/species', '/nope/not/a/page']) {
        seen = null;
        await worker.fetch(new Request('https://findflower.me' + path, { headers: { Accept: 'text/html' } }), env);
        one(path + ' is server-rendered',
            !!seen && seen.url === 'http://pat.hidencloud.com:24729' + path,
            seen ? seen.url : 'no fetch');
    }

    for (const path of ['/dashboard.html', '/chat/', '/chat/index.html', '/notifications/']) {
        seen = null;
        await worker.fetch(new Request('https://findflower.me' + path, { headers: { Accept: 'text/html' } }), env);
        one(path + ' is a document, not an asset',
            !!seen && seen.url === 'http://pat.hidencloud.com:24729' + path,
            seen ? seen.url : 'no fetch');
    }

    for (const path of ['/app.css', '/scripts/api.js', '/scripts/ssr-session.js',
        '/assets/flower.jpg', '/images/flower.jpg', '/favicon.svg', '/manifest.json', '/robots.txt']) {
        seen = null;
        await worker.fetch(new Request('https://findflower.me' + path), env);
        const cf = (seen && seen.init && seen.init.cf) || {};
        one(path + ' stays on the Pages origin',
            !!seen && seen.url === 'https://findflower.me' + path
            && cf.cacheEverything === true
            && forwarded().get('X-Forwarded-Host') === null,
            seen ? seen.url : 'no fetch');
    }

    seen = null;
    const warm = await worker.fetch(new Request('https://findflower.me/warm'), env);
    const warmBody = await warm.clone().text();
    // The page is not proxied -- the Worker answers /warm itself -- but the poke
    // it fires in the background has to land on the model loader. With the ViT
    // on the Node server that is SITE_UPSTREAM now, not the old Space.
    one('/warm is still the Worker own route',
        warm.status === 202 && warmBody === '{"warming":true}', 'status=' + warm.status);
    one('...and it warms the model on the Node server',
        !!seen && seen.url === 'http://pat.hidencloud.com:24729/warm', seen ? seen.url : 'no fetch');

    globalThis.fetch = originalFetch;

    // Without SITE_UPSTREAM nothing is proxied at all: the rollback is a var, not
    // a code change, which is what makes the catch-all safe to try.
    seen = null;
    const off = await worker.fetch(new Request('https://findflower.me/dashboard'), {});
    const offBody = await off.json();
    one('no SITE_UPSTREAM means the old behaviour', offBody.status === 'ok' && seen === null,
        'status=' + off.status);

    // A host-only session cookie cannot follow a visitor between www and the
    // apex, so one of the two names has to give: www redirects, once, keeping
    // the method and the path.
    seen = null;
    const www = await worker.fetch(new Request('https://www.findflower.me/dashboard?a=1', {
        method: 'POST',
    }), env);
    one('www redirects to the apex and keeps the path',
        www.status === 308 && www.headers.get('Location') === 'https://findflower.me/dashboard?a=1',
        'status=' + www.status + ' location=' + www.headers.get('Location'));
    one('...without a backend round trip', seen === null, seen ? seen.url : 'no fetch');
}

console.log('\n--- JWKS caching ---');
{
    const j0 = jwksHits;
    for (let i = 0; i < 4; i++) await post(await mint());
    console.log('4 valid scans caused ' + (jwksHits - j0) + ' JWKS fetch(es) (want 0-1)');
}

console.log('\n--- SCANNER ROUTE (/internal/scan) ---');
{
    // The app's own scanner posts here. It must reach the model, must not
    // spend the public allowance, and must keep working when that allowance
    // is gone: a visitor identifying a flower is not an API caller.
    function postTo(path, { origin = 'https://findflower.me', env = ENV, token } = {}) {
        const h = new Headers({ 'Content-Type': 'image/jpeg' });
        if (origin) h.set('Origin', origin);
        if (token) h.set('Authorization', 'Bearer ' + token);
        return worker.fetch(new Request('https://w.example' + path, {
            method: 'POST', headers: h, body: new Uint8Array([1, 2, 3, 4]),
        }), env);
    }
    const EXHAUSTED = {
        ...ENV,
        GLOBAL_INFERENCE_BUDGET: {
            idFromName: () => 'global-inference-budget',
            get: () => ({
                fetch: async () => new Response(JSON.stringify({
                    allowed: false, limit: 1000000, remaining: 0, retry_after: 600,
                    reset: Math.floor(Date.now() / 1000) + 600,
                    window_ends: new Date(Date.now() + 600000).toISOString(),
                }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
            }),
        },
    };
    function one(name, ok, detail) {
        console.log((ok ? 'PASS' : 'FAIL') + '  ' + name.padEnd(44) + (detail === undefined ? '' : detail));
        ok ? pass++ : fail++;
    }

    const before = spaceHits;
    const scan = await postTo('/internal/scan', { token: await mint() });
    one('scanner route reaches the Space', scan.status === 200 && spaceHits > before,
        'status=' + scan.status);
    one('scanner route is not metered', scan.headers.get('X-RateLimit-Limit') === null,
        'X-RateLimit-Limit=' + scan.headers.get('X-RateLimit-Limit'));

    const pub = await postTo('/v1/identify', { token: await mint() });
    one('public route still reports its allowance', pub.headers.get('X-RateLimit-Limit') === '1000000',
        'X-RateLimit-Limit=' + pub.headers.get('X-RateLimit-Limit'));

    // The API is account-only, and every refusal below has to land before the
    // pool is touched: an anonymous caller must never be able to spend a scan.
    const spentBefore = budgetHits;
    const anonApi = await postTo('/v1/identify');
    one('anonymous API call is refused', anonApi.status === 401, 'status=' + anonApi.status);
    one('...without touching the shared pool', budgetHits === spentBefore,
        'pool hits=' + (budgetHits - spentBefore));

    const shortApi = await postTo('/v1/identify', { token: 'not-a-token' });
    one('a malformed API token is refused', shortApi.status === 401, 'status=' + shortApi.status);

    const rogueKey = await crypto.subtle.generateKey(
        { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
        true, ['sign', 'verify']);
    const forgedApi = await postTo('/v1/identify', { token: await mint({}, {}, rogueKey.privateKey) });
    one('a forged API token is refused', forgedApi.status === 401, 'status=' + forgedApi.status);

    const anonApiDry = await postTo('/v1/identify', { env: DRY });
    one('the API rule ignores the dry-run lever', anonApiDry.status === 401, 'status=' + anonApiDry.status);
    const dryScan = await postTo('/internal/scan', { env: DRY });
    one('the dry run still serves the scanner', dryScan.status === 200, 'status=' + dryScan.status);

    const drainedPublic = await postTo('/v1/identify', { token: await mint(), env: EXHAUSTED });
    one('exhausted allowance stops API callers', drainedPublic.status === 429,
        'status=' + drainedPublic.status);
    const drainedScan = await postTo('/internal/scan', { token: await mint(), env: EXHAUSTED });
    one('...but visitors can still scan', drainedScan.status === 200,
        'status=' + drainedScan.status);

    const foreign = await postTo('/internal/scan', { origin: 'https://evil.example', token: await mint() });
    one('scanner route still honours the origin gate', foreign.status === 403,
        'status=' + foreign.status);
    const anon = await postTo('/internal/scan');
    one('scanner route still honours the auth gate', anon.status === 401,
        'status=' + anon.status);
}

console.log('\n--- INFERENCE UPSTREAM SELECTION ---');
{
    // The model moved off a Hugging Face Space onto the Node server. A leftover
    // SPACE_URL secret must not be able to pull scans back to a Space that no
    // longer answers, so SITE_UPSTREAM has to win whenever both are present.
    function one(name, ok, detail) {
        console.log((ok ? 'PASS' : 'FAIL') + '  ' + name.padEnd(44) + (detail === undefined ? '' : detail));
        ok ? pass++ : fail++;
    }
    function scanWith(env) {
        const h = new Headers({ 'Content-Type': 'image/jpeg', Origin: 'https://findflower.me' });
        h.set('Authorization', 'Bearer ' + token);
        return worker.fetch(new Request('https://w.example/v1/identify', {
            method: 'POST', headers: h, body: new Uint8Array([1, 2, 3, 4]),
        }), env);
    }
    const token = await mint();

    lastPredict = '';
    const staleSecret = await scanWith({ ...ENV, SITE_UPSTREAM: 'https://node.example' });
    one('a scan still succeeds', staleSecret.status === 200, 'status=' + staleSecret.status);
    one('SITE_UPSTREAM beats the stale SPACE_URL', lastPredict === 'https://node.example/predict',
        'target=' + lastPredict);

    lastPredict = '';
    const explicit = await scanWith({
        ...ENV, SITE_UPSTREAM: 'https://node.example', INFERENCE_UPSTREAM: 'https://gpu.example/',
    });
    one('INFERENCE_UPSTREAM beats SITE_UPSTREAM', explicit.status === 200
        && lastPredict === 'https://gpu.example/predict', 'target=' + lastPredict);

    lastPredict = '';
    const legacy = await scanWith({ ...ENV, SPACE_URL: 'https://legacy-space.example' });
    one('the legacy SPACE_URL still works alone', legacy.status === 200
        && lastPredict === 'https://legacy-space.example/predict', 'target=' + lastPredict);

    const nowhere = await scanWith({ ...ENV, SPACE_URL: undefined });
    const nowhereBody = await nowhere.clone().text();
    one('no upstream at all is a clear 500', nowhere.status === 500
        && nowhereBody.includes('misconfigured'), 'status=' + nowhere.status);
}

console.log('\n--- GLOBAL POOL (Durable Object) ---');
{
    // The DO is exported, so the batch arithmetic is tested directly instead of
    // being taken on trust from a stub. Storage is an in-memory Map and the
    // clock is mocked, because the pool size depends on when a batch opened --
    // which is exactly what a stub cannot prove.
    function one(name, ok, detail) {
        console.log((ok ? 'PASS' : 'FAIL') + '  ' + name.padEnd(44) + (detail === undefined ? '' : detail));
        ok ? pass++ : fail++;
    }
    const RealBudget = mod.GlobalInferenceBudget;
    function state(seed) {
        const store = new Map(seed || []);
        return { storage: { get: async (k) => store.get(k), put: async (k, v) => { store.set(k, v); } } };
    }
    const consume = (s) => new RealBudget(s)
        .fetch(new Request('https://quota.internal/consume', { method: 'POST' }))
        .then((r) => r.json());
    const realNow = Date.now;
    const at = (iso) => { Date.now = () => Date.parse(iso); };

    at('2026-09-14T03:30:00Z');   // 03:30 UTC -> the batch that opened at 00:00
    const shared = state();
    const first = await consume(shared);
    one('00:00 batch opens with 1,000,000',
        first.allowed === true && first.limit === 1000000 && first.remaining === 999999,
        'limit=' + first.limit + ' remaining=' + first.remaining);
    at('2026-09-14T03:45:00Z');
    const second = await consume(shared);
    one('...and the pool is shared, not per caller', second.remaining === 999998,
        'remaining=' + second.remaining);

    at('2026-09-14T12:00:01Z');   // the batch that opens at 12:00
    const third = await consume(shared);
    one('12:00 batch opens with 500,000',
        third.limit === 500000 && third.remaining === 499999,
        'limit=' + third.limit + ' remaining=' + third.remaining);

    at('2026-09-15T00:00:01Z');   // the next day's 00:00 batch
    const fourth = await consume(shared);
    one('a new batch reopens the whole pool',
        fourth.limit === 1000000 && fourth.remaining === 999999,
        'remaining=' + fourth.remaining);

    at('2026-09-15T05:00:00Z');
    const spentMorning = state([['window_start', Date.parse('2026-09-15T00:00:00Z')], ['used', 1000000]]);
    const drained = await consume(spentMorning);
    one('a spent 00:00 batch refuses until the next one',
        drained.allowed === false && drained.remaining === 0 && drained.limit === 1000000 && drained.retry_after > 0,
        'allowed=' + drained.allowed + ' retry_after=' + drained.retry_after);

    at('2026-09-15T13:00:00Z');
    const spentNoon = state([['window_start', Date.parse('2026-09-15T12:00:00Z')], ['used', 500000]]);
    const drainedNoon = await consume(spentNoon);
    one('a spent 12:00 batch refuses at 500,000',
        drainedNoon.allowed === false && drainedNoon.limit === 500000 && drainedNoon.remaining === 0,
        'allowed=' + drainedNoon.allowed + ' limit=' + drainedNoon.limit);

    at('2026-09-15T23:59:59Z');   // the last second of that batch is still that batch
    const drainedLate = await consume(spentNoon);
    one('the last second belongs to the same batch', drainedLate.limit === 500000,
        'limit=' + drainedLate.limit);

    Date.now = realNow;
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
