# Deploy the FindFlower ViT inference server to Render

## What's already done
- Worker deployed: `https://findflower-proxy.fofi.workers.dev`
- Worker secrets set: `PROXY_SECRET`, `SPACE_TOKEN`, `ALLOWED_ORIGINS`
- App files ready in `C:\Users\DELL\Desktop\FF\space\`

## What you need to do

### 1. Push `space/` to a Git repo

```powershell
cd C:\Users\DELL\Desktop\FF\space
git init
git add -A
git commit -m "Initial FindFlower ViT inference server"
```

Then push to GitHub/GitLab (create a new **private** repo there first):
```powershell
git remote add origin <your-repo-url>
git push -u origin main
```

### 2. Deploy on Render

1. Go to **render.com** → sign in (or create free account)
2. **New +** → **Blueprint**
3. **Connect a repository** → authorize GitHub/GitLab, pick the repo you just pushed
4. Render reads `render.yaml` automatically → click **Apply**
5. It creates a **Web Service** named `findflower-vit` on the free plan

### 3. Set the two secrets in Render's dashboard

Once the service is created:
1. Go to the service → **Environment** tab
2. Add two **Secret Files**:
   - Key: `HF_TOKEN`, Value: `<your Hugging Face read token>`
   - Key: `PROXY_SECRET`, Value: `<the shared secret set on the Worker>`
3. Click **Save Changes** → Render redeploys automatically

### 4. Get the URL and give it to me

After deploy finishes (first build takes ~3-5 min), Render shows the service URL:
`https://findflower-vit-<random>.onrender.com`

**Paste that URL here** so I can:
- Set `SPACE_URL` on the Worker
- Run the curl test (Worker → Render → model prediction)
- Wire up `try.html` to call the Worker
- Update the privacy copy

---

**IMPORTANT for later (not now):**
- The shared `PROXY_SECRET` value is stored locally (not in this repo) — you'll need it if you ever redeploy Render and lose the env vars. Retrieve it with `wrangler secret list` context or your local notes.
- The free Render tier sleeps after 15 min idle. Your plan to ping it with UptimeRobot every 5-14 min will keep it warm. The Worker's 5-retry loop already handles the worst-case cold start if the ping ever misses.
