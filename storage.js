/**
 * FindFlower offline-first storage layer (native IndexedDB, no dependencies).
 *
 * Everything the user accumulates -- scans, streak, badges -- lives on THEIR
 * device. There is no user database on our side, so this file is the whole
 * persistence story. The scanner writes here; dashboard.html reads here.
 *
 * Two object stores:
 *   scans  keyPath "id"   { id, userId, species, confidence, imageBase64,
 *                           timestamp, geolocation }
 *   stats  keyPath "key"  ONE ROW PER USER, key === userId: { totalScans,
 *                           currentStreak, lastScanDate, unlockedBadges }
 *
 * === Why every row carries a userId (schema v2) ===========================
 *
 * v1 kept a single stats row under the literal key "global" and read scans
 * with an unfiltered cursor. On a shared browser that meant the second person
 * to sign in inherited the first person's streak, badge shelf and discovery
 * history -- the "login amnesia" bug. Data was never lost, it was pooled.
 *
 * v2 scopes every read and write to one user id (the Auth0 `sub`). The active
 * user is resolved lazily from window.ffUser() when auth.js is present, so
 * dashboard.html needed no change to get correct per-account numbers.
 *
 * === The UNCLAIMED sentinel ==============================================
 *
 * try.html deliberately loads no Auth0 (it is the open scanning path), yet it
 * is the page that WRITES scans. Stamping those rows with a real id is
 * therefore impossible at write time. Rather than drop them on the floor or
 * force auth back onto the scanner, they are written to UNCLAIMED and adopted
 * by the first signed-in page that opens the DB -- the same adoption path that
 * migrates pre-v2 rows. Attribution catches up by itself; if auth.js is ever
 * restored to try.html it simply becomes immediate instead of deferred.
 *
 * Everything is exposed on window.ffStore. Callers await; the DB opens lazily
 * on first use so importing this file costs nothing.
 */
