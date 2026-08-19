/* ============================================================================
   FindFlower — reusable Wikidata plant-card engine (directory.js)
   ----------------------------------------------------------------------------
   The site has four live plant grids: the encyclopedia (directory.html), the
   dashboard's "Discover" feed, the scanner page's mini directory, and the home
   preview. This module is the ONE engine behind them:

       window.ffDirectory.mount({ grid, ... })  ->  { start, stop }

   It owns paging, dedupe, buffering, rendering and culling. It does not own
   fetching or markup — scripts/api.js grabs the data and scripts/ui.js draws
   the card, so a change to either lands everywhere at once.

   directory.html used to carry a near-identical inline copy of all of this.
   It no longer does: that block is now a mount() call, so the encyclopedia and
   the embeds cannot drift apart. The one thing it still needs is the
   data-ff-once guard, because the router starts this same engine through
   scripts/views/directory.js on a swap and two engines on one #dirGrid would
   double-fetch every card.

   Load-bearing behaviour, kept here because it is easy to "simplify" away:
     • The `seen` Set dedupes across pages (measured 37 dupes across two
       Wikidata pages, whose LIMIT/OFFSET windows overlap).
     • A source switch is only legal before the first card paints — restarting
       the catalogue mid-scroll would repeat everything already scrolled past.
     • loadMore() never throws; it returns a painted count, which is what stops
       fill() from spinning at full speed against a dead network.
   ========================================================================== */
