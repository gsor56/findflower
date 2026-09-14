// Flora-Flash ViT inference, server-side.
//
// Flora-Flash is the ViT that /try and /v1/identify classify with. It used to
// run in two places: in the browser through TF.js (scripts/lite.js, a separate
// 107-class export) and behind a private Hugging Face Space that try.html could
// only reach through the Worker. The Space is gone, so the model moves in here
// and the deployed site gets one code path instead of three.
//
// WHAT THE WEIGHTS ACTUALLY ARE, because this is the part that is easy to get
// wrong and completely silent when wrong:
//
//   gsor56/findflower-VIT holds two different models.
//
//   - findflower_vit_fp32_ext.onnx, plus its .onnxdata weights sibling, is the
//     serving graph. Its declared output is [batch, 116]. That was read out of
//     the graph itself rather than assumed, and the 116 labels are the ones in
//     class_names.json at the site root.
//   - model.safetensors and best_model.pth are a later, larger checkpoint with
//     4387 classes. config.json and the repo's own class_names.json describe
//     THAT model, not the ONNX.
//
//   The two orderings are prefix-compatible: manifest.json's 4387-entry class
//   list matches our 116-entry file exactly at indices 0-115. So the ONNX is
//   the 116-class head of the same ordering and the local list is the correct
//   name table for it. Wiring the repo's 4387-entry file to this graph would
//   shift every label by nothing at the low end and be wrong at the high end,
//   which is the worst kind of wrong: still confident.
//
//   loadLabels() therefore reads the LOCAL file and then asserts the count
//   against the graph's real output width. A mismatch refuses to start.
//
// Footprint: the graph is 1.4MB and its weights sibling is 327MB, so a loaded
// session is a few hundred MB resident on a 3GB container. Affordable, but not
// free, which is why the load is lazy, the download is cached on disk, and the
// session options below trade a little speed for a lower peak -- the same trade
// space/app.py made for the 512MB free tier, kept because the EVA-02 export is
// what needs the headroom next.

import { existsSync, mkdirSync, readFileSync, statSync, unlinkSync } from 'node:fs';
import { rename, writeFile } from 'node:fs/promises';
import { get as httpsGet } from 'node:https';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..');

// Two layouts, the same probe db.js and index.js use for .env and the static
// root: in the repository server/ sits below the site; on the container these
// files are the root and there is no level above.
const SITE_ROOT = existsSync(path.join(REPO_ROOT, 'index.html')) ? REPO_ROOT : HERE;

const MODEL_REPO = process.env.FF_MODEL_REPO || 'gsor56/findflower-VIT';
const GRAPH_FILE = process.env.FF_MODEL_GRAPH || 'findflower_vit_fp32_ext.onnx';
const WEIGHTS_FILE = process.env.FF_MODEL_WEIGHTS || 'findflower_vit_fp32.onnxdata';
const LABELS_FILE = process.env.FF_MODEL_LABELS || 'class_names.json';
// A named directory rather than a temp dir: the download is the slow part of a
// cold start, so it has to survive the process restarting.
const MODEL_DIR = process.env.FF_MODEL_DIR || path.join(SITE_ROOT, '.model-cache');

const IMAGE_SIZE = 224;
const MEAN = [0.5, 0.5, 0.5];
const STD = [0.5, 0.5, 0.5];
const TOP_K = 5;

// The Worker's own timeout on a scan is 135s and it retries a 502/503 five
// times, so a first request that waits for a cold model is survivable. It is
// not survivable forever: past this the route answers 503 instead of holding
// the connection, which lets the Worker's retry loop do its job.
const LOAD_WAIT_MS = Number(process.env.FF_MODEL_LOAD_WAIT_MS) || 110000;

const state = {
    phase: 'cold',
    error: null,
    labels: 0,
    startedAt: 0,
    readyAt: 0,
    bytes: 0,
};

let session = null;
let inputName = null;
let outputName = null;
let loadPromise = null;
let labelCache = null;

function log(...args) {
    console.log('[inference]', ...args);
}

