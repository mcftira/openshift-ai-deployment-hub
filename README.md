# OpenShift AI Deployment Hub — GLM-5.2 × 8×H100

Static ops console for deploying GLM-5.2 (W4A16) on a single 8×H100 node with
Red Hat OpenShift AI / vLLM. All Hugging Face links and weight downloads route
through a Cloudflare Worker proxy so the page is fully usable from networks
where huggingface.co is blocked.

## Live URLs

| What | URL |
| --- | --- |
| Hub page (GitHub Pages) | https://mcftira.github.io/openshift-ai-deployment-hub/app/ |
| HF proxy | https://hf-pull.mcftira.workers.dev |
| This repo | https://github.com/mcftira/openshift-ai-deployment-hub |

## Repo layout

```
app/index.html                     # the hub page (self-contained, no build)
glm52-h100-ops-console/index.html  # identical copy (Netlify bundle layout)
proxy/worker.js                    # Cloudflare Worker: HF pull-through proxy
proxy/wrangler.toml                # wrangler config (worker name: hf-pull)
```

## The proxy

`hf-pull.mcftira.workers.dev` reverse-proxies huggingface.co and rewrites its
302 redirects (to `us.aws.cdn.hf.co` etc.) so clients never touch an HF-owned
domain — only the worker domain. It forwards GET/HEAD (including Range
requests, so downloads are resumable) and allow-lists `huggingface.co` /
`hf.co` hosts only.

### Pulling the weights from an HF-blocked network

Via the HF CLI (works exactly like normal, just pointed at the proxy):

```bash
pip install -U "huggingface_hub[hf_transfer]"
export HF_ENDPOINT=https://hf-pull.mcftira.workers.dev
HF_HUB_ENABLE_HF_TRANSFER=1 hf download lowbitcoffee/GLM-5.2-W4A16 \
    --local-dir ./glm-5.2-w4a16
```

Or direct file URLs (18 total: 8 shards of 50/37.7 GB + config/tokenizer files,
plus the 7.6 GB DSpark speculator) — listed on the hub page, feed them to
`wget -i urls.txt -c` or `aria2c -i urls.txt`.

### Redeploying the worker

Needs Node.js. From `proxy/`:

```bash
npx wrangler login     # or: export CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=...
npx wrangler deploy
```

Account: Cloudflare account ID `fd66f31d76b775fae88ea212b41c6ff5`,
workers.dev subdomain `mcftira`. The API token used at setup is not stored in
this repo — create a new one (template: "Edit Cloudflare Workers") if needed.

## Caveats

- Free Workers plan does not meter bandwidth, so the ~395 GB of checkpoint
  traffic costs nothing, but sustained heavy proxying is outside the intended
  use of the free tier. If Cloudflare flags it, the paid plan is $5/mo.
- If the target network also blocks `*.workers.dev`, attach a custom domain
  to the worker (`npx wrangler domains add <host>`) — any domain on the same
  Cloudflare account works.
- GitHub Pages serves the site from the `main` branch root; pushes to `main`
  redeploy automatically in ~1 minute.
- The Netlify copy is maintained by hand — re-upload `app/index.html` there
  after changes.
