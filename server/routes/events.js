// GET /api/events -- the live stream a signed-in tab keeps open.
//
// One endpoint for every live update (new direct message, new friend request)
// rather than one per feature: a browser on the free tier is allowed a small
// number of parallel connections to a host, and a page that opens three streams
// starves its own image loads.

import { Router } from 'express';
import { requireViewer } from '../lib.js';
import { subscribe, connectionCount } from '../lib/events.js';

const router = Router();

router.get('/', requireViewer, function openStream(req, res) {
    res.status(200).set({
        'Content-Type': 'text/event-stream; charset=utf-8',
        // no-transform matters: a compressing proxy that buffers the stream
        // would hold messages until the connection closed, which is the exact
        // opposite of what this endpoint is for.
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        // Belt and braces for an upstream that reads this instead of the
        // Cache-Control directive.
        'X-Accel-Buffering': 'no',
    });
    res.flushHeaders();
    // An immediate comment flushes the headers so the client's open event fires
    // now rather than at the first message.
    res.write(': connected\n\n');

    let off;
    try {
        off = subscribe(req.viewer._id, res);
    } catch (err) {
        res.write('event: error\ndata: ' + JSON.stringify({ error: err.message }) + '\n\n');
        res.end();
        return;
    }

    req.on('close', off);
    req.on('error', off);
});

/** A tiny readout so /health can report whether the stream layer is in use. */
router.get('/count', function count(req, res) {
    res.json({ streams: connectionCount() });
});

export default router;
