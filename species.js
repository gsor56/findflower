(function () {
    'use strict';

    const UNKNOWN = 'Not documented in the source article.';
    const CACHE_PREFIX = 'ff_species_';

    function ffCleanName(name) {
        return String(name || '').replace(/\?+$/, '').trim();
    }

    function capitalizeFirst(s) {
        return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
    }

    function toTitle(name) {
        const n = ffCleanName(name);
        return n.charAt(0).toUpperCase() + n.slice(1);
    }

    function emptyInfo(name) {
        const clean = ffCleanName(name);
        return {
            title: toTitle(clean),
            queryName: clean,
            summary: '',
            binomial: '',
            description: '',
            family: '',
            image: '',
            articleUrl: 'https://en.wikipedia.org/w/index.php?search=' + encodeURIComponent(clean),
            range: '',
            toxic: '',
            grow: '',
            attribution: '',
            related: [],
            found: false,
            growthHabit: '',
            sunlight: '',
            edibleNote: '',
            trefle: false,
            isToxic: false,
            lookalikeUrl: '',
            lookalikeName: ''
        };
    }

    let _trefleMapPromise = null;
    function loadTrefleMap() {
        if (_trefleMapPromise) return _trefleMapPromise;
        _trefleMapPromise = (async () => {
            try {
                const cached = sessionStorage.getItem('ff_trefle_map');
                if (cached) return JSON.parse(cached);
            } catch (e) { }
            try {
                const res = await fetch('trefle-data.json');
                if (!res.ok) return {};
                const map = await res.json();
                try { sessionStorage.setItem('ff_trefle_map', JSON.stringify(map)); } catch (e) { }
                return map;
            } catch (e) {
                return {};
            }
        })();
        return _trefleMapPromise;
    }

    async function mergeTrefle(name, info, prefetched) {
        let rec = prefetched || null;
        if (!rec) {
            try {
                const map = await loadTrefleMap();
                rec = map && map[ffCleanName(name).toLowerCase()];
            } catch (e) { rec = null; }
        }

        if (!rec && window.ffApi && typeof ffApi.fetchTrefleDetails === 'function') {
            try {
                const primary = info.binomial || ffCleanName(name);
                rec = await ffApi.fetchTrefleDetails(primary, { hint: ffCleanName(name) });
            } catch (e) {
                rec = null;
            }
        }
        if (!rec) return;

        info.trefle = true;
        if (rec.growthHabit) info.growthHabit = rec.growthHabit;
        if (rec.sunlight) info.sunlight = rec.sunlight;
        if (typeof rec.moistureUse === 'number') info.moistureUse = rec.moistureUse;
        if (!info.family && rec.family) info.family = rec.family;
        if (!info.binomial && rec.matchedName) info.binomial = rec.matchedName;
        if (!info.image && rec.image) {
            info.image = rec.image;
            info.originalImage = rec.image;
            info.attribution = info.attribution
                ? info.attribution + ' · Image: Trefle / PlantNet'
                : 'Image: Trefle / PlantNet';
        }
        if (rec.edible === true) {
            const parts = (rec.ediblePart && rec.ediblePart.length)
                ? ' (' + rec.ediblePart.join(', ') + ')' : '';
            info.edibleNote = 'Trefle records this plant as edible' + parts + '. Always confirm before consumption.';
        }

        if (rec.toxicity) {
            const trefleMsg = 'Trefle rates toxicity as “' + rec.toxicity + '”.';
            const wikidataSaysToxic = /poison|toxic|harmful|irritant/i.test(info.toxic || '');
            const trefleSaysToxic = !/^\s*(none|non[- ]?toxic|no)\b/i.test(rec.toxicity);
            if (info.toxic && (wikidataSaysToxic !== trefleSaysToxic)) {
                info.toxic = 'Sources differ. ' + info.toxic + ' ' + trefleMsg +
                    ' Treat as potentially harmful and verify with an expert.';
                info.toxicConflict = true;
            } else if (!info.toxic) {
                info.toxic = trefleMsg + ' Always verify with an expert before contact or consumption.';
            }
        }
    }

    function cacheGet(name) {
        try {
            const raw = sessionStorage.getItem(CACHE_PREFIX + ffCleanName(name).toLowerCase());
            return raw ? JSON.parse(raw) : null;
        } catch (e) { return null; }
    }
    function cacheSet(name, info) {
        try {
            sessionStorage.setItem(CACHE_PREFIX + ffCleanName(name).toLowerCase(), JSON.stringify(info));
        } catch (e) { }
    }

    function extractWikidata(json, qid, info) {
        const ent = json.entities && json.entities[qid];
        if (!ent) return;
        const claims = ent.claims || {};

        const taxon = claims.P225 && claims.P225[0] &&
            claims.P225[0].mainsnak && claims.P225[0].mainsnak.datavalue &&
            claims.P225[0].mainsnak.datavalue.value;
        if (taxon) info.binomial = taxon;

        const parent = claims.P171 && claims.P171[0] && claims.P171[0].mainsnak &&
            claims.P171[0].mainsnak.datavalue && claims.P171[0].mainsnak.datavalue.value;
        if (parent && parent.id) info._parentQid = parent.id;

        const rank = claims.P105 && claims.P105[0] && claims.P105[0].mainsnak &&
            claims.P105[0].mainsnak.datavalue && claims.P105[0].mainsnak.datavalue.value;
        if (rank && rank.id) info._rankQid = rank.id;

        const P1552 = claims.P1552 || [];
        const toxicIds = new Set(['Q183560', 'Q42005', 'Q29017529']);
        const hasToxicClaim = P1552.some(c =>
            c.mainsnak && c.mainsnak.datavalue && c.mainsnak.datavalue.value &&
            toxicIds.has(c.mainsnak.datavalue.value.id));
        if (hasToxicClaim) {
            info.toxic = 'Wikidata flags this plant as poisonous. Confirm with an expert before any contact or consumption.';
        }
    }

    function deriveFromText(info) {
        const text = info.summary || '';
        const lower = text.toLowerCase();

        const nativeMatch = text.match(/native to ([^.]+)\./i);
        if (!info.range && nativeMatch) info.range = capitalizeFirst(nativeMatch[1].trim());

        if (!info.family) {
            const famMatch = text.match(/famil(?:y|ies)\s+([A-Z][a-z]+aceae)/);
            if (famMatch) info.family = famMatch[1];
        }

        if (!info.toxic) {
            if (/\b(toxic|poison|poisonous|harmful if|irritant)\b/.test(lower)) {
                info.toxic = 'The article mentions toxicity or irritant properties. Treat as potentially harmful and verify with an expert.';
            } else if (/\b(edible|non-toxic|nontoxic|used in cooking|culinary)\b/.test(lower)) {
                info.toxic = 'The article suggests edible or non-toxic use, but always confirm before consumption.';
            }
        }

        if (!info.grow) {
            const growMatch = text.match(/[^.]*\b(full sun|partial shade|well-drained|moist soil|temperate|tropical|subtropical|hardy|drought|loam|humus)\b[^.]*\./i);
            if (growMatch) info.grow = capitalizeFirst(growMatch[0].trim());
        }
    }

    async function fetchRelatedAndFamily(selfQid, parentQid, selfTitle, limit) {
        if (!selfQid && !parentQid) return { related: [], family: '' };
        const unionParts = [];
        if (selfQid) unionParts.push('{ ?item wdt:P171 wd:' + selfQid + ' . }');
        if (parentQid) unionParts.push('{ ?item wdt:P171 wd:' + parentQid + ' . }');
        const familyBind = selfQid
            ? 'OPTIONAL { wd:' + selfQid + ' wdt:P171* ?family . ?family wdt:P105 wd:Q35409 . }'
            : '';
        const query =
            'SELECT ?item ?itemLabel ?familyLabel WHERE {' +
            '  ' + unionParts.join(' UNION ') +
            '  ?article schema:about ?item ; schema:isPartOf <https://en.wikipedia.org/> .' +
            '  ' + familyBind +
            '  SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }' +
            '} LIMIT ' + (limit + 12);
        const url = 'https://query.wikidata.org/sparql?format=json&query=' + encodeURIComponent(query);
        try {
            const res = await fetch(url, { headers: { 'Accept': 'application/sparql-results+json' } });
            if (!res.ok) return { related: [], family: '' };
            const data = await res.json();
            const rows = (data.results && data.results.bindings) || [];
            const seen = new Set();
            const out = [];
            let family = '';
            for (const r of rows) {
                if (!family && r.familyLabel && r.familyLabel.value && !/^Q\d+$/.test(r.familyLabel.value)) {
                    family = r.familyLabel.value;
                }
                const label = r.itemLabel && r.itemLabel.value;
                const qid = r.item && r.item.value && r.item.value.split('/').pop();
                if (!label || !qid) continue;
                if (/^Q\d+$/.test(label)) continue;
                if (label.toLowerCase() === (selfTitle || '').toLowerCase()) continue;
                if (seen.has(label.toLowerCase())) continue;
                seen.add(label.toLowerCase());
                out.push({ name: label, qid });
                if (out.length >= limit) break;
            }
            return { related: out, family };
        } catch (e) {
            return { related: [], family: '' };
        }
    }

    async function fetchSummary(title) {
        try {
            const res = await fetch('https://en.wikipedia.org/api/rest_v1/page/summary/' + encodeURIComponent(title));
            if (!res.ok) return null;
            const d = await res.json();
            if (d.type === 'disambiguation' || !d.extract) return null;
            return d;
        } catch (e) {
            return null;
        }
    }

    function applySummary(info, d, fallbackTitle) {
        info.found = true;
        info.title = d.title || fallbackTitle;
        info.summary = d.extract || '';
        info.description = d.description || '';
        if (d.content_urls && d.content_urls.desktop && d.content_urls.desktop.page) {
            info.articleUrl = d.content_urls.desktop.page;
        }
        if (d.thumbnail && d.thumbnail.source) {
            info.image = d.thumbnail.source;
            info.originalImage = (d.originalimage && d.originalimage.source) || d.thumbnail.source;
            info.attribution = 'Image & text: Wikipedia / Wikimedia Commons (CC BY-SA)';
        } else {
            info.attribution = 'Text: Wikipedia (CC BY-SA)';
        }
        return d.wikibase_item || null;
    }

    async function ffFetchSpecies(name, opts) {
        opts = opts || {};
        const clean = ffCleanName(name);

        const cached = cacheGet(clean);
        if (cached && (!opts.related || cached._enriched)) {
            return cached;
        }

        const info = emptyInfo(clean);
        const title = info.title;

        let qid = null;
        const summary = await fetchSummary(title);
        if (summary) {
            qid = applySummary(info, summary, title);
        }

        let trefleRec = null;
        if (!summary && window.ffApi && typeof ffApi.fetchTrefleDetails === 'function') {
            try {
                trefleRec = await ffApi.fetchTrefleDetails(clean);
            } catch (e) {
                trefleRec = null;
            }
            if (trefleRec && trefleRec.matchedName &&
                trefleRec.matchedName.toLowerCase() !== clean.toLowerCase()) {
                const second = await fetchSummary(trefleRec.matchedName);
                if (second) qid = applySummary(info, second, trefleRec.matchedName);
            }
        }

        if (!summary && !trefleRec) {
            info.attribution = 'Source: Wikipedia';
            cacheSet(clean, info);
            return info;
        }

        if (qid) {
            try {
                const wres = await fetch('https://www.wikidata.org/wiki/Special:EntityData/' + qid + '.json');
                if (wres.ok) extractWikidata(await wres.json(), qid, info);
            } catch (e) { }
        }

        deriveFromText(info);

        await mergeTrefle(clean, info, trefleRec);

        if (opts.related) {
            const extra = await fetchRelatedAndFamily(qid, info._parentQid, info.title, 8);
            info.related = extra.related;
            if (extra.family) info.family = extra.family;
            info._enriched = true;
        }

        deriveSafetyFlags(info);

        cacheSet(clean, info);
        return info;
    }

    const LOOKALIKES = {
        'daffodil':        { name: 'Wild onion / ramps', toxic: true,
            url: 'https://upload.wikimedia.org/wikipedia/commons/thumb/9/93/Allium_ursinum_-_K%C3%B6hler%E2%80%93s_Medizinal-Pflanzen-016.jpg/640px-Allium_ursinum_-_K%C3%B6hler%E2%80%93s_Medizinal-Pflanzen-016.jpg' },
        'foxglove':        { name: 'Comfrey', toxic: true,
            url: 'https://upload.wikimedia.org/wikipedia/commons/thumb/1/1e/Symphytum_officinale_-_harilik_varemerohi.jpg/640px-Symphytum_officinale_-_harilik_varemerohi.jpg' },
        'lily of the valley': { name: 'Wild garlic', toxic: true,
            url: 'https://upload.wikimedia.org/wikipedia/commons/thumb/9/93/Allium_ursinum_-_K%C3%B6hler%E2%80%93s_Medizinal-Pflanzen-016.jpg/640px-Allium_ursinum_-_K%C3%B6hler%E2%80%93s_Medizinal-Pflanzen-016.jpg' },
        'monkshood':       { name: 'Wild parsnip', toxic: true,
            url: 'https://upload.wikimedia.org/wikipedia/commons/thumb/e/e4/Pastinaca_sativa_-_harilik_naeris.jpg/640px-Pastinaca_sativa_-_harilik_naeris.jpg' },
        'oleander':        { name: 'Bay laurel', toxic: true,
            url: 'https://upload.wikimedia.org/wikipedia/commons/thumb/4/4c/Laurus_nobilis_kz01.jpg/640px-Laurus_nobilis_kz01.jpg' },
        'buttercup':       { name: 'Marsh marigold', toxic: true,
            url: 'https://upload.wikimedia.org/wikipedia/commons/thumb/6/6a/Caltha_palustris_LC0059.jpg/640px-Caltha_palustris_LC0059.jpg' },
        'hydrangea':       { name: 'Viburnum', toxic: true,
            url: 'https://upload.wikimedia.org/wikipedia/commons/thumb/5/5c/Viburnum_opulus_-_harilik_lodjapuu.jpg/640px-Viburnum_opulus_-_harilik_lodjapuu.jpg' }
    };

    const TOXIC_CLAIM = /\b(poison|poisonous|toxic|toxicity|harmful|irritant|do not ingest)\b/i;
    const TOXIC_NEGATED = /\b(non[- ]?toxic|nontoxic|not (?:known to be )?(?:toxic|poisonous)|edible)\b/i;

    function deriveSafetyFlags(info) {
        const prose = info.toxic || '';
        const claimed = TOXIC_CLAIM.test(prose);
        const negatedOnly = TOXIC_NEGATED.test(prose) && !/\b(poison|irritant)\b/i.test(prose);
        info.isToxic = claimed && !negatedOnly;

        const key = (info.queryName || '').toLowerCase();
        const match = LOOKALIKES[key];
        if (match) {
            info.lookalikeUrl = match.url || '';
            info.lookalikeName = match.name || '';
            if (match.toxic === true) info.isToxic = true;
        }
        return info;
    }

    window.ffCleanName = ffCleanName;
    window.ffFetchSpecies = ffFetchSpecies;
    window.ffDeriveSafetyFlags = deriveSafetyFlags;
    window.FF_LOOKALIKES = LOOKALIKES;
    window.FF_SPECIES_UNKNOWN = UNKNOWN;
})();
