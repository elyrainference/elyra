# Deploy the website to Cloudflare Pages

The docs are rendered by `tools/pages/docs.mjs` (grouped sidebar, search, on-page contents, prev/next) using the same fonts, colours and components as the landing page and panel; `docs.css` and `docs.js` hold the look and behaviour, and the sidebar order and descriptions are the `NAV` list at the top of `docs.mjs`. Search is client-side over `docs/assets/search-index.json`, built from the Markdown at the same time.

What gets published: the **landing page** (`site/`, a static WebGL mirror) and these **docs** rendered to HTML at `/docs/`. `/app/` on the website redirects to the live node (`app.elyrainference.com`, see [REMOTE-ADMIN](REMOTE-ADMIN.md#public-market-page-optional)); there is no static demo. **A real node's control API is never published through Pages**: it is loopback-only by design (wallet and keys live behind it). The node never runs on Cloudflare Pages; only static files do.

Bundle size: about 14 MB, 100 files. Pages limits are 20,000 files and 25 MiB per file, so there is plenty of room.

## 1. Build locally

```bash
cd tools/pages
npm ci
npm run build          # writes ../../dist: landing + docs/<page>/index.html + _redirects + _headers
```

`REPO_URL=https://github.com/you/elyra npm run build` changes where non-doc links (source files) point.

Preview before publishing: `npx wrangler pages dev dist` (or any static server on `dist/`).

## 2. Create a Cloudflare API token

Cloudflare dashboard → My Profile → API Tokens → Create Token → Custom:

- Permission: **Account → Cloudflare Pages → Edit**
- Account Resources: your account only

Note the **Account ID** (dashboard sidebar, or `Workers & Pages` overview). Treat the token like a password: never paste it into an issue, a commit or a chat; if it leaks, roll it in the dashboard.

## 3. First deploy (CLI)

```bash
export CLOUDFLARE_API_TOKEN=...        # from step 2
export CLOUDFLARE_ACCOUNT_ID=...
npx wrangler pages project create elyra --production-branch=main
npx wrangler pages deploy dist --project-name=elyra --branch=main
```

The site is live at `https://<project>.pages.dev`. Pages subdomains are global: if `elyra.pages.dev` is taken Cloudflare adds a suffix (the first deploy of this project got `elyra-5cg.pages.dev`). The deploy output prints the exact host; use it in the checks below.

## 4. Automatic deploys from GitHub

`.github/workflows/deploy-pages.yml` rebuilds and deploys on every push to `main` that touches `site/`, `docs/`, root Markdown or `tools/pages/`. Add two repository secrets (Settings → Secrets and variables → Actions): `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`. The job only runs on the upstream repository, so forks without secrets do not fail.

Alternative: connect the repo in the dashboard (Workers & Pages → Create → Pages → Connect to Git) with build command `cd tools/pages && npm ci && npm run build` and output directory `dist`.

## 5. Custom domain

Workers & Pages → `elyra` → Custom domains → add your domain. If the domain's DNS is on Cloudflare the record is created for you. Before launch, run a trademark and domain check: "Elyra" is also an unrelated JupyterLab project (see `docs/STATUS.md`, Naming).

## 6. Verify

```bash
curl -sI https://elyra.pages.dev/ | head -1                 # HTTP/2 200
curl -sI https://elyra.pages.dev/docs/install/ | head -1    # 200
curl -sI https://elyra.pages.dev/app/ | grep -i location          # https://app.elyrainference.com/
curl -sI https://elyra.pages.dev/.elyra/identity.json | head -1   # 404 (there is a 404.html; without one Pages answers 200 with the landing)
```

## Rollback

Workers & Pages → `elyra` → Deployments → pick an earlier deployment → Rollback. Or `git revert` and push.

## Honesty reminder

The landing is a marketing surface: "600+ models / 150+ providers" is a **launch target**, a fresh node's demo market is simulated, and "TEE-verified" must not appear until milestone M1 is recorded in `docs/STATUS.md`. Do not add third-party trackers (see `AGENTS.md`).
