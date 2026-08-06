/* ============================================================================
   FindFlower — Trefle build-time prefetch (tools/build-trefle.js)
   ----------------------------------------------------------------------------
   Runs LOCALLY (Node), never in the browser. Reads the API token from the
   TREFLE_TOKEN environment variable so the token is never committed or shipped
   to the client. For each seed species it:

     1. resolves the scientific (binomial) name the same way the site does
        — Wikipedia summary → wikibase_item → Wikidata P225 — so the output
        keys match species.js's cache keys exactly;
     2. searches Trefle by that name for a plant id;
     3. fetches the full record and extracts the fields Trefle actually carries.

   The result is written to trefle-data.json (root + dist), which the static
   site loads same-origin — no CORS, no token exposure, no visitor rate limits.

   Usage:   $env:TREFLE_TOKEN = '...'; node tools/build-trefle.js
   ========================================================================== */
'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');

const TOKEN = process.env.TREFLE_TOKEN;
if (!TOKEN) {
  console.error('ERROR: set TREFLE_TOKEN in the environment before running.');
  process.exit(1);
}

// ---- Seed list (mirror of directory.html's SEED — common label + Wikipedia title) ----
const SEED = [
  { common: 'Rose', q: 'Rose' },
  { common: 'Tulip', q: 'Tulip' },
  { common: 'Sunflower', q: 'Common sunflower' },
  { common: 'Common Daisy', q: 'Bellis perennis' },
  { common: 'Dandelion', q: 'Taraxacum' },
  { common: 'Marigold', q: 'Tagetes' },
  { common: 'Petunia', q: 'Petunia' },
  { common: 'Snapdragon', q: 'Antirrhinum' },
  { common: 'Foxglove', q: 'Digitalis' },
  { common: 'Hibiscus', q: 'Hibiscus' },
  { common: 'Sacred Lotus', q: 'Nelumbo nucifera' },
  { common: 'Water Lily', q: 'Nymphaea' },
  { common: 'Corn Poppy', q: 'Papaver rhoeas' },
  { common: 'Carnation', q: 'Dianthus caryophyllus' },
  { common: 'Sweet Pea', q: 'Lathyrus odoratus' },
  { common: 'Bird of Paradise', q: 'Strelitzia' },
  { common: 'Tiger Lily', q: 'Lilium lancifolium' },
  { common: 'Daffodil', q: 'Narcissus (plant)' },
  { common: 'Buttercup', q: 'Ranunculus' },
  { common: 'Columbine', q: 'Aquilegia' },
  { common: 'Clematis', q: 'Clematis' },
  { common: 'Magnolia', q: 'Magnolia' },
  { common: 'Camellia', q: 'Camellia' },
  { common: 'Azalea', q: 'Azalea' },
  { common: 'Cyclamen', q: 'Cyclamen' },
  { common: 'Poinsettia', q: 'Poinsettia' },
  { common: 'Frangipani', q: 'Plumeria' },
  { common: 'Bougainvillea', q: 'Bougainvillea' },
  { common: 'Passion Flower', q: 'Passiflora' },
  { common: 'Morning Glory', q: 'Morning glory' },
  { common: 'Geranium', q: 'Geranium' },
  { common: 'Pelargonium', q: 'Pelargonium' },
  { common: 'Anthurium', q: 'Anthurium' },
  { common: 'Bee Balm', q: 'Monarda' },
  { common: 'Blanket Flower', q: 'Gaillardia' },
  { common: 'Gazania', q: 'Gazania' },
  { common: 'Osteospermum', q: 'Osteospermum' },
  { common: 'Black-eyed Susan', q: 'Rudbeckia hirta' },
  { common: 'Purple Coneflower', q: 'Echinacea purpurea' },
  { common: 'Canna Lily', q: 'Canna (plant)' },
];

