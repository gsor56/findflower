// FindFlower social backend: Express over MongoDB Atlas.
//
// Text and ids only. Scan photos and avatars are held in the browser's
// IndexedDB, and the one image-shaped field here (a 160px avatar data URL) is
// capped in the schema.
//
//   npm start            # reads MONGO_URI from the repo-root .env
//   PORT=4000            # 3000 belongs to the QA harness's static server

import express from 'express';
import { connectDb, closeDb } from './db.js';
import { seedDefaultSpaces } from './models/space.js';
import postsRouter from './routes/posts.js';
import spacesRouter from './routes/spaces.js';
import usersRouter from './routes/users.js';
import friendsRouter from './routes/friends.js';
import messagesRouter from './routes/messages.js';
import searchRouter from './routes/search.js';

const PORT = Number(process.env.PORT) || 4000;
// Render needs every interface. A local run wants loopback only, so nothing on
// the network can reach a server pointed at the live cluster.
const HOST = process.env.HOST || '0.0.0.0';

// Browsers must be named, not wildcarded: these routes read an Authorization
// header, and `Access-Control-Allow-Origin: *` cannot carry credentials.
const ORIGINS = new Set([
    'https://findflower.me',
    'https://www.findflower.me',
    'http://127.0.0.1:3000',
    'http://localhost:3000',
    ...String(process.env.FF_ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean),
]);

const app = express();

// Render terminates TLS at its edge, so req.ip is the proxy's address unless
// this is set -- and a rate limiter that sees one address sees one user.
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

// 256KB covers a 280-character bio, a 2000-character post and a capped avatar
// with room to spare. The default 100KB does not fit the avatar.
app.use(express.json({ limit: '256kb' }));

app.get('/health', (req, res) => {
    res.json({ status: 'ok', service: 'findflower-social' });
});

app.use('/api/posts', postsRouter);
app.use('/api/spaces', spacesRouter);
app.use('/api/users', usersRouter);
app.use('/api/friends', friendsRouter);
app.use('/api/messages', messagesRouter);
app.use('/api/search', searchRouter);

app.use((req, res) => {
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
