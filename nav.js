(function () {
    'use strict';

    function currentPage() { return routeKey(location.pathname); }

    var PAGE = currentPage();

    var LOGO =
        '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" class="text-sage-600">' +
        '<path d="M12 21c0-4 0-7 0-9m0 0c0-3 2.5-5 6-5-.2 3.2-2.8 5-6 5Zm0 0c0-3-2.5-5-6-5 .2 3.2 2.8 5 6 5Z" ' +
        'stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';

    var LINKS = [
        { label: 'How it works', href: '/how',      key: 'page.how' },
        { label: 'Pricing',      href: '/pricing',  key: 'page.pricing' },
        { label: 'API',          href: '/api',      key: 'page.api' },
        { label: 'About',        href: '/#about',   key: 'page.about' }
    ];

    var SVG_OPEN = '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" ' +
        'stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">';
    var ICON_CLOSE = SVG_OPEN + '<path d="M6 6l12 12"/><path d="M18 6 6 18"/></svg>';

    var ICON_BURGER = '<span class="ff-burger" aria-hidden="true">' +
        '<span></span><span></span><span></span></span>';
    var ICON_DASH  = SVG_OPEN +
        '<rect x="3" y="3" width="7" height="7" rx="1.5"/>' +
        '<rect x="14" y="3" width="7" height="7" rx="1.5"/>' +
        '<rect x="3" y="14" width="7" height="7" rx="1.5"/>' +
        '<rect x="14" y="14" width="7" height="7" rx="1.5"/></svg>';
    var ICON_DIR   = SVG_OPEN +
        '<path d="M12 21c0-4 0-7 0-9m0 0c0-3 2.5-5 6-5-.2 3.2-2.8 5-6 5Zm0 0c0-3-2.5-5-6-5 .2 3.2 2.8 5 6 5Z"/></svg>';
    var ICON_HOME  = SVG_OPEN +
        '<path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V21h14V9.5"/></svg>';
    var ICON_HOW   = SVG_OPEN +
        '<circle cx="12" cy="12" r="9"/><path d="M9.5 9a2.7 2.7 0 0 1 5.1 1.2c0 2-2.6 2.3-2.6 4"/><path d="M12 18h.01"/></svg>';
    var ICON_PRICE = SVG_OPEN +
        '<path d="M20 12V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h7"/><path d="M8 8h8M8 12h5M18 16v5M15.5 18.5h5"/></svg>';
    var ICON_API   = SVG_OPEN +
        '<path d="m8 9-4 3 4 3M16 9l4 3-4 3M14 5l-4 14"/></svg>';
    var ICON_ABOUT = SVG_OPEN +
        '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/></svg>';
    var ICON_BLOGS = SVG_OPEN +
        '<path d="M5 4.5A1.5 1.5 0 0 1 6.5 3H18a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H6.5A1.5 1.5 0 0 1 5 19.5Z"/>' +
        '<path d="M8.5 8h7M8.5 12h7M8.5 16h4"/></svg>';
    var ICON_RESEARCH = SVG_OPEN +
        '<path d="M9 3h6M10 3v6.2L5.6 17.4A2 2 0 0 0 7.4 20.5h9.2a2 2 0 0 0 1.8-3.1L14 9.2V3"/>' +
        '<path d="M7.5 15h9"/></svg>';
    var ICON_DATA  = SVG_OPEN +
        '<ellipse cx="12" cy="6" rx="7.5" ry="3"/>' +
        '<path d="M4.5 6v12c0 1.7 3.4 3 7.5 3s7.5-1.3 7.5-3V6M4.5 12c0 1.7 3.4 3 7.5 3s7.5-1.3 7.5-3"/></svg>';
    var ICON_COMMUNITY = SVG_OPEN +
        '<circle cx="9.5" cy="8" r="3.2"/><path d="M3.5 20v-1.4A4.1 4.1 0 0 1 7.6 14.5h3.8a4.1 4.1 0 0 1 4.1 4.1V20"/>' +
        '<path d="M16.2 5.2a3.2 3.2 0 0 1 0 5.6M17.4 14.7A4.1 4.1 0 0 1 20.5 18.6V20"/></svg>';

    var ICON_CONTRIBUTE = SVG_OPEN +
        '<path d="M12 16V4"/><path d="m7.5 8.5 4.5-4.5 4.5 4.5"/>' +
        '<path d="M4 15v3.5A1.5 1.5 0 0 0 5.5 20h13a1.5 1.5 0 0 0 1.5-1.5V15"/></svg>';

    var ICON_PROFILE = SVG_OPEN +
        '<circle cx="12" cy="8" r="3.4"/>' +
        '<path d="M5 20v-1.5A4.5 4.5 0 0 1 9.5 14h5a4.5 4.5 0 0 1 4.5 4.5V20"/></svg>';
    // One camera for both the tab bar and the drawer row.
    var SCAN_PATH =
        '<path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/>' +
        '<circle cx="12" cy="13" r="4"/>';
    var ICON_SCANNER = SVG_OPEN + SCAN_PATH + '</svg>';

    var ICON_GLOBE = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" ' +
        'stroke="currentColor" stroke-width="1.8" stroke-linecap="round" ' +
        'stroke-linejoin="round" aria-hidden="true">' +
        '<circle cx="12" cy="12" r="9"/><path d="M3.2 9h17.6M3.2 15h17.6"/>' +
        '<path d="M12 3c4.6 6 4.6 12 0 18C7.4 15 7.4 9 12 3Z"/></svg>';
    var ICON_CARET = '<svg class="ff-lang__caret" width="12" height="12" viewBox="0 0 24 24" ' +
        'fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" ' +
        'stroke-linejoin="round" aria-hidden="true"><path d="m6 9.5 6 6 6-6"/></svg>';

    var LANG_KEY = 'ff_lang';
    var LANGS = [
        { code: 'en', label: 'English' },
        { code: 'es', label: 'Espa\u00f1ol' },
        { code: 'fr', label: 'Fran\u00e7ais' },
        { code: 'de', label: 'Deutsch' },
        { code: 'ja', label: '\u65e5\u672c\u8a9e' }
    ];

    function escapeHTML(value) {
        return String(value == null ? '' : value).replace(/[&<>'"]/g, function (ch) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[ch];
        });
    }

    function safeImageURL(value) {
        var url = String(value || '');
        return /^(https:\/\/|data:image\/)/i.test(url) ? escapeHTML(url) : '';
    }

    function routeKey(href) {
        var s = String(href || '').split('#')[0].split('?')[0];
        if (!s) return '';
        s = s.replace(/\/+$/, '');
        var file = s.substring(s.lastIndexOf('/') + 1).toLowerCase();
        if (!file) return 'index.html';
        if (file.indexOf('.') === -1) return file + '.html';
        return file;
    }

    function linkIsActive(href) {
        var key = routeKey(href);
        if (!key || key !== PAGE) return false;
        var frag = String(href || '').split('#')[1];
        if (frag) return location.hash.toLowerCase() === ('#' + frag).toLowerCase();
        return !location.hash;
    }

    function navLinksHTML() {
        return LINKS.map(function (l) {
            var active = linkIsActive(l.href);
            var cls = active
                ? 'text-neutral-900'
                : 'text-neutral-500 hover:text-neutral-900 transition-colors';
            return '<a href="' + l.href + '" class="' + cls + '"' +
                ' data-i18n="' + l.key + '"' +
                (active ? ' aria-current="page"' : '') + '>' + l.label + '</a>';
        }).join('');
    }

    function buildHeader() {
        var header = document.createElement('header');
        header.className = 'ff-header fixed top-0 left-0 right-0 z-50';
        header.innerHTML =
            '<div class="max-w-7xl mx-auto px-4 sm:px-8 h-16 flex items-center justify-between gap-2">' +
                '<div class="flex items-center gap-2 min-w-0">' +
                    '<a href="/" class="flex items-center gap-2 text-lg font-medium tracking-tight text-neutral-900 min-w-0">' +
                        LOGO + '<span class="truncate">FindFlower</span>' +
                    '</a>' +
                    '<span class="hidden min-[360px]:inline-block shrink-0 text-xs font-medium ' +
                        'text-sage-700 bg-sage-100 px-2 py-0.5 rounded-full">Beta</span>' +
                '</div>' +
                '<nav class="hidden md:flex items-center gap-8 text-sm font-medium">' +
                    navLinksHTML() +
                '</nav>' +
                '<div class="flex items-center gap-2 sm:gap-3 shrink-0">' +
                    '<a id="signInLink" href="/login" data-i18n="nav.signin" class="text-sm font-medium text-neutral-900 ' +
                        'hover:text-neutral-600 transition-colors hidden md:block">Sign In</a>' +
                    '<button id="ffMenuBtn" type="button" data-toggle-sidebar aria-label="Open menu" ' +
                        'data-i18n-aria="nav.menu.open" ' +
                        'aria-controls="ffSidebar" aria-expanded="false" ' +
                        'class="ff-hamburger soft-click flex items-center justify-center text-neutral-700 ' +
                        'hover:text-neutral-900 transition" style="min-width:40px;min-height:40px">' +
                        ICON_BURGER + '</button>' +
                '</div>' +
            '</div>';
        return header;
    }

    function wireHeaderScroll(header) {
        var THRESHOLD = 12;
        var wasSolid = null;
        var queued = false;

        function paint() {
            queued = false;
            var y = window.pageYOffset || document.documentElement.scrollTop || 0;
            var solid = y > THRESHOLD;
            if (solid === wasSolid) return;
            wasSolid = solid;
            header.classList.toggle('ff-header--solid', solid);
        }

        function onScroll() {
            if (queued) return;
            queued = true;
            if (window.requestAnimationFrame) window.requestAnimationFrame(paint);
            else paint();
        }

        window.addEventListener('scroll', onScroll, { passive: true });
        window.addEventListener('resize', onScroll, { passive: true });
        paint();
    }

    var NOTICE_KEY = 'hide_maintenance_banner';

    function noticeDismissed() {
        try { return localStorage.getItem(NOTICE_KEY) === '1'; } catch (e) { return false; }
    }

    // The homepage hero is sized against the header, so it has to know how tall
    // the strip made it. Nothing else reads this, and it goes back to 0px the
    // moment the strip is dismissed or the router carries it away.
    function measureNotice() {
        var el = document.getElementById('ffNotice');
        var tall = el && el.parentNode ? Math.round(el.getBoundingClientRect().height) : 0;
        document.documentElement.style.setProperty('--ff-banner-h', tall + 'px');
    }

    // index.html writes the strip and the router carries it in and out with the
    // rest of the page. Moving it inside the fixed header is what pushes the bar
    // down instead of letting the strip sit over it.
    var noticeWatch = null;

    function watchNotice(el) {
        if (!window.ResizeObserver) return;
        if (!noticeWatch) noticeWatch = new ResizeObserver(measureNotice);
        noticeWatch.disconnect();
        noticeWatch.observe(el);
    }

    function adoptNotice() {
        var notice = document.getElementById('ffNotice');
        if (notice && noticeDismissed()) {
            notice.remove();
            notice = null;
        }
        var header = document.querySelector('header');
        if (notice && header && notice.parentNode !== header) {
            header.insertBefore(notice, header.firstChild);
            watchNotice(notice);
            var close = notice.querySelector('#ffNoticeClose');
            if (close) close.addEventListener('click', function () {
                try { localStorage.setItem(NOTICE_KEY, '1'); } catch (e) { }
                notice.remove();
                measureNotice();
            });
        }
        measureNotice();
    }

    function drawerLink(label, href, icon, key) {
        var active = linkIsActive(href);
        return '<a href="' + href + '" class="ff-drawer-link' + (active ? ' is-active' : '') + '"' +
            (active ? ' aria-current="page"' : '') + '>' + icon +
            '<span data-i18n="' + key + '">' + label + '</span></a>';
    }

    function savedLang() {
        var code = null;
        try { code = localStorage.getItem(LANG_KEY); } catch (e) { }
        for (var i = 0; i < LANGS.length; i++) {
            if (LANGS[i].code === code) return LANGS[i];
        }
        return LANGS[0];
    }

    // Chrome paints the open list in the select's own colours, so it stays visible.
    function langPill() {
        var current = savedLang();
        var options = LANGS.map(function (l) {
            return '<option value="' + l.code + '"' +
                (l.code === current.code ? ' selected' : '') + '>' + l.label + '</option>';
        }).join('');
        return '<span class="ff-lang">' + ICON_GLOBE +
            '<select id="ffLang" class="ff-lang__select" aria-label="Language" ' +
                'data-i18n-aria="drawer.language">' +
                options + '</select>' + ICON_CARET + '</span>';
    }

    function translate(root) {
        if (window.ffI18n) window.ffI18n.apply(root || document);
    }

    function phrase(key, fallback) {
        var said = window.ffI18n ? window.ffI18n.t(key) : '';
        return said || fallback;
    }

    function wireLang() {
        var select = document.getElementById('ffLang');
        if (!select) return;
        select.addEventListener('change', function () {
            var picked = savedLang();
            for (var i = 0; i < LANGS.length; i++) {
                if (LANGS[i].code === select.value) picked = LANGS[i];
            }
            if (window.ffI18n) window.ffI18n.set(picked.code);
            else try { localStorage.setItem(LANG_KEY, picked.code); } catch (e) { }
        });
    }

    function buildSidebar() {
        var wrap = document.createElement('div');
        wrap.innerHTML =
            '<div id="ffSidebarBackdrop" class="ff-sidebar-backdrop" aria-hidden="true"></div>' +
            '<aside id="ffSidebar" class="ff-sidebar" aria-label="Site menu" aria-hidden="true" aria-modal="true" role="dialog" tabindex="-1">' +
                '<div class="ff-sidebar__header">' +
                    '<h2 data-i18n="drawer.title">Menu</h2>' +
                    '<button id="ffSidebarClose" type="button" aria-label="Close menu" ' +
                        'data-i18n-aria="nav.menu.close" class="ff-sidebar__close">' + ICON_CLOSE + '</button>' +
                '</div>' +
                '<div class="ff-sidebar__scroll">' +
                    '<div class="ff-drawer-top">' +
                        '<div class="ff-drawer-top__row">' +
                            '<section id="ffDrawerAuth" class="ff-drawer-account" aria-live="polite"></section>' +
                            langPill() +
                        '</div>' +
                    '</div>' +
                    '<nav class="ff-drawer-nav" aria-label="All pages" data-i18n-aria="drawer.pages">' +
                        drawerLink('Home', '/', ICON_HOME, 'page.home') +
                        drawerLink('Scanner', '/try', ICON_SCANNER, 'page.scanner') +
                        drawerLink('Dashboard', '/dashboard', ICON_DASH, 'page.dashboard') +
                        drawerLink('Profile', '/profile', ICON_PROFILE, 'page.profile') +
                        drawerLink('Directory', '/directory', ICON_DIR, 'page.directory') +
                        drawerLink('How it works', '/how', ICON_HOW, 'page.how') +
                        drawerLink('Pricing', '/pricing', ICON_PRICE, 'page.pricing') +
                        drawerLink('API', '/api', ICON_API, 'page.api') +
                        drawerLink('Data', '/data', ICON_DATA, 'page.data') +
                        drawerLink('Research', '/research', ICON_RESEARCH, 'page.research') +
                        drawerLink('Blogs', '/blogs', ICON_BLOGS, 'page.blogs') +
                        drawerLink('Community', '/community', ICON_COMMUNITY, 'page.community') +
                        drawerLink('Contribute', '/contribute', ICON_CONTRIBUTE, 'page.contribute') +
                        drawerLink('About', '/#about', ICON_ABOUT, 'page.about') +
                    '</nav>' +
                '</div>' +
                '<section id="ffInstall" class="ff-drawer-install" hidden>' +
                    '<p class="ff-drawer-account__note" data-i18n="drawer.install.note">Put FindFlower ' +
                        'on your home screen and open it in its own window.</p>' +
                    '<button id="ffInstallBtn" type="button" data-i18n="drawer.install.button" ' +
                        'class="ff-drawer-button ff-drawer-button--quiet">Install app</button>' +
                '</section>' +
            '</aside>';
        return wrap;
    }

    // The browser shows its own install bar once and takes it away for months if
    // it is dismissed, so this holds on to the event behind it. Keeping the event
    // is the only way to reopen that dialog later: prompt() cannot be called from
    // nothing, which is why the drawer row stays hidden until one arrives.
    var installEvent = null;

    function alreadyInstalled() {
        if (navigator.standalone === true) return true;
        return !!(window.matchMedia && window.matchMedia('(display-mode: standalone)').matches);
    }

    function paintInstall() {
        var hide = !installEvent || alreadyInstalled();
        var row = document.getElementById('ffInstall');
        if (row) row.hidden = hide;
        // The homepage carries the same offer above the fold, so it comes and goes
        // on the event the drawer row depends on.
        var hero = document.getElementById('ffInstallHero');
        if (hero) hero.hidden = hide;
    }

    function promptInstall() {
        var evt = installEvent;
        if (!evt) return;
        installEvent = null;
        var btns = [document.getElementById('ffInstallBtn'),
                    document.getElementById('ffInstallHero')];
        function hold(on) {
            for (var i = 0; i < btns.length; i++) if (btns[i]) btns[i].disabled = on;
        }
        hold(true);
        function settle() {
            hold(false);
            paintInstall();
        }
        try { evt.prompt(); } catch (e) { settle(); return; }
        // A dismissed dialog leaves nothing to prompt with, so the row goes away
        // until the browser hands over a fresh event on some later visit.
        if (evt.userChoice && typeof evt.userChoice.then === 'function') {
            evt.userChoice.then(settle, settle);
        } else {
            settle();
        }
    }

    function wireInstall() {
        window.addEventListener('beforeinstallprompt', function (e) {
            e.preventDefault();
            installEvent = e;
            paintInstall();
        });
        window.addEventListener('appinstalled', function () {
            installEvent = null;
            paintInstall();
        });
        if (!navigator.serviceWorker) return;
        // No service worker means no beforeinstallprompt at all, so sw.js is what
        // the row above depends on. Registered after load so it never competes
        // with the page's own requests.
        window.addEventListener('load', function () {
            navigator.serviceWorker.register('/sw.js').catch(function () { });
        });
    }

    var sidebarFocus = null;
    var sidebarOverflow = '';

    function cachedProfile() {
        try { return JSON.parse(localStorage.getItem('ff_session_profile') || 'null'); } catch (e) { return null; }
    }

    function paintCachedHeader() {
        var link = document.getElementById('signInLink');
        if (!link) return;
        var session = cachedProfile();
        if (!session || !session.authenticated) return;
        link.textContent = session.name || 'Account';
        link.href = '/dashboard';
        // The label is a name now, so the language pass must stop rewriting it.
        link.removeAttribute('data-i18n');
    }

    function renderDrawerAuth() {
        var host = document.getElementById('ffDrawerAuth');
        if (!host) return;
        var guest = '<p class="ff-drawer-account__note" data-i18n="drawer.account">Sign in to keep ' +
            'your finds under your own account.</p>' +
            '<div class="ff-drawer-account__actions ff-drawer-account__actions--one">' +
                '<a href="/login" data-i18n="nav.signin" class="ff-drawer-button ff-drawer-button--solid">Sign In</a>' +
            '</div>';
        host.innerHTML = guest;
        translate(host);
        function paintProfile(session) {
            if (!session || !session.authenticated) return;
            var name = escapeHTML(session.name || 'Botanist');
            var email = escapeHTML(session.email || 'Signed in');
            var picture = safeImageURL(session.picture);
            var avatar = picture ? '<img src="' + picture + '" alt="" class="ff-drawer-profile__avatar">' : '<span class="ff-drawer-profile__initial">' + escapeHTML((session.name || 'B')[0].toUpperCase()) + '</span>';
            host.innerHTML = '<a href="/dashboard" class="ff-drawer-profile">' + avatar + '<span><strong>' + name + '</strong><small>' + email + '</small></span><span class="ff-drawer-profile__arrow">&rarr;</span></a>';
            var image = host.querySelector('img');
            if (image) image.addEventListener('error', function () {
                var initial = document.createElement('span');
                initial.className = 'ff-drawer-profile__initial';
                initial.textContent = (session.name || 'B')[0].toUpperCase();
                image.replaceWith(initial);
            }, { once: true });
        }
        if (typeof window.getUserSession !== 'function') {
            paintProfile(cachedProfile());
            return;
        }
        window.getUserSession().then(paintProfile).catch(function () {});
    }

    function setSidebar(on) {
        var sb = document.getElementById('ffSidebar');
        var backdrop = document.getElementById('ffSidebarBackdrop');
        if (!sb) return;
        var wasOpen = sb.classList.contains('active');
        if (on === wasOpen) return;
        sb.classList.toggle('active', on);
        if (backdrop) backdrop.classList.toggle('active', on);
        sb.setAttribute('aria-hidden', on ? 'false' : 'true');
        if (backdrop) backdrop.setAttribute('aria-hidden', on ? 'false' : 'true');
        var btns = document.querySelectorAll('[data-toggle-sidebar], .ff-hamburger');
        for (var i = 0; i < btns.length; i++) {
            btns[i].setAttribute('aria-expanded', on ? 'true' : 'false');
            btns[i].setAttribute('data-i18n-aria', on ? 'nav.menu.close' : 'nav.menu.open');
            btns[i].setAttribute('aria-label', on
                ? phrase('nav.menu.close', 'Close menu')
                : phrase('nav.menu.open', 'Open menu'));
        }
        if (on) {
            sidebarFocus = document.activeElement;
            sidebarOverflow = document.body.style.overflow;
            document.body.style.overflow = 'hidden';
            renderDrawerAuth();
            var close = document.getElementById('ffSidebarClose');
            if (close) close.focus();
        } else {
            document.body.style.overflow = sidebarOverflow;
            var back = sidebarFocus;
            if (!back || back === document.body || typeof back.focus !== 'function') {
                back = document.querySelector('[data-toggle-sidebar], .ff-hamburger');
            }
            if (back && typeof back.focus === 'function') back.focus();
            sidebarFocus = null;
        }
    }

    function wireSidebar() {
        document.addEventListener('click', function (e) {
            var t = e.target;
            if (!t || typeof t.closest !== 'function') return;
            if (t.closest('[data-toggle-sidebar], .ff-hamburger')) { e.preventDefault(); var sb = document.getElementById('ffSidebar'); setSidebar(!(sb && sb.classList.contains('active'))); return; }
            if (t.closest('#ffSidebarClose, #ffSidebarBackdrop')) { e.preventDefault(); setSidebar(false); return; }
            if (t.closest('#ffInstallBtn, #ffInstallHero')) { e.preventDefault(); promptInstall(); return; }
            if (t.closest('#ffSidebar a')) setSidebar(false);
        });
        document.addEventListener('keydown', function (e) {
            var sb = document.getElementById('ffSidebar');
            if (e.key === 'Escape' || e.keyCode === 27) { setSidebar(false); return; }
            if (!sb || !sb.classList.contains('active') || (e.key !== 'Tab' && e.keyCode !== 9)) return;
            var focusable = sb.querySelectorAll('a[href], button:not([disabled])');
            if (!focusable.length) return;
            var first = focusable[0], last = focusable[focusable.length - 1];
            if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
            else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
        });
    }

    var TABS = [
        {
            label: 'Home', href: '/', key: 'tab.home', match: ['index.html', ''],
            icon: '<path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V21h14V9.5"/>'
        },
        {
            label: 'Scan', href: '/try', key: 'tab.scan', match: ['try.html'],
            icon: SCAN_PATH
        },
        {
            label: 'Directory', href: '/directory', key: 'tab.directory', match: ['directory.html'],
            icon: '<path d="M12 21c0-4 0-7 0-9m0 0c0-3 2.5-5 6-5-.2 3.2-2.8 5-6 5Zm0 0c0-3-2.5-5-6-5 .2 3.2 2.8 5 6 5Z"/>'
        },
        {
            label: 'Dashboard', href: '/dashboard', key: 'tab.dashboard', match: ['dashboard.html'],
            icon: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>'
        }
    ];

    function buildTabBar() {
        var nav = document.createElement('nav');
        nav.className = 'ff-tabbar';
        nav.setAttribute('aria-label', phrase('tab.label', 'Primary'));
        nav.setAttribute('data-i18n-aria', 'tab.label');
        nav.innerHTML = TABS.map(function (t) {
            var active = t.match.indexOf(PAGE) !== -1;
            return '<a class="ff-tabbar__item" href="' + t.href + '"' +
                (active ? ' aria-current="page"' : '') + '>' +
                '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" ' +
                'stroke-linecap="round" stroke-linejoin="round">' + t.icon + '</svg>' +
                '<span data-i18n="' + t.key + '">' + t.label + '</span></a>';
        }).join('');
        return nav;
    }

    function mount() {
        var existing = document.querySelector('header');
        var header = buildHeader();
        if (existing && existing.parentNode) {
            existing.parentNode.replaceChild(header, existing);
        } else {
            document.body.insertBefore(header, document.body.firstChild);
        }

        adoptNotice();
        window.addEventListener('resize', measureNotice, { passive: true });

        document.body.appendChild(buildSidebar());
        wireSidebar();
        wireLang();
        renderDrawerAuth();
        paintInstall();

        wireHeaderScroll(header);

        document.body.appendChild(buildTabBar());
        document.body.classList.add('has-tabbar');

        translate(document);

        if (typeof window.ffRenderHeader === 'function') {
            try { window.ffRenderHeader(); } catch (e) { }
        } else {
            paintCachedHeader();
        }
    }

    function setActive(key) {
        PAGE = key || currentPage();

        var links = document.querySelectorAll('header nav a[href], #ffSidebar a[href]');
        for (var i = 0; i < links.length; i++) {
            var a = links[i];
            var on = linkIsActive(a.getAttribute('href'));
            if (on) a.setAttribute('aria-current', 'page');
            else a.removeAttribute('aria-current');
            if (a.classList.contains('ff-drawer-link')) a.classList.toggle('is-active', on);
        }

        var tabs = document.querySelectorAll('.ff-tabbar__item');
        for (var j = 0; j < tabs.length && j < TABS.length; j++) {
            if (TABS[j].match.indexOf(PAGE) !== -1) tabs[j].setAttribute('aria-current', 'page');
            else tabs[j].removeAttribute('aria-current');
        }

        if (typeof window.ffRenderHeader === 'function') {
            try { window.ffRenderHeader(); } catch (e) { }
        } else {
            paintCachedHeader();
        }
        renderDrawerAuth();
        adoptNotice();
        translate(document);
        // A router swap brings in a fresh homepage, install button and all, with the
        // event already spent or still held from before the swap.
        paintInstall();
    }

    window.ffNavSetActive = setActive;
    window.ffNavCurrent = function () { return PAGE; };

    wireInstall();

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', mount);
    } else {
        mount();
    }
})();
