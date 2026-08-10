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
// Card contract (same key set the Wikidata engine in directory.js produces,
// so generatePlantCard handles both sources uniformly):
//     { qid, name, family, img, link }
//     qid   — null for Trefle (no Wikidata id), the Wikidata entity for SPARQL
//     name  — common name when Trefle has one, else scientific
//     family — may be null; ui.js hides the line rather than show "Unknown"
//     img   — Trefle list records carry an image_url (PlantNet-hosted) when
//             one exists, else null. Many obscure taxa have none; api.js
//             reports that honestly and leaves the skip-or-placeholder
//             decision to the engine/ui layer.
//     link  — species.html?name=… ; the species page resolves it either way
//
// Details contract (same record shape trefle-data.json holds, so live and
// prebuilt lookups merge through one path — see mergeTrefle in species.js):
//     { trefleId, matchedName, family, growthHabit, lightIndex, sunlight,
//       moistureUse, atmosphericHumidity, edible, ediblePart, toxicity, source }

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
        // A 200 that is not JSON is a Worker contract break — SyntaxError
        // propagates as-is, distinct from TrefleUnavailableError on purpose.
        return res.json();
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

        var items = (body.data || []).map(function (r) {
            var name = r.common_name || r.scientific_name || '';
            // A record with neither name is useless for the species page —
            // mirror directory.js's skip-if-unusable rule.
            if (!name) return null;
            return {
                qid: null,
                name: name,
                family: r.family || null,
                // Verified against the live API: list records do carry an
                // image_url (PlantNet-hosted) when one exists. Reported as
                // null when absent so the engine can skip or placeholder.
                img: r.image_url || null,
                link: 'species.html?name=' + encodeURIComponent(name),
            };
        }).filter(Boolean);

        // "Is there a next page?" — links.next is what Trefle v1 actually
        // sends (meta carries only { total }, no total_pages). Derive the
        // page count from total as a backstop, then degrade to "no more".
        var links = body.links || {}, meta = body.meta || {};
        var hasMore = Boolean(links.next) ||
            (typeof meta.total === 'number' && p * TREFLE_PAGE_SIZE < meta.total);

        return { items: items, hasMore: hasMore };
    }

    /** Taxonomy + care record for one species (used after ViT names a flower).
     *  Search returns the best match, then the record is pulled by id.
     *  Returns null when Trefle has no record for the name — absence, not
     *  failure; throws TrefleUnavailableError when the source is unreachable. */
    async function fetchTrefleDetails(speciesName) {
        if (!speciesName || !String(speciesName).trim()) return null;
        var name = String(speciesName).trim();

        var s = await apiFetch('/trefle/plants/search?q=' + encodeURIComponent(name) + '&page=1');
        var first = (s.data || [])[0];
        if (!first) return null;

        var d = await apiFetch('/trefle/plants/' + encodeURIComponent(first.id));
        var ms = (d.data && d.data.main_species) || {};
        var g = ms.growth || {};
        var spec = ms.specifications || {};
        var light = (typeof g.light === 'number') ? g.light : null;

        return {
            trefleId: first.id,
            matchedName: first.scientific_name || null,
            family: ms.family || (d.data && d.data.family) || null,
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
            source: 'Trefle (trefle.io)',
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
    };
})();
