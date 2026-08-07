"""
FindFlower ViT inference server — ONNX + onnxruntime edition.

Runs the ViT through onnxruntime instead of PyTorch. torch alone is ~800MB of
RAM before a single image is loaded, which is what blew the 512MB Render free
tier. onnxruntime with an FP32 graph peaks at ~410MB, measured — comfortably
inside the limit.

Why FP32 and not the smaller FP16 file: onnxruntime's CPU execution provider has
no native FP16 MatMul kernel, so it Casts every weight up to FP32 at inference
time and holds that copy alongside the FP16 original. Measured on this exact
model (_onnx_probe/measure_peak.py):

    findflower_vit_fp16.onnx  165MB file → 228MB resident, 511MB PEAK
    findflower_vit_fp32.onnx  329MB file → 389MB resident, 409MB PEAK

The FP16 file is half the size on disk but 100MB *worse* at peak, and 511MB is
over the ceiling once container overhead is added — that was the exit-137 OOM
that killed /predict while /health stayed up.

Accuracy is unaffected. The FP32 graph is a lossless fp16→fp32 rebuild of the
verified FP16 file (every FP16 value is exactly representable in FP32), and
top-1/top-5 were confirmed identical between the two
(_onnx_probe/verify_equivalence.py). The FP16 file in turn had its top-1 checked
against the fp32 PyTorch reference in convert_to_onnx_fp16.py.

The .onnx file is NOT in git (329MB > GitHub's limit). It lives in the private HF
model repo and is downloaded on first boot using HF_TOKEN.
"""
import os
import json
from io import BytesIO
from fastapi import FastAPI, UploadFile, File, Header, HTTPException
from PIL import Image
import numpy as np
import onnxruntime as ort

# === Config ===
HF_REPO_ID = "gsor56/findflower-VIT"  # NOTE: uppercase VIT (the real repo id)
ONNX_FILENAME = "findflower_vit_fp32.onnx"
ONNX_PATH = os.environ.get("ONNX_PATH", ONNX_FILENAME)
PROXY_SECRET = os.environ.get("PROXY_SECRET")
HF_TOKEN = os.environ.get("HF_TOKEN")
TOP_K = 5

# Preprocessing parameters from preprocessor_config.json
IMAGE_SIZE = 224
IMAGE_MEAN = np.array([0.5, 0.5, 0.5], dtype=np.float32)
IMAGE_STD = np.array([0.5, 0.5, 0.5], dtype=np.float32)
RESCALE_FACTOR = 1.0 / 255.0

# === Startup checks ===
if not PROXY_SECRET:
    raise SystemExit("PROXY_SECRET not set. Add it as an environment variable.")

if not os.path.exists("class_names.json"):
    raise SystemExit("class_names.json not found. It should be committed alongside app.py.")

# === Fetch the ONNX model (downloaded once from the private HF repo) ===
# The 329MB weights live in the HF model repo, not git (GitHub's 100MB cap).
# huggingface_hub is a light, requests-based client — no torch pulled in.
if not os.path.exists(ONNX_PATH):
    if not HF_TOKEN:
        raise SystemExit("HF_TOKEN not set — needed to download the ONNX weights from the private repo.")
    print(f"[serve] Downloading {ONNX_FILENAME} from {HF_REPO_ID}...")
    from huggingface_hub import hf_hub_download
    ONNX_PATH = hf_hub_download(
        repo_id=HF_REPO_ID,
        filename=ONNX_FILENAME,
        token=HF_TOKEN,
    )
    print(f"[serve] Downloaded to {ONNX_PATH}")

# === Load class names ===
with open("class_names.json", "r", encoding="utf-8") as f:
    CLASS_NAMES = json.load(f)
NUM_CLASSES = len(CLASS_NAMES)

print(f"[serve] Loaded {NUM_CLASSES} class names from class_names.json")

# === Load ONNX model ===
print(f"[serve] Loading ONNX model from {ONNX_PATH}...")


def _rss_mb() -> str:
    """Current RSS in MB, read straight from procfs so we need no psutil.

    Logged around model load and on the first inference: the free tier gives no
    warning before the OOM killer fires, so having the number in the deploy log
    is the difference between a diagnosis and a guess.
    """
    try:
        with open("/proc/self/status", "r") as fh:
            for line in fh:
                if line.startswith("VmRSS:"):
                    return f"{int(line.split()[1]) / 1024:.0f}MB"
    except OSError:
        pass
    return "unknown"


