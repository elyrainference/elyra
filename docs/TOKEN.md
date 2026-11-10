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

## Verify before you trust

- Check the address against this file, the [website](https://elyrainference.com) and the [X account](https://x.com/Elyrainference). If they differ, do not interact.
- Read the contract on the explorer. This project has not published an audit of the token contract, and the escrow contracts are unaudited.
- Elyra is an early beta. Nothing here is financial advice.
