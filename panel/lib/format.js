// Number/time/address formatters. Pure: no DOM, no I/O.
export const fmt = (n) => Number(n ?? 0).toLocaleString("en-US");
export const usd = (n) => (!n ? "$0.00" : n < 0.01 ? "$" + n.toFixed(6) : n < 100 ? "$" + n.toFixed(4) : "$" + n.toFixed(2));
export const price = (n) => "$" + (n >= 1 ? n.toFixed(2) : n.toFixed(3).replace(/0$/, ""));
export const ago = (t) => {
  const s = Math.max(0, (Date.now() - t) / 1000);
  return s < 60 ? Math.floor(s) + "s ago" : s < 3600 ? Math.floor(s / 60) + "m ago" : s < 86400 ? Math.floor(s / 3600) + "h ago" : Math.floor(s / 86400) + "d ago";
};
export const kfmt = (n) => (n >= 1e6 ? (n / 1e6).toFixed(1) + "M" : n >= 1e3 ? (n / 1e3).toFixed(1) + "K" : String(Math.round(n)));
// 0x1234abcd… with an optional tail (tail 0 = head only)
export const shortAddr = (a, head = 10, tail = 6) => a.slice(0, head) + "…" + (tail ? a.slice(-tail) : "");
// "TOP RATED" -> "Top rated", "TEE" stays: display label for keys that are stored in capitals
export const label = (k) => (k === "TEE" ? k : k.charAt(0) + k.slice(1).toLowerCase());
