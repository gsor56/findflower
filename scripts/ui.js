
(function () {
    'use strict';

    function esc(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
        });
    }

    function cardLink(plant) {
        var link = plant.link || '';
        if (/^https?:\/\//i.test(link)) {
            return { href: link, attrs: ' target="_blank" rel="noopener noreferrer"' };
        }
        if (/^\/species\?/.test(link)) return { href: link, attrs: '' };
        return { href: '/species?name=' + encodeURIComponent(plant.name || ''), attrs: '' };
    }

    function placeholderTile(name) {
        var initial = esc(String(name || '?').trim().charAt(0).toUpperCase() || '?');
        return '<div class="w-full h-full flex items-center justify-center bg-sage-50">' +
            '<span class="text-3xl font-serif text-sage-500 select-none" aria-hidden="true">' + initial + '</span>' +
            '</div>';
    }

    function plantCardHTML(plant) {
        if (!plant || !plant.name) return '';
        var l = cardLink(plant);
        var media = plant.img
            ? '<img src="' + esc(plant.img) + '" alt="' + esc(plant.name) + '" loading="lazy" decoding="async" ' +
                   'class="w-full h-full object-cover group-hover:scale-[1.03] transition-transform duration-500 ease-out" ' +
                   'onerror="var a=this.closest(\'article\'); if(a) a.remove();">'
            : placeholderTile(plant.name);

        return '' +
        '<article class="ff-card group fade-in bg-white border border-neutral-200 rounded-lg overflow-hidden transition-shadow duration-300"' +
            (plant.qid ? ' data-qid="' + esc(plant.qid) + '"' : '') + '>' +
            '<a href="' + esc(l.href) + '"' + l.attrs + ' class="block">' +
                '<div class="aspect-[4/5] bg-neutral-100 overflow-hidden">' + media + '</div>' +
                '<div class="p-3.5 sm:p-4">' +
                    '<h2 class="font-medium text-sm sm:text-base text-neutral-900 leading-snug italic truncate" title="' + esc(plant.name) + '">' + esc(plant.name) + '</h2>' +
                    (plant.family ? '<p class="text-xs text-neutral-400 mt-1 truncate">' + esc(plant.family) + '</p>' : '') +
                '</div>' +
            '</a>' +
        '</article>';
    }

    function generatePlantCard(plantData) {
        var html = plantCardHTML(plantData);
        if (!html) return null;
        var t = document.createElement('template');
        t.innerHTML = html;
        return t.content.firstElementChild;
    }

    function appendPlantCards(grid, plants) {
        if (!grid || !plants || !plants.length) return 0;
        var html = plants.map(plantCardHTML).filter(Boolean);
        if (!html.length) return 0;
        grid.insertAdjacentHTML('beforeend', html.join(''));
        return html.length;
    }


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

    function renderResultDetails(data, opts) {
        var o = opts || {};
        var doc = o.root || document;
        var pick = function (id) { return doc.getElementById(id); };
        if (!data) return;

        var unknown = (typeof window.FF_SPECIES_UNKNOWN === 'string')
            ? window.FF_SPECIES_UNKNOWN : 'Not documented in the source article.';

        var famEl = pick('resFamily');
        if (famEl && data.family) famEl.textContent = data.family;

        var binEl = pick('resBinomial');
        if (binEl) {
            var bin = data.binomial || data.description || '';
            if (bin) { binEl.textContent = bin; binEl.classList.remove('hidden'); }
            else binEl.classList.add('hidden');
        }

        if (data.sunlight !== undefined) setFact(pick('factSun'), data.sunlight, unknown);
        if (data.growthHabit !== undefined) setFact(pick('factHabit'), data.growthHabit, unknown);
        if (data.grow !== undefined) setFact(pick('factGrow'), data.grow, unknown);
        if (data.range !== undefined) setFact(pick('factRange'), data.range, unknown);
        if (data.toxic !== undefined) setFact(pick('factToxic'), data.toxic, unknown);

        var waterEl = pick('factWater');
        if (waterEl && data.moistureUse !== undefined) {
            setFact(waterEl, moistureText(data.moistureUse), unknown);
        }

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

        var attrEl = pick('resAttribution');
        if (attrEl) {
            attrEl.textContent = data.trefle
                ? 'Sources: Wikipedia, Trefle (trefle.io)'
                : (data.attribution || 'Source: Wikipedia');
        }
    }

    function moistureText(m) {
        if (m === null || m === undefined || typeof m !== 'number') return '';
        if (m >= 8) return 'High water use. Keep the soil consistently moist.';
        if (m >= 5) return 'Moderate water use. Water when the top of the soil dries.';
        if (m >= 3) return 'Low water use. Let the soil dry between waterings.';
        return 'Very low water use. Drought tolerant once established.';
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
