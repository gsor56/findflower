#!/usr/bin/env python3
"""Derive the flowering-plant head and optionally slice an iNat21 checkpoint.

This is intentionally a standalone Phase-1 utility. It does not download model
weights, modify the existing ViT-116 files, or guess a fixed botanical class
count. The taxonomy file must describe the same ordered labels used by the
10,000-way checkpoint. Accepted taxonomy shapes are a list of category objects,
``{"categories": [...]}``, or an index-to-name mapping.

Typical remote use::

    python find10k_phase1_taxonomy.py \
      --taxonomy /kaggle/input/inat21/categories.json \
      --checkpoint /kaggle/input/eva02/model.safetensors \
      --output-dir /kaggle/working/find10k_phase1

The script requires explicit lineage evidence for flowering plants. If a source
has only bare names and no Plantae/angiosperm ancestry, it stops rather than
silently classifying unrelated taxa as flowers.
"""

from __future__ import annotations

import argparse
import json
import re
from pathlib import Path
from typing import Any


ANGIOSPERM_MARKERS = (
    "angiosperm", "angiospermae", "magnoliophyta", "magnoliopsida",
    "liliopsida", "monocot", "eudicot", "eudicots", "asterids", "rosids",
    "commelinids", "alismatids", "liliidae", "magnoliidae",
)
PLANT_MARKERS = ("plantae", "plant kingdom", "viridiplantae")
SPECIES_RANKS = {"species", "subspecies", "variety", "forma", "subsp.", "var."}


def read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def _text(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, (list, tuple)):
        return " ".join(_text(x) for x in value)
    if isinstance(value, dict):
        return " ".join(_text(v) for v in value.values())
    return str(value)


def _norm(value: Any) -> str:
    return re.sub(r"[^a-z0-9]+", " ", _text(value).lower()).strip()


def read_categories(path: Path) -> list[dict[str, Any]]:
    obj = json.loads(path.read_text(encoding="utf-8"))
    if isinstance(obj, dict):
        for key in ("categories", "classes", "labels", "class_names", "taxa"):
            if isinstance(obj.get(key), list):
                obj = obj[key]
                break
        else:
            # Common format: {"0": "name", "1": "name", ...}
            if obj and all(str(k).isdigit() for k in obj):
                return [{"id": int(k), "name": obj[k]} for k in sorted(obj, key=lambda x: int(x))]
            raise ValueError(f"cannot find an ordered category list in {path}")
    if not isinstance(obj, list):
        raise ValueError(f"taxonomy must be a list or category mapping: {path}")
    result = []
    for index, row in enumerate(obj):
        if isinstance(row, dict):
            item = dict(row)
            item.setdefault("id", index)
            result.append(item)
        else:
            result.append({"id": index, "name": str(row)})
    if result and all(str(row.get("id", "")).isdigit() for row in result):
        result.sort(key=lambda row: int(row["id"]))
        ids = [int(row["id"]) for row in result]
        if ids != list(range(len(result))):
            raise ValueError("taxonomy category ids must be contiguous and zero-based")
    return result


def lineage_text(row: dict[str, Any]) -> str:
    fields = (
        "lineage", "ancestry", "ancestors", "path", "taxonomy", "supercategory",
        "kingdom", "phylum", "class", "order", "family", "genus", "name",
        "scientific_name", "taxon_name",
    )
    return _norm(" ".join(_text(row.get(key)) for key in fields))


def is_flowering(row: dict[str, Any]) -> tuple[bool, str]:
    lineage = lineage_text(row)
    if not any(marker in lineage for marker in PLANT_MARKERS):
        return False, "no Plantae lineage"
    marker = next((marker for marker in ANGIOSPERM_MARKERS if marker in lineage), None)
    if marker is None:
        return False, "no angiosperm lineage"
    rank = _norm(row.get("rank"))
    if rank and rank not in SPECIES_RANKS and any(x in rank for x in ("kingdom", "phylum", "class", "order", "family", "genus")):
        return False, "non-leaf taxon"
    return True, marker


def derive(categories: list[dict[str, Any]]) -> tuple[list[int], list[dict[str, Any]]]:
    selected, rejected = [], []
    for index, row in enumerate(categories):
        ok, reason = is_flowering(row)
        if ok:
            selected.append(index)
        else:
            rejected.append({"index": index, "name": row.get("name", row.get("scientific_name", "")), "reason": reason})
    if not selected:
        raise SystemExit("No flowering classes found; provide a taxonomy with Plantae + angiosperm ancestry")
    return selected, rejected


