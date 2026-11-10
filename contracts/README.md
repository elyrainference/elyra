# Elyra escrow contract

`contracts/ElyraEscrow.sol` — unidirectional payment-channel escrow settled in **USDG** (an ERC-20 stablecoin, 6 decimals) on Robinhood Chain (EVM). Gas stays ETH. **Unaudited. Do not put real value in it.**

## Token model
- The escrow is constructed with one immutable `token` address and treats it as a plain ERC-20, nothing more.
- **Voucher units = token base units.** With USDG (6 decimals) `cumulative = USD × 1e6`; no price oracle is needed because Elyra amounts are already in dollars. The contract never reads `decimals()`.
- `deposit(amount)` / `depositFor(consumer, amount)` pull tokens with `transferFrom` (needs prior `approve`). The escrow's balance before/after must differ by exactly `amount`, else `TransferMismatch` (rejects fee-on-transfer and rebasing tokens). Zero amount reverts. Plain ETH is refused (no `receive`).
- `redeem` / `withdraw` pay with `token.transfer` through an inline safe-transfer helper: tokens returning `bool` or nothing work; `false`, a revert, or a non-contract token reverts with `TokenTransferFailed`. State is updated before the external call and everything is atomic.

### USDG facts and risks
- Mainnet USDG (Paxos Global Dollar): `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168` on Robinhood Chain (4663). No known testnet deployment: on testnet we deploy `MockUSDG`.
- Real USDG is an upgradeable, Paxos-controlled, faceted-proxy token. Transfers can revert for policy reasons (freeze/sanctions/pause), and the supply controller can burn from any address, including the escrow.
- Consequences: if the token blocks a transfer, `redeem`/`withdraw` revert and funds stay recoverable once the token allows it. If tokens are burned out of the escrow it can become insolvent (late redeemers/withdrawers revert); there is no on-chain remedy and no admin key. Token upgrades could change behaviour under the escrow.
- `MockUSDG.mint` is open to everyone (testnet faucet). **Never use it on a real network**; `deploy.mjs` refuses `--mock-token` on chain 4663.

## Commands
```
npm install
npm run build   # solc-js 0.8.26 -> artifacts/ElyraEscrow.json, MockUSDG.json ({abi, bytecode, compiler}) + standard-input.json (both sources; committed)
npm test        # hardhat in-process network, ethers v6
```

## Deploy (`deploy.mjs`)
```
RPC_URL=… PRIVATE_KEY=0x… node deploy.mjs --token 0x…      # escrow for an existing token
RPC_URL=… PRIVATE_KEY=0x… node deploy.mjs --mock-token     # MockUSDG, then escrow for it (testnet/local only)
node deploy.mjs --local --mock-token                       # local node, hardhat dev key #0
```
| Flag | Meaning |
|---|---|
| `--token 0x…` | existing ERC-20 (exactly one of `--token` / `--mock-token` is required) |
| `--mock-token` | deploy `MockUSDG` first; refused on chain 4663 |
| `--node-wallet <dataDir>` | key from `<dataDir>/wallet.json` via `../router/vault.mjs` (`ELYRA_PASSPHRASE`) instead of `PRIVATE_KEY` |
| `--local` | `RPC_URL` defaults to `http://127.0.0.1:8555` (8545 is the VPR port); default key = public hardhat dev #0, only on a loopback RPC; starts nothing itself |
| `--i-know-this-is-mainnet` | required on chain 4663 (real funds) |

Output: one JSON line `{chainId, token, escrow, tokenTx, escrowTx, mock}` on stdout; chain, gas used and explorer URLs (known chains) on stderr. Non-loopback RPCs are reached through the DoH resolver in `../router/net.mjs` (ISP DNS hijack workaround).

Local dry run: `node node_modules/hardhat/internal/cli/cli.js node --port 8556`, then `RPC_URL=http://127.0.0.1:8556 node deploy.mjs --local --mock-token`.

