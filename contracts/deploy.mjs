#!/usr/bin/env node
// Deploy ElyraEscrow (USDG / ERC-20 settlement) or, with --registry, the ElyraRegistry (provider discovery).
//   RPC_URL=… PRIVATE_KEY=0x… node contracts/deploy.mjs --token 0x…        escrow for an existing token
//   … --mock-token                                                          deploy MockUSDG first (testnet/local ONLY), then the escrow
//   … --node-wallet <dataDir>                                               key from <dataDir>/wallet.json (ELYRA_PASSPHRASE) instead of PRIVATE_KEY
//   … --testnet                                                             RPC_URL defaults to https://rpc.testnet.chain.robinhood.com
//   … --local                                                               RPC_URL defaults to http://127.0.0.1:8555, key to hardhat dev #0 (local RPC only)
//   … --i-know-this-is-mainnet                                              required on chain id 4663 (--mock-token is refused there outright)
//   … --registry [--bond <usd>] [--token 0x…]                               deploy ONLY ElyraRegistry (separate contract). --bond is the USDG bond per seller (default 0 = none, needs --token when > 0)
// Prints one JSON line {chainId, token, escrow, tokenTx, escrowTx, mock} (registry: {chainId, registry, registryTx, registryBlock, token, bondUnits}); gas + explorer links go to stderr.
// Non-local RPCs go through DoH-resolved connections (../router/net.mjs) because some ISPs hijack *.robinhood.com DNS.
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const { ethers } = createRequire(path.join(here, "package.json"))("ethers");

const argv = process.argv.slice(2);
const flag = (n) => argv.includes("--" + n);
const opt = (n) => { const i = argv.indexOf("--" + n); return i >= 0 ? argv[i + 1] : undefined; };
const die = (m) => { console.error(m); process.exit(1); };

const MAINNET = 4663;
const EXPLORERS = { 4663: "https://robinhoodchain.blockscout.com", 46630: "https://explorer.testnet.chain.robinhood.com" };
// Well-known hardhat dev account #0; only allowed together with --local on a loopback RPC.
const DEV_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

const local = flag("local");
const rpc = process.env.RPC_URL || (local ? "http://127.0.0.1:8555" : flag("testnet") ? "https://rpc.testnet.chain.robinhood.com" : "");
if (!rpc) die("RPC_URL is required (or pass --local)");
const mock = flag("mock-token");
const tokenArg = opt("token");
const registry = flag("registry");
const bondUsd = opt("bond");
if (registry) {
  if (mock) die("--registry does not deploy a mock token; pass --token 0x… if a bond is wanted");
  if (bondUsd !== undefined && !/^\d+(\.\d{1,6})?$/.test(bondUsd)) die("--bond must be a USDG amount with at most 6 decimals, e.g. 5 or 0.5");
  if (bondUsd !== undefined && Number(bondUsd) > 0 && !tokenArg) die("--bond > 0 needs --token 0x… (the bond is paid in that ERC-20)");
} else {
  if (bondUsd !== undefined) die("--bond only applies to --registry");
  if (mock === !!tokenArg) die("pass exactly one of --token 0x… or --mock-token");
}
if (tokenArg && !ethers.isAddress(tokenArg)) die("--token is not a valid address");

const host = new URL(rpc).hostname;
const loopback = host === "127.0.0.1" || host === "localhost" || host === "[::1]" || host === "::1";

let key = process.env.PRIVATE_KEY || "";
const nodeWallet = opt("node-wallet");
if (nodeWallet) {
  const { readSecretJson } = await import("../router/vault.mjs");
  key = readSecretJson(path.join(path.resolve(nodeWallet), "wallet.json"), process.env.ELYRA_PASSPHRASE || "").privateKey;
}
if (!key && local && loopback) key = DEV_KEY;
if (!key) die("PRIVATE_KEY (or --node-wallet <dataDir>) is required");

let conn = rpc;
if (!loopback) {
  const { ethersGetUrl } = await import("../router/net.mjs");
  conn = new ethers.FetchRequest(rpc);
  conn.getUrlFunc = ethersGetUrl;
}
const provider = new ethers.JsonRpcProvider(conn);
const wallet = new ethers.NonceManager(new ethers.Wallet(key, provider)); // tracks nonces locally (RPC nonce lookups can lag a fresh block)
const chainId = Number((await provider.getNetwork()).chainId);

if (chainId === MAINNET && mock) die("refusing --mock-token on chain 4663 (mainnet): the open-mint mock must never be deployed there");
if (chainId === MAINNET && !flag("i-know-this-is-mainnet")) die("chain 4663 is MAINNET (real funds). Pass --i-know-this-is-mainnet to proceed.");

const explorer = EXPLORERS[chainId];
const art = (n) => JSON.parse(readFileSync(path.join(here, "artifacts", n + ".json"), "utf8"));
const log = (m) => console.error(m);

async function deploy(name, ...args) {
  const a = art(name);
  const c = await new ethers.ContractFactory(a.abi, a.bytecode, wallet).deploy(...args);
  const receipt = await c.deploymentTransaction().wait();
  const address = await c.getAddress();
  log(`${name}: ${address}  gas used ${receipt.gasUsed}`);
  if (explorer) log(`  tx ${explorer}/tx/${receipt.hash}\n  address ${explorer}/address/${address}`);
  return { address, tx: receipt.hash, block: receipt.blockNumber };
}

try {
  if (registry) {
    const token = tokenArg ? ethers.getAddress(tokenArg) : ethers.ZeroAddress;
    const bondUnits = ethers.parseUnits(bondUsd ?? "0", 6);
    log(`chain ${chainId}, deployer ${await wallet.getAddress()}, bond ${bondUnits} base units`);
    const reg = await deploy("ElyraRegistry", token, bondUnits);
    console.log(JSON.stringify({ chainId, registry: reg.address, registryTx: reg.tx, registryBlock: reg.block, token, bondUnits: bondUnits.toString() }));
  } else {
  log(`chain ${chainId}, deployer ${await wallet.getAddress()}`);
  const tok = mock ? await deploy("MockUSDG") : { address: ethers.getAddress(tokenArg), tx: null };
  const esc = await deploy("ElyraEscrow", tok.address);
  console.log(JSON.stringify({ chainId, token: tok.address, escrow: esc.address, tokenTx: tok.tx, escrowTx: esc.tx, mock }));
  }
} finally {
  provider.destroy();
}
