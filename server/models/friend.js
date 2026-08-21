// ff_friends -- one row per direction, the way storage.js writes it.
//
// The local store keys rows "<owner>|<other>" and writes both directions to
// describe a mutual friendship, which is what lets a request sit half-answered.
// The same shape survives here as a unique compound index on the ordered pair,
// so a request is one row and accepting it flips that row's status.

import { Schema, model } from 'mongoose';

const friendSchema = new Schema({
    requester: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    recipient: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    status: {
        type: String, required: true, default: 'pending',
        enum: ['pending', 'accepted', 'blocked'],
    },
}, { timestamps: true });

// One row per ordered pair: a second request from the same person to the same
// person is a duplicate, not a second relationship.
friendSchema.index({ requester: 1, recipient: 1 }, { unique: true });
// "Who is waiting on me" and "who have I got", both indexed.
friendSchema.index({ recipient: 1, status: 1 });
friendSchema.index({ requester: 1, status: 1 });

// Mongoose 9 middleware is promise-based: a hook signals a problem by throwing,
// and there is no next() to call.
friendSchema.pre('validate', function noSelfFriend() {
    if (this.requester && this.recipient && String(this.requester) === String(this.recipient)) {
        throw new Error('A friend row cannot name the same account twice.');
    }
});

export const Friend = model('Friend', friendSchema, 'ff_friends');
