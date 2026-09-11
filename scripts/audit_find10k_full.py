#!/usr/bin/env python3
"""One-time full Hugging Face verification for the Find10K dataset.

Run this after all federation shards finish. It performs the expensive
recursive Hub listing that active workers intentionally skip, counts every
class directory, verifies the exact target resolution for sampled or all
images, and writes a JSON report locally.
"""

from __future__ import annotations

import argparse
import io
import json
import os
from collections import defaultdict
from pathlib import Path
from typing import Any

from huggingface_hub import HfApi, hf_hub_download
from PIL import Image

IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp", ".bmp", ".tif", ".tiff"}


def token() -> str:
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
            pass
    raise SystemExit("HF_TOKEN is required via the environment or credential file")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--repo-id", default="gsor56/findflower-find10k")
    parser.add_argument("--revision", default="main")
    parser.add_argument("--image-root", default="images/train")
    parser.add_argument("--target-per-class", type=int, default=300)
    parser.add_argument("--target-size", type=int, default=448)
    parser.add_argument("--sample-per-class", type=int, default=1)
    parser.add_argument("--output", type=Path, default=Path("find10k_full_audit.json"))
    args = parser.parse_args()
    if args.target_per_class <= 0 or args.target_size <= 0 or args.sample_per_class < 0:
        raise SystemExit("target and sample values must be non-negative/positive")

    api = HfApi(token=token())
    counts: dict[str, int] = defaultdict(int)
    paths_by_class: dict[str, list[str]] = defaultdict(list)
    prefix = args.image_root.strip("/") + "/"
    for entry in api.list_repo_tree(
        repo_id=args.repo_id,
        repo_type="dataset",
        path_in_repo=args.image_root.strip("/"),
        recursive=True,
        expand=False,
        revision=args.revision,
    ):
        path = str(getattr(entry, "path", "") or "")
        if getattr(entry, "type", "file") != "file" or not path.startswith(prefix):
            continue
        if Path(path).suffix.lower() not in IMAGE_EXTENSIONS:
            continue
        relative = path[len(prefix):]
        if "/" not in relative:
            continue
        folder = relative.split("/", 1)[0]
        counts[folder] += 1
        if len(paths_by_class[folder]) < args.sample_per_class:
            paths_by_class[folder].append(path)

    incomplete = {
        folder: {
            "count": count,
            "deficit": max(0, args.target_per_class - count),
            "excess": max(0, count - args.target_per_class),
        }
        for folder, count in sorted(counts.items())
        if count != args.target_per_class
    }
    sampled = []
    for folder, paths in sorted(paths_by_class.items()):
        for path in paths:
            try:
                info = hf_hub_download(
                    repo_id=args.repo_id,
                    filename=path,
                    repo_type="dataset",
                    revision=args.revision,
                )
                with Image.open(io.BytesIO(Path(info).read_bytes())) as image:
                    sampled.append({
                        "folder": folder,
                        "path": path,
                        "size": list(image.size),
                        "is_target_size": image.size == (args.target_size, args.target_size),
                    })
            except Exception as exc:
                sampled.append({"folder": folder, "path": path, "error": type(exc).__name__})

    report: dict[str, Any] = {
        "repo_id": args.repo_id,
        "revision": args.revision,
        "image_root": args.image_root,
        "target_per_class": args.target_per_class,
        "target_size": [args.target_size, args.target_size],
        "class_count": len(counts),
        "total_images": sum(counts.values()),
        "balanced_class_count": sum(1 for count in counts.values() if count == args.target_per_class),
        "incomplete_classes": incomplete,
        "sampled_images": sampled,
        "status": "complete" if not incomplete and all(item.get("is_target_size", False) for item in sampled) else "partial",
    }
    args.output.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(json.dumps({
        "class_count": report["class_count"],
        "balanced_class_count": report["balanced_class_count"],
        "total_images": report["total_images"],
        "incomplete_classes": len(incomplete),
        "status": report["status"],
        "output": str(args.output),
    }, indent=2))
    return 0 if report["status"] == "complete" else 1


if __name__ == "__main__":
    raise SystemExit(main())
