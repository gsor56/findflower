#!/usr/bin/env python3
"""Audit Find10K federation checkpoints without scanning image payloads."""

from __future__ import annotations

import json
import os
from datetime import datetime, timedelta, timezone
from pathlib import Path

import requests


REPO = os.environ.get("HF_DATASET_REPO", "gsor56/findflower-find10k")
BASE = f"https://huggingface.co/datasets/{REPO}/resolve/main/"
SHARDS = range(5)


def get_json(path: str) -> dict:
    response = requests.get(BASE + path, timeout=45)
    if response.status_code == 404:
        return {}
    response.raise_for_status()
    payload = response.json()
    if not isinstance(payload, dict):
        raise ValueError(f"expected object at {path}")
    return payload


def parse_time(value: object) -> datetime | None:
    if not isinstance(value, str) or not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


def main() -> int:
    now = datetime.now(timezone.utc)
    since = now - timedelta(hours=24)
    per_shard: list[dict] = []
    all_completed: dict[str, dict] = {}
    new_classes: set[str] = set()
    total_images = 0

    for index in SHARDS:
        progress = get_json(f"pipeline/federation/progress_shard_{index}.json")
        stop = get_json(f"pipeline/federation/stop_shard_{index}.json")
        failures = get_json(f"pipeline/federation/failures_shard_{index}.json")
        completed = progress.get("completed", {})
        if not isinstance(completed, dict):
            completed = {}
        shard_images = 0
        shard_new = 0
        for folder, state in completed.items():
            state = state if isinstance(state, dict) else {}
            count = int(state.get("count") or 0)
            shard_images += count
            all_completed.setdefault(folder, state)
            completed_at = parse_time(state.get("completed_at"))
            if completed_at and completed_at >= since:
                new_classes.add(folder)
                shard_new += 1
        total_images += shard_images
        per_shard.append({
            "shard": index,
            "classes": len(completed),
            "images": shard_images,
            "new_24h": shard_new,
            "failures": len(failures.get("failures", {})) if isinstance(failures.get("failures", {}), dict) else 0,
            "stop_reason": stop.get("reason", "missing"),
            "stop_at": stop.get("stopped_at"),
        })

    audit = get_json("flower_audit.json")
    per_class = audit.get("per_class", {})
    base_complete = {
        folder for folder, row in per_class.items()
        if isinstance(row, dict) and int(row.get("deficit") or 0) == 0
    } if isinstance(per_class, dict) else set()
    completed_union = base_complete | set(all_completed)
    overlap = base_complete & set(all_completed)

    print(json.dumps({
        "repo": REPO,
        "observed_at": now.isoformat().replace("+00:00", "Z"),
        "window_start": since.isoformat().replace("+00:00", "Z"),
        "shards": per_shard,
        "base_complete_classes": len(base_complete),
        "shard_union_completed_classes": len(all_completed),
        "base_shard_overlap_classes": len(overlap),
        "union_completed_classes": len(completed_union),
        "remaining_classes": max(0, len(per_class) - len(completed_union)) if isinstance(per_class, dict) else None,
        "new_unique_classes_last_24h": len(new_classes),
        "images_in_shard_progress": total_images,
        "taxonomy_classes": len(per_class) if isinstance(per_class, dict) else None,
        "base_audit_deficit_classes": sum(1 for row in per_class.values() if isinstance(row, dict) and int(row.get("deficit") or 0) > 0) if isinstance(per_class, dict) else None,
    }, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
