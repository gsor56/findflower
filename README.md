<div align="center">

# 🌸 FindFlower

**Point your camera at a flower. Know what it is in seconds.**

A lightweight, on-device flower identification tool — no uploads, no waiting, no accounts required to try it.

[🌐 Live Demo](https://findflower.cu.ma) · [🐛 Report a Bug](https://findflower.cu.ma/contact.html) · [📖 How it Works](https://findflower.cu.ma/how.html)

![Status](https://img.shields.io/badge/status-beta-orange)
![Made with](https://img.shields.io/badge/made%20with-TensorFlow.js-FF6F00?logo=tensorflow)
![License](https://img.shields.io/badge/license-MIT-blue)

</div>

---

## ✨ What is FindFlower?

Ever seen a flower on a walk and had *no idea* what it was called? FindFlower identifies it right from your browser — snap a photo, upload one, or paste an image link, and get a species name back in seconds.

No app to install. No image ever leaves your device. Just point, click, and learn.

## 🔍 How It Works

```
📸  Snap or upload a photo
🧠  A CNN model analyzes it — entirely on your device
🌼  Get the species name + confidence score
📚  Read more, pulled live from Wikipedia
```

Everything runs client-side using **TensorFlow.js** — your photos are never sent to a server, which means it's fast *and* private by default.

## 🪴 Current Status — Beta

FindFlower is under active development. Here's where things stand:

| Feature | Status |
|---|---|
| On-device CNN model | ✅ Live |
| Species identification | ✅ Live (growing class list) |
| Wikipedia integration | ✅ Live |
| Hosted API | 🚧 Coming soon |
| ViT model upgrade | 🚧 Planned |

Got a misidentification? Hit "No, incorrect" right on the [try page](https://findflower.cu.ma/try.html) — every bit of feedback helps retrain the model.

## 🛠️ Tech Stack

- **TensorFlow.js** — in-browser model inference
- **Vanilla HTML/CSS/JS** — no heavy frameworks, kept light and fast
- **Wikipedia API** — for species context and details

## 🚀 Running It Locally

```bash
git clone https://github.com/gsor56/findflower.git
cd findflower
# open index.html in your browser — that's it, no build step
```

## 🗺️ Roadmap

- [ ] Expand model to full species class list
- [ ] Upgrade CNN → Vision Transformer (ViT) for higher accuracy
- [ ] Launch public hosted API
- [ ] Add user accounts + saved identification history

## 🤝 Contributing

This is a solo, student-built project — feedback, bug reports, and suggestions are genuinely welcome. Open an issue or reach out via the [contact page](https://findflower.cu.ma/contact.html).

## 📄 License

Released under the [MIT License](LICENSE) — free to use, modify, and learn from.

---

<div align="center">
<sub>Built with 🌱 by a student who really likes flowers.</sub>
</div>
