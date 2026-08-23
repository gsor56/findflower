(function () {
    'use strict';

    var root = document.documentElement;

    function prefersReducedMotion() {
        return !!(window.matchMedia &&
            window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    }

    function ffHaptic(ms) {
        try {
            if (!navigator || typeof navigator.vibrate !== 'function') return false;
            if (prefersReducedMotion()) return false;
            return navigator.vibrate(typeof ms === 'number' ? ms : 50) === true;
        } catch (e) {
            return false;
        }
    }

    document.addEventListener('click', function (e) {
        var t = e.target;
        if (!t || typeof t.closest !== 'function') return;
        var hit = t.closest('[data-haptic]');
        if (!hit) return;
        var raw = hit.getAttribute('data-haptic');
        var ms = parseInt(raw, 10);
        ffHaptic(isNaN(ms) ? 50 : ms);
    }, true);

    var io = null;
    var seen = null;

    function markSeen(el) {
        if (seen) { try { seen.add(el); } catch (e) { } }
    }

    function isSeen(el) {
        if (!seen) return false;
        try { return seen.has(el); } catch (e) { return false; }
    }

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
        if (!('IntersectionObserver' in window)) return;

        if (typeof WeakSet === 'function') {
            try { seen = new WeakSet(); } catch (e) { seen = null; }
        }

        io = new IntersectionObserver(function (entries) {
            for (var i = 0; i < entries.length; i++) {
                if (!entries[i].isIntersecting) continue;
                entries[i].target.classList.add('active');
                io.unobserve(entries[i].target);
            }
        }, { threshold: 0.15, rootMargin: '0px 0px -5% 0px' });

        root.classList.add('ff-reveal');
        scanReveals(document);

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

    function crossFade(placeholder, content) {
        if (placeholder) {
            placeholder.classList.remove('skeleton-shimmer', 'skeleton');
            if (placeholder !== content) placeholder.hidden = true;
        }
        if (!content) return;
        content.hidden = false;
        if (prefersReducedMotion()) return;
        content.classList.remove('ff-fade-in');
        void content.offsetWidth;
        content.classList.add('ff-fade-in');
    }

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
