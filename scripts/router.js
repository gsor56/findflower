/* ============================================================================
   FindFlower — client-side router (scripts/router.js)
   ----------------------------------------------------------------------------
   Turns 14 real HTML pages into an SPA without giving up any of them.

   The approach is fetch-and-swap, not a template-literal shell. A click on an
   internal link is intercepted, the target page is fetched, its <main> replaces
   the current one, and history.pushState puts the REAL url in the bar. So:

     • every page stays a complete document on disk — crawlers, sitemap.xml and
       a reader with JS disabled all still get served full HTML
     • deep links keep working, because /directory.html is still /directory.html
     • no build step, which this repo does not have

   What this costs, and how it is paid.

   Every page on this site keeps its <script> and <style> OUTSIDE <main> — in
   <head> and at the end of <body> (measured: 0 of 12 routable pages have a
   script inside <main>). So a <main>-only swap brings across markup and nothing
   else, and the page arrives inert: /directory.html showed an empty #dirGrid
   stuck on "Loading species…" because ffApi/ffDirectory were never loaded, and
   /index.html rendered with .ambient-glow at position:static because its 6.7KB
   <style> block stayed behind. runScripts() and adoptStyles() therefore work
   from the whole fetched DOCUMENT, not from the swapped region.

   Inline <script> in fetched HTML does not run when injected as markup, so the
   router re-executes it. Each block is wrapped in an IIFE because a classic
   script's top-level `const` would otherwise collide with the previous visit's
   declarations in the same realm. Eleven of twelve pages also gate their init on
   DOMContentLoaded, which has long since fired by the time a swap happens — so
   those registrations are captured and invoked (see runDomReady).

   try.html is deliberately NOT routed. Its scanner is one ~700-line inline
   block holding the Hugging Face inference path, and re-running it is exactly
   the kind of change that breaks inference quietly. It is listed in RELOAD
   below and navigates for real. Lift that entry only after the scanner is
   extracted into scripts/views/scanner.js and verified.

   GitHub Pages notes (measured against the live findflower.me, 2026-08-10).

     • Paths need no rewriting. Pages serves this repo at the domain ROOT, not
       under /<repo>/, and every internal href is already relative. The router
       fetches url.href from internalUrl(), which resolves against
       location.href and rejects anything cross-origin, so there is no
       absolute-vs-relative case to fix. Verified: /directory.html,
       /try.html and every scripts/* asset answer 200, a live swap lands on
       /directory.html with exactly one <main>, and zero network failures or
       console errors were captured across the run. There is no <base> tag on
       any page.
     • Pretty URLs already resolve. Pages serves /try and /directory without
       the extension (200), and pageKey() reads the last path segment, so
       /try, /try/ and /try.HTML all key to try.html. /try/ and /directory/
       with a trailing slash are 404s at the CDN, not router cases.
     • A 404 is a document, not a redirect. Pages answers an unknown path with
       its own 404 page at HTTP 404, so the swap fetch throws and navigate()'s
       catch hands the URL to the browser. Confirmed with a sentinel global
       that disappears.
     • Swap fetches are cache: 'no-store'. Pages serves HTML with
       Cache-Control: max-age=600, and a pushState URL must not paint markup
       cached under a different app version than the scripts now in memory.

   RELOAD is matched two ways for defence in depth -- by page key, and by
   RELOAD_PATH against any `try`/`login` path segment. See mustReload().

   Views register a lifecycle so a route can set up and tear down:

       window.ffViews['dashboard.html'] = { mount: fn, unmount: fn };

   unmount is what stops the camera and disconnects observers on the way out —
   without it an IntersectionObserver from the directory keeps firing against a
   grid that is no longer in the document.
   ========================================================================== */
