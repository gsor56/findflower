(function () {
    'use strict';

    var HEALTH_TTL_MS = 30000;
    var TIMEOUT_MS = 8000;

    var health = { at: 0, ok: false, inflight: null };
    var myId = null;
    var myHandle = null;

    function trimSlash(u) {
        return String(u).replace(/\/+$/, '');
    }

    function baseUrl() {
        if (typeof window.FF_SOCIAL_API === 'string' && window.FF_SOCIAL_API) {
            return trimSlash(window.FF_SOCIAL_API);
        }
        var h = location.hostname;
        if (h === '127.0.0.1' || h === 'localhost') return 'http://127.0.0.1:4000';
        return null;
    }

    async function token() {
        var aud = typeof window.FF_SOCIAL_AUDIENCE === 'string' ? window.FF_SOCIAL_AUDIENCE : '';
        try {
            if (aud && typeof ffGetToken === 'function') return await ffGetToken(aud);
            if (typeof ffIdToken === 'function') return await ffIdToken();
        } catch (e) {
            return null;
        }
        return null;
    }

    async function request(path, opts) {
        var o = opts || {};
        var base = baseUrl();
        if (!base) return { ok: false, status: 0, data: null, error: 'No backend configured for this origin.' };

        var head = { Accept: 'application/json' };
        if (o.body !== undefined) head['Content-Type'] = 'application/json';
        if (o.auth) {
            var t = await token();
            if (!t) return { ok: false, status: 401, data: null, error: 'Sign in first.' };
            head.Authorization = 'Bearer ' + t;
        }

        var ctrl = new AbortController();
        var timer = setTimeout(function () { ctrl.abort(); }, o.timeout || TIMEOUT_MS);
        var res;
        try {
            res = await fetch(base + path, {
                method: o.method || 'GET',
                headers: head,
                body: o.body === undefined ? undefined : JSON.stringify(o.body),
                signal: ctrl.signal,
                mode: 'cors'
            });
        } catch (e) {
            clearTimeout(timer);
            health.ok = false;
            health.at = Date.now();
            return { ok: false, status: 0, data: null, error: 'The server did not answer.' };
        }
        clearTimeout(timer);

        var data = null;
        try { data = await res.json(); } catch (e) { data = null; }
        if (res.ok) return { ok: true, status: res.status, data: data, error: null };
        return {
            ok: false,
            status: res.status,
            data: data,
            error: (data && data.error) || ('Request failed (' + res.status + ').'),
            needsHandle: !!(data && data.needsHandle)
        };
    }

    async function probe(force, timeout) {
        if (!baseUrl()) { health.ok = false; return false; }
        if (!force && health.at && Date.now() - health.at < HEALTH_TTL_MS) return health.ok;
        if (health.inflight) return health.inflight;
        health.inflight = (async function () {
            var r = await request('/health', { timeout: timeout || 4000 });
            health.ok = !!(r.ok && r.data && r.data.status === 'ok');
            health.at = Date.now();
            health.inflight = null;
            return health.ok;
        })();
        return health.inflight;
    }

    function ready() {
        return !!baseUrl() && health.ok;
    }

    function postRow(p) {
        var a = p.author || null;
        return {
            id: p.id,
            userId: a ? a.handle : null,
            authorName: a ? (a.displayName || a.handle) : 'Someone',
            handle: a ? a.handle : null,
            avatar: a ? a.avatar : null,
            space: p.space,
            title: p.title || null,
            body: p.content,
            articleRef: p.articleRef || null,
            timestamp: p.createdAt,
            likeCount: p.likeCount || 0,
            likedByViewer: !!p.likedByViewer,
            mine: !!(a && myId && a.id === myId),
            remote: true
        };
    }

    function posts(query) {
        var q = new URLSearchParams();
        var o = query || {};
        if (o.space) q.set('space', o.space);
        if (o.author) q.set('author', o.author);
        if (o.page) q.set('page', String(o.page));
        if (o.limit) q.set('limit', String(o.limit));
        if (o.before) q.set('before', o.before);
        var qs = q.toString();
        return request('/api/posts' + (qs ? '?' + qs : ''), { auth: !!o.auth }).then(function (r) {
            if (r.ok && r.data) r.data.rows = (r.data.posts || []).map(postRow);
            return r;
        });
    }

    function post(id, auth) {
        return request('/api/posts/' + encodeURIComponent(id), { auth: !!auth }).then(function (r) {
            if (r.ok && r.data && r.data.post) r.data.row = postRow(r.data.post);
            return r;
        });
    }

    function createPost(fields) {
        return request('/api/posts', { method: 'POST', auth: true, body: fields }).then(function (r) {
            if (r.ok && r.data && r.data.post) r.data.row = postRow(r.data.post);
            return r;
        });
    }

    function deletePost(id) {
        return request('/api/posts/' + encodeURIComponent(id), { method: 'DELETE', auth: true });
    }

    function likePost(id) {
        return request('/api/posts/' + encodeURIComponent(id) + '/like', { method: 'POST', auth: true });
    }

    function reportPost(id, reason) {
        return request('/api/posts/' + encodeURIComponent(id) + '/report', {
            method: 'POST', auth: true, body: { reason: reason }
        });
    }

    function spaces() {
        return request('/api/spaces');
    }

    function createSpace(name, description) {
        return request('/api/spaces', {
            method: 'POST', auth: true, body: { name: name, description: description || '' }
        });
    }

    function me() {
        return request('/api/users/me', { auth: true }).then(function (r) {
            if (r.ok && r.data && r.data.user) {
                myId = r.data.user.id;
                myHandle = r.data.user.handle;
            } else if (r.status === 409 || r.status === 401) {
                myId = null;
                myHandle = null;
            }
            return r;
        });
    }

    function saveProfile(fields) {
        return request('/api/users', { method: 'POST', auth: true, body: fields }).then(function (r) {
            if (r.ok && r.data && r.data.user) {
                myId = r.data.user.id;
                myHandle = r.data.user.handle;
            }
            return r;
        });
    }

    function profile(handle, auth) {
        return request('/api/users/' + encodeURIComponent(String(handle).toLowerCase()), { auth: !!auth });
    }

    function friends() {
        return request('/api/friends', { auth: true });
    }

    function requestFriend(handle) {
        return request('/api/friends/request', { method: 'POST', auth: true, body: { handle: handle } });
    }

    function respondFriend(handle, action) {
        return request('/api/friends/respond', {
            method: 'POST', auth: true, body: { handle: handle, action: action }
        });
    }

    function messages(handle, query) {
        var q = new URLSearchParams();
        var o = query || {};
        if (o.page) q.set('page', String(o.page));
        if (o.limit) q.set('limit', String(o.limit));
        var qs = q.toString();
        return request('/api/messages/' + encodeURIComponent(handle) + (qs ? '?' + qs : ''), { auth: true });
    }

    function sendMessage(handle, content) {
        return request('/api/messages/' + encodeURIComponent(handle), {
            method: 'POST', auth: true, body: { content: content }
        });
    }

    function search(q) {
        return request('/api/search?q=' + encodeURIComponent(q), { timeout: 5000 });
    }

    function handleError(h) {
        var s = String(h || '').trim().toLowerCase();
        if (s.length < 3) return 'A handle needs at least three characters.';
        if (s.length > 20) return 'A handle can be at most twenty characters.';
        if (!/^[a-z0-9_]+$/.test(s)) return 'Letters, numbers and underscores only.';
        return null;
    }

    window.ffSocial = {
        base: baseUrl,
        probe: probe,
        ready: ready,
        request: request,
        viewerId: function () { return myId; },
        viewerHandle: function () { return myHandle; },
        handleError: handleError,
        posts: posts,
        post: post,
        createPost: createPost,
        deletePost: deletePost,
        likePost: likePost,
        reportPost: reportPost,
        spaces: spaces,
        createSpace: createSpace,
        me: me,
        saveProfile: saveProfile,
        profile: profile,
        friends: friends,
        requestFriend: requestFriend,
        respondFriend: respondFriend,
        messages: messages,
        sendMessage: sendMessage,
        search: search
    };
})();
