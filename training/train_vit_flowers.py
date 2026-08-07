# ==============================================================================
# HF token is read from the environment. On Kaggle, add it via
# Add-ons > Secrets (name: HF_TOKEN); locally, `setx HF_TOKEN <token>` or export.
# Never hardcode the token here -- this file is committed to a repo.
# ==============================================================================
import os
if not os.environ.get('HF_TOKEN'):
    raise SystemExit('HF_TOKEN not set. Add it as a Kaggle Secret or environment variable.')

# ==============================================================================
# Incremental, resumable ViT fine-tuning for flower species classification
# ------------------------------------------------------------------------------
# Designed to run as a SINGLE Kaggle notebook cell. "Run and forget":
#   * Downloads cc0/cc-by/cc-by-nc research-grade images from iNaturalist
#   * Tracks progress in manifest.json on the Hugging Face Hub
#   * Resumes model from the last checkpoint on the Hub (never restarts scratch)
#   * Grows the classification head when you add species, preserving old weights
#   * Saves progress INCREMENTALLY so a Kaggle timeout never loses finished work
#
# Setup (once):
#   1. Kaggle: enable GPU (Settings -> Accelerator -> GPU T4 x2 or P100)
#   2. Kaggle: enable Internet (Settings -> Internet -> On)
#   3. Edit SPECIES_LIST below whenever you like. Everything else is automatic.
# The HF token is injected at the very top. Two private HF repos are used and
# auto-created: the model repo (checkpoints + manifest) and a companion
# "-data" DATASET repo that stores downloaded images so they survive Kaggle
# session wipes -- this is what makes cross-session "run and forget" work.
# NOTE: do NOT pip-upgrade torch/transformers here; Kaggle's preinstalled,
# GPU-matched builds must be used or CUDA kernels won't match the GPU.
# ==============================================================================

# ------------------------------------------------------------------------------
# 0. Config -- the only things you ever need to touch
# ------------------------------------------------------------------------------
HF_REPO_ID   = "gsor56/findflower-ViT"   # your private model repo on the Hub
HF_DATA_REPO = "gsor56/findflower-ViT-data"  # dataset repo holding the images
HF_PRIVATE   = True                       # keep both repos private
BASE_MODEL   = "google/vit-base-patch16-224"

# Data targets per species
MIN_IMAGES    = 200        # a species counts as "collected" at >= this many
TARGET_IMAGES = 300        # stop downloading a species once we reach this many

# Training budget (kept modest so it fits comfortably in a Kaggle session)
EPOCHS_PER_RUN = 4         # epochs of training performed each run
BATCH_SIZE     = 32
LEARNING_RATE  = 3e-4      # head/new params; backbone is fine-tuned gently below
VAL_FRACTION   = 0.15      # 85/15 train/val split
IMAGE_SIZE     = 224

# Session safety: stop starting NEW heavy work after this many seconds so we
# always have time to push the checkpoint + manifest before Kaggle kills us.
SESSION_BUDGET_SECONDS = int(8.5 * 3600)   # ~8.5h; raise if you have 12h quota
DOWNLOAD_BUDGET_SECONDS = int(3.0 * 3600)  # cap time spent downloading per run

# iNaturalist politeness
INAT_PAGE_SIZE = 200
INAT_SLEEP     = 1.1       # seconds between API calls (<=60 req/min guideline)

