// On-chain provider registry (contracts/ElyraRegistry.sol): discovery that needs no seed. See docs/REGISTRY.md.
//  - Seller: announce this node's URL on boot and again before the entry expires (opt-in, needs gas, never blocks boot).
//  - Buyer: read Announced/Revoked logs from a persisted block cursor (bounded span and rate), keep the newest live entry
//    per wallet, and feed each URL into addPeer() exactly like a gossip-learned peer: public-host check, signed
//    /p2p/hello, plus the registry checks below. The chain is untrusted input; any read error creates no peers.
import { canon, sha } from "../lib/canon.mjs";
import { isLocalUrl, normUrl } from "../lib/url.mjs";
import { inc, log } from "../obs.mjs";
import { nullEvents } from "./events.mjs";

export const REGISTRY_TTL_SECONDS = 7 * 86400;
const SPAN = 2000;            // blocks per eth_getLogs call
const CALLS_PER_TICK = 10;    // getLogs calls per scan pass
const OVERLAP = 12;           // blocks re-read behind the cursor (reorg safety; applying an event twice is a no-op)
const VERIFY_PER_TICK = 5;    // hello verifications per pass (bounded fetch rate)
const MAX_ENTRIES = 2000;     // persisted entries (live + tombstones)
const MAX_URL = 256;
const RETRY_BASE = 120_000, RETRY_MAX = 6 * 3600_000, GIVE_UP = 8;
const HEX32 = /^0x[0-9a-f]{64}$/;

/** bytes32 node id announced on-chain: the full sha-256 of the node's ed25519 public key (the 16-hex node id is its prefix) */
export const nodeIdOf = (pub) => "0x" + sha(Buffer.from(pub, "base64"));
/** bytes32 box key announced on-chain: sha-256 of the node's X25519 public key (SPKI DER, as served in hello.box.pub) */
export const boxKeyOf = (boxPub) => "0x" + sha(Buffer.from(boxPub, "base64"));
/** metaHash: sha-256 over the canonical JSON of what the node's signed hello commits to (identity key, box key, wallet) plus the announced URL. docs/PROTOCOL.md */
export const metaHashOf = ({ pub, box, wallet, url }) => "0x" + sha(canon({ t: "elyra-registry-meta-v1", pub, box, wallet: String(wallet).toLowerCase(), url }));

/** the checks a hello must pass for an announcement; throws on any mismatch (hello signatures were already verified by fetchHello) */
export function checkHelloAgainstEntry(h, e) {
  if (nodeIdOf(h.pub) !== e.nodeId) throw new Error("registry: node id does not match the announcement");
  if (boxKeyOf(h.box.pub) !== e.boxKey) throw new Error("registry: box key does not match the announcement");
  if (!h.wallet?.address || h.wallet.address.toLowerCase() !== e.wallet) throw new Error("registry: hello wallet is not the announcing wallet");
  if (metaHashOf({ pub: h.pub, box: h.box.pub, wallet: h.wallet.address, url: e.url }) !== e.metaHash) throw new Error("registry: metaHash does not match the hello");
}

