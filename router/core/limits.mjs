// Protocol constants and request-size bounds shared by consumer and provider. Constants and pure helpers only; no state.
import { readFileSync } from "node:fs";
import { approxTokens } from "../policy.mjs";

export const VERSION = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version;
/** peer protocol major version: nodes with a different value refuse each other (see docs/PROTOCOL.md) */
export const PROTOCOL = 3;
export const DAY = 86400_000;
/** hard cap on output tokens for a peer request: bounds the worst-case cost of one call so both sides can reason about risk */
export const MAX_OUT = 8192;
/** default per-wallet deposit cap in USDG (app-side limit while the escrow contract is unaudited) */
export const DEFAULT_MAX_DEPOSIT_USD = 20;
export const MAX_DEPOSIT_CAP_USD = 10000;
/** The ONE per-wallet deposit cap: the owner's setting (state.provide.maxDepositUsd, 0 < n <= MAX_DEPOSIT_CAP_USD) or the default. Real networks additionally have the ceiling in chain.mjs (depositCapUsd). */
export const depositCapOf = (provide) => (Number(provide?.maxDepositUsd) > 0 ? Number(provide.maxDepositUsd) : DEFAULT_MAX_DEPOSIT_USD);

/** output cap for a request body: the caller's max_tokens, never above MAX_OUT */
export const outCap = (body) => Math.min(Number(body.max_tokens) > 0 ? Number(body.max_tokens) : MAX_OUT, MAX_OUT);
/** prompt size estimate (chars/4) used for worst-case pricing and receipt sanity checks */
export const promptEstimate = (body) => approxTokens(JSON.stringify(body.messages ?? ""));

export const DEMO_UPSTREAM = { id: "demo-engine", name: "Demo engine", kind: "demo", baseUrl: "", apiKey: "", price: 0, models: ["demo-echo-1"], builtin: true };