// ---- Minimal JSON GET over https (Node parses Trefle's duplicate-key images fine) ----
function getJSON(url, headers) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: headers || {} }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(new Error('HTTP ' + res.statusCode + ' for ' + url));
        }
        try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.setTimeout(20000, () => { req.destroy(new Error('timeout')); });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Map Trefle's 0–10 light index to a human sunlight description.
function lightToText(light) {
  if (light === null || light === undefined) return null;
  if (light >= 9) return 'Full sun';
  if (light >= 7) return 'Full sun to light shade';
  if (light >= 5) return 'Partial shade';
  if (light >= 3) return 'Shade to partial shade';
  return 'Full shade';
}

// Resolve a seed's scientific name via Wikipedia + Wikidata (same path as the site).
async function resolveBinomial(title) {
  try {
    const d = await getJSON('https://en.wikipedia.org/api/rest_v1/page/summary/' + encodeURIComponent(title),
      { 'User-Agent': 'FindFlower-build/1.0 (static site prefetch)' });
    const qid = d.wikibase_item;
    if (!qid) return null;
    const w = await getJSON('https://www.wikidata.org/wiki/Special:EntityData/' + qid + '.json',
      { 'User-Agent': 'FindFlower-build/1.0' });
    const ent = w.entities && w.entities[qid];
    const claim = ent && ent.claims && ent.claims.P225 && ent.claims.P225[0];
    const taxon = claim && claim.mainsnak && claim.mainsnak.datavalue && claim.mainsnak.datavalue.value;
    return taxon || null;
  } catch (e) {
    return null;
  }
}

async function fetchTrefle(searchTerm) {
  const s = await getJSON('https://trefle.io/api/v1/plants/search?token=' + TOKEN + '&q=' + encodeURIComponent(searchTerm));
  const first = (s.data || [])[0];
  if (!first) return null;
  const d = await getJSON('https://trefle.io/api/v1/plants/' + first.id + '?token=' + TOKEN);
  const ms = (d.data && d.data.main_species) || {};
  const g = ms.growth || {};
  const spec = ms.specifications || {};
  return {
    trefleId: first.id,
    matchedName: first.scientific_name || null,
    family: ms.family || (d.data && d.data.family) || null,
    growthHabit: spec.growth_habit || null,
    lightIndex: (typeof g.light === 'number') ? g.light : null,
    sunlight: lightToText(typeof g.light === 'number' ? g.light : null),
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

async function main() {
  const out = {};
  const summary = [];
  for (const seed of SEED) {
    const key = seed.q.trim().toLowerCase();
    let term = await resolveBinomial(seed.q);
    if (!term) term = seed.q; // fall back to the title if no binomial resolved
    let rec = null;
    try {
      rec = await fetchTrefle(term);
    } catch (e) {
      // Rate-limit or transient error — retry once after a pause.
      await sleep(2500);
      try { rec = await fetchTrefle(term); } catch (e2) { rec = null; }
    }
    if (rec) {
      rec.searchTerm = term;
      out[key] = rec;
      const filled = ['family', 'growthHabit', 'sunlight', 'edible', 'toxicity']
        .filter((f) => rec[f] !== null && rec[f] !== undefined);
      summary.push(seed.q.padEnd(22) + '-> ' + (rec.matchedName || '?').padEnd(26) + ' [' + filled.join(', ') + ']');
    } else {
      summary.push(seed.q.padEnd(22) + '-> NO MATCH');
    }
    await sleep(900); // stay well under Trefle's free-tier rate limit
  }

  const roots = [
    path.join(__dirname, '..', 'trefle-data.json'),
    path.join(__dirname, '..', 'dist', 'trefle-data.json'),
  ];
  const json = JSON.stringify(out, null, 2);
  for (const p of roots) {
    try { fs.writeFileSync(p, json, 'utf8'); console.log('wrote ' + p); }
    catch (e) { console.error('could not write ' + p + ': ' + e.message); }
  }

  console.log('\n=== Prefetch summary (' + Object.keys(out).length + '/' + SEED.length + ' matched) ===');
  console.log(summary.join('\n'));
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
