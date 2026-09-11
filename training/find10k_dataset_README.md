---
license: other
task_categories:
- image-classification
tags:
- botanical-identification
- flowering-plants
- inaturalist
- findflower
pretty_name: FindFlower Find10K Flowering Plants
---

# FindFlower Find10K Flowering Plants

FindFlower's curated flowering-plant image dataset for the Flora-Ultra
classification engine. The dataset is operated and maintained by **gsor56**.

Website: https://findflower.me/

## Scope

- Source taxonomy: iNaturalist 2021 10,000-label taxonomy.
- Included lineage: Plantae angiosperms, including monocots and eudicots.
- Current target: 3,969 verified flowering species.
- Per-class target: exactly 300 images after federation.
- Canonical image format: RGB JPEG, 448 x 448 pixels.
- Sources: iNaturalist and GBIF records with open licenses where available.

The source model has 10,000 labels, but this dataset intentionally excludes
animals, fungi, algae, mosses, ferns, conifers, and other non-flowering taxa.
This prevents non-botanical distractors in the flowering-plant engine.

## Curation and validation

Images pass minimum-resolution, exposure, and Laplacian sharpness gates. Exact
duplicates are removed with MD5 hashes. Near-duplicates are removed with a
256-bit perceptual dHash index. Observation metadata and deduplication journals
are retained under `pipeline/federation/` for reproducibility.

Classes are processed atomically. A class is published only when its complete
448 x 448 set is ready, and `pipeline/federation/progress.json` allows Kaggle
workers to resume after a session limit without reprocessing completed classes.

## Intended use

The dataset supports training and evaluation of Flora-Ultra, FindFlower's
server-side botanical classifier. It is intended for research and
identification assistance, not for medical, agricultural, or legal decisions.
See the live application at https://findflower.me/ and the project repository at
https://github.com/gsor56/findflower.

## Attribution and licensing

Each record retains source and attribution metadata where supplied by the
provider. Users must comply with the original license and attribution terms for
every image. Please report licensing or taxonomy issues through
https://findflower.me/contact.html.

## Maintainer

Maintained by `gsor56` for FindFlower: https://findflower.me/
