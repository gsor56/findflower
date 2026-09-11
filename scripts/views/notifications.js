(function () {
    'use strict';
    var $ = function (id) { return document.getElementById(id); };
    function esc(v) { return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) { return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]; }); }
    function note(text) { var el=$('notificationsNote'); if(el){el.textContent=text||'';el.classList.toggle('hidden',!text);} }
    function loading(on) { var el=$('notificationsLoading'); if(el)el.classList.toggle('hidden',!on); }
    function when(iso) { var d=new Date(iso); return isNaN(d)?'':d.toLocaleString(undefined,{dateStyle:'medium',timeStyle:'short'}); }
    async function render() {
        loading(true); note('');
        try {
            var r = await window.ffSocial.notifications();
            if (!r.ok) throw new Error(r.error || 'Notifications unavailable.');
            var host = $('notificationsList'), items = (r.data && r.data.items) || [];
            host.innerHTML = items.map(function (n) {
                var u = n.user || {};
                if (n.type === 'friend_request') {
                    return '<li class="border border-black rounded-none p-3">' +
                        '<p class="text-sm"><a class="font-medium hover:underline" href="/profile?handle=' + encodeURIComponent(u.handle || '') + '">' + esc(u.displayName || u.handle) + '</a> sent a friend request.</p>' +
                        '<div class="flex gap-2 mt-3">' +
                        '<button data-friend="accept" data-handle="' + esc(u.handle) + '" class="border border-black rounded-none px-3 py-2 text-xs uppercase bg-[#1a3622] text-white">Accept</button>' +
                        '<button data-friend="decline" data-handle="' + esc(u.handle) + '" class="border border-black rounded-none px-3 py-2 text-xs uppercase">Reject</button>' +
                        '</div></li>';
                }
                return '<li class="border border-black rounded-none p-3"><a class="block" href="' + esc(n.href || ('/chat?with=' + encodeURIComponent(u.handle || ''))) + '">' +
                    '<span class="text-xs uppercase font-medium">' + esc(u.displayName || u.handle) + '</span>' +
                    '<p class="text-sm mt-1">' + esc(n.snippet || 'Sent you a message') + '</p>' +
                    '<time class="text-xs text-neutral-500">' + esc(when(n.createdAt)) + '</time></a></li>';
            }).join('');
            $('notificationsEmpty').classList.toggle('hidden', items.length > 0);
        } catch (e) {
            note(e.message || 'Could not load notifications.');
        }
        loading(false);
    }
    async function init() {
        if (!window.ffSocial) return;
        var up = await window.ffSocial.probe(true, 5000);
        if (!up) { note('Community service is unavailable.'); return; }
        var signedIn = typeof window.ffIsAuthenticated === 'function' ? await window.ffIsAuthenticated().catch(function(){return false;}) : false;
        if (!signedIn) { note('Sign in to see your notifications.'); return; }
        await render();
    }
    document.addEventListener('DOMContentLoaded', function () {
        $('notificationsList').addEventListener('click', async function (e) {
            var b = e.target.closest('[data-friend]');
            if (!b) return;
            var signedIn = typeof window.ffIsAuthenticated === 'function' ? await window.ffIsAuthenticated().catch(function(){return false;}) : false;
            if (!signedIn) { note('Sign in to respond to friend requests.'); return; }
            b.disabled = true;
            var r = await window.ffSocial.respondFriend(b.dataset.handle, b.dataset.friend);
            if (!r.ok) note(r.error);
            else {
                await render();
                if (window.ffNotifications) window.ffNotifications.refresh();
            }
        });
        init();
    });
})();
