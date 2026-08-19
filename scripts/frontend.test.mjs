// scripts/frontend.test.mjs — contract tests for the fetch/render split.
//
//     node scripts/frontend.test.mjs
//
// No package.json, no framework: the repo runs tests by invoking node
// directly, same as proxy/worker.test.mjs and storage.test.mjs.
//
// Both files under test are browser IIFEs that publish onto `window`, so each
// is evaluated in a vm context holding a minimal DOM shim — enough surface for
// the functions actually exercised here, and no more. Anything the shim does
// not implement will throw loudly rather than silently pass.

import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));

let pass = 0, fail = 0;
function ok(cond, label) {
    if (cond) { pass++; console.log('PASS  ' + label); }
    else { fail++; console.log('FAIL  ' + label); }
}
function section(t) { console.log('\n--- ' + t + ' ---'); }

// ---------------------------------------------------------------------------
// DOM shim
// ---------------------------------------------------------------------------

function makeEl(id) {
    const classes = new Set();
    return {
        id,
        textContent: '',
        innerHTML: '',
        _html: [],
        classList: {
            add: (...c) => c.forEach((x) => classes.add(x)),
            remove: (...c) => c.forEach((x) => classes.delete(x)),
            contains: (c) => classes.has(c),
        },
        insertAdjacentHTML(_pos, html) { this._html.push(html); },
        // Enough for directory.js's clearSkeletons(): the shim stores markup as
        // strings rather than parsing it, so there are never nodes to remove.
        querySelectorAll: () => [],
    };
}

function makeWindow(ids = []) {
    const els = new Map(ids.map((id) => [id, makeEl(id)]));
    const win = {
        console,
        fetch: async () => { throw new Error('fetch not stubbed'); },
    };
    win.window = win;
    win.document = {
        getElementById: (id) => els.get(id) || null,
        // template + innerHTML is how generatePlantCard turns a string into a
        // node. The shim does not parse HTML; it hands back a stand-in whose
        // outerHTML is the string, which is all the assertions below need.
        createElement(tag) {
            if (tag !== 'template') throw new Error('shim: unexpected createElement(' + tag + ')');
            const t = { content: { firstElementChild: null } };
            Object.defineProperty(t, 'innerHTML', {
                set(v) {
                    t.content.firstElementChild = v
                        ? { tagName: 'ARTICLE', outerHTML: v }
                        : null;
                },
            });
            return t;
        },
    };
    win._els = els;
    return win;
}

// Load one or more browser IIFEs into a SINGLE realm, so modules that talk to
// each other through `window` (directory.js reads ffApi and ffUi) see the same
// globals they would on a real page.
function loadAll(win, relPaths) {
    const ctx = createContext(win);
    for (const p of relPaths) {
        runInContext(readFileSync(join(HERE, p), 'utf8'), ctx, { filename: p });
    }
    // Every vm context gets its own intrinsics, so an Error built in here is
    // NOT an instanceof the host realm's Error and the sandbox exposes no
    // handle to the context's copy. Grab one for realm-safe subclass checks.
    // A browser has a single realm, so this distinction exists only in tests.
    win._Error = runInContext('Error', ctx);
    return win;
}

function load(win, relPath) {
    return loadAll(win, [relPath]);
}