(function () {
    'use strict';

    // Pages that must not be swapped in. try.html carries the ViT path; login
    // completes an Auth0 redirect and needs a real document to land on.
    var RELOAD = { 'try.html': 1, 'login.html': 1 };

    // Belt to RELOAD's braces. pageKey() only ever looks at the LAST path
    // segment, so /try, /try/ and /try.HTML all resolve to try.html correctly
    // (verified against the live site) -- but /try/index.html resolves to
    // index.html and would have been swapped. No link on the site produces that
    // shape and GitHub Pages 404s it today, so this closes a hole rather than a
    // bug. Matching any `try` or `login` SEGMENT means a future pretty-URL or
    // directory-index layout cannot quietly route the scanner.
    var RELOAD_PATH = /(^|\/)(try|login)(\.html?)?(\/|$)/i;

    /** Must this path get a real document load rather than a swap? */
    function mustReload(pathname) {
        return !!RELOAD[pageKey(pathname)] || RELOAD_PATH.test(String(pathname || ''));
    }

    /** Leave the SPA for good: a full document load, no swap, no history games.
     *  Used for try.html/login.html and for every failure fallback. */
    function hardLoad(href) {
        window.location.assign(href);
    }

    var MAIN = 'main';
    // Body-level, page-owned elements outside <main> that must travel with a
    // swap. Only dashboard.html has one (#authWall, the signed-out overlay):
    // without this its inline init() calls $('authWall') on a null node.
    var EXTRA = '[data-ff-page]';
    var current = null;   // { key: 'dashboard.html', view: {...} } for the mounted route

    window.ffViews = window.ffViews || {};

    /** Filename that identifies a page. "/" and "/dashboard" both normalise to
     *  the .html file, matching how nav.js resolves the active tab. */
    function pageKey(pathname) {
        var path = String(pathname || '').replace(/\/+$/, '');
        var file = path.substring(path.lastIndexOf('/') + 1).toLowerCase();
        if (!file) return 'index.html';
        if (file.indexOf('.') === -1) return file + '.html';
        return file;
    }

    /** Same-origin http(s) URL, or null. Anything else (mailto:, tel:, another
     *  host, a protocol-relative link) is left to the browser. */
    function internalUrl(href, base) {
        if (!href) return null;
        var u;
        try { u = new URL(href, base || location.href); } catch (e) { return null; }
        if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
        if (u.origin !== location.origin) return null;
        return u;
    }

    // ---- style adoption ----------------------------------------------------
    // Each page ships its own <style> in <head> (index.html 6.7KB, api.html
    // 2.1KB, ...) defining .reveal-up, .hover-lift, .ambient-glow, .grid-dots
    // and friends. app.css does NOT contain them. A <main>-only swap leaves
    // those rules behind, so index.html arrived with .ambient-glow at
    // position:static and .card-in stuck at opacity:0 -- content that never
    // becomes visible. Adopt the fetched document's head <style> blocks,
    // keyed by page so a return visit reuses the same node.
    var adoptedStyle = {};

    function adoptStyles(key, doc) {
        if (adoptedStyle[key]) return;
        var blocks = doc.head ? doc.head.querySelectorAll('style') : [];
        if (!blocks.length) { adoptedStyle[key] = 1; return; }
        for (var i = 0; i < blocks.length; i++) {
            var s = document.createElement('style');
            s.setAttribute('data-ff-page-style', key);
            s.textContent = blocks[i].textContent;
            document.head.appendChild(s);
        }
        adoptedStyle[key] = 1;
        // Page styles accumulate rather than swap out. They are authored as
        // page-scoped class rules (.reveal-up, .grid-dots) with identical
        // definitions where they overlap, so keeping them is harmless and
        // cheaper than re-parsing on every back/forward.
    }

    // ---- script re-execution ------------------------------------------------
    // Markup injected via innerHTML never runs its <script> tags, and the
    // scripts that matter are not even inside <main>: every page keeps them in
    // <head> and at the end of <body>. So this walks the whole fetched DOCUMENT.
    //
    // External srcs are loaded once and then skipped: the modules this site uses
    // (ffApi, ffUi, ffDirectory, species.js) are idempotent IIFEs that publish
    // onto window, so re-running them would only rebuild identical objects.
    var loadedSrc = {};

    // Record what the first document already had, so the first swap does not
    // re-fetch scripts that are demonstrably present.
    (function seedLoaded() {
        var tags = document.querySelectorAll('script[src]');
        for (var i = 0; i < tags.length; i++) {
            var u = internalUrl(tags[i].getAttribute('src'));
            if (u) loadedSrc[u.pathname] = 1;
        }
    })();

    function loadScript(src) {
        return new Promise(function (resolve) {
            var s = document.createElement('script');
            s.src = src;
            // Resolve on error too: a missing optional module must not wedge a
            // navigation. The consuming view guards for its own dependency.
            s.onload = s.onerror = function () { resolve(); };
            document.head.appendChild(s);
        });
    }

    /** Run one inline block. Wrapped in an IIFE so a second visit's top-level
     *  `const` does not collide with the first visit's in this realm. */
    function runInline(code) {
        var s = document.createElement('script');
        s.textContent = '(function(){\n' + code + '\n})();';
        try {
            document.head.appendChild(s);
        } catch (e) {
            console.error('router: inline script failed', e);
        }
        if (s.parentNode) s.parentNode.removeChild(s);
    }

    // DOMContentLoaded has already fired by the time a swap happens, so an
    // inline block that only registers a listener for it would do nothing at
    // all -- and 11 of 12 pages gate their init that way (reveal observers,
    // form wiring, TOC highlighting, species lookup). Intercept the
    // registration for the duration of the re-run and invoke the callbacks by
    // hand. document.readyState is left alone: a page that branches on it
    // ('loading' ? listen : run now) correctly takes the run-now path.
    function withDomReadyCaptured(fn) {
        var captured = [];
        var real = document.addEventListener;
        document.addEventListener = function (type) {
            if (type === 'DOMContentLoaded' && typeof arguments[1] === 'function') {
                captured.push(arguments[1]);
                return;
            }
            return real.apply(document, arguments);
        };
        try {
            fn();
        } finally {
            document.addEventListener = real;
        }
        return captured;
    }

    /** Re-run the fetched document's scripts. `doc` is the whole parsed page,
     *  not the swapped fragment — see the note above. Skips the Tailwind Play
     *  CDN and its tailwind.config block: the CDN is already loaded and
     *  running, and re-assigning tailwind.config after boot has no effect
     *  (verified: utilities absent from the served HTML still resolve, so the
     *  JIT observer covers swapped-in markup). */
    async function runScripts(doc) {
        var tags = doc.querySelectorAll('script');
        var pending = [];

        for (var i = 0; i < tags.length; i++) {
            var tag = tags[i];
            var src = tag.getAttribute('src');

            if (src) {
                if (/cdn\.tailwindcss\.com/.test(src)) continue;
                var u = internalUrl(src);
                var key = u ? u.pathname : src;
                if (loadedSrc[key]) continue;
                loadedSrc[key] = 1;
                await loadScript(src);
                continue;
            }

            var code = tag.textContent;
            if (!code || !code.trim()) continue;
            if (/^\s*tailwind\.config\s*=/.test(code)) continue;
            // data-ff-once marks a block that must run on a real page load but
            // NOT on a swap, because a view module owns that behaviour on a
            // router visit. directory.html's inline grid engine is the only one:
            // re-running it would race a second engine onto the same #dirGrid.
            if (tag.hasAttribute('data-ff-once')) continue;
            pending.push(code);
        }

        // Run every inline block with DOMContentLoaded captured, then fire the
        // collected callbacks in registration order -- the same order a real
        // load would have used.
        var callbacks = withDomReadyCaptured(function () {
            for (var j = 0; j < pending.length; j++) runInline(pending[j]);
        });
        for (var k = 0; k < callbacks.length; k++) {
            try { callbacks[k](new Event('DOMContentLoaded')); }
            catch (e) { console.error('router: page init failed', e); }
        }
    }

    // ---- view lifecycle -----------------------------------------------------

    function unmountCurrent() {
        if (!current) return;
        var v = current.view;
        current = null;
        if (v && typeof v.unmount === 'function') {
            // A throwing teardown must not strand the router mid-navigation, or
            // the next route mounts on top of a half-lived one.
            try { v.unmount(); } catch (e) { console.error('router: unmount failed', e); }
        }
    }

    async function mountFor(key, initial) {
        var v = window.ffViews[key];
        current = { key: key, view: v || null };
        if (v && typeof v.mount === 'function') {
            // `initial` separates the first, server-rendered paint from a router
            // swap. It is load-bearing, not informational: on a real load each
            // page's own inline script still runs and owns its first paint, so a
            // view that also renders would double up. Measured before this
            // existed: directory.html painted 24 cards for a 12-card batch,
            // because the inline engine and the view engine both ran.
            try { await v.mount({ initial: !!initial }); }
            catch (e) { console.error('router: mount failed', e); }
        }
    }

    // The initial page was rendered by the server, so mount its view without
    // any swapping. Everything after this goes through navigate().
    async function mountInitial() {
        await mountFor(pageKey(location.pathname), true);
    }

    // ---- navigation ---------------------------------------------------------

    var navSeq = 0;      // guards against an older fetch resolving last
    var inFlight = false;

    /** Fetch `url`, swap its <main>, run its scripts, mount its view.
     *  `push` false means we are restoring a history entry (back/forward). */
    async function navigate(url, push) {
        var key = pageKey(url.pathname);
        var seq = ++navSeq;

        var host = document.querySelector(MAIN);
        if (!host) { hardLoad(url.href); return; }

        inFlight = true;
        document.documentElement.classList.add('ff-routing');
        try {
            // credentials same-origin, and no-store on the SWAP fetch only: a
            // pushState URL must never render markup the browser cached under a
            // different app version. GitHub Pages serves html with
            // `Cache-Control: max-age=600`, so without this a swap could paint a
            // ten-minute-old <main> against freshly loaded scripts.
            var res = await fetch(url.href, {
                credentials: 'same-origin',
                cache: 'no-store',
                headers: { 'Accept': 'text/html' },
            });
            if (!res.ok) throw new Error('HTTP ' + res.status);
            var html = await res.text();
            if (seq !== navSeq) return;   // superseded by a later click

            var doc = new DOMParser().parseFromString(html, 'text/html');
            var next = doc.querySelector(MAIN);
            if (!next) throw new Error('no <main> in ' + url.pathname);

            // Tear the old view down BEFORE its DOM leaves the document, so an
            // unmount can still read the nodes it was watching.
            unmountCurrent();

            if (push) history.pushState({ ff: 1 }, '', url.href);
            document.title = doc.title || document.title;

            // Styles first: adopting them after the swap would paint one frame
            // of unstyled content (.reveal-up starts at opacity:0, so the flash
            // is a blank page rather than a flicker).
            adoptStyles(key, doc);

            // Drop the previous page's body-level extras, then bring the new
            // page's across. Only dashboard.html has any (#authWall).
            var stale = document.querySelectorAll(EXTRA);
            for (var s = 0; s < stale.length; s++) stale[s].remove();

            host.replaceWith(next);

            var extras = doc.querySelectorAll(EXTRA);
            for (var x = 0; x < extras.length; x++) {
                next.parentNode.insertBefore(document.importNode(extras[x], true), next);
            }

            // A fragment in the destination is a request for a position, not for
            // the top of the document. "/#about" is the case that matters: both
            // nav.js and footer.js emit exactly that link from every route other
            // than the home page, and without this the reader landed on the hero
            // and had to hunt for the section they had just asked for.
            // getElementById rather than querySelector(url.hash) because an id
            // that is not a valid selector makes querySelector throw, and this
            // sits in the try block that falls back to a full page load.
            var anchor = url.hash ? document.getElementById(url.hash.slice(1)) : null;
            // scroll-mt-24 on the target (index.html:923) is what keeps the
            // fixed 64px header off it; scrollIntoView honours scroll-margin.
            if (anchor) anchor.scrollIntoView();
            else window.scrollTo(0, 0);

            // The whole document, not just `next`: every page keeps its scripts
            // in <head> and at the end of <body>, never inside <main>.
            await runScripts(doc);
            if (seq !== navSeq) return;

            // The chrome lives outside <main>, so it survives the swap and has to
            // be told the route changed. Both builders take the same filename key.
            if (typeof window.ffNavSetActive === 'function') {
                try { window.ffNavSetActive(key); } catch (e) { /* chrome only */ }
            }
            if (typeof window.ffFooterSetActive === 'function') {
                try { window.ffFooterSetActive(key); } catch (e) { /* chrome only */ }
            }
            await mountFor(key);
        } catch (e) {
            // Any failure falls back to a real navigation. The user gets the
            // page; they just pay a reload for it. This is also the 404 path on
            // GitHub Pages, which serves its own 404 document rather than a
            // redirect -- the fetch returns HTTP 404, we throw, and the browser
            // takes over and shows it.
            console.error('router: falling back to full load —', e.message);
            hardLoad(url.href);
        } finally {
            if (seq === navSeq) {
                inFlight = false;
                document.documentElement.classList.remove('ff-routing');
            }
        }
    }

    /** Programmatic navigation, for views that need to move the user. */
    function go(href) {
        var u = internalUrl(href);
        if (!u || mustReload(u.pathname)) { hardLoad(href); return; }
        navigate(u, true);
    }

    // ---- wiring -------------------------------------------------------------

    function onClick(e) {
        // Let the browser handle modified clicks: ctrl/cmd-click opens a tab,
        // and hijacking that is the single most irritating SPA bug.
        if (e.defaultPrevented || e.button !== 0 ||
            e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;

        var a = e.target && typeof e.target.closest === 'function'
            ? e.target.closest('a') : null;
        if (!a) return;
        if (a.hasAttribute('download') || a.getAttribute('target') === '_blank') return;
        if (a.hasAttribute('data-no-router')) return;

        var u = internalUrl(a.getAttribute('href'));
        if (!u) return;

        // A pure #fragment on the page we are already on is the browser's job,
        // and "/#about" from the nav drawer has to keep working -- the footer
        // links /about flat, the drawer still points at the home-page section.
        // Compared by route key rather than by raw pathname: that link says "/",
        // while a reader who typed /index.html has that as their pathname, and a
        // string compare would have refetched and swapped the very page they
        // were looking at just to reach a fragment inside it.
        if (u.hash && u.search === location.search &&
            pageKey(u.pathname) === pageKey(location.pathname)) return;

        var key = pageKey(u.pathname);
        if (mustReload(u.pathname)) return;    // try.html / login.html: real load
        if (!window.ffViews && !document.querySelector(MAIN)) return;

        e.preventDefault();
        if (u.href === location.href) return; // already here
        navigate(u, true);
    }

    function onPopState() {
        // Restoring an entry: the URL has already changed, so re-fetch it and
        // swap, without pushing a new entry.
        var u = internalUrl(location.href);
        if (!u) return;
        if (mustReload(u.pathname)) { location.reload(); return; }
        navigate(u, false);
    }

    function boot() {
        // Feature gate: without these the fetch-and-swap cannot work, and a
        // partial implementation is worse than plain navigation.
        if (!window.fetch || !window.history || !history.pushState ||
            !window.DOMParser || !document.querySelector(MAIN)) {
            mountInitial();
            return;
        }
        document.addEventListener('click', onClick);
        window.addEventListener('popstate', onPopState);
        mountInitial();
    }

    window.ffRouter = {
        go: go,
        navigate: function (href) { go(href); },
        pageKey: pageKey,
        mustReload: mustReload,
        register: function (key, view) { window.ffViews[key] = view; },
        get busy() { return inFlight; },
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot);
    } else {
        boot();
    }
})();

