#!/usr/bin/env python3
"""Fine-tune the 3,969-class Flora-Ultra EVA-02 model on Kaggle.

Large artifacts are downloaded only on the remote Kaggle worker. The model
head is never resized: samples from the currently available classes target
their original indices and deficit rows remain untouched.
"""
from __future__ import annotations

import argparse
import io
import json
import os
import random
import re
import subprocess
import sys
import time
import shutil
from urllib.parse import quote
from pathlib import Path

os.environ.setdefault("PYTORCH_CUDA_ALLOC_CONF", "expandable_segments:True")
os.environ.setdefault("HF_HUB_ENABLE_HF_TRANSFER", "1")

DATASET_REPO = "gsor56/findflower-find10k"
MODEL_REPO = "gsor56/Flora-Ultra"
TAXONOMY_REPO = DATASET_REPO
TAXONOMY_FILE = "pipeline/verified_botanical_classes.json"
NUM_CLASSES = 3969
ACTIVE_CLASSES = 2722
IMAGE_SIZE = 336


def safe_label(label: str) -> str:
    """Match the curation pipeline's deterministic directory naming."""
    return re.sub(r"[^A-Za-z0-9._ -]+", "_", label).replace("/", "_").strip() or "unknown"


def ensure(module: str, package: str) -> None:
    try:
        __import__(module)
    except ImportError:
        subprocess.run([sys.executable, "-m", "pip", "install", "-q", package], check=True)


def read_token() -> str:
    for key in ("HF_TOKEN", "HUGGINGFACE_TOKEN", "HF_ACCESS_TOKEN"):
        value = (os.environ.get(key) or "").strip()
        if value:
            return value
    for raw in ("/kaggle/input/my-secrets/credential.txt", "/kaggle/input/my_secrets/credential.txt"):
        try:
            value = Path(raw).read_text(encoding="utf-8").strip()
            if value:
                return value
        except OSError:
            pass
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
        return (UserSecretsClient().get_secret("HF_TOKEN") or "").strip()
    except Exception:
        return ""


def seed_everything(seed: int) -> None:
    random.seed(seed)
    import torch
    torch.manual_seed(seed)
    if torch.cuda.is_available():
        torch.cuda.manual_seed_all(seed)


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser()
    p.add_argument("--epochs", type=int, default=2)
    p.add_argument("--active-classes", type=int, default=25)
    p.add_argument("--batch-size", type=int, default=2)
    p.add_argument("--grad-accum", type=int, default=1)
    p.add_argument("--workers", type=int, default=0)
    p.add_argument("--max-images-per-class", type=int, default=8,
                   help="per-class cap for this smoke test; use 0 for full training")
    p.add_argument("--lr", type=float, default=2e-5)
    p.add_argument("--weight-decay", type=float, default=0.05)
    p.add_argument("--val-fraction", type=float, default=0.15)
    p.add_argument("--seed", type=int, default=1337)
    p.add_argument("--data-dir", type=Path, default=Path("/kaggle/working/find10k-dataset"))
    p.add_argument("--checkpoint-dir", type=Path, default=Path("/kaggle/working/flora-ultra-checkpoints"))
    p.add_argument("--refresh-data", action="store_true", help="discard and re-fetch the local dataset snapshot")
    p.add_argument("--min-free-gb", type=float, default=4.0,
                   help="abort before any large operation if less than this remains")
    return p.parse_args()


def disk_report(label: str, min_free_gb: float = 4.0) -> None:
    usage = shutil.disk_usage("/kaggle/working" if Path("/kaggle/working").exists() else Path.cwd())
    free_gb = usage.free / (1024 ** 3)
    used_gb = usage.used / (1024 ** 3)
    print(f"[disk] {label}: used={used_gb:.2f}GB free={free_gb:.2f}GB total={usage.total / (1024 ** 3):.2f}GB", flush=True)
    if free_gb < min_free_gb:
        raise SystemExit(f"insufficient disk space: {free_gb:.2f}GB free, need at least {min_free_gb:.2f}GB")


