# FindFlower inference proxy

Cloudflare Worker that sits between the public frontend and the ONNX inference
backend. It holds the shared secret and enforces an origin allowlist, so the
backend can't be used as a free open API.

```
browser --(multipart or raw bytes)--> Worker --(multipart + X-Proxy-Secret)--> backend
```

## Request contract

`POST` the image. Both shapes are accepted: **raw image bytes** under an image
`Content-Type`, which is what the examples here use, or **`multipart/form-data`**
with a `file` field, which is what a browser's `FormData` sends. Either way the
Worker forwards multipart upstream.

A signed-in visitor's Auth0 access token rides in `Authorization`. On the public
API route (`POST /v1/identify`) that token is mandatory: the route is account-only
and has no anonymous mode. On the in-app route (`POST /internal/scan`) it is
optional, which is what lets a guest identify a flower from `/try`.

```
curl -X POST --data-binary @some_flower.jpg \
  -H "Content-Type: image/jpeg" \
  -H "Authorization: Bearer <auth0-access-token>" \
  https://findflower-proxy.<you>.workers.dev
```

Returns `{"flower":"...","confidence":0.93,"top_k":[{"name":"...","confidence":0.93}]}`,
or `401` with a `WWW-Authenticate` header when the token is absent, malformed, or
fails verification. The gate runs before the body is read and before the shared
budget is charged, so a rejected request neither reaches the inference backend nor
spends a scan.

> [!NOTE]
> `-F file=@photo.jpg` is fine now, and so is `--data-binary`. Multipart used to
> come back `Invalid image`: the Worker read every body as raw bytes, so the MIME
> envelope went upstream as though it were a JPEG. `worker.js` unwraps a
> multipart body and forwards the `file` field on its own, which is what every
> upload from the website is.

## Routing: pages, assets, and the model routes

The Worker is the front door for the whole hostname (`findflower.me/*`), and it
sorts every request into three buckets.

**Pages, and the API that belongs to them, go to the Node app** on HidenCloud
(`SITE_UPSTREAM`): `/`, `/dashboard`, `/profile`, `/community`, `/chat`,
`/try`, `/login`, `/callback`, `/logout`, everything under `/api/`, and anything
else that is not a static asset. Serving the page and the API it calls from one
origin is what lets the session cookie be same-origin, and it is why the
signed-in header survives navigation instead of reverting on the next page.

**Static assets stay on GitHub Pages.** `fetch(request)` inside a Worker is a
same-zone subrequest: Cloudflare sends it to the zone's origin server and does
not re-enter the Worker, so a stylesheet comes back a stylesheet. The list of
what counts as an asset is in `isStaticAsset()`; a document, including
`/chat/index.html`, is a page and goes to Node.

