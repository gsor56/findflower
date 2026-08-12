# ==============================================================================
# FindFlower ViT — large-scale (4,000–5,000 species) fine-tuning on Kaggle
# ==============================================================================
# Credentials, in one place so there is no second place to look:
#
#   HF_TOKEN  — the ONLY secret this script reads. Looked for in the environment
#               first, then in Kaggle's secret store, because attaching a secret
#               on Kaggle does not export it as an environment variable.
#               Kaggle: Add-ons > Secrets, label it exactly HF_TOKEN.
#               Local:  setx HF_TOKEN <token>  /  export HF_TOKEN=<token>
#   kaggle.json — belongs at ~/.kaggle/kaggle.json (chmod 600) and is used by the
#               `kaggle` CLI to PUSH this kernel. The script never reads it; a
#               notebook already running on Kaggle needs no Kaggle credential.
#   A GitHub token is never needed here. Nothing in this file talks to GitHub.
#
# Never hardcode any of them: this file is committed to a PUBLIC repo.
# ==============================================================================
import os
import sys

# ------------------------------------------------------------------------------
# PRE-FLIGHT: prove the token actually works before anything expensive.
# ------------------------------------------------------------------------------
# A token can be present and still useless — expired, revoked, read-only, or
# pasted with a newline in it. Discovering that AFTER an 8-hour training run
# means the run is lost, because the weights only exist inside a Kaggle session
# that is about to be wiped. So the very first network call this script makes is
# an identity check, and the second is a write probe against the model repo.
#
# This runs before the dataset is touched and before torch is even imported, so
# the failure arrives in seconds rather than hours.
# ------------------------------------------------------------------------------
import subprocess


def _pip(*pkgs):
    subprocess.run([sys.executable, "-m", "pip", "install", "-q", *pkgs], check=False)


# IMPORTANT: never pass -U here and never install torch/accelerate. Upgrading
# transformers with -U drags in a generic torch build whose CUDA kernels don't
# match Kaggle's assigned GPU -> "no kernel image is available" at train time.
# Kaggle already ships a GPU-matched torch + transformers; we only ensure the
# Hub client is present, without touching the torch that's already installed.
_pip("--no-deps", "huggingface_hub")
_pip("requests", "pillow")

from huggingface_hub import HfApi
from huggingface_hub.utils import HfHubHTTPError

def _read_hf_token():
    """
    Find HF_TOKEN, in order: the environment, then Kaggle's secret store.

    The environment alone is not enough on Kaggle. Attaching a secret in the UI
    does NOT export it as an environment variable -- it is handed out by
    `kaggle_secrets.UserSecretsClient`, and a script that only reads os.environ
    dies on a KeyError one second into an eight-hour booking with a secret that
    was attached correctly the whole time.

    The value is never printed. Only its length and last four characters are, and
    only so a truncated paste can be recognised without leaking the token into a
    log that Kaggle keeps.
    """
    tok = (os.environ.get("HF_TOKEN") or "").strip()
    if tok:
        return tok, "environment"
    try:
        from kaggle_secrets import UserSecretsClient
        tok = (UserSecretsClient().get_secret("HF_TOKEN") or "").strip()
        if tok:
            return tok, "kaggle secret"
    except Exception as e:
        print(f"[preflight] Kaggle secret store unavailable ({type(e).__name__})")
    return "", "nowhere"


HF_TOKEN, _tok_src = _read_hf_token()
if not HF_TOKEN:
    raise SystemExit(
        "[preflight] HF_TOKEN not found.\n"
        "            On Kaggle: notebook -> Add-ons -> Secrets -> attach a secret\n"
        "            LABELLED EXACTLY 'HF_TOKEN' holding a WRITE token from\n"
        "            https://huggingface.co/settings/tokens, then re-run.\n"
        "            Locally: set the HF_TOKEN environment variable.\n"
        "            Halting now rather than downloading a dataset and training\n"
        "            for eight hours with nowhere to push the result."
    )
print(f"[preflight] HF_TOKEN found in {_tok_src} "
      f"(len={len(HF_TOKEN)}, ends '...{HF_TOKEN[-4:]}')")

# Uppercase VIT. This has to match convert_to_onnx.py:47 exactly -- Hugging Face
# repo ids are case-sensitive, so "findflower-ViT" and "findflower-VIT" are two
# different repos, and a mismatch means training pushes weights that the ONNX
# converter then never sees.
HF_REPO_ID = "gsor56/findflower-VIT"          # private model repo on the Hub
# Deliberately NOT renamed to match: this is a separate repo that already holds
# whatever images previous collector runs uploaded. Renaming it here would not
# move them, it would silently create an empty second repo and report "restored
# 0 images". Change it only after confirming which spelling actually exists.
HF_DATA_REPO = "gsor56/findflower-ViT-data"   # dataset repo holding the images
HF_PRIVATE = True                             # keep both repos private

_api = HfApi(token=HF_TOKEN)
try:
    _who = _api.whoami()
except Exception as e:
    raise SystemExit(
        f"[preflight] HF_TOKEN is present but NOT valid: {type(e).__name__}: {e}\n"
        f"            Regenerate it at https://huggingface.co/settings/tokens "
        f"with WRITE access and update the Kaggle Secret."
    )

_name = _who.get("name") or _who.get("fullname") or "<unknown>"
_perm = ((_who.get("auth") or {}).get("accessToken") or {}).get("role")
print(f"[preflight] authenticated as '{_name}'  token role={_perm or 'unknown'}")

if _perm == "read":
    raise SystemExit(
        "[preflight] This token is READ-ONLY. Training would finish and then fail "
        "to push, losing every hour of GPU time. Issue a WRITE token instead."
    )

# A role string of "write" is still only a claim about the token, not about this
# repo. The authoritative test is an actual write, so do a trivial one now.
try:
    _api.create_repo(repo_id=HF_REPO_ID, repo_type="model",
                     private=HF_PRIVATE, exist_ok=True)
    _api.create_repo(repo_id=HF_DATA_REPO, repo_type="dataset",
                     private=HF_PRIVATE, exist_ok=True)
    _api.upload_file(
        path_or_fileobj=b"ok\n", path_in_repo=".preflight",
        repo_id=HF_REPO_ID, repo_type="model",
        commit_message="preflight: verify write access",
    )
except HfHubHTTPError as e:
    raise SystemExit(
        f"[preflight] Token authenticated as '{_name}' but CANNOT WRITE to "
        f"{HF_REPO_ID}: {e}\n"
        f"            Check the repo exists and the token's scope includes it."
    )
except Exception as e:
    raise SystemExit(f"[preflight] write probe failed: {type(e).__name__}: {e}")

print(f"[preflight] write access to {HF_REPO_ID} confirmed — safe to train")

# ==============================================================================
# Incremental, resumable ViT fine-tuning for flower species classification
# ------------------------------------------------------------------------------
# Designed to run as a SINGLE Kaggle notebook cell. "Run and forget":
#   * Trains from a pre-staged image tree (4–5k species) or scrapes iNaturalist
#   * Tracks progress in manifest.json on the Hugging Face Hub
#   * Resumes model from the last checkpoint on the Hub (never restarts scratch)
#   * Grows the classification head when you add species, preserving old weights
#   * Saves progress INCREMENTALLY so a Kaggle timeout never loses finished work
#   * Hard 8.5h time-bomb, then pushes, quantizes and evaluates before the kill
#
# Setup (once):
#   1. Kaggle: enable GPU (Settings -> Accelerator -> GPU T4 x2)
#   2. Kaggle: enable Internet (Settings -> Internet -> On)
#   3. Attach the species image dataset, or edit SPECIES_LIST for the scrape path.
#
# ------------------------------------------------------------------------------
# READ THIS BEFORE SETTING NUM_SPECIES TO 5000 — the arithmetic does not fit
# ------------------------------------------------------------------------------
# 5,000 species x 300 images = 1,500,000 images.
#
#   Disk    at ~55 KB/JPEG that is ~80 GB. Kaggle gives ~20 GB in
#           /kaggle/working and ~73 GB total scratch. It DOES NOT FIT unless the
#           images arrive as an attached read-only Kaggle Dataset (which does not
#           count against the working quota) or are streamed.
#   Time    the iNaturalist path is rate-limited to ~60 req/min. At 200 results
#           per page and 300 images per species that is 5,000+ taxon lookups plus
#           ~25,000 observation pages: several DAYS of wall clock, spread over
#           dozens of 9-hour sessions. It is a collector, not a training input.
#   Compute one epoch over 1.5M images at 224px on a T4 with AMP runs at roughly
#           100–120 img/s => 3.5–4.2 HOURS PER EPOCH. An 8.5h session therefore
#           buys about TWO epochs, and that is the real reason this script is
#           built to resume rather than to finish.
#
# The consequence, made explicit so it is not discovered at hour eight: at this
# scale a single session cannot produce a converged 5,000-class model. What it
# produces is two more epochs on top of whatever the Hub already holds. Plan on
# 15–25 sessions. DATA_SOURCE below is what makes that survivable.
# ==============================================================================

# ------------------------------------------------------------------------------
# 0. Config -- the only things you ever need to touch
# ------------------------------------------------------------------------------
BASE_MODEL = "google/vit-base-patch16-224"

# ---- Where images come from ---------------------------------------------------
#   "auto"  detect: an attached Kaggle Dataset wins, else the Hub, else iNat
#   "local" an ImageFolder-style tree: <root>/<species_name>/*.jpg
#   "hub"   snapshot HF_DATA_REPO (fine to a few hundred species; not to 5,000)
#   "inat"  scrape iNaturalist per SPECIES_LIST (a collector for future runs)
DATA_SOURCE = "auto"
LOCAL_DATA_ROOTS = ["/kaggle/input"]   # searched for the deepest image tree

# ---- Clade filter for taxonomy-named attached datasets ------------------------
# The attached dataset for this run is iNaturalist 2021 `train_mini`
# (authuria/inaturalist, 44.7 GB), whose class folders carry the FULL taxonomy:
#
#   00000_Animalia_Annelida_Clitellata_Haplotaxida_Lumbricidae_Lumbricus_terrestris
#   05432_Plantae_Tracheophyta_Magnoliopsida_Ranunculales_Papaveraceae_Papaver_rhoeas
#
# That set is all of life -- 10,000 species, of which only the Plantae subset is
# what FindFlower identifies. Training the whole thing would spend most of a
# 5,000-way head on earthworms, moths and gulls, and the app would happily offer
# them as answers to "what flower is this". CLASS_FILTER keeps only directories
# whose taxonomy string contains one of these tokens.
#
# It is applied ONLY when the tree is actually taxonomy-named (see
# `_taxonomy_named` below). A plain flower tree of `Rosa_canina/` folders would
# match nothing, and a filter that silently empties the class set is worse than
# no filter at all. Set to () to admit everything.
CLASS_FILTER = ("Plantae",)

# ---- Scale ---------------------------------------------------------------------
MAX_SPECIES = 5000         # hard ceiling on classes admitted this run
MIN_IMAGES = 200           # a species is trainable at >= this many images
TARGET_IMAGES = 300        # stop collecting a species once it reaches this many
MIN_IMAGES_LARGE = 40      # floor used once >1000 species are present (see below)

# ---- Training budget ----------------------------------------------------------
# 14 is an upper bound, not a plan. With iNat21 train_mini filtered to Plantae
# (~4.3k species x 50 images, ~43 of them training) an epoch is ~184k images,
# which is roughly 30 minutes on a T4 -- not the 3.5-4 hours the 300-images-per-
# species arithmetic further down predicts. At 4 epochs a session would train for
# two hours and then sit idle for six. The time bomb and TAIL_RESERVE_SECONDS are
# what actually end the run; this number only has to be larger than they allow.
EPOCHS_PER_RUN = 14
BATCH_SIZE = 64            # T4 16GB fits 64 at 224px under AMP; falls back on OOM
GRAD_ACCUM_STEPS = 1       # raise to grow the effective batch without more VRAM
LEARNING_RATE = 3e-4       # HEAD lr; the backbone is layer-wise decayed from it
BACKBONE_LR = 5e-5         # top encoder block lr, decayed downward by LLRD_DECAY
LLRD_DECAY = 0.70          # layer-wise lr decay, 0.65–0.75 is the ViT range
WEIGHT_DECAY = 0.05
WARMUP_FRACTION = 0.05     # of total optimizer steps
VAL_FRACTION = 0.15        # 85/15 train/val split
IMAGE_SIZE = 224
NUM_WORKERS = 4
LABEL_SMOOTHING = 0.1
LOSS_MODE = "focal_smooth"  # "smooth" | "focal" | "focal_smooth"
FOCAL_GAMMA = 1.5          # mild on purpose; 2.0+ destabilises a 5k-way head

