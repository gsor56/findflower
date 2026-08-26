#!/usr/bin/env python3
"""Stream iNaturalist-2021 images into a bounded Find10K Hub dataset.

The archive is never downloaded to disk. ``requests`` exposes the response
body to ``tarfile`` in ``r|gz`` mode, while only the current normalized JPEG
batch is staged under ``/kaggle/working``. This worker is CPU/I/O-bound and is
intended for a Kaggle CPU session with internet enabled.

The input taxonomy/head artifacts are produced by ``find10k_phase1_taxonomy``:
``botanical_head_indices.json`` (local -> iNat21 global id) and
``botanical_classes.json`` (ordered class records). The archive's numeric class
directory is matched to the global id, never to a guessed alphabetical order.
"""

from __future__ import annotations

import argparse
import hashlib
import gzip
import io
import json
import os
import re
import shutil
import tarfile
import tempfile
import time
from collections import Counter, defaultdict
from pathlib import Path
from typing import BinaryIO

import requests
from PIL import Image, ImageOps

try:
    import cv2
except Exception:  # pragma: no cover - Kaggle image normally includes OpenCV
    cv2 = None


ARCHIVE_URL = "https://ml-inat-competition-datasets.s3.amazonaws.com/2021/train.tar.gz"
IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp", ".bmp"}
PROGRESS_PATH = "pipeline/find10k_ingestion_progress.json"
MAX_RETRIES = 5
CLASS_RE = re.compile(r"(?:^|/)(\d{1,6})(?:/|_|-)")