# ------------------------------------------------------------------------------
# Species list -- EDIT FREELY. Add/remove lines across runs; the pipeline picks
# up new ones automatically and grows the model head to fit. Names here are the
# human-readable labels; each maps to an iNaturalist scientific name below.
# Start set: ~120 commonly-photographed, well-documented flowering species with
# strong research-grade iNaturalist coverage. Expand toward 500+ over time.
# Format: "common label": "Scientific name" (scientific name drives the query).
# ------------------------------------------------------------------------------
SPECIES_LIST = {
    "common dandelion":        "Taraxacum officinale",
    "oxeye daisy":             "Leucanthemum vulgare",
    "common sunflower":        "Helianthus annuus",
    "california poppy":        "Eschscholzia californica",
    "common poppy":            "Papaver rhoeas",
    "black-eyed susan":        "Rudbeckia hirta",
    "purple coneflower":       "Echinacea purpurea",
    "common yarrow":           "Achillea millefolium",
    "queen anne's lace":       "Daucus carota",
    "red clover":              "Trifolium pratense",
    "white clover":            "Trifolium repens",
    "chicory":                 "Cichorium intybus",
    "common milkweed":         "Asclepias syriaca",
    "butterfly milkweed":      "Asclepias tuberosa",
    "fireweed":                "Chamerion angustifolium",
    "goldenrod":               "Solidago canadensis",
    "aster":                   "Symphyotrichum novae-angliae",
    "blanketflower":           "Gaillardia aristata",
    "cosmos":                  "Cosmos bipinnatus",
    "zinnia":                  "Zinnia elegans",
    "marigold":                "Tagetes erecta",
    "calendula":               "Calendula officinalis",
    "bachelor's button":       "Centaurea cyanus",
    "common thistle":          "Cirsium vulgare",
    "canada thistle":          "Cirsium arvense",
    "bull thistle":            "Cirsium horridulum",
    "dame's rocket":           "Hesperis matronalis",
    "wild bergamot":           "Monarda fistulosa",
    "bee balm":                "Monarda didyma",
    "lavender":                "Lavandula angustifolia",
    "rosemary":                "Salvia rosmarinus",
    "common sage":             "Salvia officinalis",
    "scarlet sage":            "Salvia splendens",
    "catmint":                 "Nepeta cataria",
    "self-heal":               "Prunella vulgaris",
    "henbit":                  "Lamium amplexicaule",
    "creeping thyme":          "Thymus serpyllum",
    "foxglove":                "Digitalis purpurea",
    "common snapdragon":       "Antirrhinum majus",
    "garden petunia":          "Petunia x atkinsiana",
    "morning glory":           "Ipomoea purpurea",
    "field bindweed":          "Convolvulus arvensis",
    "common mallow":           "Malva neglecta",
    "hollyhock":               "Alcea rosea",
    "rose of sharon":          "Hibiscus syriacus",
    "tropical hibiscus":       "Hibiscus rosa-sinensis",
    "wood sorrel":             "Oxalis stricta",
    "garden nasturtium":       "Tropaeolum majus",
    "sweet pea":               "Lathyrus odoratus",
    "lupine":                  "Lupinus polyphyllus",
    "wisteria":                "Wisteria sinensis",
    "black locust":            "Robinia pseudoacacia",
    "eastern redbud":          "Cercis canadensis",
    "forsythia":               "Forsythia x intermedia",
    "common lilac":            "Syringa vulgaris",
    "butterfly bush":          "Buddleja davidii",
    "rhododendron":            "Rhododendron ponticum",
    "mountain laurel":         "Kalmia latifolia",
    "japanese camellia":       "Camellia japonica",
    "gardenia":                "Gardenia jasminoides",
    "common jasmine":          "Jasminum officinale",
    "oleander":                "Nerium oleander",
    "bougainvillea":           "Bougainvillea glabra",
    "trumpet creeper":         "Campsis radicans",
    "honeysuckle":             "Lonicera japonica",
    "clematis":                "Clematis vitalba",
    "climbing rose":           "Rosa multiflora",
    "dog rose":                "Rosa canina",
    "beach rose":              "Rosa rugosa",
    "peony":                   "Paeonia lactiflora",
    "anemone":                 "Anemone coronaria",
    "buttercup":               "Ranunculus acris",
    "columbine":               "Aquilegia vulgaris",
    "delphinium":              "Delphinium elatum",
    "monkshood":               "Aconitum napellus",
    "hellebore":               "Helleborus niger",
    "common daisy":            "Bellis perennis",
    "gerbera daisy":           "Gerbera jamesonii",
    "shasta daisy":            "Leucanthemum x superbum",
    "chrysanthemum":           "Chrysanthemum morifolium",
    "dahlia":                  "Dahlia pinnata",
    "tulip":                   "Tulipa gesneriana",
    "daffodil":                "Narcissus pseudonarcissus",
    "grape hyacinth":          "Muscari armeniacum",
    "common hyacinth":         "Hyacinthus orientalis",
    "crocus":                  "Crocus vernus",
    "snowdrop":                "Galanthus nivalis",
    "bearded iris":            "Iris germanica",
    "yellow flag iris":        "Iris pseudacorus",
    "daylily":                 "Hemerocallis fulva",
    "tiger lily":              "Lilium lancifolium",
    "madonna lily":            "Lilium candidum",
    "canna lily":              "Canna indica",
    "calla lily":              "Zantedeschia aethiopica",
    "gladiolus":               "Gladiolus communis",
    "freesia":                 "Freesia refracta",
    "amaryllis":               "Hippeastrum puniceum",
    "agapanthus":              "Agapanthus africanus",
    "water lily":              "Nymphaea odorata",
    "sacred lotus":            "Nelumbo nucifera",
    "passionflower":           "Passiflora incarnata",
    "common evening primrose": "Oenothera biennis",
    "geranium":                "Pelargonium x hortorum",
    "cranesbill":              "Geranium maculatum",
    "impatiens":               "Impatiens walleriana",
    "begonia":                 "Begonia semperflorens",
    "african violet":          "Streptocarpus ionanthus",
    "cyclamen":                "Cyclamen persicum",
    "primrose":                "Primula vulgaris",
    "pansy":                   "Viola x wittrockiana",
    "wild violet":             "Viola sororia",
    "sweet william":           "Dianthus barbatus",
    "carnation":               "Dianthus caryophyllus",
    "baby's breath":           "Gypsophila paniculata",
    "phlox":                   "Phlox paniculata",
    "verbena":                 "Verbena bonariensis",
    "lantana":                 "Lantana camara",
    "salvia":                  "Salvia nemorosa",
    "snap pea blossom":        "Pisum sativum",
    "borage":                  "Borago officinalis",
    "forget-me-not":           "Myosotis sylvatica",
    "viper's bugloss":         "Echium vulgare",
    "st john's wort":          "Hypericum perforatum",
    "common flax":             "Linum usitatissimum",
    "cardinal flower":         "Lobelia cardinalis",
    "jewelweed":               "Impatiens capensis",
}