// ===========================================================================
section('ui.js — card markup');
// ===========================================================================
{
    const win = load(makeWindow(), 'ui.js');
    const { plantCardHTML, generatePlantCard, appendPlantCards, esc } = win.ffUi;

    const trefle = {
        qid: null, name: 'Common poppy', family: 'Papaveraceae',
        img: 'https://bs.plantnet.org/image/o/abc.jpg',
        link: '/species?name=Common%20poppy',
    };
    const wikidata = {
        qid: 'Q157419', name: 'Rosa canina', family: 'Rosaceae',
        img: 'https://commons.wikimedia.org/wiki/Special:FilePath/x.jpg?width=400',
        link: 'https://en.wikipedia.org/wiki/Rosa_canina',
    };

    const t = plantCardHTML(trefle);
    const w = plantCardHTML(wikidata);

    ok(t.includes('/species?name=Common%20poppy'), 'Trefle card links to the species page');
    ok(!/target="_blank"/.test(t), '...and stays in the tab (internal link)');
    ok(w.includes('target="_blank"') && w.includes('rel="noopener noreferrer"'),
        'Wikidata card opens externally with rel=noopener');
    ok(w.includes('data-qid="Q157419"'), 'QID is preserved when present');
    ok(!/data-qid/.test(t), '...and omitted when the record has none (Trefle)');

    // Pixel parity: both sources must produce the same shell classes, or a
    // Trefle card and a Wikidata card would visibly differ in one grid.
    const shell = (html) => (html.match(/<article class="([^"]+)"/) || [])[1];
    ok(shell(t) === shell(w), 'both sources render an identical card shell');

    ok(plantCardHTML({ name: '' }) === '', 'a nameless record renders nothing');
    ok(plantCardHTML(null) === '', 'a null record renders nothing');

    // Trefle has ~437k plants and many carry no photo.
    const noImg = plantCardHTML({ qid: null, name: 'Zephyranthes', family: null, img: null, link: '' });
    ok(!/<img/.test(noImg), 'a record with no image renders no <img>');
    ok(noImg.includes('text-sage-500') && noImg.includes('>Z<'),
        '...it renders a monogram placeholder in a colour the palette defines');
    ok(!/sage-300/.test(noImg), '...never sage-300, which the Tailwind config omits');
    ok(!/<p class="text-xs/.test(noImg), 'a null family renders no family line');

    const node = generatePlantCard(trefle);
    ok(node && node.outerHTML === t, 'generatePlantCard returns the same markup as a node');
    ok(generatePlantCard({ name: '' }) === null, 'generatePlantCard returns null for an unusable record');

    const grid = makeEl('grid');
    const n = appendPlantCards(grid, [trefle, wikidata, { name: '' }]);
    ok(n === 2, 'appendPlantCards skips unusable records and reports the real count');
    ok(grid._html.length === 1, '...and writes to the DOM exactly once for the batch');
    ok(appendPlantCards(grid, []) === 0, 'an empty batch writes nothing');
    ok(esc('<b>&"\'') === '&lt;b&gt;&amp;&quot;&#39;', 'esc covers all five HTML metacharacters');
}

// ===========================================================================
section('ui.js — hostile field values');
// ===========================================================================
{
    const win = load(makeWindow(), 'ui.js');
    const { plantCardHTML } = win.ffUi;

    // Trefle common names are user-contributed; treat every field as hostile.
    const xss = plantCardHTML({
        qid: '"><script>alert(1)</script>',
        name: '<img src=x onerror=alert(1)>',
        family: '</p><script>alert(2)</script>',
        img: 'https://x/y.jpg" onload="alert(3)',
        link: '/species?name=x',
    });
    ok(!/<script>/.test(xss), 'no <script> tag survives any field');
    ok(!/<img src=x/.test(xss), 'markup in the name is escaped, not parsed');
    // esc() turns the closing quote into &quot;, so onload stays inert text
    // *inside* the src value — the attribute is never terminated early.
    const srcVal = (xss.match(/<img src="([^"]*)"/) || [])[1];
    ok(srcVal && !srcVal.includes('"'), 'a quote in the image URL cannot break out of the attribute');

    const js = plantCardHTML({ qid: null, name: 'Evil', family: null, img: null, link: 'javascript:alert(1)' });
    ok(!/javascript:/i.test(js), 'a javascript: link is refused outright');
    ok(js.includes('/species?name=Evil'), '...and replaced with the species page');

    const data = plantCardHTML({ qid: null, name: 'Evil', family: null, img: null, link: 'data:text/html,<script>' });
    ok(!/href="data:/i.test(data), 'a data: link is refused outright');
}

// ===========================================================================
section('ui.js — renderResultDetails');
// ===========================================================================
{
    const IDS = ['resFamily', 'resBinomial', 'factSun', 'factHabit', 'factGrow',
        'factRange', 'factToxic', 'factWater', 'resEdible', 'resEdibleWrap', 'resAttribution'];
    const win = load(makeWindow(IDS), 'ui.js');
    const el = (id) => win._els.get(id);

    win.ffUi.renderResultDetails({
        family: 'Rosaceae', binomial: 'Rosa canina',
        sunlight: 'Full sun', growthHabit: 'Shrub', moistureUse: 6,
        toxic: 'No toxicity recorded.', trefle: true,
        edibleNote: 'Trefle records this plant as edible (fruit).',
    });

    ok(el('resFamily').textContent === 'Rosaceae', 'family is injected');
    ok(el('resBinomial').textContent === 'Rosa canina', 'binomial is injected');
    ok(!el('resBinomial').classList.contains('hidden'), '...and unhidden');
    ok(el('factSun').textContent === 'Full sun', 'sunlight is injected');
    ok(el('factHabit').textContent === 'Shrub', 'growth habit is injected');
    ok(/Moderate water use/.test(el('factWater').textContent),
        'moisture index 6 is phrased as a relative measure, not a schedule');
    ok(el('resAttribution').textContent === 'Sources: Wikipedia, Trefle (trefle.io)',
        'attribution names both sources when Trefle contributed');
    ok(el('resEdible').textContent.startsWith('Trefle records this plant as edible'),
        'an affirmative edibility note is shown');
    ok(!el('resEdibleWrap').classList.contains('hidden'),
        '...and the wrapper is unhidden, so the icon shows with the text');

    // Absent fields must not blank out what another source already painted:
    // that is how a Wikidata answer silently disappears when Trefle misses.
    const win2 = load(makeWindow(IDS), 'ui.js');
    const e2 = (id) => win2._els.get(id);
    e2('factRange').textContent = 'Europe';
    e2('factSun').textContent = 'PRESET';
    win2.ffUi.renderResultDetails({ family: 'Rosaceae' });
    ok(e2('factRange').textContent === 'Europe', 'an undefined field is left alone, not cleared');
    ok(e2('factSun').textContent === 'PRESET', '...including the Trefle-only fields');
    ok(e2('resEdibleWrap').classList.contains('hidden'),
        'with no edibility note the wrapper is hidden — absence is never a clearance');

    // One-directional edibility: there is no "inedible" state to render.
    const win3 = load(makeWindow(IDS), 'ui.js');
    win3.ffUi.renderResultDetails({ edible: false, family: 'X' });
    ok(win3._els.get('resEdible').textContent === '',
        'edible:false renders no claim (Trefle false-negatives are known)');

    ok(win.ffUi.renderResultDetails(null) === undefined, 'null data is a no-op, not a throw');

    const m = win.ffUi.moistureText;
    ok(m(9).startsWith('High') && m(6).startsWith('Moderate') &&
        m(3).startsWith('Low') && m(0).startsWith('Very low'), 'moisture ladder covers 0-10');
    ok(m(null) === '' && m(undefined) === '' && m('6') === '',
        'a missing or non-numeric moisture value yields no text');
}

// ===========================================================================
section('api.js — fetchTrefleBatch');
// ===========================================================================

function apiWin(handler) {
    const win = makeWindow();
    win.fetch = async (url) => {
        win._lastUrl = url;
        return handler(url);
    };
    return load(win, 'api.js');
}
const jsonRes = (body, status = 200) => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
});

