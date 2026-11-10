// Reown is opt-in. Public config contains connection facts only, never node-wallet balances, keys or provider credentials.
import { NETWORKS } from "../chain.mjs";
import { reownProjectId } from "./api-chain.mjs";

export function publicWalletConfig(state, env) {
  const projectId = reownProjectId(env);
  if (!projectId) return null;
  const n = NETWORKS[state.chain?.network] ?? NETWORKS["robinhood-testnet"];
  return { projectId, chainId: n.chainId, name: n.name, rpcUrl: n.rpcUrl, explorer: n.explorer, real: !!n.real, iconUrl: "/try/mark.svg" };
}

// Exact SDK service origins, not arbitrary remote script or RPC access. Social/email features are disabled in the bundle.
const CONNECT = [
  "https://api.web3modal.org", "https://api.web3modal.com",
  "https://pulse.walletconnect.org", "https://pulse.walletconnect.com",
  "https://rpc.walletconnect.org", "https://rpc.walletconnect.com",
  "https://relay.walletconnect.org", "https://relay.walletconnect.com",
  "wss://relay.walletconnect.org", "wss://relay.walletconnect.com",
  "https://verify.walletconnect.org", "https://verify.walletconnect.com",
  "https://cca-lite.coinbase.com", "wss://www.walletlink.org",
];

export function publicWalletPolicy(base, wallet, rpc = "") {
  if (!wallet) return rpc ? base.replace("connect-src 'self'", `connect-src 'self' ${rpc}`) : base;
  return base
    .replace("connect-src 'self'", `connect-src 'self' ${CONNECT.join(" ")}${rpc ? " " + rpc : ""}`)
    .replace("img-src 'self' data:", "img-src 'self' data: blob: https://api.web3modal.org https://api.web3modal.com")
    // AppKit's Lit components inject styles; scripts remain same-origin and no eval is allowed.
    .replace("style-src 'self'", "style-src 'self' 'unsafe-inline'")
    + "; frame-src https://verify.walletconnect.org https://verify.walletconnect.com";
}
