// On-chain actions for the "fund from your wallet" flow. Pure ethers, no DOM, no AppKit: tested on a local chain (router/test/fund.test.mjs).
// The connected wallet pays; the NODE address is credited (escrow.depositFor), because the node key is the one that signs vouchers.
import { Contract, formatUnits, getAddress, isAddress, parseUnits } from "ethers";

const ERC20 = [
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
  "function mint(address,uint256)",
  "function decimals() view returns (uint8)",
];
const ESCROW = ["function depositFor(address consumer, uint256 amount)", "function deposits(address) view returns (uint256)"];

export const toUnits = (usd, decimals = 6) => {
  const s = String(usd).trim();
  if (!new RegExp(`^\\d+(\\.\\d{1,${decimals}})?$`).test(s)) throw new Error(`Enter an amount like 10 or 2.5 (at most ${decimals} decimals)`);
  const u = parseUnits(s, decimals);
  if (u <= 0n) throw new Error("Amount must be greater than zero");
  return u;
};

function need(cfg) {
  for (const k of ["token", "escrow", "node"]) if (!isAddress(cfg[k] ?? "")) throw new Error(`Node is missing the ${k} address`);
  return { token: getAddress(cfg.token), escrow: getAddress(cfg.escrow), node: getAddress(cfg.node) };
}

export async function balances(signer, cfg) {
  const { token, escrow, node } = need(cfg);
  const me = await signer.getAddress();
  const t = new Contract(token, ERC20, signer), e = new Contract(escrow, ESCROW, signer);
  const [bal, nodeDeposit] = await Promise.all([t.balanceOf(me), e.deposits(node)]);
  return { address: me, units: bal, usd: Number(formatUnits(bal, cfg.decimals ?? 6)), nodeDepositUsd: Number(formatUnits(nodeDeposit, cfg.decimals ?? 6)) };
}

/** approve (only if the allowance is too low), then depositFor(node). onStep gets progress; returns every tx hash. */
export async function deposit(signer, cfg, usd, onStep = () => {}) {
  const { token, escrow, node } = need(cfg);
  const dec = cfg.decimals ?? 6;
  const units = toUnits(usd, dec);
  const me = await signer.getAddress();
  const t = new Contract(token, ERC20, signer), e = new Contract(escrow, ESCROW, signer);
  const [bal, cur] = await Promise.all([t.balanceOf(me), e.deposits(node)]);
  if (bal < units) throw new Error("Your wallet does not hold enough of the token");
  const capUsd = Number(cfg.maxDepositUsd) > 0 ? Number(cfg.maxDepositUsd) : 20;
  const capUnits = toUnits(String(capUsd), dec);
  if (cur + units > capUnits) {
    const curUsd = Number(formatUnits(cur, dec)), roomUsd = Math.max(0, capUsd - curUsd);
    throw new Error(`Deposit exceeds the $${capUsd} per-wallet cap (this node already has $${curUsd.toFixed(2)} in escrow; at most $${roomUsd.toFixed(2)} can be added)`);
  }
  const hashes = [];
  if ((await t.allowance(me, escrow)) < units) {
    onStep("approve");
    const a = await t.approve(escrow, units); hashes.push(a.hash); await a.wait();
  }
  onStep("deposit");
  const d = await e.depositFor(node, units); hashes.push(d.hash); await d.wait();
  return { hashes, units };
}

/** testnet only: the mock token has an open mint */
export async function mintTest(signer, cfg, usd) {
  const { token } = need({ ...cfg, escrow: cfg.escrow, node: cfg.node });
  const units = toUnits(usd, cfg.decimals ?? 6);
  const t = new Contract(token, ERC20, signer);
  const tx = await t.mint(await signer.getAddress(), units); await tx.wait();
  return { hash: tx.hash, units };
}
