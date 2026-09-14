// Personal developer keys for the public inference API.
//
// Until now /api could only say "sign in with Auth0 and copy the bearer token
// out of the tab", which no external program can do: the session is an
// httpOnly cookie belonging to a browser, not a credential a curl command can
// hold. These keys are that credential.
//
// The plaintext is 51 characters of CSPRNG output, shown exactly once at
// creation. What the database keeps is its SHA-256, so a leaked database dump
// does not hand anyone a working key, and verification is one indexed equality
// test on 'apiKeys.hash' rather than a comparison against every account.

import { Router } from 'express';
import { createHash, randomBytes } from 'node:crypto';
import { User } from '../models/user.js';
import { rateLimit, requireViewer } from '../lib.js';
import { requireProxySecret } from './identify.js';

const KEY_PREFIX = 'ff_';
const KEY_BYTES = 24;          // 48 hex characters after the prefix
const MAX_KEYS = 10;
// A scan-heavy client would otherwise write to Mongo on every single request
// just to say "still in use".
const LAST_USED_WRITE_MS = 5 * 60 * 1000;

function hashKey(key) {
    return createHash('sha256').update(String(key), 'utf8').digest('hex');
}

function mint() {
    return KEY_PREFIX + randomBytes(KEY_BYTES).toString('hex');
}

/** What the developer is allowed to see about their own key. Never the hash. */
function publicKey(entry) {
    return {
        id: entry.id,
        prefix: entry.prefix,
        label: entry.label || '',
        createdAt: entry.createdAt,
        lastUsedAt: entry.lastUsedAt,
        revokedAt: entry.revokedAt,
        active: !entry.revokedAt,
    };
}

const router = Router();

/** GET /api/keys -- the caller's own keys, newest first. */
router.get('/', requireViewer, (req, res) => {
    const keys = (req.viewer.apiKeys || []).map(publicKey)
        .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    res.json({ keys, max: MAX_KEYS });
});

/**
 * POST /api/keys/generate  { label? }
 *
 * The response body is the only place the plaintext key ever exists. There is
 * no route that can read it back, which is the point: a key that can be
 * re-displayed is a key that leaks with the session.
 */
router.post('/generate', rateLimit('keys:generate', 60 * 60_000, 10), requireViewer, async (req, res) => {
    const user = req.viewer;
    const active = (user.apiKeys || []).filter((entry) => !entry.revokedAt);
    if (active.length >= MAX_KEYS) {
        res.status(409).json({
            error: 'You already have ' + MAX_KEYS + ' active keys. Revoke one first.',
            max: MAX_KEYS,
        });
        return;
    }

    const key = mint();
    const entry = {
        id: randomBytes(8).toString('hex'),
        hash: hashKey(key),
        prefix: key.slice(0, KEY_PREFIX.length + 8),
        label: String((req.body && req.body.label) || '').slice(0, 60),
    };
    user.apiKeys.push(entry);
    await user.save();

    res.status(201).json({ key, entry: publicKey(entry) });
});

/** POST /api/keys/revoke  { id } -- revoking is final; generate a new one. */
router.post('/revoke', requireViewer, async (req, res) => {
    const id = String((req.body && req.body.id) || '');
    const entry = (req.viewer.apiKeys || []).find((k) => k.id === id);
    if (!entry) {
        res.status(404).json({ error: 'No such key.' });
        return;
    }
    if (!entry.revokedAt) entry.revokedAt = new Date();
    await req.viewer.save();
    res.json({ entry: publicKey(entry) });
});

/**
 * POST /api/keys/verify  { key }
 *
 * The Worker's key check. It cannot verify one itself -- the hashes live in
 * MongoDB -- so it asks here and then serves the scan from the shared pool.
 * Gated by X-Proxy-Secret, which only the Worker holds, so this never becomes
 * a public oracle for testing stolen keys from outside.
 *
 * Every failure answers the same { valid: false }: whether a key exists,
 * expired or was revoked is not a distinction the caller gets to make.
 */
router.post('/verify', requireProxySecret, async (req, res) => {
    const key = String((req.body && req.body.key) || '');
    if (!new RegExp('^' + KEY_PREFIX + '[0-9a-f]{32,}$', 'i').test(key)) {
        res.json({ valid: false });
        return;
    }
    const hash = hashKey(key);
    const user = await User.findOne({ 'apiKeys.hash': hash });
    const entry = user && (user.apiKeys || []).find((k) => k.hash === hash && !k.revokedAt);
    if (!entry) {
        res.json({ valid: false });
        return;
    }

    const now = Date.now();
    const last = entry.lastUsedAt ? new Date(entry.lastUsedAt).getTime() : 0;
    if (now - last > LAST_USED_WRITE_MS) {
        entry.lastUsedAt = new Date(now);
        // Not awaited into a failure path: the key is already verified, and a
        // bookkeeping write must not turn a good scan into a 500.
        user.save().catch((err) => console.error('[keys] lastUsedAt write failed:', err.message));
    }
    res.json({ valid: true, sub: user.authSub, keyId: entry.id });
});

export default router;
