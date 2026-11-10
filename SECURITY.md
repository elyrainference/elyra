# Security policy

Elyra moves money (testnet today) and handles prompts. Please report problems privately.

## Reporting

Use GitHub **Security Advisories** on this repository ("Report a vulnerability"). Do not open a public issue for something exploitable. Include: affected file or endpoint, impact, steps to reproduce against a **local** node (never against someone else's), and a suggested fix if you have one. Expect a first reply within 7 days; this is a small project, not a company with an SLA.

## Scope

In scope: the router (`router/`), peer protocol and sealed transport, receipts and vouchers, the control panel and the loopback guard, `contracts/ElyraEscrow.sol`, the TEE verifier, the deploy kits.

Out of scope: simulated catalog data, the third-party WordPress-derived landing assets, denial of service against nodes you do not own, social engineering.

## Known limitations (documented, not secrets)

- **Unaudited.** The escrow had one AI-assisted manual review, not a professional audit. Do not put real funds behind it.
- **Self-redeem (F3):** a consumer can drain its own deposit through a second address, so provider safety is off-chain (credit limit + auto-redeem), not on-chain.
- **USDG controller risk:** the real USDG token's supply controller can burn from any address, including the escrow; the token is owner-upgradeable (`contracts/rehearsal-mainnet-fork.md`).
- **Sealed transport hides prompts from the network, not from the provider operator.** Only a Google-signed Confidential Space attestation that passes the buyer's pinned trust list is `VERIFIED`, and it has not run against real Google yet.
- Reputation is local and sybil-able; there is no registry yet.

Details and finding history: [`docs/STATUS.md`](docs/STATUS.md).

## Hard rules for contributors

1. `/api/*`, `/v1/*`, `/metrics` stay loopback-only. Never proxy them. The one exception is opt-in remote admin ([docs/REMOTE-ADMIN.md](docs/REMOTE-ADMIN.md)): a single named host behind a login, never `/metrics`.
2. Never log prompts, completions, API keys or private keys.
3. Never write key material with plain `writeFileSync`; use `router/vault.mjs`.
4. Never serve dot-directories.
5. Receipts record usage, vouchers move money; every peer-supplied field is type-checked and amounts are derived locally.

## If you operate a node

Run it as an unprivileged user, keep ports 8545 and 11434 on loopback (if you enable remote admin, the tunnel is the only way in and the token is full control of the node), set `ELYRA_PASSPHRASE`, back up the data dir, and treat the wallet as a hot wallet holding only what you can lose.
