import test from 'node:test';
import assert from 'node:assert/strict';

// Exercise the actual pre-cutover check without credentials or production calls.
async function runCheck(name, respond) {
    const original = { fetch: globalThis.fetch, timeout: globalThis.setTimeout,
        argv: process.argv, origin: process.env.VERIFY_ORIGIN };
    const seen = [];
    process.argv = [...process.argv, '--origin-only'];
    process.env.VERIFY_ORIGIN = 'http://origin.invalid';
    globalThis.setTimeout = callback => { queueMicrotask(callback); return 0; };
    globalThis.fetch = async (url, options = {}) => {
        const path = new URL(url).pathname;
        seen.push({ path, method: options.method || 'GET' });
        const override = respond?.(path, options, seen);
        if (override) return override;
        if (path === '/health') return Response.json({ service: 'findflower' });
        if (path === '/internal/scan') return Response.json({ error: 'Unauthorized' }, { status: 401 });
        if (path === '/how') return new Response('<video data-showcase></video>'.repeat(5));
        if (path.endsWith('.mp4')) {
            assert.equal(options.headers.Range, 'bytes=0-31');
            return new Response('video', { status: 206, headers: { 'Content-Type': 'video/mp4' } });
        }
        if (path === '/manifest.json') return Response.json({ name: 'FindFlower', icons: [{}] });
        if (path === '/sw.js') return new Response("addEventListener('fetch', () => {})", { headers: { 'Content-Type': 'text/javascript' } });
        if (path === '/models/lite/model.json') return Response.json({ weightsManifest: [{ paths: ['weights.bin'] }] });
        if (path === '/models/lite/class_names.json') return Response.json(['canna lily']);
        if (path === '/models/lite/weights.bin') return new Response('weights');
        return new Response('Not found', { status: 404 });
    };
    try {
        await import(`./verify-live.mjs?case=${name}`);
        return seen;
    } finally {
        globalThis.fetch = original.fetch;
        globalThis.setTimeout = original.timeout;
        process.argv = original.argv;
        if (original.origin === undefined) delete process.env.VERIFY_ORIGIN;
        else process.env.VERIFY_ORIGIN = original.origin;
    }
}

test('origin readiness waits beyond old-process health and verifies assets without inference', async () => {
    let probes = 0;
    const seen = await runCheck('restart', (path, options) => {
        if (path === '/models/lite/model.json' && options.method === 'HEAD' && probes++ === 0) {
            return new Response('old process', { status: 404 });
        }
    });
    assert.equal(seen.filter(r => r.path === '/health').length, 2);
    assert.equal(seen.filter(r => r.path.endsWith('.mp4')).length, 5);
    assert.ok(seen.some(r => r.path.endsWith('/weights.bin')));
    assert.ok(seen.some(r => r.path === '/package.json'));
});

test('origin readiness fails when a model shard is missing', async () => {
    await assert.rejects(runCheck('missing-shard', path => {
        if (path.endsWith('/weights.bin')) return new Response('missing', { status: 404 });
    }), /weights.bin: HTTP 404/);
});

test('origin readiness refuses a server exposing backend source', async () => {
    await assert.rejects(runCheck('source-exposure', path => {
        if (path === '/index.js') return new Response('backend source');
    }), /Backend source must stay private/);
});

test('healthy old process without the protected scan alias cannot pass readiness', async () => {
    await assert.rejects(runCheck('missing-alias', path => {
        if (path === '/internal/scan') return new Response('missing', { status: 404 });
    }), /has not loaded the new model\/scan routes/);
});
