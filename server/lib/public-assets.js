// The flat production directory also contains private backend source.
// Keep the public surface explicit, including only the browser model subtree.
const ROOT_FILES = new Set([
    'app.css', 'auth.js', 'blur.js', 'directory.js', 'footer.js', 'i18n.js',
    'main.js', 'nav.js', 'prefs.js', 'species.js', 'storage.js', 'sw.js',
    'favicon.svg', 'favicon.ico', 'apple-touch-icon.png', 'icon-192.png',
    'icon-512.png', 'icon-maskable-512.png', 'manifest.json', 'robots.txt',
    'sitemap.xml', 'trefle-data.json', '404.html',
]);

export function isPublicAsset(urlPath, { flat = false } = {}) {
    let pathname;
    try { pathname = decodeURIComponent(urlPath); } catch { return false; }
    const parts = pathname.split('/').filter(Boolean);
    if (!parts.length || parts.some(p => p === '..' || p.includes('\\'))) return false;
    if (parts[0] === '.well-known') return parts.length === 2 && parts[1] === 'discord';
    if (parts.some(p => p.startsWith('.'))) return false;
    // In the flat layout auth.js is the backend authentication module.
    if (parts.length === 1) return ROOT_FILES.has(parts[0]) && !(flat && parts[0] === 'auth.js');
    if (parts[0] === 'models') {
        return parts[1] === 'lite' && /\.(?:json|bin|wasm|tflite)$/i.test(pathname);
    }
    if (parts[0] === 'scripts') {
        return !parts.includes('generate-showcase')
            && !parts.some(p => /(?:\.test\.|^sync-server-to-github|^hidencloud)/.test(p))
            && /\.(?:js|mjs)$/i.test(pathname);
    }
    if (parts[0] === 'assets') return /\.(?:png|jpe?g|webp|avif|gif|svg|mp4|webm|woff2?)$/i.test(pathname);
    if (parts[0] === 'articles') return /\.(?:json|md)$/i.test(pathname);
    return false;
}
