/* ============================================================================
   FindFlower — reusable Wikidata plant-card engine (directory.js)
   ----------------------------------------------------------------------------
   directory.html grew a self-contained infinite-scroll grid backed by the
   Wikidata Query Service. Two more surfaces now want the SAME live plant cards:
   the dashboard's "Discover" feed (infinite) and the scanner page's mini
   directory (a fixed ~40-card grid). Rather than copy the query logic three
   times, this module exposes it once:

       window.ffDirectory.mount({ grid, ... })  ->  { start, stop }

   directory.html keeps its own battle-tested inline copy untouched (no reason
   to risk a working page); this module is the shared engine for the new embeds.

   Design notes carried over from directory.html, because they are load-bearing:
     • A fixed 20-family VALUES set, not `wdt:P31 wd:Q506`. Modelling means only
       ~35 entities are direct instances of "flowering plant"; the family join
       keeps the query fast (~5k species, 7-9s per 96-row chunk).
     • ORDER BY ?item is required — without a total order LIMIT/OFFSET pages
       overlap and infinite scroll repeats/skips cards.
     • The `seen` Set dedupes across pages (measured 37 dupes across two pages).
     • Commons thumbnails, never originals (originals are 5-20 MB each).
   ========================================================================== */
(function () {
    'use strict';

    var ENDPOINT = 'https://query.wikidata.org/sparql';
    var CHUNK = 96; // rows fetched per network call

    var FAMILIES = [
        'wd:Q25400',  'wd:Q46299',  'wd:Q25308',  'wd:Q44448',  'wd:Q53476',
        'wd:Q145869', 'wd:Q53480',  'wd:Q155941', 'wd:Q156551', 'wd:Q156888',
        'wd:Q173756', 'wd:Q975872', 'wd:Q155848', 'wd:Q25995',  'wd:Q134172',
        'wd:Q157115', 'wd:Q144723', 'wd:Q156060', 'wd:Q155802', 'wd:Q156179'
    ].join(' ');

    function buildQuery(limit, offset) {
        return 'SELECT ?item ?itemLabel ?img ?article ?famLabel WHERE {\n' +
            '  VALUES ?fam { ' + FAMILIES + ' }\n' +
            '  ?genus wdt:P171 ?fam .\n' +
            '  ?item wdt:P171 ?genus ;\n' +
            '        wdt:P105 wd:Q7432 ;\n' +
            '        wdt:P18 ?img .\n' +
            '  OPTIONAL { ?article schema:about ?item ; schema:isPartOf <https://en.wikipedia.org/> . }\n' +
            '  SERVICE wikibase:label { bd:serviceParam wikibase:language "en" }\n' +
            '}\n' +
            'ORDER BY ?item\n' +
            'LIMIT ' + limit + ' OFFSET ' + offset;
    }

    // Ask Commons for a scaled thumbnail — the originals are far too large.
    function thumb(url, width) {
        try {
            var m = decodeURIComponent(url).match(/Special:FilePath\/(.+)$/);
            if (!m) return url;
            return 'https://commons.wikimedia.org/wiki/Special:FilePath/' +
                encodeURIComponent(m[1]) + '?width=' + (width || 500);
        } catch (e) { return url; }
    }

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
    //   onCount(n)  called after each render with the running total
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
        var onCount  = typeof opts.onCount === 'function' ? opts.onCount : null;

        var buffer = [];        // fetched-but-unrendered rows
        var fetchOffset = 0;
        var treflePage = 0;     // last Trefle page fetched
        var rendered = 0;
        var exhausted = false;  // server returned a short chunk
        var loading = false;
        var prefetch = null;
        var seen = new Set();
        var io = null;

        // Trefle first (~164k species in the same twenty families, one fast
        // REST call), Wikidata as the fallback when the proxy is unreachable
        // or TREFLE_TOKEN is unset. opts.source: 'wikidata' pins the old path.
        var engine = (opts.source !== 'wikidata' && window.ffApi &&
            typeof ffApi.fetchTrefleBatch === 'function') ? 'trefle' : 'wikidata';

        function cardLink(s) {
            if (linkMode === 'wiki') {
                return { href: s.link, attrs: ' target="_blank" rel="noopener noreferrer"' };
            }
            return { href: 'species.html?name=' + encodeURIComponent(s.name), attrs: '' };
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

        function normalize(rows) {
            var out = [];
            for (var i = 0; i < rows.length; i++) {
                var r = rows[i];
                if (!r.item || !r.img) continue;
                var qid = r.item.value.split('/').pop();
                var label = r.itemLabel ? r.itemLabel.value : '';
                if (!label || /^Q\d+$/.test(label)) continue;
                out.push({
                    qid: qid,
                    name: label,
                    family: r.famLabel ? r.famLabel.value : '',
                    img: thumb(r.img.value, 500),
                    link: r.article ? r.article.value : ('https://www.wikidata.org/wiki/' + qid)
                });
            }
            return dedupe(out);
        }

        async function fetchChunk(offset) {
            var url = ENDPOINT + '?format=json&query=' + encodeURIComponent(buildQuery(CHUNK, offset));
            var res = await fetch(url, { headers: { Accept: 'application/sparql-results+json' } });
            if (!res.ok) throw new Error('WDQS ' + res.status);
            var data = await res.json();
            return data.results.bindings;
        }

        /** One page from the live catalogue, deduped, cursor advanced. */
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
            var rows = await fetchChunk(at);
            fetchOffset = at + CHUNK;
            if (rows.length < CHUNK) exhausted = true;
            return normalize(rows);
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
