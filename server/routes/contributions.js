// POST /api/contributions -- stage one crowdsourced training image.
//
// Two gates run before anything is stored, and they are ordered by cost:
//
//   1. The browser already ran the Lite CNN and sends its verdict. A 'junk'
//      verdict is refused outright (422) with nothing written, so a visitor
//      pointing the camera at their keyboard costs the server one JSON parse.
//   2. The server hashes the decoded bytes and refuses a repeat. sha256 is the
//      cheapest dedupe that can run here; the perceptual (dHash) pass belongs
//      in the offline sync job, which has the time budget for it.
//
// Deliberately absent: any image model on this process. The container has 3GB
// and the EVA-02 ONNX export is going to want most of it, so classification
// stays in the browser (ONNX Runtime Web / TF.js) and this route only reasons
// about what it was told plus what it can compute cheaply.

import crypto from 'node:crypto';
import express from 'express';
import { Router } from 'express';
import { Contribution, MAX_IMAGE_CHARS } from '../models/contribution.js';
import { pageParams, rateLimit, requireViewer } from '../lib.js';

const router = Router();

const FLOWER_VERDICT = 'flower';
const MIN_CONFIDENCE = 0.35;
const MAX_BODY = '2mb';

const DATA_URL = /^data:(image\/(?:jpeg|jpg|png|webp));base64,([A-Za-z0-9+/=\s]+)$/;

/** Decode a data URL and answer with the bytes, or with the reason it failed. */
function readImage(raw) {
    const text = typeof raw === 'string' ? raw.trim() : '';
    if (!text) return { error: 'An image is required.' };
    if (text.length > MAX_IMAGE_CHARS) {
        return { error: 'That image is larger than the 1.5MB staging limit.' };
    }
    const m = text.match(DATA_URL);
    if (!m) {
        // The common case is a canvas export left as image/png with a stray
        // whitespace, or a blob URL, which is not portable and not something
        // the server can read at all.
        return { error: 'Send the image as a base64 data URL (jpeg, png or webp).' };
    }
    let buf;
    try {
        buf = Buffer.from(m[2].replace(/\s+/g, ''), 'base64');
    } catch {
        return { error: 'That image could not be decoded.' };
    }
    if (buf.length < 512) return { error: 'That image is too small to be useful.' };
    if (buf.length > 1_200_000) return { error: 'That image is larger than the 1.2MB byte limit.' };
    return { bytes: buf, mime: m[1] };
}

function cleanTaxon(raw) {
    const t = raw && typeof raw === 'object' ? raw : {};
    const name = String(t.acceptedName || t.name || '').trim();
    if (name.length < 2) return { error: 'A species name is required.' };
    return {
        taxon: {
            id: t.id ? String(t.id).trim().slice(0, 80) : null,
            acceptedName: name.slice(0, 120),
            commonName: t.commonName ? String(t.commonName).trim().slice(0, 120) : null,
            genus: t.genus ? String(t.genus).trim().slice(0, 60) : null,
        },
    };
}

function readVerdict(raw) {
    const v = raw && typeof raw === 'object' ? raw : {};
    const verdict = String(v.verdict || 'unknown').toLowerCase();
    const confidence = Number(v.confidence);
    return {
        model: v.model ? String(v.model).trim().slice(0, 60) : 'lite-cnn',
        label: v.label ? String(v.label).trim().slice(0, 120) : null,
        confidence: Number.isFinite(confidence) ? Math.min(1, Math.max(0, confidence)) : 0,
        verdict: ['flower', 'junk', 'unknown'].includes(verdict) ? verdict : 'unknown',
        reason: v.reason ? String(v.reason).trim().slice(0, 120) : null,
    };
}

/** POST /api/contributions */
router.post('/', rateLimit('contribute:post', 60 * 60_000, 60), express.json({ limit: MAX_BODY }),
    requireViewer, async (req, res) => {
        const body = req.body || {};
        const image = readImage(body.image);
        if (image.error) {
            res.status(400).json({ error: image.error });
            return;
        }
        const taxon = cleanTaxon(body.taxon);
        if (taxon.error) {
            res.status(400).json({ error: taxon.error });
            return;
        }
        const validation = readVerdict(body.validation);

        // Gate 1: the browser said this is not a flower. Refuse it and write
        // nothing, so the staging queue stays all-positives.
        if (validation.verdict === 'junk') {
            res.status(422).json({
                error: 'That does not look like a flower, so it was not added.',
                verdict: validation.verdict,
            });
            return;
        }
        // A 'flower' verdict the model was not sure about is a maybe. Refusing
        // beats storing a training row nobody can label later.
        if (validation.verdict === FLOWER_VERDICT && validation.confidence < MIN_CONFIDENCE) {
            res.status(422).json({
                error: 'The on-device check was not confident enough. Move closer and try again.',
                verdict: validation.verdict,
            });
            return;
        }

        const imageHash = crypto.createHash('sha256').update(image.bytes).digest('hex');
        try {
            const doc = await Contribution.create({
                contributor: req.viewer._id,
                contributorHandle: req.viewer.handle,
                taxon: taxon.taxon,
                note: body.note ? String(body.note).trim().slice(0, 300) : '',
                image: 'data:' + image.mime + ';base64,' + image.bytes.toString('base64'),
                mime: image.mime,
                imageHash,
                bytes: image.bytes.length,
                validation,
            });
            res.status(201).json({ contribution: doc.toPublic() });
        } catch (err) {
            if (err && err.code === 11000) {
                res.status(409).json({ error: 'That photo is already in the queue. Thank you, though.' });
                return;
            }
            res.status(400).json({ error: err.message });
        }
    });

/** GET /api/contributions/mine?page=1&limit=20 */
router.get('/mine', requireViewer, async (req, res) => {
    const { page, limit, skip } = pageParams(req.query, 20, 50);
    const [rows, total, staged] = await Promise.all([
        Contribution.find({ contributor: req.viewer._id }).sort({ createdAt: -1 }).skip(skip).limit(limit),
        Contribution.countDocuments({ contributor: req.viewer._id }),
        Contribution.countDocuments({ contributor: req.viewer._id, status: 'staged' }),
    ]);
    res.json({ contributions: rows.map((r) => r.toPublic()), page, limit, total, staged });
});

/** DELETE /api/contributions/:id -- withdraw a row that has not synced yet. */
router.delete('/:id', requireViewer, async (req, res) => {
    const row = await Contribution.findOne({ _id: req.params.id, contributor: req.viewer._id });
    if (!row) {
        res.status(404).json({ error: 'No contribution of yours with that id.' });
        return;
    }
    if (row.status === 'synced') {
        res.status(409).json({ error: 'That image has already joined the public set.' });
        return;
    }
    await row.deleteOne();
    res.json({ id: String(row._id), status: 'withdrawn' });
});

export default router;
