import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { destination, sourceForLive, assertSafeEntry } from './manifest.mjs';
import { isPublicAsset } from '../../server/lib/public-assets.js';

test('deployment maps backend files without overwriting them with frontend names', () => {
    assert.equal(destination('server/auth.js'), 'auth.js');
    assert.equal(destination('auth.js'), null);
    assert.equal(destination('server/package.json'), 'package.json');
    assert.equal(destination('package.json'), null);
    assert.equal(destination('server/models/user.js'), 'models/user.js');
    assert.equal(destination('models/lite/model.json'), 'models/lite/model.json');
    assert.equal(destination('manifest.json'), 'manifest.json');
    assert.equal(destination('consent.html'), 'consent.html');
});

test('deployment excludes credentials, repository metadata, model cache and scratch data', () => {
    for (const file of ['.env','server/.env','.git/config','.github/workflows/deploy.yml',
        'node_modules/pkg/index.js','scripts/generate-showcase/scratch/video.mp4',
        '.model-cache/model.onnxdata','training/manifest.json','my-secrets/password.txt',
        'github_token(classic).txt','credentials.json','server/scans.test.mjs']) {
        assert.equal(destination(file), null, file);
    }
});

test('every mapped deployment path has an unambiguous reverse source', () => {
    for (const source of ['server/index.js','server/supervisor.js','server/routes/identify.js','server/lib/public-assets.js',
        'server/package-lock.json','how.html','scripts/showcase-videos.js','assets/dash-engine.mp4',
        'models/lite/group1-shard1of3.bin','scripts/sync-server-to-github.mjs']) {
        assert.equal(sourceForLive(destination(source)), source);
    }
    assert.throws(() => assertSafeEntry({ source: '../how.html', destination: '../how.html', sha256: 'a'.repeat(64) }));
});

test('flat server serves model shards and PWA files but refuses backend source and secrets', () => {
    for (const file of ['/models/lite/model.json','/models/lite/group1-shard1of3.bin',
        '/assets/scan-input.mp4','/manifest.json','/sw.js','/scripts/showcase-videos.js','/.well-known/discord']) {
        assert.ok(isPublicAsset(file, { flat: true }), file);
    }
    for (const file of ['/index.js','/supervisor.js','/auth.js','/package.json','/models/user.js','/.env',
        '/assets/../.env','/assets/%2e%2e/.env','/scripts/hidencloud/manifest.mjs',
        '/scripts/sync-server-to-github.mjs','/.hidencloud/backups/how.html']) {
        assert.equal(isPublicAsset(file, { flat: true }), false, file);
    }
});

test('Worker preserves video ranges and requires PWA revalidation at the HidenCloud origin', async () => {
    const source = fs.readFileSync(new URL('../../proxy/worker.js', import.meta.url), 'utf8');
    const { default: worker } = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
    const original = globalThis.fetch;
    try {
        let seen;
        globalThis.fetch = async (url, options) => {
            seen = { url: String(url), options };
            return new Response('part', { status: 206, headers: { 'Content-Range': 'bytes 0-3/100', 'Cache-Control': 'public, max-age=600' } });
        };
        const env = { SITE_UPSTREAM: 'http://pat.hidencloud.com:24729' };
        const range = await worker.fetch(new Request('https://findflower.me/assets/scan-input.mp4', { headers: { Range: 'bytes=0-3' } }), env);
        assert.equal(seen.url, env.SITE_UPSTREAM + '/assets/scan-input.mp4');
        assert.equal(seen.options.headers.get('range'), 'bytes=0-3');
        assert.equal(range.status, 206);
        assert.equal(range.headers.get('content-range'), 'bytes 0-3/100');
        for (const file of ['sw.js','manifest.json']) {
            const response = await worker.fetch(new Request('https://findflower.me/' + file), env);
            assert.equal(response.headers.get('cache-control'), 'no-cache');
        }
    } finally { globalThis.fetch = original; }
});
