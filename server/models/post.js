// ff_posts -- community threads.
//
// The local store holds { userId, authorName, space, body, articleRef,
// timestamp }. Here `body` becomes `content`, `userId`/`authorName` collapse
// into one `author` reference, and likes, reports and a soft-delete flag are
// added -- none of which the single-browser prototype could express, since all
// three are one person acting on another person's row.
//
// `author` is a reference and nothing is copied out of it. Denormalising the
// handle and display name would be cheap, but the avatar is base64 and would be
// duplicated into every post that person ever wrote, so the read routes
// populate all three from ff_users instead and the API still answers with
// author.handle / author.displayName / author.avatar.

import { Schema, model } from 'mongoose';

// The same ceiling storage.js applies with POST_MAX_CHARS. Two different limits
// would mean a post that saves locally and then fails to sync.
const MAX_CONTENT = 2000;

const reportSchema = new Schema({
    reporter: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    reason: { type: String, required: true, trim: true, maxlength: 500 },
    timestamp: { type: Date, default: Date.now },
});

const postSchema = new Schema({
    author: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    // A slug from ff_spaces, not a display name.
    space: { type: String, required: true, lowercase: true, trim: true, maxlength: 40 },
    title: { type: String, default: null, trim: true, maxlength: 120 },
    content: { type: String, required: true, trim: true, maxlength: MAX_CONTENT },
    // Carried over from the local schema even though the brief does not list
    // it: article.html's "Discuss in Community" link is a shipped path, and a
    // post that arrived through it loses where it came from without this.
    articleRef: { type: String, default: null, trim: true, maxlength: 80 },
    likes: { type: [{ type: Schema.Types.ObjectId, ref: 'User' }], default: [] },
    reports: { type: [reportSchema], default: [] },
    // Soft delete. A thread other people replied to should not evaporate, and a
    // report needs the post it was filed against to still exist.
    isDeleted: { type: Boolean, default: false },
}, { timestamps: true });

// The feed, one space at a time and across all of them. isDeleted sits ahead of
// the sort key in both because every feed read filters on it.
postSchema.index({ space: 1, isDeleted: 1, createdAt: -1 });
postSchema.index({ isDeleted: 1, createdAt: -1 });
postSchema.index({ author: 1, isDeleted: 1, createdAt: -1 });

// Full-text search for the Posts column of the palette. Mongo allows one text
// index per collection, so title and content share this one.
postSchema.index({ title: 'text', content: 'text' });

postSchema.virtual('likeCount').get(function likeCount() {
    return this.likes.length;
});

/** The feed shape. `viewerId` decides one field: whether the like button on
 *  this row should be drawn as already pressed. Passing nothing is fine -- a
 *  signed-out reader gets likedByViewer: false rather than an error. */
postSchema.methods.toFeed = function toFeed(viewerId) {
    const a = this.author && this.author.handle ? this.author : null;
    return {
        id: String(this._id),
        author: a
            ? { id: String(a._id), handle: a.handle, displayName: a.displayName, avatar: a.avatar }
            : null,
        space: this.space,
        title: this.title,
        content: this.content,
        articleRef: this.articleRef,
        likeCount: this.likes.length,
        likedByViewer: viewerId ? this.likes.some((id) => String(id) === String(viewerId)) : false,
        reportCount: this.reports.length,
        createdAt: this.createdAt,
        updatedAt: this.updatedAt,
    };
};

export const Post = model('Post', postSchema, 'ff_posts');
export { MAX_CONTENT };
