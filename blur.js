(function () {
    'use strict';

    var SIZE = 256;
    var THRESHOLD = 100;
    var MESSAGE = 'Image is out of focus. Tap to refocus or try again.';

    function toGrid(source) {
        if (!source) return null;

        var draw = source;

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
            return null;
        }
    }

    function variance(source) {
        var data = toGrid(source);
        if (!data) return null;

        var lum = new Float32Array(SIZE * SIZE);
        for (var i = 0, p = 0; p < lum.length; i += 4, p++) {
            lum[p] = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
        }

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

    function isBlurry(source, threshold) {
        var v = variance(source);
        if (v === null) return false;
        return v < (typeof threshold === 'number' ? threshold : THRESHOLD);
    }

    function check(source, threshold) {
        var v = variance(source);
        return {
            variance: v,
            measured: v !== null,
            blurry: v === null ? false : v < (typeof threshold === 'number' ? threshold : THRESHOLD)
        };
    }

    var openModal = null;

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

        close();

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

            var first = el.querySelector('[data-choice="retake"]');
            if (first) { try { first.focus(); } catch (err) { } }
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
