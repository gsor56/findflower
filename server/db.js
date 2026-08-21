// Mongoose connection for the FindFlower social backend.
//
// This process is the routing and persistence layer only. Photos never arrive
// here: scan thumbnails and avatars stay in the browser's IndexedDB, and what
// crosses the wire is text plus the ids that join it together.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import mongoose from 'mongoose';
import dotenv from 'dotenv';

// The .env lives in the repo root, one level above server/, and this process
// gets started from either place -- `npm start` in here, a Render start command
// from the root. An explicit path beats depending on cwd. Render injects real
// environment variables instead, and dotenv never overwrites those.
const HERE = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(HERE, '..', '.env'), quiet: true });

let listening = false;
let closing = false;

/** Connection-level events, attached once. The initial connect is awaited and
 *  reported by connectDb(); these cover everything after it -- a dropped
 *  socket, a cluster failover, a paused free-tier cluster -- which arrive as
 *  events on an already-resolved connection and would otherwise be silent. */
function attachListeners() {
    if (listening) return;
    listening = true;
    const c = mongoose.connection;
    c.on('error', (err) => console.error('[db] connection error:', err.message));
    // Not on the way out: closeDb() drops the pool on purpose, and a warning
    // that fires on every clean shutdown is a warning people learn to ignore.
    c.on('disconnected', () => { if (!closing) console.warn('[db] disconnected'); });
    c.on('reconnected', () => console.log('[db] reconnected'));
}

export async function connectDb() {
    const uri = process.env.MONGO_URI;
    if (!uri) {
        throw new Error('MONGO_URI is not set. Add it to the repo-root .env, or to the Render dashboard.');
    }

    // Reject a query that filters on a path the schema does not declare, rather
    // than quietly returning everything.
    mongoose.set('strictQuery', true);
    attachListeners();

    try {
        await mongoose.connect(uri, {
            // The 30s default makes a wrong password or a paused cluster look
            // like a hang, and a platform health check gives up before it does.
            serverSelectionTimeoutMS: 8000,
            socketTimeoutMS: 45000,
            // Atlas free tier caps connections cluster-wide, so one web process
            // has no business holding the default pool of 100.
            maxPoolSize: 5,
        });
    } catch (err) {
        // err.message, never the URI: the connection string carries the password.
        console.error('[db] initial connection failed:', err.message);
        throw err;
    }

    const c = mongoose.connection;
    console.log(`[db] connected to "${c.name}" on ${c.host}`);
    return c;
}

/** Close the pool on the way out. Render sends SIGTERM on every redeploy; an
 *  unclosed pool leaves connections held on the cluster until they time out. */
export async function closeDb() {
    if (mongoose.connection.readyState === 0) return;
    closing = true;
    await mongoose.connection.close();
    console.log('[db] connection closed');
}

export { mongoose };
