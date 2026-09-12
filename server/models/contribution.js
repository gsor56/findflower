// ff_contributions -- the staging table for crowdsourced training images.
//
// A row here is a claim, not a fact: one photo, one species label, one
// contributor, and the verdict of whatever lightweight model looked at it
// before the upload was accepted. Nothing leaves this collection for the public
// dataset until the sync job flips `status` to 'synced'.
//
// The image lives in the row as a data URL because that is what the browser
// already holds -- contribute.html builds the training bundle in the page and
// has no upload path of its own. It is capped hard: the staging collection is a
// queue that drains, not an image store.

import { Schema, model } from 'mongoose';

// ~1.5MB of base64 is roughly a 1.1MB JPEG, which is far above what a training
// frame needs and far below what would make the queue expensive to hold.
const MAX_IMAGE_CHARS = 1_600_000;
const MAX_REASON_CHARS = 120;

const contributionSchema = new Schema({
    contributor: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    contributorHandle: { type: String, required: true, lowercase: true, trim: true },

    // What the contributor says it is. `taxonId` is the iNaturalist/GBIF id when
    // the client knew one, and is what the sync job uses to file the image.
    taxon: {
        id: { type: String, default: null, trim: true },
        acceptedName: { type: String, required: true, trim: true, maxlength: 120 },
        commonName: { type: String, default: null, trim: true, maxlength: 120 },
        genus: { type: String, default: null, trim: true, maxlength: 60 },
    },
    note: { type: String, default: '', trim: true, maxlength: 300 },

    image: { type: String, required: true, maxlength: MAX_IMAGE_CHARS },
    mime: { type: String, default: 'image/jpeg', trim: true, maxlength: 40 },
    // sha256 of the decoded bytes. Unique so the same photo cannot be staged
    // twice under two labels -- the cheapest duplicate gate we have, and the
    // one that matters for a training set.
    imageHash: { type: String, required: true, unique: true, index: true },
    bytes: { type: Number, default: 0, min: 0 },

    validation: {
        model: { type: String, default: 'lite-cnn', trim: true, maxlength: 60 },
        label: { type: String, default: null, trim: true, maxlength: 120 },
        confidence: { type: Number, default: 0, min: 0, max: 1 },
        // 'flower' | 'junk' | 'unknown'. Only 'flower' is staged; the route
        // answers 422 for the other two rather than storing a rejection pile.
        verdict: { type: String, default: 'unknown', enum: ['flower', 'junk', 'unknown'], index: true },
        reason: { type: String, default: null, trim: true, maxlength: MAX_REASON_CHARS },
    },

    status: { type: String, default: 'staged', enum: ['staged', 'synced', 'withdrawn'], index: true },
    syncedAt: { type: Date, default: null },
    hfPath: { type: String, default: null, trim: true },
}, { timestamps: true });

// The sync job walks staged rows oldest-first; the composite index is what keeps
// that a range scan instead of a collection scan as the queue grows.
contributionSchema.index({ status: 1, createdAt: 1 });

/** The shape the contributor's own page shows back to them. */
contributionSchema.methods.toPublic = function toPublic() {
    return {
        id: String(this._id),
        taxon: {
            id: this.taxon.id,
            acceptedName: this.taxon.acceptedName,
            commonName: this.taxon.commonName,
        },
        note: this.note,
        validation: {
            model: this.validation.model,
            label: this.validation.label,
            confidence: this.validation.confidence,
            verdict: this.validation.verdict,
        },
        status: this.status,
        createdAt: this.createdAt,
    };
};

export const Contribution = model('Contribution', contributionSchema, 'ff_contributions');
export { MAX_IMAGE_CHARS };
