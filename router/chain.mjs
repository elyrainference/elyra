// On-chain settlement adapter for Robinhood Chain (Arbitrum Orbit L2). Gas is ETH; money is USDG (ERC-20, 6 decimals).
// Model: consumers deposit USDG into ElyraEscrow and sign cumulative EIP-712 vouchers per provider; providers redeem
// the highest voucher. Receipts (ed25519) stay the usage record; vouchers are the money. Amounts are dollars → no oracle.
// Everything degrades to "not configured" when ethers, the artifact or an escrow address is missing.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { dohFetch, ethersGetUrl } from "./net.mjs";
import { readSecretJson, writeSecretJson } from "./vault.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const ARTIFACT = join(here, "..", "contracts", "artifacts", "ElyraEscrow.json");
const REGISTRY_ARTIFACT = join(here, "..", "contracts", "artifacts", "ElyraRegistry.json");

// Verified 2026-11-04 by calling eth_chainId through DoH-resolved addresses: testnet 0xb626 = 46630, mainnet 0x1237 = 4663.
export const NETWORKS = {
  "robinhood-testnet": { name: "Robinhood Chain Testnet", chainId: 46630, rpcUrl: "https://rpc.testnet.chain.robinhood.com", explorer: "https://explorer.testnet.chain.robinhood.com", real: false },
  "robinhood-mainnet": { name: "Robinhood Chain", chainId: 4663, rpcUrl: "https://rpc.mainnet.chain.robinhood.com", explorer: "https://robinhoodchain.blockscout.com", real: true, usdg: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168" },
  local: { name: "Local dev chain", chainId: 31337, rpcUrl: "http://127.0.0.1:8555", explorer: "", real: false },
};
export const FAUCETS = ["https://faucet.quicknode.com/robinhood/testnet", "https://faucets.chain.link/robinhood-testnet", "https://www.alchemy.com/faucets/robinhood-testnet"];

// registry = ElyraRegistry address (provider discovery, optional); registryBlock = block it was deployed at (where discovery starts reading logs)
export const DEFAULT_CHAIN = { network: "robinhood-testnet", rpcUrl: "", chainId: 0, escrow: "", registry: "", registryBlock: 0 };

/** Deposit cap in USD for a REAL network (ELYRA_MAINNET_DEPOSIT_CAP_USD), the hard ceiling of the one cap concept (default 20 = DEFAULT_MAX_DEPOSIT_USD in core/limits.mjs).
 *  A missing, invalid or negative setting falls back to the default; it never means "no cap" (0 blocks deposits). */
export function depositCapUsd(envValue) {
  const v = envValue === undefined || envValue === "" ? NaN : Number(envValue);
  return Number.isFinite(v) && v >= 0 ? v : 20;
}

const VOUCHER_TYPES = { Voucher: [{ name: "consumer", type: "address" }, { name: "provider", type: "address" }, { name: "cumulative", type: "uint256" }] };
const ERC20 = [
  "function balanceOf(address) view returns (uint256)", "function allowance(address,address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)", "function transfer(address,uint256) returns (bool)", "function decimals() view returns (uint8)",
  "function symbol() view returns (string)", "function name() view returns (string)", "function mint(address,uint256)",
];

export async function createChain({ dataDir, getConfig, allowMainnet = false, passphrase = "", getDepositCapUsd = null }) {
  let E = null, artifact = null, regArtifact = null, loadError = "";
  try { E = await import("ethers"); } catch { loadError = "ethers not installed (run npm install)"; }
  try { regArtifact = JSON.parse(readFileSync(REGISTRY_ARTIFACT, "utf8")); } catch { /* registry is optional */ }
  try { artifact = JSON.parse(readFileSync(ARTIFACT, "utf8")); } catch { loadError ||= "contract artifact missing (contracts/artifacts/ElyraEscrow.json)"; }

  // ---- wallet (separate secp256k1 key; never leaves wallet.json) ----
  let wallet = null;
  const walletFile = join(dataDir, "wallet.json");
  if (E) {
    if (existsSync(walletFile)) { const w = readSecretJson(walletFile, passphrase); wallet = new E.Wallet(w.privateKey); if (passphrase) writeSecretJson(walletFile, w, passphrase); }
    else {
      wallet = E.Wallet.createRandom();
      writeSecretJson(walletFile, { privateKey: wallet.privateKey }, passphrase);
    }
  }
  const address = wallet?.address ?? null;

  const net = () => {
    const c = getConfig();
    const preset = NETWORKS[c.network] ?? NETWORKS["robinhood-testnet"];
    if (preset.real && !allowMainnet) throw new Error("mainnet is disabled: start the node with --allow-mainnet (real funds!)");
    return { ...preset, rpcUrl: c.rpcUrl || preset.rpcUrl, chainId: c.chainId || preset.chainId, escrow: c.escrow, registry: c.registry ?? "" };
  };
  let providerCache = null, providerKey = "";
  const rpc = () => {
    const n = net();
    const key = n.rpcUrl + n.chainId;
    if (providerKey !== key) {
      const req = new E.FetchRequest(n.rpcUrl);
      req.getUrlFunc = ethersGetUrl; // resolves via DoH so ISP DNS hijacks of *.robinhood.com don't break us
      providerCache = new E.JsonRpcProvider(req, n.chainId, { staticNetwork: true, batchMaxCount: 1, cacheTimeout: -1 });
      providerKey = key;
    }
    return providerCache;
  };
  const signer = () => wallet.connect(rpc());
  const escrowRO = () => new E.Contract(net().escrow, artifact.abi, rpc());
  const escrowRW = () => new E.Contract(net().escrow, artifact.abi, signer());

  const registryRO = () => new E.Contract(net().registry, regArtifact.abi, rpc());
  const registryRW = () => new E.Contract(net().registry, regArtifact.abi, signer());

  const ready = () => !!(E && artifact && address);
  const configured = () => { try { return ready() && E.isAddress(net().escrow); } catch { return false; } };

  // ---- units: ledger is USD, chain is token units (default 6 decimals, refreshed from the token) ----
  let decimals = 6;
  const usdToUnits = (usd) => BigInt(Math.round(usd * 10 ** decimals));
  const unitsToUsd = (units) => Number(BigInt(units)) / 10 ** decimals;

  const domain = () => ({ name: "ElyraEscrow", version: "1", chainId: net().chainId, verifyingContract: net().escrow });

  async function signVoucher(providerAddress, cumulativeUnits) {
    if (!configured()) throw new Error("escrow not configured");
    return wallet.signTypedData(domain(), VOUCHER_TYPES, { consumer: address, provider: providerAddress, cumulative: BigInt(cumulativeUnits) });
  }
  /** True if `sig` is a voucher the CONTRACT will accept: canonical 65-byte r‖s‖v with v ∈ {27,28} (ethers alone also accepts v=0/1 and 64-byte EIP-2098 forms the contract rejects). */
  function verifyVoucher(consumerAddress, providerAddress, cumulativeUnits, sig) {
    try {
      if (typeof sig !== "string" || !/^0x[0-9a-fA-F]{130}$/.test(sig)) return false;
      const v = parseInt(sig.slice(130, 132), 16);
      if (v !== 27 && v !== 28) return false;
      const rec = E.verifyTypedData(domain(), VOUCHER_TYPES, { consumer: consumerAddress, provider: providerAddress, cumulative: BigInt(cumulativeUnits) }, sig);
      return rec.toLowerCase() === consumerAddress.toLowerCase();
    } catch { return false; }
  }

  /** Proof that this node controls its wallet: EIP-191 signature over (consumer node id, wallet). Stops anyone from claiming a funded wallet they do not hold. */
  const bindingText = (id, w) => `elyra-wallet-binding:${id}:${String(w).toLowerCase()}`;
  let bindingCache = null;
  const signBinding = async (id) => (bindingCache?.id === id ? bindingCache.sig : ((bindingCache = { id, sig: await wallet.signMessage(bindingText(id, address)) }).sig));
  const verifyBinding = (id, w, proof) => {
    try { return typeof proof === "string" && E.isAddress(w) && E.verifyMessage(bindingText(id, w), proof).toLowerCase() === String(w).toLowerCase(); } catch { return false; }
  };

  // ---- reads (cached; RPC may be slow or down) ----
  const cache = new Map();
  let failUntil = 0, failMsg = ""; // negative cache: an unreachable RPC is not retried for 15 s
  async function cached(key, ttl, fn) {
    const hit = cache.get(key);
    if (hit && Date.now() - hit.t < ttl) return hit.v;
    const v = await fn();
    cache.set(key, { v, t: Date.now() });
    return v;
  }
  const bust = () => { cache.clear(); failUntil = 0; };
  const timed = (p, ms = 5000) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`request timeout (${ms / 1000}s)`)), ms))]);

  const tokenAddress = () => cached(`token:${net().escrow}`, 3600_000, () => timed(escrowRO().token()));
  const tokenRO = async () => new E.Contract(await tokenAddress(), ERC20, rpc());
  const tokenRW = async () => new E.Contract(await tokenAddress(), ERC20, signer());

  /** `fresh` bypasses the cache and is time-boxed: providers must decide on current data and fail closed if the chain cannot answer. */
  async function consumerPosition(consumerAddress, providerAddress, { fresh = false } = {}) {
    if (fresh) {
      const c = escrowRO();
      const [dep, claimed] = await timed(Promise.all([c.deposits(consumerAddress), c.claimed(consumerAddress, providerAddress)]));
      return { deposit: dep, claimed };
    }
    return cached(`pos:${consumerAddress}:${providerAddress}`, 15000, async () => {
      const c = escrowRO();
      const [dep, claimed] = await Promise.all([c.deposits(consumerAddress), c.claimed(consumerAddress, providerAddress)]);
      return { deposit: dep, claimed };
    });
  }

  /** Blockscout API v2: is the escrow's source verified? null = explorer unreachable/unknown. Cached 5 min. */
  async function blockscoutVerified(explorer, escrow) {
    try {
      return await cached(`bs:${explorer}:${escrow}`, 300000, async () => {
        const r = await dohFetch(`${explorer}/api/v2/smart-contracts/${escrow}`, { timeout: 4000 });
        if (r.status === 404) return false;
        if (!r.ok) return null;
        const j = await r.json();
        return !!(j.is_verified || j.is_fully_verified);
      });
    } catch { return null; }
  }

  async function info() {
    const base = { available: !!E && !!artifact, error: loadError, address, configured: configured(), faucets: FAUCETS, networks: Object.fromEntries(Object.entries(NETWORKS).map(([k, v]) => [k, { name: v.name, chainId: v.chainId, real: v.real, usdg: v.usdg ?? null }])) };
    if (!E || !artifact) return base;
    let n;
    try { n = net(); } catch (e) { return { ...base, error: e.message }; }
    const out = { ...base, registry: n.registry || null, network: getConfig().network, networkName: n.name, chainId: n.chainId, rpcUrl: n.rpcUrl, explorer: n.explorer, escrow: n.escrow || null, real: n.real, connected: false };
    if (Date.now() < failUntil) return { ...out, error: failMsg };
    try {
      const wei = await cached("bal", 8000, () => timed(rpc().getBalance(address)));
      out.connected = true;
      out.walletWei = wei.toString(); // ETH, for gas
      out.walletEth = E.formatEther(wei);
      if (configured()) {
        const tk = await tokenRO();
        const [tokenAddr, sym, nm, dec, bal, dep, wAt] = await Promise.all([
          tokenAddress(), cached("sym", 3600_000, () => timed(tk.symbol())), cached("nm", 3600_000, () => timed(tk.name())), cached("dec", 3600_000, () => timed(tk.decimals())),
          cached("tbal", 8000, () => timed(tk.balanceOf(address))), cached("dep", 8000, () => timed(escrowRO().deposits(address))), timed(escrowRO().withdrawAt(address)),
        ]);
        decimals = Number(dec);
        Object.assign(out, {
          token: tokenAddr, tokenSymbol: sym, tokenName: nm, tokenDecimals: decimals, isMock: /mock/i.test(nm),
          tokenUnits: bal.toString(), tokenUsd: unitsToUsd(bal), depositUnits: dep.toString(), depositUsd: unitsToUsd(dep), withdrawAt: Number(wAt) * 1000 || null,
        });
      }
    } catch (e) { out.error = "RPC unreachable: " + (e.shortMessage ?? e.message).slice(0, 160); failUntil = Date.now() + 15000; failMsg = out.error; }
    out.walletUrl = out.explorer ? `${out.explorer}/address/${address}` : null;
    if (out.escrow && out.explorer) {
      out.escrowUrl = `${out.explorer}/address/${out.escrow}`;
      out.escrowVerified = await blockscoutVerified(out.explorer, out.escrow);
    }
    return out;
  }

  // ---- writes ----
  async function tx(fn, label) {
    try {
      const t = await fn();
      const rc = await t.wait();
      bust();
      return { hash: t.hash, block: rc.blockNumber, label, gasUsed: rc.gasUsed.toString() };
    } catch (e) { throw new Error(`${label} failed: ${(e.shortMessage ?? e.message).slice(0, 200)}`); }
  }
  /** approve (only if needed) then deposit. Returns both txs. */
  async function deposit(usd) {
    const units = usdToUnits(usd);
    if (units <= 0n) throw new Error("amount too small");
    // One deposit-cap concept (default $20): the owner's per-wallet cap (state.provide.maxDepositUsd, via getDepositCapUsd) applies on every network; on a REAL network the
    // ceiling ELYRA_MAINNET_DEPOSIT_CAP_USD (default 20, fail-safe parsing) applies too and the stricter of the two wins. Not a contract rule, a node-side safety.
    const owner = Number(getDepositCapUsd?.());
    const capUsd = Math.min(Number.isFinite(owner) && owner >= 0 ? owner : Infinity, net().real ? depositCapUsd(process.env.ELYRA_MAINNET_DEPOSIT_CAP_USD) : Infinity);
    if (Number.isFinite(capUsd)) {
      const cap = usdToUnits(capUsd);
      const cur = await escrowRO().deposits(address);
      if (cur + units > cap) throw new Error(`deposit cap: the escrow would hold $${unitsToUsd(cur + units)} but the cap is $${unitsToUsd(cap)}.${net().real ? " The mainnet contract is not audited: raise the cap (provide.maxDepositUsd) and ELYRA_MAINNET_DEPOSIT_CAP_USD only if you accept that risk." : ""}`);
    }
    const tk = await tokenRW(), esc = net().escrow;
    const out = [];
    if ((await tk.allowance(address, esc)) < units) out.push(await tx(() => tk.approve(esc, units), "approve"));
    out.push(await tx(() => escrowRW().deposit(units), "deposit"));
    return { hash: out.at(-1).hash, txs: out, gasUsed: String(out.reduce((a, t) => a + BigInt(t.gasUsed), 0n)) };
  }
  /** testnet only: mock token has an open mint */
  async function mint(usd) { const tk = await tokenRW(); return tx(() => tk.mint(address, usdToUnits(usd)), "mint"); }
  /** move USDG out of the node wallet (used to sweep earnings to a payout address the seller controls) */
  async function sendToken(to, units) { const tk = await tokenRW(); return tx(() => tk.transfer(to, BigInt(units)), "payout"); }
  const requestWithdraw = () => tx(() => escrowRW().requestWithdraw(), "requestWithdraw");
  const cancelWithdraw = () => tx(() => escrowRW().cancelWithdraw(), "cancelWithdraw");
  const withdraw = (usd) => tx(() => escrowRW().withdraw(usdToUnits(usd)), "withdraw");
  const redeem = (consumerAddress, cumulativeUnits, sig) => tx(() => escrowRW().redeem(consumerAddress, BigInt(cumulativeUnits), sig), "redeem");

  // ---- registry (discovery): read the Announced/Revoked logs, announce this node. Reads fail closed: any error throws, nothing is guessed ----
  const registryConfigured = () => { try { return !!(E && regArtifact && E.isAddress(net().registry)); } catch { return false; } };
  const registryAddress = () => (registryConfigured() ? net().registry : null);
  const registryIface = () => new E.Interface(regArtifact.abi);
  /** Where this registry's log cursor is valid: a different network/registry must restart from its deploy block. */
  const registryKey = () => { const n = net(); return `${n.chainId}:${String(n.registry).toLowerCase()}`; };
  /** latest block number and its timestamp (chain clock, seconds) */
  const registryHead = async () => { const b = await timed(rpc().getBlock("latest"), 8000); if (!b) throw new Error("no latest block"); return { number: Number(b.number), time: Number(b.timestamp) }; };
  /** Decoded Announced/Revoked logs in [from, to] (inclusive), in chain order. Malformed logs are dropped, never partially trusted. */
  async function registryLogs(from, to) {
    const iface = registryIface();
    const topics = [[iface.getEvent("Announced").topicHash, iface.getEvent("Revoked").topicHash]];
    const logs = await timed(rpc().getLogs({ address: net().registry, fromBlock: from, toBlock: to, topics }), 15000);
    const out = [];
    for (const l of logs) {
      let ev; try { ev = iface.parseLog(l); } catch { continue; }
      if (!ev) continue;
      const base = { wallet: ev.args.wallet.toLowerCase(), block: Number(l.blockNumber), logIndex: Number(l.index) };
      if (ev.name === "Revoked") out.push({ ...base, type: "revoked" });
      else out.push({ ...base, type: "announced", nodeId: ev.args.nodeId, boxKey: ev.args.boxKey, url: ev.args.url, metaHash: ev.args.metaHash, expiresAt: Number(ev.args.expiresAt) });
    }
    return out;
  }
  /** Seller side. Needs gas; if the contract demands a bond, tops up the token allowance first. Returns the announce tx. */
  async function registryAnnounce({ nodeId, boxKey, url, metaHash, ttl }) {
    if (!registryConfigured() || !ready()) throw new Error("registry not configured");
    const reg = registryRW();
    const out = [];
    const bond = await timed(reg.bondAmount());
    if (bond > 0n) {
      const have = await timed(reg.bonded(address));
      if (have < bond) {
        const tk = new E.Contract(await timed(reg.token()), ERC20, signer()), need = bond - have;
        if ((await tk.allowance(address, net().registry)) < need) out.push(await tx(() => tk.approve(net().registry, need), "approve bond"));
      }
    }
    out.push(await tx(() => reg.announce(nodeId, boxKey, url, metaHash, BigInt(ttl)), "registry announce"));
    return out.at(-1);
  }
  const registryRevoke = () => tx(() => registryRW().revoke(), "registry revoke");
  /** gas available? (a zero-balance wallet cannot announce; checked before trying so the node logs one clear line) */
  const hasGas = async () => (await timed(rpc().getBalance(address))) > 0n;

  return {
    registryConfigured, registryAddress, registryKey, registryHead, registryLogs, registryAnnounce, registryRevoke, hasGas,
    address, ready, configured, info, signBinding, verifyBinding, usdToUnits, unitsToUsd, signVoucher, verifyVoucher, consumerPosition, deposit, mint, sendToken, requestWithdraw, cancelWithdraw, withdraw, redeem, bust,
    explorerTx: (h) => { try { const e = net().explorer; return e ? `${e}/tx/${h}` : null; } catch { return null; } },
    explorerAddr: (a) => { try { const e = net().explorer; return e ? `${e}/address/${a}` : null; } catch { return null; } },
    isAddress: (a) => !!E && E.isAddress(a),
  };
}
