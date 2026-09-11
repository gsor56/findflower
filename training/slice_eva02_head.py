#!/usr/bin/env python3
"""Build the 3,969-class Flora-Ultra EVA-02 model on a remote worker.

The source backbone is left intact. Only the 10,000-way iNaturalist classifier
is replaced with an ordered subset containing the verified flowering taxa.
The completed artifact is validated locally before one atomic Hub commit
replaces the stale model files in ``gsor56/Flora-Ultra``.
"""

from __future__ import annotations

import gc
import hashlib
import json
import os
import random
import shutil
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


SOURCE_REPO = "timm/eva02_large_patch14_clip_336.merged2b_ft_inat21"
SOURCE_MODEL = "eva02_large_patch14_clip_336.merged2b_ft_inat21"
MODEL_ARCH = "eva02_large_patch14_clip_336"
TARGET_REPO = "gsor56/Flora-Ultra"
TAXONOMY_REPO = "gsor56/findflower-find10k"
TAXONOMY_PATH = "pipeline/verified_botanical_classes.json"
EXPECTED_SOURCE_CLASSES = 10_000
EXPECTED_TARGET_CLASSES = 3_969
EXPECTED_FEATURES = 1_024
EXPECTED_IMAGE_SIZE = 336


def ensure(module: str, package: str) -> None:
    try:
        __import__(module)
    except ImportError:
        subprocess.run(
            [sys.executable, "-m", "pip", "install", "-q", "--upgrade", package],
            check=True,
        )


def token() -> str:
    for key in ("HF_TOKEN", "HUGGINGFACE_TOKEN", "HF_ACCESS_TOKEN"):
        value = (os.environ.get(key) or "").strip()
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
    # Kaggle may mount a dataset under a versioned or normalized directory
    # name. Search only text files and accept a value only when it has the Hub
    # token prefix; the secret itself is never printed.
    input_root = Path("/kaggle/input")
    if input_root.is_dir():
        for path in input_root.rglob("*.txt"):
            try:
                value = path.read_text(encoding="utf-8").strip()
            except OSError:
                continue
            if value.startswith("hf_"):
                return value
    try:
        from kaggle_secrets import UserSecretsClient

        client = UserSecretsClient()
        for key in ("HF_TOKEN", "HUGGINGFACE_TOKEN", "HF_ACCESS_TOKEN"):
            value = (client.get_secret(key) or "").strip()
            if value:
                return value
    except Exception:
        return ""
    return ""


