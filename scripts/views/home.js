(function () {
    'use strict';

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
        if (io) { try { io.disconnect(); } catch (e) { } io = null; }
    }

    function mount() { initReveal(document); }

    var STATIC_PAGES = [
        'index.html', 'how.html', 'pricing.html', 'api.html', 'terms.html',
        'privacy.html', 'releases.html', 'contact.html', 'feedback.html',
        'species.html', 'blogs.html',
        'research.html', 'about.html', 'data.html', 'article.html',
    ];

    window.ffViews = window.ffViews || {};
    for (var i = 0; i < STATIC_PAGES.length; i++) {
        if (!window.ffViews[STATIC_PAGES[i]]) {
            window.ffViews[STATIC_PAGES[i]] = { mount: mount, unmount: teardown };
        }
    }

    window.ffHomeView = { initReveal: initReveal, teardown: teardown };
})();
