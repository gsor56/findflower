/**
 * FindFlower inference proxy (Cloudflare Worker).
 *
 * Sits between the public frontend and a PRIVATE Hugging Face Space that
 * runs the ViT. The browser never sees any secret; the Space is gated so it
 * can't be used as a free open API.
 *
 *   browser --(image)--> Worker --(image + X-Proxy-Secret)--> private Space
 *
 * The Worker:
 *   - enforces a CORS/Origin allowlist (blocks other websites)
 *   - forwards the image to the Space as multipart/form-data
 *   - adds the shared X-Proxy-Secret header (only Worker + Space know it)
 *
 * Client contract (unchanged):
 *   POST <worker-url>   body: raw image bytes
 *   ->  { flower, confidence, top_k: [{ name, confidence }, ...] }
 *
 * Secrets / vars (set via `wrangler secret put`, NOT in code):
 *   SPACE_URL       - base URL of the private Space, e.g.
 *                     https://gsor56-findflower-vit.hf.space
 *   SPACE_TOKEN     - HF read token, sent as Bearer so the Worker can reach
 *                     the *private* Space's endpoint
 *   PROXY_SECRET    - shared secret the Space checks (X-Proxy-Secret)
 *   ALLOWED_ORIGINS - comma-separated CORS allowlist, e.g.
 *                     "http://localhost:8000,https://findflower.me"
 */

const TOP_K = 5;
const MAX_RETRIES = 5;        // free Space CPU can cold-start for a bit
const RETRY_DELAY_MS = 3000;

function corsHeaders(request, env) {
  // ALLOWED_ORIGINS is a comma-separated allowlist. CORS can only echo ONE
  // origin, so we return the request's origin if it's on the list.
  const configured = (env.ALLOWED_ORIGINS || "*")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const reqOrigin = request.headers.get("Origin") || "";
  let allow = "*";
  if (!configured.includes("*")) {
    allow = configured.includes(reqOrigin) ? reqOrigin : configured[0];
  }
  return {
    "Access-Control-Allow-Origin": allow,
    "Vary": "Origin",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
  };
}

function json(body, status, request, env) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders(request, env) },
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function originAllowed(origin, env) {
  const configured = (env.ALLOWED_ORIGINS || "*")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return configured.includes("*") || configured.includes(origin);
}

export default {
  async fetch(request, env) {
    // CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(request, env) });
    }
    if (request.method !== "POST") {
      return json({ error: "Use POST with a raw image body." }, 405, request, env);
    }

    // Origin gate: only allowlisted sites may call the Worker. Blocks other
    // websites' browsers. (curl can spoof Origin, so the Space also checks the
    // secret below -- defense in depth, not a single wall.)
    const origin = request.headers.get("Origin");
    if (origin && !originAllowed(origin, env)) {
      return json({ error: "Origin not allowed." }, 403, request, env);
    }

    if (!env.SPACE_URL || !env.PROXY_SECRET) {
      return json({ error: "Server misconfigured (SPACE_URL/PROXY_SECRET)." }, 500, request, env);
    }

    const image = await request.arrayBuffer();
    if (!image || image.byteLength === 0) {
      return json({ error: "Empty image body." }, 400, request, env);
    }

    // The Space expects multipart/form-data with a `file` field.
    const contentType = request.headers.get("Content-Type") || "image/jpeg";
    const form = new FormData();
    form.append("file", new Blob([image], { type: contentType }), "upload.jpg");

    const target = env.SPACE_URL.replace(/\/+$/, "") + "/predict";
    const headers = { "X-Proxy-Secret": env.PROXY_SECRET };
    // Private Spaces require a bearer token to be reachable at all.
    if (env.SPACE_TOKEN) headers.Authorization = `Bearer ${env.SPACE_TOKEN}`;

    // Retry while the free Space cold-starts (HF edge returns 502/503).
    let res, lastText = "";
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      res = await fetch(target, { method: "POST", headers, body: form });
      if (res.status !== 503 && res.status !== 502) break;
      lastText = await res.text();
      await sleep(RETRY_DELAY_MS);
    }

    if (!res.ok) {
      const detail = lastText || (await res.text());
      return json({ error: "Inference upstream error", status: res.status, detail }, 502, request, env);
    }

    // The Space already returns { flower, confidence, top_k } -- pass through.
    let payload;
    try {
      payload = await res.json();
    } catch {
      return json({ error: "Unexpected response from inference server." }, 502, request, env);
    }
    if (!payload || !Array.isArray(payload.top_k)) {
      return json({ error: "Malformed prediction.", detail: payload }, 502, request, env);
    }
    payload.top_k = payload.top_k.slice(0, TOP_K);

    return json(payload, 200, request, env);
  },
};