def remote_image_manifest(repo_id: str, token: str) -> list[str]:
    """List image paths with paginated tree API calls, never issuing per-file HEADs."""
    import requests
    url = f"https://huggingface.co/api/datasets/{repo_id}/tree/main/images/train?recursive=true&expand=false&limit=1000"
    headers = {"Authorization": f"Bearer {token}"}
    paths: list[str] = []
    session = requests.Session()
    while url:
        for attempt in range(5):
            try:
                response = session.get(url, headers=headers, timeout=(15, 120))
                if response.status_code == 429:
                    time.sleep(min(60, 5 * (attempt + 1)))
                    continue
                response.raise_for_status()
                break
            except Exception:
                if attempt == 4:
                    raise
                time.sleep(min(30, 2 ** attempt))
        entries = response.json()
        paths.extend(
            str(entry["path"])
            for entry in entries
            if entry.get("type") == "file"
            and str(entry.get("path", "")).lower().endswith((".jpg", ".jpeg"))
        )
        next_url = None
        for link in response.headers.get("Link", "").split(","):
            if 'rel="next"' in link and "<" in link and ">" in link:
                next_url = link.split("<", 1)[1].split(">", 1)[0]
                break
        url = next_url
        if len(paths) and len(paths) % 10000 < 1000:
            print(f"[data] manifest files discovered={len(paths):,}", flush=True)
    return sorted(set(paths))


class RemoteImageDataset:
    def __init__(self, rows, transform, repo_id, token):
        self.rows, self.transform, self.repo_id, self.token = rows, transform, repo_id, token
        self.requests = self.successes = self.rate_limits = self.retries = 0
        self.bytes = 0
        self.request_seconds = 0.0

    def __len__(self):
        return len(self.rows)

    def __getitem__(self, index):
        import requests
        from PIL import Image
        path, label = self.rows[index]
        url = f"https://huggingface.co/datasets/{self.repo_id}/resolve/main/{quote(path, safe='/')}?download=true"
        last = None
        for attempt in range(4):
            started = time.monotonic()
            self.requests += 1
            try:
                response = requests.get(url, headers={"Authorization": f"Bearer {self.token}"}, timeout=(10, 30))
                self.request_seconds += time.monotonic() - started
                if response.status_code == 429:
                    self.rate_limits += 1
                    self.retries += 1
                    time.sleep(min(20, 2 ** attempt))
                    continue
                response.raise_for_status()
                self.successes += 1
                self.bytes += len(response.content)
                with Image.open(io.BytesIO(response.content)) as image:
                    return self.transform(image.convert("RGB")), label
            except Exception as exc:
                self.request_seconds += time.monotonic() - started
                last = exc
                if attempt < 3:
                    self.retries += 1
                    time.sleep(1 + attempt)
        raise RuntimeError(f"image fetch failed after retries: {path}") from last

    def stats(self) -> dict[str, float]:
        return {
            "requests": self.requests,
            "successes": self.successes,
            "rate_limits": self.rate_limits,
            "retries": self.retries,
            "bytes": self.bytes,
            "request_seconds": self.request_seconds,
        }


