# FindFlower ViT inference server

FastAPI + onnxruntime server for the FindFlower ViT (116 flower species).

## Why ONNX

PyTorch alone costs ~800MB of RAM at import, which does not fit Render's free
512MB instance. This server runs the same model through `onnxruntime`, which
peaks at ~410MB — measured, not estimated. Top-1 and top-5 predictions are
identical to the original fp32 PyTorch model; the conversion script verifies this
before uploading.

### Why FP32 weights and not FP16

FP16 halves the file (165MB vs 329MB) but makes peak RAM *worse* on CPU, because
onnxruntime's CPU execution provider has no native FP16 MatMul kernel — it Casts
every weight up to FP32 at inference time while still holding the FP16 original:

| Graph | File | Resident | Peak |
| --- | --- | --- | --- |
| fp16 | 165MB | 228MB | **511MB** |
| fp32 | 329MB | 389MB | **409MB** |

511MB does not fit in 512MB: the first FP16 `/predict` was SIGKILLed (exit 137)
while `/health` stayed up. FP16 would only pay off on a CUDA execution provider.

The `SessionOptions` in `app.py` (`enable_cpu_mem_arena=False`,
`enable_mem_pattern=False`, `ORT_ENABLE_BASIC`, one intra-op thread) are load
bearing — re-enabling the arena pushes the peak back over the limit.

## Files

| File | Purpose |
| --- | --- |
| `app.py` | FastAPI server (`/health`, `/predict`) |
| `class_names.json` | 116 labels, index-aligned to model logits |
| `Dockerfile` | Container build |
| `requirements.txt` | onnxruntime, fastapi, pillow, huggingface_hub |

The weights are **not** in git (over GitHub's 100MB file limit). They live in the
private `gsor56/findflower-VIT` HF model repo as an external-data pair and are
downloaded on first boot via `HF_TOKEN`:

| File | Size | What it is |
| --- | --- | --- |
| `findflower_vit_fp32_ext.onnx` | 1.4MB | Graph protobuf |
| `findflower_vit_fp32.onnxdata` | 327MB | Weights blob |

Both are required, and the `.onnxdata` must sit next to the `.onnx` —
onnxruntime resolves the sibling by relative path. A single-file 329MB `.onnx`
loads at roughly **2x its size** (~670MB peak) because the whole protobuf is
parsed before tensors are allocated; that OOMed at startup. External data drops
the load peak to ~395MB.

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

Run `training/convert_to_onnx.py` in an environment with torch — Kaggle is
easiest, since `HF_TOKEN` is already a Secret there. It exports FP32 ONNX,
verifies top-1 and top-5 against the PyTorch reference, converts to the
external-data layout, then uploads the `_ext.onnx` + `.onnxdata` pair.

Set `SKIP_UPLOAD=1` to leave the files on disk instead. Don't upload the
monolithic `findflower_vit_fp32.onnx` as the serving file — the server expects
the external-data pair, and the single file will OOM at load on 512MB.
