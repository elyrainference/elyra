// URL and address policy: private-range detection, local-upstream detection, the gossip SSRF guard.
// Pure helpers (the guard only does a DNS lookup); no node state.
import dns from "node:dns/promises";
import net from "node:net";

/** a node's base URL: the origin, plus the /r/<id> prefix of a node that is reached through a relay (and nothing else is kept) */
export const normUrl = (u) => {
  const x = new URL(u); if (!/^https?:$/.test(x.protocol)) throw new Error("http(s) only");
  const via = /^\/r\/[0-9a-f]{16}\/?$/.test(x.pathname) ? x.pathname.replace(/\/$/, "") : "";
  return x.origin + via;
};

export const isPrivateIp = (ip) => {
  const v4 = ip.replace(/^::ffff:/i, "");
  if (net.isIPv4(v4)) {
    const [a, b] = v4.split(".").map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  const l = ip.toLowerCase();
  return l === "::1" || l === "::" || l.startsWith("fc") || l.startsWith("fd") || l.startsWith("fe80");
};

/** An upstream on this machine/LAN keeps prompts local; a hosted API (OpenRouter, OpenAI, …) does not. */
export const isLocalUrl = (u) => { try { const h = new URL(u).hostname.replace(/^\[|\]$/g, ""); return h === "localhost" || h.endsWith(".local") || (net.isIP(h) && isPrivateIp(h)); } catch { return false; } };

/** Peers learned through gossip must be public hosts: a hostile peer cannot make us probe localhost / LAN / cloud metadata. */
export async function assertPublicUrl(url, allowPrivatePeers = false) {
  if (allowPrivatePeers) return;
  const host = new URL(url).hostname.replace(/^\[|\]$/g, "");
  const addrs = net.isIP(host) ? [host] : (await dns.lookup(host, { all: true })).map((a) => a.address);
  if (!addrs.length || addrs.some(isPrivateIp)) throw new Error("private address refused for gossip-learned peer (add it manually, or start with --allow-private-peers)");
}
