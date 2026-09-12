// One live connection per page, shared by everything that wants updates.
//
// The server publishes new direct messages and friend-request changes on
// /api/events as Server-Sent Events. Three pages want those, so the connection
// lives here rather than in each of them: a browser only allows a handful of
// parallel connections to one host, and a page that opens its own stream per
// feature starves its own image loads.
//
// Signed-out visitors open nothing. The endpoint requires a session, and a
// stream that answers 401 four times a second is worse than no stream.
(function () {
    'use strict';

    var handlers = Object.create(null);
    var source = null;
    var attempt = 0;
    var started = false;

    function emit(event, data) {
        var list = handlers[event];
        if (!list) return;
        for (var i = 0; i < list.length; i += 1) {
            try { list[i](data); } catch (e) { /* one listener must not stop the rest */ }
        }
    }

    function connect() {
        if (source || typeof EventSource !== 'function') return;
        var es;
        try {
            es = new EventSource('/api/events', { withCredentials: true });
        } catch (e) {
            return;
        }
        source = es;

        es.addEventListener('open', function () {
            attempt = 0;
            emit('open', {});
        });

        ['message', 'friend'].forEach(function (name) {
            es.addEventListener(name, function (e) {
                var data = null;
                try { data = JSON.parse(e.data); } catch (err) { data = null; }
                emit(name, data);
            });
        });

        // EventSource reconnects by itself, but its own retry is a fixed 3s and
        // it does not back off. Closing and re-opening here is how a signed-out
        // tab, or a server that is still deploying, stops hammering the endpoint.
        es.addEventListener('error', function () {
            try { es.close(); } catch (e) { /* already closed */ }
            if (source === es) source = null;
            attempt = Math.min(attempt + 1, 6);
            setTimeout(connect, Math.min(30000, 1000 * Math.pow(2, attempt)));
        });
    }

    /** Subscribe to one event name. Returns an unsubscribe function. */
    function on(event, handler) {
        if (typeof handler !== 'function') return function () {};
        if (!handlers[event]) handlers[event] = [];
        handlers[event].push(handler);
        return function off() {
            handlers[event] = (handlers[event] || []).filter(function (h) { return h !== handler; });
        };
    }

    async function start() {
        if (started) return;
        started = true;
        var signedIn = false;
        try {
            if (typeof window.getUserSession === 'function') {
                signedIn = !!(await window.getUserSession()).authenticated;
            }
        } catch (e) {
            signedIn = false;
        }
        if (!signedIn) return;
        connect();
    }

    window.ffLive = {
        on: on,
        start: start,
        connected: function () { return !!source; },
    };

    // Deferred scripts run in document order, and this one is injected last, so
    // every listener that wants the live events has already registered by the
    // time this fires.
    try {
        document.dispatchEvent(new Event('fflive:ready'));
    } catch (e) { /* very old browser: listeners fall back to polling */ }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
    else start();

    // Closing on pagehide is what the browser expects; leaving it to the unload
    // path is what leaves a zombie stream counted against the per-user cap.
    window.addEventListener('pagehide', function () {
        if (!source) return;
        try { source.close(); } catch (e) { /* already gone */ }
        source = null;
    });
})();