{
    const page = {
        data: [
            { id: 1, common_name: 'Common poppy', scientific_name: 'Papaver rhoeas', family: 'Papaveraceae', image_url: 'https://img/1.jpg' },
            { id: 2, common_name: null, scientific_name: 'Rosa canina', family: 'Rosaceae', image_url: null },
            { id: 3, common_name: null, scientific_name: null, family: 'X', image_url: null },
        ],
        links: { next: '/api/v1/plants?page=2' },
        meta: { total: 164632 },
    };
    const win = apiWin(() => jsonRes(page));
    const res = await win.ffApi.fetchTrefleBatch(1);

    ok(res.items.length === 2, 'a record with neither name is dropped');
    ok(res.items[0].name === 'Common poppy', 'the common name wins when Trefle has one');
    ok(res.items[1].name === 'Rosa canina', '...and the scientific name is the fallback');
    ok(res.items[0].img === 'https://img/1.jpg', 'image_url is carried through (list records do have it)');
    ok(res.items[1].img === null, '...and reported as null when absent, not faked');
    ok(res.items[0].qid === null, 'Trefle items carry no QID');
    ok(res.items[0].link === '/species?name=Common%20poppy', 'the link is an encoded species-page URL');
    ok(res.hasMore === true, 'links.next means there is more');

    const u = decodeURIComponent(win._lastUrl);
    ok(u.includes('filter[family_name]='), 'the curated family filter is sent');
    ok(!/filter\[family\]=/.test(u), '...as family_name, never the silently-ignored filter[family]');
    ok(u.includes('Asteraceae') && u.includes('Onagraceae'), '...with the whole twenty-family list');
    ok(win._lastUrl.startsWith('https://findflower-proxy.fofi.workers.dev/trefle/plants?page=1'),
        'the request goes through the proxy, never to trefle.io directly');
}

{
    // meta carries only { total } — there is no total_pages or current_page.
    const win = apiWin(() => jsonRes({ data: [], links: {}, meta: { total: 40 } }));
    const a = await win.ffApi.fetchTrefleBatch(1);
    ok(a.hasMore === true, 'without links.next, hasMore is derived from meta.total');
    const b = await win.ffApi.fetchTrefleBatch(2);
    ok(b.hasMore === false, '...and is false once the total is consumed');
}

{
    // Trefle answers 404 past the last page. Treating that as an outage would
    // trip the Wikidata fallback and restart the catalogue from another source.
    const body = { error: true, message: 'expected :page in 1..8232; got 8233' };
    const win = apiWin(() => ({ ok: false, status: 404, json: async () => body, text: async () => JSON.stringify(body) }));
    const res = await win.ffApi.fetchTrefleBatch(9000);
    ok(res.items.length === 0 && res.hasMore === false,
        'past the last page is an empty terminal result, not an error');
}

{
    // No TREFLE_TOKEN on the Worker: 503 + { fallback: true }.
    const win = apiWin(() => jsonRes({ error: 'trefle_unconfigured', fallback: true }, 503));
    let caught = null;
    try { await win.ffApi.fetchTrefleBatch(1); } catch (e) { caught = e; }
    ok(caught instanceof win.ffApi.TrefleUnavailableError, '503 throws TrefleUnavailableError');
    // Regression guard: this was once a factory returning a plain Error, so the
    // instanceof check in directory.js could never match and the Wikidata
    // fallback was unreachable. Both checks together pin it as a real subclass.
    ok(caught instanceof win._Error && typeof caught.stack === 'string',
        '...which is a real Error subclass, not a factory');
    ok(caught.name === 'TrefleUnavailableError', '...and names itself');
}

{
    const win = apiWin(() => { throw new TypeError('Failed to fetch'); });
    let caught = null;
    try { await win.ffApi.fetchTrefleBatch(1); } catch (e) { caught = e; }
    ok(caught instanceof win.ffApi.TrefleUnavailableError, 'a network failure throws TrefleUnavailableError');
}

{
    // A 404 that is NOT a page-range message is a genuine fault (stale Worker
    // without the route) and must not be mistaken for end-of-catalogue.
    const win = apiWin(() => ({ ok: false, status: 404, json: async () => ({}), text: async () => 'no route here' }));
    let caught = null;
    try { await win.ffApi.fetchTrefleBatch(1); } catch (e) { caught = e; }
    ok(caught instanceof win.ffApi.TrefleUnavailableError, 'an unrelated 404 still throws');
}

{
    // ---- PRODUCTION REGRESSION, 2026-08-10 -------------------------------
    // findflower.me served an empty encyclopedia while localhost was fine.
    // The deployed Worker predated the /trefle/ route, so its catch-all health
    // check answered every Trefle path with HTTP 200 {"status":"ok"}. A 200 was
    // trusted on status alone, so body.data||[] gave no items and hasMore came
    // out false -- which the engine reads as "catalogue exhausted". Nothing
    // threw, so the Wikidata fallback that exists for exactly this case was
    // never reached and the grid stayed empty with no error to show.
    const win = apiWin(() => jsonRes({ status: 'ok' }));
    let caught = null;
    try { await win.ffApi.fetchTrefleBatch(1); } catch (e) { caught = e; }
    ok(caught instanceof win.ffApi.TrefleUnavailableError,
        'a stale Worker answering 200 {"status":"ok"} throws instead of faking an empty catalogue');
    ok(/data field/.test(caught ? caught.message : ''),
        '...and says what was wrong with the body');
    ok(/trefle\/ route/.test(caught ? caught.message : ''),
        '...naming the stale deploy, so the next person is not diagnosing from scratch');
}

{
    // The check is on SHAPE, not on the literal {"status":"ok"} body: the next
    // stale deploy or captive portal will answer something else.
    const bodies = [
        { ok: true },
        { message: 'Not Found' },
        { error: 'nope' },
        {},
        [],
    ];
    let allThrew = true;
    for (const b of bodies) {
        const win = apiWin(() => jsonRes(b));
        try { await win.ffApi.fetchTrefleBatch(1); allThrew = false; }
        catch (e) { if (!(e instanceof win.ffApi.TrefleUnavailableError)) allThrew = false; }
    }
    ok(allThrew, 'any 200 without a data field is treated as an unavailable source');
}

{
    // A 200 that is not JSON at all (an HTML error page, a captive portal).
    // This used to propagate a raw SyntaxError, which no engine has a branch
    // for -- so the page broke rather than degrading.
    const win = apiWin(() => ({
        ok: true, status: 200,
        json: async () => { throw new SyntaxError('Unexpected token < in JSON at position 0'); },
        text: async () => '<html>edge error</html>',
    }));
    let caught = null;
    try { await win.ffApi.fetchTrefleBatch(1); } catch (e) { caught = e; }
    ok(caught instanceof win.ffApi.TrefleUnavailableError,
        'a 200 with non-JSON degrades to the fallback instead of throwing SyntaxError');
}

