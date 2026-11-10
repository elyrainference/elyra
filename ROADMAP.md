# Roadmap

Order is priority. Move items to `CHANGELOG.md` when shipped and reflect it in `docs/STATUS.md`.

## Next (makes the claims true)
1. ~~Prove Robinhood Chain testnet settlement~~ **done 2026-11-04**; internet path via a Cloudflare tunnel **done 2026-11-05** (same machine). Remaining: two machines on separate networks, a real LLM behind the provider, a professional contract audit, a USDG controller-burn mitigation decision (pro-rata haircut or accept), then: fund the node wallet with testnet ETH (gas), `npm run chain:deploy:testnet`, `npm run chain:verify`, run a two-node trade, record tx hashes in `docs/STATUS.md`. Then: contract audit, real-USDG transfer restrictions (policy reverts, controller burn), mainnet dry run, batch redeem.
2. **TEE attestation** (verifier + kit built 2026-11-05, see `docs/TEE.md`; remaining: first real token M1, cosign/env checks, KMS-persisted identity, second platform, GPU).
   (old text:): provider publishes an attestation quote in hello; consumer verifies against a vendor root before marking `verified`; encrypt the prompt to an enclave-bound key. Until then labels stay `CLAIMED`.
3. ~~Peer transport security~~ done as sealed envelopes (0.2.0). Still open: response integrity beyond receipts, forward secrecy for long sessions.
4. **Bootstrap + discovery**: no public seed nodes exist yet; signed seed list, optional DHT; NAT traversal / relay for home providers (meanwhile: tailscale/cloudflared + `--public-url`).

## Then
- (done 0.2.0) CI workflow, protocol versioning, observability basics. Still open: alerting rules, dashboards, tracing, tests under load.

5. Reputation that resists gaming (paid-history weighting, probe requests with known answers, token-count audit).
6. Better token audit (real tokenizers, probe requests with known answers); dispute path.
7. Provider controls: per-consumer budgets, signed allow lists. (Rate limit, deny list, SSRF guard shipped in 0.2.0.)
8. More endpoints: embeddings, images, tool-call aware billing, per-direction pricing.
9. Packaging: signed binary/installer, auto-update, system tray; Docker image for providers.
10. Panel: per-model price history, spend caps and alerts, export CSV, dark mode.


## Wallet connect

1. Built (2026-11-06): connect a wallet with Reown AppKit (MetaMask, WalletConnect/QR, Coinbase and others) and fund the escrow with `depositFor(nodeAddress, amount)`. Enabled only when `ELYRA_REOWN_PROJECT_ID` is set. Tested on a local chain with a simulated wallet; not yet with a real wallet app or on Robinhood testnet from a browser.
2. Next: try it with real wallets on Robinhood testnet and record the results in `docs/STATUS.md`.
3. Mainnet USDG, only after an independent escrow audit and a deposit cap. A wallet cannot sign per-request vouchers (the node key does), so it funds and receives, nothing more.
4. Sign-in with Ethereum for remote admin instead of a shared token.
5. Withdraw to the funding wallet (needs a contract change, so only with the audit).
