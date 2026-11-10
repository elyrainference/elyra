// Canonical JSON (the bytes that get signed), sha-256 hex and random ids. Pure helpers; no node state.
import crypto from "node:crypto";

export const canon = (v) =>
  v === null || typeof v !== "object"
    ? JSON.stringify(v)
    : Array.isArray(v)
      ? "[" + v.map(canon).join(",") + "]"
      : "{" + Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + canon(v[k])).join(",") + "}";

export const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");
export const rid = (p) => p + "_" + crypto.randomBytes(5).toString("hex");