export function createRegistry({ opts, state, save, identity, chain, publicUrl, events = nullEvents }, { addPeer }) {
  const R = (state.registry ??= {});
  R.entries ??= {};
  const pollMs = Math.min(600_000, Math.max(1000, Number(process.env.ELYRA_REGISTRY_POLL_MS) || 30_000));
  const st = { chainTime: 0, lastScan: null, lastError: "", announceError: "", scanning: false };
  let timer = null, stopped = false;
  const discoverOn = () => state.settings.registryDiscover !== false;
  const announceOn = () => state.settings.registryAnnounce === true;
  /** "now" for expiry: the later of this machine's clock and the newest chain block time seen, so either clock can expire an entry */
  const nowSec = () => Math.max(Date.now() / 1000, st.chainTime);
  const live = (e) => !e.revoked && e.expiresAt > nowSec();

  // ---------------- buyer: scan logs ----------------
  const newer = (ev, cur) => !cur || ev.block > cur.block || (ev.block === cur.block && ev.logIndex > cur.logIndex);

  function ingest(ev) {
    const cur = R.entries[ev.wallet];
    if (!newer(ev, cur)) return;
    if (ev.type === "revoked") { R.entries[ev.wallet] = { wallet: ev.wallet, revoked: true, block: ev.block, logIndex: ev.logIndex }; return; }
    // shape-check everything the chain handed us before it is stored
    if (!HEX32.test(ev.nodeId) || !HEX32.test(ev.boxKey) || !HEX32.test(ev.metaHash) || typeof ev.url !== "string" || ev.url.length > MAX_URL || !Number.isSafeInteger(ev.expiresAt)) return;
    let url; try { url = normUrl(ev.url); } catch { return; }
    if (ev.expiresAt <= nowSec()) { // already expired: it still supersedes an older live entry of that wallet
      R.entries[ev.wallet] = { wallet: ev.wallet, revoked: true, block: ev.block, logIndex: ev.logIndex };
      return;
    }
    R.entries[ev.wallet] = { wallet: ev.wallet, revoked: false, nodeId: ev.nodeId, boxKey: ev.boxKey, url, metaHash: ev.metaHash, expiresAt: ev.expiresAt, block: ev.block, logIndex: ev.logIndex, fails: 0, nextTry: 0, peerId: null };
  }

  function prune() {
    const all = Object.values(R.entries);
    for (const e of all) if (!e.revoked && !live(e)) { e.revoked = true; delete e.url; } // expired → tombstone (keeps ordering vs. re-read logs)
    const left = Object.values(R.entries);
    if (left.length > MAX_ENTRIES) {
      left.sort((a, b) => (live(a) === live(b) ? a.block - b.block : live(a) ? 1 : -1)); // dead and old first
      for (const e of left.slice(0, left.length - MAX_ENTRIES)) delete R.entries[e.wallet];
    }
  }

  /** One bounded pass over new blocks. Any RPC error aborts the pass without moving the cursor past unread blocks. */
  async function scan() {
    if (!discoverOn() || !chain.registryConfigured()) return false;
    const key = chain.registryKey();
    const start = Math.max(0, Number(state.chain.registryBlock) || 0);
    if (R.cursor?.key !== key) { R.cursor = { key, next: start }; R.entries = {}; } // other registry/network: start over
    const { number: head, time } = await chain.registryHead();
    st.chainTime = Math.max(st.chainTime, time);
    let from = Math.max(start, R.cursor.next - OVERLAP), calls = 0, first = from;
    while (from <= head && calls < CALLS_PER_TICK) {
      const to = Math.min(head, from + SPAN - 1);
      const evs = await chain.registryLogs(from, to);
      calls++;
      evs.sort((a, b) => a.block - b.block || a.logIndex - b.logIndex);
      for (const ev of evs) ingest(ev);
      R.cursor.next = to + 1; // advanced only after this span was read and applied
      from = to + 1;
    }
    prune();
    st.lastScan = { from: first, to: from - 1, head, at: Date.now() };
    save();
    return from <= head; // more to read
  }

  // ---------------- buyer: verify through the gossip path ----------------
  async function verifyBatch() {
    const now = Date.now();
    const self = chain.address?.toLowerCase();
    const due = Object.values(R.entries).filter((e) => live(e) && e.wallet !== self && !e.peerId && e.fails < GIVE_UP && (e.nextTry ?? 0) <= now).sort((a, b) => b.block - a.block).slice(0, VERIFY_PER_TICK);
    await Promise.all(due.map(async (e) => {
      try {
        const p = await addPeer(e.url, 1, false, { check: (h) => checkHelloAgainstEntry(h, e), viaRegistry: true });
        e.peerId = p.id; e.fails = 0; e.lastError = "";
        inc("elyra_registry_events_total", { event: "peer" });
      } catch (err) {
        e.fails = (e.fails ?? 0) + 1;
        e.lastError = String(err.message).slice(0, 160);
        e.nextTry = e.fails >= GIVE_UP ? e.expiresAt * 1000 : Date.now() + Math.min(RETRY_MAX, RETRY_BASE * 2 ** (e.fails - 1));
        inc("elyra_registry_events_total", { event: "rejected" });
        log("info", "registry entry rejected", { wallet: e.wallet, url: e.url, reason: e.lastError });
      }
    }));
    if (due.length) save();
  }

  // ---------------- seller: announce ----------------
  async function announceTick() {
    if (!announceOn() || !state.provide.enabled || !chain.registryConfigured() || !chain.configured()) return;
    const url = publicUrl;
    if (!opts.publicUrl && !opts.relayUrl) { st.announceError = "no public URL (set --public-url or use a relay)"; return; }
    if (isLocalUrl(url) && !opts.allowPrivatePeers) { st.announceError = "public URL is a local address, nobody could reach it"; return; }
    const meta = metaHashOf({ pub: identity.pub, box: identity.box.pub, wallet: chain.address, url });
    const sig = `${chain.registryKey()}|${url}|${meta}|${chain.address.toLowerCase()}`;
    const a = R.announce;
    const nowS = Math.floor(Date.now() / 1000);
    if (a?.sig === sig && a.expiresAt - nowS > REGISTRY_TTL_SECONDS / 2) return; // listed and fresh enough
    if (!(await chain.hasGas())) {
      const msg = "no gas: fund the node wallet with ETH to be listed";
      if (st.announceError !== msg) events.alert({ code: "low_gas", subject: "registry listing" }); // once, not on every pass
      st.announceError = msg;
      return;
    }
    const t = await chain.registryAnnounce({ nodeId: nodeIdOf(identity.pub), boxKey: boxKeyOf(identity.box.pub), url, metaHash: meta, ttl: REGISTRY_TTL_SECONDS });
    R.announce = { sig, expiresAt: nowS + REGISTRY_TTL_SECONDS, at: Date.now(), tx: t.hash };
    st.announceError = "";
    save();
    log("info", "registry announced", { url, tx: t.hash });
  }

  const guarded = (what, fn) => fn().then(() => { if (what === "scan") st.lastError = ""; }, (e) => {
    const msg = String(e.shortMessage ?? e.message).slice(0, 200);
    if (what === "announce") { if (msg !== st.announceError) log("warn", "registry announce failed (continuing without it)", { reason: msg }); st.announceError = msg; }
    else { if (msg !== st.lastError) log("warn", "registry read failed (no peers created)", { reason: msg }); st.lastError = msg; }
  });

  async function pass() {
    if (st.scanning) return false;
    st.scanning = true;
    let more = false;
    try {
      await guarded("scan", async () => { more = await scan(); await verifyBatch(); });
      await guarded("announce", announceTick);
    } finally { st.scanning = false; }
    return more;
  }

  function schedule(ms) {
    if (stopped) return;
    timer = setTimeout(async () => { const more = await pass().catch(() => false); schedule(more ? 5000 : pollMs); }, ms);
    timer.unref();
  }
  schedule(2000); // first pass shortly after boot: never part of the boot path

  const status = () => ({
    configured: chain.registryConfigured(), address: chain.registryAddress(), discover: discoverOn(), announce: announceOn(),
    cursor: R.cursor?.next ?? null, startBlock: Number(state.chain.registryBlock) || 0, lastScan: st.lastScan, lastError: st.lastError, announceError: st.announceError,
    listed: R.announce ? { expiresAt: R.announce.expiresAt, tx: R.announce.tx } : null,
    entries: Object.values(R.entries).filter(live).length, peers: Object.values(R.entries).filter((e) => live(e) && e.peerId).length,
    pending: Object.values(R.entries).filter((e) => live(e) && !e.peerId).map((e) => ({ wallet: e.wallet, url: e.url, fails: e.fails, error: e.lastError || null })).slice(0, 50),
  });

  return {
    pass, status,
    /** after an on-chain revoke from this node */
    clearAnnounce() { delete R.announce; save(); },
    stop() { stopped = true; clearTimeout(timer); },
  };
}
