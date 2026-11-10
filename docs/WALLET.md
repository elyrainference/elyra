# Wallet and USDG

How money works in Elyra today, what you can do from the panel, and what is not built yet.

> **Status:** settlement is real on **Robinhood Chain testnet** with a worthless test token, and on **mainnet** (chain 4663) `ElyraEscrow` with real USDG is deployed and a first $1 trade is recorded in [STATUS](STATUS.md). Mainnet is **disabled by default** (`--allow-mainnet`), capped (see Per-wallet deposit cap below) and the escrow contract has had no independent audit, so keep only money you can lose. Both browser wallet funding (`depositFor(nodeAddress)`) and non-custodial browser session-key pay-per-use (`ELYRA_PUBLIC_PAY=1`) have been exercised end-to-end on a local test chain with a simulated wallet, not yet with a real MetaMask/Rabby browser extension on testnet.

## The model

Elyra supports two ways to pay peer sellers in **USDG** through `ElyraEscrow`:

1. **Through your own local node (`localhost:8545`):** every node generates **its own wallet** on first start and stores it in the data directory (`.elyra/`, or `/var/lib/elyra` for the service). That key signs receipts and cumulative payment vouchers automatically as your tools call `/v1/chat/completions`, without popping up a browser wallet on every prompt (which is why a browser wallet cannot sign per-request payments for you). You can fund that node wallet's escrow balance directly from your personal browser wallet (`depositFor(nodeAddress)`).
2. **Pay-per-use in the browser (`ELYRA_PUBLIC_PAY=1`):** on a public node that enables browser session pay, a visitor who has not installed a node can pay peer sellers per token directly from the browser. The page creates a local **session key** in your browser, you fund that session address from your personal wallet (`depositFor(sessionAddress)`), and your browser verifies each receipt before signing the voucher.

In both modes:
- Prices are dollars per million tokens and **USDG** is a dollar stablecoin with 6 decimals, so there is no exchange rate or oracle.
- **ETH** is used only for gas (depositing, redeeming vouchers, or withdrawing).
- Money sits in the **escrow** contract. A buyer deposits; for each verified answer the buyer's signing key signs a higher cumulative EIP-712 voucher; the seller redeems the latest one on-chain.

## See your wallet

Open **Payments** in the panel. It shows the network and chain id, the node wallet address (with an explorer link), the escrow contract and whether it is verified on Blockscout, ETH for gas, the token balance and your escrow deposit.

Payments opens with **Fund this node**: three steps derived from live state (gas from a faucet, test USDG, deposit into the escrow), each marked done or next, collapsing to one line when complete. Alerts at the top of Home and Payments say when the escrow holds less than $1, the wallet has no ETH for gas, or you used 80% of your [daily spend cap](CONFIGURATION.md).
## Set up on testnet

1. Fund the node wallet with testnet ETH from a faucet (links are listed in the Payments view).
2. Deploy the escrow and a mock token, once:

```bash
npm run chain:install
npm run chain:build
npm run chain:deploy:testnet
```

3. In Payments, **Network settings**, paste the escrow address and save. The status changes from *Settlement is simulated* to *On-chain settlement is live*.
4. Press **Mint 100 test USDG** (testnet only: the mock token has an open mint), then **Deposit** an amount. The panel approves and deposits in two transactions.

## Fund from your own wallet

Instead of moving tokens to the node wallet by hand, connect a wallet and deposit straight from it.

