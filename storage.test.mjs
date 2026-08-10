/**
 * storage.js schema tests — the v1 -> v2 user-scoping migration.
 *
 * Run:  node storage.test.mjs        (no dependencies, same as worker.test.mjs)
 *
 * storage.js talks to real IndexedDB, which Node has no version of, so this
 * file carries a small in-memory shim faithful to the three behaviours the
 * migration actually leans on:
 *
 *   1. records whose index keyPath is missing are ABSENT from that index
 *      (this is why v1 rows are invisible to the userId index until stamped),
 *   2. compound [userId, timestamp] keys compare element-wise,
 *   3. a versionchange transaction commits only after every request inside
 *      onupgradeneeded has settled.
 *
 * If the shim and a browser ever disagree, the browser is right — but all
 * three rules above are checked against the spec's ordering, not guessed.
 */
import { promises as fs } from 'node:fs';
import vm from 'node:vm';

// ---- IndexedDB key ordering (spec: number < date < string < binary < array)
function cmp(a, b) {
    const ta = Array.isArray(a) ? 3 : typeof a === 'string' ? 2 : 1;
    const tb = Array.isArray(b) ? 3 : typeof b === 'string' ? 2 : 1;
    if (ta !== tb) return ta < tb ? -1 : 1;
    if (ta === 3) {
        for (let i = 0; i < Math.min(a.length, b.length); i++) {
            const c = cmp(a[i], b[i]);
            if (c) return c;
        }
        return a.length === b.length ? 0 : a.length < b.length ? -1 : 1;
    }
    return a < b ? -1 : a > b ? 1 : 0;
}

class KeyRange {
    constructor(lower, upper, lo = false, uo = false) {
        this.lower = lower; this.upper = upper;
        this.lowerOpen = lo; this.upperOpen = uo;
    }
    static only(v) { return new KeyRange(v, v); }
    static bound(l, u, lo, uo) { return new KeyRange(l, u, !!lo, !!uo); }
    includes(k) {
        if (this.lower !== undefined) {
            const c = cmp(k, this.lower);
            if (c < 0 || (c === 0 && this.lowerOpen)) return false;
        }
        if (this.upper !== undefined) {
            const c = cmp(k, this.upper);
            if (c > 0 || (c === 0 && this.upperOpen)) return false;
        }
        return true;
    }
}

/** Pull an index key out of a record; undefined if any component is missing. */
function extract(value, keyPath) {
    if (Array.isArray(keyPath)) {
        const out = [];
        for (const p of keyPath) {
            const v = value[p];
            if (v === undefined || v === null) return undefined; // not indexed
            out.push(v);
        }
        return out;
    }
    const v = value[keyPath];
    return v === undefined || v === null ? undefined : v;
}