{
    // The guard must not reject VALID payloads. An empty-but-well-formed page
    // is a real Trefle answer and must still resolve.
    const win = apiWin(() => jsonRes({ data: [], links: {}, meta: { total: 0 } }));
    const res = await win.ffApi.fetchTrefleBatch(1);
    ok(res.items.length === 0 && res.hasMore === false,
        'a well-formed empty page still resolves — the guard checks shape, not emptiness');
}

{
    // fetchTrefleDetails goes through the same apiFetch, so it degrades too
    // rather than reading .data off a health-check body.
    const win = apiWin(() => jsonRes({ status: 'ok' }));
    let caught = null;
    try { await win.ffApi.fetchTrefleDetails('Rose'); } catch (e) { caught = e; }
    ok(caught instanceof win.ffApi.TrefleUnavailableError,
        'fetchTrefleDetails also rejects a shapeless 200');
}

{
    const win = apiWin(() => jsonRes({ data: [], links: {}, meta: {} }));
    await win.ffApi.fetchTrefleBatch(0);
    ok(win._lastUrl.includes('page=1'), 'page 0 is clamped to 1');
    await win.ffApi.fetchTrefleBatch('abc');
    ok(win._lastUrl.includes('page=1'), 'a non-numeric page is clamped to 1');
    await win.ffApi.fetchTrefleBatch(3, { families: null });
    ok(!win._lastUrl.includes('family_name'), 'families:null browses the unfiltered catalogue');
}

// ===========================================================================
section('api.js — fetchTrefleDetails');
// ===========================================================================
{
    const win = apiWin((url) => {
        if (url.includes('/search')) return jsonRes({ data: [{ id: 42, scientific_name: 'Rosa canina' }] });
        return jsonRes({
            data: {
                family: 'Rosaceae',
                main_species: {
                    family: 'Rosaceae',
                    edible: true,
                    edible_part: ['fruit'],
                    growth: { light: 8, moisture_use: 5, atmospheric_humidity: 4 },
                    specifications: { growth_habit: 'Shrub', toxicity: 'none' },
                },
            },
        });
    });
    const rec = await win.ffApi.fetchTrefleDetails('Rosa canina');

    // The shape must be a SUPERSET of trefle-data.json's, or species.js's merge
    // — which holds the only copy of the toxicity and edibility safety rules —
    // would need a second branch for live records. `image` is live-only: the
    // build script predates the field, so prebuilt entries lack the key and
    // species.js treats it as optional. (trefle-data.json also carries
    // `searchTerm`, which is build bookkeeping and not part of the contract.)
    const REQUIRED = ['atmosphericHumidity', 'edible', 'ediblePart', 'family', 'growthHabit',
        'lightIndex', 'matchedName', 'moistureUse', 'source', 'sunlight', 'toxicity', 'trefleId'];
    const missing = REQUIRED.filter(k => !(k in rec));
    ok(missing.length === 0,
        'the record carries every field trefle-data.json holds' +
        (missing.length ? ' (missing: ' + missing.join(',') + ')' : ''));
    const extra = Object.keys(rec).filter(k => REQUIRED.indexOf(k) === -1);
    ok(extra.length === 1 && extra[0] === 'image',
        '...and adds only `image`, which prebuilt records do not have');
    ok(rec.sunlight === 'Full sun to light shade', 'light index 8 maps through the shared ladder');
    ok(rec.growthHabit === 'Shrub' && rec.toxicity === 'none', 'specifications are read');
    ok(rec.edible === true && rec.ediblePart[0] === 'fruit', 'edibility is read');
    ok(rec.moistureUse === 5, 'moisture_use is carried for the watering line');

    const empty = apiWin(() => jsonRes({ data: [] }));
    ok(await empty.ffApi.fetchTrefleDetails('Nonexistent plant') === null,
        'no search hit returns null — absence, not failure');
    ok(await empty.ffApi.fetchTrefleDetails('') === null, 'an empty name returns null without a request');
    ok(await empty.ffApi.fetchTrefleDetails('   ') === null, 'a blank name returns null without a request');
}

{
    // The search hit carries image_url; the detail record often does not. A
    // profile whose Wikipedia article has no photo depends on this being read.
    const win = apiWin((url) => {
        if (url.includes('/search')) {
            return jsonRes({ data: [{ id: 51834, scientific_name: 'Medicago lupulina', image_url: 'https://bs.plantnet.org/image/o/abc' }] });
        }
        return jsonRes({ data: { main_species: { family: 'Fabaceae' } } });
    });
    const rec = await win.ffApi.fetchTrefleDetails('Nonesuch');
    ok(rec.image === 'https://bs.plantnet.org/image/o/abc',
        'the search hit\'s image_url is carried into the record');

    const noImg = apiWin((url) => url.includes('/search')
        ? jsonRes({ data: [{ id: 1, scientific_name: 'X y' }] })
        : jsonRes({ data: { main_species: {} } }));
    ok((await noImg.ffApi.fetchTrefleDetails('X y')).image === null,
        '...and reported as null when neither record has one');
}

{
    // ---- PRODUCTION REGRESSION, 2026-08-10 -------------------------------
    // Directory cards come from Trefle, so their labels are often COMMON names.
    // "Nonesuch" (Medicago lupulina) has a Wikipedia disambiguation page, which
    // yielded no article, no photo and no facts -- the reported empty profile.
    // opts.hint gives the lookup a second name to try.
    const queries = [];
    const win = apiWin((url) => {
        const m = /[?&]q=([^&]*)/.exec(url);
        if (m) {
            queries.push(decodeURIComponent(m[1]));
            // Only the common name resolves; the (absent) binomial does not.
            if (decodeURIComponent(m[1]) !== 'Nonesuch') return jsonRes({ data: [] });
            return jsonRes({ data: [{ id: 51834, scientific_name: 'Medicago lupulina', image_url: 'https://img/n.jpg' }] });
        }
        return jsonRes({ data: { main_species: { family: 'Fabaceae', growth: { light: 7 } } } });
    });

    const missed = await win.ffApi.fetchTrefleDetails('Unresolvable name');
    ok(missed === null, 'without a hint, an unresolvable name is still null');

    queries.length = 0;
    const rec = await win.ffApi.fetchTrefleDetails('Unresolvable name', { hint: 'Nonesuch' });
    ok(rec && rec.matchedName === 'Medicago lupulina',
        'the hint resolves a common name after the primary query misses');
    ok(queries.length === 2 && queries[1] === 'Nonesuch',
        '...via exactly one extra search call');
    ok(rec.family === 'Fabaceae' && rec.sunlight === 'Full sun to light shade',
        '...and the care facts come back with it');
}

