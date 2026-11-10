// Verify ElyraEscrow / ElyraRegistry / MockUSDG on a Blockscout explorer (Robinhood Chain uses Blockscout).
//   node contracts/verify.mjs --contract ElyraEscrow --address 0x… --constructor-args 0x<abi-encoded token address> [--network robinhood-testnet|robinhood-mainnet] [--explorer https://…]
//   node contracts/verify.mjs --contract MockUSDG --address 0x…
// Uses Blockscout API v2: POST /api/v2/smart-contracts/{address}/verification/via/standard-input, then polls until verified.
// Requests go through DoH-resolved connections (../router/net.mjs) to survive ISP DNS hijacking.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { dohFetch } from "../router/net.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf("--" + n); return i >= 0 ? args[i + 1] : d; };
const EXPLORERS = { "robinhood-testnet": "https://explorer.testnet.chain.robinhood.com", "robinhood-mainnet": "https://robinhoodchain.blockscout.com" };
const CONTRACTS = { ElyraEscrow: "ElyraEscrow.sol", ElyraRegistry: "ElyraRegistry.sol", MockUSDG: "MockUSDG.sol" };

const address = opt("address");
const contract = opt("contract");
const ctorArgs = opt("constructor-args");
const explorer = (opt("explorer") ?? EXPLORERS[opt("network", "robinhood-testnet")]).replace(/\/$/, "");
const usage = "usage: node contracts/verify.mjs --contract ElyraEscrow|ElyraRegistry|MockUSDG --address 0x… [--constructor-args 0x…] [--network …] [--explorer URL]";
if (!/^0x[0-9a-fA-F]{40}$/.test(address ?? "") || !CONTRACTS[contract] || (ctorArgs && !/^0x([0-9a-fA-F]{2})*$/.test(ctorArgs))) { console.error(usage); process.exit(2); }

const si = JSON.parse(readFileSync(join(here, "artifacts", "standard-input.json"), "utf8"));
const form = new FormData();
form.set("compiler_version", si.compilerVersion);
form.set("contract_name", contract);
if (ctorArgs) form.set("constructor_args", ctorArgs);
else form.set("autodetect_constructor_args", "true");
form.set("license_type", "mit");
form.set("files[0]", new Blob([JSON.stringify(si.input)], { type: "application/json" }), "standard-input.json");

// Serialise the multipart body ourselves so it can go through dohFetch.
const enc = new Response(form);
const body = Buffer.from(await enc.arrayBuffer());
const headers = { "content-type": enc.headers.get("content-type"), "content-length": String(body.length) };

const base = `${explorer}/api/v2/smart-contracts/${address}`;
const r = await dohFetch(`${base}/verification/via/standard-input`, { method: "POST", headers, body, timeout: 60000 });
console.log("submit:", r.status, (await r.text()).slice(0, 300));
if (!r.ok) process.exit(1);

for (let i = 0; i < 20; i++) {
  await new Promise((res) => setTimeout(res, 3000));
  const j = await (await dohFetch(base, { timeout: 15000 })).json().catch(() => ({}));
  if (j.is_verified || j.is_fully_verified) { console.log(JSON.stringify({ verified: true, url: `${explorer}/address/${address}?tab=contract` })); process.exit(0); }
}
console.error("not verified yet; check the explorer");
process.exit(1);
