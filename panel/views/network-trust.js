// TEE trust card: the buyer's pinned list of Elyra container-image digests. Only a Google-signed attestation whose digest is in this list
// makes a seller TEE · VERIFIED; a seller's own claim never does. Must not: loosen or pre-fill the list.
import { api, put } from "../lib/api.js";
import { $, esc } from "../lib/dom.js";
import { field } from "../components/form.js";
import { guard, toast } from "../components/toast.js";

export async function loadTrust(view) {
  const t = await api("/api/trust");
  $("#nw-trustn").textContent = t.allowedImages.length + " pinned";
  $("#nw-trust").innerHTML = `<p class="help" style="margin:0 0 14px">A seller counts as <b>TEE · VERIFIED</b> only if Google Cloud Attestation signs a token whose container image digest is in <b>your</b> list, bound to the seller's keys, on confidential hardware (${esc(t.allowedHw.join(" / "))}).</p>
    <div class="form">${field("nw-trust-in", "Pinned image digests", `<textarea class="txt mono" id="nw-trust-in" rows="3" placeholder="sha256:…">${esc(t.allowedImages.join("\n"))}</textarea>`, "Paste the digest of the official Elyra image, one per line.")}
    <div><button type="button" class="btn primary" id="nw-trust-save">Save trust list</button></div></div>`;
  $("#nw-trust-save").onclick = guard(async () => {
    await put("/api/trust", { allowedImages: $("#nw-trust-in").value.split(/\s+/).filter(Boolean) });
    toast("Trust list saved", "ok");
    view.key = "";
    await loadTrust(view);
    await view.tick();
  });
}
