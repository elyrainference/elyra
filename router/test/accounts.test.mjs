// Username profiles (wallet accounts, ELYRA_GATEWAY=1): accounts per wallet, name rules, persistence. Sign-in itself (nonce, signed text, replay, phishing,
// expiry, sessions) is the ONE SIWE system and is covered by router/test/siwe.test.mjs and gateway.test.mjs. Run: node --test router/test/accounts.test.mjs
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { Wallet } from "ethers";
import { createAccounts } from "../core/accounts.mjs";

const dirs = []; const tmp = () => { const d = mkdtempSync(join(tmpdir(), "vpr-acct-")); dirs.push(d); return d; };
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
const mk = (extra = {}) => { let t = 1_800_000_000_000; const clock = { now: () => t, tick: (ms) => { t += ms; } }; const dir = extra.dir ?? tmp(); return { clock, dir, a: createAccounts({ dataDir: dir, now: clock.now, ...extra }) }; };

describe("accounts", () => {
  test("ensure creates one account per wallet (case-insensitive), without a name, and never twice", () => {
    const { a } = mk(); const w = Wallet.createRandom();
    const r = a.ensure(w.address); assert.equal(r.wallet, w.address.toLowerCase()); assert.equal(r.username, null); assert.equal(r.needsName, true);
    assert.equal(a.ensure(w.address.toLowerCase()).id, r.id, "same wallet, same account"); assert.equal(a.count(), 1);
    assert.equal(a.byWallet(w.address.toLowerCase()).id, r.id);
    assert.equal(a.byWallet(Wallet.createRandom().address), null, "byWallet never creates an account");
  });
  test("a bad address gets no account", () => { const { a } = mk(); for (const bad of ["", "0x12", "nope", null, undefined, "0x" + "g".repeat(40)]) assert.throws(() => a.ensure(bad), (e) => e.code === "bad_address"); assert.equal(a.count(), 0); });
});

describe("names", () => {
  test("rules: ascii, 3 to 20, unique ignoring case, not reserved, set once", () => {
    const { a } = mk(); const w1 = Wallet.createRandom(), w2 = Wallet.createRandom(); const r1 = a.ensure(w1.address), r2 = a.ensure(w2.address);
    for (const bad of ["ab", "a".repeat(21), "has space", "emoji😀", "dash-name", "ünï", "", null, "<b>x</b>", "../etc"]) assert.throws(() => a.setUsername(r1.id, bad), (e) => e.code === "bad_name", String(bad));
    for (const r of ["admin", "Elyra", "ROOT"]) assert.throws(() => a.setUsername(r1.id, r), (e) => e.code === "name_taken");
    assert.equal(a.setUsername(r1.id, "  Alice_01 ").username, "alice_01");
    assert.throws(() => a.setUsername(r2.id, "ALICE_01"), (e) => e.code === "name_taken", "case-insensitive unique");
    assert.throws(() => a.setUsername(r1.id, "bob"), (e) => e.code === "name_set", "no renaming");
    assert.deepEqual([a.checkName("alice_01").available, a.checkName("free_name").available, a.checkName("x").valid], [false, true, false]);
    assert.throws(() => a.setUsername("u_nope", "valid_name"), (e) => e.code === "no_account");
  });
});

describe("storage", () => {
  test("accounts survive a restart; the file is mode 600; a retired sessions table is dropped", () => {
    const dir = tmp(); const w = Wallet.createRandom(); const x = mk({ dir }); const r = x.a.ensure(w.address); x.a.setUsername(r.id, "keeper");
    const y = createAccounts({ dataDir: dir, now: x.clock.now }); assert.equal(y.byWallet(w.address).username, "keeper"); assert.equal(y.checkName("keeper").available, false);
    if (process.platform !== "win32") assert.equal(statSync(join(dir, "accounts.json")).mode & 0o777, 0o600);
    const f = join(dir, "accounts.json"), j = JSON.parse(readFileSync(f, "utf8")); j.sessions = { deadbeef: { acct: r.id, exp: 1 } }; writeFileSync(f, JSON.stringify(j));
    const z = createAccounts({ dataDir: dir }); z.setUsername(z.ensure(Wallet.createRandom().address).id, "second_one"); assert.equal("sessions" in JSON.parse(readFileSync(f, "utf8")), false);
  });
  test("with a passphrase the file is encrypted and needs the passphrase", () => {
    const dir = tmp(); const w = Wallet.createRandom(); const x = mk({ dir, passphrase: "correct horse battery" }); x.a.ensure(w.address);
    const raw = readFileSync(join(dir, "accounts.json"), "utf8"); assert.ok(!raw.includes(w.address.toLowerCase()), "no wallet address in clear"); assert.ok(raw.includes('"enc":1'));
    assert.equal(createAccounts({ dataDir: dir, passphrase: "correct horse battery", now: x.clock.now }).byWallet(w.address).wallet, w.address.toLowerCase());
    assert.throws(() => createAccounts({ dataDir: dir }), /encrypted/); assert.throws(() => createAccounts({ dataDir: dir, passphrase: "wrong" }), /wrong ELYRA_PASSPHRASE/);
  });
});