## Verify (Blockscout, also via DoH)
```
node verify.mjs --contract MockUSDG --address 0x…
node verify.mjs --contract ElyraEscrow --address 0x… --constructor-args 0x<32-byte token address, left-padded>
```
Without `--constructor-args` the explorer autodetects them. `--network robinhood-testnet|robinhood-mainnet` or `--explorer URL` pick the explorer.

## Mainnet-fork rehearsal (real USDG, no real funds)
```
npm run rehearse:mainnet   # ~2 min; writes rehearsal-mainnet-fork.md
```
`scripts/fork-rehearsal.mjs` starts `scripts/fork-proxy.mjs` (local JSON-RPC proxy on 127.0.0.1:8599 → `rpc.mainnet.chain.robinhood.com` through `../router/net.mjs`, because hardhat's own fork client cannot resolve the ISP-hijacked DNS; write RPCs are refused) and `hardhat node --fork` (config `hardhat.fork.config.cjs`, chain id 4663, port 8557, pinned to latest-5), then runs the committed `artifacts/ElyraEscrow.json` against the **real USDG** state: deposit / voucher redeem / double redeem / withdraw with throwaway wallets and an impersonated holder, token probes (fee-on-transfer, rebasing), and a supply-controller burn simulation. All writes are local to the fork; both processes are stopped at the end. Re-run it after any contract change.

## Flow
- Consumer: `approve(escrow, amount)` then `deposit(amount)`; a funder can credit someone else with `depositFor(consumer, amount)`.
- Consumer signs cumulative vouchers off-chain; provider calls `redeem(consumer, cumulative, sig)` with the latest one.
- Exit: `requestWithdraw()` sets `withdrawAt = now + WITHDRAW_DELAY` (1 day) and `withdrawExpires = withdrawAt + WITHDRAW_WINDOW` (7 days). `withdraw(amount)` works only inside that window and is single use (clears both fields); after expiry it reverts `WithdrawExpired` and a new request is needed. `cancelWithdraw()` clears the request. The consumer's own `deposit`/`depositFor(self)` also clears it; a third-party `depositFor` does not. Redeems keep working during the delay and after expiry.

## Voucher format (EIP-712)
Domain `{ name: "ElyraEscrow", version: "1", chainId, verifyingContract }`, type
`Voucher(address consumer, address provider, uint256 cumulative)`; `cumulative` is the total token base units (USDG: USD × 1e6) owed to that provider since the channel began (not a delta). Signature is 65 bytes `r||s||v` (v = 27/28, low-s). `voucherDigest(consumer, provider, cumulative)` returns the digest.

## Trust model
The withdraw delay only stops a consumer from *withdrawing* directly. It does **not** protect providers from a dishonest consumer: a consumer can always drain its deposit by signing a voucher to a second address it controls and redeeming it from there (the deposit is shared, first redeemer wins; the earlier provider's voucher then reverts `NothingToPay`). This is a deliberate design limitation (finding F3, covered by a test named "documented limitation: …"). A provider must never be exposed (served but unredeemed) beyond what it can afford to lose, and should redeem frequently.

## Security notes
- Signers are EOAs only (`ecrecover`); no ERC-1271 / contract wallets as consumers.
- Partial pay: if `deposits[consumer] < cumulative - claimed`, the provider receives what is available and `claimed` advances only by that amount; the remainder stays claimable after a top-up with the same voucher. Zero payout reverts.
- A consumer can withdraw after the delay, so providers must redeem promptly (and before the delay elapses) — vouchers are not collateralised beyond the current deposit.
- Deposits are shared across all providers for a consumer; first redeemer wins.
- No admin keys, no upgrade path, no pause. Deposit/redeem/withdraw are reentrancy-guarded and update state before the token transfer.
- `Deposited(consumer, funder, amount)` now carries the funder as well (event signature changed from the ETH version).
