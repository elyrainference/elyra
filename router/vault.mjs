// Optional encryption at rest for secrets (node identity, wallet key, upstream API keys).
// Enable by starting with ELYRA_PASSPHRASE=… . scrypt (N=2^15) → AES-256-GCM. Plaintext files are accepted and
// re-written encrypted on the next start. Without the passphrase an encrypted file cannot be opened (fail loudly, never fall back).
import crypto from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const KEY_OPTS = { N: 1 << 15, r: 8, p: 1, maxmem: 128 * 1024 * 1024 };
const derive = (pass, salt) => crypto.scryptSync(pass, salt, 32, KEY_OPTS);

function encrypt(plain, pass) {
  const salt = crypto.randomBytes(16), iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", derive(pass, salt), iv);
  const ct = Buffer.concat([c.update(plain, "utf8"), c.final(), c.getAuthTag()]);
  return { enc: 1, salt: salt.toString("base64"), iv: iv.toString("base64"), ct: ct.toString("base64") };
}
function decrypt(box, pass) {
  if (!pass) throw new Error("this file is encrypted: start the node with ELYRA_PASSPHRASE set");
  const ct = Buffer.from(box.ct, "base64");
  const d = crypto.createDecipheriv("aes-256-gcm", derive(pass, Buffer.from(box.salt, "base64")), Buffer.from(box.iv, "base64"));
  d.setAuthTag(ct.subarray(ct.length - 16));
  try { return Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]).toString("utf8"); }
  catch { throw new Error("wrong ELYRA_PASSPHRASE (or the file was tampered with)"); }
}

export function readSecretJson(file, pass) {
  const j = JSON.parse(readFileSync(file, "utf8"));
  return j?.enc === 1 ? JSON.parse(decrypt(j, pass)) : j;
}
export function writeSecretJson(file, obj, pass) {
  writeFileSync(file, JSON.stringify(pass ? encrypt(JSON.stringify(obj), pass) : obj), { mode: 0o600 });
}
export const secretFileExists = existsSync;

/** single string fields (upstream API keys) inside state.json: "enc:<json box>" */
export const sealField = (s, pass) => (!s || !pass ? s : "enc:" + JSON.stringify(encrypt(s, pass)));
export const openField = (s, pass) => (typeof s === "string" && s.startsWith("enc:") ? decrypt(JSON.parse(s.slice(4)), pass) : s);
