#!/usr/bin/env python3
"""Top off and atomically migrate Find10K classes to 300 x 448px JPEGs.

This worker reads ``flower_audit.json``, revalidates only the class currently
being processed, adds missing observations from iNaturalist and GBIF, performs
MD5 plus 256-bit dHash deduplication, and replaces a class only after exactly
300 images are ready. Hub commits contain bounded groups of complete classes;
an interrupted or sparse class therefore leaves its previous repository state
untouched. The expensive recursive repository audit is intentionally deferred
to ``scripts/audit_find10k_full.py`` after federation completes.
"""

from __future__ import annotations

import os

# Enable the Rust-backed transfer path before Hugging Face Hub is imported.
os.environ["HF_HUB_ENABLE_HF_TRANSFER"] = "1"

import argparse
import gzip
import hashlib
import io
import json
import random
import re
import shutil
import sqlite3
import socket
import time
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable
from urllib.parse import quote, urljoin

import requests
from PIL import Image, ImageOps
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

try:
    import cv2
except Exception:  # pragma: no cover - Kaggle normally includes OpenCV
    cv2 = None

# Bound any library-level socket operation even when a caller forgets a
# request timeout. Requests still supplies its connect/read timeout explicitly.
socket.setdefaulttimeout(10)


INAT_TAXA_URL = "https://api.inaturalist.org/v1/taxa"
INAT_OBSERVATIONS_URL = "https://api.inaturalist.org/v1/observations"
GBIF_MATCH_URL = "https://api.gbif.org/v1/species/match"
GBIF_OCCURRENCES_URL = "https://api.gbif.org/v1/occurrence/search"
IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp", ".bmp", ".tif", ".tiff"}
OPEN_LICENSES = {"cc0", "cc-by", "cc-by-nc"}
RETRYABLE_STATUS = (429, 500, 502, 503, 504)
HTTP_TIMEOUT = (3, 10)
IMAGE_HTTP_TIMEOUT = (3, 10)
PROGRESS_PATH = "pipeline/federation/progress.json"
STOP_PATH = "pipeline/federation/stop.json"
MAX_IMAGE_BYTES = 30 * 1024 * 1024


class RuntimeBudgetReached(RuntimeError):
    """Raised before another network operation near the Kaggle time limit."""


def ensure_runtime(deadline: float | None) -> None:
    if deadline is not None and time.time() >= deadline:
        raise RuntimeBudgetReached("runtime reserve reached")


def interruptible_sleep(seconds: float, deadline: float | None) -> None:
    """Sleep in short intervals so shutdown cannot be hidden by backoff."""
    end = time.time() + max(0.0, seconds)
    while time.time() < end:
        ensure_runtime(deadline)
        time.sleep(min(1.0, end - time.time()))
    ensure_runtime(deadline)


def utc_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def token() -> str:
    value = (os.environ.get("HF_TOKEN") or "").strip()
    if value:
        return value
    for raw in (
        "/kaggle/input/my-secrets/credential.txt",
        "/kaggle/input/my_secrets/credential.txt",
    ):
        try:
            value = Path(raw).read_text(encoding="utf-8").strip()
            if value:
                return value
        except OSError:
            pass
    try:
        from kaggle_secrets import UserSecretsClient
        return (UserSecretsClient().get_secret("HF_TOKEN") or "").strip()
    except Exception:
        return ""


def build_session(hf_token: str = "") -> requests.Session:
    retry = Retry(
        total=2,
        connect=2,
        read=2,
        status=2,
        backoff_factor=1.0,
        status_forcelist=RETRYABLE_STATUS,
        allowed_methods=frozenset({"GET"}),
        respect_retry_after_header=True,
        raise_on_status=False,
    )
    adapter = HTTPAdapter(max_retries=retry, pool_connections=12, pool_maxsize=12)
    session = requests.Session()
    session.trust_env = False
    session.headers.update({"User-Agent": "FindFlower-Find10K-Federator/1.0"})
    # The dataset is public. Never attach the Hub bearer token to this shared
    # session because it also calls iNaturalist, GBIF, and image CDNs.
    session.mount("https://", adapter)
    session.mount("http://", adapter)
    return session


def retry_delay(attempt: int, response: requests.Response | None = None, cap: int = 180) -> float:
    if response is not None:
        raw = response.headers.get("Retry-After")
        try:
            if raw:
                return min(cap, max(1.0, float(raw)))
        except ValueError:
            pass
    return min(cap, 2 ** attempt + random.random() * 2)


def get_json(
    session: requests.Session,
    url: str,
    params: dict[str, Any] | None = None,
    deadline: float | None = None,
) -> dict[str, Any]:
    last_error: Exception | None = None
    for attempt in range(1, 3):
        ensure_runtime(deadline)
        response: requests.Response | None = None
        try:
            response = session.get(url, params=params, timeout=HTTP_TIMEOUT)
            if response.status_code not in RETRYABLE_STATUS:
                response.raise_for_status()
                payload = response.json()
                if not isinstance(payload, dict):
                    raise ValueError(f"unexpected JSON response from {url}")
                return payload
            last_error = requests.HTTPError(f"HTTP {response.status_code}", response=response)
        except (requests.RequestException, ValueError) as exc:
            last_error = exc
            status = getattr(getattr(exc, "response", None), "status_code", None)
            if status is not None and status not in RETRYABLE_STATUS:
                raise
        finally:
            if response is not None:
                response.close()
        if attempt == 2:
            break
        delay = retry_delay(attempt, response)
        print(f"[network] retry={attempt}/2 url={url} wait={delay:.1f}s", flush=True)
        interruptible_sleep(delay, deadline)
    raise RuntimeError(f"request failed after 7 attempts: {url}") from last_error