(function () {
  "use strict";

  const DB_NAME = "findflower";
  const DB_VERSION = 3;
  const STORE_SCANS = "scans";
  const STORE_STATS = "stats";
  const STATS_KEY = "global"; // v1's single shared row; migrated away on upgrade

  // Owner of rows written before we knew who was signed in. Deliberately not a
  // plausible Auth0 `sub` (those look like "auth0|abc123" or "google-oauth2|…")
  // so it can never collide with a real account.
  const UNCLAIMED = "__unclaimed__";

  // Upper bound for the timestamp half of a [userId, timestamp] range. Built
  // from a char code rather than typed inline so the sentinel survives any
  // editor or transport that would mangle a raw U+FFFF byte.
  const MAX_KEY_CHAR = String.fromCharCode(0xffff);

  const IDX_USER = "userId";
  const IDX_USER_TIME = "user_time"; // [userId, timestamp] -- per-user, newest-first
  // [userId, species] -- how many DIFFERENT species one user has logged,
  // answered from index keys so no row (and no thumbnail) is deserialized.
  const IDX_USER_SPECIES = "user_species";

  // Thumbnails are stored as base64 inside IndexedDB. Browsers cap origin
  // storage, so keep each frame small rather than banking a full camera frame.
  const THUMB_MAX_EDGE = 320;
  const THUMB_QUALITY = 0.7;

  /**
   * Badge catalogue. `test` gets a facts object and returns true when earned.
   *
   * The facts are `{ stats, uniqueSpecies, nightSeen }` and never the rows.
   * Two of these tests used to walk `scans`, which is why addScan had to read
   * the whole history on every single write; both questions are now answered
   * from the [userId, species] and [userId, timestamp] index keys instead.
   */
  const BADGES = [
    {
      id: "first-discovery",
      name: "First Discovery",
      icon: "🌱",
      description: "Identify your first flower.",
      test: (s) => s.stats.totalScans >= 1,
    },
    {
      id: "streak-5",
      name: "5 Day Streak",
      icon: "🔥",
      description: "Identify a flower five days running.",
      test: (s) => s.stats.currentStreak >= 5,
    },
    {
      id: "night-explorer",
      name: "Night Explorer",
      icon: "🌙",
      description: "Identify a flower after 9pm.",
      test: (s) => s.nightSeen === true,
    },
    {
      id: "collector-10",
      name: "Collector",
      icon: "🧺",
      description: "Identify 10 different species.",
      test: (s) => s.uniqueSpecies >= 10,
    },
    {
      id: "botanist-25",
      name: "Field Botanist",
      icon: "🔬",
      description: "Log 25 identifications.",
      test: (s) => s.stats.totalScans >= 25,
    },
  ];

  // No `key` here on purpose: the key IS the user id, supplied at write time.
  const DEFAULT_STATS = {
    totalScans: 0,
    currentStreak: 0,
    lastScanDate: null,
    unlockedBadges: [],
  };

  let _dbPromise = null;

  /**
   * v1 -> v2. Stamp every pre-existing row with the UNCLAIMED sentinel and
   * retire the single "global" stats row into it.
   *
   * Nothing is deleted and no history is reset: v1 rows genuinely belonged to
   * whoever used this browser, we simply never recorded who. Marking them
   * unclaimed rather than guessing an owner keeps that honest, and the first
   * sign-in adopts the lot -- so a solo user (the overwhelming case) keeps
   * their streak and badges intact across the upgrade.
   *
   * Runs inside the versionchange transaction; every request here is awaited
   * by the browser before the upgrade is allowed to commit.
   */
  function migrateToV2(t) {
    const scans = t.objectStore(STORE_SCANS);
    const stats = t.objectStore(STORE_STATS);

    const cur = scans.openCursor();
    cur.onsuccess = (e) => {
      const c = e.target.result;
      if (!c) return;
      const row = c.value;
      if (!row.userId) {
        row.userId = UNCLAIMED;
        c.update(row);
      }
      c.continue();
    };

    const legacy = stats.get(STATS_KEY);
    legacy.onsuccess = () => {
      const row = legacy.result;
      if (!row) return;
      stats.delete(STATS_KEY);
      stats.put(Object.assign({}, row, { key: UNCLAIMED }));
    };
  }

  function openDB() {
    if (_dbPromise) return _dbPromise;
    _dbPromise = new Promise((resolve, reject) => {
      if (!("indexedDB" in window)) {
        reject(new Error("IndexedDB unavailable"));
        return;
      }
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains(STORE_SCANS)) {
          const s = db.createObjectStore(STORE_SCANS, { keyPath: "id" });
          // Recent-first reads are the only access pattern the dashboard has.
          s.createIndex("timestamp", "timestamp");
          s.createIndex("species", "species");
        }
        if (!db.objectStoreNames.contains(STORE_STATS)) {
          db.createObjectStore(STORE_STATS, { keyPath: "key" });
        }
        // v2: every scan belongs to a user. Index by userId alone (so stats
        // can iterate a user's whole history) and by [userId, timestamp] (so
        // per-user reads are a keyed cursor, newest first -- no scan-and-filter
        // over the whole store).
        if (e.oldVersion < 2) {
          const s = req.transaction.objectStore(STORE_SCANS);
          if (!s.indexNames.contains(IDX_USER)) s.createIndex(IDX_USER, IDX_USER);
          if (!s.indexNames.contains(IDX_USER_TIME)) {
            s.createIndex(IDX_USER_TIME, [IDX_USER, "timestamp"]);
          }
          migrateToV2(req.transaction);
        }
        // v3: one more index and nothing else. Every scan write used to read
        // the user's ENTIRE history back -- every row, every base64 thumbnail
        // -- to answer two badge questions, and both turn out to be answerable
        // from index KEYS. Purely additive: IndexedDB builds this from the
        // `species` field the rows already carry, so no row is rewritten and
        // no row is even read here.
        if (e.oldVersion < 3) {
          const s3 = req.transaction.objectStore(STORE_SCANS);
          if (!s3.indexNames.contains(IDX_USER_SPECIES)) {
            s3.createIndex(IDX_USER_SPECIES, [IDX_USER, "species"]);
          }
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
      // Another tab holding an old version open would hang us forever.
      req.onblocked = () => reject(new Error("IndexedDB blocked by another tab"));
    });
    return _dbPromise;
  }

  function tx(storeName, mode, fn) {
    return openDB().then(
      (db) =>
        new Promise((resolve, reject) => {
          const t = db.transaction(storeName, mode);
          const store = t.objectStore(storeName);
          let out;
          try {
            out = fn(store);
          } catch (err) {
            reject(err);
            return;
          }
          t.oncomplete = () => resolve(out && out.__req ? out.__req.result : out);
          t.onerror = () => reject(t.error);
          t.onabort = () => reject(t.error || new Error("transaction aborted"));
        })
    );
  }

  /** All three stores in one transaction, for cross-store writes like adoption. */
  function tx2(mode, fn) {
    return openDB().then(
      (db) =>
        new Promise((resolve, reject) => {
          const t = db.transaction([STORE_SCANS, STORE_STATS], mode);
          const stores = { scans: t.objectStore(STORE_SCANS), stats: t.objectStore(STORE_STATS) };
          let out;
          try {
            out = fn(stores, t);
          } catch (err) {
            reject(err);
            return;
          }
          t.oncomplete = () => resolve(out);
          t.onerror = () => reject(t.error);
          t.onabort = () => reject(t.error || new Error("transaction aborted"));
        })
    );
  }

  // === active user =========================================================

  /** Resolve the active user id. Returns null when nobody is signed in.
   *  auth.js exposes ffUser() -> Promise<{ sub } | null>; when it is absent
   *  (try.html) the sentinel owns the write so a later sign-in can adopt it. */
  async function activeUser() {
    if (typeof window.ffUser === "function") {
      try {
        const u = await window.ffUser();
        return u && u.sub ? String(u.sub) : null;
      } catch {
        return null; // a broken auth read must never stall a scan
      }
    }
    return null;
  }

  /** Merge two stats rows. Never reduces progress: an upgrade or an adoption
   *  must not cost the user a streak or a badge they already earned. */
  function mergeStats(mine, orphan, key) {
    const a = mine || {};
    const b = orphan || {};
    const badges = new Set([].concat(a.unlockedBadges || [], b.unlockedBadges || []));
    let later = a.lastScanDate || b.lastScanDate || null;
    if (a.lastScanDate && b.lastScanDate) {
      later = dayDiff(a.lastScanDate, b.lastScanDate) > 0 ? b.lastScanDate : a.lastScanDate;
    }
    return {
      key: key,
      totalScans: (a.totalScans || 0) + (b.totalScans || 0),
      currentStreak: Math.max(a.currentStreak || 0, b.currentStreak || 0),
      lastScanDate: later,
      unlockedBadges: Array.from(badges),
    };
  }

  /** Hand every UNCLAIMED row to `userId`. Resolves to the number adopted. */
  function adopt(userId) {
    const uid = String(userId || "");
    if (!uid || uid === UNCLAIMED) return Promise.resolve(0);
    return tx2("readwrite", ({ scans, stats }) => {
      const out = { n: 0 };
      const c = scans.index(IDX_USER).openCursor(IDBKeyRange.only(UNCLAIMED));
      c.onsuccess = (e) => {
        const cur = e.target.result;
        if (!cur) return;
        const row = cur.value;
        row.userId = uid;
        cur.update(row);
        out.n++;
        cur.continue();
      };
      const orphanReq = stats.get(UNCLAIMED);
      orphanReq.onsuccess = () => {
        const orphan = orphanReq.result;
        if (!orphan) return;
        const mineReq = stats.get(uid);
        mineReq.onsuccess = () => {
          stats.put(mergeStats(mineReq.result, orphan, uid));
          stats.delete(UNCLAIMED);
        };
      };
      return out;
    }).then((o) => o.n);
  }

  // Resolved once per page: signing in with the Auth0 SPA flow reloads the
  // page, so a cached owner cannot go stale mid-session. refreshUser() exists
  // for callers that change identity without a navigation.
  let _ownerPromise = null;

  /** The user id every read and write in this file is scoped to. */
  function owner() {
    if (_ownerPromise) return _ownerPromise;
    _ownerPromise = (async () => {
      const uid = await activeUser();
      if (!uid) return UNCLAIMED;
      // Catch up on anything the signed-out scanner wrote, then own it.
      try { await adopt(uid); } catch { /* adoption is best-effort */ }
      return uid;
    })();
    return _ownerPromise;
  }

  function refreshUser() {
    _ownerPromise = null;
    return owner();
  }

  const wrap = (req) => ({ __req: req });

  // === date helpers =========================================================

  /** Local calendar day as YYYY-MM-DD. Streaks are a human/calendar concept,
   *  so this deliberately uses local time, not UTC. */
  function dayKey(d) {
    const dt = d instanceof Date ? d : new Date(d);
    const m = String(dt.getMonth() + 1).padStart(2, "0");
    const day = String(dt.getDate()).padStart(2, "0");
    return `${dt.getFullYear()}-${m}-${day}`;
  }

  /** Whole calendar days between two YYYY-MM-DD keys (b - a). */
  function dayDiff(aKey, bKey) {
    const [ay, am, ad] = aKey.split("-").map(Number);
    const [by, bm, bd] = bKey.split("-").map(Number);
    const a = Date.UTC(ay, am - 1, ad);
    const b = Date.UTC(by, bm - 1, bd);
    return Math.round((b - a) / 86400000);
  }

  /** The badge's own definition of night, kept in one place because the key
   *  walk below and the badge test have to agree on it. Local hours, matching
   *  what the row-walking version did with `new Date(x.timestamp).getHours()`. */
  function isNightHour(when) {
    const h = new Date(when).getHours();
    return h >= 21 || h < 5;
  }

  function uniqueSpecies(scans) {
    const set = new Set();
    for (const s of scans) {
      if (s && s.species) set.add(String(s.species).trim().toLowerCase());
    }
    return set.size;
  }

  // === stats ================================================================

  async function getStats(userId) {
    const uid = userId ? String(userId) : await owner();
    const row = await tx(STORE_STATS, "readonly", (s) => wrap(s.get(uid)));
    return Object.assign({}, DEFAULT_STATS, row || {}, { key: uid });
  }

  async function putStats(stats, userId) {
    const uid = userId ? String(userId) : await owner();
    return tx(STORE_STATS, "readwrite", (s) =>
      wrap(s.put(Object.assign({}, DEFAULT_STATS, stats, { key: uid })))
    );
  }

  /**
   * Advance the streak for a scan taken at `when`.
   *
   *   same calendar day   -> unchanged (many scans in one day is still one day)
   *   exactly 1 day later -> +1
   *   2+ days later       -> broken, restart at 1
   *
   * Calendar days, not elapsed hours: 11pm Monday -> 7am Tuesday is 8 hours but
   * two days, and a user who scans both nights has obviously kept the streak.
   */
  function advanceStreak(stats, when) {
    const today = dayKey(when || new Date());
    const last = stats.lastScanDate;
    let streak = stats.currentStreak || 0;

    if (!last) {
      streak = 1;
    } else {
      const diff = dayDiff(last, today);
      if (diff === 0) streak = streak || 1;
      else if (diff === 1) streak = streak + 1;
      else if (diff > 1) streak = 1;
      // diff < 0 means a clock change put "today" before the stored day.
      // Leave the streak alone rather than punishing a timezone flight.
    }
    return { streak, today };
  }

  /** Re-evaluate the badge catalogue; returns the ids newly earned. */
  function evaluateBadges(stats, facts) {
    const have = new Set(stats.unlockedBadges || []);
    const fresh = [];
    for (const b of BADGES) {
      if (have.has(b.id)) continue;
      let earned = false;
      try {
        earned = !!b.test(facts);
      } catch {
        earned = false;
      }
      if (earned) {
        have.add(b.id);
        fresh.push(b.id);
      }
    }
    stats.unlockedBadges = Array.from(have);
    return fresh;
  }

  /**
   * How many DIFFERENT species this user has logged.
   *
   * `nextunique` visits each distinct [userId, species] key once and a KEY
   * cursor never loads the record, so this reads a handful of short strings
   * where the old path deserialized every row and every base64 thumbnail.
   *
   * The folding is done here rather than in the index because the index sees
   * the raw field: "Rose", "rose" and "Rose " are three keys and one species.
   * uniqueSpecies() normalises the same way, so the two agree exactly -- and a
   * stored name could only be normalised in the index by rewriting rows, which
   * this upgrade deliberately does not do.
   */
  function countUniqueSpecies(uid) {
    return tx(STORE_SCANS, "readonly", (store) => {
      const seen = new Set();
      const idx = store.index(IDX_USER_SPECIES);
      const range = IDBKeyRange.bound([uid, ""], [uid, MAX_KEY_CHAR]);
      const req = idx.openKeyCursor(range, "nextunique");
      req.onsuccess = (e) => {
        const cur = e.target.result;
        if (!cur) return;
        // cur.key is the INDEX key, so [userId, species]; [1] is the name.
        const name = cur.key && cur.key[1];
        if (name) seen.add(String(name).trim().toLowerCase());
        cur.continue();
      };
      // Mutated in place while the cursor runs; tx() resolves with it once the
      // transaction commits, the same contract getScans() relies on.
      return seen;
    }).then((seen) => seen.size);
  }

  /**
   * Has this user ever logged a scan between 21:00 and 05:00?
   *
   * The timestamp is half of the [userId, timestamp] key, so the hour is
   * readable without touching a row. Walks newest-first and stops at the first
   * match by simply not calling continue(). Only ever called while the badge is
   * unearned -- evaluateBadges() skips anything already in unlockedBadges, so
   * the steady state for a user who has it is zero reads.
   */
  function anyNightScan(uid) {
    return tx(STORE_SCANS, "readonly", (store) => {
      const hit = { found: false };
      const idx = store.index(IDX_USER_TIME);
      const range = IDBKeyRange.bound([uid, ""], [uid, MAX_KEY_CHAR]);
      const req = idx.openKeyCursor(range, "prev");
      req.onsuccess = (e) => {
        const cur = e.target.result;
        if (!cur) return;
        if (isNightHour(cur.key && cur.key[1])) { hit.found = true; return; }
        cur.continue();
      };
      return hit;
    }).then((hit) => hit.found);
  }

  /**
   * A streak shown on the dashboard must reflect *now*, not the last write.
   * Stored streak of 4 from three days ago is really 0 today.
   */
  function effectiveStreak(stats) {
    if (!stats.lastScanDate || !stats.currentStreak) return 0;
    const diff = dayDiff(stats.lastScanDate, dayKey(new Date()));
    if (diff <= 0) return stats.currentStreak;
    if (diff === 1) return stats.currentStreak; // yesterday: still alive today
    return 0;
  }

  // === scans ================================================================

  function newId() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return "s_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
  }

  /** Downscale any blob/dataURL to a small JPEG data URL for storage. */
  function toThumbnail(source) {
    return new Promise((resolve) => {
      try {
        const img = new Image();
        const url = typeof source === "string" ? source : URL.createObjectURL(source);
        img.onload = () => {
          try {
            const scale = Math.min(1, THUMB_MAX_EDGE / Math.max(img.width, img.height));
            const w = Math.max(1, Math.round(img.width * scale));
            const h = Math.max(1, Math.round(img.height * scale));
            const c = document.createElement("canvas");
            c.width = w;
            c.height = h;
            c.getContext("2d").drawImage(img, 0, 0, w, h);
            resolve(c.toDataURL("image/jpeg", THUMB_QUALITY));
          } catch {
            resolve(null); // tainted canvas (cross-origin URL) -- skip the thumb
          } finally {
            if (typeof source !== "string") URL.revokeObjectURL(url);
          }
        };
        img.onerror = () => {
          if (typeof source !== "string") URL.revokeObjectURL(url);
          resolve(null);
        };
        img.src = url;
      } catch {
        resolve(null);
      }
    });
  }

  /**
   * Persist one identification and roll the stats forward.
   * Returns { scan, stats, newBadges }.
   */
  async function addScan({ species, confidence, image, geolocation, timestamp, userId }) {
    const when = timestamp ? new Date(timestamp) : new Date();
    const imageBase64 = image ? await toThumbnail(image) : null;
    // Resolved before the write, never after: a row with no owner cannot be
    // told apart later from one that legitimately belongs to the sentinel.
    const uid = userId ? String(userId) : await owner();

    const scan = {
      id: newId(),
      userId: uid,
      species: species || "Unknown",
      confidence: typeof confidence === "number" ? confidence : null,
      imageBase64,
      timestamp: when.toISOString(),
      geolocation: geolocation || null,
    };

    await tx(STORE_SCANS, "readwrite", (s) => wrap(s.put(scan)));

    const stats = await getStats(uid);
    const { streak, today } = advanceStreak(stats, when);
    stats.currentStreak = streak;
    stats.lastScanDate = today;
    stats.totalScans = (stats.totalScans || 0) + 1;

    // Badge inputs, read from index keys and only for badges still unearned.
    // This line used to be `getScans(null, uid)`: the whole history, every
    // base64 thumbnail with it, on every single identification. Three of the
    // five badges read stats alone, so once a user holds the other two this
    // touches no scan data at all.
    const have = new Set(stats.unlockedBadges || []);
    const facts = { stats, uniqueSpecies: 0, nightSeen: false };
    if (!have.has("collector-10")) facts.uniqueSpecies = await countUniqueSpecies(uid);
    if (!have.has("night-explorer")) {
      // The row above is already written, so the walk would find it anyway --
      // testing `when` first just skips the walk in the obvious case.
      facts.nightSeen = isNightHour(when) || (await anyNightScan(uid));
    }
    const newBadges = evaluateBadges(stats, facts);
    await putStats(stats, uid);

    return { scan, stats, newBadges };
  }

  /** Step-1 API name for addScan. */
  function saveDiscovery(discovery) {
    return addScan(discovery || {});
  }

  /**
   * One user's scans, newest first. `limit` caps the result.
   *
   * Scoped through the [userId, timestamp] index rather than reading the whole
   * store and filtering, so another account's rows are never even loaded into
   * memory -- the fix for the pooled-history bug is structural, not a filter
   * a future caller can forget to apply.
   */
  async function getScans(limit, userId) {
    const uid = userId ? String(userId) : await owner();
    return tx(STORE_SCANS, "readonly", (store) => {
      const out = [];
      const idx = store.index(IDX_USER_TIME);
      // MAX_KEY_CHAR sorts after any real ISO timestamp, so this bounds the
      // range to exactly one user; "prev" then walks it newest-first.
      const range = IDBKeyRange.bound([uid, ""], [uid, MAX_KEY_CHAR]);
      const req = idx.openCursor(range, "prev");
      req.onsuccess = (e) => {
        const cur = e.target.result;
        if (!cur) return;
        out.push(cur.value);
        if (limit && out.length >= limit) return;
        cur.continue();
      };
      return out;
    });
  }

  /** Step-1 API name: the discoveries belonging to one user. */
  function getDiscoveries(userId) {
    return getScans(null, userId);
  }

  /** Everything dashboard.html needs, in one round trip. Per-user.
   *
   * This one still reads every row on purpose: the dashboard renders the
   * history list, so the rows are the point rather than a means to a count.
   * uniqueSpecies() over rows already in memory costs nothing extra here. */
  async function getSummary() {
    const uid = await owner();
    const [scans, rawStats] = await Promise.all([getScans(null, uid), getStats(uid)]);
    // Trust the rows over the counter: a cleared store or a failed write
    // shouldn't leave a phantom total on screen.
    const stats = Object.assign({}, rawStats, { totalScans: Math.max(rawStats.totalScans || 0, scans.length) });
    return {
      scans,
      stats,
      totalScans: stats.totalScans,
      uniqueSpecies: uniqueSpecies(scans),
      streak: effectiveStreak(stats),
      badges: BADGES.map((b) => ({
        id: b.id,
        name: b.name,
        icon: b.icon,
        description: b.description,
        earned: (stats.unlockedBadges || []).includes(b.id),
      })),
    };
  }

  async function clearAll() {
    await tx(STORE_SCANS, "readwrite", (s) => wrap(s.clear()));
    await tx(STORE_STATS, "readwrite", (s) => wrap(s.clear()));
  }

  /**
   * Erase ONE user's history: their scan rows and their stats row, nothing
   * else. Returns the number of scans deleted.
   *
   * The dashboard's Clear button calls this rather than clearAll(), and that is
   * the whole reason it exists. Two accounts sharing a browser -- a shared
   * laptop, a phone handed over, an account switch -- both have rows in this
   * one database, and store.clear() would take the other person's history and
   * badges with it. Deleting by cursor over [userId, timestamp] cannot reach
   * outside the range, so the blast radius is a property of the range and not
   * of the caller remembering to filter.
   *
   * One transaction across both stores: a half-cleared user (rows gone, streak
   * and badges intact) would show a dashboard describing a history that no
   * longer exists.
   */
  async function clearUser(userId) {
    const uid = userId ? String(userId) : await owner();
    return tx2("readwrite", (stores) => {
      const counted = { n: 0 };
      const range = IDBKeyRange.bound([uid, ""], [uid, MAX_KEY_CHAR]);
      // A delete cursor over an index: cur.delete() removes the row the key
      // points at, so no id list has to be collected first.
      const req = stores.scans.index(IDX_USER_TIME).openCursor(range);
      req.onsuccess = (e) => {
        const cur = e.target.result;
        if (!cur) return;
        cur.delete();
        counted.n += 1;
        cur.continue();
      };
      stores.stats.delete(uid);
      return counted;
    }).then((c) => c.n);
  }

  /** Does this user have anything stored in this browser? (dashboard hint) */
  async function hasHistory(userId) {
    const uid = userId ? String(userId) : await owner();
    const [n, s] = await Promise.all([
      tx(STORE_SCANS, "readonly", (store) => wrap(store.index(IDX_USER).count(uid))),
      getStats(uid),
    ]);
    return n > 0 || (s.totalScans || 0) > 0;
  }

  window.ffStore = {
    addScan,
    saveDiscovery,
    getScans,
    getDiscoveries,
    getStats,
    getSummary,
    hasHistory,
    clearAll,
    clearUser,
    adopt,
    refreshUser,
    // exported for the dashboard + tests
    BADGES,
    UNCLAIMED,
    dayKey,
    dayDiff,
    countUniqueSpecies,
    advanceStreak,
    effectiveStreak,
    uniqueSpecies,
  };
})();