# Memory-minimizing session options — Render free tier is 512MB, so we trade a
# little speed for a lower peak. Disabling the CPU mem arena is the big lever:
# by default onnxruntime pre-allocates and holds a large arena; off, it frees
# aggressively. mem_pattern off avoids up-front activation pre-allocation.
# Measured with these exact settings: 389MB resident, 409MB peak. Re-enabling the
# arena pushes the peak past 512MB, so don't "optimize" these away.
_so = ort.SessionOptions()
_so.enable_cpu_mem_arena = False
_so.enable_mem_pattern = False
_so.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_BASIC
_so.intra_op_num_threads = 1  # free tier is ~1 vCPU anyway; avoids thread overhead

session = ort.InferenceSession(ONNX_PATH, sess_options=_so, providers=["CPUExecutionProvider"])
print(f"[serve] Model loaded. Provider: {session.get_providers()}  RSS: {_rss_mb()}")
# Discover the actual input name from the model (robust to export naming).
_input_name = session.get_inputs()[0].name

# Guard against a label/logit mismatch — silently misaligned labels would return
# confident but wrong species names, which is worse than failing to boot.
_out_shape = session.get_outputs()[0].shape
if isinstance(_out_shape[-1], int) and _out_shape[-1] != NUM_CLASSES:
    raise SystemExit(
        f"Label mismatch: model outputs {_out_shape[-1]} logits but "
        f"class_names.json has {NUM_CLASSES} entries."
    )

app = FastAPI(title="FindFlower ViT ONNX", version="0.9.5")

# Log RSS on the very first inference only. The first run is where the OOM hit
# before, and one log line is cheap; logging every request would be noise.
_first_run_logged = False


def preprocess_image(image: Image.Image) -> np.ndarray:
    """
    Preprocess image to match ViTImageProcessor output exactly.

    Steps (from preprocessor_config.json):
    1. Resize to 224x224 with bilinear (resample=2)
    2. Rescale pixel values: pixel * (1/255)
    3. Normalize: (pixel - mean) / std, where mean=std=0.5
    4. Convert to CHW format (channels first)
    """
    # 1. Resize
    image = image.convert("RGB")
    image = image.resize((IMAGE_SIZE, IMAGE_SIZE), Image.BILINEAR)

    # 2. Convert to numpy and rescale
    img_array = np.array(image, dtype=np.float32) * RESCALE_FACTOR  # [H, W, 3]

    # 3. Normalize
    img_array = (img_array - IMAGE_MEAN) / IMAGE_STD

    # 4. Convert to CHW and add batch dimension
    img_array = np.transpose(img_array, (2, 0, 1))  # [3, H, W]
    img_array = np.expand_dims(img_array, axis=0)   # [1, 3, H, W]

    return img_array


@app.get("/health")
async def health():
    """Health check endpoint (no auth required)."""
    return {
        "status": "ok",
        "model": HF_REPO_ID,
        "classes": NUM_CLASSES,
        "device": "cpu",
        "runtime": "onnxruntime",
    }


@app.post("/predict")
async def predict(
    file: UploadFile = File(...),
    x_proxy_secret: str = Header(None)
):
    """
    Predict flower species from an uploaded image.

    Requires X-Proxy-Secret header matching PROXY_SECRET env var.
    Returns: {flower: str, confidence: float, top_k: [{name, confidence}, ...]}
    """
    # Gate: only the Worker can call this (shared secret)
    if x_proxy_secret != PROXY_SECRET:
        raise HTTPException(status_code=401, detail="Unauthorized")

    # Load image
    try:
        image_bytes = await file.read()
        image = Image.open(BytesIO(image_bytes))
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Invalid image: {e}")

    # Preprocess
    try:
        pixel_values = preprocess_image(image)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Preprocessing failed: {e}")

    # Inference
    try:
        outputs = session.run(None, {_input_name: pixel_values})
        logits = outputs[0][0]  # shape: [num_classes]
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Inference failed: {e}")

    global _first_run_logged
    if not _first_run_logged:
        _first_run_logged = True
        print(f"[serve] First inference OK. RSS: {_rss_mb()} (limit 512MB)")

    # Softmax
    exp_logits = np.exp(logits - np.max(logits))
    probs = exp_logits / np.sum(exp_logits)

    # Top-K
    top_indices = np.argsort(probs)[::-1][:TOP_K]
    top_k = [
        {"name": CLASS_NAMES[int(i)], "confidence": float(probs[i])}
        for i in top_indices
    ]

    return {
        "flower": top_k[0]["name"],
        "confidence": top_k[0]["confidence"],
        "top_k": top_k,
    }