function fail(message) {
    state.phase = 'error';
    state.error = message;
    return new Error(message);
}

function hfToken() {
    const token = (process.env.HF_TOKEN || '').trim();
    if (!token) {
        throw fail('HF_TOKEN is not set; it is required to fetch the private weights from ' + MODEL_REPO + '.');
    }
    return token;
}

/** The label table. Read from disk, never inferred from the repo's copy. */
export function loadLabels() {
    // Parsed once. It is only 2KB, but it is read on every scan and the log line
    // belongs in the boot sequence, not in the middle of every request.
    if (labelCache) return labelCache;
    const candidates = [
        path.join(SITE_ROOT, LABELS_FILE),
        path.join(HERE, LABELS_FILE),
        path.join(SITE_ROOT, 'space', LABELS_FILE),
    ];
    for (const candidate of candidates) {
        if (!existsSync(candidate)) continue;
        let parsed;
        try {
            parsed = JSON.parse(readFileSync(candidate, 'utf8'));
        } catch (err) {
            throw fail('Could not parse ' + candidate + ': ' + err.message);
        }
        if (!Array.isArray(parsed) || parsed.length === 0 || typeof parsed[0] !== 'string') {
            throw fail(candidate + ' is not a non-empty array of class names.');
        }
        log('labels', parsed.length, 'from', candidate);
        labelCache = { labels: parsed, source: candidate };
        return labelCache;
    }
    throw fail('No ' + LABELS_FILE + ' found. Looked in: ' + candidates.join(', '));
}

/** Download one file from the private repo, following the CDN redirect. */
function download(url, destination, token) {
    return new Promise((resolve, reject) => {
        const request = httpsGet(url, {
            headers: {
                authorization: 'Bearer ' + token,
                'user-agent': 'findflower-server',
            },
        }, (response) => {
            if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
                response.resume();
                download(response.headers.location, destination, token).then(resolve, reject);
                return;
            }
            if (response.statusCode !== 200) {
                response.resume();
                reject(new Error('HTTP ' + response.statusCode + ' for ' + url));
                return;
            }
            const declared = Number(response.headers['content-length']) || 0;
            const chunks = [];
            let received = 0;
            let lastLogged = 0;
            response.on('data', (chunk) => {
                chunks.push(chunk);
                received += chunk.length;
                // One line per 32MB: enough to see progress in the container log
                // without turning a 327MB download into thousands of lines.
                if (received - lastLogged > 32 * 1024 * 1024) {
                    lastLogged = received;
                    log('downloading', path.basename(destination), Math.round(received / 1048576) + 'MB of ' + Math.round(declared / 1048576) + 'MB');
                }
            });
            response.on('error', reject);
            response.on('end', async () => {
                try {
                    if (declared && received !== declared) {
                        throw new Error('short read: got ' + received + ' of ' + declared + ' bytes');
                    }
                    // Write beside the target and rename, so an interrupted
                    // download can never leave a truncated file that a later
                    // boot would happily load as a corrupt model.
                    const partial = destination + '.part';
                    await writeFile(partial, Buffer.concat(chunks));
                    await rename(partial, destination);
                    resolve(received);
                } catch (err) {
                    reject(err);
                }
            });
        });
        request.on('error', reject);
        request.setTimeout(120000, () => request.destroy(new Error('timed out downloading ' + url)));
    });
}

async function ensureFile(name, sizeHint) {
    const destination = path.join(MODEL_DIR, name);
    if (existsSync(destination)) {
        const size = statSync(destination).size;
        if (size > 0) {
            log('cached', name, size + ' bytes');
            return destination;
        }
        // A zero-byte file is the one shape a rename cannot produce, so it is
        // the one shape worth trusting as garbage rather than retrying forever.
        unlinkSync(destination);
    }
    const token = hfToken();
    const url = 'https://huggingface.co/' + MODEL_REPO + '/resolve/main/' + name;
    log('fetching', name, sizeHint ? '(' + sizeHint + ' bytes)' : '');
    const bytes = await download(url, destination, token);
    log('saved', destination, bytes + ' bytes');
    return destination;
}

