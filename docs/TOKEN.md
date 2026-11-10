# $ELYRA token

`$ELYRA` is Elyra's token on **Robinhood Chain** (mainnet, chain id 4663).

| | |
|---|---|
| Contract | [`0x42cc3f36bb20481378bc0d84ebdfd4fe8f17fbf5`](https://robinhoodchain.blockscout.com/token/0x42cc3f36bb20481378bc0d84ebdfd4fe8f17fbf5) |
| Name | Elyra Inference |
| Symbol | ELYRA |
| Decimals | 18 |
| Total supply | 1,000,000,000 |

The name, symbol, decimals and supply above were read directly from the contract. Holders, transfers and market data are on the [block explorer](https://robinhoodchain.blockscout.com/token/0x42cc3f36bb20481378bc0d84ebdfd4fe8f17fbf5); this repository does not repeat numbers it cannot read from a node.

## What it does not do

- **It is not required to use Elyra.** Requests are paid in **USDG** through `ElyraEscrow`. A buyer or a seller never needs `$ELYRA`.
- **Staking, rewards and free requests for stake are not live.** The app marks those pages "Not live yet".
- The token contract is **separate from the escrow and registry contracts** and is not part of the settlement path.

## What the contract does (checked 2026-11-10)

Read from the deployed bytecode and from view calls on Robinhood Chain. This is a bytecode and call inspection, **not a source-code audit**.

- **Plain ERC-20 with burn.** It exposes `transfer`, `approve`, `transferFrom`, `allowance`, `balanceOf`, `burn` and `burnFrom`, and uses the OpenZeppelin v5 error set.
- **No owner and no admin functions.** There is no `owner()`, no `mint`, no pause, no blacklist and no fee or tax function. The 1,000,000,000 supply is fixed.
- **Not upgradeable.** The EIP-1967 implementation slot is empty.
- **Launched through a launchpad factory.** The token exposes `launchFactory()`, `curve()`, `deployer()`, `description()`, `socials()` and `logo()`. Metadata points at `@Elyrainference` and `elyrainference.com`.
- **Transfers are not globally locked.** A simulated transfer from the bonding-curve contract succeeds. A simulated transfer from an account with no balance reverts with the standard insufficient-balance error.

What this does not tell you: how the launchpad's bonding curve and factory behave (they are separate contracts, owned by the launchpad operator), how the supply is distributed, or whether a custom transfer hook exists that does not show up as a function. Read the verified source on the explorer if it is published.

## Verify before you trust

- Check the address against this file, the [website](https://elyrainference.com) and the [X account](https://x.com/Elyrainference). If they differ, do not interact.
- Read the contract on the explorer. This project has not published an audit of the token contract, and the escrow contracts are unaudited.
- Elyra is an early beta. Nothing here is financial advice.
