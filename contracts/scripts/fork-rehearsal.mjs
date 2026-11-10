#!/usr/bin/env node
// Mainnet dry run: ElyraEscrow against the REAL USDG bytecode/state on a local fork of Robinhood Chain mainnet.
// No real funds, no real keys: mainnet is only read (through the DoH proxy); every write happens on the local
// hardhat fork node. Starts the proxy (in-process) and `hardhat node --fork` (child process), runs the scenario,
// prints a report and writes contracts/rehearsal-mainnet-fork.md, then stops both by PID.
//   npm run rehearse:mainnet            (env: ELYRA_FORK_BLOCK=<n> to pin a block instead of latest-5)
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { startProxy } from "./fork-proxy.mjs";
import { dohFetch } from "../../router/net.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");
const { ethers } = createRequire(path.join(root, "package.json"))("ethers");

const UPSTREAM = "https://rpc.mainnet.chain.robinhood.com";
const EXPLORER = "https://robinhoodchain.blockscout.com";
const USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";
const MAINNET_ID = 4663n;
const PROXY_PORT = 8599, NODE_PORT = 8557;
const NODE_URL = `http://127.0.0.1:${NODE_PORT}`;
const EIP1967_IMPL = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const EIP1967_ADMIN = "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103";
const TRANSFER_TOPIC = ethers.id("Transfer(address,address,uint256)");
const U = (n) => ethers.parseUnits(String(n), 6);
const fmt = (n) => ethers.formatUnits(n, 6);
const ETH1 = "0x" + (10n ** 18n).toString(16);

const TOKEN_ABI = [
  "function symbol() view returns (string)", "function name() view returns (string)", "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint256)", "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
  "function transfer(address,uint256) returns (bool)", "function approve(address,uint256) returns (bool)",
  "function transferFrom(address,address,uint256) returns (bool)",
  "function owner() view returns (address)", "function paused() view returns (bool)", "function supplyControl() view returns (address)",
  "function decreaseSupplyFromAddress(uint256,address)",
  "error InsufficientFunds()", "error InsufficientAllowance()", "error ContractPaused()", "error ZeroAddress()", "error ZeroValue()",
  "error CannotBurnFromAddress(address,address)", "error RateLimitExceeded()", "error BalanceOverflow()",
];
const SC_ABI = [
  "function getAllSupplyControllerAddresses() view returns (address[])",
  "function canBurnFromAddress(address from,address controller) view returns (bool)", // arg order verified: the error names the 2nd arg when it lacks the role
  "function defaultAdmin() view returns (address)", "function owner() view returns (address)",
  "function updateAllowAnyMintAndBurnAddress(address,bool)",
  "error CannotBurnFromAddress(address,address)", "error RateLimitExceeded()", "error AccountMissingSupplyControllerRole(address)",
];
const EXTRA_ERRORS = new ethers.Interface(["error Panic(uint256)", "error Error(string)"]);

// ---------- report plumbing ----------
const steps = [];
const notes = [];
const note = (s) => { notes.push(s); console.error(`  note: ${s}`); };
const json = (v) => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x), 2);
class Abort extends Error {}
const ok = (c, m) => { if (!c) throw new Error("assertion failed: " + m); };
let aborted = false;

async function step(id, title, fn, { critical = false } = {}) {
  if (aborted) { steps.push({ id, title, status: "SKIP", observed: { reason: "earlier critical step failed" } }); return undefined; }
  const t0 = Date.now();
  try {
    const r = (await fn()) ?? {};
    const rec = { id, title, status: r.status ?? "PASS", gas: r.gas, observed: r.observed ?? {}, ms: Date.now() - t0 };
    steps.push(rec);
    console.error(`[${rec.status}] ${id} ${title}${rec.gas ? ` (gas ${rec.gas})` : ""}`);
    return r;
  } catch (e) {
    steps.push({ id, title, status: "FAIL", error: describeError(e), ms: Date.now() - t0 });
    console.error(`[FAIL] ${id} ${title}: ${e.message}`);
    if (critical || e instanceof Abort) aborted = true;
    return undefined;
  }
}

function describeError(e) {
  const out = { message: e.shortMessage ?? e.message };
  const data = e.data ?? e.info?.error?.data ?? e.error?.data;
  if (typeof data === "string" && data.startsWith("0x")) out.revertData = data;
  if (e.reason) out.reason = e.reason;
  return out;
}

// Decode raw revert data against the known error ABIs (token, supply control, escrow, Panic/Error).
let decoders = [];
function decodeRevert(data) {
  if (!data || data === "0x") return { raw: "0x", name: "(empty revert)" };
  for (const itf of decoders) {
    try { const p = itf.parseError(data); if (p) return { raw: data, name: p.name, args: p.args.map(String) }; } catch { /* next */ }
  }
  return { raw: data, name: `unknown selector ${data.slice(0, 10)}` };
}
const revertDataOf = (e) => { const d = e.data ?? e.info?.error?.data ?? e.error?.data; return typeof d === "string" ? d : undefined; };

