/* ============================================================================
   FindFlower — directory view (scripts/views/directory.js)
   ----------------------------------------------------------------------------
   Route lifecycle for the encyclopedia grid. The engine itself is unchanged and
   stays in directory.js (ffDirectory.mount) — this file exists so the router
   can start that engine on entry and, crucially, STOP it on exit.

   Why the stop matters. ffDirectory.mount() installs an IntersectionObserver on
   the sentinel and a scroll listener for DOM culling. When the router swaps
   <main>, the sentinel node leaves the document but the observer and the window
   listener survive; the culler then walks a detached grid on every scroll and
   the observer can still fire a fetch for a page nobody will see. mount()
   returns { start, stop } precisely so this can be undone, and nothing called
   stop() until now.

   directory.html's inline engine is a separate, older copy that runs on a real
   page load. This module only takes over on a router revisit, when that inline
   script has already executed once in this realm.
   ========================================================================== */
(function () {
    'use strict';

    var handle = null;

    /** Start the grid for the current route. Idempotent. */
    async function renderDirectory(opts) {
        var o = opts || {};
        var grid = o.grid || document.getElementById('dirGrid');
        if (!grid) return null;

        if (!window.ffDirectory || typeof ffDirectory.mount !== 'function') {
            console.error('views/directory: directory.js is not loaded.');
            return null;
        }
        // Already running against this grid — do not stack a second observer.
        if (handle) return handle;

        handle = ffDirectory.mount({
            grid:     grid,
            sentinel: o.sentinel || document.getElementById('dirSentinel'),
            spinner:  o.spinner  || document.getElementById('dirSpinner'),
            endNote:  o.endNote  || document.getElementById('dirEnd'),
            errorBox: o.errorBox || document.getElementById('dirError'),
            retryBtn: o.retryBtn || document.getElementById('dirRetry'),
            countEl:  o.countEl  || document.getElementById('dirCount'),
            infinite: true,
            link:     'species',
        });
        await handle.start();
        return handle;
    }

    function teardown() {
        if (!handle) return;
        try { handle.stop(); } catch (e) { /* already stopped */ }
        handle = null;
    }

    async function mount(ctx) {
        // A real page load is already served by directory.html's own inline
        // engine (marked data-ff-once, so the router skips it on a swap).
        // Starting a second engine here would double-fetch and duplicate every
        // card -- measured 24 cards for a 12-card batch before this guard.
        if (ctx && ctx.initial) return;
        var grid = document.getElementById('dirGrid');
        if (grid && !grid.querySelector('article')) await renderDirectory({ grid: grid });
    }

    window.ffViews = window.ffViews || {};
    window.ffViews['directory.html'] = { mount: mount, unmount: teardown };

    window.ffDirectoryView = {
        renderDirectory: renderDirectory,
        teardown: teardown,
        get running() { return !!handle; },
    };
})();
