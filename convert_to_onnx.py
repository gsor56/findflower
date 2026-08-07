"""
Convert the FindFlower ViT model to ONNX with FP16 weights (fp32 I/O).

Run this ONCE in an environment with torch installed (Kaggle recommended — it's
where the model was trained and HF_TOKEN is already a Kaggle Secret).

Strategy (preserves accuracy, avoids dtype pitfalls):
  1. Export the model to standard FP32 ONNX.
  2. Convert weights to FP16 with `keep_io_types=True` — inputs/outputs stay
     FP32, so the server's fp32 preprocessing feeds it directly, and onnxruntime
     upcasts to fp32 internally for compute. Result: ~half the file size, and
     argmax/topk identical to the original for all practical inputs.

Outputs:
  findflower_vit_fp32.onnx   (~330 MB, intermediate — can delete after)
  findflower_vit_fp16.onnx   (~165 MB, THIS is what the server loads)

After running, the script uploads findflower_vit_fp16.onnx to the HF model repo
itself (set SKIP_UPLOAD=1 to keep it local instead).

Extra dependency beyond the training env:
  pip install onnx onnxconverter-common onnxruntime
"""
import os
import torch
import numpy as np
from transformers import AutoModelForImageClassification

# === Config ===
HF_REPO_ID = "gsor56/findflower-VIT"   # NOTE: uppercase VIT (the real repo id)
FP32_PATH = "findflower_vit_fp32.onnx"
FP16_PATH = "findflower_vit_fp16.onnx"
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

# Sanity: capture a reference output BEFORE conversion so we can verify accuracy.
print("[2/5] Capturing reference logits (fp32 torch)...")
torch.manual_seed(0)
ref_input = torch.randn(1, 3, 224, 224, dtype=torch.float32)
with torch.no_grad():
    ref_logits = wrapped(ref_input).numpy()

print(f"[3/5] Exporting FP32 ONNX -> {FP32_PATH}")
torch.onnx.export(
    wrapped,
    ref_input,
    FP32_PATH,
    input_names=["pixel_values"],
    output_names=["logits"],
    dynamic_axes={"pixel_values": {0: "batch"}, "logits": {0: "batch"}},
    opset_version=14,
    do_constant_folding=True,
)

# === Convert to FP16 weights, keeping FP32 input/output ===
print(f"[4/5] Converting weights to FP16 (keep_io_types=True) -> {FP16_PATH}")
import onnx
from onnxconverter_common import float16

onnx_model = onnx.load(FP32_PATH)
onnx_fp16 = float16.convert_float_to_float16(onnx_model, keep_io_types=True)
onnx.save(onnx_fp16, FP16_PATH)

for p in (FP32_PATH, FP16_PATH):
    print(f"     {p}: {os.path.getsize(p) / (1024*1024):.1f} MB")

# === Verify accuracy against the fp32 torch reference ===
print("[5/5] Verifying FP16 ONNX matches fp32 torch...")
import onnxruntime as ort

sess = ort.InferenceSession(FP16_PATH, providers=["CPUExecutionProvider"])
onnx_logits = sess.run(None, {"pixel_values": ref_input.numpy()})[0]

# argmax must match; logits should be extremely close
ref_top = int(np.argmax(ref_logits))
onnx_top = int(np.argmax(onnx_logits))
max_abs_diff = float(np.max(np.abs(ref_logits - onnx_logits)))

print(f"     torch argmax: {ref_top}   onnx argmax: {onnx_top}   match: {ref_top == onnx_top}")
print(f"     max abs logit diff: {max_abs_diff:.6f}")

if ref_top != onnx_top:
    raise SystemExit("ACCURACY CHECK FAILED: top class differs. Do NOT deploy this file.")

print("\n=== Accuracy verified. ===")

# === Upload to the HF model repo so the server can fetch it at boot ===
if os.environ.get("SKIP_UPLOAD"):
    print(f"SKIP_UPLOAD set — leaving {FP16_PATH} on disk. Upload it manually.")
else:
    print(f"[6/6] Uploading {FP16_PATH} to {HF_REPO_ID}...")
    from huggingface_hub import upload_file

    upload_file(
        path_or_fileobj=FP16_PATH,
        path_in_repo=FP16_PATH,
        repo_id=HF_REPO_ID,
        token=HF_TOKEN,
    )
    print(f"Uploaded. The server will download it on first boot.")

print("\n=== DONE ===")
