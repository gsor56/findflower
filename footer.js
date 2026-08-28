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

    var SOCIAL = [
        { label: 'FindFlower on GitHub', href: 'https://github.com/gsor56/findflower',
          path: 'M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12' },
        { label: 'FindFlower on Telegram', href: 'https://t.me/fokduk',
          path: 'M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.26-1.91.178-.184 3.247-2.977 3.307-3.23.005-.03.01-.14-.052-.198-.062-.058-.155-.038-.222-.023-.096.022-1.614 1.025-4.555 3.01-.43.296-.816.44-1.163.432-.386-.008-1.12-.216-1.665-.393-.68-.222-1.218-.34-1.176-.717.021-.194.288-.393.803-.596 3.132-1.365 5.218-2.264 6.257-2.697 2.98-1.24 3.6-1.456 4.004-1.463z' },
        { label: 'FindFlower on Discord', href: 'https://discord.com/users/1123486235151826964',
          path: 'M20.317 4.3698a19.7913 19.7913 0 00-4.8851-1.5152.0741.0741 0 00-.0785.0371c-.211.3753-.4447.8648-.6083 1.2495-1.8447-.2762-3.68-.2762-5.4868 0-.1636-.3933-.4058-.8742-.6177-1.2495a.077.077 0 00-.0785-.037 19.7363 19.7363 0 00-4.8852 1.515.0699.0699 0 00-.0321.0277C.5334 9.0458-.319 13.5799.0992 18.0578a.0824.0824 0 00.0312.0561c2.0528 1.5076 4.0413 2.4228 5.9929 3.0294a.0777.0777 0 00.0842-.0276c.4616-.6304.8731-1.2952 1.226-1.9942a.076.076 0 00-.0416-.1057c-.6528-.2476-1.2743-.5495-1.8722-.8923a.077.077 0 01-.0076-.1277c.1258-.0943.2517-.1923.3718-.2914a.0743.0743 0 01.0776-.0105c3.9278 1.7933 8.18 1.7933 12.0614 0a.0739.0739 0 01.0785.0095c.1202.099.246.1981.3728.2924a.077.077 0 01-.0066.1276 12.2986 12.2986 0 01-1.873.8914.0766.0766 0 00-.0407.1067c.3604.698.7719 1.3628 1.225 1.9932a.076.076 0 00.0842.0286c1.961-.6067 3.9495-1.5219 6.0023-3.0294a.077.077 0 00.0313-.0552c.5004-5.177-.8382-9.6739-3.5485-13.6604a.061.061 0 00-.0312-.0286zM8.02 15.3312c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9555-2.4189 2.157-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.9555 2.4189-2.1569 2.4189zm7.9748 0c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9554-2.4189 2.1569-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.946 2.4189-2.1568 2.4189Z' }
    ];

    function socialRow() {
        return '<div class="flex items-center gap-5 mt-5 md:mt-0">' +
            SOCIAL.map(function (i) {
                return '<a href="' + i.href + '" target="_blank" rel="noopener noreferrer"' +
                    ' aria-label="' + i.label + '"' +
                    ' class="inline-flex items-center justify-center text-neutral-500 ' +
                    'hover:text-neutral-900 transition-colors">' +
                    '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" ' +
                    'aria-hidden="true"><path d="' + i.path + '"/></svg></a>';
            }).join('') +
        '</div>';
    }

    function bottomBar() {
        return '<div class="flex flex-col md:flex-row items-center justify-between pt-8 ' + 'border-t border-neutral-100 text-xs text-neutral-400 font-light">' +
                '<p data-ff-credit>' + creditLine() + '</p>' +
                socialRow() +
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
                            'Point it at a flower and it gives you the species, how ' +
                            'confident it is, and the record behind it.</p>' +
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
