#!/usr/bin/env python3
"""Master Kaggle entry point for Find10K Phases 1-3.

All large inputs stay remote or under ``/kaggle/input``. The runner downloads
only small taxonomy/config files and the model checkpoint required for the
Phase-1 artifact. Set ``INAT_TAXONOMY`` to an attached authoritative iNat21
taxonomy JSON (recommended), or ``INAT_TAXONOMY_URL`` to a remote copy. The
runner deliberately stops with a clear preflight error if lineage data is not
available; a bare alphabetic class list is unsafe for botanical slicing.
"""

from __future__ import annotations

import importlib.util
import json
import os
import subprocess
import sys
import tarfile
from pathlib import Path


def ensure(module: str, package: str) -> None:
    if importlib.util.find_spec(module) is None:
        subprocess.run([sys.executable, "-m", "pip", "install", "-q", "--no-deps", package], check=True)


ensure("huggingface_hub", "huggingface_hub")
ensure("PIL", "pillow")
ensure("cv2", "opencv-python-headless")
ensure("requests", "requests")
ensure("ijson", "ijson")

from huggingface_hub import HfApi, hf_hub_download  # noqa: E402


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


def discover_secret_file() -> Path | None:
    root = Path("/kaggle/input")
    if not root.is_dir():
        return None
    # Dataset mounts can be normalized to underscores or numeric names. Find
    # the exact credential file without assuming the mount directory spelling.
    for path in root.glob("**/credential.txt"):
        try:
            value = path.read_text(encoding="utf-8").strip()
            if value.startswith("hf_"):
                return path
        except OSError:
            continue
    return None


def find(name: str) -> Path | None:
    root = Path("/kaggle/input")
    if not root.is_dir():
        return None
    hits = list(root.glob(f"**/{name}"))
    return hits[0] if hits else None


def fetch_official_taxonomy(destination: Path) -> Path:
    """Stream the small metadata archive and retain only its category table."""
    import ijson
    import requests
    url = os.environ.get(
        "INAT_TAXONOMY_ARCHIVE_URL",
        "https://ml-inat-competition-datasets.s3.amazonaws.com/2021/train.json.tar.gz",
    )
    session = requests.Session()
    session.trust_env = False
    print(f"[taxonomy] streaming official metadata: {url}", flush=True)
    with session.get(url, stream=True, timeout=(30, 600)) as response:
        response.raise_for_status()
        response.raw.decode_content = True
        with tarfile.open(fileobj=response.raw, mode="r|gz") as archive:
            for member in archive:
                if not member.isfile() or not member.name.lower().endswith(".json"):
                    continue
                handle = archive.extractfile(member)
                if handle is None:
                    continue
                categories = list(ijson.items(handle, "categories.item"))
                if categories:
                    destination.write_text(json.dumps({"categories": categories}), encoding="utf-8")
                    print(f"[taxonomy] extracted {len(categories):,} categories", flush=True)
                    return destination
    raise SystemExit("[taxonomy] categories were not found in the official metadata archive")


def main() -> int:
    work = Path(os.environ.get("FIND10K_WORK", "/kaggle/working/find10k"))
    work.mkdir(parents=True, exist_ok=True)
    hf_token = token()
    if not hf_token:
        secret_path = discover_secret_file()
        if secret_path:
            hf_token = secret_path.read_text(encoding="utf-8").strip()
            print(f"[auth] credential discovered at {secret_path}", flush=True)
    if not hf_token:
        raise SystemExit("[auth] HF_TOKEN unavailable")
    api = HfApi(token=hf_token)
    model_repo = os.environ.get("HF_MODEL_REPO", "timm/eva02_large_patch14_clip_336.merged2b_ft_inat21")
    run_ingestion = os.environ.get("FIND10K_RUN_INGESTION", "1") == "1"
    if not run_ingestion:
        print("[preflight] Phase 1 is enabled; Phase 3 ingestion is explicitly disabled.")
    taxonomy = Path(os.environ["INAT_TAXONOMY"]) if os.environ.get("INAT_TAXONOMY") else find("categories.json")
    if not taxonomy and os.environ.get("INAT_TAXONOMY_URL"):
        import requests
        taxonomy = work / "taxonomy.json"
        with requests.get(os.environ["INAT_TAXONOMY_URL"], stream=True, timeout=(30, 120)) as response:
            response.raise_for_status()
            taxonomy.write_bytes(response.content)
    if not taxonomy or not taxonomy.is_file():
        taxonomy = fetch_official_taxonomy(work / "inat21_categories.json")
    model_config = Path(hf_hub_download(model_repo, "config.json", token=hf_token))
    config = json.loads(model_config.read_text(encoding="utf-8"))
    if int(config.get("num_classes", 0)) != 10_000:
        raise SystemExit("[preflight] EVA02 checkpoint config is not 10,000-way")
    checkpoint = None
    checkpoint_ref = os.environ.get("FIND10K_CHECKPOINT")
    if checkpoint_ref:
        checkpoint = Path(checkpoint_ref)
    elif os.environ.get("FIND10K_SLICE_CHECKPOINT", "0") == "1":
        checkpoint = Path(hf_hub_download(model_repo, "model.safetensors", token=hf_token))

    phase1 = Path(__file__).with_name("find10k_phase1_taxonomy.py")
    cmd = [sys.executable, str(phase1), "--taxonomy", str(taxonomy), "--model-config", str(model_config), "--output-dir", str(work / "phase1"), "--checkpoint-width", "10000"]
    if checkpoint:
        cmd += ["--checkpoint", str(checkpoint)]
    subprocess.run(cmd, check=True)
    phase1_out = work / "phase1"

    phase2_out = work / "phase2"
    phase2_out.mkdir(parents=True, exist_ok=True)
    predictions = find("predictions.jsonl")
    if predictions:
        phase2 = Path(__file__).with_name("find10k_phase2_audit.py")
        subprocess.run(
            [sys.executable, str(phase2), "--predictions", str(predictions), "--output-dir", str(phase2_out)],
            check=True,
        )
    else:
        status = {
            "status": "pending_predictions",
            "reason": "Phase 2 requires labeled validation predictions from the sliced EVA02 checkpoint.",
            "taxonomy_ready": True,
            "next_input": "predictions.jsonl",
        }
        (phase2_out / "phase2_status.json").write_text(json.dumps(status, indent=2), encoding="utf-8")
        print("[phase2] taxonomy is ready; baseline audit is pending predictions.jsonl", flush=True)

    phase3 = Path(__file__).with_name("find10k_phase3_ingestion.py")
    ingest = [sys.executable, str(phase3), "--head-indices", str(phase1_out / "botanical_head_indices.json"), "--botanical-classes", str(phase1_out / "botanical_classes.json"), "--output", str(work / "ingestion")]
    if os.environ.get("HF_DATASET_REPO"):
        ingest += ["--dataset-repo", os.environ["HF_DATASET_REPO"]]
    if run_ingestion:
        subprocess.run(ingest, check=True)
    else:
        print("[preflight] skipping 240GB archive stream")
    print(f"[done] artifacts: {work}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