{
    // The hint must not cost a request when the primary query already worked,
    // and must not fire twice for the same string in different case.
    let calls = 0;
    const win = apiWin((url) => {
        if (url.includes('/search')) { calls++; return jsonRes({ data: [{ id: 7, scientific_name: 'Rosa canina' }] }); }
        return jsonRes({ data: { main_species: {} } });
    });
    await win.ffApi.fetchTrefleDetails('Rosa canina', { hint: 'Dog rose' });
    ok(calls === 1, 'a successful primary query never triggers the hint');

    let calls2 = 0;
    const win2 = apiWin((url) => {
        if (url.includes('/search')) { calls2++; return jsonRes({ data: [] }); }
        return jsonRes({ data: { main_species: {} } });
    });
    ok(await win2.ffApi.fetchTrefleDetails('rose', { hint: 'ROSE' }) === null,
        'a hint that only differs in case is skipped');
    ok(calls2 === 1, '...costing one request, not two');
}

// ===========================================================================
section('api.js — fetchWikidataBatch');
// ===========================================================================

// The SPARQL half moved here from directory.js in the Step 5 dedupe. It used to
// exist TWICE — once in directory.js for the embeds, once inline in
// directory.html for the encyclopedia — and the query's ORDER BY is what stops
// LIMIT/OFFSET pages from overlapping. Two copies of that is two chances to
// lose it. These tests pin the contract now that there is one copy.

const wdBinding = (n) => ({
    item: { value: 'http://www.wikidata.org/entity/Q' + n },
    itemLabel: { value: 'Species ' + n },
    famLabel: { value: 'Rosaceae' },
    img: { value: 'http://commons.wikimedia.org/wiki/Special:FilePath/Flower%20' + n + '.jpg' },
    article: { value: 'https://en.wikipedia.org/wiki/Species_' + n },
});
const wdRes = (bindings) => jsonRes({ results: { bindings } });

