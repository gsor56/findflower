(function () {
    'use strict';

    var esc = (window.ffUi && ffUi.esc) ? ffUi.esc : function (s) {
        return String(s === null || s === undefined ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    };

    function $(id) { return document.getElementById(id); }

    // Every threshold below is read off the ingestion run in
    // training/find10k_deficit_topoff_448.py, which is what actually decides whether a
    // photo is kept. They are copied rather than fetched because that script never
    // reaches the browser. If one of them moves there it has to move here too, or this
    // page starts promising something the collection will not honour.
    var MIN_SIDE = 448;
    var BLUR_FLOOR = 40;
    var LUM_MIN = 18;
    var LUM_MAX = 238;
    var CONTRAST_MIN = 12;
    var CLIP_MAX = 0.45;
    var OUT_SIDE = 448;

    var MAX_BYTES = 10 * 1024 * 1024;
    var MAX_FILES = 8;
    var TYPES = { 'image/jpeg': 1, 'image/png': 1, 'image/webp': 1 };

    // A phone photo is measured at its own size, but a hundred megapixel scan would
    // lock the tab up inside getImageData, so the measuring canvas stops here and any
    // row that hit the cap says so.
    var MEASURE_SIDE = 4096;
    var MEASURE_PIXELS = 16777216;

    var LOW_CONFIDENCE = 0.4;

    var mode = 'known';
    var rows = [];
    var classNames = null;
    var geo = null;
    var bundle = null;
    var busy = false;
    var seq = 1;
    var teach = [];
    var mounted = false;

    function stamp() {
        return new Date().toISOString().slice(0, 10);
    }

    function fmtBytes(n) {
        if (!n) return '';
        if (n < 1024) return n + ' B';
        if (n < 1048576) return (n / 1024).toFixed(0) + ' KB';
        return (n / 1048576).toFixed(1) + ' MB';
    }

    function round(n, places) {
        var f = Math.pow(10, places || 0);
        return Math.round(n * f) / f;
    }

    function download(filename, text) {
        var blob = new Blob([text], { type: 'application/json' });
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(function () { URL.revokeObjectURL(url); }, 30000);
    }

    function viaImg(file) {
        return new Promise(function (resolve, reject) {
            var url = URL.createObjectURL(file);
            var img = new Image();
            img.onload = function () {
                URL.revokeObjectURL(url);
                resolve(img);
            };
            img.onerror = function () {
                URL.revokeObjectURL(url);
                reject(new Error('decode failed'));
            };
            img.src = url;
        });
    }

    function bitmapOf(file) {
        if (typeof createImageBitmap !== 'function') return viaImg(file);
        return createImageBitmap(file, { imageOrientation: 'from-image' })
            .catch(function () { return createImageBitmap(file); })
            .catch(function () { return viaImg(file); });
    }

    function toGray(data, len) {
        var gray = new Float64Array(len);
        for (var i = 0, p = 0; i < len; i++, p += 4) {
            gray[i] = Math.round(0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2]);
        }
        return gray;
    }

    // The variance of the Laplacian, with the same three by three kernel and the same
    // reflect-101 border OpenCV uses, so the figure lines up with the one the ingestion
    // run recorded for the photos already in the set.
    function lapVar(gray, w, h) {
        var n = w * h;
        var sum = 0;
        var sumSq = 0;
        for (var y = 0; y < h; y++) {
            var up = y === 0 ? Math.min(1, h - 1) : y - 1;
            var dn = y === h - 1 ? Math.max(0, h - 2) : y + 1;
            for (var x = 0; x < w; x++) {
                var lf = x === 0 ? Math.min(1, w - 1) : x - 1;
                var rt = x === w - 1 ? Math.max(0, w - 2) : x + 1;
                var v = gray[up * w + x] + gray[dn * w + x] +
                        gray[y * w + lf] + gray[y * w + rt] - 4 * gray[y * w + x];
                sum += v;
                sumSq += v * v;
            }
        }
        var mean = sum / n;
        return sumSq / n - mean * mean;
    }

    function measurePixels(src, w, h) {
        var scale = Math.min(1, MEASURE_SIDE / Math.max(w, h), Math.sqrt(MEASURE_PIXELS / (w * h)));
        var cw = Math.max(1, Math.round(w * scale));
        var ch = Math.max(1, Math.round(h * scale));
        var canvas = document.createElement('canvas');
        canvas.width = cw;
        canvas.height = ch;
        var ctx = canvas.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(src, 0, 0, cw, ch);
        var data = ctx.getImageData(0, 0, cw, ch).data;
        var n = cw * ch;
        var gray = toGray(data, n);
        var sum = 0;
        var clipped = 0;
        for (var i = 0; i < n; i++) {
            sum += gray[i];
            if (gray[i] <= 3 || gray[i] >= 252) clipped++;
        }
        var mean = sum / n;
        var acc = 0;
        for (var j = 0; j < n; j++) {
            var d = gray[j] - mean;
            acc += d * d;
        }
        return {
            sharpness: lapVar(gray, cw, ch),
            luminance: mean,
            contrast: Math.sqrt(acc / n),
            clipped: clipped / n,
            sampled: scale < 1
        };
    }

    // ImageOps.fit takes the middle square and resamples it, so the file this page
    // hands over is the same 448 crop the set stores rather than the original frame.
    function cropOut(src, w, h) {
        var side = Math.min(w, h);
        var sx = Math.round((w - side) / 2);
        var sy = Math.round((h - side) / 2);
        var canvas = document.createElement('canvas');
        canvas.width = OUT_SIDE;
        canvas.height = OUT_SIDE;
        var ctx = canvas.getContext('2d');
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(src, sx, sy, side, side, 0, 0, OUT_SIDE, OUT_SIDE);
        return canvas.toDataURL('image/jpeg', 0.95);
    }

    function gateFail(row) {
        var short = Math.min(row.width, row.height);
        if (short < MIN_SIDE) {
            return 'Shortest side is ' + short + ' pixels. The set needs ' + MIN_SIDE + ' or more.';
        }
        if (!(row.sharpness > BLUR_FLOOR)) {
            return 'Sharpness measures ' + round(row.sharpness, 1) + '. Anything at or below ' +
                BLUR_FLOOR + ' reads as blurred.';
        }
        if (row.luminance < LUM_MIN || row.luminance > LUM_MAX) {
            return 'Brightness measures ' + round(row.luminance, 1) + '. The set keeps ' +
                LUM_MIN + ' to ' + LUM_MAX + '.';
        }
        if (row.contrast < CONTRAST_MIN) {
            return 'Contrast measures ' + round(row.contrast, 1) + '. The set needs ' +
                CONTRAST_MIN + ' or more.';
        }
        if (row.clipped > CLIP_MAX) {
            return 'Blown out or crushed pixels cover ' + round(row.clipped * 100, 1) +
                '% of the frame. The set allows ' + round(CLIP_MAX * 100, 1) + '%.';
        }
        return '';
    }

    async function measure(file) {
        var row = {
            id: 'p' + (seq++),
            name: file.name || 'photo',
            bytes: file.size || 0,
            type: file.type || '',
            taken: file.lastModified || 0,
            ok: false,
            why: '',
            measured: false,
            image: ''
        };
        if (!TYPES[row.type]) {
            row.why = 'Only JPEG, PNG and WebP go into the set.';
            return row;
        }
        if (row.bytes > MAX_BYTES) {
            row.why = fmtBytes(row.bytes) + ' is over the 10 MB this page will carry.';
            return row;
        }
        var src;
        try {
            src = await bitmapOf(file);
        } catch (e) {
            row.why = 'This file could not be read as an image.';
            return row;
        }
        row.width = src.width || src.naturalWidth || 0;
        row.height = src.height || src.naturalHeight || 0;
        if (!row.width || !row.height) {
            row.why = 'This file could not be read as an image.';
            return row;
        }
        try {
            var stats = measurePixels(src, row.width, row.height);
            row.sharpness = stats.sharpness;
            row.luminance = stats.luminance;
            row.contrast = stats.contrast;
            row.clipped = stats.clipped;
            row.sampled = stats.sampled;
            row.measured = true;
            row.why = gateFail(row);
            row.ok = !row.why;
            if (row.ok) row.image = cropOut(src, row.width, row.height);
        } catch (e) {
            row.why = 'This browser ran out of room measuring a photo this large.';
        }
        if (src.close) src.close();
        return row;
    }

    function stat(label, value) {
        if (value === '' || value === null || value === undefined) return '';
        return '<div><dt class="inline text-neutral-400">' + esc(label) + '</dt> ' +
            '<dd class="inline text-neutral-600">' + esc(value) + '</dd></div>';
    }

    function rowHTML(row) {
        var thumb = row.image
            ? '<img src="' + esc(row.image) + '" alt="" class="w-full h-full object-cover">'
            : '';
        var figures = row.measured
            ? '<dl class="grid grid-cols-2 gap-x-6 gap-y-1 text-xs mt-2">' +
                stat('Size', row.width + ' x ' + row.height) +
                stat('Sharpness', round(row.sharpness, 1)) +
                stat('Brightness', round(row.luminance, 1)) +
                stat('Contrast', round(row.contrast, 1)) +
                stat('Clipped', round(row.clipped * 100, 1) + '%') +
                stat('Bytes', fmtBytes(row.bytes)) +
              '</dl>'
            : '';
        var verdict = row.ok
            ? '<p class="text-sm text-sage-700 mt-0.5">Cropped to 448 and ready to go.</p>'
            : '<p class="text-sm text-red-700 font-light mt-0.5">' + esc(row.why) + '</p>';
        var note = row.sampled
            ? '<p class="text-xs text-neutral-400 font-light mt-2">Measured on a smaller copy, ' +
                'because the full frame is too large to read in one pass here.</p>'
            : '';
        return '<li class="border border-neutral-200 rounded-lg p-4 flex gap-4">' +
            (thumb
                ? '<div class="w-16 h-16 shrink-0 rounded-md overflow-hidden ' +
                    'border border-neutral-200 bg-neutral-100">' + thumb + '</div>'
                : '') +
            '<div class="min-w-0 flex-1">' +
                '<p class="text-sm font-medium text-neutral-900 break-all">' + esc(row.name) + '</p>' +
                verdict + figures + note +
            '</div>' +
            '<button type="button" data-drop="' + esc(row.id) + '" class="soft-click shrink-0 text-sm ' +
                'text-neutral-400 hover:text-neutral-900 transition self-start">Remove</button>' +
        '</li>';
    }

    function passing() {
        return rows.filter(function (r) { return r.ok; });
    }

    function renderRows() {
        var list = $('ctbList');
        var tally = $('ctbTally');
        if (!list) return;
        list.innerHTML = rows.map(rowHTML).join('');
        if (!tally) return;
        if (!rows.length) {
            tally.classList.add('hidden');
            tally.textContent = '';
            return;
        }
        var good = passing().length;
        tally.classList.remove('hidden');
        tally.textContent = good
            ? good + ' of ' + rows.length + ' passed. Only those go into the file.'
            : 'Nothing here passed yet, so there is nothing to build.';
    }

    function titleCase(s) {
        return String(s || '').replace(/(^|\s)(\S)/g, function (m, pre, c) {
            return pre + c.toUpperCase();
        });
    }

    async function loadClasses() {
        var select = $('ctbKnown');
        var note = $('ctbKnownNote');
        if (!select) return;
        try {
            var res = await fetch('/models/lite/class_names.json', { cache: 'force-cache' });
            if (!res.ok) throw new Error('HTTP ' + res.status);
            var list = await res.json();
            if (!Array.isArray(list) || !list.length) throw new Error('empty list');
            classNames = list.slice();
        } catch (e) {
            select.innerHTML = '<option value="">The list did not load</option>';
            if (note) {
                note.textContent = 'The name list could not be read just now. Switch to the second ' +
                    'option above and type the name instead.';
                note.className = 'text-sm text-red-700 font-light mt-2';
                note.classList.remove('hidden');
            }
            return;
        }
        var sorted = classNames.slice().sort(function (a, b) { return a.localeCompare(b); });
        select.innerHTML = '<option value="">Pick a name</option>' + sorted.map(function (name) {
            return '<option value="' + esc(name) + '">' + esc(titleCase(name)) + '</option>';
        }).join('');
        if (note) {
            note.textContent = classNames.length + ' names, exactly as the offline model spells them.';
            note.className = 'text-sm text-neutral-500 font-light mt-2';
            note.classList.remove('hidden');
        }
    }

    async function take(fileList) {
        var files = Array.prototype.slice.call(fileList || []);
        if (!files.length) return;
        var room = MAX_FILES - rows.length;
        var over = files.length - room;
        if (room <= 0) files = [];
        else if (over > 0) files = files.slice(0, room);
        busy = true;
        ready();
        var tally = $('ctbTally');
        for (var i = 0; i < files.length; i++) {
            if (tally) {
                tally.classList.remove('hidden');
                tally.textContent = 'Measuring ' + (i + 1) + ' of ' + files.length + '.';
            }
            rows.push(await measure(files[i]));
            renderRows();
        }
        busy = false;
        if (over > 0) {
            if (tally) {
                tally.classList.remove('hidden');
                tally.textContent = 'Eight photos at a time is the limit here, so ' + over +
                    ' of them were left out.';
            }
        }
        bundle = null;
        hideSend();
        fillDate();
        ready();
    }

    function licence() {
        var picked = document.querySelector('input[name="ctbLicence"]:checked');
        return picked ? picked.value : 'cc-by';
    }

    function val(id) {
        var el = $(id);
        return el ? String(el.value || '').replace(/\s+/g, ' ').trim() : '';
    }

    function hideSend() {
        var send = $('ctbSend');
        if (send) send.classList.add('hidden');
    }

    function joinList(parts) {
        if (parts.length === 1) return parts[0];
        return parts.slice(0, -1).join(', ') + ' and ' + parts[parts.length - 1];
    }

    function missing() {
        var out = [];
        if (!passing().length) out.push('a photo that passes');
        if (mode === 'known' && !val('ctbKnown')) out.push('the name it goes under');
        if (mode === 'new') {
            if (!val('ctbNew')) out.push('a name to file it under');
            if (!val('ctbSource')) out.push('where that name comes from');
        }
        if (licence() !== 'cc0' && !val('ctbCredit')) out.push('the name to credit');
        var own = $('ctbOwn');
        var release = $('ctbRelease');
        if (!(own && own.checked) || !(release && release.checked)) out.push('both boxes ticked');
        return out;
    }

    function ready() {
        var btn = $('ctbPrep');
        var why = $('ctbWhy');
        if (!btn) return false;
        if (busy) {
            btn.disabled = true;
            if (why) why.textContent = 'Measuring.';
            return false;
        }
        var gaps = missing();
        btn.disabled = gaps.length > 0;
        if (why) {
            why.textContent = gaps.length
                ? 'Still needs ' + joinList(gaps) + '.'
                : 'Nothing is sent by pressing this. The file saves to this device, and the next ' +
                  'step is yours.';
        }
        return !gaps.length;
    }

    function geoNote(text, tone) {
        var note = $('ctbGeoNote');
        if (!note) return;
        note.textContent = text;
        note.className = 'text-sm font-light mt-2 ' +
            (tone === 'bad' ? 'text-red-700' : tone === 'good' ? 'text-sage-700' : 'text-neutral-500');
    }

    function askGeo() {
        var btn = $('ctbGeo');
        var drop = $('ctbGeoDrop');
        if (!navigator.geolocation) {
            geoNote('This browser has no location to give.', 'bad');
            return;
        }
        if (btn) {
            btn.disabled = true;
            btn.textContent = 'Asking';
        }
        navigator.geolocation.getCurrentPosition(function (pos) {
            geo = {
                latitude: round(pos.coords.latitude, 5),
                longitude: round(pos.coords.longitude, 5),
                accuracy_m: pos.coords.accuracy ? Math.round(pos.coords.accuracy) : null
            };
            if (btn) {
                btn.disabled = false;
                btn.textContent = 'Use my location';
                btn.classList.add('hidden');
            }
            if (drop) drop.classList.remove('hidden');
            geoNote(geo.latitude + ', ' + geo.longitude +
                (geo.accuracy_m ? ' to about ' + geo.accuracy_m + ' m' : '') +
                '. This goes in the file and nowhere else.', 'good');
            bundle = null;
            hideSend();
            ready();
        }, function (err) {
            if (btn) {
                btn.disabled = false;
                btn.textContent = 'Use my location';
            }
            geoNote(err && err.code === 1
                ? 'You turned that down, which is fine. The rest of the file works without it.'
                : 'Your location did not come back. The rest of the file works without it.', 'bad');
        }, { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 });
    }

    function dropGeo() {
        geo = null;
        var btn = $('ctbGeo');
        var drop = $('ctbGeoDrop');
        if (btn) btn.classList.remove('hidden');
        if (drop) drop.classList.add('hidden');
        geoNote('Gone. Nothing about where you were is in the file now.');
        bundle = null;
        hideSend();
    }

    function speciesName() {
        return mode === 'known' ? val('ctbKnown') : val('ctbNew');
    }

    function speciesLabel() {
        var sel = $('ctbKnown');
        if (mode !== 'known' || !sel || sel.selectedIndex < 0) return speciesName();
        return sel.options[sel.selectedIndex].textContent;
    }

    function makeBundle() {
        var good = passing();
        var code = licence();
        return {
            kind: 'findflower-contribution',
            schema: 1,
            built: new Date().toISOString(),
            species: speciesName(),
            known_class: mode === 'known' ? val('ctbKnown') : null,
            name_source: mode === 'new' ? val('ctbSource') : '',
            license_code: code,
            attribution: val('ctbCredit'),
            observed_on: val('ctbDate'),
            coordinates: geo,
            consent: { own_work: true, released_under_licence: true },
            normalized: { side: OUT_SIDE, format: 'image/jpeg', quality: 0.95, fit: 'centre crop' },
            gates: {
                min_short_side: MIN_SIDE,
                sharpness_over: BLUR_FLOOR,
                luminance_range: [LUM_MIN, LUM_MAX],
                contrast_min: CONTRAST_MIN,
                clipped_max: CLIP_MAX
            },
            photos: good.map(function (r) {
                return {
                    filename: r.name,
                    bytes: r.bytes,
                    type: r.type,
                    source_width: r.width,
                    source_height: r.height,
                    sharpness: round(r.sharpness, 2),
                    luminance: round(r.luminance, 2),
                    contrast: round(r.contrast, 2),
                    clipped: round(r.clipped, 4),
                    measured_on_smaller_copy: !!r.sampled,
                    image: r.image
                };
            })
        };
    }

    var LICENCE_LABEL = { 'cc-by': 'CC BY 4.0', 'cc0': 'CC0 1.0', 'cc-by-nc': 'CC BY-NC 4.0' };

    function fileName() {
        return 'findflower-contribution-' + stamp() + '.json';
    }

    function showSend(name) {
        var send = $('ctbSend');
        var what = $('ctbSendWhat');
        var mail = $('ctbMail');
        var issue = $('ctbIssue');
        if (!send) return;
        var count = bundle.photos.length;
        var lic = LICENCE_LABEL[bundle.license_code] || bundle.license_code;
        if (what) {
            what.textContent = name + ' is in your downloads. ' +
                (count === 1 ? 'One photo' : count + ' photos') + ' of ' +
                speciesLabel() + ', cropped to 448 square, under ' + lic +
                '. Neither a mail link nor an issue form can carry an attachment, ' +
                'so attach it yourself to whichever of these you would rather use.';
        }
        var subject = 'FindFlower contribution: ' + bundle.species;
        var body = 'Species: ' + bundle.species + '\n' +
            'Photos: ' + count + '\n' +
            'Licence: ' + lic + '\n' +
            'Credit: ' + (bundle.attribution || 'none given') + '\n' +
            (bundle.observed_on ? 'Observed: ' + bundle.observed_on + '\n' : '') +
            (bundle.name_source ? 'Name from: ' + bundle.name_source + '\n' : '') +
            '\nThe file ' + name + ' is attached. It holds the crops and the measured figures ' +
            'for each one.\n';
        if (mail) {
            mail.href = 'mailto:ibhx800@gmail.com?subject=' + encodeURIComponent(subject) +
                '&body=' + encodeURIComponent(body);
        }
        if (issue) {
            issue.href = 'https://github.com/gsor56/findflower/issues/new?title=' +
                encodeURIComponent(subject) + '&body=' +
                encodeURIComponent(body + '\nDrag ' + name + ' into this issue before posting it.\n');
        }
        send.classList.remove('hidden');
    }

    function build() {
        if (!ready()) return;
        bundle = makeBundle();
        var name = fileName();
        download(name, JSON.stringify(bundle, null, 2));
        showSend(name);
    }

    function relDate(iso) {
        var then = new Date(iso);
        if (isNaN(then.getTime())) return '';
        return then.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
    }

    function needsName(scan) {
        if (scan.correction && scan.correction.species) return '';
        if (scan.unknown) return 'You put this one down as unknown.';
        var name = window.ffStore && typeof ffStore.displaySpecies === 'function'
            ? ffStore.displaySpecies(scan) : scan.species;
        if (!name) return 'Saved with no name on it.';
        if (typeof scan.confidence === 'number' && scan.confidence < LOW_CONFIDENCE) {
            return 'It answered ' + Math.round(scan.confidence * 100) + '%, which it calls low.';
        }
        return '';
    }

    function teachHTML(item) {
        var scan = item.scan;
        var name = String(scan.species || '');
        var told = name && name.toLowerCase() !== 'unknown' ? titleCase(name) : '';
        var thumb = scan.imageBase64
            ? '<img src="' + esc(scan.imageBase64) + '" alt="" class="w-full h-full object-cover">'
            : '';
        return '<li data-scan="' + esc(scan.id) + '" class="border border-neutral-200 rounded-lg p-4 flex gap-4">' +
            (thumb
                ? '<div class="w-16 h-16 shrink-0 rounded-md overflow-hidden ' +
                    'border border-neutral-200 bg-neutral-100">' + thumb + '</div>'
                : '') +
            '<div class="min-w-0 flex-1">' +
                (told
                    ? '<p class="text-sm font-medium text-neutral-900">It said ' +
                        esc(told) + '</p>'
                    : '') +
                '<p data-reason class="' + (told
                    ? 'text-xs text-neutral-400 font-light mt-0.5'
                    : 'text-sm font-medium text-neutral-900') + '">' +
                    esc(item.reason) +
                    (scan.timestamp ? ' ' + esc(relDate(scan.timestamp)) : '') + '</p>' +
                '<input type="text" data-name class="field mt-3" maxlength="120" ' +
                    'placeholder="What it actually is">' +
                '<div class="flex flex-wrap gap-3 mt-3">' +
                    '<button type="button" data-save class="soft-click text-sm font-medium ' +
                        'bg-neutral-900 text-white px-4 py-2.5 rounded-md hover:bg-neutral-800 ' +
                        'transition">Save this name</button>' +
                    '<button type="button" data-unknown class="soft-click text-sm text-neutral-500 ' +
                        'hover:text-neutral-900 transition">Leave it unnamed</button>' +
                '</div>' +
                '<p data-said class="hidden text-sm font-light mt-2"></p>' +
            '</div>' +
        '</li>';
    }

    var TEACH_EMPTY =
        '<div class="border border-dashed border-neutral-300 rounded-lg p-8 text-center">' +
            '<p class="text-base text-neutral-500 font-light">Every find saved in this browser ' +
                'already carries a name.</p>' +
            '<a href="/try" class="inline-flex items-center justify-center mt-4 min-h-[44px] px-6 ' +
                'rounded-md bg-neutral-900 text-white text-sm font-medium hover:bg-neutral-800 ' +
                'transition-colors">Scan something new</a>' +
        '</div>';

    function writeCount() {
        var count = $('teachCount');
        if (!count) return;
        if (!teach.length) {
            count.classList.add('hidden');
            return;
        }
        count.classList.remove('hidden');
        count.textContent = teach.length === 1
            ? 'One find is waiting for a name.'
            : teach.length + ' finds are waiting for a name.';
    }

    function renderTeach() {
        var list = $('teachList');
        var empty = $('teachEmpty');
        if (!list) return;
        list.innerHTML = teach.map(teachHTML).join('');
        writeCount();
        if (empty) {
            if (teach.length) {
                empty.classList.add('hidden');
            } else {
                if (!empty.innerHTML.trim()) empty.innerHTML = TEACH_EMPTY;
                empty.classList.remove('hidden');
            }
        }
    }

    async function loadTeach() {
        var list = $('teachList');
        if (!list) return;
        if (!window.ffStore || typeof ffStore.getScans !== 'function') {
            list.innerHTML = '<li class="text-sm text-red-700 font-light">Your saved finds could ' +
                'not be read in this browser.</li>';
            return;
        }
        var scans = [];
        try {
            scans = await ffStore.getScans() || [];
        } catch (e) {
            list.innerHTML = '<li class="text-sm text-red-700 font-light">Your saved finds could ' +
                'not be read in this browser.</li>';
            return;
        }
        teach = [];
        scans.forEach(function (scan) {
            var reason = needsName(scan);
            if (reason) teach.push({ scan: scan, reason: reason });
        });
        renderTeach();
    }

    function said(li, text, tone) {
        var el = li.querySelector('[data-said]');
        if (!el) return;
        el.textContent = text;
        el.className = 'text-sm font-light mt-2 ' +
            (tone === 'bad' ? 'text-red-700' : 'text-sage-700');
        el.classList.remove('hidden');
    }

    function forget(id) {
        teach = teach.filter(function (t) { return String(t.scan.id) !== String(id); });
        writeCount();
    }

    async function nameIt(li, id) {
        var input = li.querySelector('[data-name]');
        var name = input ? String(input.value || '').replace(/\s+/g, ' ').trim() : '';
        if (!name) {
            said(li, 'Type the name first.', 'bad');
            return;
        }
        try {
            await ffStore.setCorrection(id, { species: name });
        } catch (e) {
            said(li, 'That name could not be written to your records.', 'bad');
            return;
        }
        forget(id);
        said(li, 'Written. Your history and your albums call it ' + name + ' now.');
    }

    async function unknownIt(li, id) {
        try {
            await ffStore.setUnknown(id, true);
        } catch (e) {
            said(li, 'That could not be written to your records.', 'bad');
            return;
        }
        said(li, 'Left unnamed. It shows without a name everywhere in your records.');
    }

    function onTeachClick(e) {
        var save = e.target.closest ? e.target.closest('[data-save]') : null;
        var unk = e.target.closest ? e.target.closest('[data-unknown]') : null;
        if (!save && !unk) return;
        var li = (save || unk).closest('li[data-scan]');
        if (!li) return;
        var id = li.getAttribute('data-scan');
        if (save) nameIt(li, id);
        else unknownIt(li, id);
    }

    var MODE_NOTE = {
        known: 'The offline model already reads this name, so every extra photo sharpens a class ' +
            'that exists. Per photo, this is the one that helps most.',
        'new': 'Nothing in the set answers to this name yet. A species needs 300 photos before it ' +
            'earns a class of its own, so treat one photo as a start.',
        teach: 'This one stays on your device. You are correcting your own records, and none of it ' +
            'travels.'
    };

    function setMode(next) {
        mode = MODE_NOTE[next] ? next : 'known';
        var buttons = document.querySelectorAll('.choice[data-mode]');
        Array.prototype.forEach.call(buttons, function (b) {
            b.setAttribute('aria-pressed', b.getAttribute('data-mode') === mode ? 'true' : 'false');
        });
        var note = $('modeNote');
        if (note) note.textContent = MODE_NOTE[mode];
        var photo = $('photoPanel');
        var teachPanel = $('teachPanel');
        if (photo) photo.classList.toggle('hidden', mode === 'teach');
        if (teachPanel) teachPanel.classList.toggle('hidden', mode !== 'teach');
        var known = $('ctbKnownBox');
        var fresh = $('ctbNewBox');
        if (known) known.classList.toggle('hidden', mode !== 'known');
        if (fresh) fresh.classList.toggle('hidden', mode !== 'new');
        if (mode === 'teach') loadTeach();
        else ready();
    }

    function fillDate() {
        var field = $('ctbDate');
        if (!field || field.value) return;
        var first = passing()[0];
        if (!first || !first.taken) return;
        var when = new Date(first.taken);
        if (isNaN(when.getTime())) return;
        var pad = function (n) { return String(n).padStart(2, '0'); };
        field.value = when.getFullYear() + '-' + pad(when.getMonth() + 1) + '-' + pad(when.getDate());
    }

    function onDragOver(e) {
        e.preventDefault();
        if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
        var drop = $('ctbDrop');
        if (drop) drop.classList.add('border-sage-400');
    }

    function onDragLeave() {
        var drop = $('ctbDrop');
        if (drop) drop.classList.remove('border-sage-400');
    }

    function onDrop(e) {
        e.preventDefault();
        onDragLeave();
        if (e.dataTransfer && e.dataTransfer.files) take(e.dataTransfer.files);
    }

    function onListClick(e) {
        var btn = e.target.closest ? e.target.closest('[data-drop]') : null;
        if (!btn) return;
        var id = btn.getAttribute('data-drop');
        rows = rows.filter(function (r) { return r.id !== id; });
        bundle = null;
        hideSend();
        renderRows();
        ready();
    }

    function onFieldChange() {
        bundle = null;
        hideSend();
        ready();
    }

    function wire() {
        var files = $('ctbFiles');
        if (files) {
            files.addEventListener('change', function () {
                take(files.files);
                files.value = '';
            });
        }
        var drop = $('ctbDrop');
        if (drop) {
            drop.addEventListener('dragover', onDragOver);
            drop.addEventListener('dragleave', onDragLeave);
            drop.addEventListener('drop', onDrop);
        }
        var list = $('ctbList');
        if (list) list.addEventListener('click', onListClick);
        var teachList = $('teachList');
        if (teachList) teachList.addEventListener('click', onTeachClick);
        Array.prototype.forEach.call(document.querySelectorAll('.choice[data-mode]'), function (b) {
            b.addEventListener('click', function () { setMode(b.getAttribute('data-mode')); });
        });
        ['ctbKnown', 'ctbNew', 'ctbSource', 'ctbCredit'].forEach(function (id) {
            var el = $(id);
            if (!el) return;
            el.addEventListener('input', onFieldChange);
            el.addEventListener('change', onFieldChange);
        });
        ['ctbOwn', 'ctbRelease'].forEach(function (id) {
            var el = $(id);
            if (el) el.addEventListener('change', onFieldChange);
        });
        Array.prototype.forEach.call(document.querySelectorAll('input[name="ctbLicence"]'),
            function (el) { el.addEventListener('change', onFieldChange); });
        var geoBtn = $('ctbGeo');
        if (geoBtn) geoBtn.addEventListener('click', askGeo);
        var geoOut = $('ctbGeoDrop');
        if (geoOut) geoOut.addEventListener('click', dropGeo);
        var prep = $('ctbPrep');
        if (prep) prep.addEventListener('click', build);
        var again = $('ctbAgain');
        if (again) {
            again.addEventListener('click', function () {
                if (bundle) download(fileName(), JSON.stringify(bundle, null, 2));
            });
        }
    }

    async function mount() {
        mounted = true;
        rows = [];
        teach = [];
        geo = null;
        bundle = null;
        busy = false;
        if (!$('ctbPrep')) return;
        wire();
        setMode('known');
        renderRows();
        await loadClasses();
        ready();
    }

    function unmount() {
        mounted = false;
        rows = [];
        teach = [];
        geo = null;
        bundle = null;
        busy = false;
    }

    window.ffViews = window.ffViews || {};
    window.ffViews['contribute.html'] = { mount: mount, unmount: unmount };

    window.ffContribute = {
        measurePixels: measurePixels,
        gateFail: gateFail,
        makeBundle: makeBundle,
        missing: missing,
        setMode: setMode,
        get mode() { return mode; },
        get rows() { return rows; },
        get bundle() { return bundle; },
        get mounted() { return mounted; },
    };
})();
