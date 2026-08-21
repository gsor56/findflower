// scripts/search.js — the dashboard search palette (window.ffSearch).
//
// Ctrl+K, or the field at the top of /dashboard. Three sources, and every one
// of them is real data this site already has:
//
//   your scans   ffStore.listSpecies() — the distinct species in your history,
//                read from the [userId, species] index keys, so a thousand
//                scans cost a few hundred short strings instead of every
//                base64 thumbnail.
//   species      trefle-data.json (the ~40 prebuilt records, same-origin and
//                instant) and then ffApi.searchSpecies() through the Worker for
//                the long tail. The live half is debounced, and when it fails
//                the palette says so — an empty list would read as "no such
//                flower", which is a different answer.
//   pages        the routes this site serves, plus the four panels on this
//                page. Those are real ids on real <section>s.
//
//   botanists   ffStore.listUsers() — the ff_users rows this browser holds.
//               That is every account that has signed in on this device and
//               nobody else: there is no server to ask about anyone further.
//               The section is absent when nothing matches, like the others.
//
// Rows are <a href>. router.js already owns a delegated click handler that
// knows a same-page fragment from a clean path; a palette that navigated by
// itself would be a second, worse copy of it. Enter calls .click() on the
// highlighted row and lets that handler do its job.
//
// Opening is refused while the drawer or the auth wall owns the screen. Both of
// those save and restore document.body.style.overflow, and a second overlay
// doing the same thing unlocks the page underneath the first one — the failure
// mode nav.js's setSidebar() documents.
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

    // Long enough that a two-key burst is one request, short enough that it
    // still feels like typing. The local half answers on every keystroke.
    var LIVE_DEBOUNCE = 260;

    var MAX_SCANS = 6;
    var MAX_LOCAL = 6;
    var MAX_LIVE = 8;
    var MAX_PAGES = 8;
    var MAX_USERS = 5;

    // Routes that exist. Every one of these answers 200 — the harness checks
    // that separately, and nothing gets added here without a page behind it.
    // The last five are anchors on this page: each <section> already carries
    // the id and its own scroll-mt.
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

    /** trefle-data.json, once per session. Shares species.js's sessionStorage
     *  key on purpose: it is the same file, so a reader who has already opened
     *  a species page this session pays nothing here. Missing or offline
     *  resolves to {} — the palette loses its instant local hits and keeps
     *  everything else. */
    var localPromise = null;
    function loadLocal() {
        if (localPromise) return localPromise;
        localPromise = (async function () {
            try {
                var cached = sessionStorage.getItem('ff_trefle_map');
                if (cached) return JSON.parse(cached);
            } catch (e) { /* private window, or a corrupt entry */ }
            try {
                var res = await fetch('trefle-data.json');
                if (!res.ok) return {};
                var map = await res.json();
                try { sessionStorage.setItem('ff_trefle_map', JSON.stringify(map)); } catch (e) { /* quota */ }
                return map;
            } catch (e) {
                return {};
            }
        })();
        return localPromise;
    }

    /** The species in this user's own history. Read once per open rather than
     *  per keystroke: it is an IndexedDB round trip, and a history does not
     *  change while the palette is up. */
    async function loadScans() {
        if (!window.ffStore || typeof ffStore.listSpecies !== 'function') return [];
        try {
            return await ffStore.listSpecies() || [];
        } catch (e) {
            // Blocked or unavailable storage. Your-scans is one of three
            // sections; losing it is not losing the palette.
            return [];
        }
    }

    /** The ff_users rows. Read once per open for the same reason as the scans:
     *  an IndexedDB round trip per keystroke buys nothing when the list cannot
     *  change while the palette is up. */
    async function loadUsers() {
        if (!window.ffStore || typeof ffStore.listUsers !== 'function') return [];
        try {
            return await ffStore.listUsers() || [];
        } catch (e) {
            return [];
        }
    }

    /** An Auth0 sub is "auth0|68a…"; the tail is what tells two accounts on one
     *  device apart, and it is what /profile prints on the card. */
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

    /** The prebuilt records. Matched on the common name, the binomial and the
     *  family, because all three are printed on the row and a match the reader
     *  cannot see looks like a bug. */
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

    // The one icon in here. A magnifier on a search field reads as the control
    // it is; a second icon on every row would be decoration.
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
                        'placeholder="Search species, your scans and pages">' +
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

    /** What the live half of the species section has to say for itself, if
     *  anything. An outage gets a line of its own, because the alternative is
     *  a short list that looks complete. */
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
                // it.name verbatim: Trefle sends the common name when it has
                // one and the binomial when it does not, and title-casing the
                // second kind writes a name no botanist did.
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
            // "Nothing matched" is a claim about the catalogue, and it is not
            // true yet while the request for it is still out. Which of the
            // three it is -- still looking, could not look, looked and found
            // nothing -- is the whole content of an empty result.
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

    /** Move the highlight. Wraps, because a list this short is quicker to walk
     *  round than to reverse out of. */
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

    /** The live half, debounced, with a sequence number instead of an abort:
     *  a response that is no longer the newest is dropped rather than allowed
     *  to overwrite a fresher list. Under two characters is left to the local
     *  records — "ro" would otherwise spend a request on every prefix. */
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

    /** Another overlay already owns the screen. Both the drawer and the auth
     *  wall save and restore document.body.style.overflow, so a second one
     *  doing the same would unlock the page under the first — and a palette
     *  over a sign-in wall is answering a question nobody asked. */
    function blocked() {
        var wall = document.getElementById('authWall');
        if (wall && !wall.classList.contains('hidden')) return true;
        var sb = document.getElementById('ffSidebar');
        if (sb && sb.classList.contains('active')) return true;
        return false;
    }

    async function openPalette() {
        // No trigger means this is not a page that offers search: after a
        // client-side route away from the dashboard the button leaves with
        // <main>, and Ctrl+K goes back to being the browser's.
        if (isOpen || !trigger() || blocked()) return;
        ensure();
        isOpen = true;
        savedFocus = document.activeElement;
        savedOverflow = document.body.style.overflow;
        document.body.style.overflow = 'hidden';
        el.classList.add('active');
        el.setAttribute('aria-hidden', 'false');
        trigger().setAttribute('aria-expanded', 'true');
        input.value = '';
        liveItems = []; liveQuery = ''; liveState = 'idle';
        render();
        // Focus in the same task as the class flip. .ff-cmd.active drops the
        // visibility delay for exactly this reason — see app.css's note on the
        // drawer, where a focus() against a visibility:hidden node was dropped.
        input.focus();

        // Both of these are awaited after the first paint: the palette opens on
        // the routes it already has and repaints as the slower halves land.
        localMap = await loadLocal();
        if (!isOpen) return;
        render();
        scanNames = await loadScans();
        if (!isOpen) return;
        render();
        userRows = await loadUsers();
        if (isOpen) render();
    }

    /**
     * Close it.
     *
     * restoreFocus is false when a row was activated: the anchor's navigation
     * is still in flight, the router is about to replace <main>, and pulling
     * focus back to a button that is on its way out of the document fights it.
     */
    function closePalette(restoreFocus) {
        if (!isOpen) return;
        isOpen = false;
        if (timer) { clearTimeout(timer); timer = null; }
        seq++; // strands any request already in flight
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

    /** Two tab stops, the input and the close button, so the trap is a pair of
     *  edges rather than a query for everything focusable. */
    function trapTab(e) {
        var close = el.querySelector('.ff-cmd__close');
        if (!close) return;
        var on = document.activeElement;
        if (e.shiftKey && on === input) { e.preventDefault(); close.focus(); }
        else if (!e.shiftKey && on === close) { e.preventDefault(); input.focus(); }
        else if (on !== input && on !== close) { e.preventDefault(); input.focus(); }
    }

    // Delegated, not bound to the button: the trigger lives inside <main>, so
    // every client-side return to the dashboard brings a different node.
    document.addEventListener('click', function (e) {
        var t = e.target;
        if (!t || typeof t.closest !== 'function') return;
        if (t.closest('#ffSearchOpen')) { e.preventDefault(); openPalette(); return; }
        if (!isOpen) return;
        if (t.closest('[data-cmd-close]')) { e.preventDefault(); closePalette(true); return; }
        // A row is a real link. Close and let it navigate: router.js's own
        // document-level handler sees the same click and owns what happens next.
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
        // The route table, exposed so the harness can prove every row it can
        // print resolves to a page that exists.
        PAGES: PAGES,
        get isOpen() { return isOpen; },
        get rowCount() { return rows.length; },
    };
})();
