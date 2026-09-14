// Hand the herbarium to the account, and the account's herbarium back.
//
// A scan used to live in one browser's IndexedDB and nowhere else, which is why
// the same account could show three finds on a phone and an empty dashboard on a
// laptop: the records were never wrong, they were never in the same place. This
// runs on every server-rendered page and does both halves -- push what is here,
// then pull what is there and import it.
//
// Both directions are idempotent. The upload is keyed on the client's own record
// id, so re-sending a batch inserts nothing; the download goes through
// ffStore.importHistory, which skips an id it already holds. That is what makes
// it safe to run unattended on every load rather than behind a button someone
// has to remember to press on each device.
//
// Records are not deleted after a successful upload. A guest's scans stop being
// guest's scans the moment they sign in -- storage.js adopts them onto the
// account locally (see adopt()) -- but the rows themselves stay, because the
// offline page promises the reader their finds are still in this browser, and a
// herbarium that only exists once the network answers is a worse herbarium.
(function () {
    'use strict';

    var SSR = window.__FF_SSR__ || {};
    var auth = SSR.auth || {};
    // Signed out: there is no account to sync with, and the anonymous records
    // are already local. Most pages have no local store at all, and the read
    // below answers null for them.
    if (!auth.authenticated) return;

    var STAMP = 'ff_scan_sync_at';
    var WINDOW_MS = 60000;
    var HISTORY_KIND = 'findflower-history';
    var RUNNING = null;

    function recentlySynced() {
        try {
            var at = Number(sessionStorage.getItem(STAMP) || 0);
            return !!at && (Date.now() - at) < WINDOW_MS;
        } catch (e) {
            return false;
        }
    }

    function markSynced() {
        try { sessionStorage.setItem(STAMP, String(Date.now())); } catch (e) { /* private mode */ }
    }

    function api(path, opts) {
        var o = opts || {};
        // Same-origin, so the session cookie rides along on its own. The SSR
        // shim hands out no bearer token by design, and none is needed here.
        o.credentials = 'same-origin';
        o.headers = Object.assign({ Accept: 'application/json' }, o.headers || {});
        return fetch(path, o);
    }

    async function readLocal() {
        if (!window.ffStore || typeof ffStore.getSummary !== 'function') return null;
        try {
            var summary = await ffStore.getSummary();
            return (summary && summary.scans) || [];
        } catch (e) {
            return null;
        }
    }

    async function pushUp(scans) {
        if (!scans || !scans.length) return { added: 0, updated: 0, total: null };
        var res = await api('/api/scans/sync', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ scans: scans }),
        });
        if (!res.ok) throw new Error('upload answered ' + res.status);
        return res.json();
    }

    async function pullDown() {
        var res = await api('/api/scans?limit=2000');
        if (!res.ok) throw new Error('download answered ' + res.status);
        var body = await res.json();
        var rows = (body && body.scans) || [];
        if (!rows.length) return { scans: 0, skipped: 0 };
        if (!window.ffStore || typeof ffStore.importHistory !== 'function') return { scans: 0, skipped: rows.length };
        // The same reader the "restore from a file" path uses: it dedupes by
        // record id, rebuilds the scan count and deliberately leaves the streak
        // alone -- a find made on another device is not a day this browser was
        // opened.
        return ffStore.importHistory({
            kind: ffStore.HISTORY_KIND || HISTORY_KIND,
            scans: rows,
        });
    }

    // The dashboard paints from the local store, so an import that is not
    // followed by a repaint is invisible until the next navigation.
    function repaint() {
        var dash = window.ffDashboardView;
        if (dash && typeof dash.renderDiscoveries === 'function') {
            try { dash.renderDiscoveries({ limit: 6 }); } catch (e) { /* not this page */ }
        }
        try {
            document.dispatchEvent(new CustomEvent('ff:scans-synced', { detail: {} }));
        } catch (e) { /* very old browser */ }
    }

    async function run() {
        var local = await readLocal();
        if (local === null) return null;
        markSynced();
        var up = await pushUp(local);
        var down = await pullDown();
        repaint();
        return {
            pushed: local.length,
            added: up.added || 0,
            pulled: down.scans || 0,
            total: typeof up.total === 'number' ? up.total : null,
        };
    }

    function start(force) {
        if (RUNNING) return RUNNING;
        if (!force && recentlySynced()) return Promise.resolve(null);
        RUNNING = run()
            .then(function (r) {
                // Cleared once settled, not held: RUNNING exists to fold two
                // concurrent calls into one request, and a promise that outlives
                // the work would make a deliberate retry a no-op instead.
                RUNNING = null;
                if (r) {
                    console.log('[sync] herbarium: sent ' + r.pushed + ', server added ' + r.added
                        + ', pulled ' + r.pulled + (r.total === null ? '' : ', account holds ' + r.total));
                }
                return r;
            })
            .catch(function (err) {
                // Offline, or the server is mid-deploy. Nothing is lost: the
                // local records are untouched and the next page load retries.
                RUNNING = null;
                console.warn('[sync] herbarium sync skipped:', err && err.message ? err.message : err);
                return null;
            });
        return RUNNING;
    }

    window.ffScanSync = { run: start, pushUp: pushUp, pullDown: pullDown, repaint: repaint };

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function () { start(); });
    else start();
})();