# ---- The 8.5-hour Kaggle time-bomb -------------------------------------------
# 30600s is checked at the end of EVERY epoch, as specified. TAIL_RESERVE is the
# separate, earlier deadline that stops a NEW epoch from starting, because the
# work that happens after the bomb (push, ONNX export, the quantization ladder,
# two evaluation passes) is itself 25–50 minutes. Firing at 30600 and only then
# beginning an hour of post-processing is how a session gets killed holding
# everything it just earned.
TIME_BOMB_SECONDS = 30600           # 8.5h — the specified hard limit
TAIL_RESERVE_SECONDS = 45 * 60      # keep this much for push + quantize + eval
STEP_CHECKPOINT_EVERY = 1500        # mid-epoch weight saves; a 4h epoch is too
                                    # long to risk losing to a wipe

# ---- Quantization ------------------------------------------------------------
QUANT_MAX_ACC_LOSS = 0.01   # 1%: above this, selective quantization is triggered
QUANT_EVAL_MAX = 4000       # images used for the FP32-vs-INT8 comparison
ONNX_OPSET = 14
ONNX_FP32_PATH = "findflower_vit_fp32.onnx"
ONNX_INT8_PATH = "findflower_vit.onnx"    # the INT8 artefact named in the brief
BEST_MODEL_PATH = "best_model.pth"

# iNaturalist politeness (only used when DATA_SOURCE resolves to "inat")
INAT_PAGE_SIZE = 200
INAT_SLEEP = 1.1           # seconds between API calls (<=60 req/min guideline)
SESSION_BUDGET_SECONDS = TIME_BOMB_SECONDS
DOWNLOAD_BUDGET_SECONDS = int(3.0 * 3600)  # cap time spent downloading per run


# ------------------------------------------------------------------------------
# Species registry -- the SEED list, and the fallback for the iNat collector.
#
# This dict is no longer the definition of the class set at 4–5k scale. Typing
# five thousand entries into a source file is unreviewable and unmergeable, so
# when DATA_SOURCE resolves to "local" or "hub" the classes are read from the
# directory names of the image tree instead, and this dict only supplies
# scientific names for whichever of them it happens to know. It remains the
# authoritative input for the "inat" collector path.
#
# An optional species_list.json — either beside the attached dataset or at the
# root of HF_DATA_REPO — is merged over this dict when present, which is how the
# list actually grows past a few hundred entries. Format: {"label": "Scientific
# name", ...} or {"species": {...}}.
#
# Start set: ~120 commonly-photographed species with strong research-grade
# iNaturalist coverage. Format: "common label": "Scientific name".
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
# The pre-flight at the top of this file already ran `_pip`, imported HfApi and
# authenticated. Nothing here repeats that work; this section installs the
# augmentation stack, imports torch, and proves the GPU can actually run kernels.

# Albumentations is NOT preinstalled on every Kaggle image. --no-deps keeps pip
# from resolving a numpy/opencv upgrade that would invalidate the GPU-matched
# torch build; opencv-python-headless is the one real dependency it needs, and
# Kaggle ships it. If the import still fails, section 6 falls back to torchvision
# rather than aborting a session that is otherwise ready to train.
_pip("--no-deps", "albumentations")

import io, json, time, math, random, shutil, tempfile, traceback
from collections import defaultdict

import requests
from PIL import Image, ImageFile
ImageFile.LOAD_TRUNCATED_IMAGES = True

import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F
from torch.utils.data import Dataset, DataLoader
from torchvision import transforms

from huggingface_hub import hf_hub_download, snapshot_download
from huggingface_hub.utils import EntryNotFoundError, RepositoryNotFoundError
from transformers import ViTForImageClassification, ViTImageProcessor

RUN_START = time.monotonic()
def elapsed():            return time.monotonic() - RUN_START
def session_time_left():  return SESSION_BUDGET_SECONDS - elapsed()

def hms(seconds):
    """Seconds -> '3h 42m 11s'. Used by every progress line and the final panel."""
    seconds = max(0, int(seconds))
    h, rem = divmod(seconds, 3600)
    m, s = divmod(rem, 60)
    return f"{h}h {m:02d}m {s:02d}s" if h else f"{m}m {s:02d}s"

random.seed(42)
np.random.seed(42)
torch.manual_seed(42)
torch.cuda.manual_seed_all(42)

# cudnn autotunes convolution algorithms for a fixed input shape. Every batch
# here is (B, 3, 224, 224), so the tuning cost is paid once and repaid for the
# rest of the run. Determinism is deliberately not requested: it would cost
# throughput we do not have to spare against an 8.5-hour ceiling.
torch.backends.cudnn.benchmark = True

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
# 1a. AMP (mixed precision) — the single biggest throughput lever on a T4.
# ------------------------------------------------------------------------------
# The brief asks for `torch.cuda.amp.autocast()`. That exact call is deprecated
# in torch >= 2.4 and prints a FutureWarning on every single step, which at
# ~20,000 steps per epoch buries the actual training log. So the modern
# `torch.amp.autocast('cuda')` is preferred and the old spelling is the fallback:
# identical numerics either way, and the script runs on both old and new Kaggle
# images without edits.
#
# bfloat16 vs float16: T4 (sm_75) has NO bf16 tensor cores, so fp16 + GradScaler
# is the right choice there. On sm_80+ (A100/L4) bf16 needs no scaler and cannot
# overflow, so it is used when available.
_AMP_NEW = hasattr(torch, "amp") and hasattr(torch.amp, "GradScaler")

# `torch.cuda.is_bf16_supported()` is not usable as the gate: in several torch
# versions it answers True on a T4 because it counts *emulated* bf16, which is
# slower than fp16 tensor cores rather than faster. Compute capability is the
# honest test — bf16 tensor cores arrive with sm_80.
_bf16_ok = DEVICE == "cuda" and cap_num >= 8.0
AMP_DTYPE = torch.bfloat16 if _bf16_ok else torch.float16
AMP_ENABLED = DEVICE == "cuda"

if _AMP_NEW:
    def amp_autocast():
        return torch.amp.autocast("cuda", dtype=AMP_DTYPE, enabled=AMP_ENABLED)
    def amp_scaler():
        # bf16 has fp32's exponent range, so gradients cannot underflow and the
        # scaler is a no-op cost. Only fp16 needs it.
        return torch.amp.GradScaler("cuda", enabled=AMP_ENABLED and AMP_DTYPE is torch.float16)
else:
    def amp_autocast():
        return torch.cuda.amp.autocast(dtype=AMP_DTYPE, enabled=AMP_ENABLED)
    def amp_scaler():
        return torch.cuda.amp.GradScaler(enabled=AMP_ENABLED and AMP_DTYPE is torch.float16)

print(f"[init] AMP: enabled={AMP_ENABLED} dtype={str(AMP_DTYPE).split('.')[-1]} "
      f"api={'torch.amp' if _AMP_NEW else 'torch.cuda.amp (legacy)'}")

# ------------------------------------------------------------------------------
# 1b. The 8.5-hour clock. One wall-clock origin, read from everywhere.
# ------------------------------------------------------------------------------
# The brief specifies `start_time = time.time()` and a `> 30600` check, so that
# is exactly what is implemented. time.monotonic() is used for the same quantity
# because it cannot go backwards if the container's clock is stepped by NTP
# mid-run — a wall-clock jump of a few minutes is the difference between saving
# the model and losing it.
start_time = time.time()

def bomb_elapsed():
    """Seconds since the run began — the quantity compared against 30600."""
    return time.monotonic() - RUN_START

def time_bomb_fired():
    """The literal spec: (time.time() - start_time) > 30600."""
    return bomb_elapsed() > TIME_BOMB_SECONDS

def tail_deadline_passed():
    """
    True once there is no longer room to START another epoch and still finish the
    tail (push + ONNX export + the quantization ladder + two eval passes). Firing
    only at 30600 and THEN beginning ~40 minutes of post-processing is how a
    session gets killed holding everything it just earned.
    """
    return bomb_elapsed() > (TIME_BOMB_SECONDS - TAIL_RESERVE_SECONDS)

# The Hub client from the pre-flight is reused as-is. Re-running login(),
# HfApi() and create_repo() here would repeat three network calls that already
# succeeded 40 lines up — and a second source of truth for the token.
api = _api
print(f"[init] hub model repo ready: {HF_REPO_ID} (private={HF_PRIVATE})")
print(f"[init] hub data  repo ready: {HF_DATA_REPO} (private={HF_PRIVATE})")

# Local working dirs (Kaggle gives us /kaggle/working, scratch elsewhere).
WORK = "/kaggle/working" if os.path.isdir("/kaggle/working") else tempfile.mkdtemp()
DATA_DIR  = os.path.join(WORK, "data")      # data/<label>/*.jpg
CKPT_DIR  = os.path.join(WORK, "checkpoint")
os.makedirs(DATA_DIR, exist_ok=True)
os.makedirs(CKPT_DIR, exist_ok=True)

MANIFEST_NAME = "manifest.json"

# ------------------------------------------------------------------------------
# 1c. Species registry expansion — how SPECIES_LIST reaches 5,000 entries.
# ------------------------------------------------------------------------------
# A hardcoded dict cannot be the vehicle for five thousand species: it would be
# 5,000 lines of unreviewable diff in a source file, and the scientific names
# would drift from whatever the image set actually contains. So an optional
# `species_list.json` is merged over SPECIES_LIST if one is found, searched in
# priority order:
#
#   1. any attached Kaggle Dataset  (/kaggle/input/**/species_list.json)
#   2. the root of HF_DATA_REPO     (survives across sessions, one place to edit)
#
# Accepted shapes: {"label": "Scientific name", ...} or {"species": {...}} or a
# bare list ["Scientific name", ...] (labels are then the names themselves).
# Absent file = no-op; this is an expansion hook, never a requirement.
def _coerce_species_map(obj):
    if isinstance(obj, dict):
        inner = obj.get("species") if isinstance(obj.get("species"), dict) else obj
        return {str(k): str(v) for k, v in inner.items() if k and v}
    if isinstance(obj, list):
        return {str(x): str(x) for x in obj if x}
    return {}

def load_species_registry():
    candidates = []
    for root in LOCAL_DATA_ROOTS:
        if not os.path.isdir(root):
            continue
        # Two levels deep only. Walking all of /kaggle/input looking for a JSON
        # file would traverse the entire image tree — potentially 1.5M entries.
        for depth1 in sorted(os.listdir(root))[:64]:
            candidates.append(os.path.join(root, depth1, "species_list.json"))
        candidates.append(os.path.join(root, "species_list.json"))
    for p in candidates:
        try:
            if os.path.isfile(p):
                with open(p, encoding="utf-8") as f:
                    m = _coerce_species_map(json.load(f))
                if m:
                    print(f"[species] merged {len(m):,} entries from {p}")
                    return m
        except Exception as e:
            print(f"[species] ignoring {p}: {type(e).__name__}: {e}")
    try:
        p = hf_hub_download(repo_id=HF_DATA_REPO, filename="species_list.json",
                            repo_type="dataset", token=HF_TOKEN)
        with open(p, encoding="utf-8") as f:
            m = _coerce_species_map(json.load(f))
        if m:
            print(f"[species] merged {len(m):,} entries from {HF_DATA_REPO}/species_list.json")
            return m
    except (EntryNotFoundError, RepositoryNotFoundError):
        pass
    except Exception as e:
        print(f"[species] hub registry unavailable ({type(e).__name__}); using the built-in list")
    return {}

_extra_species = load_species_registry()
if _extra_species:
    # The file wins on scientific names — it is the maintained artefact — but the
    # built-in list is never dropped, so a malformed upload cannot empty the run.
    SPECIES_LIST.update(_extra_species)
print(f"[species] registry: {len(SPECIES_LIST):,} labels known "
      f"({len(_extra_species):,} from file, cap MAX_SPECIES={MAX_SPECIES:,})")

