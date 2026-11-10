// Elyra VPR — Virtual Private Router daemon: CLI parsing, boot and graceful shutdown only.
//   node router/server.mjs [--port 8545] [--host 127.0.0.1] [--data .elyra] [--name NAME]
//                       [--public-url URL] [--seed URL]... [--no-demo] [--allow-mainnet] [--allow-private-peers]
// Serves: OpenAI-compatible /v1, local control API /api, peer protocol /p2p, and the static site + /app/ (see http/).
import { startRelayClient } from "./core/relay-client.mjs";
import { existsSync, renameSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { VERSION } from "./core/limits.mjs";
import { createNode } from "./core/node.mjs";
import { createApp } from "./http/app.mjs";
import { log } from "./obs.mjs";

const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf("--" + name); return i >= 0 ? args[i + 1] : def; };
const seeds = args.flatMap((a, i) => (a === "--seed" ? [args[i + 1]] : []));
const port = Number(opt("port", 8545));
const host = opt("host", "127.0.0.1");
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const defaultData = join(root, ".elyra");
// the project was called Solais until 2026-11-06: adopt an existing .solais data dir (identity, wallet, state) instead of silently starting fresh
if (!opt("data") && !existsSync(defaultData) && existsSync(join(root, ".solais"))) renameSync(join(root, ".solais"), defaultData);
const dataDir = resolve(opt("data", defaultData));

// a seller without a public address dials out to a relay instead (it is reachable at <relay>/r/<id>); an explicit public URL wins
const relayUrl = !(opt("public-url") || process.env.ELYRA_PUBLIC_URL) ? opt("relay") || process.env.ELYRA_RELAY_URL || undefined : undefined;
const node = await createNode({
  dataDir, port, host, name: opt("name"), publicUrl: opt("public-url") || process.env.ELYRA_PUBLIC_URL || undefined, relayUrl, demoNetwork: args.includes("--no-demo") ? false : undefined,
  tee: process.env.ELYRA_TEE || "", teeSocket: process.env.ELYRA_TEE_SOCKET || undefined, allowMainnet: args.includes("--allow-mainnet"), passphrase: process.env.ELYRA_PASSPHRASE || "", allowPrivatePeers: args.includes("--allow-private-peers"),
});
const { state } = node;

// Boot-time configuration from the environment, for immutable deployments (Confidential Space has no interactive setup).
// Each variable is visible in the attestation token (submods.container.env), so buyers can inspect what the seller set.
// Runs before server.listen and before seed peer announcements so /p2p/hello advertises the configured seller state immediately.
const envCfg = async () => {
  const E = process.env;
  if (E.ELYRA_ESCROW && !state.chain.escrow) { state.chain.escrow = E.ELYRA_ESCROW; if (E.ELYRA_NETWORK) state.chain.network = E.ELYRA_NETWORK; } // seeds a node without an escrow; never overwrites the owner's choice
  // on-chain provider registry (docs/REGISTRY.md): address + deploy block, discovery on by default once set, announcing is opt-in
  if (E.ELYRA_REGISTRY) { state.chain.registry = E.ELYRA_REGISTRY; if (E.ELYRA_NETWORK && !E.ELYRA_ESCROW) state.chain.network = E.ELYRA_NETWORK; }
  if (E.ELYRA_REGISTRY_BLOCK) state.chain.registryBlock = Math.max(0, Math.floor(Number(E.ELYRA_REGISTRY_BLOCK)) || 0);
  if (E.ELYRA_REGISTRY_DISCOVER === "0") state.settings.registryDiscover = false; else if (E.ELYRA_REGISTRY_DISCOVER === "1") state.settings.registryDiscover = true;
  if (E.ELYRA_REGISTRY_ANNOUNCE === "1") state.settings.registryAnnounce = true; else if (E.ELYRA_REGISTRY_ANNOUNCE === "0") state.settings.registryAnnounce = false;
  // These variables SEED a node that has not been set up. Once the owner has chosen a source, price or payout (panel or API), a restart must
  // not put the environment's values back: that silently dropped a live seller's GPU models on every restart.
  const hasChosenSource = state.provide.upstreamId === "*" || (state.provide.upstreamId !== "demo-engine" && !!node.upstreamById(state.provide.upstreamId)) || (state.provide.upstreamIds ?? []).some((id) => id !== "demo-engine" && !!node.upstreamById(id));
  const fresh = !hasChosenSource;
  if (E.ELYRA_PAYOUT && (fresh || !state.provide.payout)) state.provide.payout = E.ELYRA_PAYOUT;
  if (E.ELYRA_UPSTREAM_URL) {
    try {
      const up = node.upstreams().find((u) => u.baseUrl === E.ELYRA_UPSTREAM_URL.replace(/\/$/, ""));
      const id = up?.id ?? (await node.addUpstream({ name: E.ELYRA_UPSTREAM_NAME || "local-model", baseUrl: E.ELYRA_UPSTREAM_URL })).id;
      if (fresh) state.provide.upstreamId = id;
    } catch (e) { log("error", "boot configuration failed", { reason: e.message }); }
  }
  if (E.ELYRA_PROVIDE_PRICE && fresh) state.provide.price = Number(E.ELYRA_PROVIDE_PRICE);
  if (E.ELYRA_MAX_DEPOSIT_USD && fresh) { const cap = Number(E.ELYRA_MAX_DEPOSIT_USD); if (Number.isFinite(cap) && cap > 0 && cap <= 10000) state.provide.maxDepositUsd = cap; }
  if (E.ELYRA_PROVIDE === "1" && fresh) state.provide.enabled = true;
  node.save();
};
await envCfg().catch((e) => log("error", "boot configuration failed", { reason: e.message }));

const server = createServer(createApp(node, { panelDir: join(root, "panel"), siteDir: join(root, "site") }));
server.listen(port, host, async () => {
  console.log(`Elyra VPR ${VERSION}  node ${node.selfId}  "${state.name}"`);
  console.log(`  endpoint   http://localhost:${port}/v1   (OpenAI-compatible)`);
  console.log(`  app        http://localhost:${port}/app/`);
  console.log(`  p2p        ${node.publicUrl}/p2p/hello   (bound to ${host})`);
  console.log(`  data       ${dataDir}`);
  if (relayUrl) {
    node.relay = startRelayClient({ relayUrl, identity: node.relayIdentity, port, log });
    console.log(`  relay      reachable at ${node.publicUrl} through ${relayUrl}   (no port forwarding needed)`);
    await node.relay.ready;
  } else if (process.env.ELYRA_RELAY_URL || opt("relay")) log("warn", "relay ignored: this node has its own public URL (--public-url / ELYRA_PUBLIC_URL)");
  for (const s of seeds) node.addPeer(s).then((p) => console.log(`  peer +     ${p.name} @ ${p.url}`), (e) => console.log(`  peer !     ${s}: ${e.message}`));
  for (const s2 of (process.env.ELYRA_SEEDS || "").split(",").map((x) => x.trim()).filter(Boolean)) node.addPeer(s2).catch((e) => log("warn", "seed unreachable", { seed: s2, reason: e.message }));
});
if (node.teeActive()) log("info", "TEE node wallet (fund this address with ETH for gas; it changes on every boot)", { wallet: node.address, payout: state.provide.payout || "(none: earnings stay in this wallet!)" });

// shut down without stranding earnings: redeem what we hold (bounded), then exit
const stop = async () => { try { await Promise.race([node.settle(), new Promise((r) => setTimeout(r, 20000))]); } catch { /* best effort */ } node.close(); server.close(); process.exit(0); };
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
