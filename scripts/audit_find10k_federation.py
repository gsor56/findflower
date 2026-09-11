#!/usr/bin/env python3
"""Audit recent Find10K federation commits directly on Hugging Face Hub."""

from __future__ import annotations

import argparse
import io
import json
import os
from pathlib import Path
from typing import Any

from huggingface_hub import HfApi, HfFileSystem
from huggingface_hub.errors import RepositoryNotFoundError
from PIL import Image


IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp", ".bmp", ".tif", ".tiff"}
PROGRESS_PATH = "pipeline/federation/progress.json"
STOP_PATH = "pipeline/federation/stop.json"


def token() -> str | None:
    value = (os.environ.get("HF_TOKEN") or "").strip()
    if value:
        return value
    for path in (
        Path("my-secrets/credential.txt"),
        Path("/kaggle/input/my-secrets/credential.txt"),
        Path("/kaggle/input/my_secrets/credential.txt"),
    ):
        try:
            value = path.read_text(encoding="utf-8").strip()
            if value:
                return value
        except OSError:
            continue
    return None


def fs_path(repo_id: str, path_in_repo: str) -> str:
    return f"datasets/{repo_id}/{path_in_repo}"


def load_json(fs: HfFileSystem, repo_id: str, path_in_repo: str) -> dict[str, Any]:
    payload = json.loads(fs.read_text(fs_path(repo_id, path_in_repo)))
    if not isinstance(payload, dict):
        raise TypeError(f"{path_in_repo} must contain a JSON object")
    return payload


def load_optional_json(
    fs: HfFileSystem,
    repo_id: str,
    path_in_repo: str,
) -> dict[str, Any] | None:
    path = fs_path(repo_id, path_in_repo)
    if not fs.exists(path):
        return None
    return load_json(fs, repo_id, path_in_repo)


def recent_completed(progress: dict[str, Any], limit: int) -> list[tuple[str, dict[str, Any]]]:
    completed = progress.get("completed") or {}
    if not isinstance(completed, dict):
        raise TypeError("progress.json completed must be an object")
    rows = [(str(folder), dict(state or {})) for folder, state in completed.items()]
    rows.sort(key=lambda item: str(item[1].get("completed_at") or ""), reverse=True)
    return rows[:limit]


def ingestion_fallback(
    audit: dict[str, Any],
    ingestion: dict[str, Any] | None,
    limit: int,
) -> list[tuple[str, dict[str, Any]]]:
    counts = (ingestion or {}).get("counts") or {}
    rows = []
    for item in (audit.get("per_class") or {}).values():
        class_id = int(item.get("inat21_class_id", -1))
        count = int(counts.get(str(class_id), item.get("count", 0)))
        if count < 300:
            continue
        rows.append((
            str(item["folder"]),
            {
                "count": count,
                "resolution": [224, 224],
                "completed_at": None,
                "source": "phase3_ingestion_fallback",
                "inat21_class_id": class_id,
            },
        ))
    rows.sort(key=lambda item: int(item[1]["inat21_class_id"]), reverse=True)
    return rows[:limit]


def image_paths(api: HfApi, repo_id: str, revision: str, folder: str) -> list[str]:
    root = f"images/train/{folder}"
    paths: list[str] = []
    for entry in api.list_repo_tree(
        repo_id=repo_id,
        repo_type="dataset",
        path_in_repo=root,
        recursive=True,
        expand=False,
        revision=revision,
    ):
        path = str(getattr(entry, "path", ""))
        if path and Path(path).suffix.lower() in IMAGE_EXTENSIONS:
            paths.append(path)
    return sorted(set(paths))


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--repo-id", default="gsor56/findflower-find10k")
    parser.add_argument("--revision", default="main")
    parser.add_argument("--sample-classes", type=int, default=5)
    args = parser.parse_args()
    if args.sample_classes <= 0:
        raise SystemExit("--sample-classes must be positive")

    auth = token()
    api = HfApi(token=auth)
    fs = HfFileSystem(token=auth)
    try:
        api.repo_info(args.repo_id, repo_type="dataset", revision=args.revision)
    except RepositoryNotFoundError as exc:
        raise SystemExit(f"dataset repository not found or inaccessible: {args.repo_id}") from exc

    progress = load_optional_json(fs, args.repo_id, PROGRESS_PATH)
    stop = load_optional_json(fs, args.repo_id, STOP_PATH) or {
        "status": "missing",
        "reason": f"{STOP_PATH} is not present",
    }

    if progress and progress.get("completed"):
        recent = recent_completed(progress, args.sample_classes)
        sample_source = "federation_progress"
    else:
        audit = load_json(fs, args.repo_id, "flower_audit.json")
        ingestion = load_optional_json(
            fs, args.repo_id, "pipeline/find10k_ingestion_progress.json"
        )
        recent = ingestion_fallback(audit, ingestion, args.sample_classes)
        sample_source = "phase3_ingestion_fallback"
    if not recent:
        raise SystemExit("no completed classes are available for sampling")

    samples: list[dict[str, Any]] = []
    first_image: str | None = None
    for folder, state in recent:
        paths = image_paths(api, args.repo_id, args.revision, folder)
        samples.append({
            "folder": folder,
            "hub_image_count": len(paths),
            "target_count": state.get("count"),
            "recorded_resolution": state.get("resolution"),
            "completed_at": state.get("completed_at"),
            "count_is_300": len(paths) == 300,
        })
        if first_image is None and paths:
            first_image = paths[0]

    if first_image is None:
        raise SystemExit("recent completed folders contain no downloadable images")
    with fs.open(fs_path(args.repo_id, first_image), "rb") as handle:
        sample_bytes = handle.read()
    with Image.open(io.BytesIO(sample_bytes)) as image:
        image_check = {
            "path": first_image,
            "format": image.format,
            "mode": image.mode,
            "width": image.width,
            "height": image.height,
            "is_448x448": image.size == (448, 448),
        }

    completed = (progress or {}).get("completed") or {}
    output = {
        "repo_id": args.repo_id,
        "revision": args.revision,
        "completed_class_count": len(completed),
        "federation_progress_exists": progress is not None,
        "journal_count": len((progress or {}).get("journals") or []),
        "record_shard_count": len((progress or {}).get("record_shards") or []),
        "sample_source": sample_source,
        "recent_class_checks": samples,
        "sample_image_check": image_check,
        "stopping_point": {
            "position": stop.get("position"),
            "total_classes": stop.get("total_classes"),
            "folder": stop.get("folder"),
            "reason": stop.get("reason"),
            "stopped_at": stop.get("stopped_at"),
        },
    }
    print(json.dumps(output, indent=2, sort_keys=True))

    if any(not row["count_is_300"] for row in samples):
        raise SystemExit("audit failed: at least one recent completed class is not exactly 300 images")
    if not image_check["is_448x448"]:
        raise SystemExit("audit failed: downloaded sample is not exactly 448x448")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
