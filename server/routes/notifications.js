import { Router } from 'express';
import { Friend } from '../models/friend.js';
import { Message } from '../models/message.js';
import { requireViewer } from '../lib.js';

const router = Router();
const CARD = 'handle displayName avatar';

// Explicit, not implied. Express sets a charset on res.json on its own, but this
// route is the one that carries a person's display name and the first line of
// their message, and a JSON body that reaches the browser without a charset is
// decoded as latin-1 by anything that does not default to UTF-8 -- which is how
// an accented name or an ellipsis turns into `â€¦` on the page. The SSE route
// sets the same parameter for the same reason; both are written out so a
// proxy that guesses has nothing left to guess.
function sendJson(res, payload) {
    res.set('Content-Type', 'application/json; charset=utf-8').send(JSON.stringify(payload));
}

router.get('/count', requireViewer, async (req, res) => {
    const me = req.viewer._id;
    const [friends, messages] = await Promise.all([
        Friend.countDocuments({ recipient: me, status: 'pending' }),
        Message.countDocuments({ recipient: me, isRead: false }),
    ]);
    sendJson(res, { unread: friends + messages, friendRequests: friends, directMessages: messages });
});

router.get('/', requireViewer, async (req, res) => {
    const me = req.viewer._id;
    const [requests, messages] = await Promise.all([
        Friend.find({ recipient: me, status: 'pending' }).populate('requester', CARD).sort({ createdAt: -1 }).limit(20),
        Message.find({ recipient: me, isRead: false }).populate('sender', CARD).sort({ createdAt: -1 }).limit(20),
    ]);
    const items = requests.map((r) => ({ id: 'friend:' + r._id, type: 'friend_request', createdAt: r.createdAt, user: r.requester }))
        .concat(messages.map((m) => ({ id: 'dm:' + m._id, type: 'direct_message', createdAt: m.createdAt, user: m.sender, snippet: m.content.slice(0, 120), href: '/chat?with=' + encodeURIComponent(m.sender.handle) })))
        .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    // The rows are handed over as data, not as pre-escaped markup: the browser
    // writes them with textContent, so nothing here is HTML-escaped and nothing
    // arrives double-escaped.
    sendJson(res, { items, unread: items.length });
});

export default router;
