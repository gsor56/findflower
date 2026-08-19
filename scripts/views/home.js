/* ============================================================================
   FindFlower — home + static page views (scripts/views/home.js)
   ----------------------------------------------------------------------------
   The landing page and the static pages (how / pricing / api / about / terms /
   privacy / releases / contact / feedback) need no HTML generation: their markup
   already lives in their .html files, which is what keeps them indexable and
   readable without JS. The router fetches and swaps that markup.

   What they DO need is the small amount of behaviour a real page load gives
   them for free and a swap does not — the scroll-reveal observer, and anything
   else keyed to DOMContentLoaded. That is all this file provides.

   So there is no renderHome() returning a 46KB template literal. Generating
   markup that already exists on disk would mean two copies of the landing page
   drifting apart, and the copy the crawler reads would be the empty one.
   ========================================================================== */
(function () {
    'use strict';

    // .reveal-up elements animate in as they enter the viewport. Every page runs
    // its own copy of this on load; on a router swap the new markup arrives with
    // the class but no observer, so it must be re-armed or content stays hidden.
    var io = null;

    function initReveal(root) {
        var scope = root || document;
        var els = scope.querySelectorAll('.reveal-up:not(.active)');
        if (!els.length) return;

        if (!('IntersectionObserver' in window)) {
            for (var i = 0; i < els.length; i++) els[i].classList.add('active');
            return;
        }
        io = new IntersectionObserver(function (entries) {
            for (var j = 0; j < entries.length; j++) {
                if (entries[j].isIntersecting) {
                    entries[j].target.classList.add('active');
                    io.unobserve(entries[j].target);
                }
            }
        }, { threshold: 0.15 });
        for (var k = 0; k < els.length; k++) io.observe(els[k]);
    }

    function teardown() {
        if (io) { try { io.disconnect(); } catch (e) { /* gone */ } io = null; }
    }

    function mount() { initReveal(document); }

    // Every page whose only route-time need is the reveal observer. try.html and
    // login.html are absent on purpose: the router never swaps them (see RELOAD
    // in scripts/router.js), so they always get a real load.
    var STATIC_PAGES = [
        'index.html', 'how.html', 'pricing.html', 'api.html', 'terms.html',
        'privacy.html', 'releases.html', 'contact.html', 'feedback.html',
        'species.html', 'blogs.html', 'community.html',
    ];

    window.ffViews = window.ffViews || {};
    for (var i = 0; i < STATIC_PAGES.length; i++) {
        // Do not clobber a view a dedicated module already registered.
        if (!window.ffViews[STATIC_PAGES[i]]) {
            window.ffViews[STATIC_PAGES[i]] = { mount: mount, unmount: teardown };
        }
    }

    window.ffHomeView = { initReveal: initReveal, teardown: teardown };
})();