(function () {
    'use strict';

    // ---- mount: one embeddable, self-contained grid ------------------------
    // opts:
    //   grid      (required) container element cards are appended to
    //   sentinel  element observed to trigger more loads (infinite mode)
    //   spinner, endNote, errorBox, retryBtn, countEl  optional UI hooks
    //   infinite  keep loading on scroll (default true)
    //   max       hard cap on rendered cards (default Infinity)
    //   batch     cards rendered per step (default 12)
    //   cull      drop far-offscreen image sources to save memory (default true)
    //   link      'species' -> species.html?name=  |  'wiki' -> external article
    //   thumbWidth  Commons thumbnail width for Wikidata rows (default 500)
    //   onCount(n)  called after each render with the running total
    //   onError(err, rendered)  a page failed. errorBox already handles the
    //             nothing-rendered case; this is for surfaces that also want to
    //             say something when SOME cards are up (the encyclopedia turns
    //             its counter into "… · scroll to retry").
    function mount(opts) {
        opts = opts || {};
        var grid = opts.grid;
        if (!grid) return { start: function () {}, stop: function () {} };
        // Hard dependency: the card markup lives in scripts/ui.js. Fail here,
        // audibly, rather than render an empty grid with no explanation.
        if (!window.ffUi || typeof ffUi.plantCardHTML !== 'function') {
            console.error('ffDirectory.mount: scripts/ui.js is not loaded.');
            if (opts.errorBox) opts.errorBox.classList.remove('hidden');
            return { start: function () {}, stop: function () {} };
        }
        // Same rule for the data half. This used to be a soft dependency — no
        // ffApi just meant "use the SPARQL code in this file" — but that code
        // moved to api.js, so a missing api.js now leaves no catalogue at all.
        // Say so rather than run an engine that can only paint an empty grid.
        if (!window.ffApi || typeof ffApi.fetchWikidataBatch !== 'function') {
            console.error('ffDirectory.mount: scripts/api.js is not loaded.');
            if (opts.errorBox) opts.errorBox.classList.remove('hidden');
            return { start: function () {}, stop: function () {} };
        }

        var sentinel = opts.sentinel || null;
        var spinner  = opts.spinner || null;
        var endNote  = opts.endNote || null;
        var errorBox = opts.errorBox || null;
        var countEl  = opts.countEl || null;
        var infinite = opts.infinite !== false;
        var max      = opts.max || Infinity;
        var BATCH    = opts.batch || 12;
        var cull     = opts.cull !== false;
        var linkMode = opts.link || 'species';
        var thumbWidth = opts.thumbWidth || 500;
        var onCount  = typeof opts.onCount === 'function' ? opts.onCount : null;
        var onError  = typeof opts.onError === 'function' ? opts.onError : null;

        var buffer = [];        // fetched-but-unrendered rows
        var fetchOffset = 0;
        var treflePage = 0;     // last Trefle page fetched
        var rendered = 0;
        var exhausted = false;  // server returned a short chunk
        var loading = false;
        var prefetch = null;
        var seen = new Set();
        var io = null;

        // Trefle first: filtered to the same twenty families it holds ~164,000
        // species against roughly 5,000 reachable through Wikidata's taxon
        // graph, and answers a REST call in a fraction of a 7–9s SPARQL query.
        // Wikidata stays as the fallback so an unreachable or unconfigured
        // proxy degrades the page instead of emptying it.
        // opts.source: 'wikidata' pins the fallback (used by the tests).
        var engine = (opts.source !== 'wikidata' &&
            typeof ffApi.fetchTrefleBatch === 'function') ? 'trefle' : 'wikidata';

        function cardLink(s) {
            if (linkMode === 'wiki') {
                return { href: s.link, attrs: ' target="_blank" rel="noopener noreferrer"' };
            }
            return { href: '/species?name=' + encodeURIComponent(s.name), attrs: '' };
        }

        /** Drop anything already rendered. Keyed on QID where there is one,
         *  else the name -- Trefle records carry no Wikidata id. */
        function dedupe(items) {
            var out = [];
            for (var i = 0; i < items.length; i++) {
                var it = items[i];
                if (!it || !it.name) continue;
                var key = it.qid || ('n:' + String(it.name).trim().toLowerCase());
                if (seen.has(key)) continue;
                seen.add(key);
                out.push(it);
            }
            return out;
        }

        /** One page from the live catalogue, deduped, cursor advanced.
         *  Both branches call api.js, so the query and the REST contract live
         *  in one file; this function only decides WHICH source and WHEN to
         *  give up on it. Cursors advance only on success, so a failed page is
         *  retried rather than skipped — safe because ensureBuffer() and
         *  startPrefetch() never run a fetch concurrently. */
        async function fetchNext() {
            if (engine === 'trefle') {
                try {
                    var res = await ffApi.fetchTrefleBatch(treflePage + 1);
                    treflePage += 1;
                    if (!res.hasMore) exhausted = true;
                    // linkMode 'wiki' wants an external article; Trefle has no
                    // article URL, so those embeds keep the species page link
                    // api.js already set.
                    return dedupe(res.items);
                } catch (err) {
                    // Only switch before anything is on screen: restarting the
                    // catalogue from another source mid-scroll would repeat
                    // cards the user has already passed.
                    var known = window.ffApi && err instanceof ffApi.TrefleUnavailableError;
                    if (rendered || !known) throw err;
                    engine = 'wikidata';
                    seen.clear();
                }
            }
            var at = fetchOffset;
            var wd = await ffApi.fetchWikidataBatch(at, { thumbWidth: thumbWidth });
            fetchOffset = wd.nextOffset;
            if (!wd.hasMore) exhausted = true;
            return dedupe(wd.items);
        }

        function startPrefetch() {
            if (prefetch || exhausted) return;
            prefetch = fetchNext().then(function (items) {
                buffer.push.apply(buffer, items);
                prefetch = null;
            }).catch(function () { prefetch = null; });
        }

        async function ensureBuffer() {
            if (buffer.length >= BATCH || exhausted) return;
            if (prefetch) { await prefetch; return; }
            // A Trefle page is 20 rows against Wikidata's 96, and a page can be
            // deduped away entirely, so one fetch may not fill a batch.
            for (var i = 0; i < 5 && buffer.length < BATCH && !exhausted; i++) {
                var items = await fetchNext();
                buffer.push.apply(buffer, items);
            }
        }

        // Card markup lives in scripts/ui.js -- one design for every grid on
        // the site. cardLink() resolves linkMode here; ui.js then decides
        // target/rel from the href (external gets _blank + noopener).
        function cardHTML(s) {
            return ffUi.plantCardHTML({
                qid: s.qid,
                name: s.name,
                family: s.family,
                img: s.img,
                link: cardLink(s).href,
            });
        }

        function renderBatch() {
            var room = max - rendered;
            if (room <= 0) return 0;
            var slice = buffer.splice(0, Math.min(BATCH, room));
            if (!slice.length) return 0;
            grid.insertAdjacentHTML('beforeend', slice.map(cardHTML).join(''));
            rendered += slice.length;
            if (countEl) countEl.textContent = rendered + ' species';
            if (onCount) onCount(rendered);
            return slice.length;
        }

        function showSkeletons(n) {
            var cells = '';
            for (var i = 0; i < n; i++) {
                cells += '<div class="ff-skel bg-white border border-neutral-200 rounded-3xl overflow-hidden">' +
                    '<div class="aspect-[4/5] skeleton"></div>' +
                    '<div class="p-4 space-y-2"><div class="h-3 skeleton rounded"></div>' +
                    '<div class="h-3 w-2/3 skeleton rounded"></div></div></div>';
            }
            grid.insertAdjacentHTML('beforeend', cells);
        }
        function clearSkeletons() {
            var nodes = grid.querySelectorAll('.ff-skel');
            for (var i = 0; i < nodes.length; i++) nodes[i].remove();
        }

        // Drop far-offscreen image sources (frees decoded bitmaps) while keeping
        // the element box so scroll position stays stable. Infinite mode only.
        var CULL_MARGIN = 2500;
        function cullOffscreen() {
            // Trefle records have no QID, so match every card <article> --
            // skeletons are .ff-skel <div>s and are not selected.
            var cards = grid.querySelectorAll('article');
            var top = window.scrollY - CULL_MARGIN;
            var bottom = window.scrollY + window.innerHeight + CULL_MARGIN;
            for (var i = 0; i < cards.length; i++) {
                var card = cards[i];
                var img = card.querySelector('img');
                if (!img) continue;
                var y = card.offsetTop;
                var far = (y + card.offsetHeight < top) || (y > bottom);
                if (far && img.getAttribute('src')) {
                    img.dataset.src = img.getAttribute('src');
                    img.removeAttribute('src');
                } else if (!far && !img.getAttribute('src') && img.dataset.src) {
                    img.setAttribute('src', img.dataset.src);
                }
            }
        }

        function done() {
            return (exhausted && !buffer.length) || rendered >= max;
        }

        /** One step: top the buffer up if needed, then render a batch.
         *  Returns the number of cards rendered, 0 on failure or when there is
         *  nothing left. fill() reads that to know when to stop -- this function
         *  handles its own errors, so a caller cannot tell from a throw. */
        async function loadMore() {
            if (loading || done()) return 0;
            loading = true;
            if (errorBox) errorBox.classList.add('hidden');

            var needsNetwork = buffer.length < BATCH && !exhausted;
            if (needsNetwork) {
                if (spinner) spinner.classList.remove('hidden');
                showSkeletons(Math.min(BATCH, max - rendered));
            }

            var painted = 0;
            try {
                await ensureBuffer();
                clearSkeletons();
                painted = renderBatch();
                if (buffer.length < BATCH * 3) startPrefetch();

                if (done()) {
                    if (endNote && exhausted) endNote.classList.remove('hidden');
                    if (io) io.disconnect();
                }
            } catch (err) {
                clearSkeletons();
                if (!rendered && errorBox) errorBox.classList.remove('hidden');
                if (onError) { try { onError(err, rendered); } catch (e) { /* hook's problem */ } }
            } finally {
                if (spinner) spinner.classList.add('hidden');
                loading = false;
            }
            return painted;
        }

        function initObserver() {
            if (!infinite || !sentinel || !('IntersectionObserver' in window)) return;
            io = new IntersectionObserver(function (entries) {
                for (var i = 0; i < entries.length; i++) {
                    if (entries[i].isIntersecting) { loadMore(); return; }
                }
            }, { rootMargin: '600px 0px' });
            io.observe(sentinel);
        }

        var cullTimer = null;
        function onScroll() {
            if (cullTimer) return;
            cullTimer = setTimeout(function () { cullTimer = null; cullOffscreen(); }, 250);
        }

        // Fixed grids (infinite:false) have no scroll trigger, so they fill in a
        // loop. loadMore() reports 0 both when the source is spent and when a
        // request failed -- it never throws -- so stopping on 0 is what keeps a
        // dead network from spinning this loop at full speed. done() alone would
        // not: a failed fetch leaves exhausted false and the buffer empty.
        async function fill() {
            while (!done()) {
                var n = await loadMore();
                if (!n) return;
            }
        }

        async function start() {
            if (opts.retryBtn) {
                opts.retryBtn.addEventListener('click', function () {
                    if (errorBox) errorBox.classList.add('hidden');
                    if (infinite) loadMore();
                    else fill();
                });
            }
            if (infinite && cull) window.addEventListener('scroll', onScroll, { passive: true });
            initObserver();
            // Fill to the cap (fixed grid) or lay down the first batch (infinite,
            // after which the observer keeps it going).
            if (infinite) await loadMore();
            else await fill();
        }

        function stop() {
            if (io) io.disconnect();
            if (infinite && cull) window.removeEventListener('scroll', onScroll);
        }

        return { start: start, stop: stop, loadMore: loadMore };
    }

    window.ffDirectory = { mount: mount };
})();
