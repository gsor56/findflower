---
title: FindFlower ViT
emoji: 🌸
colorFrom: green
colorTo: gray
sdk: docker
app_port: 7860
pinned: false
---

# FindFlower ViT inference

Private inference server for the FindFlower ViT (116 flower species).
Loads `gsor56/findflower-ViT` internally; only labels + scores are returned,
so the model weights never leave the container.

All `/predict` calls require an `X-Proxy-Secret` header — only the FindFlower
Cloudflare Worker holds it, so this Space is not an open public API.
