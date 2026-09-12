// Server-Sent Events fan-out for chat, notifications and unread badges.
//
// SSE rather than a WebSocket on purpose. One long-lived HTTP response per open
// tab needs no upgrade handshake, crosses the Cloudflare Worker as an ordinary
// streamed response (no WebSocket protocol handling in the Worker, no proxy
// rewrite to keep in sync), and adds no second socket stack to a container that
// has 3GB in total. The resident cost is one response object per connected tab,
// which is what the caps below bound.
//
// The bus is deliberately in-process: this deployment is a single Node instance,
// so a fan-out that needs Redis would buy a dependency and no reach. If it ever
// runs two instances, this file is the one that changes.

const MAX_PER_USER = 4;      // a user with five stale tabs should not hold five
const MAX_TOTAL = 400;       // ~400 response objects is a few MB, not a few hundred
const HEARTBEAT_MS = 25_000; // under the 30s idle cut most proxies apply to a stream
const MAX_BUFFERED = 1 << 20;

/** userId (string) -> Set<res> */
const channels = new Map();
let total = 0;
let heartbeat = null;

function frame(event, data) {
    return 'event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n';
}

function stopHeartbeatIfIdle() {
    if (total || !heartbeat) return;
    clearInterval(heartbeat);
    heartbeat = null;
}

function drop(userId, res) {
    const set = channels.get(userId);
    if (!set) return;
    if (set.delete(res)) total -= 1;
    if (!set.size) channels.delete(userId);
    stopHeartbeatIfIdle();
}

function ensureHeartbeat() {
    if (heartbeat) return;
    // One interval for every connection rather than one per client: a comment
    // line is all it takes to keep a proxy from treating the stream as idle,
    // and this costs no application work.
    heartbeat = setInterval(() => {
        for (const [userId, set] of channels) {
            for (const res of set) {
                try {
                    res.write(': ping\n\n');
                } catch {
                    drop(userId, res);
                }
            }
        }
    }, HEARTBEAT_MS);
    if (heartbeat.unref) heartbeat.unref();
}

/**
 * Attach one open response to a user's channel.
 *
 * @returns {() => void} the unsubscribe function; call it on request close.
 */
export function subscribe(userId, res) {
    const key = String(userId);
    if (total >= MAX_TOTAL) {
        // Refuse rather than grow without bound. The client reconnects with
        // backoff and will get a slot on a later attempt.
        throw new Error('Too many live streams open.');
    }
    let set = channels.get(key);
    if (!set) {
        set = new Set();
        channels.set(key, set);
    }
    while (set.size >= MAX_PER_USER) {
        // Oldest tab loses its slot; the browser reconnects it on its own.
        const oldest = set.values().next().value;
        set.delete(oldest);
        total -= 1;
        try { oldest.end(); } catch { /* already gone */ }
    }
    set.add(res);
    total += 1;
    ensureHeartbeat();
    return () => drop(key, res);
}

/**
 * Write one event to every tab belonging to any of `userIds`.
 *
 * Failures are per-recipient: a dead socket drops that one subscription and
 * never stops the others from being told.
 */
export function publish(userIds, event, data) {
    if (!total) return 0;
    const payload = frame(event, data);
    let sent = 0;
    for (const id of userIds) {
        const key = String(id);
        const set = channels.get(key);
        if (!set) continue;
        for (const res of Array.from(set)) {
            try {
                if (res.writableLength > MAX_BUFFERED) throw new Error('stream backed up');
                res.write(payload);
                sent += 1;
            } catch {
                drop(key, res);
            }
        }
    }
    return sent;
}

/** Live connection count, for the health payload. */
export function connectionCount() {
    return total;
}
