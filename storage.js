(function () {
  "use strict";

  const DB_NAME = "findflower";
  const DB_VERSION = 5;
  const STORE_SCANS = "scans";
  const STORE_STATS = "stats";
  const STATS_KEY = "global";

  const STORE_USERS = "ff_users";
  const STORE_POSTS = "ff_posts";
  const STORE_FRIENDS = "ff_friends";
  const STORE_MESSAGES = "ff_messages";
  const STORE_ALBUMS = "ff_albums";

  const CACHE_LIMIT = 100;

  const AVATAR_MAX_EDGE = 160;
  const AVATAR_QUALITY = 0.72;

  const SPACES = [
    { id: "field-notes", label: "Field notes", blurb: "What you found, and where." },
    { id: "id-help", label: "Identification help", blurb: "Ask what a plant is." },
    { id: "corrections", label: "Corrections", blurb: "When the model got it wrong." },
    { id: "engineering", label: "Engineering", blurb: "The site, the model, the data." },
  ];

  const UNCLAIMED = "__unclaimed__";

  const MAX_KEY_CHAR = String.fromCharCode(0xffff);

  const IDX_USER = "userId";
  const IDX_USER_TIME = "user_time";
  const IDX_USER_SPECIES = "user_species";

  const IDX_POST_TIME = "timestamp";
  const IDX_POST_SPACE_TIME = "space_time";
  const IDX_POST_USER_TIME = "post_user_time";
  const IDX_FRIEND_OWNER = "ownerId";
  const IDX_MSG_CHANNEL_TIME = "channel_time";
  const IDX_ALBUM_OWNER = "album_owner";

  const ALBUM_NAME_MAX = 40;

  const THUMB_MAX_EDGE = 320;
  const THUMB_QUALITY = 0.7;

  const BADGES = [
    {
      id: "first-discovery",
      name: "First Bloom",
      icon: '<path d="M12 20v-9"/><path d="M12 13c0-2.6 2.1-4.3 5-4.3-.2 2.8-2.3 4.3-5 4.3Z"/><path d="M12 16.5c-2.3 0-3.9-1.4-4-3.6 2.4 0 4 1.3 4 3.6Z"/><path d="M6 20h12"/>',
      description: "Identify your first flower.",
      test: (s) => s.stats.totalScans >= 1,
    },
    {
      id: "streak-5",
      name: "5 Day Streak",
      icon: '<path d="M12 22a6 6 0 0 0 6-6c0-4.2-3-6.6-6-11.5-3 4.9-6 7.3-6 11.5a6 6 0 0 0 6 6Z"/><path d="M12 22a2.6 2.6 0 0 0 2.6-2.6c0-1.8-1.3-2.9-2.6-5-1.3 2.1-2.6 3.2-2.6 5A2.6 2.6 0 0 0 12 22Z"/>',
      description: "Identify a flower five days running.",
      test: (s) => s.stats.currentStreak >= 5,
    },
    {
      id: "night-explorer",
      name: "Nightshade",
      icon: '<path d="M19.5 14.8A8.2 8.2 0 0 1 9.2 4.5 7.5 7.5 0 1 0 19.5 14.8Z"/>',
      description: "Identify a flower between 10 at night and 4 in the morning.",
      needs: "nightSeen",
      test: (s) => s.nightSeen === true,
    },
    {
      id: "collector-10",
      name: "Collector",
      icon: '<path d="M3.5 9.5h17"/><path d="M5.5 9.5 6.8 19a2 2 0 0 0 2 1.7h6.4a2 2 0 0 0 2-1.7l1.3-9.5"/><path d="M8 9.5a4 4 0 0 1 8 0"/>',
      description: "Identify 10 different species.",
      needs: "uniqueSpecies",
      test: (s) => s.uniqueSpecies >= 10,
    },
    {
      id: "botanist-25",
      name: "Field Botanist",
      icon: '<path d="M3 22h18"/><path d="M6 18h8"/><path d="M14 22a7 7 0 1 0 0-14h-1"/><path d="M9 14h2"/><path d="M9 12a2 2 0 0 1-2-2V6h6v4a2 2 0 0 1-2 2Z"/><path d="M12 6V3.5a1 1 0 0 0-1-1H9a1 1 0 0 0-1 1V6"/>',
      description: "Log 25 identifications.",
      test: (s) => s.stats.totalScans >= 25,
    },
    {
      id: "dawn-patrol",
      name: "Dawn Patrol",
      icon: '<path d="M3 20h18"/><path d="M8 20a4 4 0 0 1 8 0"/><path d="M12 14.5V12"/><path d="M7.5 16.5 6 15"/><path d="M16.5 16.5 18 15"/>',
      description: "Identify a flower between 5 and 8 in the morning.",
      needs: "dawnSeen",
      test: (s) => s.dawnSeen === true,
    },
    {
      id: "season-10",
      name: "Ten Days Out",
      icon: '<rect x="3.5" y="5.5" width="17" height="15" rx="2"/><path d="M3.5 10.5h17"/><path d="M8.5 3.5v4"/><path d="M15.5 3.5v4"/>',
      description: "Log a flower on ten different days.",
      needs: "daysLogged",
      test: (s) => s.daysLogged >= 10,
    },
    {
      id: "collector-50",
      name: "Herbarium",
      icon: '<path d="M6.5 2.5H20v19H6.5A2.5 2.5 0 0 1 4 19v-14a2.5 2.5 0 0 1 2.5-2.5Z"/><path d="M4 19a2.5 2.5 0 0 1 2.5-2.5H20"/>',
      description: "Identify 50 different species.",
      needs: "uniqueSpecies",
      test: (s) => s.uniqueSpecies >= 50,
    },
    {
      id: "botanist-100",
      name: "Hundred Finds",
      icon: '<rect x="4.5" y="3" width="14" height="18" rx="1.5"/><path d="M8 3v18"/><path d="M11 8.5h4.5"/><path d="M11 12.5h4.5"/><path d="M11 16.5h2.5"/>',
      description: "Log 100 identifications.",
      test: (s) => s.stats.totalScans >= 100,
    },
    {
      id: "archivist",
      name: "Archivist",
      icon: '<rect x="3" y="4" width="18" height="4.5" rx="1"/><path d="M5 8.5v10.5a1.5 1.5 0 0 0 1.5 1.5h11a1.5 1.5 0 0 0 1.5-1.5V8.5"/><path d="M10 12.5h4"/>',
      description: "Write your first community post.",
      needs: "postCount",
      test: (s) => s.postCount >= 1,
    },
  ];

  const badgeIcon = (icon) =>
    '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
    'stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">' + icon + '</svg>';

  const DEFAULT_STATS = {
    totalScans: 0,
    currentStreak: 0,
    lastScanDate: null,
    unlockedBadges: [],
  };

  let _dbPromise = null;

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
          s.createIndex("timestamp", "timestamp");
          s.createIndex("species", "species");
        }
        if (!db.objectStoreNames.contains(STORE_STATS)) {
          db.createObjectStore(STORE_STATS, { keyPath: "key" });
        }
        if (e.oldVersion < 2) {
          const s = req.transaction.objectStore(STORE_SCANS);
          if (!s.indexNames.contains(IDX_USER)) s.createIndex(IDX_USER, IDX_USER);
          if (!s.indexNames.contains(IDX_USER_TIME)) {
            s.createIndex(IDX_USER_TIME, [IDX_USER, "timestamp"]);
          }
          migrateToV2(req.transaction);
        }
        if (e.oldVersion < 3) {
          const s3 = req.transaction.objectStore(STORE_SCANS);
          if (!s3.indexNames.contains(IDX_USER_SPECIES)) {
            s3.createIndex(IDX_USER_SPECIES, [IDX_USER, "species"]);
          }
        }
        if (e.oldVersion < 4) {
          if (!db.objectStoreNames.contains(STORE_USERS)) {
            db.createObjectStore(STORE_USERS, { keyPath: "id" });
          }
          if (!db.objectStoreNames.contains(STORE_POSTS)) {
            const p = db.createObjectStore(STORE_POSTS, { keyPath: "id" });
            p.createIndex(IDX_POST_TIME, "timestamp");
            p.createIndex(IDX_POST_SPACE_TIME, ["space", "timestamp"]);
            p.createIndex(IDX_POST_USER_TIME, ["userId", "timestamp"]);
          }
          if (!db.objectStoreNames.contains(STORE_FRIENDS)) {
            const f = db.createObjectStore(STORE_FRIENDS, { keyPath: "id" });
            f.createIndex(IDX_FRIEND_OWNER, "ownerId");
          }
          if (!db.objectStoreNames.contains(STORE_MESSAGES)) {
            const m = db.createObjectStore(STORE_MESSAGES, { keyPath: "id" });
            m.createIndex(IDX_MSG_CHANNEL_TIME, ["channel", "timestamp"]);
          }
        }
        // Albums are their own store so one can sit empty and be renamed without
        // touching a single scan. Scans point at them by id, and a scan saved
        // before this version simply has no albumId, which reads as unfiled.
        if (e.oldVersion < 5) {
          if (!db.objectStoreNames.contains(STORE_ALBUMS)) {
            const a = db.createObjectStore(STORE_ALBUMS, { keyPath: "id" });
            a.createIndex(IDX_ALBUM_OWNER, "userId");
          }
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
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

  async function activeUser() {
    if (typeof window.ffUser === "function") {
      try {
        const u = await window.ffUser();
        return u && u.sub ? String(u.sub) : null;
      } catch {
        return null;
      }
    }
    return null;
  }

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

  let _ownerPromise = null;

  function owner() {
    if (_ownerPromise) return _ownerPromise;
    _ownerPromise = (async () => {
      const uid = await activeUser();
      if (!uid) return UNCLAIMED;
      try { await adopt(uid); } catch { }
      return uid;
    })();
    return _ownerPromise;
  }

  function refreshUser() {
    _ownerPromise = null;
    return owner();
  }

  const wrap = (req) => ({ __req: req });

  function dayKey(d) {
    const dt = d instanceof Date ? d : new Date(d);
    const m = String(dt.getMonth() + 1).padStart(2, "0");
    const day = String(dt.getDate()).padStart(2, "0");
    return `${dt.getFullYear()}-${m}-${day}`;
  }

  function dayDiff(aKey, bKey) {
    const [ay, am, ad] = aKey.split("-").map(Number);
    const [by, bm, bd] = bKey.split("-").map(Number);
    const a = Date.UTC(ay, am - 1, ad);
    const b = Date.UTC(by, bm - 1, bd);
    return Math.round((b - a) / 86400000);
  }

  function isNightHour(when) {
    const h = new Date(when).getHours();
    return h >= 22 || h < 4;
  }

  function isDawnHour(when) {
    const h = new Date(when).getHours();
    return h >= 5 && h < 8;
  }

  function uniqueSpecies(scans) {
    const set = new Set();
    for (const s of scans) {
      if (s && s.species) set.add(String(s.species).trim().toLowerCase());
    }
    return set.size;
  }

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
    }
    return { streak, today };
  }

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

  function countUniqueSpecies(uid) {
    return tx(STORE_SCANS, "readonly", (store) => {
      const seen = new Set();
      const idx = store.index(IDX_USER_SPECIES);
      const range = IDBKeyRange.bound([uid, ""], [uid, MAX_KEY_CHAR]);
      const req = idx.openKeyCursor(range, "nextunique");
      req.onsuccess = (e) => {
        const cur = e.target.result;
        if (!cur) return;
        const name = cur.key && cur.key[1];
        if (name) seen.add(String(name).trim().toLowerCase());
        cur.continue();
      };
      return seen;
    }).then((seen) => seen.size);
  }

  async function listSpecies(userId) {
    const uid = userId ? String(userId) : await owner();
    return tx(STORE_SCANS, "readonly", (store) => {
      const byFolded = new Map();
      const idx = store.index(IDX_USER_SPECIES);
      const range = IDBKeyRange.bound([uid, ""], [uid, MAX_KEY_CHAR]);
      const req = idx.openKeyCursor(range, "nextunique");
      req.onsuccess = (e) => {
        const cur = e.target.result;
        if (!cur) return;
        const raw = cur.key && cur.key[1];
        const folded = raw ? String(raw).trim().toLowerCase() : "";
        if (folded && !byFolded.has(folded)) byFolded.set(folded, String(raw).trim());
        cur.continue();
      };
      return byFolded;
    }).then((byFolded) => Array.from(byFolded.values()));
  }

  function anyScanAtHour(uid, hourTest) {
    return tx(STORE_SCANS, "readonly", (store) => {
      const hit = { found: false };
      const idx = store.index(IDX_USER_TIME);
      const range = IDBKeyRange.bound([uid, ""], [uid, MAX_KEY_CHAR]);
      const req = idx.openKeyCursor(range, "prev");
      req.onsuccess = (e) => {
        const cur = e.target.result;
        if (!cur) return;
        if (hourTest(cur.key && cur.key[1])) { hit.found = true; return; }
        cur.continue();
      };
      return hit;
    }).then((hit) => hit.found);
  }

  function countDaysLogged(uid) {
    return tx(STORE_SCANS, "readonly", (store) => {
      const acc = { n: 0, last: null };
      const idx = store.index(IDX_USER_TIME);
      const range = IDBKeyRange.bound([uid, ""], [uid, MAX_KEY_CHAR]);
      const req = idx.openKeyCursor(range);
      req.onsuccess = (e) => {
        const cur = e.target.result;
        if (!cur) return;
        const iso = cur.key && cur.key[1];
        if (iso) {
          const k = dayKey(iso);
          if (k !== acc.last) { acc.n++; acc.last = k; }
        }
        cur.continue();
      };
      return acc;
    }).then((acc) => acc.n);
  }

  function effectiveStreak(stats) {
    if (!stats.lastScanDate || !stats.currentStreak) return 0;
    const diff = dayDiff(stats.lastScanDate, dayKey(new Date()));
    if (diff <= 0) return stats.currentStreak;
    if (diff === 1) return stats.currentStreak;
    return 0;
  }

  function newId() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return "s_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
  }

  function toThumbnail(source, maxEdge, quality) {
    const edge = maxEdge || THUMB_MAX_EDGE;
    const q = quality || THUMB_QUALITY;
    return new Promise((resolve) => {
      try {
        const img = new Image();
        const url = typeof source === "string" ? source : URL.createObjectURL(source);
        img.onload = () => {
          try {
            const scale = Math.min(1, edge / Math.max(img.width, img.height));
            const w = Math.max(1, Math.round(img.width * scale));
            const h = Math.max(1, Math.round(img.height * scale));
            const c = document.createElement("canvas");
            c.width = w;
            c.height = h;
            c.getContext("2d").drawImage(img, 0, 0, w, h);
            resolve(c.toDataURL("image/jpeg", q));
          } catch {
            resolve(null);
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

  async function addScan({ species, confidence, image, geolocation, timestamp, userId,
    family, albumId }) {
    const when = timestamp ? new Date(timestamp) : new Date();
    const imageBase64 = image ? await toThumbnail(image) : null;
    const uid = userId ? String(userId) : await owner();

    const scan = {
      id: newId(),
      userId: uid,
      species: species || "Unknown",
      confidence: typeof confidence === "number" ? confidence : null,
      imageBase64,
      timestamp: when.toISOString(),
      geolocation: geolocation || null,
      family: family ? String(family) : null,
      albumId: albumId ? String(albumId) : null,
      correction: null,
      unknown: false,
    };

    await tx(STORE_SCANS, "readwrite", (s) => wrap(s.put(scan)));

    const stats = await getStats(uid);
    const { streak, today } = advanceStreak(stats, when);
    stats.currentStreak = streak;
    stats.lastScanDate = today;
    stats.totalScans = (stats.totalScans || 0) + 1;

    const have = new Set(stats.unlockedBadges || []);
    const wanted = new Set();
    for (const b of BADGES) if (b.needs && !have.has(b.id)) wanted.add(b.needs);

    const facts = { stats, uniqueSpecies: 0, nightSeen: false, dawnSeen: false, daysLogged: 0, postCount: 0 };
    if (wanted.has("uniqueSpecies")) facts.uniqueSpecies = await countUniqueSpecies(uid);
    if (wanted.has("nightSeen")) {
      facts.nightSeen = isNightHour(when) || (await anyScanAtHour(uid, isNightHour));
    }
    if (wanted.has("dawnSeen")) {
      facts.dawnSeen = isDawnHour(when) || (await anyScanAtHour(uid, isDawnHour));
    }
    if (wanted.has("daysLogged")) facts.daysLogged = await countDaysLogged(uid);

    const newBadges = evaluateBadges(stats, facts);
    await putStats(stats, uid);

    return { scan, stats, newBadges };
  }

  function saveDiscovery(discovery) {
    return addScan(discovery || {});
  }

  async function getScans(limit, userId) {
    const uid = userId ? String(userId) : await owner();
    return tx(STORE_SCANS, "readonly", (store) => {
      const out = [];
      const idx = store.index(IDX_USER_TIME);
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

  function getDiscoveries(userId) {
    return getScans(null, userId);
  }

  async function getSummary() {
    const uid = await owner();
    const [scans, rawStats] = await Promise.all([getScans(null, uid), getStats(uid)]);
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
    await tx(STORE_ALBUMS, "readwrite", (s) => wrap(s.clear()));
  }

  async function clearUser(userId) {
    const uid = userId ? String(userId) : await owner();
    return tx2("readwrite", (stores) => {
      const counted = { n: 0 };
      const range = IDBKeyRange.bound([uid, ""], [uid, MAX_KEY_CHAR]);
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
    }).then(async (c) => {
      await tx(STORE_ALBUMS, "readwrite", (store) => {
        const req = store.index(IDX_ALBUM_OWNER).openCursor(uid);
        req.onsuccess = (e) => {
          const cur = e.target.result;
          if (!cur) return;
          cur.delete();
          cur.continue();
        };
        return null;
      });
      return c.n;
    });
  }

  async function hasHistory(userId) {
    const uid = userId ? String(userId) : await owner();
    const [n, s] = await Promise.all([
      tx(STORE_SCANS, "readonly", (store) => wrap(store.index(IDX_USER).count(uid))),
      getStats(uid),
    ]);
    return n > 0 || (s.totalScans || 0) > 0;
  }

  function txAll(mode, fn) {
    const names = [STORE_SCANS, STORE_STATS, STORE_USERS, STORE_POSTS, STORE_FRIENDS,
      STORE_MESSAGES, STORE_ALBUMS];
    return openDB().then(
      (db) =>
        new Promise((resolve, reject) => {
          const t = db.transaction(names, mode);
          const stores = {};
          names.forEach((n) => {
            stores[n] = t.objectStore(n);
          });
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

  const USER_SHAPE = { name: "", picture: null, avatar: null, isPublic: true, created: null };

  function normUser(row, id) {
    return Object.assign({}, USER_SHAPE, row || {}, { id: String(id) });
  }

  async function getUser(userId) {
    const uid = userId ? String(userId) : await owner();
    if (!uid) return null;
    const row = await tx(STORE_USERS, "readonly", (s) => wrap(s.get(uid)));
    return row ? normUser(row, uid) : null;
  }
  async function upsertUser(profile) {
    const p = profile || {};
    const uid = p.id ? String(p.id) : await owner();
    if (!uid || uid === UNCLAIMED) return null;
    const prev = await tx(STORE_USERS, "readonly", (s) => wrap(s.get(uid)));
    const next = normUser(prev, uid);
    ["name", "picture", "avatar"].forEach((k) => {
      if (p[k]) next[k] = p[k];
    });
    if (typeof p.isPublic === "boolean") next.isPublic = p.isPublic;
    if (!next.created) next.created = new Date().toISOString();
    await tx(STORE_USERS, "readwrite", (s) => wrap(s.put(next)));
    return next;
  }

  async function listUsers() {
    const rows = await tx(STORE_USERS, "readonly", (s) => wrap(s.getAll()));
    return (rows || [])
      .map((r) => normUser(r, r.id))
      .sort((a, b) => String(a.name || a.id).localeCompare(String(b.name || b.id)));
  }

  async function setVisibility(isPublic, userId) {
    const uid = userId ? String(userId) : await owner();
    return upsertUser({ id: uid, isPublic: !!isPublic });
  }

  async function saveAvatar(source, userId) {
    const data = await toThumbnail(source, AVATAR_MAX_EDGE, AVATAR_QUALITY);
    if (!data) return null;
    const row = await upsertUser({ id: userId ? String(userId) : undefined, avatar: data });
    return row ? row.avatar : null;
  }

  const POST_MAX_CHARS = 2000;

  function userRange(uid) {
    return IDBKeyRange.bound([String(uid), ""], [String(uid), MAX_KEY_CHAR]);
  }

  async function countPosts(userId) {
    const uid = userId ? String(userId) : await owner();
    return tx(STORE_POSTS, "readonly", (s) =>
      wrap(s.index(IDX_POST_USER_TIME).count(userRange(uid)))
    );
  }

  async function addPost({ body, space, userId, authorName, articleRef, timestamp }) {
    const text = String(body == null ? "" : body).trim();
    if (!text) return null;
    const uid = userId ? String(userId) : await owner();
    const when = timestamp ? new Date(timestamp) : new Date();
    const post = {
      id: newId(),
      userId: uid,
      authorName: authorName ? String(authorName) : "",
      space: SPACES.some((s) => s.id === space) ? space : SPACES[0].id,
      body: text.slice(0, POST_MAX_CHARS),
      articleRef: articleRef ? String(articleRef) : null,
      timestamp: when.toISOString(),
    };
    await tx(STORE_POSTS, "readwrite", (s) => wrap(s.put(post)));

    const stats = await getStats(uid);
    const have = new Set(stats.unlockedBadges || []);
    const facts = { stats, uniqueSpecies: 0, nightSeen: false, dawnSeen: false, daysLogged: 0, postCount: 0 };
    if (BADGES.some((b) => b.needs === "postCount" && !have.has(b.id))) {
      facts.postCount = await countPosts(uid);
    }
    const newBadges = evaluateBadges(stats, facts);
    if (newBadges.length) await putStats(stats, uid);
    return { post, newBadges };
  }
  async function listPosts(opts) {
    const o = opts || {};
    const limit = Math.min(Math.max(1, o.limit || CACHE_LIMIT), CACHE_LIMIT);
    const upper = o.before ? String(o.before) : MAX_KEY_CHAR;
    const rows = await tx(STORE_POSTS, "readonly", (store) => {
      const out = [];
      const idx = o.space ? store.index(IDX_POST_SPACE_TIME) : store.index(IDX_POST_TIME);
      const range = o.space
        ? IDBKeyRange.bound([o.space, ""], [o.space, upper], false, !!o.before)
        : IDBKeyRange.bound("", upper, false, !!o.before);
      const req = idx.openCursor(range, "prev");
      req.onsuccess = (e) => {
        const cur = e.target.result;
        if (!cur || out.length >= limit) return;
        out.push(cur.value);
        cur.continue();
      };
      return out;
    });
    return rows;
  }

  const FRIEND_STATES = ["pending", "accepted", "blocked"];

  function friendKey(ownerId, otherId) {
    return String(ownerId) + "|" + String(otherId);
  }
  async function addFriend(otherId, ownerId, status) {
    const own = ownerId ? String(ownerId) : await owner();
    const other = String(otherId || "");
    if (!own || !other || own === other) return null;
    const row = {
      id: friendKey(own, other),
      ownerId: own,
      otherId: other,
      status: FRIEND_STATES.includes(status) ? status : "pending",
      created: new Date().toISOString(),
    };
    await tx(STORE_FRIENDS, "readwrite", (s) => wrap(s.put(row)));
    return row;
  }

  async function friendStatus(otherId, ownerId) {
    const own = ownerId ? String(ownerId) : await owner();
    if (!own || !otherId) return null;
    const row = await tx(STORE_FRIENDS, "readonly", (s) =>
      wrap(s.get(friendKey(own, otherId)))
    );
    return row ? row.status : null;
  }

  async function removeFriend(otherId, ownerId) {
    const own = ownerId ? String(ownerId) : await owner();
    if (!own || !otherId) return false;
    await tx(STORE_FRIENDS, "readwrite", (s) => wrap(s.delete(friendKey(own, otherId))));
    return true;
  }

  async function listFriends(ownerId) {
    const own = ownerId ? String(ownerId) : await owner();
    if (!own) return [];
    const rows = await tx(STORE_FRIENDS, "readonly", (s) =>
      wrap(s.index(IDX_FRIEND_OWNER).getAll(own))
    );
    return (rows || []).sort((a, b) => String(b.created).localeCompare(String(a.created)));
  }

  async function listMessages(opts) {
    const o = opts || {};
    const limit = Math.min(Math.max(1, o.limit || CACHE_LIMIT), CACHE_LIMIT);
    const channel = o.channel ? String(o.channel) : null;
    const rows = await tx(STORE_MESSAGES, "readonly", (store) => {
      const out = [];
      const range = channel
        ? IDBKeyRange.bound([channel, ""], [channel, MAX_KEY_CHAR])
        : null;
      const req = store.index(IDX_MSG_CHANNEL_TIME).openCursor(range, "prev");
      req.onsuccess = (e) => {
        const cur = e.target.result;
        if (!cur || out.length >= limit) return;
        out.push(cur.value);
        cur.continue();
      };
      return out;
    });
    return rows;
  }

  function topSpecies(userId, n) {
    const want = Math.max(1, n || 3);
    return Promise.resolve(userId ? String(userId) : owner()).then((uid) =>
      tx(STORE_SCANS, "readonly", (store) => {
        const tally = new Map();
        const idx = store.index(IDX_USER_SPECIES);
        const req = idx.openKeyCursor(IDBKeyRange.bound([uid, ""], [uid, MAX_KEY_CHAR]));
        req.onsuccess = (e) => {
          const cur = e.target.result;
          if (!cur) return;
          const raw = cur.key && cur.key[1];
          const folded = raw ? String(raw).trim().toLowerCase() : "";
          if (folded) {
            const seen = tally.get(folded);
            if (seen) seen.count += 1;
            else tally.set(folded, { name: String(raw).trim(), count: 1 });
          }
          cur.continue();
        };
        return tally;
      }).then((tally) =>
        Array.from(tally.values())
          .sort((a, b) => b.count - a.count)
          .slice(0, want)
      )
    );
  }
  async function exportBundle(userId) {
    const uid = userId ? String(userId) : await owner();
    const got = await txAll("readonly", (s) => {
      const out = { profile: null, posts: [], friends: [], messages: [] };
      s[STORE_USERS].get(uid).onsuccess = (e) => {
        out.profile = e.target.result || null;
      };
      s[STORE_POSTS].index(IDX_POST_USER_TIME).getAll(userRange(uid)).onsuccess = (e) => {
        out.posts = e.target.result || [];
      };
      s[STORE_FRIENDS].index(IDX_FRIEND_OWNER).getAll(uid).onsuccess = (e) => {
        out.friends = e.target.result || [];
      };
      s[STORE_MESSAGES].getAll().onsuccess = (e) => {
        out.messages = (e.target.result || []).filter((m) => String(m.userId) === uid);
      };
      return out;
    });
    return got;
  }

  async function deleteAccount(userId) {
    const uid = userId ? String(userId) : await owner();
    const counted = await txAll("readwrite", (s) => {
      const n = { scans: 0, posts: 0, friends: 0, messages: 0 };
      const del = (req, key) => {
        req.onsuccess = (e) => {
          const cur = e.target.result;
          if (!cur) return;
          cur.delete();
          n[key] += 1;
          cur.continue();
        };
      };
      del(s[STORE_SCANS].index(IDX_USER_TIME).openCursor(userRange(uid)), "scans");
      del(s[STORE_POSTS].index(IDX_POST_USER_TIME).openCursor(userRange(uid)), "posts");
      s[STORE_FRIENDS].openCursor().onsuccess = (e) => {
        const cur = e.target.result;
        if (!cur) return;
        const row = cur.value || {};
        if (String(row.ownerId) === uid || String(row.otherId) === uid) {
          cur.delete();
          n.friends += 1;
        }
        cur.continue();
      };
      s[STORE_MESSAGES].openCursor().onsuccess = (e) => {
        const cur = e.target.result;
        if (!cur) return;
        if (String((cur.value || {}).userId) === uid) {
          cur.delete();
          n.messages += 1;
        }
        cur.continue();
      };
      s[STORE_ALBUMS].index(IDX_ALBUM_OWNER).openCursor(uid).onsuccess = (e) => {
        const cur = e.target.result;
        if (!cur) return;
        cur.delete();
        cur.continue();
      };
      s[STORE_STATS].delete(uid);
      s[STORE_USERS].delete(uid);
      return n;
    });
    return counted;
  }

  function foldName(value) {
    return String(value == null ? "" : value).trim().toLowerCase();
  }

  function cleanAlbumName(value) {
    return String(value == null ? "" : value)
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, ALBUM_NAME_MAX);
  }

  function countScans(uid) {
    return tx(STORE_SCANS, "readonly", (s) =>
      wrap(s.index(IDX_USER_TIME).count(userRange(uid)))
    );
  }

  async function listAlbums(userId) {
    const uid = userId ? String(userId) : await owner();
    const rows = await tx(STORE_ALBUMS, "readonly", (s) =>
      wrap(s.index(IDX_ALBUM_OWNER).getAll(uid))
    );
    const tally = await tx(STORE_SCANS, "readonly", (store) => {
      const counts = new Map();
      const req = store.index(IDX_USER_TIME).openCursor(userRange(uid));
      req.onsuccess = (e) => {
        const cur = e.target.result;
        if (!cur) return;
        const key = (cur.value || {}).albumId;
        if (key) counts.set(String(key), (counts.get(String(key)) || 0) + 1);
        cur.continue();
      };
      return counts;
    });
    return (rows || [])
      .map((row) => Object.assign({}, row, { count: tally.get(row.id) || 0 }))
      .sort((a, b) => String(a.created || "").localeCompare(String(b.created || "")));
  }

  async function createAlbum(name, userId) {
    const uid = userId ? String(userId) : await owner();
    const clean = cleanAlbumName(name);
    if (!clean) throw new Error("An album needs a name");
    const here = await listAlbums(uid);
    const clash = here.find((a) => foldName(a.name) === foldName(clean));
    if (clash) return clash;
    const row = { id: newId(), userId: uid, name: clean, created: new Date().toISOString() };
    await tx(STORE_ALBUMS, "readwrite", (s) => wrap(s.put(row)));
    return Object.assign({}, row, { count: 0 });
  }

  async function renameAlbum(albumId, name) {
    const clean = cleanAlbumName(name);
    if (!clean) throw new Error("An album needs a name");
    const uid = await owner();
    const out = await tx(STORE_ALBUMS, "readwrite", (s) => {
      const held = {};
      s.get(String(albumId)).onsuccess = (e) => {
        const row = e.target.result;
        if (!row || String(row.userId) !== uid) return;
        row.name = clean;
        s.put(row);
        held.row = row;
      };
      return held;
    });
    return out.row || null;
  }

  // Deleting an album unfiles its scans instead of taking them with it. The
  // photo is the thing the reader made; the album is only a label on it.
  async function deleteAlbum(albumId) {
    const uid = await owner();
    const id = String(albumId);
    return txAll("readwrite", (s) => {
      const n = { removed: false, unfiled: 0 };
      s[STORE_ALBUMS].get(id).onsuccess = (e) => {
        const row = e.target.result;
        if (!row || String(row.userId) !== uid) return;
        s[STORE_ALBUMS].delete(id);
        n.removed = true;
        s[STORE_SCANS].index(IDX_USER_TIME).openCursor(userRange(uid)).onsuccess = (ev) => {
          const cur = ev.target.result;
          if (!cur) return;
          const scan = cur.value || {};
          if (String(scan.albumId || "") === id) {
            scan.albumId = null;
            cur.update(scan);
            n.unfiled += 1;
          }
          cur.continue();
        };
      };
      return n;
    });
  }

  // The one place a saved scan is edited, so nothing can rewrite a record that
  // belongs to another account.
  function patchScan(scanId, uid, change) {
    return tx(STORE_SCANS, "readwrite", (s) => {
      const held = {};
      s.get(String(scanId)).onsuccess = (e) => {
        const scan = e.target.result;
        if (!scan || String(scan.userId) !== uid) return;
        change(scan);
        s.put(scan);
        held.scan = scan;
      };
      return held;
    }).then((held) => held.scan || null);
  }

  async function setAlbum(scanId, albumId) {
    const uid = await owner();
    const target = albumId ? String(albumId) : null;
    if (target) {
      const album = await tx(STORE_ALBUMS, "readonly", (s) => wrap(s.get(target)));
      if (!album || String(album.userId) !== uid) throw new Error("No such album");
    }
    return patchScan(scanId, uid, (scan) => {
      scan.albumId = target;
    });
  }

  async function setCorrection(scanId, opts) {
    const o = opts || {};
    const uid = await owner();
    const clean = String(o.species == null ? "" : o.species)
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 120);
    return patchScan(scanId, uid, (scan) => {
      scan.correction = clean
        ? { species: clean, at: new Date().toISOString(), shared: !!o.shared }
        : null;
      if (clean) scan.unknown = false;
    });
  }

  async function setUnknown(scanId, on) {
    const uid = await owner();
    return patchScan(scanId, uid, (scan) => {
      scan.unknown = on !== false;
      if (scan.unknown) scan.correction = null;
    });
  }

  // A corrected scan answers to the name the reader gave it, everywhere. An
  // empty string means the record has no name to show, which the view renders
  // as blank rather than as the word Unknown.
  function displaySpecies(scan) {
    const row = scan || {};
    const fixed = row.correction && row.correction.species;
    if (fixed) return String(fixed);
    if (row.unknown) return "";
    const name = row.species ? String(row.species).trim() : "";
    return foldName(name) === "unknown" ? "" : name;
  }

  // Pure on purpose: the dashboard already holds every scan it drew, so the
  // month summary is a pass over that array rather than a second read.
  function monthInsights(scans, when) {
    const at = when ? new Date(when) : new Date();
    const month = at.getFullYear() + "-" + String(at.getMonth() + 1).padStart(2, "0");
    const species = new Map();
    const families = new Map();
    let count = 0;
    for (const scan of scans || []) {
      if (!scan || !scan.timestamp) continue;
      if (String(scan.timestamp).slice(0, 7) !== month) continue;
      count += 1;
      const folded = foldName(displaySpecies(scan));
      if (folded) species.set(folded, (species.get(folded) || 0) + 1);
      const fam = String(scan.family || "").trim();
      if (fam) families.set(fam, (families.get(fam) || 0) + 1);
    }
    let topFamily = null;
    for (const [name, n] of families) {
      if (!topFamily || n > topFamily.count) topFamily = { name: name, count: n };
    }
    return { month: month, scans: count, species: species.size, topFamily: topFamily };
  }

  const HISTORY_KIND = "findflower-history";

  // The thumbnails travel with the scans, which is what makes this a backup
  // rather than a list of names. It is also why the file is measured in
  // megabytes once a reader has a few hundred finds.
  async function exportHistory(userId) {
    const uid = userId ? String(userId) : await owner();
    const [scans, albums, stats] = await Promise.all([
      getScans(null, uid),
      listAlbums(uid),
      getStats(uid),
    ]);
    return {
      kind: HISTORY_KIND,
      schema: DB_VERSION,
      exported: new Date().toISOString(),
      counts: { scans: scans.length, albums: albums.length },
      albums: albums.map((a) => ({ id: a.id, name: a.name, created: a.created })),
      scans: scans,
      stats: stats,
    };
  }

  // Merging is by id, so the same file can be read twice without doubling
  // anything. Albums are matched on name as well: two exports of one shelf made
  // in two browsers carry two different ids for the same thing.
  async function importHistory(bundle) {
    const data = bundle && typeof bundle === "object" ? bundle : {};
    if (data.kind !== HISTORY_KIND || !Array.isArray(data.scans)) {
      throw new Error("That file is not a FindFlower history export");
    }
    const uid = await owner();
    const here = await listAlbums(uid);
    const byName = new Map(here.map((a) => [foldName(a.name), a.id]));
    const usedIds = new Set(here.map((a) => a.id));
    const remap = new Map();
    const added = { albums: 0, scans: 0, skipped: 0 };

    for (const raw of Array.isArray(data.albums) ? data.albums : []) {
      const name = cleanAlbumName(raw && raw.name);
      if (!name) continue;
      const standing = byName.get(foldName(name));
      if (standing) {
        if (raw.id) remap.set(String(raw.id), standing);
        continue;
      }
      const id = raw.id && !usedIds.has(String(raw.id)) ? String(raw.id) : newId();
      const row = {
        id: id,
        userId: uid,
        name: name,
        created: raw.created || new Date().toISOString(),
      };
      await tx(STORE_ALBUMS, "readwrite", (s) => wrap(s.put(row)));
      byName.set(foldName(name), id);
      usedIds.add(id);
      if (raw.id) remap.set(String(raw.id), id);
      added.albums += 1;
    }

    for (const raw of data.scans) {
      if (!raw || !raw.id || !raw.timestamp) {
        added.skipped += 1;
        continue;
      }
      const when = new Date(raw.timestamp);
      if (isNaN(when.getTime())) {
        added.skipped += 1;
        continue;
      }
      const id = String(raw.id);
      const standing = await tx(STORE_SCANS, "readonly", (s) => wrap(s.get(id)));
      if (standing) {
        added.skipped += 1;
        continue;
      }
      const fix = raw.correction && raw.correction.species;
      await tx(STORE_SCANS, "readwrite", (s) =>
        wrap(
          s.put({
            id: id,
            userId: uid,
            species: raw.species ? String(raw.species) : "Unknown",
            confidence: typeof raw.confidence === "number" ? raw.confidence : null,
            imageBase64: typeof raw.imageBase64 === "string" ? raw.imageBase64 : null,
            timestamp: when.toISOString(),
            geolocation: raw.geolocation || null,
            family: raw.family ? String(raw.family) : null,
            albumId: raw.albumId ? remap.get(String(raw.albumId)) || null : null,
            correction: fix
              ? {
                  species: String(fix),
                  at: raw.correction.at || when.toISOString(),
                  shared: !!raw.correction.shared,
                }
              : null,
            unknown: !!raw.unknown,
          })
        )
      );
      added.scans += 1;
    }

    // The streak is left alone on purpose. Records from another browser say
    // nothing about whether this one has been opened every day, and a run of
    // days read out of a file is a number the reader never earned.
    const stats = await getStats(uid);
    stats.totalScans = await countScans(uid);
    await putStats(stats, uid);
    return added;
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
    BADGES,
    badgeIcon,
    UNCLAIMED,
    dayKey,
    dayDiff,
    countUniqueSpecies,
    listSpecies,
    advanceStreak,
    effectiveStreak,
    uniqueSpecies,
    getUser,
    upsertUser,
    listUsers,
    setVisibility,
    saveAvatar,
    addPost,
    listPosts,
    countPosts,
    addFriend,
    listFriends,
    friendStatus,
    removeFriend,
    listMessages,
    topSpecies,
    exportBundle,
    deleteAccount,
    listAlbums,
    createAlbum,
    renameAlbum,
    deleteAlbum,
    setAlbum,
    setCorrection,
    setUnknown,
    displaySpecies,
    monthInsights,
    exportHistory,
    importHistory,
    ALBUM_NAME_MAX,
    SPACES,
    CACHE_LIMIT,
    POST_MAX_CHARS,
  };
})();
