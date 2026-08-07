"""
Convert the FindFlower ViT model to ONNX for the inference server.

Run this ONCE in an environment with torch installed (Kaggle recommended — it's
where the model was trained and HF_TOKEN is already a Kaggle Secret).

Output: findflower_vit_fp32.onnx (~330 MB), uploaded to the HF model repo, which
is what space/app.py downloads at boot.

Why FP32 and not FP16
---------------------
An earlier version of this script converted the weights to FP16 with
`keep_io_types=True`, halving the file to 165 MB. That was a mistake for CPU
serving, and it cost a deploy: onnxruntime's CPU execution provider has no native
FP16 MatMul kernel, so it inserts Cast nodes and materializes a full FP32 copy of
every weight at inference time — while still holding the FP16 original. Measured
on this exact model:

    fp16 graph:  165 MB file → 228 MB resident, 511 MB PEAK
    fp32 graph:  329 MB file → 389 MB resident, 409 MB PEAK

So FP16 is smaller on disk but ~100 MB *worse* at peak RAM, and 511 MB does not
fit Render's 512 MB free tier — /health stayed up while /predict was SIGKILLed
(exit 137) on the first request. FP32 is both simpler and cheaper here. FP16
would only pay off on a GPU/CUDA EP, which the free tier does not have.

Dependency beyond the training env:
  pip install onnx onnxruntime
"""
import os

import numpy as np
import torch
from transformers import AutoModelForImageClassification

# === Config ===
HF_REPO_ID = "gsor56/findflower-VIT"   # NOTE: uppercase VIT (the real repo id)
ONNX_PATH = "findflower_vit_fp32.onnx"
HF_TOKEN = os.environ.get("HF_TOKEN")

if not HF_TOKEN:
    raise SystemExit("HF_TOKEN not set. Add it as a Kaggle Secret or environment variable.")


class LogitsOnly(torch.nn.Module):
    """Wrap the HF model so ONNX export returns a plain logits tensor,
    not the ImageClassifierOutput dataclass."""

    def __init__(self, model):
        super().__init__()
        self.model = model

    def forward(self, pixel_values):
        return self.model(pixel_values=pixel_values).logits


print(f"[1/5] Loading {HF_REPO_ID} (fp32)...")
model = AutoModelForImageClassification.from_pretrained(HF_REPO_ID, token=HF_TOKEN)
model.eval()
wrapped = LogitsOnly(model).eval()

# Sanity: capture a reference output BEFORE export so we can verify accuracy.
print("[2/5] Capturing reference logits (fp32 torch)...")
torch.manual_seed(0)
ref_input = torch.randn(1, 3, 224, 224, dtype=torch.float32)
with torch.no_grad():
    ref_logits = wrapped(ref_input).numpy()

print(f"[3/5] Exporting FP32 ONNX -> {ONNX_PATH}")
torch.onnx.export(
    wrapped,
    ref_input,
    ONNX_PATH,
    input_names=["pixel_values"],
    output_names=["logits"],
    dynamic_axes={"pixel_values": {0: "batch"}, "logits": {0: "batch"}},
    opset_version=14,
    do_constant_folding=True,
)
print(f"     {ONNX_PATH}: {os.path.getsize(ONNX_PATH) / (1024 * 1024):.1f} MB")

# === Verify the exported graph against the torch reference ===
# A silent accuracy regression here would ship as confident wrong species names,
# so this is a hard gate: the script refuses to upload if top-1 moves.
print("[4/5] Verifying ONNX matches fp32 torch...")
import onnxruntime as ort  # noqa: E402  (imported late so export failures surface first)

# Same session options the server uses, so the numbers are comparable.
_so = ort.SessionOptions()
_so.enable_cpu_mem_arena = False
_so.enable_mem_pattern = False
_so.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_BASIC
_so.intra_op_num_threads = 1

sess = ort.InferenceSession(ONNX_PATH, sess_options=_so, providers=["CPUExecutionProvider"])
onnx_logits = sess.run(None, {"pixel_values": ref_input.numpy()})[0]

ref_top = int(np.argmax(ref_logits))
onnx_top = int(np.argmax(onnx_logits))
ref_top5 = np.argsort(ref_logits[0])[::-1][:5].tolist()
onnx_top5 = np.argsort(onnx_logits[0])[::-1][:5].tolist()
max_abs_diff = float(np.max(np.abs(ref_logits - onnx_logits)))

print(f"     torch argmax: {ref_top}   onnx argmax: {onnx_top}   match: {ref_top == onnx_top}")
print(f"     top-5 order match: {ref_top5 == onnx_top5}")
print(f"     max abs logit diff: {max_abs_diff:.6f}")

if ref_top != onnx_top:
    raise SystemExit("ACCURACY CHECK FAILED: top class differs. Do NOT deploy this file.")

print("\n=== Accuracy verified. ===")

# === Upload to the HF model repo so the server can fetch it at boot ===
if os.environ.get("SKIP_UPLOAD"):
    print(f"SKIP_UPLOAD set — leaving {ONNX_PATH} on disk. Upload it manually.")
else:
    print(f"[5/5] Uploading {ONNX_PATH} to {HF_REPO_ID}...")
    from huggingface_hub import upload_file

    upload_file(
        path_or_fileobj=ONNX_PATH,
        path_in_repo=ONNX_PATH,
        repo_id=HF_REPO_ID,
        token=HF_TOKEN,
    )
    print("Uploaded. The server will download it on first boot.")

print("\n=== DONE ===")
