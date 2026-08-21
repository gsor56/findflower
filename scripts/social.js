/* FindFlower social API client.

   One place that knows how to talk to server/ (Express + MongoDB Atlas), so no
   view has to remember the base URL, the token flavour or which status code
   means "you have no handle yet".

   Where it talks to, in order:
     window.FF_SOCIAL_API   set it to point a page at a deployed backend
     http://127.0.0.1:4000  when the page itself is on localhost
     nothing                any other origin

   That last case is deliberate. There is no backend published for findflower.me
   yet, and inventing a hostname here would make every social control on the site
   fail silently. ready() answers false instead, and the views fall back to the
   local IndexedDB feed they have always had.

   Photos are not this file's business. Scan thumbnails and avatars live in the
   browser (storage.js); what crosses the wire is text and ids. */
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

    /* The ID token by default: the server accepts the SPA client id as the
       audience because no Auth0 API is registered yet. Set FF_SOCIAL_AUDIENCE
       once one is, and this asks for an access token for it instead. */
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

    /* Never throws and never returns undefined: { ok, status, data, error }.
       A view can render an error message from this without a try/catch in its
       own paint path. status 0 means the request never reached the server. */
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

        // AbortSignal.timeout is not in every browser this site still supports.
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

    /* Is there a server, and is it answering? Cached for 30s, and one probe is
       shared by however many views ask at once during a page load. */
    async function probe(force) {
        if (!baseUrl()) { health.ok = false; return false; }
        if (!force && health.at && Date.now() - health.at < HEALTH_TTL_MS) return health.ok;
        if (health.inflight) return health.inflight;
        health.inflight = (async function () {
            var r = await request('/health', { timeout: 4000 });
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

    /* A server post, in the row shape scripts/views/community.js already
       renders, plus the fields only a server can know. userId carries the handle
       so the existing profile link keeps working. */
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

    /* One post by id, for a link that names a thread the current page of the
       feed may not contain. auth only changes likedByViewer and mine, so a
       signed-out reader following a shared link still gets the post. */
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

    /* The caller's own row, or a 409 that means "signed in, no handle yet".
       The id is kept so a feed can tell which posts are the viewer's. */
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

    /* A public card is readable signed out, so the token is optional here: with
       one the answer also carries isOwner, which is what tells the profile page
       it is looking at its own row. */
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

    /* The handle rules from server/models/user.js, checked here so the composer
       can say what is wrong before spending a request on it. */
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
