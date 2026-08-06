<div align="center">

<img width="480" alt="FindFlower demo" src="https://github.com/user-attachments/assets/80fb2b0f-c697-4787-9b1e-fa3bf479d973" />

# 🌸 FindFlower

### Point your camera at a flower. Know what it is in seconds.

A lightweight, on-device flower identification tool — no uploads, no waiting, no accounts required to try it.

<p>
  <img src="https://img.shields.io/badge/status-beta-orange" alt="status" />
  <img src="https://img.shields.io/badge/made%20with-TensorFlow.js-FF6F00?logo=tensorflow" alt="made with tensorflow.js" />
  <img src="https://img.shields.io/badge/license-MIT-blue" alt="license" />
  <img src="https://img.shields.io/badge/on--device-100%25%20private-4CAF50" alt="private" />
</p>

<p>
  <a href="https://findflower.me"><b>🌐 Live Demo</b></a> ·
  <a href="https://findflower.me/contact.html"><b>🐛 Report a Bug</b></a> ·
  <a href="https://findflower.me/how.html"><b>📖 How it Works</b></a>
</p>

</div>

<br>

## ✨ What is FindFlower?

> Ever seen a flower on a walk and had *no idea* what it was called?

FindFlower identifies it right from your browser — snap a photo, upload one, or paste an image link, and get a species name back in seconds.

**No app to install. No image ever leaves your device.** Just point, click, and learn.

<br>

## 🔍 How It Works

<table>
<tr>
<td align="center" width="25%">📸<br><b>Snap or upload</b><br><sub>a photo of any flower</sub></td>
<td align="center" width="25%">🧠<br><b>On-device CNN</b><br><sub>analyzes it, right in your browser</sub></td>
<td align="center" width="25%">🌼<br><b>Get the species</b><br><sub>+ a confidence score</sub></td>
<td align="center" width="25%">📚<br><b>Learn more</b><br><sub>pulled live from Wikipedia</sub></td>
</tr>
</table>

Everything runs client-side using **TensorFlow.js** — your photos are never sent to a server, which means it's fast *and* private by default.

<br>

## 🪴 Current Status — Beta

<table>
<tr><th>Feature</th><th>Status</th></tr>
<tr><td>On-device CNN model</td><td>✅ Live</td></tr>
<tr><td>Species identification</td><td>✅ Live (growing class list)</td></tr>
<tr><td>Wikipedia integration</td><td>✅ Live</td></tr>
<tr><td>Hosted API</td><td>🚧 Coming soon</td></tr>
<tr><td>ViT model upgrade</td><td>🚧 Planned</td></tr>
</table>

Got a misidentification? Hit **"No, incorrect"** right on the [try page](https://findflower.me/try.html) — every bit of feedback helps retrain the model.

<br>

## 🛠️ Tech Stack

<p>
<img src="https://img.shields.io/badge/TensorFlow.js-FF6F00?style=for-the-badge&logo=tensorflow&logoColor=white" />
<img src="https://img.shields.io/badge/HTML5-E34F26?style=for-the-badge&logo=html5&logoColor=white" />
<img src="https://img.shields.io/badge/JavaScript-F7DF1E?style=for-the-badge&logo=javascript&logoColor=black" />
<img src="https://img.shields.io/badge/Wikipedia_API-black?style=for-the-badge&logo=wikipedia&logoColor=white" />
</p>

No heavy frameworks — kept light and fast on purpose.

<br>

## 🚀 Running It Locally

```bash
git clone https://github.com/gsor56/findflower.git
cd findflower
# open index.html in your browser — that's it, no build step
```

<br>

## 🗺️ Roadmap

- [ ] Expand model to full species class list
- [ ] Upgrade CNN → Vision Transformer (ViT) for higher accuracy
- [ ] Launch public hosted API
- [ ] Add user accounts + saved identification history

<br>

## 🤝 Contributing

This is a solo, student-built project — feedback, bug reports, and suggestions are genuinely welcome. Open an issue or reach out via the [contact page](https://findflower.me/contact.html).

<br>

## 📄 License

Released under the [MIT License](LICENSE) — free to use, modify, and learn from.

---

<div align="center">
<sub>Built with 🌱 by a student who really likes flowers.</sub>
</div>
