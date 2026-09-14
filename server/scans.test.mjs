// The herbarium's wire format, its server render, and the browser sync that
// joins the two.
//
// No database and no network: every assertion here is about a pure function or
// a stubbed call, which is the point -- the parts of the two-device sync that
// can silently go wrong (a field renamed, a grid left hidden, an upload sent
// without the session) are all decidable without Mongo.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { toClientScan, fromClientScan } from './models/scan.js';
import { renderPage } from './lib/ssr.js';

let pass = 0, fail = 0;
function one(name, ok, detail) {
    console.log((ok ? 'PASS' : 'FAIL') + '  ' + name.padEnd(56) + (detail === undefined ? '' : detail));
    ok ? pass++ : fail++;
}

console.log('--- WIRE FORMAT ---');
{
    const wire = fromClientScan({
        id: 'abc-1', species: 'Taraxacum officinale', confidence: 0.9999,
        imageBase64: 'data:image/jpeg;base64,AAAA', timestamp: '2026-09-14T10:00:00.000Z',
        family: 'Asteraceae', geolocation: { lat: 1, lng: 2 }, albumId: 'alb-1',
        correction: { species: 'Leontodon', at: '2026-09-14T11:00:00.000Z', shared: true }, unknown: false,
    });
    one('a complete record normalises', !!wire && wire.clientId === 'abc-1');
    one('...its timestamp survives', wire.scannedAt.toISOString() === '2026-09-14T10:00:00.000Z');
    one('...the correction is kept', wire.correction.species === 'Leontodon' && wire.correction.shared === true);
    one('confidence is clamped into 0..1',
        fromClientScan({ id: 'x', timestamp: '2026-01-01T00:00:00Z', confidence: 95 }).confidence === 1);

    // A record that cannot be de-duplicated must be refused, not defaulted: an
    // id invented here would arrive twice on the next sync and double the find.
    one('a record with no id is refused', fromClientScan({ timestamp: '2026-01-01T00:00:00Z' }) === null);
    one('a record with no timestamp is refused', fromClientScan({ id: 'x' }) === null);
    one('a record with a junk timestamp is refused', fromClientScan({ id: 'x', timestamp: 'not-a-date' }) === null);
    one('a non-object is refused', fromClientScan('nope') === null && fromClientScan(null) === null);
    one('an oversized thumbnail is dropped, not the record',
        (() => { const r = fromClientScan({ id: 'x', timestamp: '2026-01-01T00:00:00Z', imageBase64: 'x'.repeat(40000) }); return r !== null && r.thumb === null; })());

    const row = {
        clientId: 'abc-1', species: 'Daisy', confidence: 0.5, thumb: 'data:image/jpeg;base64,BBBB',
        scannedAt: new Date('2026-09-14T10:00:00.000Z'), family: 'Asteraceae', albumId: null,
        geolocation: null, correction: { species: 'Bellis', at: new Date('2026-09-14T11:00:00.000Z'), shared: false }, unknown: true,
    };
    const client = toClientScan(row);
    one('the wire shape uses the local names',
        client.id === 'abc-1' && client.imageBase64 === row.thumb && client.timestamp === '2026-09-14T10:00:00.000Z');
    one('...and the correction round-trips', client.correction.species === 'Bellis' && client.correction.shared === false);
    one('a missing correction reads as null',
        toClientScan({ clientId: 'z', species: 'x', scannedAt: new Date(), correction: {} }).correction === null);

    const back = toClientScan(fromClientScan({ ...client, timestamp: client.timestamp, correction: client.correction }));
    one('a round trip is lossless for the fields that matter',
        back.id === client.id && back.species === client.species && back.imageBase64 === client.imageBase64
        && back.timestamp === client.timestamp && back.correction.species === client.correction.species);
}

console.log('\n--- SERVER RENDER (/dashboard) ---');
{
    function fakeRes() {
        const out = { code: 200, headers: {}, body: '' };
        return {
            out,
            status(c) { out.code = c; return this; },
            set(k, v) { out.headers[k] = v; return this; },
            type() { return this; },
            send(b) { out.body = String(b); return this; },
        };
    }
    const scans = [
        {
            id: 's1', species: 'Taraxacum officinale', confidence: 0.9991, imageBase64: 'data:image/jpeg;base64,AAAA',
            timestamp: new Date(Date.now() - 3600_000).toISOString(), family: 'Asteraceae', albumId: null,
            geolocation: null, correction: null, unknown: false,
        },
        {
            id: 's2', species: 'bellis perennis', confidence: 0.4, imageBase64: null,
            timestamp: new Date(Date.now() - 86400_000 * 2).toISOString(), family: 'Asteraceae', albumId: null,
            geolocation: null, correction: { species: 'Bellis perennis', at: null, shared: true }, unknown: false,
        },
    ];
    const res = fakeRes();
    await renderPage({}, res, 'dashboard', {
        session: { authenticated: true, user: { sub: 'auth0|x', name: 'Dev', email: 'd@x' } },
        data: { authenticated: true, scans, total: 2, count: 2 },
        viewerId: 'u1',
    });
    const html = res.out.body;
    one('the dashboard renders', res.out.code === 200 && html.includes('recentGrid'));
    one('the grid is un-hidden', html.includes('<div id="recentGrid" class="grid grid-cols-2 lg:grid-cols-3 gap-4">'));
    one('the empty state is hidden', html.includes('id="recentEmpty" class="hidden '));
    one('a card carries its record id', html.includes('data-scan-id="s1"'));
    one('the model answer is title-cased', html.includes('Taraxacum Officinale'));
    one('the reader correction wins over the model', html.includes('Bellis Perennis'));
    one('confidence is a percentage', html.includes('>100%<'));
    one('a record with no thumbnail still renders', html.includes('text-sage-400'));
    one('the sync script is booted', html.includes('/scripts/sync-scans.js'));
    one('the server inlines who this is', html.includes('"authenticated":true'));

    // A signed-out visitor keeps the shell it shipped with.
    const anon = fakeRes();
    await renderPage({}, anon, 'dashboard', {
        session: { authenticated: false, user: null }, data: { authenticated: false, scans: [], total: 0 },
    });
    one('signed out leaves the empty state alone', !anon.out.body.includes('id="recentEmpty" class="hidden '));
    one('signed out still renders the page', anon.out.body.includes('recentGrid'));
}

