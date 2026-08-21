// scripts/api.js — FindFlower data fetcher (client half of the Trefle pivot).
//
// One job: grab data. Rendering lives in scripts/ui.js and in the page
// engines (directory.js, try.html). A page never mixes the two — it calls
// ffApi.fetchTrefleBatch(), hands the items to generatePlantCard(), and
// appends the result.
//
// Why through the proxy: Trefle sends no CORS header and requires a token,
// so a browser on a static site cannot call trefle.io directly. The Worker
// (proxy/worker.js) owns the token, forwards only allowlisted routes, and
// answers 503 with { fallback: true } when Trefle is unavailable. This file
// translates that contract into a typed error so callers can degrade:
//
//     try { const { items, hasMore } = await ffApi.fetchTrefleBatch(page); }
//     catch (e) {
//         if (e instanceof ffApi.TrefleUnavailableError) return wikidataEngine();
//         throw e; // contract break — let the page show an honest failure
//     }
//
// Both catalogues live here — fetchTrefleBatch() and fetchWikidataBatch() —
// and they return the SAME card shape, so ffDirectory.mount() differs only in
// which one it calls and ui.js renders either without knowing the source.
//
// Card contract:
//     { qid, name, family, img, link }
//     qid   — null for Trefle (no Wikidata id), the Wikidata entity for SPARQL
//     name  — common name when Trefle has one, else scientific
//     family — may be null; ui.js hides the line rather than show "Unknown"
//     img   — Trefle list records carry an image_url (PlantNet-hosted) when
//             one exists, else null. Many obscure taxa have none; api.js
//             reports that honestly and leaves the skip-or-placeholder
//             decision to the engine/ui layer. Wikidata images are always
//             Commons THUMBNAILS — the P18 originals are 5–20 MB each.
//     link  — the source link, and it differs by catalogue on purpose:
//             Trefle has no article, so it is /species?name=…, while
//             Wikidata carries the real Wikipedia article URL. Callers that
//             want every card to point inward (the encyclopedia) rewrite it;
//             callers that want to send people to Wikipedia (the dashboard
//             feed, try.html's mini-grid) use it as given.
//
// Details contract (a superset of the record shape trefle-data.json holds, so
// live and prebuilt lookups merge through one path — see mergeTrefle in
// species.js):
//     { trefleId, matchedName, family, growthHabit, lightIndex, sunlight,
//       moistureUse, atmosphericHumidity, edible, ediblePart, toxicity,
//       image, source }
//     image — only live records carry it. tools/build-trefle.js predates the
//             field, so prebuilt entries have no `image` key and species.js
//             falls back to the Wikipedia thumbnail. Consumers must treat it
//             as optional rather than assume every record has a photo.

