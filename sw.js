// Chrome will only offer to install a site whose service worker can answer a
// navigation with the network gone, so answering that one case is this whole
// file. It caches nothing: every script here is versioned with ?v=N, and a copy
// kept in here would outlive the next bump and serve yesterday's page forever.
//
// The reply is written out below rather than fetched from a page on the site,
// because Tailwind arrives from a CDN and app.css is not cached either, so a
// real page would land with no styling at all in the one situation it exists for.

const CACHE_VERSION = 'ff-offline-v2';

const OFFLINE_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>No connection | FindFlower</title>
<style>
  :root { color-scheme: light }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center;
         background: #FCFCFC; color: #171717; padding: 2rem 1.5rem;
         font-family: Inter, system-ui, -apple-system, "Segoe UI", sans-serif; }
  main { max-width: 26rem; text-align: left }
  .mark { display: flex; align-items: center; gap: .5rem; font-size: 1.125rem;
          font-weight: 500; letter-spacing: -.01em; }
  .mark svg { color: #4C6650 }
  h1 { font-size: 1.25rem; font-weight: 500; margin: 1.75rem 0 0 }
  p { font-size: .875rem; line-height: 1.6; color: #525252; margin: .5rem 0 0 }
  button { margin-top: 1.5rem; min-height: 44px; padding: 0 1.25rem;
           font: 500 .875rem Inter, system-ui, sans-serif; color: #FFF;
           background: #171717; border: 1px solid #171717; border-radius: .375rem;
           cursor: pointer; }
  button:hover { background: #262626 }
</style>
</head>
<body>
<main>
  <span class="mark">
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M12 21c0-4 0-7 0-9m0 0c0-3 2.5-5 6-5-.2 3.2-2.8 5-6 5Zm0 0c0-3-2.5-5-6-5 .2 3.2 2.8 5 6 5Z" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>
    FindFlower
  </span>
  <h1>This page needs a connection</h1>
  <p>Identifying a flower runs on the network, so nothing here works until the
     connection is back. Your saved scans are stored in this browser and are
     still there waiting.</p>
  <button type="button" onclick="location.reload()">Try again</button>
</main>
</body>
</html>`;

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (event) => {
    // A named version exists only so there is something to purge. Nothing is
    // cached under it (see the note at the top), so an installed PWA that
    // somehow kept a stale shell from an older build has exactly one way to
    // lose it: this activation deleting every cache that is not this name. The
    // version is bumped whenever a change here has to reach a phone without
    // waiting for the browser to decide the worker has changed on its own.
    event.waitUntil((async () => {
        try {
            const names = await caches.keys();
            await Promise.all(names.filter((name) => name !== CACHE_VERSION).map((name) => caches.delete(name)));
        } catch (e) {
            // No CacheStorage in this context: nothing was cached, so there is
            // nothing to drop, and the activation must still finish.
        }
        await self.clients.claim();
    })());
});

self.addEventListener('fetch', (event) => {
    const req = event.request;
    if (req.method !== 'GET' || req.mode !== 'navigate') return;
    event.respondWith(
        fetch(req).catch(() => new Response(OFFLINE_PAGE, {
            status: 200,
            headers: { 'content-type': 'text/html; charset=utf-8' },
        }))
    );
});
