const { exec } = require('node:child_process');
const { promisify } = require('node:util');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { assets } = require('./assets');
const run = promisify(exec);
const root = path.resolve(__dirname, '../..');
const rawDir = path.join(root, 'public/assets');
const outputDir = path.join(rawDir, 'optimized');
const maxBytes = 1_900_000; // Margin below the requested decimal 2 MB limit.

function quote(value) {
  const text = String(value);
  if (process.platform === 'win32') {
    if (/["%!\r\n\0]/.test(text)) throw new Error('Unsafe character in command argument');
    return '"' + text + '"';
  }
  return "'" + text.replace(/'/g, "'\\''") + "'";
}
async function command(ffmpeg, args) {
  return run([ffmpeg, ...args].map(quote).join(' '), { windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
}
async function optimize() {
  const ffmpeg = process.env.FFMPEG_BIN || require('ffmpeg-static');
  if (!ffmpeg) throw new Error('Install ffmpeg-static or set FFMPEG_BIN');
  await fs.mkdir(outputDir, { recursive: true });
  await fs.rm(path.join(outputDir, 'manifest.json'), { force: true });
  const manifest = [];
  for (const asset of assets) {
    const meta = JSON.parse(await fs.readFile(path.join(rawDir, `${asset.name}.json`), 'utf8'));
    if (meta.name !== asset.name || !Number.isFinite(meta.duration) || meta.duration < 2) throw new Error('Invalid capture metadata');
    const raw = path.join(rawDir, `${asset.name}.webm`);
    if ((await fs.stat(raw)).size < 1000) throw new Error(`Empty recording: ${raw}`);
    // FFmpeg prints container metadata on stderr; a null output also confirms it decodes.
    const { stderr } = await command(ffmpeg, ['-hide_banner', '-i', raw, '-f', 'null', '-']);
    const match = stderr.match(/Duration: (\d+):(\d+):(\d+\.\d+)/);
    if (!match) throw new Error(`Cannot read recording duration: ${raw}`);
    const rawDuration = Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
    const duration = Math.min(meta.duration, rawDuration);
    const start = Math.max(0, rawDuration - duration);
    const { x, y, width, height } = meta.crop;
    if (![x, y, width, height].every(Number.isFinite) || x < 0 || y < 0 || width < 32 || height < 32 || x + width > 1920 || y + height > 1080) {
      throw new Error(`Invalid crop for ${asset.name}: ${JSON.stringify(meta.crop)}`);
    }
    const filter = `crop=${Math.floor(width / 2) * 2}:${Math.floor(height / 2) * 2}:${Math.floor(x / 2) * 2}:${Math.floor(y / 2) * 2},` +
      `scale=${asset.width}:${asset.height}:force_original_aspect_ratio=decrease:force_divisible_by=2:flags=lanczos,` +
      `pad=${asset.width}:${asset.height}:(ow-iw)/2:(oh-ih)/2:color=white,setsar=1,fps=30`;
    const output = path.join(outputDir, `${asset.name}.mp4`);
    let size = 0;
    for (const crf of [28, 30, 32]) {
      await command(ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error', '-ss', start.toFixed(3), '-i', raw,
        '-t', duration.toFixed(3), '-vf', filter, '-c:v', 'libx264', '-preset', 'slow', '-crf', String(crf),
        '-pix_fmt', 'yuv420p', '-an', '-movflags', '+faststart', output]);
      size = (await fs.stat(output)).size;
      if (size < maxBytes) break;
    }
    if (size < 1000 || size >= maxBytes) throw new Error(`Video outside size budget: ${asset.name} (${size} bytes)`);
    await command(ffmpeg, ['-v', 'error', '-i', output, '-f', 'null', '-']);
    const hash = createHash('sha256').update(await fs.readFile(output)).digest('hex');
    manifest.push({ ...asset, bytes: size, duration, sha256: hash });
  }
  await fs.writeFile(path.join(outputDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  console.table(manifest.map(a => ({ file: a.name + '.mp4', bytes: a.bytes, MB: (a.bytes / 1_000_000).toFixed(3), seconds: a.duration.toFixed(2) })));
  console.log('All five MP4s decoded successfully and are below 1.9 MB. Staged in public/assets/optimized/.');
}
if (require.main === module) optimize().catch(err => { console.error(err.message); process.exitCode = 1; });
module.exports = { optimize, quote };