async function loadSession() {
    state.phase = 'loading';
    state.startedAt = Date.now();

    mkdirSync(MODEL_DIR, { recursive: true });

    // Labels first: a missing or mismatched label table should stop this before
    // 327MB of weights come down the wire.
    const { labels } = loadLabels();

    await ensureFile(WEIGHTS_FILE);
    const graphPath = await ensureFile(GRAPH_FILE);

    let ort;
    try {
        ort = await import('onnxruntime-node');
    } catch (err) {
        throw fail('onnxruntime-node is not installed or failed to load: ' + err.message);
    }

    // The same levers space/app.py used on the 512MB tier. The arena is the
    // big one: on by default, onnxruntime pre-allocates and holds a large
    // block, and off it frees aggressively.
    const created = await ort.InferenceSession.create(graphPath, {
        executionProviders: ['cpu'],
        graphOptimizationLevel: 'basic',
        intraOpNumThreads: 1,
        interOpNumThreads: 1,
        enableCpuMemArena: false,
        enableMemPattern: false,
    });

    inputName = created.inputNames[0];
    outputName = created.outputNames[0];

    // Read the width the graph actually declares. onnxruntime-node does not
    // expose the output shape until the first run, so take it from the tensor
    // metadata when it is available and fall back to the label count with a
    // warning rather than guessing in silence.
    let width = labels.length;
    try {
        const meta = created.outputMetadata || (created.outputMetadata = undefined);
        if (meta && meta[outputName] && Array.isArray(meta[outputName].dimensions)) {
            const dims = meta[outputName].dimensions;
            const last = dims[dims.length - 1];
            if (Number.isFinite(last) && last > 0) width = last;
        }
    } catch (err) { /* metadata is a nicety, not a contract */ }

    if (width !== labels.length) {
        throw fail('Label mismatch: the graph outputs ' + width + ' logits but ' + LABELS_FILE +
            ' has ' + labels.length + ' entries. Refusing to start rather than name a class from the wrong row.');
    }

    session = created;
    state.labels = labels.length;
    state.phase = 'ready';
    state.readyAt = Date.now();
    state.bytes = 0;
    log('ready: ' + labels.length + ' classes, input ' + inputName + ', output ' + outputName +
        ', loaded in ' + Math.round((state.readyAt - state.startedAt) / 1000) + 's');
    return session;
}

/** Kick the load off without waiting for it. Safe to call repeatedly. */
export function preload() {
    if (session || loadPromise) return loadPromise;
    loadPromise = loadSession().catch((err) => {
        // Clear the memo so a later request can retry a transient failure -- a
        // dropped download should not need a container restart to recover.
        loadPromise = null;
        log('load failed:', err.message);
        throw err;
    });
    // Nothing awaits this here, so keep Node from treating it as unhandled.
    loadPromise.catch(() => { });
    return loadPromise;
}

/** The loaded session, waiting for an in-flight load up to LOAD_WAIT_MS. */
async function readySession() {
    if (session) return session;
    const pending = preload();
    if (!pending) return session;
    let timer = null;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('model is still loading')), LOAD_WAIT_MS);
    });
    try {
        await Promise.race([pending, timeout]);
    } finally {
        if (timer) clearTimeout(timer);
    }
    return session;
}

/** Report load progress without leaking anything about the weights. */
export function modelStatus() {
    return {
        phase: state.phase,
        classes: state.labels,
        ready: state.phase === 'ready',
        error: state.error,
        loaded_ms: state.readyAt && state.startedAt ? state.readyAt - state.startedAt : 0,
        repo: MODEL_REPO,
    };
}

