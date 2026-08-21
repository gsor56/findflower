# ==============================================================================
# FindFlower MaxViT-384 — dense-species (1,500 × 400+ img) fine-tuning on Kaggle
# ==============================================================================
# Credentials, in one place so there is no second place to look:
#
#   HF_TOKEN  — the ONLY secret this script reads. Looked for in the environment
#               first, then in Kaggle's secret store because attaching a secret
#               on Kaggle does not export it as an environment variable.
#               Kaggle: Add-ons > Secrets, label it exactly HF_TOKEN.
#               Local: set HF_TOKEN in the current process environment.
#   kaggle.json — belongs at ~/.kaggle/kaggle.json (chmod 600) and is used by the
#               `kaggle` CLI to PUSH this kernel. The script never reads it; a
#               notebook already running on Kaggle needs no Kaggle credential.
#   A GitHub token is never needed here. Nothing in this file talks to GitHub.
#
# Never hardcode any of them: this file is committed to a PUBLIC repo.
# ==============================================================================
import gc
import os
import sys

# Reduce allocator fragmentation before torch initializes CUDA. The conservative
# micro-batch below handles peak activation memory; expandable segments handle
# changing temporary allocation sizes without reserving as many unusable blocks.
os.environ.setdefault("PYTORCH_CUDA_ALLOC_CONF", "expandable_segments:True")

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
    Find HF_TOKEN in the environment or Kaggle's secret store.

    The environment alone is not enough on Kaggle. Attaching a secret in the UI
    does NOT export it as an environment variable -- it is handed out by
    `kaggle_secrets.UserSecretsClient`, and a script that only reads os.environ
    dies on a KeyError one second into an eight-hour booking with a secret that
    was attached correctly the whole time.

    The value is never printed or partially disclosed in the Kaggle logs.
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
print(f"[preflight] HF_TOKEN found in {_tok_src}")

# A FRESH repo for the MaxViT-384 pivot. Deliberately not the 224px ViT repo:
# the manifest lives inside the model repo, so pointing at a new id is what gives
# this architecture a clean class list, a clean epoch count and a clean history
# without touching `gsor56/findflower-VIT`, which still holds the finished 224px
# run (4,387 species, top-1 67.75%). Nothing here deletes or rewrites that.
#
# convert_to_onnx.py:47 still names the old ViT repo. That is correct for now --
# it converts the deployed 224px model. Point it here only when the MaxViT weights
# are the ones being served.
#
# (Repo ids are matched case-INsensitively by the Hub; "findflower-ViT" and
# "findflower-VIT" resolve to the same repo. Verified against the API.)
HF_REPO_ID = "gsor56/findflower-maxvit"       # private model repo on the Hub
# Deliberately NOT renamed to match: this is a separate repo that already holds
# whatever images previous collector runs uploaded. Renaming it here would not
# move them, it would silently create an empty second repo and report "restored
# 0 images". Change it only after confirming which spelling actually exists.
HF_DATA_REPO = "gsor56/FindFlower-Premium-100-flowering"  # balanced 1,500-class dataset
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
# Incremental, resumable MaxViT-384 fine-tuning for flower species classification
# ------------------------------------------------------------------------------
# Designed to run as a SINGLE Kaggle notebook cell. "Run and forget":
#   * Trains from a pre-staged image tree or scrapes iNaturalist
#   * Tracks progress in manifest.json on the Hugging Face Hub
#   * Resumes model from the last checkpoint on the Hub (never restarts scratch)
#   * Grows the classification head when you add species, preserving old weights
#   * Saves progress INCREMENTALLY so a Kaggle timeout never loses finished work
#   * Hard TIME_BOMB_SECONDS bomb, then pushes, quantizes and evaluates
#
# Setup (once):
#   1. Kaggle: enable GPU (Settings -> Accelerator -> GPU T4 x2)
#   2. Kaggle: enable Internet (Settings -> Internet -> On)
#   3. Attach the species image dataset, or edit SPECIES_LIST for the scrape path.
#
# ------------------------------------------------------------------------------
# THE COST OF 384px, measured -- read before changing BATCH_SIZE or EPOCHS_PER_RUN
# ------------------------------------------------------------------------------
# The 224px ViT-B/16 run on this exact hardware measured 115-117 img/s training
# and 4,271 Plantae classes at 27m 35s per epoch (full log, run #2).
#
#   Pixels     384^2 / 224^2 = 2.94x the input area.
#   Attention  MaxViT is block-local + grid-global, so attention stays linear in
#              the token count instead of quadratic -- that is why it is usable at
#              384 at all. The MBConv stages, however, are pure convolution over
#              2.94x the area.
#   Net        expect roughly 10-15 img/s, i.e. 8-12x slower per image. At 1,500
#              species x 50 images that is ~1 to 1.5 hours per epoch, so a 10.5h
#              session buys single-digit epochs. EPOCHS_PER_RUN=50 is a ceiling
#              spanning many sessions; the manifest is what accumulates them.
#   VRAM       BATCH_SIZE=4 x GRAD_ACCUM_STEPS=16 keeps the effective batch at 64
#              with conservative activation usage on a 16 GB T4. If a T4 still
#              OOMs, the loop skips the batch (see _oom_backoff) rather than dying.
# ------------------------------------------------------------------------------
# READ THIS BEFORE SETTING MAX_SPECIES TO 5000 — the arithmetic does not fit
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
#           100–120 img/s => 3.5–4.2 HOURS PER EPOCH. A 10.5h session therefore
#           buys about TWO epochs, and that is the real reason this script is
#           built to resume rather than to finish. At 384px on MaxViT-base the
#           per-image cost is 8-12x higher again, so the dense-1,500 plan below
#           is not a smaller version of this — it is the only version that fits.
#
# The consequence, made explicit so it is not discovered at hour eight: at this
# scale a single session cannot produce a converged 5,000-class model. What it
# produces is two more epochs on top of whatever the Hub already holds. Plan on
# 15–25 sessions. DATA_SOURCE below is what makes that survivable.
# ==============================================================================

# ------------------------------------------------------------------------------
# 0. Config -- the only things you ever need to touch
# ------------------------------------------------------------------------------
# The backbone. Two families are supported and the choice is made by the id:
#
#   "timm/<name>"                 -> loaded with timm.create_model
#   anything else (a transformers -> loaded with ViTForImageClassification
#   checkpoint like google/vit-*)
#
# MaxViT is a hybrid: MBConv stages for local structure, then alternating
# block-local and grid-global attention. That is the reason for the pivot -- at
# 384px a plain ViT-B/16 sees 576 patches of 16px and never looks INSIDE a patch,
# while MaxViT's convolutional stem resolves stamen and petal-margin detail that
# separates two Papaver species, and the grid attention still relates the whole
# inflorescence. It is a timm checkpoint, not a transformers one, so sections 5-10
# below dispatch on IS_TIMM rather than assuming ViTForImageClassification.
BASE_MODEL = "timm/maxvit_base_tf_384.in1k"

# ---- Where images come from ---------------------------------------------------
#   "auto"  detect: an attached Kaggle Dataset wins, else the Hub, else iNat
#   "local" an ImageFolder-style tree: <root>/<species_name>/*.jpg
#   "hub"   snapshot HF_DATA_REPO (fine to a few hundred species; not to 5,000)
#   "inat"  scrape iNaturalist per SPECIES_LIST (a collector for future runs)
DATA_SOURCE = "hub"
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
# Quality over quantity: 1,500 densely-photographed species rather than 5,000
# thin ones. MAX_SPECIES keeps the RICHEST classes (the eligible list is sorted by
# image count before the cap is applied), so this is a density filter as much as a
# ceiling.
MAX_SPECIES = 1500         # hard ceiling on classes admitted this run
MIN_IMAGES = 100           # Premium-100 is strictly balanced at 100 images/class
TARGET_IMAGES = 100        # do not collect beyond the finalized dataset contract
MIN_IMAGES_LARGE = 100     # retain every one of the 1,500 balanced classes

