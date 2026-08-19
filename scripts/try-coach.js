/* ============================================================================
   FindFlower — first-run coach marks for /try (scripts/try-coach.js)
   ----------------------------------------------------------------------------
   A phone-only, first-visit guide over the capture card: a pulsing ring around
   the one control that should be tapped next, a "Tap here" pill on the ring,
   and a small sheet above the tab bar saying in plain words what that tap does.

   Written for someone who has never used this page and may never have used a
   site that asks for a camera. Three rules follow from that:

     1. It never blocks. The whole layer is pointer-events: none apart from its
        own Hide button, so the ring sits ON a live control and the tap it is
        asking for goes straight through to the page underneath.

     2. It cannot get out of step. The current step is DERIVED from the page's
        own state — which mode tab is selected, whether Capture is live, whether
        Identify has an image — rather than counted up on clicks. Switch tabs,
        retake, wander off and come back: the ring is always on the next useful
        control, and no sequence of taps can leave it pointing at a button that
        is not on screen.

     3. It teaches once. Finishing and dismissing are both remembered in
        localStorage under ff_coach_try.

   Desktop gets nothing. The workspace is two columns from md up, every control
   is already in view at once, and a ring chasing a mouse-owner around is noise.
   The gate is viewport width rather than touch support, because a narrow window
   is the same single-column layout a phone gets.

   Nothing here reads or writes currentBlob, the inference request, or IndexedDB.
   It observes four attributes and moves a div.
   ========================================================================== */
