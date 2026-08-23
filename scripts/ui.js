// scripts/ui.js — FindFlower render engine (Step 3 of the pivot).
//
// One job: turn data into DOM. It performs no fetching. scripts/api.js grabs
// the data; this file generates the markup. The split is what lets the
// encyclopedia swap Trefle for Wikidata without touching a line of rendering.
//
//     const { items } = await ffApi.fetchTrefleBatch(page);
//     items.forEach(i => grid.appendChild(ffUi.generatePlantCard(i)));
//
// The card markup here is a deliberate copy of directory.js's cardHTML, not a
// redesign: both sources render through this one function, so a Trefle card
// and a Wikidata card are pixel-identical. If the card look changes, it
// changes here and both sources follow.
//
// Escaping: every interpolated value goes through esc(). These strings are
// built from third-party API text (Trefle common names are user-contributed),
// so an unescaped field is an XSS hole, not a cosmetic bug.

(function () {
    'use strict';

    /** HTML-escape. Same implementation as directory.js:51 — duplicated
     *  rather than imported because directory.js keeps its helpers module-
     *  private, and a shared global would be a wider change than this pivot
     *  needs. */
    function esc(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
        });
    }

    /** Card href + link attributes.
     *  External links (Wikipedia/Wikidata, used by the homepage strip) open in
     *  a new tab and carry rel="noopener"; internal species links do not.
     *  Anything that is not http(s) is refused outright — a javascript: URL
     *  arriving in an API field must never reach an href. */
    function cardLink(plant) {
        var link = plant.link || '';
        if (/^https?:\/\//i.test(link)) {
            return { href: link, attrs: ' target="_blank" rel="noopener noreferrer"' };
        }
        // The clean path api.js now emits. Kept as an explicit allow rather
        // than falling through: the fallback below rebuilds the href from
        // plant.name, which is the same string today and silently would not be
        // if a caller ever passes a link for a name it has already resolved.
        if (/^\/species\?/.test(link)) return { href: link, attrs: '' };
        // No usable link (or a suspicious scheme) — fall back to the species
        // page keyed by name rather than emitting an attacker-controlled href.
        return { href: '/species?name=' + encodeURIComponent(plant.name || ''), attrs: '' };
    }

    /** Neutral tile for a record with no image. Trefle has ~437k plants and
     *  not all carry a photo; a monogram beats a broken-image icon.
     *  Uses sage-200/sage-500, which exist in every page's Tailwind config —
     *  sage-300 does not (the palette skips it), and an undefined Tailwind
     *  colour renders as no colour at all. */
    function placeholderTile(name) {
        var initial = esc(String(name || '?').trim().charAt(0).toUpperCase() || '?');
        return '<div class="w-full h-full flex items-center justify-center bg-sage-50">' +
            '<span class="text-3xl font-serif text-sage-500 select-none" aria-hidden="true">' + initial + '</span>' +
            '</div>';
    }

    /** The card, as an HTML string. Kept separate from the element builder so
     *  a caller batching 20 cards can join strings and do ONE DOM insert
     *  (insertAdjacentHTML) instead of 20 appendChild reflows. */
    function plantCardHTML(plant) {
        if (!plant || !plant.name) return '';
        var l = cardLink(plant);
        var media = plant.img
            ? '<img src="' + esc(plant.img) + '" alt="' + esc(plant.name) + '" loading="lazy" decoding="async" ' +
                   'class="w-full h-full object-cover group-hover:scale-[1.03] transition-transform duration-500 ease-out" ' +
                   // A dead image URL removes its own card rather than leaving
                   // a grey hole in the grid. Same behaviour as directory.js.
                   'onerror="var a=this.closest(\'article\'); if(a) a.remove();">'
            : placeholderTile(plant.name);

        return '' +
        '<article class="ff-card group fade-in bg-white border border-neutral-200 rounded-lg overflow-hidden transition-shadow duration-300"' +
            (plant.qid ? ' data-qid="' + esc(plant.qid) + '"' : '') + '>' +
            '<a href="' + esc(l.href) + '"' + l.attrs + ' class="block">' +
                '<div class="aspect-[4/5] bg-neutral-100 overflow-hidden">' + media + '</div>' +
                '<div class="p-3.5 sm:p-4">' +
                    // Species names get long (and Trefle common names are
                    // user-contributed), so the title is capped at one line
                    // with an ellipsis; the full name stays available on the
                    // tooltip instead of stretching the card.
                    '<h3 class="font-medium text-sm sm:text-base text-neutral-900 leading-snug italic truncate" title="' + esc(plant.name) + '">' + esc(plant.name) + '</h3>' +
                    (plant.family ? '<p class="text-xs text-neutral-400 mt-1 truncate">' + esc(plant.family) + '</p>' : '') +
                '</div>' +
            '</a>' +
        '</article>';
    }

    /** The card, as a DOM element — the signature the brief asks for.
     *  Returns null for an unusable record so callers can .filter(Boolean). */
    function generatePlantCard(plantData) {
        var html = plantCardHTML(plantData);
        if (!html) return null;
        var t = document.createElement('template');
        t.innerHTML = html;
        return t.content.firstElementChild;
    }

    /** Append many cards in a single DOM write. Returns the number rendered. */
    function appendPlantCards(grid, plants) {
        if (!grid || !plants || !plants.length) return 0;
        var html = plants.map(plantCardHTML).filter(Boolean);
        if (!html.length) return 0;
        grid.insertAdjacentHTML('beforeend', html.join(''));
        return html.length;
    }

    // ---- try.html result details -------------------------------------------

    /** Set a fact line, or show the honest "not documented" fallback.
     *  Mirrors try.html's own setFact so the two never drift in styling. */
    function setFact(el, value, unknownText) {
        if (!el) return;
        var v = (value == null) ? '' : String(value);
        if (v.trim()) {
            el.textContent = v.trim();
            el.classList.remove('text-neutral-400', 'italic');
            el.classList.add('text-neutral-700');
        } else {
            el.textContent = unknownText || 'Not documented in the source article.';
            el.classList.remove('text-neutral-700');
            el.classList.add('text-neutral-400', 'italic');
        }
    }

    /** Inject taxonomy + care into the result view.
     *
     *  Additive by design: it fills the care/taxonomy elements when they exist
     *  and leaves everything else (confidence, alternatives, the toxicity
     *  banner, the compare slider) to try.html, which already owns them. A
     *  missing element is skipped silently — pages that do not have the care
     *  block are not broken by calling this.
     *
     *  data is a species-info object (from ffFetchSpecies, already merged with
     *  a Trefle record by species.js's mergeTrefle when one was found). */
    function renderResultDetails(data, opts) {
        var o = opts || {};
        var doc = o.root || document;
        var pick = function (id) { return doc.getElementById(id); };
        if (!data) return;

        var unknown = (typeof window.FF_SPECIES_UNKNOWN === 'string')
            ? window.FF_SPECIES_UNKNOWN : 'Not documented in the source article.';

        // Taxonomy
        var famEl = pick('resFamily');
        if (famEl && data.family) famEl.textContent = data.family;

        var binEl = pick('resBinomial');
        if (binEl) {
            var bin = data.binomial || data.description || '';
            if (bin) { binEl.textContent = bin; binEl.classList.remove('hidden'); }
            else binEl.classList.add('hidden');
        }

        // Care facts. Only paint a field when the data has something to say —
        // an absent Trefle record must not blank out a Wikidata answer.
        if (data.sunlight !== undefined) setFact(pick('factSun'), data.sunlight, unknown);
        if (data.growthHabit !== undefined) setFact(pick('factHabit'), data.growthHabit, unknown);
        if (data.grow !== undefined) setFact(pick('factGrow'), data.grow, unknown);
        if (data.range !== undefined) setFact(pick('factRange'), data.range, unknown);
        if (data.toxic !== undefined) setFact(pick('factToxic'), data.toxic, unknown);

        // Watering: Trefle's moisture_use is a 0–10 index, not a schedule.
        // Phrase it as the relative measure it is rather than inventing days.
        var waterEl = pick('factWater');
        if (waterEl && data.moistureUse !== undefined) {
            setFact(waterEl, moistureText(data.moistureUse), unknown);
        }

        // Affirmative edibility only — Trefle's edible:false is a known
        // false-negative (see mergeTrefle in species.js, which sets edibleNote).
        // The visibility toggle goes on the wrapper when there is one, so the
        // icon hides with the text instead of leaving a bare bullet behind.
        var edibleEl = pick('resEdible');
        if (edibleEl) {
            var edibleBox = pick('resEdibleWrap') || edibleEl;
            if (data.edibleNote) {
                edibleEl.textContent = data.edibleNote;
                edibleBox.classList.remove('hidden');
            } else {
                edibleEl.textContent = '';
                edibleBox.classList.add('hidden');
            }
        }

        // Attribution names every source that contributed.
        var attrEl = pick('resAttribution');
        if (attrEl) {
            attrEl.textContent = data.trefle
                ? 'Sources: Wikipedia, Trefle (trefle.io)'
                : (data.attribution || 'Source: Wikipedia');
        }
    }

    /** Trefle moisture_use (0–10) as plain language. */
    function moistureText(m) {
        if (m === null || m === undefined || typeof m !== 'number') return '';
        if (m >= 8) return 'High water use — keep consistently moist.';
        if (m >= 5) return 'Moderate water use — water when the top of the soil dries.';
        if (m >= 3) return 'Low water use — let the soil dry between waterings.';
        return 'Very low water use — drought tolerant once established.';
    }

    window.ffUi = {
        esc: esc,
        generatePlantCard: generatePlantCard,
        plantCardHTML: plantCardHTML,
        appendPlantCards: appendPlantCards,
        renderResultDetails: renderResultDetails,
        moistureText: moistureText,
    };
})();
