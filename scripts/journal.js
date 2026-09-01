(function () {
    'use strict';

    var GOAL_KEY = 'ff_goal_dismissed';
    var WEEKDAYS = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];
    var MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
        'August', 'September', 'October', 'November', 'December'];

    var state = {
        uid: null,
        scans: [],
        albums: [],
        filter: null,
        compare: false,
        picked: [],
        cmpNote: '',
        month: null,
        renaming: null,
        arming: null
    };
    var hooks = { repaint: null };
    var timers = [];
    var listeners = [];
    var modalBack = null;
    var scrollWas = null;

    function $(id) { return document.getElementById(id); }

    function esc(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
        });
    }

    function titleCase(s) {
        return String(s || '').replace(/(^|\s)(\w)/g, function (m, pre, c) {
            return pre + c.toUpperCase();
        });
    }

    function named(scan) {
        var store = window.ffStore;
        var name = store && typeof store.displaySpecies === 'function'
            ? store.displaySpecies(scan)
            : (scan && scan.species) || '';
        return name ? titleCase(name) : '';
    }

    function on(el, ev, fn) {
        if (!el) return;
        el.addEventListener(ev, fn);
        listeners.push([el, ev, fn]);
    }

    function later(fn, ms) {
        var t = setTimeout(fn, ms);
        timers.push(t);
        return t;
    }
    function dayKey(d) {
        var dt = d instanceof Date ? d : new Date(d);
        return dt.getFullYear() + '-' + String(dt.getMonth() + 1).padStart(2, '0') +
            '-' + String(dt.getDate()).padStart(2, '0');
    }

    // A scan is stamped in UTC and read back in the reader's own zone, so the day
    // a find belongs to is the local day, not the first ten characters.
    function scanDay(scan) {
        var d = new Date(scan && scan.timestamp);
        return isNaN(d.getTime()) ? '' : dayKey(d);
    }

    function fmtDay(key) {
        var parts = String(key || '').split('-');
        if (parts.length !== 3) return '';
        var d = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
        return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
    }

    function albumName(id) {
        for (var i = 0; i < state.albums.length; i++) {
            if (state.albums[i].id === id) return state.albums[i].name;
        }
        return '';
    }

    function plural(n, one, many) {
        return n + ' ' + (n === 1 ? one : many);
    }

    var BTN = 'soft-click tap px-4 text-xs font-medium text-neutral-700 border ' +
        'border-neutral-300 rounded-md hover:bg-neutral-50 transition';
    var BTN_SOLID = 'soft-click tap px-4 text-xs font-medium bg-neutral-900 text-white ' +
        'border border-neutral-900 rounded-md hover:bg-neutral-800 transition ' +
        'disabled:opacity-40 disabled:hover:bg-neutral-900';
    var BTN_QUIET = 'soft-click tap px-2 text-xs font-medium text-neutral-500 ' +
        'hover:text-neutral-900 transition';
    var CARD = 'bg-white border border-neutral-200 rounded-lg';

    function read() {
        var store = window.ffStore;
        return Promise.all([
            store.getScans(null, state.uid),
            store.listAlbums(state.uid)
        ]).then(function (out) {
            state.scans = out[0] || [];
            state.albums = out[1] || [];
            return state;
        });
    }
    function renderMonth(host) {
        if (!host) return;
        var now = new Date();
        var m = window.ffStore.monthInsights(state.scans, now);
        var label = MONTHS[now.getMonth()];

        if (!m.scans) {
            var last = state.scans.length ? fmtDay(scanDay(state.scans[0])) : '';
            host.innerHTML = '<div class="' + CARD + ' p-5">' +
                '<p class="text-sm text-neutral-600">Nothing recorded in ' + esc(label) + ' yet.' +
                (last ? ' Your last find was ' + esc(last) + '.' : '') +
                '</p></div>';
            return;
        }

        var strong = 'font-medium text-neutral-900';
        host.innerHTML = '<div class="' + CARD + ' p-5 flex flex-wrap items-baseline gap-x-10 gap-y-3">' +
            '<p class="text-sm text-neutral-600">In ' + esc(label) + ' you identified ' +
                '<span class="' + strong + '">' + esc(plural(m.scans, 'flower', 'flowers')) + '</span>, ' +
                '<span class="' + strong + '">' + esc(plural(m.species, 'distinct species', 'distinct species')) +
                '</span>.</p>' +
            (m.topFamily
                ? '<p class="text-sm text-neutral-600">Most identified family: ' +
                    '<span class="' + strong + '">' + esc(m.topFamily.name) + '</span> ' +
                    '<span class="text-neutral-400">' + esc(plural(m.topFamily.count, 'find', 'finds')) +
                    '</span></p>'
                : '') +
        '</div>';
    }

    function fold(s) { return String(s == null ? '' : s).trim().toLowerCase(); }

    // Every goal is read off the records this browser already holds. Nothing here
    // asks the reader to tell us whether they did it.
    var GOALS = [
        {
            id: 'three-today',
            ask: 'Record three finds today',
            need: 3,
            have: function (scans) {
                var today = dayKey(new Date());
                return scans.filter(function (s) { return scanDay(s) === today; }).length;
            }
        },
        {
            id: 'new-species',
            ask: 'Add a species your history has not seen before',
            need: 1,
            have: function (scans) {
                var today = dayKey(new Date());
                var before = {}, fresh = {};
                scans.forEach(function (s) {
                    var n = fold(named(s));
                    if (n && scanDay(s) !== today) before[n] = 1;
                });
                scans.forEach(function (s) {
                    var n = fold(named(s));
                    if (n && scanDay(s) === today && !before[n]) fresh[n] = 1;
                });
                return Object.keys(fresh).length;
            }
        },
        {
            id: 'file-three',
            ask: 'Keep three finds filed in albums',
            need: 3,
            have: function (scans) {
                return scans.filter(function (s) { return !!s.albumId; }).length;
            }
        },
        {
            id: 'name-one',
            ask: 'Correct one find the model got wrong',
            need: 1,
            have: function (scans) {
                return scans.filter(function (s) {
                    return s.correction && s.correction.species;
                }).length;
            }
        }
    ];

    function goalToday(when) {
        var at = when || new Date();
        var start = new Date(at.getFullYear(), 0, 0);
        var day = Math.floor((at - start) / 86400000);
        return GOALS[day % GOALS.length];
    }

    function dismissed() {
        try { return localStorage.getItem(GOAL_KEY) === dayKey(new Date()); }
        catch (e) { return false; }
    }

    function renderGoal(host) {
        if (!host) return;
        var section = $('challengeSection');
        if (dismissed()) {
            if (section) section.classList.add('hidden');
            host.innerHTML = '';
            return;
        }
        if (section) section.classList.remove('hidden');

        var goal = goalToday();
        var have = Math.min(goal.need, goal.have(state.scans));
        var done = have >= goal.need;

        host.innerHTML = '<div class="' + CARD + ' p-5 flex flex-wrap items-center justify-between gap-4">' +
            '<div class="min-w-0">' +
                '<p class="text-sm ' + (done ? 'text-neutral-500 line-through' : 'text-neutral-900') + '">' +
                    esc(goal.ask) + '</p>' +
                '<p class="text-xs text-neutral-500 mt-1">' +
                    (done ? 'Done.' : esc(have + ' of ' + goal.need + ' so far.')) + '</p>' +
            '</div>' +
            '<button type="button" id="goalOff" data-haptic class="' + BTN_QUIET + '">Not today</button>' +
        '</div>';

        on($('goalOff'), 'click', function () {
            try { localStorage.setItem(GOAL_KEY, dayKey(new Date())); } catch (e) { }
            renderGoal(host);
        });
    }
    function note(id, text, bad) {
        var el = $(id);
        if (!el) return;
        el.textContent = text || '';
        el.className = 'text-xs mt-2 ' + (bad ? 'text-red-700' : 'text-sage-700') +
            (text ? '' : ' hidden');
    }

    function albumRow(a) {
        var picked = state.filter && state.filter.kind === 'album' && state.filter.value === a.id;
        if (state.renaming === a.id) {
            return '<form data-album-save="' + esc(a.id) + '" class="flex flex-wrap items-center gap-2 py-2.5 ' +
                'border-b border-neutral-100 last:border-b-0">' +
                '<label class="sr-only" for="albumRename">Rename ' + esc(a.name) + '</label>' +
                '<input id="albumRename" type="text" value="' + esc(a.name) + '" maxlength="' +
                    (window.ffStore.ALBUM_NAME_MAX || 40) + '" class="tap flex-1 min-w-[10rem] text-sm ' +
                    'border border-neutral-300 rounded-md px-3 text-neutral-900">' +
                '<button type="submit" class="' + BTN + '">Save</button>' +
                '<button type="button" data-album-cancel="1" class="' + BTN_QUIET + '">Cancel</button>' +
            '</form>';
        }
        // An empty album has nothing to show, so its name is a label rather than a
        // filter that would leave the grid blank.
        var label = a.count
            ? '<button type="button" data-album-pick="' + esc(a.id) + '" aria-pressed="' +
                (picked ? 'true' : 'false') + '" class="soft-click flex-1 min-w-0 text-left text-sm truncate ' +
                (picked ? 'text-sage-700 font-medium' : 'text-neutral-900 hover:text-sage-700') + ' transition">' +
                esc(a.name) + ' <span class="text-neutral-400 font-normal">' + a.count + '</span></button>'
            : '<span class="flex-1 min-w-0 text-sm text-neutral-500 truncate">' + esc(a.name) +
                ' <span class="text-neutral-400">empty</span></span>';
        return '<div class="flex items-center gap-2 py-2.5 border-b border-neutral-100 last:border-b-0">' +
            label +
            '<button type="button" data-album-rename="' + esc(a.id) + '" class="' + BTN_QUIET + '">Rename</button>' +
            '<button type="button" data-album-del="' + esc(a.id) + '" class="' + BTN_QUIET +
                (state.arming === a.id ? ' text-red-700' : '') + '">' +
                (state.arming === a.id ? 'Tap again' : 'Delete') + '</button>' +
        '</div>';
    }

    function renderAlbums(host) {
        if (!host) return;
        var max = window.ffStore.ALBUM_NAME_MAX || 40;
        host.innerHTML = '<div class="' + CARD + ' p-5">' +
            '<form id="albumNew" class="flex flex-wrap gap-2 max-w-md">' +
                '<label class="sr-only" for="albumName">New album name</label>' +
                '<input id="albumName" type="text" maxlength="' + max + '" autocomplete="off" ' +
                    'placeholder="Name an album" class="tap flex-1 min-w-[11rem] text-sm border ' +
                    'border-neutral-300 rounded-md px-3 text-neutral-900 placeholder:text-neutral-400">' +
                '<button type="submit" class="' + BTN_SOLID + '">Add album</button>' +
            '</form>' +
            '<p id="albumNote" class="hidden text-xs text-sage-700 mt-2"></p>' +
            (state.albums.length
                ? '<div class="mt-3">' + state.albums.map(albumRow).join('') + '</div>'
                : '<p class="text-xs text-neutral-500 leading-relaxed mt-3">No albums yet. A find sits in ' +
                  'one album at a time, and an album can be renamed or deleted without touching the finds ' +
                  'inside it.</p>') +
        '</div>';
        wireAlbums(host);
    }
    function refresh() {
        return read().then(function () {
            paintAll();
            if (hooks.repaint) hooks.repaint();
        });
    }

    function setFilter(next) {
        state.filter = next;
        state.arming = null;
        paintAll();
        if (hooks.repaint) hooks.repaint();
    }

    function addAlbum(host) {
        var field = $('albumName');
        var typed = field ? field.value : '';
        if (!String(typed).trim()) { note('albumNote', 'An album needs a name.', true); return; }
        var known = state.albums.length;
        var typing = document.activeElement === field;
        window.ffStore.createAlbum(typed, state.uid).then(function (album) {
            if (field) field.value = '';
            return refresh().then(function () {
                note('albumNote', state.albums.length === known
                    ? 'You already have an album called ' + album.name + '.'
                    : 'Added ' + album.name + '.');
                // The refresh rebuilds this form, so the caret has to be put back
                // or naming a second album takes another tap.
                var again = $('albumName');
                if (typing && again) again.focus();
            });
        }).catch(function (err) {
            note('albumNote', err.message || 'That album could not be made.', true);
        });
    }

    function saveName(id) {
        var field = $('albumRename');
        window.ffStore.renameAlbum(id, field ? field.value : '').then(function (row) {
            state.renaming = null;
            return refresh().then(function () {
                if (row) note('albumNote', 'Now called ' + row.name + '.');
            });
        }).catch(function (err) {
            note('albumNote', err.message || 'That name did not take.', true);
        });
    }

    function dropAlbum(id) {
        window.ffStore.deleteAlbum(id).then(function (out) {
            if (state.filter && state.filter.value === id) state.filter = null;
            return refresh().then(function () {
                if (out && out.removed) {
                    note('albumNote', 'Album deleted. ' + plural(out.unfiled, 'find', 'finds') +
                        ' came out of it, none were deleted.');
                }
            });
        });
    }
    function wireAlbums(host) {
        if (host.getAttribute('data-wired') === '1') return;
        host.setAttribute('data-wired', '1');

        on(host, 'submit', function (ev) {
            var form = ev.target;
            if (form.id === 'albumNew') {
                ev.preventDefault();
                addAlbum(host);
                return;
            }
            var id = form.getAttribute && form.getAttribute('data-album-save');
            if (!id) return;
            ev.preventDefault();
            saveName(id);
        });

        on(host, 'click', function (ev) {
            var hit = ev.target.closest('[data-album-pick],[data-album-rename],' +
                '[data-album-del],[data-album-cancel]');
            if (!hit) return;

            var pick = hit.getAttribute('data-album-pick');
            if (pick) {
                var same = state.filter && state.filter.kind === 'album' && state.filter.value === pick;
                setFilter(same ? null : { kind: 'album', value: pick });
                return;
            }
            if (hit.getAttribute('data-album-cancel')) {
                state.renaming = null;
                renderAlbums(host);
                return;
            }
            var ren = hit.getAttribute('data-album-rename');
            if (ren) {
                state.renaming = ren;
                state.arming = null;
                renderAlbums(host);
                var field = $('albumRename');
                if (field) field.focus();
                return;
            }
            var del = hit.getAttribute('data-album-del');
            if (!del) return;
            if (state.arming !== del) {
                state.arming = del;
                renderAlbums(host);
                later(function () {
                    if (state.arming !== del) return;
                    state.arming = null;
                    renderAlbums(host);
                }, 5000);
                return;
            }
            state.arming = null;
            dropAlbum(del);
        });
    }
    var CHEV = {
        back: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
            'stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><path d="M15 5l-7 7 7 7"/></svg>',
        on: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
            'stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><path d="M9 5l7 7-7 7"/></svg>'
    };

    function shownMonth() {
        if (state.month) return new Date(state.month.y, state.month.m, 1);
        var now = new Date();
        return new Date(now.getFullYear(), now.getMonth(), 1);
    }

    function byDay() {
        var map = {};
        state.scans.forEach(function (s) {
            var key = scanDay(s);
            if (!key) return;
            if (!map[key]) map[key] = [];
            map[key].push(s);
        });
        return map;
    }

    function firstDay() {
        var out = '';
        state.scans.forEach(function (s) {
            var key = scanDay(s);
            if (key && (!out || key < out)) out = key;
        });
        return out;
    }

    // Only offer a month the reader could actually have finds in: nothing after
    // this one, and nothing before their first record.
    function canStep(dir) {
        var at = shownMonth();
        var to = new Date(at.getFullYear(), at.getMonth() + dir, 1);
        if (dir > 0) {
            var now = new Date();
            return to <= new Date(now.getFullYear(), now.getMonth(), 1);
        }
        var old = firstDay();
        if (!old) return false;
        var p = old.split('-');
        return to >= new Date(Number(p[0]), Number(p[1]) - 1, 1);
    }
    function dayCell(key, n, finds) {
        var num = '<span class="absolute top-1 left-1.5 text-xs ' +
            (finds.length ? 'font-medium text-neutral-900' : 'text-neutral-400') + '">' + n + '</span>';
        if (!finds.length) {
            return '<div class="relative h-11 sm:h-20 border border-neutral-100 rounded-md">' + num + '</div>';
        }
        var picked = state.filter && state.filter.kind === 'day' && state.filter.value === key;
        var shots = finds.slice(0, 2).map(function (s) {
            return s.imageBase64
                ? '<img src="' + esc(s.imageBase64) + '" alt="" class="h-full aspect-square object-cover">'
                : '<span class="h-full aspect-square bg-sage-100"></span>';
        }).join('');
        return '<button type="button" data-day="' + key + '" aria-pressed="' + (picked ? 'true' : 'false') +
            '" aria-label="' + esc(fmtDay(key) + ', ' + plural(finds.length, 'find', 'finds')) +
            '" class="soft-click relative h-11 sm:h-20 overflow-hidden border rounded-md transition ' +
            (picked ? 'border-sage-500 bg-sage-50' : 'border-neutral-200 hover:border-sage-300') + '">' +
            num +
            '<span class="absolute inset-x-0 bottom-0 h-1/2 flex gap-px justify-center">' + shots + '</span>' +
        '</button>';
    }

    function stepButton(dir) {
        if (!canStep(dir)) return '';
        var at = shownMonth();
        var to = new Date(at.getFullYear(), at.getMonth() + dir, 1);
        return '<button type="button" data-cal="' + dir + '" data-haptic aria-label="Show ' +
            MONTHS[to.getMonth()] + ' ' + to.getFullYear() + '" class="soft-click p-1.5 rounded-md ' +
            'text-neutral-500 hover:text-neutral-900 hover:bg-neutral-50 transition">' +
            (dir < 0 ? CHEV.back : CHEV.on) + '</button>';
    }

    function renderCalendar(host) {
        if (!host) return;
        var at = shownMonth();
        var y = at.getFullYear();
        var m = at.getMonth();
        var map = byDay();
        var cells = '';
        var i;
        for (i = 0; i < (at.getDay() + 6) % 7; i++) cells += '<div></div>';
        var busy = 0;
        var last = new Date(y, m + 1, 0).getDate();
        for (i = 1; i <= last; i++) {
            var key = y + '-' + String(m + 1).padStart(2, '0') + '-' + String(i).padStart(2, '0');
            var finds = map[key] || [];
            if (finds.length) busy += 1;
            cells += dayCell(key, i, finds);
        }
        var head = WEEKDAYS.map(function (w) {
            return '<span aria-hidden="true" class="text-xs text-neutral-400 text-center">' + w + '</span>';
        }).join('');
        host.innerHTML = '<div class="' + CARD + ' p-5">' +
            '<div class="flex items-center justify-between gap-3">' +
                '<p class="text-sm font-medium text-neutral-900">' + esc(MONTHS[m] + ' ' + y) + '</p>' +
                '<div class="flex items-center gap-1">' + stepButton(-1) + stepButton(1) + '</div>' +
            '</div>' +
            '<div class="grid grid-cols-7 gap-1 mt-4">' + head + cells + '</div>' +
            '<p class="text-xs text-neutral-500 mt-3">' + (busy
                ? esc(plural(busy, 'day', 'days')) + ' with finds. Tap one to see what you named that day.'
                : 'Nothing recorded in this month.') + '</p>' +
        '</div>';
        wireCalendar(host);
    }

    function wireCalendar(host) {
        if (host.getAttribute('data-wired') === '1') return;
        host.setAttribute('data-wired', '1');
        on(host, 'click', function (ev) {
            var hit = ev.target.closest('[data-cal],[data-day]');
            if (!hit) return;
            var dir = hit.getAttribute('data-cal');
            if (dir) {
                var at = shownMonth();
                var to = new Date(at.getFullYear(), at.getMonth() + Number(dir), 1);
                state.month = { y: to.getFullYear(), m: to.getMonth() };
                renderCalendar(host);
                return;
            }
            var key = hit.getAttribute('data-day');
            var same = state.filter && state.filter.kind === 'day' && state.filter.value === key;
            setFilter(same ? null : { kind: 'day', value: key });
        });
    }
    function scanById(id) {
        for (var i = 0; i < state.scans.length; i++) {
            if (state.scans[i].id === id) return state.scans[i];
        }
        return null;
    }

    // Four columns is what fits on a phone in two rows, so the fifth tick pushes
    // the oldest pick out rather than doing nothing.
    function pick(id) {
        var at = state.picked.indexOf(id);
        state.cmpNote = '';
        if (at !== -1) {
            state.picked.splice(at, 1);
            return;
        }
        if (state.picked.length >= 4) {
            state.picked.shift();
            state.cmpNote = 'Four at a time is the most that fits, so the first pick came off.';
        }
        state.picked.push(id);
    }

    function toggleCompare(want) {
        state.compare = !!want;
        if (!state.compare) {
            state.picked = [];
            state.cmpNote = '';
        }
        paintAll();
        if (hooks.repaint) hooks.repaint();
    }

    function renderCompare(host) {
        if (!host) return;
        var toggle = $('cmpToggle');
        // Nothing to put side by side under two finds, so the button goes away
        // rather than sitting there doing nothing.
        var few = state.scans.length < 2;
        if (few && state.compare) { state.compare = false; state.picked = []; state.cmpNote = ''; }
        if (toggle) {
            toggle.classList.toggle('hidden', few);
            toggle.setAttribute('aria-pressed', state.compare ? 'true' : 'false');
        }
        if (!state.compare) {
            host.innerHTML = '';
            return;
        }
        var n = state.picked.length;
        host.innerHTML = '<div class="' + CARD + ' p-4 mb-4 flex flex-wrap items-center justify-between gap-3">' +
            '<div class="min-w-0">' +
                '<p class="text-sm text-neutral-700">' + (n
                    ? esc(plural(n, 'find picked', 'finds picked')) + (n < 2 ? ', one more to go.' : '.')
                    : 'Tick two to four of the finds below.') + '</p>' +
                (state.cmpNote
                    ? '<p class="text-xs text-neutral-500 mt-1">' + esc(state.cmpNote) + '</p>'
                    : '') +
            '</div>' +
            '<div class="flex items-center gap-2">' +
                '<button type="button" id="cmpGo" data-haptic' + (n < 2 ? ' disabled' : '') +
                    ' class="' + BTN_SOLID + '">Compare</button>' +
                '<button type="button" id="cmpOff" class="' + BTN_QUIET + '">Done</button>' +
            '</div>' +
        '</div>';
        on($('cmpGo'), 'click', openCompare);
        on($('cmpOff'), 'click', function () { toggleCompare(false); });
    }
    function cmpColumn(scan) {
        var name = named(scan);
        var pct = typeof scan.confidence === 'number' ? Math.round(scan.confidence * 100) + '% sure' : '';
        var where = scan.albumId ? albumName(scan.albumId) : '';
        var fixed = scan.correction && scan.correction.species;
        return '<div class="min-w-0">' +
            (scan.imageBase64
                ? '<img src="' + esc(scan.imageBase64) + '" alt="" class="w-full aspect-square ' +
                  'object-cover rounded-md border border-neutral-200">'
                : '<div class="w-full aspect-square rounded-md border border-neutral-200 bg-sage-50"></div>') +
            '<p class="text-sm font-medium text-neutral-900 leading-snug mt-2">' +
                (name ? esc(name) : '<span class="font-normal text-neutral-400">Not named yet</span>') + '</p>' +
            (pct ? '<p class="text-xs text-neutral-500 mt-1">' + pct + '</p>' : '') +
            '<p class="text-xs text-neutral-500 mt-1">' + esc(fmtDay(scanDay(scan))) + '</p>' +
            (where ? '<p class="text-xs text-neutral-400 mt-1">' + esc(where) + '</p>' : '') +
            (fixed ? '<p class="text-xs text-sage-700 mt-1">Corrected by you</p>' : '') +
        '</div>';
    }

    function trapTab(ev, box) {
        var able = box.querySelectorAll('button:not([disabled]), [href], input, select');
        if (!able.length) { ev.preventDefault(); box.focus(); return; }
        var first = able[0];
        var last = able[able.length - 1];
        var at = document.activeElement;
        if (!box.contains(at)) { ev.preventDefault(); first.focus(); }
        else if (ev.shiftKey && at === first) { ev.preventDefault(); last.focus(); }
        else if (!ev.shiftKey && at === last) { ev.preventDefault(); first.focus(); }
    }

    function closeCompare(quiet) {
        var host = $('cmpModal');
        if (!host || !host.innerHTML) return;
        host.innerHTML = '';
        document.body.style.overflow = scrollWas || '';
        scrollWas = null;
        if (!quiet && modalBack && modalBack.focus) modalBack.focus();
        modalBack = null;
    }
    function openCompare() {
        var host = $('cmpModal');
        if (!host) return;
        var rows = state.picked.map(scanById).filter(Boolean);
        if (rows.length < 2) return;
        modalBack = document.activeElement;
        scrollWas = document.body.style.overflow;
        host.innerHTML = '<div class="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-6">' +
            '<div data-cmp-close class="absolute inset-0 bg-neutral-900/20"></div>' +
            '<div id="cmpBox" role="dialog" aria-modal="true" aria-labelledby="cmpTitle" tabindex="-1" ' +
                'class="relative w-full max-w-3xl max-h-[88vh] flex flex-col bg-white border ' +
                'border-neutral-200 rounded-lg overflow-hidden">' +
                '<div class="flex items-center justify-between gap-3 px-5 py-4 border-b border-neutral-200">' +
                    '<h2 id="cmpTitle" class="text-sm font-medium text-neutral-900">' +
                        esc(plural(rows.length, 'find', 'finds')) + ' side by side</h2>' +
                    '<button type="button" data-cmp-close class="' + BTN_QUIET + '">Close</button>' +
                '</div>' +
                '<div class="overflow-y-auto p-5 grid grid-cols-2 gap-4 sm:grid-cols-' + rows.length + '">' +
                    rows.map(cmpColumn).join('') +
                '</div>' +
            '</div>' +
        '</div>';
        document.body.style.overflow = 'hidden';
        var box = $('cmpBox');
        if (box) box.focus();
    }

    function wireModal() {
        on(document, 'click', function (ev) {
            var t = ev.target;
            if (!t || typeof t.closest !== 'function') return;
            if (t.closest('[data-cmp-close]')) closeCompare(false);
        });
        on(document, 'keydown', function (ev) {
            var box = $('cmpBox');
            if (!box) return;
            var k = ev.key;
            if (k === 'Escape' || ev.keyCode === 27) { closeCompare(false); return; }
            if (k === 'Tab' || ev.keyCode === 9) trapTab(ev, box);
        });
    }
    // The dashboard owns the grid; this decides which of its records are in view
    // and rewrites the line under the heading to say why.
    function visible(scans) {
        var all = scans || [];
        var list = all;
        // The line has to be true of what is actually below it: six finds are only
        // the last six when there are more than six.
        var why = '';
        if (all.length > 6) why = 'Your last six finds.';
        else if (all.length) why = plural(all.length, 'find', 'finds') + ' so far.';
        if (state.filter && state.filter.kind === 'album') {
            list = all.filter(function (s) { return s.albumId === state.filter.value; });
            why = albumName(state.filter.value) + ', ' + plural(list.length, 'find', 'finds') + '.';
        } else if (state.filter && state.filter.kind === 'day') {
            list = all.filter(function (s) { return scanDay(s) === state.filter.value; });
            why = plural(list.length, 'find', 'finds') + ' on ' + fmtDay(state.filter.value) + '.';
        }
        var line = $('recentNote');
        if (line) {
            line.innerHTML = esc(why) + (state.filter
                ? ' <button type="button" id="recentAll" class="soft-click text-xs font-medium ' +
                  'text-sage-700 underline hover:text-sage-800 transition">Show everything</button>'
                : '');
            var back = $('recentAll');
            if (back) back.addEventListener('click', function () { setFilter(null); });
        }
        return list.slice(0, state.filter ? 48 : 6);
    }

    function albumOptions(scan) {
        var out = '<option value="">Not in an album</option>';
        state.albums.forEach(function (a) {
            out += '<option value="' + esc(a.id) + '"' + (scan.albumId === a.id ? ' selected' : '') +
                '>' + esc(a.name) + '</option>';
        });
        return out;
    }

    function cardTools(scan) {
        var bits = '';
        if (state.compare) {
            bits += '<label class="flex items-center gap-2 text-xs text-neutral-600 cursor-pointer">' +
                '<input type="checkbox" data-cmp-pick="' + esc(scan.id) + '"' +
                (state.picked.indexOf(scan.id) !== -1 ? ' checked' : '') +
                ' class="h-4 w-4 rounded-sm border-neutral-300">Compare</label>';
        }
        if (state.albums.length) {
            bits += '<select data-file="' + esc(scan.id) + '" aria-label="Album for this find" ' +
                'class="min-w-0 flex-1 text-xs text-neutral-700 bg-white border border-neutral-200 ' +
                'rounded-md px-2 py-1">' + albumOptions(scan) + '</select>';
        }
        return bits;
    }
    function fileScan(scanId, albumId) {
        return window.ffStore.setAlbum(scanId, albumId || null)
            .then(refresh)
            .catch(function (err) {
                note('albumNote', err.message || 'That find could not be filed.', true);
                return refresh();
            });
    }

    function wireGrid(grid) {
        if (grid.getAttribute('data-wired') === '1') return;
        grid.setAttribute('data-wired', '1');
        on(grid, 'change', function (ev) {
            var t = ev.target;
            if (!t || typeof t.closest !== 'function') return;
            var sel = t.closest('[data-file]');
            if (sel) {
                fileScan(sel.getAttribute('data-file'), sel.value);
                return;
            }
            var box = t.closest('[data-cmp-pick]');
            if (!box) return;
            pick(box.getAttribute('data-cmp-pick'));
            // A fifth tick drops the first pick, so that tick has to leave the
            // card as well. Nothing else repaints the grid on a tick.
            syncPicks(grid);
            renderCompare($('comparePanel'));
        });
    }

    function syncPicks(grid) {
        var boxes = grid.querySelectorAll('[data-cmp-pick]');
        for (var i = 0; i < boxes.length; i++) {
            boxes[i].checked = state.picked.indexOf(boxes[i].getAttribute('data-cmp-pick')) !== -1;
        }
    }

    function decorate(grid, shown) {
        if (!grid) return;
        (shown || []).forEach(function (scan) {
            var card = grid.querySelector('[data-scan-id="' + scan.id + '"]');
            if (!card || card.querySelector('[data-tools]')) return;
            var bits = cardTools(scan);
            if (!bits) return;
            var row = document.createElement('div');
            row.setAttribute('data-tools', '1');
            row.className = 'flex items-center gap-2 px-3 py-2 border-t border-neutral-100';
            row.innerHTML = bits;
            card.appendChild(row);
        });
        wireGrid(grid);
    }

    function paintAll() {
        renderMonth($('panelMonth'));
        renderGoal($('panelChallenge'));
        renderAlbums($('panelAlbums'));
        renderCompare($('comparePanel'));
        // An album is somewhere to put finds, and the calendar is a shape made of
        // them, so neither is worth a heading until there is a find.
        var shelf = $('albumsSection');
        if (shelf) shelf.classList.toggle('hidden', !state.scans.length);
        var section = $('calendarSection');
        if (section) section.classList.toggle('hidden', !state.scans.length);
        if (state.scans.length) renderCalendar($('panelCalendar'));
    }
    var mounted = false;

    function mount(opts) {
        var o = opts || {};
        state.uid = o.uid || null;
        hooks.repaint = typeof o.onRepaint === 'function' ? o.onRepaint : null;
        state.filter = null;
        state.compare = false;
        state.picked = [];
        state.cmpNote = '';
        state.month = null;
        state.renaming = null;
        state.arming = null;
        if (!mounted) {
            mounted = true;
            on($('cmpToggle'), 'click', function () { toggleCompare(!state.compare); });
            wireModal();
        }
        return read().then(function () {
            paintAll();
            // The grid is painted before the albums have been read, so the cards
            // have no album picker on them yet. Ask for one more paint, and only
            // when there is an album to file a find into.
            if (state.albums.length && hooks.repaint) hooks.repaint();
        });
    }

    function unmount() {
        closeCompare(true);
        timers.forEach(clearTimeout);
        timers = [];
        listeners.forEach(function (l) { l[0].removeEventListener(l[1], l[2]); });
        listeners = [];
        hooks.repaint = null;
        mounted = false;
        state.filter = null;
        state.compare = false;
        state.picked = [];
        state.cmpNote = '';
        ['panelMonth', 'panelChallenge', 'panelAlbums', 'panelCalendar', 'comparePanel'].forEach(function (id) {
            var el = $(id);
            if (!el) return;
            el.innerHTML = '';
            el.removeAttribute('data-wired');
        });
    }

    // For a change made somewhere else on the page, like an import: re-read the
    // records and repaint these panels, and leave the grid to the caller that is
    // already repainting it.
    function reread() {
        if (!mounted) return Promise.resolve(null);
        return read().then(paintAll);
    }

    window.ffJournal = {
        mount: mount,
        unmount: unmount,
        reread: reread,
        visible: visible,
        decorate: decorate,
        goalToday: goalToday,
        get filter() { return state.filter; },
        get compare() { return state.compare; },
        get picked() { return state.picked.slice(); },
        get albums() { return state.albums.slice(); }
    };
})();
