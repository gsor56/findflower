#!/usr/bin/env python3
"""Produce the Phase-2 staircase baseline audit from model predictions.

The heavy model evaluation is deliberately separated from reporting. A Kaggle
cell can emit JSONL rows with ``true_index``, ``pred_top1``, ``pred_top5`` and
``observation_count`` (or provide a logits ``.npy`` plus integer labels). This
tool then computes tiered Top-1/Top-5, macro recall, and a weak-class manifest
without loading EVA02 or downloading anything locally.
"""

from __future__ import annotations

import argparse
import json
from collections import defaultdict
from pathlib import Path
from typing import Any


def tier(count: int, common_cutoff: int, rare_cutoff: int) -> str:
    if count >= common_cutoff:
        return "A_extremely_common"
    if count >= rare_cutoff:
        return "B_common"
    return "C_rare_endemic"


def rows_from_jsonl(path: Path) -> list[dict[str, Any]]:
    rows = []
    with path.open(encoding="utf-8") as handle:
        for line_no, line in enumerate(handle, 1):
            if line.strip():
                row = json.loads(line)
                for key in ("true_index", "pred_top1"):
                    if key not in row:
                        raise ValueError(f"{path}:{line_no} lacks {key}")
                row.setdefault("pred_top5", [row["pred_top1"]])
                row.setdefault("observation_count", 0)
                row.setdefault("class_name", str(row["true_index"]))
                rows.append(row)
    return rows


def metrics(rows: list[dict[str, Any]], common_cutoff: int, rare_cutoff: int) -> tuple[dict, dict]:
    by_class = defaultdict(lambda: {"name": "", "n": 0, "top1": 0, "top5": 0, "observation_count": 0})
    for row in rows:
        key = int(row["true_index"])
        item = by_class[key]
        item["name"] = str(row.get("class_name", key))
        item["n"] += 1
        item["top1"] += int(int(row["pred_top1"]) == key)
        item["top5"] += int(key in {int(x) for x in row.get("pred_top5", [])})
        item["observation_count"] = max(item["observation_count"], int(row.get("observation_count", 0)))
    classes = []
    for key, item in sorted(by_class.items()):
        item["top1_accuracy"] = item["top1"] / item["n"]
        item["top5_accuracy"] = item["top5"] / item["n"]
        item["tier"] = tier(item["observation_count"], common_cutoff, rare_cutoff)
        classes.append({"index": key, **item})
    grouped = defaultdict(list)
    for item in classes:
        grouped[item["tier"]].append(item)
    tier_metrics = {}
    for name, group in grouped.items():
        tier_metrics[name] = {
            "classes_evaluated": len(group),
            "images_evaluated": sum(x["n"] for x in group),
            "top1": sum(x["top1"] for x in group) / max(1, sum(x["n"] for x in group)),
            "top5": sum(x["top5"] for x in group) / max(1, sum(x["n"] for x in group)),
            "macro_recall": sum(x["top1_accuracy"] for x in group) / max(1, len(group)),
        }
    return tier_metrics, {str(x["index"]): x for x in classes}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--predictions", required=True, type=Path, help="JSONL prediction rows")
    ap.add_argument("--output-dir", required=True, type=Path)
    ap.add_argument("--common-cutoff", type=int, default=100_000)
    ap.add_argument("--rare-cutoff", type=int, default=10_000)
    ap.add_argument("--weak-threshold", type=float, default=0.90)
    args = ap.parse_args()
    rows = rows_from_jsonl(args.predictions)
    tier_metrics, classes = metrics(rows, args.common_cutoff, args.rare_cutoff)
    weak = [x for x in classes.values() if x["top1_accuracy"] < args.weak_threshold]
    out = args.output_dir
    out.mkdir(parents=True, exist_ok=True)
    report = {
        "prediction_source": str(args.predictions),
        "images": len(rows),
        "classes_evaluated": len(classes),
        "tier_cutoffs": {"extremely_common": args.common_cutoff, "common": args.rare_cutoff},
        "weak_threshold_top1": args.weak_threshold,
        "accuracy_by_tier": tier_metrics,
        "macro_recall": sum(x["top1_accuracy"] for x in classes.values()) / max(1, len(classes)),
    }
    (out / "accuracy_by_tier.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
    (out / "weak_class_manifest.json").write_text(json.dumps(weak, indent=2), encoding="utf-8")
    print(json.dumps({**report, "weak_classes": len(weak)}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