class FakeIndex {
    constructor(store, name, keyPath) {
        this.store = store; this.name = name; this.keyPath = keyPath;
    }
    /** [indexKey, primaryKey, value] for every record that HAS this key. */
    entries() {
        const out = [];
        for (const [pk, value] of this.store.records) {
            const k = extract(value, this.keyPath);
            if (k === undefined) continue;
            out.push([k, pk, value]);
        }
        out.sort((a, b) => cmp(a[0], b[0]) || cmp(a[1], b[1]));
        return out;
    }
    count(keyOrRange) {
        const r = keyOrRange instanceof KeyRange ? keyOrRange
            : keyOrRange === undefined ? null : KeyRange.only(keyOrRange);
        return this.store._req(() =>
            this.entries().filter(([k]) => !r || r.includes(k)).length);
    }
    openCursor(range, dir) { return this.store._cursor(this.entries(), range, dir); }
}
// Requests settle on a microtask queue that the transaction drains before it
// commits — the property migrateToV2() depends on.
class FakeStore {
    constructor(db, name, keyPath) {
        this.db = db; this.name = name; this.keyPath = keyPath;
        this.records = new Map();
        this.indexes = new Map();
    }
    get indexNames() {
        const names = [...this.indexes.keys()];
        return { contains: (n) => names.includes(n) };
    }
    createIndex(name, keyPath) {
        const idx = new FakeIndex(this, name, keyPath);
        this.indexes.set(name, idx);
        return idx;
    }
    index(name) {
        const i = this.indexes.get(name);
        if (!i) throw new Error('no such index: ' + name);
        return i;
    }
    _req(fn) {
        const req = { onsuccess: null, onerror: null, result: undefined };
        this.db._pending++;
        Promise.resolve().then(() => {
            req.result = fn();
            if (req.onsuccess) req.onsuccess({ target: req });
            this.db._pending--;
        });
        return req;
    }
    get(key) { return this._req(() => this.records.get(key)); }
    put(value) {
        return this._req(() => {
            this.records.set(value[this.keyPath], JSON.parse(JSON.stringify(value)));
            return value[this.keyPath];
        });
    }
    delete(key) { return this._req(() => { this.records.delete(key); }); }
    clear() { return this._req(() => { this.records.clear(); }); }
    count() { return this._req(() => this.records.size); }
    openCursor(range, dir) {
        const rows = [...this.records.entries()]
            .map(([pk, v]) => [pk, pk, v])
            .sort((a, b) => cmp(a[0], b[0]));
        return this._cursor(rows, range, dir);
    }
    /** rows: [key, primaryKey, value][] */
    _cursor(rows, range, dir) {
        let list = rows.filter(([k]) => !range || range.includes(k));
        if (dir === 'prev') list = list.reverse();
        const req = { onsuccess: null, onerror: null, result: null };
        let i = 0;
        const step = () => {
            this.db._pending++;
            Promise.resolve().then(() => {
                if (i >= list.length) {
                    req.result = null;
                } else {
                    const [, pk, value] = list[i++];
                    req.result = {
                        key: pk, primaryKey: pk, value,
                        continue: () => step(),
                        update: (nv) => this.put(nv),
                        delete: () => this.delete(pk),
                    };
                }
                if (req.onsuccess) req.onsuccess({ target: req });
                this.db._pending--;
            });
        };
        step();
        return req;
    }
}

class FakeDB {
    constructor(name) {
        this.name = name; this.version = 0;
        this.stores = new Map();
        this._pending = 0;
    }
    get objectStoreNames() {
        const names = [...this.stores.keys()];
        return { contains: (n) => names.includes(n) };
    }
    createObjectStore(name, opts) {
        const s = new FakeStore(this, name, opts.keyPath);
        this.stores.set(name, s);
        return s;
    }
    objectStore(name) {
        const s = this.stores.get(name);
        if (!s) throw new Error('no such store: ' + name);
        return s;
    }
    transaction(names, mode) {
        const t = {
            objectStore: (n) => this.objectStore(n),
            oncomplete: null, onerror: null, onabort: null, error: null,
        };
        // Drain every queued request, then commit — mirrors a real transaction.
        const settle = async () => {
            for (let i = 0; i < 5000; i++) {
                await Promise.resolve();
                if (this._pending === 0) break;
            }
            if (t.oncomplete) t.oncomplete();
        };
        Promise.resolve().then(settle);
        return t;
    }
    /** Snapshot for assertions. */
    dump(store) { return [...this.objectStore(store).records.values()]; }
}

const DBS = new Map();
const indexedDB = {
    open(name, version) {
        const req = {
            onupgradeneeded: null, onsuccess: null, onerror: null,
            onblocked: null, result: null, transaction: null,
        };
        Promise.resolve().then(async () => {
            let db = DBS.get(name);
            if (!db) { db = new FakeDB(name); DBS.set(name, db); }
            req.result = db;
            const oldVersion = db.version;
            if (version > db.version) {
                const t = db.transaction([], 'versionchange');
                req.transaction = { objectStore: (n) => db.objectStore(n) };
                db.version = version;
                if (req.onupgradeneeded) {
                    req.onupgradeneeded({ target: req, oldVersion, newVersion: version });
                }
                // let the upgrade's own requests finish before opening
                for (let i = 0; i < 5000; i++) {
                    await Promise.resolve();
                    if (db._pending === 0) break;
                }
                void t;
            }
            if (req.onsuccess) req.onsuccess({ target: req });
        });
        return req;
    },
};
// ---- load storage.js into a fake window --------------------------------
const src = await fs.readFile(new URL('./storage.js', import.meta.url), 'utf8');

