# FindFlower inference proxy

Tiny Cloudflare Worker that holds the Hugging Face token and forwards uploaded
images to the HF Inference API. Keeps the model repo private and the token out
of the browser.

## Deploy (one time)

1. Install Wrangler and log in (free Cloudflare account):
   ```
   npm install -g wrangler
   wrangler login
   ```

2. From this folder, store your HF **read** token as a secret (never in code):
   ```
   cd proxy
   wrangler secret put HF_TOKEN
   # paste your hf_... read token when prompted
   ```

3. (Optional but recommended) lock CORS to your site — edit `wrangler.toml`,
   uncomment `[vars]` and set `ALLOWED_ORIGIN` to your real origin.

4. Publish:
   ```
   wrangler deploy
   ```
   Wrangler prints the URL, e.g. `https://findflower-proxy.<you>.workers.dev`.
   That URL is what `try.html` will POST to.

## Test it

```
curl -X POST --data-binary @some_flower.jpg \
  -H "Content-Type: image/jpeg" \
  https://findflower-proxy.<you>.workers.dev
```
Expect: `{"flower":"...","confidence":0.93,"top_k":[...]}`.

If you get a 502 with an upstream "not found / not supported" detail, HF's
serverless inference won't serve this custom private model — see the fallback
note in the chat (host serve_vit.py on a small always-on box instead).
