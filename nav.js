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

    var PAGE = currentPage();

    // Brand mark (the favicon flower) reused in the header.
    var LOGO =
        '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" class="text-sage-600">' +
        '<path d="M12 21c0-4 0-7 0-9m0 0c0-3 2.5-5 6-5-.2 3.2-2.8 5-6 5Zm0 0c0-3-2.5-5-6-5 .2 3.2 2.8 5 6 5Z" ' +
        'stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';

    // The canonical desktop nav. Same links, same order, same labels, on every
    // page. (Marketing destinations — How it works, Pricing, About — remain
    // reachable from the footer, which every page also shares.)
    var LINKS = [
        { label: 'Scanner',   href: 'try.html' },
        { label: 'Directory', href: 'directory.html' },
        { label: 'Dashboard', href: 'dashboard.html' },
        { label: 'API',       href: 'api.html' }
    ];

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
                '<a href="index.html" class="flex items-center gap-2 font-serif text-lg text-neutral-900">' +
                    LOGO + 'FindFlower' +
                '</a>' +
                '<nav class="hidden md:flex items-center gap-8 text-sm font-medium">' +
                    navLinksHTML() +
                '</nav>' +
                '<div class="flex items-center gap-3">' +
                    '<a id="signInLink" href="login.html" class="text-sm font-medium text-neutral-900 ' +
                        'hover:text-neutral-600 transition-colors hidden md:block">Sign In</a>' +
                    '<a href="try.html" class="text-sm font-medium bg-neutral-900 text-white px-5 ' +
                        'rounded-full hover:bg-neutral-800 transition-colors flex items-center" ' +
                        'style="min-height:40px">Try Now</a>' +
                '</div>' +
            '</div>';
        return header;
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
                '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" ' +
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

        // Bottom tab bar + the body padding that keeps content clear of it.
        document.body.appendChild(buildTabBar());
        document.body.classList.add('has-tabbar');

        // If auth.js is on the page, let it drive the (rebuilt) sign-in link.
        if (typeof window.ffRenderHeader === 'function') {
            try { window.ffRenderHeader(); } catch (e) { /* non-fatal */ }
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', mount);
    } else {
        mount();
    }
})();
