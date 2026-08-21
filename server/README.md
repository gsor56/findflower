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
| `AUTH0_DOMAIN` | no | `findflower.au.auth0.com` | Same public value `auth.js` ships to the browser. |
| `AUTH0_CLIENT_ID` | no | the SPA client id | Used as the audience until an API is registered. |
| `AUTH0_AUDIENCE` | no | `AUTH0_CLIENT_ID` | Set once an API exists in the Auth0 dashboard; access tokens for it are then accepted. |
| `AUTH0_ISSUER` | no | `https://$AUTH0_DOMAIN/` | For a staging tenant, or a test harness serving its own JWKS. |
| `AUTH0_JWKS_URL` | no | `$AUTH0_ISSUER.well-known/jwks.json` | As above. |

There is no variable that turns verification off.

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
