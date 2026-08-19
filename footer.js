/* ============================================================================
   FindFlower — universal footer (footer.js)
   ----------------------------------------------------------------------------
   The sibling of nav.js, and it exists for the same reason: the thing it builds
   had drifted. Measured across the 15 pages before this file existed, all 15
   footers differed from each other by at least one of these:

     • the bottom-left line read "Engineered by gsor56" on 13 pages and
       "Open botanical reference" on the other 2
     • the About link was "#about" on the home page and "index.html#about"
       everywhere else, which is right per page and so has to be derived
       rather than copied
     • "mt-24" sat on the <footer> of 11 pages and was absent from 4
     • directory.html carried a Wikidata/Wikipedia credit line no other page had

   Nobody wrote those differences on purpose. They are what 45 lines of markup
   pasted into 15 files turns into, and the only fix that holds is to stop
   pasting it. This builds the footer once, from data.

   Mounting, in order of preference:
     1. <div id="ff-footer"> — the hook every page now ships. Replaced outright
        by the real <footer>, so no wrapper div survives to affect layout.
     2. an existing page <footer> — replaced, exactly as nav.js replaces a
        page's shipped <header>. A page that was never converted still gets the
        canonical footer.
     3. appended to <body>.

   The one thing that is legitimately per-page is the top margin, and it is a
   route table below (FLUSH) rather than an attribute on the hook. It started as
   data-flush on the hook and that is measurably wrong: the router replaces
   <main> only, so the destination page's hook never enters the DOM and a swap
   has no attribute to read. Measured before this moved: routing from / to
   /pricing left the footer flush against the pricing table, because the node
   had been built on index.html and nothing ever revisited its class.

   SPA note. The chrome lives outside <main>, so the router never replaces this
   and it is built exactly once per document load. Four things do change per
   route: the About link (a bare "#about" while you are on the home page,
   "/#about" from anywhere else), the aria-current marker, the species-data
   credit, and the top margin. router.js calls window.ffFooterSetActive(key)
   after each swap, the same way it already calls window.ffNavSetActive.
   ========================================================================== */
