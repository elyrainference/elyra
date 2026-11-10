# Mainnet (Robinhood Chain, chain 4663): capped beta runbook

Status 2026-11-07: **escrow and registry are deployed on mainnet** (addresses in `docs/STATUS.md`; steps 1, 3, 4 and 5 below are done, step 6 smoke test done 2026-11-07 (details in STATUS; withdraw of the rest pending its 1-day delay); Blockscout source verification must be done by hand because the explorer API is behind a Cloudflare challenge). The founder chose to skip a longer testnet phase. This document is the safest way to do that, and it keeps the unaudited-contract risk explicit.

## Read this first: what you are risking
- `ElyraEscrow` is **not audited by a third party**. It has an internal security review (9 findings fixed) and a mainnet-fork rehearsal, nothing more. A bug can lose every USDG in it.
- Real USDG has a **supply controller that can burn tokens from any address, including the escrow** (found in `contracts/rehearsal-mainnet-fork.md`, step F). Depositors cannot protect against that.
- A consumer can self-redeem through a second address (limitation F3); sellers bound their risk with `creditUsd` and auto-redeem.
- Therefore the node enforces **one deposit cap** (default $20 per wallet, `maxDepositUsd`; on real networks the stricter of it and `ELYRA_MAINNET_DEPOSIT_CAP_USD`, default 20, so raising it needs both; `router/chain.mjs`). Treat the first weeks as a beta with money you can lose. Do not market it as safe for savings.

## The mainnet node (already created)
- Data dir `.elyra-main` (git-ignored), identity + wallet **encrypted at rest**.
- Wallet address: `0x1BBb3A552b8E1331A1e13FFdd0d400A665737f49` (public; safe to share).
- Keep the passphrase outside the repo. **Move it into a password manager and back up `.elyra-main`**: without both, the wallet is gone. Never paste either into a chat.
- Do not reuse the testnet wallets (`.elyra`, `.elyra-b`): their keys are not encrypted.

## Steps (you do 1-2, the agent does 3-6)
1. **Put a small amount of ETH on Robinhood Chain mainnet in that address** (a few dollars covers deployment and many redeems; gas is cents). Use the official bridge/on-ramp documented by Robinhood Chain; I did not verify a bridge route.
2. **Put USDG** in the same address only when you want to be a buyer (start with <= $10). Real USDG: `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168` (from the official docs, checked 2026-11-04).
3. Deploy the escrow (PowerShell/bash, passphrase from the file):
   ```
   ELYRA_PASSPHRASE=… RPC_URL=https://rpc.mainnet.chain.robinhood.com node contracts/deploy.mjs --token 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168 --node-wallet .elyra-main --i-know-this-is-mainnet
   ```
   Verify on Blockscout (`node contracts/verify.mjs --contract ElyraEscrow --address … --constructor-args … --network robinhood-mainnet`).
4. Registry (optional, bond 0 for the beta; spam is possible without a bond, see `docs/REGISTRY.md`): same command with `--registry`.
5. Start the node: `ELYRA_PASSPHRASE=… node router/server.mjs --port 8547 --data .elyra-main --name elyra-main --no-demo --allow-mainnet`, then in the panel (Payments) or via `PUT /api/chain` set network `robinhood-mainnet`, the escrow address, and the registry address and start block.
6. Smoke test with **$1**: deposit, one paid request to a live seller, seller redeems, withdraw the rest (`requestWithdraw`, 1 day, `withdraw`). Record every tx hash in `docs/STATUS.md`. Only then raise the cap.

## Before real users
- Independent audit of escrow + registry (budget decision).
- A decision on the USDG burn exposure (pro-rata handling or an explicit user-facing disclosure).
- Legal review of `site/legal/*` and the "unaudited beta" wording on the landing and in the panel.
- Seller-side `creditUsd` stays small; keep auto-redeem on.
