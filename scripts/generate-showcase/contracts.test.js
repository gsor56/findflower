const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { replaceFigures } = require('./publish');
const { assets } = require('./assets');
const root = path.resolve(__dirname, '../..');

test('publication retains all five figures, descriptions and posters; source loading is deferred', () => {
  const original = fs.readFileSync(path.join(root, 'how.html'), 'utf8').replace(/\r\n/g, '\n');
  const html = replaceFigures(original);
  assert.equal((html.match(/<figure\b/g) || []).length, (original.match(/<figure\b/g) || []).length);
  const videos = html.match(/<video\b[\s\S]*?<\/video>/g) || [];
  assert.equal(videos.length, 5);
  for (const [index, asset] of assets.entries()) {
    const video = videos[index];
    assert.ok(video.includes(`data-src="/assets/${asset.name}.mp4"`));
    assert.ok(video.includes(`poster="/assets/${asset.name}.webp"`));
    assert.match(video, /autoplay loop muted playsinline preload="none"/);
    assert.match(video, /class="w-full rounded-lg border border-neutral-200 bg-white"/);
    assert.match(video, /aria-label="[^"]{40,}"/);
    assert.doesNotMatch(video, /\ssrc=/);
  }
  assert.equal(replaceFigures(html), html, 'Publishing twice must not duplicate markup or controls');
});

test('publication refuses a page with a missing target', () => {
  // Build the pre-publish shape (five <img> figures) from the asset list rather than
  // reading how.html, so this negative check is deterministic whether or not the page
  // has already been published: once it holds <video>s, the idempotency guard would
  // otherwise skip the renamed target and mask the refusal.
  const page = assets.map(a =>
    `                        <img src="/assets/${a.name}.webp"\n` +
    `                            alt="A representative ${a.name} description, long enough to double as an aria-label."\n` +
    '                            class="w-full rounded-lg border border-neutral-200 bg-white" />'
  ).join('\n');
  assert.throws(() => replaceFigures(page.replaceAll('scan-ranking.webp', 'removed.webp')), /scan-ranking/);
});

test('scanner shows the requested runners-up but drops anything under one percent', () => {
  const source = fs.readFileSync(path.join(root, 'try.html'), 'utf8');
  // The threshold is declared beside the function rather than inside it, so the
  // extracted source has to carry it along, and it is read from the page instead of
  // repeated here so the test cannot drift away from what ships.
  const threshold = source.match(/const ALT_MIN_CONFIDENCE = ([\d.]+);/)?.[1];
  assert.ok(threshold);
  const functionSource = source.match(/function alternatives\(ranked, upTo\) \{[\s\S]*?\n        \}/)?.[0];
  assert.ok(functionSource);
  const alternatives = vm.runInNewContext(
    `const ALT_MIN_CONFIDENCE = ${threshold};\n${functionSource}\nalternatives;`);
  const ranked = [{ name: 'best', p: .9 }, { name: 'second', p: .06 }, { name: 'third', p: .03 },
    { name: 'fourth', p: .005 }, { name: 'noise', p: .00001 }];
  assert.equal(JSON.stringify(alternatives(ranked, 5).map(item => item.name)), JSON.stringify(['second', 'third']));
  assert.equal(alternatives([{ p: .999 }, { p: .009 }], 4).length, 0);
  assert.equal(alternatives([{ p: .999 }, { p: .01 }], 4).length, 1);
});
