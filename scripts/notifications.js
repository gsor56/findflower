(function () {
    'use strict';
    // Every page loads this, and only some of them set FF_SOCIAL_API, so the
    // production default belongs here too. Local runs keep talking to the
    // harness stub rather than reaching out to a deployed backend.
    function baseUrl() {
        if (typeof window.FF_SOCIAL_API === 'string' && window.FF_SOCIAL_API) {
            return String(window.FF_SOCIAL_API).replace(/\/+$/, '');
        }
        var h = location.hostname;
        if (h === '127.0.0.1' || h === 'localhost') return 'http://127.0.0.1:4000';
        return 'https://findflower-proxy.fofi.workers.dev/v1/community';
    }

    async function authToken() {
        try {
            if (typeof window.ffIdToken === 'function') return await window.ffIdToken();
        } catch (e) { }
        return null;
    }

    function ensureBell() {
        var bell = document.getElementById('ffNotifyBell');
        if (bell) return bell;
        var menu = document.getElementById('ffMenuBtn');
        if (!menu || !menu.parentNode) return null;
        bell = document.createElement('a');
        bell.id = 'ffNotifyBell';
        bell.href = '/notifications';
        bell.setAttribute('aria-label', 'Notifications');
        bell.className = 'relative flex items-center justify-center rounded-full text-[#1a3622]';
        bell.style.width = '40px'; bell.style.height = '40px';
        bell.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4"/></svg><span id="ffNotifyBadge" class="hidden absolute -top-1 -right-1 min-w-[18px] h-[18px] px-1 items-center justify-center bg-[#1a3622] text-white text-[10px] rounded-full"></span>';
        menu.parentNode.insertBefore(bell, menu);
        return bell;
    }

    async function refresh() {
        var bell = ensureBell();
        if (!bell) return;
        var token = await authToken();
        if (!token) return;
        try {
            var res = await fetch(baseUrl() + '/api/notifications/count', {
                headers: { Accept: 'application/json', Authorization: 'Bearer ' + token }, mode: 'cors'
            });
            if (!res.ok) return;
            var data = await res.json();
            var count = Number(data.unread) || 0;
            bell.classList.remove('hidden'); bell.classList.add('flex');
            var badge = document.getElementById('ffNotifyBadge');
            if (!badge) return;
            badge.textContent = count > 99 ? '99+' : String(count);
            badge.classList.toggle('hidden', count < 1);
            badge.classList.toggle('flex', count > 0);
            bell.setAttribute('aria-label', count ? 'Notifications, ' + count + ' unread' : 'Notifications');
        } catch (e) { }
    }

    window.ffNotifications = { refresh: refresh };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', refresh);
    else refresh();
})();
