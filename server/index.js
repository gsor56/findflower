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
import { existsSync, writeFileSync } from 'node:fs';
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
import identifyRouter from './routes/identify.js';
import { preload } from './inference.js';

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

// HidenCloud's front proxy can rewrite X-Forwarded-Proto to `http` on the
// final hop even though the browser entered through Cloudflare HTTPS. The
// Worker pins X-Forwarded-Host to our public hostname; normalize the paired
// scheme before express-openid-connect builds callback URLs or cookies.
app.use((req, res, next) => {
    const forwardedHost = req.get('X-Forwarded-Host');
    if (forwardedHost === 'findflower.me' || forwardedHost === 'www.findflower.me') {
        req.headers['x-forwarded-proto'] = 'https';
        req.headers['x-forwarded-port'] = '443';
    }
    next();
});

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

// A route that proves the Node application itself is answering, separate from
// anything Auth0 does: if this 200s and /login does not, the fault is in the
// OIDC wiring rather than in the proxy or the container.
app.get('/auth-test', (req, res) => res.send('Backend reachable'));

// A session that is minted but never stored looks identical to a successful
// sign-in from the server side. Browsers silently discard a cookie larger than
// roughly 4KB, so report exactly what /callback asks the browser to keep.
app.use((req, res, next) => {
    if (req.path === '/callback') {
        const setHeader = res.setHeader.bind(res);
        res.setHeader = (name, value) => {
            if (String(name).toLowerCase() === 'set-cookie') {
                for (const cookie of [].concat(value)) {
                    const pair = String(cookie).split(';')[0] || '';
                    console.error('[auth] callback set-cookie', pair.split('=')[0], 'bytes=' + String(cookie).length);
                }
            }
            return setHeader(name, value);
        };
    }
    next();
});

// The model. The Worker owns /internal/scan and /v1/identify publicly and
// rewrites both to a multipart POST /predict here, so these routes are reached
// by the Worker rather than by the browser. Mounted ahead of the JSON parser
// for the same reason contributions are: a scan is an image, and the 256KB
// parser below would otherwise be the first thing to see it.
app.use(identifyRouter);

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

// Every navigable page. Most of these paint from the session cookie the render
// inlines and then fetch their own data; that is fine, but they still have to be
// *served* here, and the list is exhaustive on purpose. A page that is missing
// from it cannot be routed, and before this list covered the whole URL space,
// /dashboard, /profile and /about fell through to GitHub Pages' 404.html -- the
// static shell that boots the SPA login client and shows a signed-in visitor as
// signed out, which is exactly the fragmentation this migration removes.
//
// Attached to every page, signed in or not: attachViewer only hydrates
// req.viewer, and a signed-out reader still gets the page rendered for them.
const PAGES = [
    ['/', 'home'],
    ['/api', 'api'],
    ['/try', 'try'],
    ['/contribute', 'contribute'],
    ['/dashboard', 'dashboard'],
    ['/profile', 'profile'],
    ['/about', 'about'],
    ['/pricing', 'pricing'],
    ['/how', 'how'],
    ['/species', 'species'],
    ['/directory', 'directory'],
    ['/contact', 'contact'],
    ['/docs', 'docs'],
    ['/research', 'research'],
    ['/data', 'data'],
    ['/blogs', 'blogs'],
    ['/releases', 'releases'],
    ['/privacy', 'privacy'],
    ['/terms', 'terms'],
    ['/feedback', 'feedback'],
    ['/article', 'article'],
];

for (const [route, page] of PAGES) {
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
    '/dashboard.html': '/dashboard',
    '/profile.html': '/profile',
    '/about.html': '/about',
    '/pricing.html': '/pricing',
    '/how.html': '/how',
    '/species.html': '/species',
    '/directory.html': '/directory',
    '/contact.html': '/contact',
    '/docs.html': '/docs',
    '/research.html': '/research',
    '/data.html': '/data',
    '/blogs.html': '/blogs',
    '/releases.html': '/releases',
    '/privacy.html': '/privacy',
    '/terms.html': '/terms',
    '/feedback.html': '/feedback',
    '/article.html': '/article',
};
for (const [from, to] of Object.entries(REDIRECTS)) {
    app.get(from, (req, res) => res.redirect(301, to));
}

