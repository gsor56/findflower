/* FindFlower composer: the markdown toolbar on the post box, and the renderer
   that displays what it produced.

   Both halves live in one file on purpose. A toolbar that writes **bold** into a
   feed which renders it as literal asterisks is worse than no toolbar, so the
   only markup the buttons can produce is the markup toHtml() knows how to draw:
   three heading levels, bold, italic, blockquotes, fenced and inline code,
   [species:Name] tags and bare http links. Nothing else in markdown is offered,
   because nothing else would render.

   The renderer never inserts caller HTML. Code spans, species tags and links are
   pulled out into slots before the rest of the text is escaped, then put back as
   built markup -- which is also why a species name keeps its apostrophes instead
   of arriving at encodeURIComponent already HTML-escaped. */
(function () {
    'use strict';

    function esc(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
        });
    }

    var LINK = 'text-sage-600 hover:text-sage-700 underline underline-offset-2';
    var CODE = 'bg-neutral-100 rounded px-1 py-0.5 text-xs font-mono text-neutral-800';

    // inline()'s slot marker, built rather than written as an escape: a
    // control character cannot come from a keyboard and survives esc()
    // untouched, so it cannot collide with anything a writer typed.
    var NUL = String.fromCharCode(0);

    var SPECIES_TAG = /\[species:([^\]\n]{1,80})\]/g;
    var BARE_URL = /https?:\/\/[^\s<>()]+/g;

    /* Inline markup for one run of text. Slots first, escape second, emphasis
       last: emphasis is the only pattern safe to run over escaped text, because
       * and _ survive escaping unchanged. */
    function inline(raw) {
        var slots = [];
        function slot(html) {
            slots.push(html);
            return NUL + (slots.length - 1) + NUL;
        }

        var s = String(raw == null ? '' : raw);
        s = s.replace(/`([^`\n]+)`/g, function (m, code) {
            return slot('<code class="' + CODE + '">' + esc(code) + '</code>');
        });
        s = s.replace(SPECIES_TAG, function (m, name) {
            var n = name.trim();
            if (!n || n.indexOf(NUL) !== -1) return m;
            return slot('<a href="/species?name=' + encodeURIComponent(n) + '" class="' + LINK + '">' +
                esc(n) + '</a>');
        });
        s = s.replace(BARE_URL, function (url) {
            /* A code span or species tag written immediately after a URL leaves its
               slot marker inside this match -- the marker is not whitespace, so the
               URL pattern runs straight through it. Cut there, or the marker ends up
               in the href and its slot never restores. */
            var mark = url.indexOf(NUL);
            var rest = '';
            if (mark !== -1) {
                rest = url.slice(mark);
                url = url.slice(0, mark);
            }
            var trimmed = url.replace(/[.,;:!?]+$/, '');
            var tail = url.slice(trimmed.length);
            return slot('<a href="' + esc(trimmed) + '" rel="nofollow noopener" class="' + LINK + '">' +
                esc(trimmed) + '</a>') + tail + rest;
        });

        s = esc(s);
        s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong class="font-medium text-neutral-900">$1</strong>');
        s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
        return s.replace(new RegExp(NUL + '(\\d+)' + NUL, 'g'), function (m, i) {
            var html = slots[Number(i)];
            return html === undefined ? '' : html;
        });
    }

    var HEAD = [
        'text-base font-medium text-neutral-900',
        'text-sm font-medium text-neutral-900',
        'text-sm font-medium text-neutral-700'
    ];

    /* Block markup. A single newline inside a paragraph becomes a <br> rather
       than being collapsed: these are field notes, and someone who put a
       sighting on its own line meant it to stay there. */
    function toHtml(md) {
        var lines = String(md == null ? '' : md).replace(/\r\n?/g, '\n').split('\n');
        var out = [];
        var para = [];
        var quote = [];

        function flushPara() {
            if (!para.length) return;
            out.push('<p class="mt-2 first:mt-0">' +
                inline(para.join('\n')).replace(/\n/g, '<br>') + '</p>');
            para = [];
        }
        function flushQuote() {
            if (!quote.length) return;
            out.push('<blockquote class="mt-2 first:mt-0 border-l-2 border-neutral-200 pl-3 ' +
                'text-neutral-500">' + inline(quote.join('\n')).replace(/\n/g, '<br>') +
                '</blockquote>');
            quote = [];
        }
        function fenced(lines, i) {
            var buf = [];
            for (i++; i < lines.length && !/^```/.test(lines[i]); i++) buf.push(lines[i]);
            out.push('<pre class="mt-2 first:mt-0 overflow-x-auto bg-neutral-50 border ' +
                'border-neutral-200 rounded p-3"><code class="text-xs font-mono text-neutral-700">' +
                esc(buf.join('\n')) + '</code></pre>');
            return i;
        }

        for (var i = 0; i < lines.length; i++) {
            var line = lines[i];
            if (/^```/.test(line)) {
                flushPara();
                flushQuote();
                i = fenced(lines, i);
                continue;
            }
            var h = /^(#{1,3})\s+(.*)$/.exec(line);
            if (h) {
                flushPara();
                flushQuote();
                var tag = 'h' + (h[1].length + 2);
                out.push('<' + tag + ' class="mt-3 first:mt-0 ' + HEAD[h[1].length - 1] + '">' +
                    inline(h[2]) + '</' + tag + '>');
                continue;
            }
            var q = /^>\s?(.*)$/.exec(line);
            if (q) {
                flushPara();
                quote.push(q[1]);
                continue;
            }
            if (!line.trim()) {
                flushPara();
                flushQuote();
                continue;
            }
            flushQuote();
            para.push(line);
        }
        flushPara();
        flushQuote();
        return out.join('');
    }

    var TOOLS = [
        { id: 'bold', label: 'B', cls: 'font-semibold', name: 'Bold' },
        { id: 'italic', label: 'I', cls: 'italic', name: 'Italic' },
        { id: 'heading', label: 'H', cls: 'font-medium', name: 'Heading' },
        { id: 'quote', label: 'Quote', cls: '', name: 'Blockquote' },
        { id: 'code', label: 'Code', cls: 'font-mono', name: 'Code block' },
        { id: 'species', label: 'Species', cls: '', name: 'Insert a species tag' }
    ];

    var BTN = 'text-xs text-neutral-500 hover:text-neutral-900 hover:bg-neutral-50 border ' +
        'border-neutral-200 rounded px-2 py-1 transition disabled:opacity-40';
    var TAB_ON = 'text-xs font-medium text-neutral-900 bg-neutral-50 border border-neutral-300 ' +
        'rounded px-2 py-1';
    var TAB_OFF = 'text-xs text-neutral-400 hover:text-neutral-900 border border-transparent ' +
        'rounded px-2 py-1 transition';

    function titleCase(s) {
        return String(s || '').replace(/\b\w/g, function (c) { return c.toUpperCase(); });
    }

    /* Names for the species picker, from what this browser already has: the
       prebuilt trefle-data.json records and the species in this device's own
       scan history. The sessionStorage key is species.js's, so a reader who has
       opened a species page this session pays nothing for the first list. */
    var namesPromise = null;
    function speciesNames() {
        if (namesPromise) return namesPromise;
        namesPromise = (async function () {
            var seen = {};
            try {
                var cached = sessionStorage.getItem('ff_trefle_map');
                var map = cached ? JSON.parse(cached) : null;
                if (!map) {
                    var res = await fetch('trefle-data.json');
                    if (res.ok) {
                        map = await res.json();
                        try { sessionStorage.setItem('ff_trefle_map', JSON.stringify(map)); } catch (e) { /* quota */ }
                    }
                }
                Object.keys(map || {}).forEach(function (k) { seen[titleCase(k)] = 1; });
            } catch (e) { /* offline, or a private window: the picker still accepts typing */ }
            try {
                if (window.ffStore && typeof ffStore.listSpecies === 'function') {
                    (await ffStore.listSpecies() || []).forEach(function (n) { seen[titleCase(n)] = 1; });
                }
            } catch (e) { /* blocked storage */ }
            return Object.keys(seen).sort();
        })();
        return namesPromise;
    }

    /* Every edit below goes through this, so the page's own input listeners --
       the character counter, the enabled state of the Post button -- see a
       programmatic edit exactly as they see typing. */
    function fire(box) {
        box.dispatchEvent(new Event('input', { bubbles: true }));
    }

    function wrap(box, before, after) {
        var s = box.selectionStart;
        var e = box.selectionEnd;
        var v = box.value;
        var sel = v.slice(s, e);
        box.value = v.slice(0, s) + before + sel + after + v.slice(e);
        if (sel) {
            box.selectionStart = s + before.length;
            box.selectionEnd = s + before.length + sel.length;
        } else {
            box.selectionStart = box.selectionEnd = s + before.length;
        }
        box.focus();
        fire(box);
    }

    /* Line prefixes toggle. Pressing Quote twice should leave the text as it
       was, not build "> > ". */
    function prefixLines(box, prefix) {
        var v = box.value;
        var start = v.lastIndexOf('\n', box.selectionStart - 1) + 1;
        var end = v.indexOf('\n', box.selectionEnd);
        if (end === -1) end = v.length;
        var lines = v.slice(start, end).split('\n');
        var on = lines.every(function (l) { return l.indexOf(prefix) === 0; });
        var next = lines.map(function (l) {
            return on ? l.slice(prefix.length) : prefix + l;
        }).join('\n');
        box.value = v.slice(0, start) + next + v.slice(end);
        box.selectionStart = start;
        box.selectionEnd = start + next.length;
        box.focus();
        fire(box);
    }

    function fence(box) {
        var v = box.value;
        var s = box.selectionStart;
        var e = box.selectionEnd;
        var open = (s > 0 && v.charAt(s - 1) !== '\n' ? '\n' : '') + '```\n';
        var close = '\n```\n';
        var sel = v.slice(s, e);
        box.value = v.slice(0, s) + open + sel + close + v.slice(e);
        box.selectionStart = box.selectionEnd = s + open.length + sel.length;
        box.focus();
        fire(box);
    }

    function insert(box, text) {
        var s = box.selectionStart;
        box.value = box.value.slice(0, s) + text + box.value.slice(box.selectionEnd);
        box.selectionStart = box.selectionEnd = s + text.length;
        box.focus();
        fire(box);
    }

    var seq = 0;

    /* Puts the toolbar above a textarea and the preview panel below it. The
       textarea itself is left exactly where the page put it, with its id and its
       own listeners intact -- this adds controls, it does not take the box over. */
    function attach(opts) {
        var box = (opts && opts.box) || null;
        if (!box || box.dataset.ffComposer) return null;
        box.dataset.ffComposer = '1';

        var listId = 'ffMdSpecies' + (++seq);

        var bar = document.createElement('div');
        bar.className = 'flex flex-wrap items-center justify-between gap-2 mb-2';
        bar.innerHTML =
            '<div class="flex flex-wrap items-center gap-1">' +
                TOOLS.map(function (t) {
                    return '<button type="button" data-md="' + t.id + '" title="' + esc(t.name) + '" ' +
                        'aria-label="' + esc(t.name) + '" class="' + BTN + ' ' + t.cls + '">' +
                        esc(t.label) + '</button>';
                }).join('') +
            '</div>' +
            '<div class="flex items-center gap-1" role="tablist" aria-label="Composer view">' +
                '<button type="button" role="tab" data-md-tab="write" aria-selected="true" ' +
                    'class="' + TAB_ON + '">Write</button>' +
                '<button type="button" role="tab" data-md-tab="preview" aria-selected="false" ' +
                    'class="' + TAB_OFF + '">Preview</button>' +
            '</div>';

        var picker = document.createElement('div');
        picker.className = 'hidden items-center gap-2 mb-2';
        picker.innerHTML =
            '<label class="sr-only" for="' + listId + 'Field">Species name</label>' +
            '<input type="text" id="' + listId + 'Field" list="' + listId + '" data-md-name ' +
                'placeholder="Species name" autocomplete="off" ' +
                'class="min-w-0 flex-1 text-sm text-neutral-900 placeholder:text-neutral-400 border ' +
                'border-neutral-200 rounded px-3 py-2 focus:outline-none focus:border-neutral-400">' +
            '<datalist id="' + listId + '"></datalist>' +
            '<button type="button" data-md-add class="' + BTN + '">Add tag</button>';

        var preview = document.createElement('div');
        preview.className = 'hidden text-sm text-neutral-700 leading-relaxed border ' +
            'border-neutral-200 rounded p-3';
        preview.setAttribute('role', 'tabpanel');
        preview.style.minHeight = '5.25rem';

        box.parentNode.insertBefore(bar, box);
        box.parentNode.insertBefore(picker, box);
        box.parentNode.insertBefore(preview, box.nextSibling);

        var tabs = bar.querySelectorAll('[data-md-tab]');
        var tools = bar.querySelectorAll('[data-md]');
        var field = picker.querySelector('[data-md-name]');
        var filled = false;

        // hidden and flex are never both set: Tailwind's display utilities are one
        // cascade layer, so which of the two won would depend on their order in a
        // stylesheet this page does not control.
        function showPicker(on) {
            picker.classList.toggle('hidden', !on);
            picker.classList.toggle('flex', on);
        }

        function paintPreview() {
            preview.innerHTML = toHtml(box.value) ||
                '<p class="text-neutral-400">Nothing to preview yet.</p>';
        }

        function setTab(which) {
            var on = which === 'preview';
            for (var i = 0; i < tabs.length; i++) {
                var sel = tabs[i].getAttribute('data-md-tab') === which;
                tabs[i].setAttribute('aria-selected', sel ? 'true' : 'false');
                tabs[i].className = sel ? TAB_ON : TAB_OFF;
            }
            // The buttons edit the textarea, and in preview mode the textarea is
            // not on screen to show what they did.
            for (var j = 0; j < tools.length; j++) tools[j].disabled = on;
            if (on) showPicker(false);
            box.classList.toggle('hidden', on);
            preview.classList.toggle('hidden', !on);
            if (on) paintPreview();
            else box.focus();
        }

        async function togglePicker() {
            var opening = picker.classList.contains('hidden');
            showPicker(opening);
            if (!opening) return;
            field.focus();
            if (filled) return;
            filled = true;
            var names = await speciesNames();
            var list = picker.querySelector('#' + listId);
            if (list) {
                list.innerHTML = names.map(function (n) {
                    return '<option value="' + esc(n) + '"></option>';
                }).join('');
            }
        }

        /* Brackets are stripped rather than escaped: [species:...] has no escape
           for a ] inside it, and a name containing one would end the tag early. */
        function addTag() {
            var name = field.value.trim().replace(/[[\]]/g, '').trim();
            if (!name) { field.focus(); return; }
            insert(box, '[species:' + name + ']');
            field.value = '';
            showPicker(false);
        }

        bar.addEventListener('click', function (e) {
            var tab = e.target.closest('[data-md-tab]');
            if (tab) { setTab(tab.getAttribute('data-md-tab')); return; }
            var btn = e.target.closest('[data-md]');
            if (!btn) return;
            var id = btn.getAttribute('data-md');
            if (id === 'bold') wrap(box, '**', '**');
            else if (id === 'italic') wrap(box, '*', '*');
            else if (id === 'heading') prefixLines(box, '# ');
            else if (id === 'quote') prefixLines(box, '> ');
            else if (id === 'code') fence(box);
            else if (id === 'species') togglePicker();
        });

        picker.addEventListener('click', function (e) {
            if (e.target.closest('[data-md-add]')) addTag();
        });

        // The picker sits inside the post form, where a bare Enter would submit it.
        picker.addEventListener('keydown', function (e) {
            if (e.key === 'Enter') { e.preventDefault(); addTag(); }
            else if (e.key === 'Escape') { showPicker(false); box.focus(); }
        });

        box.addEventListener('keydown', function (e) {
            if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
            var k = String(e.key).toLowerCase();
            if (k === 'b') { e.preventDefault(); wrap(box, '**', '**'); }
            else if (k === 'i') { e.preventDefault(); wrap(box, '*', '*'); }
        });

        // Covers the caller emptying the box after a successful post while the
        // preview is the visible half.
        box.addEventListener('input', function () {
            if (!preview.classList.contains('hidden')) paintPreview();
        });

        function destroy() {
            [bar, picker, preview].forEach(function (el) {
                if (el.parentNode) el.parentNode.removeChild(el);
            });
            box.classList.remove('hidden');
            delete box.dataset.ffComposer;
        }

        return {
            box: box,
            preview: preview,
            setTab: setTab,
            reset: function () { setTab('write'); },
            destroy: destroy
        };
    }

    window.ffComposer = {
        attach: attach,
        toHtml: toHtml,
        inline: inline
    };
})();