console.log('\n--- BROWSER SYNC (guest to account) ---');
{
    const src = readFileSync(fileURLToPath(new URL('../scripts/sync-scans.js', import.meta.url)), 'utf8');
    const local = [
        { id: 'a', species: 'Daisy', confidence: 0.5, imageBase64: 'data:image/jpeg;base64,A', timestamp: '2026-09-01T10:00:00.000Z' },
        { id: 'b', species: 'Rose', confidence: 0.7, imageBase64: null, timestamp: '2026-09-02T10:00:00.000Z' },
    ];
    const remote = [{ id: 'c', species: 'Lily', confidence: 0.9, imageBase64: null, timestamp: '2026-09-03T10:00:00.000Z' }];

    // The script is a browser IIFE that reads bare globals (ffStore, fetch), so
    // the harness publishes them on globalThis exactly as a page would.
    function harness(opts) {
        const o = opts || {};
        const calls = [];
        const store = {
            HISTORY_KIND: 'findflower-history',
            getSummary: async () => ({ scans: o.scans === undefined ? local : o.scans, stats: {} }),
            importHistory: async (bundle) => {
                calls.push({ kind: 'import', bundle });
                return { albums: 0, scans: bundle.scans.length, skipped: 0 };
            },
        };
        globalThis.window = {
            __FF_SSR__: { auth: { authenticated: o.signedIn !== false, user: { sub: 'auth0|x' } } },
            ffStore: o.store === false ? undefined : store,
        };
        if (o.store !== false) globalThis.ffStore = store;
        globalThis.document = { readyState: 'complete', addEventListener() {}, dispatchEvent() {} };
        globalThis.sessionStorage = {
            store: {},
            getItem(k) { return this.store[k] || null; },
            setItem(k, v) { this.store[k] = v; },
        };
        globalThis.fetch = async (path, init) => {
            calls.push({ kind: 'fetch', path, init });
            if (o.failFetch) throw new Error('offline');
            if (String(path).startsWith('/api/scans')) {
                return { ok: true, status: 200, json: async () => ({ scans: o.remote === undefined ? remote : o.remote, total: 3 }) };
            }
            return { ok: true, status: 200, json: async () => ({ added: 2, updated: 0, total: 3 }) };
        };
        new Function(src)();
        return { win: globalThis.window, calls };
    }
    const tick = () => new Promise((r) => setTimeout(r, 20));
    const quiet = console.log;
    console.log = () => {};

    const h = harness({});
    await tick();
    const posts = h.calls.filter((c) => c.kind === 'fetch' && c.init && c.init.method === 'POST');
    const gets = h.calls.filter((c) => c.kind === 'fetch' && (!c.init || !c.init.method));
    const imp = h.calls.find((c) => c.kind === 'import');
    console.log = quiet;
    one('local records are posted up', posts.length === 1 && posts[0].path === '/api/scans/sync', 'posts=' + posts.length);
    one('...with the session cookie', posts.length === 1 && posts[0].init.credentials === 'same-origin');
    one('...carrying every local record', posts.length === 1 && JSON.parse(posts[0].init.body).scans.length === 2);
    one('the account history is pulled down', gets.length === 1 && gets[0].path.startsWith('/api/scans?limit='));
    one('the pulled rows go through importHistory', !!imp);
    one('...in the bundle shape the store accepts',
        !!imp && imp.bundle.kind === 'findflower-history' && imp.bundle.scans[0].id === 'c');
    one('a manual retry is exposed', typeof h.win.ffScanSync.run === 'function');

    console.log = () => {};
    const out = harness({ signedIn: false });
    await tick();
    const noStore = harness({ store: false });
    await tick();
    const off = harness({ failFetch: true });
    await tick();
    console.log = quiet;
    one('a signed-out page makes no calls', out.calls.length === 0, 'calls=' + out.calls.length);
    one('a page without storage.js makes no calls', noStore.calls.length === 0, 'calls=' + noStore.calls.length);
    one('an offline sync imports nothing', !off.calls.some((c) => c.kind === 'import'));

    console.log = () => {};
    const again = harness({});
    await tick();
    const first = again.calls.length;
    again.win.ffScanSync.run();
    await tick();
    const afterSkip = again.calls.length;
    again.win.ffScanSync.run(true);
    await tick();
    const afterForce = again.calls.length;
    console.log = quiet;
    one('a repeat sync inside the window is skipped', afterSkip === first, 'extra=' + (afterSkip - first));
    one('...unless it is forced', afterForce > first, 'extra=' + (afterForce - first));
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
