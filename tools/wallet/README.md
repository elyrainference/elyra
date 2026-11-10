# Wallet bundle (dev tool)

Builds `panel/vendor/wallet.js`: Reown AppKit + ethers, bundled with esbuild into one ES module loaded only on **Connect wallet**. The owner panel uses `/app/vendor/wallet.js`; the public app uses `/try/appkit.js`, an alias to the same file. Both need a configured `ELYRA_REOWN_PROJECT_ID`.
The node itself does not depend on any of this (its only runtime dependency is still `ethers`). This folder exists so the checked-in bundle can be rebuilt and audited.

```bash
cd tools/wallet
npm install --ignore-scripts      # exact versions are pinned in package.json
node build.mjs                    # writes panel/vendor/wallet.js and wallet.js.sha256
```

- `src/session.js` + `build-session.mjs`: the small ethers-only module behind pay-per-use sessions on the public page (`panel/try/session.js`, with a `.sha256`). `node build-session.mjs` rebuilds it.
- `src/fund.mjs`: the on-chain part (approve, `depositFor`, test mint). Pure ethers, covered by `router/test/fund.test.mjs` on a local chain.
- `src/entry.js`: AppKit setup. Wallet picker only: email, social login, analytics, swaps, on-ramp and history are switched off.
- The entry also exposes the EIP-1193 provider and account/provider subscriptions for public SIWE, plus a theme setter. Neither connecting nor signing in calls the funding helpers; only explicit deposit/mint actions do. AppKit itself may request a network switch while connecting.
- Built from `@reown/appkit` and `@reown/appkit-adapter-ethers` 1.8.24, `ethers` 6.13.5, `esbuild` 0.28.2. Both Reown packages are published by `reown-npm-org`.
- `--ignore-scripts` is deliberate. The only install scripts are esbuild's binary check and AppKit's version-consistency check; neither is needed.
- The bundle contains no `eval` and no `new Function`. Check that `panel/vendor/wallet.js.sha256` matches after a rebuild; a different hash with the same lockfile means something changed.
- Hosts it can contact at runtime: Reown/WalletConnect (`relay.walletconnect.org`, `rpc.walletconnect.org`, `api.web3modal.org`, `pulse.walletconnect.org`, `verify.walletconnect.org`, `secure.walletconnect.org`, `echo.walletconnect.com`), and the selected wallet's own endpoints (for example Coinbase). The chain RPC is the node's own.
