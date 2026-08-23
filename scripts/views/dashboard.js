/* ============================================================================
   FindFlower — dashboard view (scripts/views/dashboard.js)
   ----------------------------------------------------------------------------
   The herbarium: every plant the signed-in user has saved, read from IndexedDB
   and rendered here rather than shipped as markup.

   Scope note. dashboard.html's inline script already owns the profile card,
   the metric tiles and the badge wall, and it works. This module owns exactly
   one thing — the saved-discovery grid — plus the route lifecycle:

       ffViews['dashboard.html'] = { mount, unmount }

   unmount is the load-bearing half. The Discover feed mounts an
   IntersectionObserver through ffDirectory; without a teardown it keeps firing
   against a grid that has already been swapped out of the document, fetching
   Trefle pages nobody will ever see.

   User isolation is not this file's job to enforce and it deliberately does not
   try: ffStore.getDiscoveries(userId) reads through a [userId, timestamp] index,
   so another account's rows are never loaded into memory at all. Passing no id
   resolves the active Auth0 sub inside storage.js. A filter here would be a
   second, weaker copy of a guarantee that is already structural.
   ========================================================================== */
(function () {
    'use strict';

    var esc = (window.ffUi && ffUi.esc) ? ffUi.esc : function (s) {
        return String(s === null || s === undefined ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    };

    function titleCase(s) {
        return String(s || '').replace(/\b\w/g, function (c) { return c.toUpperCase(); });
    }

    /** "3 hours ago" / "Yesterday" / "12 Mar" — short enough for a card. */
    function relTime(iso) {
        var then = new Date(iso);
        if (isNaN(then.getTime())) return '';
        var mins = Math.floor((Date.now() - then.getTime()) / 60000);
        if (mins < 1) return 'Just now';
        if (mins < 60) return mins + ' min ago';
        var hrs = Math.floor(mins / 60);
        if (hrs < 24) return hrs + (hrs === 1 ? ' hour ago' : ' hours ago');
        var days = Math.floor(hrs / 24);
        if (days === 1) return 'Yesterday';
        if (days < 7) return days + ' days ago';
        return then.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
    }

    var FLOWER_PATH = 'M12 21c0-4 0-7 0-9m0 0c0-3 2.5-5 6-5-.2 3.2-2.8 5-6 5Zm0 0c0-3-2.5-5-6-5 .2 3.2 2.8 5 6 5Z';

    /** One saved plant. Card markup is local rather than ffUi.plantCardHTML:
     *  that renders a CATALOGUE species (family, external article link), while a
     *  saved scan shows the user's own photo, when they found it, and how sure
     *  the model was. Different data, different card. */
    function savedCardHTML(scan) {
        if (!scan || !scan.species) return '';
        var pct = typeof scan.confidence === 'number'
            ? Math.round(scan.confidence * 100) + '%' : '';
        var thumb = scan.imageBase64
            ? '<img src="' + esc(scan.imageBase64) + '" alt="" class="w-full h-full object-cover">'
            : '<div class="w-full h-full flex items-center justify-center bg-sage-50">' +
              '<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
              'stroke-width="1.4" class="text-sage-400"><path d="' + FLOWER_PATH + '"/></svg></div>';

        var name = titleCase(scan.species);
        return '<article class="bg-white border border-neutral-200 rounded-lg overflow-hidden">' +
            '<a href="/species?name=' + encodeURIComponent(name) + '" class="block">' +
                '<div class="aspect-square bg-neutral-100">' + thumb + '</div>' +
            '</a>' +
            '<div class="p-3">' +
                '<h3 class="font-medium text-sm text-neutral-900 leading-snug line-clamp-2">' +
                    esc(name) + '</h3>' +
                '<div class="flex items-center justify-between mt-1.5">' +
                    '<span class="text-xs text-neutral-400">' + esc(relTime(scan.timestamp)) + '</span>' +
                    (pct ? '<span class="text-xs font-medium text-sage-700 bg-sage-50 px-1.5 py-0.5 rounded">' +
                        esc(pct) + '</span>' : '') +
                '</div>' +
            '</div>' +
        '</article>';
    }

    var EMPTY_HTML =
        '<div class="border border-dashed border-neutral-300 rounded-lg p-10 text-center">' +
            '<svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
                'stroke-width="1.3" class="text-neutral-300 mx-auto mb-3">' +
                '<path d="' + FLOWER_PATH + '"/></svg>' +
            '<p class="text-neutral-500 font-light">Your herbarium is empty.</p>' +
            '<a href="/try" class="inline-flex items-center justify-center mt-4 min-h-[44px] px-6 ' + 'rounded-full bg-neutral-900 text-white text-sm font-medium hover:bg-neutral-800 ' + 'transition-colors">Start scanning</a>' +
        '</div>';

    /**
     * Render the saved-discovery grid.
     *
     * userId is optional — omitted, storage.js resolves the active Auth0 sub.
     * Returns the number of cards rendered so a caller can decide whether to
     * offer the Discover feed instead.
     */
    async function renderDiscoveries(opts) {
        var o = opts || {};
        var grid = o.grid || document.getElementById('recentGrid');
        var empty = o.empty || document.getElementById('recentEmpty');
        if (!grid) return 0;

        if (!window.ffStore || typeof ffStore.getDiscoveries !== 'function') {
            console.error('views/dashboard: storage.js is not loaded.');
            return 0;
        }

        var scans = [];
        try {
            scans = await ffStore.getDiscoveries(o.userId) || [];
        } catch (e) {
            // IndexedDB can be unavailable outright (private windows, blocked
            // storage). An honest empty state beats a spinner that never ends.
            console.error('views/dashboard: could not read discoveries', e);
            scans = [];
        }

        var shown = typeof o.limit === 'number' ? scans.slice(0, o.limit) : scans;
        var cards = shown.map(savedCardHTML).filter(Boolean);

        if (!cards.length) {
            grid.classList.add('hidden');
            grid.innerHTML = '';
            if (empty) {
                empty.classList.remove('hidden');
                if (!empty.innerHTML.trim()) empty.innerHTML = EMPTY_HTML;
            }
            return 0;
        }

        if (empty) empty.classList.add('hidden');
        grid.classList.remove('hidden');
        grid.innerHTML = cards.join('');
        return cards.length;
    }

    // ---- route lifecycle ----------------------------------------------------
    // The Discover feed's observer is the reason unmount() exists. mount() is a
    // no-op on a normal page load because dashboard.html's own inline init()
    // runs and owns the first paint; this is what re-runs on a router revisit,
    // where that inline script has already executed once in this realm.

    var mounted = false;

    async function mount(ctx) {
        mounted = true;
        // On a real load dashboard.html's inline init() owns the first paint.
        if (ctx && ctx.initial) return;
        // Only paint if the inline script has not already done so this visit.
        var grid = document.getElementById('recentGrid');
        if (grid && !grid.innerHTML.trim() && !grid.classList.contains('hidden')) {
            await renderDiscoveries({ limit: 6 });
        }
        // The panel hosts arrive empty inside the swapped-in <main>, and the
        // inline init() that filled them on the first load does not run again.
        // No session is passed: with no id, storage.js resolves the active user
        // itself, which is the same answer init() would have handed over.
        if (window.ffPanels && document.getElementById('panelPrefs')) {
            window.ffPanels.mount();
        }
    }

    function unmount() {
        mounted = false;
        // Stop the Discover feed: its IntersectionObserver would otherwise keep
        // pulling Trefle pages into a grid that has left the document.
        if (window.ffDiscoverHandle && typeof ffDiscoverHandle.stop === 'function') {
            try { ffDiscoverHandle.stop(); } catch (e) { /* already stopped */ }
            window.ffDiscoverHandle = null;
        }
        // The Preferences panel keeps a delegated click handler on its host.
        if (window.ffPanels) {
            try { ffPanels.unmount(); } catch (e) { /* nothing mounted */ }
        }
    }

    window.ffViews = window.ffViews || {};
    window.ffViews['dashboard.html'] = { mount: mount, unmount: unmount };

    window.ffDashboardView = {
        renderDiscoveries: renderDiscoveries,
        savedCardHTML: savedCardHTML,
        relTime: relTime,
        get mounted() { return mounted; },
    };
})();

