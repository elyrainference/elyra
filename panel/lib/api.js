// Client for the local control API. Owns: base URL, JSON encoding, error extraction. Must not: toast or touch the DOM (callers use guard()).
import { API } from "./config.js";

export async function api(path, opts = {}) {
  const r = await fetch(API + path, { ...opts, headers: { "content-type": "application/json", ...opts.headers }, body: opts.body && typeof opts.body !== "string" ? JSON.stringify(opts.body) : opts.body });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error?.message ?? r.statusText);
  return j;
}
export const put = (p, body) => api(p, { method: "PUT", body });
export const post = (p, body = {}) => api(p, { method: "POST", body });
export const del = (p) => api(p, { method: "DELETE" });
