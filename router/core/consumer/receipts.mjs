// Consumer-side receipt verification. A receipt records USAGE and is evidence for a voucher; nothing a peer sends is
// trusted. Every field is validated strictly and the money amount is DERIVED locally, never trusted:
// missing/NaN/huge fields must fail closed. Must not sign vouchers or touch state (see wallet.mjs).
import { cost, approxTokens } from "../../policy.mjs";
import { inc, log } from "../../obs.mjs";

const isNat = (x) => Number.isSafeInteger(x) && x >= 0;

export function createReceiptVerifier({ identity, chain }) {
  const seenReceipts = new Set(); // receipt ids already accepted (a provider cannot bill the same receipt twice)

  /**
   * `req` = what this node asked for: { peer, nonce, maxPrice, promptEst, maxTokens, chainOn }.
   * Returns the receipt when valid, throws (and counts the rejection) otherwise.
   */
  const verifyInner = (receipt, text, req) => {
    const { peer, nonce, maxPrice, promptEst, maxTokens, chainOn } = req;
    const { sig, ...rest } = receipt ?? {};
    if (!sig || !identity.verify(rest, sig, peer.pubkey)) throw new Error("receipt signature invalid");
    if (rest.consumer !== identity.id || rest.provider !== peer.id) throw new Error("receipt parties mismatch");
    if (rest.nonce !== nonce) throw new Error("receipt not bound to this request");
    if (typeof rest.id !== "string" || seenReceipts.has(rest.id)) throw new Error("receipt replayed");
    if (!isNat(rest.promptTokens) || !isNat(rest.completionTokens)) throw new Error("receipt token counts malformed");
    if (!Number.isFinite(rest.price) || rest.price < 0 || rest.price > maxPrice) throw new Error("receipt price above quote");
    if (rest.promptTokens > promptEst * 3 + 64) throw new Error("receipt prompt token count inflated");
    // anti-inflation: output is capped by max_tokens and may not exceed what we actually received (estimate is chars/4, tokenizers differ, so allow 3x + 32)
    if (rest.completionTokens > Math.min(approxTokens(text) * 3 + 32, maxTokens * 2 + 64)) throw new Error("receipt token count inflated vs received text");
    const expected = cost(rest.price, rest.promptTokens, rest.completionTokens);
    if (!Number.isFinite(expected) || !Number.isFinite(rest.amount) || Math.abs(rest.amount - expected) > 1e-9) throw new Error("receipt amount mismatch");
    if (chainOn) {
      if (typeof rest.amountUnits !== "string" || !/^\d{1,30}$/.test(rest.amountUnits) || rest.providerWallet !== peer.wallet) throw new Error("receipt missing on-chain amount");
      if (BigInt(rest.amountUnits) !== chain.usdToUnits(expected)) throw new Error("receipt token amount differs from the exact dollar amount");
    }
    seenReceipts.add(rest.id);
    if (seenReceipts.size > 20000) seenReceipts.delete(seenReceipts.values().next().value);
    return receipt;
  };

  return function verifyReceipt(receipt, text, req) {
    try { return verifyInner(receipt, text, req); }
    catch (e) { inc("elyra_receipts_rejected_total", { reason: e.message.replace(/[^a-z ]/gi, "").slice(0, 40) }); log("warn", "receipt rejected", { peer: req.peer.name, reason: e.message }); throw e; }
  };
}