(function () {
    'use strict';

    /** Filename key for a path. Mirrors pageKey() in scripts/router.js and
     *  currentPage() in nav.js: "/" and "/how" both resolve to the .html file,
     *  so a clean path and a .html path compare equal. */
    function pageKey(pathname) {
        var path = String(pathname || '').replace(/\/+$/, '');
        var file = path.substring(path.lastIndexOf('/') + 1).toLowerCase();
        if (!file) return 'index.html';
        if (file.indexOf('.') === -1) return file + '.html';
        return file;
    }

    // Mutable: the router repaints this after every client-side navigation.
    var PAGE = pageKey(location.pathname);

    // Clean paths, not filenames. GitHub Pages serves /how for how.html and
    // 404s a path with no file behind it. Measured against the live site on
    // 2026-08-19: /, /try, /directory and /how all answered 200, and
    // /nonexistent-xyz answered 404.
    var PRODUCT = [
        { label: 'Try Now',       href: '/try',       key: 'try.html' },
        { label: 'Directory',     href: '/directory', key: 'directory.html' },
        { label: 'How it works',  href: '/how',       key: 'how.html' },
        { label: 'Pricing',       href: '/pricing',   key: 'pricing.html' },
        { label: 'API',           href: '/api',       key: 'api.html' },
        { label: 'Release Notes', href: '/releases',  key: 'releases.html' }
    ];

    var PROJECT = [
        { label: 'About',            href: '#about',   key: 'index.html', hash: true },
        { label: 'Contact',          href: '/contact', key: 'contact.html' },
        { label: 'Privacy Policy',   href: '/privacy', key: 'privacy.html' },
        { label: 'Terms of Service', href: '/terms',   key: 'terms.html' }
    ];

    // Pages that render live species data fetched from Wikidata and Wikipedia.
    // The credit line is a CC BY-SA condition rather than decoration, so it is
    // keyed off the route here instead of left to each page to remember.
    var ATTRIBUTED = { 'directory.html': 1, 'species.html': 1 };

    // Routes that must NOT get the mt-24 top margin: each of these ends in a
    // section carrying its own bottom padding, and stacking 6rem on top of it
    // opens a visible gap. The other eleven pages end flush against their last
    // element and need the margin or the footer crowds it.
    var FLUSH = {
        'index.html': 1, 'how.html': 1, 'login.html': 1, '404.html': 1,
        // Both placeholders centre one short block in a min-h-[58vh] section
        // that already carries pb-28, so mt-24 on top of it opens a gap.
        'blogs.html': 1, 'community.html': 1,
    };

    var LOGO =
        '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" class="text-sage-600" aria-hidden="true">' +
        '<path d="M12 21c0-4 0-7 0-9m0 0c0-3 2.5-5 6-5-.2 3.2-2.8 5-6 5Zm0 0c0-3-2.5-5-6-5 .2 3.2 2.8 5 6 5Z" ' +
        'stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';

    var LINK_CLS = 'hover:text-neutral-900 transition-colors';

    /** An #about link should point at the current document while the reader is
     *  already on the home page, so the browser scrolls rather than the router
     *  swapping. From any other route it needs the home path in front of it. */
    function resolve(item) {
        if (!item.hash) return item.href;
        return PAGE === 'index.html' ? '#about' : '/' + item.href;
    }

    function isActive(item) {
        if (item.hash) return false;   // a fragment is a position, not a page
        return item.key === PAGE;
    }

    function column(title, items) {
        return '<div>' +
            '<h5 class="text-sm font-medium text-neutral-900 mb-4">' + title + '</h5>' +
            '<ul class="space-y-3 text-sm text-neutral-500 font-light">' +
            items.map(function (i) {
                var on = isActive(i);
                // data-ff-key is what setActive() repaints against. Pairing the
                // anchors to the tables by DOM index would work today and break
                // the first time a column gains a row.
                return '<li><a href="' + resolve(i) + '" data-ff-key="' + i.key + '" class="' +
                    (on ? 'text-neutral-900' : LINK_CLS) + '"' +
                    (on ? ' aria-current="page"' : '') + '>' + i.label + '</a></li>';
            }).join('') +
            '</ul></div>';
    }

    function creditLine() {
        return '&copy; 2026 FindFlower &middot; Open botanical reference' +
            (ATTRIBUTED[PAGE]
                ? '<br>Species data from Wikidata &amp; Wikipedia, CC0 / CC BY-SA'
                : '');
    }

    function bottomBar() {
        return '<div class="flex flex-col md:flex-row items-center justify-between pt-8 ' +
                'border-t border-neutral-100 text-xs text-neutral-400 font-light">' +
                '<p data-ff-credit>' + creditLine() + '</p>' +
                '<div class="flex gap-4 mt-4 md:mt-0">' +
                    '<span class="flex items-center gap-1.5">' +
                        '<span class="w-1.5 h-1.5 rounded-full bg-sage-500"></span>' +
                        'Vision Transformer &middot; 116 classes</span>' +
                    '<span>ONNX Runtime &middot; fp32 weights</span>' +
                '</div>' +
            '</div>';
    }

    var SHELL_CLS = 'border-t border-neutral-200 bg-[#FCFCFC] pt-16 pb-8';

    /** Assigned rather than toggled: the class list is entirely ours, and a
     *  toggle would have to know which of the two states it was in. */
    function spacing(el, flush) {
        el.className = SHELL_CLS + (flush ? '' : ' mt-24');
    }

    function build(flush) {
        var el = document.createElement('footer');
        el.setAttribute('data-ff-footer', '');
        spacing(el, flush);
        el.innerHTML =
            '<div class="max-w-7xl mx-auto px-6">' +
                '<div class="grid grid-cols-2 md:grid-cols-4 gap-8 mb-16">' +
                    '<div class="col-span-2">' +
                        '<span class="flex items-center gap-2 text-lg font-medium tracking-tight ' +
                            'text-neutral-900 mb-3">' + LOGO + 'FindFlower</span>' +
                        '<p class="text-sm text-neutral-500 font-light max-w-xs">' +
                            'Flower identification from a single photo, running a Vision ' +
                            'Transformer trained on 116 species.</p>' +
                    '</div>' +
                    column('Product', PRODUCT) +
                    column('Project', PROJECT) +
                '</div>' +
                bottomBar() +
            '</div>';
        return el;
    }

    /** The page footer, never the sidebar one. nav.js used to build a
     *  <footer class="ff-drawer-utility"> inside #ffSidebar for the clock and
     *  location panel, and a bare querySelector('footer') reached it -- which
     *  put the page footer inside the drawer. The panel is gone, so today this
     *  loop always returns on i=0; the skip stays because the drawer is markup
     *  nav.js owns and this file must not assume what is in it. */
    function pageFooter() {
        var all = document.querySelectorAll('footer');
        for (var i = 0; i < all.length; i++) {
            if (!all[i].closest('#ffSidebar')) return all[i];
        }
        return null;
    }

    function mount() {
        if (document.querySelector('footer[data-ff-footer]')) return;

        var hook = document.getElementById('ff-footer');
        var host = hook || pageFooter();

        // The route table, so the first paint and every later swap agree. The
        // fallback is for a page that was never converted and still ships its
        // own <footer>: it has no entry there, so keep the spacing it was
        // authored with rather than guessing at it.
        var flush = hook ? !!FLUSH[PAGE]
            : (host ? !/\bmt-24\b/.test(host.className || '') : false);

        var el = build(flush);
        if (host && host.parentNode) host.parentNode.replaceChild(el, host);
        else document.body.appendChild(el);
    }

    /**
     * Repaint after a client-side navigation.
     *
     * Four things depend on the route: the About link, which is a bare fragment
     * on the home page and a rooted one everywhere else; the aria-current
     * marker; the Wikidata credit, which has to appear when a swap lands on the
     * directory or a species page; and the top margin, which index.html, how,
     * login and 404 must not carry. The footer itself is not rebuilt.
     */
    function setActive(key) {
        PAGE = key || pageKey(location.pathname);
        var el = document.querySelector('footer[data-ff-footer]');
        if (!el) return;

        var byKey = {};
        PRODUCT.concat(PROJECT).forEach(function (i) { byKey[i.key] = i; });

        var links = el.querySelectorAll('a[data-ff-key]');
        for (var i = 0; i < links.length; i++) {
            var a = links[i];
            var item = byKey[a.getAttribute('data-ff-key')];
            if (!item) continue;
            a.setAttribute('href', resolve(item));
            if (isActive(item)) {
                a.setAttribute('aria-current', 'page');
                a.className = 'text-neutral-900';
            } else {
                a.removeAttribute('aria-current');
                a.className = LINK_CLS;
            }
        }

        var credit = el.querySelector('[data-ff-credit]');
        if (credit) credit.innerHTML = creditLine();

        spacing(el, !!FLUSH[PAGE]);
    }

    window.ffFooterSetActive = setActive;
    window.ffFooterCurrent = function () { return PAGE; };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', mount);
    } else {
        mount();
    }
})();
