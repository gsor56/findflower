// Send validated photos straight to the staging queue.
//
// contribute.html already builds a downloadable bundle, which is the offline
// path: the visitor keeps the file and mails it. This adds the online path for
// a signed-in visitor -- the photo goes to /api/contributions, where it waits
// until the sync job publishes it.
//
// The junk filter runs here, in the browser, because this page is the cheapest
// place to do it and because the server has 3GB of headroom to protect for the
// EVA-02 export. The Lite CNN is asked for its top class; a top probability
// under the threshold is treated as "not a flower" and refused before anything
// is uploaded at all.
(function () {
    'use strict';

    var MIN_CONFIDENCE = 0.35;
    var MAX_SIDE = 448;          // EVA-02 wants multiples of the 14px patch
    var MAX_BYTES = 1200000;     // the schema refuses more than this
    var QUALITY = 0.85;

    function $(id) { return document.getElementById(id); }

    function say(text, tone) {
        var el = $('ctbUploadNote');
        if (!el) return;
        el.textContent = text || '';
        el.classList.toggle('hidden', !text);
        el.className = 'text-sm font-light mt-3 leading-relaxed '
            + (tone === 'bad' ? 'text-red-700' : tone === 'good' ? 'text-sage-700' : 'text-neutral-500');
    }

    function decode(file) {
        if (typeof createImageBitmap === 'function') return createImageBitmap(file);
        return new Promise(function (resolve, reject) {
            var url = URL.createObjectURL(file);
            var img = new Image();
            img.onload = function () { URL.revokeObjectURL(url); resolve(img); };
            img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('That file is not an image.')); };
            img.src = url;
        });
    }

    /** Re-encode to a 448px JPEG under the byte cap. The original may be a 12MP
     *  phone photo; the training frame only needs the flower. */
    async function shrink(file) {
        var src = await decode(file);
        var w = src.width || src.naturalWidth;
        var h = src.height || src.naturalHeight;
        if (!w || !h) throw new Error('That file has no readable image data.');
        var scale = Math.min(1, MAX_SIDE / Math.max(w, h));
        var canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(w * scale));
        canvas.height = Math.max(1, Math.round(h * scale));
        canvas.getContext('2d').drawImage(src, 0, 0, canvas.width, canvas.height);
        if (src.close) src.close();
        var blob = await new Promise(function (resolve) { canvas.toBlob(resolve, 'image/jpeg', QUALITY); });
        if (!blob) throw new Error('That photo could not be re-encoded.');
        if (blob.size > MAX_BYTES) throw new Error('That photo is too large even after resizing.');
        return blob;
    }

    function toDataUrl(blob) {
        return new Promise(function (resolve, reject) {
            var reader = new FileReader();
            reader.onload = function () { resolve(String(reader.result)); };
            reader.onerror = function () { reject(new Error('That photo could not be read.')); };
            reader.readAsDataURL(blob);
        });
    }

    /** The Lite CNN's verdict. Returns null when the model cannot run, which is
     *  not the same as "junk": the server still stages a photo nothing looked at,
     *  so a missing model must not silently reject every contribution. */
    async function judge(blob) {
        if (!window.ffLite || typeof window.ffLite.predict !== 'function') return null;
        try {
            var top = await window.ffLite.predict(blob, 3);
            if (!top || !top.length) return null;
            return {
                model: 'lite-cnn',
                label: top[0].name,
                confidence: top[0].p,
                verdict: top[0].p >= MIN_CONFIDENCE ? 'flower' : 'junk',
            };
        } catch (e) {
            return null;
        }
    }

    async function send(files) {
        var nameField = $('ctbNew');
        var stated = nameField ? nameField.value.trim() : '';
        var sent = 0, skipped = 0, failed = 0;
        for (var i = 0; i < files.length; i += 1) {
            var file = files[i];
            say('Checking ' + (i + 1) + ' of ' + files.length + ' in this browser...');
            var blob, dataUrl, verdict;
            try {
                blob = await shrink(file);
                dataUrl = await toDataUrl(blob);
                verdict = await judge(blob);
            } catch (err) {
                skipped += 1;
                continue;
            }
            if (verdict && verdict.verdict === 'junk') { skipped += 1; continue; }

            var taxon = stated || (verdict && verdict.label) || '';
            try {
                var res = await fetch('/api/contributions', {
                    method: 'POST',
                    credentials: 'same-origin',
                    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
                    body: JSON.stringify({
                        image: dataUrl,
                        taxon: { acceptedName: taxon || 'Unidentified flower', name: taxon },
                        validation: verdict || { verdict: 'unknown' },
                        note: 'Sent from contribute.html',
                    }),
                });
                if (res.status === 201) sent += 1;
                else if (res.status === 409) skipped += 1;
                else skipped += 1;
            } catch (e) {
                failed += 1;
            }
        }
        var parts = [];
        if (sent) parts.push(sent + ' added to the queue');
        if (skipped) parts.push(skipped + ' skipped (not a flower, a duplicate, or unreadable)');
        if (failed) parts.push(failed + ' could not reach the server');
        say(parts.join('. ') + '.', failed && !sent ? 'bad' : sent ? 'good' : null);
    }

    async function init() {
        var button = $('ctbUpload');
        if (!button) return;
        var signedIn = false;
        try {
            if (typeof getUserSession === 'function') signedIn = !!(await getUserSession()).authenticated;
        } catch (e) { signedIn = false; }
        if (!signedIn) return;
        button.classList.remove('hidden');
        button.addEventListener('click', async function () {
            var picker = $('ctbFiles');
            var files = picker && picker.files ? Array.prototype.slice.call(picker.files) : [];
            if (!files.length) { say('Choose at least one photo first.', 'bad'); return; }
            button.disabled = true;
            try { await send(files); } finally { button.disabled = false; }
        });
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
})();
