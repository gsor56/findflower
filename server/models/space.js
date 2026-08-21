// ff_spaces -- the sections a post can belong to.
//
// storage.js hard-codes four of these in its SPACES array, because the local
// prototype had nobody to negotiate a fifth with. Here they are rows, so a
// person can add one, and the four originals are seeded with isDefault so the
// community page can tell a built-in section from a user's own.

import { Schema, model } from 'mongoose';

const spaceSchema = new Schema({
    name: { type: String, required: true, unique: true, trim: true, maxlength: 40 },
    // What the API and the URL use: GET /api/posts?space=field-notes. The four
    // seeded slugs match storage.js SPACES ids exactly, so a post written by
    // the local prototype maps to a row here without a translation table.
    slug: {
        type: String, required: true, unique: true, lowercase: true, trim: true,
        maxlength: 40,
        match: [/^[a-z0-9-]+$/, 'A slug can hold only lowercase letters, numbers and hyphens.'],
    },
    description: { type: String, default: '', trim: true, maxlength: 160 },
    // Null for the four built-ins -- nobody created them.
    creator: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    isDefault: { type: Boolean, default: false },
}, { timestamps: true });

/** The four sections storage.js ships with, ids and blurbs copied from its
 *  SPACES array so the two halves agree. Idempotent: run it on every boot. */
export async function seedDefaultSpaces() {
    const defaults = [
        { slug: 'field-notes', name: 'Field notes', description: 'What you found, and where.' },
        { slug: 'id-help', name: 'Identification help', description: 'Ask what a plant is.' },
        { slug: 'corrections', name: 'Corrections', description: 'When the model got it wrong.' },
        { slug: 'engineering', name: 'Engineering', description: 'The site, the model, the data.' },
    ];
    let added = 0;
    for (const d of defaults) {
        const now = new Date();
        const res = await Space.updateOne(
            { slug: d.slug },
            { $setOnInsert: { ...d, isDefault: true, creator: null, createdAt: now, updatedAt: now } },
            // Mongoose would otherwise add `$set: { updatedAt }`, which applies to
            // the rows that already exist: every boot would rewrite all four.
            { upsert: true, timestamps: false },
        );
        if (res.upsertedCount) added += 1;
    }
    return added;
}

export const Space = model('Space', spaceSchema, 'ff_spaces');