// One URL per page, and no second copy of it behind a trailing slash. GitHub
// Pages used to answer /chat/ with its own index.html -- the same static shell
// under a different name -- and a page served from two URLs is a page that can
// be cached in two states. The redirect also keeps relative asset paths
// resolving the way the document expects.
app.use((req, res, next) => {
    if (req.path.length > 1 && req.path.endsWith('/')) {
        const bare = req.path.replace(/\/+$/, '');
        // `//` strips to nothing, and a redirect to an empty Location is a
        // worse answer than the 404 it would otherwise get.
        if (bare) {
            res.redirect(301, bare + req.originalUrl.slice(req.path.length));
            return;
        }
    }
    next();
});

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
        // The site's own "not found" screen, rendered with the session inlined:
        // a mistyped URL is a normal navigation, and it should not be the one
        // page that forgets who is signed in.
        renderPage(req, res, 'notFound', { session: sessionBootstrap(req) }, 404);
        return;
    }
    res.status(404).json({ error: `No route for ${req.method} ${req.path}.` });
});

// Express 5 forwards a rejected handler promise here. The message is logged and
// not returned: a mongoose validation error is safe to show, a driver error can
// carry connection detail, and telling them apart per-error is how detail leaks.
app.use((err, req, res, next) => {
    // Auth0/OIDC libraries intentionally collapse token endpoint failures into
    // a generic message. Keep the provider's sanitized error fields so a bad
    // client secret, redirect, or PKCE exchange is diagnosable from HidenCloud
    // logs without ever printing code/state/token values.
    const cause = err && err.cause;
    const authDetails = {
        status: err?.status || err?.statusCode,
        code: err?.code,
        error: err?.error || cause?.error || cause?.cause?.error,
        error_description: err?.error_description
            || cause?.error_description
            || cause?.cause?.error_description,
    };
    const hasAuthDetails = Object.values(authDetails).some((value) => value !== undefined);
    if (req.path === '/callback' || hasAuthDetails) {
        const diagnostic = {
            at: new Date().toISOString(),
            method: req.method,
            path: req.path,
            queryKeys: Object.keys(req.query || {}).sort(),
            forwardedHost: req.get('X-Forwarded-Host') || null,
            forwardedProto: req.get('X-Forwarded-Proto') || null,
            hasTransactionCookie: /(?:^|;\s*)auth_verification=/.test(req.get('Cookie') || ''),
            providerError: (req.query && req.query.error) || null,
            providerErrorDescription: (req.query && req.query.error_description) || null,
            cookieNames: String(req.get('Cookie') || '')
                .split(';')
                .map((part) => part.split('=')[0].trim())
                .filter(Boolean),
            ...authDetails,
        };
        console.error('[auth] callback failure', JSON.stringify(diagnostic));
        try {
            writeFileSync(path.join(HERE, '.auth-callback-error.json'), JSON.stringify(diagnostic, null, 2));
        } catch (writeError) {
            console.error('[auth] could not persist callback diagnostic:', writeError.message);
        }
    }
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

// Load the ViT in the background. It is a couple of seconds from the on-disk
// cache and closer to two minutes on a cold container, because the 327MB weight
// file has to come down first -- so starting it here means the first scan is
// not the request that pays for it. Nothing waits on this, and a failure is not
// fatal: /model-status reports the state and the log carries the reason.
preload().catch((err) => console.error('[inference] preload failed:', err.message));

for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => {
        console.log(`[api] ${sig} -- shutting down`);
        server.close(async () => {
            await closeDb();
            process.exit(0);
        });
    });
}
