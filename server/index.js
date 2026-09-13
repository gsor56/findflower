// FindFlower application server: server-rendered pages, the JSON API, and the
// live event stream, in one Express process.
//
// This is the migration target. Pages are rendered here through EJS with the
// Auth0 session inlined, so the browser no longer boots a second login client
// and /community, /notifications and /chat arrive with their first page of data
// already in the markup. The same app answers /api/* for the scripts that still
// fetch after load.
//
//   npm start            # reads MONGO_URI from the repo-root .env
//   PORT=4000            # a local run; 3000 belongs to the QA harness's static server
//
// Footprint note: the allocation is 3GB and the EVA-02 ONNX export wants most of
// it, so nothing in this process loads an image model. Classification stays in
// the browser; the server reasons about text, ids, and one capped staging image.

import path from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { connectDb, closeDb } from './db.js';
import { seedDefaultSpaces } from './models/space.js';
import { User } from './models/user.js';
import { oidc, sessionBootstrap, sessionUser } from './session.js';
import { renderPage } from './lib/ssr.js';
import { communityPayload, notificationsPayload, chatPayload } from './lib/social-data.js';
import { connectionCount } from './lib/events.js';
import postsRouter from './routes/posts.js';
import spacesRouter from './routes/spaces.js';
import usersRouter from './routes/users.js';
import friendsRouter from './routes/friends.js';
import messagesRouter from './routes/messages.js';
import searchRouter from './routes/search.js';
import notificationsRouter from './routes/notifications.js';
import eventsRouter from './routes/events.js';
import contributionsRouter from './routes/contributions.js';

const PORT = Number(process.env.PORT || process.env.SERVER_PORT) || 24729;
const HOST = process.env.HOST || '0.0.0.0';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..');
const SITE_ROOT = existsSync(path.join(REPO_ROOT, 'index.html')) ? REPO_ROOT : HERE;

const ORIGINS = new Set([
    'https://findflower.me',
    'https://www.findflower.me',
    'http://127.0.0.1:3000',
    'http://localhost:3000',
    ...String(process.env.FF_ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean),
]);

const app = express();

app.set('view engine', 'ejs');
app.set('views', path.join(HERE, 'views'));
app.set('trust proxy', 1);

