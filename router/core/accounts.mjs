// Username profiles for the opt-in gateway (ELYRA_GATEWAY=1). Authentication is NOT here: wallet sign-in is the one SIWE system in
// http/siwe.mjs (server-built EIP-4361 text, single-use nonce, signed v2 session cookie, roles admin/user). This store only remembers, per
// wallet that signed in, the name the person chose. Rules that matter (each covered by router/test/accounts.test.mjs):
//  - one account per wallet address (lowercase), created on the first successful sign-in;
//  - names are ASCII `[a-z0-9_]{3,20}`, unique ignoring case, not reserved, set once (no squatting by renaming);
//  - the account file is written atomically, mode 600, encrypted when ELYRA_PASSPHRASE is set. No prompts or answers are ever stored here.
import crypto from "node:crypto";
import { existsSync, mkdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import { readSecretJson, writeSecretJson } from "../vault.mjs";

export const RESERVED = new Set(["admin", "administrator", "root", "support", "staff", "elyra", "official", "system", "api", "null", "undefined", "me", "you", "team", "security", "help", "billing", "wallet", "gateway", "node", "router", "mod", "moderator"]);
export const NAME_RE = /^[a-z0-9_]{3,20}$/;
const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;
const MAX_ACCOUNTS = 100_000;

export function createAccounts({ dataDir, passphrase, now = Date.now } = {}) {
  const file = join(dataDir, "accounts.json");
  let db = { v: 1, accounts: {} };
  if (existsSync(file)) { const j = readSecretJson(file, passphrase); if (j?.v === 1) db = { v: 1, accounts: j.accounts ?? {} }; } // a `sessions` table from the retired gateway sign-in is dropped on the next save
  const idByWallet = new Map(), idByName = new Map();
  for (const a of Object.values(db.accounts)) { idByWallet.set(a.wallet, a.id); if (a.username) idByName.set(a.username, a.id); }

  function save() {
    mkdirSync(dataDir, { recursive: true });
    const tmp = file + ".tmp";
    writeSecretJson(tmp, db, passphrase); renameSync(tmp, file);
  }
  const view = (a) => ({ id: a.id, wallet: a.wallet, username: a.username, needsName: !a.username, created: a.created });

  /** the account of a wallet that just signed in (created on first sight); throws { code: "full" } at the cap */
  function ensure(address) {
    const wallet = String(address ?? "").toLowerCase();
    if (!ADDR_RE.test(wallet)) throw Object.assign(new Error("not an address"), { code: "bad_address" });
    let id = idByWallet.get(wallet);
    if (!id) {
      if (Object.keys(db.accounts).length >= MAX_ACCOUNTS) throw Object.assign(new Error("this node cannot take more accounts"), { code: "full" });
      id = "u_" + crypto.randomBytes(8).toString("hex");
      db.accounts[id] = { id, wallet, username: null, created: now() }; idByWallet.set(wallet, id); save();
    }
    return view(db.accounts[id]);
  }
  /** the account of a wallet, or null (never creates one) */
  function byWallet(address) { const id = idByWallet.get(String(address ?? "").toLowerCase()); return id ? view(db.accounts[id]) : null; }

  function checkName(raw) {
    const name = typeof raw === "string" ? raw.trim().toLowerCase() : "";
    if (!NAME_RE.test(name)) return { name, valid: false, available: false, reason: "Use 3 to 20 letters, numbers or underscores." };
    if (RESERVED.has(name)) return { name, valid: true, available: false, reason: "That name is reserved." };
    if (idByName.has(name)) return { name, valid: true, available: false, reason: "That name is taken." };
    return { name, valid: true, available: true, reason: "" };
  }
  function setUsername(accountId, raw) {
    const a = db.accounts[accountId]; if (!a) throw Object.assign(new Error("no such account"), { code: "no_account" });
    if (a.username) throw Object.assign(new Error("your name is already set and cannot be changed"), { code: "name_set" });
    const c = checkName(raw); if (!c.valid || !c.available) throw Object.assign(new Error(c.reason), { code: c.valid ? "name_taken" : "bad_name" });
    a.username = c.name; idByName.set(c.name, a.id); save();
    return view(a);
  }
  return { ensure, byWallet, checkName, setUsername, count: () => Object.keys(db.accounts).length, _db: () => db };
}
