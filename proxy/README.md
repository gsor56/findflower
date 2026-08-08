# FindFlower inference proxy

Cloudflare Worker that sits between the public frontend and the ONNX inference
backend. It holds the shared secret and enforces an origin allowlist, so the
backend can't be used as a free open API.

```
browser --(raw image bytes)--> Worker --(multipart + X-Proxy-Secret)--> backend
```

## Request contract

`POST` the **raw image bytes** as the body — not multipart. The Worker builds the
multipart `file` field itself before forwarding. Every request must carry an
Auth0 access token; there is no anonymous access.

```
curl -X POST --data-binary @some_flower.jpg \
  -H "Content-Type: image/jpeg" \
  -H "Authorization: Bearer <auth0-access-token>" \
  https://findflower-proxy.<you>.workers.dev
```

Returns `{"flower":"...","confidence":0.93,"top_k":[{"name":"...","confidence":0.93}]}`,
or `401` with a `WWW-Authenticate` header when the token is absent, malformed,
or fails verification. The gate runs before the body is read, so a rejected
request never reaches the inference backend.

> [!TIP]
> Sending `-F file=@photo.jpg` instead will fail with `Invalid image` — the whole
> multipart envelope gets wrapped as image bytes. Use `--data-binary`.

## Configuration

Set as Worker secrets/vars, never in code:

| Name | Purpose |
| --- | --- |
| `SPACE_URL` | Base URL of the inference backend (no trailing `/predict`) |
| `PROXY_SECRET` | Shared secret; must match the backend's `PROXY_SECRET` exactly |
| `ALLOWED_ORIGINS` | Comma-separated CORS allowlist. `*` is ignored — the fallback is `https://findflower.me` |
| `SPACE_TOKEN` | Optional bearer token, only needed if the backend is access-gated |
| `AUTH0_DOMAIN` | Auth0 tenant, e.g. `findflower.au.auth0.com`. Enables JWT verification |
| `AUTH0_AUDIENCE` | Auth0 API identifier. Must match `AUTH0_AUDIENCE` in `try.html` |

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

## Defense in depth

The origin gate blocks other websites' browsers, but `curl` can spoof an `Origin`
header, so it isn't a wall on its own. The token gate blocks unauthenticated
callers. The backend independently checks `X-Proxy-Secret` on every `/predict`
call. All three layers are load bearing.
