import { Router } from 'express';
import { Friend } from '../models/friend.js';
import { Message } from '../models/message.js';
import { requireViewer } from '../lib.js';

const router = Router();
const CARD = 'handle displayName avatar';

router.get('/count', requireViewer, async (req, res) => {
    const me = req.viewer._id;
    const [friends, messages] = await Promise.all([
        Friend.countDocuments({ recipient: me, status: 'pending' }),
        Message.countDocuments({ recipient: me, isRead: false }),
    ]);
    res.json({ unread: friends + messages, friendRequests: friends, directMessages: messages });
});

router.get('/', requireViewer, async (req, res) => {
    const me = req.viewer._id;
    const [requests, messages] = await Promise.all([
        Friend.find({ recipient: me, status: 'pending' }).populate('requester', CARD).sort({ createdAt: -1 }).limit(20),
        Message.find({ recipient: me, isRead: false }).populate('sender', CARD).sort({ createdAt: -1 }).limit(20),
    ]);
    const items = requests.map((r) => ({ id: 'friend:' + r._id, type: 'friend_request', createdAt: r.createdAt, user: r.requester }))
        .concat(messages.map((m) => ({ id: 'dm:' + m._id, type: 'direct_message', createdAt: m.createdAt, user: m.sender, snippet: m.content.slice(0, 120), href: '/chat.html?with=' + encodeURIComponent(m.sender.handle) })))
        .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    res.json({ items, unread: items.length });
});

export default router;