// ---------- process management ----------
const started = []; // { name, pid }
let proxy = null, nodeProc = null;
const nodeLog = [];

function killTree(pid) {
  if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
  else { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } }
}
async function cleanup() {
  if (nodeProc?.pid) { killTree(nodeProc.pid); console.error(`stopped hardhat fork node (PID ${nodeProc.pid})`); }
  if (proxy) { await proxy.close(); console.error(`stopped fork proxy (in-process, PID ${process.pid}, port ${PROXY_PORT})`); }
}

async function waitRpc(url, ms) {
  const t0 = Date.now();
  let last;
  while (Date.now() - t0 < ms) {
    if (nodeProc && nodeProc.exitCode !== null) throw new Error(`hardhat node exited early (code ${nodeProc.exitCode}):\n${nodeLog.slice(-40).join("\n")}`);
    try {
      const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}', signal: AbortSignal.timeout(3000) });
      const j = await r.json();
      if (j.result) return j.result;
      last = JSON.stringify(j);
    } catch (e) { last = e.message; }
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error(`RPC ${url} not ready after ${ms}ms: ${last}\n${nodeLog.slice(-40).join("\n")}`);
}

// Direct read-only upstream call through the proxy (with 429 backoff) — used before the fork node is up and for log scans.
async function up(method, params = [], batch = null) {
  const body = batch ?? { jsonrpc: "2.0", id: 1, method, params };
  for (let a = 0; a < 8; a++) {
    const r = await fetch(`http://127.0.0.1:${PROXY_PORT}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const j = await r.json();
    const first = Array.isArray(j) ? j.find((x) => x.error) : j;
    if (first?.error?.code === 429 || first?.error?.message === "Too Many Requests") { await new Promise((r2) => setTimeout(r2, 500 * (a + 1))); continue; }
    if (batch) { if (!Array.isArray(j)) throw new Error(`batch: ${JSON.stringify(j.error ?? j)}`); return j; }
    if (j.error) throw new Error(`${method}: ${JSON.stringify(j.error)}`);
    return j.result;
  }
  throw new Error(`${method}: upstream rate-limited (429) after retries`);
}

// ---------- scenario ----------
const report = { chainId: null, forkBlock: null, token: USDG };
async function main() {
  // --- 0. infrastructure
  let pin;
  await step("0.1", "start read-only DoH proxy → mainnet RPC", async () => {
    proxy = await startProxy({ port: PROXY_PORT, upstream: UPSTREAM, log: (m) => console.error("proxy:", m) });
    started.push({ name: "fork-proxy (in-process)", pid: process.pid });
    const cid = BigInt(await up("eth_chainId"));
    const head = parseInt(await up("eth_blockNumber"), 16);
    ok(cid === MAINNET_ID, `upstream chain id ${cid} != 4663`);
    pin = process.env.ELYRA_FORK_BLOCK ? Number(process.env.ELYRA_FORK_BLOCK) : head - 5;
    report.forkBlock = pin;
    const blk = await up("eth_getBlockByNumber", ["0x" + pin.toString(16), false]);
    return { observed: { proxy: proxy.url, upstream: UPSTREAM, upstreamChainId: cid, latestBlock: head, pinnedBlock: pin, pinnedBlockTime: new Date(parseInt(blk.timestamp, 16) * 1000).toISOString() } };
  }, { critical: true });

  await step("0.2", "start `hardhat node --fork` on the proxy", async () => {
    const cli = path.join(root, "node_modules", "hardhat", "internal", "cli", "cli.js");
    nodeProc = spawn(process.execPath, [cli, "node", "--config", "hardhat.fork.config.cjs", "--hostname", "127.0.0.1", "--port", String(NODE_PORT)], {
      cwd: root, env: { ...process.env, ELYRA_FORK_URL: proxy.url, ELYRA_FORK_BLOCK: String(pin) }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
    });
    started.push({ name: "hardhat fork node", pid: nodeProc.pid });
    for (const s of [nodeProc.stdout, nodeProc.stderr]) s.on("data", (d) => { for (const l of String(d).split(/\r?\n/)) if (l.trim()) { nodeLog.push(l); if (nodeLog.length > 400) nodeLog.shift(); } });
    const cid = BigInt(await waitRpc(NODE_URL, 120000));
    ok(cid === MAINNET_ID, `fork chain id ${cid} != 4663`);
    // hardhat cannot execute at the fork block itself on an unknown chain (no hardfork history): mine one local block
    await fetch(NODE_URL, { method: "POST", headers: { "content-type": "application/json" }, body: '{"jsonrpc":"2.0","id":1,"method":"evm_mine","params":[]}' });
    report.chainId = cid;
    return { observed: { pid: nodeProc.pid, url: NODE_URL, forkChainId: cid } };
  }, { critical: true });

  const provider = new ethers.JsonRpcProvider(NODE_URL, undefined, { staticNetwork: ethers.Network.from(Number(MAINNET_ID)), batchMaxCount: 1, polling: true, cacheTimeout: -1 });
  provider.pollingInterval = 100;
  const send = (m, p = []) => provider.send(m, p);
  const mine = () => send("evm_mine");
  const token = new ethers.Contract(USDG, TOKEN_ABI, provider);
  const bal = (a) => token.balanceOf(typeof a === "string" ? a : a.target ?? a.address);
  const impersonate = async (addr) => {
    await send("hardhat_impersonateAccount", [addr]);
    await send("hardhat_setBalance", [addr, "0x" + (10n * 10n ** 18n).toString(16)]);
    return new ethers.JsonRpcSigner(provider, ethers.getAddress(addr)); // getSigner() refuses addresses missing from eth_accounts
  };

  // --- (a) real token facts
  let supplyControl = null;
  await step("A", "read real USDG facts on the fork", async () => {
    const [symbol, name, decimals, totalSupply, impl, admin, code] = await Promise.all([
      token.symbol(), token.name(), token.decimals(), token.totalSupply(),
      provider.getStorage(USDG, EIP1967_IMPL), provider.getStorage(USDG, EIP1967_ADMIN), provider.getCode(USDG),
    ]);
    const owner = await token.owner().catch((e) => `(call failed: ${e.shortMessage ?? e.message})`);
    const paused = await token.paused().catch((e) => `(call failed: ${e.shortMessage ?? e.message})`);
    supplyControl = await token.supplyControl().catch(() => null);
    const implAddr = ethers.getAddress("0x" + impl.slice(26));
    const implCode = await provider.getCode(implAddr);
    ok(Number(decimals) === 6, `decimals ${decimals} != 6`);
    ok(symbol === "USDG", `symbol ${symbol} != USDG`);
    const o = { symbol, name, decimals: Number(decimals), totalSupply: `${totalSupply} (${fmt(totalSupply)} USDG)`, eip1967Implementation: implAddr, eip1967Admin: admin === ethers.ZeroHash ? "0x0 (none)" : "0x" + admin.slice(26), proxyCodeBytes: (code.length - 2) / 2, implCodeBytes: (implCode.length - 2) / 2, implCodeHash: ethers.keccak256(implCode), owner, paused, supplyControl };
    return { observed: o };
  }, { critical: true });

  // --- (b) rich holder
  let holder, holderBal;
  await step("B", "find a rich USDG holder and impersonate it on the fork", async () => {
    const via = { blockscout: null, method: null };
    let cands = [];
    try {
      const r = await dohFetch(`${EXPLORER}/api/v2/tokens/${USDG}/holders`, { headers: { accept: "application/json" } });
      const t = await r.text();
      if (r.ok) {
        const j = JSON.parse(t);
        cands = (j.items ?? []).map((i) => ({ address: ethers.getAddress(i.address.hash), isContract: !!i.address.is_contract }));
        via.blockscout = `HTTP ${r.status}, ${cands.length} holders`;
        if (cands.length) via.method = "blockscout";
      } else via.blockscout = `HTTP ${r.status} (${/Just a moment/.test(t) ? "Cloudflare challenge" : t.slice(0, 80)})`;
    } catch (e) { via.blockscout = `error: ${e.message}`; }
    if (!cands.length) {
      // fallback: sample Transfer logs (1000-block windows spread over the last ~2M blocks) through the proxy
      via.method = "transfer-log scan via proxy";
      const seen = new Set();
      for (let k = 0; k < 10; k++) {
        const end = pin - k * 200000, start = end - 999;
        const logs = await up("eth_getLogs", [{ address: USDG, topics: [TRANSFER_TOPIC], fromBlock: "0x" + start.toString(16), toBlock: "0x" + end.toString(16) }]);
        for (const l of logs) for (const t of [l.topics[1], l.topics[2]]) if (t) seen.add(ethers.getAddress("0x" + t.slice(26)));
      }
      seen.delete(ethers.ZeroAddress); seen.delete(ethers.getAddress(USDG));
      cands = [...seen].map((address) => ({ address }));
      via.scannedAddresses = cands.length;
    }
    const itf = new ethers.Interface(TOKEN_ABI);
    const addrs = cands.map((c) => c.address);
    const withBal = [];
    for (let i = 0; i < addrs.length; i += 25) {
      const chunk = addrs.slice(i, i + 25);
      const batch = chunk.map((a, j) => ({ jsonrpc: "2.0", id: j, method: "eth_call", params: [{ to: USDG, data: itf.encodeFunctionData("balanceOf", [a]) }, "0x" + pin.toString(16)] }));
      const res = await up(null, null, batch);
      for (const r of res) if (r.result) withBal.push({ address: chunk[r.id], balance: BigInt(r.result) });
    }
    withBal.sort((a, b) => (a.balance < b.balance ? 1 : -1));
    const top = withBal.slice(0, 10);
    for (const t of top) t.isContract = (await up("eth_getCode", [t.address, "0x" + pin.toString(16)])) !== "0x";
    const pick = top.find((t) => !t.isContract && t.balance >= U(1000)) ?? top.find((t) => t.balance >= U(1000)) ?? top[0];
    ok(pick && pick.balance >= U(101), `no holder with >= 101 USDG found (best: ${pick ? fmt(pick.balance) : "none"})`);
    holder = pick.address; holderBal = pick.balance;
    const forkBal = await bal(holder);
    ok(forkBal === pick.balance, "fork balance differs from upstream balance at pinned block");
    await impersonate(holder);
    return { observed: { ...via, holder, holderIsContract: pick.isContract, holderBalance: `${forkBal} (${fmt(forkBal)} USDG)`, top: top.slice(0, 5).map((t) => ({ address: t.address, usdg: fmt(t.balance), contract: t.isContract })) } };
  }, { critical: true });

  // --- (c) deploy escrow
  const art = JSON.parse(readFileSync(path.join(root, "artifacts", "ElyraEscrow.json"), "utf8"));
  const escrowIface = new ethers.Interface(art.abi);
  decoders = [new ethers.Interface(TOKEN_ABI), new ethers.Interface(SC_ABI), escrowIface, EXTRA_ERRORS];
  const deployer = ethers.Wallet.createRandom().connect(provider);
  const consumer = ethers.Wallet.createRandom().connect(provider);
  const provW = ethers.Wallet.createRandom().connect(provider);
  let escrow;
  await step("C", "deploy ElyraEscrow(real USDG) on the fork", async () => {
    await send("hardhat_setBalance", [deployer.address, ETH1]);
    const f = new ethers.ContractFactory(art.abi, art.bytecode, deployer);
    const c = await f.deploy(USDG);
    const rc = await c.deploymentTransaction().wait();
    escrow = new ethers.Contract(await c.getAddress(), art.abi, provider);
    ok((await escrow.token()) === USDG, "escrow.token() != USDG");
    const dom = await escrow.domainSeparator();
    const expect = ethers.TypedDataEncoder.hashDomain({ name: "ElyraEscrow", version: "1", chainId: MAINNET_ID, verifyingContract: escrow.target });
    ok(dom === expect, "domainSeparator mismatch (chain id on fork)");
    return { gas: rc.gasUsed.toString(), observed: { escrow: escrow.target, token: await escrow.token(), artifactCompiler: art.compiler, domainSeparatorChainId: MAINNET_ID, deployGasUsed: rc.gasUsed } };
  }, { critical: true });

  // --- (d) happy path
  const TYPES = { Voucher: [{ name: "consumer", type: "address" }, { name: "provider", type: "address" }, { name: "cumulative", type: "uint256" }] };
  const domain = () => ({ name: "ElyraEscrow", version: "1", chainId: MAINNET_ID, verifyingContract: escrow.target });
  const sign = (cum) => consumer.signTypedData(domain(), TYPES, { consumer: consumer.address, provider: provW.address, cumulative: cum });
  const E = (w) => escrow.connect(w);
  const T = (w) => token.connect(w);
  const sumInvariant = async () => {
    const [d, b] = await Promise.all([escrow.deposits(consumer.address), bal(escrow)]);
    return { deposits: d, escrowBalance: b };
  };
  const gasOf = async (txp) => { const tx = await txp; const rc = await tx.wait(); ok(rc.status === 1, "tx failed"); return rc; };

  await step("D1", "fund throwaway wallets: 100 USDG → consumer (from impersonated holder), 1 ETH gas each", async () => {
    await send("hardhat_setBalance", [consumer.address, ETH1]);
    await send("hardhat_setBalance", [provW.address, ETH1]);
    const holderSigner = new ethers.JsonRpcSigner(provider, holder);
    const [hb0, cb0] = [await bal(holder), await bal(consumer)];
    const rc = await gasOf(T(holderSigner).transfer(consumer.address, U(100)));
    const [hb1, cb1] = [await bal(holder), await bal(consumer)];
    ok(cb1 - cb0 === U(100), `consumer received ${cb1 - cb0}`);
    ok(hb0 - hb1 === U(100), `holder lost ${hb0 - hb1}`);
    return { gas: rc.gasUsed.toString(), observed: { consumer: consumer.address, provider: provW.address, consumerUsdg: fmt(cb1), holderDeltaUnits: hb0 - hb1, consumerDeltaUnits: cb1 - cb0, note: "real USDG transfer, no fee taken" } };
  });

  await step("D2", "consumer approve(40) + deposit(40 USDG)", async () => {
    const r1 = await gasOf(T(consumer).approve(escrow.target, U(40)));
    const allow = await token.allowance(consumer.address, escrow.target);
    ok(allow === U(40), `allowance ${allow}`);
    const r2 = await gasOf(E(consumer).deposit(U(40)));
    const s = await sumInvariant();
    ok(s.deposits === U(40) && s.escrowBalance === U(40), `deposits ${s.deposits} balance ${s.escrowBalance}`);
    const ev = r2.logs.map((l) => { try { return escrowIface.parseLog(l); } catch { return null; } }).find((l) => l?.name === "Deposited");
    ok(ev && ev.args.amount === U(40), "Deposited event missing");
    return { gas: `approve ${r1.gasUsed} + deposit ${r2.gasUsed}`, observed: { ...s, allowanceAfterDeposit: await token.allowance(consumer.address, escrow.target), consumerUsdg: fmt(await bal(consumer)) } };
  });

  const V1 = 12_345_678n; // 12.345678 USDG
  let sig1;
  await step("D3", "consumer signs cumulative voucher 12.345678 USDG; provider redeems", async () => {
    sig1 = await sign(V1);
    const digest = await escrow.voucherDigest(consumer.address, provW.address, V1);
    ok(digest === ethers.TypedDataEncoder.hash(domain(), TYPES, { consumer: consumer.address, provider: provW.address, cumulative: V1 }), "voucherDigest != EIP-712 hash");
    const p0 = await bal(provW);
    ok(p0 === 0n, "provider should start with 0 USDG");
    const rc = await gasOf(E(provW).redeem(consumer.address, V1, sig1));
    const p1 = await bal(provW);
    ok(p1 === V1, `provider received ${p1}, expected ${V1}`);
    const s = await sumInvariant();
    ok(s.deposits === U(40) - V1, `deposits ${s.deposits}`);
    ok(s.escrowBalance === s.deposits, `escrow balance ${s.escrowBalance} != deposits ${s.deposits}`);
    const claimed = await escrow.claimed(consumer.address, provW.address);
    ok(claimed === V1, `claimed ${claimed}`);
    return { gas: rc.gasUsed.toString(), observed: { providerReceivedUnits: p1, ...s, claimed } };
  });

  await step("D4", "second redeem of the same voucher reverts, state unchanged", async () => {
    const before = { ...(await sumInvariant()), pbal: await bal(provW), claimed: await escrow.claimed(consumer.address, provW.address) };
    let data;
    try { await E(provW).redeem.staticCall(consumer.address, V1, sig1); throw new Error("staticCall did not revert"); } catch (e) { if (e.message === "staticCall did not revert") throw e; data = revertDataOf(e); }
    const dec = decodeRevert(data);
    ok(dec.name === "NotAboveClaimed", `unexpected revert ${dec.name}`);
    let sent = true;
    try { await (await E(provW).redeem(consumer.address, V1, sig1, { gasLimit: 400000 })).wait(); } catch { sent = false; }
    ok(!sent, "second redeem was mined successfully");
    const after = { ...(await sumInvariant()), pbal: await bal(provW), claimed: await escrow.claimed(consumer.address, provW.address) };
    ok(json(before) === json(after), "state changed after failed redeem");
    return { observed: { revert: dec, stateUnchanged: true } };
  });

  await step("D5", "requestWithdraw, early withdraw locked, +1 day, withdraw rest", async () => {
    await gasOf(E(consumer).requestWithdraw());
    const rest = await escrow.deposits(consumer.address);
    let early;
    try { await E(consumer).withdraw.staticCall(rest); throw new Error("early withdraw did not revert"); } catch (e) { if (e.message === "early withdraw did not revert") throw e; early = decodeRevert(revertDataOf(e)); }
    ok(early.name === "WithdrawLocked", `early withdraw revert ${early.name}`);
    await send("evm_increaseTime", [86400 + 60]); await mine();
    const c0 = await bal(consumer);
    const rc = await gasOf(E(consumer).withdraw(rest));
    const c1 = await bal(consumer);
    ok(c1 - c0 === rest, `withdrew ${c1 - c0}, expected ${rest}`);
    const s = await sumInvariant();
    ok(s.deposits === 0n && s.escrowBalance === 0n, `escrow not empty: ${json(s)}`);
    ok(c1 === U(100) - V1, `consumer final ${c1}`);
    return { gas: rc.gasUsed.toString(), observed: { earlyWithdrawRevert: early, withdrawn: `${rest} (${fmt(rest)} USDG)`, consumerFinalUnits: c1, conservation: "consumer + provider == 100 USDG", providerUnits: await bal(provW), ...s } };
  });

  // --- (e) real-token behaviour probes
  await step("E1", "direct token.transfer(1 unit) to the escrow works; not fee-on-transfer", async () => {
    const holderSigner = new ethers.JsonRpcSigner(provider, holder);
    const [e0, h0] = [await bal(escrow), await bal(holder)];
    const rc = await gasOf(T(holderSigner).transfer(escrow.target, 1n));
    const [e1, h1] = [await bal(escrow), await bal(holder)];
    ok(e1 - e0 === 1n && h0 - h1 === 1n, `transfer deltas escrow +${e1 - e0}, holder -${h0 - h1}`);
    return { gas: rc.gasUsed.toString(), observed: { escrowDelta: e1 - e0, holderDelta: h0 - h1, note: "escrow now holds 1 unrecoverable donated unit (no sweep function); deposits sum unchanged", escrowBalance: e1, depositsSum: await escrow.deposits(consumer.address) } };
  });

  await step("E2", "escrow balance-delta check passes on the real token (1-unit and 3 USDG deposits)", async () => {
    await gasOf(T(consumer).approve(escrow.target, U(3) + 1n));
    const rc1 = await gasOf(E(consumer).deposit(1n));
    const rc2 = await gasOf(E(consumer).deposit(U(3)));
    const d = await escrow.deposits(consumer.address);
    const b = await bal(escrow);
    ok(d === U(3) + 1n, `deposits ${d}`);
    ok(b === d + 1n, `escrow balance ${b} should be deposits + 1 donated unit`);
    return { gas: `deposit(1) ${rc1.gasUsed}, deposit(3e6) ${rc2.gasUsed}`, observed: { deposits: d, escrowBalance: b, surplusUnits: b - d } };
  });

  await step("E3", "no rebasing/yield accrual: escrow balance + totalSupply constant after 30 days of fork time", async () => {
    const [b0, s0] = [await bal(escrow), await token.totalSupply()];
    await send("evm_increaseTime", [30 * 86400]); await mine();
    const [b1, s1] = [await bal(escrow), await token.totalSupply()];
    ok(b0 === b1, `escrow balance moved ${b0} -> ${b1}`);
    return { observed: { escrowBalance: [b0, b1], totalSupply: [s0, s1] } };
  });

  // --- (f) controller-burn risk
  await step("F", "supply-controller burn risk (decreaseSupplyFromAddress on the escrow)", async () => {
    ok(supplyControl, "token has no supplyControl()");
    const sc = new ethers.Contract(supplyControl, SC_ABI, provider);
    const controllers = await sc.getAllSupplyControllerAddresses();
    const obs = { supplyControl, controllers: [...controllers] };
    ok(controllers.length > 0, "no supply controllers registered");
    let ctrl = controllers[0];
    const tryView = async (fn) => { try { return await fn(); } catch (e) { return { reverted: decodeRevert(revertDataOf(e)) }; } };
    obs.canBurnFromAddress_view_firstController = await tryView(() => sc.canBurnFromAddress(escrow.target, ctrl));
    obs.canBurnFromEscrow_perController = {};
    for (const c of controllers) { const v = await tryView(() => sc.canBurnFromAddress(escrow.target, c)); obs.canBurnFromEscrow_perController[c] = typeof v === "boolean" ? v : v.reverted.name; }

    // fresh scenario on the same escrow: consumer has 3.000001... deposit 10 USDG more so the numbers are clean
    await gasOf(T(consumer).approve(escrow.target, U(10)));
    await gasOf(E(consumer).deposit(U(10)));
    const dep0 = await escrow.deposits(consumer.address);          // 13.000001
    const cumTarget = V1 + U(5);                                    // provider is owed 5 more
    const sig = await sign(cumTarget);
    obs.setup = { consumerDeposit: dep0, escrowBalanceBeforeBurn: await bal(escrow) };

    const burnAmt = U(11); // leaves escrow with 2.000002 USDG while deposits[consumer] = 13.000001
    obs.burnStaticCallPerController = {};
    let live = null;
    for (const c of controllers) {
      const s = await impersonate(c);
      try { await T(s).decreaseSupplyFromAddress.staticCall(burnAmt, escrow.target); obs.burnStaticCallPerController[c] = "WOULD SUCCEED"; live ??= c; }
      catch (e) { obs.burnStaticCallPerController[c] = decodeRevert(revertDataOf(e)).name; }
    }
    if (live) ctrl = live;
    obs.controller = ctrl;
    const ctrlSigner = await impersonate(ctrl);
    const burn = async (amount) => { await T(ctrlSigner).decreaseSupplyFromAddress.staticCall(amount, escrow.target); return T(ctrlSigner).decreaseSupplyFromAddress(amount, escrow.target, { gasLimit: 2_000_000 }); }; // staticCall first: surfaces the revert data
    const trySend = async (fn) => { try { const rc = await (await fn()).wait(); return { ok: true, rc }; } catch (e) { return { ok: false, err: decodeRevert(revertDataOf(e)), msg: e.shortMessage ?? e.message }; } };

    // F1: burn as the real controller, no config changes
    obs.firstControllerNote = "controllers[0] is only used for the reconfiguration scenario when no controller can burn as-is";
    let r = await trySend(() => burn(burnAmt));
    obs.burnAsRealController = r.ok ? "SUCCEEDED" : { reverted: r.err, msg: r.msg };
    let hypothetical = null;
    if (!r.ok) {
      // F2/F3: hypothetical — the issuer's SupplyControl admin widens the controller on the fork only
      note("the real controller cannot burn from the escrow as configured; simulating issuer reconfiguration on the fork only (hypothetical).");
      const adminAddr = await sc.defaultAdmin();
      obs.supplyControlAdmin = adminAddr;
      const adminSigner = await impersonate(adminAddr);
      const scAbi2 = new ethers.Contract(supplyControl, [...SC_ABI, "function addMintAddressToWhitelist(address,address)", "function SUPPLY_CONTROLLER_MANAGER_ROLE() view returns (bytes32)", "function hasRole(bytes32,address) view returns (bool)", "function grantRole(bytes32,address)"], adminSigner);
      const role = await scAbi2.SUPPLY_CONTROLLER_MANAGER_ROLE();
      obs.adminHasManagerRole = await scAbi2.hasRole(role, adminAddr);
      if (!obs.adminHasManagerRole) { const g = await trySend(() => scAbi2.grantRole(role, adminAddr)); obs.grantManagerRoleToAdmin = g.ok ? "ok (fork only)" : { reverted: g.err }; }
      const attempts = [
        ["whitelist escrow for controller (addMintAddressToWhitelist(controller, escrow))", () => scAbi2.addMintAddressToWhitelist(ctrl, escrow.target, { gasLimit: 1_000_000 })],
        ["allow any mint/burn address for controller (updateAllowAnyMintAndBurnAddress(controller, true))", () => scAbi2.updateAllowAnyMintAndBurnAddress(ctrl, true, { gasLimit: 1_000_000 })],
      ];
      obs.reconfigAttempts = [];
      for (const [label, fn] of attempts) {
        const rr = await trySend(fn);
        const entry = { label, configTx: rr.ok ? "ok" : { reverted: rr.err, msg: rr.msg } };
        if (rr.ok) {
          entry.canBurnFromAddress = await tryView(() => sc.canBurnFromAddress(escrow.target, ctrl));
          r = await trySend(() => burn(burnAmt));
          entry.burn = r.ok ? "SUCCEEDED" : { reverted: r.err, msg: r.msg };
        }
        obs.reconfigAttempts.push(entry);
        if (r.ok) { hypothetical = label; break; }
      }
    }
    if (!r.ok) return { status: "SKIP", observed: { ...obs, conclusion: "burn could not be executed on the fork even after simulated issuer reconfiguration; see reverts" } };
    obs.burnWasHypothetical = hypothetical ?? false;

    const balAfter = await bal(escrow), depAfter = await escrow.deposits(consumer.address);
    obs.afterBurn = { burned: burnAmt, escrowBalance: balAfter, deposits: depAfter, accountingGapUnits: depAfter - balAfter, accountingGapUsdg: fmt(depAfter - balAfter) };
    ok(balAfter === obs.setup.escrowBalanceBeforeBurn - burnAmt, `escrow balance ${balAfter} != ${obs.setup.escrowBalanceBeforeBurn} - ${burnAmt}`);

    // raw token revert data for an over-balance transfer from the escrow (impersonated eth_call)
    try { await provider.call({ from: escrow.target, to: USDG, data: new ethers.Interface(TOKEN_ABI).encodeFunctionData("transfer", [provW.address, balAfter + 1n]) }); obs.tokenRevertOnOverTransfer = "did not revert"; }
    catch (e) { obs.tokenRevertOnOverTransfer = decodeRevert(revertDataOf(e)); }

    // redeem that exceeds the real balance → must revert atomically
    const snap = async () => ({ deposits: await escrow.deposits(consumer.address), claimed: await escrow.claimed(consumer.address, provW.address), escrowBalance: await bal(escrow), providerBalance: await bal(provW) });
    const before = await snap();
    let sc1;
    try { await E(provW).redeem.staticCall(consumer.address, cumTarget, sig); sc1 = "did not revert"; } catch (e) { sc1 = decodeRevert(revertDataOf(e)); }
    const mined = await trySend(() => E(provW).redeem(consumer.address, cumTarget, sig, { gasLimit: 500000 }));
    const afterRedeem = await snap();
    obs.redeemExceedingBalance = { owed: U(5), escrowBalance: balAfter, staticCallRevert: sc1, txMined: mined.ok, stateUnchanged: json(before) === json(afterRedeem) };
    ok(!mined.ok, "over-balance redeem unexpectedly mined");
    ok(json(before) === json(afterRedeem), "redeem was not atomic");

    // withdraw of the full deposit → must revert atomically
    await gasOf(E(consumer).requestWithdraw());
    await send("evm_increaseTime", [86400 + 60]); await mine();
    const wBefore = await snap();
    let sc2;
    try { await E(consumer).withdraw.staticCall(wBefore.deposits); sc2 = "did not revert"; } catch (e) { sc2 = decodeRevert(revertDataOf(e)); }
    const wm = await trySend(() => E(consumer).withdraw(wBefore.deposits, { gasLimit: 500000 }));
    const wAfter = await snap();
    obs.withdrawFullDeposit = { amount: wBefore.deposits, escrowBalance: wBefore.escrowBalance, staticCallRevert: sc2, txMined: wm.ok, stateUnchanged: json(wBefore) === json(wAfter) };
    ok(!wm.ok, "over-balance withdraw unexpectedly mined");
    ok(json(wBefore) === json(wAfter), "withdraw was not atomic");

    // partial recovery: redeem/withdraw up to the real balance still works (first come, first served)
    const part = balAfter;
    const wp = await trySend(() => E(consumer).withdraw(part, { gasLimit: 500000 }));
    obs.withdrawUpToRealBalance = wp.ok ? { amount: part, ok: true, escrowBalanceAfter: await bal(escrow), depositsAfter: await escrow.deposits(consumer.address) } : { ok: false, revert: wp.err };
    const first = typeof obs.burnAsRealController === "object" ? `As configured on mainnet none of the ${controllers.length} supply controllers can burn from the escrow (${obs.burnAsRealController.reverted.name}); it only becomes possible after an issuer-side reconfiguration (simulated on the fork: ${hypothetical ?? "n/a"}). ` : `A REAL supply controller (${ctrl}) can burn from the escrow as currently configured on mainnet (no reconfiguration needed; per-controller static calls: ${json(obs.burnStaticCallPerController)}). `;
    obs.conclusion = `${first}After the simulated burn deposits[] exceeded the real escrow balance by ${fmt(depAfter - balAfter)} USDG; over-balance redeem/withdraw revert atomically with TokenTransferFailed (token revert: ${typeof obs.tokenRevertOnOverTransfer === "object" ? obs.tokenRevertOnOverTransfer.name : obs.tokenRevertOnOverTransfer}); amounts up to the remaining balance are paid first-come-first-served; the burned shortfall is unrecoverable and there is no on-chain remedy (documented in ElyraEscrow.sol). The token is additionally upgradeable by its owner (UUPS-style upgradeTo/setFacet), so burn is not the only issuer-side lever.`;
    return { observed: obs };
  });
}

// ---------- markdown ----------
function render(exitCode, fatal) {
  const pass = steps.filter((s) => s.status === "PASS").length, fail = steps.filter((s) => s.status === "FAIL").length, skip = steps.filter((s) => s.status === "SKIP").length;
  const L = [];
  L.push("# ElyraEscrow — Robinhood mainnet fork rehearsal (real USDG, no real funds)", "");
  L.push(`Generated: ${new Date().toISOString()}  `);
  L.push(`Fork: chain id ${report.chainId ?? "?"}, block ${report.forkBlock ?? "?"} of \`${UPSTREAM}\` (read-only, via DoH proxy \`127.0.0.1:${PROXY_PORT}\`), local node \`${NODE_URL}\`.  `);
  L.push(`Token: real USDG \`${USDG}\`. Escrow: committed \`artifacts/ElyraEscrow.json\` deployed on the fork only. All wallets are throwaway; no mainnet transaction is ever sent (proxy refuses write RPCs).  `);
  L.push(`Result: **${fail ? "FAIL" : "OK"}** — ${pass} passed, ${fail} failed, ${skip} skipped.`, "");
  if (fatal) L.push(`Fatal: \`${fatal}\``, "");
  L.push("| Step | Result | Gas | What |", "|---|---|---|---|");
  for (const s of steps) L.push(`| ${s.id} | ${s.status} | ${s.gas ?? ""} | ${s.title.replace(/\|/g, "\\|")} |`);
  L.push("", "Gas figures are hardhat EVM gas on the fork (no Arbitrum L1 data fee component).", "");
  if (notes.length) { L.push("## Notes", ""); for (const n of notes) L.push(`- ${n}`); L.push(""); }
  L.push("## Step details", "");
  for (const s of steps) {
    L.push(`### ${s.id} — ${s.title} — ${s.status}`, "");
    if (s.error) L.push("```json", json(s.error), "```", "");
    if (s.observed && Object.keys(s.observed).length) L.push("```json", json(s.observed), "```", "");
  }
  L.push("## Processes", "");
  for (const p of started) L.push(`- ${p.name}: PID ${p.pid} (stopped at end of run)`);
  L.push("");
  return L.join("\n");
}

let fatal = null;
try { await main(); } catch (e) { fatal = e.message; console.error("fatal:", e.stack ?? e.message); }
finally {
  const md = render(0, fatal);
  const out = path.join(root, "rehearsal-mainnet-fork.md");
  writeFileSync(out, md);
  console.log(md);
  console.error(`report written to ${out}`);
  await cleanup();
}
process.exit(fatal || steps.some((s) => s.status === "FAIL") ? 1 : 0);