/** Fresh module instance over a given starting DB state and ffUser(). */
function loadStore({ user = null } = {}) {
    // storage.js guards on `window.crypto` but calls bare `crypto` — the same
    // object in a browser, so both names must exist here or newId() throws.
    const cryptoStub = { randomUUID: () => 'id_' + (loadStore._n = (loadStore._n || 0) + 1) };
    const win = {
        indexedDB,
        crypto: cryptoStub,
        ffUser: user === null ? undefined : async () => user,
    };
    const ctx = vm.createContext({
        window: win, indexedDB, IDBKeyRange: KeyRange, crypto: cryptoStub,
        console, Promise, Date, Math, Set, Map, Array, Object, String, Number, JSON,
        setTimeout, Image: undefined, document: undefined, URL, sessionStorage: undefined,
    });
    ctx.globalThis = ctx;
    new vm.Script(src, { filename: 'storage.js' }).runInContext(ctx);
    return win.ffStore;
}

let pass = 0, fail = 0;
function check(name, got, want) {
    const ok = JSON.stringify(got) === JSON.stringify(want);
    console.log((ok ? 'PASS' : 'FAIL') + '  ' + name +
        (ok ? '' : '\n        got  ' + JSON.stringify(got) + '\n        want ' + JSON.stringify(want)));
    ok ? pass++ : fail++;
}

const DB = 'findflower';
const reset = () => DBS.delete(DB);

// ---- seed a v1 database, exactly as the shipped v1 schema wrote it ------
async function seedV1(rows, stats) {
    reset();
    const db = new FakeDB(DB);
    db.version = 1;
    const s = db.createObjectStore('scans', { keyPath: 'id' });
    s.createIndex('timestamp', 'timestamp');
    s.createIndex('species', 'species');
    const st = db.createObjectStore('stats', { keyPath: 'key' });
    for (const r of rows) s.records.set(r.id, r);   // NOTE: no userId field
    if (stats) st.records.set('global', stats);
    DBS.set(DB, db);
    return db;
}

console.log('--- v1 -> v2 migration ---');
{
    const db = await seedV1(
        [
            { id: 'a', species: 'rose', confidence: 0.9, timestamp: '2026-08-01T10:00:00.000Z', imageBase64: null, geolocation: null },
            { id: 'b', species: 'tulip', confidence: 0.8, timestamp: '2026-08-02T10:00:00.000Z', imageBase64: null, geolocation: null },
        ],
        { key: 'global', totalScans: 2, currentStreak: 2, lastScanDate: '2026-08-02', unlockedBadges: ['first-discovery'] }
    );

    const store = loadStore({ user: null });        // try.html: no auth loaded
    const scans = await store.getScans();

    check('v1 rows survive the upgrade', db.dump('scans').length, 2);
    check('every legacy row is stamped UNCLAIMED',
        db.dump('scans').every((r) => r.userId === '__unclaimed__'), true);
    check('legacy "global" stats row is retired',
        db.dump('stats').some((r) => r.key === 'global'), false);
    check('legacy stats move to UNCLAIMED, progress intact',
        db.dump('stats').find((r) => r.key === '__unclaimed__').unlockedBadges, ['first-discovery']);
    check('signed-out read sees the unclaimed history', scans.map((s) => s.species), ['tulip', 'rose']);
    check('  ...newest first', scans[0].timestamp > scans[1].timestamp, true);
}

