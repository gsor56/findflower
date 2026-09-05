(function () {
    'use strict';

    var $ = function (id) { return document.getElementById(id); };

    var ROW_GUESS = 132;
    var OVERSCAN = 3;
    var PAGE = 20;

    var WAKE_TRIES = 2;
    var WAKE_TIMEOUT_MS = 25000;
    var WAKE_GAP_MS = 2000;

    var state = {
        space: null,
        posts: [],
        heights: [],
        offsets: [],
        total: 0,
        names: {},
        viewer: null,
        viewerName: '',
        draftRef: null,
        rendered: [0, -1],

        remote: false,
        waking: false,
        handle: null,
        needsHandle: false,
        authStale: false,
        spaces: [],
        hasMore: false,
        single: false,
        focus: null,
    };

    var bound = false;
    var frame = 0;
    var settle = 0;
    var composer = null;

    function esc(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
        });
    }

    function show(el, on) {
        if (el) el.classList.toggle('hidden', !on);
    }

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

    function shortId(sub) {
        var s = String(sub || '');
        var bar = s.indexOf('|');
        var tail = bar === -1 ? s : s.slice(bar + 1);
        return tail.length > 10 ? tail.slice(0, 10) : tail;
    }

    function spacesList() {
        if (state.remote && state.spaces.length) return state.spaces;
        return (window.ffStore && window.ffStore.SPACES) || [];
    }

    function spaceLabel(id) {
        var list = spacesList();
        for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i].label;
        return id || 'All spaces';
    }

    function note(text) {
        var el = $('cmFeedNote');
        if (!el) return;
        el.textContent = text || '';
        show(el, !!text);
    }

    function badgeName(id) {
        var all = (window.ffStore && window.ffStore.BADGES) || [];
        for (var i = 0; i < all.length; i++) if (all[i].id === id) return all[i].name;
        return id;
    }

    function avatarCell(row, name) {
        var src = row && (row.avatar || row.picture);
        if (src) {
            return '<img src="' + esc(src) + '" alt="" referrerpolicy="no-referrer" ' +
                'class="w-8 h-8 shrink-0 rounded border border-neutral-200 object-cover">';
        }
        return '<span class="w-8 h-8 shrink-0 rounded border border-neutral-200 bg-sage-50 ' + 'flex items-center justify-center font-serif text-sm text-sage-700">' +
            esc((name || 'B').charAt(0).toUpperCase()) + '</span>';
    }

    var ACT = 'text-xs text-neutral-500 hover:text-neutral-900 hover:bg-neutral-50 rounded ' +
        'px-2 py-1 transition disabled:opacity-40';

    function bodyHtml(md) {
        if (window.ffComposer && typeof window.ffComposer.toHtml === 'function') {
            return window.ffComposer.toHtml(md);
        }
        return esc(md).replace(/\n/g, '<br>');
    }

    function actionsHtml(p) {
        if (!p.remote) return '';
        var can = !!(state.remote && state.handle);
        var out = [];
        if (can) {
            out.push('<button type="button" data-act="like" data-id="' + esc(p.id) + '" ' +
                'aria-pressed="' + (p.likedByViewer ? 'true' : 'false') + '" class="' + ACT + (p.likedByViewer ? ' text-sage-700' : '') + '">' +
                (p.likedByViewer ? 'Liked' : 'Like') + (p.likeCount ? ' ' + p.likeCount : '') +
                '</button>');
        } else if (p.likeCount) {
            out.push('<span class="text-xs text-neutral-400 tabular-nums px-2 py-1">' +
                p.likeCount + (p.likeCount === 1 ? ' like' : ' likes') + '</span>');
        }
        out.push('<button type="button" data-act="share" data-id="' + esc(p.id) + '" class="' + ACT + '">Share</button>');
        if (p.mine) {
            out.push('<button type="button" data-act="delete" data-id="' + esc(p.id) + '" class="' + ACT + '">Delete</button>');
        } else if (can) {
            out.push('<button type="button" data-act="report" data-id="' + esc(p.id) + '" class="' + ACT + '">Report</button>');
        }
        return '<div class="flex flex-wrap items-center gap-1 mt-3 pt-3 border-t border-neutral-100">' +
            out.join('') + '</div>';
    }

    function rowHtml(p, i) {
        var who = state.names[p.userId] || (p.remote ? p : null);
        var name = p.authorName || (who && who.name) || shortId(p.userId);
        var top = state.offsets[i] || 0;
        var ref = p.articleRef
            ? '<p class="text-xs text-neutral-400 mt-3">Started from ' +
              '<a href="/article?id=' + encodeURIComponent(p.articleRef) + '" ' +
              'class="text-sage-600 hover:text-sage-700 underline underline-offset-2">this field log</a></p>'
            : '';
        var href = p.handle
            ? '/profile?handle=' + encodeURIComponent(p.handle)
            : '/profile?id=' + encodeURIComponent(p.userId);
        var at = p.handle
            ? '<span class="text-xs text-neutral-400 break-words">@' + esc(p.handle) + '</span>'
            : '';
        var focused = state.focus && p.id === state.focus;

        return '<article class="ff-post pb-3" data-i="' + i + '" data-id="' + esc(p.id) + '" ' +
            'style="top:' + top + 'px">' +
            '<div class="bg-white border rounded p-4 ' + (focused ? 'border-sage-200' : 'border-neutral-200') + '">' +
                '<div class="flex items-center gap-3">' +
                    avatarCell(who, name) +
                    '<div class="min-w-0 flex-1">' +
                        '<div class="flex flex-wrap items-baseline gap-x-2">' +
                            '<a href="' + esc(href) + '" ' +
                            'class="text-sm font-medium text-neutral-900 hover:text-sage-700 break-words">' +
                            esc(name) + '</a>' + at +
                        '</div>' +
                        '<p class="text-xs text-neutral-400">' + esc(relTime(p.timestamp)) +
                        ' &middot; <span class="text-neutral-500 bg-neutral-100 rounded px-1.5 py-0.5">' +
                        esc(spaceLabel(p.space)) + '</span></p>' +
                    '</div>' +
                '</div>' +
                '<div class="ff-post-body text-sm text-neutral-700 leading-relaxed mt-3">' +
                    bodyHtml(p.body) + '</div>' +
                ref +
                actionsHtml(p) +
            '</div>' +
            '</article>';
    }

    function computeOffsets() {
        var run = 0;
        state.offsets = [];
        for (var i = 0; i < state.posts.length; i++) {
            state.offsets.push(run);
            run += state.heights[i] || ROW_GUESS;
        }
        state.total = run;
        var feed = $('cmFeed');
        if (feed) feed.style.height = run + 'px';
    }

    function visibleRange() {
        var feed = $('cmFeed');
        if (!feed || !state.posts.length) return [0, -1];

        var listTop = feed.getBoundingClientRect().top + window.pageYOffset;
        var from = window.pageYOffset - listTop;
        var to = from + window.innerHeight;

        var first = -1, last = -1;
        for (var i = 0; i < state.posts.length; i++) {
            var a = state.offsets[i] || 0;
            var b = a + (state.heights[i] || ROW_GUESS);
            if (b <= from) continue;
            if (a >= to) break;
            if (first === -1) first = i;
            last = i;
        }
        if (first === -1) return [0, -1];
        return [
            Math.max(0, first - OVERSCAN),
            Math.min(state.posts.length - 1, last + OVERSCAN),
        ];
    }

    function paintWindow(force, depth) {
        var feed = $('cmFeed');
        if (!feed) return;

        var r = visibleRange();
        if (!force && r[0] === state.rendered[0] && r[1] === state.rendered[1]) return;

        var html = '';
        for (var i = r[0]; i <= r[1]; i++) html += rowHtml(state.posts[i], i);
        feed.innerHTML = html;
        state.rendered = r;

        var changed = false;
        var nodes = feed.children;
        for (var j = 0; j < nodes.length; j++) {
            var idx = Number(nodes[j].getAttribute('data-i'));
            var h = nodes[j].offsetHeight;
            if (h && Math.abs((state.heights[idx] || 0) - h) > 1) {
                state.heights[idx] = h;
                changed = true;
            }
        }
        if (changed && (depth || 0) < 1) {
            computeOffsets();
            paintWindow(true, (depth || 0) + 1);
            return;
        }
        scheduleSettle(feed);
    }

    function scheduleSettle(feed) {
        if (settle) return;
        settle = requestAnimationFrame(function () {
            settle = 0;
            var moved = false;
            var kids = feed.children;
            for (var k = 0; k < kids.length; k++) {
                var idx = Number(kids[k].getAttribute('data-i'));
                var h = kids[k].offsetHeight;
                if (h && Math.abs((state.heights[idx] || 0) - h) > 1) {
                    state.heights[idx] = h;
                    moved = true;
                }
            }
            if (moved) {
                computeOffsets();
                paintWindow(true, 0);
            }
        });
    }

    function onScroll() {
        if (frame) return;
        frame = requestAnimationFrame(function () {
            frame = 0;
            paintWindow(false);
        });
    }

    function onResize() {
        paintWindow(true);
    }

    function bind() {
        if (bound) return;
        bound = true;
        window.addEventListener('scroll', onScroll, { passive: true });
        window.addEventListener('resize', onResize);
    }

    function unbind() {
        if (!bound) return;
        bound = false;
        window.removeEventListener('scroll', onScroll);
        window.removeEventListener('resize', onResize);
        if (frame) { cancelAnimationFrame(frame); frame = 0; }
        if (settle) { cancelAnimationFrame(settle); settle = 0; }
    }

    function paintSpaces() {
        var host = $('cmSpaces');
        if (!host) return;
        var spaces = [{ id: null, label: 'All spaces', blurb: 'Everything, newest first' }]
            .concat(spacesList());

        host.innerHTML = spaces.map(function (s) {
            var on = state.space === s.id;
            var n = typeof s.posts === 'number'
                ? '<span class="text-xs text-neutral-400 tabular-nums ml-2">' + s.posts + '</span>'
                : '';
            return '<button type="button" class="ff-space text-left text-sm px-3 py-2 rounded ' + 'lg:flex lg:items-baseline lg:justify-between lg:w-full transition ' + (on ? '' : 'text-neutral-500 hover:text-neutral-900 hover:bg-neutral-50') + '" ' +
                'data-space="' + esc(s.id || '') + '" aria-current="' + (on ? 'true' : 'false') + '" ' +
                'title="' + esc(s.blurb || '') + '"><span>' + esc(s.label) + '</span>' + n + '</button>';
        }).join('');
    }

    function feedHeading() {
        var t = $('cmFeedTitle');
        if (t) t.textContent = spaceLabel(state.space);
        var c = $('cmFeedCount');
        if (c) {
            c.textContent = state.posts.length
                ? state.posts.length + (state.posts.length === 1 ? ' post' : ' posts')
                : '';
        }
        var cap = $('cmCap');
        var capped = !state.remote && window.ffStore &&
            state.posts.length >= window.ffStore.CACHE_LIMIT;
        if (cap && capped) {
            cap.textContent = 'Showing the newest ' + window.ffStore.CACHE_LIMIT +
                ' posts. Older ones stay in this browser and are read a page at a time.';
        }
        show(cap, !!capped);
        show($('cmEmpty'), !state.posts.length);
        show($('cmMore'), !!(state.remote && state.hasMore && !state.single));
    }

    function seat(rows) {
        state.posts = rows || [];
        state.heights = state.posts.map(function () { return ROW_GUESS; });
        state.rendered = [0, -1];
        feedHeading();
        computeOffsets();
        paintWindow(true);
    }

    async function loadRemote() {
        var r = await window.ffSocial.posts({
            space: state.space, page: 1, limit: PAGE, auth: !!state.handle
        });
        if (!r.ok || !r.data) return false;
        state.hasMore = !!r.data.hasMore;
        seat(r.data.rows || []);
        return true;
    }

    async function load() {
        state.single = false;
        state.focus = null;
        if (state.remote) {
            if (await loadRemote()) return;
            state.remote = false;
            syncNote();
            note('The server stopped answering, so this is the copy in your browser.');
        }
        state.hasMore = false;
        if (!window.ffStore) return;
        var rows = [];
        try {
            rows = await window.ffStore.listPosts({ space: state.space });
        } catch (e) {
            rows = [];
        }

        try {
            var users = await window.ffStore.listUsers();
            state.names = {};
            users.forEach(function (u) { state.names[u.id] = u; });
        } catch (e) { }

        seat(rows);
    }

    async function loadMore() {
        var btn = $('cmMore');
        var last = state.posts[state.posts.length - 1];
        if (!state.remote || !last) return;
        if (btn) btn.disabled = true;
        var r = await window.ffSocial.posts({
            space: state.space, before: last.timestamp, limit: PAGE, auth: !!state.handle
        });
        if (btn) btn.disabled = false;
        if (!r.ok || !r.data) {
            note(r.error || 'Could not read older posts.');
            return;
        }
        var rows = r.data.rows || [];
        state.hasMore = !!r.data.hasMore;
        for (var i = 0; i < rows.length; i++) {
            state.posts.push(rows[i]);
            state.heights.push(ROW_GUESS);
        }
        feedHeading();
        computeOffsets();
        paintWindow(true);
    }

    function syncNote() {
        var dot = $('cmSyncDot');
        var text = $('cmSyncText');
        var where = $('cmWhere');
        var msg;
        if (state.waking) msg = 'The server is starting up. Showing this browser’s copy meanwhile.';
        else if (!state.remote) msg = 'Posts stay in this browser’s own storage.';
        else if (state.handle) msg = 'Posting as @' + state.handle + ' on the FindFlower server.';
        else if (state.authStale) msg = 'The server would not take your sign-in. Sign in again to post.';
        else if (state.viewer) msg = 'Reading the FindFlower server. Pick a handle to post.';
        else msg = 'Reading the FindFlower server. Sign in to post.';

        if (dot) {
            var tone = 'bg-neutral-300';
            if (state.remote) tone = 'bg-sage-500';
            else if (state.waking) tone = 'bg-neutral-400 animate-pulse';
            dot.className = 'w-1.5 h-1.5 shrink-0 rounded-full ' + tone;
        }
        if (text) text.textContent = msg;
        if (where) {
            var localPaging = '<p class="mt-3">The feed reads at most 100 posts at a time and ' +
                'keeps only the rows near your scroll position in the page.</p>';
            if (state.remote) {
                where.innerHTML =
                    '<p class="mt-3">Post text is stored on the FindFlower server, so it reaches ' +
                    'other people and other devices. Photos are not sent: your identifications and ' +
                    'their thumbnails stay in this browser.</p>' +
                    '<p class="mt-3">The feed reads twenty posts at a time and keeps only the rows ' +
                    'near your scroll position in the page.</p>';
            } else if (state.waking) {
                where.innerHTML =
                    '<p class="mt-3">The server is starting up, which takes up to a minute when it ' +
                    'has been idle. Until it answers, this is the copy in this browser&rsquo;s ' +
                    'IndexedDB.</p>' + localPaging;
            } else {
                where.innerHTML =
                    '<p class="mt-3">The server is not answering, so this is the copy in this ' +
                    'browser&rsquo;s IndexedDB. Clearing site data deletes it, and no other device ' +
                    'can see it.</p>' + localPaging;
            }
        }
    }

    async function loadSpaces() {
        var r = await window.ffSocial.spaces();
        if (!r.ok || !r.data || !Array.isArray(r.data.spaces)) return false;
        state.spaces = r.data.spaces.map(function (s) {
            return { id: s.slug, label: s.name, blurb: s.description || '', posts: s.posts || 0 };
        });
        return true;
    }

    function indexOf(id) {
        for (var i = 0; i < state.posts.length; i++) {
            if (state.posts[i].id === id) return i;
        }
        return -1;
    }

    function postParam() {
        try {
            return new URLSearchParams(location.search).get('post');
        } catch (e) {
            return null;
        }
    }

    function scrollToRow(i) {
        var feed = $('cmFeed');
        if (!feed) return;
        var listTop = feed.getBoundingClientRect().top + window.pageYOffset;
        var y = listTop + (state.offsets[i] || 0) - 96;
        window.scrollTo(0, y < 0 ? 0 : y);
    }

    async function focusPost(id) {
        var i = indexOf(id);
        if (i !== -1) {
            state.focus = id;
            paintWindow(true);
            scrollToRow(i);
            return;
        }
        if (!state.remote) return;
        var r = await window.ffSocial.post(id, !!state.handle);
        if (!r.ok || !r.data || !r.data.row) {
            note(r.status === 404 ? 'That post is not on the server any more.'
                : (r.error || 'That post could not be read.'));
            return;
        }
        state.single = true;
        state.focus = id;
        seat([r.data.row]);
        note('Showing one post. Pick a space to read the whole feed.');
    }

    function session() {
        if (typeof getUserSession !== 'function') {
            return Promise.resolve({ authenticated: false, sub: null, name: null, picture: null });
        }
        return getUserSession().catch(function () {
            return { authenticated: false, sub: null, name: null, picture: null };
        });
    }

    function draftParam() {
        try {
            return new URLSearchParams(location.search).get('draft_ref');
        } catch (e) {
            return null;
        }
    }

    async function fileTitle(ref) {
        try {
            var res = await fetch('/articles/manifest.json');
            if (!res.ok) return '';
            var list = await res.json();
            if (!Array.isArray(list)) return '';
            for (var i = 0; i < list.length; i++) {
                var row = list[i];
                if (!row || !row.filename || !row.title) continue;
                if (String(row.filename).replace(/[.]md$/, '') !== ref) continue;
                return String(row.title).trim();
            }
        } catch (e) { }
        return '';
    }

    async function prefillDraft(ref) {
        var box = $('cmBody');
        var line = $('cmDraftRef');
        if (!box) return;

        var href = location.origin + '/article?id=' + encodeURIComponent(ref);
        var title = '';
        try {
            var res = await fetch('/article?id=' + encodeURIComponent(ref), { credentials: 'same-origin' });
            if (res.ok) {
                var doc = new DOMParser().parseFromString(await res.text(), 'text/html');
                var h1 = doc.querySelector('article[data-entry="' + ref + '"] h1');
                if (h1) title = h1.textContent.trim();
            }
        } catch (e) { }
        // A field log kept as markdown has no title in the page it is served
        // from, so the index is the only place left to read it.
        if (!title) title = await fileTitle(ref);

        state.draftRef = ref;
        if (!box.value) {
            box.value = (title ? 'Re: ' + title + '\n' : '') + href + '\n\n';
            countChars();
        }
        if (line) {
            line.innerHTML = 'Attached to <a href="' + esc('/article?id=' + encodeURIComponent(ref)) +
                '" class="text-sage-600 hover:text-sage-700 underline underline-offset-2">' +
                esc(title || 'the field log you came from') + '</a>.';
            show(line, true);
        }
    }

    function countChars() {
        var box = $('cmBody');
        var out = $('cmCount');
        var btn = $('cmPost');
        if (!box) return;
        var max = (window.ffStore && window.ffStore.POST_MAX_CHARS) || 2000;
        if (out) out.textContent = box.value.length + ' / ' + max;
        if (btn) btn.disabled = !box.value.trim();
    }

    function fillSpaceSelect() {
        var sel = $('cmSpace');
        if (!sel) return;
        var spaces = spacesList();
        sel.innerHTML = spaces.map(function (s) {
            return '<option value="' + esc(s.id) + '">' + esc(s.label) + '</option>';
        }).join('');
        if (state.space) sel.value = state.space;
    }

    function insertRow(row) {
        if (!row || state.single) return false;
        if (state.space && row.space !== state.space) return false;
        state.posts.unshift(row);
        state.heights.unshift(ROW_GUESS);
        state.rendered = [0, -1];
        feedHeading();
        computeOffsets();
        paintWindow(true);
        return true;
    }

    async function submitPost(e) {
        e.preventDefault();
        var box = $('cmBody');
        var sel = $('cmSpace');
        var btn = $('cmPost');
        var msg = $('cmPostNote');
        if (!box || !state.viewer || !window.ffStore) return;

        var body = box.value.trim();
        if (!body) return;

        if (state.remote) {
            if (!state.handle) {
                showClaim(true);
                claimNote('Pick a handle first. What you typed is kept.');
                return;
            }
            if (btn) btn.disabled = true;
            var r = await window.ffSocial.createPost({
                space: sel ? sel.value : null,
                content: body,
                articleRef: state.draftRef || null
            });
            countChars();
            if (r.needsHandle) {
                state.handle = null;
                state.needsHandle = true;
                syncNote();
                showClaim(true);
                claimNote('Pick a handle first. What you typed is kept.');
                return;
            }
            if (!r.ok) {
                if (msg) {
                    msg.textContent = r.error || 'The server did not take that post.';
                    show(msg, true);
                }
                return;
            }
            box.value = '';
            countChars();
            if (composer) composer.reset();
            state.draftRef = null;
            show($('cmDraftRef'), false);
            if (msg) {
                msg.textContent = 'Posted.';
                show(msg, true);
            }
            if (!insertRow(r.data && r.data.row)) await load();
            return;
        }

        if (btn) btn.disabled = true;
        var out = null;
        try {
            out = await window.ffStore.addPost({
                body: body,
                space: sel ? sel.value : null,
                userId: state.viewer,
                authorName: state.viewerName,
                articleRef: state.draftRef,
            });
        } catch (err) {
            if (msg) {
                msg.textContent = 'This browser would not store that post.';
                show(msg, true);
            }
            countChars();
            return;
        }

        box.value = '';
        countChars();
        if (composer) composer.reset();
        state.draftRef = null;
        show($('cmDraftRef'), false);

        if (msg) {
            var earned = (out && out.newBadges) || [];
            msg.textContent = earned.length
                ? 'Posted. Badge earned: ' + earned.map(badgeName).join(', ') + '.'
                : 'Posted. It is in this browser only.';
            show(msg, true);
        }

        if (!insertRow(out && out.post)) await load();
    }

    function share(id) {
        var url = location.origin + '/community?post=' + encodeURIComponent(id);
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(url).then(function () {
                note('Link copied. ' + url);
            }, function () {
                note(url);
            });
            return;
        }
        note(url);
    }

    async function feedAction(ev) {
        var btn = ev.target.closest('button[data-act]');
        if (!btn) return;
        var act = btn.getAttribute('data-act');
        var id = btn.getAttribute('data-id');
        var i = indexOf(id);
        if (i === -1) return;

        if (act === 'share') {
            share(id);
            return;
        }
        if (!state.remote || !state.handle) return;

        if (act === 'like') {
            btn.disabled = true;
            var r = await window.ffSocial.likePost(id);
            if (!r.ok) {
                btn.disabled = false;
                note(r.error || 'That like did not save.');
                return;
            }
            state.posts[i].likedByViewer = !!(r.data && r.data.likedByViewer);
            state.posts[i].likeCount = (r.data && r.data.likeCount) || 0;
            note('');
            paintWindow(true);
            return;
        }
        if (act === 'delete') {
            if (!window.confirm('Delete this post? It stops being readable for everyone.')) return;
            var d = await window.ffSocial.deletePost(id);
            if (!d.ok) {
                note(d.error || 'That post was not deleted.');
                return;
            }
            state.posts.splice(i, 1);
            state.heights.splice(i, 1);
            state.rendered = [0, -1];
            feedHeading();
            computeOffsets();
            paintWindow(true);
            note('Deleted.');
            return;
        }
        if (act === 'report') {
            var reason = window.prompt('What is wrong with this post?');
            if (reason === null) return;
            reason = String(reason).trim();
            if (!reason) {
                note('A report needs a reason.');
                return;
            }
            var rp = await window.ffSocial.reportPost(id, reason);
            note(rp.ok ? 'Reported, with your reason.' : (rp.error || 'That report did not send.'));
        }
    }

    function showClaim(on) {
        show($('cmClaim'), on);
        if (on) show($('cmForm'), false);
        var h = $('cmHandle');
        var d = $('cmDisplay');
        if (on && h && !h.value) h.value = suggestHandle();
        if (on && d && !d.value) d.value = state.viewerName || '';
    }

    function claimNote(text) {
        var msg = $('cmClaimNote');
        if (!msg) return;
        msg.textContent = text;
        show(msg, true);
    }

    function showStale(on) {
        show($('cmStale'), on);
        if (on) show($('cmForm'), false);
    }

    function suggestHandle() {
        var s = String(state.viewerName || '').toLowerCase()
            .replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 20);
        return window.ffSocial.handleError(s) ? '' : s;
    }

    async function claimSubmit(e) {
        e.preventDefault();
        var h = $('cmHandle');
        var d = $('cmDisplay');
        var btn = $('cmClaimGo');
        var msg = $('cmClaimNote');
        if (!h) return;

        var handle = String(h.value || '').trim().toLowerCase();
        var bad = window.ffSocial.handleError(handle);
        if (bad) {
            if (msg) { msg.textContent = bad; show(msg, true); }
            h.focus();
            return;
        }
        if (btn) btn.disabled = true;
        var r = await window.ffSocial.saveProfile({
            handle: handle,
            displayName: d ? String(d.value || '').trim() : ''
        });
        if (btn) btn.disabled = false;
        if (!r.ok || !r.data || !r.data.user) {
            if (msg) { msg.textContent = r.error || 'That handle was not saved.'; show(msg, true); }
            return;
        }

        state.handle = r.data.user.handle;
        state.needsHandle = false;
        show(msg, false);
        showClaim(false);
        show($('cmForm'), true);
        show($('cmSpaceNew'), true);
        countChars();
        syncNote();
        await load();
    }

    async function spaceSubmit(e) {
        e.preventDefault();
        var name = $('cmSpaceName');
        var desc = $('cmSpaceDesc');
        var msg = $('cmSpaceNote');
        var n = name ? String(name.value || '').trim() : '';
        if (n.length < 3) {
            if (msg) { msg.textContent = 'A name needs at least three characters.'; show(msg, true); }
            return;
        }
        var r = await window.ffSocial.createSpace(n, desc ? String(desc.value || '').trim() : '');
        if (!r.ok || !r.data || !r.data.space) {
            if (msg) { msg.textContent = r.error || 'That space was not created.'; show(msg, true); }
            return;
        }
        if (name) name.value = '';
        if (desc) desc.value = '';
        show(msg, false);
        show($('cmSpaceForm'), false);
        show($('cmSpaceNew'), true);
        await loadSpaces();
        state.space = r.data.space.slug;
        paintSpaces();
        fillSpaceSelect();
        await load();
    }

    function wire() {
        var form = $('cmForm');
        var box = $('cmBody');
        var host = $('cmSpaces');
        var feed = $('cmFeed');

        if (form && !form.dataset.wired) {
            form.dataset.wired = '1';
            form.addEventListener('submit', submitPost);
        }
        if (box && !box.dataset.wired) {
            box.dataset.wired = '1';
            box.addEventListener('input', countChars);
        }
        if (box && window.ffComposer && !composer) {
            composer = window.ffComposer.attach({ box: box });
        }
        if (host && !host.dataset.wired) {
            host.dataset.wired = '1';
            host.addEventListener('click', function (ev) {
                var btn = ev.target.closest('button[data-space]');
                if (!btn) return;
                var id = btn.getAttribute('data-space') || null;
                if (id === state.space && !state.single) return;
                state.space = id;
                note('');
                paintSpaces();
                fillSpaceSelect();
                load();
            });
        }
        if (feed && !feed.dataset.wired) {
            feed.dataset.wired = '1';
            feed.addEventListener('click', feedAction);
        }

        var claim = $('cmClaim');
        if (claim && !claim.dataset.wired) {
            claim.dataset.wired = '1';
            claim.addEventListener('submit', claimSubmit);
        }
        var more = $('cmMore');
        if (more && !more.dataset.wired) {
            more.dataset.wired = '1';
            more.addEventListener('click', function () { loadMore(); });
        }
        var newSpace = $('cmSpaceNew');
        if (newSpace && !newSpace.dataset.wired) {
            newSpace.dataset.wired = '1';
            newSpace.addEventListener('click', function () {
                show(newSpace, false);
                show($('cmSpaceForm'), true);
                var f = $('cmSpaceName');
                if (f) f.focus();
            });
        }
        var spaceForm = $('cmSpaceForm');
        if (spaceForm && !spaceForm.dataset.wired) {
            spaceForm.dataset.wired = '1';
            spaceForm.addEventListener('submit', spaceSubmit);
            var cancel = $('cmSpaceCancel');
            if (cancel) {
                cancel.addEventListener('click', function () {
                    show(spaceForm, false);
                    show($('cmSpaceNote'), false);
                    show($('cmSpaceNew'), true);
                });
            }
        }
    }

    function reveal() {
        if (window.ffHomeView && typeof window.ffHomeView.initReveal === 'function') {
            window.ffHomeView.initReveal(document);
            return;
        }
        var els = document.querySelectorAll('main .reveal-up');
        for (var i = 0; i < els.length; i++) els[i].classList.add('active');
    }

    async function probeOnce(force, timeout) {
        try {
            return await window.ffSocial.probe(force, timeout);
        } catch (e) {
            return false;
        }
    }

    async function wakeServer() {
        for (var i = 0; i < WAKE_TRIES; i++) {
            if (i) await new Promise(function (r) { setTimeout(r, WAKE_GAP_MS); });
            if (!state.waking || !$('cmFeed')) return;
            if (await probeOnce(true, WAKE_TIMEOUT_MS)) {
                state.waking = false;
                if ($('cmFeed')) await goRemote();
                return;
            }
        }
        state.waking = false;
        // Nothing answered, so posting falls back to this browser's own store,
        // which needs the composer that render() held back for the server.
        if (state.viewer) show($('cmForm'), true);
        syncNote();
    }

    async function syncUp() {
        if (!window.ffSocial) return;
        if (await probeOnce()) {
            await goRemote();
            return;
        }
        if (window.ffSocial.base()) {
            state.waking = true;
            syncNote();
            wakeServer().catch(function () {
                state.waking = false;
                syncNote();
            });
            return;
        }
        syncNote();
    }

    async function goRemote() {
        state.remote = true;

        if (state.viewer) {
            var r = await window.ffSocial.me();
            // One dropped request is not an answer, and the health probe answered
            // moments ago, so a request that never arrived is worth asking twice.
            if (!r.ok && r.status === 0) r = await window.ffSocial.me();
            if (r.ok && r.data && r.data.user) {
                state.handle = r.data.user.handle;
                state.needsHandle = false;
                state.authStale = false;
            } else if (r.status === 409 || r.needsHandle) {
                state.handle = null;
                state.needsHandle = true;
                state.authStale = false;
            } else if (r.status === 401) {
                state.handle = null;
                state.needsHandle = false;
                state.authStale = true;
            } else {
                // The server is up but would not say who this is, so every write
                // below it would be refused. The local store is the honest place
                // for a post until it will.
                state.remote = false;
                state.handle = null;
                state.needsHandle = false;
                show($('cmForm'), true);
                syncNote();
                await load();
                return;
            }
        }

        await loadSpaces();
        paintSpaces();
        fillSpaceSelect();
        syncNote();
        showClaim(state.needsHandle);
        showStale(state.authStale);
        if (state.handle) show($('cmForm'), true);
        show($('cmSpaceNew'), !!state.handle);
        await load();

        var pid = postParam();
        if (pid) await focusPost(pid);
    }

    async function render() {
        if (!$('cmFeed') || !window.ffStore) return;
        if (typeof ffRenderHeader === 'function') ffRenderHeader();

        var me = await session();
        state.viewer = me.authenticated && me.sub ? String(me.sub) : null;
        state.viewerName = me.name || (state.viewer ? shortId(state.viewer) : '');

        if (state.viewer) {
            try {
                await window.ffStore.upsertUser({ id: state.viewer, name: me.name, picture: me.picture });
            } catch (e) { }
        }

        // With a server configured the composer waits for goRemote(): the server
        // is what knows whether this account has a handle yet, and a box shown
        // before that answer is a box the handle step takes away mid sentence.
        var pending = !!(window.ffSocial && window.ffSocial.base());
        state.authStale = false;
        show($('cmForm'), !!state.viewer && !pending);
        show($('cmGuest'), !state.viewer);
        show($('cmStale'), false);

        paintSpaces();
        fillSpaceSelect();
        countChars();
        wire();
        await load();

        var ref = draftParam();
        if (ref && state.viewer) await prefillDraft(ref);

        bind();
        reveal();
        await syncUp();
    }

    window.ffViews = window.ffViews || {};
    window.ffViews['community.html'] = {
        mount: function () { return render(); },
        unmount: function () {
            unbind();
            state.posts = [];
            state.heights = [];
            state.offsets = [];
            state.rendered = [0, -1];
            state.single = false;
            state.focus = null;
            state.hasMore = false;
            state.waking = false;
            state.authStale = false;
            composer = null;
            if (window.ffHomeView && typeof window.ffHomeView.teardown === 'function') {
                window.ffHomeView.teardown();
            }
        },
    };

    window.ffCommunityFeed = {
        render: render,
        reload: load,
        rows: function () { return state.posts.length; },
        nodes: function () { var f = $('cmFeed'); return f ? f.children.length : 0; },
        height: function () { return state.total; },
        remote: function () { return state.remote; },
    };
})();
