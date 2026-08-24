(function () {
    'use strict';

    function pageKey(pathname) {
        var path = String(pathname || '').replace(/\/+$/, '');
        var file = path.substring(path.lastIndexOf('/') + 1).toLowerCase();
        if (!file) return 'index.html';
        if (file.indexOf('.') === -1) return file + '.html';
        return file;
    }

    var PAGE = pageKey(location.pathname);

    var PRODUCT = [
        { label: 'Try Now',       href: '/try',       key: 'try.html' },
        { label: 'Directory',     href: '/directory', key: 'directory.html' },
        { label: 'How it works',  href: '/how',       key: 'how.html' },
        { label: 'Docs',          href: '/docs',      key: 'docs.html' },
        { label: 'Pricing',       href: '/pricing',   key: 'pricing.html' },
        { label: 'API',           href: '/api',       key: 'api.html' },
        { label: 'Data',          href: '/data',      key: 'data.html' },
        { label: 'Release Notes', href: '/releases',  key: 'releases.html' },
        { label: 'Blogs',         href: '/blogs',     key: 'blogs.html' }
    ];

    var PROJECT = [
        { label: 'About',            href: '/about',     key: 'about.html' },
        { label: 'Research',         href: '/research',  key: 'research.html' },
        { label: 'Community',        href: '/community', key: 'community.html' },
        { label: 'Contact',          href: '/contact',   key: 'contact.html' },
        { label: 'Privacy Policy',   href: '/privacy',   key: 'privacy.html' },
        { label: 'Terms of Service', href: '/terms',     key: 'terms.html' }
    ];

    var ATTRIBUTED = { 'directory.html': 1, 'species.html': 1 };

    var FLUSH = {
        'index.html': 1, 'how.html': 1, 'login.html': 1, '404.html': 1,
        'community.html': 1,
    };

    var LOGO =
        '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" class="text-sage-600" aria-hidden="true">' +
        '<path d="M12 21c0-4 0-7 0-9m0 0c0-3 2.5-5 6-5-.2 3.2-2.8 5-6 5Zm0 0c0-3-2.5-5-6-5 .2 3.2 2.8 5 6 5Z" ' +
        'stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';

    var LINK_CLS = 'hover:text-neutral-900 transition-colors';

    function isActive(item) {
        return item.key === PAGE;
    }

    function column(title, items) {
        return '<div>' +
            '<h2 class="text-sm font-medium text-neutral-900 mb-4">' + title + '</h2>' +
            '<ul class="space-y-3 text-sm text-neutral-500 font-light">' +
            items.map(function (i) {
                var on = isActive(i);
                return '<li><a href="' + i.href + '" data-ff-key="' + i.key + '" class="' + (on ? 'text-neutral-900' : LINK_CLS) + '"' +
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
        return '<div class="flex flex-col md:flex-row items-center justify-between pt-8 ' + 'border-t border-neutral-100 text-xs text-neutral-400 font-light">' +
                '<p data-ff-credit>' + creditLine() + '</p>' +
                '<div class="flex gap-4 mt-4 md:mt-0">' +
                    '<span>Vision Transformer &middot; 116 classes</span>' +
                    '<span>ONNX Runtime &middot; fp32 weights</span>' +
                '</div>' +
            '</div>';
    }

    var SHELL_CLS = 'border-t border-neutral-200 bg-[#FCFCFC] pt-16 pb-8';

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
                        '<span class="flex items-center gap-2 text-lg font-medium tracking-tight ' + 'text-neutral-900 mb-3">' + LOGO + 'FindFlower</span>' +
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

    function pageFooter() {
        var all = document.querySelectorAll('footer');
        for (var i = 0; i < all.length; i++) {
            if (all[i].closest('#ffSidebar') || all[i].closest('main')) continue;
            return all[i];
        }
        return null;
    }

    function mount() {
        if (document.querySelector('footer[data-ff-footer]')) return;

        var hook = document.getElementById('ff-footer');
        var host = hook || pageFooter();

        var flush = hook ? !!FLUSH[PAGE]
            : (host ? !/\bmt-24\b/.test(host.className || '') : false);

        var el = build(flush);
        if (host && host.parentNode) host.parentNode.replaceChild(el, host);
        else document.body.appendChild(el);
    }

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
            a.setAttribute('href', item.href);
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
