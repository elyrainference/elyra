# Design: on-chain registry and what "as good as Morpheus, then better" really takes

Status: **implemented and deployed** on Robinhood testnet (`0xD15DE4C6269728E91b8841410a0C72057F915fFF`) and mainnet (`0x6B573D1D07465De29de3Ad47B44CE8787a4dFABc`, bond 0), both 2026-11-07; a discovery proof run on testnet is recorded in `docs/STATUS.md`. Contract, node client, tests and deploy script also pass on a local EVM. Sections 1 and 3 are the original 2026-11-06 analysis; section 2 describes what was built. DECIDE items left for the founder: bond size on mainnet (suggest $5; testnet 0) and the chain.

## 1. Where Elyra stands against Morpheus (from its public docs, see `docs/LANDSCAPE.md`)

| Capability | Morpheus | Elyra today | Gap |
|---|---|---|---|
| Local router + provider node, OpenAI-compatible | yes (`proxy-router`, Electron UI, CLI) | yes (VPR, panel) | no installer/desktop app |
| On-chain settlement | session stake in MOR, claim on close | per-token vouchers in USDG via escrow (unaudited) | audit |
| **On-chain registry of providers/models/bids** | yes (Diamond contract on Base) | **no**: peers found by seed URL + gossip | **main architectural gap** |
| Reputation | per-provider uptime/TTFT/throughput/success, shared marketplace data | local to each node | no shared signal |
| Liveness view of the whole network | active.mor.org | none | no network-wide health |
| TEE | `tee` tag + SecretVM attestation endpoint | buyer-pinned digest verification, VERIFIED/CLAIMED labels (simulated tokens only) | M1 proof |
| Token role in payments | MOR (stake, rewards) | none: payments are USDG; `$ELYRA` exists but is not in the settlement path ([TOKEN](TOKEN.md)) | by design |
| Hosted gateway for non-technical users | yes | no | optional later |

**Honest answer to "can it be better?":** on architecture, yes in three specific ways, none proven in production yet:
1. **Pay per token in a stablecoin.** The buyer risks at most the voucher balance, not a time-based stake, and never needs to hold a volatile token to buy or sell.
2. **Prompts sealed end-to-end to the seller's key** (X25519 + AES-GCM), independent of TEE; relays and the network never see plaintext.
3. **Client-side attestation policy.** The buyer pins image digests and the node itself verifies the token; nobody asks the buyer to trust a platform badge. Competitors' TEE claims are all "unverified" on the public tracker (deai.org, 2026-11-02).

"Better" overall is not decided by code: Morpheus has live supply, a token, and years of operation. Elyra wins only if it gets real sellers and its TEE verification is proven (M1). Until then the correct claim is "same architecture, simpler economics, stronger verification design".

## 2. Registry design (closes the discovery gap)

Goal: any node can find real sellers without a trusted seed, and spam is expensive. Keep trust **off the registry**: the chain only says "this wallet announced this URL"; every claim is re-verified by talking to the node.

### Contract `ElyraRegistry` (`contracts/contracts/ElyraRegistry.sol`, separate from the escrow so the escrow stays small and audited on its own)
- `announce(bytes32 nodeId, bytes32 boxKey, string url, bytes32 metaHash, uint64 ttl)` called by the seller wallet (the wallet is always `msg.sender`); emits `Announced(address indexed wallet, bytes32 nodeId, bytes32 boxKey, string url, bytes32 metaHash, uint64 expiresAt)`. **Design change from the first draft:** the event also carries `boxKey` (the draft listed it only as an argument, so a buyer reading logs could not have checked it). State per wallet: the expiry of its latest announcement only; the content lives in the event log (cheap gas), the newest event per wallet wins.
- Caps: `ttl` 1 hour to 30 days (0 = default 7 days), `url` 1 to 256 bytes, `nodeId` non-zero.
- `revoke()` unlists now (`Revoked(wallet)`); entries also expire at `expiresAt`. Sellers re-announce on boot (if less than half the TTL is left) and before expiry. `isListed(wallet)` is a convenience view.
- Optional bond, fixed at deploy (`bondAmount`, 0 = off; suggest $5 on mainnet, 0 on testnet), paid in an ERC-20 on the first announce (balance delta checked, fee-on-transfer tokens rejected) and kept while the wallet is listed. Exit mirrors the escrow: `requestWithdraw()` (unlists immediately) → 1 day → `withdraw()` inside a 7-day window, single use; announcing again cancels a pending exit. **No slashing**: slashing needs an objective fault proof, which the design does not yet have (see §3). The bond only prices Sybil spam. No admin keys, no upgradeability, nothing anybody else can use to delist a wallet or touch its bond.
- No on-chain model list or price (changes too often, costs gas). The announcement commits to the node's signed identity through `metaHash` (exact definition in [PROTOCOL.md](PROTOCOL.md#registry-announcement-commitments)); models and prices are read from the hello after the node is contacted.