def get_bytes(
    session: requests.Session,
    url: str,
    deadline: float | None = None,
) -> bytes:
    last_error: Exception | None = None
    for attempt in range(1, 3):
        ensure_runtime(deadline)
        response: requests.Response | None = None
        try:
            response = session.get(url, stream=True, timeout=IMAGE_HTTP_TIMEOUT)
            if response.status_code in RETRYABLE_STATUS:
                last_error = requests.HTTPError(f"HTTP {response.status_code}", response=response)
            else:
                response.raise_for_status()
                length = int(response.headers.get("content-length") or 0)
                if length > MAX_IMAGE_BYTES:
                    raise OverflowError(f"image exceeds {MAX_IMAGE_BYTES} bytes")
                output = io.BytesIO()
                for chunk in response.iter_content(128 * 1024):
                    ensure_runtime(deadline)
                    if not chunk:
                        continue
                    output.write(chunk)
                    if output.tell() > MAX_IMAGE_BYTES:
                        raise OverflowError(f"image exceeds {MAX_IMAGE_BYTES} bytes")
                return output.getvalue()
        except OverflowError:
            raise
        except requests.RequestException as exc:
            last_error = exc
            status = getattr(getattr(exc, "response", None), "status_code", None)
            if status is not None and status not in RETRYABLE_STATUS:
                raise
        finally:
            if response is not None:
                response.close()
        if attempt == 2:
            break
        interruptible_sleep(retry_delay(attempt, response, cap=20), deadline)
    raise RuntimeError(f"download failed after 2 attempts: {url}") from last_error


def hf_resolve_url(repo_id: str, revision: str, path_in_repo: str) -> str:
    return (
        f"https://huggingface.co/datasets/{repo_id}/resolve/"
        f"{quote(revision, safe='')}/{quote(path_in_repo, safe='/')}"
    )


def load_hub_json(
    session: requests.Session,
    repo_id: str,
    revision: str,
    path_in_repo: str,
    missing: dict[str, Any] | None = None,
    deadline: float | None = None,
) -> dict[str, Any]:
    ensure_runtime(deadline)
    url = hf_resolve_url(repo_id, revision, path_in_repo)
    with session.get(url, timeout=HTTP_TIMEOUT) as response:
        if response.status_code == 404 and missing is not None:
            return missing
        response.raise_for_status()
        payload = response.json()
        if not isinstance(payload, dict):
            raise ValueError(f"expected JSON object at {path_in_repo}")
        return payload


def scan_repo_folder(
    session: requests.Session,
    repo_id: str,
    revision: str,
    image_root: str,
    folder: str,
    deadline: float | None = None,
) -> list[str]:
    """Refresh one class directory directly from the Hub before processing it."""
    root = f"{image_root.strip('/')}/{folder.strip('/')}"
    api_root = (
        f"https://huggingface.co/api/datasets/{repo_id}/tree/"
        f"{quote(revision, safe='')}/{quote(root, safe='/')}"
    )
    url = api_root + "?recursive=true&expand=false&limit=1000"
    prefix = root.rstrip("/") + "/"
    paths: list[str] = []
    while url:
        ensure_runtime(deadline)
        with session.get(url, timeout=HTTP_TIMEOUT) as response:
            if response.status_code == 404:
                return []
            response.raise_for_status()
            payload = response.json()
            if not isinstance(payload, list):
                raise ValueError("unexpected Hugging Face folder response")
            for item in payload:
                ensure_runtime(deadline)
                path = str(item.get("path") or "")
                if item.get("type") == "file" and path.startswith(prefix):
                    if Path(path).suffix.lower() in IMAGE_EXTENSIONS:
                        paths.append(path)
            links = requests.utils.parse_header_links(response.headers.get("Link", ""))
            next_url = next((link.get("url") for link in links if link.get("rel") == "next"), None)
            url = urljoin(api_root, next_url) if next_url else None
    return sorted(set(paths))


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


def normalize_and_gate(
    data: bytes,
    target_size: int,
    min_source_side: int,
    blur_floor: float,
) -> tuple[bytes | None, dict[str, Any]]:
    try:
        with Image.open(io.BytesIO(data)) as raw:
            image = ImageOps.exif_transpose(raw).convert("RGB")
            width, height = image.size
            if min(width, height) < min_source_side:
                return None, {"reason": "small", "width": width, "height": height}
            sharpness = None
            luminance = None
            clipped = None
            contrast = None
            if cv2 is not None:
                import numpy as np
                gray = cv2.cvtColor(np.asarray(image), cv2.COLOR_RGB2GRAY)
                sharpness = float(cv2.Laplacian(gray, cv2.CV_64F).var())
                luminance = float(gray.mean())
                contrast = float(gray.std())
                clipped = float(((gray <= 3) | (gray >= 252)).mean())
                if sharpness <= blur_floor:
                    return None, {"reason": "blur", "sharpness": sharpness}
                if luminance < 18 or luminance > 238 or clipped > 0.45 or contrast < 12:
                    return None, {
                        "reason": "exposure",
                        "luminance": luminance,
                        "contrast": contrast,
                        "clipped_fraction": clipped,
                    }
            image = ImageOps.fit(image, (target_size, target_size), method=Image.Resampling.LANCZOS)
            output = io.BytesIO()
            image.save(output, "JPEG", quality=95, optimize=True, progressive=True)
            return output.getvalue(), {
                "source_width": width,
                "source_height": height,
                "normalized_size": [target_size, target_size],
                "sharpness": sharpness,
                "luminance": luminance,
                "contrast": contrast,
                "clipped_fraction": clipped,
            }
    except Exception as exc:
        return None, {"reason": f"decode:{type(exc).__name__}"}


