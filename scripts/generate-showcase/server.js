// Local-only static server; no database, secrets, or production inference.
const http = require('node:http');
const path = require('node:path');
const handler = require('serve-handler');
const root = path.resolve(__dirname, '../..');
const port = Number(process.env.SHOWCASE_PORT || 3000);
http.createServer((req, res) => {
  const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  if (pathname === '/__showcase_health') {
    res.setHeader('Content-Type', 'text/plain');
    return res.end('findflower-showcase');
  }
  if (pathname.startsWith('/api/')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ user: null, authenticated: false }));
  }
  const parts = pathname.split('/').filter(Boolean);
  const publicDirs = ['assets', 'scripts', 'models', 'articles', 'chat', 'notifications'];
  if (parts.some(p => p.startsWith('.') || p === 'generate-showcase') ||
      (parts.length > 1 && !publicDirs.includes(parts[0]))) {
    res.writeHead(404).end();
    return;
  }
  return handler(req, res, { public: root, cleanUrls: true, directoryListing: false });
}).listen(port, '127.0.0.1', () => console.log(`Showcase: http://127.0.0.1:${port}`));
