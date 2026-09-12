// Server-side reads for the SSR pages. These deliberately reuse the same
// Mongoose models as the API routes so a rendered page and an API response can
// never drift into two different shapes.

import { Friend } from '../models/friend.js';
import { Message } from '../models/message.js';
import { Post } from '../models/post.js';
import { Space } from '../models/space.js';
import { User } from '../models/user.js';

const CARD = 'handle displayName avatar';
const AUTHOR = 'handle displayName avatar';
const PAGE = 20;

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
