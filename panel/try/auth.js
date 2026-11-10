// Wallet sign-in helper (Sign-In with Ethereum, EIP-4361) for the public page and the login page. Same-origin only, no dependency, no
// inline script. It asks the wallet to sign one message (personal_sign): no transaction, no gas, no funds move. The server builds the message,
// checks the signature and sets the session cookie (HttpOnly: this code never sees it). Works with any EIP-1193 provider (MetaMask, Rabby,
// WalletConnect/AppKit providers): pass the provider object, or just its `request` function.
// All server text is returned as Error.message / JSON values; the callers put it into the page with textContent.
const ADDR = /^0x[0-9a-fA-F]{40}$/;
const hex = (s) => "0x" + [...new TextEncoder().encode(s)].map((b) => b.toString(16).padStart(2, "0")).join("");
const rejected = (e) => e && (e.code === 4001 || e.code === "ACTION_REJECTED" || /reject|denied|declin|cancel/i.test(e.message || ""));

async function call(path, init) {
  let r;
  try { r = await fetch(path, { credentials: "same-origin", cache: "no-store", ...init }); }
  catch { throw new Error("Could not reach the node. Check your connection."); }
  let j = null; try { j = await r.json(); } catch { /* not JSON */ }
  if (!r.ok) {
    const e = new Error(j?.error?.message || `Sign-in failed (${r.status}).`); e.status = r.status;
    const ra = Number(r.headers.get("retry-after")); if (ra) e.retryAfter = ra;
    throw e;
  }
  return j;
}

/** { signedIn: false } or { signedIn: true, role: "admin"|"user", address?, expiresAt, username?, needsName? } (username/needsName only when the node runs the gateway). Never throws. */
export async function getSession() {
  try { return await call("/auth/session"); } catch { return { signedIn: false }; }
}

/** Clears the session cookie. Never throws. */
export async function signOut() {
  try { await call("/auth/logout", { method: "POST" }); } catch { /* already signed out */ }
}

/** Is this username valid and free? { name, valid, available, reason }. Throws when the gateway is off (404) or the client is rate limited. */
export const checkUsername = (name) => call("/auth/username?name=" + encodeURIComponent(name));

/** Set the username of the signed-in wallet, once (no renaming). Resolves the profile; throws with the server's reason (name_taken, name_set, bad_name). */
export const setUsername = (username) => call("/auth/username", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ username }) });

/**
 * Sign in with a wallet. `provider`: EIP-1193 provider or its request function. `address`: the connected account (asked from the wallet when omitted).
 * Resolves { address, role: "admin"|"user", expiresAt, username?, needsName? }. Throws an Error with a readable message (code 4001 when the user rejected).
 */
export async function signInWithWallet({ provider, address } = {}) {
  const request = typeof provider === "function" ? provider : provider && typeof provider.request === "function" ? provider.request.bind(provider) : null;
  if (!request) throw new Error("No wallet found. Install a browser wallet or open this page in your wallet's browser.");
  let account = address;
  try {
    if (!account) { const a = await request({ method: "eth_requestAccounts" }); account = Array.isArray(a) ? a[0] : null; }
    if (typeof account !== "string" || !ADDR.test(account)) throw new Error("The wallet did not share an account.");
    const { message } = await call("/auth/nonce?address=" + account);
    const signature = await request({ method: "personal_sign", params: [hex(message), account] });
    return await call("/auth/verify", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ address: account, message, signature }) });
  } catch (e) {
    if (rejected(e)) { const r = new Error("Cancelled in your wallet."); r.code = 4001; throw r; }
    throw e instanceof Error ? e : new Error(String(e?.message || e).slice(0, 180));
  }
}
