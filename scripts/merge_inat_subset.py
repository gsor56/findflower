#!/usr/bin/env python3
"""Build a deduplicated target subset from an attached iNat-2021 tree.

The script is intentionally offline: Kaggle should provide the iNat tree and
the taxonomy files as attached datasets. It never downloads images or model
weights and it does not write outside ``--output``.

Expected inputs
---------------
``--source`` is an ImageFolder-like tree. Class directories may be scientific
names or iNat21 folders with a numeric prefix. ``--target-manifest`` accepts
the generated flowering-plant manifest (``{"classes": [...]}``) or a JSON
list. ``--inat21-label-map`` is the authoritative full taxonomy order, either
as a list or ``{"classes": [...]}``. The output contains a 10k class map,
target ids, quality/dedup audit, and train/validation file lists.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import sys
from collections import defaultdict
from pathlib import Path

try:
    from PIL import Image, ImageOps
except ImportError:  # Imported lazily for --help/syntax checks on minimal hosts.
    Image = ImageOps = None

try:
    import cv2  # optional; quality scoring remains available without it
except Exception:  # pragma: no cover - Kaggle image includes cv2
    cv2 = None

IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".webp", ".bmp"}
OBS_RE = re.compile(r"(?:obs(?:ervation)?[_-]?|photo[_-]?)(\d+)", re.I)
NUMERIC_ID_RE = re.compile(r"^(\d{5,})(?:[_-].*)?$")
PREFIX_RE = re.compile(r"^\d+[_-](.+)$")


def read_json(path: Path):
    with path.open(encoding="utf-8") as f:
        return json.load(f)


def labels_from_json(path: Path) -> list[str]:
    obj = read_json(path)
    if isinstance(obj, dict):
        for key in ("classes", "labels", "class_names", "species", "categories"):
            value = obj.get(key)
            if isinstance(value, dict):
                return [str(k) for k in value]
            if isinstance(value, list):
                obj = value
                break
        # class_names.json is commonly {"0": "Rosa ..."}
        if obj and all(str(k).isdigit() for k in obj):
            return [str(obj[k]) for k in sorted(obj, key=lambda x: int(x))]
    if isinstance(obj, list):
        if obj and isinstance(obj[0], dict):
            def row_id(row):
                value = row.get("id", row.get("index", row.get("class_id", 0)))
                return int(value)
            rows = sorted(obj, key=row_id)
            labels = []
            for row in rows:
                value = next((row.get(k) for k in (
                    "scientific_name", "taxon_name", "name", "class_name", "label"
                ) if row.get(k)), None)
                if value is None:
                    raise ValueError(f"category entry has no label field in {path}")
                labels.append(str(value))
            return labels
        return [str(x) for x in obj]
    raise ValueError(f"cannot read class labels from {path}")


def clean_label(name: str) -> str:
    name = PREFIX_RE.sub(r"\1", name)
    return name.replace("_", " ").strip()


def aliases(label: str) -> set[str]:
    raw = str(label).strip()
    clean = clean_label(raw)
    out = {raw, clean, raw.replace(" ", "_"), clean.replace(" ", "_")}
    # iNat21 ImageFolder names often encode the full lineage and end in the
    # genus/species pair. Add that binomial explicitly, but only for lineage-like
    # labels; ordinary scientific names are already represented above.
    words = clean.split()
    if len(words) >= 6:
        binomial = " ".join(words[-2:])
        out.update({binomial, binomial.replace(" ", "_")})
    return out


def md5(path: Path) -> str:
    h = hashlib.md5()
    with path.open("rb") as f:
        for block in iter(lambda: f.read(1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()


def dhash(path: Path, size: int = 16) -> int:
    """Small dependency-free perceptual hash (256 bits at the default size)."""
    if Image is None:
        raise RuntimeError("Pillow is required for image processing; Kaggle includes it")
    with Image.open(path) as im:
        im = ImageOps.exif_transpose(im).convert("L").resize((size + 1, size))
        px = list(im.getdata())
    bits = 0
    for row in range(size):
        base = row * (size + 1)
        for col in range(size):
            bits = (bits << 1) | int(px[base + col] > px[base + col + 1])
    return bits


def quality(path: Path, min_side: int, blur_floor: float) -> tuple[bool, dict]:
    if Image is None:
        raise RuntimeError("Pillow is required for image processing; Kaggle includes it")
    try:
        with Image.open(path) as raw:
            im = ImageOps.exif_transpose(raw).convert("RGB")
            w, h = im.size
            if min(w, h) < min_side:
                return False, {"reason": "small", "width": w, "height": h}
            gray = None
            if cv2 is not None:
                import numpy as np
                gray = cv2.cvtColor(np.asarray(im), cv2.COLOR_RGB2GRAY)
                sharp = float(cv2.Laplacian(gray, cv2.CV_64F).var())
                hist = cv2.calcHist([gray], [0], None, [32], [0, 256]).ravel()
                hist /= max(1.0, float(hist.sum()))
                exposure = float(hist.var())
                luminance = float(gray.mean())
                clipped = float(((gray <= 3) | (gray >= 252)).mean())
            else:
                # A conservative fallback; exact blur scoring is available on
                # Kaggle where cv2 is part of the standard image.
                sharp, exposure, luminance, clipped = None, None, None, None
            if sharp is not None and sharp < blur_floor:
                return False, {"reason": "blur", "sharpness": sharp,
                               "exposure_variance": exposure, "width": w, "height": h}
            if luminance is not None and (luminance < 18 or luminance > 238 or clipped > 0.45):
                return False, {"reason": "exposure", "luminance": luminance,
                               "clipped_fraction": clipped, "width": w, "height": h}
            # A near-zero normalized histogram variance is a flat/blank frame;
            # reject it even when the Laplacian happens to contain compression
            # noise. Clipping above handles the opposite extreme.
            if exposure is not None and exposure < 1e-5:
                return False, {"reason": "flat_exposure", "exposure_variance": exposure,
                               "luminance": luminance, "width": w, "height": h}
            return True, {"sharpness": sharp, "exposure_variance": exposure,
                          "luminance": luminance, "clipped_fraction": clipped,
                          "width": w, "height": h}
    except Exception as exc:
        return False, {"reason": f"decode:{type(exc).__name__}"}


def observation_key(path: Path) -> str:
    # iNat exports often preserve observation/photo ids in filenames. When they
    # do not, the relative parent/file path is still deterministic and prevents
    # a single source file from crossing the train/validation boundary.
    match = OBS_RE.search(path.stem)
    if match:
        return f"obs:{match.group(1)}"
    match = NUMERIC_ID_RE.match(path.stem)
    if match:
        return f"obs:{match.group(1)}"
    return f"file:{path.parent.name}/{path.stem}"


def link_or_copy(src: Path, dst: Path, mode: str) -> None:
    dst.parent.mkdir(parents=True, exist_ok=True)
    if dst.exists():
        return
    if mode == "symlink":
        dst.symlink_to(src.resolve())
    elif mode == "hardlink":
        os.link(src, dst)
    else:
        shutil.copy2(src, dst)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--source", required=True, type=Path, action="append",
                    help="ImageFolder root; repeat to merge Premium-100 and iNat21")
    ap.add_argument("--target-manifest", required=True, type=Path)
    ap.add_argument("--inat21-label-map", required=True, type=Path)
    ap.add_argument("--output", required=True, type=Path)
    ap.add_argument("--images-per-class", type=int, default=300)
    ap.add_argument("--validation-fraction", type=float, default=0.15)
    ap.add_argument("--min-side", type=int, default=224)
    ap.add_argument("--blur-floor", type=float, default=40.0)
    ap.add_argument("--link-mode", choices=("symlink", "hardlink", "copy"), default="symlink")
    ap.add_argument("--seed", type=int, default=42)
    ap.add_argument("--allow-partial", action="store_true",
                    help="retain a gap report instead of aborting on taxonomy/class shortages")
    args = ap.parse_args()

    for source in args.source:
        if not source.is_dir():
            raise SystemExit(f"source does not exist: {source}")
    target_labels = labels_from_json(args.target_manifest)
    full_labels = labels_from_json(args.inat21_label_map)
    if len(full_labels) != 10000:
        raise SystemExit(f"expected exactly 10,000 iNat21 labels, got {len(full_labels)}")
    if len(set(full_labels)) != len(full_labels):
        raise SystemExit("iNat21 label map contains duplicate names")
    full_by_alias = defaultdict(set)
    for i, label in enumerate(full_labels):
        for alias in aliases(label):
            full_by_alias[alias].add(i)

    target_ids = {}
    missing_target = []
    for label in target_labels:
        hits = {idx for alias in aliases(label) for idx in full_by_alias.get(alias, ())}
        if len(hits) != 1:
            missing_target.append(label)
        else:
            target_ids[label] = hits.pop()
    if missing_target and not args.allow_partial:
        sample = ", ".join(missing_target[:8])
        raise SystemExit(f"{len(missing_target)} target labels are absent/ambiguous in iNat21 map: {sample}")
    if missing_target:
        print(f"[partial] {len(missing_target)} target labels have no unique taxonomy id", flush=True)

    class_dirs = defaultdict(list)
    for source in args.source:
        for child in sorted(source.iterdir()):
            if child.is_dir():
                # Register the full lineage and its derived binomial aliases.
                # This is what lets ``05432_Plantae_..._Rosa_canina`` resolve to
                # the manifest label ``Rosa canina`` without guessing by index.
                for alias in aliases(child.name):
                    class_dirs[alias].append(child)
    selected = []
    for label in target_labels:
        dirs = []
        for alias in aliases(label):
            dirs.extend(class_dirs.get(alias, ()))
        dirs = list(dict.fromkeys(dirs))
        if not dirs or label not in target_ids:
            continue
        selected.append((label, dirs))
    if len(selected) != len(target_labels) and not args.allow_partial:
        selected_labels = {label for label, _dirs in selected}
        missing = [label for label in target_labels if label not in selected_labels]
        raise SystemExit(f"missing target class folders: {len(missing)} (first: {missing[:8]})")
    if len(selected) != len(target_labels):
        print(f"[partial] selected {len(selected)}/{len(target_labels)} mapped class folders", flush=True)

    # Hashes are global across classes: the same community photo must not appear
    # under two taxa, and near-identical crops are kept only once.
    exact, perceptual = {}, defaultdict(set)
    perceptual_values = []
    records, rejected = [], defaultdict(int)
    for class_number, (label, folders) in enumerate(selected, 1):
        candidates = []
        for folder in folders:
            for path in folder.rglob("*"):
                if path.suffix.lower() not in IMAGE_EXTS:
                    continue
                ok, metrics = quality(path, args.min_side, args.blur_floor)
                if not ok:
                    rejected[metrics.get("reason", "quality")] += 1
                    continue
                digest = md5(path)
                if digest in exact:
                    rejected["md5_duplicate"] += 1
                    continue
                ph = dhash(path)
                # Sixteen 16-bit bands: with a <=8-bit Hamming threshold at least
                # eight bands remain identical, so lookup cannot miss a match.
                bands = tuple((band, (ph >> (band * 16)) & 0xFFFF) for band in range(16))
                candidate_ids = set()
                for band in bands:
                    candidate_ids.update(perceptual.get(band, ()))
                near = False
                for other_id in candidate_ids:
                    if (ph ^ perceptual_values[other_id]).bit_count() <= 8:
                        near = True
                        break
                if near:
                    rejected["perceptual_duplicate"] += 1
                    continue
                exact[digest] = path
                ph_id = len(perceptual_values)
                perceptual_values.append(ph)
                for band in bands:
                    perceptual[band].add(ph_id)
                candidates.append((path, metrics, observation_key(path)))
        candidates.sort(key=lambda x: (-(x[1].get("sharpness") or 0.0), str(x[0])))
        records.extend((label, *row) for row in candidates[: args.images_per_class])
        if class_number == 1 or class_number % 25 == 0 or class_number == len(selected):
            print(f"[scan] {class_number}/{len(selected)} classes; {len(records):,} accepted images", flush=True)

    # Deterministic observation-group split. Sorting by hash means reruns produce
    # the same split while class-local sampling remains balanced.
    import random
    rng = random.Random(args.seed)
    by_class = defaultdict(list)
    for row in records:
        by_class[row[0]].append(row)
    split = {"train": [], "validation": []}
    short = {}
    for label in target_labels:
        rows = by_class[label]
        rng.shuffle(rows)
        groups = defaultdict(list)
        for row in rows:
            groups[row[3]].append(row)
        ordered = list(groups.values())
        rng.shuffle(ordered)
        val_n = max(1, int(round(len(rows) * args.validation_fraction))) if rows else 0
        val, train = [], []
        for group in ordered:
            (val if len(val) < val_n else train).extend(group)
        if len(rows) < args.images_per_class:
            short[label] = len(rows)
        split["train"].extend(train)
        split["validation"].extend(val)

    args.output.mkdir(parents=True, exist_ok=True)
    image_root = args.output / "images"
    for subset, rows in split.items():
        for label, src, _metrics, _obs in rows:
            dst_name = f"{md5(src)[:12]}_{src.name}"
            dst = image_root / subset / label.replace("/", "_") / dst_name
            link_or_copy(src, dst, args.link_mode)

    def serial(row):
        label, src, metrics, obs = row
        return {"label": label, "head_id": target_ids[label], "path": str(src),
                "observation": obs, "metrics": metrics}

    report = {
        "version": 1,
        "full_class_count": len(full_labels),
        "target_class_count": len(target_labels),
        "target_head_ids": target_ids,
        "unmapped_target_labels": missing_target,
        "full_labels": full_labels,
        "target_labels": target_labels,
        "images_per_class_requested": args.images_per_class,
        "images_total": len(records),
        "images_train": len(split["train"]),
        "images_validation": len(split["validation"]),
        "short_classes": short,
        "rejected": dict(rejected),
        "dedup_exact_count": len(exact),
        "dedup_perceptual_hashes": len(perceptual_values),
        "records_file": "records.jsonl",
    }
    with (args.output / "records.jsonl").open("w", encoding="utf-8") as f:
        for subset, rows in split.items():
            for row in rows:
                entry = serial(row)
                entry["split"] = subset
                f.write(json.dumps(entry, separators=(",", ":")) + "\n")
    with (args.output / "dataset_audit.json").open("w", encoding="utf-8") as f:
        json.dump(report, f, indent=2)
    with (args.output / "inat21_labels.json").open("w", encoding="utf-8") as f:
        json.dump({str(i): label for i, label in enumerate(full_labels)}, f, indent=2)
    with (args.output / "target_head_ids.json").open("w", encoding="utf-8") as f:
        json.dump(target_ids, f, indent=2, sort_keys=True)
    print(json.dumps({k: report[k] for k in (
        "full_class_count", "target_class_count", "images_total", "images_train",
        "images_validation", "short_classes", "rejected")}, indent=2))
    if short:
        return 2
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        raise SystemExit(130)
