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
    // Same normalisation as any href, so see routeKey() below for the rules.
    function currentPage() { return routeKey(location.pathname); }

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
        { label: 'How it works', href: '/how' },
        { label: 'Pricing',      href: '/pricing' },
        { label: 'API',          href: '/api' },
        { label: 'About',        href: '/#about' }
    ];

    // Every icon is a 24x24 SVG with EXPLICIT width/height so it can never
    // render unconstrained (e.g. if a stylesheet is slow to apply).
    var SVG_OPEN = '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" ' +
        'stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">';
    var ICON_CLOSE = SVG_OPEN + '<path d="M6 6l12 12"/><path d="M18 6 6 18"/></svg>';

    // The hamburger is three real elements rather than an SVG, so its lines can
    // physically fold into an X on open. Pure CSS: .ff-burger keys off the
    // button's own aria-expanded, which setSidebar() already maintains, so
    // there is no second piece of state to drift out of sync. Fixed 20x14 box
    // and transform-only motion — the button never changes size.
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
    var ICON_PIN   = SVG_OPEN +
        '<path d="M20 10c0 5-8 11-8 11S4 15 4 10a8 8 0 1 1 16 0Z"/><circle cx="12" cy="10" r="2.5"/></svg>';
    var ICON_REFRESH = SVG_OPEN +
        '<path d="M20 7v5h-5"/><path d="M4 17v-5h5"/><path d="M6.1 8.2A7 7 0 0 1 18.4 7L20 9M4 15l1.6 2A7 7 0 0 0 17.9 15.8"/></svg>';
    var ICON_COMMUNITY =
        '<svg class="ff-community-flower" width="30" height="36" viewBox="0 0 30 36" fill="none" aria-hidden="true">' +
        '<path d="M15 34V17" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>' +
        '<path d="M15 26c-5.2 0-8.4-2.5-9.4-6.8 5.1-.4 8.3 2 9.4 6.8Zm0 2.7c4.8 0 7.9-2.2 9.1-6.2-4.8-.5-7.9 1.6-9.1 6.2Z" fill="currentColor" fill-opacity=".14" stroke="currentColor" stroke-width="1.35" stroke-linejoin="round"/>' +
        '<path d="M15 17c-4.5 0-7.7-2.8-7.7-6.5 3.7-.7 6.4.8 7.7 3.3 1.3-2.5 4-4 7.7-3.3 0 3.7-3.2 6.5-7.7 6.5Z" fill="currentColor" fill-opacity=".18" stroke="currentColor" stroke-width="1.35" stroke-linejoin="round"/>' +
        '<circle cx="15" cy="9" r="3.5" fill="#D5A84B" stroke="currentColor" stroke-width="1.2"/>' +
        '</svg>';

    function escapeHTML(value) {
        return String(value == null ? '' : value).replace(/[&<>'"]/g, function (ch) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[ch];
        });
    }

    function safeImageURL(value) {
        var url = String(value || '');
        return /^(https:\/\/|data:image\/)/i.test(url) ? escapeHTML(url) : '';
    }

    /**
     * The filename key a link points at, whatever shape the link is written in.
     *
     * Every href on the site is now a clean path ("/", "/how", "/#about") while
     * PAGE is always a filename, because that is what the router and TABS[].match
     * key off. So the two can no longer be compared directly and everything that
     * asks "is this link the page I am on" has to come through here.
     *
     * Returns '' for an href with no page part of its own. That case is the
     * Community placeholder in the drawer, href="#", and the empty key is what
     * stops it matching: the old code read the missing filename as index.html and
     * lit "Community · Coming Soon" as the current page every time the home page
     * loaded without a hash.
     */
    function routeKey(href) {
        var s = String(href || '').split('#')[0].split('?')[0];
        if (!s) return '';
        s = s.replace(/\/+$/, '');
        var file = s.substring(s.lastIndexOf('/') + 1).toLowerCase();
        if (!file) return 'index.html';
        if (file.indexOf('.') === -1) return file + '.html';
        return file;
    }

    /** One active rule for both nav surfaces. The page has to match, and if the
     *  href carries a fragment then the location's fragment has to match too, so
     *  "/#about" is current at /#about and not merely anywhere on the home page. */
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
                (active ? ' aria-current="page"' : '') + '>' + l.label + '</a>';
        }).join('');
    }

    function buildHeader() {
        var header = document.createElement('header');
        // No background/border utilities here on purpose. The glass is owned by
        // .ff-header / .ff-header--solid in app.css so it can transition; a
        // Tailwind `bg-*` class would win the cascade (the Play CDN injects
        // after app.css) and pin the bar solid at every scroll position.
        // `fixed top-0` stays — header.fixed.top-0 carries the safe-area inset.
        header.className = 'ff-header fixed top-0 left-0 right-0 z-50';
        header.innerHTML =
            '<div class="max-w-7xl mx-auto px-4 sm:px-8 h-16 flex items-center justify-between gap-2">' +
                // LEFT — logo + wordmark + Beta pill. min-w-0 so this group is what
                // yields when 360px runs out of room: without it the flex line
                // squeezed the Try Now button until its label wrapped onto two.
                '<div class="flex items-center gap-2 min-w-0">' +
                    '<a href="/" class="flex items-center gap-2 text-lg font-medium tracking-tight text-neutral-900 min-w-0">' +
                        LOGO + '<span class="truncate">FindFlower</span>' +
                    '</a>' +
                    // The pill is decorative; the wordmark is not. Below 360px
                    // there is no room for both, so this is what goes.
                    '<span class="hidden min-[360px]:inline-block shrink-0 text-xs font-medium ' +
                        'text-sage-700 bg-sage-100 px-2 py-0.5 rounded-full">Beta</span>' +
                '</div>' +
                // CENTER — primary links
                '<nav class="hidden md:flex items-center gap-8 text-sm font-medium">' +
                    navLinksHTML() +
                '</nav>' +
                // RIGHT — Sign In, Try Now, and the sidebar hamburger
                '<div class="flex items-center gap-2 sm:gap-3 shrink-0">' +
                    '<a id="signInLink" href="/login" class="text-sm font-medium text-neutral-900 ' +
                        'hover:text-neutral-600 transition-colors hidden md:block">Sign In</a>' +
                    '<a id="ffTryNow" href="/try" class="soft-click text-sm font-medium bg-neutral-900 text-white ' +
                        // `transition`, not `transition-colors`: this button carries
                        // .soft-click, whose press scale needs `transform` in the
                        // transition list. The utility lands after app.css, so
                        // whichever one is named here is the list that wins.
                        'px-4 sm:px-5 rounded-full hover:bg-neutral-800 transition flex items-center gap-1.5 ' +
                        'whitespace-nowrap" ' +
                        'style="min-height:40px">Try Now<span aria-hidden="true">&rarr;</span></a>' +
                    // Hamburger is shown at every width. The top bar carries the
                    // primary links on desktop; the slide-out holds the rest
                    // (Dashboard, Directory) and stays reachable on any screen.
                    // Carries both hooks the delegated handler listens for.
                    '<button id="ffMenuBtn" type="button" data-toggle-sidebar aria-label="Open menu" ' +
                        'aria-controls="ffSidebar" aria-expanded="false" ' +
                        'class="ff-hamburger soft-click flex items-center justify-center text-neutral-700 ' +
                        // `transition` for the same reason as #ffTryNow above.
                        'hover:text-neutral-900 transition" style="min-width:40px;min-height:40px">' +
                        ICON_BURGER + '</button>' +
                '</div>' +
            '</div>';
        return header;
    }

    /**
     * Toggle the header's glass plate on scroll.
     *
     * Transparent while the page is at the top so the hero runs edge to edge
     * behind the bar; solid once content would otherwise slide under the links.
     *
     * Cheap on purpose: one passive listener, coalesced into a single rAF, and
     * it only touches the DOM when the state actually flips. classList.toggle
     * with the same value every frame would still invalidate style on some
     * engines, so the `solid === wasSolid` early-out matters.
     */
    function wireHeaderScroll(header) {
        var THRESHOLD = 12;      // ~one line of scroll: enough to mean "moved"
        var wasSolid = null;     // null so the first pass always paints
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

        // Passive: this handler never calls preventDefault, and saying so keeps
        // it off the critical path of the scroll gesture on touch devices.
        window.addEventListener('scroll', onScroll, { passive: true });
        // Restoring a scrolled position (back button, deep link, reload) must
        // not leave the bar transparent over content.
        window.addEventListener('resize', onScroll, { passive: true });
        paint();
    }

    function drawerLink(label, href, icon) {
        var active = linkIsActive(href);
        return '<a href="' + href + '" class="ff-drawer-link' + (active ? ' is-active' : '') + '"' +
            (active ? ' aria-current="page"' : '') + '>' + icon + '<span>' + label + '</span></a>';
    }

    function buildSidebar() {
        var wrap = document.createElement('div');
        wrap.innerHTML =
            '<div id="ffSidebarBackdrop" class="ff-sidebar-backdrop" aria-hidden="true"></div>' +
            '<aside id="ffSidebar" class="ff-sidebar" aria-label="Site menu" aria-hidden="true" aria-modal="true" role="dialog" tabindex="-1">' +
                '<div class="ff-sidebar__header">' +
                    '<div><span class="ff-sidebar__eyebrow">FindFlower</span><h2>Explore</h2></div>' +
                    '<button id="ffSidebarClose" type="button" aria-label="Close menu" class="ff-sidebar__close">' + ICON_CLOSE + '</button>' +
                '</div>' +
                '<div class="ff-sidebar__scroll">' +
                    '<section id="ffDrawerAuth" class="ff-drawer-auth" aria-live="polite"></section>' +
                    '<nav class="ff-drawer-nav" aria-label="All pages">' +
                        drawerLink('Home', '/', ICON_HOME) +
                        drawerLink('Dashboard', '/dashboard', ICON_DASH) +
                        drawerLink('Directory', '/directory', ICON_DIR) +
                        drawerLink('How it works', '/how', ICON_HOW) +
                        drawerLink('Pricing', '/pricing', ICON_PRICE) +
                        drawerLink('API', '/api', ICON_API) +
                        drawerLink('About', '/#about', ICON_ABOUT) +
                    '</nav>' +
                    '<div class="ff-drawer-community">' +
                        '<a href="#" class="ff-drawer-link ff-drawer-link--community" data-coming-soon="true" aria-label="Community, coming soon">' +
                            ICON_COMMUNITY + '<span>Community</span><span class="ff-coming-soon">Coming Soon</span>' +
                        '</a>' +
                    '</div>' +
                '</div>' +
                '<footer class="ff-drawer-utility" aria-live="polite">' +
                    '<div class="ff-drawer-utility__top"><span class="ff-sidebar__eyebrow">Your local field note</span>' +
                        '<button id="ffLocationRefresh" type="button" class="ff-location-refresh" aria-label="Refresh location" title="Refresh location">' + ICON_REFRESH + '</button></div>' +
                    '<div class="ff-drawer-location">' + ICON_PIN + '<div><strong id="ffDrawerPlace">Location unavailable</strong><span id="ffDrawerCoords">Allow location access to find your place</span></div></div>' +
                    '<div class="ff-drawer-time"><span>Local time</span><time id="ffDrawerTime">--:--</time></div>' +
                '</footer>' +
            '</aside>';
        return wrap;
    }

    var sidebarFocus = null;
    var sidebarOverflow = '';
    var locationStarted = false;
    var clockTimer = null;

    function renderDrawerAuth() {
        var host = document.getElementById('ffDrawerAuth');
        if (!host) return;
        var guest = '<div class="ff-drawer-auth__guest"><span class="ff-drawer-auth__mark">FF</span><div><strong>Welcome to FindFlower</strong><span>Sign in to keep your field notes together.</span></div></div>' +
            '<div class="ff-drawer-auth__actions"><a href="/login" class="ff-drawer-button ff-drawer-button--quiet">Sign In</a><a href="/try" class="ff-drawer-button ff-drawer-button--solid">Try Now</a></div>';
        host.innerHTML = guest;
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
            try { paintProfile(JSON.parse(localStorage.getItem('ff_session_profile') || 'null')); } catch (e) {}
            return;
        }
        window.getUserSession().then(paintProfile).catch(function () {});
    }

    function paintClock() {
        var time = document.getElementById('ffDrawerTime');
        if (!time) return;
        var now = new Date();
        time.textContent = new Intl.DateTimeFormat([], { hour: 'numeric', minute: '2-digit' }).format(now);
        time.dateTime = now.toISOString();
    }

    function setLocationMessage(place, coords) {
        var placeEl = document.getElementById('ffDrawerPlace');
        var coordsEl = document.getElementById('ffDrawerCoords');
        if (placeEl) placeEl.textContent = place;
        if (coordsEl) coordsEl.textContent = coords || '';
    }

    function reverseGeocode(position) {
        var lat = position.coords.latitude;
        var lon = position.coords.longitude;
        var accuracy = Math.round(position.coords.accuracy || 0);
        var coords = lat.toFixed(5) + ', ' + lon.toFixed(5) + (accuracy ? ' · ±' + accuracy + ' m' : '');
        window.ffDrawerLocation = { latitude: lat, longitude: lon, accuracy: position.coords.accuracy || null, altitude: position.coords.altitude || null, timestamp: position.timestamp || Date.now(), place: null, city: null, state: null };
        window.dispatchEvent(new CustomEvent('ff:location', { detail: window.ffDrawerLocation }));
        setLocationMessage('Finding your place…', coords);
        fetch('https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=10&addressdetails=1&lat=' + encodeURIComponent(lat) + '&lon=' + encodeURIComponent(lon), { headers: { 'Accept-Language': navigator.language || 'en' } })
            .then(function (res) { return res.ok ? res.json() : null; })
            .then(function (data) {
                var address = data && data.address;
                var city = address && (address.city || address.town || address.village || address.municipality || address.county);
                var state = address && (address.state || address.region);
                var place = city ? city + (state ? ', ' + state : '') : 'Current location';
                window.ffDrawerLocation.place = place;
                window.ffDrawerLocation.city = city || null;
                window.ffDrawerLocation.state = state || null;
                window.dispatchEvent(new CustomEvent('ff:location', { detail: window.ffDrawerLocation }));
                setLocationMessage(place, coords);
            })
            .catch(function () { setLocationMessage('Current location', coords); });
    }

    function startLocation() {
        if (locationStarted) return;
        locationStarted = true;
        paintClock();
        if (!clockTimer) clockTimer = window.setInterval(paintClock, 30000);
        if (!navigator.geolocation) { setLocationMessage('Location unavailable', 'Geolocation is not supported here'); return; }
        setLocationMessage('Locating…', 'Waiting for a precise browser reading');
        navigator.geolocation.getCurrentPosition(reverseGeocode, function (error) {
            locationStarted = false;
            var message = error && error.code === 1 ? 'Location permission needed' : 'Location unavailable';
            setLocationMessage(message, 'Tap refresh to try again');
        }, { enableHighAccuracy: true, timeout: 12000, maximumAge: 300000 });
    }

    function setSidebar(on) {
        var sb = document.getElementById('ffSidebar');
        var backdrop = document.getElementById('ffSidebarBackdrop');
        if (!sb) return;
        sb.classList.toggle('active', on);
        if (backdrop) backdrop.classList.toggle('active', on);
        sb.setAttribute('aria-hidden', on ? 'false' : 'true');
        if (backdrop) backdrop.setAttribute('aria-hidden', on ? 'false' : 'true');
        var btns = document.querySelectorAll('[data-toggle-sidebar], .ff-hamburger');
        for (var i = 0; i < btns.length; i++) {
            btns[i].setAttribute('aria-expanded', on ? 'true' : 'false');
            btns[i].setAttribute('aria-label', on ? 'Close menu' : 'Open menu');
        }
        if (on) {
            sidebarFocus = document.activeElement;
            sidebarOverflow = document.body.style.overflow;
            document.body.style.overflow = 'hidden';
            renderDrawerAuth();
            startLocation();
            window.setTimeout(function () { var close = document.getElementById('ffSidebarClose'); if (close) close.focus(); }, 20);
        } else {
            document.body.style.overflow = sidebarOverflow;
            if (sidebarFocus && typeof sidebarFocus.focus === 'function') sidebarFocus.focus();
            sidebarFocus = null;
        }
    }

    function wireSidebar() {
        document.addEventListener('click', function (e) {
            var t = e.target;
            if (!t || typeof t.closest !== 'function') return;
            if (t.closest('[data-toggle-sidebar], .ff-hamburger')) { e.preventDefault(); var sb = document.getElementById('ffSidebar'); setSidebar(!(sb && sb.classList.contains('active'))); return; }
            if (t.closest('#ffSidebarClose, #ffSidebarBackdrop')) { e.preventDefault(); setSidebar(false); return; }
            if (t.closest('[data-coming-soon="true"]')) { e.preventDefault(); return; }
            if (t.closest('#ffLocationRefresh')) { e.preventDefault(); locationStarted = false; startLocation(); return; }
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

    // Bottom tab bar — Home · Scan · Directory · Dashboard. Icons are inline so
    // the bar has no asset dependency. Active tab is coloured via aria-current
    // (see app.css).
    var TABS = [
        {
            label: 'Home', href: '/', match: ['index.html', ''],
            icon: '<path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V21h14V9.5"/>'
        },
        {
            label: 'Scan', href: '/try', match: ['try.html'],
            icon: '<path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/>'
        },
        {
            label: 'Directory', href: '/directory', match: ['directory.html'],
            icon: '<path d="M12 21c0-4 0-7 0-9m0 0c0-3 2.5-5 6-5-.2 3.2-2.8 5-6 5Zm0 0c0-3-2.5-5-6-5 .2 3.2 2.8 5 6 5Z"/>'
        },
        {
            label: 'Dashboard', href: '/dashboard', match: ['dashboard.html'],
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
        renderDrawerAuth();
        paintClock();

        // Transparent-at-top / glass-on-scroll behaviour for the bar just built.
        wireHeaderScroll(header);

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

        // Desktop links + drawer links repaint after every client-side route.
        var links = document.querySelectorAll('header nav a[href], #ffSidebar a[href]');
        for (var i = 0; i < links.length; i++) {
            var a = links[i];
            var on = linkIsActive(a.getAttribute('href'));
            if (on) a.setAttribute('aria-current', 'page');
            else a.removeAttribute('aria-current');
            if (a.classList.contains('ff-drawer-link')) a.classList.toggle('is-active', on);
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
        renderDrawerAuth();
    }

    window.ffNavSetActive = setActive;
    window.ffNavCurrent = function () { return PAGE; };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', mount);
    } else {
        mount();
    }
})();
