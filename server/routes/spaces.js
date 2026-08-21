import { Router } from 'express';
import { Space } from '../models/space.js';
import { Post } from '../models/post.js';
import { rateLimit, requireViewer } from '../lib.js';

const router = Router();

/** GET /api/spaces — the section list, with a live thread count each. */
router.get('/', async (req, res) => {
    const spaces = await Space.find({}).sort({ isDefault: -1, name: 1 }).lean();
    const counts = await Post.aggregate([
        { $match: { isDeleted: false } },
        { $group: { _id: '$space', n: { $sum: 1 } } },
    ]);
    const byslug = new Map(counts.map((c) => [c._id, c.n]));
    res.json({
        spaces: spaces.map((s) => ({
            name: s.name,
            slug: s.slug,
            description: s.description,
            isDefault: !!s.isDefault,
            creator: s.creator ? String(s.creator) : null,
            posts: byslug.get(s.slug) || 0,
        })),
    });
});

/** POST /api/spaces  { name, description? } — the slug is derived, not given, so
 *  two people cannot claim the same section under different punctuation. */
router.post('/', rateLimit('space:create', 60 * 60_000, 3), requireViewer, async (req, res) => {
    const body = req.body || {};
    const name = String(body.name || '').trim();
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    if (name.length < 3 || !slug) {
        res.status(400).json({ error: 'A space needs a name of at least three letters or numbers.' });
        return;
    }
    try {
        const space = await Space.create({
            name,
            slug,
            description: body.description ? String(body.description).trim() : '',
            creator: req.viewer._id,
            isDefault: false,
        });
        res.status(201).json({
            space: {
                name: space.name, slug: space.slug, description: space.description,
                isDefault: false, creator: String(req.viewer._id), posts: 0,
            },
        });
    } catch (err) {
        if (err.code === 11000) {
            res.status(409).json({ error: 'A space with that name already exists.' });
            return;
        }
        res.status(400).json({ error: err.message });
    }
});

export default router;