**The Worker's own endpoints** are answered here, never forwarded: `GET
/health`, `GET /warm`, `POST /internal/scan`, `POST /v1/identify`, `/trefle/*`
and `/v1/community/*`.

`www.findflower.me` answers `308` to `findflower.me` for everything. The session
cookie is host-only, so two hostnames would mean two sessions.

`GET /health` is the liveness check. It is answered by the Node app, which is the
thing whose liveness the page actually needs: it says nothing about whether the
model is awake, and it is free to poll.

`GET /warm` asks the backend to wake up and returns `{"warming":true}` straight
away, without waiting for it. `/try` calls this on page load, because a sleeping
backend needs around two minutes to boot and nobody watches a spinner that long;
the boot then overlaps with choosing a photo instead of landing on whoever
pressed Identify. It is origin-gated, unlike the health check, since it does
spend backend compute. It never reports readiness, only that the poke was
sent. Both `GET` and `HEAD` answer `202` with `Cache-Control: no-store`.

## Configuration

Set as Worker secrets/vars, never in code:

| Name | Purpose |
| --- | --- |
| `INFERENCE_UPSTREAM` | Optional base URL of the inference backend (no trailing `/predict`). Unset in production: inference runs on `SITE_UPSTREAM` |
| `PROXY_SECRET` | Shared secret; must match the backend's `PROXY_SECRET` exactly |
| `ALLOWED_ORIGINS` | Comma-separated CORS allowlist. `*` is ignored — the fallback is `https://findflower.me` |
| `SPACE_TOKEN` | Optional bearer token, only needed if the backend is access-gated |
| `AUTH0_DOMAIN` | Auth0 tenant, e.g. `dev-jvit0r04itv8hfjz.us.auth0.com`. Enables JWT verification |
| `AUTH0_AUDIENCE` | Auth0 API identifier. Must match `AUTH0_AUDIENCE` in `try.html` |
| `SITE_UPSTREAM` | Where the server-rendered pages live, e.g. `http://pat.hidencloud.com:24729`. Unset it and every path falls back to GitHub Pages |
| `ENFORCE_AUTH` | Leave `"false"` while the gate is disarmed; the literal string is what disarms it |

```
npm install -g wrangler
wrangler login
cd proxy
wrangler secret put PROXY_SECRET
wrangler deploy
```

A `PROXY_SECRET` mismatch shows up as a **502 from the Worker** wrapping a 401
from the backend — check both sides agree before digging further.

## Authentication

The auth gate has two layers, and only the second one is a lock.

**Structure** (always on): the request must present `Authorization: Bearer <token>`.
Missing header, wrong scheme, or an implausibly short token → `401`, before any
body parsing or upstream call.

**Verification** (only when `AUTH0_DOMAIN` *and* `AUTH0_AUDIENCE` are set): the
token is validated as a real JWT — RS256 signature checked against the tenant's
published JWKS, plus issuer, audience and expiry. The algorithm is pinned, so
`alg: none` and HS256-confusion tokens are rejected outright.

> [!IMPORTANT]
> With the two Auth0 vars unset the Worker cannot distinguish a genuine token
> from a fabricated one — anyone can send `Authorization: Bearer aaaaaaaaaaaaaaaa`
> and reach the model. Structure-only mode stops crawlers and casual reuse, not a
> determined caller. Set both vars for real protection.

Auth0 only issues a *verifiable* JWT when the client requests an **audience**;
without one it returns an opaque token no resource server can validate. So
`AUTH0_AUDIENCE` here and `AUTH0_AUDIENCE` in `try.html` must both be set to the
same API identifier, or verification will reject every signed-in user with
`token is not a JWT`.

Run `node worker.test.mjs` from this directory to exercise the gate — it mints
real RS256 tokens against a stub JWKS and asserts that expired, tampered,
wrong-audience, wrong-issuer and downgraded tokens are all refused before the
backend is called.

### Where it stands

The dry-run lever is on: `ENFORCE_AUTH = "false"` in `wrangler.toml`, so the gate
evaluates and reports instead of refusing. `try.html` matches that with
`REQUIRE_SIGN_IN = false`, and it does send a token when the visitor happens to
have one (`SEND_AUTH_TOKEN = true`), which is what makes `X-FF-Auth` worth
reading: `ok` on a signed-in scan, `would-reject: Authorization header is
required` on a guest one.

The lever does not reach the API route. `POST /v1/identify` requires a verified
token whether the lever is on or off, because an anonymous caller must never be
able to spend the shared pool.

Arming the lever is one change in two places at once. Delete the `ENFORCE_AUTH`
line, `wrangler deploy`, and set `REQUIRE_SIGN_IN = true` in `try.html` in the
same rollout. An armed Worker against a page that still lets guests through means
every anonymous scan 401s, and only after the photo has already gone up the wire.

## Quota

Two inference routes, counted in opposite ways:

| Route | Metered | Why |
| --- | --- | --- |
| `POST /internal/scan` | No, unlimited | the site's own scanner; a visitor identifying a flower must not be able to exhaust the API's allowance |
| `POST /v1/identify` | Yes, shared pool | the documented API, and the only way to spend the pool |

The pool is a single `GlobalInferenceBudget` Durable Object shared by every
authenticated caller, not a per-account allowance. It refills in two batches a
day: **1,000,000** scans when the 00:00 UTC batch opens, **500,000** when the
12:00 UTC batch opens. Nothing accrues between batches, and a spent batch answers
`429` with `Retry-After` until the next one opens. Responses carry
`X-RateLimit-Limit`, `X-RateLimit-Remaining` and `X-RateLimit-Reset`, and a metered
response is only ever produced for a request that already cleared the auth gate.

## Defense in depth

The origin gate blocks other websites' browsers, but `curl` can spoof an `Origin`
header, so it isn't a wall on its own. The token gate blocks unauthenticated
callers. The backend independently checks `X-Proxy-Secret` on every `/predict`
call. All three layers are load bearing.
