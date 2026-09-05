## Why the count started again

The collection before this one finished: 1,500 species, exactly 100 checked photographs each, 150,000 images, and how five notebooks split that between them with no coordinator is [the earlier post](/article?id=shards). The set being built now keeps almost none of those numbers. The vocabulary is 3,969 flowering species instead of 1,500, the target is 300 photographs for each of them instead of 100, and every image is stored at 448 pixels square instead of 224, because 448 is what the larger model reads.

That last change is the expensive one. A 224 pixel photograph stretched to 448 carries more pixels and no more detail, so nothing collected at the smaller size was carried over. Every one of those classes is being sourced again from the original observations. The full target is 1,190,700 photographs.

## Where it stands

1,747 species have a folder. 1,022 of them hold the full 300. 493,646 photographs have passed the checks, which leaves 697,054 still to find, and 2,222 species not started at all.

Those figures were read on 28 August 2026 and they move most days. The live version, read from the collector's own ledger, sits at the foot of [the contribute page](/contribute).

## Most rejections have nothing to do with the photograph

45,474 candidates have been thrown out. The breakdown is not the one you would guess from the outside:

- 33,838 because the observation behind the photograph did not resolve to the species whose folder it was fetched for
- 5,856 too blurred
- 3,380 under a licence the set cannot carry
- 1,417 duplicates of an image already kept
- 509 too small
- 469 badly exposed, and 2 with no variation in exposure at all
- 3 with a taxon that could not be resolved

The quality gates get all the attention, and between them they account for fewer than one rejection in six. What actually throws work away is identity: a photograph filed under a name that does not survive checking. Every one of those 33,838 was downloaded and decoded before it was discarded, which is bandwidth and time spent to learn that a record was wrong.

## Two counts of the same set, both right

The audit that walks the published repository reports 867 species sitting exactly on 300. The collector's own ledger counts 1,022 finished. Neither is wrong. 155 folders hold more than 300 photographs, 2,307 surplus images between them, left over from earlier passes at the same species. The audit calls a folder balanced only when it holds exactly the target, so those 155 count as finished by one measure and unbalanced by the other.

Nothing is deleted to make the two agree. A surplus photograph in a folder is not a defect, and removing images from the only copy of the set so that one figure matches another is the wrong trade. The gap is 0.3 percent of the images and it is written down rather than tidied away, which is the whole point of publishing the audit next to the data.

## The top off pass, and the bug it was designed around

The last collection had one real failure: images were uploaded, the progress file was written seconds later, and a session that died in that window left a folder full of images that no record knew about. The next worker started the class again from scratch.

This one inverts the order. A worker reads the audit, revalidates every image already in a class, fetches only the observations that are missing, deduplicates against everything kept so far by MD5 and by a 256 bit perceptual hash, and replaces the class in the repository only once exactly 300 images are ready. A commit therefore contains whole classes and nothing else. An interrupted class leaves its previous state in the repository untouched, so there is no half written folder for the next worker to interpret.

Sources changed too. The first pass drew from iNaturalist alone; this one falls back to GBIF for the species where iNaturalist does not have 300 usable observations to give.

## The tail is the whole problem

The 2,222 species with no folder are not 2,222 equal jobs. The target list is ordered by how often people photograph the plant, so what is left is the thin end: species with a few hundred observations in total, most of them a leaf, a herbarium sheet, or the same flower photographed six times. A class like that does not yield 300 images that pass, and no amount of patience changes the arithmetic.

That is the part where a photograph taken by hand is worth more than any amount of fetching. A good set of a rare flower fills a gap the pipeline cannot reach; a good set of common yarrow, which already has 335,840 observations behind it, does not.

The model this feeds has not been trained yet, and it will not be listed as available until a checkpoint passes its evaluation. The data comes first, which is the slow half.