# ==============================================================================
# 1. Environment
# ==============================================================================
import subprocess, sys

def _pip(*pkgs):
    subprocess.run([sys.executable, "-m", "pip", "install", "-q", *pkgs], check=False)

# IMPORTANT: never pass -U here and never install torch/accelerate. Upgrading
# transformers with -U drags in a generic torch build whose CUDA kernels don't
# match Kaggle's assigned GPU -> "no kernel image is available" at train time.
# Kaggle already ships a GPU-matched torch + transformers; we only ensure the
# Hub client is present, without touching the torch that's already installed.
_pip("--no-deps", "huggingface_hub")
_pip("requests", "pillow")

import os, io, json, time, math, random, shutil, tempfile, traceback
from collections import defaultdict

import requests
from PIL import Image, ImageFile
ImageFile.LOAD_TRUNCATED_IMAGES = True

import torch
import torch.nn as nn
from torch.utils.data import Dataset, DataLoader
from torchvision import transforms

from huggingface_hub import HfApi, hf_hub_download, snapshot_download, login
from huggingface_hub.utils import EntryNotFoundError, RepositoryNotFoundError
from transformers import ViTForImageClassification, ViTImageProcessor

RUN_START = time.monotonic()
def elapsed():            return time.monotonic() - RUN_START
def session_time_left():  return SESSION_BUDGET_SECONDS - elapsed()

random.seed(42)
torch.manual_seed(42)

DEVICE = "cuda" if torch.cuda.is_available() else "cpu"
print(f"[init] device={DEVICE}  torch={torch.__version__}")

# Fail-fast GPU check. Tesla P100 (capability 6.0) predates PyTorch cu128's 7.0
# floor and cannot run any CUDA kernel; T4 (7.5) and newer work. We HARD-EXIT on
# an unusable/absent GPU rather than silently crawling on CPU for hours -- push
# the kernel with `--accelerator NvidiaTeslaT4` so it always lands on a T4.
MIN_CAPABILITY = 7.0
if DEVICE != "cuda":
    raise SystemExit(
        "[init] No CUDA GPU detected. Enable GPU and push with "
        "--accelerator NvidiaTeslaT4. Refusing to train on CPU.")
try:
    cap = torch.cuda.get_device_capability(0)
    cap_num = cap[0] + cap[1] * 0.1
    name = torch.cuda.get_device_name(0)
    print(f"[init] GPU: {name} (compute capability {cap[0]}.{cap[1]})")
    if cap_num < MIN_CAPABILITY:
        raise SystemExit(
            f"[init] GPU '{name}' has compute capability {cap[0]}.{cap[1]}, "
            f"below this PyTorch build's {MIN_CAPABILITY} floor (P100 problem). "
            f"Re-push with `--accelerator NvidiaTeslaT4`. Refusing to run on CPU.")
    # Live conv2d to catch any other CUDA/driver mismatch before the long download.
    _t = torch.nn.Conv2d(3, 4, 3).cuda()
    _ = _t(torch.randn(1, 3, 8, 8, device="cuda"))
    torch.cuda.synchronize()
    print("[init] GPU smoke test PASSED -- proceeding on GPU")
except SystemExit:
    raise
