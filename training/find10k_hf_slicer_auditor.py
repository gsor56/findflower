#!/usr/bin/env python3
"""Audit and optionally purge non-flowering folders from a Find10K Hub dataset.

The trusted class source is the strict ``botanical_classes.json`` emitted by
``find10k_phase1_taxonomy.py``. Repository folders not represented by that
verified Plantae/angiosperm taxonomy are reported as quarantined and are only
deleted when both ``--apply-delete`` and ``--confirm-repo`` are supplied.
"""

from __future__ import annotations

import argparse
import json
import os
import random
import re
import time
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.parse import quote, urljoin

import requests
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry


IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp", ".bmp", ".tif", ".tiff"}
RETRYABLE_STATUS = (429, 500, 502, 503, 504)
ANGIOSPERM_MARKERS = (
    "angiosperm", "angiospermae", "magnoliophyta", "magnoliopsida",
    "liliopsida", "monocot", "eudicot", "eudicots", "asterids", "rosids",
    "commelinids", "alismatids", "liliidae", "magnoliidae",
)
PLANT_MARKERS = ("plantae", "plant kingdom", "viridiplantae")
SPECIES_RANKS = {"species", "subspecies", "variety", "forma", "form", "hybrid", "subsp.", "var."}


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
        total=7,
        connect=7,
        read=7,
        status=7,
        backoff_factor=1.0,
        status_forcelist=RETRYABLE_STATUS,
        allowed_methods=frozenset({"GET"}),
        respect_retry_after_header=True,
        raise_on_status=False,
    )
    adapter = HTTPAdapter(max_retries=retry, pool_connections=8, pool_maxsize=8)
    session = requests.Session()
    session.trust_env = False
    session.headers.update({"User-Agent": "FindFlower-Find10K-Auditor/1.0"})
    if hf_token:
        session.headers["Authorization"] = f"Bearer {hf_token}"
    session.mount("https://", adapter)
    session.mount("http://", adapter)
    return session


def _text(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, dict):
        return " ".join(_text(item) for item in value.values())
    if isinstance(value, (list, tuple)):
        return " ".join(_text(item) for item in value)
    return str(value)


def _norm(value: Any) -> str:
    return re.sub(r"[^a-z0-9]+", " ", _text(value).lower()).strip()


def lineage_text(row: dict[str, Any]) -> str:
    fields = (
        "lineage", "ancestry", "ancestors", "path", "taxonomy", "supercategory",
        "kingdom", "phylum", "class", "order", "family", "genus", "name",
        "scientific_name", "taxon_name",
    )
    return _norm(" ".join(_text(row.get(key)) for key in fields))


def flowering_evidence(row: dict[str, Any]) -> tuple[bool, str]:
    lineage = lineage_text(row)
    plant = next((marker for marker in PLANT_MARKERS if marker in lineage), None)
    angiosperm = next((marker for marker in ANGIOSPERM_MARKERS if marker in lineage), None)
    if not plant:
        return False, "missing Plantae lineage evidence"
    if not angiosperm:
        return False, "missing angiosperm lineage evidence"
    rank = _norm(row.get("rank"))
    if rank and rank not in SPECIES_RANKS:
        return False, f"non-species rank: {rank}"
    return True, f"{plant}+{angiosperm}"


def safe_label(label: str) -> str:
    return re.sub(r"[^A-Za-z0-9._ -]+", "_", label).replace("/", "_").strip() or "unknown"


def class_name(row: dict[str, Any]) -> str:
    value = row.get("scientific") or row.get("scientific_name") or row.get("name")
    if not value:
        raise ValueError("taxonomy record has no scientific name")
    return str(value)


def load_taxonomy(path: Path) -> list[dict[str, Any]]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    rows = payload.get("classes", payload) if isinstance(payload, dict) else payload
    if not isinstance(rows, list) or not rows:
        raise ValueError(f"expected a non-empty class list in {path}")
    verified: list[dict[str, Any]] = []
    folders: dict[str, str] = {}
    for local_index, raw in enumerate(rows):
        if not isinstance(raw, dict):
            raise ValueError("the strict botanical taxonomy must contain full lineage records")
        row = dict(raw)
        name = class_name(row)
        valid, evidence = flowering_evidence(row)
        if not valid:
            raise ValueError(f"unverified taxonomy row {local_index} ({name}): {evidence}")
        folder = safe_label(name)
        if folder in folders and folders[folder] != name:
            raise ValueError(f"folder collision: {folders[folder]!r} and {name!r} -> {folder!r}")
        folders[folder] = name
        row.update({
            "local_index": local_index,
            "scientific_name": name,
            "folder": folder,
            "flowering_evidence": evidence,
        })
        verified.append(row)
    return verified


