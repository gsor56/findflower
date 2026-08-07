/**
 * FindFlower offline-first storage layer (native IndexedDB, no dependencies).
 *
 * Everything the user accumulates -- scans, streak, badges -- lives on THEIR
 * device. There is no user database on our side, so this file is the whole
 * persistence story. The scanner writes here; dashboard.html reads here.
 *
 * Two object stores:
 *   scans  keyPath "id"   { id, species, confidence, imageBase64, timestamp, geolocation }
 *   stats  keyPath "key"  one row, key "global": { totalScans, currentStreak,
 *                                                  lastScanDate, unlockedBadges }
 *
 * Everything is exposed on window.ffStore. Callers await; the DB opens lazily
 * on first use so importing this file costs nothing.
 */
(function () {
  "use strict";

  const DB_NAME = "findflower";
  const DB_VERSION = 1;
  const STORE_SCANS = "scans";
  const STORE_STATS = "stats";
  const STATS_KEY = "global";

  // Thumbnails are stored as base64 inside IndexedDB. Browsers cap origin
  // storage, so keep each frame small rather than banking a full camera frame.
  const THUMB_MAX_EDGE = 320;
  const THUMB_QUALITY = 0.7;

  /** Badge catalogue. `test` gets ({stats, scans}) and returns true when earned. */
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
      test: (s) =>
        s.scans.some((x) => {
          const h = new Date(x.timestamp).getHours();
          return h >= 21 || h < 5;
        }),
    },
    {
      id: "collector-10",
      name: "Collector",
      icon: "🧺",
      description: "Identify 10 different species.",
      test: (s) => uniqueSpecies(s.scans) >= 10,
    },
    {
      id: "botanist-25",
      name: "Field Botanist",
      icon: "🔬",
      description: "Log 25 identifications.",
      test: (s) => s.stats.totalScans >= 25,
    },
  ];

  const DEFAULT_STATS = {
    key: STATS_KEY,
    totalScans: 0,
    currentStreak: 0,
    lastScanDate: null,
    unlockedBadges: [],
  };

  let _dbPromise = null;

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

  function uniqueSpecies(scans) {
    const set = new Set();
    for (const s of scans) {
      if (s && s.species) set.add(String(s.species).trim().toLowerCase());
    }
    return set.size;
  }

  // === stats ================================================================

  async function getStats() {
    const row = await tx(STORE_STATS, "readonly", (s) => wrap(s.get(STATS_KEY)));
    return Object.assign({}, DEFAULT_STATS, row || {});
  }

  function putStats(stats) {
    return tx(STORE_STATS, "readwrite", (s) => wrap(s.put(Object.assign({}, DEFAULT_STATS, stats, { key: STATS_KEY }))));
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
  function evaluateBadges(stats, scans) {
    const have = new Set(stats.unlockedBadges || []);
    const fresh = [];
    for (const b of BADGES) {
      if (have.has(b.id)) continue;
      let earned = false;
      try {
        earned = !!b.test({ stats, scans });
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
  async function addScan({ species, confidence, image, geolocation, timestamp }) {
    const when = timestamp ? new Date(timestamp) : new Date();
    const imageBase64 = image ? await toThumbnail(image) : null;

    const scan = {
      id: newId(),
      species: species || "Unknown",
      confidence: typeof confidence === "number" ? confidence : null,
      imageBase64,
      timestamp: when.toISOString(),
      geolocation: geolocation || null,
    };

    await tx(STORE_SCANS, "readwrite", (s) => wrap(s.put(scan)));

    const stats = await getStats();
    const { streak, today } = advanceStreak(stats, when);
    stats.currentStreak = streak;
    stats.lastScanDate = today;
    stats.totalScans = (stats.totalScans || 0) + 1;

    const scans = await getScans();
    const newBadges = evaluateBadges(stats, scans);
    await putStats(stats);

    return { scan, stats, newBadges };
  }

  /** All scans, newest first. `limit` caps the result. */
  function getScans(limit) {
    return tx(STORE_SCANS, "readonly", (store) => {
      const out = [];
      const idx = store.index("timestamp");
      const req = idx.openCursor(null, "prev"); // descending == newest first
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

  /** Everything dashboard.html needs, in one round trip. */
  async function getSummary() {
    const [scans, rawStats] = await Promise.all([getScans(), getStats()]);
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

  window.ffStore = {
    addScan,
    getScans,
    getStats,
    getSummary,
    clearAll,
    // exported for the dashboard + tests
    BADGES,
    dayKey,
    dayDiff,
    advanceStreak,
    effectiveStreak,
    uniqueSpecies,
  };
})();
