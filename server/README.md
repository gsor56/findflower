# FindFlower social backend

Express 5 over MongoDB Atlas. It carries text and ids: posts, spaces, profiles,
friend rows, direct messages, and the search index over them.

Photos never arrive here. Scan thumbnails stay in the browser's IndexedDB
(`storage.js`), and identification runs in the Hugging Face Space behind
`proxy/worker.js`, not in this process. The only image-shaped field is a 160px
avatar data URL, capped in the schema.

## Run it locally

```
cd server
npm install
npm start          # or: npm run dev   (node --watch)
```

`MONGO_URI` has to be set. The repo-root `.env` is read from here by an explicit
path, so it works whether you start from `server/` or from the repo root.

```
curl http://127.0.0.1:4000/health
{"status":"ok","service":"findflower-social"}
```

`npm run check` parses `index.js` and `db.js` without connecting — useful when
Atlas is unreachable and you only want to know the file is valid.

## Environment

| Variable | Required | Default | What it does |
| --- | --- | --- | --- |
| `MONGO_URI` | yes | — | Atlas connection string, database `findflower`. Carries the password, so it lives in `.env` (gitignored) or in the host's dashboard. |
| `PORT` | no | `4000` | 3000 is the QA harness's static server; don't take it. |
| `HOST` | no | `0.0.0.0` | Set `127.0.0.1` for a local run so nothing on the network can reach a server pointed at the live cluster. |
| `FF_ALLOWED_ORIGINS` | no | — | Comma-separated extra CORS origins. `findflower.me`, `www.findflower.me` and `127.0.0.1:3000` / `localhost:3000` are already allowed. |
| `AUTH0_DOMAIN` | no | `dev-jvit0r04itv8hfjz.us.auth0.com` | Same public value `auth.js` ships to the browser. |
| `AUTH0_CLIENT_ID` | no | the SPA client id for that tenant | The audience accepted when AUTH0_AUDIENCE is not set. |
| `AUTH0_AUDIENCE` | no | `AUTH0_CLIENT_ID` | Set to `https://api.findflower.me` to require an access token for that API instead of the SPA ID token. |
| `AUTH0_ISSUER` | no | `https://$AUTH0_DOMAIN/` | For a staging tenant, or a test harness serving its own JWKS. |
| `AUTH0_JWKS_URL` | no | `$AUTH0_ISSUER.well-known/jwks.json` | As above. |

There is no variable that turns verification off.

### Server-rendered pages and the session

These are the variables the SSR half needs. Without them the pages still render;
only sign-in breaks, and it breaks loudly in the logs rather than silently.

| Variable | Required | Default | What it does |
| --- | --- | --- | --- |
| `AUTH0_SECRET` | yes in production | derived from MONGO_URI in dev | Signs the `ff_session` cookie. A derived secret means every restart invalidates every session, so production sets its own. |
| `AUTH0_BASE_URL` | recommended | localhost plus PORT | The public origin Auth0 redirects back to. On HidenCloud this must be the public URL, or /callback lands on the wrong host. |
| `AUTH0_CLIENT_SECRET` | yes for real login | - | The confidential-client secret. Without it the code exchange at /callback fails. |
| `AUTH0_ISSUER` | no | issuer derived from the domain | Staging tenant, or a harness serving its own JWKS. |
| `FF_PUBLIC_URL` | no | - | Fallback for AUTH0_BASE_URL. |

## Authentication

`Authorization: Bearer <token>`, an Auth0 RS256 JWT. `auth.js` verifies the
signature against the tenant's JWKS (cached 10 minutes, one forced refetch on an
unknown `kid`), the issuer, the audience and the expiry with 60 seconds of skew.
Node's `crypto` reads the JWK directly, so there is no JWT dependency.

Identity is the token's `sub`. Author and ownership checks compare
`req.viewer._id`, never anything the client sends.

A signed-in caller with no profile row yet gets `409 {needsHandle: true}` from
the routes that need an author. `POST /api/users` claims the handle.

## Routes

Reads are public unless marked. Rate limits are per address per window.

| Method | Path | Auth | Limit |
| --- | --- | --- | --- |
| GET | `/health` | — | — |
| GET | `/api/posts?space=&page=&limit=&before=` | optional (sets `likedByViewer`) | — |
| GET | `/api/posts/:id` | optional (sets `likedByViewer`) | — |
| POST | `/api/posts` | yes | 10 / 10 min |
| DELETE | `/api/posts/:id` | author only | — |
| POST | `/api/posts/:id/like` | yes | 60 / min |
| POST | `/api/posts/:id/report` | yes | 5 / hour |
| GET | `/api/spaces` | — | — |
| POST | `/api/spaces` | yes | 3 / hour |
| GET | `/api/users/me` | yes | — |
| POST | `/api/users` | yes | 20 / 10 min |
| GET | `/api/users/:handle` | optional | — |
| GET | `/api/friends` | yes | — |
| POST | `/api/friends/request` | yes | 30 / hour |
| POST | `/api/friends/respond` | yes | 60 / hour |
| GET | `/api/messages/:friendHandle?page=&limit=` | yes, accepted friend | — |
| POST | `/api/messages/:friendHandle` | yes, accepted friend | 30 / min |
| GET | `/api/search?q=` | — | 60 / min |

Paging is `page` + `limit` with a per-route ceiling (20 for posts, 30 for
messages). Posts also accept `before=<ISO date>` for a stable cursor read; a
cursor page ignores the offset, because applying both would skip a window.

Deletes are soft: `isDeleted = true`, and every read filters on it.

The SSR migration added these routes:

