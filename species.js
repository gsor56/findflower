/* ============================================================================
   FindFlower — shared species data module (species.js)
   ----------------------------------------------------------------------------
   Client-side only. No backend, no local database. Fetches live botanical
   context from the Wikipedia REST API and (when needed) Wikidata, normalizes
   it into a single `info` object, and caches per species in sessionStorage so
   revisiting a species during the session costs zero network calls.

   Used by try.html (after a photo identification), directory.html (grid cards),
   and species.html (standalone detail via ?name=). This file holds DATA logic
   only — each page owns its own rendering so the module stays reusable.

   Public API (attached to window):
     • ffCleanName(name)            → tidy a raw class/label into a query string
     • ffFetchSpecies(name, opts)   → Promise<info>  (opts.related pulls family
                                       + sibling species from Wikidata)

   The `info` object shape:
     { title, summary, binomial, description, family, image, articleUrl,
       range, toxic, grow, attribution, related: [{ name, qid }],
       growthHabit, sunlight, edibleNote, trefle }

   Botanical extras (growth habit, sunlight, edibility) come from Trefle, but
   the Trefle API can't be called from the browser (no CORS header on GET) and
   can't hold a token on a static site — so those fields are prefetched at
   build time (tools/build-trefle.js → trefle-data.json) and merged here from
   that same-origin file.

   Honesty contract: toxicity is reported from Wikidata poison claims first,
   then explicit article wording, otherwise the UNKNOWN fallback — we never
   imply "safe" by omission. If Trefle ever supplies a conflicting toxicity
   value, BOTH sources are shown rather than silently choosing one. Trefle's
   `edible:false` is treated as unknown (it's an unreliable false-negative);
   only an affirmative `edible:true` is surfaced.
   ========================================================================== */
