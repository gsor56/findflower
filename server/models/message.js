// ff_messages -- direct messages and space chat in one collection.
//
// The local store carries a single `channel` string and cannot tell a private
// message from a public one except by convention. Here the two cases are
// separate fields and exactly one of them is set: `recipient` for a DM, `space`
// for a room. The client's old `channel` maps to whichever of the two is
// present.
//
// This is the store storage.js has a reader for and no writer -- the local
// prototype could not invent a second participant. These routes are that writer.

import { Schema, model } from 'mongoose';

const MAX_CONTENT = 2000;

const messageSchema = new Schema({
    sender: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    recipient: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    space: { type: String, default: null, lowercase: true, trim: true, maxlength: 40 },
    content: { type: String, required: true, trim: true, maxlength: MAX_CONTENT },
    // Only meaningful on a DM. A space message has no single reader to have
    // read it, and the route never sets this on one.
    isRead: { type: Boolean, default: false },
}, { timestamps: { createdAt: true, updatedAt: false } });

// A DM read walks both directions of one pair, which is an $or of two equality
// prefixes; each branch gets its own index rather than sharing one that can
// only serve the first ordering.
messageSchema.index({ sender: 1, recipient: 1, createdAt: -1 });
messageSchema.index({ recipient: 1, sender: 1, createdAt: -1 });
messageSchema.index({ space: 1, createdAt: -1 });
// Unread badge counts, without scanning a conversation.
messageSchema.index({ recipient: 1, isRead: 1 });

messageSchema.pre('validate', function oneTargetOnly() {
    const dm = !!this.recipient;
    const room = !!this.space;
    if (dm === room) {
        throw new Error('A message needs exactly one of recipient (direct) or space (room).');
    }
});

messageSchema.methods.toWire = function toWire() {
    const s = this.sender && this.sender.handle ? this.sender : null;
    return {
        id: String(this._id),
        sender: s
            ? { id: String(s._id), handle: s.handle, displayName: s.displayName, avatar: s.avatar }
            : { id: String(this.sender), handle: null, displayName: null, avatar: null },
        recipient: this.recipient ? String(this.recipient) : null,
        space: this.space,
        content: this.content,
        isRead: this.isRead,
        createdAt: this.createdAt,
    };
};

export const Message = model('Message', messageSchema, 'ff_messages');
export { MAX_CONTENT };