// Basic request middleware comes first.
app.use((req, res, next) => {
    const origin = req.get('Origin');
    if (origin && ORIGINS.has(origin)) {
        res.set('Access-Control-Allow-Origin', origin);
        res.set('Vary', 'Origin');
        res.set('Access-Control-Allow-Credentials', 'true');
        res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
        res.set('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
        res.set('Access-Control-Max-Age', '600');
    }
    if (req.method === 'OPTIONS') {
        res.sendStatus(origin && ORIGINS.has(origin) ? 204 : 403);
        return;
    }
    next();
});

// Keep ordinary JSON requests capped at 256KB. Contributions have their own
// 2MB parser on the dedicated router, so this basic parser deliberately leaves
// that path untouched instead of consuming or rejecting its larger body.
const jsonParser = express.json({ limit: '256kb' });
app.use((req, res, next) => {
    if (req.path.startsWith('/api/contributions')) {
        next();
        return;
    }
    jsonParser(req, res, next);
});

// Auth0 must own /login, /logout and /callback before any application route,
// static-file handler or SPA fallback can see them. authRequired remains false
// in session.js, so public routes stay public while the default OIDC routes are
// still installed by express-openid-connect.
app.use(oidc);

app.use('/api/contributions', contributionsRouter);

app.get('/health', (req, res) => {
    res.json({ status: 'ok', service: 'findflower', streams: connectionCount() });
});

async function attachViewer(req, res, next) {
    const who = sessionUser(req);
    if (!who) {
        req.viewer = null;
        next();
        return;
    }
    try {
        req.viewer = await User.findOne({ authSub: who.sub });
    } catch (err) {
        console.error('[ssr] viewer lookup failed:', err.message);
        req.viewer = null;
    }
    next();
}

async function renderWith(req, res, page, load, extra) {
    const session = sessionBootstrap(req);
    let data = null;
    if (load) {
        try {
            data = await load();
        } catch (err) {
            console.error(`[ssr] ${page} data failed:`, err.message);
        }
    }
    const viewerId = req.viewer ? String(req.viewer._id) : null;
    renderPage(req, res, page, { session, data, ...(extra || {}), viewerId });
}

for (const [route, page] of [['/', 'home'], ['/api', 'api'], ['/try', 'try'], ['/contribute', 'contribute']]) {
    app.get(route, attachViewer, (req, res) => renderWith(req, res, page, null));
}

app.get('/community', attachViewer, (req, res) =>
    renderWith(req, res, 'community', () => communityPayload(req)));

app.get('/notifications', attachViewer, (req, res) =>
    renderWith(req, res, 'notifications', () => notificationsPayload(req)));

app.get('/chat', attachViewer, (req, res) =>
    renderWith(req, res, 'chat', () => chatPayload(req, req.query.with)));

const REDIRECTS = {
    '/index.html': '/',
    '/try.html': '/try',
    '/contribute.html': '/contribute',
    '/api.html': '/api',
    '/community.html': '/community',
    '/chat.html': '/chat',
    '/chat/index.html': '/chat',
    '/notifications/index.html': '/notifications',
    '/login.html': '/login',
};
for (const [from, to] of Object.entries(REDIRECTS)) {
    app.get(from, (req, res) => res.redirect(301, to));
}

app.use('/api/posts', postsRouter);
app.use('/api/spaces', spacesRouter);
app.use('/api/users', usersRouter);
app.use('/api/friends', friendsRouter);
app.use('/api/messages', messagesRouter);
app.use('/api/search', searchRouter);
app.use('/api/notifications', notificationsRouter);
app.use('/api/events', eventsRouter);

const PUBLIC_DIRS = new Set(['articles', 'assets', 'chat', 'notifications', 'scripts', '.well-known']);
const PUBLIC_FILE = /\.(?:html|css|js|mjs|json|png|jpe?g|webp|svg|ico|woff2?|xml|txt)$/i;

app.use((req, res, next) => {
    const parts = req.path.split('/').filter(Boolean);
    if (!parts.length) {
        next();
        return;
    }
    if (parts.length > 1) {
        if (PUBLIC_DIRS.has(parts[0])) {
            next();
            return;
        }
        res.status(404).json({ error: 'Not found.' });
        return;
    }
    if (PUBLIC_FILE.test(parts[0]) || parts[0] === 'CNAME' || parts[0] === 'LICENSE') {
        next();
        return;
    }
    res.status(404).json({ error: 'Not found.' });
});

app.use(express.static(SITE_ROOT, {
    index: false,
    dotfiles: 'allow',
    etag: true,
    maxAge: '10m',
    setHeaders(res, filePath) {
        if (/\.(?:js|css|html)$/i.test(filePath)) res.setHeader('Cache-Control', 'no-cache');
    },
}));

app.use((req, res) => {
    if (req.accepts('html') && !req.path.startsWith('/api/')) {
        renderPage(req, res, 'home', { session: sessionBootstrap(req) }, 404);
        return;
    }
    res.status(404).json({ error: `No route for ${req.method} ${req.path}.` });
});

app.use((err, req, res, next) => {
    console.error(`[api] ${req.method} ${req.path} failed:`, err.message);
    if (res.headersSent) return;
    res.status(500).json({ error: 'Something went wrong on the server.' });
});

const server = await start();

async function start() {
    await connectDb();
    const added = await seedDefaultSpaces();
    console.log(`[api] spaces seeded (${added} new)`);
    return app.listen(PORT, HOST, () => console.log(`[api] listening on ${HOST}:${PORT}`));
}

for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => {
        console.log(`[api] ${sig} -- shutting down`);
        server.close(async () => {
            await closeDb();
            process.exit(0);
        });
    });
}