console.log('\n--- adoption on first sign-in ---');
{
    await seedV1(
        [{ id: 'a', species: 'rose', timestamp: '2026-08-01T10:00:00.000Z' }],
        { key: 'global', totalScans: 1, currentStreak: 3, lastScanDate: '2026-08-01', unlockedBadges: ['first-discovery'] }
    );
    const store = loadStore({ user: { sub: 'auth0|alice' } });
    const mine = await store.getDiscoveries();
    const stats = await store.getStats();

    check('alice inherits the pre-auth history', mine.map((s) => s.species), ['rose']);
    check('  ...and the streak is not reset', stats.currentStreak, 3);
    check('  ...and the badge is kept', stats.unlockedBadges, ['first-discovery']);
    check('nothing is left unclaimed', (await store.getScans(null, '__unclaimed__')).length, 0);
}

console.log('\n--- the login-amnesia bug itself ---');
{
    reset();
    // alice signs in and scans
    const alice = loadStore({ user: { sub: 'auth0|alice' } });
    await alice.addScan({ species: 'rose', confidence: 0.9 });
    await alice.addScan({ species: 'tulip', confidence: 0.8 });

    // bob signs in on the SAME browser — a fresh page load, fresh module
    const bob = loadStore({ user: { sub: 'auth0|bob' } });
    const bobScans = await bob.getDiscoveries();
    const bobStats = await bob.getStats();
    await bob.addScan({ species: 'daisy', confidence: 0.7 });

    check("bob does NOT see alice's scans", bobScans.length, 0);
    check("bob does NOT inherit alice's streak", bobStats.currentStreak, 0);
    check("bob does NOT inherit alice's badges", bobStats.unlockedBadges, []);

    // and alice is unharmed by bob's visit
    const alice2 = loadStore({ user: { sub: 'auth0|alice' } });
    const back = await alice2.getDiscoveries();
    check('alice still has exactly her own two scans',
        back.map((s) => s.species).sort(), ['rose', 'tulip']);
    check("alice's total is not inflated by bob", (await alice2.getStats()).totalScans, 2);
    check('bob keeps his own single scan',
        (await loadStore({ user: { sub: 'auth0|bob' } }).getDiscoveries()).map((s) => s.species), ['daisy']);
}

console.log('\n--- scanner writes unclaimed, dashboard adopts ---');
{
    reset();
    // try.html: no auth.js on the page at all
    const scanner = loadStore({ user: null });
    await scanner.addScan({ species: 'poppy', confidence: 0.91 });
    check('a signed-out scan is stored, not dropped', (await scanner.getScans()).length, 1);
    check('  ...owned by the sentinel',
        (await scanner.getScans())[0].userId, '__unclaimed__');

    // dashboard.html: auth.js present, same browser
    const dash = loadStore({ user: { sub: 'auth0|carol' } });
    const summary = await dash.getSummary();
    check('carol adopts the scanner row', summary.scans.map((s) => s.species), ['poppy']);
    check('  ...and it counts toward her total', summary.totalScans, 1);
    check('  ...and toward her streak', summary.streak >= 1, true);
    check('  ...and unlocks her first badge',
        summary.badges.find((b) => b.id === 'first-discovery').earned, true);
}

console.log('\n--- adoption merges rather than overwrites ---');
{
    reset();
    const dave = loadStore({ user: { sub: 'auth0|dave' } });
    await dave.addScan({ species: 'iris', confidence: 0.9 });   // dave has 1

    const anon = loadStore({ user: null });
    await anon.addScan({ species: 'lily', confidence: 0.9 });   // +1 unclaimed

    const dave2 = loadStore({ user: { sub: 'auth0|dave' } });
    const s = await dave2.getSummary();
    check('dave ends up with both scans', s.scans.map((x) => x.species).sort(), ['iris', 'lily']);
    check('  ...totals are summed, not clobbered', s.totalScans, 2);
}

console.log('\n--- getScans(limit) still honours the cap ---');
{
    reset();
    const st = loadStore({ user: { sub: 'auth0|erin' } });
    for (const n of ['a', 'b', 'c']) await st.addScan({ species: n, confidence: 0.5 });
    check('limit caps the result', (await st.getScans(2)).length, 2);
    check('unlimited returns all', (await st.getScans()).length, 3);
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
