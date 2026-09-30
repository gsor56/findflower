import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const excluded = /(?:^|\/)(?:\.[^/]+|node_modules|scratch|generate-showcase)(?:\/|$)|(?:\.test\.|\.spec\.|\.integration\.)/;
const sensitive = /(?:^|\/)[^/]*(?:secret|credential|token|\.env)[^/]*(?:\/|$)/i;

// Production retains the existing flat layout and `node index.js` startup.
// Backend auth.js/package.json take precedence over the repository root files.
export function destination(source) {
    if (source === '.well-known/discord') return source;
    if (excluded.test(source) || sensitive.test(source)) return null;
    if (/^server\/(?:[^/]+\.js|package(?:-lock)?\.json|(?:routes|models|lib|views)\/.+\.(?:js|ejs))$/.test(source)) {
        return source.slice(7);
    }
    if (/^scripts\/hidencloud\/.+\.mjs$/.test(source) || source === 'scripts/sync-server-to-github.mjs') return source;
    if (/^scripts\/(?:(?:views|vendor)\/)?[^/]+\.js$/.test(source)) return source;
    if (/^(?:assets\/.+\.(?:png|jpe?g|webp|avif|gif|svg|mp4|webm)|models\/lite\/.+\.(?:json|bin|wasm|tflite)|articles\/.+\.(?:json|md)|(?:chat|notifications)\/index\.html)$/.test(source)) return source;
    if (!source.includes('/') && source !== 'auth.js' && !/^package(?:-lock)?\.json$/.test(source)
        && /\.(?:html|css|js|svg|ico|png|json|xml|txt)$/.test(source)
        && !/(?:test|manifest\.|^hf_|^kaggle|^README|^LICENSE)/i.test(source)) return source;
    // manifest.json is a public PWA asset, not a data-processing manifest.
    if (source === 'manifest.json') return source;
    return null;
}

export function buildManifest(repo = root, revision = 'HEAD') {
    const commit = execFileSync('git', ['rev-parse', revision], { cwd: repo, encoding: 'utf8' }).trim();
    const sources = execFileSync('git', ['ls-tree', '-r', '--name-only', '-z', commit], { cwd: repo }).toString().split('\0').filter(Boolean);
    const files = [];
    const used = new Set();
    for (const source of sources) {
        const dest = destination(source);
        if (!dest) continue;
        if (used.has(dest)) throw new Error(`Deployment path collision: ${dest}`);
        used.add(dest);
        const bytes = execFileSync('git', ['show', `${commit}:${source}`], { cwd: repo, maxBuffer: 100 * 1024 * 1024 });
        files.push({ source, destination: dest, sha256: sha256(bytes), size: bytes.length });
    }
    return { version: 1, revision: commit, files };
}

export function assertSafeEntry(entry) {
    if (destination(entry.source) !== entry.destination || (entry.sha256 !== null && !/^[a-f0-9]{64}$/.test(entry.sha256))) {
        throw new Error(`Invalid manifest entry: ${entry.source}`);
    }
    if (entry.source.split('/').some(p => !p || p === '..') || entry.source.includes('\\')) throw new Error('Unsafe source path');
}

export function sourceForLive(dest) {
    if (/^(?:routes|lib|views)\//.test(dest) || /^models\/(?!lite\/)/.test(dest)
        || /^(?:index|auth|db|session|lib|inference)\.js$/.test(dest)
        || /^package(?:-lock)?\.json$/.test(dest)) {
        return destination('server/' + dest) === dest ? 'server/' + dest : null;
    }
    return destination(dest) === dest ? dest : null;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const revision = process.argv[2] || 'HEAD';
    const out = path.resolve(process.argv[3] || '.hidencloud-local/bundle');
    if (!out.startsWith(root + path.sep)) throw new Error('Build output must be inside this checkout');
    if (fs.existsSync(out)) throw new Error('Use a fresh output directory; stale files must not enter a deployment');
    const manifest = buildManifest(root, revision);
    fs.mkdirSync(out, { recursive: true });
    for (const entry of manifest.files) {
        const bytes = execFileSync('git', ['show', `${manifest.revision}:${entry.source}`], { cwd: root, maxBuffer: 100 * 1024 * 1024 });
        const target = path.join(out, entry.destination);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, bytes);
    }
    fs.writeFileSync(path.join(out, 'deployment.json'), JSON.stringify(manifest, null, 2));
    console.log(`Built ${manifest.files.length} files from ${manifest.revision} in ${out}`);
}
