// Script of /admin/login (loaded as /admin/login.js; same origin, no inline script): "Sign in with wallet" for an allow-listed admin address.
// Wallets are found through EIP-6963 (or window.ethereum). The signature (see auth.js) moves no funds; the server decides the role.
(() => {
  const $ = (s) => document.querySelector(s);
  const box = $("#wallet"), btn = $("#wbtn"), list = $("#wlist"), err = $("#err"); if (!box || !btn) return;
  const found = new Map();
  addEventListener("eip6963:announceProvider", (e) => { const d = e.detail; if (d?.provider && d?.info?.uuid) found.set(d.info.uuid, d); });
  dispatchEvent(new Event("eip6963:requestProvider"));
  const show = (m) => { err.textContent = m || ""; err.hidden = !m; };
  const wallets = () => { const a = [...found.values()]; if (!a.length && window.ethereum) a.push({ provider: window.ethereum, info: { name: "Browser wallet" } }); return a; };
  let busy = false;

  async function go(w, button) {
    if (busy) return; busy = true; show("");
    const label = button.textContent; button.textContent = "Check your wallet…"; button.disabled = true;
    try {
      const { signInWithWallet, signOut } = await import("/admin/auth.js");
      const s = await signInWithWallet({ provider: w.provider });
      if (s.role === "admin") return location.assign("/app/");
      await signOut(); // not on the allow-list: a visitor cookie is no use on this page
      show("This wallet is not an admin of this node. Nothing was changed.");
    } catch (e) { show(e?.message || "Sign-in failed."); }
    finally { busy = false; button.textContent = label; button.disabled = false; }
  }

  function draw() {
    const a = wallets(); list.textContent = ""; box.hidden = false;
    if (!a.length) { btn.disabled = true; btn.textContent = "No wallet found"; return; }
    if (a.length === 1) { btn.disabled = false; btn.onclick = () => go(a[0], btn); return; }
    btn.hidden = true;
    for (const w of a) { const b = document.createElement("button"); b.type = "button"; b.className = "alt"; b.textContent = "Sign in with " + String(w.info?.name || "wallet").slice(0, 40); b.onclick = () => go(w, b); list.append(b); }
  }
  setTimeout(draw, 250);
})();
