# FindFlower inference proxy

Cloudflare Worker that sits between the public frontend and the ONNX inference
backend. It holds the shared secret and enforces an origin allowlist, so the
backend can't be used as a free open API.

```
browser --(raw image bytes)--> Worker --(multipart + X-Proxy-Secret)--> backend
```

## Request contract

`POST` the **raw image bytes** as the body — not multipart. The Worker builds the
multipart `file` field itself before forwarding.

```
curl -X POST --data-binary @some_flower.jpg \
  -H "Content-Type: image/jpeg" \
  https://findflower-proxy.<you>.workers.dev
```

Returns `{"flower":"...","confidence":0.93,"top_k":[{"name":"...","confidence":0.93}]}`.

> [!TIP]
> Sending `-F file=@photo.jpg` instead will fail with `Invalid image` — the whole
> multipart envelope gets wrapped as image bytes. Use `--data-binary`.

## Configuration

Set as Worker secrets/vars, never in code:

| Name | Purpose |
| --- | --- |
| `SPACE_URL` | Base URL of the inference backend (no trailing `/predict`) |
| `PROXY_SECRET` | Shared secret; must match the backend's `PROXY_SECRET` exactly |
| `ALLOWED_ORIGINS` | Comma-separated CORS allowlist, e.g. `http://localhost:8000,https://findflower.me` |
| `SPACE_TOKEN` | Optional bearer token, only needed if the backend is access-gated |

```
npm install -g wrangler
wrangler login
cd proxy
wrangler secret put PROXY_SECRET
wrangler deploy
```

A `PROXY_SECRET` mismatch shows up as a **502 from the Worker** wrapping a 401
from the backend — check both sides agree before digging further.

## Defense in depth

The origin gate blocks other websites' browsers, but `curl` can spoof an `Origin`
header, so it isn't a wall on its own. The backend independently checks
`X-Proxy-Secret` on every `/predict` call. Both layers are load bearing.
