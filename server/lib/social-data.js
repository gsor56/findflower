// Server-side reads for the SSR pages. These deliberately reuse the same
// Mongoose models as the API routes so a rendered page and an API response can
// never drift into two different shapes.

import { Friend } from '../models/friend.js';
import { Message } from '../models/message.js';
import { Post } from '../models/post.js';
import { Scan, toClientScan } from '../models/scan.js';
import { Space } from '../models/space.js';
import { User } from '../models/user.js';

const CARD = 'handle displayName avatar';
const AUTHOR = 'handle displayName avatar';
const PAGE = 20;
// How many finds the dashboard's first paint carries. The client asks for the
// same six the card grid shows when it re-renders, so a page that paints from
// Mongo and a page that repaints from IndexedDB show the same thing.
const DASH_PAGE = 6;
/**
 * The dashboard's own data: this account's scans, read from MongoDB.
 *
 * This is the page the two-device bug showed up on. It used to render an empty
 * shell and let the browser paint it from IndexedDB, so a laptop that had never
 * scanned looked empty no matter how much was on the phone. Rendering the rows
 * here means the first paint is the account's real herbarium, and the client
 * sync that follows only ever adds to it.
 *
 * A signed-out visitor gets the shell and no rows, which is what the page's own
 * "your herbarium is empty" state says.
 */
export async function dashboardPayload(req) {
    if (!req.viewer) return { authenticated: false, scans: [], total: 0 };
    const rows = await Scan.find({ authSub: req.viewer.authSub })
        .sort({ scannedAt: -1 })
        .limit(DASH_PAGE)
        .lean({ virtuals: false });
    const total = await Scan.countDocuments({ authSub: req.viewer.authSub });
    return { authenticated: true, scans: rows.map(toClientScan), total, count: rows.length };
}

function iso(value) {
    return value instanceof Date ? value.toISOString() : value || null;
}

function publicCard(user) {
    if (!user || !user.handle) return null;
    return {
        id: String(user._id || user.id || ''),
        handle: user.handle,
        displayName: user.displayName || user.handle,
        avatar: user.avatar || null,
    };
}

function postRow(post, viewerId) {
    return { ...post.toFeed(viewerId), createdAt: iso(post.createdAt), updatedAt: iso(post.updatedAt) };
}

export async function communityPayload(req) {
    const viewerId = req.viewer ? req.viewer._id : null;
    const [posts, total, spaces, counts] = await Promise.all([
        Post.find({ isDeleted: false }).sort({ createdAt: -1 }).limit(PAGE).populate('author', AUTHOR),
        Post.countDocuments({ isDeleted: false }),
        Space.find({}).sort({ isDefault: -1, name: 1 }),
        Post.aggregate([
            { $match: { isDeleted: false } },
            { $group: { _id: '$space', n: { $sum: 1 } } },
        ]),
    ]);
    const bySlug = new Map(counts.map((row) => [row._id, row.n]));
    return {
        posts: posts.map((post) => postRow(post, viewerId)),
        total,
        hasMore: posts.length < total,
        spaces: spaces.map((space) => ({
            id: space.slug,
            label: space.name,
            blurb: space.description || '',
            posts: bySlug.get(space.slug) || 0,
        })),
    };
}

export async function notificationsPayload(req) {
    if (!req.viewer) {
        return { authenticated: false, items: [], unread: 0, friendRequests: 0, directMessages: 0 };
    }
    const me = req.viewer._id;
    const [requests, messages, friendCount, messageCount] = await Promise.all([
        Friend.find({ recipient: me, status: 'pending' }).populate('requester', CARD).sort({ createdAt: -1 }).limit(20),
        Message.find({ recipient: me, isRead: false }).populate('sender', CARD).sort({ createdAt: -1 }).limit(20),
        Friend.countDocuments({ recipient: me, status: 'pending' }),
        Message.countDocuments({ recipient: me, isRead: false }),
    ]);
    const items = requests
        .map((row) => ({
            id: 'friend:' + row._id,
            type: 'friend_request',
            createdAt: iso(row.createdAt),
            user: publicCard(row.requester),
        }))
        .concat(messages.map((row) => ({
            id: 'dm:' + row._id,
            type: 'direct_message',
            createdAt: iso(row.createdAt),
            user: publicCard(row.sender),
            snippet: String(row.content || '').slice(0, 120),
            href: '/chat?with=' + encodeURIComponent(row.sender && row.sender.handle ? row.sender.handle : ''),
        })))
        .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    return {
        authenticated: true,
        items,
        unread: items.length,
        friendRequests: friendCount,
        directMessages: messageCount,
    };
}

export async function chatPayload(req, handle) {
    const clean = String(handle || '').toLowerCase().trim();
    if (!req.viewer) return { authenticated: false, handle: clean, messages: [] };
    if (!clean) return { authenticated: true, handle: '', messages: [], missing: true };
    const them = await User.findOne({ handle: clean });
    if (!them) return { authenticated: true, handle: clean, messages: [], missing: true };

    const pair = await Friend.findOne({
        $or: [
            { requester: req.viewer._id, recipient: them._id },
            { requester: them._id, recipient: req.viewer._id },
        ],
    });
    if (!pair || pair.status !== 'accepted') {
        return { authenticated: true, handle: clean, with: publicCard(them), messages: [], forbidden: true };
    }

    const rows = await Message.find({
        $or: [
            { sender: req.viewer._id, recipient: them._id },
            { sender: them._id, recipient: req.viewer._id },
        ],
    }).sort({ createdAt: -1 }).limit(20).populate('sender', CARD);

    await Message.updateMany(
        { sender: them._id, recipient: req.viewer._id, isRead: false },
        { $set: { isRead: true } },
    );

    return {
        authenticated: true,
        handle: them.handle,
        with: publicCard(them),
        messages: rows.reverse().map((row) => ({
            ...row.toWire(),
            createdAt: iso(row.createdAt),
        })),
        hasMore: rows.length === 20,
    };
}