def utc_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(8 * 1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def retry(operation: Any, label: str, attempts: int = 5) -> Any:
    for attempt in range(1, attempts + 1):
        try:
            return operation()
        except Exception as exc:
            if attempt == attempts:
                raise
            delay = min(90.0, (2 ** attempt) + random.uniform(0, 3))
            print(
                f"[{label}] retry={attempt}/{attempts} "
                f"error={type(exc).__name__} wait={delay:.1f}s",
                flush=True,
            )
            time.sleep(delay)


def main() -> int:
    ensure("huggingface_hub", "huggingface_hub>=0.34.0")
    ensure("safetensors", "safetensors>=0.4.5")
    ensure("timm", "timm>=1.0.15")

    import torch
    import torch.nn as nn
    import timm
    from huggingface_hub import (
        CommitOperationAdd,
        CommitOperationDelete,
        HfApi,
        hf_hub_download,
    )
    from safetensors.torch import save_file

    hf_token = token()
    if not hf_token:
        raise SystemExit("HF_TOKEN or the attached credential dataset is required")
    os.environ["HF_TOKEN"] = hf_token
    os.environ.setdefault("HF_HUB_ENABLE_HF_TRANSFER", "1")

    work = Path("/kaggle/working/flora-ultra-eva02")
    stage = work / "publish"
    shutil.rmtree(work, ignore_errors=True)
    stage.mkdir(parents=True, exist_ok=True)

    api = HfApi(token=hf_token)
    identity = api.whoami()
    role = (((identity.get("auth") or {}).get("accessToken") or {}).get("role") or "")
    if role == "read":
        raise SystemExit("The configured Hugging Face token is read-only")
    api.create_repo(TARGET_REPO, repo_type="model", private=True, exist_ok=True)
    print(f"[auth] write-capable identity verified for {TARGET_REPO}", flush=True)

    taxonomy_file = retry(
        lambda: hf_hub_download(
            repo_id=TAXONOMY_REPO,
            repo_type="dataset",
            filename=TAXONOMY_PATH,
            token=hf_token,
        ),
        "taxonomy",
    )
    source_config_file = retry(
        lambda: hf_hub_download(
            repo_id=SOURCE_REPO,
            filename="config.json",
            token=hf_token,
        ),
        "source-config",
    )
    source_weights_file = retry(
        lambda: hf_hub_download(
            repo_id=SOURCE_REPO,
            filename="model.safetensors",
            token=hf_token,
        ),
        "source-weights",
    )
    taxonomy = json.loads(Path(taxonomy_file).read_text(encoding="utf-8"))
    source_config = json.loads(Path(source_config_file).read_text(encoding="utf-8"))
    source_labels = source_config.get("label_names") or []

    if len(source_labels) != EXPECTED_SOURCE_CLASSES:
        raise SystemExit(f"source label count is {len(source_labels)}, expected 10,000")
    if not isinstance(taxonomy, list) or len(taxonomy) != EXPECTED_TARGET_CLASSES:
        raise SystemExit(f"taxonomy count is {len(taxonomy)}, expected 3,969")

    source_indices: list[int] = []
    class_names: list[str] = []
    for local_index, row in enumerate(taxonomy):
        if not isinstance(row, dict):
            raise SystemExit(f"taxonomy row {local_index} is not an object")
        source_index = int(row["id"])
        name = str(row["name"])
        if row.get("kingdom") != "Plantae":
            raise SystemExit(f"non-Plantae taxonomy row: {name}")
        if str(row.get("class")) not in {"Magnoliopsida", "Liliopsida"}:
            raise SystemExit(f"non-angiosperm taxonomy class for {name}: {row.get('class')}")
        if not 0 <= source_index < EXPECTED_SOURCE_CLASSES:
            raise SystemExit(f"source index out of range for {name}: {source_index}")
        if source_labels[source_index] != name:
            raise SystemExit(
                f"taxonomy/source label mismatch at {source_index}: "
                f"{name!r} != {source_labels[source_index]!r}"
            )
        source_indices.append(source_index)
        class_names.append(name)

    if len(set(source_indices)) != EXPECTED_TARGET_CLASSES:
        raise SystemExit("taxonomy contains duplicate classifier indices")
    if source_indices != sorted(source_indices):
        raise SystemExit("taxonomy indices are not in source classifier order")
    print(
        f"[taxonomy] exact mapping verified: source=10,000 retained={len(source_indices):,} "
        f"removed={EXPECTED_SOURCE_CLASSES - len(source_indices):,}",
        flush=True,
    )

    print(f"[model] constructing {MODEL_ARCH} through timm", flush=True)
    model = retry(
        lambda: timm.create_model(
            MODEL_ARCH,
            pretrained=False,
            num_classes=EXPECTED_SOURCE_CLASSES,
        ),
        "model",
    )
    print(f"[model] loading source weights from {SOURCE_REPO}", flush=True)
    from safetensors.torch import load_file

    source_state = load_file(str(source_weights_file), device="cpu")
    load_result = model.load_state_dict(source_state, strict=False)
    unexpected = list(load_result.unexpected_keys)
    missing = list(load_result.missing_keys)
    if missing or unexpected:
        raise SystemExit(
            f"source checkpoint/model mismatch: missing={missing[:8]} "
            f"unexpected={unexpected[:8]}"
        )
    del source_state
    classifier = model.get_classifier()
    if not isinstance(classifier, nn.Linear):
        raise SystemExit(f"expected nn.Linear classifier, found {type(classifier).__name__}")
    if classifier.out_features != EXPECTED_SOURCE_CLASSES:
        raise SystemExit(
            f"source head has {classifier.out_features} outputs, expected 10,000"
        )
    if classifier.in_features != EXPECTED_FEATURES:
        raise SystemExit(
            f"source feature width is {classifier.in_features}, expected 1,024"
        )

    index_tensor = torch.tensor(source_indices, dtype=torch.long)
    retained_weight = classifier.weight.detach().cpu().index_select(0, index_tensor).clone()
    retained_bias = (
        classifier.bias.detach().cpu().index_select(0, index_tensor).clone()
        if classifier.bias is not None
        else None
    )
    model.reset_classifier(EXPECTED_TARGET_CLASSES)
    sliced_classifier = model.get_classifier()
    if not isinstance(sliced_classifier, nn.Linear):
        raise SystemExit("reset_classifier did not produce an nn.Linear head")
    with torch.no_grad():
        sliced_classifier.weight.copy_(retained_weight)
        if retained_bias is not None:
            if sliced_classifier.bias is None:
                raise SystemExit("source has bias but sliced classifier does not")
            sliced_classifier.bias.copy_(retained_bias)

    if not torch.equal(sliced_classifier.weight.detach().cpu(), retained_weight):
        raise SystemExit("classifier weight equivalence check failed")
    if retained_bias is not None and not torch.equal(
        sliced_classifier.bias.detach().cpu(), retained_bias
    ):
        raise SystemExit("classifier bias equivalence check failed")
    if sliced_classifier.out_features != EXPECTED_TARGET_CLASSES:
        raise SystemExit("sliced classifier width verification failed")
    print(
        f"[model] head sliced safely: [10000, {EXPECTED_FEATURES}] -> "
        f"[{EXPECTED_TARGET_CLASSES}, {EXPECTED_FEATURES}]",
        flush=True,
    )

    state = {
        key: value.detach().cpu().contiguous()
        for key, value in model.state_dict().items()
    }
    weights_path = stage / "model.safetensors"
    save_file(state, str(weights_path), metadata={"format": "pt"})
    del state, model, classifier, sliced_classifier, retained_weight, retained_bias
    gc.collect()

    target_config = dict(source_config)
    target_config.update({
        "architecture": MODEL_ARCH,
        "num_classes": EXPECTED_TARGET_CLASSES,
        "num_features": EXPECTED_FEATURES,
        "label_names": class_names,
        "source_model": SOURCE_REPO,
        "source_num_classes": EXPECTED_SOURCE_CLASSES,
        "source_classifier_indices": "source_indices.json",
        "input_size": [3, EXPECTED_IMAGE_SIZE, EXPECTED_IMAGE_SIZE],
    })
    target_config["pretrained_cfg"] = dict(target_config.get("pretrained_cfg") or {})
    target_config["pretrained_cfg"]["num_classes"] = EXPECTED_TARGET_CLASSES
    target_config.pop("label_descriptions", None)
    (stage / "config.json").write_text(
        json.dumps(target_config, indent=2, ensure_ascii=True) + "\n",
        encoding="utf-8",
    )
    (stage / "class_names.json").write_text(
        json.dumps(class_names, indent=2, ensure_ascii=True) + "\n",
        encoding="utf-8",
    )
    (stage / "source_indices.json").write_text(
        json.dumps(source_indices, indent=2) + "\n",
        encoding="utf-8",
    )
    label_mapping = {
        "id2label": {str(i): name for i, name in enumerate(class_names)},
        "label2id": {name: i for i, name in enumerate(class_names)},
        "local_to_inat21_index": {str(i): source for i, source in enumerate(source_indices)},
    }
    (stage / "label_mapping.json").write_text(
        json.dumps(label_mapping, indent=2, ensure_ascii=True) + "\n",
        encoding="utf-8",
    )
    preprocessor = {
        "input_size": [3, EXPECTED_IMAGE_SIZE, EXPECTED_IMAGE_SIZE],
        "size": {"height": EXPECTED_IMAGE_SIZE, "width": EXPECTED_IMAGE_SIZE},
        "crop_pct": 1.0,
        "interpolation": "bicubic",
        "mean": [0.48145466, 0.4578275, 0.40821073],
        "std": [0.26862954, 0.26130258, 0.27577711],
    }
    (stage / "preprocessor_config.json").write_text(
        json.dumps(preprocessor, indent=2) + "\n", encoding="utf-8"
    )
    manifest = {
        "schema_version": 1,
        "generated_at": utc_now(),
        "model_name": "Flora-Ultra",
        "architecture": "eva02_large_patch14_clip_336",
        "library": "timm",
        "source_model": SOURCE_REPO,
        "source_classes": EXPECTED_SOURCE_CLASSES,
        "flowering_classes": EXPECTED_TARGET_CLASSES,
        "removed_non_flower_rows": EXPECTED_SOURCE_CLASSES - EXPECTED_TARGET_CLASSES,
        "feature_width": EXPECTED_FEATURES,
        "image_size": EXPECTED_IMAGE_SIZE,
        "taxonomy_source": f"{TAXONOMY_REPO}/{TAXONOMY_PATH}",
        "weights_sha256": sha256(weights_path),
        "head_rows_copied_without_reinitialization": True,
        "training_status": "pretrained botanical baseline; not yet fine-tuned on Find10K",
    }
    (stage / "manifest.json").write_text(
        json.dumps(manifest, indent=2) + "\n", encoding="utf-8"
    )
    (stage / "README.md").write_text(
        """---
library_name: timm
pipeline_tag: image-classification
license: cc-by-nc-4.0
tags:
- eva02
- inaturalist
- botanical-identification
- findflower
---

# Flora-Ultra

Flora-Ultra is FindFlower's flowering-plant classifier operated by **gsor56**.
It preserves the complete EVA-02 Large backbone from
`timm/eva02_large_patch14_clip_336.merged2b_ft_inat21` and retains only the
3,969 verified flowering-plant classifier rows from its original 10,000-class
iNaturalist 2021 head.

- Architecture: EVA-02 Large Patch14 CLIP at 336px
- Framework: `timm`
- Output classes: 3,969 flowering taxa
- Feature width: 1,024
- Removed classifier rows: 6,031 non-flowering taxa
- Dataset: https://huggingface.co/datasets/gsor56/findflower-find10k
- Product: https://findflower.me/

The retained classifier rows are copied directly from the source checkpoint;
they are not randomly initialized. This revision is the botanical pretrained
baseline and is ready for Find10K fine-tuning.

## Limitations

This model always returns a flowering-plant label. Applications should use a
separate out-of-domain check when users may submit animals, fungi, objects, or
other non-flowering content. Predictions are identification aids, not a
substitute for expert botanical determination.
""",
        encoding="utf-8",
    )

    expected_files = {
        "README.md",
        "class_names.json",
        "config.json",
        "label_mapping.json",
        "manifest.json",
        "model.safetensors",
        "preprocessor_config.json",
        "source_indices.json",
    }
    produced = {path.name for path in stage.iterdir() if path.is_file()}
    if produced != expected_files:
        raise SystemExit(f"staging file mismatch: {sorted(produced)}")

    existing = set(api.list_repo_files(TARGET_REPO, repo_type="model"))
    obsolete_suffixes = (".pth", ".pt", ".onnx", ".bin", ".ckpt")
    obsolete = sorted(
        path for path in existing
        if path not in expected_files
        and path != ".gitattributes"
        and (path != ".preflight" or path.endswith(obsolete_suffixes))
    )
    operations = [
        CommitOperationDelete(path_in_repo=path, is_folder=False)
        for path in obsolete
    ]
    operations.extend(
        CommitOperationAdd(path_in_repo=path.name, path_or_fileobj=str(path))
        for path in sorted(stage.iterdir())
        if path.is_file()
    )

    print(
        f"[upload] atomic replacement files={len(expected_files)} "
        f"obsolete_current_files={len(obsolete)} weights_bytes={weights_path.stat().st_size:,}",
        flush=True,
    )
    retry(
        lambda: api.create_commit(
            repo_id=TARGET_REPO,
            repo_type="model",
            operations=operations,
            commit_message="model: install EVA-02 Large 3,969-class botanical baseline",
        ),
        "upload",
        attempts=4,
    )

    remote_files = set(api.list_repo_files(TARGET_REPO, repo_type="model"))
    missing = expected_files - remote_files
    if missing:
        raise SystemExit(f"remote verification failed; missing files: {sorted(missing)}")
    remote_config = json.loads(
        Path(
            hf_hub_download(
                repo_id=TARGET_REPO,
                filename="config.json",
                token=hf_token,
                force_download=True,
            )
        ).read_text(encoding="utf-8")
    )
    if remote_config.get("architecture") != "eva02_large_patch14_clip_336":
        raise SystemExit("remote architecture verification failed")
    if int(remote_config.get("num_classes") or 0) != EXPECTED_TARGET_CLASSES:
        raise SystemExit("remote class-count verification failed")
    print(
        json.dumps(
            {
                "status": "complete",
                "repo": TARGET_REPO,
                "architecture": remote_config["architecture"],
                "num_classes": remote_config["num_classes"],
                "features": remote_config["num_features"],
                "weights_sha256": manifest["weights_sha256"],
                "removed_non_flower_rows": manifest["removed_non_flower_rows"],
            },
            indent=2,
        ),
        flush=True,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
