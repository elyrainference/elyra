// Browser entry for pay-per-use sessions: a throwaway key held by the page (ethers only, no wallet-connect code). It signs the proof that binds the
// session to a gateway node, signs vouchers, and (with a little gas ETH on the session address) moves the session's own escrow deposit back out.
// Bundled into panel/try/session.js by tools/wallet/build-session.mjs; loaded only when a visitor creates a session.
import { Contract, JsonRpcProvider, Wallet } from "ethers";

const TYPES = { Voucher: [{ name: "consumer", type: "address" }, { name: "provider", type: "address" }, { name: "cumulative", type: "uint256" }] };
const ESCROW = ["function claimed(address,address) view returns (uint256)", "function deposits(address) view returns (uint256)", "function withdrawAt(address) view returns (uint256)", "function withdrawExpires(address) view returns (uint256)", "function requestWithdraw()", "function cancelWithdraw()", "function withdraw(uint256)"];
const ERC20 = ["function balanceOf(address) view returns (uint256)", "function transfer(address,uint256) returns (bool)"];

export const newKey = () => Wallet.createRandom().privateKey;
export const addressOf = (key) => new Wallet(key).address;
export const bindingProof = (key, nodeId) => { const w = new Wallet(key); return w.signMessage(`elyra-wallet-binding:${nodeId}:${w.address.toLowerCase()}`); };
export const signVoucher = (key, cfg, provider, cumulative) => {
  const w = new Wallet(key);
  return w.signTypedData({ name: "ElyraEscrow", version: "1", chainId: cfg.chainId, verifyingContract: cfg.escrow }, TYPES, { consumer: w.address, provider, cumulative: BigInt(cumulative) });
};

const conn = (key, cfg) => new Wallet(key, new JsonRpcProvider(cfg.rpcUrl, cfg.chainId, { staticNetwork: true, batchMaxCount: 1 }));
const send = async (p) => { const tx = await p; await tx.wait(); return tx.hash; };

/** what the session holds, from chain data */
export async function position(key, cfg, cum = {}) {
  const w = conn(key, cfg), e = new Contract(cfg.escrow, ESCROW, w), t = new Contract(cfg.token, ERC20, w);
  const [deposit, at, exp, tok, eth, blk] = await Promise.all([e.deposits(w.address), e.withdrawAt(w.address), e.withdrawExpires(w.address), t.balanceOf(w.address), w.provider.getBalance(w.address), w.provider.getBlock("latest")]);
  // `now` is the chain's clock (what the contract compares against), not this computer's
  // what sellers may still collect: every voucher this session signed, minus what the seller already redeemed on chain. A withdrawal must leave that in the escrow.
  let owed = 0n;
  for (const [provider, v] of Object.entries(cum)) { const c = await e.claimed(w.address, provider); if (BigInt(v.cumulative) > c) owed += BigInt(v.cumulative) - c; }
  return { owed: owed.toString(), deposit: deposit.toString(), withdrawAt: Number(at), withdrawExpires: Number(exp), token: tok.toString(), eth: eth.toString(), now: Number(blk.timestamp) };
}
export const requestWithdraw = (key, cfg) => send(new Contract(cfg.escrow, ESCROW, conn(key, cfg)).requestWithdraw());
export const cancelWithdraw = (key, cfg) => send(new Contract(cfg.escrow, ESCROW, conn(key, cfg)).cancelWithdraw());
export const withdraw = (key, cfg, units) => send(new Contract(cfg.escrow, ESCROW, conn(key, cfg)).withdraw(BigInt(units)));
export const sendToken = (key, cfg, to, units) => send(new Contract(cfg.token, ERC20, conn(key, cfg)).transfer(to, BigInt(units)));
