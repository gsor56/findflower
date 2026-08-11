/* ============================================================================
   FindFlower — global UX layer (scripts/ux.js)
   ----------------------------------------------------------------------------
   Loaded on every page, next to nav.js. Three jobs, all presentation:

     1. Haptics. One 50ms tick on the controls that COMMIT to something —
        Identify, Delete, Save. Declarative via data-haptic so a page opts a
        button in with an attribute and no per-page script.

     2. Scroll reveals, globally and fail-safely. Each page also has its own
        inline observer; this is a second, independent one, and it exists
        because those fourteen copies share a failure mode (see app.css).

     3. Loading that reads as arrival rather than delay: shimmer placeholders
        cross-fading to content instead of a spinner that stops.

   Deliberately NOT a module. A `type="module"` tag is silently skipped by
   anything that does not support it, and this file owns the switch that hides
   revealable content — the one script on the site where failing to run must
   leave the page readable rather than blank. Classic script, `defer`, no build
   step, ES5 syntax to match nav.js.

   Touches nothing but classes and attributes. No fetch, no storage, no
   inference — the ViT pipeline, IndexedDB and the Trefle/Wikidata calls never
   see this file.
   ========================================================================== */
(function () {
    'use strict';

    var root = document.documentElement;

    function prefersReducedMotion() {
        return !!(window.matchMedia &&
            window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    }

    /* ------------------------------------------------------------------------
       1. Haptics
       ------------------------------------------------------------------------ */

    /**
     * One short haptic tick. For buttons that commit: Identify, Delete, Save.
     *
     * Guarded three ways because vibrate() is the least uniformly implemented
     * API on the site: absent on iOS Safari entirely, present-but-ignored
     * outside a user gesture on Chrome, and it throws on a few Android
     * WebViews. A missing buzz must never break the click it was attached to,
     * so every path returns false rather than raising.
     *
     * Skipped under prefers-reduced-motion: someone who has asked the system
     * to stop moving things is also asking it to stop buzzing them. That is
     * how iOS and Android both treat the setting.
     *
     * @param {number} [ms=50] Duration in milliseconds.
     * @returns {boolean} true if the device accepted the request.
     */
    function ffHaptic(ms) {
        try {
            if (!navigator || typeof navigator.vibrate !== 'function') return false;
            if (prefersReducedMotion()) return false;
            return navigator.vibrate(typeof ms === 'number' ? ms : 50) === true;
        } catch (e) {
            return false;
        }
    }

    // Declarative wiring. `data-haptic` alone gives the standard 50ms tick;
    // `data-haptic="30"` overrides it. Delegated from the document so it covers
    // buttons that do not exist yet — the scanner's Identify button, dashboard
    // rows rendered from IndexedDB, candidate chips built after inference.
    //
    // Capture phase on purpose: a page handler that calls stopPropagation (the
    // scanner does, on some controls) would otherwise swallow the feedback for
    // the exact actions most worth confirming.
    document.addEventListener('click', function (e) {
        var t = e.target;
        if (!t || typeof t.closest !== 'function') return;
        var hit = t.closest('[data-haptic]');
        if (!hit) return;
        var raw = hit.getAttribute('data-haptic');
        var ms = parseInt(raw, 10);
        ffHaptic(isNaN(ms) ? 50 : ms);
    }, true);

    /* ------------------------------------------------------------------------
       2. Scroll reveals
       ------------------------------------------------------------------------ */

    var io = null;
    var seen = null;   // WeakSet where available: never re-observe one element

    function markSeen(el) {
        if (seen) { try { seen.add(el); } catch (e) { /* ignore */ } }
    }

    function isSeen(el) {
        if (!seen) return false;
        try { return seen.has(el); } catch (e) { return false; }
    }

    /**
     * Reveal every .reveal-up inside `scope` as it enters the viewport.
     *
     * Adds `.active`, the same class all fourteen inline observers use, so this
     * observer drives each page's own CSS and each page's observer drives the
     * global rules. Either alone is sufficient; together neither is a single
     * point of failure.
     *
     * @param {Element|Document} [scope=document]
     */
    function scanReveals(scope) {
        if (!io) return;
        var host = scope || document;
        if (!host.querySelectorAll) return;
        var els = host.querySelectorAll('.reveal-up:not(.active)');
        for (var i = 0; i < els.length; i++) {
            if (isSeen(els[i])) continue;
            markSeen(els[i]);
            io.observe(els[i]);
        }
    }

    function startReveals() {
        // No IntersectionObserver (or no JS at all, in which case this never
        // runs) means .ff-reveal is never set and app.css leaves everything
        // visible. Nothing to fall back to, because nothing was hidden.
        if (!('IntersectionObserver' in window)) return;

        if (typeof WeakSet === 'function') {
            try { seen = new WeakSet(); } catch (e) { seen = null; }
        }

        io = new IntersectionObserver(function (entries) {
            for (var i = 0; i < entries.length; i++) {
                if (!entries[i].isIntersecting) continue;
                entries[i].target.classList.add('active');
                // One-shot: content does not un-reveal on the way back up, and
                // unobserving keeps the callback cost proportional to what is
                // still hidden rather than to page length.
                io.unobserve(entries[i].target);
            }
        }, { threshold: 0.15, rootMargin: '0px 0px -5% 0px' });

        // Only NOW is it safe to hide anything: the observer that reveals them
        // exists. Setting the class earlier would reintroduce the blank-page
        // bug in the window between the two statements.
        root.classList.add('ff-reveal');
        scanReveals(document);

        // Content arrives after load from three directions: router swaps of
        // <main>, the directory's infinite scroll, and the scanner's result
        // card. Each brings .reveal-up markup with no observer attached.
        //
        // A MutationObserver covers all three without any of them having to
        // call in. Coalesced through one rAF, so a burst of 96 appended cards
        // costs a single scan instead of 96.
        if (typeof MutationObserver !== 'function') return;

        var queued = false;
        function rescan() {
            queued = false;
            scanReveals(document);
        }
        new MutationObserver(function (records) {
            if (queued) return;
            for (var i = 0; i < records.length; i++) {
                if (records[i].addedNodes && records[i].addedNodes.length) {
                    queued = true;
                    if (window.requestAnimationFrame) window.requestAnimationFrame(rescan);
                    else rescan();
                    return;
                }
            }
        }).observe(document.body, { childList: true, subtree: true });
    }

    /* ------------------------------------------------------------------------
       3. Shimmer → content cross-fade
       ------------------------------------------------------------------------ */

    /**
     * Swap a loading placeholder for the content it was standing in for.
     *
     * The point is that the two states share one motion instead of reading as
     * "stop, then start". The placeholder is removed in the same frame the
     * content begins fading in, and only opacity animates, so the layout the
     * content lands in never moves.
     *
     * @param {Element} placeholder Shimmer element to retire. May be null.
     * @param {Element} content     Element to fade in. May be null.
     */
    function crossFade(placeholder, content) {
        if (placeholder) {
            placeholder.classList.remove('skeleton-shimmer', 'skeleton');
            if (placeholder !== content) placeholder.hidden = true;
        }
        if (!content) return;
        content.hidden = false;
        if (prefersReducedMotion()) return;
        // Restart the animation if this element has already faded once (a
        // re-render into the same node), which needs the class off for a frame.
        content.classList.remove('ff-fade-in');
        void content.offsetWidth;   // reflow: forces the removal to take effect
        content.classList.add('ff-fade-in');
    }

    /* ------------------------------------------------------------------------
       Public surface
       ------------------------------------------------------------------------ */

    window.ffHaptic = ffHaptic;
    window.ffUX = {
        haptic: ffHaptic,
        scanReveals: scanReveals,
        crossFade: crossFade,
        prefersReducedMotion: prefersReducedMotion
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', startReveals);
    } else {
        startReveals();
    }
})();