class SQLiteDeduplicator:
    """Disk-backed global MD5 and locality-sensitive 256-bit dHash index."""

    def __init__(self, path: Path, threshold: int):
        if str(path) != ":memory:":
            path.parent.mkdir(parents=True, exist_ok=True)
            path.unlink(missing_ok=True)
        self.threshold = threshold
        self.db = sqlite3.connect(str(path))
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.execute("PRAGMA synchronous=NORMAL")
        self.db.execute("CREATE TABLE hashes (md5 TEXT PRIMARY KEY, dhash TEXT NOT NULL, folder TEXT NOT NULL)")
        self.db.execute("CREATE TABLE bands (band INTEGER NOT NULL, key TEXT NOT NULL, md5 TEXT NOT NULL)")
        self.db.execute("CREATE INDEX bands_lookup ON bands (band, key)")
        self.db.execute("CREATE INDEX hashes_folder ON hashes (folder)")

    @staticmethod
    def band_keys(value: int) -> list[str]:
        # Nine disjoint bands guarantee that hashes within Hamming distance 8
        # share at least one unchanged band (pigeonhole principle).
        widths = (29, 29, 29, 29, 28, 28, 28, 28, 28)
        keys: list[str] = []
        offset = 0
        for width in widths:
            keys.append(f"{(value >> offset) & ((1 << width) - 1):x}")
            offset += width
        return keys

    def restore(self, digest: str, perceptual: int, folder: str) -> None:
        if self.db.execute("SELECT 1 FROM hashes WHERE md5=?", (digest,)).fetchone():
            return
        self.db.execute("INSERT INTO hashes VALUES (?, ?, ?)", (digest, f"{perceptual:064x}", folder))
        self.db.executemany(
            "INSERT INTO bands VALUES (?, ?, ?)",
            [(band, key, digest) for band, key in enumerate(self.band_keys(perceptual))],
        )

    def add_if_unique(self, digest: str, perceptual: int, folder: str) -> bool:
        if self.db.execute("SELECT 1 FROM hashes WHERE md5=?", (digest,)).fetchone():
            return False
        candidates: set[str] = set()
        for band, key in enumerate(self.band_keys(perceptual)):
            candidates.update(
                row[0] for row in self.db.execute(
                    "SELECT md5 FROM bands WHERE band=? AND key=?", (band, key)
                )
            )
        if candidates:
            placeholders = ",".join("?" for _ in candidates)
            for row in self.db.execute(
                f"SELECT dhash FROM hashes WHERE md5 IN ({placeholders})", tuple(candidates)
            ):
                if hamming(perceptual, int(row[0], 16)) <= self.threshold:
                    return False
        self.restore(digest, perceptual, folder)
        return True

    def remove_folder(self, folder: str) -> None:
        digests = [row[0] for row in self.db.execute("SELECT md5 FROM hashes WHERE folder=?", (folder,))]
        if digests:
            self.db.executemany("DELETE FROM bands WHERE md5=?", [(value,) for value in digests])
            self.db.execute("DELETE FROM hashes WHERE folder=?", (folder,))
        self.db.commit()

    def commit(self) -> None:
        self.db.commit()

    def close(self) -> None:
        self.db.commit()
        self.db.close()


def restore_journals(
    session: requests.Session,
    repo_id: str,
    revision: str,
    journals: Iterable[str],
    dedup: SQLiteDeduplicator,
    deadline: float | None = None,
) -> None:
    paths = list(journals)
    for index, path in enumerate(paths, 1):
        ensure_runtime(deadline)
        compressed = get_bytes(session, hf_resolve_url(repo_id, revision, path), deadline)
        with gzip.GzipFile(fileobj=io.BytesIO(compressed), mode="rb") as handle:
            for raw in handle:
                ensure_runtime(deadline)
                row = json.loads(raw)
                dedup.restore(str(row["md5"]), int(str(row["dhash256"]), 16), str(row["folder"]))
        if index % 20 == 0 or index == len(paths):
            dedup.commit()
            print(f"[resume] dedup_journals={index}/{len(paths)}", flush=True)


def resolve_inat_taxon_id(
    session: requests.Session,
    scientific_name: str,
    existing: Any,
    deadline: float | None = None,
) -> int:
    if existing not in (None, ""):
        return int(existing)
    results = get_json(
        session, INAT_TAXA_URL, {"q": scientific_name, "per_page": 30}, deadline
    ).get("results") or []
    exact = [
        row for row in results
        if scientific_name.casefold() in {
            str(row.get("name") or "").casefold(),
            str(row.get("matched_term") or "").casefold(),
        }
    ]
    if not exact:
        raise LookupError(f"no exact iNaturalist taxon for {scientific_name}")
    return int(exact[0]["id"])


def inat_candidates(
    session: requests.Session,
    taxon_id: int,
    max_pages: int,
    deadline: float | None = None,
) -> Iterable[dict[str, Any]]:
    for page in range(1, max_pages + 1):
        try:
            ensure_runtime(deadline)
        except RuntimeBudgetReached:
            # A per-class deadline is intentionally a soft stop for the
            # candidate generator; the caller records the shortfall and moves
            # to the next species instead of aborting the whole shard.
            return
        try:
            payload = get_json(session, INAT_OBSERVATIONS_URL, {
                "taxon_id": taxon_id,
                "quality_grade": "research",
                "photos": "true",
                "photo_license": ",".join(sorted(OPEN_LICENSES)),
                "per_page": 200,
                "page": page,
                "order_by": "votes",
                "order": "desc",
            }, deadline)
        except RuntimeBudgetReached:
            return
        except Exception as exc:
            print(
                f"[inat] page deferred taxon={taxon_id} page={page} "
                f"error={type(exc).__name__}: {exc}",
                flush=True,
            )
            break
        observations = payload.get("results") or []
        if not observations:
            break
        for observation in observations:
            try:
                ensure_runtime(deadline)
            except RuntimeBudgetReached:
                return
            taxon = observation.get("taxon") or {}
            observed_id = taxon.get("id")
            ancestors = {int(value) for value in (taxon.get("ancestor_ids") or [])}
            if observed_id is None or (int(observed_id) != taxon_id and taxon_id not in ancestors):
                continue
            observation_id = int(observation.get("id") or 0)
            for photo in observation.get("photos") or []:
                try:
                    ensure_runtime(deadline)
                except RuntimeBudgetReached:
                    return
                license_code = str(photo.get("license_code") or "").lower()
                url = re.sub(
                    r"/(square|small|medium|large|original)\.",
                    "/original.",
                    str(photo.get("url") or ""),
                )
                if license_code in OPEN_LICENSES and url.startswith("http"):
                    yield {
                        "source": "inaturalist",
                        "source_id": f"inat:{observation_id}",
                        "observation_id": observation_id,
                        "photo_id": photo.get("id"),
                        "url": url,
                        "license": license_code,
                        "attribution": photo.get("attribution"),
                    }
                    break
        if len(observations) < 200:
            break
        interruptible_sleep(0.4, deadline)


def normalized_license(value: str) -> str | None:
    text = value.lower().replace("_", "-")
    if "creativecommons.org/publicdomain/zero" in text or "cc0" in text:
        return "cc0"
    if "creativecommons.org/licenses/by-nc/" in text or "cc-by-nc" in text:
        return "cc-by-nc"
    if "creativecommons.org/licenses/by/" in text or "cc-by" in text:
        return "cc-by"
    return None