except Exception as e:
    raise SystemExit(
        f"[init] GPU smoke test FAILED ({e}). Re-push with "
        f"`--accelerator NvidiaTeslaT4`. Refusing to run on CPU.")

# ------------------------------------------------------------------------------
# 1a. Authenticate to the Hub. Kaggle stores the secret; fall back to env var.
# ------------------------------------------------------------------------------
def get_hf_token():
    tok = os.environ.get("HF_TOKEN")
    if tok:
        return tok
    raise RuntimeError(
        "HF_TOKEN not found. It is injected at the top of this script; if you "
        "removed that line, set the HF_TOKEN environment variable instead."
    )

HF_TOKEN = get_hf_token()
login(token=HF_TOKEN, add_to_git_credential=False)
api = HfApi(token=HF_TOKEN)

# Ensure the repos exist (idempotent).
api.create_repo(repo_id=HF_REPO_ID, repo_type="model",
                private=HF_PRIVATE, exist_ok=True)
api.create_repo(repo_id=HF_DATA_REPO, repo_type="dataset",
                private=HF_PRIVATE, exist_ok=True)
print(f"[init] hub model repo ready: {HF_REPO_ID} (private={HF_PRIVATE})")
print(f"[init] hub data  repo ready: {HF_DATA_REPO} (private={HF_PRIVATE})")

# Local working dirs (Kaggle gives us /kaggle/working, scratch elsewhere).
WORK = "/kaggle/working" if os.path.isdir("/kaggle/working") else tempfile.mkdtemp()
DATA_DIR  = os.path.join(WORK, "data")      # data/<label>/*.jpg
CKPT_DIR  = os.path.join(WORK, "checkpoint")
os.makedirs(DATA_DIR, exist_ok=True)
os.makedirs(CKPT_DIR, exist_ok=True)

MANIFEST_NAME = "manifest.json"

# ==============================================================================
# 2. Manifest -- the source of truth for what's done. Lives on the Hub.
# ==============================================================================
# Schema:
# {
#   "version": 3,
#   "updated": "<iso ts>",
#   "runs": <int>,
#   "species": {
#       "<label>": {
#           "scientific": "<name>",
#           "downloaded": <int>,       # images we have on the Hub-tracked set
#           "collected": <bool>,       # downloaded >= MIN_IMAGES
#           "seen_inat_ids": [ ... ],  # dedupe across runs (photo ids)
#       }, ...
#   },
#   "classes": [ "<label>", ... ],     # ORDERED -> defines head index mapping
#   "trained_epochs": <int>,           # cumulative epochs trained
#   "last_val_accuracy": <float>,
# }

def default_manifest():
    return {
        "version": 3, "updated": None, "runs": 0,
        "species": {}, "classes": [],
        "trained_epochs": 0, "last_val_accuracy": None,
    }

def load_manifest():
    try:
        path = hf_hub_download(repo_id=HF_REPO_ID, filename=MANIFEST_NAME,
                               repo_type="model", token=HF_TOKEN)
        with open(path) as f:
            m = json.load(f)
        print(f"[manifest] loaded: runs={m.get('runs')} "
              f"classes={len(m.get('classes', []))} "
              f"epochs={m.get('trained_epochs')}")
        return m
    except (EntryNotFoundError, RepositoryNotFoundError):
        print("[manifest] none on Hub yet -- starting fresh")
        return default_manifest()
    except Exception as e:
        print(f"[manifest] load failed ({e}); starting fresh")
        return default_manifest()

manifest = load_manifest()

# Register any newly-added species from SPECIES_LIST into the manifest.
for label, sci in SPECIES_LIST.items():
    if label not in manifest["species"]:
        manifest["species"][label] = {
            "scientific": sci, "downloaded": 0,
            "collected": False, "seen_inat_ids": [],
        }
    else:
        manifest["species"][label]["scientific"] = sci  # keep sci name fresh