def read_json(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def class_records(path: Path) -> tuple[dict[int, str], list[dict]]:
    obj = read_json(path)
    rows = obj.get("classes", obj) if isinstance(obj, dict) else obj
    if not isinstance(rows, list):
        raise ValueError(f"expected a class list in {path}")
    records = []
    for index, row in enumerate(rows):
        if isinstance(row, dict):
            name = row.get("scientific") or row.get("scientific_name") or row.get("name")
            item = dict(row)
        else:
            name, item = str(row), {"name": str(row)}
        if not name:
            raise ValueError(f"class {index} has no scientific name")
        item["name"] = str(name)
        item["local_index"] = index
        records.append(item)
    return {index: str(row["name"]) for index, row in enumerate(records)}, records


def load_global_ids(path: Path) -> list[int]:
    obj = read_json(path)
    if isinstance(obj, dict):
        values = obj.get("indices") or obj.get("head_indices") or obj.get("global_ids")
    else:
        values = obj
    if not isinstance(values, list) or not values:
        raise ValueError(f"expected local-to-global id list in {path}")
    ids = [int(x) for x in values]
    if len(ids) != len(set(ids)):
        raise ValueError("botanical head indices contain duplicates")
    return ids


def safe_label(label: str) -> str:
    return re.sub(r"[^A-Za-z0-9._ -]+", "_", label).replace("/", "_").strip() or "unknown"


def md5_bytes(data: bytes) -> str:
    return hashlib.md5(data).hexdigest()


def dhash256(image: Image.Image) -> int:
    gray = ImageOps.exif_transpose(image).convert("L").resize((17, 16), Image.Resampling.BILINEAR)
    pixels = list(gray.getdata())
    value = 0
    for row in range(16):
        offset = row * 17
        for col in range(16):
            value = (value << 1) | int(pixels[offset + col] > pixels[offset + col + 1])
    return value


def hamming(left: int, right: int) -> int:
    return (left ^ right).bit_count()


def quality_and_normalize(data: bytes, min_side: int, blur_floor: float) -> tuple[bytes | None, dict]:
    try:
        with Image.open(io.BytesIO(data)) as raw:
            image = ImageOps.exif_transpose(raw).convert("RGB")
            width, height = image.size
            if min(width, height) < min_side:
                return None, {"reason": "small", "width": width, "height": height}
            sharpness = exposure = luminance = clipped = None
            if cv2 is not None:
                import numpy as np
                gray = cv2.cvtColor(np.asarray(image), cv2.COLOR_RGB2GRAY)
                sharpness = float(cv2.Laplacian(gray, cv2.CV_64F).var())
                histogram = cv2.calcHist([gray], [0], None, [32], [0, 256]).ravel()
                histogram /= max(1.0, float(histogram.sum()))
                exposure = float(histogram.var())
                luminance = float(gray.mean())
                clipped = float(((gray <= 3) | (gray >= 252)).mean())
                if sharpness <= blur_floor:
                    return None, {"reason": "blur", "sharpness": sharpness}
                if luminance < 18 or luminance > 238 or clipped > 0.45:
                    return None, {"reason": "exposure", "luminance": luminance, "clipped_fraction": clipped}
                if exposure < 1e-5:
                    return None, {"reason": "flat_exposure", "exposure_variance": exposure}
            # A fixed 224px output makes the downstream ImageFolder deterministic
            # and keeps Hub storage bounded. LANCZOS preserves botanical detail.
            image = ImageOps.fit(image, (224, 224), method=Image.Resampling.LANCZOS)
            buffer = io.BytesIO()
            image.save(buffer, format="JPEG", quality=95, optimize=True)
            return buffer.getvalue(), {
                "width": width, "height": height, "sharpness": sharpness,
                "exposure_variance": exposure, "luminance": luminance,
                "clipped_fraction": clipped,
            }
    except Exception as exc:
        return None, {"reason": f"decode:{type(exc).__name__}"}


class Deduplicator:
    """Exact MD5 plus 256-bit dHash with a locality-sensitive band index."""

    def __init__(self, threshold: int = 8):
        self.threshold = threshold
        self.md5s: set[str] = set()
        self.hashes: list[int] = []
        self.bands: list[dict[int, list[int]]] = [defaultdict(list) for _ in range(8)]

    def seen(self, digest: str, perceptual: int) -> bool:
        if digest in self.md5s:
            return True
        # Compare only hashes sharing at least one 32-bit band. This avoids an
        # O(N^2) scan while catching the usual re-encoded/cropped duplicates.
        candidates: set[int] = set()
        for band in range(8):
            key = (perceptual >> (band * 32)) & 0xFFFFFFFF
            candidates.update(self.bands[band].get(key, ()))
        if any(hamming(perceptual, self.hashes[index]) <= self.threshold for index in candidates):
            return True
        index = len(self.hashes)
        self.md5s.add(digest)
        self.hashes.append(perceptual)
        for band in range(8):
            key = (perceptual >> (band * 32)) & 0xFFFFFFFF
            self.bands[band][key].append(index)
        return False


def token() -> str:
    value = (os.environ.get("HF_TOKEN") or "").strip()
    if value:
        return value
    for path in ("/kaggle/input/my-secrets/credential.txt", "/kaggle/input/my_secrets/credential.txt"):
        try:
            value = Path(path).read_text(encoding="utf-8").strip()
            if value:
                return value
        except OSError:
            pass
    try:
        from kaggle_secrets import UserSecretsClient
        return (UserSecretsClient().get_secret("HF_TOKEN") or "").strip()
    except Exception:
        return ""


def hub_progress(api, repo_id: str, hf_token: str) -> dict:
    from huggingface_hub import hf_hub_download
    try:
        path = hf_hub_download(repo_id, PROGRESS_PATH, repo_type="dataset", token=hf_token, force_download=True)
        data = read_json(Path(path))
        data["counts"] = {str(k): int(v) for k, v in (data.get("counts") or {}).items()}
        return data
    except Exception:
        return {"version": 1, "counts": {}, "commits": [], "accepted": 0}


def restore_dedup(api, repo_id: str, hf_token: str, progress: dict, dedup: Deduplicator) -> None:
    """Restore immutable per-batch hash journals without downloading images."""
    from huggingface_hub import hf_hub_download
    journals = list(progress.get("dedup_journals", []))
    for number, path_in_repo in enumerate(journals, 1):
        local = hf_hub_download(repo_id, path_in_repo, repo_type="dataset", token=hf_token)
        with gzip.open(local, "rt", encoding="utf-8") as handle:
            for line in handle:
                row = json.loads(line)
                digest, perceptual = str(row["md5"]), int(row["dhash256"])
                if digest in dedup.md5s:
                    continue
                index = len(dedup.hashes)
                dedup.md5s.add(digest)
                dedup.hashes.append(perceptual)
                for band in range(8):
                    key = (perceptual >> (band * 32)) & 0xFFFFFFFF
                    dedup.bands[band][key].append(index)
        if number % 20 == 0 or number == len(journals):
            print(f"[resume] restored dedup journal {number}/{len(journals)}", flush=True)


def upload_dedup_journal(api, repo_id: str, rows: list[dict], batch_index: int, output: Path) -> str:
    relative = f"pipeline/dedup/batch-{batch_index:06d}.jsonl.gz"
    local = output / f"dedup-{batch_index:06d}.jsonl.gz"
    with gzip.open(local, "wt", encoding="utf-8", compresslevel=6) as handle:
        for row in rows:
            handle.write(json.dumps(row, separators=(",", ":")) + "\n")
    api.upload_file(
        repo_id=repo_id, repo_type="dataset", path_or_fileobj=str(local),
        path_in_repo=relative, commit_message=f"dedup: immutable hash journal {batch_index:06d}",
    )
    local.unlink(missing_ok=True)
    return relative


def commit_progress(api, repo_id: str, progress: dict, output: Path) -> None:
    progress["updated_at_unix"] = int(time.time())
    path = output / "find10k_ingestion_progress.json"
    path.write_text(json.dumps(progress, indent=2, sort_keys=True), encoding="utf-8")
    api.upload_file(
        repo_id=repo_id, repo_type="dataset", path_or_fileobj=str(path),
        path_in_repo=PROGRESS_PATH, commit_message="progress: Find10K streaming ingestion checkpoint",
    )


def upload_batch(api, repo_id: str, batch_root: Path, label: str) -> None:
    for attempt in range(1, MAX_RETRIES + 1):
        try:
            api.upload_folder(
                repo_id=repo_id, repo_type="dataset", folder_path=str(batch_root),
                path_in_repo="images", commit_message=f"images: Find10K {label}",
            )
            return
        except Exception:
            if attempt == MAX_RETRIES:
                raise
            time.sleep(20 * attempt)


def source_class(member_name: str) -> int | None:
    match = CLASS_RE.search(member_name.replace("\\", "/"))
    return int(match.group(1)) if match else None


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--head-indices", required=True, type=Path)
    ap.add_argument("--botanical-classes", required=True, type=Path)
    ap.add_argument("--dataset-repo", default=os.environ.get("HF_DATASET_REPO", "gsor56/findflower-find10k"))
    ap.add_argument("--archive-url", default=os.environ.get("INAT_TRAIN_URL", ARCHIVE_URL))
    ap.add_argument("--output", type=Path, default=Path("/kaggle/working/find10k-ingestion"))
    ap.add_argument("--images-per-class", type=int, default=300)
    ap.add_argument("--commit-files", type=int, default=4000)
    ap.add_argument("--min-side", type=int, default=224)
    ap.add_argument("--blur-floor", type=float, default=40.0)
    ap.add_argument("--dhash-threshold", type=int, default=8)
    args = ap.parse_args()

    if args.images_per_class <= 0 or args.commit_files <= 0:
        raise SystemExit("images-per-class and commit-files must be positive")
    ids = load_global_ids(args.head_indices)
    names, records = class_records(args.botanical_classes)
    if len(ids) != len(records):
        raise SystemExit(f"head index count {len(ids)} does not match class count {len(records)}")
    global_to_local = {global_id: local for local, global_id in enumerate(ids)}
    labels = {global_id: safe_label(names[local]) for global_id, local in global_to_local.items()}
    hf_token = token()
    if not hf_token:
        raise SystemExit("[auth] HF_TOKEN unavailable")
    from huggingface_hub import HfApi
    api = HfApi(token=hf_token)
    api.create_repo(args.dataset_repo, repo_type="dataset", private=False, exist_ok=True)
    progress = hub_progress(api, args.dataset_repo, hf_token)
    counts = Counter({int(k): int(v) for k, v in progress.get("counts", {}).items()})
    committed_processed = Counter({int(k): int(v) for k, v in progress.get("processed", {}).items()})
    # ``processed`` is a stream cursor, not merely an accepted-image count.
    # Count members seen in this fresh archive traversal so a restart skips the
    # exact prefix recorded by the previous checkpoint.
    session_processed = Counter()
    accepted = int(progress.get("accepted", 0))
    rejected = Counter(progress.get("rejected", {}))
    dedup = Deduplicator(args.dhash_threshold)
    restore_dedup(api, args.dataset_repo, hf_token, progress, dedup)
    args.output.mkdir(parents=True, exist_ok=True)
    records_path = args.output / "records.jsonl"
    records_file = records_path.open("a", encoding="utf-8")
    staged = 0
    batch_hashes: list[dict] = []
    start_time = time.time()

    def flush_batch() -> None:
        nonlocal staged, batch_hashes
        if not staged:
            return
        batch_root = args.output / "batch-images"
        batch_index = len(progress.get("commits", [])) + 1
        upload_batch(api, args.dataset_repo, batch_root, f"batch {batch_index:06d}; {accepted:,} accepted")
        journal = upload_dedup_journal(api, args.dataset_repo, batch_hashes, batch_index, args.output)
        shutil.rmtree(batch_root, ignore_errors=True)
        progress["counts"] = {str(k): int(v) for k, v in sorted(counts.items())}
        progress["accepted"] = accepted
        progress["rejected"] = dict(rejected)
        progress["commits"] = list(progress.get("commits", [])) + [accepted]
        progress["dedup_journals"] = list(progress.get("dedup_journals", [])) + [journal]
        progress["processed"] = {str(k): int(v) for k, v in sorted(session_processed.items())}
        commit_progress(api, args.dataset_repo, progress, args.output)
        staged = 0
        batch_hashes = []

    session = requests.Session()
    session.trust_env = False
    session.headers.update({"User-Agent": "FindFlower-Find10K/1.0"})
    print(f"[stream] opening {args.archive_url}", flush=True)
    with session.get(args.archive_url, stream=True, timeout=(30, 600)) as response:
        response.raise_for_status()
        response.raw.decode_content = True
        with tarfile.open(fileobj=response.raw, mode="r|gz") as archive:
            for member in archive:
                if not member.isfile() or Path(member.name).suffix.lower() not in IMAGE_EXTENSIONS:
                    continue
                global_id = source_class(member.name)
                local = global_to_local.get(global_id) if global_id is not None else None
                if local is None:
                    continue
                stream_seen = session_processed[global_id] + 1
                session_processed[global_id] = stream_seen
                if stream_seen <= committed_processed[global_id]:
                    continue
                if counts[global_id] >= args.images_per_class:
                    continue
                stream: BinaryIO | None = archive.extractfile(member)
                if stream is None:
                    rejected["missing_member_stream"] += 1
                    continue
                raw = stream.read()
                normalized, quality_info = quality_and_normalize(raw, args.min_side, args.blur_floor)
                if normalized is None:
                    rejected[quality_info.get("reason", "quality")] += 1
                    continue
                digest = md5_bytes(raw)
                with Image.open(io.BytesIO(normalized)) as normalized_image:
                    perceptual = dhash256(normalized_image)
                if dedup.seen(digest, perceptual):
                    rejected["duplicate"] += 1
                    continue
                label = labels[global_id]
                filename = f"{digest[:16]}_{Path(member.name).stem}.jpg"
                target = args.output / "batch-images" / "train" / label / filename
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(normalized)
                records_file.write(json.dumps({
                    "label": names[local], "local_index": local, "inat21_id": global_id,
                    "member": member.name, "md5": digest, "dhash256": str(perceptual),
                    "split": "train", "quality": quality_info,
                }, separators=(",", ":")) + "\n")
                records_file.flush()
                counts[global_id] += 1
                accepted += 1
                staged += 1
                batch_hashes.append({"md5": digest, "dhash256": str(perceptual)})
                if staged >= args.commit_files:
                    flush_batch()
                if accepted and accepted % 1000 == 0:
                    print(f"[stream] accepted={accepted:,} classes={sum(v >= args.images_per_class for v in counts.values()):,}/{len(ids):,}", flush=True)
                if len(counts) == len(ids) and all(counts[x] >= args.images_per_class for x in ids):
                    break
    records_file.close()
    flush_batch()
    # Persist an end-of-stream cursor even when the last portion accepted no
    # images, otherwise a sparse class would be rescanned on every continuation.
    progress["processed"] = {str(k): int(v) for k, v in sorted(session_processed.items())}
    progress["counts"] = {str(k): int(v) for k, v in sorted(counts.items())}
    progress["accepted"] = accepted
    progress["rejected"] = dict(rejected)
    commit_progress(api, args.dataset_repo, progress, args.output)
    short = {str(global_id): int(args.images_per_class - counts[global_id]) for global_id in ids if counts[global_id] < args.images_per_class}
    audit = {
        "archive_url": args.archive_url, "target_classes": len(ids),
        "images_per_class": args.images_per_class, "accepted_images": accepted,
        "complete_classes": sum(v >= args.images_per_class for v in counts.values()),
        "short_classes": short, "rejected": dict(rejected),
        "elapsed_seconds": round(time.time() - start_time, 2),
        "status": "complete" if not short else "partial",
    }
    audit_path = args.output / "ingestion_audit.json"
    audit_path.write_text(json.dumps(audit, indent=2), encoding="utf-8")
    api.upload_file(repo_id=args.dataset_repo, repo_type="dataset", path_or_fileobj=str(audit_path), path_in_repo="ingestion_audit.json", commit_message="metadata: Find10K ingestion audit")
    print(json.dumps(audit, indent=2))
    return 0 if not short else 2


if __name__ == "__main__":
    raise SystemExit(main())
