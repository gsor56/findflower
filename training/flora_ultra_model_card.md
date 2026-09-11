---
library_name: timm
pipeline_tag: image-classification
tags:
- botanical-identification
- eva02
- inaturalist
- findflower
---

# Flora-Ultra

Flora-Ultra is the planned high-precision FindFlower botanical engine. It is
fine-tuned from `eva02_large_patch14_clip_336.merged2b_ft_inat21` and uses the
verified flowering-plant taxonomy produced by the FindFlower federation
pipeline.

The production service is operated by **gsor56** and is available through
https://findflower.me/. The public web application remains the stable entry
point at https://findflower.me/try.html.

## Model and data contract

- Backbone: EVA-02 Large, iNaturalist-21K fine-tuned weights.
- Taxonomy: flowering Plantae classes derived dynamically from the iNat21
  10,000-label taxonomy.
- Input preprocessing: RGB image, resized/cropped to the training resolution.
- Deployment target: server-side ONNX Runtime, with quantized artifacts tested
  against the backend memory budget.
- Dataset card: https://huggingface.co/datasets/gsor56/findflower-find10k

This model card describes the Flora-Ultra target. Check the release files and
evaluation report before using a checkpoint in production.

## Safety and limitations

Species-level accuracy varies by taxon, geographic range, image quality, and
whether diagnostic structures are visible. Predictions are identification aids,
not authoritative taxonomy. Keep the Standard ViT-116 production model
available as a stable fallback.

## Support

Project site: https://findflower.me/  
Issue reporting: https://findflower.me/contact.html  
Repository: https://github.com/gsor56/findflower