def main() -> int:
    args = parse_args()
    if args.epochs < 1 or args.active_classes < 1 or args.active_classes > NUM_CLASSES:
        raise SystemExit("invalid epoch/class configuration")
    ensure("huggingface_hub", "huggingface_hub>=0.34.0")
    ensure("hf_transfer", "hf_transfer")
    ensure("safetensors", "safetensors>=0.4.5")
    ensure("timm", "timm>=1.0.15")
    ensure("PIL", "pillow")

    import torch
    import torch.nn as nn
    from PIL import Image
    from safetensors.torch import load_file
    from torch.cuda.amp import GradScaler, autocast
    from torch.utils.data import DataLoader, Dataset
    from torchvision import transforms
    from huggingface_hub import hf_hub_download, snapshot_download
    import timm

    if not torch.cuda.is_available():
        raise SystemExit("CUDA GPU is required; refusing to train on CPU")
    token = read_token()
    if not token:
        raise SystemExit("HF_TOKEN is required via Kaggle Secret or environment")
    os.environ["HF_TOKEN"] = token
    seed_everything(args.seed)
    device = torch.device("cuda")
    print(f"[preflight] device={torch.cuda.get_device_name(0)} classes={NUM_CLASSES} active={args.active_classes}", flush=True)

    # Do not snapshot 96k loose files: that causes one HEAD per image and fills
    # Kaggle's working volume. Build one paginated manifest, then stream image
    # bytes directly into RAM as each DataLoader sample is requested.
    disk_report("before manifest", args.min_free_gb)
    print("[data] building paginated Hub manifest (no per-file HEAD requests)", flush=True)
    image_paths = remote_image_manifest(DATASET_REPO, token)
    disk_report("after manifest", args.min_free_gb)

    taxonomy_path = Path(hf_hub_download(
        repo_id=TAXONOMY_REPO, repo_type="dataset", filename=TAXONOMY_FILE, token=token
    ))
    taxonomy = json.loads(taxonomy_path.read_text(encoding="utf-8"))
    if not isinstance(taxonomy, list) or len(taxonomy) != NUM_CLASSES:
        raise SystemExit(f"taxonomy has {len(taxonomy) if isinstance(taxonomy, list) else 'invalid'} rows; expected {NUM_CLASSES}")
    names = [str(row["name"]) for row in taxonomy]
    name_to_index = {name: i for i, name in enumerate(names)}
    if len(name_to_index) != NUM_CLASSES:
        raise SystemExit("taxonomy contains duplicate class names")

    records: list[tuple[str, int]] = []
    counts: dict[str, int] = {}
    folder_to_name = {safe_label(name): name for name in names}
    if len(folder_to_name) != len(names):
        raise SystemExit("taxonomy names collide after dataset folder sanitization")
    for path in image_paths:
        parts = path.split("/")
        class_name = folder_to_name.get(parts[2]) if len(parts) >= 4 else None
        if class_name is None:
            continue
        counts[class_name] = counts.get(class_name, 0) + 1
        records.append((path, name_to_index[class_name]))
    eligible = [name for name in names if counts.get(name, 0) >= 2]
    if len(eligible) < args.active_classes:
        raise SystemExit(f"only {len(eligible)} classes have >=2 images; need {args.active_classes}")
    selected = eligible[: args.active_classes]
    selected_ids = {name_to_index[name] for name in selected}
    records = [(path, label) for path, label in records if label in selected_ids]
    print(f"[data] selected={len(selected)} images={len(records):,} min_images={min(counts[n] for n in selected):,}", flush=True)

    by_label: dict[int, list[str]] = {name_to_index[n]: [] for n in selected}
    for path, label in records:
        by_label[label].append(path)
    rng = random.Random(args.seed)
    train_records: list[tuple[str, int]] = []
    val_records: list[tuple[str, int]] = []
    for label, paths in by_label.items():
        rng.shuffle(paths)
        if args.max_images_per_class > 0:
            paths = paths[:args.max_images_per_class]
        val_n = max(1, int(round(len(paths) * args.val_fraction)))
        val_records.extend((p, label) for p in paths[:val_n])
        train_records.extend((p, label) for p in paths[val_n:])

    train_tf = transforms.Compose([
        transforms.RandomResizedCrop(IMAGE_SIZE, scale=(0.65, 1.0)),
        transforms.RandomHorizontalFlip(),
        transforms.ColorJitter(0.2, 0.2, 0.2, 0.05),
        transforms.ToTensor(),
        transforms.Normalize([0.48145466, 0.4578275, 0.40821073], [0.26862954, 0.26130258, 0.27577711]),
    ])
    val_tf = transforms.Compose([
        transforms.Resize((IMAGE_SIZE, IMAGE_SIZE)), transforms.ToTensor(),
        transforms.Normalize([0.48145466, 0.4578275, 0.40821073], [0.26862954, 0.26130258, 0.27577711]),
    ])

    class FlowerDataset(Dataset):
        def __init__(self, rows, transform): self.rows, self.transform = rows, transform
        def __len__(self): return len(self.rows)
        def __getitem__(self, i):
            path, label = self.rows[i]
            with Image.open(path) as im:
                image = im.convert("RGB")
            return self.transform(image), label

    train_remote = RemoteImageDataset(train_records, train_tf, DATASET_REPO, token)
    val_remote = RemoteImageDataset(val_records, val_tf, DATASET_REPO, token)
    train_loader = DataLoader(train_remote, batch_size=args.batch_size, shuffle=True,
                              num_workers=args.workers, pin_memory=True, persistent_workers=args.workers > 0,
                              drop_last=True)
    val_loader = DataLoader(val_remote, batch_size=args.batch_size, shuffle=False,
                            num_workers=args.workers, pin_memory=True, persistent_workers=args.workers > 0)

    model_dir = args.checkpoint_dir / "flora-ultra-model"
    model_dir.mkdir(parents=True, exist_ok=True)
    config_file = Path(hf_hub_download(repo_id=MODEL_REPO, repo_type="model", filename="config.json", token=token, local_dir=str(model_dir)))
    weights_file = Path(hf_hub_download(repo_id=MODEL_REPO, repo_type="model", filename="model.safetensors", token=token, local_dir=str(model_dir)))
    cfg = json.loads(config_file.read_text(encoding="utf-8"))
    if int(cfg.get("num_classes", 0)) != NUM_CLASSES:
        raise SystemExit(f"Flora-Ultra config num_classes={cfg.get('num_classes')} != {NUM_CLASSES}")
    model = timm.create_model("eva02_large_patch14_clip_336", pretrained=False, num_classes=NUM_CLASSES)
    classifier = model.get_classifier()
    if not isinstance(classifier, nn.Linear) or classifier.out_features != NUM_CLASSES or classifier.in_features != 1024:
        raise SystemExit("unexpected EVA-02 classifier shape")
    state = load_file(str(weights_file), device="cpu")
    result = model.load_state_dict(state, strict=True)
    if result.missing_keys or result.unexpected_keys:
        raise SystemExit(f"checkpoint mismatch missing={result.missing_keys[:3]} unexpected={result.unexpected_keys[:3]}")
    print(f"[model] EVA-02 head preserved: [{NUM_CLASSES}, 1024]", flush=True)
    model.to(device)

    optimizer = torch.optim.AdamW(model.parameters(), lr=args.lr, weight_decay=args.weight_decay)
    scheduler = torch.optim.lr_scheduler.CosineAnnealingLR(optimizer, T_max=args.epochs)
    scaler = GradScaler(enabled=True)
    criterion = nn.CrossEntropyLoss()
    args.checkpoint_dir.mkdir(parents=True, exist_ok=True)
    latest = args.checkpoint_dir / "latest_checkpoint.pth"
    best_path = args.checkpoint_dir / "best_model.pth"
    start_epoch, best_sub = 0, -1.0
    if latest.exists():
        checkpoint = torch.load(latest, map_location="cpu")
        model.load_state_dict(checkpoint["model"])
        optimizer.load_state_dict(checkpoint["optimizer"])
        scheduler.load_state_dict(checkpoint["scheduler"])
        scaler.load_state_dict(checkpoint.get("scaler", scaler.state_dict()))
        start_epoch = int(checkpoint.get("epoch", -1)) + 1
        best_sub = float(checkpoint.get("best_sub", -1.0))
        model.to(device)
        print(f"[resume] checkpoint epoch={start_epoch} best_sub={best_sub:.4f}", flush=True)

    deficit_ids = set(range(NUM_CLASSES)) - selected_ids
    for epoch in range(start_epoch, args.epochs):
        model.train(); optimizer.zero_grad(set_to_none=True); running = 0.0; seen = 0
        for step, (images, labels) in enumerate(train_loader, 1):
            images, labels = images.to(device, non_blocking=True), labels.to(device, non_blocking=True)
            with autocast(dtype=torch.float16):
                loss = criterion(model(images), labels) / args.grad_accum
            scaler.scale(loss).backward()
            if step % args.grad_accum == 0 or step == len(train_loader):
                scaler.step(optimizer); scaler.update(); optimizer.zero_grad(set_to_none=True)
            running += float(loss.detach()) * args.grad_accum * labels.size(0); seen += labels.size(0)
        scheduler.step()

        model.eval(); top1 = top5 = global_correct = total = leakage = 0
        active_tensor = torch.tensor(sorted(selected_ids), device=device)
        with torch.no_grad():
            for images, labels in val_loader:
                images, labels = images.to(device, non_blocking=True), labels.to(device, non_blocking=True)
                logits = model(images)
                global_pred5 = logits.topk(5, dim=1).indices
                global_correct += int((global_pred5[:, 0] == labels).sum())
                active_logits = logits.index_select(1, active_tensor)
                active_pred5 = active_tensor[active_logits.topk(5, dim=1).indices]
                top1 += int((active_pred5[:, 0] == labels).sum()); top5 += int((active_pred5 == labels[:, None]).any(dim=1).sum())
                leakage += int(torch.isin(global_pred5[:, 0], torch.tensor(list(deficit_ids), device=device)).sum())
                total += labels.numel()
        sub = top1 / max(1, total)
        global_acc = global_correct / max(1, total)
        ts, vs = train_remote.stats(), val_remote.stats()
        reqs = ts["requests"] + vs["requests"]
        successes = ts["successes"] + vs["successes"]
        elapsed = ts["request_seconds"] + vs["request_seconds"]
        rate = successes / max(elapsed, 1e-9)
        print(f"[epoch {epoch + 1}/{args.epochs}] train_loss={running/max(1,seen):.4f} Sub-Accuracy={sub:.4%} Global Accuracy={global_acc:.4%} Deficit-Leakage={leakage}", flush=True)
        print(f"[network] requests={reqs} successes={successes} 429s={ts['rate_limits'] + vs['rate_limits']} retries={ts['retries'] + vs['retries']} bytes={ts['bytes'] + vs['bytes']} request_rate={rate:.2f}/s avg_latency={(elapsed/max(1,successes)):.3f}s", flush=True)
        disk_report(f"after epoch {epoch + 1}", args.min_free_gb)
        payload = {"epoch": epoch, "model": model.state_dict(), "optimizer": optimizer.state_dict(),
                   "scheduler": scheduler.state_dict(), "scaler": scaler.state_dict(), "best_sub": max(best_sub, sub)}
        torch.save(payload, latest)
        if sub > best_sub:
            best_sub = sub; torch.save(model.state_dict(), best_path)
        del payload
    print(f"[done] epochs={args.epochs} best_sub_accuracy={best_sub:.4%}", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
