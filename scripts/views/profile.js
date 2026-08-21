/* ============================================================================
   FindFlower — profile view (scripts/views/profile.js)
   ----------------------------------------------------------------------------
   /profile?id=<auth0 sub> renders one botanist's card from IndexedDB alone.
   With no ?id it renders the signed-in viewer's own card.

   Unlike the other views this one owns the FIRST paint as well as router
   swaps: profile.html ships no inline engine, because there is no markup a
   server could have rendered -- every field on the card is a read against
   ff_users, ff_scans, ff_stats and ff_friends. So there is deliberately no
   `if (ctx.initial) return;` guard here. The router calls mount() for the
   initial route too, and that is the only render path.

   Who can see what:

     * own card          -> everything, plus the avatar control and Privacy
                            settings, whatever the visibility flag says
     * public, not yours -> everything except the avatar control
     * private, not yours-> the name and nothing else
     * no row stored     -> the "no profile stored here" state, since a profile
                            exists only in the browser that made it

   Friend rows are per-direction ("<owner>|<other>"), so accepting writes both
   directions here: the other person's request row is updated to accepted at the
   same time as ours is created. That is only sound because both accounts live
   in one browser -- when the WebSocket server exists, acceptance belongs to it.
   ========================================================================== */
(function () {
    'use strict';

    var $ = function (id) { return document.getElementById(id); };
    var STATES = ['pfLoading', 'pfGuest', 'pfMissing', 'pfPrivate', 'pfRemoteMiss', 'pfCard'];

    function esc(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
        });
    }

    function show(el, on) {
        if (el) el.classList.toggle('hidden', !on);
    }

    function only(id) {
        for (var i = 0; i < STATES.length; i++) show($(STATES[i]), STATES[i] === id);
    }

    function titleCase(s) {
        return String(s || '').replace(/\b\w/g, function (c) { return c.toUpperCase(); });
    }

    /** "12 August 2026" — a join date is a date, not "3 months ago". */
    function longDate(iso) {
        var d = new Date(iso);
        if (isNaN(d)) return '';
        return d.toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' });
    }

    function wantedId() {
        try {
            var q = new URLSearchParams(location.search).get('id');
            return q ? String(q) : null;
        } catch (e) {
            return null;
        }
    }

    /* ?handle= is the other kind of card: one the server holds, readable from
       any device. ?id= is an account in this browser. They are different
       identifiers for what may or may not be the same person, so the page never
       tries to guess one from the other. */
    function wantedHandle() {
        try {
            var q = new URLSearchParams(location.search).get('handle');
            q = q ? String(q).trim().toLowerCase().replace(/^@/, '') : '';
            return q || null;
        } catch (e) {
            return null;
        }
    }

    /* An Auth0 sub is "auth0|68a…" — the tail is what distinguishes two
       accounts on one device, and the whole thing is too long for a card. */
    function shortId(sub) {
        var s = String(sub || '');
        var bar = s.indexOf('|');
        var tail = bar === -1 ? s : s.slice(bar + 1);
        return tail.length > 10 ? tail.slice(0, 10) : tail;
    }

    function paintAvatar(user, name) {
        var host = $('pfAvatar');
        if (!host) return;
        var src = user.avatar || user.picture || null;
        if (src) {
            var img = document.createElement('img');
            img.src = src;
            img.alt = '';
            img.className = 'w-full h-full object-cover';
            img.referrerPolicy = 'no-referrer';
            // A dead Auth0 picture URL must fall back to the initial, not a
            // broken-image icon on somebody's identity card.
            img.onerror = function () {
                host.innerHTML = '<span class="font-serif text-2xl text-sage-700">' +
                    esc((name || 'B').charAt(0).toUpperCase()) + '</span>';
            };
            host.innerHTML = '';
            host.appendChild(img);
            return;
        }
        host.innerHTML = '<span class="font-serif text-2xl text-sage-700">' +
            esc((name || 'B').charAt(0).toUpperCase()) + '</span>';
    }

    function paintTop(rows) {
        var host = $('pfTop');
        if (!host) return;
        show($('pfTopEmpty'), !rows.length);
        host.innerHTML = rows.map(function (r, i) {
            return '<li class="flex items-baseline gap-3">' +
                '<span class="ff-rank text-xs text-neutral-300 w-4">' + (i + 1) + '</span>' +
                '<span class="text-sm text-neutral-700 flex-1 min-w-0 break-words">' + esc(titleCase(r.name)) + '</span>' +
                '<span class="ff-stat-n text-xs text-neutral-400">' + r.count + '</span>' +
                '</li>';
        }).join('');
    }

    /* Earned badges only, in catalogue order. A public card is not the place to
       list ten things somebody has NOT done; the count line says how many are
       left, which is the part that is actually informative. */
    function paintBadges(stats) {
        paintBadgeIds((stats && stats.unlockedBadges) || []);
    }

    /* Badge ids, whether they were read from this browser's stats row or from a
       server card. The catalogue that turns an id into a name and an icon is
       local either way: the server stores ids, not artwork. */
    function paintBadgeIds(held) {
        var host = $('pfBadges');
        if (!host) return;
        var all = (window.ffStore && window.ffStore.BADGES) || [];
        var earned = all.filter(function (b) { return held.indexOf(b.id) !== -1; });

        var count = $('pfBadgeCount');
        if (count) count.textContent = earned.length + ' of ' + all.length + ' earned';
        show($('pfBadgesEmpty'), !earned.length);
        host.innerHTML = earned.map(function (b) {
            return '<div class="border border-sage-200 bg-white rounded p-3 text-center" title="' + esc(b.description) + '">' +
                '<div class="text-2xl" aria-hidden="true">' + b.icon + '</div>' +
                '<p class="text-xs font-medium text-neutral-900 mt-1.5">' + esc(b.name) + '</p>' +
                '</div>';
        }).join('');
    }

    var STATUS_LABEL = { accepted: 'Friends', pending: 'Request sent', blocked: 'Blocked' };

    /* A pending row is somebody's outgoing request, which is theirs to disclose,
       not this page's. Another account's card therefore lists accepted
       friendships only; your own lists everything with its real status. */
    function paintFriends(rows, names, isOwn) {
        var host = $('pfFriends');
        if (!host) return;
        var visible = isOwn ? rows : rows.filter(function (r) { return r.status === 'accepted'; });
        show($('pfFriendsEmpty'), !visible.length);
        host.innerHTML = visible.map(function (r) {
            var known = names[r.otherId];
            var label = known && known.name ? known.name : shortId(r.otherId);
            return '<li class="flex items-baseline justify-between gap-3">' +
                '<a href="/profile?id=' + encodeURIComponent(r.otherId) + '" class="text-sm text-sage-600 hover:text-sage-700 underline underline-offset-2 min-w-0 break-words">' +
                esc(label) + '</a>' +
                '<span class="text-xs text-neutral-400 shrink-0">' +
                esc(STATUS_LABEL[r.status] || r.status) + '</span>' +
                '</li>';
        }).join('');
    }

    /* The lists at the foot of the card. Which of them a card can offer depends
       on where it was read from: identifications and species are rows in THIS
       browser, so a server card belonging to somebody else can only offer the
       posts, which are the part a server actually holds. */
    var lists = { uid: null, handle: null, tabs: [], active: null };
    var TAB_LABEL = { observations: 'Observations', threads: 'Threads', species: 'Species' };

    /** Same rule as the feed's, so a post reads the same in both places. */
    function relTime(iso) {
        var then = new Date(iso);
        if (isNaN(then)) return '';
        var mins = Math.floor((Date.now() - then.getTime()) / 60000);
        if (mins < 1) return 'Just now';
        if (mins < 60) return mins + ' min ago';
        var hrs = Math.floor(mins / 60);
        if (hrs < 24) return hrs + (hrs === 1 ? ' hour ago' : ' hours ago');
        var days = Math.floor(hrs / 24);
        if (days === 1) return 'Yesterday';
        if (days < 7) return days + ' days ago';
        return then.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
    }

    function spaceLabel(slug) {
        var all = (window.ffStore && window.ffStore.SPACES) || [];
        for (var i = 0; i < all.length; i++) {
            if (all[i].id === slug) return all[i].label;
        }
        return titleCase(String(slug || '').replace(/-/g, ' '));
    }

    function emptyLine(text) {
        return '<p class="text-sm text-neutral-400">' + esc(text) + '</p>';
    }

    async function observationsHtml() {
        var rows = await window.ffStore.getScans(24, lists.uid);
        if (!rows.length) return emptyLine('Nothing identified yet.');
        return '<div class="grid grid-cols-3 sm:grid-cols-4 gap-3">' + rows.map(function (r) {
            var name = titleCase(r.species);
            var thumb = r.imageBase64
                ? '<img src="' + esc(r.imageBase64) + '" alt="" class="w-full h-full object-cover">'
                : '<span class="text-xs text-neutral-400">No photo</span>';
            return '<a href="/species?name=' + encodeURIComponent(name) + '" class="block group">' +
                '<span class="aspect-square flex items-center justify-center bg-sage-50 border border-neutral-200 rounded overflow-hidden">' +
                thumb + '</span>' +
                '<span class="block text-xs text-neutral-700 group-hover:text-neutral-900 mt-1.5 break-words">' +
                esc(name) + '</span>' +
                '<span class="block text-xs text-neutral-400">' + esc(relTime(r.timestamp)) + '</span>' +
                '</a>';
        }).join('') + '</div>';
    }

    async function threadsHtml() {
        var rows = [];
        if (lists.handle && window.ffSocial && window.ffSocial.ready()) {
            var r = await window.ffSocial.posts({ author: lists.handle, limit: 20 });
            if (!r.ok) return emptyLine(r.error || 'The server did not answer.');
            rows = (r.data && r.data.rows) || [];
        } else if (lists.uid) {
            // The local store indexes posts by space and by time, not by author,
            // so the read is a page of the feed narrowed here.
            var all = await window.ffStore.listPosts({ limit: 100 });
            rows = all.filter(function (p) {
                return String(p.userId) === String(lists.uid);
            }).slice(0, 20);
        }
        if (!rows.length) return emptyLine('Nothing posted yet.');
        return '<ul class="list-none space-y-3">' + rows.map(function (p) {
            var text = String(p.body || '');
            var cut = text.length > 240;
            if (cut) text = text.slice(0, 240);
            var line = esc(spaceLabel(p.space)) + ' &middot; ' + esc(relTime(p.timestamp));
            var head = p.remote
                ? '<a href="/community?post=' + encodeURIComponent(p.id) +
                  '" class="text-xs text-neutral-500 hover:text-neutral-900">' + line + '</a>'
                : '<span class="text-xs text-neutral-500">' + line + '</span>';
            var title = p.title
                ? '<p class="text-sm font-medium text-neutral-900 mt-1.5 break-words">' + esc(p.title) + '</p>'
                : '';
            return '<li class="border border-neutral-200 rounded p-3">' + head + title +
                '<p class="text-sm text-neutral-700 leading-relaxed mt-1.5" style="overflow-wrap:anywhere">' +
                esc(text) + (cut ? '&hellip;' : '') + '</p></li>';
        }).join('') + '</ul>';
    }

    async function speciesHtml() {
        var rows = await window.ffStore.topSpecies(lists.uid, 24);
        if (!rows.length) return emptyLine('No species logged yet.');
        return '<ul class="list-none flex flex-wrap gap-1.5">' + rows.map(function (r) {
            var name = titleCase(r.name);
            return '<li><a href="/species?name=' + encodeURIComponent(name) + '" ' +
                'class="inline-flex items-baseline gap-2 text-sm text-neutral-700 hover:text-neutral-900 ' +
                'hover:bg-neutral-50 border border-neutral-200 rounded px-2.5 py-1.5 transition">' +
                esc(name) + '<span class="text-xs text-neutral-400 tabular-nums">' + r.count +
                '</span></a></li>';
        }).join('') + '</ul>';
    }

    function paintTabs() {
        var strip = $('pfTabs');
        show($('pfLists'), lists.tabs.length > 0);
        if (!strip) return;
        if (lists.tabs.length < 2) {
            // One list is a heading, not a tab: a tab you cannot switch away
            // from is a control that does nothing.
            strip.innerHTML = lists.active
                ? '<h2 id="pfTab-' + lists.active + '" class="text-sm font-medium text-neutral-900">' +
                  esc(TAB_LABEL[lists.active]) + '</h2>'
                : '';
        } else {
            strip.innerHTML = lists.tabs.map(function (id) {
                var on = id === lists.active;
                return '<button type="button" role="tab" id="pfTab-' + id + '" data-tab="' + id + '" ' +
                    'aria-selected="' + (on ? 'true' : 'false') + '" class="text-sm px-3 py-1.5 rounded ' +
                    'border transition ' + (on
                        ? 'bg-sage-50 border-sage-200 text-sage-700'
                        : 'border-neutral-200 text-neutral-500 hover:text-neutral-900 hover:bg-neutral-50') +
                    '">' + esc(TAB_LABEL[id]) + '</button>';
            }).join('');
        }
        var panel = $('pfPanel');
        if (panel && lists.active) panel.setAttribute('aria-labelledby', 'pfTab-' + lists.active);
    }

    async function paintPanel() {
        var panel = $('pfPanel');
        if (!panel) return;
        if (!lists.active) { panel.innerHTML = ''; return; }
        panel.innerHTML = '<p class="text-sm text-neutral-400">Reading&hellip;</p>';
        var want = lists.active;
        var html;
        try {
            if (want === 'observations') html = await observationsHtml();
            else if (want === 'threads') html = await threadsHtml();
            else html = await speciesHtml();
        } catch (e) {
            html = emptyLine('That list could not be read.');
        }
        // A tab pressed while this read was in flight owns the panel now.
        if (lists.active !== want) return;
        panel.innerHTML = html;
    }

    function wireTabs() {
        var strip = $('pfTabs');
        if (!strip || strip.dataset.wired) return;
        strip.dataset.wired = '1';
        strip.addEventListener('click', function (e) {
            var b = e.target.closest('button[data-tab]');
            if (!b) return;
            lists.active = b.getAttribute('data-tab');
            paintTabs();
            paintPanel();
        });
    }

    /* The panel paint is deliberately not awaited: the rest of the card is
       already correct without it, and a slow list should not hold it back. */
    function setLists(uid, handle, tabs) {
        lists.uid = uid;
        lists.handle = handle;
        lists.tabs = tabs;
        if (tabs.indexOf(lists.active) === -1) lists.active = tabs[0] || null;
        wireTabs();
        paintTabs();
        paintPanel();
    }


    function note(text) {
        var el = $('pfActionNote');
        if (!el) return;
        el.textContent = text;
        show(el, !!text);
    }

    function reveal() {
        if (window.ffHomeView && typeof window.ffHomeView.initReveal === 'function') {
            window.ffHomeView.initReveal(document);
            return;
        }
        var els = document.querySelectorAll('main .reveal-up');
        for (var i = 0; i < els.length; i++) els[i].classList.add('active');
    }

    function session() {
        if (typeof getUserSession !== 'function') {
            return Promise.resolve({ authenticated: false, sub: null, name: null, picture: null });
        }
        return getUserSession().catch(function () {
            return { authenticated: false, sub: null, name: null, picture: null };
        });
    }
    function wireAvatar(uid) {
        var input = $('pfAvatarFile');
        if (!input || input.dataset.wired) return;
        input.dataset.wired = '1';
        input.addEventListener('change', function () {
            var file = input.files && input.files[0];
            if (!file) return;
            var msg = $('pfAvatarNote');
            window.ffStore.saveAvatar(file, uid).then(function (data) {
                if (msg) {
                    msg.textContent = data
                        ? 'Picture updated. Stored in this browser at 160 pixels.'
                        : 'That file could not be read as an image.';
                }
                input.value = '';
                return render();
            }).catch(function () {
                if (msg) msg.textContent = 'Could not store that picture in this browser.';
            });
        });
    }

    function reportProfile(wanted, viewer) {
        // The payload the blueprint asks for: which account, when, and who is
        // reporting. There is no moderation queue to POST to, and a fake one
        // would be worse than an email that actually arrives.
        var body = 'Reported profile: ' + wanted + '\n' +
            'Reported at: ' + new Date().toISOString() + '\n' +
            'Reported by: ' + (viewer || 'not signed in') + '\n\n' +
            'What happened:\n';
        window.location.href = 'mailto:support@findflower.me' +
            '?subject=' + encodeURIComponent('Report: ' + wanted) +
            '&body=' + encodeURIComponent(body);
    }

    function on(el, fn) {
        if (!el) return;
        el.onclick = fn;   // assigned, not added: render() runs again after every action
    }

    function paintActions(wanted, viewer, isOwn, mine, theirs) {
        var add = $('pfAdd'), accept = $('pfAccept'), rm = $('pfRemove');
        var report = $('pfReport'), settings = $('pfSettings');
        show(add, false); show(accept, false); show(rm, false);
        show(report, !isOwn); show(settings, isOwn);
        note('');

        if (isOwn || !window.ffStore) return;
        on(report, function () { reportProfile(wanted, viewer); });

        if (!viewer) {
            var el = $('pfActionNote');
            if (el) {
                el.innerHTML = '<a href="/login" class="text-sage-600 hover:text-sage-700 underline underline-offset-2">Sign in</a> to add this botanist.';
                show(el, true);
            }
            return;
        }

        if (mine === 'accepted') {
            rm.textContent = 'Remove friend';
            show(rm, true);
            on(rm, function () {
                window.ffStore.removeFriend(wanted, viewer)
                    .then(function () { return window.ffStore.removeFriend(viewer, wanted); })
                    .then(render);
            });
            return;
        }
        if (mine === 'pending') {
            rm.textContent = 'Cancel request';
            show(rm, true);
            on(rm, function () {
                window.ffStore.removeFriend(wanted, viewer).then(render);
            });
            return;
        }
        if (theirs === 'pending') {
            show(accept, true);
            on(accept, function () {
                // Both directions, or the other card would still read "request
                // sent" while this one reads "friends".
                window.ffStore.addFriend(wanted, viewer, 'accepted')
                    .then(function () { return window.ffStore.addFriend(viewer, wanted, 'accepted'); })
                    .then(render);
            });
            return;
        }
        show(add, true);
        on(add, function () {
            window.ffStore.addFriend(wanted, viewer)
                .then(render)
                .then(function () { note('Request sent. It shows on your card until they accept.'); });
        });
    }

    /* The link to your own server card, if you have one. It costs one request,
       and only on your own card with a server in reach: the answer is what names
       the handle, which no row in this browser records. */
    function offerServerCard(isOwn) {
        var line = $('pfPublicLine'), link = $('pfPublicLink');
        if (!line || !link) return;
        show(line, false);
        if (!isOwn || !window.ffSocial) return;
        window.ffSocial.probe().then(function (up) {
            return up ? window.ffSocial.me() : null;
        }).then(function (r) {
            var h = r && r.ok && r.data && r.data.user ? r.data.user.handle : null;
            if (!h) return;
            link.textContent = 'Your card on the server';
            link.setAttribute('href', '/profile?handle=' + encodeURIComponent(h));
            show(line, true);
        }).catch(function () { /* no server card to offer, so no line */ });
    }

    function wireBio(u) {
        var form = $('pfBioEdit'), box = $('pfBioText'), count = $('pfBioCount');
        if (!form || !box) return;
        box.value = u.bio || '';
        if (count) count.textContent = box.value.length + ' / 280';
        if (form.dataset.wired) return;
        form.dataset.wired = '1';
        box.addEventListener('input', function () {
            if (count) count.textContent = box.value.length + ' / 280';
        });
        form.addEventListener('submit', function (e) {
            e.preventDefault();
            var btn = $('pfBioSave'), msg = $('pfBioNote');
            if (btn) btn.disabled = true;
            window.ffSocial.saveProfile({ bio: box.value.trim() }).then(function (r) {
                if (btn) btn.disabled = false;
                if (msg) {
                    msg.textContent = r.ok ? 'Bio saved on the server.' : (r.error || 'That could not be saved.');
                    show(msg, true);
                }
                if (r.ok) return render();
            });
        });
    }

    function remoteMiss(title, text) {
        var h = $('pfRemoteMissTitle'), p = $('pfRemoteMissNote');
        if (h) h.textContent = title;
        if (p) p.textContent = text;
        only('pfRemoteMiss');
        reveal();
    }

    /* A server card has no friend buttons yet: friendship there is keyed on a
       handle and lives in routes this build has no reader for, so a request sent
       from here would be invisible to whoever received it. */
    function paintRemoteActions(handle, viewer, isOwn) {
        show($('pfAdd'), false);
        show($('pfAccept'), false);
        show($('pfRemove'), false);
        show($('pfReport'), !isOwn);
        show($('pfSettings'), isOwn);
        note('');
        if (!isOwn) on($('pfReport'), function () { reportProfile('@' + handle, viewer); });
    }

    /* Your own server card is where this browser's numbers get published: the
       server cannot count rows it never sees, so it holds whatever was last
       reported. Only a difference is sent, so reading your card costs no write. */
    async function pushOwnNumbers(u, viewer, stats) {
        if (!viewer || !window.ffStore) return;
        var row;
        try {
            row = await window.ffStore.getUser(viewer);
        } catch (e) {
            row = null;
        }
        var fields = {};
        var held = (stats && stats.unlockedBadges) || [];
        if (held.slice().sort().join(',') !== (u.badges || []).slice().sort().join(',')) {
            fields.badges = held;
        }
        var scans = (stats && stats.totalScans) || 0;
        if (!u.stats || u.stats.scansCount !== scans) fields.stats = { scansCount: scans };
        if (row && row.avatar && row.avatar !== u.avatar) fields.avatar = row.avatar;
        if (!Object.keys(fields).length) return;
        await window.ffSocial.saveProfile(fields);
    }

    async function renderRemote(handle, viewer) {
        var social = window.ffSocial;
        if (!social || !(await social.probe())) {
            remoteMiss('That card is on the server, and the server is not answering',
                'A card read by handle comes from the FindFlower server rather than from this ' +
                'browser. Your own card is built here and still works.');
            return;
        }

        var r = await social.profile(handle, !!viewer);
        if (!r.ok || !r.data || !r.data.user) {
            if (r.status === 404) {
                remoteMiss('No account with that handle',
                    'The server holds no profile for @' + handle + '.');
            } else {
                remoteMiss('That card could not be read',
                    r.error || 'The server did not answer that request.');
            }
            return;
        }

        var u = r.data.user;
        var isOwn = !!r.data.isOwner;
        var name = u.displayName || u.handle;

        // On your own card the local rows are the truth and the server holds a
        // copy: read them first, show those, and publish the difference below.
        var localStats = null;
        if (isOwn && viewer && window.ffStore) {
            try { localStats = await window.ffStore.getStats(viewer); } catch (e) { localStats = null; }
        }

        if (r.data.private) {
            var pn = $('pfPrivateName');
            if (pn) pn.textContent = name;
            show($('pfPrivateLocal'), false);
            var pnote = $('pfPrivateNote');
            if (pnote) {
                pnote.textContent = '@' + u.handle + ' keeps this card private. Their posts are still ' +
                    'in the spaces they posted them to.';
                show(pnote, true);
            }
            only('pfPrivate');
            reveal();
            return;
        }

        $('pfName').textContent = name;
        $('pfJoined').textContent = u.createdAt
            ? 'Joined ' + longDate(u.createdAt)
            : 'Join date not recorded';
        $('pfHandle').textContent = isOwn ? '@' + u.handle + ', your card on the server' : '@' + u.handle;
        var bio = $('pfBio');
        if (bio) {
            bio.textContent = u.bio || '';
            show(bio, !!u.bio);
        }
        paintAvatar({ avatar: u.avatar }, name);
        paintBadgeIds(localStats ? (localStats.unlockedBadges || []) : (u.badges || []));

        // Streak, scans and species are counted from rows in one browser, so a
        // server card cannot show them for anybody but the viewer. The two it
        // can show are the post count the server holds and the scan count the
        // account last reported from its own device.
        show($('pfLocalStats'), false);
        show($('pfRemoteStats'), true);
        $('pfThreads').textContent = typeof r.data.threads === 'number' ? r.data.threads : 0;
        var reported = u.stats && typeof u.stats.scansCount === 'number' ? u.stats.scansCount : null;
        if (localStats) reported = localStats.totalScans || 0;
        $('pfReported').textContent = reported === null ? '—' : reported;

        show($('pfTopSection'), false);
        show($('pfFriendsSection'), false);
        show($('pfAvatarRow'), false);
        show($('pfBioEdit'), isOwn);
        if (isOwn) wireBio(u);

        var line = $('pfPublicLine'), link = $('pfPublicLink');
        if (line && link) {
            link.textContent = 'Your card in this browser';
            link.setAttribute('href', '/profile');
            show(line, isOwn);
        }

        setLists(isOwn ? viewer : null, u.handle,
            isOwn ? ['threads', 'observations', 'species'] : ['threads']);
        paintRemoteActions(u.handle, viewer, isOwn);

        only('pfCard');
        reveal();

        if (isOwn) await pushOwnNumbers(u, viewer, localStats);
    }

    async function render() {
        if (!$('pfCard') || !window.ffStore) return;
        if (typeof ffRenderHeader === 'function') ffRenderHeader();

        var me = await session();
        var viewer = me.authenticated && me.sub ? String(me.sub) : null;

        var handle = wantedHandle();
        if (handle) { await renderRemote(handle, viewer); return; }

        var wanted = wantedId() || viewer;

        if (!wanted) { only('pfGuest'); reveal(); return; }

        // Nothing else writes ff_users on a first visit, so the viewer's own row
        // is created here -- from the Auth0 name and picture, since the handle
        // picker is a backend-phase feature.
        if (viewer && viewer === wanted) {
            try {
                await window.ffStore.upsertUser({ id: viewer, name: me.name, picture: me.picture });
            } catch (e) { /* a blocked store still renders below as "no profile" */ }
        }

        var user = null;
        try { user = await window.ffStore.getUser(wanted); } catch (e) { user = null; }
        if (!user) { only('pfMissing'); reveal(); return; }

        var isOwn = !!viewer && viewer === wanted;
        var name = user.name || shortId(wanted);

        if (!user.isPublic && !isOwn) {
            var pn = $('pfPrivateName');
            if (pn) pn.textContent = name;
            show($('pfPrivateLocal'), true);
            show($('pfPrivateNote'), false);
            only('pfPrivate');
            reveal();
            return;
        }

        var stats, unique, top, friends, everyone;
        try {
            stats = await window.ffStore.getStats(wanted);
            unique = await window.ffStore.countUniqueSpecies(wanted);
            top = await window.ffStore.topSpecies(wanted, 3);
            friends = await window.ffStore.listFriends(wanted);
            everyone = await window.ffStore.listUsers();
        } catch (e) {
            only('pfMissing');
            reveal();
            return;
        }

        var names = {};
        everyone.forEach(function (u) { names[u.id] = u; });

        $('pfName').textContent = name;
        $('pfJoined').textContent = user.created
            ? 'Joined ' + longDate(user.created)
            : 'Join date not recorded';
        // The card has no handle to show -- the picker is a backend-phase
        // feature -- so this line carries the one fact that distinguishes two
        // accounts on one device, or tells you the card is yours.
        $('pfHandle').textContent = isOwn
            ? (user.isPublic ? 'Your card, public to other accounts on this device' : 'Your card, private')
            : shortId(wanted);
        paintAvatar(user, name);
        $('pfStreak').textContent = window.ffStore.effectiveStreak(stats);
        $('pfScans').textContent = stats.totalScans || 0;
        $('pfSpecies').textContent = unique;
        paintTop(top);
        paintBadges(stats);
        paintFriends(friends, names, isOwn);

        // Back on the local reads, so the rows only a server can fill go away:
        // a bio and a reported scan count are fields it holds, not this browser.
        show($('pfLocalStats'), true);
        show($('pfRemoteStats'), false);
        show($('pfTopSection'), true);
        show($('pfFriendsSection'), true);
        show($('pfBio'), false);
        show($('pfBioEdit'), false);
        setLists(wanted, null, ['observations', 'threads', 'species']);
        offerServerCard(isOwn);

        show($('pfAvatarRow'), isOwn);
        if (isOwn) wireAvatar(viewer);

        var mine = null, theirs = null;
        if (viewer && !isOwn) {
            mine = await window.ffStore.friendStatus(wanted, viewer);
            theirs = await window.ffStore.friendStatus(viewer, wanted);
        }
        paintActions(wanted, viewer, isOwn, mine, theirs);

        only('pfCard');
        reveal();
    }

    window.ffViews = window.ffViews || {};
    window.ffViews['profile.html'] = {
        mount: function () { return render(); },
        unmount: function () {
            // The only thing this view retains is the reveal observer, which
            // home.js owns; the file input's handler dies with the swapped markup.
            if (window.ffHomeView && typeof window.ffHomeView.teardown === 'function') {
                window.ffHomeView.teardown();
            }
        },
    };

    window.ffProfileView = { render: render };
})();
