# FindFlower showcase generation

Run from the repository root in a normal local terminal:

```powershell
npm run showcase
```

The full pipeline captures five real app flows, optimizes them, installs them in
`assets/`, updates `how.html`, and checks desktop/mobile playback, lazy loading,
SPA navigation, and reduced motion. A failed capture or conversion stops before
the shipped page is changed. No commit, push, deployment, login, or feedback
submission is performed.

## Current assets

All five MP4s and the `how.html` replacements are present in commit `8eb5b92`.
Their H.264/yuv420p streams, lack of audio, checksums, full decoding and sampled
frames have been verified. Sizes are 29,268 bytes (input), 64,021 (ranking),
19,890 (engine), 100,930 (species) and 27,702 (correction).

Desktop/mobile playback screenshots are under `public/assets/`. The fresh
`npm run showcase:verify` run passed all four browser tests in 20.6 seconds on
September 30, 2026, from the user's normal terminal. The three publication/score
contract tests and five playback lifecycle tests also pass. The browser suite
covers desktop/mobile decoding and playback, deferred loading, SPA navigation,
reduced motion and the pause control.

If a managed Windows session rejects child-process pipes with `spawn EPERM`,
run the browser commands from a normal terminal instead.

## Requirements

- Node.js 20+; the root dependencies include `@playwright/test` and `ffmpeg-static`.
- Chromium: `npx playwright install chromium` if absent.
- Free local port 3000, or set `SHOWCASE_PORT` to another port.
- Access to Tailwind and Google Fonts CDNs, as used by the existing app.

`playwright.config.ts` starts a local static server serving the repository root.
The recording context is 1920 × 1080, with raw videos under `public/assets/`.
Production FindFlower, Worker, authentication, Hugging Face and challenge hosts
are blocked by Playwright routing. No production scan is made. The scanner runs
its actual bundled Flora-Micro model in the browser.

## Data and choreography

- **scan-input:** the real Upload tab and `#dropzone`. A real click triggers the
  file chooser; the chooser is dismissed because OS dialogs are not browser video.
- **scan-ranking:** a real Micro inference with `fixtures/cc0-bird-b.jpg`. This
  fixture was copied from the existing QA harness, which documents it as CC0.
  Exact 98.4 / 0.9 / 0.3 / 0.1 scores are asserted, never invented. If the model
  output drifts, recording fails. Override the file with `SHOWCASE_PHOTO`.
- **dash-engine:** fresh local preferences select Micro. The recording fixture
  exposes the dashboard panel behind the guest sign-in wall and mounts its real
  UI code. Clicking Flash changes the actual setting; its checked state, shading,
  label and stored value are asserted. This does not create a signed-in session.
- **species-fields:** `/species?name=Rudbeckia%20hirta`, with the existing local
  `trefle-data.json` record placed in the app's normal session cache. This freezes
  catalogue fields and empty values, avoiding live Wikipedia/Trefle changes. The
  app's real renderer displays all four missing fields. No description is invented.
- **scan-correction:** a real scan, followed by the real `#fbNo` handler and focus
  in the optional input. Nothing is submitted.

The cursor is SVG with cubic Bezier movement driven by `requestAnimationFrame`.
Native clicks trigger its 150 ms press animation. Each scenario measures a crop
from real element bounds and saves a review PNG. Setup/loading is trimmed from
the final clip. The original still-image aspect ratios are retained with even
H.264 dimensions; fit/padding prevents clipping when the panel proportions differ.

## Individual steps

```powershell
npm run showcase:capture
npm run showcase:optimize
npm run showcase:publish
npm run showcase:verify
node scripts/generate-showcase/contracts.test.js
node scripts/generate-showcase/playback.test.js
```

Optimization uses H.264, yuv420p, CRF 28, no audio and fast-start MP4 metadata.
It retries CRF 30/32 only when necessary and rejects files at or above 1.9 MB.
All clips must decode successfully before a complete checksum manifest is written.
Publication validates every checksum before replacing any figure. It prints final
file sizes. Inspect the review PNGs and playback-test screenshots before deploying.

Videos use the existing WebP posters and exact image classes. Sources are attached
on intersection, playback pauses off-screen, and reduced-motion visitors see stills
until they choose Play demonstrations. A single pause control stops the demos.
The setup uses the existing router's mount/unmount lifecycle.

## External QA harness

The sibling `ffqa-harness/shots.probe.mjs` already recognizes the ranking video,
including its `data-src`, `aria-label`, dimensions and deferred loading.
`qa-shots.patch` is provided for older copies that still expect an image. Apply
it only to those older copies, after publishing, from the harness directory:

```powershell
git apply --ignore-whitespace ../FF/scripts/generate-showcase/qa-shots.patch
```

The external harness was inspected without changing it in this verification
pass. The dedicated Playwright suite independently covers all five videos and
does not depend on that harness.

## Deployment

Ship the root `assets/*.mp4` files and `scripts/showcase-videos.js` with `how.html`.
Exclude `scripts/generate-showcase/` from the deployed frontend. Raw recordings,
profiles, intermediate encodes, metadata and review images under `public/assets/`
are ignored by Git. Deployment configuration is being updated independently;
the MP4s use the same root `/assets/` route as the existing images.
