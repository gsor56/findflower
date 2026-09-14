// The herbarium endpoints: the account's scans, in and out.
//
//   GET  /api/scans               this account's scans, newest first
//   POST /api/scans/sync          merge a client's records in
//   POST /api/user/sync-scans     the same handler, under the name the brief used
//
// Three things make the merge safe to run unattended on every page load. It is
// keyed on the client's own record id, so re-sending a batch inserts nothing;
// it is upsert-only, so a device can never delete another device's finds by
// syncing; and it answers with counts rather than an error when a record is
// unusable, because a single malformed row must not strand a whole herbarium.

import { Router } from 'express';
import { Scan, fromClientScan, toClientScan } from '../models/scan.js';
import { rateLimit, requireViewer } from '../lib.js';

const router = Router();

// One upload is a browser handing over its whole local history. 5,000 rows is
// far past any real herbarium and still a bounded write, and the byte cap on
// express.json keeps the body itself to 256KB.
const MAX_PER_SYNC = 5000;
// One download is a page's first paint of saved finds.
const PAGE = 500;
const MAX_PAGE = 2000;

/** Shaped for storage.js: the local store imports these under `scans`. */
function listRows(rows) {
    return rows.map(toClientScan);
}

/**
 * POST /api/scans/sync  { scans: [ ...local records ] }
 *
 * `$setOnInsert` for the identity fields and `$set` for the rest: the device
 * that made a scan owns what it says, but a re-sync cannot resurrect a record's
 * identity or move it onto another account. A null thumbnail is skipped rather
 * than written, so a browser that has lost its local image cannot blank out the
 * one another device already uploaded.
 */
async function syncScans(req, res) {
    const body = req.body || {};
    const incoming = Array.isArray(body.scans) ? body.scans : [];
    if (!incoming.length) {
        const total = await Scan.countDocuments({ authSub: req.viewer.authSub });
        res.json({ added: 0, updated: 0, skipped: 0, total, scans: [] });
        return;
    }

    const docs = [];
    let skipped = 0;
    const seen = new Set();
    for (const raw of incoming.slice(0, MAX_PER_SYNC)) {
        const doc = fromClientScan(raw);
        // A batch from one browser can contain the same id twice if a tab was
        // restored mid-write. Two upserts on one key in a single bulkWrite is an
        // error, so the duplicate is dropped here instead.
        if (!doc || seen.has(doc.clientId)) {
            skipped += 1;
            continue;
        }
        seen.add(doc.clientId);
        docs.push(doc);
    }

    let added = 0, updated = 0;
    if (docs.length) {
        const ops = docs.map((doc) => {
            const { clientId, scannedAt, thumb, ...rest } = doc;
            const set = { ...rest };
            if (thumb) set.thumb = thumb;
            return {
                updateOne: {
                    filter: { authSub: req.viewer.authSub, clientId },
                    update: { $set: set, $setOnInsert: { authSub: req.viewer.authSub, clientId, scannedAt } },
                    upsert: true,
                },
            };
        });
        const result = await Scan.bulkWrite(ops, { ordered: false });
        added = result.upsertedCount || 0;
        updated = result.modifiedCount || 0;
    }

    const total = await Scan.countDocuments({ authSub: req.viewer.authSub });
    res.json({ added, updated, skipped, total, scans: listRows(docs) });
}

/** GET /api/scans?limit=500 -- this account's finds, newest first. */
router.get('/scans', requireViewer, async (req, res) => {
    const asked = parseInt(req.query.limit, 10) || PAGE;
    const limit = Math.min(MAX_PAGE, Math.max(1, asked));
    const rows = await Scan.find({ authSub: req.viewer.authSub })
        .sort({ scannedAt: -1 })
        .limit(limit)
        .lean({ virtuals: false });
    const total = await Scan.countDocuments({ authSub: req.viewer.authSub });
    res.json({ scans: listRows(rows), total, limit, count: rows.length });
});

router.post('/scans/sync', rateLimit('scans:sync', 60_000, 30), requireViewer, syncScans);
// The brief asked for /api/user/sync-scans. Registered as its own path rather
// than by mounting this router twice, so the alias answers the sync and nothing
// else -- /api/user does not silently become a scan list.
router.post('/user/sync-scans', rateLimit('scans:sync', 60_000, 30), requireViewer, syncScans);

export default router;
