(function () {
    'use strict';

    var RELOAD = { 'try.html': 1, 'login.html': 1 };

    var RELOAD_PATH = /(^|\/)(try|login)(\.html?)?(\/|$)/i;

    function mustReload(pathname) {
        return !!RELOAD[pageKey(pathname)] || RELOAD_PATH.test(String(pathname || ''));
    }

    function hardLoad(href) {
        window.location.assign(href);
    }

    var MAIN = 'main';
    var EXTRA = '[data-ff-page]';
    var current = null;

    window.ffViews = window.ffViews || {};

    function pageKey(pathname) {
        var path = String(pathname || '').replace(/\/+$/, '');
        var file = path.substring(path.lastIndexOf('/') + 1).toLowerCase();
        if (!file) return 'index.html';
        if (file.indexOf('.') === -1) return file + '.html';
        return file;
    }

    function internalUrl(href, base) {
        if (!href) return null;
        var u;
        try { u = new URL(href, base || location.href); } catch (e) { return null; }
        if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
        if (u.origin !== location.origin) return null;
        return u;
    }

    var adoptedStyle = {};

    function adoptStyles(key, doc) {
        if (adoptedStyle[key]) return;
        var blocks = doc.head ? doc.head.querySelectorAll('style') : [];
        if (!blocks.length) { adoptedStyle[key] = 1; return; }
        for (var i = 0; i < blocks.length; i++) {
            var s = document.createElement('style');
            s.setAttribute('data-ff-page-style', key);
            s.textContent = blocks[i].textContent;
            document.head.appendChild(s);
        }
        adoptedStyle[key] = 1;
    }

    var loadedSrc = {};

    (function seedLoaded() {
        var tags = document.querySelectorAll('script[src]');
        for (var i = 0; i < tags.length; i++) {
            var u = internalUrl(tags[i].getAttribute('src'));
            if (u) loadedSrc[u.pathname] = 1;
        }
    })();

    function loadScript(src) {
        return new Promise(function (resolve) {
            var s = document.createElement('script');
            s.src = src;
            s.onload = s.onerror = function () { resolve(); };
            document.head.appendChild(s);
        });
    }

    function runInline(code) {
        var s = document.createElement('script');
        s.textContent = '(function(){\n' + code + '\n})();';
        try {
            document.head.appendChild(s);
        } catch (e) {
            console.error('router: inline script failed', e);
        }
        if (s.parentNode) s.parentNode.removeChild(s);
    }

    function withDomReadyCaptured(fn) {
        var captured = [];
        var real = document.addEventListener;
        document.addEventListener = function (type) {
            if (type === 'DOMContentLoaded' && typeof arguments[1] === 'function') {
                captured.push(arguments[1]);
                return;
            }
            return real.apply(document, arguments);
        };
        try {
            fn();
        } finally {
            document.addEventListener = real;
        }
        return captured;
    }

    async function runScripts(doc) {
        var tags = doc.querySelectorAll('script');
        var pending = [];

        for (var i = 0; i < tags.length; i++) {
            var tag = tags[i];
            var src = tag.getAttribute('src');

            if (src) {
                if (/cdn\.tailwindcss\.com/.test(src)) continue;
                var u = internalUrl(src);
                var key = u ? u.pathname : src;
                if (loadedSrc[key]) continue;
                loadedSrc[key] = 1;
                await loadScript(src);
                continue;
            }

            var code = tag.textContent;
            if (!code || !code.trim()) continue;
            if (/^\s*tailwind\.config\s*=/.test(code)) continue;
            if (tag.hasAttribute('data-ff-once')) continue;
            pending.push(code);
        }

        var callbacks = withDomReadyCaptured(function () {
            for (var j = 0; j < pending.length; j++) runInline(pending[j]);
        });
        for (var k = 0; k < callbacks.length; k++) {
            try { callbacks[k](new Event('DOMContentLoaded')); }
            catch (e) { console.error('router: page init failed', e); }
        }
    }

    function unmountCurrent() {
        if (!current) return;
        var v = current.view;
        current = null;
        if (v && typeof v.unmount === 'function') {
            try { v.unmount(); } catch (e) { console.error('router: unmount failed', e); }
        }
    }

    async function mountFor(key, initial) {
        var v = window.ffViews[key];
        current = { key: key, view: v || null };
        if (v && typeof v.mount === 'function') {
            try { await v.mount({ initial: !!initial }); }
            catch (e) { console.error('router: mount failed', e); }
        }
    }

    async function mountInitial() {
        await mountFor(pageKey(location.pathname), true);
    }

    var navSeq = 0;
    var inFlight = false;

    async function navigate(url, push) {
        var key = pageKey(url.pathname);
        var seq = ++navSeq;

        var host = document.querySelector(MAIN);
        if (!host) { hardLoad(url.href); return; }

        inFlight = true;
        document.documentElement.classList.add('ff-routing');
        try {
            var res = await fetch(url.href, {
                credentials: 'same-origin',
                cache: 'no-store',
                headers: { 'Accept': 'text/html' },
            });
            if (!res.ok) throw new Error('HTTP ' + res.status);
            var html = await res.text();
            if (seq !== navSeq) return;

            var doc = new DOMParser().parseFromString(html, 'text/html');
            var next = doc.querySelector(MAIN);
            if (!next) throw new Error('no <main> in ' + url.pathname);

            unmountCurrent();

            if (push) history.pushState({ ff: 1 }, '', url.href);
            document.title = doc.title || document.title;

            adoptStyles(key, doc);

            var stale = document.querySelectorAll(EXTRA);
            for (var s = 0; s < stale.length; s++) stale[s].remove();

            host.replaceWith(next);

            var extras = doc.querySelectorAll(EXTRA);
            for (var x = 0; x < extras.length; x++) {
                next.parentNode.insertBefore(document.importNode(extras[x], true), next);
            }

            var anchor = url.hash ? document.getElementById(url.hash.slice(1)) : null;
            if (anchor) anchor.scrollIntoView();
            else window.scrollTo(0, 0);

            await runScripts(doc);
            if (seq !== navSeq) return;

            if (typeof window.ffNavSetActive === 'function') {
                try { window.ffNavSetActive(key); } catch (e) { }
            }
            if (typeof window.ffFooterSetActive === 'function') {
                try { window.ffFooterSetActive(key); } catch (e) { }
            }
            await mountFor(key);
        } catch (e) {
            console.error('router: falling back to full load —', e.message);
            hardLoad(url.href);
        } finally {
            if (seq === navSeq) {
                inFlight = false;
                document.documentElement.classList.remove('ff-routing');
            }
        }
    }

    function go(href) {
        var u = internalUrl(href);
        if (!u || mustReload(u.pathname)) { hardLoad(href); return; }
        navigate(u, true);
    }

    function onClick(e) {
        if (e.defaultPrevented || e.button !== 0 ||
            e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;

        var a = e.target && typeof e.target.closest === 'function'
            ? e.target.closest('a') : null;
        if (!a) return;
        if (a.hasAttribute('download') || a.getAttribute('target') === '_blank') return;
        if (a.hasAttribute('data-no-router')) return;

        var u = internalUrl(a.getAttribute('href'));
        if (!u) return;

        if (u.hash && u.search === location.search &&
            pageKey(u.pathname) === pageKey(location.pathname)) return;

        var key = pageKey(u.pathname);
        if (mustReload(u.pathname)) return;
        if (!window.ffViews && !document.querySelector(MAIN)) return;

        e.preventDefault();
        if (u.href === location.href) return;
        navigate(u, true);
    }

    function onPopState() {
        var u = internalUrl(location.href);
        if (!u) return;
        if (mustReload(u.pathname)) { location.reload(); return; }
        navigate(u, false);
    }

    function boot() {
        if (!window.fetch || !window.history || !history.pushState ||
            !window.DOMParser || !document.querySelector(MAIN)) {
            mountInitial();
            return;
        }
        document.addEventListener('click', onClick);
        window.addEventListener('popstate', onPopState);
        mountInitial();
    }

    window.ffRouter = {
        go: go,
        navigate: function (href) { go(href); },
        pageKey: pageKey,
        mustReload: mustReload,
        register: function (key, view) { window.ffViews[key] = view; },
        get busy() { return inFlight; },
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot);
    } else {
        boot();
    }
})();