(function () {
    'use strict';

    const UNKNOWN = 'Not documented in the source article.';
    const CACHE_PREFIX = 'ff_species_';

    // Tidy a raw class label / query into a Wikipedia-friendly string.
    function ffCleanName(name) {
        return String(name || '').replace(/\?+$/, '').trim();
    }

    function capitalizeFirst(s) {
        return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
    }

    // Wikipedia titles are case-sensitive after the first letter; upper-case
    // only the first character and leave the rest as given.
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
            // Trefle-sourced extras (populated by mergeTrefle when available).
            growthHabit: '',
            sunlight: '',
            edibleNote: '',
            trefle: false
        };
    }

    // ---- Trefle build-time data (trefle-data.json, same-origin) -------------
    // The Trefle API blocks browser calls (no CORS header on GET) and can't
    // hold a token safely on a static site, so botanical extras are prefetched
    // at build time (tools/build-trefle.js) into trefle-data.json. Here we just
    // load that static file once and merge. Memoized in-memory AND mirrored to
    // sessionStorage so it costs one request per session, not per page.
    let _trefleMapPromise = null;
    function loadTrefleMap() {
        if (_trefleMapPromise) return _trefleMapPromise;
        _trefleMapPromise = (async () => {
            // Session cache first (same pattern as species entries).
            try {
                const cached = sessionStorage.getItem('ff_trefle_map');
                if (cached) return JSON.parse(cached);
            } catch (e) { /* ignore */ }
            try {
                const res = await fetch('trefle-data.json');
                if (!res.ok) return {};
                const map = await res.json();
                try { sessionStorage.setItem('ff_trefle_map', JSON.stringify(map)); } catch (e) { /* ignore */ }
                return map;
            } catch (e) {
                return {}; // file missing / offline — graceful: no extras, no error
            }
        })();
        return _trefleMapPromise;
    }

    // Merge prefetched Trefle fields into an info object. Never blocks the page:
    // any missing field simply stays empty so the UI shows the honest fallback.
    async function mergeTrefle(name, info) {
        let rec = null;
        try {
            const map = await loadTrefleMap();
            rec = map && map[ffCleanName(name).toLowerCase()];
        } catch (e) { rec = null; }
        if (!rec) return;

        info.trefle = true;
        // Growth habit + sunlight are the reliably-populated Trefle extras.
        if (rec.growthHabit) info.growthHabit = rec.growthHabit;
        if (rec.sunlight) info.sunlight = rec.sunlight;
        // Family: Wikidata wins; Trefle fills the gap only if we have nothing.
        if (!info.family && rec.family) info.family = rec.family;
        // Edibility: Trefle's `edible:false` is an unreliable false-negative
        // (it flags dandelion & sunflower as inedible), so only surface an
        // affirmative "edible" — never assert inedibility from Trefle.
        if (rec.edible === true) {
            const parts = (rec.ediblePart && rec.ediblePart.length)
                ? ' (' + rec.ediblePart.join(', ') + ')' : '';
            info.edibleNote = 'Trefle records this plant as edible' + parts + '. Always confirm before consumption.';
        }

        // Toxicity cross-check. Wikidata is our primary source (info.toxic).
        // If Trefle also carries a toxicity value and the two disagree, show
        // BOTH rather than silently picking one. (In practice Trefle's toxicity
        // is currently empty for every seed species, so this rarely fires — but
        // the honest-conflict handling is here for when it does.)
        if (rec.toxicity) {
            const trefleMsg = 'Trefle rates toxicity as “' + rec.toxicity + '”.';
            const wikidataSaysToxic = /poison|toxic|harmful|irritant/i.test(info.toxic || '');
            const trefleSaysToxic = !/^\s*(none|non[- ]?toxic|no)\b/i.test(rec.toxicity);
            if (info.toxic && (wikidataSaysToxic !== trefleSaysToxic)) {
                // Conflict — present both sources side by side.
                info.toxic = 'Sources differ. ' + info.toxic + ' ' + trefleMsg +
                    ' Treat as potentially harmful and verify with an expert.';
                info.toxicConflict = true;
            } else if (!info.toxic) {
                // Wikidata silent, Trefle has something — surface Trefle's value.
                info.toxic = trefleMsg + ' Always verify with an expert before contact or consumption.';
            }
        }
    }

    // ---- sessionStorage cache (shared key across every FindFlower page) ----
    function cacheGet(name) {
        try {
            const raw = sessionStorage.getItem(CACHE_PREFIX + ffCleanName(name).toLowerCase());
            return raw ? JSON.parse(raw) : null;
        } catch (e) { return null; }
    }
    function cacheSet(name, info) {
        try {
            sessionStorage.setItem(CACHE_PREFIX + ffCleanName(name).toLowerCase(), JSON.stringify(info));
        } catch (e) { /* storage may be unavailable — continue */ }
    }

    // ---- Wikidata: structured claims (binomial, toxicity, family, genus) ----
    function extractWikidata(json, qid, info) {
        const ent = json.entities && json.entities[qid];
        if (!ent) return;
        const claims = ent.claims || {};

        // Binomial / scientific name (P225 "taxon name").
        const taxon = claims.P225 && claims.P225[0] &&
            claims.P225[0].mainsnak && claims.P225[0].mainsnak.datavalue &&
            claims.P225[0].mainsnak.datavalue.value;
        if (taxon) info.binomial = taxon;

        // Parent taxon (P171) — used both for the family label and to find
        // sibling species for the "Related Plants" section.
        const parent = claims.P171 && claims.P171[0] && claims.P171[0].mainsnak &&
            claims.P171[0].mainsnak.datavalue && claims.P171[0].mainsnak.datavalue.value;
        if (parent && parent.id) info._parentQid = parent.id;

        // Taxon rank (P105) — helps label what this entity is.
        const rank = claims.P105 && claims.P105[0] && claims.P105[0].mainsnak &&
            claims.P105[0].mainsnak.datavalue && claims.P105[0].mainsnak.datavalue.value;
        if (rank && rank.id) info._rankQid = rank.id;

        // Toxicity signal: "has quality" (P1552) referencing a poison/toxic
        // entity. Surface a cautious, clearly-sourced note only when present.
        const P1552 = claims.P1552 || [];
        const toxicIds = new Set(['Q183560', 'Q42005', 'Q29017529']); // poison / toxicity / poisonous plant
        const hasToxicClaim = P1552.some(c =>
            c.mainsnak && c.mainsnak.datavalue && c.mainsnak.datavalue.value &&
            toxicIds.has(c.mainsnak.datavalue.value.id));
        if (hasToxicClaim) {
            info.toxic = 'Wikidata flags this plant as poisonous. Confirm with an expert before any contact or consumption.';
        }
    }

    // ---- Text heuristics: fill gaps Wikidata doesn't cover, conservatively ----
    function deriveFromText(info) {
        const text = info.summary || '';
        const lower = text.toLowerCase();

        // Native range — "native to ..." up to the sentence end.
        const nativeMatch = text.match(/native to ([^.]+)\./i);
        if (!info.range && nativeMatch) info.range = capitalizeFirst(nativeMatch[1].trim());

        // Family — "family Xaceae" or "in the family Xaceae".
        if (!info.family) {
            const famMatch = text.match(/famil(?:y|ies)\s+([A-Z][a-z]+aceae)/);
            if (famMatch) info.family = famMatch[1];
        }

        // Toxicity — only from explicit wording, and only if Wikidata didn't
        // already set it. Otherwise leave blank so the UI shows the honest
        // fallback rather than implying "safe".
        if (!info.toxic) {
            if (/\b(toxic|poison|poisonous|harmful if|irritant)\b/.test(lower)) {
                info.toxic = 'The article mentions toxicity or irritant properties. Treat as potentially harmful and verify with an expert.';
            } else if (/\b(edible|non-toxic|nontoxic|used in cooking|culinary)\b/.test(lower)) {
                info.toxic = 'The article suggests edible or non-toxic use, but always confirm before consumption.';
            }
        }

        // Growing conditions — a sentence mentioning sun/soil/climate cues.
        if (!info.grow) {
            const growMatch = text.match(/[^.]*\b(full sun|partial shade|well-drained|moist soil|temperate|tropical|subtropical|hardy|drought|loam|humus)\b[^.]*\./i);
            if (growMatch) info.grow = capitalizeFirst(growMatch[0].trim());
        }
    }

    // ---- Related plants + family, in a single Wikidata SPARQL query ----
    // Fired only when a caller asks for related data (the detail page).
    //   • Related: taxa whose parent taxon (P171) is EITHER this entity (its
    //     child species — best for a genus page) OR this entity's parent (its
    //     siblings — best for a species page). Union covers both cases so the
    //     section is populated whether the article is a genus or a species.
    //   • Family: walk the parent-taxon chain transitively (P171*) up to the
    //     taxon whose rank (P105) is "family" (Q35409) — so a genus whose
    //     immediate parent is a tribe still resolves to its true family.
    // Returns { related: [{ name, qid }], family: '' }.
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
                if (/^Q\d+$/.test(label)) continue; // unlabelled entity — skip
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

    // ============================================================
    //  ffFetchSpecies — the shared entry point.
    //  opts.related === true also pulls family label + sibling
    //  species (one extra Wikidata request each), used by the
    //  detail page. Directory cards and try.html omit it so the
    //  common case is a single Wikipedia summary request.
    // ============================================================
    async function ffFetchSpecies(name, opts) {
        opts = opts || {};
        const clean = ffCleanName(name);

        // 1 · Session cache. Only reuse it if it already satisfies this call's
        //     needs (a summary-only cache entry is upgraded when related data
        //     is later requested by the detail page).
        const cached = cacheGet(clean);
        if (cached && (!opts.related || cached._enriched)) {
            return cached;
        }

        const info = emptyInfo(clean);
        const title = info.title;

        // 2 · Wikipedia REST summary (one request).
        let qid = null;
        try {
            const sres = await fetch('https://en.wikipedia.org/api/rest_v1/page/summary/' + encodeURIComponent(title));
            if (!sres.ok) throw new Error('summary not found');
            const d = await sres.json();
            if (d.type === 'disambiguation' || !d.extract) throw new Error('ambiguous');

            info.found = true;
            info.title = d.title || title;
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
            qid = d.wikibase_item || null;
        } catch (err) {
            // Nothing usable from Wikipedia — cache the honest empty result so
            // repeated views don't re-request, and let the caller fall back.
            info.attribution = 'Source: Wikipedia';
            cacheSet(clean, info);
            return info;
        }

        // 3 · Wikidata enrichment. Always cheap-derives from the summary; only
        //     hits Wikidata when we have a Qid and either need structured facts
        //     or the caller asked for related data.
        if (qid) {
            try {
                const wres = await fetch('https://www.wikidata.org/wiki/Special:EntityData/' + qid + '.json');
                if (wres.ok) extractWikidata(await wres.json(), qid, info);
            } catch (e) { /* Wikidata optional — continue with text-derived facts */ }
        }

        // 4 · Text-derived facts (range, toxicity fallback, growing, family).
        deriveFromText(info);

        // 4b · Trefle build-time extras (growth habit, sunlight, edibility, and
        //      a toxicity cross-check). Same-origin static file — never blocks
        //      the page and never overrides Wikidata toxicity silently.
        await mergeTrefle(clean, info);

        // 5 · Related data (detail page only): family (chain-walked) + related taxa.
        if (opts.related) {
            const extra = await fetchRelatedAndFamily(qid, info._parentQid, info.title, 8);
            info.related = extra.related;
            // Prefer the chain-walked family; keep any text-derived family as fallback.
            if (extra.family) info.family = extra.family;
            info._enriched = true;
        }

        // 6 · Cache for the session and return.
        cacheSet(clean, info);
        return info;
    }

    // ---- Export as globals (auth.js style; no bundler) ----
    window.ffCleanName = ffCleanName;
    window.ffFetchSpecies = ffFetchSpecies;
    window.FF_SPECIES_UNKNOWN = UNKNOWN;
})();
