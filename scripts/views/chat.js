(function () {
    'use strict';
    var $ = function (id) { return document.getElementById(id); };
    var state = { handle: '', page: 1, hasMore: false, messages: [] };
    function esc(v) { return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) { return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]; }); }
    function handleFromUrl() { try { return (new URLSearchParams(location.search).get('with') || '').toLowerCase().replace(/^@/, ''); } catch (e) { return ''; } }
    function note(text) { var e=$('chatNote'); if(e){e.textContent=text||'';e.classList.toggle('hidden',!text);} }
    function loading(on) { var e=$('chatLoading'); if(e)e.classList.toggle('hidden',!on); }
    function when(iso) { var d=new Date(iso); return isNaN(d)?'':d.toLocaleString(undefined,{dateStyle:'medium',timeStyle:'short'}); }
    function renderMessages() {
        var host=$('chatMessages'); if(!host)return;
        host.innerHTML=state.messages.map(function(m){var mine=window.ffSocial && m.sender && m.sender.id===window.ffSocial.viewerId();return '<li class="border border-black rounded-none p-3 '+(mine?'bg-[#f2f5f2]':'bg-white')+'"><div class="flex justify-between gap-3"><span class="text-xs font-medium uppercase">'+esc(mine?'You':(m.sender.displayName||m.sender.handle||'User'))+'</span><time class="text-xs text-neutral-500">'+esc(when(m.createdAt))+'</time></div><p class="text-sm leading-relaxed mt-2 whitespace-pre-wrap break-words">'+esc(m.content)+'</p></li>';}).join('');
        $('chatEmpty').classList.toggle('hidden',state.messages.length>0);
        $('chatMore').classList.toggle('hidden',!state.hasMore);
    }
    async function loadMessages(older) {
        loading(true); note('');
        try {
            var r=await window.ffSocial.messages(state.handle,{page:older?state.page+1:1,limit:20});
            if(!r.ok) throw new Error(r.error||'Conversation unavailable.');
            state.page=older?state.page+1:1; state.hasMore=!!r.data.hasMore;
            state.messages=older?(r.data.messages||[]).concat(state.messages):(r.data.messages||[]);
            $('chatTitle').textContent=r.data.with.displayName||('@'+state.handle);
            $('chatHandle').textContent='@'+state.handle;
            renderMessages();
            if(window.ffNotifications) window.ffNotifications.refresh();
        } catch(e){note(e.message||'Could not load this conversation.');}
        loading(false);
    }
    async function init() {
        if(!window.ffSocial) return;
        state.handle=handleFromUrl();
        if(!state.handle){ location.replace('/notifications'); return; }
        var up=await window.ffSocial.probe(true,5000);
        if(!up){note('Community service is unavailable.');return;}
        var signedIn=typeof window.ffIsAuthenticated==='function'?await window.ffIsAuthenticated().catch(function(){return false;}):false;
        if(!signedIn){note('Sign in to open this conversation.');return;}
        var me=await window.ffSocial.me();
        if(!me.ok){note(me.error||'Sign in to open this conversation.');return;}
        await loadMessages(false);
    }
    document.addEventListener('DOMContentLoaded',function(){
        $('chatMore').addEventListener('click',function(){loadMessages(true);});
        $('chatForm').addEventListener('submit',async function(e){
            e.preventDefault();
            var box=$('chatBody'),text=box.value.trim();
            if(!text)return;
            var btn=$('chatSend');btn.disabled=true;
            var r=await window.ffSocial.sendMessage(state.handle,text);
            btn.disabled=false;
            if(!r.ok){note(r.error);return;}
            box.value='';state.messages.push(r.data.message);renderMessages();
        });
        init();
    });
})();