def download_taxonomy(
    session: requests.Session,
    repo_id: str,
    revision: str,
    path_in_repo: str,
    destination: Path,
) -> Path:
    url = f"https://huggingface.co/datasets/{repo_id}/resolve/{quote(revision, safe='')}/{quote(path_in_repo, safe='/')}"
    with session.get(url, timeout=(30, 180)) as response:
        response.raise_for_status()
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(response.content)
    return destination


def discover_taxonomy() -> Path | None:
    candidates = [
        Path("/kaggle/working/find10k/phase1/botanical_classes.json"),
        Path("/kaggle/working/find10k_phase1/botanical_classes.json"),
        Path(__file__).with_name("find10k_phase1") / "botanical_classes.json",
    ]
    for candidate in candidates:
        if candidate.is_file():
            return candidate
    input_root = Path("/kaggle/input")
    if input_root.is_dir():
        matches = list(input_root.glob("**/botanical_classes.json"))
        if matches:
            return matches[0]
    return None


def scan_repo_images(
    session: requests.Session,
    repo_id: str,
    revision: str,
    image_root: str,
) -> tuple[dict[str, list[str]], int]:
    encoded_root = quote(image_root.strip("/"), safe="/")
    api_root = f"https://huggingface.co/api/datasets/{repo_id}/tree/{quote(revision, safe='')}/{encoded_root}"
    url = api_root + "?recursive=true&expand=false&limit=1000"
    by_folder: dict[str, list[str]] = defaultdict(list)
    entries = 0
    page = 0
    prefix = image_root.strip("/") + "/"
    while url:
        with session.get(url, timeout=(30, 180)) as response:
            if response.status_code == 404:
                return {}, 0
            response.raise_for_status()
            payload = response.json()
            if not isinstance(payload, list):
                raise ValueError("unexpected Hugging Face tree response")
            for item in payload:
                path = str(item.get("path") or "")
                if item.get("type") != "file" or Path(path).suffix.lower() not in IMAGE_EXTENSIONS:
                    continue
                if not path.startswith(prefix):
                    continue
                relative = path[len(prefix):]
                if "/" not in relative:
                    continue
                folder = relative.split("/", 1)[0]
                by_folder[folder].append(path)
                entries += 1
            links = requests.utils.parse_header_links(response.headers.get("Link", ""))
            next_url = next((link.get("url") for link in links if link.get("rel") == "next"), None)
            url = urljoin(api_root, next_url) if next_url else None
        page += 1
        if page % 25 == 0:
            print(f"[scan] pages={page:,} image_files={entries:,} classes={len(by_folder):,}", flush=True)
    for paths in by_folder.values():
        paths.sort()
    return dict(by_folder), entries


def commit_folder_deletes(api: Any, repo_id: str, folders: list[str], image_root: str) -> None:
    from huggingface_hub import CommitOperationDelete

    for offset in range(0, len(folders), 100):
        batch = folders[offset:offset + 100]
        operations = [
            CommitOperationDelete(path_in_repo=f"{image_root.strip('/')}/{folder}", is_folder=True)
            for folder in batch
        ]
        for attempt in range(1, 8):
            try:
                api.create_commit(
                    repo_id=repo_id,
                    repo_type="dataset",
                    operations=operations,
                    commit_message=f"audit: purge non-flowering folders {offset + len(batch)}/{len(folders)}",
                )
                print(f"[purge] committed={offset + len(batch)}/{len(folders)}", flush=True)
                break
            except Exception as exc:
                if attempt == 7:
                    raise
                delay = min(300, 2 ** attempt + random.random() * 3)
                print(f"[purge] retry={attempt}/7 error={type(exc).__name__} wait={delay:.1f}s", flush=True)
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


