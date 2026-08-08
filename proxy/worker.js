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
 *   - requires a Bearer token and verifies it against Auth0 (see AUTH GATE)
 *   - forwards the image to the Space as multipart/form-data
 *   - adds the shared X-Proxy-Secret header (only Worker + Space know it)
 *
 * Client contract:
 *   POST <worker-url>   body: raw image bytes OR multipart `file`
 *                       header: Authorization: Bearer <Auth0 access token>
 *   ->  { flower, confidence, top_k: [{ name, confidence }, ...] }
 *   ->  401 when the token is absent, malformed, or fails verification
 *
 * Secrets / vars (set via `wrangler secret put`, NOT in code):
 *   SPACE_URL       - base URL of the private Space, e.g.
 *                     https://gsor56-findflower-vit.hf.space
 *   SPACE_TOKEN     - HF read token, sent as Bearer so the Worker can reach
 *                     the *private* Space's endpoint
 *   PROXY_SECRET    - shared secret the Space checks (X-Proxy-Secret)
 *   ALLOWED_ORIGINS - comma-separated CORS allowlist. `*` is IGNORED; the
 *                     fallback is CANONICAL_ORIGIN below.
 *   AUTH0_DOMAIN    - e.g. findflower.au.auth0.com   \  both required for real
 *   AUTH0_AUDIENCE  - your Auth0 API identifier      /  token verification
 */

const TOP_K = 5;
const MAX_RETRIES = 5;        // free Space CPU can cold-start for a bit
const RETRY_DELAY_MS = 3000;

// The one origin this Worker exists to serve. Used as the CORS fallback so an
// unset/!misconfigured ALLOWED_ORIGINS can never degrade to a wildcard.
const CANONICAL_ORIGIN = "https://findflower.me";

// Reject junk like `Bearer x` before spending a JWKS fetch on it.
const MIN_TOKEN_LENGTH = 16;

function allowedOrigins(env) {
  // A literal `*` is dropped rather than honoured: this Worker fronts a model
  // that costs money to run, so "any website may call it" is never the answer.
  const configured = (env.ALLOWED_ORIGINS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((s) => s !== "*");
  return configured.length ? configured : [CANONICAL_ORIGIN];
}

function corsHeaders(request, env) {
  // CORS can only name ONE origin, so echo the request's origin when it is on
  // the allowlist and fall back to the canonical site otherwise.
  const list = allowedOrigins(env);
  const reqOrigin = request.headers.get("Origin") || "";
  const allow = list.includes(reqOrigin) ? reqOrigin : CANONICAL_ORIGIN;
  return {
    "Access-Control-Allow-Origin": allow,
    "Vary": "Origin",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    // Authorization must be listed or the browser discards the POST after
    // preflight -- the token header is what makes this a non-simple request.
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400",
  };
}

function json(body, status, request, env, extraHeaders) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...corsHeaders(request, env),
      ...(extraHeaders || {}),
    },
  });
}

/* Standard shape for an auth failure. WWW-Authenticate is what makes a 401 a
   real 401 rather than a bare status code, and it tells clients why. */
