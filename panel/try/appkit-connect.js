// The wallet picker belongs to Reown AppKit. Elyra keeps sign-in and transaction confirmation separate.
import { state } from "./lib.js";

let kit = null, loading = null;
let onChange = () => {};
let wasConnected = false;

async function load() {
  if (kit) return kit;
  if (loading) return loading;
  loading = (async () => {
    const cfg = state.info?.walletConnect ?? (await fetch("/pub/info", { cache: "no-store" }).then((r) => {
      if (!r.ok) throw new Error("Wallet connection is temporarily unavailable. Try again.");
      return r.json();
    })).walletConnect;
    if (!cfg?.projectId) throw new Error("Wallet connection is not configured on this node. The operator must set ELYRA_REOWN_PROJECT_ID and allow this domain in Reown. No wallet request was sent.");
    const mod = await import("/try/appkit.js");
    kit = mod.init(cfg);
    const sync = ({ address, connected }) => {
      const provider = kit.provider();
      if (connected && address && provider) {
        wasConnected = true;
        onChange({ address, provider });
      } else if (wasConnected) { wasConnected = false; onChange(null); }
    };
    kit.onAccount(sync);
    kit.onProvider(() => sync({ address: kit.address(), connected: !!kit.address() }));
    sync({ address: kit.address(), connected: !!kit.address() });
    new MutationObserver(() => kit.setTheme(document.documentElement.dataset.theme)).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return kit;
  })();
  try { return await loading; } finally { loading = null; }
}

export function onConnection(fn) { onChange = fn; }
export async function openWalletPicker() { return (await load()).open(); }
export async function disconnectWallet() { if (kit) await kit.disconnect(); }
