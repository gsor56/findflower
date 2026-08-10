/* ============================================================================
   FindFlower — unified navigation (nav.js)
   ----------------------------------------------------------------------------
   One source of truth for site navigation, loaded on every page. Two problems
   it solves:

     1. The header text and link set drifted from page to page (marketing pages
        listed "How it works / Pricing / About", app pages listed "Scanner /
        Directory / API"). This script REPLACES whatever <header> a page shipped
        with a single canonical sticky header, so the top bar is identical
        everywhere and can only ever change in one file.

     2. On phones the site felt like a website, not an app. This injects a fixed
        bottom tab bar (Home · Scan · Dashboard) that appears only on small
        viewports (styling in app.css), giving a native iOS/Android feel.

   The page's original <header> is kept in the HTML as a no-JS fallback; this
   just swaps it for the canonical one once the DOM is parsed. When auth.js is
   present (dashboard/login) we hand the rebuilt sign-in link back to
   ffRenderHeader() so the live session state still drives it.

   SPA note. scripts/router.js swaps <main> without reloading, so the active-tab
   highlight can no longer be a one-time read of location.pathname at load. PAGE
   is therefore mutable and the router calls window.ffNavSetActive(key) after
   each swap to repaint it. The chrome itself (header, sidebar, tab bar) lives
   outside <main> and is never replaced, so it is built exactly once.
   ========================================================================== */
