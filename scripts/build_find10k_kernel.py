#!/usr/bin/env python3
"""Build a self-contained Kaggle script package for Find10K Phases 1-3."""

from __future__ import annotations

import base64
import json
import shutil
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "training"
PACKAGE = ROOT / "training" / "find10k-kernel"


def main() -> int:
    PACKAGE.mkdir(parents=True, exist_ok=True)
    phase1 = (SOURCE / "find10k_phase1_taxonomy.py").read_bytes()
    phase2 = (SOURCE / "find10k_phase2_audit.py").read_bytes()
    phase3 = (SOURCE / "find10k_phase3_ingestion.py").read_bytes()
    runner = (SOURCE / "find10k_kaggle_runner.py").read_text(encoding="utf-8")
    runner = runner.replace(
        'phase1 = Path(__file__).with_name("find10k_phase1_taxonomy.py")',
        'phase1 = bootstrap_source(work, "find10k_phase1_taxonomy.py", PHASE1_B64)',
    ).replace(
        'phase2 = Path(__file__).with_name("find10k_phase2_audit.py")',
        'phase2 = bootstrap_source(work, "find10k_phase2_audit.py", PHASE2_B64)',
    ).replace(
        'phase3 = Path(__file__).with_name("find10k_phase3_ingestion.py")',
        'phase3 = bootstrap_source(work, "find10k_phase3_ingestion.py", PHASE3_B64)',
    )
    # The Kaggle script kernel only receives the generated runner. Ensure its
    # source has the latest authentication/path fixes before packaging.
    preamble = (
        "\nPHASE1_B64 = " + repr(base64.b64encode(phase1).decode("ascii")) +
        "\nPHASE2_B64 = " + repr(base64.b64encode(phase2).decode("ascii")) +
        "\nPHASE3_B64 = " + repr(base64.b64encode(phase3).decode("ascii")) +
        "\n\ndef bootstrap_source(work: Path, name: str, encoded: str) -> Path:\n"
        "    path = work / name\n"
        "    path.write_bytes(__import__('base64').b64decode(encoded))\n"
        "    return path\n"
    )
    marker = "from huggingface_hub import HfApi, hf_hub_download  # noqa: E402\n"
    runner = runner.replace(marker, marker + preamble)
    (PACKAGE / "find10k_kaggle_runner.py").write_text(runner, encoding="utf-8")
    metadata = json.loads((SOURCE / "find10k-kernel-metadata.json").read_text(encoding="utf-8"))
    metadata["code_file"] = "find10k_kaggle_runner.py"
    (PACKAGE / "kernel-metadata.json").write_text(json.dumps(metadata, indent=2) + "\n", encoding="utf-8")
    print(f"built {PACKAGE}")
    print(f"code bytes: {(PACKAGE / 'find10k_kaggle_runner.py').stat().st_size:,}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
