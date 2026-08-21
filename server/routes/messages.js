import { Router } from 'express';
import { Message } from '../models/message.js';
import { Friend } from '../models/friend.js';
import { User } from '../models/user.js';
import { pageParams, rateLimit, requireViewer } from '../lib.js';

// Direct messages only, which is what the brief's routes describe. Space chat
// has a schema and no endpoint yet on purpose: a room needs a socket to be worth
// anything, and SOCIAL_ARCHITECTURE puts the WebSocket layer after this one.

const router = Router();
const CARD = 'handle displayName avatar';

/** The row describing these two, in whichever direction it was written. */
function pairRow(a, b) {
    return Friend.findOne({
        $or: [{ requester: a, recipient: b }, { requester: b, recipient: a }],
    });
}

/** Resolve :friendHandle and check the two of you may talk at all. */
async function openConversation(req, res) {
    const handle = String(req.params.friendHandle || '').toLowerCase();
    const them = await User.findOne({ handle });
    if (!them) {
        res.status(404).json({ error: 'No profile with that handle.' });
        return null;
    }
    // Mutual acceptance, per the blueprint: a pending request is not a channel.
    const row = await pairRow(req.viewer._id, them._id);
    if (!row || row.status !== 'accepted') {
        res.status(403).json({ error: 'Direct messages need an accepted friend request.' });
        return null;
    }
    return them;
}

/** GET /api/messages/:friendHandle?page=1&limit=30 */
router.get('/:friendHandle', requireViewer, async (req, res) => {
    const them = await openConversation(req, res);
    if (!them) return;
    const { page, limit, skip } = pageParams(req.query, 30, 30);
    const me = req.viewer._id;
    const q = {
        $or: [
            { sender: me, recipient: them._id },
            { sender: them._id, recipient: me },
        ],
    };
    const [rows, total] = await Promise.all([
        Message.find(q).sort({ createdAt: -1 }).skip(skip).limit(limit).populate('sender', CARD),
        Message.countDocuments(q),
    ]);

    // Reading a page marks the half of it addressed to you as read. Scoped to
    // this conversation, not everything unread.
    await Message.updateMany({ sender: them._id, recipient: me, isRead: false }, { $set: { isRead: true } });

    res.json({
        // Newest-first for the page window, then reversed so one page reads
        // downward in time like a conversation.
        messages: rows.reverse().map((m) => m.toWire()),
        with: { handle: them.handle, displayName: them.displayName, avatar: them.avatar },
        page,
        limit,
        total,
        hasMore: skip + rows.length < total,
    });
});

/** POST /api/messages/:friendHandle  { content } */
router.post('/:friendHandle', rateLimit('dm:send', 60_000, 30), requireViewer, async (req, res) => {
    const them = await openConversation(req, res);
    if (!them) return;
    if (!them.privacy.allowDMs) {
        res.status(403).json({ error: 'That profile has direct messages turned off.' });
        return;
    }
    const content = String((req.body || {}).content == null ? '' : req.body.content).trim();
    if (!content) {
        res.status(400).json({ error: 'A message needs something in it.' });
        return;
    }
    try {
        const doc = await Message.create({ sender: req.viewer._id, recipient: them._id, content });
        await doc.populate('sender', CARD);
        res.status(201).json({ message: doc.toWire() });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

export default router;
