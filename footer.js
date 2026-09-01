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
        { label: 'Contribute',       href: '/contribute', key: 'contribute.html' },
        { label: 'Contact',          href: '/contact',   key: 'contact.html' },
        { label: 'Privacy Policy',   href: '/privacy',   key: 'privacy.html' },
        { label: 'Terms of Service', href: '/terms',     key: 'terms.html' },
        { label: 'Open datasets',    href: 'https://huggingface.co/gsor56', out: true },
        { label: 'Source on GitHub', href: 'https://github.com/gsor56/findflower', out: true }
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
                if (i.out) {
                    return '<li><a href="' + i.href + '" target="_blank" rel="noopener noreferrer"' +
                        ' class="' + LINK_CLS + '">' + i.label + '</a></li>';
                }
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
        { label: 'FindFlower datasets on Hugging Face',
          href: 'https://huggingface.co/datasets/gsor56/FindFlower-Premium-100-flowering/tree/0fd49fd410c72b5a805c37d22cb6c904fcbfddfe',
          path: 'M1.4446 11.5059c0 1.1021.1673 2.1585.4847 3.1563-.0378-.0028-.0691-.0058-.1058-.0058-.4209 0-.8015.16-1.0704.4512-.3454.3737-.4984.8335-.4316 1.293a1.576 1.576 0 0 0 .2148.5978c-.2319.1864-.4018.4456-.4844.7578-.0646.2448-.131.7543.2149 1.2794a1.4552 1.4552 0 0 0-.0625.1055c-.208.3923-.2207.8372-.0371 1.25.2783.6258.9696 1.1175 2.3126 1.6467.8356.3292 1.5988.5411 1.6056.543 1.1046.2847 2.104.4277 2.969.4277 1.4173 0 2.4754-.3849 3.1525-1.1446 1.538.2651 2.791.1403 3.592.006.6773.7555 1.7332 1.1387 3.1467 1.1387.8649 0 1.8643-.143 2.969-.4278.0068-.0019.77-.2138 1.6056-.543 1.343-.5292 2.0343-1.0208 2.3126-1.6466.1836-.4129.171-.8577-.037-1.25a1.4685 1.4685 0 0 0-.0626-.1056c.346-.525.2795-1.0346.2149-1.2793-.0826-.3122-.2525-.5714-.4844-.7579.11-.1816.1831-.3788.2148-.5977.0669-.4595-.0862-.9193-.4316-1.293-.2688-.2913-.6495-.4513-1.0704-.4513-.0209 0-.0376.0008-.0588.0018.3162-.9966.4846-2.0518.4846-3.1523 0-5.807-4.7362-10.5144-10.5789-10.5144-5.8426 0-10.5788 4.7073-10.5788 10.5144Zm10.5788-9.4831c5.2727 0 9.5476 4.246 9.5476 9.483a9.4201 9.4201 0 0 1-.2696 2.2365c-.0039-.0047-.0079-.011-.0117-.0156-.274-.3255-.6679-.5059-1.1075-.5059-.352 0-.714.1155-1.0763.3438-.2403.1517-.5058.422-.7793.7598-.2534-.3492-.608-.5832-1.0137-.6465a1.5174 1.5174 0 0 0-.2344-.0176c-.9263 0-1.4828.7993-1.6935 1.5177-.1046.2426-.6065 1.3482-1.3614 2.0978-1.1681 1.1601-1.4458 2.3534-.8396 3.6382-.843.1029-1.5836.0927-2.365-.006.5906-1.212.3626-2.4388-.8426-3.6322-.755-.7496-1.2568-1.8552-1.3614-2.0978-.2107-.7184-.7673-1.5177-1.6935-1.5177-.078 0-.1568.0054-.2344.0176-.4057.0633-.7604.2973-1.0137.6465-.2735-.3379-.539-.6081-.7794-.7598-.3622-.2283-.7243-.3438-1.0762-.3438-.4266 0-.8094.171-1.0821.4786a9.4208 9.4208 0 0 1-.2598-2.1936c0-5.237 4.2749-9.483 9.5475-9.483zM8.6443 7.0036c-.4838.0043-.9503.2667-1.1934.7227-.3536.6633-.1006 1.4873.5645 1.84.351.1862.4883-.5261.836-.6485.3107-.1095.841.399 1.0078.086.3536-.6634.1025-1.4874-.5625-1.84a1.3659 1.3659 0 0 0-.6524-.1602Zm6.8403 0c-.2199-.002-.4426.05-.6504.1602-.665.3526-.9181 1.1766-.5645 1.84.1669.313.6971-.1955 1.0079-.086.3476.1224.4867.8347.838.6485.6649-.3527.916-1.1767.5624-1.84-.243-.456-.7096-.7184-1.1934-.7227Zm-9.7565 1.418a.8768.8768 0 0 0-.877.877c0 .4846.3925.877.877.877a.8768.8768 0 0 0 .877-.877.8768.8768 0 0 0-.877-.877zm12.6434 0c-.4845 0-.879.3925-.879.877 0 .4846.3945.877.879.877a.8768.8768 0 0 0 .877-.877.8768.8768 0 0 0-.877-.877zM8.7927 11.459c-.179-.003-.2793.1107-.2793.416 0 .8097.3874 2.125 1.4279 2.924.207-.7123 1.3453-1.2832 1.5079-1.2012.2315.1167.2191.4417.6074.7266.3884-.285.374-.6098.6056-.7266.1627-.082 1.3009.4889 1.5079 1.2012 1.0404-.799 1.4278-2.1144 1.4278-2.924 0-1.2212-1.583.6402-3.5413.6485-1.4686-.0061-2.7266-1.0558-3.2639-1.0645zM4.312 14.4768c.5792.365 1.6964 2.2751 2.1056 3.0177.1371.2488.371.3536.582.3536.4188 0 .7465-.4138.0391-.9395-1.0636-.791-.6914-2.0846-.1836-2.1642a.4302.4302 0 0 1 .0664-.004c.4616 0 .666.7892.666.7892s.5959 1.4898 1.6213 2.508c.942.9356 1.062 1.703.4961 2.6661-.0164-.004-.0159.0236-.1484.2149-.1853.2673-.4322.4688-.7188.6152-.5062.2269-1.1397.2696-1.7833.2696-1.037 0-2.1017-.1824-2.6975-.336-.0293-.0075-3.6505-.9567-3.1916-1.8224.0771-.1454.2033-.2031.3633-.2031.6463 0 1.823.9551 2.3283.9551.113 0 .196-.0865.2285-.2031.2249-.8045-3.2787-1.0522-2.9846-2.1642.0519-.1967.193-.2757.3907-.2754.854 0 2.7704 1.4923 3.172 1.4923.0307 0 .0525-.0085.0645-.0274.2012-.3227.1096-.5865-1.3087-1.4395-1.4182-.8533-2.4315-1.329-1.8653-1.9416.0651-.0707.1574-.1015.2695-.1015.8611.0002 2.8948 1.84 2.8948 1.84s.5487.5683.8809.5683c.0762 0 .1416-.0315.1855-.1054.2355-.3946-2.1858-2.2183-2.3224-2.971-.0926-.51.0641-.7676.3555-.7676-.0006.008.1701-.0285.4942.1759zm16.2257.5918c-.1366.7526-2.5579 2.5764-2.3224 2.9709.044.074.1092.1055.1855.1055.3321 0 .881-.5684.881-.5684s2.0336-1.8397 2.8947-1.84c.1121 0 .2044.0308.2695.1016.5662.6125-.447 1.0882-1.8653 1.9415-1.4183.853-1.51 1.1168-1.3087 1.4396.012.0188.0337.0273.0644.0273.4016 0 2.3181-1.4923 3.1721-1.4923.1977-.0002.3388.0787.3907.2754.294 1.112-3.2095 1.3597-2.9846 2.1642.0325.1166.1156.2032.2285.2032.5054 0 1.682-.9552 2.3283-.9552.16 0 .2862.0577.3633.2032.459.8656-3.1623 1.8149-3.1916 1.8224-.5958.1535-1.6605.336-2.6975.336-.6351 0-1.261-.0409-1.7638-.2599-.2949-.1472-.5488-.3516-.7383-.625-.0411-.0682-.1026-.1476-.1426-.205-.5726-.9679-.455-1.7371.4903-2.676 1.0254-1.0182 1.6212-2.508 1.6212-2.508s.2044-.7891.666-.7891a.4318.4318 0 0 1 .0665.0039c.5078.0796.88 1.3732-.1836 2.1642-.7074.5257-.3797.9395.039.9395.211 0 .445-.1047.5821-.3535.4092-.7426 1.5264-2.6527 2.1056-3.0178.5588-.3524.99-.1816.8497.5918z' },
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
        PRODUCT.concat(PROJECT).forEach(function (i) { if (i.key) byKey[i.key] = i; });

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
