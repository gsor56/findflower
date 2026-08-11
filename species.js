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
            trefle: false,
            // --- Safety / comparison model -------------------------------
            // `toxic` above is prose from Wikidata/Trefle/Wikipedia and stays
            // the authoritative explanation. `isToxic` is the boolean the UI
            // switches the red badge on, derived from that prose by
            // deriveSafetyFlags() so there is only ever one source of truth.
            //
            // NOTE: false means "no toxicity claim was found", NOT "safe".
            // Absence of evidence is not evidence of edibility, and the badge
            // copy must never imply otherwise.
            isToxic: false,
            // Reference photo of the most-confused lookalike, for the
            // side-by-side comparison slider. Empty string = no comparison.
            lookalikeUrl: '',
            lookalikeName: ''
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

    // Merge Trefle fields into an info object. Never blocks the page: any
    // missing field simply stays empty so the UI shows the honest fallback.
    //
    // Three sources, in order:
    //   1. `prefetched` — a record ffFetchSpecies already pulled while trying
    //      to resolve a common name into a binomial (step 2b). Passing it in
    //      is what stops the same species being looked up twice per page.
    //   2. trefle-data.json — prefetched at build time, ~40 seed species, free
    //      and instant. Covers the common scans.
    //   3. the live API via the Cloudflare proxy (scripts/api.js) — reached
    //      only when the static map misses, so the long tail of species gets
    //      care data too. Costs one request, so the result is cached with the
    //      rest of the species entry.
    //
    // The live call is strictly additive: if api.js is not on the page, or the
    // proxy has no TREFLE_TOKEN, or Trefle is down, the merge simply does
    // nothing and the panel renders from Wikidata alone.
    async function mergeTrefle(name, info, prefetched) {
        let rec = prefetched || null;
        if (!rec) {
            try {
                const map = await loadTrefleMap();
                rec = map && map[ffCleanName(name).toLowerCase()];
            } catch (e) { rec = null; }
        }

        // Static map missed — ask the live API, if it is available here.
        if (!rec && window.ffApi && typeof ffApi.fetchTrefleDetails === 'function') {
            try {
                // Prefer the binomial: Trefle indexes scientific names, so
                // "Rosa canina" resolves where "dog rose" may not. The plain
                // name is passed as the hint, because the reverse also happens:
                // Trefle carries "Nonesuch" as a common name for Medicago
                // lupulina while Wikipedia's page for it is a disambiguation
                // and yields no binomial at all.
                const primary = info.binomial || ffCleanName(name);
                rec = await ffApi.fetchTrefleDetails(primary, { hint: ffCleanName(name) });
            } catch (e) {
                rec = null; // unreachable/unconfigured — Wikidata still stands
            }
        }
        if (!rec) return;

        // From here the code is source-agnostic: fetchTrefleDetails returns the
        // same record shape trefle-data.json holds, deliberately, so the
        // toxicity-conflict and edibility rules below have ONE implementation.
        // Those rules are safety logic — a second copy that drifts is how a
        // "sources differ" warning quietly stops appearing.
        info.trefle = true;
        // Growth habit + sunlight are the reliably-populated Trefle extras.
        if (rec.growthHabit) info.growthHabit = rec.growthHabit;
        if (rec.sunlight) info.sunlight = rec.sunlight;
        // moisture_use is a 0–10 index, not a schedule; the renderer phrases it
        // (ffUi.moistureText). 0 is a meaningful value, so test for a number.
        if (typeof rec.moistureUse === 'number') info.moistureUse = rec.moistureUse;
        // Family: Wikidata wins; Trefle fills the gap only if we have nothing.
        if (!info.family && rec.family) info.family = rec.family;
        // Binomial: same rule. When Wikipedia handed us a disambiguation page
        // there is no P225 taxon name, and Trefle's matched scientific name is
        // the only thing standing between the visitor and a nameless profile.
        if (!info.binomial && rec.matchedName) info.binomial = rec.matchedName;
        // Photo: only ever a fallback. A Wikipedia thumbnail is chosen for the
        // article and is the better image when it exists; Trefle's PlantNet
        // photo is what keeps the profile from showing a broken frame when
        // Wikipedia has no illustration.
        if (!info.image && rec.image) {
            info.image = rec.image;
            info.originalImage = rec.image;
            info.attribution = info.attribution
                ? info.attribution + ' · Image: Trefle / PlantNet'
                : 'Image: Trefle / PlantNet';
        }
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

    // ---- Wikipedia REST summary -------------------------------------------
    // Split out of ffFetchSpecies so it can be called twice: once for the name
    // the visitor arrived with, and again for a binomial that Trefle resolved
    // when the first title turned out to be a disambiguation page.
    // Returns the parsed payload, or null when there is no usable article.
    async function fetchSummary(title) {
        try {
            const res = await fetch('https://en.wikipedia.org/api/rest_v1/page/summary/' + encodeURIComponent(title));
            if (!res.ok) return null;
            const d = await res.json();
            // A disambiguation page has no species facts in it, and its extract
            // is a list of unrelated meanings — worse than nothing.
            if (d.type === 'disambiguation' || !d.extract) return null;
            return d;
        } catch (e) {
            return null;
        }
    }

    // Copy a Wikipedia summary payload onto an info object.
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
        const summary = await fetchSummary(title);
        if (summary) {
            qid = applySummary(info, summary, title);
        }

        // 2b · No usable article under that title. This is the common name /
        //      disambiguation case, and it used to end the lookup here: the
        //      profile rendered with a broken image frame and every fact reading
        //      "Not documented in the source article."
        //
        //      Measured example — a directory card for "Nonesuch" (a Trefle
        //      common name for Medicago lupulina):
        //        /page/summary/Nonesuch -> type:"disambiguation" -> gave up
        //        Trefle /plants/search?q=Nonesuch -> Medicago lupulina, id 51834,
        //          Fabaceae, Forb/herb, light 7, and a PlantNet photo
        //        /page/summary/Medicago lupulina -> a full article with a photo
        //
        //      So Trefle is asked to translate the common name into a binomial,
        //      and Wikipedia is asked again under that name. Two extra requests
        //      on a path that previously produced an empty page; none at all on
        //      the happy path, because this only runs when the first title
        //      missed.
        let trefleRec = null;
        if (!summary && window.ffApi && typeof ffApi.fetchTrefleDetails === 'function') {
            try {
                trefleRec = await ffApi.fetchTrefleDetails(clean);
            } catch (e) {
                trefleRec = null; // unreachable/unconfigured — nothing lost
            }
            if (trefleRec && trefleRec.matchedName &&
                trefleRec.matchedName.toLowerCase() !== clean.toLowerCase()) {
                const second = await fetchSummary(trefleRec.matchedName);
                if (second) qid = applySummary(info, second, trefleRec.matchedName);
            }
        }

        // Still nothing from Wikipedia OR Trefle: cache the honest empty result
        // so repeated views don't re-request, and let the caller fall back.
        if (!summary && !trefleRec) {
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

        // 4b · Trefle extras (growth habit, sunlight, edibility, a photo when
        //      Wikipedia has none, and a toxicity cross-check). The record
        //      fetched in 2b is reused so the same species is never looked up
        //      twice in one call.
        await mergeTrefle(clean, info, trefleRec);

        // 5 · Related data (detail page only): family (chain-walked) + related taxa.
        if (opts.related) {
            const extra = await fetchRelatedAndFamily(qid, info._parentQid, info.title, 8);
            info.related = extra.related;
            // Prefer the chain-walked family; keep any text-derived family as fallback.
            if (extra.family) info.family = extra.family;
            info._enriched = true;
        }

        // 5b · Safety flags + lookalike reference for the result UI.
        deriveSafetyFlags(info);

        // 6 · Cache for the session and return.
        cacheSet(clean, info);
        return info;
    }

    // ---- Safety flags & lookalikes -----------------------------------------
    //
    // Species most often mistaken for one another, where getting it wrong has a
    // real cost. Keyed by the cleaned lowercase label the model emits.
    //
    // `toxic: true` here is a hard override for plants whose danger is well
    // established, so the badge does not depend on whether Wikipedia happened
    // to use the word "poisonous" in its opening paragraph. Entries without a
    // `toxic` key leave the derived value alone.
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

    // Wording that constitutes a real toxicity claim. Deliberately excludes the
    // reassuring sentences deriveFromText() can produce ("suggests edible or
    // non-toxic use"), which would otherwise trip the badge on the word "toxic".
    const TOXIC_CLAIM = /\b(poison|poisonous|toxic|toxicity|harmful|irritant|do not ingest)\b/i;
    const TOXIC_NEGATED = /\b(non[- ]?toxic|nontoxic|not (?:known to be )?(?:toxic|poisonous)|edible)\b/i;

    /* Set info.isToxic and attach any known lookalike. Pure derivation over
       data already on `info` plus the table above — no network. */
    function deriveSafetyFlags(info) {
        const prose = info.toxic || '';
        // A sentence can contain both ("sources differ"): a live claim wins,
        // because under-warning is the costlier error for a plant ID app.
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

    // ---- Export as globals (auth.js style; no bundler) ----
    window.ffCleanName = ffCleanName;
    window.ffFetchSpecies = ffFetchSpecies;
    window.ffDeriveSafetyFlags = deriveSafetyFlags;
    window.FF_LOOKALIKES = LOOKALIKES;
    window.FF_SPECIES_UNKNOWN = UNKNOWN;
})();
