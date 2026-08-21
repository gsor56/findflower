// ff_users -- the server-side half of the browser's ff_users store.
//
// storage.js keys its local rows on the Auth0 `sub`; this collection keys on a
// Mongo _id and carries the sub alongside, because the sub is the only value
// that can join a document here to the IndexedDB row for the same person.
//
// The local row holds { name, picture, avatar, isPublic, created }. This one is
// wider: a handle, a bio, a badge shelf and the two privacy flags. `picture`
// (the Auth0-hosted URL) is deliberately absent -- it belongs to the identity
// provider, changes without telling us, and the client already has it.

import { Schema, model } from 'mongoose';

// A 160px JPEG data URL from storage.js saveAvatar() runs about 8-12KB. The cap
// leaves room for an inline SVG fallback and refuses an unresized upload.
const MAX_AVATAR = 32768;

const userSchema = new Schema({
    authSub: { type: String, required: true, unique: true, trim: true },
    handle: {
        type: String, required: true, unique: true, lowercase: true, trim: true,
        minlength: 3, maxlength: 20,
        // Narrow on purpose: a handle sits in a URL path unescaped, and must
        // not be able to look like one of the app's own routes.
        match: [/^[a-z0-9_]+$/, 'A handle can hold only letters, numbers and underscores.'],
    },
    displayName: { type: String, required: true, trim: true, maxlength: 60 },
    bio: { type: String, default: '', trim: true, maxlength: 280 },
    avatar: { type: String, default: null, maxlength: MAX_AVATAR },
    // Badge ids as storage.js already computes them ("first-discovery",
    // "night-explorer", "archivist", ...). Not an enum: the catalogue lives in
    // storage.js BADGES, and a second copy here would drift the moment one
    // side gained a badge.
    badges: { type: [String], default: [] },
    stats: {
        scansCount: { type: Number, default: 0, min: 0 },
        helpfulCount: { type: Number, default: 0, min: 0 },
    },
    privacy: {
        // Kept from the local schema, which the brief's privacy pair does not
        // cover: profile.html already renders a "this card is private" state off
        // ff_users.isPublic, and dropping the field would quietly make every
        // hidden profile public again.
        isPublic: { type: Boolean, default: true },
        showHistory: { type: Boolean, default: true },
        allowDMs: { type: Boolean, default: true },
    },
}, { timestamps: true });

// Prefix search over handles, for the Botanists column of the search palette,
// runs on the index `unique: true` above already builds. The displayName half of
// that query has no index it can use, which is why the route caps it at ten rows.

/** The public shape. Everything the profile card and the feed need, and nothing
 *  else: authSub identifies an account and never leaves the server. */
userSchema.methods.toPublic = function toPublic() {
    return {
        id: String(this._id),
        handle: this.handle,
        displayName: this.displayName,
        bio: this.bio,
        avatar: this.avatar,
        badges: this.badges,
        stats: { scansCount: this.stats.scansCount, helpfulCount: this.stats.helpfulCount },
        privacy: {
            isPublic: this.privacy.isPublic,
            showHistory: this.privacy.showHistory,
            allowDMs: this.privacy.allowDMs,
        },
        createdAt: this.createdAt,
    };
};

export const User = model('User', userSchema, 'ff_users');
export { MAX_AVATAR };