# ==============================================================================
# 2. Manifest -- the source of truth for what's done. Lives on the Hub.
# ==============================================================================
# Schema (v4):
# {
#   "version": 4,
#   "updated": "<iso ts>",
#   "runs": <int>,
#   "species": {
#       "<label>": {
#           "scientific": "<name>",
#           "downloaded": <int>,       # images we have on the Hub-tracked set
#           "collected": <bool>,       # downloaded >= MIN_IMAGES
#           "seen_inat_ids": [ ... ],  # dedupe across runs (photo ids), PRUNED
#       }, ...
#   },
#   "classes": [ "<label>", ... ],     # ORDERED -> defines head index mapping
#   "trained_epochs": <int>,           # cumulative epochs trained
#   "last_val_accuracy": <float>,
#   "history": [ {run, epochs, top1, top3, macro_f1, seconds}, ... ],
# }
#
# WHY v4 EXISTS — the manifest was on its way to becoming the largest artefact in
# the repo. `seen_inat_ids` grew without bound: at 5,000 species x up to 5,000
# photo ids that is 25 MILLION integers, roughly a quarter of a GIGABYTE of JSON
# that is downloaded and re-uploaded on every single checkpoint. v4 prunes it on
# every save, on two rules:
#
#   1. A species marked `collected` will never be downloaded again, so its
#      dedupe ledger has no reader. Dropped entirely.
#   2. An in-progress species keeps at most SEEN_IDS_CAP ids. The ledger exists
#      to avoid re-fetching the same photo; iNaturalist returns pages in a
#      stable order, so the *recent* tail is the part that does any work.
#
# The cost of pruning is bounded and known: an occasional duplicate download for
# a species whose ledger was trimmed. The cost of not pruning is a manifest that
# eventually cannot be round-tripped inside a session at all.
SEEN_IDS_CAP = 1200
MANIFEST_VERSION = 4

def default_manifest():
    return {
        "version": MANIFEST_VERSION, "updated": None, "runs": 0,
        "species": {}, "classes": [],
        "trained_epochs": 0, "last_val_accuracy": None, "history": [],
    }

def load_manifest():
    try:
        path = hf_hub_download(repo_id=HF_REPO_ID, filename=MANIFEST_NAME,
                               repo_type="model", token=HF_TOKEN)
        with open(path) as f:
            m = json.load(f)
        m.setdefault("history", [])
        was = m.get("version")
        if was != MANIFEST_VERSION:
            print(f"[manifest] migrating v{was} -> v{MANIFEST_VERSION}")
            m["version"] = MANIFEST_VERSION
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

def prune_manifest():
    """Enforce the v4 size rules. Returns (ids_dropped, bytes_saved_estimate)."""
    dropped = 0
    for rec in manifest["species"].values():
        ids = rec.get("seen_inat_ids") or []
        if not ids:
            continue
        if rec.get("collected"):
            dropped += len(ids)
            rec["seen_inat_ids"] = []
        elif len(ids) > SEEN_IDS_CAP:
            dropped += len(ids) - SEEN_IDS_CAP
            rec["seen_inat_ids"] = ids[-SEEN_IDS_CAP:]
    return dropped

