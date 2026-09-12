#!/usr/bin/env python3
"""Publish staged FindFlower contributions to the public dataset repository.

This is the second half of the contribution pipeline. The server stages what it
was sent; this job is what decides it is safe to publish. It runs wherever you
have the database credentials and a Hugging Face token, NOT inside the web
process -- the container has 3GB and the EVA-02 export wants most of it, so
image work does not belong on the request path.

    MONGO_URI=... HF_TOKEN=... python server/scripts/sync_contributions_to_hf.py \
        --repo gsor56/findflower-community --limit 500

What it does, per staged row, oldest first:

  1. Decodes the data URL and checks the bytes are really a JPEG/PNG/WebP.
  2. Recomputes sha256 and skips a row whose image is already published.
  3. Re-encodes to a 448x448 JPEG (the patch-14 geometry the backbone wants).
  4. Uploads under contributions/<taxon-slug>/<hash>.jpg in one commit per run.
  5. Marks the row synced, or leaves it staged and logs the reason.

Every step is idempotent: a run that dies half way leaves rows staged, and the
next run picks them up because the destination path is derived from the content
hash rather than from a counter.
"""

import argparse
import base64
import hashlib
import io
import os
import re
import sys
from datetime import datetime, timezone

try:
    import pymongo
except ImportError:  # pragma: no cover - dependency message, not logic
    sys.exit("pymongo is required: pip install pymongo")

try:
    from PIL import Image, UnidentifiedImageError
except ImportError:  # pragma: no cover
    sys.exit("Pillow is required: pip install Pillow")

try:
    from huggingface_hub import HfApi
except ImportError:  # pragma: no cover
    sys.exit("huggingface_hub is required: pip install huggingface_hub")


TARGET_SIDE = 448  # divisible by 14: eva02_large_patch14 clips at this size
MAX_ROWS = 5000
DATA_URL = re.compile(r"^data:(image/[a-zA-Z+]+);base64,(.+)$", re.S)


def slug(value: str) -> str:
    """A filesystem- and URL-safe folder name for one taxon."""
    text = (value or "unidentified").strip().lower()
    text = re.sub(r"[^a-z0-9]+", "-", text).strip("-")
    return text[:80] or "unidentified"


def decode(row):
    """The image bytes from a staged row, or a reason it cannot be used."""
    raw = row.get("image") or ""
    match = DATA_URL.match(raw.strip())
    if not match:
        return None, "image is not a base64 data URL"
    try:
        blob = base64.b64decode(match.group(2), validate=False)
    except Exception:
        return None, "image did not decode"
    if len(blob) < 512:
        return None, "image is too small"
    return blob, None


def normalise(blob):
    """Re-encode to a square-ish 448px JPEG, preserving aspect ratio.

    The backbone resizes internally, so this is about storage and consistency
    rather than correctness: one geometry for the whole published set.
    """
    try:
        with Image.open(io.BytesIO(blob)) as img:
            if img.mode != "RGB":
                img = img.convert("RGB")
            img.thumbnail((TARGET_SIDE, TARGET_SIDE), Image.LANCZOS)
            canvas = Image.new("RGB", (TARGET_SIDE, TARGET_SIDE), (255, 255, 255))
            offset = ((TARGET_SIDE - img.width) // 2, (TARGET_SIDE - img.height) // 2)
            canvas.paste(img, offset)
            out = io.BytesIO()
            canvas.save(out, format="JPEG", quality=88, optimize=True)
            return out.getvalue(), None
    except UnidentifiedImageError:
        return None, "not a readable image"
    except Exception as err:  # pragma: no cover - defensive
        return None, f"re-encode failed: {err}"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", default=os.environ.get("HF_CONTRIB_REPO", "gsor56/findflower-community"),
                        help="public Hugging Face dataset repository")
    parser.add_argument("--limit", type=int, default=500, help="rows to publish in this run")
    parser.add_argument("--prefix", default="contributions", help="folder inside the repository")
    parser.add_argument("--dry-run", action="store_true", help="report what would be published, upload nothing")
    args = parser.parse_args()

    uri = os.environ.get("MONGO_URI")
    if not uri:
        return print("MONGO_URI is not set.") or 2
    token = os.environ.get("HF_TOKEN") or os.environ.get("HUGGING_FACE_HUB_TOKEN")
    if not token and not args.dry_run:
        return print("HF_TOKEN is not set.") or 2

    limit = max(1, min(args.limit, MAX_ROWS))
    client = pymongo.MongoClient(uri, serverSelectionTimeoutMS=8000)
    coll = client.get_default_database()["ff_contributions"]
    api = HfApi(token=token) if token else None

    cursor = coll.find({"status": "staged"}).sort("createdAt", 1).limit(limit)
    uploaded, skipped, failed = 0, 0, 0
    seen_hashes = set()

    for row in cursor:
        blob, why = decode(row)
        if blob is None:
            skipped += 1
            print(f"[skip] {row.get('_id')}: {why}")
            continue

        digest = hashlib.sha256(blob).hexdigest()
        if digest in seen_hashes:
            skipped += 1
            continue
        seen_hashes.add(digest)

        jpeg, why = normalise(blob)
        if jpeg is None:
            skipped += 1
            print(f"[skip] {row.get('_id')}: {why}")
            continue

        taxon = (row.get("taxon") or {}).get("acceptedName") or "Unidentified flower"
        path = f"{args.prefix}/{slug(taxon)}/{digest[:16]}.jpg"

        if args.dry_run:
            uploaded += 1
            print(f"[dry]  {path}  ({len(jpeg)} bytes)")
            continue

        try:
            api.upload_file(
                path_or_fileobj=io.BytesIO(jpeg),
                path_in_repo=path,
                repo_id=args.repo,
                repo_type="dataset",
                commit_message=f"Add {taxon} from the community queue",
            )
        except Exception as err:
            failed += 1
            print(f"[fail] {row.get('_id')}: {err}")
            continue

        coll.update_one(
            {"_id": row["_id"]},
            {"$set": {"status": "synced", "syncedAt": datetime.now(timezone.utc), "hfPath": path}},
        )
        uploaded += 1
        print(f"[ok]   {path}")

    print(f"\nuploaded={uploaded} skipped={skipped} failed={failed} repo={args.repo}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