# ---- Training budget ----------------------------------------------------------
# 50 is a cumulative CEILING that spans sessions, not a plan for one booking.
# The manifest carries `trained_epochs` across runs, so each booking picks up
# where the last stopped;
# what actually ends a session is TAIL_RESERVE_SECONDS below. MaxViT-base at 384px
# is roughly 8-12x the cost per image of ViT-B/16 at 224px, so expect single-digit
# epochs per session, not all 50 at once.
EPOCHS_PER_RUN = 50
BATCH_SIZE = 4             # conservative per-device batch for MaxViT-base at 384px
GRAD_ACCUM_STEPS = 16      # 4 x 16 = an effective batch of 64, same as the 224 run
LEARNING_RATE = 1.5e-4     # lower resumed-head lr reduces late-epoch oscillation
BACKBONE_LR = 2.5e-5       # conservative top-block adaptation over the long run
LLRD_DECAY = 0.80          # adapt low-level botanical texture/color features more
WEIGHT_DECAY = 0.03        # less underfitting with 400+ images across 1,500 classes
WARMUP_FRACTION = 0.02     # one epoch over the cumulative 50-epoch schedule
VAL_FRACTION = 0.15        # 85/15 train/val split
IMAGE_SIZE = 384           # maxvit_base_tf_384 is FIXED at 384; do not change alone
NUM_WORKERS = 4
LABEL_SMOOTHING = 0.1
LOSS_MODE = "focal_smooth"  # "smooth" | "focal" | "focal_smooth"
FOCAL_GAMMA = 1.0          # less emphasis on noisy hard samples; better top-k fit

# ---- The Kaggle session time-bomb --------------------------------------------
# Kaggle's GPU sessions run to 12 hours. 37800s (10.5h) is checked at the end of
# EVERY epoch. TAIL_RESERVE is the separate, earlier deadline that stops a NEW
# epoch from starting, because the work that happens after the bomb (push, ONNX
# export, the quantization ladder, two evaluation passes) is itself 25-50 minutes.
# Firing at 37800 and only then beginning an hour of post-processing is how a
# session gets killed holding everything it just earned.
#
# Net effect: new epochs stop at 9.75h, the bomb fires at 10.5h, and the tail has
# the remaining ~1.5h of the 12-hour booking to finish in.
TIME_BOMB_SECONDS = 37800           # 10.5h — the hard limit for this run
TAIL_RESERVE_SECONDS = 45 * 60      # keep this much for push + quantize + eval
STEP_CHECKPOINT_EVERY = 1500        # mid-epoch weight saves; a 4h epoch is too
                                    # long to risk losing to a wipe

# ---- Quantization ------------------------------------------------------------
QUANT_MAX_ACC_LOSS = 0.01   # 1%: above this, selective quantization is triggered
QUANT_EVAL_MAX = 400        # bounded CPU eval so ONNX finalization fits the session
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

# ------------------------------------------------------------------------------
# timm — the MaxViT backbone lives here, not in transformers.
# ------------------------------------------------------------------------------
# Kaggle's image ships timm, but the version drifts and MaxViT's `maxxvit.py`
# arrived in 0.9. --no-deps for the usual reason (nothing may replace the numpy
# that the GPU-matched torch was built against); timm's only hard requirements are
# torch/torchvision/huggingface_hub, all already present.
#
# IS_TIMM is the single switch every architecture-specific branch below reads. A
# transformers checkpoint id keeps the old ViT code path alive, so reverting the
# pivot is a one-line change to BASE_MODEL.
IS_TIMM = BASE_MODEL.startswith(("timm/", "hf_hub:"))
TIMM_ARCH = BASE_MODEL.split("/", 1)[1] if IS_TIMM else ""

timm = None
if IS_TIMM:
    try:
        import timm
    except Exception:
        _pip("--no-deps", "timm")
        import timm
    _need = (0, 9)
    _have = tuple(int(x) for x in timm.__version__.split(".")[:2]
                  if x.isdigit()) or (0, 0)
    if _have < _need:
        # An old timm has no maxxvit.py at all, and create_model would raise a
        # bare "Unknown model" that reads like a typo rather than a version
        # problem. Upgrade in place; --no-deps keeps numpy/torch untouched.
        print(f"[init] timm {timm.__version__} predates MaxViT; upgrading")
        _pip("--no-deps", "--upgrade", "timm")
        import importlib
        timm = importlib.reload(timm)
    print(f"[init] timm {timm.__version__}, arch={TIMM_ARCH}")

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
# here is (B, 3, IMAGE_SIZE, IMAGE_SIZE), so the tuning cost is paid once and
# repaid for the rest of the run — and MaxViT's MBConv stages are convolution, so
# this matters more here than it did for a pure ViT. Determinism is deliberately
# not requested: it would cost throughput we do not have to spare.
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
# 1b. The session clock. One wall-clock origin, read from everywhere.
# ------------------------------------------------------------------------------
# The brief specifies `start_time = time.time()` and a `> TIME_BOMB_SECONDS`
# check, so that is exactly what is implemented. time.monotonic() is used for the
# same quantity because it cannot go backwards if the container's clock is stepped
# by NTP mid-run — a wall-clock jump of a few minutes is the difference between
# saving the model and losing it.
start_time = time.time()

def bomb_elapsed():
    """Seconds since the run began — the quantity compared against the bomb."""
    return time.monotonic() - RUN_START

def time_bomb_fired():
    """The literal spec: (time.time() - start_time) > TIME_BOMB_SECONDS."""
    return bomb_elapsed() > TIME_BOMB_SECONDS