{
    const rows = [
        wdBinding(1),
        // An unresolved label falls back to the QID, which is not a species
        // name — the row must be dropped, not rendered as "Q42".
        { ...wdBinding(42), itemLabel: { value: 'Q42' } },
        // No P18 image: the card design is image-led, so there is nothing to show.
        { item: { value: 'http://www.wikidata.org/entity/Q7' }, itemLabel: { value: 'Species 7' } },
        // No Wikipedia article — the entity page is the honest fallback link.
        { ...wdBinding(9), article: undefined },
    ];
    const win = apiWin(() => wdRes(rows));
    const res = await win.ffApi.fetchWikidataBatch(0);

    ok(res.items.length === 2, 'a QID-labelled row and an imageless row are both dropped');
    ok(res.items[0].qid === 'Q1', 'the QID is taken from the entity URI');
    ok(res.items[0].name === 'Species 1', 'the label is the name');
    ok(res.items[0].family === 'Rosaceae', 'famLabel becomes family');
    ok(res.items[1].link === 'https://www.wikidata.org/wiki/Q9',
        'a row with no article links to the entity page instead');
    ok(res.items[0].link === 'https://en.wikipedia.org/wiki/Species_1',
        'Wikidata rows carry the real article URL — callers rewrite it if they want species.html');

    // Commons originals are 5–20 MB each; a 12-card grid of them is unusable
    // on mobile data. The thumbnail rewrite is not cosmetic.
    ok(/[?&]width=500/.test(res.items[0].img), 'images are Commons thumbnails at the default width');
    ok(res.items[0].img.startsWith('https://commons.wikimedia.org/wiki/Special:FilePath/'),
        '...still served from Special:FilePath');

    const q = decodeURIComponent(win._lastUrl);
    ok(/ORDER BY \?item/.test(q),
        'the query keeps ORDER BY — without a total order, LIMIT/OFFSET pages overlap (37 dupes measured)');
    ok(/LIMIT 96 OFFSET 0/.test(q), 'the chunk size and offset are in the query');
    ok(/VALUES \?fam \{/.test(q) && /wd:Q25400/.test(q) && /wd:Q156179/.test(q),
        '...against the fixed twenty-family set, not wdt:P31 wd:Q506');
    ok(win._lastUrl.startsWith('https://query.wikidata.org/sparql?format=json&query='),
        'it goes to WDQS asking for JSON');
}

{
    const win = apiWin(() => wdRes([wdBinding(1)]));
    const res = await win.ffApi.fetchWikidataBatch(0, { thumbWidth: 400 });
    ok(/[?&]width=400/.test(res.items[0].img), 'thumbWidth overrides the default');
}

{
    // A short chunk is the end of the catalogue. Measured on the ROW count, not
    // the normalized count: rows dropped for a missing label do not mean the
    // source is spent, and treating them that way truncates the encyclopedia.
    const short = [];
    for (let i = 0; i < 30; i++) short.push(wdBinding(i));
    const win = apiWin(() => wdRes(short));
    const res = await win.ffApi.fetchWikidataBatch(0);
    ok(res.hasMore === false, 'a chunk shorter than 96 rows ends the catalogue');

    const full = [];
    for (let i = 0; i < 96; i++) full.push(i % 2 ? wdBinding(i) : { ...wdBinding(i), itemLabel: { value: 'Q' + i } });
    const win2 = apiWin(() => wdRes(full));
    const res2 = await win2.ffApi.fetchWikidataBatch(96);
    ok(res2.items.length === 48 && res2.hasMore === true,
        'a full 96-row chunk means more, even when half the rows are unusable');
    ok(res2.nextOffset === 192, 'nextOffset advances by the chunk size, not by the kept count');
}

{
    // No further fallback exists below Wikidata, so unlike Trefle this throws
    // and the caller shows its error state.
    const win = apiWin(() => ({ ok: false, status: 429, json: async () => ({}), text: async () => '' }));
    let caught = null;
    try { await win.ffApi.fetchWikidataBatch(0); } catch (e) { caught = e; }
    ok(caught && /WDQS 429/.test(caught.message), 'a non-OK WDQS response throws');
    ok(!(caught instanceof win.ffApi.TrefleUnavailableError),
        '...as a plain Error — it must NOT look like a skippable Trefle outage');
}

// ===========================================================================
section('directory.js — mount(): the fetch → render pipeline');
// ===========================================================================

// A fixed grid (infinite:false) has no scroll trigger, so mount() fills it in a
// loop. These tests cover that loop, because it is the one place where a failing
// network can turn into a hot spin: loadMore() swallows its own errors, so the
// loop cannot detect failure by catching — only by the returned count.

function dirWin(fetchImpl) {
    const win = makeWindow();
    win.fetch = fetchImpl;
    win.setTimeout = setTimeout;
    win.clearTimeout = clearTimeout;
    win.addEventListener = () => {};
    win.removeEventListener = () => {};
    win.scrollY = 0;
    win.innerHeight = 800;
    return loadAll(win, ['api.js', 'ui.js', '../directory.js']);
}

// Trefle pages of 20 with distinct names, so nothing is deduped away.
function treflePage(page, total) {
    const data = [];
    for (let i = 0; i < 20; i++) {
        const n = (page - 1) * 20 + i;
        data.push({ id: n, common_name: 'Plant ' + n, scientific_name: 'Genus sp' + n, family: 'Rosaceae', image_url: 'https://img/' + n + '.jpg' });
    }
    return jsonRes({ data, links: { next: '/api/v1/plants?page=' + (page + 1) }, meta: { total } });
}

{
    let pages = 0;
    const win = dirWin(async (url) => { pages++; return treflePage(Number(/page=(\d+)/.exec(url)[1]), 164632); });
    const grid = makeEl('grid');
    await win.ffDirectory.mount({ grid, infinite: false, max: 40, cull: false }).start();

    // 40 cards over two 20-row Trefle pages. A prefetch may run ahead, so the
    // assertion is on cards rendered, not on requests made.
    const html = grid._html.join('');
    ok((html.match(/<article/g) || []).length === 40, 'a fixed grid fills to exactly its max');
    ok(html.includes('/species?name=Plant%200'), '...through ffUi, linking to the species page');
    ok(pages >= 2, '...pulling as many Trefle pages as it took');
}

{
    // The regression this section exists for. Every request fails, so exhausted
    // stays false and the buffer stays empty: done() is never true. If fill()
    // looped on done() alone it would re-fire forever.
    let calls = 0;
    const win = dirWin(async () => { calls++; throw new TypeError('Failed to fetch'); });
    const grid = makeEl('grid');
    const errorBox = makeEl('err');
    await win.ffDirectory.mount({ grid, errorBox, infinite: false, max: 40, cull: false }).start();

    ok(calls > 0 && calls < 40, 'a dead network stops the fill loop instead of spinning (' + calls + ' calls)');
    ok(!(grid._html.join('').includes('<article')), '...no cards are rendered');
    ok(!errorBox.classList.contains('hidden'), '...and the error box is shown');
}

{
    // Trefle unconfigured (503 + fallback) with nothing on screen yet: switch to
    // Wikidata mid-call and keep going, so the page looks exactly as it did
    // before Trefle existed.
    const wd = {
        results: {
            bindings: [{
                item: { value: 'http://www.wikidata.org/entity/Q157419' },
                itemLabel: { value: 'Rosa canina' },
                famLabel: { value: 'Rosaceae' },
                img: { value: 'https://commons.wikimedia.org/wiki/Special:FilePath/x.jpg' },
                article: { value: 'https://en.wikipedia.org/wiki/Rosa_canina' },
            }],
        },
    };
    const win = dirWin(async (url) => {
        if (url.includes('/trefle/')) return jsonRes({ error: 'trefle_unconfigured', fallback: true }, 503);
        return jsonRes(wd);
    });
    const grid = makeEl('grid');
    await win.ffDirectory.mount({ grid, infinite: false, max: 40, cull: false }).start();
    const html = grid._html.join('');
    ok(html.includes('data-qid="Q157419"'), 'an unconfigured Trefle falls back to Wikidata before first paint');
    ok((html.match(/<article/g) || []).length === 1, '...and renders the short chunk it got');
}

{
    // Same failure AFTER cards are on screen must NOT switch: Wikidata orders
    // differently, so the user would be shown everything again from the top.
    let seenWdqs = false;
    let trefleCalls = 0;
    const win = dirWin(async (url) => {
        if (url.includes('/trefle/')) {
            trefleCalls++;
            if (trefleCalls === 1) return treflePage(1, 164632);
            return jsonRes({ error: 'trefle_unconfigured', fallback: true }, 503);
        }
        seenWdqs = true;
        return jsonRes({ results: { bindings: [] } });
    });
    const grid = makeEl('grid');
    await win.ffDirectory.mount({ grid, infinite: false, max: 40, cull: false }).start();
    ok(!seenWdqs, 'a mid-scroll Trefle failure never restarts the catalogue from Wikidata');
    ok((grid._html.join('').match(/<article/g) || []).length === 20,
        '...the cards already rendered stay put');
}

{
    // ui.js missing: an empty grid with no explanation is the failure mode this
    // guard exists to prevent.
    const win = makeWindow();
    win.fetch = async () => { throw new Error('should not be called'); };
    loadAll(win, ['api.js', '../directory.js']);
    const grid = makeEl('grid');
    const errorBox = makeEl('err');
    const handle = win.ffDirectory.mount({ grid, errorBox, infinite: false });
    ok(typeof handle.start === 'function' && typeof handle.stop === 'function',
        'mount() without ui.js still returns a usable handle');
    await handle.start();
    ok(!errorBox.classList.contains('hidden'), '...and surfaces the error instead of a silent empty grid');
    ok(!grid._html.length, '...having written nothing');
}

{
    // api.js missing. This used to be survivable — no ffApi just meant "use the
    // SPARQL code inside directory.js" — but that code moved to api.js in the
    // Step 5 dedupe, so a missing api.js now leaves no catalogue at all. Same
    // rule as ui.js: say so rather than run an engine that can only ever paint
    // an empty grid.
    const win = makeWindow();
    win.fetch = async () => { throw new Error('should not be called'); };
    loadAll(win, ['ui.js']);
    // directory.js reads window.ffApi at mount time, so loading it alone is
    // enough to reach the guard.
    loadAll(win, ['../directory.js']);
    const grid = makeEl('grid');
    const errorBox = makeEl('err');
    const handle = win.ffDirectory.mount({ grid, errorBox, infinite: false });
    ok(typeof handle.start === 'function' && typeof handle.stop === 'function',
        'mount() without api.js still returns a usable handle');
    await handle.start();
    ok(!errorBox.classList.contains('hidden'), '...and surfaces the error');
    ok(!grid._html.length, '...having written nothing');
}

{
    // The encyclopedia asks for 400px thumbnails (four columns on a desktop,
    // two on a phone) rather than the 500 default. That option has to reach the
    // fetcher, or every card on the busiest grid pulls a larger image than it
    // will ever display.
    let q = '';
    const win = dirWin(async (url) => {
        if (url.includes('/trefle/')) return jsonRes({ error: 'x', fallback: true }, 503);
        q = url;
        return jsonRes({ results: { bindings: [] } });
    });
    await win.ffDirectory.mount({
        grid: makeEl('grid'), infinite: false, max: 12, cull: false, thumbWidth: 400,
    }).start();
    ok(q.includes('query.wikidata.org'), 'the fallback reached WDQS');
    // The width lands on the image URL, not the query, so assert on a rendered card.
    const win2 = dirWin(async (url) => {
        if (url.includes('/trefle/')) return jsonRes({ error: 'x', fallback: true }, 503);
        return jsonRes({ results: { bindings: [{
            item: { value: 'http://www.wikidata.org/entity/Q1' },
            itemLabel: { value: 'Rosa canina' },
            famLabel: { value: 'Rosaceae' },
            img: { value: 'https://commons.wikimedia.org/wiki/Special:FilePath/x.jpg' },
        }] } });
    });
    const grid2 = makeEl('grid');
    await win2.ffDirectory.mount({ grid: grid2, infinite: false, max: 12, cull: false, thumbWidth: 400 }).start();
    ok(/width=400/.test(grid2._html.join('')), 'thumbWidth reaches the rendered card');
}

// ---------------------------------------------------------------------------
// The head-order contract for prefs.js
// ---------------------------------------------------------------------------
// prefs.js applies the reduce-motion class to <html>. If it is deferred, or
// missing from a page, the reader who asked for no animation sees exactly one
// -- the first one that page runs -- before the class lands. Every page has to
// carry it, and none of them may defer it. String ops rather than a regex:
// this is markup order, and the assertions should read like the thing they
// guard.
section('every page loads prefs.js blocking in <head>');
{
    const { readdirSync } = await import('node:fs');
    const root = join(HERE, '..');
    const pages = readdirSync(root).filter((f) => f.endsWith('.html')).sort();
    ok(pages.length >= 17, 'found the page set (' + pages.length + ' files)');

    const openTag = (html, needle) => {
        const i = html.indexOf(needle);
        if (i === -1) return null;
        return html.slice(i, html.indexOf('>', i) + 1);
    };

    const missing = [], deferred = [], late = [], stale = [];
    for (const f of pages) {
        const html = readFileSync(join(root, f), 'utf8');
        const tag = openTag(html, '<script src="prefs.js');
        if (!tag) { missing.push(f); continue; }
        if (tag.includes(' defer') || tag.includes(' async')) deferred.push(f);
        const head = html.indexOf('</head>');
        if (head === -1 || html.indexOf(tag) > head) late.push(f);
        // A page left on an older app.css would serve cached CSS with no
        // reduce-motion block: the switch would look broken on that page only.
        for (const part of html.split('app.css?v=').slice(1)) {
            if (!part.startsWith('8"')) stale.push(f + ' -> app.css?v=' + part.slice(0, 2));
        }
    }
    ok(missing.length === 0, 'no page is without prefs.js: ' + (missing.join(', ') || 'none'));
    ok(deferred.length === 0, 'no page defers it: ' + (deferred.join(', ') || 'none'));
    ok(late.length === 0, 'and none of them load it after </head>: ' + (late.join(', ') || 'none'));
    ok(stale.length === 0, 'every page is on the same app.css: ' + (stale.join(', ') || 'v=8 everywhere'));
}

// ---------------------------------------------------------------------------
// Every preference changes something
// ---------------------------------------------------------------------------
// The rule the four switches were written under: no toggle that only remembers
// its own position. Each key has to be read at the place it governs, and this
// is what fails if a future edit removes the read but leaves the switch.
section('each preference is enforced somewhere real');
{
    const root = join(HERE, '..');
    const prefs = readFileSync(join(root, 'prefs.js'), 'utf8');
    const tryHtml = readFileSync(join(root, 'try.html'), 'utf8');
    const css = readFileSync(join(root, 'app.css'), 'utf8');

    const keys = prefs.slice(prefs.indexOf('var DEFAULTS'), prefs.indexOf('var MOTION_CLASS'))
        .split(':').slice(0, -1).map((s) => s.trim().split(/[^A-Za-z]/).pop()).filter(Boolean);
    ok(keys.length === 4 && keys.join(',') === 'attachLocation,keepPhotos,recordHistory,reduceMotion',
        'four preferences: ' + keys.join(', '));

    // The three the capture path reads before it writes a scan.
    for (const k of ['attachLocation', 'keepPhotos', 'recordHistory']) {
        ok(tryHtml.includes("pref('" + k + "'"), k + ' gates something in try.html');
    }
    // The fourth is a class app.css keys its rest state off.
    ok(prefs.includes('MOTION_CLASS') && prefs.includes("'ff-reduce-motion'"),
        'reduceMotion resolves to a class name in prefs.js');
    ok(css.includes('html.ff-reduce-motion'), 'and app.css acts on that class');
    ok(css.includes('animation-duration: 1ms'),
        'by collapsing durations, not by animation: none, which hides fill-mode elements');
    for (const sel of ['.reveal-up', '.ff-lb-hero']) {
        ok(css.slice(css.indexOf('html.ff-reduce-motion')).includes('html.ff-reduce-motion ' + sel),
            'and it restores the rest state of ' + sel + ', which has none of its own');
    }
}

// ---------------------------------------------------------------------------
// The /try coach's wiring
// ---------------------------------------------------------------------------
// The coach reads the page instead of counting taps, so it stays correct only
// for as long as the things it reads still exist. Every id in its step table,
// the mode tabs it derives the path length from, the attributes it observes: if
// a future edit renames one of those, the coach does not throw -- it silently
// points at nothing. That is what these guard. The browser side (geometry, one
// showing, reduced motion) is coach.qa.mjs; this is the part the text can
// answer on its own.
section('/try coach -- the page contract it depends on');
{
    const root = join(HERE, '..');
    const { readdirSync } = await import('node:fs');
    const tryHtml = readFileSync(join(root, 'try.html'), 'utf8');
    const coach = readFileSync(join(root, 'scripts', 'try-coach.js'), 'utf8');
    const scanner = readFileSync(join(root, 'scripts', 'views', 'scanner.js'), 'utf8');
    const router = readFileSync(join(root, 'scripts', 'router.js'), 'utf8');
    const appCss = readFileSync(join(root, 'app.css'), 'utf8');

    const at = tryHtml.indexOf('try-coach.js');
    const tag = at === -1 ? '' : tryHtml.slice(tryHtml.lastIndexOf('<script', at), tryHtml.indexOf('>', at) + 1);
    ok(tag !== '', 'try.html loads scripts/try-coach.js');
    ok(tag.includes(' defer'), 'deferred: it must not delay the inference script above it');
    // Order matters twice over: scanner.js owns the state the coach reads, and
    // the layer has to exist before the router can sweep it away again.
    const tagAt = (src) => tryHtml.indexOf('<script src="' + src);
    ok(tagAt('scripts/views/scanner.js') < at, 'after scanner.js, which drives the state it reads');
    ok(at < tagAt('scripts/router.js'), 'and before router.js');

    const others = readdirSync(root).filter((f) => f.endsWith('.html') && f !== 'try.html')
        .filter((f) => readFileSync(join(root, f), 'utf8').includes('try-coach.js'));
    ok(others.length === 0, 'and no other page carries it: ' + (others.join(', ') || 'none'));

    // Its CSS deliberately lives in try.html. Moving it to app.css would cost a
    // ?v= bump on all 17 pages for a layer only one of them can ever show.
    ok(tryHtml.includes('.ff-coach__ring'), 'the coach CSS is inline in try.html');
    ok(!appCss.includes('ff-coach'), 'and app.css is untouched, so no site-wide ?v= bump');

    // Every control the step table points at.
    const ids = [...coach.matchAll(/id: '([A-Za-z]+)'/g)].map((m) => m[1]);
    ok(ids.length === 5, 'five steps in the table: ' + ids.join(', '));
    const gone = ids.filter((id) => !tryHtml.includes('id="' + id + '"'));
    ok(gone.length === 0, 'each is an id try.html really has: ' + (gone.join(', ') || 'all five'));

    // "Step n of 3" versus "of 2" comes off the mode tabs: aria-selected is
    // both the tab's own state and the coach's input.
    for (const m of ['camera', 'upload', 'url']) {
        ok(tryHtml.includes('data-mode="' + m + '"'), 'the ' + m + ' tab is still a .seg-btn[data-mode]');
    }
    ok(tryHtml.includes('seg-btn') && tryHtml.includes('aria-selected'),
        'and the tabs still carry aria-selected, which mode() reads');
    ok(coach.includes("attributeFilter: ['disabled', 'class', 'aria-selected']"),
        'the observers watch exactly those three attributes');
    const capture = tryHtml.slice(tryHtml.indexOf('id="camCapture"'));
    ok(capture.slice(0, capture.indexOf('>')).includes('disabled'),
        'Capture starts disabled, which is what puts step 1 on Start camera');

    // Teardown, both halves: the node goes with the router's sweep, the
    // observers go with stop(). dismiss() here would spend the one showing on
    // a reader who merely tapped Home.
    ok(coach.includes("setAttribute('data-ff-page'"), 'the layer tags itself [data-ff-page]');
    ok(router.includes("var EXTRA = '[data-ff-page]'"), 'which is the selector router.js sweeps');
    ok(scanner.includes('ffTryCoach.stop()'), 'scanner.js unmount() stops the coach');
    ok(!scanner.includes('ffTryCoach.dismiss'), 'and does not mark it seen on the way out');

    // Phones only, and remembered per rebuilt flow rather than for ever.
    ok(coach.includes('(max-width: 767px)'), 'it gates on md, the same breakpoint as the tab bar');
    ok(coach.includes("SEEN_KEY = 'ff_coach_try'"), 'the one-showing flag is ff_coach_try');
    ok(/VERSION = '[0-9]+'/.test(coach), 'and it is versioned, so a rebuilt flow can teach again');

    // Type scale. The sheet's text is Tailwind utilities; the pill is the only
    // hand-written size in the layer, and it still has to be a step.
    const css = tryHtml.slice(tryHtml.indexOf('.ff-coach {'), tryHtml.indexOf('@media (prefers-reduced-motion'));
    const STEP = ['0.75rem', '0.875rem', '1rem', '1.125rem', '1.25rem', '1.5rem', '1.875rem', '2.25rem'];
    const sizes = [...css.matchAll(/font-size:[ ]*([^;]+);/g)].map((m) => m[1].trim());
    ok(sizes.length > 0 && sizes.every((v) => STEP.includes(v)),
        'every hand-written font-size is a scale step: ' + sizes.join(', '));
    const weights = [...css.matchAll(/font-weight:[ ]*([^;]+);/g)].map((m) => m[1].trim());
    ok(weights.every((v) => ['400', '500', '600', '700'].includes(v)),
        'and every weight is a real one: ' + weights.join(', '));
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