def gbif_candidates(
    session: requests.Session,
    scientific_name: str,
    max_pages: int,
    deadline: float | None = None,
) -> Iterable[dict[str, Any]]:
    try:
        match = get_json(
            session, GBIF_MATCH_URL, {"name": scientific_name, "strict": "true"}, deadline
        )
    except RuntimeBudgetReached:
        return
    except Exception as exc:
        print(
            f"[gbif] taxon deferred name={scientific_name} "
            f"error={type(exc).__name__}: {exc}",
            flush=True,
        )
        return
    taxon_key = match.get("usageKey")
    if not taxon_key:
        return
    limit = 300
    for page in range(max_pages):
        try:
            ensure_runtime(deadline)
        except RuntimeBudgetReached:
            return
        try:
            payload = get_json(session, GBIF_OCCURRENCES_URL, {
                "taxon_key": taxon_key,
                "media_type": "StillImage",
                "occurrence_status": "present",
                "limit": limit,
                "offset": page * limit,
            }, deadline)
        except RuntimeBudgetReached:
            return
        except Exception as exc:
            print(
                f"[gbif] page deferred name={scientific_name} page={page} "
                f"error={type(exc).__name__}: {exc}",
                flush=True,
            )
            break
        results = payload.get("results") or []
        if not results:
            break
        for occurrence in results:
            try:
                ensure_runtime(deadline)
            except RuntimeBudgetReached:
                return
            occurrence_id = str(occurrence.get("key") or occurrence.get("occurrenceID") or "")
            for media in occurrence.get("media") or []:
                try:
                    ensure_runtime(deadline)
                except RuntimeBudgetReached:
                    return
                license_code = normalized_license(str(media.get("license") or ""))
                url = str(media.get("identifier") or media.get("references") or "")
                if license_code and url.startswith("http"):
                    yield {
                        "source": "gbif",
                        "source_id": f"gbif:{occurrence_id}",
                        "observation_id": occurrence_id,
                        "photo_id": media.get("identifier"),
                        "url": url,
                        "license": license_code,
                        "attribution": media.get("creator") or occurrence.get("recordedBy"),
                    }
                    break
        if len(results) < limit:
            break
        interruptible_sleep(0.4, deadline)


def canonical_filename(index: int, source_id: str) -> str:
    digest = hashlib.sha1(source_id.encode("utf-8")).hexdigest()[:12]
    return f"{index:03d}_{digest}.jpg"


def stage_candidate(
    data: bytes,
    metadata: dict[str, Any],
    folder: str,
    class_stage: Path,
    index: int,
    dedup: SQLiteDeduplicator,
    target_size: int,
    min_source_side: int,
    blur_floor: float,
) -> dict[str, Any] | None:
    normalized, quality = normalize_and_gate(data, target_size, min_source_side, blur_floor)
    if normalized is None:
        return None
    digest = hashlib.md5(normalized).hexdigest()
    with Image.open(io.BytesIO(normalized)) as image:
        perceptual = dhash256(image)
    if not dedup.add_if_unique(digest, perceptual, folder):
        return None
    filename = canonical_filename(index, str(metadata["source_id"]))
    target = class_stage / filename
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(normalized)
    return {
        **metadata,
        "folder": folder,
        "filename": filename,
        "md5": digest,
        "dhash256": f"{perceptual:064x}",
        "quality": quality,
        "normalized_size": [target_size, target_size],
    }


def prepare_class(
    session: requests.Session,
    repo_id: str,
    revision: str,
    row: dict[str, Any],
    existing_paths: list[str],
    work: Path,
    dedup: SQLiteDeduplicator,
    target_count: int,
    target_size: int,
    blur_floor: float,
    api_pages: int,
    gbif_pages: int,
    deadline: float | None = None,
    class_timeout_seconds: float = 90.0,
) -> tuple[Path | None, list[dict[str, Any]], dict[str, int]]:
    folder = str(row["folder"])
    scientific_name = str(row["scientific_name"])
    class_stage = work / "current" / folder
    shutil.rmtree(class_stage, ignore_errors=True)
    class_stage.mkdir(parents=True, exist_ok=True)
    records: list[dict[str, Any]] = []
    rejects: dict[str, int] = defaultdict(int)
    used_sources: set[str] = set()
    class_deadline = time.time() + max(1.0, class_timeout_seconds)
    effective_deadline = min(deadline, class_deadline) if deadline is not None else class_deadline

    def class_expired() -> bool:
        return time.time() >= class_deadline and (deadline is None or time.time() < deadline)

    for path in existing_paths:
        if class_expired():
            rejects["class_timeout"] += 1
            break
        ensure_runtime(effective_deadline)
        if len(records) >= target_count:
            break
        source_id = f"hub:{path}"
        try:
            raw = get_bytes(session, hf_resolve_url(repo_id, revision, path), effective_deadline)
            record = stage_candidate(
                raw,
                {"source": "hub", "source_id": source_id, "source_path": path, "license": "preserved"},
                folder,
                class_stage,
                len(records) + 1,
                dedup,
                target_size,
                min_source_side=224,
                blur_floor=blur_floor,
            )
        except RuntimeBudgetReached:
            if class_expired():
                rejects["class_timeout"] += 1
                break
            raise
        except Exception as exc:
            rejects[f"hub_download:{type(exc).__name__}"] += 1
            continue
        if record is None:
            rejects["hub_quality_or_duplicate"] += 1
            continue
        records.append(record)
        used_sources.add(source_id)

    taxon_id: int | None = None
    if len(records) < target_count:
        try:
            taxon_id = resolve_inat_taxon_id(
                session, scientific_name, row.get("inat_taxon_id"), effective_deadline
            )
        except RuntimeBudgetReached:
            if class_expired():
                rejects["class_timeout"] += 1
                taxon_id = None
            else:
                raise
        except Exception as exc:
            rejects[f"taxon_resolution:{type(exc).__name__}"] += 1
        if taxon_id is not None:
            for candidate in inat_candidates(session, taxon_id, api_pages, effective_deadline):
                if class_expired():
                    rejects["class_timeout"] += 1
                    break
                ensure_runtime(effective_deadline)
                if len(records) >= target_count:
                    break
                if candidate["source_id"] in used_sources:
                    continue
                used_sources.add(candidate["source_id"])
                try:
                    raw = get_bytes(session, candidate["url"], effective_deadline)
                    record = stage_candidate(
                        raw,
                        candidate,
                        folder,
                        class_stage,
                        len(records) + 1,
                        dedup,
                        target_size,
                        min_source_side=target_size,
                        blur_floor=blur_floor,
                    )
                except RuntimeBudgetReached:
                    if class_expired():
                        rejects["class_timeout"] += 1
                        break
                    raise
                except Exception as exc:
                    rejects[f"inat_download:{type(exc).__name__}"] += 1
                    continue
                if record is None:
                    rejects["inat_quality_or_duplicate"] += 1
                    continue
                records.append(record)

    if len(records) < target_count:
        for candidate in gbif_candidates(session, scientific_name, gbif_pages, effective_deadline):
            if class_expired():
                rejects["class_timeout"] += 1
                break
            ensure_runtime(effective_deadline)
            if len(records) >= target_count:
                break
            if candidate["source_id"] in used_sources:
                continue
            used_sources.add(candidate["source_id"])
            try:
                raw = get_bytes(session, candidate["url"], effective_deadline)
                record = stage_candidate(
                    raw,
                    candidate,
                    folder,
                    class_stage,
                    len(records) + 1,
                    dedup,
                    target_size,
                    min_source_side=target_size,
                    blur_floor=blur_floor,
                )
            except RuntimeBudgetReached:
                if class_expired():
                    rejects["class_timeout"] += 1
                    break
                raise
            except Exception as exc:
                rejects[f"gbif_download:{type(exc).__name__}"] += 1
                continue
            if record is None:
                rejects["gbif_quality_or_duplicate"] += 1
                continue
            records.append(record)

    # A shard-wide deadline must still propagate to the outer loop. A
    # per-class deadline, by contrast, is handled as a skippable shortfall.
    if deadline is not None and time.time() >= deadline:
        raise RuntimeBudgetReached("runtime reserve reached")
    if len(records) != target_count:
        dedup.remove_folder(folder)
        shutil.rmtree(class_stage, ignore_errors=True)
        rejects["shortfall"] = target_count - len(records)
        return None, [], dict(rejects)
    dedup.commit()
    return class_stage, records, dict(rejects)