| Method | Path | Auth | What it does |
| --- | --- | --- | --- |
| GET | `/`, `/community`, `/notifications`, `/chat`, `/try`, `/contribute`, `/api` | session, optional | Renders the page through EJS with the session inlined and the first page of data already in the markup. |
| GET | `/api/events` | session | Server-Sent Events. New direct messages and friend-request changes fan out here; `scripts/live.js` holds one connection per tab. |
| POST | `/api/contributions` | session | Stages one crowdsourced photo after the browser junk filter has passed it. 2MB body limit, sha256 dedupe, 1.2MB byte cap. |
| GET, DELETE | `/api/contributions/mine`, `/api/contributions/:id` | session | A contributor own staged rows, and withdrawing one that has not synced. |

## Notes that cost time to rediscover

- Mongoose 9 middleware is promise-based. A `pre('validate')` hook gets no
  `next` and signals a problem by throwing. The callback form fails at runtime
  with `next is not a function`, which is what broke every friend row and DM
  until it was fixed.
- A field-level `unique: true` already builds the index. A matching
  `schema.index()` is a duplicate and mongoose warns about it.
- Use `returnDocument: 'after'` instead of `{ new: true }`.
- `seedDefaultSpaces()` upserts with `timestamps: false`; without it the
  plugin adds `$set: { updatedAt }` and every boot rewrites all four rows.
- Search falls back to a substring scan when the `$text` index is not built yet,
  rather than returning a 500 on a fresh database.

## Deploy

Any Node host that runs `npm start` from `server/`. Set `MONGO_URI` as an
environment variable there — not in a file — and add the site's origin to
`FF_ALLOWED_ORIGINS` if it is not one of the four already allowed. Leave `HOST`
unset so the platform's health check can reach the port. `SIGTERM` closes the
pool before exit, so a redeploy does not leave connections held on the cluster.

Atlas needs the host's egress addresses in its access list; a free-tier cluster
also pauses after inactivity, and the first request after that fails server
selection while it wakes.

`server/` is excluded from both site builders (`_config.yml` and the allowlist in
`.github/workflows/pages.yml`), so none of it is published to findflower.me.

## Server-rendered pages (SSR)

The pages are rendered here now, not shipped from GitHub Pages. EJS is the view
engine, and `server/lib/ssr.js` is the only place that knows how a page becomes
a response:

1. The body comes from the page's original HTML file, so the static build and
   the server render stay the same document.
2. The client-side Auth0 tags are stripped. `scripts/ssr-session.js` is injected
   in their place and answers the handful of globals the page scripts call
   (`ffUser`, `ffIsAuthenticated`, `ffLogin`, `getUserSession`).
3. `window.__FF_SSR__` carries the session and the first page of data.
4. `/community`, `/notifications` and `/chat` get that first page rendered into
   their list containers, so nobody watches a spinner for data the server
   already had.
5. `scripts/live.js` is injected deferred, and opens one SSE connection per tab.

Every value interpolated into markup goes through `escapeHtml`, and the JSON
bootstrap escapes the angle bracket, so a display name cannot close the script
element it sits inside.

Auth0 runs as middleware (`express-openid-connect`), not in the browser. The
session is an httpOnly, same-origin cookie. `resolveViewerSub()` in `lib.js`
prefers it and falls back to a bearer token, so non-browser API clients are
unaffected.

## Live updates

`GET /api/events` is Server-Sent Events rather than a WebSocket, and the reason
is the 3GB allocation: a stream needs no upgrade handshake, no second protocol
stack, and crosses the Cloudflare Worker as an ordinary streamed response.

`lib/events.js` is the fan-out. It is in-process (one instance, so Redis would
buy a dependency and no reach), it caps four streams per user and 400 in total,
and it drops the oldest tab rather than growing without bound. One shared
25-second heartbeat stops a proxy treating an idle stream as dead. Nothing is
broadcast until the row is written: a message that reached a reader but not the
database would vanish on the next reload, and that reload is the only repair a
client that missed the event has.

## Contribution pipeline

```
browser (Lite CNN verdict) -> POST /api/contributions -> ff_contributions
                                                              |
                     python server/scripts/sync_contributions_to_hf.py
                                                              v
                                          Hugging Face dataset repository
```

The junk filter runs in the browser, because the server has 3GB to protect and
this is the cheapest place to do the work. `POST /api/contributions` refuses a
`junk` verdict, and a `flower` verdict under 35 percent, without writing
anything; it dedupes on the sha256 of the decoded bytes; it stores the row
staged. The sync job publishes: re-encode to a 448px JPEG, upload under
`contributions/<taxon-slug>/<hash>.jpg`, mark the row synced. The destination
path comes from the content hash, so a run that dies half way resumes and never
publishes the same photo twice.

## Footprint

The target is a 3GB / 15GB container with an EVA-02 ONNX export still to come,
so the rule throughout is that no image model runs in this process.

- Dependencies are `express`, `mongoose`, `ejs`, `express-openid-connect` and
  `dotenv` - five, all server-side. Tailwind and TensorFlow.js are loaded by the
  page from the CDN and never belong to this package.
- JWT verification is hand-rolled over `node:crypto` instead of pulling in a JWT
  library, and the SSE bus is about ninety lines instead of a socket dependency.
- Identification stays in the browser (ONNX Runtime Web / TF.js) wherever it
  can. The ONNX EVA-02 artifact is sized for client-side execution or a separate
  inference host, not for this web process.
- The staging collection is a queue, not an image store: rows are capped at
  1.2MB and drain as soon as the sync job runs. Without that drain, a few
  thousand 448px JPEGs fill the free tier on their own.
