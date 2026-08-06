# FindFlower ViT inference server

FastAPI + onnxruntime server for the FindFlower ViT (116 flower species).

## Why ONNX

PyTorch alone costs ~800MB of RAM at import, which does not fit Render's free
512MB instance. This server runs the same model through `onnxruntime` with FP16
weights and FP32 I/O, landing around 250-300MB. Top-1 and top-5 predictions are
identical to the original fp32 PyTorch model — the conversion script verifies
this before writing the file.

## Files

| File | Purpose |
| --- | --- |
| `app.py` | FastAPI server (`/health`, `/predict`) |
| `class_names.json` | 116 labels, index-aligned to model logits |
| `Dockerfile` | Container build |
| `requirements.txt` | onnxruntime, fastapi, pillow, huggingface_hub |

The 165MB `findflower_vit_fp16.onnx` is **not** in git (over GitHub's file
limit). It lives in the private `gsor56/findflower-VIT` HF model repo and is
downloaded on first boot via `HF_TOKEN`.

## Environment variables

| Var | Required | Purpose |
| --- | --- | --- |
| `PROXY_SECRET` | yes | Shared secret; `/predict` rejects requests without a matching `X-Proxy-Secret` header |
| `HF_TOKEN` | yes | Read token to download the ONNX weights from the private model repo |
| `ONNX_PATH` | no | Override the local model path (skips the download) |

## Endpoints

`GET /health` — no auth. Returns `{status, model, classes, device, runtime}`.

`POST /predict` — requires `X-Proxy-Secret`. Multipart body with a `file` field.
Returns:

```json
{
  "flower": "common dandelion",
  "confidence": 0.94,
  "top_k": [{ "name": "common dandelion", "confidence": 0.94 }]
}
```

Only labels and scores are returned, so the weights never leave the container.
Only the FindFlower Cloudflare Worker holds `PROXY_SECRET`, so this is not an
open public API.

## Regenerating the ONNX model

Run `convert_to_onnx_fp16.py` (repo root) in an environment with torch — Kaggle
is easiest, since `HF_TOKEN` is already a Secret there. It exports to FP32 ONNX,
converts weights to FP16, verifies top-1 against the PyTorch reference, then you
upload `findflower_vit_fp16.onnx` to the HF model repo.