def tail_deadline_passed():
    """
    True once there is no longer room to START another epoch and still finish the
    tail (push + ONNX export + the quantization ladder + two eval passes). Firing
    only at the bomb and THEN beginning ~40 minutes of post-processing is how a
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
_canonical_species_order = list(_extra_species)
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
# wall clock, and the session dies in 10.5 hours (TIME_BOMB_SECONDS). So at scale
# the images must already exist, and this block finds them.
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
# The image floor, and why it has to be able to give way.
# ------------------------------------------------------------------------------
# MIN_IMAGES / MIN_IMAGES_LARGE express the density this pivot is aiming at: 400+
# images per species, so a 1,500-way head is learning from real within-species
# variation rather than memorising fifty photographs. That is the right target and
# it is what the constants say.
#
# It is not what every attached dataset can supply. iNaturalist 2021 `train_mini`
# — the tree attached to this kernel — holds EXACTLY 50 images per species by
# construction (measured: min=50 median=50 max=50 over 4,271 Plantae classes). A
# 400 floor admits zero classes there, `collected` collapses to whatever the
# manifest already knew, and on a fresh repo that is nothing at all: the run would
# exit two minutes into a twelve-hour booking having trained on nothing.
#
# So the floor is a REQUEST, not an assertion. If it admits fewer classes than the
# run needs, it steps down through a ladder to the highest value the tree can
# actually satisfy and says so loudly. The alternative — honouring a number the
# data cannot meet — trades a wasted session for no benefit, and the imbalance a
# lower floor lets in is already handled where it belongs: focal loss and the
# sqrt-inverse-frequency sampler.
#
# MIN_VIABLE_CLASSES is the bar for "did the floor leave us a trainable problem".
# Below this it is not a thin class set, it is a broken filter.
MIN_VIABLE_CLASSES = 50

def _eligible_at(floor):
    out = [(lbl, len(f)) for lbl, f in samples_by_label.items() if len(f) >= floor]
    out.sort(key=lambda t: (-t[1], t[0]))          # richest classes first
    return out

FLOOR = MIN_IMAGES_LARGE if len(samples_by_label) > 1000 else MIN_IMAGES
FLOOR_REQUESTED = FLOOR
eligible = _eligible_at(FLOOR)
print(f"[classes] floor={FLOOR} img/species -> {len(eligible):,} eligible "
      f"of {len(samples_by_label):,}")

if len(eligible) < MIN_VIABLE_CLASSES and samples_by_label:
    _sizes = sorted((len(f) for f in samples_by_label.values()), reverse=True)
    # The highest floor that still admits MIN_VIABLE_CLASSES classes is just the
    # size of the MIN_VIABLE_CLASSES-th richest class. Then walk the ladder down
    # from the request so the reported floor is a round, explainable number rather
    # than whatever one outlier class happens to hold.
    _best_possible = _sizes[min(len(_sizes), MIN_VIABLE_CLASSES) - 1]
    for _cand in (400, 300, 200, 150, 100, 75, 50, 40, 30, 20, 10):
        if _cand <= FLOOR_REQUESTED and _cand <= _best_possible:
            FLOOR = _cand
            break
    else:
        FLOOR = max(2, _best_possible)
    eligible = _eligible_at(FLOOR)
    print(f"[classes] !! the requested floor of {FLOOR_REQUESTED} img/species "
          f"admits only {len(_eligible_at(FLOOR_REQUESTED)):,} classes -- this "
          f"tree's richest class has {_sizes[0]:,} images.")
    print(f"[classes] !! relaxing the floor to {FLOOR} img/species -> "
          f"{len(eligible):,} eligible. To train at {FLOOR_REQUESTED}+ images per "
          f"species, attach a denser dataset (iNat21 full train, or several "
          f"sessions of the `inat` collector building up HF_DATA_REPO).")

if len(eligible) > MAX_SPECIES:
    print(f"[classes] capping at MAX_SPECIES={MAX_SPECIES:,} "
          f"(dropping {len(eligible) - MAX_SPECIES:,} thinnest classes)")
    eligible = eligible[:MAX_SPECIES]

collected = [lbl for lbl, _ in eligible]

# A fresh MaxViT head follows the finalized species_list.json order. Resumed
# runs retain manifest["classes"] below so existing checkpoint indices never move.
if not manifest["classes"] and _canonical_species_order:
    eligible_labels = set(collected)
    ordered = [lbl for lbl in _canonical_species_order if lbl in eligible_labels]
    ordered_set = set(ordered)
    ordered.extend(lbl for lbl in collected if lbl not in ordered_set)
    collected = ordered

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
# Two loaders, one interface. Everything downstream of this section talks to the
# model through four helpers and never asks what family it belongs to:
#
#   forward_logits(m, x)   -> a plain (B, C) tensor, .logits unwrapped if needed
#   classifier_of(m)       -> the final nn.Linear
#   set_classifier(m, fc)  -> replace it
#   reset_classifier(m, n) -> rebuild it at a new width, timm's own way
#
# That indirection is the whole reason a MaxViT pivot is a section-5 change and not
# a rewrite: the training loop, the metrics, the checkpointing and the ONNX export
# are all architecture-agnostic once logits are just a tensor.
def forward_logits(m, x):
    """
    Logits from either family. timm returns a bare tensor; transformers returns
    ImageClassifierOutput. Both accept pixel_values positionally, so one call
    covers both and the unwrapping is decided by the type, not by a flag that
    could disagree with the object actually in memory.
    """
    out = m(x)
    return out if torch.is_tensor(out) else out.logits

def classifier_of(m):
    if hasattr(m, "get_classifier"):          # timm's documented accessor
        return m.get_classifier()
    return m.classifier                        # transformers ViT

def set_classifier(m, fc):
    if hasattr(m, "get_classifier"):
        # MaxViT's head is NormMlpClassifierHead(norm, pre_logits, drop, fc): the
        # Linear is head.fc, and reset_classifier rebuilds ONLY that, leaving the
        # pretrained norm and pre_logits MLP intact. Assigning through the same
        # attribute keeps that invariant.
        m.head.fc = fc
    else:
        m.classifier = fc

def reset_classifier(m, n):
    if hasattr(m, "reset_classifier"):
        m.reset_classifier(n)
    else:
        old = classifier_of(m)
        set_classifier(m, nn.Linear(old.in_features, n))

# ------------------------------------------------------------------------------
# The processor. Kept even on the timm path, deliberately.
# ------------------------------------------------------------------------------
# timm carries its normalization in `pretrained_cfg`, not in a preprocessor
# config. But the inference server, convert_to_onnx.py and try.html all read
# preprocessor_config.json from the Hub repo to learn mean/std/size. Building a
# ViTImageProcessor around timm's own numbers means the pivot does not silently
# change the contract those three consumers depend on — and section 6 below can go
# on reading processor.image_mean without caring which family loaded the weights.
TIMM_CFG = {}

def load_processor():
    if IS_TIMM:
        return None            # built after the model, from its pretrained_cfg
    try:
        return ViTImageProcessor.from_pretrained(HF_REPO_ID, token=HF_TOKEN)
    except Exception:
        return ViTImageProcessor.from_pretrained(BASE_MODEL)

def processor_from_timm(m):
    """A ViTImageProcessor that reports exactly what this timm model was trained
    with. resolve_model_data_config is timm's own answer to that question; the
    hand-rolled fallback exists because it moved modules between 0.9 and 1.x."""
    cfg = {}
    try:
        cfg = dict(timm.data.resolve_model_data_config(m))
    except Exception:
        try:
            from timm.data import resolve_data_config
            cfg = dict(resolve_data_config({}, model=m))
        except Exception:
            pc = dict(getattr(m, "pretrained_cfg", {}) or {})
            cfg = {"mean": pc.get("mean", (0.5, 0.5, 0.5)),
                   "std": pc.get("std", (0.5, 0.5, 0.5)),
                   "input_size": pc.get("input_size", (3, IMAGE_SIZE, IMAGE_SIZE)),
                   "crop_pct": pc.get("crop_pct", 0.875)}
    TIMM_CFG.update(cfg)
    return ViTImageProcessor(
        do_resize=True, size={"height": IMAGE_SIZE, "width": IMAGE_SIZE},
        do_rescale=True, rescale_factor=1 / 255, do_normalize=True,
        image_mean=list(cfg.get("mean", (0.5, 0.5, 0.5))),
        image_std=list(cfg.get("std", (0.5, 0.5, 0.5))),
    )

processor = load_processor()

# ------------------------------------------------------------------------------
# Resume.
# ------------------------------------------------------------------------------
# The transformers path can use from_pretrained. The timm path cannot: there is no
# PretrainedModel wrapper and no guarantee that timm's own hub-config schema in
# whatever version Kaggle ships matches the one that wrote the checkpoint. So the
# timm resume is done explicitly and under our control -- read config.json for the
# label count, build the architecture at that width, load the state dict. That is
# version-proof in a way `create_model('hf_hub:...')` is not.
def _load_state_dict(local_dir):
    st = os.path.join(local_dir, "model.safetensors")
    if os.path.exists(st):
        from safetensors.torch import load_file
        return load_file(st, device="cpu")
    for cand in ("pytorch_model.bin", "model.bin"):
        p = os.path.join(local_dir, cand)
        if os.path.exists(p):
            blob = torch.load(p, map_location="cpu", weights_only=False)
            return blob.get("state_dict", blob) if isinstance(blob, dict) else blob
    return None

def try_load_checkpoint():
    """Return a model loaded from the Hub checkpoint, or None if none exists."""
    try:
        local = snapshot_download(repo_id=HF_REPO_ID, repo_type="model",
                                  token=HF_TOKEN,
                                  allow_patterns=["*.json", "*.safetensors", "*.bin"])
        cfg_path = os.path.join(local, "config.json")
        if not os.path.exists(cfg_path):
            return None
        if not IS_TIMM:
            model = ViTForImageClassification.from_pretrained(local)
            print(f"[model] resumed checkpoint with {model.config.num_labels} labels")
            return model

        with open(cfg_path, encoding="utf-8") as f:
            cfg = json.load(f)
        arch = cfg.get("architecture") or cfg.get("timm_arch") or TIMM_ARCH
        old_n = int(cfg.get("num_classes") or cfg.get("num_labels") or 0)
        if arch != TIMM_ARCH:
            # A checkpoint for a different backbone in the same repo is not a
            # checkpoint we can grow -- the parameter shapes do not line up. Say so
            # instead of loading half a state dict and training noise.
            print(f"[model] checkpoint architecture '{arch}' != '{TIMM_ARCH}'; "
                  f"ignoring it and starting from the pretrained backbone")
            return None
        if old_n < 1:
            return None
        sd = _load_state_dict(local)
        if sd is None:
            return None
        model = timm.create_model(TIMM_ARCH, pretrained=False, num_classes=old_n)
        missing, unexpected = model.load_state_dict(sd, strict=False)
        if missing or unexpected:
            print(f"[model] state dict: {len(missing)} missing, "
                  f"{len(unexpected)} unexpected key(s)")
            if len(missing) > 0.2 * len(list(model.state_dict())):
                print("[model] too much of the checkpoint is missing; discarding it")
                return None
        model._ff_id2label = {int(k): v for k, v in
                              (cfg.get("id2label") or {}).items()}
        if not model._ff_id2label:
            names = cfg.get("label_names") or cfg.get("labels") or []
            model._ff_id2label = {i: n for i, n in enumerate(names)}
        model._ff_num_labels = old_n
        print(f"[model] resumed checkpoint with {old_n} labels")
        return model
    except (EntryNotFoundError, RepositoryNotFoundError):
        return None
    except Exception as e:
        print(f"[model] no usable checkpoint ({e})")
        return None

def _prev_id2label(m):
    """Old index -> label, from whichever family the checkpoint came from."""
    if hasattr(m, "config"):
        return {int(k): v for k, v in m.config.id2label.items()}
    return dict(getattr(m, "_ff_id2label", {}) or {})

def _prev_num_labels(m):
    if hasattr(m, "config"):
        return int(m.config.num_labels)
    return int(getattr(m, "_ff_num_labels", classifier_of(m).out_features))

prev_model = try_load_checkpoint()

if prev_model is None:
    print("[model] initializing fresh from", BASE_MODEL)
    if IS_TIMM:
        model = timm.create_model(TIMM_ARCH, pretrained=True,
                                  num_classes=num_labels)
    else:
        model = ViTForImageClassification.from_pretrained(
            BASE_MODEL, num_labels=num_labels,
            id2label=id2label, label2id=label2id,
            ignore_mismatched_sizes=True,
        )
else:
    old_num = _prev_num_labels(prev_model)
    model = prev_model
    if old_num != num_labels:
        # ---- Grow the classification head, preserving old class weights ----
        print(f"[model] resizing head {old_num} -> {num_labels} (preserving weights)")
        old_fc = classifier_of(model)
        old_w = old_fc.weight.detach().clone()
        old_b = (old_fc.bias.detach().clone() if old_fc.bias is not None else None)
        reset_classifier(model, num_labels)
        new_fc = classifier_of(model)
        nn.init.xavier_uniform_(new_fc.weight)
        if new_fc.bias is not None:
            nn.init.zeros_(new_fc.bias)
        # Copy old rows for classes that already existed, BY LABEL NAME. Copying by
        # index would be silently wrong the first time a species is dropped from the
        # tree: every class after it shifts down one and inherits its neighbour's
        # weights, which looks like training and predicts nonsense.
        moved = 0
        with torch.no_grad():
            for old_idx, lbl in _prev_id2label(model).items():
                if lbl in label2id and old_idx < old_w.shape[0]:
                    new_idx = label2id[lbl]
                    new_fc.weight[new_idx] = old_w[old_idx]
                    if old_b is not None and new_fc.bias is not None:
                        new_fc.bias[new_idx] = old_b[old_idx]
                    moved += 1
        print(f"[model] carried {moved:,} existing class vector(s) across the resize")
    if hasattr(model, "config"):
        model.config.num_labels = num_labels
        model.config.id2label = id2label
        model.config.label2id = label2id
    else:
        model._ff_id2label = dict(id2label)
        model._ff_num_labels = num_labels

if IS_TIMM:
    processor = processor_from_timm(model)
    _in = TIMM_CFG.get("input_size", (3, IMAGE_SIZE, IMAGE_SIZE))
    if int(_in[-1]) != IMAGE_SIZE:
        # maxvit_base_tf_384 has fixed_input_size=True: the grid-attention
        # partitioning is computed for a 384 feature map and a different input
        # silently changes the window layout (or throws deep inside the stage).
        # Failing here costs a minute; failing at step 1 costs the booking.
        raise SystemExit(
            f"[model] IMAGE_SIZE={IMAGE_SIZE} but {TIMM_ARCH} expects "
            f"{int(_in[-1])}. Set IMAGE_SIZE to {int(_in[-1])} or pick a variant "
            f"trained at {IMAGE_SIZE}."
        )
    print(f"[model] {TIMM_ARCH}: {sum(p.numel() for p in model.parameters())/1e6:.1f}M "
          f"params, {num_labels:,}-way head, "
          f"input {IMAGE_SIZE}px, crop_pct={TIMM_CFG.get('crop_pct', 0.875)}")

model.to(DEVICE)

# ==============================================================================
# 6. Dataset + augmentation (train) / clean resize (val)
# ==============================================================================
mean = processor.image_mean
std  = processor.image_std

# ------------------------------------------------------------------------------
# The validation resize, and why the crop ratio is not a constant.
# ------------------------------------------------------------------------------
# 1.14 is 1/0.875 — the crop_pct every ImageNet ViT is evaluated at, and the right
# number for google/vit-base-patch16-224. It is the WRONG number for
# maxvit_base_tf_384.in1k, which timm records as crop_pct=1.0 with crop_mode
# 'squash': that checkpoint was validated on the whole frame squashed to 384x384,
# not on a centre crop of a 438px resize. Evaluating it at 0.875 throws away the
# outer 12% of every validation image and costs real top-1 for no reason.
#
# So the ratio comes from the model's own config when there is one. At crop_pct=1.0
# the resize equals IMAGE_SIZE and the CenterCrop below becomes a no-op, which is
# exactly 'squash'.
EVAL_CROP_PCT = float(TIMM_CFG.get("crop_pct") or 0.875)
EVAL_RESIZE = max(IMAGE_SIZE, int(round(IMAGE_SIZE / max(0.05, EVAL_CROP_PCT))))
print(f"[aug] eval resize {EVAL_RESIZE}px -> centre crop {IMAGE_SIZE}px "
      f"(crop_pct={EVAL_CROP_PCT:.3f})")

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
            lambda: A.Resize(height=EVAL_RESIZE, width=EVAL_RESIZE),
            lambda: A.Resize(EVAL_RESIZE, EVAL_RESIZE),
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
        # A tuple squashes to a square (crop_pct=1.0, timm's 'squash' mode); a bare
        # int resizes the SHORT side and lets CenterCrop take the middle, which is
        # the classic 0.875 recipe. The albumentations branch above always passes
        # height and width, so it squashes either way and the CenterCrop is what
        # makes the two paths agree.
        transforms.Resize((EVAL_RESIZE, EVAL_RESIZE) if EVAL_RESIZE == IMAGE_SIZE
                          else EVAL_RESIZE),
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

def _timm_hub_config():
    """
    The config.json a timm checkpoint needs on the Hub.

    Two audiences, one file. `architecture` / `num_classes` / `pretrained_cfg` are
    timm's own schema, so `timm.create_model("hf_hub:gsor56/findflower-maxvit",
    pretrained=True)` works for anyone downstream. `id2label` / `label2id` /
    `num_labels` are the transformers spelling that the inference server and
    try.html already read. Writing both costs a few KB and removes a whole class of
    "which loader am I" bug.

    pretrained_cfg is DERIVED from the live model rather than typed out: the mean,
    std, input_size and crop_pct have to be the ones training actually used, and a
    hand-copied table is how those drift apart.
    """
    pc = dict(getattr(model, "pretrained_cfg", {}) or {})
    pc.update({
        "num_classes": num_labels,
        "input_size": list(TIMM_CFG.get("input_size", (3, IMAGE_SIZE, IMAGE_SIZE))),
        "mean": list(mean), "std": list(std),
        "crop_pct": EVAL_CROP_PCT,
    })
    pc.pop("url", None)          # points at the in1k weights, not ours
    pc.pop("hf_hub_id", None)
    return {
        "architecture": TIMM_ARCH,
        "num_classes": num_labels,
        "num_features": int(getattr(model, "num_features", 0)) or None,
        "pretrained_cfg": pc,
        "label_names": [id2label[i] for i in range(num_labels)],
        # transformers-compatible aliases
        "model_type": "timm_wrapper",
        "num_labels": num_labels,
        "id2label": {str(k): v for k, v in id2label.items()},
        "label2id": label2id,
        "image_size": IMAGE_SIZE,
        "base_model": BASE_MODEL,
    }

def save_checkpoint_local():
    if IS_TIMM:
        # timm models have no save_pretrained. safetensors directly, which is the
        # same format from_pretrained would have written and the one the Hub UI and
        # every downstream loader prefer.
        from safetensors.torch import save_file
        sd = {k: v.detach().cpu().contiguous()
              for k, v in model.state_dict().items()}
        save_file(sd, os.path.join(CKPT_DIR, "model.safetensors"),
                  metadata={"format": "pt"})
        with open(os.path.join(CKPT_DIR, "config.json"), "w", encoding="utf-8") as f:
            json.dump(_timm_hub_config(), f, indent=2)
    else:
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
    id2label/label2id mapping.

    Run #2 failed here with `PushToHubMixin.push_to_hub() got an unexpected keyword
    argument 'safe_serialization'` — transformers moved that argument out of the
    mixin's signature, and passing it unconditionally turned a working push into a
    TypeError at the very end of a six-hour run. The fallback saved it, but the fix
    is to ask the signature what it accepts instead of guessing.

    A timm model has no push_to_hub at all, so on that path upload_folder IS the
    push, not a fallback: `save_checkpoint_local` has already written the exact
    same safetensors + config.json + preprocessor_config.json that a
    `from_pretrained` consumer needs.
    """
    if hasattr(model, "config"):
        model.config.id2label = {int(k): v for k, v in id2label.items()}
        model.config.label2id = label2id

    def _push(obj, what, **extra):
        """push_to_hub, called with only the kwargs this version admits."""
        import inspect
        try:
            accepted = set(inspect.signature(obj.push_to_hub).parameters)
        except (TypeError, ValueError):
            accepted = set()
        kw = {"token": HF_TOKEN, "private": HF_PRIVATE, "commit_message": msg}
        kw.update(extra)
        # VAR_KEYWORD means **kwargs, which swallows anything -- but the run #2
        # failure proves it can still reject a name it swallowed in an older
        # release, so drop unknowns whenever the signature is introspectable.
        if accepted and not any(
                p.kind is inspect.Parameter.VAR_KEYWORD
                for p in inspect.signature(obj.push_to_hub).parameters.values()):
            kw = {k: v for k, v in kw.items() if k in accepted}
        obj.push_to_hub(HF_REPO_ID, **kw)
        print(f"[push] {what}.push_to_hub -> {HF_REPO_ID}")

    ok = True
    if hasattr(model, "push_to_hub"):
        try:
            _push(model, "model", safe_serialization=True)
        except Exception as e:
            ok = False
            print(f"[push] model.push_to_hub failed: {type(e).__name__}: {e}")
    else:
        ok = False           # timm: upload_folder below is the real push
        print(f"[push] {TIMM_ARCH} is a timm model (no push_to_hub); "
              f"using upload_folder, which carries the same artefacts")
    try:
        _push(processor, "processor")
    except Exception as e:
        ok = False
        print(f"[push] processor.push_to_hub failed: {type(e).__name__}: {e}")
    if not ok:
        print("[push] upload_folder for the same artefacts")
        try:
            push_checkpoint(msg + " (upload_folder)")
        except Exception as e:
            print(f"[push] upload_folder ALSO failed: {e}")
    return ok

# ==============================================================================
# 8. Train -- LLRD + focal/label-smoothing loss + the session time bomb
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
# FOCAL_GAMMA is 1.0, not the paper's 2.0: with a 1,500-way head the
# early-training probability of the correct class is ~0.0002, so (1-p)^gamma is
# ~1 for everything and gamma mostly amplifies noise. Gamma 1.0 keeps useful
# hard-example pressure without letting mislabeled or ambiguous photos dominate.
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
# Early layers encode edges and colour; late layers encode the composition that
# actually separates two similar Papaver species. Training both at one rate either
# destroys the general features or starves the specific ones. LLRD assigns each
# depth its own rate, decaying by LLRD_DECAY per level down:
#
#   depth 0            the stem / patch embedding
#   depth 1..N         the transformer or hybrid blocks, in forward order
#   depth N+1          final norm, pooler, head
#
#   lr(depth) = BACKBONE_LR * LLRD_DECAY ** (N + 1 - depth)
#
# The head is deliberately NOT part of that ladder. It is brand new (or has just
# grown by hundreds of rows) and needs LEARNING_RATE, which is ~6x the top block's
# rate. A single shared rate here is the classic way to get a run that looks like
# it is training and never separates the tail classes.
#
# The hard part on a pivot is that "the blocks" is a different parameter tree for
# every family, and getting it wrong is silent: an unmatched name falls to the
# deepest bucket, so a broken map trains the ENTIRE backbone at BACKBONE_LR and
# looks completely normal in the logs. So the map is DISCOVERED from the model's
# own named_parameters() and then asserted:
#
#   MaxViT / ConvNeXt / timm hybrids   stages.{s}.blocks.{b}.*     -> 24 blocks
#   timm plain ViT                     blocks.{i}.*
#   transformers ViT                   [vit.]encoder.layer.{i}.*
#   Swin                               layers.{s}.blocks.{b}.*
#
# Ordering matters and lexical sort would put stage 10 before stage 2, so the keys
# are integer tuples and sorted as tuples.
import re as _re

_DEPTH_PATTERNS = (
    ("stages",  _re.compile(r"(?:^|\.)stages\.(\d+)\.blocks\.(\d+)\.")),
    ("layers",  _re.compile(r"(?:^|\.)layers\.(\d+)\.blocks\.(\d+)\.")),
    ("blocks",  _re.compile(r"(?:^|\.)blocks\.(\d+)\.")),
    ("encoder", _re.compile(r"(?:^|\.)encoder\.layer\.(\d+)\.")),
)
_STEM_HINTS = ("stem.", "patch_embed.", "embeddings.", "conv_stem", "cls_token",
               "pos_embed", "position_embeddings", "patch_embeddings")

def build_depth_map(m):
    """
    Return (depth_of, n_blocks, prefixes, kind).

    `depth_of(name) -> int` in 0..n_blocks+1. `prefixes[d]` is the list of
    parameter-name prefixes belonging to depth d, which section 10c reuses to pick
    ONNX nodes by block — the same map, so the ladder and the optimizer can never
    disagree about which block is "outer".
    """
    names = [n for n, _ in m.named_parameters()]
    kind, pat, keys = None, None, set()
    for k, p in _DEPTH_PATTERNS:
        found = {tuple(int(g) for g in mt.groups())
                 for n in names for mt in [p.search(n)] if mt}
        if found:
            kind, pat, keys = k, p, found
            break
    if not keys:
        return (lambda name: 1), 1, {0: [], 1: [], 2: []}, "flat"

    order = {key: i + 1 for i, key in enumerate(sorted(keys))}
    n_blocks = len(order)
    top = n_blocks + 1

    # Which stage does each depth belong to, so a stage-level parameter that is not
    # inside a block (MaxViT keeps some downsample/norm weights there) can be
    # charged to that stage's FIRST block rather than dumped at the top.
    stage_first = {}
    if len(next(iter(order))) == 2:
        for (s, _b), d in sorted(order.items(), key=lambda kv: kv[1]):
            stage_first.setdefault(s, d)
    _stage_only = _re.compile(r"(?:^|\.)(?:stages|layers)\.(\d+)\.")

    prefixes = {d: [] for d in range(top + 1)}
    for key, d in order.items():
        if kind in ("stages", "layers"):
            body = f"{kind}.{key[0]}.blocks.{key[1]}."
        elif kind == "blocks":
            body = f"blocks.{key[0]}."
        else:
            body = f"encoder.layer.{key[0]}."
        # Both spellings: parameter/initializer names are dotted, while the legacy
        # ONNX exporter emits module paths with slashes.
        prefixes[d] = [body, body.replace(".", "/")]

    def depth_of(name):
        mt = pat.search(name)
        if mt:
            return order.get(tuple(int(g) for g in mt.groups()), top)
        sm = _stage_only.search(name)
        if sm:
            return stage_first.get(int(sm.group(1)), top)
        if any(h in name for h in _STEM_HINTS):
            return 0
        return top          # final norm / pooler / head / anything unmatched

    return depth_of, n_blocks, prefixes, kind

DEPTH_OF, N_LAYERS, DEPTH_PREFIXES, DEPTH_KIND = build_depth_map(model)
print(f"[llrd] depth map: {DEPTH_KIND} tree, {N_LAYERS} block(s) "
      f"+ stem + head")
if N_LAYERS <= 1:
    # Not fatal — a one-bucket ladder is just uniform BACKBONE_LR — but it means
    # the pattern table above does not know this architecture, and saying nothing
    # would hide that behind a run that trains slightly worse for no visible reason.
    print("[llrd] !! no block structure recognised in named_parameters(); the "
          "whole backbone will train at one rate. Add this model's block pattern "
          "to _DEPTH_PATTERNS.")

# The head is identified by object identity, not by a name prefix: MaxViT's is
# head.fc, a transformers ViT's is classifier, and a timm ViT's is head. Asking the
# model for its own classifier and comparing parameter ids is exact, and it cannot
# drift when the next architecture arrives.
_HEAD_IDS = {id(p) for p in classifier_of(model).parameters()}

# LayerNorm weights and every bias are excluded from weight decay. Decaying a
# LayerNorm gain toward zero is decaying the layer's output scale toward zero,
# which is not regularisation — it is damage, and it is the most common silent
# bug in hand-rolled ViT optimizers. MaxViT adds one more: relative_position_bias
# tables are 2-D, so ndim<=1 does not catch them, and decaying a position bias
# toward zero erases the spatial prior that block attention is built on.
def no_decay(name, param):
    low = name.lower()
    return (param.ndim <= 1 or name.endswith(".bias")
            or "layernorm" in low or ".norm" in low or low.startswith("norm")
            or "rel_pos" in low or "relative_position" in low)

# ------------------------------------------------------------------------------
# The decay factor has to be renormalised for depth, or the pivot silently becomes
# head-only fine-tuning.
# ------------------------------------------------------------------------------
# LLRD_DECAY=0.80 expresses the desired total span over a 12-block reference:
# BACKBONE_LR * 0.80**13 = 1.37e-06 at the stem with the configured 2.5e-5
# top-block rate. Applying 0.80 directly at every one of MaxViT's 24 blocks would
# make the span architecture-dependent, so the effective per-level factor below
# is normalized by depth. The broader 0.80 span lets low-level color, edge and
# texture filters adapt to botanical detail without exposing them to the top LR.
#
# So the tuned quantity is treated as the ladder's TOTAL SPAN (0.80**13 ≈ 1/18
# from top block to stem) rather than its step size, and the step is whatever
# spreads that span over the blocks this architecture actually has.
_REF_BLOCKS = 12
LLRD_DECAY_EFF = LLRD_DECAY ** ((_REF_BLOCKS + 1) / max(1, N_LAYERS + 1))

groups, group_names = {}, {}
for name, param in model.named_parameters():
    if not param.requires_grad:
        continue
    is_head = id(param) in _HEAD_IDS
    depth = N_LAYERS + 1 if is_head else DEPTH_OF(name)
    wd = 0.0 if no_decay(name, param) else WEIGHT_DECAY
    if is_head:
        lr = LEARNING_RATE
        key = ("head", wd)
    else:
        lr = BACKBONE_LR * (LLRD_DECAY_EFF ** (N_LAYERS + 1 - depth))
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

_lrs = sorted({round(g["lr"], 12) for g in param_groups})
print(f"[llrd] {len(param_groups)} param groups over {N_LAYERS} blocks, "
      f"decay={LLRD_DECAY} requested -> {LLRD_DECAY_EFF:.4f} per level "
      f"(same total span over {N_LAYERS} blocks as {LLRD_DECAY} over {_REF_BLOCKS})")
print(f"[llrd] lr range: {min(_lrs):.2e} (stem) .. {BACKBONE_LR:.2e} "
      f"(top block) .. {LEARNING_RATE:.2e} (head)")
_head_n = sum(p.numel() for k, g in groups.items() if k[0] == "head"
              for p in g["params"])
print(f"[llrd] head params: {_head_n:,} "
      f"({100*_head_n/max(1,sum(p.numel() for p in model.parameters())):.1f}% "
      f"of the model)")

# ------------------------------------------------------------------------------
# 8c. Warmup + cosine schedule over the cumulative resumed training target.
# ------------------------------------------------------------------------------
# The cosine is expressed over the cumulative target and offset by the epochs in
# manifest.json. A resumed Kaggle session therefore continues the same decay
# instead of restarting warmup and jumping back to the peak learning rate.
steps_per_epoch = max(1, len(train_loader) // max(1, GRAD_ACCUM_STEPS))
trained_before_run = max(0, int(manifest.get("trained_epochs", 0)))
schedule_epochs_done = min(EPOCHS_PER_RUN, trained_before_run)
planned_epochs = max(0, EPOCHS_PER_RUN - trained_before_run)
TOTAL_STEPS = steps_per_epoch * max(1, EPOCHS_PER_RUN)
SCHEDULE_START_STEP = steps_per_epoch * schedule_epochs_done
WARMUP_STEPS = max(50, int(TOTAL_STEPS * WARMUP_FRACTION))

def lr_scale(step):
    schedule_step = min(TOTAL_STEPS, SCHEDULE_START_STEP + step)
    if schedule_step < WARMUP_STEPS:
        return (schedule_step + 1) / WARMUP_STEPS
    prog = ((schedule_step - WARMUP_STEPS) /
            max(1, TOTAL_STEPS - WARMUP_STEPS))
    prog = min(1.0, max(0.0, prog))
    # Floor at 2% rather than 0: a cosine that reaches exactly zero spends its
    # last steps doing nothing while the clock still runs.
    return 0.02 + 0.98 * 0.5 * (1.0 + math.cos(math.pi * prog))

scheduler = torch.optim.lr_scheduler.LambdaLR(optimizer, lr_scale)
print(f"[sched] target={EPOCHS_PER_RUN} cumulative epochs, "
      f"completed={trained_before_run}, remaining={planned_epochs}; "
      f"{steps_per_epoch:,} steps/epoch, warmup={WARMUP_STEPS:,} steps")

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
            logits = forward_logits(model, x)
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

def accuracy_selection_key(metrics):
    """Top-1 first, Top-3 second, macro F1 only as the final tie-breaker."""
    return (
        float(metrics.get("top1") or -1.0),
        float(metrics.get("top3") or -1.0),
        float(metrics.get("macro_f1") or -1.0),
    )


_history = manifest.get("history") or []
if _history:
    _prior_best = max(_history, key=accuracy_selection_key)
    _prior_score = accuracy_selection_key(_prior_best)
    best = {
        "top1": float(_prior_best.get("top1") or 0.0),
        "top3": float(_prior_best.get("top3") or 0.0),
        "macro_f1": float(_prior_best.get("macro_f1") or 0.0),
        "epoch": int(_prior_best.get("epoch") or trained_before_run),
        "score": _prior_score,
    }
    # The Hub checkpoint loaded above is the previous run's shipped best model.
    # Materialize it locally before training so a non-improving continuation can
    # never overwrite the best-known weights with a weaker epoch.
    save_best_model(best)
    print(f"[best] seeded resumed checkpoint: epoch={best['epoch']} "
          f"top1={best['top1']*100:.2f}% macroF1={best['macro_f1']:.4f}")
else:
    best = {"top1": -1.0, "top3": 0.0, "macro_f1": 0.0, "epoch": 0}
epochs_done_this_run = 0
bomb_fired = False
stop_reason = "completed all planned epochs"
global_step = 0
train_seconds = 0.0

def _oom_backoff():
    """
    Release Python and CUDA allocator state after a CUDA OOM.

    Rebuilding the DataLoader mid-epoch would restart the epoch and throw away
    hours, so the batch SIZE is left alone and the step is simply skipped after
    releasing the failed batch and clearing cached allocations.
    """
    gc.collect()
    if torch.cuda.is_available():
        torch.cuda.empty_cache()

for epoch in range(1, planned_epochs + 1):
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
        logits = loss = None
        try:
            x = x.to(DEVICE, non_blocking=True)
            y = y.to(DEVICE, non_blocking=True)
            with amp_autocast():
                logits = forward_logits(model, x)
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
            del x, y, logits, loss
            _oom_backoff()
            continue

        running += float(loss.detach()) * GRAD_ACCUM_STEPS * y.size(0)
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

    # Accuracy is the deployment target: Top-1 is primary, Top-3 breaks a tie,
    # and macro F1 prevents a final tie from favoring a less balanced checkpoint.
    score = accuracy_selection_key(metrics)
    best_score = best.get("score", (-1.0, -1.0, -1.0))
    if score > best_score:
        best = dict(metrics)
        best["epoch"] = manifest["trained_epochs"]
        best["score"] = score
        save_best_model(best)
    else:
        print(f"[best] e{epoch} did not improve accuracy "
              f"(top1={metrics['top1']:.4f}, top3={metrics['top3']:.4f})")

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
_pip("--no-deps", "onnx", "onnxruntime", "onnxscript")

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
    The backbone wrapped so the ONNX graph has a single tensor output.

    A transformers model traces to ImageClassifierOutput, and every consumer then
    has to know that logits live at output[0]. The inference server reads output 0
    by name, so the name is pinned here at export time. A timm model already
    returns a bare tensor; forward_logits handles both, so the wrapper stays
    identical across the pivot and the exported graph keeps the same signature the
    server has always consumed.
    """
    def __init__(self, m):
        super().__init__()
        self.m = m
    def forward(self, pixel_values):
        return forward_logits(self.m, pixel_values)

# ------------------------------------------------------------------------------
# 10a. The evaluation subset: stratified, bounded, and the SAME for every rung.
# ------------------------------------------------------------------------------
# The full validation split at 5,000 species is ~200,000 images. Through
# onnxruntime on 4 CPU cores that is roughly seven hours — for one rung of the
# ladder. QUANT_EVAL_MAX caps it, and the cap is spent on breadth: one image per
# class first, then a second, and so on. With a 400-sample cap this intentionally
# trades statistical precision for a bounded CPU finalization time while still
# spreading the comparison across 400 distinct classes when available.
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
    """
    Export the FP32 ONNX graph, legacy exporter first.

    torch 2.10 defaults `torch.onnx.export` to the dynamo path, which needs
    onnxscript — that missing module is exactly what aborted run #2's export after
    six hours of training. onnxscript is installed above now, but the LEGACY
    (TorchScript) exporter is still tried first, for two reasons that matter more
    than being current:

      * the inference server already consumes a legacy-exported graph, and
      * quantize_dynamic's node selection below reads initializer names, which the
        legacy exporter keeps as clean parameter paths.

    dynamo is the fallback, at opset 18 because that is its floor for several of
    the ops MaxViT's grid attention lowers to.
    """
    m = LogitsOnly(model).eval().to("cpu")
    dummy = torch.randn(1, 3, IMAGE_SIZE, IMAGE_SIZE)
    common = dict(
        input_names=["pixel_values"], output_names=["logits"],
        # Batch stays dynamic so the same file serves a single request and a
        # batched eval loop. Height/width are FIXED: maxvit_base_tf_384 declares
        # fixed_input_size, its grid attention is partitioned for a 384 feature
        # map, and dynamic spatial dims would defeat onnxruntime's shape inference
        # for a flexibility this model does not have.
        dynamic_axes={"pixel_values": {0: "batch"}, "logits": {0: "batch"}},
        do_constant_folding=True,
    )
    attempts = [
        ("legacy", dict(common, opset_version=ONNX_OPSET, dynamo=False)),
        ("dynamo", dict(common, opset_version=max(ONNX_OPSET, 18), dynamo=True)),
        ("default", dict(common, opset_version=ONNX_OPSET)),
    ]
    last = None
    for tag, kw in attempts:
        try:
            torch.onnx.export(m, (dummy,), FP32_PATH, **kw)
            print(f"[onnx] exported with the {tag} exporter "
                  f"(opset {kw['opset_version']})")
            model.to(DEVICE)
            return os.path.getsize(FP32_PATH) / 1e6
        except TypeError as e:
            # This torch does not know the `dynamo` kwarg at all -> skip to the
            # call that does not pass it.
            last = e
            continue
        except Exception as e:
            last = e
            print(f"[onnx] {tag} exporter failed: {type(e).__name__}: {e}")
    model.to(DEVICE)
    raise RuntimeError(f"every ONNX exporter path failed; last: {last}")

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
# Dynamic INT8 is not uniformly safe on either architecture. What hurts, in order:
#
#   the classifier head    thousands of rows of near-collinear class vectors; 256
#                          INT8 levels cannot separate species whose logits differ
#                          by less than the quantization step. This is almost
#                          always where the loss comes from at high class counts.
#   attention Q/K/V        the scaled dot product amplifies weight error, then
#                          softmax turns amplified error into a different
#                          attention MAP, not just a noisier one. On MaxViT this
#                          is attn.qkv/attn.proj inside attn_block and attn_grid.
#   the outer blocks       the first block sees the rawest activations (widest
#                          range) and the last one feeds the head directly.
#   the middle-block MLPs  the safest ~60% of the parameters, and where most of
#                          the file size lives. Quantizing only these is the
#                          endpoint of the ladder.
#
# Each rung EXCLUDES more from quantization, so the file grows and the accuracy
# recovers. The loop stops at the first rung under QUANT_MAX_ACC_LOSS, keeping the
# smallest artefact that meets the bar rather than the safest one.
def matmul_nodes(path):
    """(node_name, searchable_tag) for every quantizable MatMul/Gemm.

    onnxruntime excludes nodes by NAME, so the first field is what ends up in
    `nodes_to_exclude`. But the name alone is not a reliable place to look for
    "which block is this": the legacy exporter names nodes after the module tree
    (`/stages.1/blocks.0/attn_block/attn/qkv/MatMul`) while the dynamo exporter
    emits `node_MatMul_87` and keeps the module path only on the weight
    INITIALIZER (`stages.1.blocks.0.attn_block.attn.qkv.weight`). export_fp32()
    tries three exporters, so the ladder cannot assume which one won -- the tag
    is the node name plus its constant-weight initializer names, and selection
    matches against that union. Whichever exporter ran, one of the two halves
    carries the path.
    """
    g = onnx.load(path, load_external_data=False).graph
    inits = {i.name for i in g.initializer}
    out = []
    for n in g.node:
        if n.op_type not in ("MatMul", "Gemm") or not n.name:
            continue
        # MatMulConstBOnly means only weight-bearing MatMuls are quantized at
        # all, so every node we care about has at least one initializer input.
        out.append((n.name, "\x00".join([n.name] + [i for i in n.input
                                                    if i in inits])))
    return out

def _variants(*needles):
    """Each dotted needle, plus its slashed spelling (legacy node names)."""
    out = []
    for s in needles:
        out.append(s)
        if "." in s:
            out.append(s.replace(".", "/"))
    return tuple(dict.fromkeys(out))

def _prefix_variants(body):
    """The three spellings a module prefix can take across the two exporters.

    `stages.1.blocks.0.` -> parameter paths keep it dotted, the fully-slashed
    form appears in some graphs, and the legacy exporter writes
    `stages.1/blocks.0/` -- an index stays glued to its parent with a dot while
    the levels above it are separated by slashes.
    """
    toks = [t for t in body.strip("./").replace("/", ".").split(".") if t]
    mixed = ""
    for t in toks:
        if mixed and t.isdigit():
            mixed = mixed[:-1] + "." + t + "/"
        else:
            mixed += t + "/"
    return tuple(dict.fromkeys([body, "/".join(toks) + "/", mixed]))

# Leaf needles, both families. transformers-ViT spells its projections
# `attention.attention.query`; timm spells a MaxViT attention block
# `attn_block.attn.qkv` / `attn_grid.attn.proj`, and its MLPs `mlp.fc1`/`fc2`.
# "attn." does not match "attn_block." (no dot after the underscore), so the
# attention needles stay clear of the MLP that sits inside the same block.
_HEAD_NEEDLES = _variants("classifier", "head.fc", "head.pre_logits")
_ATTN_NEEDLES = _variants(
    "attention.attention.query", "attention.attention.key",
    "attention.attention.value", "attention.output.dense",
    "attn.qkv", "attn.proj", "attn.q_proj", "attn.k_proj", "attn.v_proj",
    "attn.q.", "attn.kv.",
)
_MLP_NEEDLES = _variants("intermediate.dense", "output.dense",
                         "mlp.fc1", "mlp.fc2")

def _sel(nodes, *needles):
    return [nm for nm, tag in nodes if any(s in tag for s in needles)]

def _sel_in(nodes, prefixes, needles=None):
    """Nodes under any of `prefixes`, optionally narrowed to `needles`."""
    return [nm for nm, tag in nodes
            if any(p in tag for p in prefixes)
            and (needles is None or any(s in tag for s in needles))]

def _block_prefixes(depths):
    out = []
    for d in depths:
        for body in (DEPTH_PREFIXES.get(d) or ()):
            out += list(_prefix_variants(body))
    return tuple(dict.fromkeys(out))

def build_rungs(nodes):
    head = _sel(nodes, *_HEAD_NEEDLES)
    attn = _sel(nodes, *_ATTN_NEEDLES)

    # Depth 1 is the first block and N_LAYERS the last (0 is the stem); the
    # prefixes come from the same map the optimizer built its LLRD ladder from,
    # so "outer block" can never mean two different things in one run.
    outer_d = [d for d in (1, 2, N_LAYERS - 1, N_LAYERS) if 1 <= d <= N_LAYERS]
    outer = _sel_in(nodes, _block_prefixes(sorted(set(outer_d))))

    mid_d = [d for d in range(3, N_LAYERS - 1) if 1 <= d <= N_LAYERS]
    mid_mlp = _sel_in(nodes, _block_prefixes(mid_d), _MLP_NEEDLES)
    all_but_mid_mlp = [nm for nm, _ in nodes if nm not in set(mid_mlp)]

    if not head:
        print("[quant] !! no classifier node matched; the head rung is a no-op. "
              "Add this model's head name to _HEAD_NEEDLES.")
    if not attn:
        print("[quant] !! no attention projection matched; the attention rung is "
              "a no-op. Add this model's names to _ATTN_NEEDLES.")
    print(f"[quant] selection: head={len(head)} attn={len(attn)} "
          f"outer={len(outer)} mid_mlp={len(mid_mlp)} of {len(nodes)} nodes")

    cand = [
        ("INT8 (all MatMul)",                     []),
        ("INT8, head in FP32",                    head),
        ("INT8, head + attention in FP32",        head + attn),
        ("INT8, head + attention + outer blocks", head + attn + outer),
        ("INT8, middle-block MLPs only",          all_but_mid_mlp),
    ]

    # A rung whose exclusion set repeats an earlier one costs a quantize plus a
    # full eval to re-measure a number we already have, and the last rung
    # degenerates into "quantize nothing" if no middle MLP matched -- which
    # would pass the accuracy gate trivially while shipping an FP32 file under
    # an INT8 name. Drop both cases here rather than in the timing loop.
    rungs, seen = [], set()
    for label, excl in cand:
        if label.endswith("MLPs only") and not mid_mlp:
            print("[quant] skipping the middle-MLP rung: nothing matched, so it "
                  "would exclude every node and quantize nothing")
            continue
        key = frozenset(excl)
        if key in seen:
            continue
        seen.add(key)
        rungs.append((label, list(dict.fromkeys(excl))))
    return rungs

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

        q_nodes = matmul_nodes(FP32_PATH)
        rungs = build_rungs(q_nodes)
        print(f"[quant] {len(q_nodes):,} quantizable MatMul/Gemm nodes; "
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
print(f"  FINDFLOWER {(TIMM_ARCH or 'ViT').upper()} — RUN #{manifest['runs']} "
      f"SUMMARY".ljust(W))
rule()
row("architecture", f"{BASE_MODEL} @ {IMAGE_SIZE}px")
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
