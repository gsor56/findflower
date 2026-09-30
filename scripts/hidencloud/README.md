# FindFlower on HidenCloud

GitHub stores the code. The Node application on HidenCloud serves HTML, APIs,
PWA files, videos and the bundled browser model, with Cloudflare as its front
door. `.github/workflows/pages.yml` is retired. The replacement workflow is
`.github/workflows/deploy.yml`.

## One-time configuration

In **GitHub > Settings > Secrets and variables > Actions**, add these repository
secrets (never put their values in a committed file):

- `SFTP_PASSWORD`: HidenCloud SFTP password.
- `HIDENCLOUD_API_KEY`: active HidenCloud Client API key, authorized to restart
  this server.
- `CLOUDFLARE_API_TOKEN`: token authorized to deploy the `findflower-proxy` Worker
  and its routes.

Add these repository variables:

- `SFTP_HOST_KEY`: SHA256 fingerprint of the verified host key for
  `pat.hidencloud.com:2022`. The local `.hidencloud-local/known_hosts` file holds
  the already-recorded public host key; `ssh-keygen -lf` prints its fingerprint.
- `SFTP_REMOTE_ROOT`: `/` for the current SFTP account.
- `HIDENCLOUD_PANEL_URL`: `https://panel.hidencloud.com`.
- `HIDENCLOUD_SERVER_ID`: server identifier from the Client API/panel, expected
  to correspond to the SFTP account suffix `9753ee4c`; verify it before use.
- `CLOUDFLARE_ACCOUNT_ID`: account containing the existing Worker.
- `HIDENCLOUD_BOOTSTRAP_REVISION`: the known Git revision matching the initial live files.
  This is only needed until the first full deployment writes its server manifest.

The deployment uses Paramiko for **SFTP**, not FTP. SamKirkland's FTP action does
not speak SFTP on port 2022. The pipeline verifies source mappings, protects
server edits, uploads checksummed files with backups, restarts the application,
updates the Cloudflare Worker, and verifies the public site.

Configure the server's startup process to install changed dependencies before
starting Node, for example `npm ci --omit=dev && node index.js`, using the panel's
supported startup settings. SFTP cannot execute npm or change the running process.

## Local commands

To publish the reviewed migration from a normal Windows PowerShell terminal:

```powershell
& .\scripts\hidencloud\publish.ps1
```

This runs the checks, commits the listed migration/showcase follow-ups, and
pushes `main` with the existing credential helper. It stops on errors and
excludes unrelated working-tree changes. Repository secrets and the initial
deployment baseline must also be configured before CI can deploy successfully.

Local credentials may be supplied through temporary environment variables or
interactive SFTP password input. No local `.env` is required.

```powershell
python -m pip install --target .hidencloud-local/python paramiko==4.0.0
python scripts/hidencloud/sftp.py host-key
python scripts/hidencloud/sftp.py inspect
node scripts/hidencloud/manifest.mjs HEAD .hidencloud-local/bundle
python scripts/hidencloud/sftp.py showcase
```

For a full initial deployment, build a separate baseline manifest from the known
live revision, then pass its `deployment.json` via `--baseline`. Use `--dry-run`
first to see the changes. A mismatch stops the upload instead of overwriting an
unreviewed server edit. The main pipeline requires committed source; unrelated
training changes in the working tree do not enter its bundle.

After the backend is ready, deploy the Worker with an authenticated Wrangler:

```powershell
node scripts/hidencloud/verify-live.mjs --origin-only
npx wrangler deploy --config proxy/wrangler.toml
node scripts/hidencloud/verify-live.mjs
```

Only proceed to Wrangler if the origin check passes. It checks the browser
model, video ranges, PWA and the protected backend scan route before traffic
switches. The public check then runs a real scan through Cloudflare.

The Worker must be updated too: otherwise HTML can come from HidenCloud while
video and model URLs still go to the retired Pages origin and return 404.

## Server-to-GitHub synchronization

Use a repository-scoped write credential in the server's Git credential helper
or a GitHub deploy key. Do not embed it in the source or a remote URL.
From the server console, after a completed full deployment:

```sh
git --version
npm run sync:server:setup
node scripts/hidencloud/setup-sync.mjs --install-cron
```

If cron is unavailable, run `npm run sync:server:watch` under the server's
process manager. It checks every five minutes. Merely uploading the script does
not start a background process.

The sync script uses an isolated checkout under `.hidencloud/repo`, fetches main,
reconstructs server edits against the deployed baseline, and cherry-picks them
onto the latest main. It commits as `sync(server): automated sync from HidenCloud`
and pushes normally, triggering the same deployment workflow. It never force
pushes. Conflicting edits are retained on a `server-sync/*` branch for review,
and deployments stop while there are conflicting live edits. Secrets, dependencies,
runtime caches and deployment backups are outside the sync allowlist.

## Checks

```sh
node proxy/worker.test.mjs
node scripts/hidencloud/deployment.test.mjs
node scripts/hidencloud/verify-live.test.mjs
node scripts/hidencloud/sync.integration.mjs
python -m unittest discover -s scripts/hidencloud -p '*_test.py'
node scripts/hidencloud/verify-live.mjs
```

Live verification includes five videos with byte-range responses, the PWA
manifest/service worker, browser model shards, and one real `/internal/scan`
request. A successful page response alone does not prove the migration finished.
