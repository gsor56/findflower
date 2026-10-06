import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
const originOnly = process.argv.includes('--origin-only');
let base = process.env.VERIFY_ORIGIN;
if (!base && originOnly) {
    const config = await fs.readFile(new URL('../../proxy/wrangler.toml', import.meta.url), 'utf8');
    base = config.match(/^SITE_UPSTREAM\s*=\s*"([^"]+)"/m)?.[1];
    assert.ok(base, 'SITE_UPSTREAM is required for the origin readiness check');
}
base = (base || 'https://findflower.me').replace(/\/+$/, '');
async function get(path, options) {
    const response = await fetch(base + path, { signal: AbortSignal.timeout(180000), ...options });
    assert.equal(response.status, 200, `${path}: HTTP ${response.status}`);
    return response;
}
// Allow the panel restart and model initialization to finish.
let healthy = false;
for (let attempt = 0; attempt < 24; attempt++) {
    try {
        const response = await fetch(base + '/health', { signal: AbortSignal.timeout(10000) });
        healthy = response.ok && (await response.json()).service === 'findflower';
        if (healthy && originOnly) {
            // A restart request can be accepted while the old process still
            // answers /health. Wait for the new model route as well.
            const model = await fetch(base + '/models/lite/model.json', {
                method: 'HEAD', signal: AbortSignal.timeout(10000),
            });
            const scan = await fetch(base + '/internal/scan', {
                method: 'POST', signal: AbortSignal.timeout(10000),
            });
            healthy = model.status === 200 && scan.status === 401;
            await scan.body?.cancel();
        }
    } catch { healthy = false; }
    if (healthy) break;
    await new Promise(resolve => setTimeout(resolve, 5000));
}
assert.ok(healthy, originOnly ? 'HidenCloud has not loaded the new model/scan routes; check its restart' : 'HidenCloud health check did not recover');

// A deploy is only real once the running process has loaded the new commit. An
// upload without a restart leaves the old process answering, and because the
// stamp is read at startup it keeps reporting the commit it began with - so a
// restart that silently did nothing fails here instead of passing quietly.
const expectedCommit = process.env.EXPECTED_COMMIT;
if (expectedCommit) {
    let seen = null;
    let last = 'no answer';
    for (let attempt = 0; attempt < 24; attempt++) {
        try {
            const response = await fetch(base + '/version', {
                cache: 'no-store',
                signal: AbortSignal.timeout(10000),
            });
            last = `HTTP ${response.status}`;
            if (response.ok) {
                seen = await response.json();
                last = `commit ${seen.commit}`;
                if (seen.commit === expectedCommit) break;
            } else {
                await response.body?.cancel();
            }
        } catch (error) { last = error.message; }
        await new Promise(resolve => setTimeout(resolve, 5000));
    }
    assert.equal(seen && seen.commit, expectedCommit,
        `HidenCloud is serving ${last}, not ${expectedCommit}. The files may be uploaded but the process was not restarted.`);
    console.log(`PASS: live commit ${seen.commit}, built ${seen.builtAt}, process started ${seen.startedAt}`);
}
const how = await (await get('/how')).text();
assert.equal((how.match(/<video\b[^>]*data-showcase/g) || []).length, 5, 'Expected five showcase videos');
for (const name of ['dash-engine','scan-correction','scan-input','scan-ranking','species-fields']) {
    const response = await fetch(`${base}/assets/${name}.mp4`, { headers: { Range: 'bytes=0-31' }, signal: AbortSignal.timeout(15000) });
    assert.equal(response.status, 206, `${name}: video range request`);
    assert.match(response.headers.get('content-type') || '', /video\/mp4/);
    await response.arrayBuffer();
}
const manifest = await (await get('/manifest.json')).json();
assert.ok(manifest.name && manifest.icons?.length, 'Invalid PWA manifest');
const worker = await get('/sw.js');
assert.match(worker.headers.get('content-type') || '', /javascript/);
assert.match(await worker.text(), /addEventListener\('fetch'/);
const graph = await (await get('/models/lite/model.json')).json();
const classes = await (await get('/models/lite/class_names.json')).json();
assert.ok(Array.isArray(classes) && classes.length > 0, 'Browser model class names are missing');
for (const group of graph.weightsManifest) {
    for (const shard of group.paths) {
        const response = await get('/models/lite/' + shard);
        await response.arrayBuffer();
    }
}
if (originOnly) {
    // Confirms the new backend route and its configured secret gate without
    // sending secrets over the origin's HTTP connection or running inference.
    const scan = await fetch(base + '/internal/scan', { method: 'POST', signal: AbortSignal.timeout(15000) });
    assert.equal(scan.status, 401, 'Origin /internal/scan must exist and reject requests without the proxy secret');
    assert.equal((await scan.json()).error, 'Unauthorized');
    for (const file of ['/index.js', '/package.json', '/lib/public-assets.js']) {
        const response = await fetch(base + file, { signal: AbortSignal.timeout(15000) });
        assert.equal(response.status, 404, `Backend source must stay private: ${file}`);
        await response.body?.cancel();
    }
    console.log('PASS: HidenCloud origin serves five videos, PWA and browser models; scan route is protected');
} else {
    const form = new FormData();
    const photo = await fs.readFile(new URL('../generate-showcase/fixtures/cc0-bird-b.jpg', import.meta.url));
    form.append('file', new Blob([photo], { type: 'image/jpeg' }), 'verification.jpg');
    const prediction = await (await get('/internal/scan', { method: 'POST', headers: { Origin: base }, body: form })).json();
    assert.equal(typeof prediction.flower, 'string', 'Scan must return a prediction, not a static page');
    assert.equal(typeof prediction.confidence, 'number');
    console.log('PASS: five videos, byte-range playback, PWA, browser model shards and a real backend scan');
}