### Node side (`router/core/registry.mjs`)
- **Seller (opt-in, costs gas):** when `registryAnnounce` is on, providing is enabled, chain mode is configured (escrow + registry), an explicit public URL (`--public-url` or relay) exists and is not a local address, the node announces about 2 s after boot and re-announces when less than half of the 7-day TTL is left or when URL/wallet/keys changed. A missing public URL, no gas, or an RPC error is logged once as a warning and shown in `GET /api/registry` (`announceError`); it never blocks boot. A TEE node's wallet changes on every boot, so its old entry just expires.
- **Buyer (on by default once a registry address is set; `registryDiscover: false` or `ELYRA_REGISTRY_DISCOVER=0` turns it off):** every 30 s (5 s while catching up) reads `Announced`/`Revoked` logs with `eth_getLogs` from a persisted block cursor (`state.registry.cursor`), at most 2000 blocks per call and 10 calls per pass, re-reading 12 blocks behind the cursor for reorgs (applying an event twice is a no-op). The first read starts at `registryBlock` (the deploy block, printed by `deploy.mjs --registry`); a different registry or network restarts the cursor. Keeps the newest entry per wallet (block, log index); expired and revoked entries are ignored; "now" for expiry is the later of the local clock and the newest block time. At most 2000 entries are kept and 5 hellos verified per pass, with exponential retry (2 min up to 6 h, give up after 8 failures until the wallet re-announces).
- Each live entry goes through the **same `addPeer` path as a gossip-learned peer**: `assertPublicUrl` (private/LAN URLs refused unless `--allow-private-peers`), the signed `/p2p/hello` verification, plus: `nodeId` = sha-256 of the hello's node key, `boxKey` = sha-256 of the hello's box key, the hello's signed wallet = the announcing wallet, and the recomputed `metaHash` = the announced one. Any mismatch rejects the entry before a peer is stored.
- **Fail closed:** any RPC/log error aborts the pass, leaves the cursor where it was, and creates no peer. Chain data is untrusted input (shape-checked, URL length-capped) exactly like gossip.
- Seeds and gossip stay; the registry is additive. Peers it finds are tagged `viaRegistry` (panel badge "from registry", only a statement about how they were found).
- **Not solved:** with no bond, anyone can spam entries; the cap, per-pass verification limit and backoff bound the cost to a buyer, but a flood of 2000+ live wallets can crowd out honest ones (a bond on mainnet is the answer). Starting the first read from block 0 on a long-lived chain is slow; always set `registryBlock`.

### Operate
Deploy: `node contracts/deploy.mjs --registry --testnet --node-wallet <dataDir>` (add `--bond <usd> --token 0x…` for a bond; `--local` for a dev chain). The JSON line includes `registry` and `registryBlock`. Nodes: set `ELYRA_REGISTRY`, `ELYRA_REGISTRY_BLOCK` (and `ELYRA_REGISTRY_ANNOUNCE=1` on sellers); see [CONFIGURATION](CONFIGURATION.md). Inspect: `GET /api/registry`. Unlist: `POST /api/registry/revoke`.

### Tests
`contracts/test/ElyraRegistry.test.cjs` (52 contract tests with the escrow's, including fee-on-transfer, no-return, blocking and re-entering tokens). `router/test/registry.test.mjs` on a hardhat node: a buyer with no seed finds an auto-announcing seller; mismatching metaHash/nodeId/boxKey/wallet rejected; private URLs refused; expired and revoked entries ignored; cursor persists across a restart; discovery off; unreachable chain fails closed. Still to do: fork rehearsal like the escrow's, testnet deploy, two-machine test.

## 3. Reputation and abuse (phase 2, needs design review)
- Local signals today: success rate, TTFT, tokens/s, uptime as seen by this node. Keep them.
- Shared signal candidates: buyers publish **signed, aggregate** observations (not prompts) that others may weigh by their own trust. Sybil-resistance is unsolved here; do not ship a global score that looks authoritative.
- Disputes: receipts are signed by the provider and bound to the voucher, so a buyer can prove what it was charged; "bad answer" is subjective and not on-chain. State this plainly in the docs.

## 4. Work breakdown
1. ~~Contract + tests~~ done 2026-11-07.
2. ~~`core/registry.mjs` + panel Network badge "from registry"~~ done 2026-11-07.
3. Testnet deploy (`contracts/verify.mjs --contract ElyraRegistry` supported), verify on Blockscout, add address to `docs/STATUS.md`.
4. Two-machine test with discovery through the registry only.
5. Audit scope: escrow + registry together.