(function () {
    'use strict';

    // Which nav entry is "current" — resolved from the file being viewed.
    // Pretty URLs ("/", "/dashboard") and ".html" URLs both map cleanly.
    function currentPage() {
        var path = location.pathname.replace(/\/+$/, '');
        var file = path.substring(path.lastIndexOf('/') + 1).toLowerCase();
        if (!file) return 'index.html';
        if (file.indexOf('.') === -1) return file + '.html';
        return file;
    }

    // Mutable: the router repaints this on every client-side navigation.
    var PAGE = currentPage();

    // Brand mark (the favicon flower) reused in the header.
    var LOGO =
        '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" class="text-sage-600">' +
        '<path d="M12 21c0-4 0-7 0-9m0 0c0-3 2.5-5 6-5-.2 3.2-2.8 5-6 5Zm0 0c0-3-2.5-5-6-5 .2 3.2 2.8 5 6 5Z" ' +
        'stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';

    // Fixed desktop nav — the primary marketing/product links. Dashboard and
    // Directory intentionally do NOT live in the top bar; they sit in the
    // slide-out sidebar (see buildSidebar) opened by the hamburger button.
    var LINKS = [
        { label: 'How it works', href: 'how.html' },
        { label: 'Pricing',      href: 'pricing.html' },
        { label: 'API',          href: 'api.html' },
        { label: 'About',        href: 'index.html#about' }
    ];

    // Every icon is a 24x24 SVG with EXPLICIT width/height so it can never
    // render unconstrained (e.g. if a stylesheet is slow to apply).
    var SVG_OPEN = '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" ' +
        'stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">';
    var ICON_MENU  = SVG_OPEN + '<path d="M4 6h16"/><path d="M4 12h16"/><path d="M4 18h16"/></svg>';
    var ICON_CLOSE = SVG_OPEN + '<path d="M6 6l12 12"/><path d="M18 6 6 18"/></svg>';
    var ICON_DASH  = SVG_OPEN +
        '<rect x="3" y="3" width="7" height="7" rx="1.5"/>' +
        '<rect x="14" y="3" width="7" height="7" rx="1.5"/>' +
        '<rect x="3" y="14" width="7" height="7" rx="1.5"/>' +
        '<rect x="14" y="14" width="7" height="7" rx="1.5"/></svg>';
    var ICON_DIR   = SVG_OPEN +
        '<path d="M12 21c0-4 0-7 0-9m0 0c0-3 2.5-5 6-5-.2 3.2-2.8 5-6 5Zm0 0c0-3-2.5-5-6-5 .2 3.2 2.8 5 6 5Z"/></svg>';

    function navLinksHTML() {
        return LINKS.map(function (l) {
            var active = (l.href === PAGE);
            var cls = active
                ? 'text-neutral-900'
                : 'text-neutral-500 hover:text-neutral-900 transition-colors';
            return '<a href="' + l.href + '" class="' + cls + '"' +
                (active ? ' aria-current="page"' : '') + '>' + l.label + '</a>';
        }).join('');
    }

    function buildHeader() {
        var header = document.createElement('header');
        header.className =
            'fixed top-0 left-0 right-0 z-50 bg-[#FCFCFC]/80 backdrop-blur-md ' +
            'border-b border-neutral-200/60';
        header.innerHTML =
            '<div class="max-w-7xl mx-auto px-5 sm:px-8 h-16 flex items-center justify-between">' +
                // LEFT — logo + wordmark + Beta pill
                '<div class="flex items-center gap-2">' +
                    '<a href="index.html" class="flex items-center gap-2 text-lg font-medium tracking-tight text-neutral-900">' +
                        LOGO + 'FindFlower' +
                    '</a>' +
                    '<span class="text-xs font-medium text-sage-700 bg-sage-100 px-2 py-0.5 rounded-full">Beta</span>' +
                '</div>' +
                // CENTER — primary links
                '<nav class="hidden md:flex items-center gap-8 text-sm font-medium">' +
                    navLinksHTML() +
                '</nav>' +
                // RIGHT — Sign In, Try Now, and the sidebar hamburger
                '<div class="flex items-center gap-3">' +
                    '<a id="signInLink" href="login.html" class="text-sm font-medium text-neutral-900 ' +
                        'hover:text-neutral-600 transition-colors hidden md:block">Sign In</a>' +
                    '<a id="ffTryNow" href="try.html" class="text-sm font-medium bg-neutral-900 text-white ' +
                        'px-5 rounded-full hover:bg-neutral-800 transition-colors flex items-center gap-1.5" ' +
                        'style="min-height:40px">Try Now<span aria-hidden="true">&rarr;</span></a>' +
                    // Hamburger is shown at every width. The top bar carries the
                    // primary links on desktop; the slide-out holds the rest
                    // (Dashboard, Directory) and stays reachable on any screen.
                    // Carries both hooks the delegated handler listens for.
                    '<button id="ffMenuBtn" type="button" data-toggle-sidebar aria-label="Open menu" ' +
                        'aria-controls="ffSidebar" aria-expanded="false" ' +
                        'class="ff-hamburger flex items-center justify-center text-neutral-700 ' +
                        'hover:text-neutral-900 transition-colors" style="min-width:40px;min-height:40px">' +
                        ICON_MENU + '</button>' +
                '</div>' +
            '</div>';
        return header;
    }

    // Slide-out sidebar for the links kept out of the top bar (Dashboard,
    // Directory). Opened by the hamburger; closed by the X or Escape. It covers
    // the full viewport (see .ff-sidebar in app.css), so there is no backdrop to
    // click through — the X and Escape are the ways out.
    function sidebarLink(label, href, icon) {
        var active = (href === PAGE);
        var cls = 'flex items-center gap-3 px-3 py-3 rounded-xl text-sm font-medium transition-colors ' +
            (active ? 'bg-sage-50 text-sage-700' : 'text-neutral-700 hover:bg-neutral-100');
        return '<a href="' + href + '" class="' + cls + '"' +
            (active ? ' aria-current="page"' : '') + '>' + icon + '<span>' + label + '</span></a>';
    }

    function buildSidebar() {
        var wrap = document.createElement('div');
        wrap.innerHTML =
            '<aside id="ffSidebar" class="ff-sidebar" aria-label="More navigation" aria-hidden="true">' +
                '<div class="flex items-center justify-between mb-6">' +
                    '<span class="text-base font-medium tracking-tight text-neutral-900">Menu</span>' +
                    '<button id="ffSidebarClose" type="button" aria-label="Close menu" ' +
                        'class="flex items-center justify-center text-neutral-500 hover:text-neutral-900 ' +
                        'transition-colors" style="min-width:40px;min-height:40px">' + ICON_CLOSE + '</button>' +
                '</div>' +
                '<nav class="flex flex-col gap-1">' +
                    sidebarLink('Dashboard', 'dashboard.html', ICON_DASH) +
                    sidebarLink('Directory', 'directory.html', ICON_DIR) +
                '</nav>' +
            '</aside>';
        return wrap;
    }

    // Open/close the panel. `.active` is the single source of truth for
    // visibility; app.css keeps it translated off-screen without it.
    function setSidebar(on) {
        var sb = document.getElementById('ffSidebar');
        if (!sb) return;
        sb.classList.toggle('active', on);
        sb.setAttribute('aria-hidden', on ? 'false' : 'true');

        var btns = document.querySelectorAll('[data-toggle-sidebar], .ff-hamburger');
        for (var i = 0; i < btns.length; i++) {
            btns[i].setAttribute('aria-expanded', on ? 'true' : 'false');
        }

        // Freeze the page behind the panel so a scroll gesture over the overlay
        // doesn't drag the document underneath it.
        document.body.style.overflow = on ? 'hidden' : '';
    }

    function wireSidebar() {
        // Delegated from the document, so the toggle works for ANY hamburger —
        // desktop or mobile, present at load or injected later, and unaffected
        // by the header being rebuilt. No per-button binding to keep in sync.
        document.addEventListener('click', function (e) {
            var t = e.target;
            if (!t || typeof t.closest !== 'function') return;

            if (t.closest('[data-toggle-sidebar], .ff-hamburger')) {
                e.preventDefault();
                var sb = document.getElementById('ffSidebar');
                setSidebar(!(sb && sb.classList.contains('active')));
                return;
            }
            if (t.closest('#ffSidebarClose')) {
                e.preventDefault();
                setSidebar(false);
                return;
            }
            // Following a link inside the panel navigates away — close first so
            // a back-button return never lands on an open menu with a locked body.
            if (t.closest('#ffSidebar a')) setSidebar(false);
        });

        document.addEventListener('keydown', function (e) {
            if (e.key === 'Escape' || e.keyCode === 27) setSidebar(false);
        });
    }

    // Bottom tab bar — Home · Scan · Dashboard. Icons are inline so the bar has
    // no asset dependency. Active tab is coloured via aria-current (see app.css).
    var TABS = [
        {
            label: 'Home', href: 'index.html', match: ['index.html', ''],
            icon: '<path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V21h14V9.5"/>'
        },
        {
            label: 'Scan', href: 'try.html', match: ['try.html'],
            icon: '<path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/>'
        },
        {
            label: 'Dashboard', href: 'dashboard.html', match: ['dashboard.html'],
            icon: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>'
        }
    ];

    function buildTabBar() {
        var nav = document.createElement('nav');
        nav.className = 'ff-tabbar';
        nav.setAttribute('aria-label', 'Primary');
        nav.innerHTML = TABS.map(function (t) {
            var active = t.match.indexOf(PAGE) !== -1;
            return '<a class="ff-tabbar__item" href="' + t.href + '"' +
                (active ? ' aria-current="page"' : '') + '>' +
                '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" ' +
                'stroke-linecap="round" stroke-linejoin="round">' + t.icon + '</svg>' +
                '<span>' + t.label + '</span></a>';
        }).join('');
        return nav;
    }

    function mount() {
        // Swap the page's shipped header for the canonical one (or add it if the
        // page had none). Only the first <header> is treated as site chrome.
        var existing = document.querySelector('header');
        var header = buildHeader();
        if (existing && existing.parentNode) {
            existing.parentNode.replaceChild(header, existing);
        } else {
            document.body.insertBefore(header, document.body.firstChild);
        }

        // Slide-out sidebar (Dashboard / Directory) + its open/close wiring.
        document.body.appendChild(buildSidebar());
        wireSidebar();

        // Bottom tab bar + the body padding that keeps content clear of it.
        document.body.appendChild(buildTabBar());
        document.body.classList.add('has-tabbar');

        // If auth.js is on the page, let it drive the (rebuilt) sign-in link.
        if (typeof window.ffRenderHeader === 'function') {
            try { window.ffRenderHeader(); } catch (e) { /* non-fatal */ }
        }
    }

    /**
     * Repaint the active-route highlight after a client-side navigation.
     *
     * Called by scripts/router.js with the new page key. Only the three
     * aria-current markers move; the chrome is not rebuilt, because rebuilding
     * it would drop the delegated sidebar state and re-run ffRenderHeader for
     * no reason.
     */
    function setActive(key) {
        PAGE = key || currentPage();

        // Desktop links + sidebar links: both key off an exact href match.
        var links = document.querySelectorAll('header nav a[href], #ffSidebar a[href]');
        for (var i = 0; i < links.length; i++) {
            var a = links[i];
            var href = (a.getAttribute('href') || '').toLowerCase();
            var on = (href === PAGE);
            if (on) a.setAttribute('aria-current', 'page');
            else a.removeAttribute('aria-current');
        }

        // Bottom tab bar: match through the TABS table, so "/" still lights Home.
        var tabs = document.querySelectorAll('.ff-tabbar__item');
        for (var j = 0; j < tabs.length && j < TABS.length; j++) {
            if (TABS[j].match.indexOf(PAGE) !== -1) tabs[j].setAttribute('aria-current', 'page');
            else tabs[j].removeAttribute('aria-current');
        }

        // Sign-in state can differ per route (dashboard is private), so let
        // auth.js have another pass if it is present.
        if (typeof window.ffRenderHeader === 'function') {
            try { window.ffRenderHeader(); } catch (e) { /* non-fatal */ }
        }
    }

    window.ffNavSetActive = setActive;
    window.ffNavCurrent = function () { return PAGE; };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', mount);
    } else {
        mount();
    }
})();