def save_manifest_local():
    manifest["updated"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    p = os.path.join(WORK, MANIFEST_NAME)
    with open(p, "w") as f:
        json.dump(manifest, f, indent=2)
    return p

def push_manifest():
    p = save_manifest_local()
    api.upload_file(path_or_fileobj=p, path_in_repo=MANIFEST_NAME,
                    repo_id=HF_REPO_ID, repo_type="model",
                    commit_message="update manifest")
    print("[manifest] pushed to Hub")

# ==============================================================================
# 3. iNaturalist download -- cc0/cc-by/cc-by-nc, research-grade only
# ==============================================================================
INAT_URL = "https://api.inaturalist.org/v1/observations"
INAT_TAXA = "https://api.inaturalist.org/v1/taxa"
LICENSES = "cc0,cc-by,cc-by-nc"

_session = requests.Session()
_session.headers.update({"User-Agent": "findflower-vit/1.0 (educational, non-commercial)"})

def _inat_get(url, params, tries=4):
    for i in range(tries):
        try:
            r = _session.get(url, params=params, timeout=60)
            if r.status_code == 200:
                return r.json()
            if r.status_code == 429:  # rate limited -> back off
                time.sleep(5 * (i + 1))
                continue
            time.sleep(2 * (i + 1))
        except requests.RequestException:
            time.sleep(2 * (i + 1))
    return None

def resolve_taxon_id(scientific):
    data = _inat_get(INAT_TAXA, {"q": scientific, "rank": "species", "per_page": 1})
    time.sleep(INAT_SLEEP)
    if data and data.get("results"):
        return data["results"][0]["id"]
    return None

def folder_name(label):
    return label.replace("/", "_").replace(" ", "_")

def species_dir(label):
    d = os.path.join(DATA_DIR, folder_name(label))
    os.makedirs(d, exist_ok=True)
    return d

def count_local_images(label):
    d = species_dir(label)
    return len([f for f in os.listdir(d) if f.lower().endswith((".jpg", ".jpeg", ".png"))])

def pull_data_repo():
    """Restore previously-downloaded images from the HF dataset repo into
    DATA_DIR. This is what makes downloads survive a wiped Kaggle session."""
    try:
        local = snapshot_download(
            repo_id=HF_DATA_REPO, repo_type="dataset", token=HF_TOKEN,
            allow_patterns=["*/*.jpg", "*/*.jpeg", "*/*.png"])
    except Exception as e:
        print(f"[data] nothing to restore yet ({e})")
        return
    n = 0
    for root, _, files in os.walk(local):
        for f in files:
            if not f.lower().endswith((".jpg", ".jpeg", ".png")):
                continue
            rel = os.path.relpath(os.path.join(root, f), local)
            dst = os.path.join(DATA_DIR, rel)
            os.makedirs(os.path.dirname(dst), exist_ok=True)
            if not os.path.exists(dst):
                shutil.copy2(os.path.join(root, f), dst)
                n += 1
    print(f"[data] restored {n} images from {HF_DATA_REPO}")

def push_species_images(label):
    """Persist one species' images to the dataset repo. Called right after a
    species is collected so a mid-run kill never loses downloaded images."""
    d = species_dir(label)
    if not os.listdir(d):
        return
    try:
        api.upload_folder(folder_path=d, path_in_repo=folder_name(label),
                          repo_id=HF_DATA_REPO, repo_type="dataset",
                          commit_message=f"images: {label}")
    except Exception as e:
        print(f"  [data] image push failed for {label}: {e}")

def download_species(label):
    """Fetch up to TARGET_IMAGES cc-licensed research-grade photos for a species.
    Idempotent: skips iNat photo ids already recorded in the manifest."""
    info = manifest["species"][label]
    sci = info["scientific"]
    have = count_local_images(label)
    if have >= TARGET_IMAGES:
        return have

    taxon_id = resolve_taxon_id(sci)
    if not taxon_id:
        print(f"  [dl] {label}: could not resolve taxon '{sci}' -- skipping")
        return have

    seen = set(info.get("seen_inat_ids", []))
    ddir = species_dir(label)
    page = 1
    while have < TARGET_IMAGES:
        if elapsed() > DOWNLOAD_BUDGET_SECONDS:
            print("  [dl] download time budget reached")
            break
        params = {
            "taxon_id": taxon_id, "quality_grade": "research",
            "photo_license": LICENSES, "license": LICENSES,
            "per_page": INAT_PAGE_SIZE, "page": page,
            "order": "desc", "order_by": "votes",  # best-photographed first
        }
        data = _inat_get(INAT_URL, params)
        time.sleep(INAT_SLEEP)
        if not data or not data.get("results"):
            break
        for obs in data["results"]:
            if have >= TARGET_IMAGES:
                break
            for photo in obs.get("photos", []):
                pid = photo.get("id")
                if pid in seen:
                    continue
                seen.add(pid)
                url = photo.get("url", "")
                # iNat "square" thumb -> request a larger "medium" version
                url = url.replace("square", "medium")
                if not url:
                    continue
                try:
                    ir = _session.get(url, timeout=60)
                    if ir.status_code != 200:
                        continue
                    img = Image.open(io.BytesIO(ir.content)).convert("RGB")
                    if min(img.size) < 80:   # drop tiny/broken images
                        continue
                    img.save(os.path.join(ddir, f"{pid}.jpg"), "JPEG", quality=90)
                    have += 1
                except Exception:
                    continue
                if have >= TARGET_IMAGES:
                    break
        page += 1
        if page > 60:   # safety bound on paging
            break

    info["seen_inat_ids"] = list(seen)[:5000]   # cap manifest size
    info["downloaded"] = have
    info["collected"] = have >= MIN_IMAGES
    return have

# ------------------------------------------------------------------------------
# 3a. Download loop -- only species that aren't collected yet, newest first.
# ------------------------------------------------------------------------------
print("\n[phase] DOWNLOAD")
# Restore any images collected on previous runs before deciding what's missing.
pull_data_repo()
# A species needs downloading if it doesn't yet have enough images ON DISK
# (after the restore above), regardless of manifest flags -- this is robust to
# a wiped Kaggle session and to newly-added species.
to_collect = [lbl for lbl in manifest["species"]
              if count_local_images(lbl) < MIN_IMAGES]
print(f"[dl] {len(to_collect)} species need images "
      f"(already have enough: {len(manifest['species']) - len(to_collect)})")

for idx, label in enumerate(to_collect, 1):
    if elapsed() > DOWNLOAD_BUDGET_SECONDS:
        print("[dl] stopping downloads -- time budget for this run reached")
        break
    n = download_species(label)
    status = "OK" if n >= MIN_IMAGES else "partial"
    print(f"  [{idx}/{len(to_collect)}] {label}: {n} images ({status})")
    # Persist this species' images immediately so a mid-run kill can't lose them.
    if n >= MIN_IMAGES:
        push_species_images(label)
    # Persist manifest every few species so a mid-run kill loses almost nothing.
    if idx % 5 == 0:
        try: push_manifest()
        except Exception as e: print(f"  [manifest] push skipped: {e}")

push_manifest()

# ==============================================================================
# 4. Assemble the trainable class set (species with enough images) & label map
# ==============================================================================
# Trainable = species that actually have >= MIN_IMAGES on disk right now, plus
# any class already in the trained model (so we never shrink the head).
collected = [lbl for lbl in manifest["species"]
             if count_local_images(lbl) >= MIN_IMAGES]
for lbl in manifest["classes"]:
    if lbl not in collected:
        collected.append(lbl)

if len(collected) < 2:
    print(f"\n[train] only {len(collected)} collected species available -- "
          "need >=2 to train. Downloaded progress is saved; re-run to gather "
          "more, then training will begin automatically.")
    push_manifest()
    print("[done] nothing to train this run.")
    raise SystemExit(0)

# Preserve existing class ordering (so old head indices stay valid), append new.
classes = list(manifest["classes"])
for lbl in collected:
    if lbl not in classes:
        classes.append(lbl)
label2id = {c: i for i, c in enumerate(classes)}
id2label = {i: c for c, i in label2id.items()}
num_labels = len(classes)
print(f"\n[train] classes this run: {num_labels} "
      f"(new since last: {num_labels - len(manifest['classes'])})")

# ==============================================================================
# 5. Load model -- resume from Hub checkpoint if present; grow head if needed
# ==============================================================================
def load_processor():
    try:
        return ViTImageProcessor.from_pretrained(HF_REPO_ID, token=HF_TOKEN)
    except Exception:
        return ViTImageProcessor.from_pretrained(BASE_MODEL)

processor = load_processor()

def try_load_checkpoint():
    """Return a model loaded from the Hub checkpoint, or None if none exists."""
    try:
        local = snapshot_download(repo_id=HF_REPO_ID, repo_type="model",
                                  token=HF_TOKEN,
                                  allow_patterns=["*.json", "*.safetensors", "*.bin"])
        if not os.path.exists(os.path.join(local, "config.json")):
            return None
        model = ViTForImageClassification.from_pretrained(local)
        print(f"[model] resumed checkpoint with {model.config.num_labels} labels")
        return model
    except (EntryNotFoundError, RepositoryNotFoundError):
        return None
    except Exception as e:
        print(f"[model] no usable checkpoint ({e})")
        return None

prev_model = try_load_checkpoint()

if prev_model is None:
    print("[model] initializing fresh from", BASE_MODEL)
    model = ViTForImageClassification.from_pretrained(
        BASE_MODEL, num_labels=num_labels,
        id2label=id2label, label2id=label2id,
        ignore_mismatched_sizes=True,
    )
else:
    old_num = prev_model.config.num_labels
    if old_num == num_labels:
        model = prev_model
        model.config.id2label = id2label
        model.config.label2id = label2id
    else:
        # ---- Grow the classification head, preserving old class weights ----
        print(f"[model] resizing head {old_num} -> {num_labels} (preserving weights)")
        model = prev_model
        in_features = model.classifier.in_features
        new_head = nn.Linear(in_features, num_labels)
        # Sensible init for the whole new layer...
        nn.init.xavier_uniform_(new_head.weight)
        nn.init.zeros_(new_head.bias)
        # ...then copy old rows for classes that already existed, by label name.
        old_id2label = {int(k): v for k, v in prev_model.config.id2label.items()}
        with torch.no_grad():
            for old_idx, lbl in old_id2label.items():
                if lbl in label2id and old_idx < model.classifier.weight.shape[0]:
                    new_idx = label2id[lbl]
                    new_head.weight[new_idx] = model.classifier.weight[old_idx]
                    new_head.bias[new_idx]   = model.classifier.bias[old_idx]
        model.classifier = new_head
        model.config.num_labels = num_labels
        model.config.id2label = id2label
        model.config.label2id = label2id

model.to(DEVICE)

# ==============================================================================
# 6. Dataset + augmentation (train) / clean resize (val)
# ==============================================================================
mean = processor.image_mean
std  = processor.image_std

train_tf = transforms.Compose([
    transforms.RandomResizedCrop(IMAGE_SIZE, scale=(0.7, 1.0)),  # zoom
    transforms.RandomHorizontalFlip(),
    transforms.RandomRotation(25),                                # rotation
    transforms.ColorJitter(0.25, 0.25, 0.25, 0.08),              # color jitter
    transforms.ToTensor(),
    transforms.Normalize(mean, std),
])
val_tf = transforms.Compose([
    transforms.Resize(int(IMAGE_SIZE * 1.14)),
    transforms.CenterCrop(IMAGE_SIZE),
    transforms.ToTensor(),
    transforms.Normalize(mean, std),
])

class FlowerDataset(Dataset):
    def __init__(self, samples, tf):
        self.samples, self.tf = samples, tf
    def __len__(self): return len(self.samples)
    def __getitem__(self, i):
        path, y = self.samples[i]
        try:
            img = Image.open(path).convert("RGB")
        except Exception:
            img = Image.new("RGB", (IMAGE_SIZE, IMAGE_SIZE))
        return self.tf(img), y

# Build sample list from local images of the collected classes.
all_samples = []
for lbl in classes:
    d = species_dir(lbl)
    if not os.path.isdir(d):
        continue
    files = [os.path.join(d, f) for f in os.listdir(d)
             if f.lower().endswith((".jpg", ".jpeg", ".png"))]
    for f in files:
        all_samples.append((f, label2id[lbl]))

random.shuffle(all_samples)
if len(all_samples) < BATCH_SIZE:
    print("[train] not enough images on disk this run to train; saving & exiting.")
    push_manifest()
    raise SystemExit(0)

# Stratified-ish split: shuffle already done; carve val by fraction per class.
by_class = defaultdict(list)
for s in all_samples:
    by_class[s[1]].append(s)
train_samples, val_samples = [], []
for y, items in by_class.items():
    k = max(1, int(len(items) * VAL_FRACTION))
    val_samples.extend(items[:k])
    train_samples.extend(items[k:])
random.shuffle(train_samples)

print(f"[data] train={len(train_samples)}  val={len(val_samples)}  "
      f"classes={num_labels}")

train_loader = DataLoader(FlowerDataset(train_samples, train_tf),
                          batch_size=BATCH_SIZE, shuffle=True,
                          num_workers=2, pin_memory=(DEVICE == "cuda"),
                          drop_last=True)
val_loader   = DataLoader(FlowerDataset(val_samples, val_tf),
                          batch_size=BATCH_SIZE, shuffle=False,
                          num_workers=2, pin_memory=(DEVICE == "cuda"))

# ==============================================================================
# 7. Save + push helpers (used incrementally, not just at the end)
# ==============================================================================
def save_checkpoint_local():
    model.save_pretrained(CKPT_DIR, safe_serialization=True)
    processor.save_pretrained(CKPT_DIR)
    with open(os.path.join(CKPT_DIR, "class_names.json"), "w") as f:
        json.dump(classes, f, indent=2)

def push_checkpoint(msg):
    save_checkpoint_local()
    api.upload_folder(folder_path=CKPT_DIR, repo_id=HF_REPO_ID,
                      repo_type="model", commit_message=msg)
    print(f"[push] checkpoint -> Hub ({msg})")

# ==============================================================================
# 8. Train -- differential LR (gentle backbone, faster head), epoch checkpoints
# ==============================================================================
backbone_params = [p for n, p in model.named_parameters() if not n.startswith("classifier")]
head_params     = [p for n, p in model.named_parameters() if n.startswith("classifier")]
optimizer = torch.optim.AdamW([
    {"params": backbone_params, "lr": LEARNING_RATE * 0.1},
    {"params": head_params,     "lr": LEARNING_RATE},
], weight_decay=0.01)
criterion = nn.CrossEntropyLoss()
scaler = torch.cuda.amp.GradScaler(enabled=(DEVICE == "cuda"))

@torch.no_grad()
def evaluate():
    model.eval()
    correct = total = 0
    for x, y in val_loader:
        x, y = x.to(DEVICE), y.to(DEVICE)
        with torch.cuda.amp.autocast(enabled=(DEVICE == "cuda")):
            logits = model(pixel_values=x).logits
        correct += (logits.argmax(1) == y).sum().item()
        total   += y.size(0)
    return correct / max(1, total)

print("\n[phase] TRAIN")
epochs_done_this_run = 0
for epoch in range(1, EPOCHS_PER_RUN + 1):
    # Stop starting a new epoch if we're near the session limit -- we still
    # need time to push. Each already-finished epoch was checkpointed below.
    if session_time_left() < 20 * 60:
        print(f"[train] ~{int(session_time_left()/60)} min left -- "
              "stopping before epoch to guarantee a clean push")
        break

    model.train()
    running, seen, t0 = 0.0, 0, time.monotonic()
    for step, (x, y) in enumerate(train_loader, 1):
        x, y = x.to(DEVICE), y.to(DEVICE)
        optimizer.zero_grad(set_to_none=True)
        with torch.cuda.amp.autocast(enabled=(DEVICE == "cuda")):
            logits = model(pixel_values=x).logits
            loss = criterion(logits, y)
        scaler.scale(loss).backward()
        scaler.step(optimizer)
        scaler.update()
        running += loss.item() * y.size(0)
        seen    += y.size(0)
        if step % 20 == 0:
            print(f"  e{epoch} step {step}/{len(train_loader)} "
                  f"loss={running/seen:.3f}")
        # Hard safety: if we blow the session budget mid-epoch, break out and
        # go straight to the push so completed steps aren't lost.
        if session_time_left() < 12 * 60:
            print("  [train] session budget nearly gone -- breaking epoch")
            break

    val_acc = evaluate()
    epochs_done_this_run += 1
    manifest["trained_epochs"] = manifest.get("trained_epochs", 0) + 1
    manifest["last_val_accuracy"] = val_acc
    print(f"[epoch {epoch}] train_loss={running/max(1,seen):.3f}  "
          f"val_acc={val_acc:.4f}  ({time.monotonic()-t0:.0f}s)")

    # INCREMENTAL checkpoint after every epoch -> forced stop never loses it.
    manifest["classes"] = classes
    try:
        push_checkpoint(f"epoch checkpoint (val_acc={val_acc:.3f}, "
                        f"classes={num_labels})")
        push_manifest()
    except Exception as e:
        print(f"  [push] epoch push failed (will retry at end): {e}")

# ==============================================================================
# 9. Finalize -- mark classes collected, push everything, report
# ==============================================================================
for lbl in collected:
    manifest["species"][lbl]["collected"] = True
manifest["classes"] = classes
manifest["runs"] = manifest.get("runs", 0) + 1

final_acc = manifest.get("last_val_accuracy")
try:
    push_checkpoint(f"end-of-run (run #{manifest['runs']}, "
                    f"classes={num_labels}, val_acc={final_acc})")
    push_manifest()
except Exception as e:
    print(f"[push] FINAL push failed: {e}\n{traceback.format_exc()}")

print("\n" + "=" * 70)
print(f"[DONE] run #{manifest['runs']}")
print(f"  classes trained:       {num_labels}")
print(f"  epochs this run:       {epochs_done_this_run}")
print(f"  cumulative epochs:     {manifest['trained_epochs']}")
print(f"  validation accuracy:   {final_acc:.4f}" if final_acc else
      "  validation accuracy:   n/a")
print(f"  species collected:     {len(collected)} / {len(manifest['species'])}")
print(f"  model + manifest on:   https://huggingface.co/{HF_REPO_ID}")
print("=" * 70)
print("Re-run anytime: it resumes from here. Edit SPECIES_LIST to grow it.")