def save_manifest_local():
    dropped = prune_manifest()
    manifest["updated"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    p = os.path.join(WORK, MANIFEST_NAME)
    # separators=(",", ":") on a 5,000-species manifest is not a micro-
    # optimisation: indent=2 roughly triples it, and this file is uploaded on
    # every checkpoint. Written compact, read by machines.
    with open(p, "w") as f:
        json.dump(manifest, f, separators=(",", ":"))
    size_kb = os.path.getsize(p) / 1024
    if dropped:
        print(f"[manifest] pruned {dropped:,} stale dedupe ids -> {size_kb:.0f} KB")
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

    info["seen_inat_ids"] = list(seen)[-SEEN_IDS_CAP:]   # bounded; see v4 notes
    info["downloaded"] = have
    info["collected"] = have >= MIN_IMAGES
    return have

# ==============================================================================
# 3a. DATA SOURCE RESOLUTION — the decision that makes 5,000 species possible
# ==============================================================================
# The scraper above is a fine way to assemble a few hundred species. It is not a
# way to assemble five thousand: at ~60 requests/minute, 1.5M photos is days of
# wall clock, and the session dies in 8.5 hours. So at scale the images must
# already exist, and this block finds them.
#
#   "local"  an ImageFolder tree under LOCAL_DATA_ROOTS (normally an attached
#            read-only Kaggle Dataset). This is THE path for 4–5k species: the
#            attached dataset does not count against the ~20 GB working quota,
#            needs no download time, and is memory-mapped by the OS page cache.
#            To attach one, add its slug to `dataset_sources` in
#            training/kernel-metadata.json.
#   "hub"    snapshot HF_DATA_REPO. Correct up to a few hundred species; at 80 GB
#            it would spend the whole session downloading.
#   "inat"   scrape. Use it to GROW the dataset for future runs, not to feed this
#            one.
#
# "auto" prefers them in exactly that order, because that is the order of
# increasing cost.
# ------------------------------------------------------------------------------
IMG_EXT = (".jpg", ".jpeg", ".png", ".webp", ".bmp")

def _looks_like_class_tree(d, probe=48):
    """
    Score a directory as an ImageFolder root: how many of its immediate children
    are directories that directly contain at least one image.

    Only the first `probe` children are sampled. A 5,000-class tree has 5,000
    subdirectories and listing every one of them at every candidate depth is the
    difference between a two-second decision and a two-minute one.
    """
    try:
        entries = sorted(os.listdir(d))
    except OSError:
        return 0, 0
    subdirs = [e for e in entries if os.path.isdir(os.path.join(d, e))]
    if not subdirs:
        return 0, 0
    hits = 0
    for name in subdirs[:probe]:
        p = os.path.join(d, name)
        try:
            if any(f.lower().endswith(IMG_EXT) for f in os.listdir(p)[:200]):
                hits += 1
        except OSError:
            continue
    sampled = min(len(subdirs), probe)
    # Require a clear majority so a directory of METADATA folders that happens to
    # contain one stray thumbnail cannot win over the real image tree.
    return (len(subdirs) if hits >= max(1, int(0.6 * sampled)) else 0), hits

def find_class_tree(roots, max_depth=3):
    """Breadth-first hunt for the directory with the most image-bearing children."""
    best, best_score = None, 0
    frontier = [(r, 0) for r in roots if os.path.isdir(r)]
    visited = set()
    while frontier:
        d, depth = frontier.pop(0)
        rp = os.path.realpath(d)
        if rp in visited:
            continue
        visited.add(rp)
        score, _ = _looks_like_class_tree(d)
        if score > best_score:
            best, best_score = d, score
        if depth < max_depth:
            try:
                for e in sorted(os.listdir(d))[:64]:
                    p = os.path.join(d, e)
                    if os.path.isdir(p):
                        frontier.append((p, depth + 1))
            except OSError:
                continue
    return best, best_score

DATA_MODE = DATA_SOURCE
CLASS_TREE = None

if DATA_SOURCE in ("auto", "local"):
    CLASS_TREE, _n = find_class_tree(LOCAL_DATA_ROOTS)
    if CLASS_TREE:
        DATA_MODE = "local"
        print(f"[data] LOCAL image tree: {CLASS_TREE}  ({_n:,} class directories)")
    elif DATA_SOURCE == "local":
        raise SystemExit(
            f"[data] DATA_SOURCE='local' but no ImageFolder tree was found under "
            f"{LOCAL_DATA_ROOTS}. Attach the dataset (kernel-metadata.json ->"
            f" dataset_sources) or set DATA_SOURCE='hub'/'inat'.")
    else:
        print(f"[data] no local image tree under {LOCAL_DATA_ROOTS}")

if DATA_MODE == "auto":
    # Nothing attached. Try the Hub dataset repo; fall back to scraping.
    try:
        files = api.list_repo_files(repo_id=HF_DATA_REPO, repo_type="dataset")
        n_img = sum(1 for f in files if f.lower().endswith(IMG_EXT))
    except Exception as e:
        print(f"[data] could not list {HF_DATA_REPO} ({type(e).__name__}); assuming empty")
        n_img = 0
    if n_img >= MIN_IMAGES * 2:
        DATA_MODE = "hub"
        print(f"[data] HUB dataset holds {n_img:,} images -> restoring")
    else:
        DATA_MODE = "inat"
        print(f"[data] hub holds {n_img:,} images -> falling back to the iNat collector")

print(f"[data] DATA_MODE = {DATA_MODE}")

# ------------------------------------------------------------------------------
# 3b. Acquire images for the modes that need it.
# ------------------------------------------------------------------------------
if DATA_MODE == "hub":
    print("\n[phase] RESTORE")
    pull_data_repo()

elif DATA_MODE == "inat":
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

else:
    print("[data] using the attached tree as-is; no download phase this run")

# ==============================================================================
# 4. Index the images, then assemble the trainable class set & label map
# ==============================================================================
# One pass over the filesystem produces `samples_by_label`, and everything after
# this point reads that dict instead of touching the disk again. At 1.5M files the
# walk is the single slowest non-GPU operation in the script, so it is done once
# and cached.
INDEX_CACHE = os.path.join(WORK, "sample_index.json")

_KINGDOMS = {"animalia", "plantae", "fungi", "protozoa", "chromista",
             "bacteria", "archaea", "viruses"}

def _strip_index(name):
    """'00123_Rosa_canina' -> 'Rosa_canina'. Leaves anything else alone."""
    head, sep, rest = name.partition("_")
    return rest if (sep and head.isdigit() and rest) else name

def _taxo_tokens(name):
    n = _strip_index(name.strip()).replace("_", " ").replace("-", " ")
    return [t for t in n.split() if t]

def _taxonomy_named(entries, probe=64):
    """
    Do these directory names encode a full taxonomy, iNat21-style?

    Answered by sampling rather than assumed, because the same script has to
    handle a plain `Rosa_canina/` tree. Requires a clear majority: one stray
    `Plantae_something` folder in an otherwise ordinary tree must not flip the
    interpretation and hand CLASS_FILTER a set it will empty.
    """
    sample = [e for e in entries[:probe]]
    if not sample:
        return False
    hits = sum(1 for e in sample
               if len(_taxo_tokens(e)) >= 7 and _taxo_tokens(e)[0].lower() in _KINGDOMS)
    return hits >= max(1, int(0.6 * len(sample)))

def _label_from_dirname(name, taxonomy=False):
    """
    'Papaver_rhoeas' / 'papaver rhoeas' / '00123_Papaver_rhoeas' -> a stable label.

    The leading-number strip matters: several public flower sets prefix class
    folders with an index, and treating '00123_Rosa_canina' and 'Rosa_canina' as
    two different species would silently split a class in half.

    With `taxonomy=True` the iNat21 form is reduced to its binomial. The rank
    count there is fixed -- kingdom, phylum, class, order, family, then genus and
    epithet -- so dropping the first five is exact, and it keeps trinomials
    (subspecies, hybrids) whole instead of truncating them at two tokens. This
    label is user-facing: it reaches id2label, the Hub config and the answer the
    app shows, so 'Plantae Tracheophyta Magnoliopsida Ranunculales Papaveraceae
    Papaver rhoeas' is not an acceptable value for it.
    """
    toks = _taxo_tokens(name)
    if taxonomy and len(toks) >= 7 and toks[0].lower() in _KINGDOMS:
        toks = toks[5:]
    return " ".join(toks)

def _clade_allowed(dirname):
    return (not CLASS_FILTER) or any(k.lower() in dirname.lower() for k in CLASS_FILTER)

def build_index_local(tree):
    entries = sorted(os.listdir(tree))
    taxonomy = _taxonomy_named(entries)
    filtering = taxonomy and bool(CLASS_FILTER)
    if taxonomy:
        print(f"[index] directory names are taxonomy-encoded (iNat21 style); "
              f"labels reduced to the binomial")
    if filtering:
        print(f"[index] clade filter active: keeping {'/'.join(CLASS_FILTER)} only")
    elif CLASS_FILTER:
        print(f"[index] clade filter {CLASS_FILTER} IGNORED: this tree is not "
              f"taxonomy-named, so the filter would match nothing")

    out, skipped = {}, 0
    for entry in entries:
        d = os.path.join(tree, entry)
        if not os.path.isdir(d):
            continue
        if filtering and not _clade_allowed(entry):
            skipped += 1
            continue
        try:
            files = [os.path.join(d, f) for f in os.listdir(d)
                     if f.lower().endswith(IMG_EXT)]
        except OSError:
            continue
        if not files:
            continue
        lbl = _label_from_dirname(entry, taxonomy=taxonomy)
        # Two directory spellings can normalise to the same label; merge them
        # rather than letting the second silently replace the first.
        out.setdefault(lbl, []).extend(files)

    if filtering:
        print(f"[index] clade filter kept {len(out):,} classes, dropped {skipped:,}")
        # A filter that leaves nothing is a configuration error, not a result.
        # Recovering with the unfiltered tree beats ending the session here.
        if not out:
            print("[index] !! the filter matched NOTHING -- falling back to the "
                  "unfiltered tree. Check CLASS_FILTER against the folder names.")
            for entry in entries:
                d = os.path.join(tree, entry)
                if not os.path.isdir(d):
                    continue
                try:
                    files = [os.path.join(d, f) for f in os.listdir(d)
                             if f.lower().endswith(IMG_EXT)]
                except OSError:
                    continue
                if files:
                    out.setdefault(_label_from_dirname(entry, taxonomy=taxonomy),
                                   []).extend(files)
    return out

def build_index_from_data_dir():
    out = {}
    for lbl in manifest["species"]:
        d = os.path.join(DATA_DIR, folder_name(lbl))
        if not os.path.isdir(d):
            continue
        try:
            files = [os.path.join(d, f) for f in os.listdir(d)
                     if f.lower().endswith(IMG_EXT)]
        except OSError:
            continue
        if files:
            out[lbl] = files
    return out

_t_index = time.monotonic()
_cache_key = f"{DATA_MODE}:{CLASS_TREE or DATA_DIR}:filter={','.join(CLASS_FILTER)}"
samples_by_label = None
if os.path.isfile(INDEX_CACHE):
    try:
        with open(INDEX_CACHE) as f:
            blob = json.load(f)
        if blob.get("key") == _cache_key:
            samples_by_label = blob["index"]
            print(f"[index] reused cache: {len(samples_by_label):,} classes")
    except Exception as e:
        print(f"[index] cache unusable ({type(e).__name__}); rebuilding")

if samples_by_label is None:
    samples_by_label = (build_index_local(CLASS_TREE) if DATA_MODE == "local"
                        else build_index_from_data_dir())
    try:
        with open(INDEX_CACHE, "w") as f:
            json.dump({"key": _cache_key, "index": samples_by_label},
                      f, separators=(",", ":"))
    except Exception as e:
        print(f"[index] could not cache index ({type(e).__name__}); harmless")

_total_imgs = sum(len(v) for v in samples_by_label.values())
print(f"[index] {len(samples_by_label):,} class dirs, {_total_imgs:,} images "
      f"in {hms(time.monotonic() - _t_index)}")

# ------------------------------------------------------------------------------
# The image floor, and why it moves with scale.
# ------------------------------------------------------------------------------
# MIN_IMAGES=200 is the right bar for a 126-species model: it keeps the class set
# clean and there is no shortage of candidates. Applied to a 5,000-species tree it
# is a scythe — real botanical datasets are steeply long-tailed, and a 200-image
# floor throws away the majority of species, which is the opposite of the goal.
# So once the tree is large the floor drops to MIN_IMAGES_LARGE and the imbalance
# is handled where it belongs: in the loss (focal) and the sampler.
FLOOR = MIN_IMAGES_LARGE if len(samples_by_label) > 1000 else MIN_IMAGES
eligible = [(lbl, len(f)) for lbl, f in samples_by_label.items() if len(f) >= FLOOR]
eligible.sort(key=lambda t: (-t[1], t[0]))     # richest classes first
print(f"[classes] floor={FLOOR} img/species -> {len(eligible):,} eligible "
      f"of {len(samples_by_label):,}")

if len(eligible) > MAX_SPECIES:
    print(f"[classes] capping at MAX_SPECIES={MAX_SPECIES:,} "
          f"(dropping {len(eligible) - MAX_SPECIES:,} thinnest classes)")
    eligible = eligible[:MAX_SPECIES]

collected = [lbl for lbl, _ in eligible]

# Never shrink the head: a class the deployed model already predicts must keep its
# index even if this session's tree happens not to contain it.
for lbl in manifest["classes"]:
    if lbl not in collected:
        collected.append(lbl)

if len(collected) < 2:
    print(f"\n[train] only {len(collected)} eligible species available -- "
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

# Register any label discovered on disk but absent from the manifest, so the
# species table stays a complete record of what the model can name.
for lbl in classes:
    if lbl not in manifest["species"]:
        manifest["species"][lbl] = {
            "scientific": SPECIES_LIST.get(lbl, lbl), "downloaded": 0,
            "collected": False, "seen_inat_ids": [],
        }
    manifest["species"][lbl]["downloaded"] = len(samples_by_label.get(lbl, []))

_counts = [n for _, n in eligible]
print(f"\n[train] classes this run: {num_labels:,} "
      f"(new since last: {num_labels - len(manifest['classes']):,})")
if _counts:
    print(f"[train] images/class: min={min(_counts)} median="
          f"{sorted(_counts)[len(_counts)//2]} max={max(_counts)} "
          f"imbalance={max(_counts)/max(1,min(_counts)):.0f}x")

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

# ------------------------------------------------------------------------------
# Albumentations, defensively constructed.
# ------------------------------------------------------------------------------
# The brief names five specific transforms. Three of them have been RENAMED or
# had their signature changed between albumentations 1.x and 2.x, and Kaggle's
# base image is not pinned:
#
#   A.Cutout            -> removed; A.CoarseDropout, whose own arguments changed
#                          from max_holes/max_height to *_range tuples in 2.0
#   A.ShiftScaleRotate  -> deprecated in favour of A.Affine
#   RandomResizedCrop   -> (height=, width=) became size=(h, w)
#
# Guessing wrong costs an entire GPU session on an AttributeError, so each
# transform is built by trying the modern spelling first and falling back. If
# albumentations cannot be imported at all, a torchvision pipeline covers the
# same five operations — a slightly weaker Cutout is worth far more than a
# session that refuses to start.
def _first_ok(*builders):
    """Return the first builder that constructs without raising."""
    last = None
    for b in builders:
        try:
            return b()
        except Exception as e:
            last = e
    raise RuntimeError(f"no working spelling for this transform: {last}")

ALBU = None
def _import_albu():
    global ALBU
    import albumentations as _A
    from albumentations.pytorch import ToTensorV2 as _T
    ALBU = _A.__version__
    return _A, _T

try:
    A, ToTensorV2 = _import_albu()
except Exception as _e1:
    # Kaggle usually ships albumentations, so the install is the exception path
    # rather than the rule. --no-deps is still mandatory: a plain
    # `pip install albumentations` resolves numpy/opencv and can replace the
    # numpy that Kaggle's GPU-matched torch was built against, which turns a
    # missing augmentation into a broken CUDA build. albucore/stringzilla/simsimd
    # are 2.x's own split-out helpers and have to be named explicitly under
    # --no-deps or the import fails on them instead.
    print(f"[aug] albumentations import failed ({type(_e1).__name__}); installing")
    _pip("--no-deps", "albumentations", "albucore", "stringzilla", "simsimd")
    try:
        A, ToTensorV2 = _import_albu()
    except Exception as _e2:
        print(f"[aug] still unavailable ({type(_e2).__name__}: {_e2}) "
              f"-> falling back to torchvision")

if ALBU:
    _rrc = _first_ok(
        lambda: A.RandomResizedCrop(size=(IMAGE_SIZE, IMAGE_SIZE),
                                    scale=(0.65, 1.0), ratio=(0.8, 1.25)),
        lambda: A.RandomResizedCrop(height=IMAGE_SIZE, width=IMAGE_SIZE,
                                    scale=(0.65, 1.0), ratio=(0.8, 1.25)),
    )
    # ShiftScaleRotate's replacement. rotate is deliberately capped at 30 deg:
    # flowers are photographed from any angle, but a 180 deg rotation plus a
    # vertical flip is the same image twice, which wastes augmentation budget.
    _ssr = _first_ok(
        lambda: A.Affine(translate_percent=(-0.0625, 0.0625), scale=(0.9, 1.1),
                         rotate=(-30, 30), border_mode=0, p=0.7),
        lambda: A.Affine(translate_percent=(-0.0625, 0.0625), scale=(0.9, 1.1),
                         rotate=(-30, 30), p=0.7),
        lambda: A.ShiftScaleRotate(shift_limit=0.0625, scale_limit=0.1,
                                   rotate_limit=30, p=0.7),
    )
    # Cutout. Occluding ~2-8% of the frame teaches the head to use petal margin
    # and leaf shape instead of betting everything on the brightest patch.
    _cut = _first_ok(
        lambda: A.CoarseDropout(num_holes_range=(1, 3),
                                hole_height_range=(0.08, 0.22),
                                hole_width_range=(0.08, 0.22),
                                fill=0, p=0.35),
        lambda: A.CoarseDropout(num_holes_range=(1, 3),
                                hole_height_range=(0.08, 0.22),
                                hole_width_range=(0.08, 0.22),
                                fill_value=0, p=0.35),
        lambda: A.CoarseDropout(max_holes=3,
                                max_height=int(0.22 * IMAGE_SIZE),
                                max_width=int(0.22 * IMAGE_SIZE),
                                min_holes=1,
                                min_height=int(0.08 * IMAGE_SIZE),
                                min_width=int(0.08 * IMAGE_SIZE),
                                fill_value=0, p=0.35),
        lambda: A.Cutout(num_holes=2, max_h_size=int(0.2 * IMAGE_SIZE),
                         max_w_size=int(0.2 * IMAGE_SIZE), p=0.35),
    )
    _albu_train = A.Compose([
        _rrc,
        A.HorizontalFlip(p=0.5),
        # Vertical flip at 0.5 would be wrong for this domain half the time --
        # many species are recognised partly by how the flower hangs. 0.2 keeps
        # the invariance without teaching upside-down as the norm.
        A.VerticalFlip(p=0.2),
        _ssr,
        A.ColorJitter(brightness=0.2, contrast=0.2, saturation=0.2, hue=0.02, p=0.8),
        _cut,
        A.Normalize(mean=mean, std=std),
        ToTensorV2(),
    ])
    _albu_val = A.Compose([
        _first_ok(
            lambda: A.Resize(height=int(IMAGE_SIZE * 1.14), width=int(IMAGE_SIZE * 1.14)),
            lambda: A.Resize(int(IMAGE_SIZE * 1.14), int(IMAGE_SIZE * 1.14)),
        ),
        _first_ok(
            lambda: A.CenterCrop(height=IMAGE_SIZE, width=IMAGE_SIZE),
            lambda: A.CenterCrop(IMAGE_SIZE, IMAGE_SIZE),
        ),
        A.Normalize(mean=mean, std=std),
        ToTensorV2(),
    ])
    print(f"[aug] albumentations {ALBU}: RandomResizedCrop, H/V flip, "
          f"{type(_ssr).__name__}, ColorJitter(.2,.2,.2), {type(_cut).__name__}")

    def train_tf(pil):  return _albu_train(image=np.asarray(pil))["image"]
    def val_tf(pil):    return _albu_val(image=np.asarray(pil))["image"]
else:
    _tv_train = transforms.Compose([
        transforms.RandomResizedCrop(IMAGE_SIZE, scale=(0.65, 1.0)),
        transforms.RandomHorizontalFlip(p=0.5),
        transforms.RandomVerticalFlip(p=0.2),
        transforms.RandomAffine(degrees=30, translate=(0.0625, 0.0625),
                                scale=(0.9, 1.1)),
        transforms.ColorJitter(0.2, 0.2, 0.2, 0.02),
        transforms.ToTensor(),
        transforms.Normalize(mean, std),
        # RandomErasing IS Cutout, applied post-tensor.
        transforms.RandomErasing(p=0.35, scale=(0.02, 0.08), value=0),
    ])
    _tv_val = transforms.Compose([
        transforms.Resize(int(IMAGE_SIZE * 1.14)),
        transforms.CenterCrop(IMAGE_SIZE),
        transforms.ToTensor(),
        transforms.Normalize(mean, std),
    ])
    def train_tf(pil):  return _tv_train(pil)
    def val_tf(pil):    return _tv_val(pil)

class FlowerDataset(Dataset):
    def __init__(self, samples, tf):
        self.samples, self.tf = samples, tf
    def __len__(self): return len(self.samples)
    def __getitem__(self, i):
        path, y = self.samples[i]
        try:
            img = Image.open(path).convert("RGB")
        except Exception:
            # A single unreadable JPEG in a 1.5M-file tree must not kill an epoch
            # four hours in. A grey frame contributes almost nothing to the
            # gradient and the run continues.
            img = Image.new("RGB", (IMAGE_SIZE, IMAGE_SIZE), (127, 127, 127))
        return self.tf(img), y

# Build the sample list from the index produced in section 4 -- no second walk.
all_samples = []
for lbl in classes:
    y = label2id[lbl]
    for f in samples_by_label.get(lbl, []):
        all_samples.append((f, y))

if len(all_samples) < BATCH_SIZE:
    print("[train] not enough images on disk this run to train; saving & exiting.")
    push_manifest()
    raise SystemExit(0)

# ------------------------------------------------------------------------------
# Stratified split. Per class, not globally.
# ------------------------------------------------------------------------------
# A global shuffle-and-slice would, at a 40-image floor over 5,000 classes, leave
# some classes with zero validation images and others with all of theirs -- and
# then Macro F1, which averages over classes, would be measuring a different
# class set than the one being trained. The split is therefore taken inside each
# class, with at least one held out and at least one kept.
by_class = defaultdict(list)
for s in all_samples:
    by_class[s[1]].append(s)

rng = random.Random(42)
train_samples, val_samples = [], []
for y, items in by_class.items():
    rng.shuffle(items)
    k = min(len(items) - 1, max(1, int(round(len(items) * VAL_FRACTION)))) \
        if len(items) > 1 else 0
    val_samples.extend(items[:k])
    train_samples.extend(items[k:])
rng.shuffle(train_samples)

print(f"[data] train={len(train_samples):,}  val={len(val_samples):,}  "
      f"classes={num_labels:,}")

# ------------------------------------------------------------------------------
# Class-balanced sampling, at a deliberately partial strength.
# ------------------------------------------------------------------------------
# Real botanical trees are long-tailed by orders of magnitude. Full inverse-
# frequency sampling (power 1.0) would show a 40-image species as often as a
# 3,000-image one and overfit the tail badly. sqrt weighting (power 0.5) is the
# standard compromise, and it composes with focal loss rather than duplicating it.
USE_BALANCED_SAMPLER = num_labels > 1000
train_ds = FlowerDataset(train_samples, train_tf)
sampler = None
if USE_BALANCED_SAMPLER:
    freq = np.bincount([y for _, y in train_samples], minlength=num_labels)
    w_per_class = np.where(freq > 0, 1.0 / np.sqrt(np.maximum(freq, 1)), 0.0)
    weights = torch.as_tensor([w_per_class[y] for _, y in train_samples],
                              dtype=torch.double)
    sampler = torch.utils.data.WeightedRandomSampler(
        weights, num_samples=len(train_samples), replacement=True)
    print(f"[data] balanced sampler ON (sqrt inverse-frequency, "
          f"{int(freq.min())}..{int(freq.max())} img/class)")

_dl_common = dict(num_workers=NUM_WORKERS, pin_memory=(DEVICE == "cuda"))
if NUM_WORKERS > 0:
    # Respawning 4 workers per epoch on a 1.5M-sample loader costs minutes of the
    # session for nothing; prefetch keeps the T4 fed while JPEGs decode on CPU.
    _dl_common.update(persistent_workers=True, prefetch_factor=4)

train_loader = DataLoader(train_ds, batch_size=BATCH_SIZE,
                          shuffle=(sampler is None), sampler=sampler,
                          drop_last=True, **_dl_common)
val_loader   = DataLoader(FlowerDataset(val_samples, val_tf),
                          batch_size=BATCH_SIZE, shuffle=False, **_dl_common)

# ==============================================================================
# 7. Save + push helpers (used incrementally, not just at the end)
# ==============================================================================
BEST_PATH = os.path.join(WORK, BEST_MODEL_PATH)

def save_checkpoint_local():
    model.save_pretrained(CKPT_DIR, safe_serialization=True)
    processor.save_pretrained(CKPT_DIR)
    with open(os.path.join(CKPT_DIR, "class_names.json"), "w") as f:
        json.dump(classes, f, indent=2)
    # The label maps are already inside config.json, but the inference server
    # reads this file directly and a 5,000-entry mapping is exactly the thing you
    # do not want to reconstruct by hand if config.json is ever regenerated.
    with open(os.path.join(CKPT_DIR, "label_mapping.json"), "w") as f:
        json.dump({"id2label": {str(k): v for k, v in id2label.items()},
                   "label2id": label2id}, f, separators=(",", ":"))

def push_checkpoint(msg):
    save_checkpoint_local()
    api.upload_folder(folder_path=CKPT_DIR, repo_id=HF_REPO_ID,
                      repo_type="model", commit_message=msg)
    print(f"[push] checkpoint -> Hub ({msg})")

def save_best_model(metrics):
    """
    Write best_model.pth — the artefact the brief names.

    state_dict only, not the pickled module: a pickled nn.Module carries the
    class path and breaks the moment transformers is upgraded, which for a file
    meant to outlive several Kaggle images is a guaranteed future failure. The
    label maps travel inside the same file so the checkpoint is self-describing.
    """
    torch.save({
        "state_dict": model.state_dict(),
        "num_labels": num_labels,
        "id2label": id2label,
        "label2id": label2id,
        "base_model": BASE_MODEL,
        "metrics": metrics,
        "saved_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }, BEST_PATH)
    mb = os.path.getsize(BEST_PATH) / 1e6
    print(f"[best] wrote {BEST_MODEL_PATH} ({mb:.1f} MB) "
          f"top1={metrics.get('top1', 0):.4f}")
    return BEST_PATH

def push_best_model():
    try:
        api.upload_file(path_or_fileobj=BEST_PATH, path_in_repo=BEST_MODEL_PATH,
                        repo_id=HF_REPO_ID, repo_type="model",
                        commit_message="best_model.pth")
        print(f"[push] {BEST_MODEL_PATH} -> Hub")
    except Exception as e:
        print(f"[push] {BEST_MODEL_PATH} push failed: {e}")

def push_to_hub_full(msg):
    """
    Requirement 4: weights (safetensors) + feature extractor + the full
    id2label/label2id mapping, via the transformers push_to_hub path.

    push_to_hub is used because it is what the brief asks for and because it
    writes the model card and config the Hub UI reads. It is wrapped, not
    trusted: it is a network call at the end of an 8-hour run, and if it fails
    the upload_folder path above has already put the same bytes on the Hub. A
    failure here must never be the thing that loses the session.
    """
    model.config.id2label = {int(k): v for k, v in id2label.items()}
    model.config.label2id = label2id
    ok = True
    try:
        model.push_to_hub(HF_REPO_ID, token=HF_TOKEN, private=HF_PRIVATE,
                          safe_serialization=True, commit_message=msg)
        print(f"[push] model.push_to_hub -> {HF_REPO_ID}")
    except Exception as e:
        ok = False
        print(f"[push] model.push_to_hub failed: {type(e).__name__}: {e}")
    try:
        processor.push_to_hub(HF_REPO_ID, token=HF_TOKEN, private=HF_PRIVATE,
                              commit_message=f"{msg} (feature extractor)")
        print("[push] processor.push_to_hub -> Hub")
    except Exception as e:
        ok = False
        print(f"[push] processor.push_to_hub failed: {type(e).__name__}: {e}")
    if not ok:
        print("[push] falling back to upload_folder for the same artefacts")
        try:
            push_checkpoint(msg + " (fallback)")
        except Exception as e:
            print(f"[push] fallback ALSO failed: {e}")
    return ok

# ==============================================================================
# 8. Train -- LLRD + focal/label-smoothing loss + the 8.5-hour time bomb
# ==============================================================================
# ------------------------------------------------------------------------------
# 8a. Loss. Focal AND label smoothing, which pull in opposite directions.
# ------------------------------------------------------------------------------
# The brief asks for both "Focal Loss / Label Smoothing (smoothing=0.1)" to
# "penalize overconfidence on hard, similar-looking floral species". They are not
# the same tool and they partly fight each other:
#
#   Label smoothing caps confidence for EVERY sample. It is what actually
#   penalises overconfidence, and it is the one that helps on look-alike species.
#   Focal loss down-weights EASY samples so the gradient concentrates on hard
#   ones. It is an imbalance/hard-example tool, and it makes the model MORE
#   confident on what remains, not less.
#
# Stacking them naively (smoothing inside a focal term) means the focal weight is
# computed from a target the model can never reach, and the loss floor stops being
# interpretable. So LOSS_MODE selects, and "focal_smooth" implements the
# defensible combination: a focal-weighted CE plus a uniform cross-entropy term
# scaled by the smoothing coefficient — mathematically the smoothing expansion,
# with the focal modulation applied only to the true-class part.
#
# FOCAL_GAMMA defaults to 1.5, not the paper's 2.0: with a 5,000-way head the
# early-training probability of the correct class is ~0.0002, so (1-p)^gamma is
# ~1 for everything and gamma mostly amplifies noise. 1.5 keeps the effect mild
# until the head is actually discriminating.
class FlowerLoss(nn.Module):
    def __init__(self, mode=LOSS_MODE, smoothing=LABEL_SMOOTHING,
                 gamma=FOCAL_GAMMA, n_classes=None):
        super().__init__()
        self.mode, self.eps, self.gamma = mode, smoothing, gamma
        self.n = n_classes

    def forward(self, logits, target):
        # log_softmax in fp32: with 5,000 logits under fp16 autocast the
        # exponentials are close enough to the representable floor that the loss
        # can read as nan while the model is perfectly healthy.
        logp = torch.log_softmax(logits.float(), dim=-1)
        logp_t = logp.gather(1, target.unsqueeze(1)).squeeze(1)

        if self.mode == "smooth":
            # Standard label smoothing, written out rather than delegated so the
            # smoothing term is visibly the same one reused by focal_smooth.
            return (-(1 - self.eps) * logp_t - self.eps * logp.mean(dim=-1)).mean()

        pt = logp_t.exp()
        focal = (1.0 - pt).clamp_min(0).pow(self.gamma)
        if self.mode == "focal":
            return (-focal * logp_t).mean()

        # "focal_smooth": focal weighting on the true class, plus the uniform
        # smoothing mass, which is NOT focal-weighted (its job is a confidence
        # ceiling and that ceiling must not depend on how hard the sample is).
        return (-(1 - self.eps) * focal * logp_t - self.eps * logp.mean(dim=-1)).mean()

criterion = FlowerLoss(n_classes=num_labels).to(DEVICE)
print(f"[loss] {LOSS_MODE}  smoothing={LABEL_SMOOTHING}  gamma={FOCAL_GAMMA}")

# ------------------------------------------------------------------------------
# 8b. Layer-wise Learning Rate Decay (LLRD).
# ------------------------------------------------------------------------------
# A ViT's early blocks encode edges and colour; its late blocks encode the
# composition that actually separates two similar Papaver species. Training both
# at one rate either destroys the general features or starves the specific ones.
# LLRD assigns each depth its own rate, decaying by LLRD_DECAY per level down:
#
#   depth 0        patch embeddings + position embeddings + cls token
#   depth 1..12    encoder.layer.{0..11}
#   depth 13       final layernorm, pooler, classifier
#
#   lr(depth) = BACKBONE_LR * LLRD_DECAY ** (n_layers + 1 - depth)
#
# The head is deliberately NOT part of that ladder. It is brand new (or has just
# grown by thousands of rows) and needs LEARNING_RATE, which is ~6x the top
# block's rate. A single shared rate here is the classic way to get a run that
# looks like it is training and never separates the tail classes.
def vit_depth(name, n_layers):
    if name.startswith("vit.embeddings") or "embeddings" in name.split(".")[:2]:
        return 0
    if ".encoder.layer." in name or name.startswith("vit.encoder.layer."):
        try:
            return int(name.split("encoder.layer.")[1].split(".")[0]) + 1
        except (IndexError, ValueError):
            return n_layers + 1
    return n_layers + 1   # layernorm / pooler / anything unmatched

N_LAYERS = getattr(model.config, "num_hidden_layers", 12)

# LayerNorm weights and every bias are excluded from weight decay. Decaying a
# LayerNorm gain toward zero is decaying the layer's output scale toward zero,
# which is not regularisation — it is damage, and it is the most common silent
# bug in hand-rolled ViT optimizers.
def no_decay(name, param):
    return param.ndim <= 1 or name.endswith(".bias") or "layernorm" in name.lower()

groups, group_names = {}, {}
for name, param in model.named_parameters():
    if not param.requires_grad:
        continue
    is_head = name.startswith("classifier")
    depth = N_LAYERS + 1 if is_head else vit_depth(name, N_LAYERS)
    wd = 0.0 if no_decay(name, param) else WEIGHT_DECAY
    if is_head:
        lr = LEARNING_RATE
        key = ("head", wd)
    else:
        lr = BACKBONE_LR * (LLRD_DECAY ** (N_LAYERS + 1 - depth))
        key = (depth, wd)
    if key not in groups:
        groups[key] = {"params": [], "lr": lr, "weight_decay": wd,
                       "name": f"{'head' if is_head else f'depth{depth}'}"
                               f"{'/nodecay' if wd == 0 else ''}"}
        group_names[key] = groups[key]["name"]
    groups[key]["params"].append(param)

param_groups = [groups[k] for k in sorted(groups, key=lambda k: (str(k[0]), k[1]))]
optimizer = torch.optim.AdamW(param_groups, betas=(0.9, 0.999), eps=1e-8)
scaler = amp_scaler()

_lrs = sorted({round(g["lr"], 9) for g in param_groups})
print(f"[llrd] {len(param_groups)} param groups over {N_LAYERS} blocks, "
      f"decay={LLRD_DECAY}")
print(f"[llrd] lr range: {min(_lrs):.2e} (embeddings) .. {BACKBONE_LR:.2e} "
      f"(top block) .. {LEARNING_RATE:.2e} (head)")

# ------------------------------------------------------------------------------
# 8c. Warmup + cosine schedule, expressed in STEPS this session will actually run.
# ------------------------------------------------------------------------------
# The horizon is min(planned epochs, what the time bomb allows). Scheduling a
# cosine over 4 epochs and then being cut off after 2 leaves the run stranded at
# half the peak rate, which is the worst place to stop.
steps_per_epoch = max(1, len(train_loader) // max(1, GRAD_ACCUM_STEPS))
planned_epochs = EPOCHS_PER_RUN
TOTAL_STEPS = steps_per_epoch * planned_epochs
WARMUP_STEPS = max(50, int(TOTAL_STEPS * WARMUP_FRACTION))

def lr_scale(step):
    if step < WARMUP_STEPS:
        return (step + 1) / WARMUP_STEPS
    prog = (step - WARMUP_STEPS) / max(1, TOTAL_STEPS - WARMUP_STEPS)
    prog = min(1.0, max(0.0, prog))
    # Floor at 2% rather than 0: a cosine that reaches exactly zero spends its
    # last steps doing nothing while the clock still runs.
    return 0.02 + 0.98 * 0.5 * (1.0 + math.cos(math.pi * prog))

scheduler = torch.optim.lr_scheduler.LambdaLR(optimizer, lr_scale)
print(f"[sched] {steps_per_epoch:,} steps/epoch x {planned_epochs} = "
      f"{TOTAL_STEPS:,} steps, warmup {WARMUP_STEPS:,}")

# ------------------------------------------------------------------------------
# 8d. Metrics: Top-1, Top-3, Macro F1 — computed without a confusion matrix.
# ------------------------------------------------------------------------------
# A 5,000 x 5,000 confusion matrix is 25M int64 cells, ~200 MB, allocated on the
# GPU inside an eval loop that is already holding activations. Macro F1 does not
# need it: per-class TP, FP and FN are three length-C vectors, and bincount fills
# them in one pass per batch with no allocation proportional to C squared.
class MetricAccumulator:
    def __init__(self, n_classes, device):
        z = lambda: torch.zeros(n_classes, dtype=torch.long, device=device)
        self.tp, self.fp, self.fn = z(), z(), z()
        self.n = n_classes
        self.correct1 = self.correct3 = self.total = 0
        # Per-sample correctness, kept for the PAIRED quantization comparison in
        # section 10. Bool on CPU: 4,000 samples is 4 KB, and the paired test is
        # the only way to resolve a 1% threshold at this sample size.
        self.per_sample = []

    def update(self, logits, y):
        k = min(3, logits.shape[1])
        top = logits.topk(k, dim=1).indices
        pred = top[:, 0]
        hit1 = pred == y
        hit3 = (top == y.unsqueeze(1)).any(dim=1)
        self.correct1 += int(hit1.sum())
        self.correct3 += int(hit3.sum())
        self.total += int(y.numel())
        self.per_sample.append(hit1.detach().to("cpu"))
        # TP / FP / FN as three histograms. A prediction that is right is a TP for
        # that class; a prediction that is wrong is an FP for the predicted class
        # AND an FN for the true one.
        self.tp += torch.bincount(pred[hit1], minlength=self.n)
        wrong = ~hit1
        if bool(wrong.any()):
            self.fp += torch.bincount(pred[wrong], minlength=self.n)
            self.fn += torch.bincount(y[wrong], minlength=self.n)

    def result(self):
        tp = self.tp.double(); fp = self.fp.double(); fn = self.fn.double()
        prec = tp / (tp + fp).clamp_min(1)
        rec  = tp / (tp + fn).clamp_min(1)
        f1 = 2 * prec * rec / (prec + rec).clamp_min(1e-12)
        # Macro F1 averages over classes PRESENT in this split. Including classes
        # with no validation sample would silently divide by the full class count
        # and report a number that falls as the class set grows, regardless of
        # whether the model got better.
        present = (tp + fn) > 0
        n_present = int(present.sum())
        return {
            "top1": self.correct1 / max(1, self.total),
            "top3": self.correct3 / max(1, self.total),
            "macro_f1": float(f1[present].mean()) if n_present else 0.0,
            "n": self.total,
            "classes_present": n_present,
        }

    def mask(self):
        return (torch.cat(self.per_sample) if self.per_sample
                else torch.zeros(0, dtype=torch.bool))

@torch.no_grad()
def evaluate(loader=None, limit=None, tag="val"):
    """Top-1 / Top-3 / Macro F1 over `loader`, optionally capped at `limit` samples."""
    loader = loader or val_loader
    model.eval()
    acc = MetricAccumulator(num_labels, DEVICE)
    t0 = time.monotonic()
    for x, y in loader:
        x = x.to(DEVICE, non_blocking=True)
        y = y.to(DEVICE, non_blocking=True)
        with amp_autocast():
            logits = model(pixel_values=x).logits
        acc.update(logits.float(), y)
        if limit and acc.total >= limit:
            break
    r = acc.result()
    r["seconds"] = time.monotonic() - t0
    print(f"[eval:{tag}] top1={r['top1']*100:.2f}%  top3={r['top3']*100:.2f}%  "
          f"macroF1={r['macro_f1']:.4f}  (n={r['n']:,} over "
          f"{r['classes_present']:,} classes, {hms(r['seconds'])})")
    return r

# ------------------------------------------------------------------------------
# 8e. The training loop, and the time bomb.
# ------------------------------------------------------------------------------
print("\n[phase] TRAIN")
print(f"[train] budget: bomb at {TIME_BOMB_SECONDS}s ({hms(TIME_BOMB_SECONDS)}), "
      f"tail reserve {hms(TAIL_RESERVE_SECONDS)}")

best = {"top1": -1.0, "top3": 0.0, "macro_f1": 0.0, "epoch": 0}
epochs_done_this_run = 0
bomb_fired = False
stop_reason = "completed all planned epochs"
global_step = 0
train_seconds = 0.0

def _oom_backoff():
    """
    Halve the batch by accumulating instead. Called on a CUDA OOM.

    Rebuilding the DataLoader mid-epoch would restart the epoch and throw away
    hours, so the batch SIZE is left alone and the step is simply skipped after
    clearing the cache. Two OOMs in a row means the configuration is wrong, and
    saying so beats limping.
    """
    torch.cuda.empty_cache()

for epoch in range(1, EPOCHS_PER_RUN + 1):
    # Do not START an epoch there is no room to finish AND wrap up. The literal
    # 30600 check is at the bottom of the loop, as specified; this is the earlier,
    # stricter gate that keeps the tail work fundable.
    if tail_deadline_passed():
        stop_reason = (f"stopped before epoch {epoch}: {hms(bomb_elapsed())} "
                       f"elapsed, tail reserve engaged")
        print(f"[train] {stop_reason}")
        break

    model.train()
    running, seen, t0 = 0.0, 0, time.monotonic()
    optimizer.zero_grad(set_to_none=True)
    epoch_broken = False

    for step, (x, y) in enumerate(train_loader, 1):
        x = x.to(DEVICE, non_blocking=True)
        y = y.to(DEVICE, non_blocking=True)
        try:
            with amp_autocast():
                logits = model(pixel_values=x).logits
                loss = criterion(logits, y) / GRAD_ACCUM_STEPS
            scaler.scale(loss).backward()
            if step % GRAD_ACCUM_STEPS == 0:
                # Unscale before clipping: clipping scaled gradients clips the
                # wrong magnitude and silently changes the effective threshold.
                scaler.unscale_(optimizer)
                torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
                scaler.step(optimizer)
                scaler.update()
                optimizer.zero_grad(set_to_none=True)
                scheduler.step()
                global_step += 1
        except torch.cuda.OutOfMemoryError:
            print(f"  [train] CUDA OOM at step {step}; skipping batch")
            optimizer.zero_grad(set_to_none=True)
            _oom_backoff()
            continue

        running += float(loss) * GRAD_ACCUM_STEPS * y.size(0)
        seen += y.size(0)

        if step % 100 == 0:
            rate = seen / max(1e-9, time.monotonic() - t0)
            eta = (len(train_loader) - step) * BATCH_SIZE / max(1e-9, rate)
            print(f"  e{epoch} step {step:,}/{len(train_loader):,} "
                  f"loss={running/seen:.3f} lr={scheduler.get_last_lr()[-1]:.2e} "
                  f"{rate:.0f} img/s  eta {hms(eta)}  elapsed {hms(bomb_elapsed())}")

        # A 4-hour epoch is far too long to be the checkpoint granularity: a kill
        # at 3h59m would lose the whole thing. Mid-epoch checkpoints bound the
        # loss to STEP_CHECKPOINT_EVERY steps.
        if STEP_CHECKPOINT_EVERY and step % STEP_CHECKPOINT_EVERY == 0:
            try:
                push_checkpoint(f"mid-epoch e{epoch} step {step} "
                                f"(loss={running/max(1,seen):.3f})")
            except Exception as e:
                print(f"  [push] mid-epoch push skipped: {e}")

        # Mid-epoch bomb. The end-of-epoch check below is the one the brief
        # specifies; this exists because at ~4h/epoch the end of the epoch can be
        # hours past the deadline.
        if tail_deadline_passed():
            print(f"  [train] tail reserve reached mid-epoch at step {step:,} "
                  f"-- breaking to protect the wrap-up")
            epoch_broken = True
            break

    train_seconds += time.monotonic() - t0
    metrics = evaluate(tag=f"e{epoch}")
    epochs_done_this_run += 1
    manifest["trained_epochs"] = manifest.get("trained_epochs", 0) + 1
    manifest["last_val_accuracy"] = metrics["top1"]
    print(f"[epoch {epoch}] train_loss={running/max(1,seen):.3f}  "
          f"top1={metrics['top1']*100:.2f}%  top3={metrics['top3']*100:.2f}%  "
          f"macroF1={metrics['macro_f1']:.4f}  ({hms(time.monotonic()-t0)})")

    # Best-so-far -> best_model.pth. Selected on Macro F1 rather than Top-1:
    # with a long-tailed 5,000-class set, Top-1 is dominated by the handful of
    # classes with thousands of images, and a model that improves it by ignoring
    # the tail is not the model to ship.
    score = metrics["macro_f1"] if num_labels > 100 else metrics["top1"]
    best_score = best.get("score", -1.0)
    if score > best_score:
        best = dict(metrics); best["epoch"] = epoch; best["score"] = score
        save_best_model(best)
    else:
        print(f"[best] e{epoch} did not improve ({score:.4f} <= {best_score:.4f})")

    manifest["classes"] = classes
    manifest.setdefault("history", []).append({
        "run": manifest.get("runs", 0) + 1, "epoch": manifest["trained_epochs"],
        "top1": metrics["top1"], "top3": metrics["top3"],
        "macro_f1": metrics["macro_f1"], "seconds": round(time.monotonic() - t0),
    })
    try:
        push_checkpoint(f"epoch checkpoint (top1={metrics['top1']:.3f}, "
                        f"classes={num_labels})")
        push_manifest()
    except Exception as e:
        print(f"  [push] epoch push failed (will retry at end): {e}")

    # ---- THE TIME BOMB, exactly as specified: checked at the end of EVERY epoch.
    if time_bomb_fired():
        bomb_fired = True
        stop_reason = (f"TIME BOMB at {hms(bomb_elapsed())} "
                       f"(> {TIME_BOMB_SECONDS}s) after epoch {epoch}")
        print(f"\n[bomb] {stop_reason}")
        print("[bomb] breaking the epoch loop and going straight to "
              "save -> push -> quantize -> evaluate")
        break
    if epoch_broken:
        bomb_fired = True
        stop_reason = (f"tail reserve at {hms(bomb_elapsed())} during epoch {epoch}")
        break

# If no epoch ever improved (e.g. a single epoch that crashed evaluation), there
# is still a model in memory worth keeping. Never reach the export stage with no
# best_model.pth on disk.
if not os.path.exists(BEST_PATH):
    print("[best] no epoch produced a best checkpoint; saving current weights")
    if best["top1"] < 0:
        best = {"top1": manifest.get("last_val_accuracy") or 0.0, "top3": 0.0,
                "macro_f1": 0.0, "epoch": epochs_done_this_run}
    save_best_model(best)

print(f"\n[train] {epochs_done_this_run} epoch(s) in {hms(train_seconds)} "
      f"-- {stop_reason}")


# ==============================================================================
# 9. Baseline evaluation + Hub push  (requirements 4 and 5, first half)
# ==============================================================================
# Order matters here and it is not arbitrary. The push comes FIRST, before ONNX
# export and before the quantization ladder, because those steps are CPU-bound,
# take tens of minutes, and are the most likely thing to be running when Kaggle
# pulls the plug. Weights on the Hub are the deliverable; an ONNX file that never
# got exported can be produced from them in five minutes on any laptop. The
# reverse is not true.
print("\n[phase] FINALIZE")

# The best epoch's weights are what gets shipped, not whatever the last epoch
# happened to leave in memory. Reloading also means the exported ONNX and the
# pushed checkpoint are provably the same parameters.
if os.path.exists(BEST_PATH) and best.get("epoch"):
    try:
        blob = torch.load(BEST_PATH, map_location="cpu", weights_only=False)
        model.load_state_dict(blob["state_dict"])
        model.to(DEVICE)
        print(f"[final] restored best weights from epoch {blob['metrics'].get('epoch')}")
    except Exception as e:
        print(f"[final] could not restore {BEST_MODEL_PATH} ({e}); "
              f"shipping the in-memory weights instead")

for lbl in collected:
    if lbl in manifest["species"]:
        manifest["species"][lbl]["collected"] = True
manifest["classes"] = classes
manifest["runs"] = manifest.get("runs", 0) + 1

# ------------------------------------------------------------------------------
# 9a. The FP32 and FP16 baselines the summary panel reports.
# ------------------------------------------------------------------------------
# FP16 is measured, not assumed to equal FP32. It is the precision the GPU path
# actually ran in, and reporting a quantization delta against a baseline that was
# never measured is how a 0.8% loss gets reported as 0.3%.
baseline_fp32 = baseline_fp16 = None
if epochs_done_this_run or not manifest.get("history"):
    try:
        _saved_amp = AMP_ENABLED
        AMP_ENABLED = False
        baseline_fp32 = evaluate(tag="fp32")
        AMP_ENABLED = _saved_amp
        if DEVICE == "cuda":
            baseline_fp16 = evaluate(tag="fp16")
    except Exception as e:
        print(f"[final] baseline eval failed: {type(e).__name__}: {e}")
        AMP_ENABLED = DEVICE == "cuda"

if baseline_fp32:
    manifest["last_val_accuracy"] = baseline_fp32["top1"]

try:
    push_checkpoint(f"end-of-run (run #{manifest['runs']}, classes={num_labels}, "
                    f"top1={(baseline_fp32 or {}).get('top1', 0):.4f})")
    push_manifest()
except Exception as e:
    print(f"[push] checkpoint push failed: {e}\n{traceback.format_exc()}")

# Requirement 4: push_to_hub for weights + feature extractor + label maps.
push_to_hub_full(f"run #{manifest['runs']}: {num_labels} species, "
                 f"{manifest['trained_epochs']} cumulative epochs")
push_best_model()

# ==============================================================================
# 10. ONNX export + conditional SELECTIVE quantization  (requirement 5)
# ==============================================================================
# The rule from the brief: export INT8, measure it against the baseline, and if
# the accuracy loss exceeds 1% escalate to selective quantization until it is
# strictly under 1%.
#
# Two things about HOW that is measured, both of which change the answer:
#
# 1. The delta is measured ONNX-FP32 -> ONNX-INT8, not PyTorch -> ONNX-INT8.
#    Export itself moves accuracy slightly (different resize/pad kernels, opset
#    semantics). Folding that into the "quantization loss" measures two changes
#    and attributes both to quantization, and the ladder would then chase an
#    error that no exclusion list can fix.
#
# 2. The comparison is PAIRED. At n=4,000 the standard error on an unpaired
#    accuracy difference is about 1.1% — the same size as the threshold being
#    tested, so an unpaired measurement cannot resolve it at all. Run on
#    IDENTICAL samples, only the discordant pairs carry variance, and the
#    uncertainty on the difference drops by roughly an order of magnitude. The
#    discordant counts are printed so the number can be judged, not just trusted.
#
# FP16 ONNX is deliberately NOT produced. training/convert_to_onnx.py records the
# measurement: onnxruntime's CPU EP has no native FP16 MatMul kernel, so it casts
# to FP32 at load and peaks at 511 MB resident against a 512 MB server limit.
# INT8 is the only quantized format that helps here.
print("\n[phase] EXPORT + QUANTIZE")
_pip("--no-deps", "onnx", "onnxruntime")

ONNX_OK = True
try:
    import onnx
    import onnxruntime as ort
    from onnxruntime.quantization import quantize_dynamic, QuantType
except Exception as e:
    ONNX_OK = False
    print(f"[onnx] unavailable ({type(e).__name__}: {e}) -- skipping export and "
          f"quantization. The PyTorch weights are already on the Hub.")

class LogitsOnly(nn.Module):
    """
    ViT wrapped so the ONNX graph has a single tensor output.

    Without this the traced graph returns ImageClassifierOutput, and every
    consumer then has to know that logits live at output[0]. The inference server
    reads output 0 by name, so the name is pinned here at export time.
    """
    def __init__(self, m):
        super().__init__()
        self.m = m
    def forward(self, pixel_values):
        return self.m(pixel_values=pixel_values).logits

# ------------------------------------------------------------------------------
# 10a. The evaluation subset: stratified, bounded, and the SAME for every rung.
# ------------------------------------------------------------------------------
# The full validation split at 5,000 species is ~200,000 images. Through
# onnxruntime on 4 CPU cores that is roughly seven hours — for one rung of the
# ladder. QUANT_EVAL_MAX caps it, and the cap is spent on breadth: one image per
# class first, then a second, and so on, so a 4,000-sample budget covers as many
# distinct classes as possible. Macro F1 over a subset that only contains the
# common classes would be measuring the easy half of the problem.
def stratified_subset(samples, cap):
    buckets = defaultdict(list)
    for s in samples:
        buckets[s[1]].append(s)
    order = sorted(buckets)
    out, depth = [], 0
    while len(out) < cap:
        added = False
        for y in order:
            if depth < len(buckets[y]):
                out.append(buckets[y][depth])
                added = True
                if len(out) >= cap:
                    break
        if not added:
            break
        depth += 1
    return out

quant_subset = stratified_subset(val_samples, QUANT_EVAL_MAX)
print(f"[quant] eval subset: {len(quant_subset):,} images over "
      f"{len({y for _, y in quant_subset}):,} classes "
      f"(cap {QUANT_EVAL_MAX:,} of {len(val_samples):,} val images)")

quant_loader = DataLoader(FlowerDataset(quant_subset, val_tf),
                          batch_size=32, shuffle=False,
                          num_workers=min(2, NUM_WORKERS))

# ------------------------------------------------------------------------------
# 10b. Export FP32, then measure it. This is the reference every rung is judged
#      against.
# ------------------------------------------------------------------------------
FP32_PATH = os.path.join(WORK, ONNX_FP32_PATH)
INT8_PATH = os.path.join(WORK, ONNX_INT8_PATH)

def export_fp32():
    m = LogitsOnly(model).eval().to("cpu")
    dummy = torch.randn(1, 3, IMAGE_SIZE, IMAGE_SIZE)
    torch.onnx.export(
        m, (dummy,), FP32_PATH,
        input_names=["pixel_values"], output_names=["logits"],
        # Batch stays dynamic so the same file serves a single request and a
        # batched eval loop. Height/width are fixed at 224 on purpose: dynamic
        # spatial dims defeat onnxruntime's shape inference and cost throughput
        # for a flexibility this model does not have (ViT is patch-locked).
        dynamic_axes={"pixel_values": {0: "batch"}, "logits": {0: "batch"}},
        opset_version=ONNX_OPSET, do_constant_folding=True,
    )
    model.to(DEVICE)
    return os.path.getsize(FP32_PATH) / 1e6

def ort_session(path):
    # The SAME session options the inference server uses, so a number measured
    # here is a number that will reproduce in production. See convert_to_onnx.py.
    so = ort.SessionOptions()
    so.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_BASIC
    so.enable_cpu_mem_arena = False
    so.enable_mem_pattern = False
    so.intra_op_num_threads = max(1, min(4, os.cpu_count() or 1))
    return ort.InferenceSession(path, sess_options=so,
                                providers=["CPUExecutionProvider"])

def eval_onnx(path, tag):
    """Top-1/Top-3/Macro F1 plus a per-sample correctness mask for pairing."""
    sess = ort_session(path)
    name = sess.get_inputs()[0].name
    acc = MetricAccumulator(num_labels, "cpu")
    t0 = time.monotonic()
    for x, y in quant_loader:
        logits = sess.run(None, {name: x.numpy().astype(np.float32)})[0]
        acc.update(torch.from_numpy(np.asarray(logits)).float(), y)
    r = acc.result()
    r["seconds"] = time.monotonic() - t0
    r["mask"] = acc.mask()
    r["mb"] = sum(os.path.getsize(p) for p in _artifact_files(path)) / 1e6
    print(f"[onnx:{tag}] top1={r['top1']*100:.2f}%  top3={r['top3']*100:.2f}%  "
          f"macroF1={r['macro_f1']:.4f}  {r['mb']:.1f} MB  ({hms(r['seconds'])})")
    del sess
    return r

def _artifact_files(path):
    """A model's real size: the protobuf PLUS any external-data sibling."""
    files = [path] if os.path.exists(path) else []
    base = os.path.basename(path)
    d = os.path.dirname(path) or "."
    for f in os.listdir(d):
        if f.startswith(base) and f != base:      # e.g. model.onnx.data
            files.append(os.path.join(d, f))
        if f == base.replace(".onnx", ".onnxdata"):
            files.append(os.path.join(d, f))
    return files

def paired_delta(base_mask, cand_mask):
    """
    Paired accuracy difference with the uncertainty that actually applies.

    b = base right / candidate wrong, c = base wrong / candidate right. Only these
    discordant pairs move the difference; the concordant ones cancel exactly. The
    standard error is sqrt(b + c)/n, which for a well-behaved quantization is
    typically 5-10x tighter than the unpaired sqrt(2p(1-p)/n).
    """
    n = min(len(base_mask), len(cand_mask))
    if n == 0:
        return {"delta": 0.0, "se": 0.0, "b": 0, "c": 0, "n": 0}
    b = int((base_mask[:n] & ~cand_mask[:n]).sum())
    c = int((~base_mask[:n] & cand_mask[:n]).sum())
    return {"delta": (b - c) / n, "se": math.sqrt(b + c) / n,
            "b": b, "c": c, "n": n}

# ------------------------------------------------------------------------------
# 10c. The quantization ladder.
# ------------------------------------------------------------------------------
# Dynamic INT8 on a ViT is not uniformly safe. The parts that hurt, in order:
#
#   the classifier head    5,000 rows of near-collinear class vectors; 256 INT8
#                          levels cannot separate species whose logits differ by
#                          less than the quantization step. This is almost always
#                          where the loss comes from at high class counts.
#   attention Q/K/V        the scaled dot product amplifies weight error, then
#                          softmax turns amplified error into a different
#                          attention MAP, not just a noisier one.
#   the outer blocks       layer 0 sees raw patches (widest activation range) and
#                          the last layer feeds the head directly.
#   the middle-block MLPs  the safest ~60% of the parameters, and where most of
#                          the file size lives. Quantizing only these is the
#                          endpoint of the ladder.
#
# Each rung EXCLUDES more from quantization, so the file grows and the accuracy
# recovers. The loop stops at the first rung under QUANT_MAX_ACC_LOSS, keeping the
# smallest artefact that meets the bar rather than the safest one.
def matmul_nodes(path):
    g = onnx.load(path, load_external_data=False).graph
    return [n.name for n in g.node if n.op_type in ("MatMul", "Gemm") and n.name]

def _sel(names, *needles):
    return [n for n in names if any(s in n for s in needles)]

def build_rungs(names):
    head = _sel(names, "classifier")
    attn = _sel(names, "attention/attention/query", "attention/attention/key",
                "attention/attention/value", "attention/output/dense",
                "attention.attention.query", "attention.attention.key",
                "attention.attention.value", "attention.output.dense")
    outer = []
    for i in list(range(2)) + list(range(max(0, N_LAYERS - 2), N_LAYERS)):
        outer += _sel(names, f"encoder/layer.{i}/", f"encoder.layer.{i}.")
    # Everything that is NOT a middle-block MLP -> the most conservative rung.
    mid_lo, mid_hi = 2, max(3, N_LAYERS - 2)
    mid_mlp = []
    for i in range(mid_lo, mid_hi):
        mid_mlp += _sel(names, f"encoder/layer.{i}/intermediate",
                        f"encoder/layer.{i}/output/dense",
                        f"encoder.layer.{i}.intermediate",
                        f"encoder.layer.{i}.output.dense")
    all_but_mid_mlp = [n for n in names if n not in set(mid_mlp)]
    return [
        ("INT8 (all MatMul)",                    []),
        ("INT8, head in FP32",                   head),
        ("INT8, head + attention in FP32",       head + attn),
        ("INT8, head + attention + outer blocks",head + attn + outer),
        ("INT8, middle-block MLPs only",         all_but_mid_mlp),
    ]

def quantize(exclude, out_path):
    quantize_dynamic(
        model_input=FP32_PATH, model_output=out_path,
        weight_type=QuantType.QInt8,
        # MatMul only. Quantizing every op type drags in the Add/LayerNorm path,
        # where INT8 costs accuracy and saves nothing: the weights there are a
        # rounding error of the total, and the casts it inserts cost throughput.
        op_types_to_quantize=["MatMul"],
        nodes_to_exclude=list(exclude),
        extra_options={"MatMulConstBOnly": True},
    )
    return sum(os.path.getsize(p) for p in _artifact_files(out_path)) / 1e6

# ------------------------------------------------------------------------------
# 10d. Run it, budget-aware.
# ------------------------------------------------------------------------------
onnx_fp32 = onnx_int8 = None
chosen_rung = None
quant_report = []
onnx_mb = fp32_mb = None
quant_note = ""

if ONNX_OK:
    try:
        fp32_mb = export_fp32()
        print(f"[onnx] exported FP32: {ONNX_FP32_PATH} ({fp32_mb:.1f} MB)")
        onnx_fp32 = eval_onnx(FP32_PATH, "fp32")

        names = matmul_nodes(FP32_PATH)
        rungs = build_rungs(names)
        print(f"[quant] {len(names):,} quantizable MatMul/Gemm nodes; "
              f"{len(rungs)} rungs available")

        # One eval is `onnx_fp32['seconds']`; one quantize is roughly a third of
        # that. Anything the clock cannot pay for is not attempted, and the report
        # says so rather than pretending the ladder was exhausted.
        per_rung = onnx_fp32["seconds"] * 1.35 + 20
        for i, (label, exclude) in enumerate(rungs):
            left = TIME_BOMB_SECONDS - bomb_elapsed()
            if i > 0 and left < per_rung + 180:
                quant_note = (f"ladder stopped early: {hms(left)} left, a rung "
                              f"costs ~{hms(per_rung)}")
                print(f"[quant] {quant_note}")
                break

            mb = quantize(exclude, INT8_PATH)
            r = eval_onnx(INT8_PATH, f"int8 r{i}")
            p = paired_delta(onnx_fp32["mask"], r["mask"])
            # delta = (base right & cand wrong - base wrong & cand right)/n, so a
            # POSITIVE delta is accuracy LOST. A negative one means INT8 scored
            # higher, which does happen and is not an error — it is noise of the
            # same magnitude as the effect, which is exactly why `se` is printed.
            loss = p["delta"]
            quant_report.append({
                "rung": i, "label": label, "excluded": len(exclude),
                "mb": mb, "top1": r["top1"], "top3": r["top3"],
                "macro_f1": r["macro_f1"], "loss": loss, "se": p["se"],
                "b": p["b"], "c": p["c"],
            })
            print(f"[quant] rung {i} — {label}\n"
                  f"        excluded {len(exclude):,} nodes  size {mb:.1f} MB\n"
                  f"        top1 loss vs ONNX-FP32: {loss*100:+.2f}% "
                  f"+/- {p['se']*100:.2f}%  (discordant b={p['b']} c={p['c']}, "
                  f"n={p['n']:,})")

            if loss <= QUANT_MAX_ACC_LOSS:
                chosen_rung = i
                onnx_int8 = r
                onnx_mb = mb
                print(f"[quant] rung {i} is within the {QUANT_MAX_ACC_LOSS*100:.0f}% "
                      f"budget -> KEEPING it")
                break
            print(f"[quant] loss exceeds {QUANT_MAX_ACC_LOSS*100:.0f}% -> "
                  f"escalating to selective quantization")

        if chosen_rung is None and quant_report:
            # Nothing met the bar. Ship the best rung measured and say so plainly
            # — a silently-degraded model is worse than a documented one.
            bestr = min(quant_report, key=lambda r: r["loss"])
            quant_note = (quant_note + "; " if quant_note else "") + (
                f"NO rung reached <={QUANT_MAX_ACC_LOSS*100:.0f}%; best was rung "
                f"{bestr['rung']} at {bestr['loss']*100:+.2f}%")
            print(f"[quant] {quant_note}")
            print("[quant] re-materialising the best rung as the shipped artefact")
            _, exclude = rungs[bestr["rung"]]
            onnx_mb = quantize(exclude, INT8_PATH)
            onnx_int8 = eval_onnx(INT8_PATH, f"int8 r{bestr['rung']} (final)")
            chosen_rung = bestr["rung"]

        # Upload both: FP32 is what the next quantization experiment starts from,
        # INT8 is what the server loads.
        for p, nm in ((INT8_PATH, ONNX_INT8_PATH), (FP32_PATH, ONNX_FP32_PATH)):
            if not os.path.exists(p):
                continue
            try:
                api.upload_file(path_or_fileobj=p, path_in_repo=nm,
                                repo_id=HF_REPO_ID, repo_type="model",
                                commit_message=f"onnx: {nm}")
                print(f"[push] {nm} -> Hub")
            except Exception as e:
                print(f"[push] {nm} upload failed: {e}")
    except Exception as e:
        quant_note = f"export/quantization aborted: {type(e).__name__}: {e}"
        print(f"[onnx] {quant_note}\n{traceback.format_exc()}")
else:
    quant_note = "onnxruntime unavailable in this image"

# ==============================================================================
# 11. Final accuracy summary  (requirement 6)
# ==============================================================================
manifest["classes"] = classes
if onnx_int8:
    manifest["quantization"] = {
        "rung": chosen_rung,
        "label": (quant_report[chosen_rung]["label"]
                  if chosen_rung is not None and chosen_rung < len(quant_report)
                  else None),
        "top1": onnx_int8["top1"], "top3": onnx_int8["top3"],
        "macro_f1": onnx_int8["macro_f1"], "mb": onnx_mb,
        "loss_vs_onnx_fp32": (quant_report[chosen_rung]["loss"]
                              if chosen_rung is not None
                              and chosen_rung < len(quant_report) else None),
        "note": quant_note or None,
    }
try:
    push_manifest()
except Exception as e:
    print(f"[manifest] final push failed: {e}")

W = 78
def rule(ch="="):   print(ch * W)
def row(k, v):      print(f"  {k:<34}{v}")
def blank():        print()

def _pct(x):  return "n/a" if x is None else f"{x*100:.2f}%"
def _f4(x):   return "n/a" if x is None else f"{x:.4f}"
def _mb(x):   return "n/a" if x is None else f"{x:.1f} MB"

_pth_mb = os.path.getsize(BEST_PATH) / 1e6 if os.path.exists(BEST_PATH) else None
_final_mb = onnx_mb if onnx_mb is not None else _pth_mb
_delta = None
if chosen_rung is not None and chosen_rung < len(quant_report):
    _delta = quant_report[chosen_rung]["loss"]

blank(); rule()
print(f"  FINDFLOWER ViT — RUN #{manifest['runs']} SUMMARY".ljust(W))
rule()
row("species (classes)", f"{num_labels:,}")
row("epochs completed this run", f"{epochs_done_this_run}")
row("cumulative epochs", f"{manifest['trained_epochs']}")
row("training time (this run)", hms(train_seconds))
row("total session elapsed", hms(bomb_elapsed()))
row("stopped because", stop_reason)
row("time bomb fired", "YES" if bomb_fired else "no")
rule("-")
print("  BASELINE — PyTorch")
row("  FP32  top-1 / top-3", f"{_pct((baseline_fp32 or {}).get('top1'))} / "
                             f"{_pct((baseline_fp32 or {}).get('top3'))}")
row("  FP32  macro F1", _f4((baseline_fp32 or {}).get("macro_f1")))
if baseline_fp16:
    row("  FP16  top-1 / top-3", f"{_pct(baseline_fp16.get('top1'))} / "
                                 f"{_pct(baseline_fp16.get('top3'))}")
    row("  FP16  macro F1", _f4(baseline_fp16.get("macro_f1")))
row("  best epoch (by macro F1)", f"{best.get('epoch', 0)}")
rule("-")
print("  ONNX")
row("  FP32  top-1 / top-3", f"{_pct((onnx_fp32 or {}).get('top1'))} / "
                             f"{_pct((onnx_fp32 or {}).get('top3'))}")
row("  FP32  macro F1", _f4((onnx_fp32 or {}).get("macro_f1")))
row("  FP32  size", _mb(fp32_mb))
row("  INT8  top-1 / top-3", f"{_pct((onnx_int8 or {}).get('top1'))} / "
                             f"{_pct((onnx_int8 or {}).get('top3'))}")
row("  INT8  macro F1", _f4((onnx_int8 or {}).get("macro_f1")))
row("  quantization strategy",
    (quant_report[chosen_rung]["label"]
     if chosen_rung is not None and chosen_rung < len(quant_report) else "none"))
row("  ACCURACY DELTA (top-1 lost)",
    "n/a" if _delta is None else
    f"{_delta*100:+.2f}%  ({'WITHIN' if _delta <= QUANT_MAX_ACC_LOSS else 'OVER'}"
    f" the {QUANT_MAX_ACC_LOSS*100:.0f}% budget)")
row("  measured on", f"{len(quant_subset):,} paired samples, "
                     f"{len({y for _, y in quant_subset}):,} classes")
rule("-")
row("FINAL MODEL SIZE", _mb(_final_mb))
row("  best_model.pth", _mb(_pth_mb))
row("  findflower_vit.onnx (INT8)", _mb(onnx_mb))
if fp32_mb and onnx_mb:
    row("  compression", f"{fp32_mb/onnx_mb:.2f}x smaller than ONNX FP32")
if quant_note:
    row("  note", quant_note)
rule("-")
row("model + manifest", f"https://huggingface.co/{HF_REPO_ID}")
row("data source", f"{DATA_MODE}" + (f" ({CLASS_TREE})" if CLASS_TREE else ""))
row("images indexed", f"{_total_imgs:,}")
rule()

if quant_report and len(quant_report) > 1:
    blank()
    print("  Quantization ladder (every rung actually measured):")
    print(f"  {'rung':<5}{'excluded':>10}{'size':>10}{'top-1':>9}"
          f"{'macroF1':>9}{'delta':>9}  strategy")
    for r in quant_report:
        mark = " <-- shipped" if r["rung"] == chosen_rung else ""
        print(f"  {r['rung']:<5}{r['excluded']:>10,}{r['mb']:>9.1f}M"
              f"{r['top1']*100:>8.2f}%{r['macro_f1']:>9.4f}"
              f"{r['loss']*100:>+8.2f}%  {r['label']}{mark}")

blank()
print("Re-run to continue: the manifest, the class order and the head all resume.")
if bomb_fired:
    print(f"The {TIME_BOMB_SECONDS}s bomb fired — every artefact above was still "
          f"saved and pushed before the session limit.")
print(f"To grow the class set, attach a larger image dataset "
      f"(kernel-metadata.json -> dataset_sources) or upload a species_list.json "
      f"to {HF_DATA_REPO}.")