def write_gzip_jsonl(path: Path, rows: Iterable[dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with gzip.open(path, "wt", encoding="utf-8", compresslevel=6) as handle:
        for row in rows:
            handle.write(json.dumps(row, separators=(",", ":"), ensure_ascii=True) + "\n")


def iter_files(root: Path) -> Iterable[Path]:
    for path in sorted(root.rglob("*")):
        if path.is_file():
            yield path


def commit_batch(
    api: Any,
    repo_id: str,
    image_root: str,
    batch_root: Path,
    batch_classes: list[dict[str, Any]],
    old_paths: dict[str, list[str]],
    progress: dict[str, Any],
    batch_records: list[dict[str, Any]],
    progress_repo_path: str,
    failures: dict[str, Any],
    failure_path: Path,
) -> bool:
    from huggingface_hub import CommitOperationAdd, CommitOperationDelete
    from huggingface_hub.errors import BadRequestError, HfHubHTTPError

    batch_index = len(progress.get("journals", [])) + 1
    # The class digest makes the marker and journal paths deterministic for a
    # retry, while preventing concurrent workers from colliding on batch-000001.
    class_digest = hashlib.sha256(
        "\n".join(sorted(str(item["folder"]) for item in batch_classes)).encode("utf-8")
    ).hexdigest()[:12]
    batch_marker = f"batch-{batch_index:06d}-{class_digest}"
    journal_repo_path = f"pipeline/federation/dedup/{batch_marker}.jsonl.gz"
    records_repo_path = f"pipeline/federation/records/{batch_marker}.jsonl.gz"
    journal_local = batch_root / journal_repo_path
    records_local = batch_root / records_repo_path
    write_gzip_jsonl(journal_local, (
        {"folder": row["folder"], "md5": row["md5"], "dhash256": row["dhash256"]}
        for row in batch_records
    ))
    write_gzip_jsonl(records_local, batch_records)

    next_progress = json.loads(json.dumps(progress))
    next_progress.setdefault("completed", {})
    for item in batch_classes:
        next_progress["completed"][item["folder"]] = {
            "scientific_name": item["scientific_name"],
            "count": item["target"],
            "resolution": [item["target_size"], item["target_size"]],
            "completed_at": utc_now(),
        }
    next_progress["journals"] = list(next_progress.get("journals", [])) + [journal_repo_path]
    next_progress["record_shards"] = list(next_progress.get("record_shards", [])) + [records_repo_path]
    next_progress["updated_at"] = utc_now()
    progress_local = batch_root / progress_repo_path
    progress_local.parent.mkdir(parents=True, exist_ok=True)
    progress_local.write_text(json.dumps(next_progress, indent=2, sort_keys=True) + "\n", encoding="utf-8")

    add_paths = {
        path.relative_to(batch_root).as_posix(): path
        for path in iter_files(batch_root)
    }
    # A five-class checkpoint contains at most 1,500 images. Delete each previous class
    # directory as one operation so the replacement remains below the Hub's
    # commit-operation ceiling instead of issuing 15,000 additional deletes.
    delete_folders = sorted(
        item["folder"] for item in batch_classes if old_paths.get(item["folder"])
    )
    operations = [
        CommitOperationDelete(
            path_in_repo=f"{image_root.strip('/')}/{folder}",
            is_folder=True,
        )
        for folder in delete_folders
    ]
    operations.extend(
        CommitOperationAdd(path_in_repo=path_in_repo, path_or_fileobj=str(path))
        for path_in_repo, path in sorted(add_paths.items())
    )
    if len(operations) > 20_000:
        raise RuntimeError(f"batch has {len(operations):,} operations; reduce --commit-classes")
    def status_code(exc: Exception) -> int | None:
        response = getattr(exc, "response", None)
        value = getattr(response, "status_code", None) or getattr(exc, "status_code", None)
        try:
            return int(value) if value is not None else None
        except (TypeError, ValueError):
            return None

    def commit_was_applied() -> bool:
        """Check recent Hub history after an ambiguous gateway response."""
        try:
            recent = api.list_repo_commits(
                repo_id=repo_id,
                repo_type="dataset",
                revision="main",
            )
            for commit in list(recent)[:30]:
                title = str(getattr(commit, "title", "") or "")
                if batch_marker in title:
                    return True
        except Exception as verify_error:
            print(
                f"[commit] server-side verification unavailable: "
                f"{type(verify_error).__name__}: {verify_error}",
                flush=True,
            )
        return False

    for attempt in range(1, 8):
        try:
            # Read the current main ref immediately before each attempt. This
            # avoids submitting a stale parent when other shards commit.
            parent_commit = None
            try:
                parent_commit = api.repo_info(
                    repo_id=repo_id, repo_type="dataset", revision="main"
                ).sha
            except Exception as ref_error:
                print(
                    f"[commit] ref refresh unavailable: {type(ref_error).__name__}: {ref_error}",
                    flush=True,
                )
            api.create_commit(
                repo_id=repo_id,
                repo_type="dataset",
                operations=operations,
                parent_commit=parent_commit,
                commit_message=(
                    f"federate: 448px classes {len(next_progress['completed']):,}; "
                    f"{batch_marker}"
                ),
            )
            progress.clear()
            progress.update(next_progress)
            print(
                f"[commit] batch={batch_index:06d} classes={len(batch_classes)} "
                f"operations={len(operations):,}",
                flush=True,
            )
            return True
        except (BadRequestError, HfHubHTTPError) as exc:
            # huggingface_hub may surface either httpx.HTTPStatusError or its
            # HfHubHTTPError wrapper. Treat 502/503/504 as ambiguous: the Hub
            # can finish the commit while the gateway drops the response.
            httpx_status_error = False
            try:
                import httpx
                httpx_status_error = isinstance(exc, httpx.HTTPStatusError)
            except Exception:
                pass
            status = status_code(exc)
            if status == 400 or isinstance(exc, BadRequestError):
                # A 400 means the Hub rejected the staged LFS payload (usually
                # a desynchronised/corrupt batch). Retrying the same payload
                # only repeats the failure and can stall every shard.
                failure_time = utc_now()
                for item in batch_classes:
                    failures[item["folder"]] = {
                        "scientific_name": item["scientific_name"],
                        "existing_count": 0,
                        "rejected": {
                            "commit_http_400": 1,
                            "batch_marker": batch_marker,
                        },
                        "recorded_at": failure_time,
                    }
                failure_path.parent.mkdir(parents=True, exist_ok=True)
                failure_path.write_text(
                    json.dumps({"generated_at": failure_time, "failures": failures}, indent=2)
                    + "\n",
                    encoding="utf-8",
                )
                shutil.rmtree(batch_root, ignore_errors=True)
                print(
                    f"[commit] HTTP 400; discarded batch={batch_marker} and continuing",
                    flush=True,
                )
                return False
            collision_or_gateway = status in {412, 502, 503, 504}
            if collision_or_gateway:
                print(
                    f"[commit] retryable Hub response status={status}; "
                    f"checking Hub for {batch_marker}",
                    flush=True,
                )
                if status in {502, 503, 504}:
                    for verify_attempt in range(1, 4):
                        if commit_was_applied():
                            progress.clear()
                            progress.update(next_progress)
                            print(
                                f"[commit] verified server-side after gateway error; "
                                f"batch={batch_marker}",
                                flush=True,
                            )
                            return
                        if verify_attempt < 3:
                            time.sleep(5 * verify_attempt)
            if attempt == 7:
                raise
            if status in {412, 502, 503, 504}:
                delay = min(45.0, 10.0 * (2 ** (attempt - 1)) + random.uniform(0, 8))
            else:
                delay = min(600, 10 * 2 ** attempt + random.random() * 5)
            print(
                f"[commit] retry={attempt}/7 error={type(exc).__name__} "
                f"status={status} wait={delay:.1f}s",
                flush=True,
            )
            time.sleep(delay)
        except Exception as exc:
            if attempt == 7:
                raise
            delay = min(600, 10 * 2 ** attempt + random.random() * 5)
            print(
                f"[commit] retry={attempt}/7 error={type(exc).__name__} "
                f"wait={delay:.1f}s",
                flush=True,
            )
            time.sleep(delay)


def upload_file_with_retry(
    api: Any,
    repo_id: str,
    local_path: Path,
    path_in_repo: str,
    message: str,
) -> None:
    for attempt in range(1, 8):
        try:
            api.upload_file(
                repo_id=repo_id,
                repo_type="dataset",
                path_or_fileobj=str(local_path),
                path_in_repo=path_in_repo,
                commit_message=message,
            )
            return
        except Exception as exc:
            if attempt == 7:
                raise
            delay = min(300, 2 ** attempt + random.random() * 3)
            print(f"[upload] retry={attempt}/7 error={type(exc).__name__} wait={delay:.1f}s", flush=True)
            time.sleep(delay)


def load_audit(
    session: requests.Session,
    repo_id: str,
    revision: str,
    local_path: Path | None,
    path_in_repo: str,
    deadline: float | None = None,
) -> dict[str, Any]:
    if local_path:
        payload = json.loads(local_path.read_text(encoding="utf-8"))
    else:
        payload = load_hub_json(session, repo_id, revision, path_in_repo, deadline=deadline)
    if not isinstance(payload.get("per_class"), dict):
        raise ValueError("flower_audit.json has no per_class mapping")
    return payload


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--repo-id", default=os.environ.get("HF_DATASET_REPO", "gsor56/findflower-find10k"))
    parser.add_argument("--revision", default="main")
    parser.add_argument("--image-root", default="images/train")
    parser.add_argument("--audit", type=Path)
    parser.add_argument("--audit-path-in-repo", default="flower_audit.json")
    parser.add_argument("--work", type=Path, default=Path("/kaggle/working/find10k-federation"))
    parser.add_argument("--target-per-class", type=int, default=300)
    parser.add_argument("--target-size", type=int, default=448)
    parser.add_argument("--blur-floor", type=float, default=40.0)
    parser.add_argument("--dhash-threshold", type=int, default=8)
    parser.add_argument("--api-pages", type=int, default=50)
    parser.add_argument("--gbif-pages", type=int, default=20)
    parser.add_argument("--commit-classes", type=int, default=10)
    parser.add_argument("--shard-index", type=int, default=0)
    parser.add_argument("--total-shards", type=int, default=1)
    parser.add_argument("--max-runtime-seconds", type=int, default=41_000)
    parser.add_argument(
        "--class-timeout-seconds",
        type=float,
        default=90.0,
        help="maximum wall-clock time spent sourcing one species",
    )
    parser.add_argument(
        "--absolute-deadline-unix",
        type=float,
        help="absolute session deadline propagated by the Kaggle runner",
    )
    parser.add_argument("--allow-unexpected-folders", action="store_true")
    args = parser.parse_args()

    if args.target_size != 448:
        raise SystemExit("target-size must be exactly 448 for the Find10K federation standard")
    if min(args.target_per_class, args.target_size, args.commit_classes) <= 0:
        raise SystemExit("target-per-class, target-size, and commit-classes must be positive")
    if args.commit_classes != 10:
        raise SystemExit("commit-classes is fixed at 10 for this federation cycle")
    if args.total_shards <= 0 or not 0 <= args.shard_index < args.total_shards:
        raise SystemExit("shard-index must be in [0, total-shards)")
    progress_repo_path = f"pipeline/federation/progress_shard_{args.shard_index}.json"
    stop_repo_path = f"pipeline/federation/stop_shard_{args.shard_index}.json"
    failures_repo_path = f"pipeline/federation/failures_shard_{args.shard_index}.json"
    skipped_repo_path = f"pipeline/federation/skipped_deficit_shard_{args.shard_index}.json"
    deadline = args.absolute_deadline_unix or (time.time() + max(600, args.max_runtime_seconds))
    hf_token = token()
    if not hf_token:
        raise SystemExit("HF_TOKEN or the Kaggle credential dataset is required")
    session = build_session(hf_token)
    audit = load_audit(
        session,
        args.repo_id,
        args.revision,
        args.audit,
        args.audit_path_in_repo,
        deadline,
    )
    if audit.get("repo_id") and audit["repo_id"] != args.repo_id:
        raise SystemExit("audit repo_id does not match --repo-id")
    if audit.get("unexpected_folders") and not args.allow_unexpected_folders:
        raise SystemExit("audit contains unexpected folders; run the slicer purge before federation")
    target = int(audit.get("target_per_class") or args.target_per_class)
    if target != args.target_per_class:
        raise SystemExit(f"audit target {target} does not match requested target {args.target_per_class}")
    all_classes = [dict(value) for value in audit["per_class"].values()]
    deficit_classes = [
        row for row in all_classes if int(row.get("deficit") or 0) > 0
    ]
    classes = deficit_classes or all_classes
    classes.sort(key=lambda row: (-int(row.get("deficit") or 0), int(row["local_index"])))
    if len({row["folder"] for row in classes}) != len(classes):
        raise SystemExit("audit contains duplicate class folders")
    classes = classes[args.shard_index :: args.total_shards]

    from huggingface_hub import HfApi
    api = HfApi(token=hf_token)
    progress = load_hub_json(
        session,
        args.repo_id,
        args.revision,
        progress_repo_path,
        missing={"schema_version": 1, "completed": {}, "journals": [], "record_shards": []},
        deadline=deadline,
    )
    stop_state = load_hub_json(
        session,
        args.repo_id,
        args.revision,
        stop_repo_path,
        missing={},
        deadline=deadline,
    )
    completed = set(progress.get("completed", {}))
    print(
        f"[resume] completed={len(completed):,}/{len(classes):,} "
        f"journals={len(progress.get('journals', [])):,}",
        flush=True,
    )
    args.work.mkdir(parents=True, exist_ok=True)
    dedup = SQLiteDeduplicator(
        args.work / f"dedup_shard_{args.shard_index}.sqlite3", args.dhash_threshold
    )
    try:
        ensure_runtime(deadline)
        restore_journals(
            session,
            args.repo_id,
            args.revision,
            progress.get("journals", []),
            dedup,
            deadline,
        )
    except RuntimeBudgetReached:
        dedup.close()
        stop_info = {
            "stopped_at": utc_now(),
            "position": 0,
            "total_classes": len(classes),
            "reason": "runtime_budget_during_resume_scan",
        }
        stop_path = args.work / f"federation_stop_shard_{args.shard_index}.json"
        stop_path.write_text(json.dumps(stop_info, indent=2) + "\n", encoding="utf-8")
        upload_file_with_retry(
            api,
            args.repo_id,
            stop_path,
            stop_repo_path,
            "federate: publish graceful stopping point",
        )
        session.close()
        print(json.dumps({"status": "checkpointed", **stop_info}, indent=2), flush=True)
        return 0
    # Do not enumerate the entire dataset on resume. Every unfinished class is
    # refreshed individually immediately before processing.
    by_folder: dict[str, list[str]] = {}

    resume_folder = str(stop_state.get("folder") or "")
    if resume_folder:
        resume_index = next(
            (index for index, row in enumerate(classes) if str(row["folder"]) == resume_folder),
            None,
        )
        if resume_index is not None:
            classes = classes[resume_index:] + classes[:resume_index]
            print(
                f"[resume] stopping_point={resume_folder} queue_offset={resume_index}",
                flush=True,
            )
    elif stop_state:
        print(
            f"[resume] stopping_point has no folder; reason={stop_state.get('reason')}",
            flush=True,
        )

    batch_root = args.work / "batch"
    shutil.rmtree(batch_root, ignore_errors=True)
    batch_root.mkdir(parents=True)
    batch_classes: list[dict[str, Any]] = []
    batch_records: list[dict[str, Any]] = []
    batch_files = 0
    failures: dict[str, Any] = {}
    skipped: dict[str, Any] = {}
    failure_path = args.work / f"federation_failures_shard_{args.shard_index}.json"
    stop_info: dict[str, Any] | None = None

    def flush() -> None:
        nonlocal batch_root, batch_classes, batch_records, batch_files
        if not batch_classes:
            return
        commit_batch(
            api,
            args.repo_id,
            args.image_root,
            batch_root,
            batch_classes,
            by_folder,
            progress,
            batch_records,
            progress_repo_path,
            failures,
            failure_path,
        )
        # commit_batch may already have removed the buffer after a terminal
        # HTTP 400. Cleanup must remain idempotent so the queue can continue.
        shutil.rmtree(batch_root, ignore_errors=True)
        batch_root.mkdir(parents=True)
        batch_classes = []
        batch_records = []
        batch_files = 0

    for position, row in enumerate(classes, 1):
        folder = str(row["folder"])
        state = progress.get("completed", {}).get(folder) or {}
        if folder in completed and state.get("resolution") == [args.target_size, args.target_size]:
            continue
        if time.time() >= deadline:
            stop_info = {
                "stopped_at": utc_now(),
                "position": position,
                "total_classes": len(classes),
                "folder": folder,
                "reason": "runtime_budget",
            }
            print(f"[time] stopping before class={folder}; committing staged complete classes", flush=True)
            break
        try:
            # Refresh remote state immediately before deciding whether this
            # class needs work. This makes reruns safe after partial commits.
            by_folder[folder] = scan_repo_folder(
                session, args.repo_id, args.revision, args.image_root, folder, deadline
            )
        except RuntimeBudgetReached:
            stop_info = {
                "stopped_at": utc_now(),
                "position": position,
                "total_classes": len(classes),
                "folder": folder,
                "reason": "runtime_budget_during_hub_scan",
            }
            print(f"[time] stopping during Hub scan for class={folder}", flush=True)
            break
        except Exception as exc:
            failures[folder] = {
                "scientific_name": row["scientific_name"],
                "existing_count": len(by_folder.get(folder, [])),
                "rejected": {f"hub_state:{type(exc).__name__}": 1},
            }
            print(f"[hub] state check failed folder={folder}: {type(exc).__name__}: {exc}", flush=True)
            continue
        existing_count = len(by_folder.get(folder, []))
        if existing_count >= target and state.get("resolution") == [args.target_size, args.target_size]:
            completed.add(folder)
            continue
        print(
            f"[class] {position}/{len(classes)} folder={folder} "
            f"existing={len(by_folder.get(folder, []))} target={target}",
            flush=True,
        )
        try:
            class_stage, records, rejects = prepare_class(
                session,
                args.repo_id,
                args.revision,
                row,
                by_folder.get(folder, []),
                args.work,
                dedup,
                target,
                args.target_size,
                args.blur_floor,
                args.api_pages,
                args.gbif_pages,
                deadline,
                args.class_timeout_seconds,
            )
        except RuntimeBudgetReached:
            dedup.remove_folder(folder)
            shutil.rmtree(args.work / "current" / folder, ignore_errors=True)
            stop_info = {
                "stopped_at": utc_now(),
                "position": position,
                "total_classes": len(classes),
                "folder": folder,
                "reason": "runtime_budget_during_class",
            }
            print(f"[time] stopping during class={folder}; staged class discarded", flush=True)
            break
        if class_stage is None:
            failures[folder] = {
                "scientific_name": row["scientific_name"],
                "existing_count": len(by_folder.get(folder, [])),
                "rejected": rejects,
            }
            if rejects.get("class_timeout"):
                skipped[folder] = {
                    "scientific_name": row["scientific_name"],
                    "existing_count": existing_count,
                    "partial_images": len(records),
                    "deficit": max(0, target - existing_count),
                    "reason": "class_timeout",
                    "recorded_at": utc_now(),
                }
            print(f"[class] deferred={folder} details={json.dumps(rejects, sort_keys=True)}", flush=True)
            continue
        destination = batch_root / args.image_root.strip("/") / folder
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.move(str(class_stage), str(destination))
        batch_classes.append({
            "folder": folder,
            "scientific_name": row["scientific_name"],
            "target": target,
            "target_size": args.target_size,
        })
        batch_records.extend(records)
        batch_files += len(records)
        print(f"[class] ready={folder} images={len(records)}", flush=True)
        if len(batch_classes) >= args.commit_classes:
            print(
                f"[checkpoint] completed_classes={len(batch_classes)}; committing to Hub",
                flush=True,
            )
            flush()

    flush()
    dedup.close()
    if stop_info is None and time.time() >= deadline:
        stop_info = {
            "stopped_at": utc_now(),
            "position": len(classes),
            "total_classes": len(classes),
            "reason": "runtime_budget",
        }
    stop_path: Path | None = None
    if stop_info:
        stop_path = args.work / f"federation_stop_shard_{args.shard_index}.json"
        stop_path.write_text(json.dumps(stop_info, indent=2) + "\n", encoding="utf-8")
    failure_path.write_text(json.dumps({"generated_at": utc_now(), "failures": failures}, indent=2) + "\n", encoding="utf-8")
    skipped_path = args.work / f"skipped_deficit_shard_{args.shard_index}.json"
    skipped_path.write_text(
        json.dumps({"generated_at": utc_now(), "skipped": skipped}, indent=2) + "\n",
        encoding="utf-8",
    )
    if stop_path is not None:
        upload_file_with_retry(
            api,
            args.repo_id,
            stop_path,
            stop_repo_path,
            "federate: publish graceful stopping point",
        )
    if failures:
        upload_file_with_retry(
            api,
            args.repo_id,
            failure_path,
            failures_repo_path,
            "federate: update sparse class report",
        )
    if skipped:
        upload_file_with_retry(
            api,
            args.repo_id,
            skipped_path,
            skipped_repo_path,
            "federate: record per-class timeout skips",
        )
    if stop_info:
        # Do not run the full-repository final audit after the shutdown signal;
        # the buffer and stopping point are durable, so exit with Kaggle margin.
        session.close()
        print(json.dumps({"status": "checkpointed", **stop_info}, indent=2), flush=True)
        return 0
    # Active workers must not run a recursive Hub scan here. On large repos
    # that verification can exceed the session deadline after all useful work
    # is committed. The durable shard progress file is the active source of
    # truth; run scripts/audit_find10k_full.py once after federation completes.
    shard_summary = {
        "generated_at": utc_now(),
        "repo_id": args.repo_id,
        "shard_index": args.shard_index,
        "total_shards": args.total_shards,
        "completed_classes": len(progress.get("completed", {})),
        "images_committed": sum(
            int((state or {}).get("count") or 0)
            for state in progress.get("completed", {}).values()
        ),
        "status": "active_audit_deferred",
    }
    session.close()
    print(json.dumps(shard_summary, indent=2), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
