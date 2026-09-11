#!/usr/bin/env python3
"""Build the self-contained CPU Kaggle federation kernel."""

from __future__ import annotations

import base64
import argparse
import json
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
TRAINING = ROOT / "training"
PACKAGE = TRAINING / "find10k-federation-kernel"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--shard-index", type=int, default=0)
    parser.add_argument("--total-shards", type=int, default=1)
    parser.add_argument("--output", type=Path, default=PACKAGE)
    parser.add_argument("--kernel-id", default=None)
    args = parser.parse_args()
    if args.total_shards <= 0 or not 0 <= args.shard_index < args.total_shards:
        raise SystemExit("shard-index must be in [0, total-shards)")
    package = args.output
    package.mkdir(parents=True, exist_ok=True)
    auditor = base64.b64encode((TRAINING / "find10k_hf_slicer_auditor.py").read_bytes()).decode("ascii")
    topoff = base64.b64encode((TRAINING / "find10k_deficit_topoff_448.py").read_bytes()).decode("ascii")
    runner = (TRAINING / "find10k_federation_runner.py").read_text(encoding="utf-8")
    runner = runner.replace('"__AUDITOR_B64__"', repr(auditor), 1)
    runner = runner.replace('"__TOPOFF_B64__"', repr(topoff), 1)
    runner = runner.replace("DEFAULT_SHARD_INDEX = 0", f"DEFAULT_SHARD_INDEX = {args.shard_index}", 1)
    runner = runner.replace("DEFAULT_TOTAL_SHARDS = 1", f"DEFAULT_TOTAL_SHARDS = {args.total_shards}", 1)
    (package / "find10k_federation_runner.py").write_text(runner, encoding="utf-8")
    metadata = json.loads((TRAINING / "find10k-federation-kernel-metadata.json").read_text(encoding="utf-8"))
    if args.kernel_id:
        metadata["id"] = args.kernel_id
        metadata["title"] = args.kernel_id.rsplit("/", 1)[-1]
    (package / "kernel-metadata.json").write_text(json.dumps(metadata, indent=2) + "\n", encoding="utf-8")
    print(f"built {package}")
    print(f"runner_bytes={(package / 'find10k_federation_runner.py').stat().st_size:,}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
