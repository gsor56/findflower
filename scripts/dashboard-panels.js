/* ============================================================================
   FindFlower — dashboard panels (scripts/dashboard-panels.js)
   ----------------------------------------------------------------------------
   The four sections below the badge shelf on /dashboard:

     Preferences        the four switches prefs.js stores and try.html obeys
     Places             where the located scans were taken
     Model & data       what identifies a flower, and what leaves this device
     Storage            what IndexedDB holds here, exportable and erasable

   In its own file rather than dashboard.html's inline IIFE for one concrete
   reason: dashboard.html hides <main> and shows the sign-in wall for a guest,
   so nothing inside it can be reached by a test that has no Auth0 session.
   window.ffPanels.mount() is the seam -- settings.qa.mjs unhides #dashMain,
   calls mount(), and drives the switches with no session at all.

   Every panel renders into a host element by id and skips itself when that id
   is absent, so a page can adopt one panel without taking all four.
   ========================================================================== */
(function () {
    'use strict';

    // Facts, not marketing: both numbers are the ones releases.html and
    // api.html already publish. Kept here so a model change is one edit.
    var MODEL = { arch: 'Vision Transformer (ViT)', classes: 116 };

    // The local correction log. try.html writes {predicted, confidence,
    // correct, correction} and feedback.html writes {predicted, correct,
    // correction, notes, hasImage, at} -- so `at` is optional by history, and
    // anything reading this has to tolerate its absence.
    var FEEDBACK_KEY = 'ff_feedback';

    var teardown = [];
    var state = { uid: null, scans: [], stats: null };

    function $(id) { return document.getElementById(id); }

    function esc(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
        });
    }

    function titleCase(s) {
        return String(s || '').replace(/\b\w/g, function (c) { return c.toUpperCase(); });
    }

    function fmtBytes(n) {
        if (typeof n !== 'number' || !isFinite(n) || n < 0) return '—';
        if (n < 1024) return n + ' B';
        if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
        if (n < 1024 * 1024 * 1024) return (n / (1024 * 1024)).toFixed(1) + ' MB';
        // Quotas are gigabytes. Without this rung the browser's own estimate
        // reads "10240.0 MB", which nobody says out loud.
        return (n / (1024 * 1024 * 1024)).toFixed(1) + ' GB';
    }

    function fmtDate(iso) {
        var d = new Date(iso);
        if (isNaN(d)) return '';
        return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
    }

    /** The correction log, or [] for private mode, absent key, or hand-edited
     *  JSON. A malformed log must not take the whole panel down with it. */
    function readFeedback() {
        try {
            var raw = JSON.parse(localStorage.getItem(FEEDBACK_KEY) || '[]');
            return Array.isArray(raw) ? raw : [];
        } catch (e) {
            return [];
        }
    }

    /** Hand the browser a file. Object URL rather than a data: URL because a
     *  full history export with thumbnails runs to megabytes, and Safari caps
     *  data: navigations well below that. */
    function download(filename, text) {
        var blob = new Blob([text], { type: 'application/json' });
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
        // Revoked on a timer: revoking in the same tick cancels the download in
        // Firefox, which reads the blob after the click handler returns.
        setTimeout(function () { URL.revokeObjectURL(url); }, 30000);
    }

    function stamp() {
        return new Date().toISOString().slice(0, 10);
    }

    /** Two-step destructive buttons. The first click arms and relabels; a
     *  second click within 5s commits. Nothing here can be undone, and a
     *  confirm() is suppressible in a way an inline arm state is not. */
    function arm(btn, armedLabel, run) {
        var idle = btn.textContent;
        var armed = false;
        var timer = null;
        function reset() {
            armed = false;
            btn.textContent = idle;
            btn.className = btn.getAttribute('data-idle-class');
        }
        btn.setAttribute('data-idle-class', btn.className);
        btn.addEventListener('click', function () {
            if (!armed) {
                armed = true;
                btn.textContent = armedLabel;
                btn.className = btn.getAttribute('data-idle-class')
                    .replace('border-neutral-300', 'border-red-300')
                    .replace('text-neutral-700', 'text-red-700');
                timer = setTimeout(reset, 5000);
                return;
            }
            clearTimeout(timer);
            reset();
            run();
        });
    }

    // === Preferences =====================================================
    // Each entry names the behaviour the switch changes, in both positions,
    // because a settings row that only says "Attach location" makes the reader
    // guess. The `on`/`off` copy is what the switch actually does -- if one of
    // these lines ever stops being true, the switch is the bug.
    var PREFS = [
        {
            key: 'attachLocation',
            label: 'Attach location to a scan',
            on: 'The scanner asks this browser for coordinates before it saves an identification, and Places below fills in. The permission prompt appears on your next scan, not now.',
            off: 'No location prompt. New scans are saved without coordinates; ones you already have are kept.'
        },
        {
            key: 'keepPhotos',
            label: 'Keep a thumbnail with each scan',
            on: 'A 320px JPEG of each capture is stored on this device, so Recent identifications shows the flower you photographed.',
            off: 'Scans are saved as species, confidence and time only. This is the setting that costs the least storage.'
        },
        {
            key: 'recordHistory',
            label: 'Record scan history',
            on: 'Identifications are written to this device. Your streak, badges and species count all read from that history.',
            off: 'Nothing new is written. Identifying still works — the dashboard just stops filling up. Existing history is left alone.'
        },
        {
            key: 'reduceMotion',
            label: 'Reduce motion',
            on: 'Animations across the site collapse to a still frame.',
            off: 'Full motion, unless your operating system already asks every site for less.'
        }
    ];

    function switchRow(p, on) {
        return '' +
        '<div class="flex items-start justify-between gap-4 py-4 border-b border-neutral-100 last:border-b-0">' +
            '<div class="min-w-0">' +
                '<p id="' + p.key + 'Label" class="text-sm font-medium text-neutral-900">' + esc(p.label) + '</p>' +
                '<p class="text-xs text-neutral-500 leading-relaxed mt-1">' + esc(on ? p.on : p.off) + '</p>' +
            '</div>' +
            '<button type="button" role="switch" data-pref="' + p.key + '" data-haptic' +
                    ' aria-checked="' + (on ? 'true' : 'false') + '" aria-labelledby="' + p.key + 'Label"' +
                    ' class="tap shrink-0 flex items-center justify-center rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sage-500 focus-visible:ring-offset-2">' +
                '<span aria-hidden="true" class="relative block w-11 h-6 rounded-full border transition-colors ' +
                    (on ? 'bg-sage-600 border-sage-700' : 'bg-neutral-200 border-neutral-300') + '">' +
                    '<span class="absolute top-0.5 w-5 h-5 rounded-full bg-white shadow-sm transition-all ' +
                        (on ? 'right-0.5' : 'left-0.5') + '"></span>' +
                '</span>' +
            '</button>' +
        '</div>';
    }

    /** Draw the rows. Called again after every toggle, because the hint line
     *  under a switch is a function of its value and one code path should draw
     *  both states. The delegated listener lives in renderPrefs(), NOT here --
     *  host survives the innerHTML swap, so wiring it per paint would stack a
     *  second handler on every toggle and the switch would flip twice. */
    function paintPrefs(host) {
        var values = window.ffPrefs.all();
        var rows = PREFS.map(function (p) { return switchRow(p, !!values[p.key]); }).join('');
        host.innerHTML =
            '<div id="prefRows">' + rows + '</div>' +
            '<p id="prefWarn" class="hidden text-xs text-red-700 bg-red-50 border border-red-200 rounded-xl px-3 py-2 mt-4">' +
                'This browser refused to store the setting. It applies for now but will be forgotten on reload — ' +
                'private windows and full storage both do this.' +
            '</p>' +
            '<div class="flex items-center justify-between gap-4 pt-4 mt-2 border-t border-neutral-100">' +
                '<p class="text-xs text-neutral-400">Stored on this device only, so it does not follow your account to another browser.</p>' +
                '<button type="button" id="prefReset" data-haptic class="soft-click tap shrink-0 px-4 text-xs font-medium text-neutral-700 border border-neutral-300 rounded-full hover:bg-neutral-50 transition">Restore defaults</button>' +
            '</div>';

        // Recreated by the swap above, so wiring it here leaks nothing.
        $('prefReset').addEventListener('click', function () {
            window.ffPrefs.reset();
            paintPrefs(host);
            renderPlaces($('panelPlaces'));
            renderStorage($('panelStorage'));
        });
    }

    /** Repaint the switches from another panel, without re-attaching the
     *  delegated handler renderPrefs() owns. */
    function repaintPrefs() {
        var h = $('panelPrefs');
        if (h && window.ffPrefs && h.querySelector('[data-pref]')) paintPrefs(h);
    }

    function renderPrefs(host) {
        if (!host) return;
        if (!window.ffPrefs) {
            host.innerHTML = '<p class="text-sm text-neutral-500">Preferences need prefs.js, which this page did not load.</p>';
            return;
        }
        paintPrefs(host);

        function onClick(e) {
            var btn = e.target.closest ? e.target.closest('[data-pref]') : null;
            if (!btn || !host.contains(btn)) return;
            var key = btn.getAttribute('data-pref');
            var next = btn.getAttribute('aria-checked') !== 'true';
            var stored = window.ffPrefs.set(key, next);
            paintPrefs(host);
            if (!stored) $('prefWarn').classList.remove('hidden');
            // Places reads attachLocation for its empty state, and Storage
            // reports what keepPhotos will do to the next write.
            if (key === 'attachLocation') renderPlaces($('panelPlaces'));
            if (key === 'keepPhotos' || key === 'recordHistory') renderStorage($('panelStorage'));
        }

        host.addEventListener('click', onClick);
        teardown.push(function () { host.removeEventListener('click', onClick); });
    }

    // === Places ==========================================================
    /**
     * Group located scans by rounded coordinate.
     *
     * 3 decimal places is about 110m at the equator and less further from it,
     * which is the point: a garden, a park corner, one stretch of path. Full
     * 5-dp keys (what ffGeolocate stores, ~1m) would make every scan its own
     * "place" because GPS never returns the same fix twice.
     */
    function groupPlaces(scans) {
        var byKey = {};
        var order = [];
        for (var i = 0; i < scans.length; i++) {
            var g = scans[i].geolocation;
            if (!g || typeof g.lat !== 'number' || typeof g.lon !== 'number') continue;
            var key = g.lat.toFixed(3) + ',' + g.lon.toFixed(3);
            if (!byKey[key]) {
                byKey[key] = { key: key, lat: g.lat, lon: g.lon, accuracy: g.accuracy, species: [], count: 0, last: scans[i].timestamp };
                order.push(key);
            }
            var p = byKey[key];
            p.count += 1;
            var name = titleCase(scans[i].species || '');
            if (name && p.species.indexOf(name) === -1) p.species.push(name);
            // scans arrive newest-first, so the first timestamp seen is the latest.
            if (!p.last || scans[i].timestamp > p.last) p.last = scans[i].timestamp;
        }
        return order.map(function (k) { return byKey[k]; }).sort(function (a, b) { return b.count - a.count; });
    }

    function placeCard(p) {
        // zoom 15 shows a few streets -- close enough to recognise the spot,
        // wide enough that it is not a pin on someone's front door.
        var osm = 'https://www.openstreetmap.org/?mlat=' + p.lat + '&mlon=' + p.lon + '#map=15/' + p.lat + '/' + p.lon;
        return '' +
        '<div class="bg-white border border-neutral-200 rounded-2xl p-4 shadow-subtle">' +
            '<div class="flex items-start justify-between gap-3">' +
                '<div class="min-w-0">' +
                    '<p class="text-sm font-medium text-neutral-900">' + esc(p.lat.toFixed(3)) + ', ' + esc(p.lon.toFixed(3)) + '</p>' +
                    '<p class="text-xs text-neutral-400 mt-0.5">' +
                        p.count + (p.count === 1 ? ' scan' : ' scans') +
                        (p.last ? ' · ' + esc(fmtDate(p.last)) : '') +
                        (typeof p.accuracy === 'number' && p.accuracy ? ' · ±' + p.accuracy + 'm' : '') +
                    '</p>' +
                '</div>' +
                '<span class="shrink-0 text-base" aria-hidden="true">📍</span>' +
            '</div>' +
            '<p class="text-xs text-neutral-600 leading-relaxed mt-3">' + esc(p.species.slice(0, 4).join(', ')) +
                (p.species.length > 4 ? ' <span class="text-neutral-400">+' + (p.species.length - 4) + ' more</span>' : '') +
            '</p>' +
            '<a href="' + esc(osm) + '" target="_blank" rel="noopener noreferrer" class="tap inline-flex items-center mt-1 -mb-2 text-xs font-medium text-sage-700 hover:text-sage-600 transition-colors">Open in OpenStreetMap &rarr;</a>' +
        '</div>';
    }

    function renderPlaces(host) {
        if (!host) return;
        var places = groupPlaces(state.scans);
        var on = window.ffPrefs ? window.ffPrefs.get('attachLocation') : false;

        if (!places.length) {
            var why, action;
            if (!state.scans.length) {
                why = 'Once you identify a flower with location on, the places you found it appear here.';
                action = '<a href="/try" class="tap inline-flex items-center justify-center mt-4 px-5 bg-neutral-900 text-white text-sm font-medium rounded-full hover:bg-neutral-800 transition-colors">Identify a flower</a>';
            } else if (!on) {
                why = 'None of your ' + state.scans.length + ' identifications carry coordinates, because location is switched off above.';
                action = '<button type="button" id="placesEnable" data-haptic class="soft-click tap inline-flex items-center justify-center mt-4 px-5 border border-neutral-300 text-sm font-medium rounded-full hover:bg-neutral-50 transition">Turn on location for new scans</button>';
            } else {
                // The pref is on but nothing is located: either no scan since,
                // or the browser prompt was dismissed or denied.
                why = 'Location is on, so your next identification will be placed here. If nothing appears, this browser may have denied the location permission for the site.';
                action = '<a href="/try" class="tap inline-flex items-center justify-center mt-4 px-5 bg-neutral-900 text-white text-sm font-medium rounded-full hover:bg-neutral-800 transition-colors">Identify a flower</a>';
            }
            host.innerHTML =
                '<div class="border border-dashed border-neutral-300 rounded-2xl p-8 text-center">' +
                    '<p class="text-sm text-neutral-500 max-w-md mx-auto leading-relaxed">' + esc(why) + '</p>' + action +
                '</div>';
            var enable = $('placesEnable');
            if (enable) {
                enable.addEventListener('click', function () {
                    window.ffPrefs.set('attachLocation', true);
                    repaintPrefs();
                    renderPlaces(host);
                });
            }
            return;
        }

        var located = places.reduce(function (n, p) { return n + p.count; }, 0);
        host.innerHTML =
            '<div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">' +
                places.slice(0, 9).map(placeCard).join('') +
            '</div>' +
            '<p class="text-xs text-neutral-400 mt-4 leading-relaxed">' +
                located + ' of ' + state.scans.length + ' identifications carry coordinates, rounded to about 110m and grouped. ' +
                'They were never sent anywhere — they sit in this browser\'s database with the rest of your history.' +
                (places.length > 9 ? ' Showing your nine busiest places.' : '') +
            '</p>';
    }

    // === Model & data ====================================================
    /** One "spec sheet" row. `note` is the honest caveat, not a footnote. */
    function factRow(label, value, note) {
        return '' +
        '<div class="flex flex-wrap items-baseline gap-x-3 gap-y-1 py-3 border-b border-neutral-100 last:border-b-0">' +
            '<dt class="text-xs uppercase tracking-wider text-neutral-400 w-full sm:w-40 shrink-0">' + esc(label) + '</dt>' +
            '<dd class="text-sm text-neutral-900 min-w-0">' + value +
                (note ? '<span class="block text-xs text-neutral-500 leading-relaxed mt-0.5">' + esc(note) + '</span>' : '') +
            '</dd>' +
        '</div>';
    }

    function renderModel(host) {
        if (!host) return;
        var log = readFeedback();
        var dated = log.filter(function (r) { return r && r.at; });
        var last = dated.length ? dated[dated.length - 1].at : null;
        var withPhoto = log.filter(function (r) { return r && r.hasImage; }).length;
        var disagreed = log.filter(function (r) { return r && r.correct === false; }).length;

        host.innerHTML =
        '<div class="grid grid-cols-1 lg:grid-cols-2 gap-4">' +
            '<div class="bg-white border border-neutral-200 rounded-2xl p-5 shadow-subtle">' +
                '<h3 class="text-sm font-medium text-neutral-900">What identifies your flower</h3>' +
                '<dl class="mt-3">' +
                    factRow('Architecture', esc(MODEL.arch), 'Beta. It returns a ranked guess with a confidence score, not a verdict.') +
                    factRow('Vocabulary', MODEL.classes + ' botanical classes', 'Anything outside those classes comes back as the nearest match it knows, which is why the runners-up are always shown.') +
                    factRow('Runs on', 'A hosted inference endpoint', 'Not in your browser: the photo is uploaded, analysed, and the weights stay on the server.') +
                    factRow('Your photo', 'Not stored afterwards', 'It is used to return the prediction and nothing else. Only the species and confidence come back.') +
                '</dl>' +
                '<div class="flex flex-wrap gap-x-4 gap-y-1 mt-4">' +
                    '<a href="/privacy#images" class="text-xs font-medium text-sage-700 hover:text-sage-600 transition-colors">How images are handled &rarr;</a>' +
                    '<a href="/releases" class="text-xs font-medium text-sage-700 hover:text-sage-600 transition-colors">Model release notes &rarr;</a>' +
                    '<a href="/api" class="text-xs font-medium text-sage-700 hover:text-sage-600 transition-colors">API reference &rarr;</a>' +
                '</div>' +
            '</div>' +
            '<div class="bg-white border border-neutral-200 rounded-2xl p-5 shadow-subtle flex flex-col">' +
                '<h3 class="text-sm font-medium text-neutral-900">What you have contributed</h3>' +
                '<p class="text-xs text-neutral-500 leading-relaxed mt-2">' +
                    'Every time you tell the scanner it was right or wrong, that verdict is written to this browser and nowhere else. ' +
                    'When the improvement pipeline launches, corrections you submit are what will make the next model better — ' +
                    'nothing here has been sent yet.' +
                '</p>' +
                '<div class="grid grid-cols-3 gap-3 mt-4">' +
                    '<div><p class="font-serif text-2xl text-neutral-900">' + log.length + '</p><p class="text-xs text-neutral-400 mt-0.5">verdicts</p></div>' +
                    '<div><p class="font-serif text-2xl text-neutral-900">' + disagreed + '</p><p class="text-xs text-neutral-400 mt-0.5">corrections</p></div>' +
                    '<div><p class="font-serif text-2xl text-neutral-900">' + withPhoto + '</p><p class="text-xs text-neutral-400 mt-0.5">with a photo</p></div>' +
                '</div>' +
                (last ? '<p class="text-xs text-neutral-400 mt-3">Most recent: ' + esc(fmtDate(last)) + '.</p>' : '') +
                '<div class="flex flex-wrap gap-2 mt-auto pt-4">' +
                    '<button type="button" id="fbExport" data-haptic class="soft-click tap px-4 text-xs font-medium text-neutral-700 border border-neutral-300 rounded-full hover:bg-neutral-50 transition disabled:opacity-40 disabled:hover:bg-transparent"' + (log.length ? '' : ' disabled') + '>Export my feedback</button>' +
                    '<button type="button" id="fbClear" data-haptic class="soft-click tap px-4 text-xs font-medium text-neutral-700 border border-neutral-300 rounded-full hover:bg-neutral-50 transition disabled:opacity-40 disabled:hover:bg-transparent"' + (log.length ? '' : ' disabled') + '>Clear my feedback</button>' +
                '</div>' +
                '<p id="fbNote" class="hidden text-xs text-sage-700 mt-2"></p>' +
            '</div>' +
        '</div>';

        var exportBtn = $('fbExport');
        var clearBtn = $('fbClear');
        var note = $('fbNote');

        if (exportBtn && log.length) {
            exportBtn.addEventListener('click', function () {
                download('findflower-feedback-' + stamp() + '.json', JSON.stringify({
                    exported: new Date().toISOString(),
                    source: 'FindFlower local feedback log (' + FEEDBACK_KEY + ')',
                    entries: log
                }, null, 2));
                note.textContent = 'Downloaded ' + log.length + (log.length === 1 ? ' entry.' : ' entries.');
                note.classList.remove('hidden');
            });
        }

        // privacy.html promises "You can clear locally stored feedback at any
        // time from your browser". Until this button existed, that sentence was
        // only true for someone who knew how to open devtools.
        if (clearBtn && log.length) {
            arm(clearBtn, 'Delete ' + log.length + ' — tap again', function () {
                try { localStorage.removeItem(FEEDBACK_KEY); } catch (e) { /* nothing to remove */ }
                renderModel(host);
                var n = $('fbNote');
                n.textContent = 'Feedback log deleted from this browser.';
                n.classList.remove('hidden');
            });
        }
    }

    // === Storage =========================================================
    /** Rough on-disk cost of the thumbnails, from the base64 length: four
     *  characters encode three bytes. Reported as approximate because it is. */
    function thumbBytes(scans) {
        var n = 0;
        for (var i = 0; i < scans.length; i++) {
            var b = scans[i].imageBase64;
            if (typeof b === 'string') n += Math.round(b.length * 0.75);
        }
        return n;
    }

    function countRow(label, value, note) {
        return '' +
        '<div class="flex items-baseline justify-between gap-3 py-2.5 border-b border-neutral-100 last:border-b-0">' +
            '<span class="text-sm text-neutral-600 min-w-0">' + esc(label) +
                (note ? '<span class="block text-xs text-neutral-400">' + esc(note) + '</span>' : '') +
            '</span>' +
            '<span class="text-sm font-medium text-neutral-900 shrink-0">' + esc(value) + '</span>' +
        '</div>';
    }

    function renderStorage(host) {
        if (!host) return;
        var scans = state.scans;
        var thumbs = scans.filter(function (s) { return !!s.imageBase64; }).length;
        var located = scans.filter(function (s) { return s.geolocation && typeof s.geolocation.lat === 'number'; }).length;
        var log = readFeedback();
        var keep = window.ffPrefs ? window.ffPrefs.get('keepPhotos') : true;
        var record = window.ffPrefs ? window.ffPrefs.get('recordHistory') : true;

        host.innerHTML =
        '<div class="grid grid-cols-1 lg:grid-cols-2 lg:items-start gap-4">' +
            '<div class="bg-white border border-neutral-200 rounded-2xl p-5 shadow-subtle">' +
                '<h3 class="text-sm font-medium text-neutral-900">What this browser is holding</h3>' +
                '<div class="mt-3">' +
                    countRow('Identifications', String(scans.length), record ? null : 'History recording is off, so this number is frozen.') +
                    countRow('Thumbnails kept', String(thumbs), keep ? 'About ' + fmtBytes(thumbBytes(scans)) + ' of the total below.' : 'Thumbnails are off for new scans.') +
                    countRow('Scans with coordinates', String(located), null) +
                    countRow('Feedback entries', String(log.length), null) +
                '</div>' +
                '<div id="quotaWrap" class="hidden mt-4 pt-4 border-t border-neutral-100">' +
                    '<div class="flex items-baseline justify-between gap-3">' +
                        '<span class="text-xs uppercase tracking-wider text-neutral-400">Site storage</span>' +
                        '<span id="quotaText" class="text-xs text-neutral-500"></span>' +
                    '</div>' +
                    '<div class="h-1.5 bg-neutral-100 rounded-full overflow-hidden mt-2">' +
                        '<div id="quotaBar" class="h-full bg-sage-500 rounded-full transition-all" style="width:0%"></div>' +
                    '</div>' +
                    '<p class="text-xs text-neutral-400 leading-relaxed mt-2">' +
                        'The browser\'s own estimate for findflower.me as a whole — history, cached pages and fonts together — ' +
                        'and it is deliberately rounded by the browser.' +
                    '</p>' +
                '</div>' +
            '</div>' +
            '<div class="bg-white border border-neutral-200 rounded-2xl p-5 shadow-subtle flex flex-col">' +
                '<h3 class="text-sm font-medium text-neutral-900">Take it or erase it</h3>' +
                '<p class="text-xs text-neutral-500 leading-relaxed mt-2">' +
                    'There is no copy of any of this on our side, which cuts both ways: nobody can hand it back to you if you ' +
                    'clear this browser, and nobody but you can read it. Export first if it matters.' +
                '</p>' +
                '<div class="flex flex-wrap gap-2 mt-4">' +
                    '<button type="button" id="dataExport" data-haptic class="soft-click tap px-4 text-xs font-medium text-neutral-700 border border-neutral-300 rounded-full hover:bg-neutral-50 transition">Export everything (JSON)</button>' +
                    '<button type="button" id="dataClear" data-haptic class="soft-click tap px-4 text-xs font-medium text-neutral-700 border border-neutral-300 rounded-full hover:bg-neutral-50 transition disabled:opacity-40 disabled:hover:bg-transparent"' + (scans.length ? '' : ' disabled') + '>Erase my history</button>' +
                '</div>' +
                '<p class="text-xs text-neutral-400 leading-relaxed mt-3">' +
                    'Erasing removes your identifications, streak and badges from this device. ' +
                    'Another account signed in on this browser keeps its own history — the delete is scoped to you.' +
                '</p>' +
                '<p id="dataNote" class="hidden text-xs text-sage-700 mt-2"></p>' +
            '</div>' +
        '</div>';

        // storage.estimate() is a promise and is missing in Safari < 17, so the
        // bar is hidden until (and unless) a real number arrives.
        if (navigator.storage && navigator.storage.estimate) {
            navigator.storage.estimate().then(function (est) {
                var wrap = $('quotaWrap');
                if (!wrap || !est || !est.quota) return;
                var pct = Math.min(100, Math.max(0.5, (est.usage / est.quota) * 100));
                $('quotaText').textContent = fmtBytes(est.usage) + ' of ' + fmtBytes(est.quota);
                $('quotaBar').style.width = pct.toFixed(1) + '%';
                wrap.classList.remove('hidden');
            }).catch(function () { /* no estimate, no bar */ });
        }

        var exportBtn = $('dataExport');
        if (exportBtn) {
            exportBtn.addEventListener('click', function () {
                var payload = {
                    exported: new Date().toISOString(),
                    schema: 'findflower/v3',
                    userId: state.uid,
                    stats: state.stats,
                    preferences: window.ffPrefs ? window.ffPrefs.all() : null,
                    feedback: readFeedback(),
                    scans: state.scans
                };
                download('findflower-export-' + stamp() + '.json', JSON.stringify(payload, null, 2));
                var n = $('dataNote');
                n.textContent = 'Downloaded ' + state.scans.length + ' identifications, thumbnails included.';
                n.classList.remove('hidden');
            });
        }

        var clearBtn = $('dataClear');
        if (clearBtn && state.scans.length) {
            arm(clearBtn, 'Erase ' + state.scans.length + ' — tap again', function () {
                var target = state.uid;
                // clearUser, never clearAll: a shared browser holds other
                // accounts' rows in the same database.
                window.ffStore.clearUser(target).then(function (n) {
                    return refresh().then(function () {
                        var note = $('dataNote');
                        if (note) {
                            note.textContent = n + (n === 1 ? ' identification erased.' : ' identifications erased.');
                            note.classList.remove('hidden');
                        }
                    });
                }).catch(function (err) {
                    var note = $('dataNote');
                    if (note) {
                        note.textContent = 'Could not erase: ' + (err && err.message ? err.message : 'storage error') + '.';
                        note.className = 'text-xs text-red-700 mt-2';
                    }
                });
            });
        }
    }

    // === lifecycle =======================================================

    /** Re-read the store into `state` and repaint every data-driven panel.
     *  Returns a promise so a caller can post a message after the repaint --
     *  which is also why the panels look their nodes up by id afterwards
     *  instead of closing over them: the repaint replaces them. */
    function refresh() {
        if (!window.ffStore) return Promise.resolve(null);
        return window.ffStore.getSummary().then(function (summary) {
            state.scans = summary.scans || [];
            state.stats = summary.stats || null;
            renderModel($('panelModel'));
            renderPlaces($('panelPlaces'));
            renderStorage($('panelStorage'));
            // dashboard.html passes a callback so the metric tiles, recent grid
            // and badge shelf above these panels agree with them after an erase.
            if (typeof state.onChange === 'function') {
                try { state.onChange(summary); } catch (e) { /* the host's problem, not ours */ }
            }
            return summary;
        });
    }

    /**
     * Draw the panels into whichever of the four hosts the page has.
     *
     * opts: { session, summary, onDataChanged }
     *   session         from getUserSession(); only `sub` is used, to scope the erase
     *   summary         an ffStore.getSummary() the caller already awaited
     *   onDataChanged   called with a fresh summary after an erase
     *
     * Every field is optional: mount() with nothing at all is what the harness
     * does, and it reads the store itself.
     */
    function mount(opts) {
        var o = opts || {};
        unmount();
        state.uid = o.userId || (o.session && o.session.sub) || null;
        state.onChange = typeof o.onDataChanged === 'function' ? o.onDataChanged : null;
        state.scans = (o.summary && o.summary.scans) || [];
        state.stats = (o.summary && o.summary.stats) || null;

        // Preferences first and unconditionally: it is the one panel that owes
        // nothing to IndexedDB, so it must still work when storage is blocked.
        renderPrefs($('panelPrefs'));
        renderModel($('panelModel'));
        renderPlaces($('panelPlaces'));
        renderStorage($('panelStorage'));

        // A caller holding a summary already paid for the read (dashboard.html
        // drew its metric tiles from it), so draw from that and skip the trip.
        if (o.summary) return Promise.resolve(o.summary);
        return refresh().catch(function () {
            // Private mode or a blocked database: the switches are still live.
            var s = $('panelStorage');
            if (s) s.innerHTML = '<p class="text-sm text-neutral-500">Local storage is unavailable in this browser mode, so there is nothing to report or erase.</p>';
            return null;
        });
    }

    function unmount() {
        for (var i = 0; i < teardown.length; i++) {
            try { teardown[i](); } catch (e) { /* ignore */ }
        }
        teardown = [];
        state = { uid: null, scans: [], stats: null, onChange: null };
    }

    window.ffPanels = {
        mount: mount,
        unmount: unmount,
        refresh: refresh,
        // exported for the QA suite, which asserts the copy matches the keys
        PREFS: PREFS,
        MODEL: MODEL
    };
})();
