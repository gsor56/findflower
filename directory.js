(function () {
    'use strict';

    function mount(opts) {
        opts = opts || {};
        var grid = opts.grid;
        if (!grid) return { start: function () {}, stop: function () {} };
        if (!window.ffUi || typeof ffUi.plantCardHTML !== 'function') {
            console.error('ffDirectory.mount: scripts/ui.js is not loaded.');
            if (opts.errorBox) opts.errorBox.classList.remove('hidden');
            return { start: function () {}, stop: function () {} };
        }
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

        var buffer = [];
        var fetchOffset = 0;
        var treflePage = 0;
        var rendered = 0;
        var exhausted = false;
        var loading = false;
        var prefetch = null;
        var seen = new Set();
        var io = null;

        var engine = (opts.source !== 'wikidata' &&
            typeof ffApi.fetchTrefleBatch === 'function') ? 'trefle' : 'wikidata';

        function cardLink(s) {
            if (linkMode === 'wiki') {
                return { href: s.link, attrs: ' target="_blank" rel="noopener noreferrer"' };
            }
            return { href: '/species?name=' + encodeURIComponent(s.name), attrs: '' };
        }

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

        async function fetchNext() {
            if (engine === 'trefle') {
                try {
                    var res = await ffApi.fetchTrefleBatch(treflePage + 1);
                    treflePage += 1;
                    if (!res.hasMore) exhausted = true;
                    return dedupe(res.items);
                } catch (err) {
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
            for (var i = 0; i < 5 && buffer.length < BATCH && !exhausted; i++) {
                var items = await fetchNext();
                buffer.push.apply(buffer, items);
            }
        }

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
                cells += '<div class="ff-skel bg-white border border-neutral-200 rounded-lg overflow-hidden">' +
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

        var CULL_MARGIN = 2500;
        function cullOffscreen() {
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
                if (onError) { try { onError(err, rendered); } catch (e) { } }
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
