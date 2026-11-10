# Third-party material and what the MIT license covers

The MIT license in `LICENSE` covers the code and documents **written for Elyra**: `router/`, `panel/` (except `panel/vendor/`), `contracts/`, `deploy/`, `tools/` (except bundled dependencies), `docs/`.

It does **not** grant rights to third-party material that is stored in this repository. Those rights stay with their owners:

| Path | What it is | Status |
|---|---|---|
| `panel/vendor/wallet.js` | Bundle of `@reown/appkit` and `ethers`, built by `tools/wallet/build.mjs` | Each package keeps its own license; see the sources in `tools/wallet/package.json` |
| `panel/assets/logos/` | Vendor logos (Lobe Icons static SVGs) | Trademarks of their owners, shown only to identify a model's vendor |

`site/` holds only a minimal Elyra-written landing placeholder served by the router. No third-party theme, fonts or 3D models are shipped.
