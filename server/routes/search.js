import { Router } from 'express';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { User } from '../models/user.js';
import { Post } from '../models/post.js';
import { rateLimit } from '../lib.js';

// One query, three indexes. Ten rows each, so a wide query cannot turn into a
// page of five hundred results on a phone.

const router = Router();
const PER_CATEGORY = 10;

// The model's own vocabulary, the same file space/app.py loads to label its
// logits. Read once at boot: 116 lowercase common names, so the species column
// can only ever offer flowers the scanner could actually name.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SPECIES = JSON.parse(
    readFileSync(path.join(HERE, '..', '..', 'space', 'class_names.json'), 'utf8'),
);

/** Escape a user's query before it goes near a regex. */
function safe(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** GET /api/search?q=rosa */
router.get('/', rateLimit('search', 60_000, 60), async (req, res) => {
    const q = String(req.query.q || '').trim();
    if (q.length < 2) {
        res.json({ query: q, species: [], users: [], posts: [] });
        return;
    }
    const rx = new RegExp(safe(q), 'i');

    // A name that starts with the query beats one that merely contains it --
    // typing "dan" should put dandelion first, not eighth.
    const starts = [];
    const holds = [];
    for (const name of SPECIES) {
        if (name.startsWith(q.toLowerCase())) starts.push(name);
        else if (rx.test(name)) holds.push(name);
        if (starts.length >= PER_CATEGORY) break;
    }
    const species = starts.concat(holds).slice(0, PER_CATEGORY);

    const users = await User.find({
        'privacy.isPublic': true,
        $or: [{ handle: rx }, { displayName: rx }],
    }).limit(PER_CATEGORY).select('handle displayName avatar badges');

    // $text needs the index built, which on a fresh database it may not be yet.
    // A substring scan answers the same question more slowly rather than 500ing.
    let posts;
    try {
        posts = await Post.find({ $text: { $search: q }, isDeleted: false })
            .sort({ score: { $meta: 'textScore' } })
            .limit(PER_CATEGORY)
            .populate('author', 'handle displayName avatar');
    } catch (err) {
        posts = await Post.find({ isDeleted: false, $or: [{ title: rx }, { content: rx }] })
            .sort({ createdAt: -1 })
            .limit(PER_CATEGORY)
            .populate('author', 'handle displayName avatar');
    }

    res.json({
        query: q,
        species,
        users: users.map((u) => ({
            handle: u.handle, displayName: u.displayName, avatar: u.avatar, badges: u.badges,
        })),
        posts: posts.map((p) => ({
            id: String(p._id),
            space: p.space,
            title: p.title,
            // Enough to recognise the thread, not the whole essay.
            excerpt: p.content.slice(0, 160),
            author: p.author ? { handle: p.author.handle, displayName: p.author.displayName } : null,
            createdAt: p.createdAt,
        })),
    });
});

export default router;
