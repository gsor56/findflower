
(function () {
    'use strict';

    var PROXY = 'https://findflower-proxy.fofi.workers.dev';

    var TREFLE_PAGE_SIZE = 20;

    var FLOWER_FAMILIES = [
        'Asteraceae', 'Rosaceae', 'Orchidaceae', 'Fabaceae', 'Lamiaceae',
        'Ranunculaceae', 'Liliaceae', 'Iridaceae', 'Malvaceae', 'Brassicaceae',
        'Apocynaceae', 'Ericaceae', 'Amaryllidaceae', 'Caryophyllaceae',
        'Solanaceae', 'Primulaceae', 'Papaveraceae', 'Violaceae',
        'Campanulaceae', 'Onagraceae',
    ];

    class TrefleUnavailableError extends Error {
        constructor(message) {
            super(message);
            this.name = 'TrefleUnavailableError';
        }
    }

    function lightToText(light) {
        if (light === null || light === undefined) return null;
        if (light >= 9) return 'Full sun';
        if (light >= 7) return 'Full sun to light shade';
        if (light >= 5) return 'Partial shade';
        if (light >= 3) return 'Shade to partial shade';
        return 'Full shade';
    }

    function looksLikeTrefle(body) {
        return !!body && typeof body === 'object' && 'data' in body;
    }

    async function apiFetch(path, opts) {
        var o = opts || {};
        var res;
        try {
            res = await fetch(PROXY + path, { headers: { Accept: 'application/json' } });
        } catch (e) {
            throw new TrefleUnavailableError('Trefle proxy unreachable (' + e.message + ').');
        }
        if (res.status === 404 && o.pastEnd) {
            var text = '';
            try { text = await res.text(); } catch (e) { }
            if (/expected :page in/.test(text) || /\bpage\b/i.test(text)) return null;
            throw new TrefleUnavailableError('Trefle proxy answered 404.');
        }
        if (!res.ok) {
            throw new TrefleUnavailableError('Trefle proxy answered ' + res.status + '.');
        }

        var body;
        try {
            body = await res.json();
        } catch (e) {
            throw new TrefleUnavailableError('Trefle proxy answered 200 with non-JSON.');
        }

        if (!looksLikeTrefle(body)) {
            var seen = Object.keys(body || {}).slice(0, 4).join(',') || typeof body;
            throw new TrefleUnavailableError(
                'Trefle proxy answered 200 without a data field (got: ' + seen + ') — ' +
                'the deployed Worker is probably missing the /trefle/ route.');
        }
        return body;
    }

    function trefleCard(r) {
        var name = (r && (r.common_name || r.scientific_name)) || '';
        if (!name) return null;
        return {
            qid: null,
            name: name,
            family: r.family || null,
            img: r.image_url || null,
            link: '/species?name=' + encodeURIComponent(name),
        };
    }

    async function fetchTrefleBatch(page, opts) {
        var o = opts || {};
        var p = Math.max(1, parseInt(page, 10) || 1);
        var fams = (o.families === undefined) ? FLOWER_FAMILIES : o.families;
        var q = '/trefle/plants?page=' + p;
        if (fams && fams.length) {
            q += '&filter%5Bfamily_name%5D=' + encodeURIComponent(fams.join(','));
        }
        var body = await apiFetch(q, { pastEnd: true });
        if (!body) return { items: [], hasMore: false };

        var items = (body.data || []).map(trefleCard).filter(Boolean);

        var links = body.links || {}, meta = body.meta || {};
        var hasMore = Boolean(links.next) ||
            (typeof meta.total === 'number' && p * TREFLE_PAGE_SIZE < meta.total);

        return { items: items, hasMore: hasMore };
    }

    async function fetchTrefleDetails(speciesName, opts) {
        var o = opts || {};
        var tries = [];
        if (speciesName && String(speciesName).trim()) tries.push(String(speciesName).trim());
        if (o.hint && String(o.hint).trim()) tries.push(String(o.hint).trim());
        if (!tries.length) return null;

        var first = null;
        for (var i = 0; i < tries.length && !first; i++) {
            if (i && tries[i].toLowerCase() === tries[0].toLowerCase()) continue;
            var s = await apiFetch('/trefle/plants/search?q=' + encodeURIComponent(tries[i]) + '&page=1');
            first = (s.data || [])[0] || null;
        }
        if (!first) return null;

        var d = await apiFetch('/trefle/plants/' + encodeURIComponent(first.id));
        var rec = (d.data) || {};
        var ms = rec.main_species || {};
        var g = ms.growth || {};
        var spec = ms.specifications || {};
        var light = (typeof g.light === 'number') ? g.light : null;

        return {
            trefleId: first.id,
            matchedName: first.scientific_name || null,
            family: ms.family || rec.family || null,
            growthHabit: spec.growth_habit || null,
            lightIndex: light,
            sunlight: lightToText(light),
            moistureUse: (typeof g.moisture_use === 'number') ? g.moisture_use : null,
            atmosphericHumidity: (typeof g.atmospheric_humidity === 'number') ? g.atmospheric_humidity : null,
            edible: (typeof ms.edible === 'boolean') ? ms.edible : null,
            ediblePart: (ms.edible_part && ms.edible_part.length) ? ms.edible_part : null,
            toxicity: (spec.toxicity && String(spec.toxicity).trim()) ? String(spec.toxicity).trim() : null,
            image: first.image_url || rec.image_url || null,
            source: 'Trefle (trefle.io)',
        };
    }

    async function searchSpecies(query, opts) {
        var o = opts || {};
        var q = String(query || '').trim();
        if (!q) return { items: [] };
        var body = await apiFetch('/trefle/plants/search?q=' + encodeURIComponent(q) + '&page=1');
        var items = (body.data || []).map(trefleCard).filter(Boolean);
        var limit = (typeof o.limit === 'number') ? o.limit : 8;
        return { items: limit > 0 ? items.slice(0, limit) : items };
    }

    var WDQS = 'https://query.wikidata.org/sparql';

    var WIKIDATA_CHUNK = 96;

    var WD_FAMILIES = [
        'wd:Q25400',
        'wd:Q46299',
        'wd:Q25308',
        'wd:Q44448',
        'wd:Q53476',
        'wd:Q145869',
        'wd:Q53480',
        'wd:Q155941',
        'wd:Q156551',
        'wd:Q156888',
        'wd:Q173756',
        'wd:Q975872',
        'wd:Q155848',
        'wd:Q25995',
        'wd:Q134172',
        'wd:Q157115',
        'wd:Q144723',
        'wd:Q156060',
        'wd:Q155802',
        'wd:Q156179',
    ].join(' ');

    function buildWikidataQuery(limit, offset) {
        return 'SELECT ?item ?itemLabel ?img ?article ?famLabel WHERE {\n' +
            '  VALUES ?fam { ' + WD_FAMILIES + ' }\n' +
            '  ?genus wdt:P171 ?fam .\n' +
            '  ?item wdt:P171 ?genus ;\n' +
            '        wdt:P105 wd:Q7432 ;\n' +
            '        wdt:P18 ?img .\n' +
            '  OPTIONAL { ?article schema:about ?item ; schema:isPartOf <https://en.wikipedia.org/> . }\n' +
            '  SERVICE wikibase:label { bd:serviceParam wikibase:language "en" }\n' +
            '}\n' +
            'ORDER BY ?item\n' +
            'LIMIT ' + limit + ' OFFSET ' + offset;
    }

    function commonsThumb(url, width) {
        try {
            var m = decodeURIComponent(url).match(/Special:FilePath\/(.+)$/);
            if (!m) return url;
            return 'https://commons.wikimedia.org/wiki/Special:FilePath/' +
                encodeURIComponent(m[1]) + '?width=' + (width || 500);
        } catch (e) { return url; }
    }

    function normalizeWikidataRows(rows, width) {
        var out = [];
        for (var i = 0; i < rows.length; i++) {
            var r = rows[i];
            if (!r.item || !r.img) continue;
            var qid = r.item.value.split('/').pop();
            var label = r.itemLabel ? r.itemLabel.value : '';
            if (!label || /^Q\d+$/.test(label)) continue;
            out.push({
                qid: qid,
                name: label,
                family: r.famLabel ? r.famLabel.value : '',
                img: commonsThumb(r.img.value, width),
                link: r.article ? r.article.value : ('https://www.wikidata.org/wiki/' + qid),
            });
        }
        return out;
    }

    async function fetchWikidataBatch(offset, opts) {
        var o = opts || {};
        var at = Math.max(0, parseInt(offset, 10) || 0);
        var url = WDQS + '?format=json&query=' +
            encodeURIComponent(buildWikidataQuery(WIKIDATA_CHUNK, at));
        var res = await fetch(url, { headers: { Accept: 'application/sparql-results+json' } });
        if (!res.ok) throw new Error('WDQS ' + res.status);
        var data = await res.json();
        var rows = (data.results && data.results.bindings) || [];
        return {
            items: normalizeWikidataRows(rows, o.thumbWidth || 500),
            hasMore: rows.length >= WIKIDATA_CHUNK,
            nextOffset: at + WIKIDATA_CHUNK,
        };
    }

    window.ffApi = {
        TrefleUnavailableError: TrefleUnavailableError,
        fetchTrefleBatch: fetchTrefleBatch,
        fetchTrefleDetails: fetchTrefleDetails,
        searchSpecies: searchSpecies,
        fetchWikidataBatch: fetchWikidataBatch,
    };
})();
