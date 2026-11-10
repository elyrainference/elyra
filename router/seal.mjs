// Sealed envelopes for /p2p/infer: X25519 ECDH (ephemeral sender key) → HKDF-SHA256 → AES-256-GCM.
// Prompts and completions never cross the network in clear text, and only the holder of the
// recipient's X25519 private key (the node, or an enclave-bound key later) can read them.
// This is confidentiality against the network and relays. It does NOT hide prompts from the provider operator; that needs a TEE.
import crypto from "node:crypto";

const b64 = (b) => Buffer.from(b).toString("base64");
const unb64 = (s) => Buffer.from(s, "base64");
const pubObj = (b64der) => crypto.createPublicKey({ key: unb64(b64der), format: "der", type: "spki" });

export function newBoxKey() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("x25519");
  return {
    pub: publicKey.export({ type: "spki", format: "der" }).toString("base64"),
    priv: privateKey.export({ type: "pkcs8", format: "der" }).toString("base64"),
  };
}

function deriveKey(privObj, pubB64, epkB64) {
  const shared = crypto.diffieHellman({ privateKey: privObj, publicKey: pubObj(pubB64) });
  return Buffer.from(crypto.hkdfSync("sha256", shared, Buffer.alloc(0), "elyra-box-v1|" + epkB64, 32));
}

const encrypt = (key, data, aad) => {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", key, iv);
  c.setAAD(Buffer.from(aad));
  const ct = Buffer.concat([c.update(data), c.final(), c.getAuthTag()]);
  return b64(Buffer.concat([iv, ct]));
};
const decrypt = (key, blob, aad) => {
  const raw = unb64(blob);
  const d = crypto.createDecipheriv("aes-256-gcm", key, raw.subarray(0, 12));
  d.setAAD(Buffer.from(aad));
  d.setAuthTag(raw.subarray(raw.length - 16));
  return Buffer.concat([d.update(raw.subarray(12, raw.length - 16)), d.final()]);
};

/** Sender side: returns { envelope, session } where session encrypts/decrypts the response. */
export function sealTo(recipientPubB64, obj) {
  const eph = crypto.generateKeyPairSync("x25519");
  const epk = eph.publicKey.export({ type: "spki", format: "der" }).toString("base64");
  const key = deriveKey(eph.privateKey, recipientPubB64, epk);
  return {
    envelope: { v: 1, epk, ct: encrypt(key, Buffer.from(JSON.stringify(obj)), "elyra-req") },
    session: session(key),
  };
}

/** Recipient side: opens an envelope with the node's box private key, returns { obj, session }. */
export function open(boxPrivB64, boxPubB64, envelope) {
  if (envelope?.v !== 1 || !envelope.epk || !envelope.ct) throw new Error("bad envelope");
  const priv = crypto.createPrivateKey({ key: unb64(boxPrivB64), format: "der", type: "pkcs8" });
  const key = deriveKey(priv, envelope.epk, envelope.epk);
  void boxPubB64;
  return { obj: JSON.parse(decrypt(key, envelope.ct, "elyra-req").toString("utf8")), session: session(key) };
}

const session = (key) => ({
  seal: (data) => encrypt(key, Buffer.from(typeof data === "string" ? data : JSON.stringify(data)), "elyra-res"),
  open: (blob) => decrypt(key, blob, "elyra-res").toString("utf8"),
});