(function () {
    'use strict';

    var SEEN_KEY = 'ff_coach_try';
    var VERSION = '1';              // bump to teach a rebuilt flow again
    var PHONE = '(max-width: 767px)';
    var RING_PAD = 6;               // ring is drawn OUTSIDE the control
    var SETTLE_MS = 420;            // let the page's own scroll land first

    function seen() {
        try { return localStorage.getItem(SEEN_KEY) === VERSION; } catch (e) { return false; }
    }
    function markSeen() {
        try { localStorage.setItem(SEEN_KEY, VERSION); } catch (e) { /* private window */ }
    }
    function phone() {
        return !!(window.matchMedia && window.matchMedia(PHONE).matches);
    }

    /** Either source of "less motion": the OS setting, or the app's own Motion
     *  switch (which prefs.js reflects as a class on <html>). CSS already
     *  answers both; this is only for scroll behaviour, which CSS cannot reach
     *  once a script has asked for smooth explicitly. */
    function stillPlease() {
        if (document.documentElement.classList.contains('ff-reduce-motion')) return true;
        return !!(window.ffUX && ffUX.prefersReducedMotion());
    }

    /* ------------------------------------------------------------------------
       The steps
       ------------------------------------------------------------------------
       Keyed by the page state they belong to, not by an index, because the
       order is the page's to decide (see stepKey below).

       `of` is per PATH: the camera takes three taps, a photo already on the
       phone takes two. One shared "of 3" would promise a step that never comes.

       Copy rules, for a reader who is not fluent in apps: name the control the
       way it is labelled on screen, say what happens after the tap, and offer
       the way out in the same breath as the thing that can go wrong.
       ------------------------------------------------------------------------ */
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
            id: 'identifyBtn', n: 0, of: 0,   // last step of whichever path was taken
            title: 'Tap <b>Identify flower</b>',
            body: 'The name and the details appear on this page in a few seconds. ' +
                  'If it asks you to sign in, that is so your flower can be saved.'
        }
    };

    function mode() {
        var on = document.querySelector('.seg-btn[aria-selected="true"]');
        return on ? (on.getAttribute('data-mode') || 'camera') : 'camera';
    }

    /**
     * Which step the page is in RIGHT NOW, read off the page rather than
     * remembered. Ordered by how far along the user is, furthest first: an
     * image sitting in the preview outranks everything, because Identify is
     * then the only tap that moves them forward — no matter which of the three
     * inputs produced it, and no matter that the camera may still be running.
     */
    function stepKey() {
        var identify = document.getElementById('identifyBtn');
        if (identify && !identify.disabled) return 'identify';
        var m = mode();
        if (m === 'upload') return 'pick';
        if (m === 'url') return 'link';
        // Capture is enabled only while a stream is live, and it is swapped out
        // for Retake once a frame is taken. Enabled AND showing is exactly the
        // window in which Capture is the next tap.
        var cap = document.getElementById('camCapture');
        if (cap && !cap.disabled && !cap.classList.contains('hidden')) return 'capture';
        return 'start';
    }

    /* ---- the layer --------------------------------------------------------- */

    var root = null, ring = null, sheet = null;
    var elStep = null, elTitle = null, elBody = null;
    var shown = false, currentKey = null, currentSig = null;
    var frame = 0, settle = 0, mos = [], ro = null;
    var guard = 0, guardUntil = 0;

    function build() {
        root = document.createElement('div');
        root.className = 'ff-coach';
        // The router drops [data-ff-page] nodes when it swaps a page in, which
        // is what removes this layer if the user leaves /try through the tab
        // bar. Same contract dashboard.html's #authWall uses.
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
                    '<button type="button" class="ff-coach__hide soft-click flex-shrink-0 -mt-1 -mr-1 min-h-[44px] ' +
                        'min-w-[44px] px-3 rounded-full text-sm font-medium text-neutral-500 ' +
                        'hover:text-neutral-900 hover:bg-neutral-50 transition" ' +   // plain transition:
                        // transition-colors would drop transform and .soft-click's press would snap

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

    /** The step's control, or null if it is not on screen. A control inside a
     *  hidden panel has a zero-size rect, and the ring must never point at
     *  something the user cannot see. */
    function targetOf(key) {
        var step = STEPS[key];
        var el = step ? document.getElementById(step.id) : null;
        if (!el || typeof el.getBoundingClientRect !== 'function') return null;
        var r = el.getBoundingClientRect();
        return (r.width > 0 && r.height > 0) ? el : null;
    }

    /** Lay the ring around `el`, in document coordinates so that scrolling
     *  moves it with the control and costs no JS at all. */
    function place(el) {
        var r = el.getBoundingClientRect();
        var top = Math.round(r.top + window.scrollY - RING_PAD) + 'px';
        var left = Math.round(r.left + window.scrollX - RING_PAD) + 'px';
        var w = Math.round(r.width + RING_PAD * 2) + 'px';
        var h = Math.round(r.height + RING_PAD * 2) + 'px';
        ring.hidden = false;
        // Nothing moved: return without touching the style. The ring animates
        // its own top/left/width/height, so a needless write would restart that
        // transition on every resize tick and on every watchdog frame below.
        if (ring.style.top === top && ring.style.left === left &&
            ring.style.width === w && ring.style.height === h) return false;
        ring.style.top = top;
        ring.style.left = left;
        ring.style.width = w;
        ring.style.height = h;
        // Follow the control's own corner, so the ring reads as a highlight of
        // that button rather than a lozenge dropped on top of it. A pill stays
        // a pill; the upload dropzone keeps its card radius, grown by the pad.
        var rad = parseFloat(getComputedStyle(el).borderTopLeftRadius);
        if (!isFinite(rad)) rad = 12;
        ring.style.borderRadius = (rad > 40 ? 9999 : rad + RING_PAD) + 'px';
        // No room for the pill above a control tucked under the fixed header.
        ring.classList.toggle('is-below', r.top < 108);
        return true;
    }

    /** How many taps the path the user is on takes. The camera needs three,
     *  a photo already on the phone needs two. */
    function pathLength() { return mode() === 'camera' ? 3 : 2; }

    function describe(key) {
        var step = STEPS[key];
        var of = step.of || pathLength();
        elStep.textContent = 'Step ' + (step.n || of) + ' of ' + of;
        elTitle.innerHTML = step.title;
        elBody.innerHTML = step.body;
    }

    /**
     * Put the control somewhere it can actually be tapped: below the fixed
     * header, above our own sheet. Measured rather than assumed, and the test
     * is the control's CENTRE, so this only fires when the target is genuinely
     * off screen or hidden behind the sheet — a nudge for something already in
     * comfortable view is a jolt carrying no information, and would fight the
     * page's own scroll after a capture.
     */
    function bringIntoView(el) {
        if (!el || !shown) return;
        var vh = window.innerHeight || document.documentElement.clientHeight;
        var top = 88;                                    // 64px header + air
        var bottom = sheet ? sheet.getBoundingClientRect().top - 16 : vh - 16;
        if (bottom - top < 96) return;                   // no band worth aiming at
        var r = el.getBoundingClientRect();
        var mid = r.top + r.height / 2;
        if (mid > top && mid < bottom) return;
        var want = r.height <= bottom - top
            ? top + ((bottom - top) - r.height) / 2      // centre it in the band
            : top;                                       // taller than the band
        try {
            window.scrollBy({ top: Math.round(r.top - want), behavior: stillPlease() ? 'auto' : 'smooth' });
        } catch (e) {
            window.scrollBy(0, Math.round(r.top - want)); // older signature
        }
    }

    /** Re-read the page and move the ring. Safe to call on any hint that
     *  something changed; schedule() coalesces a burst into one frame. */
    function sync() {
        if (!shown) return;
        var key = stepKey();
        var el = targetOf(key);
        if (!el) { ring.hidden = true; return; }
        var moved = key !== currentKey;
        currentKey = key;
        // Re-word only when the wording would change. The last step belongs to
        // whichever path reached it, so switching tabs while holding an image
        // turns "Step 2 of 2" into "Step 3 of 3" without the step itself
        // moving -- and a live region that re-announces identical text on every
        // resize is its own kind of rude.
        var sig = key + ':' + pathLength();
        if (sig !== currentSig) { currentSig = sig; describe(key); }
        place(el);
        if (moved) {
            guardLayout(700);
            clearTimeout(settle);
            settle = setTimeout(function () { bringIntoView(el); }, SETTLE_MS);
        }
    }

    /**
     * Hold the ring on its control while the page is still settling.
     *
     * A ring laid down before the layout stops moving -- a .reveal-up still
     * travelling its 30px, a webfont arriving, the camera panel swapping in --
     * would sit off its button with nothing to correct it: no attribute
     * changed, and ResizeObserver does not see a move that changes position
     * without changing size. So for a short while, look every frame and
     * re-place only when the numbers genuinely differ. It stops itself, and
     * from then on the observers carry it.
     */
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

    /* ---- what we listen to -------------------------------------------------
       Four attributes carry every state change the step machine reads:
       aria-selected on the mode tabs, disabled on Capture and on Identify, and
       class on Capture (the capture switch hides it after a shot). Observing
       those five nodes directly rather than the document subtree keeps this off
       the hot path while the result panel is being built.
       ----------------------------------------------------------------------- */
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
        // Layout can move under the ring without any attribute changing: fonts
        // arriving, the panel swap changing the card's height, the on-screen
        // keyboard opening over the Link field.
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

    /** The tour ends where it was going: the result panel takes over the
     *  narration from here, with its own copy for every outcome. */
    function onIdentify() {
        if (shown) close(true);
    }
    function onKey(e) {
        if (e.key === 'Escape' || e.key === 'Esc') close(true);
    }

    /* ---- lifecycle --------------------------------------------------------- */

    function start() {
        if (shown) return false;
        // Not the try page (or the markup moved): say so once, do nothing.
        if (!document.getElementById('identifyBtn') || !document.querySelector('.seg-btn')) return false;
        build();
        shown = true;
        currentKey = currentSig = null;
        watch();
        sync();
        guardLayout(1600);   // covers the card's 1s reveal, then gets out of the way
        // A webfont can land after that window and re-flow the button under
        // the ring. One promise, resolves once, and sync() ignores it if the
        // layer has already closed.
        if (document.fonts && document.fonts.ready) document.fonts.ready.then(schedule);
        // One frame between insertion and the class, or the sheet has no
        // starting frame to transition from and simply appears.
        requestAnimationFrame(function () { if (root) root.classList.add('is-on'); });
        return true;
    }

    /** Take the layer down. `remember` is the difference between "you are done
     *  with this" and "this window is too wide for coach marks now". */
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

    // Rotating a phone into landscape crosses into the two-column layout, where
    // coach marks are noise; rotating back is a fresh chance to be useful.
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
        start: start,                                   // force it, ignoring "seen"
        sync: schedule,
        /** Leave without marking it seen — the route teardown, not a dismissal. */
        stop: function () { return close(false); },
        dismiss: function () { return close(true); },
        /** Forget the visit, so the tour runs again. The QA suite uses this, and
         *  it is the hook a "show the tips again" control would call. */
        reset: function () { try { localStorage.removeItem(SEEN_KEY); } catch (e) {} },
        seen: seen,
        get shown() { return shown; },
        get step() { return currentKey; }
    };
})();