def write_audit(
    destination: Path,
    repo_id: str,
    revision: str,
    image_root: str,
    target: int,
    verified: list[dict[str, Any]],
    by_folder: dict[str, list[str]],
    deleted: list[str],
) -> dict[str, Any]:
    expected = {row["folder"]: row for row in verified}
    per_class: dict[str, dict[str, Any]] = {}
    deficits: list[dict[str, Any]] = []
    excess: list[dict[str, Any]] = []
    for row in verified:
        folder = row["folder"]
        count = len(by_folder.get(folder, []))
        item = {
            "local_index": int(row["local_index"]),
            "folder": folder,
            "scientific_name": row["scientific_name"],
            "inat21_class_id": row.get("id", row["local_index"]),
            "inat_taxon_id": row.get("inat_taxon_id") or row.get("taxon_id"),
            "count": count,
            "target": target,
            "deficit": max(0, target - count),
            "excess": max(0, count - target),
            "flowering_evidence": row["flowering_evidence"],
        }
        per_class[folder] = item
        if item["deficit"]:
            deficits.append(item)
        if item["excess"]:
            excess.append(item)
    unexpected = [
        {"folder": folder, "count": len(paths), "reason": "not present in verified angiosperm taxonomy"}
        for folder, paths in sorted(by_folder.items()) if folder not in expected
    ]
    audit = {
        "schema_version": 1,
        "generated_at": utc_now(),
        "repo_id": repo_id,
        "revision": revision,
        "image_root": image_root.strip("/"),
        "target_per_class": target,
        "verified_flowering_species_count": len(verified),
        "materialized_verified_species_count": sum(item["count"] > 0 for item in per_class.values()),
        "balanced_species_count": sum(item["count"] == target for item in per_class.values()),
        "verified_image_count": sum(item["count"] for item in per_class.values()),
        "unexpected_folder_count": len(unexpected),
        "unexpected_image_count": sum(item["count"] for item in unexpected),
        "deleted_unexpected_folders": deleted,
        "per_class": per_class,
        "deficits": sorted(deficits, key=lambda item: (-item["deficit"], item["scientific_name"])),
        "excess": sorted(excess, key=lambda item: (-item["excess"], item["scientific_name"])),
        "unexpected_folders": unexpected,
        "ready_for_topoff": not unexpected,
    }
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text(json.dumps(audit, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return audit


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--repo-id", default=os.environ.get("HF_DATASET_REPO", "gsor56/findflower-find10k"))
    parser.add_argument("--revision", default="main")
    parser.add_argument("--image-root", default="images/train")
    parser.add_argument("--target-per-class", type=int, default=300)
    parser.add_argument("--botanical-classes", type=Path)
    parser.add_argument("--taxonomy-path-in-repo", default="pipeline/verified_botanical_classes.json")
    parser.add_argument("--output", type=Path, default=Path("/kaggle/working/flower_audit.json"))
    parser.add_argument("--audit-path-in-repo", default="flower_audit.json")
    parser.add_argument("--apply-delete", action="store_true")
    parser.add_argument("--confirm-repo", default="")
    parser.add_argument("--no-upload", action="store_true")
    args = parser.parse_args()

    if args.target_per_class <= 0:
        raise SystemExit("target-per-class must be positive")
    hf_token = token()
    if not hf_token:
        raise SystemExit("HF_TOKEN or the Kaggle credential dataset is required")
    session = build_session(hf_token)
    taxonomy_path = args.botanical_classes or discover_taxonomy()
    if taxonomy_path is None:
        taxonomy_path = args.output.parent / "verified_botanical_classes.json"
        download_taxonomy(session, args.repo_id, args.revision, args.taxonomy_path_in_repo, taxonomy_path)
    verified = load_taxonomy(taxonomy_path)
    print(f"[taxonomy] verified flowering species={len(verified):,}", flush=True)

    by_folder, total_files = scan_repo_images(session, args.repo_id, args.revision, args.image_root)
    expected = {row["folder"] for row in verified}
    unexpected = sorted(set(by_folder) - expected)
    print(
        f"[audit] image_files={total_files:,} folders={len(by_folder):,} "
        f"unexpected={len(unexpected):,}",
        flush=True,
    )

    deleted: list[str] = []
    from huggingface_hub import HfApi
    api = HfApi(token=hf_token)
    if args.apply_delete:
        if args.confirm_repo != args.repo_id:
            raise SystemExit("--confirm-repo must exactly match --repo-id before deletion")
        commit_folder_deletes(api, args.repo_id, unexpected, args.image_root)
        deleted = unexpected
        for folder in deleted:
            by_folder.pop(folder, None)
    elif unexpected:
        print("[safety] unexpected folders were quarantined in the audit; rerun with --apply-delete and --confirm-repo to purge", flush=True)

    audit = write_audit(
        args.output,
        args.repo_id,
        args.revision,
        args.image_root,
        args.target_per_class,
        verified,
        by_folder,
        deleted,
    )
    if not args.no_upload:
        upload_file_with_retry(
            api,
            args.repo_id,
            args.output,
            args.audit_path_in_repo,
            "audit: publish flowering dataset balance report",
        )
        # Publish the exact trusted taxonomy used by this audit so the top-off
        # worker can reproduce the folder map without relying on Kaggle output.
        upload_file_with_retry(
            api,
            args.repo_id,
            taxonomy_path,
            args.taxonomy_path_in_repo,
            "taxonomy: publish verified botanical classes",
        )
    print(json.dumps({
        "verified_species": audit["verified_flowering_species_count"],
        "balanced_species": audit["balanced_species_count"],
        "deficit_species": len(audit["deficits"]),
        "unexpected_folders": audit["unexpected_folder_count"],
        "audit": str(args.output),
    }, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
