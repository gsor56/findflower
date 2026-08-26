(function () {
    'use strict';

    var MODEL = { arch: 'Vision Transformer (ViT)', classes: 116 };

    var FEEDBACK_KEY = 'ff_feedback';

    var teardown = [];
    var state = { uid: null, scans: [], stats: null, profile: null, posts: 0, friends: 0 };

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
        return (n / (1024 * 1024 * 1024)).toFixed(1) + ' GB';
    }

    function fmtDate(iso) {
        var d = new Date(iso);
        if (isNaN(d)) return '';
        return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
    }

    function readFeedback() {
        try {
            var raw = JSON.parse(localStorage.getItem(FEEDBACK_KEY) || '[]');
            return Array.isArray(raw) ? raw : [];
        } catch (e) {
            return [];
        }
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

    function stamp() {
        return new Date().toISOString().slice(0, 10);
    }

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

    var TIERS = [
        {
            id: 'lite',
            name: 'Lite (CNN)',
            note: 'Identifies on this device. Your photo stays in this browser and is never sent to the server.',
            ready: true
        },
        {
            id: 'standard',
            name: 'Standard (ViT-116)',
            note: '116 species. The scanner sends the photo to the FindFlower server and gets the top five back.',
            ready: true
        },
        {
            id: 'pro',
            name: 'Pro (MaxViT-1500)',
            note: 'A wider vocabulary, on the same server path as Standard.',
            ready: false,
            why: 'Not trained yet.'
        }
    ];

    function tierRow(t, active) {
        var head = '<span class="text-sm font-medium text-neutral-900">' + esc(t.name) + '</span>';
        var body = '<span class="block text-xs text-neutral-500 leading-relaxed mt-1">' +
            esc(t.ready ? t.note : t.why) + '</span>';
        if (!t.ready) {
            return '' +
            '<div class="px-4 py-3 border-b border-neutral-100 last:border-b-0 opacity-60">' +
                '<p>' + head + '<span class="text-xs text-neutral-400 ml-2">unavailable</span></p>' +
                body +
            '</div>';
        }
        return '' +
        '<button type="button" role="radio" data-tier="' + t.id + '" data-haptic' +
                ' aria-checked="' + (active ? 'true' : 'false') + '"' +
                ' class="tap cursor-pointer w-full text-left px-4 py-3 border-b border-neutral-100 last:border-b-0 ' + (active ? 'bg-sage-50' : 'hover:bg-neutral-50') + ' transition-colors' + ' focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sage-500 focus-visible:ring-inset">' +
            '<span class="flex items-baseline justify-between gap-3">' + head +
                '<span class="text-xs ' + (active ? 'text-sage-700' : 'text-neutral-400') + '">' +
                    (active ? 'in use' : 'use this') + '</span>' +
            '</span>' +
            body +
        '</button>';
    }

    function tierBlock(current) {
        return '' +
        '<div class="mt-2 mb-6">' +
            '<p id="tierLabel" class="text-sm font-medium text-neutral-900">Identification engine</p>' +
            '<p class="text-xs text-neutral-500 leading-relaxed mt-1 mb-3">' +
                'Which model answers a capture. Stored on this device, and read by the scanner on every identification.' +
            '</p>' +
            '<div id="modelTiers" role="radiogroup" aria-labelledby="tierLabel" ' +
                    'class="border border-neutral-200 rounded-md overflow-hidden bg-white">' +
                TIERS.map(function (t) { return tierRow(t, t.id === current); }).join('') +
            '</div>' +
        '</div>';
    }

    function switchRow(p, on, attr) {
        return '' +
        '<div class="flex items-start justify-between gap-4 py-4 border-b border-neutral-100 last:border-b-0">' +
            '<div class="min-w-0">' +
                '<p id="' + p.key + 'Label" class="text-sm font-medium text-neutral-900">' + esc(p.label) + '</p>' +
                '<p class="text-xs text-neutral-500 leading-relaxed mt-1">' + esc(on ? p.on : p.off) + '</p>' +
            '</div>' +
            '<button type="button" role="switch" ' + (attr || 'data-pref') + '="' + p.key + '" data-haptic' +
                    ' aria-checked="' + (on ? 'true' : 'false') + '" aria-labelledby="' + p.key + 'Label"' +
                    ' class="tap shrink-0 flex items-center justify-center rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sage-500 focus-visible:ring-offset-2">' +
                '<span aria-hidden="true" class="relative block w-11 h-6 rounded-full border transition-colors ' + (on ? 'bg-sage-600 border-sage-700' : 'bg-neutral-200 border-neutral-300') + '">' +
                    '<span class="absolute top-0.5 w-5 h-5 rounded-full bg-white transition-all ' + (on ? 'right-0.5' : 'left-0.5') + '"></span>' +
                '</span>' +
            '</button>' +
        '</div>';
    }

    function paintPrefs(host) {
        var values = window.ffPrefs.all();
        var rows = PREFS.map(function (p) { return switchRow(p, !!values[p.key]); }).join('');
        host.innerHTML =
            tierBlock(values.modelTier) +
            '<div id="prefRows">' + rows + '</div>' +
            '<p id="prefWarn" class="hidden text-xs text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2 mt-4">' +
                'This browser refused to store the setting. It applies for now but will be forgotten on reload — ' +
                'private windows and full storage both do this.' +
            '</p>' +
            '<div class="flex items-center justify-between gap-4 pt-4 mt-2 border-t border-neutral-100">' +
                '<p class="text-xs text-neutral-400">Stored on this device only, so it does not follow your account to another browser.</p>' +
                '<button type="button" id="prefReset" data-haptic class="soft-click tap shrink-0 px-4 text-xs font-medium text-neutral-700 border border-neutral-300 rounded-md hover:bg-neutral-50 transition">Restore defaults</button>' +
            '</div>';

        $('prefReset').addEventListener('click', function () {
            window.ffPrefs.reset();
            paintPrefs(host);
            renderPlaces($('panelPlaces'));
            renderStorage($('panelStorage'));
        });
    }

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
            if (!e.target.closest) return;
            var tier = e.target.closest('[data-tier]');
            if (tier && host.contains(tier)) {
                e.preventDefault();
                var stored = window.ffPrefs.set('modelTier', tier.getAttribute('data-tier'));
                paintPrefs(host);
                if (!stored) $('prefWarn').classList.remove('hidden');
                return;
            }
            var btn = e.target.closest('[data-pref]');
            if (!btn || !host.contains(btn)) return;
            var key = btn.getAttribute('data-pref');
            var next = btn.getAttribute('aria-checked') !== 'true';
            var stored = window.ffPrefs.set(key, next);
            paintPrefs(host);
            if (!stored) $('prefWarn').classList.remove('hidden');
            if (key === 'attachLocation') renderPlaces($('panelPlaces'));
            if (key === 'keepPhotos' || key === 'recordHistory') renderStorage($('panelStorage'));
        }

        host.addEventListener('click', onClick);
        teardown.push(function () { host.removeEventListener('click', onClick); });
    }

    var VISIBILITY = {
        key: 'profileVisible',
        label: 'Public profile card',
        on: 'Another account signed in on this browser can open your card and read your streak, species, badges and friends.',
        off: 'Your card shows your name and nothing else. What you see when you open it yourself does not change.'
    };

    function paintPrivacy(host) {
        if (!state.uid) {
            host.innerHTML =
            '<div class="bg-white border border-neutral-200 rounded-lg p-5">' +
                '<h3 class="text-sm font-medium text-neutral-900">Your public card</h3>' +
                '<p class="text-xs text-neutral-500 leading-relaxed mt-2">' +
                    'A card belongs to an account, so this needs a sign-in. ' +
                    '<a href="/login" class="text-sage-600 hover:text-sage-700 underline underline-offset-2">Sign in</a>' +
                    ' and it appears here.' +
                '</p>' +
            '</div>';
            return;
        }

        var open = !state.profile || state.profile.isPublic !== false;
        host.innerHTML =
        '<div class="bg-white border border-neutral-200 rounded-lg p-5">' +
            '<h3 class="text-sm font-medium text-neutral-900">Your public card</h3>' +
            '<div class="mt-1">' + switchRow(VISIBILITY, open, 'data-visibility') + '</div>' +
            '<p id="privacyWarn" class="hidden text-xs text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2 mt-4">' +
                'This browser refused to store that. The card is unchanged.' +
            '</p>' +
            '<div class="flex flex-wrap items-center justify-between gap-3 pt-4 mt-2 border-t border-neutral-100">' +
                '<p class="text-xs text-neutral-400 leading-relaxed">' +
                    'Profiles have no server behind them yet, so the only readers are other accounts signed in on this browser.' +
                '</p>' +
                '<a href="/profile" class="shrink-0 px-4 py-2 text-xs font-medium text-neutral-700 border border-neutral-300 rounded-md hover:bg-neutral-50 transition">Open your card</a>' +
            '</div>' +
        '</div>';
    }

    function renderPrivacy(host) {
        if (!host) return;
        paintPrivacy(host);

        function onClick(e) {
            var btn = e.target.closest ? e.target.closest('[data-visibility]') : null;
            if (!btn || !host.contains(btn)) return;
            var next = btn.getAttribute('aria-checked') !== 'true';
            window.ffStore.setVisibility(next, state.uid).then(function (row) {
                state.profile = row;
                paintPrivacy(host);
            }).catch(function () {
                paintPrivacy(host);
                var warn = $('privacyWarn');
                if (warn) warn.classList.remove('hidden');
            });
        }

        host.addEventListener('click', onClick);
        teardown.push(function () { host.removeEventListener('click', onClick); });
    }

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
            if (!p.last || scans[i].timestamp > p.last) p.last = scans[i].timestamp;
        }
        return order.map(function (k) { return byKey[k]; }).sort(function (a, b) { return b.count - a.count; });
    }

    function placeCard(p) {
        var osm = 'https://www.openstreetmap.org/?mlat=' + p.lat + '&mlon=' + p.lon + '#map=15/' + p.lat + '/' + p.lon;
        return '' +
        '<div class="bg-white border border-neutral-200 rounded-lg p-4">' +
            '<div class="flex items-start justify-between gap-3">' +
                '<div class="min-w-0">' +
                    '<p class="text-sm font-medium text-neutral-900">' + esc(p.lat.toFixed(3)) + ', ' + esc(p.lon.toFixed(3)) + '</p>' +
                    '<p class="text-xs text-neutral-400 mt-0.5">' +
                        p.count + (p.count === 1 ? ' scan' : ' scans') +
                        (p.last ? ' · ' + esc(fmtDate(p.last)) : '') +
                        (typeof p.accuracy === 'number' && p.accuracy ? ' · ±' + p.accuracy + 'm' : '') +
                    '</p>' +
                '</div>' +
                '<svg class="shrink-0 text-neutral-400" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
                    '<path d="M20 10.5c0 5.2-5.6 9.9-7.4 11.2a1 1 0 0 1-1.2 0C9.6 20.4 4 15.7 4 10.5a8 8 0 0 1 16 0Z"/>' +
                    '<circle cx="12" cy="10.3" r="2.6"/></svg>' +
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
                action = '<a href="/try" class="tap inline-flex items-center justify-center mt-4 px-5 bg-neutral-900 text-white text-sm font-medium rounded-md hover:bg-neutral-800 transition-colors">Identify a flower</a>';
            } else if (!on) {
                why = 'None of your ' + state.scans.length + ' identifications carry coordinates, because location is switched off above.';
                action = '<button type="button" id="placesEnable" data-haptic class="soft-click tap inline-flex items-center justify-center mt-4 px-5 border border-neutral-300 text-sm font-medium rounded-md hover:bg-neutral-50 transition">Turn on location for new scans</button>';
            } else {
                why = 'Location is on, so your next identification will be placed here. If nothing appears, this browser may have denied the location permission for the site.';
                action = '<a href="/try" class="tap inline-flex items-center justify-center mt-4 px-5 bg-neutral-900 text-white text-sm font-medium rounded-md hover:bg-neutral-800 transition-colors">Identify a flower</a>';
            }
            host.innerHTML =
                '<div class="border border-dashed border-neutral-300 rounded-lg p-8 text-center">' +
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
            '<div class="bg-white border border-neutral-200 rounded-lg p-5">' +
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
            '<div class="bg-white border border-neutral-200 rounded-lg p-5 flex flex-col">' +
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
                    '<button type="button" id="fbExport" data-haptic class="soft-click tap px-4 text-xs font-medium text-neutral-700 border border-neutral-300 rounded-md hover:bg-neutral-50 transition disabled:opacity-40 disabled:hover:bg-transparent"' + (log.length ? '' : ' disabled') + '>Export my feedback</button>' +
                    '<button type="button" id="fbClear" data-haptic class="soft-click tap px-4 text-xs font-medium text-neutral-700 border border-neutral-300 rounded-md hover:bg-neutral-50 transition disabled:opacity-40 disabled:hover:bg-transparent"' + (log.length ? '' : ' disabled') + '>Clear my feedback</button>' +
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

        if (clearBtn && log.length) {
            arm(clearBtn, 'Delete ' + log.length + ' — tap again', function () {
                try { localStorage.removeItem(FEEDBACK_KEY); } catch (e) { }
                renderModel(host);
                var n = $('fbNote');
                n.textContent = 'Feedback log deleted from this browser.';
                n.classList.remove('hidden');
            });
        }
    }

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
            '<div class="bg-white border border-neutral-200 rounded-lg p-5">' +
                '<h3 class="text-sm font-medium text-neutral-900">What this browser is holding</h3>' +
                '<div class="mt-3">' +
                    countRow('Identifications', String(scans.length), record ? null : 'History recording is off, so this number is frozen.') +
                    countRow('Thumbnails kept', String(thumbs), keep ? 'About ' + fmtBytes(thumbBytes(scans)) + ' of the total below.' : 'Thumbnails are off for new scans.') +
                    countRow('Scans with coordinates', String(located), null) +
                    countRow('Community posts', String(state.posts), state.posts ? 'Written on this device and readable only here.' : null) +
                    countRow('Friend rows', String(state.friends), null) +
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
            '<div class="bg-white border border-neutral-200 rounded-lg p-5 flex flex-col">' +
                '<h3 class="text-sm font-medium text-neutral-900">Take it or erase it</h3>' +
                '<p class="text-xs text-neutral-500 leading-relaxed mt-2">' +
                    'There is no copy of any of this on our side, which cuts both ways: nobody can hand it back to you if you ' +
                    'clear this browser, and nobody but you can read it. Export first if it matters.' +
                '</p>' +
                '<div class="flex flex-wrap gap-2 mt-4">' +
                    '<button type="button" id="dataExport" data-haptic class="soft-click tap px-4 text-xs font-medium text-neutral-700 border border-neutral-300 rounded-md hover:bg-neutral-50 transition">Export everything (JSON)</button>' +
                    '<button type="button" id="dataClear" data-haptic class="soft-click tap px-4 text-xs font-medium text-neutral-700 border border-neutral-300 rounded-md hover:bg-neutral-50 transition disabled:opacity-40 disabled:hover:bg-transparent"' + (scans.length ? '' : ' disabled') + '>Erase my history</button>' +
                    '<button type="button" id="dataWipe" data-haptic class="soft-click tap px-4 text-xs font-medium text-neutral-700 border border-neutral-300 rounded-md hover:bg-neutral-50 transition">Delete everything and sign out</button>' +
                '</div>' +
                '<p class="text-xs text-neutral-400 leading-relaxed mt-3">' +
                    'Erasing removes your identifications, streak and badges from this device. ' +
                    'Another account signed in on this browser keeps its own history — nothing in this card reaches it.' +
                '</p>' +
                '<p class="text-xs text-neutral-400 leading-relaxed mt-2">' +
                    'Deleting everything removes your profile card, posts and friend rows as well, restores the four ' +
                    'preferences to their defaults, clears the correction log, and signs you out. ' +
                    'Your sign-in account is held by Auth0 and is not ' +
                    'removed here — ask through the <a href="/contact" class="text-sage-600 hover:text-sage-700 underline underline-offset-2">contact page</a> for that.' +
                '</p>' +
                '<p id="dataNote" class="hidden text-xs text-sage-700 mt-2"></p>' +
            '</div>' +
        '</div>';

        if (navigator.storage && navigator.storage.estimate) {
            navigator.storage.estimate().then(function (est) {
                var wrap = $('quotaWrap');
                if (!wrap || !est || !est.quota) return;
                var pct = Math.min(100, Math.max(0.5, (est.usage / est.quota) * 100));
                $('quotaText').textContent = fmtBytes(est.usage) + ' of ' + fmtBytes(est.quota);
                $('quotaBar').style.width = pct.toFixed(1) + '%';
                wrap.classList.remove('hidden');
            }).catch(function () { });
        }

        var exportBtn = $('dataExport');
        if (exportBtn) {
            exportBtn.addEventListener('click', function () {
                var held = (state.stats && state.stats.unlockedBadges) || [];
                var payload = {
                    exported: new Date().toISOString(),
                    schema: 'findflower/v4',
                    userId: state.uid,
                    stats: state.stats,
                    badges: (window.ffStore.BADGES || []).map(function (b) {
                        return {
                            id: b.id,
                            name: b.name,
                            requirement: b.description,
                            earned: held.indexOf(b.id) !== -1
                        };
                    }),
                    preferences: window.ffPrefs ? window.ffPrefs.all() : null,
                    feedback: readFeedback(),
                    scans: state.scans
                };
                var n = $('dataNote');
                var bundle = window.ffStore.exportBundle
                    ? window.ffStore.exportBundle(state.uid)
                    : Promise.resolve(null);
                bundle.catch(function () { return null; }).then(function (extra) {
                    if (extra) {
                        payload.profile = extra.profile;
                        payload.posts = extra.posts;
                        payload.friends = extra.friends;
                        payload.messages = extra.messages;
                    }
                    download('findflower-export-' + stamp() + '.json', JSON.stringify(payload, null, 2));
                    var counted = extra
                        ? ' Posts, friends and messages are in the same file.'
                        : '';
                    n.textContent = 'Downloaded ' + state.scans.length +
                        ' identifications, thumbnails included.' + counted;
                    n.classList.remove('hidden');
                });
            });
        }

        var clearBtn = $('dataClear');
        if (clearBtn && state.scans.length) {
            arm(clearBtn, 'Erase ' + state.scans.length + ' — tap again', function () {
                var target = state.uid;
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

        var wipeBtn = $('dataWipe');
        if (wipeBtn) {
            arm(wipeBtn, 'Delete everything — tap again', function () {
                var target = state.uid;
                window.ffStore.deleteAccount(target).then(function () {
                    if (window.ffPrefs) window.ffPrefs.reset();
                    try { localStorage.removeItem(FEEDBACK_KEY); } catch (e) { }
                    if (typeof ffLogout === 'function') {
                        return ffLogout().catch(function () { });
                    }
                }).then(function () {
                    return refresh();
                }).then(function () {
                    var note = $('dataNote');
                    if (note) {
                        note.textContent = 'Deleted. If you are still signed in, use Sign out at the top of this page.';
                        note.classList.remove('hidden');
                    }
                    repaintPrefs();
                }).catch(function (err) {
                    var note = $('dataNote');
                    if (note) {
                        note.textContent = 'Could not delete: ' + (err && err.message ? err.message : 'storage error') + '.';
                        note.className = 'text-xs text-red-700 mt-2';
                    }
                });
            });
        }
    }

    function social() {
        if (!window.ffStore || typeof window.ffStore.getUser !== 'function') {
            state.profile = null;
            state.posts = 0;
            state.friends = 0;
            return Promise.resolve();
        }
        var uid = state.uid;
        return Promise.all([
            window.ffStore.getUser(uid),
            window.ffStore.countPosts(uid),
            window.ffStore.listFriends(uid)
        ]).then(function (out) {
            state.profile = out[0];
            state.posts = out[1] || 0;
            state.friends = (out[2] || []).length;
        }).catch(function () {
            state.profile = null;
            state.posts = 0;
            state.friends = 0;
        });
    }

    function refresh() {
        if (!window.ffStore) return Promise.resolve(null);
        return window.ffStore.getSummary().then(function (summary) {
            state.scans = summary.scans || [];
            state.stats = summary.stats || null;
            return social().then(function () { return summary; });
        }).then(function (summary) {
            renderModel($('panelModel'));
            renderPrivacy($('panelPrivacy'));
            renderPlaces($('panelPlaces'));
            renderStorage($('panelStorage'));
            if (typeof state.onChange === 'function') {
                try { state.onChange(summary); } catch (e) { }
            }
            return summary;
        });
    }

    function mount(opts) {
        var o = opts || {};
        unmount();
        state.uid = o.userId || (o.session && o.session.sub) || null;
        state.onChange = typeof o.onDataChanged === 'function' ? o.onDataChanged : null;
        state.scans = (o.summary && o.summary.scans) || [];
        state.stats = (o.summary && o.summary.stats) || null;

        renderPrefs($('panelPrefs'));
        renderModel($('panelModel'));
        renderPlaces($('panelPlaces'));
        renderPrivacy($('panelPrivacy'));
        renderStorage($('panelStorage'));

        if (o.summary) {
            return social().then(function () {
                renderPrivacy($('panelPrivacy'));
                renderStorage($('panelStorage'));
                return o.summary;
            });
        }
        return refresh().catch(function () {
            var s = $('panelStorage');
            if (s) s.innerHTML = '<p class="text-sm text-neutral-500">Local storage is unavailable in this browser mode, so there is nothing to report or erase.</p>';
            return null;
        });
    }

    function unmount() {
        for (var i = 0; i < teardown.length; i++) {
            try { teardown[i](); } catch (e) { }
        }
        teardown = [];
        state = { uid: null, scans: [], stats: null, profile: null, posts: 0, friends: 0, onChange: null };
    }

    window.ffPanels = {
        mount: mount,
        unmount: unmount,
        refresh: refresh,
        PREFS: PREFS,
        MODEL: MODEL
    };
})();
