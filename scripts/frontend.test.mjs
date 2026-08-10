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
        link: 'species.html?name=Common%20poppy',
    };
    const wikidata = {
        qid: 'Q157419', name: 'Rosa canina', family: 'Rosaceae',
        img: 'https://commons.wikimedia.org/wiki/Special:FilePath/x.jpg?width=400',
        link: 'https://en.wikipedia.org/wiki/Rosa_canina',
    };

    const t = plantCardHTML(trefle);
    const w = plantCardHTML(wikidata);

    ok(t.includes('species.html?name=Common%20poppy'), 'Trefle card links to the species page');
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
        link: 'species.html?name=x',
    });
    ok(!/<script>/.test(xss), 'no <script> tag survives any field');
    ok(!/<img src=x/.test(xss), 'markup in the name is escaped, not parsed');
    // esc() turns the closing quote into &quot;, so onload stays inert text
    // *inside* the src value — the attribute is never terminated early.
    const srcVal = (xss.match(/<img src="([^"]*)"/) || [])[1];
    ok(srcVal && !srcVal.includes('"'), 'a quote in the image URL cannot break out of the attribute');

    const js = plantCardHTML({ qid: null, name: 'Evil', family: null, img: null, link: 'javascript:alert(1)' });
    ok(!/javascript:/i.test(js), 'a javascript: link is refused outright');
    ok(js.includes('species.html?name=Evil'), '...and replaced with the species page');

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
    ok(res.items[0].link === 'species.html?name=Common%20poppy', 'the link is an encoded species-page URL');
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

    // The shape must match trefle-data.json exactly, or species.js's merge —
    // which holds the only copy of the toxicity and edibility safety rules —
    // would need a second branch for live records.
    const keys = Object.keys(rec).sort().join(',');
    ok(keys === ['atmosphericHumidity', 'edible', 'ediblePart', 'family', 'growthHabit',
        'lightIndex', 'matchedName', 'moistureUse', 'source', 'sunlight', 'toxicity', 'trefleId']
        .sort().join(','), 'the record shape matches trefle-data.json');
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
    ok(html.includes('species.html?name=Plant%200'), '...through ffUi, linking to the species page');
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

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
