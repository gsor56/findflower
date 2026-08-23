(function () {
    'use strict';

    var esc = (window.ffUi && ffUi.esc) ? ffUi.esc : function (s) {
        return String(s === null || s === undefined ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    };

    function titleCase(s) {
        return String(s || '').replace(/\b\w/g, function (c) { return c.toUpperCase(); });
    }

    function fold(s) {
        return String(s || '').trim().toLowerCase();
    }

    var LIVE_DEBOUNCE = 260;

    var MAX_SCANS = 6;
    var MAX_LOCAL = 6;
    var MAX_LIVE = 8;
    var MAX_PAGES = 8;
    var MAX_USERS = 5;

    var PLACEHOLDER = 'Search species, your scans and pages';

    var PAGES = [
        { label: 'Try Now', href: '/try', hint: 'Identify a flower from a photo' },
        { label: 'Directory', href: '/directory', hint: 'Browse the species catalogue' },
        { label: 'Dashboard', href: '/dashboard', hint: 'Your saved identifications' },
        { label: 'How it works', href: '/how' },
        { label: 'Pricing', href: '/pricing' },
        { label: 'API', href: '/api', hint: 'Endpoints and limits' },
        { label: 'Data & integrations', href: '/data' },
        { label: 'Research', href: '/research', hint: 'How the model was built' },
        { label: 'Release notes', href: '/releases' },
        { label: 'Blogs', href: '/blogs', hint: 'Field logs and engineering notes' },
        { label: 'About', href: '/about' },
        { label: 'Community', href: '/community', hint: 'Field notes and corrections' },
        { label: 'Your profile', href: '/profile', hint: 'Your public card' },
        { label: 'Contact', href: '/contact' },
        { label: 'Send feedback', href: '/feedback' },
        { label: 'Privacy Policy', href: '/privacy' },
        { label: 'Terms of Service', href: '/terms' },
        { label: 'Preferences', href: '/dashboard#prefsSection', hint: 'Location, thumbnails, history, motion' },
        { label: 'Places', href: '/dashboard#placesSection', hint: 'Where you found them' },
        { label: 'Profile & privacy', href: '/dashboard#privacySection', hint: 'Who can read your card' },
        { label: 'Model & data', href: '/dashboard#modelSection', hint: 'What identifies a flower' },
        { label: 'Storage on this device', href: '/dashboard#storageSection', hint: 'Export everything, or erase it' }
    ];

    var localPromise = null;
    function loadLocal() {
        if (localPromise) return localPromise;
        localPromise = (async function () {
            try {
                var cached = sessionStorage.getItem('ff_trefle_map');
                if (cached) return JSON.parse(cached);
            } catch (e) { }
            try {
                var res = await fetch('trefle-data.json');
                if (!res.ok) return {};
                var map = await res.json();
                try { sessionStorage.setItem('ff_trefle_map', JSON.stringify(map)); } catch (e) { }
                return map;
            } catch (e) {
                return {};
            }
        })();
        return localPromise;
    }

    async function loadScans() {
        if (!window.ffStore || typeof ffStore.listSpecies !== 'function') return [];
        try {
            return await ffStore.listSpecies() || [];
        } catch (e) {
            return [];
        }
    }

    async function loadUsers() {
        if (!window.ffStore || typeof ffStore.listUsers !== 'function') return [];
        try {
            return await ffStore.listUsers() || [];
        } catch (e) {
            return [];
        }
    }

    function shortId(sub) {
        var str = String(sub || '');
        var bar = str.indexOf('|');
        var tail = bar === -1 ? str : str.slice(bar + 1);
        return tail.length > 10 ? tail.slice(0, 10) : tail;
    }

    function matchUsers(list, q) {
        var out = [];
        for (var i = 0; i < list.length && out.length < MAX_USERS; i++) {
            var u = list[i] || {};
            var tail = shortId(u.id);
            var name = u.name || tail;
            if (q && fold(name).indexOf(q) === -1 && fold(tail).indexOf(q) === -1) continue;
            out.push({
                label: name,
                hint: u.isPublic === false ? 'Private card' : (name === tail ? '' : tail),
                href: '/profile?id=' + encodeURIComponent(u.id)
            });
        }
        return out;
    }

    function matchPages(q) {
        if (!q) return PAGES.slice();
        return PAGES.filter(function (p) {
            return fold(p.label).indexOf(q) !== -1 ||
                (p.hint && fold(p.hint).indexOf(q) !== -1);
        }).slice(0, MAX_PAGES);
    }

    function matchScans(names, q) {
        var out = [];
        for (var i = 0; i < names.length && out.length < MAX_SCANS; i++) {
            if (q && fold(names[i]).indexOf(q) === -1) continue;
            var name = titleCase(names[i]);
            out.push({
                label: name,
                hint: 'In your history',
                href: '/species?name=' + encodeURIComponent(name)
            });
        }
        return out;
    }

    function matchLocal(map, q) {
        if (!q) return [];
        var out = [];
        var keys = Object.keys(map);
        for (var i = 0; i < keys.length && out.length < MAX_LOCAL; i++) {
            var rec = map[keys[i]] || {};
            var hay = fold(keys[i]) + ' ' + fold(rec.matchedName) + ' ' + fold(rec.family);
            if (hay.indexOf(q) === -1) continue;
            var name = titleCase(keys[i]);
            out.push({
                label: name,
                hint: [rec.matchedName, rec.family].filter(Boolean).join(' · '),
                href: '/species?name=' + encodeURIComponent(name)
            });
        }
        return out;
    }

    var el = null, input = null, list = null;
    var isOpen = false;
    var savedFocus = null, savedOverflow = '';
    var scanNames = [], localMap = {}, userRows = [];
    var liveItems = [], liveQuery = '', liveState = 'idle';
    var seq = 0, timer = null;
    var rows = [], sel = -1;

    var SEARCH_ICON =
        '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
            'stroke-width="1.8" stroke-linecap="round" class="text-neutral-400 shrink-0" aria-hidden="true">' +
            '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.4-3.4"/></svg>';

    var CLOSE_ICON =
        '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
            'stroke-width="1.8" stroke-linecap="round" aria-hidden="true">' +
            '<path d="M6 6l12 12M18 6 6 18"/></svg>';

    function ensure() {
        if (el) return el;
        el = document.createElement('div');
        el.id = 'ffCmd';
        el.className = 'ff-cmd';
        el.setAttribute('role', 'dialog');
        el.setAttribute('aria-modal', 'true');
        el.setAttribute('aria-label', 'Search');
        el.setAttribute('aria-hidden', 'true');
        el.innerHTML =
            '<div class="ff-cmd__scrim" data-cmd-close></div>' +
            '<div class="ff-cmd__panel">' +
                '<div class="ff-cmd__head">' + SEARCH_ICON +
                    '<input id="ffCmdInput" class="ff-cmd__input" type="text" role="combobox" ' +
                        'aria-expanded="true" aria-controls="ffCmdList" aria-autocomplete="list" ' +
                        'autocomplete="off" autocapitalize="none" spellcheck="false" ' +
                        'placeholder="' + esc(PLACEHOLDER) + '">' +
                    '<button type="button" class="ff-cmd__close" data-cmd-close ' +
                        'aria-label="Close search">' + CLOSE_ICON + '</button>' +
                '</div>' +
                '<div id="ffCmdList" class="ff-cmd__list" role="listbox" aria-label="Results"></div>' +
                '<p class="ff-cmd__foot">Arrow keys to move &middot; Enter to open &middot; Esc to close</p>' +
            '</div>';
        document.body.appendChild(el);
        input = el.querySelector('#ffCmdInput');
        list = el.querySelector('#ffCmdList');
        input.addEventListener('input', function () { scheduleLive(); render(); });
        list.addEventListener('mouseover', function (e) {
            var row = (e.target && e.target.closest) ? e.target.closest('[data-cmd-row]') : null;
            if (row) select(parseInt(row.getAttribute('data-cmd-row'), 10));
        });
        return el;
    }

    function liveNote(q) {
        if (!q) return '';
        if (liveState === 'unavailable') return 'Live species search is unavailable right now.';
        if (liveState === 'loading') return 'Searching the catalogue…';
        return '';
    }

    function sections(q) {
        var out = [];

        var mine = matchScans(scanNames, q);
        if (mine.length) out.push({ title: 'Your scans', items: mine });

        var species = matchLocal(localMap, q);
        var seen = {};
        species.forEach(function (s) { seen[fold(s.label)] = 1; });
        if (q && liveQuery === q) {
            liveItems.forEach(function (it) {
                if (!it || !it.name || seen[fold(it.name)]) return;
                seen[fold(it.name)] = 1;
                species.push({ label: it.name, hint: it.family || '', href: it.link });
            });
        }
        var note = liveNote(q);
        if (species.length || note) out.push({ title: 'Species', items: species, note: note });

        var people = matchUsers(userRows, q);
        if (people.length) out.push({ title: 'Botanists', items: people });

        var pages = matchPages(q);
        if (pages.length) out.push({ title: 'Pages', items: pages });

        return out;
    }

    function render() {
        if (!input || !list) return;
        var raw = input.value.trim();
        var q = fold(raw);
        var secs = sections(q);
        rows = [];
        var html = '';

        secs.forEach(function (sec, n) {
            var gid = 'ffCmdGrp' + n;
            html += '<div role="group" aria-labelledby="' + gid + '" class="pb-2">' +
                '<div id="' + gid + '" class="px-4 pt-3 pb-1 text-xs font-medium text-neutral-400">' +
                    esc(sec.title) + '</div>';
            if (sec.note) {
                html += '<p class="px-4 pb-1 text-xs font-light text-neutral-400">' + esc(sec.note) + '</p>';
            }
            sec.items.forEach(function (it) {
                var i = rows.length;
                rows.push(it);
                html += '<a id="ffCmdRow' + i + '" data-cmd-row="' + i + '" role="option" ' +
                        'aria-selected="false" tabindex="-1" href="' + esc(it.href) + '" class="ff-cmd__row">' +
                        '<span class="text-sm text-neutral-900 truncate">' + esc(it.label) + '</span>' +
                        (it.hint
                            ? '<span class="text-xs text-neutral-400 truncate">' + esc(it.hint) + '</span>'
                            : '') +
                    '</a>';
            });
            html += '</div>';
        });

        if (!rows.length) {
            html = '<div class="px-4 py-6">' + (liveState === 'loading'
                ? '<p class="text-sm text-neutral-500">Searching the catalogue&hellip;</p>'
                : '<p class="text-sm text-neutral-500">Nothing matched &ldquo;' +
                        esc(raw) + '&rdquo;.</p>' +
                    (liveState === 'unavailable'
                        ? '<p class="mt-1 text-xs font-light text-neutral-400">Live species ' +
                            'search is unavailable right now.</p>'
                        : '')) +
            '</div>';
        }

        list.innerHTML = html;
        select(rows.length ? 0 : -1);
    }

    function select(i) {
        if (!rows.length) {
            sel = -1;
            if (input) input.setAttribute('aria-activedescendant', '');
            return;
        }
        var n = rows.length;
        sel = ((i % n) + n) % n;
        var all = list.querySelectorAll('[data-cmd-row]');
        for (var k = 0; k < all.length; k++) {
            all[k].setAttribute('aria-selected', k === sel ? 'true' : 'false');
        }
        var on = all[sel];
        if (on) {
            input.setAttribute('aria-activedescendant', on.id);
            if (typeof on.scrollIntoView === 'function') on.scrollIntoView({ block: 'nearest' });
        }
    }

    function scheduleLive() {
        var raw = input.value.trim();
        var q = fold(raw);
        if (timer) { clearTimeout(timer); timer = null; }
        if (q.length < 2) { liveItems = []; liveQuery = q; liveState = 'idle'; return; }
        if (!window.ffApi || typeof ffApi.searchSpecies !== 'function') { liveState = 'idle'; return; }
        liveState = 'loading';
        var mine = ++seq;
        timer = setTimeout(async function () {
            timer = null;
            try {
                var res = await ffApi.searchSpecies(raw, { limit: MAX_LIVE });
                if (mine !== seq) return;
                liveItems = res.items || [];
                liveState = 'done';
            } catch (e) {
                if (mine !== seq) return;
                liveItems = [];
                liveState = 'unavailable';
            }
            liveQuery = q;
            if (isOpen) render();
        }, LIVE_DEBOUNCE);
    }

    function trigger() { return document.getElementById('ffSearchOpen'); }

    function blocked() {
        var wall = document.getElementById('authWall');
        if (wall && !wall.classList.contains('hidden')) return true;
        var sb = document.getElementById('ffSidebar');
        if (sb && sb.classList.contains('active')) return true;
        return false;
    }

    async function openPalette() {
        if (isOpen || !trigger() || blocked()) return;
        ensure();
        isOpen = true;
        input.placeholder = trigger().getAttribute('data-placeholder') || PLACEHOLDER;
        savedFocus = document.activeElement;
        savedOverflow = document.body.style.overflow;
        document.body.style.overflow = 'hidden';
        el.classList.add('active');
        el.setAttribute('aria-hidden', 'false');
        trigger().setAttribute('aria-expanded', 'true');
        input.value = '';
        liveItems = []; liveQuery = ''; liveState = 'idle';
        render();
        input.focus();

        localMap = await loadLocal();
        if (!isOpen) return;
        render();
        scanNames = await loadScans();
        if (!isOpen) return;
        render();
        userRows = await loadUsers();
        if (isOpen) render();
    }

    function closePalette(restoreFocus) {
        if (!isOpen) return;
        isOpen = false;
        if (timer) { clearTimeout(timer); timer = null; }
        seq++;
        el.classList.remove('active');
        el.setAttribute('aria-hidden', 'true');
        input.setAttribute('aria-activedescendant', '');
        document.body.style.overflow = savedOverflow;
        var t = trigger();
        if (t) t.setAttribute('aria-expanded', 'false');
        if (restoreFocus) {
            var back = savedFocus;
            if (!back || back === document.body || typeof back.focus !== 'function') back = t;
            if (back && typeof back.focus === 'function') back.focus();
        }
        savedFocus = null;
    }

    function trapTab(e) {
        var close = el.querySelector('.ff-cmd__close');
        if (!close) return;
        var on = document.activeElement;
        if (e.shiftKey && on === input) { e.preventDefault(); close.focus(); }
        else if (!e.shiftKey && on === close) { e.preventDefault(); input.focus(); }
        else if (on !== input && on !== close) { e.preventDefault(); input.focus(); }
    }

    document.addEventListener('click', function (e) {
        var t = e.target;
        if (!t || typeof t.closest !== 'function') return;
        if (t.closest('#ffSearchOpen')) { e.preventDefault(); openPalette(); return; }
        if (!isOpen) return;
        if (t.closest('[data-cmd-close]')) { e.preventDefault(); closePalette(true); return; }
        if (t.closest('[data-cmd-row]')) closePalette(false);
    });

    document.addEventListener('keydown', function (e) {
        var k = e.key;
        if ((e.ctrlKey || e.metaKey) && !e.altKey && (k === 'k' || k === 'K')) {
            if (!trigger()) return;
            e.preventDefault();
            if (isOpen) closePalette(true); else openPalette();
            return;
        }
        if (!isOpen) return;
        if (k === 'Escape' || e.keyCode === 27) { e.preventDefault(); closePalette(true); return; }
        if (k === 'ArrowDown' || e.keyCode === 40) { e.preventDefault(); select(sel + 1); return; }
        if (k === 'ArrowUp' || e.keyCode === 38) { e.preventDefault(); select(sel - 1); return; }
        if (k === 'Enter' || e.keyCode === 13) {
            var on = list.querySelector('[data-cmd-row="' + sel + '"]');
            if (on) { e.preventDefault(); on.click(); }
            return;
        }
        if (k === 'Tab' || e.keyCode === 9) trapTab(e);
    });

    window.ffSearch = {
        open: openPalette,
        close: function () { closePalette(true); },
        PAGES: PAGES,
        get isOpen() { return isOpen; },
        get rowCount() { return rows.length; },
    };
})();
