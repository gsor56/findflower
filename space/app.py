"""
FindFlower ViT inference server (runs inside a private HF Space).

Loads the fine-tuned ViT (gsor56/findflower-ViT) + its processor once at
startup, then serves predictions. The model repo stays PRIVATE and the
weights never leave this container -- only labels + scores are returned.

Access is gated by PROXY_SECRET: every request must carry
`X-Proxy-Secret: <value>`. Only the Cloudflare Worker knows it, so the
Space can't be used as a free open inference API.

Env (set as Space *secrets*, never in code):
    HF_TOKEN      - read token, to pull the private model
    PROXY_SECRET  - shared secret the Worker must send
"""

import io
import os

import torch
import torch.nn.functional as F
from fastapi import FastAPI, File, Header, HTTPException, UploadFile
from PIL import Image
from transformers import AutoImageProcessor, AutoModelForImageClassification

HF_REPO_ID = "gsor56/findflower-ViT"
HF_TOKEN = os.environ.get("HF_TOKEN")
PROXY_SECRET = os.environ.get("PROXY_SECRET")
TOP_K = 5
DEVICE = "cuda" if torch.cuda.is_available() else "cpu"

if not HF_TOKEN:
    raise SystemExit("HF_TOKEN not set (add it as a Space secret).")
if not PROXY_SECRET:
    raise SystemExit("PROXY_SECRET not set (add it as a Space secret).")

print(f"[serve] loading {HF_REPO_ID} on {DEVICE} ...")
processor = AutoImageProcessor.from_pretrained(HF_REPO_ID, token=HF_TOKEN)
model = AutoModelForImageClassification.from_pretrained(HF_REPO_ID, token=HF_TOKEN)
model.to(DEVICE).eval()
ID2LABEL = {int(k): v for k, v in model.config.id2label.items()}
print(f"[serve] ready: {len(ID2LABEL)} classes on {DEVICE}")

app = FastAPI(title="FindFlower ViT")


@app.get("/health")
def health():
    # No secret required -- lets the Worker/uptime checks confirm liveness
    # without revealing anything sensitive.
    return {"status": "ok", "classes": len(ID2LABEL), "device": DEVICE}


@torch.inference_mode()
def classify(img: Image.Image):
    inputs = processor(images=img, return_tensors="pt").to(DEVICE)
    logits = model(**inputs).logits[0]
    probs = F.softmax(logits, dim=-1)
    k = min(TOP_K, probs.numel())
    top_probs, top_idx = probs.topk(k)
    return [
        {"name": ID2LABEL[int(i)], "confidence": round(float(p), 4)}
        for p, i in zip(top_probs.tolist(), top_idx.tolist())
    ]


@app.post("/predict")
async def predict(
    file: UploadFile = File(...),
    x_proxy_secret: str | None = Header(default=None),
):
    # Gate: reject anything that isn't the Worker.
    if not x_proxy_secret or x_proxy_secret != PROXY_SECRET:
        raise HTTPException(status_code=401, detail="Unauthorized.")

    raw = await file.read()
    try:
        img = Image.open(io.BytesIO(raw)).convert("RGB")
    except Exception:
        raise HTTPException(status_code=400, detail="Could not read that image file.")

    ranked = classify(img)
    top = ranked[0]
    return {"flower": top["name"], "confidence": top["confidence"], "top_k": ranked}
