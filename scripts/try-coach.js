(function () {
    'use strict';

    var SEEN_KEY = 'ff_coach_try';
    var VERSION = '1';
    var PHONE = '(max-width: 767px)';
    var RING_PAD = 6;
    var SETTLE_MS = 420;

    function seen() {
        try { return localStorage.getItem(SEEN_KEY) === VERSION; } catch (e) { return false; }
    }
    function markSeen() {
        try { localStorage.setItem(SEEN_KEY, VERSION); } catch (e) { }
    }
    function phone() {
        return !!(window.matchMedia && window.matchMedia(PHONE).matches);
    }

    function stillPlease() {
        if (document.documentElement.classList.contains('ff-reduce-motion')) return true;
        return !!(window.ffUX && ffUX.prefersReducedMotion());
    }

    var STEPS = {
        start: {
            id: 'camStart', n: 1, of: 3,
            title: 'Tap <b>Start camera</b>',
            body: 'Your phone will ask for permission — choose <b>Allow</b>. ' +
                  'No camera? Scroll up and tap <b>Upload</b> to use a photo you already have.'
        },
        capture: {
            id: 'camCapture', n: 2, of: 3,
            title: 'Hold still, then tap <b>Capture</b>',
            body: 'Get close enough that one flower fills the white box in the middle.'
        },
        pick: {
            id: 'dropzone', n: 1, of: 2,
            title: 'Tap the dotted box',
            body: 'Then choose a flower photo from your phone.'
        },
        link: {
            id: 'urlInput', n: 1, of: 2,
            title: 'Paste a web address here',
            body: 'Then tap <b>Load</b> to bring the picture in.'
        },
        identify: {
            id: 'identifyBtn', n: 0, of: 0,
            title: 'Tap <b>Identify flower</b>',
            body: 'The name and the details appear on this page in a few seconds. ' +
                  'If it asks you to sign in, that is so your flower can be saved.'
        }
    };

    function mode() {
        var on = document.querySelector('.seg-btn[aria-selected="true"]');
        return on ? (on.getAttribute('data-mode') || 'camera') : 'camera';
    }

    function stepKey() {
        var identify = document.getElementById('identifyBtn');
        if (identify && !identify.disabled) return 'identify';
        var m = mode();
        if (m === 'upload') return 'pick';
        if (m === 'url') return 'link';
        var cap = document.getElementById('camCapture');
        if (cap && !cap.disabled && !cap.classList.contains('hidden')) return 'capture';
        return 'start';
    }

    var root = null, ring = null, sheet = null;
    var elStep = null, elTitle = null, elBody = null;
    var shown = false, currentKey = null, currentSig = null;
    var frame = 0, settle = 0, mos = [], ro = null;
    var guard = 0, guardUntil = 0;

    function build() {
        root = document.createElement('div');
        root.className = 'ff-coach';
        root.setAttribute('data-ff-page', 'try.html');
        root.innerHTML =
            '<div class="ff-coach__ring" hidden>' +
                '<span class="ff-coach__here">Tap here</span>' +
            '</div>' +
            '<div class="ff-coach__sheet" role="region" aria-label="How to identify a flower">' +
                '<div class="flex items-start gap-3">' +
                    '<div class="flex-1 min-w-0" aria-live="polite">' +
                        '<p class="ff-coach__count text-xs font-medium text-sage-600"></p>' +
                        '<p class="ff-coach__title text-base font-medium text-neutral-900 leading-snug mt-0.5"></p>' +
                        '<p class="ff-coach__body text-sm text-neutral-500 font-light leading-snug mt-1"></p>' +
                    '</div>' +
                    '<button type="button" class="ff-coach__hide soft-click flex-shrink-0 -mt-1 -mr-1 min-h-[44px] ' + 'min-w-[44px] px-3 rounded-md text-sm font-medium text-neutral-500 ' + 'hover:text-neutral-900 hover:bg-neutral-50 transition" ' +

                        'aria-label="Hide these tips">Hide</button>' +
                '</div>' +
            '</div>';
        ring = root.querySelector('.ff-coach__ring');
        sheet = root.querySelector('.ff-coach__sheet');
        elStep = root.querySelector('.ff-coach__count');
        elTitle = root.querySelector('.ff-coach__title');
        elBody = root.querySelector('.ff-coach__body');
        root.querySelector('.ff-coach__hide').addEventListener('click', function () { close(true); });
        document.body.appendChild(root);
    }

    function targetOf(key) {
        var step = STEPS[key];
        var el = step ? document.getElementById(step.id) : null;
        if (!el || typeof el.getBoundingClientRect !== 'function') return null;
        var r = el.getBoundingClientRect();
        return (r.width > 0 && r.height > 0) ? el : null;
    }

    function place(el) {
        var r = el.getBoundingClientRect();
        var top = Math.round(r.top + window.scrollY - RING_PAD) + 'px';
        var left = Math.round(r.left + window.scrollX - RING_PAD) + 'px';
        var w = Math.round(r.width + RING_PAD * 2) + 'px';
        var h = Math.round(r.height + RING_PAD * 2) + 'px';
        ring.hidden = false;
        if (ring.style.top === top && ring.style.left === left &&
            ring.style.width === w && ring.style.height === h) return false;
        ring.style.top = top;
        ring.style.left = left;
        ring.style.width = w;
        ring.style.height = h;
        var rad = parseFloat(getComputedStyle(el).borderTopLeftRadius);
        if (!isFinite(rad)) rad = 12;
        ring.style.borderRadius = (rad > 40 ? 9999 : rad + RING_PAD) + 'px';
        ring.classList.toggle('is-below', r.top < 108);
        return true;
    }

    function pathLength() { return mode() === 'camera' ? 3 : 2; }

    function describe(key) {
        var step = STEPS[key];
        var of = step.of || pathLength();
        elStep.textContent = 'Step ' + (step.n || of) + ' of ' + of;
        elTitle.innerHTML = step.title;
        elBody.innerHTML = step.body;
    }

    function bringIntoView(el) {
        if (!el || !shown) return;
        var vh = window.innerHeight || document.documentElement.clientHeight;
        var top = 88;
        var bottom = sheet ? sheet.getBoundingClientRect().top - 16 : vh - 16;
        if (bottom - top < 96) return;
        var r = el.getBoundingClientRect();
        var mid = r.top + r.height / 2;
        if (mid > top && mid < bottom) return;
        var want = r.height <= bottom - top
            ? top + ((bottom - top) - r.height) / 2
            : top;
        try {
            window.scrollBy({ top: Math.round(r.top - want), behavior: stillPlease() ? 'auto' : 'smooth' });
        } catch (e) {
            window.scrollBy(0, Math.round(r.top - want));
        }
    }

    function sync() {
        if (!shown) return;
        var key = stepKey();
        var el = targetOf(key);
        if (!el) { ring.hidden = true; return; }
        var moved = key !== currentKey;
        currentKey = key;
        var sig = key + ':' + pathLength();
        if (sig !== currentSig) { currentSig = sig; describe(key); }
        place(el);
        if (moved) {
            guardLayout(700);
            clearTimeout(settle);
            settle = setTimeout(function () { bringIntoView(el); }, SETTLE_MS);
        }
    }

    function guardLayout(ms) {
        guardUntil = Math.max(guardUntil, Date.now() + ms);
        if (guard) return;
        guard = requestAnimationFrame(function tick() {
            guard = 0;
            if (!shown) return;
            var el = targetOf(currentKey || stepKey());
            if (el) place(el);
            if (Date.now() < guardUntil) guard = requestAnimationFrame(tick);
        });
    }

    function schedule() {
        if (frame) return;
        frame = requestAnimationFrame(function () { frame = 0; sync(); });
    }

    function watch() {
        var nodes = [document.getElementById('camCapture'), document.getElementById('identifyBtn')];
        var tabs = document.querySelectorAll('.seg-btn');
        for (var t = 0; t < tabs.length; t++) nodes.push(tabs[t]);
        for (var i = 0; i < nodes.length; i++) {
            if (!nodes[i]) continue;
            var mo = new MutationObserver(schedule);
            mo.observe(nodes[i], { attributes: true, attributeFilter: ['disabled', 'class', 'aria-selected'] });
            mos.push(mo);
        }
        var card = document.getElementById('previewBlock');
        card = card ? card.parentNode : null;
        if (card && typeof ResizeObserver === 'function') {
            ro = new ResizeObserver(schedule);
            ro.observe(card);
        }
        var identify = document.getElementById('identifyBtn');
        if (identify) identify.addEventListener('click', onIdentify);
        document.addEventListener('keydown', onKey);
    }

    function unwatch() {
        for (var i = 0; i < mos.length; i++) { try { mos[i].disconnect(); } catch (e) {} }
        mos = [];
        if (ro) { try { ro.disconnect(); } catch (e) {} ro = null; }
        var identify = document.getElementById('identifyBtn');
        if (identify) identify.removeEventListener('click', onIdentify);
        document.removeEventListener('keydown', onKey);
    }

    function onIdentify() {
        if (shown) close(true);
    }
    function onKey(e) {
        if (e.key === 'Escape' || e.key === 'Esc') close(true);
    }

    function start() {
        if (shown) return false;
        if (!document.getElementById('identifyBtn') || !document.querySelector('.seg-btn')) return false;
        build();
        shown = true;
        currentKey = currentSig = null;
        watch();
        sync();
        guardLayout(1600);
        if (document.fonts && document.fonts.ready) document.fonts.ready.then(schedule);
        requestAnimationFrame(function () { if (root) root.classList.add('is-on'); });
        return true;
    }

    function close(remember) {
        if (remember) markSeen();
        if (!shown) return false;
        shown = false;
        currentKey = currentSig = null;
        clearTimeout(settle);
        if (frame) { cancelAnimationFrame(frame); frame = 0; }
        if (guard) { cancelAnimationFrame(guard); guard = 0; }
        guardUntil = 0;
        unwatch();
        if (root && root.parentNode) root.parentNode.removeChild(root);
        root = ring = sheet = elStep = elTitle = elBody = null;
        return true;
    }

    function maybeStart() {
        if (seen() || !phone()) return false;
        return start();
    }

    window.addEventListener('resize', function () {
        if (!phone()) { close(false); return; }
        if (!shown) { maybeStart(); return; }
        schedule();
    });

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', maybeStart);
    } else {
        maybeStart();
    }

    window.ffTryCoach = {
        key: SEEN_KEY,
        version: VERSION,
        start: start,
        sync: schedule,
        stop: function () { return close(false); },
        dismiss: function () { return close(true); },
        reset: function () { try { localStorage.removeItem(SEEN_KEY); } catch (e) {} },
        seen: seen,
        get shown() { return shown; },
        get step() { return currentKey; }
    };
})();
