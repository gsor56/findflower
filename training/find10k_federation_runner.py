#!/usr/bin/env python3
"""Kaggle entry point for sequential Find10K audit and 448px federation."""

from __future__ import annotations

import argparse
import importlib.util
import json
import os
import subprocess
import sys
import time
from pathlib import Path


AUDITOR_B64 = "__AUDITOR_B64__"
TOPOFF_B64 = "__TOPOFF_B64__"
DEFAULT_SHARD_INDEX = 0
DEFAULT_TOTAL_SHARDS = 1


def ensure(module: str, package: str) -> None:
    if importlib.util.find_spec(module) is None:
        subprocess.run([sys.executable, "-m", "pip", "install", "-q", package], check=True)


def bootstrap(work: Path, name: str, payload: str) -> Path:
    import base64
    path = work / name
    path.write_bytes(base64.b64decode(payload))
    return path


def token() -> str:
    value = (os.environ.get("HF_TOKEN") or "").strip()
    if value:
        return value
    root = Path("/kaggle/input")
    if root.is_dir():
        for path in root.glob("**/credential.txt"):
            try:
                value = path.read_text(encoding="utf-8").strip()
                if value.startswith("hf_"):
                    print(f"[auth] credential source={path}", flush=True)
                    return value
            except OSError:
                pass
    try:
        from kaggle_secrets import UserSecretsClient
        return (UserSecretsClient().get_secret("HF_TOKEN") or "").strip()
    except Exception:
        return ""


def taxonomy() -> Path:
    candidates = [
        Path("/kaggle/working/find10k/phase1/botanical_classes.json"),
        Path("/kaggle/working/find10k_phase1/botanical_classes.json"),
    ]
    for candidate in candidates:
        if candidate.is_file():
            return candidate
    root = Path("/kaggle/input")
    if root.is_dir():
        matches = list(root.glob("**/botanical_classes.json"))
        if matches:
            print(f"[taxonomy] attached artifact={matches[0]}", flush=True)
            return matches[0]
    raise SystemExit("[taxonomy] botanical_classes.json was not found in the Phase 3 kernel output")


def main() -> int:
    parser = argparse.ArgumentParser(description="Run one Find10K federation shard")
    parser.add_argument(
        "--shard-index",
        type=int,
        default=int(os.environ.get("FIND10K_SHARD_INDEX", str(DEFAULT_SHARD_INDEX))),
    )
    parser.add_argument(
        "--total-shards",
        type=int,
        default=int(os.environ.get("FIND10K_TOTAL_SHARDS", str(DEFAULT_TOTAL_SHARDS))),
    )
    args = parser.parse_args()
    if args.total_shards <= 0 or not 0 <= args.shard_index < args.total_shards:
        raise SystemExit("shard-index must be in [0, total-shards)")
    session_started = time.time()
    session_deadline = session_started + 41_000
    ensure("huggingface_hub", "huggingface_hub")
    ensure("PIL", "pillow")
    ensure("requests", "requests")
    ensure("cv2", "opencv-python-headless")
    ensure("hf_transfer", "hf_transfer")
    hf_token = token()
    if not hf_token:
        raise SystemExit("[auth] HF_TOKEN unavailable")
    os.environ["HF_TOKEN"] = hf_token
    repo_id = os.environ.get("HF_DATASET_REPO", "gsor56/findflower-find10k")
    work = Path("/kaggle/working/find10k-federation")
    work.mkdir(parents=True, exist_ok=True)
    auditor = bootstrap(work, "find10k_hf_slicer_auditor.py", AUDITOR_B64)
    topoff = bootstrap(work, "find10k_deficit_topoff_448.py", TOPOFF_B64)
    audit_path = work / "flower_audit.json"
    botanical_classes = taxonomy()
    from huggingface_hub import HfApi
    api = HfApi(token=hf_token)
    has_remote_audit = api.file_exists(
        repo_id=repo_id,
        filename="flower_audit.json",
        repo_type="dataset",
    )
    has_remote_taxonomy = api.file_exists(
        repo_id=repo_id,
        filename="pipeline/verified_botanical_classes.json",
        repo_type="dataset",
    )

    if has_remote_audit and has_remote_taxonomy:
        print("[stage 1/2] published audit and taxonomy found; skipping full repository scan", flush=True)
        audit_argument: list[str] = []
    else:
        print("[stage 1/2] auditing and purging non-flowering folders", flush=True)
        subprocess.run([
            sys.executable,
            str(auditor),
            "--repo-id", repo_id,
            "--botanical-classes", str(botanical_classes),
            "--output", str(audit_path),
            "--target-per-class", "300",
            "--apply-delete",
            "--confirm-repo", repo_id,
        ], check=True)
        audit_argument = ["--audit", str(audit_path)]

    remaining = session_deadline - time.time()
    if remaining <= 600:
        print(
            f"[time] audit consumed the session budget; remaining={remaining:.0f}s. "
            "Stage 2 will resume on the next run.",
            flush=True,
        )
        return 0

    print("[stage 2/2] migrating and topping off complete classes to 300 x 448px", flush=True)
    subprocess.run([
        sys.executable,
        str(topoff),
        "--repo-id", repo_id,
        "--target-per-class", "300",
        "--target-size", "448",
        "--commit-classes", "10",
        "--shard-index", str(args.shard_index),
        "--total-shards", str(args.total_shards),
        "--max-runtime-seconds", "41000",
        "--class-timeout-seconds", "90",
        # This is the absolute deadline for the entire Kaggle process, so time
        # spent installing dependencies and running Stage 1 is included.
        "--absolute-deadline-unix", str(session_deadline),
    ] + audit_argument, check=True)
    summary = {
        "status": "session_complete",
        "repo_id": repo_id,
        "audit": str(audit_path),
        "next_run_resumes_from_hub": True,
    }
    print(json.dumps(summary, indent=2), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
