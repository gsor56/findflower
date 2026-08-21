import { Router } from 'express';
import { Friend } from '../models/friend.js';
import { User } from '../models/user.js';
import { rateLimit, requireViewer } from '../lib.js';

const router = Router();
const CARD = 'handle displayName avatar';

/** GET /api/friends — accepted, and the two halves of pending kept apart:
 *  a request you have to answer is a different thing from one you are waiting on. */
router.get('/', requireViewer, async (req, res) => {
    const me = req.viewer._id;
    const rows = await Friend.find({ $or: [{ requester: me }, { recipient: me }] })
        .populate('requester', CARD)
        .populate('recipient', CARD)
        .sort({ updatedAt: -1 });

    const out = { friends: [], incoming: [], outgoing: [], blocked: [] };
    for (const r of rows) {
        const mine = String(r.requester._id) === String(me);
        const them = mine ? r.recipient : r.requester;
        const card = {
            handle: them.handle, displayName: them.displayName, avatar: them.avatar,
            since: r.updatedAt,
        };
        if (r.status === 'accepted') out.friends.push(card);
        else if (r.status === 'blocked') { if (mine) out.blocked.push(card); }
        else if (mine) out.outgoing.push(card);
        else out.incoming.push(card);
    }
    res.json(out);
});

/** POST /api/friends/request  { handle } */
router.post('/request', rateLimit('friend:request', 60 * 60_000, 30), requireViewer, async (req, res) => {
    const handle = String((req.body || {}).handle || '').toLowerCase().trim();
    const them = await User.findOne({ handle });
    if (!them) {
        res.status(404).json({ error: 'No profile with that handle.' });
        return;
    }
    if (String(them._id) === String(req.viewer._id)) {
        res.status(400).json({ error: 'You are already yourself.' });
        return;
    }
    // They may have asked first, in which case this is an acceptance rather
    // than a second request pointing the other way.
    const theirs = await Friend.findOne({ requester: them._id, recipient: req.viewer._id });
    if (theirs) {
        if (theirs.status === 'blocked') {
            res.status(403).json({ error: 'That profile is not accepting requests.' });
            return;
        }
        theirs.status = 'accepted';
        await theirs.save();
        res.json({ handle, status: 'accepted' });
        return;
    }
    try {
        const row = await Friend.create({ requester: req.viewer._id, recipient: them._id });
        res.status(201).json({ handle, status: row.status });
    } catch (err) {
        if (err.code === 11000) {
            res.status(409).json({ error: 'You have already asked.' });
            return;
        }
        res.status(400).json({ error: err.message });
    }
});

/** POST /api/friends/respond  { handle, action: accept | decline | block }
 *  Decline removes the row rather than storing a refusal: the point of a
 *  declined request is that it is gone, and they may ask again later. */
router.post('/respond', rateLimit('friend:respond', 60 * 60_000, 60), requireViewer, async (req, res) => {
    const body = req.body || {};
    const handle = String(body.handle || '').toLowerCase().trim();
    const action = String(body.action || '').toLowerCase();
    if (!['accept', 'decline', 'block'].includes(action)) {
        res.status(400).json({ error: 'action must be accept, decline or block.' });
        return;
    }
    const them = await User.findOne({ handle });
    if (!them) {
        res.status(404).json({ error: 'No profile with that handle.' });
        return;
    }
    const row = await Friend.findOne({ requester: them._id, recipient: req.viewer._id });
    if (!row) {
        res.status(404).json({ error: 'No request from that profile.' });
        return;
    }
    if (action === 'decline') {
        await row.deleteOne();
        res.json({ handle, status: 'none' });
        return;
    }
    row.status = action === 'accept' ? 'accepted' : 'blocked';
    await row.save();
    res.json({ handle, status: row.status });
});

export default router;
