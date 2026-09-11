# Find10K Dataset Federation

The federation pipeline has two bounded CPU workers. Run them after the Phase 3
API ingestion kernel finishes. A read-only audit may run while Phase 3 is live,
but Hub deletion and 448px replacement must not overlap with another writer.

## Architecture

1. `find10k_hf_slicer_auditor.py`
   - Loads the strict `botanical_classes.json` produced by Phase 1.
   - Revalidates explicit Plantae and angiosperm lineage evidence.
   - Scans `images/train/` through the paginated Hugging Face tree API.
   - Quarantines folders absent from the verified taxonomy.
   - Optionally deletes quarantined folders in bounded Hub commits.
   - Publishes `flower_audit.json` with exact counts, deficits, and excesses.

2. `find10k_deficit_topoff_448.py`
   - Reads `flower_audit.json` and processes deficit classes first.
   - Revalidates and resizes every existing image to 448x448 JPEG.
   - Uses iNaturalist first and GBIF as fallback only when a class remains short.
   - Enforces research-grade/open-license iNaturalist candidates.
   - Uses a disk-backed global MD5 and 256-bit dHash index.
   - Replaces a class only after exactly 300 images are staged.
   - Commits complete classes in bounded atomic batches with progress, records,
     and immutable dedup journals in the same Hub commit.

Upscaling an existing 224px image to 448px standardizes tensor dimensions but
does not create new botanical detail. Newly sourced images must have a minimum
448px side before normalization.

## Execution

Read-only audit:

```bash
python training/find10k_hf_slicer_auditor.py \
  --repo-id gsor56/findflower-find10k \
  --botanical-classes /kaggle/working/find10k/phase1/botanical_classes.json
```

Apply the reviewed purge after Phase 3 has stopped:

```bash
python training/find10k_hf_slicer_auditor.py \
  --repo-id gsor56/findflower-find10k \
  --botanical-classes /kaggle/working/find10k/phase1/botanical_classes.json \
  --apply-delete \
  --confirm-repo gsor56/findflower-find10k
```

Run the 448px migration and deficit top-off:

```bash
python training/find10k_deficit_topoff_448.py \
  --repo-id gsor56/findflower-find10k \
  --target-per-class 300 \
  --target-size 448 \
  --commit-files 1500
```

Authentication is read from `HF_TOKEN`, the attached `my-secrets` Kaggle
dataset, or Kaggle Secrets. Tokens are never written into source or reports.
