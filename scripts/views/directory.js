/* ============================================================================
   FindFlower — directory view (scripts/views/directory.js)
   ----------------------------------------------------------------------------
   Route lifecycle for the encyclopedia grid. The engine itself lives in
   directory.js (ffDirectory.mount) — this file exists so the router can start
   that engine on entry and, crucially, STOP it on exit.

   Why the stop matters. ffDirectory.mount() installs an IntersectionObserver on
   the sentinel and a scroll listener for DOM culling. When the router swaps
   <main>, the sentinel node leaves the document but the observer and the window
   listener survive; the culler then walks a detached grid on every scroll and
   the observer can still fire a fetch for a page nobody will see. mount()
   returns { start, stop } precisely so this can be undone, and nothing called
   stop() until now.

   On a real page load directory.html's own block mounts the engine (marked
   data-ff-once, so the router skips it on a swap) and parks the handle on
   window.ffDirectoryInline. That handle is this module's to stop as well —
   otherwise the FIRST visit is the one that leaks, which is the visit every
   search engine and every shared link makes.
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
        // The inline mount from a real page load. Stopping it is the whole
        // point of this module — its observer and scroll listener outlive the
        // <main> swap exactly like a router-started one's would.
        if (window.ffDirectoryInline) {
            try { ffDirectoryInline.stop(); } catch (e) { /* already stopped */ }
            window.ffDirectoryInline = null;
        }
        if (!handle) return;
        try { handle.stop(); } catch (e) { /* already stopped */ }
        handle = null;
    }

    async function mount(ctx) {
        // A real page load is already served by directory.html's own block
        // (marked data-ff-once, so the router skips it on a swap). Starting a
        // second engine here would double-fetch and duplicate every card --
        // measured 24 cards for a 12-card batch before this guard.
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