def classifier_keys(state: dict[str, Any], width: int) -> tuple[str, str | None]:
    weights = [(key, value) for key, value in state.items() if hasattr(value, "shape") and len(value.shape) == 2 and value.shape[0] == width]
    preferred = [x for x in weights if any(t in x[0].lower() for t in ("head", "classifier", "fc"))]
    if not preferred:
        preferred = weights
    if not preferred:
        raise KeyError(f"no [num_classes, hidden] classifier weight found (width={width})")
    weight_key, _ = sorted(preferred, key=lambda x: ("head" not in x[0].lower(), len(x[0])))[0]
    prefix = weight_key.rsplit(".weight", 1)[0]
    bias_key = prefix + ".bias"
    return weight_key, bias_key if bias_key in state else None


def extract_heads(checkpoint: Path, output_dir: Path, indices: list[int], width: int) -> dict[str, Any]:
    """Export small classifier-only artifacts, not duplicate backbone copies."""
    import torch
    state: dict[str, Any]
    is_safe = checkpoint.suffix.lower() == ".safetensors"
    if is_safe:
        from safetensors.torch import load_file, save_file
        state = load_file(str(checkpoint), device="cpu")
    else:
        obj = torch.load(checkpoint, map_location="cpu", weights_only=False)
        state = obj.get("state_dict", obj) if isinstance(obj, dict) else obj
        if not isinstance(state, dict):
            raise ValueError("checkpoint does not contain a state dict")
    weight_key, bias_key = classifier_keys(state, width)
    weight = state[weight_key]
    bias = state[bias_key] if bias_key else torch.zeros(width, dtype=weight.dtype)
    keep = torch.zeros(width, dtype=torch.bool)
    keep[indices] = True
    sliced = {"weight": weight[indices, :].contiguous(), "bias": bias[indices].contiguous()}
    zero_weight, zero_bias = weight.clone(), bias.clone()
    zero_weight[~keep] = 0
    zero_bias[~keep] = 0
    suppressed_bias = zero_bias.clone()
    suppressed_bias[~keep] = -1.0e4
    output_dir.mkdir(parents=True, exist_ok=True)
    artifacts = {
        "botanical_head.safetensors": sliced,
        "botanical_zeroed_full_head.safetensors": {"weight": zero_weight.contiguous(), "bias": zero_bias.contiguous()},
        "botanical_suppressed_full_head.safetensors": {"weight": zero_weight.contiguous(), "bias": suppressed_bias.contiguous()},
    }
    from safetensors.torch import save_file
    for name, tensors in artifacts.items():
        save_file(tensors, str(output_dir / name))
    return {
        "weight_key": weight_key,
        "bias_key": bias_key,
        "original_width": width,
        "sliced_width": len(indices),
        "active_rows": len(indices),
        "inactive_rows": width - len(indices),
        "artifacts": list(artifacts),
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--taxonomy", required=True, type=Path)
    ap.add_argument("--output-dir", required=True, type=Path)
    ap.add_argument("--checkpoint", type=Path)
    ap.add_argument("--checkpoint-width", type=int, default=10_000)
    ap.add_argument("--model-config", type=Path,
                    help="optional timm config.json used to verify taxonomy label order")
    args = ap.parse_args()
    categories = read_categories(args.taxonomy)
    if args.model_config:
        model_config = read_json(args.model_config)
        model_labels = model_config.get("label_names") or []
        taxonomy_labels = [str(row.get("name") or row.get("scientific_name") or "") for row in categories]
        if len(model_labels) != len(taxonomy_labels) or model_labels != taxonomy_labels:
            raise SystemExit("taxonomy order does not exactly match the EVA02 label_names order")
    indices, rejected = derive(categories)
    out = args.output_dir
    out.mkdir(parents=True, exist_ok=True)
    selected = [categories[i] for i in indices]
    (out / "botanical_head_indices.json").write_text(json.dumps(indices, indent=2), encoding="utf-8")
    (out / "botanical_classes.json").write_text(json.dumps(selected, indent=2), encoding="utf-8")
    (out / "botanical_class_map.json").write_text(
        json.dumps({str(local): int(global_id) for local, global_id in enumerate(indices)}, indent=2),
        encoding="utf-8",
    )
    report = {
        "taxonomy_source": str(args.taxonomy),
        "taxonomy_count": len(categories),
        "flowering_class_count": len(indices),
        "non_flowering_count": len(rejected),
        "indices_are_ordered": indices == sorted(indices),
        "rejected_sample": rejected[:25],
        "head_slicing": "not_requested",
    }
    if args.checkpoint:
        if not args.checkpoint.is_file():
            raise SystemExit(f"checkpoint not found: {args.checkpoint}")
        report["head_slicing"] = extract_heads(args.checkpoint, out, indices, args.checkpoint_width)
    (out / "botanical_model_config.json").write_text(json.dumps({
        "architecture": "eva02_large_patch14_clip_336",
        "source_num_classes": args.checkpoint_width,
        "num_classes": len(indices),
        "head_indices_in_source": indices,
        "label_map": "botanical_class_map.json",
        "full_head_mask_available": bool(args.checkpoint),
    }, indent=2), encoding="utf-8")
    (out / "taxonomy_report.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(json.dumps(report, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
