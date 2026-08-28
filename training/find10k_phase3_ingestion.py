#!/usr/bin/env python3
"""Curate Find10K images through the paginated iNaturalist Node API.

Taxa are processed sequentially, and only the current normalized JPEG batch is
staged under ``/kaggle/working``. Every accepted sample comes from a distinct
research-grade observation with an open photo license. Hub progress, API page
cursors, resolved iNaturalist taxon IDs, and immutable dedup journals make the
CPU worker resumable across Kaggle sessions and transient network failures.
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
import time
from collections import Counter, defaultdict
from pathlib import Path

import requests
from PIL import Image, ImageOps
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

try:
    import cv2
except Exception:  # pragma: no cover - Kaggle image normally includes OpenCV
    cv2 = None


INAT_API_URL = "https://api.inaturalist.org/v1/observations"
INAT_TAXA_URL = "https://api.inaturalist.org/v1/taxa"
PROGRESS_PATH = "pipeline/find10k_ingestion_progress.json"
MAX_RETRIES = 7
HUB_RETRIES = 7
RETRYABLE_STATUS = (429, 500, 502, 503, 504)
ALLOWED_LICENSES = {"cc0", "cc-by", "cc-by-nc"}
MAX_IMAGE_BYTES = 25 * 1024 * 1024


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
    from huggingface_hub.errors import EntryNotFoundError
    for attempt in range(1, HUB_RETRIES + 1):
        try:
            path = hf_hub_download(repo_id, PROGRESS_PATH, repo_type="dataset", token=hf_token, force_download=True)
            data = read_json(Path(path))
            data["counts"] = {str(k): int(v) for k, v in (data.get("counts") or {}).items()}
            return data
        except EntryNotFoundError:
            # A newly-created repository has no checkpoint yet. This is the
            # only case where an empty state is safe.
            return {"version": 1, "counts": {}, "commits": [], "accepted": 0}
        except Exception as exc:
            if attempt == HUB_RETRIES:
                raise RuntimeError(f"unable to read Hub progress after {HUB_RETRIES} attempts") from exc
            time.sleep(min(60, 5 * attempt))
    raise AssertionError("unreachable")


def restore_dedup(api, repo_id: str, hf_token: str, progress: dict, dedup: Deduplicator) -> None:
    """Restore immutable per-batch hash journals without downloading images."""
    from huggingface_hub import hf_hub_download
    journals = list(progress.get("dedup_journals", []))
    for number, path_in_repo in enumerate(journals, 1):
        for attempt in range(1, HUB_RETRIES + 1):
            try:
                local = hf_hub_download(repo_id, path_in_repo, repo_type="dataset", token=hf_token)
                break
            except Exception as exc:
                if attempt == HUB_RETRIES:
                    raise RuntimeError(f"unable to restore dedup journal {path_in_repo}") from exc
                time.sleep(min(60, 5 * attempt))
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


def stage_dedup_journal(rows: list[dict], batch_index: int, batch_root: Path) -> str:
    relative = f"pipeline/dedup/batch-{batch_index:06d}.jsonl.gz"
    local = batch_root / relative
    local.parent.mkdir(parents=True, exist_ok=True)
    with gzip.open(local, "wt", encoding="utf-8", compresslevel=6) as handle:
        for row in rows:
            handle.write(json.dumps(row, separators=(",", ":")) + "\n")
    return relative


def stage_progress(progress: dict, batch_root: Path) -> None:
    progress["updated_at_unix"] = int(time.time())
    path = batch_root / PROGRESS_PATH
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(progress, indent=2, sort_keys=True), encoding="utf-8")


def commit_progress(api, repo_id: str, progress: dict, output: Path) -> None:
    progress["updated_at_unix"] = int(time.time())
    path = output / "find10k_ingestion_progress.json"
    path.write_text(json.dumps(progress, indent=2, sort_keys=True), encoding="utf-8")
    for attempt in range(1, HUB_RETRIES + 1):
        try:
            api.upload_file(
                repo_id=repo_id, repo_type="dataset", path_or_fileobj=str(path),
                path_in_repo=PROGRESS_PATH, commit_message="progress: Find10K API ingestion checkpoint",
            )
            return
        except Exception as exc:
            if attempt == HUB_RETRIES:
                raise RuntimeError("unable to upload Hub progress checkpoint") from exc
            time.sleep(min(60, 5 * attempt))


def upload_batch(api, repo_id: str, batch_root: Path, label: str) -> None:
    for attempt in range(1, MAX_RETRIES + 1):
        try:
            api.upload_folder(
                repo_id=repo_id, repo_type="dataset", folder_path=str(batch_root),
                path_in_repo=None, commit_message=f"images: Find10K {label}",
            )
            return
        except Exception:
            if attempt == MAX_RETRIES:
                raise
            time.sleep(20 * attempt)


def build_session() -> requests.Session:
    retry = Retry(
        total=3,
        connect=3,
        read=3,
        status=3,
        backoff_factor=1.0,
        status_forcelist=RETRYABLE_STATUS,
        allowed_methods=frozenset({"GET"}),
        respect_retry_after_header=True,
        raise_on_status=False,
    )
    adapter = HTTPAdapter(max_retries=retry, pool_connections=8, pool_maxsize=8)
    session = requests.Session()
    session.trust_env = False
    session.headers.update({"User-Agent": "FindFlower-Find10K/2.0 (dataset curation)"})
    session.mount("https://", adapter)
    session.mount("http://", adapter)
    return session


def backoff(attempt: int, cap: int = 120) -> None:
    time.sleep(min(cap, 2 ** attempt))


def retryable_request_error(exc: requests.RequestException) -> bool:
    response = getattr(exc, "response", None)
    return response is None or response.status_code in RETRYABLE_STATUS


def get_json(session: requests.Session, url: str, params: dict) -> dict:
    last_error: Exception | None = None
    for attempt in range(1, MAX_RETRIES + 1):
        try:
            with session.get(url, params=params, timeout=(20, 90)) as response:
                response.raise_for_status()
                payload = response.json()
                if not isinstance(payload, dict):
                    raise ValueError(f"unexpected JSON response from {url}")
                return payload
        except requests.RequestException as exc:
            if not retryable_request_error(exc):
                raise
            last_error = exc
            if attempt == MAX_RETRIES:
                break
            print(
                f"[network] JSON request failed ({attempt}/{MAX_RETRIES}): "
                f"{type(exc).__name__}: {exc}",
                flush=True,
            )
            backoff(attempt)
        except ValueError as exc:
            last_error = exc
            if attempt == MAX_RETRIES:
                break
            backoff(attempt)
    raise RuntimeError(f"request failed after {MAX_RETRIES} attempts: {url}") from last_error


def explicit_taxon_id(record: dict, class_id: int) -> int | None:
    for key in ("inat_taxon_id", "taxon_id", "inaturalist_taxon_id", "iNaturalistTaxonId"):
        value = record.get(key)
        if value not in (None, ""):
            return int(value)
    nested = record.get("taxon")
    if isinstance(nested, dict) and nested.get("id") not in (None, ""):
        return int(nested["id"])
    # Official iNat21 category IDs are contiguous model-head indices, not Node
    # API taxon IDs. Only accept a bare record ID when it differs from that
    # class index; otherwise resolve the scientific name through /v1/taxa.
    value = record.get("id")
    if value not in (None, "") and int(value) != class_id:
        return int(value)
    return None


def resolve_taxon_id(session: requests.Session, record: dict, class_id: int) -> int:
    direct = explicit_taxon_id(record, class_id)
    if direct is not None:
        return direct
    scientific_name = str(record["name"])
    payload = get_json(session, INAT_TAXA_URL, {
        "q": scientific_name,
        "per_page": 30,
    })
    results = payload.get("results") or []
    exact = [
        row for row in results
        if scientific_name.casefold() in {
            str(row.get("name") or "").casefold(),
            str(row.get("matched_term") or "").casefold(),
        }
    ]
    if not exact:
        raise LookupError(f"no exact iNaturalist taxon match for {scientific_name!r}")
    return int(exact[0]["id"])


def api_observations(session: requests.Session, taxon_id: int, page: int, per_page: int) -> list[dict]:
    payload = get_json(session, INAT_API_URL, {
        "taxon_id": taxon_id,
        "quality_grade": "research",
        "photos": "true",
        "photo_license": ",".join(sorted(ALLOWED_LICENSES)),
        "per_page": min(200, max(1, per_page)),
        "page": page,
        "order_by": "id",
        "order": "desc",
    })
    results = payload.get("results") or []
    if not isinstance(results, list):
        raise ValueError("iNaturalist observations response has no result list")
    return results


def observation_matches_taxon(observation: dict, taxon_id: int) -> bool:
    taxon = observation.get("taxon") or {}
    observed_id = taxon.get("id")
    ancestors = taxon.get("ancestor_ids") or []
    return observed_id is not None and (int(observed_id) == taxon_id or taxon_id in {int(x) for x in ancestors})


def download_photo(session: requests.Session, url: str) -> bytes:
    last_error: Exception | None = None
    for attempt in range(1, MAX_RETRIES + 1):
        try:
            with session.get(url, stream=True, timeout=(20, 120)) as response:
                response.raise_for_status()
                content_length = int(response.headers.get("content-length") or 0)
                if content_length > MAX_IMAGE_BYTES:
                    raise OverflowError(f"image exceeds {MAX_IMAGE_BYTES} bytes")
                buffer = io.BytesIO()
                for chunk in response.iter_content(chunk_size=128 * 1024):
                    if not chunk:
                        continue
                    buffer.write(chunk)
                    if buffer.tell() > MAX_IMAGE_BYTES:
                        raise OverflowError(f"image exceeds {MAX_IMAGE_BYTES} bytes")
                return buffer.getvalue()
        except OverflowError:
            raise
        except requests.RequestException as exc:
            if not retryable_request_error(exc):
                raise
            last_error = exc
            if attempt == MAX_RETRIES:
                break
            backoff(attempt, cap=60)
    raise RuntimeError(f"image download failed after {MAX_RETRIES} attempts: {url}") from last_error


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--head-indices", required=True, type=Path)
    ap.add_argument("--botanical-classes", required=True, type=Path)
    ap.add_argument("--dataset-repo", default=os.environ.get("HF_DATASET_REPO", "gsor56/findflower-find10k"))
    ap.add_argument("--output", type=Path, default=Path("/kaggle/working/find10k-ingestion"))
    ap.add_argument("--images-per-class", type=int, default=300)
    # Two metadata files (progress + dedup journal) share each atomic commit,
    # keeping the total at the requested 4,000-file ceiling.
    ap.add_argument("--commit-files", type=int, default=3998)
    ap.add_argument("--min-side", type=int, default=224)
    ap.add_argument("--blur-floor", type=float, default=40.0)
    ap.add_argument("--dhash-threshold", type=int, default=8)
    ap.add_argument(
        "--max-runtime-seconds", type=int, default=30_000,
        help="curation budget; leaves roughly 100 minutes for final Hub uploads and Kaggle shutdown",
    )
    ap.add_argument("--api-max-pages", type=int, default=50)
    ap.add_argument("--api-page-size", type=int, default=200)
    args = ap.parse_args()

    if args.images_per_class <= 0 or args.commit_files <= 0 or args.api_page_size <= 0:
        raise SystemExit("images-per-class, commit-files, and api-page-size must be positive")
    class_ids = load_global_ids(args.head_indices)
    names, records = class_records(args.botanical_classes)
    if len(class_ids) != len(records):
        raise SystemExit(f"head index count {len(class_ids)} does not match class count {len(records)}")
    class_to_local = {class_id: local for local, class_id in enumerate(class_ids)}
    labels = {class_id: safe_label(names[local]) for class_id, local in class_to_local.items()}
    hf_token = token()
    if not hf_token:
        raise SystemExit("[auth] HF_TOKEN unavailable")
    from huggingface_hub import HfApi
    api = HfApi(token=hf_token)
    for attempt in range(1, HUB_RETRIES + 1):
        try:
            api.create_repo(args.dataset_repo, repo_type="dataset", private=False, exist_ok=True)
            break
        except Exception as exc:
            if attempt == HUB_RETRIES:
                raise RuntimeError("unable to access the Hub dataset repository") from exc
            time.sleep(min(60, 5 * attempt))
    progress = hub_progress(api, args.dataset_repo, hf_token)
    counts = Counter({int(k): int(v) for k, v in progress.get("counts", {}).items()})
    api_pages = Counter({int(k): int(v) for k, v in progress.get("api_pages", {}).items()})
    api_taxon_ids = {int(k): int(v) for k, v in (progress.get("api_taxon_ids") or {}).items()}
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
        journal = stage_dedup_journal(batch_hashes, batch_index, batch_root)
        progress["counts"] = {str(k): int(v) for k, v in sorted(counts.items())}
        progress["accepted"] = accepted
        progress["rejected"] = dict(rejected)
        progress["commits"] = list(progress.get("commits", [])) + [accepted]
        progress["dedup_journals"] = list(progress.get("dedup_journals", [])) + [journal]
        progress["api_pages"] = {str(k): int(v) for k, v in sorted(api_pages.items())}
        progress["api_taxon_ids"] = {str(k): int(v) for k, v in sorted(api_taxon_ids.items())}
        stage_progress(progress, batch_root)
        upload_batch(api, args.dataset_repo, batch_root, f"batch {batch_index:06d}; {accepted:,} accepted")
        shutil.rmtree(batch_root)
        staged = 0
        batch_hashes = []

    session = build_session()
    deadline = start_time + max(600, args.max_runtime_seconds)
    timed_out = False
    for class_id in class_ids:
        if counts[class_id] >= args.images_per_class:
            continue
        local = class_to_local[class_id]
        scientific_name = names[local]
        try:
            taxon_id = api_taxon_ids.get(class_id) or resolve_taxon_id(session, records[local], class_id)
            api_taxon_ids[class_id] = taxon_id
        except Exception as exc:
            rejected["taxon_resolution"] += 1
            print(
                f"[api] taxon unresolved class={class_id} name={scientific_name}: "
                f"{type(exc).__name__}: {exc}",
                flush=True,
            )
            continue

        page = api_pages[class_id] + 1
        while counts[class_id] < args.images_per_class and page <= args.api_max_pages:
            if time.time() >= deadline:
                timed_out = True
                break
            try:
                observations = api_observations(session, taxon_id, page, args.api_page_size)
            except Exception as exc:
                rejected["api_page_error"] += 1
                print(
                    f"[api] page deferred class={class_id} taxon={taxon_id} page={page}: "
                    f"{type(exc).__name__}: {exc}",
                    flush=True,
                )
                break
            if not observations:
                api_pages[class_id] = page
                break

            for observation in observations:
                if counts[class_id] >= args.images_per_class:
                    break
                if not observation_matches_taxon(observation, taxon_id):
                    rejected["taxon_mismatch"] += 1
                    continue
                observation_id = observation.get("id")
                accepted_from_observation = False
                for photo in observation.get("photos") or []:
                    license_code = str(photo.get("license_code") or "").lower()
                    if license_code not in ALLOWED_LICENSES:
                        rejected["license"] += 1
                        continue
                    photo_url = str(photo.get("url") or "")
                    if not photo_url:
                        rejected["missing_photo_url"] += 1
                        continue
                    photo_url = photo_url.replace("/square.", "/large.")
                    try:
                        raw = download_photo(session, photo_url)
                    except Exception as exc:
                        rejected["photo_download"] += 1
                        print(
                            f"[image] skipped observation={observation_id}: "
                            f"{type(exc).__name__}: {exc}",
                            flush=True,
                        )
                        continue
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

                    photo_id = photo.get("id") or digest[:16]
                    filename = f"inat-{observation_id}-{photo_id}.jpg"
                    target = args.output / "batch-images" / "images" / "train" / labels[class_id] / filename
                    target.parent.mkdir(parents=True, exist_ok=True)
                    target.write_bytes(normalized)
                    records_file.write(json.dumps({
                        "label": scientific_name,
                        "local_index": local,
                        "inat21_class_id": class_id,
                        "inat_taxon_id": taxon_id,
                        "observation_id": observation_id,
                        "photo_id": photo_id,
                        "source_url": photo_url,
                        "md5": digest,
                        "dhash256": str(perceptual),
                        "license": license_code,
                        "split": "train",
                        "quality": quality_info,
                    }, separators=(",", ":")) + "\n")
                    records_file.flush()
                    counts[class_id] += 1
                    accepted += 1
                    staged += 1
                    batch_hashes.append({"md5": digest, "dhash256": str(perceptual)})
                    accepted_from_observation = True
                    if staged >= args.commit_files:
                        flush_batch()
                    break
                if accepted_from_observation and counts[class_id] >= args.images_per_class:
                    break
            api_pages[class_id] = page
            page += 1
            time.sleep(0.25)

        print(
            f"[api] class={class_id} taxon={taxon_id} name={scientific_name} "
            f"count={counts[class_id]}/{args.images_per_class} "
            f"complete={sum(counts[x] >= args.images_per_class for x in class_ids):,}/{len(class_ids):,}",
            flush=True,
        )
        if timed_out:
            break

    records_file.close()
    flush_batch()
    session.close()
    progress["api_pages"] = {str(k): int(v) for k, v in sorted(api_pages.items())}
    progress["api_taxon_ids"] = {str(k): int(v) for k, v in sorted(api_taxon_ids.items())}
    progress["counts"] = {str(k): int(v) for k, v in sorted(counts.items())}
    progress["accepted"] = accepted
    progress["rejected"] = dict(rejected)
    commit_progress(api, args.dataset_repo, progress, args.output)
    short = {
        str(class_id): int(args.images_per_class - counts[class_id])
        for class_id in class_ids if counts[class_id] < args.images_per_class
    }
    audit = {
        "source": "inaturalist_node_api",
        "target_classes": len(class_ids),
        "images_per_class": args.images_per_class,
        "accepted_images": accepted,
        "complete_classes": sum(counts[x] >= args.images_per_class for x in class_ids),
        "resolved_taxa": len(api_taxon_ids),
        "short_classes": short,
        "rejected": dict(rejected),
        "elapsed_seconds": round(time.time() - start_time, 2),
        "status": "complete" if not short else ("checkpointed" if timed_out else "partial"),
    }
    audit_path = args.output / "ingestion_audit.json"
    audit_path.write_text(json.dumps(audit, indent=2), encoding="utf-8")
    for attempt in range(1, HUB_RETRIES + 1):
        try:
            api.upload_file(repo_id=args.dataset_repo, repo_type="dataset", path_or_fileobj=str(audit_path), path_in_repo="ingestion_audit.json", commit_message="metadata: Find10K API ingestion audit")
            break
        except Exception as exc:
            if attempt == HUB_RETRIES:
                raise RuntimeError("unable to upload API ingestion audit") from exc
            time.sleep(min(60, 5 * attempt))
    print(json.dumps(audit, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