1. Turn it on once, with a free project id from [dashboard.reown.com](https://dashboard.reown.com): set `ELYRA_REOWN_PROJECT_ID` on the node ([Configuration](/docs/configuration/)). In the Reown dashboard add the address you open the panel on (for example `app.example.com`) under the project's allowed domains.
2. Open **Payments**. In **Fund from your wallet** press **Connect wallet** and pick MetaMask, Rainbow, Coinbase Wallet or any WalletConnect wallet (scan the QR with your phone).
3. Enter an amount and press **Deposit from my wallet**. Your wallet asks you to approve the token once, then to confirm the deposit.
4. On testnet, **Get 100 test USDG in my wallet** mints test tokens to you first.

What happens: your wallet pays and the escrow credits **this node's address**, because the node's own key signs the payments. So the deposit funds the requests this node makes. Only the node's key can withdraw it (see below). Your wallet never signs requests and never sees prompts.

The wallet component is large (about 1.3 MB compressed), so it loads only when you press Connect. It talks to Reown's WalletConnect services (relay, wallet list, verification) and, depending on the wallet you pick, to that wallet's own service. Without a project id none of this is loaded.

### Public app connection

The public **Connect wallet** button now opens the same genuine Reown AppKit picker, not an Elyra-built list of injected wallets. It supports installed wallets and the WalletConnect QR option, follows the app theme and loads only on click. The same `ELYRA_REOWN_PROJECT_ID` and domain allowlist are required even when no escrow is configured: wallet identity is separate from funding. A missing project ID shows a configuration error; it does not simulate a connected account. The SDK may ask to switch networks, but SIWE sign-in and any token approval/deposit require separate confirmation. Public CSP permits exact Reown service origins and SDK-injected styles only when configured; remote scripts and eval remain blocked. See [Reown's CSP guidance](https://docs.reown.com/advanced/security/content-security-policy).


## Your first paid request

You need three things on the test network: gas (ETH), test USDG, and a deposit in the escrow that names the seller. Your **own browser wallet** does the funding; the node wallet only signs payment vouchers.

1. **Join and match settlement** as in [Quickstart](QUICKSTART.md#buy-from-the-live-network-testnet).
2. **Test ETH for gas.** Use a faucet from the list in Payments (Alchemy, QuickNode, Chainstack). They ask for a small balance and some history on **Ethereum mainnet** at the address that claims, so claim with your everyday wallet, not with a brand-new address. Add the Robinhood testnet (chain id 46630) to the wallet if it is not there.
3. In Payments choose **Connect wallet**, approve the network switch, then **Get 100 test USDG in my wallet** (the test token has a public mint).
4. Enter an amount and **Deposit to this node**. The panel approves once, then calls `depositFor`, which credits the node's escrow balance. A cent is enough: a million tokens costs the seller's price, so a short chat costs a fraction of that.
5. Send a request that names the seller's model. It is answered, the cost is deducted from the escrow, and the seller redeems your signed voucher on-chain when it chooses to.

If a request is refused with **Not enough funds**, the deposit has not arrived or is smaller than the worst-case cost of that request; the message shows your balance.

## Withdraw

Withdrawal is deliberately slow so a consumer cannot spend a deposit and pull it out before the provider redeems.

1. **Request withdraw** starts a one-day timer (`WITHDRAW_DELAY`).
2. After it unlocks, enter an amount and withdraw. **CANCEL** aborts.

`withdraw` pays the address that deposited, which is the node wallet. To move funds to a personal wallet, send them from the node wallet afterwards.

## Get paid

Providers redeem vouchers from the escrow and pay the gas. Set a payout address with `ELYRA_PAYOUT=0x...` so earnings land in a wallet you control rather than the node key ([Configuration](/docs/configuration/)). See [Sell capacity](/docs/provider/) for credit limits and redemption.

## Pay-per-use on the public page (browser session key)

When a public node enables `ELYRA_PUBLIC_PAY=1` (alongside `ELYRA_PUBLIC_TRY=1` and an on-chain escrow), visitors can pay peer sellers per token from the public app without running their own node:

1. **Connect a browser wallet:** in the **Wallet** / **Pay-per-use session** section of the public page, connect MetaMask, Rabby, or Coinbase Wallet. For paying, your wallet is used only to read balances, switch network, and confirm deposit transactions. (Signing in to the node, a separate one-signature step, is not needed to pay; see [Sign-in](AUTH.md).)
2. **Browser session key:** your browser generates a local session key (`0x...`) in `localStorage`. The public node never sees the private key.
3. **Fund the session key:** on testnet, click **Mint 100 test USDG** if needed, enter an amount within the per-wallet deposit cap (default **$20 USDG**), and confirm `approve` + `depositFor(sessionAddress)` in your wallet.
4. **Chat with a paid peer seller:** open the Playground for a peer model and send a message:
   - The public node acts as a non-custodial gateway: it binds its node id to your session address, forwards the sealed request to the seller, verifies the seller's signed receipt, and streams back an `event: pay` SSE frame with the verified cost (`/pub/paid-chat`).
   - Your browser checks that the cost does not exceed the price ceiling you accepted (`price * 1.05 * max_tokens`) and signs the next monotonic cumulative EIP-712 voucher (`POST /pub/voucher`), which the public node forwards sealed to the seller.
5. **Withdraw unused session funds:** only the browser session key can call `requestWithdraw` and (after the 1-day `WITHDRAW_DELAY`, checked against the chain's latest block timestamp) `withdraw`. To protect sellers who have not yet redeemed their latest voucher on-chain, the browser calculates `owed = sum(max(signedCumulative, onChainClaimed) - onChainClaimed)` across every seller you used and withdraws at most `deposit - owed`. Because the session address submits the withdrawal transaction on-chain, it needs a tiny amount of ETH for gas.

> **Status:** verified end-to-end (including withdrawal safety against unredeemed seller vouchers) on a local Hardhat chain; currently off on `app.elyrainference.com` while there is 1 live seller, and not yet tested with a real MetaMask/Rabby browser extension.

## Hosted sources vs. peer-to-peer payments

USDG escrow deposits and EIP-712 vouchers apply **only to peer-to-peer sellers (`LIVE`)**.

- If you attach a **hosted API source** (`OpenRouter`, `OpenAI`, `Groq`, `Together`, labelled `HOSTED · CLEAR`) to your own local router, requests routed there are billed outside the chain by that company through your API key.
- Hosted models are ranked by their published per-model prices (averaged input and output per million tokens) so `auto:cheapest` compares them fairly and never treats a paid hosted model as free.
- Hosted sources are never re-shared with peers, never shown on the public market page, and cannot use TEE privacy.

## Per-wallet deposit cap

While `ElyraEscrow.sol` has not had an independent audit, the node enforces **one** per-wallet deposit cap (default **$20 USDG**, set via `maxDepositUsd` in **Provide**, `PUT /api/provide`, `PUT /api/chain`, or `ELYRA_MAX_DEPOSIT_USD` at first boot; contract unchanged). It applies everywhere a deposit can happen and is cumulative with what the escrow already holds (`currentDeposit + amount <= cap`):

- **Seller credit gate and hello:** before creating any state or calling a model on `/p2p/infer`, the seller reads the buyer wallet's on-chain escrow balance (`escrow.deposits(wallet)`) and refuses (`402 deposit_cap_exceeded`) any wallet holding more than the cap; the cap is also advertised in the node's hello.
- **Node deposit, wallet fund & browser session pay:** `POST /api/chain/deposit`, the panel's **Deposit** and **Fund from your wallet**, `/pub/chain` and the public page's **Pay-per-use session** all check the cap before sending `approve` or `depositFor`, and surface it in the UI.
- **Real networks:** on mainnet the stricter of the cap above and `ELYRA_MAINNET_DEPOSIT_CAP_USD` (default $20; an invalid value never disables it, `0` blocks deposits) wins, so raising the limit on mainnet needs both.

## Mainnet

Disabled by default: starting a node with `--allow-mainnet` unlocks Robinhood Chain mainnet (chain id 4663) and **real funds**. The escrow and registry are deployed there (addresses and the first trade in [STATUS](STATUS.md), runbook in [MAINNET](MAINNET.md)), but the contracts are unaudited, so the deposit cap above is the only guard-rail: use it as a capped beta. One specific risk: the USDG issuer can burn balances from any address, including the escrow, so a deposit is not protected by the contract alone. The fork rehearsal and findings are in `contracts/rehearsal-mainnet-fork.md`.

## Not built yet

- **Withdrawing a node deposit straight to your personal wallet in one step:** `withdraw` pays the address that owns the escrow position (for a node deposit, the node wallet; for a browser session deposit, the browser session address).
- **HTTP 402 (`x402`) pay-per-request without an escrow deposit:** not started. A bytecode check on Robinhood Chain mainnet (chain 4663) showed that the USDG token implementation has neither EIP-3009 `transferWithAuthorization` nor `permit`, so the `exact` scheme cannot use USDG and `upto` would require a custom Permit2 proxy contract.
- **An independent audit** of the escrow contract.