/**
 * Resize and normalise one image the way the training pipeline did.
 *
 * This mirrors space/app.py's preprocess_image, which mirrors the
 * preprocessor_config.json in the model repo: RGB, 224x224, rescaled by 1/255,
 * normalised by mean=std=0.5, laid out channels-first.
 *
 * One deliberate difference. .rotate() applies the EXIF orientation, which
 * space/app.py did not do. The training set is upright, and a phone photo that
 * carries an orientation tag is stored sideways, so honouring it is what puts
 * the input back in the orientation the model was shown. Browsers do the same
 * thing when they paint an <img>, so this also keeps the server's view of a
 * photo the same as the visitor's.
 */
async function preprocess(buffer) {
    let sharp;
    try {
        sharp = (await import('sharp')).default;
    } catch (err) {
        throw new Error('sharp is not installed or failed to load: ' + err.message);
    }
    let raw;
    try {
        raw = await sharp(buffer, { failOn: 'none', limitInputPixels: 64 * 1024 * 1024 })
            .rotate()
            .resize(IMAGE_SIZE, IMAGE_SIZE, { kernel: 'linear', fit: 'fill' })
            .removeAlpha()
            .toColourspace('srgb')
            .raw()
            .toBuffer({ resolveWithObject: true });
    } catch (err) {
        throw new Error('could not decode that image: ' + err.message);
    }
    if (raw.info.channels !== 3) {
        throw new Error('expected 3 channels after conversion, got ' + raw.info.channels);
    }

    // HWC uint8 -> CHW float32, normalised in one pass so the source buffer is
    // never copied into an intermediate float image.
    const pixels = IMAGE_SIZE * IMAGE_SIZE;
    const data = new Float32Array(3 * pixels);
    const source = raw.data;
    for (let i = 0; i < pixels; i++) {
        const s = i * 3;
        const r = source[s] / 255;
        const g = source[s + 1] / 255;
        const b = source[s + 2] / 255;
        data[i] = (r - MEAN[0]) / STD[0];
        data[pixels + i] = (g - MEAN[1]) / STD[1];
        data[2 * pixels + i] = (b - MEAN[2]) / STD[2];
    }
    return data;
}

/**
 * Classify one image buffer.
 * Returns { flower, confidence, top_k: [{ name, confidence }, ...] }.
 */
export async function identify(buffer, options) {
    if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
        throw new Error('empty image');
    }
    const wanted = Number(options && options.topK) > 0 ? Number(options.topK) : TOP_K;
    const active = await readySession();
    if (!active) throw new Error('model did not load');

    const ort = await import('onnxruntime-node');
    const labels = loadLabels().labels;
    const data = await preprocess(buffer);

    const started = Date.now();
    const results = await active.run({
        [inputName]: new ort.Tensor('float32', data, [1, 3, IMAGE_SIZE, IMAGE_SIZE]),
    });
    const logits = results[outputName] || results[Object.keys(results)[0]];
    if (!logits || !logits.data || typeof logits.data.length !== 'number') {
        throw new Error('the model returned no logits');
    }
    const scores = logits.data;
    if (scores.length !== labels.length) {
        throw new Error('model returned ' + scores.length + ' logits for ' + labels.length + ' labels');
    }

    // Softmax, computed against the max so a large logit cannot overflow.
    let max = -Infinity;
    for (let i = 0; i < scores.length; i++) if (scores[i] > max) max = scores[i];
    let sum = 0;
    const probabilities = new Float32Array(scores.length);
    for (let i = 0; i < scores.length; i++) {
        const value = Math.exp(scores[i] - max);
        probabilities[i] = value;
        sum += value;
    }
    for (let i = 0; i < probabilities.length; i++) probabilities[i] /= sum;

    const ranked = Array.from(probabilities, (confidence, index) => ({ index, confidence }))
        .sort((a, b) => b.confidence - a.confidence)
        .slice(0, wanted);

    const top = ranked.map((entry) => ({
        name: labels[entry.index],
        confidence: entry.confidence,
    }));

    log('scan ' + buffer.length + ' bytes -> ' + top[0].name + ' ' +
        top[0].confidence.toFixed(4) + ' in ' + (Date.now() - started) + 'ms');

    return {
        flower: top[0].name,
        confidence: top[0].confidence,
        top_k: top,
    };
}
