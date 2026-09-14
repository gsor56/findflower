// ff_scans -- the server-side half of the browser's `scans` store.
//
// Why this exists at all: the herbarium used to be one browser's IndexedDB. That
// is a fine place for a scan and a bad place for a collection, because the same
// person on a phone and a laptop had two unrelated histories -- three finds on
// one, an empty dashboard on the other -- with nothing to reconcile them. A row
// here is that same record under the same id, so two devices converge on a union
// instead of one copying over the other.
//
// The id is the client's own. storage.js mints it with crypto.randomUUID(), so
// an upload is idempotent (a repeated sync inserts nothing new) and a download
// imports under the id the record already had. That is what makes it safe to run
// on every page load rather than behind a button somebody has to remember.

import { Schema, model } from 'mongoose';

// storage.js keeps a 160px JPEG data URL per scan; those run 5-15KB. The cap is
// generous on purpose: it is here to refuse an unresized upload, not to trim the
// thumbnail a dashboard card actually renders.
const MAX_THUMB = 32768;
const MAX_TEXT = 120;
const MAX_ID = 80;

const scanSchema = new Schema({
    // The Auth0 sub, not a foreign key to ff_users: a scan belongs to a person
    // whether or not they have claimed a handle yet, and requireViewer already
    // guarantees there is a row before this is written.
    authSub: { type: String, required: true, index: true },
    clientId: { type: String, required: true, trim: true, maxlength: MAX_ID },
    species: { type: String, default: 'Unknown', trim: true, maxlength: MAX_TEXT },
    confidence: { type: Number, default: null },
    thumb: { type: String, default: null, maxlength: MAX_THUMB },
    family: { type: String, default: null, trim: true, maxlength: MAX_TEXT },
    albumId: { type: String, default: null, maxlength: MAX_ID },
    // Free-form on purpose: storage.js stores whatever the geolocation call
    // returned, and that shape belongs to the browser, not to this schema.
    geolocation: { type: Schema.Types.Mixed, default: null },
    // The reader's own correction of a wrong identification. Carried in the same
    // shape the local store uses, so an imported row is indistinguishable from
    // one recorded here.
    correction: {
        species: { type: String, default: null, trim: true, maxlength: MAX_TEXT },
        at: { type: Date, default: null },
        shared: { type: Boolean, default: false },
    },
    unknown: { type: Boolean, default: false },
    // The client's timestamp, not the write time. Two devices have to kind their
    // records into one order, and the order the reader actually scanned in is
    // theirs to keep -- a sync is not a new find.
    scannedAt: { type: Date, required: true },
}, { timestamps: true });

// One row per client record per account. The whole idempotency argument above
// rests on this constraint: without it, running the sync twice doubles a
// herbarium, which is the exact failure the feature is meant to prevent.
scanSchema.index({ authSub: 1, clientId: 1 }, { unique: true });
// The dashboard's read: this account's scans, newest first.
scanSchema.index({ authSub: 1, scannedAt: -1 });

/**
 * The one shape a scan is allowed to take on the wire.
 *
 * Shared by the API routes and the server render so the page a reader loads and
 * the JSON a script fetches can never describe the same row differently. Field
 * names match storage.js (`id`, `imageBase64`, `timestamp`) rather than the
 * database's (`clientId`, `thumb`, `scannedAt`), because the browser is the
 * consumer and its local schema is the contract an import reads.
 */
export function toClientScan(row) {
    const fix = row && row.correction && row.correction.species;
    return {
        id: String(row.clientId || ''),
        species: row.species || 'Unknown',
        confidence: typeof row.confidence === 'number' ? row.confidence : null,
        imageBase64: row.thumb || null,
        timestamp: row.scannedAt instanceof Date ? row.scannedAt.toISOString() : row.scannedAt || null,
        geolocation: row.geolocation || null,
        family: row.family || null,
        albumId: row.albumId || null,
        correction: fix
            ? {
                species: String(fix),
                at: row.correction.at instanceof Date ? row.correction.at.toISOString() : row.correction.at || null,
                shared: !!row.correction.shared,
            }
            : null,
        unknown: !!row.unknown,
    };
}

/**
 * Normalise one uploaded record, or null if it cannot be a scan.
 *
 * A record without an id or a usable timestamp is dropped rather than defaulted:
 * a scan with no id cannot be de-duplicated, and importing it into the other
 * device twice is exactly the bug this route exists to fix.
 */
export function fromClientScan(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const clientId = String(raw.id || '').trim().slice(0, MAX_ID);
    if (!clientId) return null;
    const when = new Date(raw.timestamp);
    if (Number.isNaN(when.getTime())) return null;
    const fix = raw.correction && raw.correction.species ? raw.correction : null;
    const thumb = typeof raw.imageBase64 === 'string' && raw.imageBase64.length <= MAX_THUMB
        ? raw.imageBase64
        : null;
    return {
        clientId,
        species: String(raw.species || 'Unknown').slice(0, MAX_TEXT),
        confidence: typeof raw.confidence === 'number' && Number.isFinite(raw.confidence)
            ? Math.min(1, Math.max(0, raw.confidence))
            : null,
        thumb,
        family: raw.family ? String(raw.family).slice(0, MAX_TEXT) : null,
        albumId: raw.albumId ? String(raw.albumId).slice(0, MAX_ID) : null,
        geolocation: raw.geolocation || null,
        correction: fix
            ? {
                species: String(fix.species).slice(0, MAX_TEXT),
                at: fix.at ? new Date(fix.at) : null,
                shared: !!fix.shared,
            }
            : null,
        unknown: !!raw.unknown,
        scannedAt: when,
    };
}

export const Scan = model('Scan', scanSchema, 'ff_scans');
export { MAX_THUMB, MAX_TEXT };
