import { Router } from 'express';
import { Post } from '../models/post.js';
import { Space } from '../models/space.js';
import { User } from '../models/user.js';
import { pageParams, rateLimit, requireViewer, optionalViewer } from '../lib.js';

// Threads. Reads are public; every write needs a verified token, and the author
// checks are done against req.viewer._id rather than anything the client sends.

const router = Router();
const AUTHOR_FIELDS = 'handle displayName avatar';

/** GET /api/posts?space=slug&author=handle&page=1&limit=20
 *  Newest first, soft-deleted rows excluded, 20 the hard ceiling. */
router.get('/', optionalViewer, async (req, res) => {
    const { page, limit, skip, before } = pageParams(req.query, 20, 20);
    const q = { isDeleted: false };
    if (req.query.space) q.space = String(req.query.space).toLowerCase();
    if (before) q.createdAt = { $lt: before };

    // author=<handle>, for the Threads tab on a profile card. An unknown handle
    // is an empty page rather than a 404: the card above it already resolved.
    if (req.query.author) {
        const who = await User.findOne({ handle: String(req.query.author).toLowerCase() }).select('_id');
        if (!who) { res.json({ posts: [], page, limit, total: 0, hasMore: false }); return; }
        q.author = who._id;
    }

    const [rows, total] = await Promise.all([
        Post.find(q)
            .sort({ createdAt: -1 })
            // A cursor read starts at the row after `before`, so the page
            // offset would skip a second window on top of it.
            .skip(before ? 0 : skip)
            .limit(limit)
            .populate('author', AUTHOR_FIELDS),
        Post.countDocuments(q),
    ]);

    const viewerId = req.viewer ? req.viewer._id : null;
    res.json({
        posts: rows.map((r) => r.toFeed(viewerId)),
        page,
        limit,
        total,
        hasMore: before ? rows.length === limit : skip + rows.length < total,
    });
});

/** GET /api/posts/:id — one post, so a shared link resolves to the thread it
 *  names rather than to whatever happens to be on the first page of the feed. */
router.get('/:id', optionalViewer, async (req, res) => {
    const post = await Post.findOne({ _id: req.params.id, isDeleted: false })
        .populate('author', AUTHOR_FIELDS)
        .catch(() => null);
    if (!post) {
        res.status(404).json({ error: 'No such post.' });
        return;
    }
    res.json({ post: post.toFeed(req.viewer ? req.viewer._id : null) });
});

/** POST /api/posts  { space, content, title?, articleRef? } */
router.post('/', rateLimit('post:create', 10 * 60_000, 10), requireViewer, async (req, res) => {
    const body = req.body || {};
    const slug = String(body.space || '').toLowerCase().trim();
    const content = String(body.content == null ? '' : body.content).trim();
    if (!content) {
        res.status(400).json({ error: 'A post needs something in it.' });
        return;
    }
    // The space has to exist. Accepting a free-text slug would grow sections
    // nobody can navigate to, one typo at a time.
    const space = await Space.findOne({ slug });
    if (!space) {
        res.status(400).json({ error: `No space with the slug "${slug}".` });
        return;
    }

    try {
        const doc = await Post.create({
            author: req.viewer._id,
            space: space.slug,
            title: body.title ? String(body.title).trim() : null,
            content,
            articleRef: body.articleRef ? String(body.articleRef).trim() : null,
        });
        await doc.populate('author', AUTHOR_FIELDS);
        res.status(201).json({ post: doc.toFeed(req.viewer._id) });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

/** DELETE /api/posts/:id — author only, and a flag rather than a removal. */
router.delete('/:id', requireViewer, async (req, res) => {
    const post = await Post.findById(req.params.id).catch(() => null);
    if (!post || post.isDeleted) {
        res.status(404).json({ error: 'No such post.' });
        return;
    }
    if (String(post.author) !== String(req.viewer._id)) {
        res.status(403).json({ error: 'Only the author can delete a post.' });
        return;
    }
    post.isDeleted = true;
    await post.save();
    res.json({ id: String(post._id), isDeleted: true });
});

/** POST /api/posts/:id/like — toggle. $addToSet/$pull rather than read-modify-
 *  write, so two taps arriving together cannot both decide the array. */
router.post('/:id/like', rateLimit('post:like', 60_000, 60), requireViewer, async (req, res) => {
    const id = req.params.id;
    const post = await Post.findOne({ _id: id, isDeleted: false }).catch(() => null);
    if (!post) {
        res.status(404).json({ error: 'No such post.' });
        return;
    }
    const me = req.viewer._id;
    const liked = post.likes.some((u) => String(u) === String(me));
    const update = liked ? { $pull: { likes: me } } : { $addToSet: { likes: me } };
    const after = await Post.findByIdAndUpdate(id, update, { returnDocument: 'after', select: 'likes' });
    res.json({ id, likedByViewer: !liked, likeCount: after.likes.length });
});

/** POST /api/posts/:id/report  { reason } */
router.post('/:id/report', rateLimit('post:report', 60 * 60_000, 5), requireViewer, async (req, res) => {
    const reason = String((req.body || {}).reason || '').trim();
    if (!reason) {
        res.status(400).json({ error: 'Say what is wrong with it.' });
        return;
    }
    const post = await Post.findOne({ _id: req.params.id, isDeleted: false }).catch(() => null);
    if (!post) {
        res.status(404).json({ error: 'No such post.' });
        return;
    }
    // One report per person per post: a second one is the same complaint, and
    // counting it twice would make a queue that sorts by report count lie.
    if (post.reports.some((r) => String(r.reporter) === String(req.viewer._id))) {
        res.status(409).json({ error: 'You have already reported this post.' });
        return;
    }
    post.reports.push({ reporter: req.viewer._id, reason });
    await post.save();
    res.status(201).json({ id: String(post._id), reportCount: post.reports.length });
});

export default router;

