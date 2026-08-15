<div align="center">

<img width="480" alt="FindFlower demo" src="https://github.com/user-attachments/assets/80fb2b0f-c697-4787-9b1e-fa3bf479d973" />

# 🌸 FindFlower

### Point your camera at a flower. Know what it is in seconds.

Flower identification for 116 species, powered by a fine-tuned Vision Transformer.

<p>
  <img src="https://img.shields.io/badge/status-beta-orange" alt="status" />
  <img src="https://img.shields.io/badge/model-ViT--base-EE4C2C" alt="model" />
  <img src="https://img.shields.io/badge/runtime-ONNX-005CED" alt="runtime" />
  <img src="https://img.shields.io/badge/license-MIT-blue" alt="license" />
</p>

<p>
  <a href="https://findflower.me"><b>🌐 Live Demo</b></a> ·
  <a href="https://findflower.me/how.html"><b>📖 How it Works</b></a> ·
  <a href="https://findflower.me/contact.html"><b>🐛 Report a Bug</b></a>
</p>

</div>

<br>

## ✨ What is FindFlower?

> Ever seen a flower on a walk and had *no idea* what it was called?

Snap a photo, upload one, or paste an image link, and get a species name plus a
confidence score in a few seconds. No app to install, no account needed to try it.

<br>

## 🔍 How It Works

<table>
<tr>
<td align="center" width="25%">📸<br><b>Snap or upload</b><br><sub>a photo of any flower</sub></td>
<td align="center" width="25%">🔒<br><b>Sent over HTTPS</b><br><sub>via our inference proxy</sub></td>
<td align="center" width="25%">🌼<br><b>ViT identifies it</b><br><sub>116 species, top-5 scores</sub></td>
<td align="center" width="25%">📚<br><b>Learn more</b><br><sub>pulled live from Wikipedia</sub></td>
</tr>
</table>

Identification runs **server-side** on a fine-tuned ViT-base. Your image is sent
over HTTPS to do that, used only to run the prediction, and not stored — see the
[privacy page](https://findflower.me/privacy.html) for specifics.

> [!NOTE]
> Earlier betas ran a smaller CNN in-browser via TensorFlow.js, so images stayed
> on your device. The ViT is far more accurate but too large to ship to a browser,
> so inference moved to a server. The privacy tradeoff is deliberate and documented
> rather than glossed over.

<br>

## 🏗️ Architecture

```
browser  ──image──▶  Cloudflare Worker  ──image + X-Proxy-Secret──▶  ONNX backend
                     (origin allowlist,                              (FastAPI +
                      holds the secret)                               onnxruntime)
   ◀── { flower, confidence, top_k } ────────────────────────────────────┘
```

The Worker keeps the backend from being an open public API: it enforces an origin
allowlist and attaches a shared secret the backend checks. Only labels and scores
come back, so the weights never leave the container.

| Path | What lives there |
| --- | --- |
| `*.html`, `*.js`, `favicon.svg` | The static frontend (GitHub Pages) |
| `space/` | FastAPI + onnxruntime inference server |
| `proxy/` | Cloudflare Worker that fronts the backend |
| `training/` | Kaggle training + ONNX conversion scripts |
| `tools/` | Build script for the Trefle species data |

Only the frontend files are published to the web root —
`.github/workflows/pages.yml` copies those into `_site/` and deploys that, so the
training scripts stay in version control without being served.

<br>

## 🚀 Running It Locally

Frontend only — it talks to the deployed Worker, so there's no build step:

```bash
git clone https://github.com/gsor56/findflower.git
cd findflower
python -m http.server 8000     # http://localhost:8000 is on the CORS allowlist
```

The backend and Worker each have their own setup notes in
[`space/README.md`](space/README.md) and [`proxy/README.md`](proxy/README.md).

<br>

## 🪴 Current Status — Beta

<table>
<tr><th>Feature</th><th>Status</th></tr>
<tr><td>ViT identification (116 species)</td><td>✅ Live</td></tr>
<tr><td>Hosted inference backend</td><td>✅ Live</td></tr>
<tr><td>Wikipedia integration</td><td>✅ Live</td></tr>
<tr><td>Public API for developers</td><td>🚧 Planned</td></tr>
<tr><td>Saved identification history</td><td>🚧 Planned</td></tr>
</table>

Got a misidentification? Hit **"No, incorrect"** right on the
[try page](https://findflower.me/try.html) — every bit of feedback helps retrain
the model.

<br>

## 🗺️ Roadmap

- [ ] Expand beyond the current 116 species
- [ ] Launch a documented public API
- [ ] Add user accounts + saved identification history
- [ ] Move the backend to a host with more memory headroom

<br>

## 🤝 Contributing

This is a solo, student-built project — feedback, bug reports, and suggestions are
genuinely welcome. Open an issue or reach out via the
[contact page](https://findflower.me/contact.html).

<br>

## 📄 License

Released under the [MIT License](LICENSE) — free to use, modify, and learn from.

---

<div align="center">
<sub>Built with 🌱 by a student who really likes flowers.<br>
The readme may be outdated. Don't refer.</sub>
</div>
