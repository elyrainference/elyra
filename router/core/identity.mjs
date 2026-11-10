// Node identity: ed25519 signing key (node id = first 16 hex of sha256(pub)) + X25519 box key for sealed envelopes.
// Owns identity.json (via vault.mjs, so it may be passphrase-encrypted). Must never expose the private halves:
// callers get sign()/verify() and the public parts only.
import crypto from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { canon, sha } from "../lib/canon.mjs";
import { newBoxKey } from "../seal.mjs";
import { readSecretJson, writeSecretJson } from "../vault.mjs";

export function loadIdentity(dataDir, passphrase) {
  mkdirSync(dataDir, { recursive: true });
  const idFile = join(dataDir, "identity.json");
  let ident;
  if (existsSync(idFile)) ident = readSecretJson(idFile, passphrase);
  else {
    const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
    ident = {
      pub: publicKey.export({ type: "spki", format: "der" }).toString("base64"),
      priv: privateKey.export({ type: "pkcs8", format: "der" }).toString("base64"),
    };
    writeSecretJson(idFile, ident, passphrase);
  }
  const privKey = crypto.createPrivateKey({ key: Buffer.from(ident.priv, "base64"), format: "der", type: "pkcs8" });
  const id = sha(Buffer.from(ident.pub, "base64")).slice(0, 16);
  if (!ident.box || passphrase) { ident.box ??= newBoxKey(); writeSecretJson(idFile, ident, passphrase); } // new box key, or migrate plaintext → encrypted
  const sign = (obj) => crypto.sign(null, Buffer.from(canon(obj)), privKey).toString("base64");
  const verify = (obj, sig, pub) => {
    try {
      const k = crypto.createPublicKey({ key: Buffer.from(pub, "base64"), format: "der", type: "spki" });
      return crypto.verify(null, Buffer.from(canon(obj)), k, Buffer.from(sig, "base64"));
    } catch { return false; }
  };
  // `box` carries the X25519 private key: only seal.open() callers inside core/ use it.
  return { id, pub: ident.pub, box: ident.box, sign, verify };
}
