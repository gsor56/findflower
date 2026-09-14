// The inference surface the Worker forwards to.
//
// The Worker owns /internal/scan and /v1/identify publicly. Both arrive here as
// POST /predict, which is the exact contract space/app.py served before it:
// multipart/form-data with a `file` part, an X-Proxy-Secret header, and a
// { flower, confidence, top_k } reply.
//
// That is deliberate. Keeping the contract means moving the model onto this
// server needs no Worker code change at all -- only the SPACE_URL secret has to
// point here instead of at the Space -- so the public API and the site's own
// scanner keep the same shape they had while the Space was alive.
//
// Why the shared secret stays even though the Worker is the only caller: this
// origin is reachable directly at its HidenCloud address, so without the header
// anyone who found that host and port could spend the model. The Worker is the
// only holder of the secret, and the comparison below is constant-time.
//
// Two routes are deliberately outside the secret gate, and both are cheap and
// non-committal:
//   - GET /warm triggers the same load that happens at boot anyway and answers
//     immediately, so it is not worth authenticating.
//   - GET /model-status reports whether the model is loaded and how many classes
//     it has. It reveals nothing about the weights and it is the only way to
//     tell a cold container from a broken one without reading the logs.

import { timingSafeEqual } from 'node:crypto';
import express from 'express';
import multer from 'multer';
import { identify, preload, modelStatus } from '../inference.js';

// 12MB clears a 48-megapixel phone JPEG with room to spare and keeps an
// accidental 300MB upload from becoming this process's problem. Scans are
// resized to 224x224 before the model sees them, so nothing larger helps.
const MAX_UPLOAD_BYTES = Number(process.env.FF_SCAN_MAX_BYTES) || 12 * 1024 * 1024;

const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_UPLOAD_BYTES, files: 2, fields: 8 },
});

function constantTimeEquals(a, b) {
    const left = Buffer.from(String(a), 'utf8');
    const right = Buffer.from(String(b), 'utf8');
    if (left.length !== right.length || left.length === 0) return false;
    try {
        return timingSafeEqual(left, right);
    } catch {
        return false;
    }
}

export function requireProxySecret(req, res, next) {
    const expected = (process.env.PROXY_SECRET || '').trim();
    if (!expected) {
        // Fail closed. An unset secret means the Worker cannot be authenticated
        // either, and serving inference anyway would hand the model to anyone
        // who can reach this port.
        console.error('[scan] PROXY_SECRET is not set; refusing to serve inference.');
        res.status(503).json({ error: 'Inference is not configured on this server.' });
        return;
    }
    if (!constantTimeEquals(req.get('X-Proxy-Secret') || '', expected)) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
    }
    next();
}

const router = express.Router();

// The Worker's /warm poke lands here. It starts a load that boot already
// started and answers at once, so the page never waits on a container.
router.get('/warm', (req, res) => {
    preload().catch(() => { });
    const status = modelStatus();
    res.status(202).json({ warming: !status.ready, phase: status.phase });
});

router.get('/model-status', (req, res) => {
    res.json(modelStatus());
});

function runInference(req, res) {
    const parts = req.files || {};
    const file = req.file
        || (Array.isArray(parts.file) && parts.file[0])
        || (Array.isArray(parts.image) && parts.image[0]);

    if (!file || !file.buffer || file.buffer.length === 0) {
        res.status(400).json({ error: 'Multipart body is missing a non-empty image in a `file` field.' });
        return;
    }

    identify(file.buffer)
        .then((prediction) => {
            res.json(prediction);
        })
        .catch((err) => {
            const message = err && err.message ? err.message : String(err);
            // While the weights are still coming down, a retry is the right
            // answer rather than a failure: the Worker already retries 502/503.
            if (/still loading/i.test(message)) {
                res.status(503).json({ error: 'Model is still loading.', detail: message });
                return;
            }
            if (/could not decode|empty image|expected 3 channels/i.test(message)) {
                res.status(400).json({ error: 'Invalid image', detail: message });
                return;
            }
            console.error('[scan] inference failed:', message);
            res.status(500).json({ error: 'Inference failed', detail: message });
        });
}

// `file` is what the Worker sends. `image` is accepted because the API docs
// have always described the part loosely, and a 400 over a field name is a
// worse answer than doing the work.
const acceptImage = upload.fields([
    { name: 'file', maxCount: 1 },
    { name: 'image', maxCount: 1 },
]);

function handle(req, res) {
    acceptImage(req, res, (err) => {
        if (err) {
            if (err.code === 'LIMIT_FILE_SIZE') {
                res.status(413).json({
                    error: 'Image is too large.',
                    limit_bytes: MAX_UPLOAD_BYTES,
                });
                return;
            }
            res.status(400).json({ error: 'Malformed multipart body.', detail: err.message });
            return;
        }
        runInference(req, res);
    });
}

router.post('/predict', requireProxySecret, handle);
// An alias, so pointing SPACE_URL at either path works.
router.post('/scan', requireProxySecret, handle);

export default router;