(function () {
    'use strict';

    var PROXY = 'https://findflower-proxy.fofi.workers.dev';

    // Trefle serves 20 records per list page and does not accept per_page on
    // this route (measured, not assumed). Used only to derive "is there more"
    // from meta.total when links.next is absent.
    var TREFLE_PAGE_SIZE = 20;

    // The same twenty flowering families the Wikidata engine curates to.
    //
    // Without this filter, /plants browses all 437,255 records in Trefle —
    // oaks, grasses, conifers — which is a plant database, not FindFlower's
    // flower encyclopedia. Filtered, it is ~164,000 species across these
    // families (measured), against roughly 5,000 reachable via Wikidata.
    //
    // Note it is filter[family_name], not filter[family]: the latter is
    // silently IGNORED by the API and returns the unfiltered catalogue.
    var FLOWER_FAMILIES = [
        'Asteraceae', 'Rosaceae', 'Orchidaceae', 'Fabaceae', 'Lamiaceae',
        'Ranunculaceae', 'Liliaceae', 'Iridaceae', 'Malvaceae', 'Brassicaceae',
        'Apocynaceae', 'Ericaceae', 'Amaryllidaceae', 'Caryophyllaceae',
        'Solanaceae', 'Primulaceae', 'Papaveraceae', 'Violaceae',
        'Campanulaceae', 'Onagraceae',
    ];

    /** Thrown when Trefle is unreachable, unconfigured (503 fallback), or
     *  the proxy answers non-OK. Callers catch this to fall back to the
     *  Wikidata engine — NOT a bug to show the user, a source to skip.
     *  A real subclass, so `e instanceof ffApi.TrefleUnavailableError` holds. */
    class TrefleUnavailableError extends Error {
        constructor(message) {
            super(message);
            this.name = 'TrefleUnavailableError';
        }
    }

    /** Map Trefle's 0–10 light index to a human sunlight description.
     *  Same ladder as tools/build-trefle.js so live and prebuilt data agree
     *  (the two copies are deliberate — the build script runs in Node). */
    function lightToText(light) {
        if (light === null || light === undefined) return null;
        if (light >= 9) return 'Full sun';
        if (light >= 7) return 'Full sun to light shade';
        if (light >= 5) return 'Partial shade';
        if (light >= 3) return 'Shade to partial shade';
        return 'Full shade';
    }

    /** Does this body look like a Trefle payload at all?
     *
     *  PRODUCTION INCIDENT, 2026-08-10. findflower.me served an empty
     *  encyclopedia while localhost was fine, and the difference was not the
     *  frontend: the DEPLOYED Worker predates the /trefle/ route, so its
     *  catch-all health check answered every Trefle path with
     *  `HTTP 200 {"status":"ok"}`. Measured on both origins:
     *
     *    localhost  -> fetch THREW  -> TrefleUnavailableError -> Wikidata -> 12 cards
     *    live       -> HTTP 200 ok  -> resolved {items:[],hasMore:false} -> 0 cards
     *
     *  A 200 was trusted on status alone, so `body.data || []` produced no
     *  items and `hasMore` came out false, which the engine reads as "the
     *  catalogue is exhausted" — a terminal, successful, empty result. Nothing
     *  threw, so the Wikidata fallback that exists for exactly this case was
     *  never reached, and the page had no error to show either.
     *
     *  So status is not enough: a wrong-shaped 200 is an unavailable source,
     *  not an empty one. Any stale deploy, cached edge response, captive
     *  portal or misrouted path that answers 200 with something else now
     *  degrades to Wikidata instead of silently emptying the grid.
     *
     *  Deliberately a SHAPE check, not an equality check against
     *  `{"status":"ok"}`: the next stale deploy will answer something else. A
     *  Trefle list carries `data` (array) and a record carries `data`
     *  (object); either is enough to prove we are talking to Trefle. */
    function looksLikeTrefle(body) {
        return !!body && typeof body === 'object' && 'data' in body;
    }

    /** Internal fetch: proxy path → response object, or throw.
     *  opts.pastEnd: when set, a 404 whose body says the page is out of range
     *  resolves to null instead of throwing — that is the end of the
     *  catalogue, not a failed source. */
    async function apiFetch(path, opts) {
        var o = opts || {};
        var res;
        try {
            res = await fetch(PROXY + path, { headers: { Accept: 'application/json' } });
        } catch (e) {
            throw new TrefleUnavailableError('Trefle proxy unreachable (' + e.message + ').');
        }
        if (res.status === 404 && o.pastEnd) {
            // Trefle answers `expected :page in 1..8232; got 8233` once you
            // scroll past the last page. Treat it as "no more records" so
            // infinite scroll ends cleanly instead of claiming an outage.
            var text = '';
            try { text = await res.text(); } catch (e) { /* body optional */ }
            if (/expected :page in/.test(text) || /\bpage\b/i.test(text)) return null;
            throw new TrefleUnavailableError('Trefle proxy answered 404.');
        }
        if (!res.ok) {
            // 503+fallback (token unset), 502 (upstream down/error), 404
            // (stale Worker without the route) — all mean "use Wikidata".
            throw new TrefleUnavailableError('Trefle proxy answered ' + res.status + '.');
        }

        // A 200 that is not JSON at all: the proxy is answering with something
        // else entirely (an HTML error page, a captive portal). Same verdict as
        // a 503 — skip the source rather than crash the page with a SyntaxError
        // the engine has no branch for.
        var body;
        try {
            body = await res.json();
        } catch (e) {
            throw new TrefleUnavailableError('Trefle proxy answered 200 with non-JSON.');
        }

        // A 200 with the wrong shape — see looksLikeTrefle. This is the check
        // that would have caught the live outage on the first page load.
        if (!looksLikeTrefle(body)) {
            var seen = Object.keys(body || {}).slice(0, 4).join(',') || typeof body;
            throw new TrefleUnavailableError(
                'Trefle proxy answered 200 without a data field (got: ' + seen + ') — ' +
                'the deployed Worker is probably missing the /trefle/ route.');
        }
        return body;
    }

    /** One Trefle plant record -> the card contract at the top of this file.
     *
     *  Shared by the list route and the search route because they serve the
     *  same `plants` record shape. Named rather than inlined twice: the img
     *  and link rules below are the sort of thing that gets fixed in one copy.
     *  Returns null for a record with neither name -- useless for the species
     *  page, and the same skip-if-unusable rule directory.js applies. */
    function trefleCard(r) {
        var name = (r && (r.common_name || r.scientific_name)) || '';
        if (!name) return null;
        return {
            qid: null,
            name: name,
            family: r.family || null,
            // Verified against the live API: list records do carry an
            // image_url (PlantNet-hosted) when one exists. Reported as
            // null when absent so the engine can skip or placeholder.
            img: r.image_url || null,
            link: '/species?name=' + encodeURIComponent(name),
        };
    }

    /** Encyclopedia list page. Returns { items, hasMore }.
     *  page is 1-based; Trefle serves 20 records per page on this route.
     *  opts.families overrides the curated family filter; pass null for the
     *  whole unfiltered catalogue. */
    async function fetchTrefleBatch(page, opts) {
        var o = opts || {};
        var p = Math.max(1, parseInt(page, 10) || 1);
        var fams = (o.families === undefined) ? FLOWER_FAMILIES : o.families;
        var q = '/trefle/plants?page=' + p;
        if (fams && fams.length) {
            q += '&filter%5Bfamily_name%5D=' + encodeURIComponent(fams.join(','));
        }
        var body = await apiFetch(q, { pastEnd: true });
        // Scrolled past the final page — an empty, terminal result, not an
        // error. The caller stops loading; it must NOT fall back to Wikidata
        // and start the catalogue over from a different source.
        if (!body) return { items: [], hasMore: false };

        var items = (body.data || []).map(trefleCard).filter(Boolean);

        // "Is there a next page?" — links.next is what Trefle v1 actually
        // sends (meta carries only { total }, no total_pages). Derive the
        // page count from total as a backstop, then degrade to "no more".
        var links = body.links || {}, meta = body.meta || {};
        var hasMore = Boolean(links.next) ||
            (typeof meta.total === 'number' && p * TREFLE_PAGE_SIZE < meta.total);

        return { items: items, hasMore: hasMore };
    }

    /** Taxonomy + care record for one species (used after ViT names a flower,
     *  and by species.html when the static trefle-data.json map misses).
     *  Search returns the best match, then the record is pulled by id.
     *  Returns null when Trefle has no record for the name — absence, not
     *  failure; throws TrefleUnavailableError when the source is unreachable.
     *
     *  opts.hint: an alternate name to try when the primary query finds
     *  nothing. species.html passes the page title so a Wikipedia-only common
     *  name ("Nonesuch") still resolves after the binomial lookup misses, and
     *  vice versa. Two cheap search calls beat an empty profile. */
    async function fetchTrefleDetails(speciesName, opts) {
        var o = opts || {};
        var tries = [];
        if (speciesName && String(speciesName).trim()) tries.push(String(speciesName).trim());
        if (o.hint && String(o.hint).trim()) tries.push(String(o.hint).trim());
        if (!tries.length) return null;

        var first = null;
        for (var i = 0; i < tries.length && !first; i++) {
            // Skip a hint that is just the primary query in different case.
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
            // moisture_use is Trefle's watering proxy; frequently absent — kept honest.
            moistureUse: (typeof g.moisture_use === 'number') ? g.moisture_use : null,
            atmosphericHumidity: (typeof g.atmospheric_humidity === 'number') ? g.atmospheric_humidity : null,
            edible: (typeof ms.edible === 'boolean') ? ms.edible : null,
            ediblePart: (ms.edible_part && ms.edible_part.length) ? ms.edible_part : null,
            // Trefle toxicity is a string ('none' | 'low' | 'medium' | 'high') when present.
            toxicity: (spec.toxicity && String(spec.toxicity).trim()) ? String(spec.toxicity).trim() : null,
            // A PlantNet/Trefle-hosted photo. The search hit carries it more
            // reliably than the detail record, so prefer that and fall back.
            image: first.image_url || rec.image_url || null,
            source: 'Trefle (trefle.io)',
        };
    }

    /** Species name search. Returns { items } in the card contract above,
     *  Trefle's own relevance order, capped at opts.limit (default 8).
     *
     *  Separate from fetchTrefleDetails, which answers "tell me about THIS
     *  flower" and throws away everything but the first hit. A palette needs
     *  the list: someone typing "wild" has not decided yet.
     *
     *  Throws TrefleUnavailableError when the proxy or Trefle is unreachable,
     *  like the other two fetchers. Callers must not render that as an empty
     *  result -- "no such flower" and "we could not look" are different
     *  answers, and only one of them is the user's fault. */
    async function searchSpecies(query, opts) {
        var o = opts || {};
        var q = String(query || '').trim();
        if (!q) return { items: [] };
        var body = await apiFetch('/trefle/plants/search?q=' + encodeURIComponent(q) + '&page=1');
        var items = (body.data || []).map(trefleCard).filter(Boolean);
        var limit = (typeof o.limit === 'number') ? o.limit : 8;
        return { items: limit > 0 ? items.slice(0, limit) : items };
    }

    // ====================================================================
    //  Wikidata (WDQS) — the fallback catalogue.
    //
    //  Moved here from directory.js so BOTH catalogues sit behind one
    //  fetcher. Before, the SPARQL half lived in two places: directory.js
    //  for the shared embeds and a near-identical inline copy in
    //  directory.html. Two copies of a query whose ORDER BY is load-bearing
    //  is how the pages drift apart silently.
    // ====================================================================

    var WDQS = 'https://query.wikidata.org/sparql';

    // Rows per SPARQL call — 8 twelve-card batches. Callers get nextOffset
    // back rather than hard-coding this.
    var WIKIDATA_CHUNK = 96;

    // The same twenty families as FLOWER_FAMILIES, as Wikidata entities.
    //
    // Why a family list and not `?item wdt:P31 wd:Q506`: Wikidata models a
    // species as an instance of "taxon" (Q16521) carrying a rank, so only 35
    // entities are direct instances of "flowering plant" — three pages, then
    // nothing. The obvious fix, a transitive `wdt:P171*` walk up to
    // Magnoliophyta, does return 83k species but takes 45–57s per page, which
    // is not a scroll experience. A fixed family set keeps the join small:
    // ~5,000 species at 7–9s per 96-row chunk.
    var WD_FAMILIES = [
        'wd:Q25400',  // Asteraceae
        'wd:Q46299',  // Rosaceae
        'wd:Q25308',  // Orchidaceae
        'wd:Q44448',  // Fabaceae
        'wd:Q53476',  // Lamiaceae
        'wd:Q145869', // Ranunculaceae
        'wd:Q53480',  // Liliaceae
        'wd:Q155941', // Iridaceae
        'wd:Q156551', // Malvaceae
        'wd:Q156888', // Brassicaceae
        'wd:Q173756', // Apocynaceae
        'wd:Q975872', // Ericaceae
        'wd:Q155848', // Amaryllidaceae
        'wd:Q25995',  // Caryophyllaceae
        'wd:Q134172', // Solanaceae
        'wd:Q157115', // Primulaceae
        'wd:Q144723', // Papaveraceae
        'wd:Q156060', // Violaceae
        'wd:Q155802', // Campanulaceae
        'wd:Q156179', // Onagraceae
    ].join(' ');

    /** ORDER BY is not cosmetic: without a total order, LIMIT/OFFSET pages
     *  overlap (measured 37 duplicates across two 96-row pages), so infinite
     *  scroll would repeat cards and silently skip others. */
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

    /** Ask Commons for a scaled thumbnail. P18 originals are routinely
     *  5–20 MB each, which would make a 12-card grid unusable on mobile data. */
    function commonsThumb(url, width) {
        try {
            var m = decodeURIComponent(url).match(/Special:FilePath\/(.+)$/);
            if (!m) return url;
            return 'https://commons.wikimedia.org/wiki/Special:FilePath/' +
                encodeURIComponent(m[1]) + '?width=' + (width || 500);
        } catch (e) { return url; }
    }

    /** SPARQL bindings → the shared card contract.
     *  Note `link` here is the SOURCE link (the Wikipedia article, or the
     *  entity page when there is none), NOT species.html — the caller decides,
     *  because the dashboard and try.html embeds link outward while the
     *  encyclopedia links inward. */
    function normalizeWikidataRows(rows, width) {
        var out = [];
        for (var i = 0; i < rows.length; i++) {
            var r = rows[i];
            if (!r.item || !r.img) continue;
            var qid = r.item.value.split('/').pop();
            var label = r.itemLabel ? r.itemLabel.value : '';
            // An unresolved label falls back to the QID, which is not a species
            // name — drop the row rather than render "Q12345".
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

    /** One SPARQL page. Returns { items, hasMore, nextOffset }.
     *  Throws on a non-OK response — unlike Trefle there is no further
     *  fallback, so the caller shows its error state.
     *  opts.thumbWidth: Commons thumbnail width (default 500). */
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
            // A short chunk is the end of the catalogue. Measured on the row
            // count, not the normalized count: rows dropped for a missing label
            // do not mean the source is spent.
            hasMore: rows.length >= WIKIDATA_CHUNK,
            nextOffset: at + WIKIDATA_CHUNK,
        };
    }

    // NOTE: there is deliberately no merge function here. fetchTrefleDetails
    // returns the same record shape trefle-data.json holds, so species.js's
    // mergeTrefle() consumes live and prebuilt data through one code path.
    // The toxicity-conflict and edibility rules are safety logic; a second
    // copy in this file would be free to drift, and the failure mode is a
    // "sources differ" warning quietly stopping appearing.

    window.ffApi = {
        TrefleUnavailableError: TrefleUnavailableError,
        fetchTrefleBatch: fetchTrefleBatch,
        fetchTrefleDetails: fetchTrefleDetails,
        searchSpecies: searchSpecies,
        fetchWikidataBatch: fetchWikidataBatch,
    };
})();
