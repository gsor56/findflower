"""
FindFlower ViT inference backend.

Replaces the old in-browser TensorFlow.js CNN. Loads the fine-tuned ViT
(gsor56/findflower-ViT) + its processor from the Hugging Face Hub once at
startup, then serves predictions over HTTP.

Run:
    set HF_TOKEN=hf_...          (Windows CMD)   -- your HF *read* token
    $env:HF_TOKEN="hf_..."       (PowerShell)
    pip install -r requirements-serve.txt
    uvicorn serve_vit:app --host 0.0.0.0 --port 8000

Predict:
    POST /predict  (multipart form, field name "file") -> JSON
"""

import io
import os

import torch
import torch.nn.functional as F
from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from PIL import Image
from transformers import AutoImageProcessor, AutoModelForImageClassification

# ---- Config -----------------------------------------------------------------
HF_REPO_ID = "gsor56/findflower-ViT"          # private repo -> needs a token
HF_TOKEN = os.environ.get("HF_TOKEN")          # read-only token, from env (never hardcode)
TOP_K = 5                                       # how many ranked guesses to return
DEVICE = "cuda" if torch.cuda.is_available() else "cpu"

if not HF_TOKEN:
    raise SystemExit(
        "HF_TOKEN is not set. Create a *read* token at "
        "https://huggingface.co/settings/tokens and export it as HF_TOKEN."
    )

# ---- Load once at startup ----------------------------------------------------
print(f"[serve] loading {HF_REPO_ID} on {DEVICE} ...")
processor = AutoImageProcessor.from_pretrained(HF_REPO_ID, token=HF_TOKEN)
model = AutoModelForImageClassification.from_pretrained(HF_REPO_ID, token=HF_TOKEN)
model.to(DEVICE).eval()

# Labels come straight from the model config (baked in during training),
# so the index->name mapping always matches the classifier head.
ID2LABEL = {int(k): v for k, v in model.config.id2label.items()}
print(f"[serve] ready: {len(ID2LABEL)} classes on {DEVICE}")

# ---- App --------------------------------------------------------------------
app = FastAPI(title="FindFlower ViT")

# Allow the static frontend (any origin) to call this backend. In production,
# lock allow_origins down to your real site's URL.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["POST", "GET"],
    allow_headers=["*"],
)


@app.get("/health")
def health():
    return {"status": "ok", "classes": len(ID2LABEL), "device": DEVICE}


@torch.inference_mode()
def classify(img: Image.Image):
    # The processor handles resize->224x224 + ViT normalization exactly as in training.
    inputs = processor(images=img, return_tensors="pt").to(DEVICE)
    logits = model(**inputs).logits[0]                 # shape: [num_classes]
    probs = F.softmax(logits, dim=-1)
    k = min(TOP_K, probs.numel())
    top_probs, top_idx = probs.topk(k)
    return [
        {"name": ID2LABEL[int(i)], "confidence": round(float(p), 4)}
        for p, i in zip(top_probs.tolist(), top_idx.tolist())
    ]


@app.post("/predict")
async def predict(file: UploadFile = File(...)):
    raw = await file.read()
    try:
        img = Image.open(io.BytesIO(raw)).convert("RGB")
    except Exception:
        raise HTTPException(status_code=400, detail="Could not read that image file.")

    ranked = classify(img)
    top = ranked[0]
    return {
        "flower": top["name"],           # predicted flower name
        "confidence": top["confidence"], # 0..1
        "top_k": ranked,                 # full ranked list for the UI
    }
