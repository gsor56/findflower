import { Router } from 'express';
import { User } from '../models/user.js';
import { Post } from '../models/post.js';
import { viewerSub } from '../auth.js';
import { authRefusal, rateLimit, requireViewer } from '../lib.js';

// Profiles. The brief lists no routes for these, but nothing else works without
// them: a post needs an author row, and a browser cannot make one itself.

const router = Router();

/** GET /api/users/me returns the caller's own row, privacy fields included. */
router.get('/me', requireViewer, (req, res) => {
    res.json({ user: req.viewer.toPublic() });
});

/**
 * POST /api/users  { handle, displayName, bio?, avatar?, badges?, stats?, privacy? }
 * Claims a handle on first call and updates the row after that. Keyed on the
 * verified `sub`, so this can only ever write the caller's own profile.
 */
router.post('/', rateLimit('user:upsert', 10 * 60_000, 20), async (req, res) => {
    const sub = await viewerSub(req);
    if (!sub) {
        res.status(401).json(authRefusal(req));
        return;
    }
    const body = req.body || {};
    const existing = await User.findOne({ authSub: sub });

    const doc = existing || new User({ authSub: sub, handle: '', displayName: '' });
    if (body.handle !== undefined) doc.handle = String(body.handle);
    if (body.displayName !== undefined) doc.displayName = String(body.displayName);
    if (body.bio !== undefined) doc.bio = String(body.bio);
    if (body.avatar !== undefined) doc.avatar = body.avatar ? String(body.avatar) : null;
    // Badge ids and scan counts are computed in the browser from records this
    // server never sees, so they arrive as reported. They describe the reporter
    // and nobody else, which is the only reason that is safe.
    if (Array.isArray(body.badges)) doc.badges = body.badges.map(String);
    if (body.stats && typeof body.stats === 'object') {
        if (Number.isFinite(body.stats.scansCount)) doc.stats.scansCount = body.stats.scansCount;
        if (Number.isFinite(body.stats.helpfulCount)) doc.stats.helpfulCount = body.stats.helpfulCount;
    }
    if (body.privacy && typeof body.privacy === 'object') {
        for (const k of ['isPublic', 'showHistory', 'allowDMs']) {
            if (typeof body.privacy[k] === 'boolean') doc.privacy[k] = body.privacy[k];
        }
    }

    try {
        await doc.save();
    } catch (err) {
        // 11000 is the unique index on handle (or on authSub, if two tabs raced
        // the first save). Either way it is a taken name, not a server fault.
        if (err.code === 11000) {
            res.status(409).json({ error: 'That handle is taken.', field: 'handle' });
            return;
        }
        res.status(400).json({ error: err.message });
        return;
    }
    res.status(existing ? 200 : 201).json({ user: doc.toPublic() });
});

/** GET /api/users/:handle returns the public card, plus a thread count for its tabs.
 *  A private profile answers with the name and nothing else: the search palette
 *  already offered the name, so hiding it here would only look broken. */
router.get('/:handle', async (req, res) => {
    const handle = String(req.params.handle || '').toLowerCase();
    const user = await User.findOne({ handle });
    if (!user) {
        res.status(404).json({ error: 'No profile with that handle.' });
        return;
    }
    const sub = await viewerSub(req);
    const isOwner = sub && sub === user.authSub;
    if (!user.privacy.isPublic && !isOwner) {
        res.json({ user: { handle: user.handle, displayName: user.displayName }, private: true });
        return;
    }
    const threads = await Post.countDocuments({ author: user._id, isDeleted: false });
    res.json({ user: user.toPublic(), threads, isOwner: !!isOwner });
});

export default router;
