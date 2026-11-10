# Contributing

Thanks for helping. Elyra is early; small, well-tested changes land fastest.

## Ground rules

- Read [`AGENTS.md`](AGENTS.md) (map, hard rules) and [`docs/STATUS.md`](docs/STATUS.md) first. The hard rules are not negotiable: honest labels (`SIM`/`DEMO`/`CLAIMED`/`VERIFIED`), local surface stays local, no prompt logging, no plaintext key writes.
- No build step and one runtime dependency (`ethers`). Plain ESM on Node 20 or newer. Do not add a dependency without a strong reason in the PR.
- Tests assert **behaviour** (routing rules, billing equals receipt, failure modes, local-only), never wording.
- Docs ship in the same change as code: behaviour changes update `docs/STATUS.md` and `CHANGELOG.md`; wire changes update `docs/PROTOCOL.md` and bump `PROTOCOL` in `router/core/limits.mjs`; module or state changes update `docs/ARCHITECTURE.md`; non-obvious choices go in `docs/DECISIONS.md`.

## Setup

```bash
git clone https://github.com/elyrainference/elyra.git && cd elyra
npm ci
npm run chain:install      # hardhat, for the on-chain test and contract tests
npm test                   # all behaviour tests (about 15 s on an idle machine)
npm run chain:test         # contract tests
```

Run tests when the machine is not busy; booting nodes can take several seconds under load.

## Pull requests

1. Branch from `main`, keep the change focused, one concern per PR.
2. Add or update tests. A bug fix needs a regression test.
3. If you touch `contracts/`: `cd contracts && npm run build` and commit the regenerated `artifacts/` (CI fails on drift).
4. Never commit `.elyra*/`, `.env*`, wallet or identity files. CI scans for tracked key files, but check yourself.
5. Describe what you verified and what you could not.

## Website and docs

`site/` is a saved landing mirror: edit copy in place, never regenerate. Docs are Markdown in `docs/`; the Cloudflare Pages build (`tools/pages/`) renders them, see [`docs/DEPLOY-CLOUDFLARE.md`](docs/DEPLOY-CLOUDFLARE.md).

## Conduct

Be direct and kind; critique code, not people. Harassment is not tolerated; maintainers may remove comments and block accounts.

## Licensing

By contributing you agree your work is released under the [MIT License](LICENSE).

## Name

"Elyra" is also the name of an unrelated open-source JupyterLab project. A trademark and domain check is an open item before a public launch (see `docs/STATUS.md`, Naming).
