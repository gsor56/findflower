const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { assets } = require('./assets');
const root = path.resolve(__dirname, '../..');
const staging = path.join(root, 'public/assets/optimized');

function replaceFigures(html) {
  for (const asset of assets) {
    const pattern = new RegExp(`<img\\s+src="/assets/${asset.name}\\.webp"[\\s\\S]*?/>`, 'g');
    const matches = html.match(pattern) || [];
    if (!matches.length && html.includes(`data-src="/assets/${asset.name}.mp4"`)) continue;
    if (matches.length !== 1) throw new Error(`Expected exactly one figure for ${asset.name}`);
    const alt = matches[0].match(/alt="([^"]*)"/)?.[1];
    if (!alt) throw new Error(`Missing description: ${asset.name}`);
    html = html.replace(pattern,
      `<video data-showcase data-src="/assets/${asset.name}.mp4" poster="/assets/${asset.name}.webp"\n` +
      `                            width="${asset.width}" height="${asset.height}" autoplay loop muted playsinline preload="none"\n` +
      `                            aria-label="${alt}"\n` +
      '                            class="w-full rounded-lg border border-neutral-200 bg-white">\n' +
      `                            ${alt}\n` +
      '                        </video>');
  }
  if (!html.includes('src="scripts/showcase-videos.js"')) {
    html = html.replace('    <script src="scripts/router.js" defer></script>',
      '    <script src="scripts/showcase-videos.js" defer></script>\n    <script src="scripts/router.js" defer></script>');
    const anchor = '                    How FindFlower works';
    if (!html.includes(anchor)) throw new Error('How page title moved');
    const endCTA = html.indexOf('                    </a>', html.indexOf(anchor));
    if (endCTA < 0) throw new Error('How page call-to-action moved');
    const pos = endCTA + '                    </a>'.length;
    html = html.slice(0, pos) + '\n                    <button type="button" data-showcase-toggle aria-pressed="false" class="block mt-5 text-sm text-neutral-500 underline underline-offset-4 hover:text-neutral-900">Pause demonstrations</button>' + html.slice(pos);
  }
  if ((html.match(/<video data-showcase /g) || []).length !== 5) throw new Error('Expected five video replacements');
  return html;
}

async function publish(preview = false) {
  const target = path.join(root, 'how.html');
  const original = await fs.readFile(target, 'utf8');
  const html = replaceFigures(original.replace(/\r\n/g, '\n'));
  if (preview) {
    const previewFile = path.join(root, 'public/assets/how.video-preview.html');
    await fs.mkdir(path.dirname(previewFile), { recursive: true });
    await fs.writeFile(previewFile, html);
    console.log('Prepared five replacements in public/assets/how.video-preview.html; how.html unchanged.');
    return;
  }
  const manifest = JSON.parse(await fs.readFile(path.join(staging, 'manifest.json'), 'utf8'));
  if (manifest.length !== assets.length) throw new Error('Incomplete optimized manifest');
  for (const asset of assets) {
    const entry = manifest.find(item => item.name === asset.name);
    const bytes = await fs.readFile(path.join(staging, asset.name + '.mp4'));
    if (!entry || entry.width !== asset.width || entry.height !== asset.height || entry.bytes !== bytes.length ||
      bytes.length >= 1_900_000 || createHash('sha256').update(bytes).digest('hex') !== entry.sha256) {
      throw new Error(`Optimized artifact validation failed: ${asset.name}`);
    }
  }
  for (const asset of assets) {
    await fs.copyFile(path.join(staging, asset.name + '.mp4'), path.join(root, 'assets', asset.name + '.mp4'));
  }
  await fs.writeFile(target, original.includes('\r\n') ? html.replace(/\n/g, '\r\n') : html);
  console.table(manifest.map(a => ({ file: 'assets/' + a.name + '.mp4', bytes: a.bytes, MB: (a.bytes / 1e6).toFixed(3) })));
  console.log('how.html: all five images replaced; posters preserved; videos buffer only on intersection.');
}
if (require.main === module) publish(process.argv.includes('--preview')).catch(err => { console.error(err.message); process.exitCode = 1; });
module.exports = { publish, replaceFigures };
