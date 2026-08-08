/* ============================================================================
   FindFlower — pre-inference focus shield (blur.js)
   ----------------------------------------------------------------------------
   Zero dependencies. Answers one question before we spend a network call and a
   server inference: is this frame sharp enough to be worth identifying?

   THE MATH — variance of the Laplacian.
   A focused photo has hard edges, so the second spatial derivative swings hard
   both ways and its variance is large. A blurred photo is locally flat, the
   derivative stays near zero, and the variance collapses. That single number
   separates the two cases well enough to gate an upload, costs no model, and
   runs in a couple of milliseconds.

   Pipeline: source -> 256x256 canvas -> Rec.601 luma -> 3x3 Laplacian -> var.

   Downscaling first is deliberate. It normalises the measurement across a
   12MP phone capture and a 400px thumbnail, and it bounds the work to a fixed
   65k pixels so this never reads as a stall on a budget device.

   IMPORTANT — the threshold is scale-dependent. 100 is calibrated for the
   256x256 grid below. Changing SIZE invalidates it; recalibrate with
   ffBlur.variance() on real captures rather than guessing a new number.

   Exposes window.ffBlur — { SIZE, THRESHOLD, MESSAGE, variance, isBlurry,
   check, confirm }.
   ========================================================================== */
(function () {
    'use strict';

    var SIZE = 256;        // measurement grid, per spec
    var THRESHOLD = 100;   // strictly below this = treated as out of focus
    var MESSAGE = 'Image is out of focus. Tap to refocus or try again.';

    /* Normalise anything drawable (canvas, <video>, <img>, ImageData) into a
       256x256 RGBA buffer. Returns null when the source has no pixels yet or
       the canvas is tainted by a cross-origin image. */
    function toGrid(source) {
        if (!source) return null;

        var draw = source;

        // ImageData has no draw path of its own — park it on a canvas first.
        if (typeof ImageData !== 'undefined' && source instanceof ImageData) {
            if (!source.width || !source.height) return null;
            var host = document.createElement('canvas');
            host.width = source.width;
            host.height = source.height;
            host.getContext('2d').putImageData(source, 0, 0);
            draw = host;
        } else {
            var sw = source.videoWidth || source.naturalWidth || source.width;
            var sh = source.videoHeight || source.naturalHeight || source.height;
            if (!sw || !sh) return null;
        }

        try {
            var c = document.createElement('canvas');
            c.width = SIZE;
            c.height = SIZE;
            var ctx = c.getContext('2d', { willReadFrequently: true });
            ctx.drawImage(draw, 0, 0, SIZE, SIZE);
            return ctx.getImageData(0, 0, SIZE, SIZE).data;
        } catch (e) {
            // SecurityError: a cross-origin <img> taints the canvas and
            // getImageData throws. Unmeasurable, so we decline to judge.
            return null;
        }
    }

    /* Variance of the Laplacian over luminance. Higher = sharper.
       Returns null when the frame could not be measured at all. */
    function variance(source) {
        var data = toGrid(source);
        if (!data) return null;

        // Rec. 601 luma. One pass, Float32 to keep the later squares honest.
        var lum = new Float32Array(SIZE * SIZE);
        for (var i = 0, p = 0; p < lum.length; i += 4, p++) {
            lum[p] = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
        }

        // 3x3 Laplacian [0 1 0; 1 -4 1; 0 1 0]. Interior pixels only — the
        // border has no full neighbourhood and would fake an edge.
        var sum = 0, sumSq = 0, n = 0;
        for (var y = 1; y < SIZE - 1; y++) {
            for (var x = 1; x < SIZE - 1; x++) {
                var o = y * SIZE + x;
                var v = lum[o - SIZE] + lum[o + SIZE] + lum[o - 1] + lum[o + 1] - 4 * lum[o];
                sum += v;
                sumSq += v * v;
                n++;
            }
        }
        if (!n) return null;
        var mean = sum / n;
        return sumSq / n - mean * mean;
    }

    /* True when the frame is too soft to be worth an inference call.
       An unmeasurable frame returns false: never block on missing evidence. */
    function isBlurry(source, threshold) {
        var v = variance(source);
        if (v === null) return false;
        return v < (typeof threshold === 'number' ? threshold : THRESHOLD);
    }

    /* Both numbers at once, for callers that want to log or display the score. */
    function check(source, threshold) {
        var v = variance(source);
        return {
            variance: v,
            measured: v !== null,
            blurry: v === null ? false : v < (typeof threshold === 'number' ? threshold : THRESHOLD)
        };
    }

    /* ------------------------------------------------------------------
       The intercept modal.

       confirm(source, opts) -> Promise<'scan' | 'retake'>

       Resolves 'scan' immediately when the frame is sharp (or unmeasurable),
       so callers can await it unconditionally and only see the modal when it
       genuinely matters. Otherwise it renders the warning and resolves with
       whichever override the user picked.

       Markup is built here rather than in the page so every entry point
       (camera, gallery, link) gets an identical dialog. Styling lives in
       app.css under .ff-blur-* to match the rounded, minimal design system.
       ------------------------------------------------------------------ */
    var openModal = null; // only ever one at a time

    function buildModal(onChoice) {
        var wrap = document.createElement('div');
        wrap.className = 'ff-blur-backdrop';
        wrap.setAttribute('role', 'dialog');
        wrap.setAttribute('aria-modal', 'true');
        wrap.setAttribute('aria-labelledby', 'ffBlurTitle');
        wrap.innerHTML =
            '<div class="ff-blur-card">' +
                '<div class="ff-blur-icon" aria-hidden="true">' +
                    '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
                        'stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' +
                        '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z"/>' +
                        '<circle cx="12" cy="12" r="3"/><path d="M3 3l18 18"/>' +
                    '</svg>' +
                '</div>' +
                '<h2 id="ffBlurTitle" class="ff-blur-title">' + MESSAGE + '</h2>' +
                '<p class="ff-blur-body">A sharper photo gives a far more reliable ' +
                    'identification. Hold steady, tap the flower to focus, and keep it well lit.</p>' +
                '<div class="ff-blur-actions">' +
                    '<button type="button" data-choice="retake" class="ff-blur-btn ff-blur-btn--primary">Retake</button>' +
                    '<button type="button" data-choice="scan" class="ff-blur-btn ff-blur-btn--ghost">Scan Anyway</button>' +
                '</div>' +
            '</div>';

        wrap.addEventListener('click', function (e) {
            var btn = e.target && e.target.closest ? e.target.closest('[data-choice]') : null;
            if (btn) { onChoice(btn.getAttribute('data-choice')); return; }
            // Tapping the backdrop is the same intent as Retake: don't scan.
            if (e.target === wrap) onChoice('retake');
        });
        return wrap;
    }

    function close() {
        if (!openModal) return;
        if (openModal.el && openModal.el.parentNode) openModal.el.parentNode.removeChild(openModal.el);
        document.removeEventListener('keydown', openModal.onKey);
        document.body.style.overflow = openModal.prevOverflow || '';
        openModal = null;
    }

    function confirm(source, opts) {
        var o = opts || {};
        var result = check(source, o.threshold);
        if (!result.blurry) return Promise.resolve('scan');

        close(); // never stack dialogs

        return new Promise(function (resolve) {
            var settled = false;
            function choose(choice) {
                if (settled) return;
                settled = true;
                close();
                resolve(choice === 'scan' ? 'scan' : 'retake');
            }

            var el = buildModal(choose);
            var onKey = function (e) {
                if (e.key === 'Escape' || e.keyCode === 27) choose('retake');
            };

            openModal = { el: el, onKey: onKey, prevOverflow: document.body.style.overflow };
            document.body.appendChild(el);
            document.body.style.overflow = 'hidden';
            document.addEventListener('keydown', onKey);

            // Focus the safe option so Enter never silently scans a blurry frame.
            var first = el.querySelector('[data-choice="retake"]');
            if (first) { try { first.focus(); } catch (err) { /* not focusable yet */ } }
        });
    }

    window.ffBlur = {
        SIZE: SIZE,
        THRESHOLD: THRESHOLD,
        MESSAGE: MESSAGE,
        variance: variance,
        isBlurry: isBlurry,
        check: check,
        confirm: confirm,
        close: close
    };
})();
