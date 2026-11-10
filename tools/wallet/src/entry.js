// Browser entry: Reown AppKit (wallet picker, WalletConnect/QR, injected wallets) + ethers. Bundled once into panel/vendor/wallet.js.
// Loaded on demand by the panel, only when the node has ELYRA_REOWN_PROJECT_ID set. Nothing here runs on the node.
import { createAppKit } from "@reown/appkit";
import { defineChain } from "@reown/appkit/networks";
import { EthersAdapter } from "@reown/appkit-adapter-ethers";
import { BrowserProvider } from "ethers";
import { balances, deposit, mintTest } from "./fund.mjs";

let kit = null, chain = null;

/** cfg: { projectId, chainId, name, rpcUrl, explorer } from the node (/api/chain). Idempotent. */
export function init(cfg) {
  if (kit) return api;
  chain = defineChain({
    id: Number(cfg.chainId), caipNetworkId: `eip155:${cfg.chainId}`, chainNamespace: "eip155", name: cfg.name || `Chain ${cfg.chainId}`,
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [cfg.rpcUrl] } },
    blockExplorers: cfg.explorer ? { default: { name: "Explorer", url: cfg.explorer } } : undefined,
    testnet: !cfg.real,
  });
  kit = createAppKit({
    projectId: cfg.projectId,
    adapters: [new EthersAdapter()],
    networks: [chain], defaultNetwork: chain,
    metadata: { name: "Elyra", description: "Connect to Elyra", url: location.origin, icons: [location.origin + (cfg.iconUrl || "/app/assets/elyra-mark.svg")] },
    // wallet picker only: no email/social logins, analytics, swaps or on-ramps (those call extra Reown services)
    features: { analytics: false, email: false, socials: false, swaps: false, onramp: false, send: false, receive: false, history: false, legalCheckbox: false },
    allWallets: "SHOW", themeMode: document.documentElement.dataset.theme === "light" ? "light" : "dark",
    themeVariables: { "--w3m-accent": "#6d6bff", "--w3m-border-radius-master": "3px", "--w3m-font-family": "ui-sans-serif, system-ui, sans-serif", "--w3m-z-index": 10000 },
  });
  return api;
}

const signer = async () => {
  const p = kit.getWalletProvider();
  if (!p) throw new Error("Wallet is not connected");
  if (Number(kit.getChainId()) !== chain.id) await kit.switchNetwork(chain);
  return new BrowserProvider(p, chain.id).getSigner();
};

const api = {
  open: () => kit.open({ view: "Connect" }),
  disconnect: () => kit.disconnect(),
  address: () => kit.getAddress(),
  provider: () => kit.getWalletProvider(),
  setTheme: (mode) => kit.setThemeMode(mode === "light" ? "light" : "dark"),
  onProvider: (cb) => kit.subscribeProviders(() => cb()),
  chainId: () => Number(kit.getChainId()),
  /** cb({ address, connected }) on every account change; returns unsubscribe */
  onAccount: (cb) => kit.subscribeAccount((a) => cb({ address: a.address ?? null, connected: !!a.isConnected })),
  balances: async (cfg) => balances(await signer(), cfg),
  deposit: async (cfg, usd, onStep) => deposit(await signer(), cfg, usd, onStep),
  mintTest: async (cfg, usd) => mintTest(await signer(), cfg, usd),
};
export default api;
