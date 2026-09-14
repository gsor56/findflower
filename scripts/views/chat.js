// One conversation, rendered from the server and kept fresh by the live stream.
//
// The page arrives with its newest twenty messages already in the markup, so the
// first paint is the conversation rather than a spinner. Everything after that
// is either a page of older messages the reader asked for, or a push from
// /api/events when the other person writes.
(function () {
    'use strict';
    var $ = function (id) { return document.getElementById(id); };
    var state = { handle: '', page: 1, hasMore: false, messages: [], index: Object.create(null) };

    function esc(v) {
        return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
        });
    }

    function handleFromUrl() {
        try { return (new URLSearchParams(location.search).get('with') || '').toLowerCase().replace(/^@/, ''); }
        catch (e) { return ''; }
    }

    function note(text) { var e = $('chatNote'); if (e) { e.textContent = text || ''; e.classList.toggle('hidden', !text); } }
    function loading(on) { var e = $('chatLoading'); if (e) e.classList.toggle('hidden', !on); }
    function when(iso) { var d = new Date(iso); return isNaN(d) ? '' : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }); }

    function mine(m) {
        return !!(window.ffSocial && m.sender && m.sender.id === window.ffSocial.viewerId());
    }

    function bubble(m) {
        var who = mine(m) ? 'You' : ((m.sender && (m.sender.displayName || m.sender.handle)) || 'User');
        var reportBtn = mine(m) ? '' : '<button type="button" class="ff-chat-report text-xs text-neutral-400 hover:text-neutral-900 transition" data-msg-id="' + esc(m.id) + '" data-sender="' + esc((m.sender && (m.sender.handle || m.sender.id)) || '') + '" title="Report this message"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/><line x1="4" y1="22" x2="4" y2="15"/></svg></button>';
        return '<li data-message-id="' + esc(m.id) + '" class="border border-black rounded-none p-3 '
            + (mine(m) ? 'bg-[#f2f5f2]' : 'bg-white') + '">'
            + '<div class="flex justify-between gap-3"><span class="text-xs font-medium uppercase">' + esc(who) + '</span>'
            + '<div class="flex items-center gap-3">' + reportBtn
            + '<time class="text-xs text-neutral-500">' + esc(when(m.createdAt)) + '</time></div></div>'
            + '<p class="text-sm leading-relaxed mt-2 whitespace-pre-wrap break-words">' + esc(m.content) + '</p></li>';
    }

    /** Nearest scrollable ancestor, or the document. The page is the scroller
     *  today; this keeps the behaviour right if the conversation ever moves into
     *  a fixed-height panel. */
    function scroller() {
        var host = $('chatMessages');
        var node = host ? host.parentElement : null;
        while (node && node !== document.body) {
            var style = window.getComputedStyle(node);
            if (/(auto|scroll)/.test(style.overflowY) && node.scrollHeight > node.clientHeight) return node;
            node = node.parentElement;
        }
        return document.scrollingElement || document.documentElement;
    }

    function atBottom(slop) {
        var el = scroller();
        return el.scrollHeight - el.scrollTop - el.clientHeight < (slop || 80);
    }

    function scrollToBottom() {
        var el = scroller();
        try { el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' }); }
        catch (e) { el.scrollTop = el.scrollHeight; }
    }

    function paintEmpty() {
        var empty = $('chatEmpty');
        if (empty) empty.classList.toggle('hidden', state.messages.length > 0);
    }

    function renderMessages() {
        var host = $('chatMessages');
        if (!host) return;
        host.innerHTML = state.messages.map(bubble).join('');
        paintEmpty();
    }

    /** Add one message unless it is already on screen. The sender sees their own
     *  message twice otherwise: once from the POST response and once from the
     *  broadcast the server made to both participants. */
    function append(m) {
        if (!m || !m.id || state.index[m.id]) return false;
        state.index[m.id] = true;
        state.messages.push(m);
        var host = $('chatMessages');
        if (!host) return false;
        var stick = atBottom();
        host.insertAdjacentHTML('beforeend', bubble(m));
        paintEmpty();
        if (stick) scrollToBottom();
        return true;
    }

    function seed(rows) {
        state.messages = [];
        state.index = Object.create(null);
        (rows || []).forEach(function (m) {
            if (!m || !m.id || state.index[m.id]) return;
            state.index[m.id] = true;
            state.messages.push(m);
        });
    }

    async function loadMessages(older) {
        if (!older) loading(true);
        note('');
        try {
            var r = await window.ffSocial.messages(state.handle, { page: older ? state.page + 1 : 1, limit: 20 });
            if (!r.ok) throw new Error(r.error || 'Conversation unavailable.');
            state.page = older ? state.page + 1 : 1;
            state.hasMore = !!r.data.hasMore;
            var rows = r.data.messages || [];
            if (older) {
                // Older rows go in front and keep their order; the ids already on
                // screen are skipped so a message that arrived live between the
                // two fetches is not duplicated.
                var keep = state.messages;
                seed(rows.concat(keep));
            } else {
                seed(rows);
            }
            var title = $('chatTitle');
            if (title && r.data.with) title.textContent = r.data.with.displayName || ('@' + state.handle);
            var handle = $('chatHandle');
            if (handle) handle.textContent = '@' + state.handle;
            renderMessages();
            if (!older) scrollToBottom();
            $('chatMore') && $('chatMore').classList.toggle('hidden', !state.hasMore);
            if (window.ffNotifications) window.ffNotifications.refresh();
        } catch (e) {
            note(e.message || 'Could not load this conversation.');
        }
        loading(false);
    }

    /** Does this broadcast belong to the conversation on screen? */
    function belongs(payload) {
        if (!payload || !payload.message) return false;
        var other = payload.from && payload.from.handle ? payload.from.handle : null;
        var target = payload.to && payload.to.handle ? payload.to.handle : null;
        var me = (window.ffSocial && window.ffSocial.viewerHandle()) || null;
        var peer = state.handle;
        if (!other || !target) return false;
        // The pair is (me, peer) in either direction.
        return (other === peer && (!me || target === me)) || (target === peer && (!me || other === me));
    }

    function listenLive() {
        if (!window.ffLive) return;
        window.ffLive.on('message', function (payload) {
            if (!belongs(payload)) {
                if (window.ffNotifications) window.ffNotifications.refresh();
                return;
            }
            if (append(payload.message) && window.ffNotifications) window.ffNotifications.refresh();
        });
    }

    async function init() {
        if (!window.ffSocial) return;
        state.handle = handleFromUrl();
        if (!state.handle) { location.replace('/notifications'); return; }

        // The server already rendered this page's first page of messages into
        // the markup; take them as the starting state so nothing is fetched
        // twice before the reader has seen anything.
        var ssr = window.__FF_SSR__ && window.__FF_SSR__.page === 'chat' ? window.__FF_SSR__.data : null;
        if (ssr && Array.isArray(ssr.messages) && ssr.messages.length) {
            seed(ssr.messages);
            state.hasMore = !!ssr.hasMore;
            scrollToBottom();
        }

        listenLive();

        var up = await window.ffSocial.probe(true, 5000);
        if (!up) { note('Community service is unavailable.'); return; }
        var signedIn = typeof window.ffIsAuthenticated === 'function'
            ? await window.ffIsAuthenticated().catch(function () { return false; })
            : false;
        if (!signedIn) { note('Sign in to open this conversation.'); return; }
        var me = await window.ffSocial.me();
        if (!me.ok) { note(me.error || 'Sign in to open this conversation.'); return; }
        await loadMessages(false);
    }

    var FF_MSG_WARN_KEY = 'ff_msg_warning_seen';

    function _msgWarnSeen() {
        try { return localStorage.getItem(FF_MSG_WARN_KEY) === '1'; } catch (e) { return false; }
    }

    function _msgWarnGate() {
        return new Promise(function (resolve) {
            var existing = document.getElementById('ffMsgWarnDialog');
            if (existing) existing.remove();
            var dlg = document.createElement('dialog');
            dlg.id = 'ffMsgWarnDialog';
            dlg.className = 'w-full max-w-sm p-0 border border-black bg-white backdrop:bg-black/30';
            dlg.innerHTML =
                '<div class="p-5">' +
                '<h2 class="text-sm font-medium text-neutral-900 mb-2">Safety check</h2>' +
                '<p class="text-sm text-neutral-600 leading-relaxed mb-4">' +
                'You are responsible for what you post. Harassment, illegal content, or dangerous plant advice will result in an immediate ban. ' +
                '<a href="/terms#ugc" class="underline text-neutral-900" target="_blank">Review the full terms</a>.' +
                '</p>' +
                '<div class="flex items-center justify-end gap-2">' +
                '<button type="button" id="ffMsgWarnCancel" class="text-sm text-neutral-500 hover:text-neutral-900 px-3 py-2 transition">Cancel</button>' +
                '<button type="button" id="ffMsgWarnContinue" class="text-sm font-medium bg-neutral-900 text-white border border-black rounded-none px-4 py-2 hover:bg-neutral-800 transition">Continue sending</button>' +
                '</div></div>';
            document.body.appendChild(dlg);
            dlg.querySelector('#ffMsgWarnCancel').addEventListener('click', function () { dlg.close(); resolve(false); });
            dlg.querySelector('#ffMsgWarnContinue').addEventListener('click', function () {
                try { localStorage.setItem(FF_MSG_WARN_KEY, '1'); } catch (e) {}
                dlg.close();
                resolve(true);
            });
            dlg.addEventListener('close', function () { dlg.remove(); });
            dlg.showModal();
        });
    }

    document.addEventListener('DOMContentLoaded', function () {
        var more = $('chatMore');
        if (more) more.addEventListener('click', function () { loadMessages(true); });

        var msgs = $('chatMessages');
        if (msgs) msgs.addEventListener('click', function (ev) {
            var btn = ev.target.closest('.ff-chat-report');
            if (!btn) return;
            var dlg = document.getElementById('ffChatReportDialog');
            if (!dlg || typeof dlg.showModal !== 'function') return;
            dlg.dataset.msgId = btn.dataset.msgId || '';
            dlg.dataset.sender = btn.dataset.sender || '';
            var radios = dlg.querySelectorAll('input[name="ffChatReportReason"]');
            radios.forEach(function (r) { r.checked = false; });
            var detail = dlg.querySelector('#ffChatReportDetail');
            if (detail) detail.value = '';
            var submit = dlg.querySelector('#ffChatReportSubmit');
            if (submit) submit.disabled = true;
            dlg.showModal();
        });

        var dlg = document.getElementById('ffChatReportDialog');
        if (dlg) {
            var reasons = dlg.querySelector('#ffChatReportReasons');
            var submitBtn = dlg.querySelector('#ffChatReportSubmit');
            var cancelBtn = dlg.querySelector('#ffChatReportCancel');
            if (reasons && submitBtn) {
                reasons.addEventListener('change', function () {
                    submitBtn.disabled = !dlg.querySelector('input[name="ffChatReportReason"]:checked');
                });
            }
            if (cancelBtn) {
                cancelBtn.addEventListener('click', function () { dlg.close(); });
            }
            dlg.querySelector('form').addEventListener('submit', async function (ev) {
                ev.preventDefault();
                var checked = dlg.querySelector('input[name="ffChatReportReason"]:checked');
                if (!checked) return;
                var reason = checked.value;
                var detail = (dlg.querySelector('#ffChatReportDetail') || {}).value || '';
                detail = detail.trim();
                if (detail) reason = reason + ': ' + detail;
                var sender = dlg.dataset.sender || '';
                var msgId = dlg.dataset.msgId || '';
                if (sender) reason = '[user:' + sender + '] [msg:' + msgId + '] ' + reason;
                dlg.close();
                if (!window.ffSocial || !window.ffSocial.reportPost) {
                    note('Could not send that report.');
                    return;
                }
                var rp = await window.ffSocial.reportPost(state.handle, reason);
                note(rp.ok ? 'Reported. Thank you.' : (rp.error || 'That report did not send.'));
            });
        }

        var form = $('chatForm');
        if (form) form.addEventListener('submit', async function (e) {
            e.preventDefault();
            var box = $('chatBody'), text = box.value.trim();
            if (!text) return;
            if (!_msgWarnSeen()) {
                var ok = await _msgWarnGate();
                if (!ok) return;
            }
            var btn = $('chatSend');
            btn.disabled = true;
            var r = await window.ffSocial.sendMessage(state.handle, text);
            btn.disabled = false;
            if (!r.ok) { note(r.error); return; }
            box.value = '';
            append(r.data.message);
            scrollToBottom();
            box.focus();
        });

        init();
    });
})();
