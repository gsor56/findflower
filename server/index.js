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

// The container's allocation is 24729. Panels of that family publish the
// number as SERVER_PORT rather than PORT, so both names are read before the
// default is used.
const PORT = Number(process.env.PORT || process.env.SERVER_PORT) || 24729;
const HOST = process.env.HOST || '0.0.0.0';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// Two layouts, same as db.js handles for .env: in the repository server/ sits
// one level below the site; on the container these files are the root and there
// is no level above. Whichever one holds index.html is the static root.
const REPO_ROOT = path.resolve(HERE, '..');
const SITE_ROOT = existsSync(path.join(REPO_ROOT, 'index.html')) ? REPO_ROOT : HERE;

// Browsers must be named, not wildcarded: these routes read a session cookie,
// and `Access-Control-Allow-Origin: *` cannot carry credentials.
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

// TLS terminates upstream, so req.ip is the proxy's address unless this is set
// -- and a rate limiter that sees one address sees one user. It is also what
// makes the `secure` session cookie work behind the HidenCloud hop.
app.set('trust proxy', 1);

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

// Auth0 runs for every request and only populates req.oidc. It does not gate
// anything by itself: the public pages are public, and the routes that need a
// viewer use requireViewer/optionalViewer, which now read the same session.
app.use(oidc);

// Mounted before the global JSON parser on purpose. A staged contribution is an
// image and needs a far larger limit than a 280-character bio; body-parser
// marks the request parsed, so the global one below skips it.
app.use('/api/contributions', contributionsRouter);

// 256KB covers a 280-character bio, a 2000-character post and a capped avatar
// with room to spare. The default 100KB does not fit the avatar.
app.use(express.json({ limit: '256kb' }));

app.get('/health', (req, res) => {
    res.json({ status: 'ok', service: 'findflower', streams: connectionCount() });
});

/** Hydrate req.viewer from the session cookie for a page render. Unlike
 *  requireViewer this never answers: a signed-out visitor still gets the page,
 *  just one rendered for a signed-out reader. */
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
            // A dead cluster must not take the page with it: the shell still
            // renders and the client scripts can retry the fetch themselves.
            console.error(`[ssr] ${page} data failed:`, err.message);
        }
    }
    const viewerId = req.viewer ? String(req.viewer._id) : null;
    renderPage(req, res, page, { session, data, ...(extra || {}), viewerId });
}

// Pages whose content is the same for everyone. Only the session differs, and
// that is the one thing the render injects.
for (const [route, page] of [['/', 'home'], ['/api', 'api'], ['/try', 'try'], ['/contribute', 'contribute']]) {
    app.get(route, attachViewer, (req, res) => renderWith(req, res, page, null));
}

app.get('/community', attachViewer, (req, res) =>
    renderWith(req, res, 'community', () => communityPayload(req)));

app.get('/notifications', attachViewer, (req, res) =>
    renderWith(req, res, 'notifications', () => notificationsPayload(req)));

app.get('/chat', attachViewer, (req, res) =>
    renderWith(req, res, 'chat', () => chatPayload(req, req.query.with)));

// The static build's filenames, kept as redirects rather than deleted: they are
// in the sitemap and in whatever people bookmarked, and one URL per page is the
// point of the migration.
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

// The static assets the rendered pages reference: stylesheets, scripts, icons,
// images. index:false so / is never answered from disk and the SSR route keeps
// ownership of it.
//
// The allowlist above express.static is not decoration. On the container the
// site and the server are the same tree, so a bare mount would publish
// server/, proxy/, space/, training/, curation/ and my-secrets/ to anyone who
// guessed the path. Only the directories a page actually loads are reachable,
// and only files with an asset extension at the root.
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
    // .well-known has to be reachable for domain verification, and the guard
    // above is what keeps the other dotfiles out of reach.
    dotfiles: 'allow',
    etag: true,
    maxAge: '10m',
    setHeaders(res, filePath) {
        // Code must be revalidate-ready: a cached stale script against fresh
        // markup is how a deploy turns into a blank page.
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

// Express 5 forwards a rejected handler promise here. The message is logged and
// not returned: a mongoose validation error is safe to show, a driver error can
// carry connection detail, and telling them apart per-error is how detail leaks.
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