function unauthorized(reason, request, env) {
  return json({ error: "Unauthorized", detail: reason }, 401, request, env, {
    "WWW-Authenticate": `Bearer realm="findflower", error="invalid_token", error_description="${reason}"`,
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function originAllowed(origin, env) {
  return allowedOrigins(env).includes(origin);
}

/* ===========================================================================
   AUTH GATE
   ---------------------------------------------------------------------------
   Two layers, and it matters which one is actually running:

   1. STRUCTURE (always on). The request must carry
      `Authorization: Bearer <token>` with a plausible token, or it is 401'd
      here and never reaches Hugging Face.

   2. VERIFICATION (only when AUTH0_DOMAIN *and* AUTH0_AUDIENCE are set). The
      token is parsed as a JWT and checked for real: RS256 signature against
      the tenant's published JWKS, plus issuer, audience and expiry.

   Layer 1 alone stops crawlers and casual scripted reuse, but it cannot tell a
   genuine token from the string "Bearer aaaaaaaaaaaaaaaa" -- anyone who reads
   this file can craft one. Only layer 2 is a lock. Set both vars.

   Auth0 issues a *verifiable* JWT only when the client requests an `audience`;
   without one it returns an opaque token that no resource server can validate.
   So AUTH0_AUDIENCE must match the audience the frontend asks for.
   =========================================================================== */

// JWKS lives at module scope: Workers reuse an isolate across requests, so this
// caches the fetch for the isolate's lifetime instead of hitting Auth0 per scan.
let _jwksCache = { url: "", keys: null, fetchedAt: 0 };
const JWKS_TTL_MS = 60 * 60 * 1000;   // an hour; key rotation is far slower

function b64urlToBytes(s) {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function b64urlToJson(s) {
  return JSON.parse(new TextDecoder().decode(b64urlToBytes(s)));
}

function issuerFor(domain) {
  return "https://" + String(domain).replace(/^https?:\/\//, "").replace(/\/+$/, "") + "/";
}

async function getSigningKey(kid, issuer) {
  const url = issuer + ".well-known/jwks.json";
  const fresh = _jwksCache.keys && _jwksCache.url === url &&
    Date.now() - _jwksCache.fetchedAt < JWKS_TTL_MS;

  if (fresh) {
    const hit = _jwksCache.keys.find((k) => k.kid === kid);
    if (hit) return hit;
    // Unknown kid on a warm cache means the tenant rotated keys -- refetch once
    // rather than 401'ing every user until the TTL expires.
  }

  const res = await fetch(url, { cf: { cacheTtl: 3600, cacheEverything: true } });
  if (!res.ok) return null;
  const body = await res.json().catch(() => null);
  if (!body || !Array.isArray(body.keys)) return null;
  _jwksCache = { url, keys: body.keys, fetchedAt: Date.now() };
  return body.keys.find((k) => k.kid === kid) || null;
}

/* Full JWT check. Resolves { ok } or { ok: false, reason }; never throws, so a
   transient JWKS hiccup surfaces as a clean 401 instead of a 500. */
async function verifyAuth0Token(token, env) {
  const parts = token.split(".");
  if (parts.length !== 3) {
    // Almost always the audience-less opaque token; name it precisely.
    return { ok: false, reason: "token is not a JWT (request an Auth0 audience)" };
  }

  let header, payload;
  try {
    header = b64urlToJson(parts[0]);
    payload = b64urlToJson(parts[1]);
  } catch {
    return { ok: false, reason: "token is not decodable" };
  }

  // Pin the algorithm. Accepting whatever `alg` the token declares is the
  // classic JWT break -- `none` bypasses signing entirely and `HS256` lets an
  // attacker sign with the public key as an HMAC secret.
  if (header.alg !== "RS256") return { ok: false, reason: "unexpected token algorithm" };
  if (!header.kid) return { ok: false, reason: "token has no key id" };

  const issuer = issuerFor(env.AUTH0_DOMAIN);
  if (payload.iss !== issuer) return { ok: false, reason: "wrong token issuer" };

  // `aud` is a string for one audience and an array when the client also asked
  // for /userinfo, which the SPA SDK does by default.
  const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!aud.includes(env.AUTH0_AUDIENCE)) return { ok: false, reason: "wrong token audience" };

  const now = Math.floor(Date.now() / 1000);
  const SKEW = 60;   // tolerate a minute of clock drift
  if (typeof payload.exp !== "number" || payload.exp + SKEW < now) {
    return { ok: false, reason: "token expired" };
  }
  if (typeof payload.nbf === "number" && payload.nbf - SKEW > now) {
    return { ok: false, reason: "token not yet valid" };
  }

  const jwk = await getSigningKey(header.kid, issuer);
  if (!jwk) return { ok: false, reason: "signing key unavailable" };

  let valid = false;
  try {
    const key = await crypto.subtle.importKey(
      "jwk",
      { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"],
    );
    valid = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      key,
      b64urlToBytes(parts[2]),
      new TextEncoder().encode(parts[0] + "." + parts[1]),
    );
  } catch {
    return { ok: false, reason: "signature check failed" };
  }
  if (!valid) return { ok: false, reason: "invalid token signature" };

  return { ok: true, sub: payload.sub };
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
    // websites' browsers. (curl can spoof Origin, so the token check below and
    // the Space's own secret are the real walls -- defense in depth.)
    const origin = request.headers.get("Origin");
    if (origin && !originAllowed(origin, env)) {
      return json({ error: "Origin not allowed." }, 403, request, env);
    }

    // ---- AUTH GATE: refuse before doing any work ----
    // Deliberately ahead of body parsing and the upstream call, so an
    // unauthenticated request costs us a header read and nothing else.
    //
    // ENFORCE_AUTH is the rollout switch, and it fails CLOSED: only the exact
    // string "false" (any case) disarms the gate. An unset, empty, misspelled
    // or nonsense value enforces. A security switch that opens on a typo --
    // "no", "0", "flase" -- is the wrong way round, so the safe state is the
    // default and disabling it has to be deliberate.
    //
    // While disarmed the gate evaluates every request exactly as it would when
    // armed, reports the verdict in X-FF-Auth, and then serves it anyway. That
    // exists so the Worker and the frontend can be deployed in either order
    // without a window where scanning is broken: deploy with ENFORCE_AUTH set
    // to "false" (preflight starts accepting Authorization, anonymous scans
    // keep working), publish the frontend, confirm X-FF-Auth reads `ok`, then
    // remove the var to arm it.
    const enforcing = String(env.ENFORCE_AUTH ?? "").toLowerCase() !== "false";
    const audit = { outcome: "ok", reason: "" };

    const authHeader = request.headers.get("Authorization") || "";
    const match = /^Bearer\s+(\S+)$/i.exec(authHeader.trim());
    if (!match) {
      audit.outcome = "reject";
      audit.reason = authHeader
        ? "Authorization header is malformed"
        : "Authorization header is required";
    } else if (match[1].length < MIN_TOKEN_LENGTH) {
      audit.outcome = "reject";
      audit.reason = "Authorization header is malformed";
    } else if (env.AUTH0_DOMAIN && env.AUTH0_AUDIENCE) {
      // Cryptographic verification when the tenant is configured. Without both
      // vars the Worker has no way to tell a real token from a fabricated one,
      // so it falls through on structure alone.
      const verdict = await verifyAuth0Token(match[1], env);
      if (!verdict.ok) {
        audit.outcome = "reject";
        audit.reason = verdict.reason;
      }
    } else {
      audit.outcome = "unverified";
      audit.reason = "AUTH0_DOMAIN/AUTH0_AUDIENCE not set";
    }

    if (audit.outcome === "reject" && enforcing) {
      return unauthorized(audit.reason, request, env);
    }
    // Not enforcing (or nothing to enforce): carry the verdict on the response
    // so a dry run is observable in the browser's network tab and in logs.
    const authAudit = {
      "X-FF-Auth": enforcing
        ? audit.outcome
        : audit.outcome === "reject"
          ? "would-reject: " + audit.reason
          : audit.outcome,
    };

    if (!env.SPACE_URL || !env.PROXY_SECRET) {
      return json({ error: "Server misconfigured (SPACE_URL/PROXY_SECRET)." }, 500, request, env);
    }

    // Accept BOTH body shapes:
    //   - multipart/form-data with a `file` field  <- what try.html sends (FormData)
    //   - a raw image body                         <- curl --data-binary, API users
    //
    // This used to read the body as raw bytes unconditionally, which silently
    // broke the actual website: a multipart upload got re-wrapped envelope and
    // all, so the server received MIME boundary text instead of a JPEG and
    // answered "Invalid image: cannot identify image file" -> 502 for every
    // upload from findflower.me.
    const reqType = (request.headers.get("Content-Type") || "").toLowerCase();
    let imageBlob;

    if (reqType.includes("multipart/form-data")) {
      let inbound;
      try {
        inbound = await request.formData();
      } catch {
        return json({ error: "Malformed multipart body." }, 400, request, env);
      }
      const filePart = inbound.get("file");
      if (!filePart || typeof filePart === "string") {
        return json({ error: "Multipart body is missing a `file` field." }, 400, request, env);
      }
      if (filePart.size === 0) {
        return json({ error: "Empty image body." }, 400, request, env);
      }
      imageBlob = filePart;
    } else {
      const image = await request.arrayBuffer();
      if (!image || image.byteLength === 0) {
        return json({ error: "Empty image body." }, 400, request, env);
      }
      imageBlob = new Blob([image], { type: reqType || "image/jpeg" });
    }

    // The backend expects multipart/form-data with a `file` field.
    const form = new FormData();
    form.append("file", imageBlob, "upload.jpg");

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

    return json(payload, 200, request, env, authAudit);
  },
};
