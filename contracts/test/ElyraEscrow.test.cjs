const { expect } = require("chai");
const { ethers, network } = require("hardhat");
const fs = require("fs");
const path = require("path");

const USD = (n) => ethers.parseUnits(String(n), 6); // USDG has 6 decimals
const TYPES = { Voucher: [
  { name: "consumer", type: "address" },
  { name: "provider", type: "address" },
  { name: "cumulative", type: "uint256" },
] };

describe("ElyraEscrow (ERC-20)", () => {
  let escrow, usdg, consumer, providerA, providerB, other, chainId;
  const domain = (c = chainId, a = escrow) => ({ name: "ElyraEscrow", version: "1", chainId: c, verifyingContract: a.target ?? a });
  const sign = (signer, prov, cum, dom = domain()) =>
    signer.signTypedData(dom, TYPES, { consumer: signer.address, provider: prov.address, cumulative: cum });
  const increase = async (s) => { await network.provider.send("evm_increaseTime", [s]); await network.provider.send("evm_mine"); };
  const bal = (t, a) => t.balanceOf(a.address ?? a.target ?? a);
  const deploy = async (name, ...args) => { const c = await (await ethers.getContractFactory(name)).deploy(...args); await c.waitForDeployment(); return c; };
  const fund = async (token, esc, who, amount) => {
    await token.mint(who.address, amount);
    await token.connect(who).approve(esc.target, amount);
  };

  beforeEach(async () => {
    [consumer, providerA, providerB, other] = await ethers.getSigners();
    usdg = await deploy("MockUSDG");
    escrow = await deploy("ElyraEscrow", usdg.target);
    chainId = (await ethers.provider.getNetwork()).chainId;
    await fund(usdg, escrow, consumer, USD(1));
    await escrow.connect(consumer).deposit(USD(1));
  });

  it("constructor rejects zero token and stores the token", async () => {
    expect(await escrow.token()).to.equal(usdg.target);
    await expect((await ethers.getContractFactory("ElyraEscrow")).deploy(ethers.ZeroAddress)).to.be.reverted;
  });

  it("committed artifacts deploy and work", async () => {
    const read = (n) => JSON.parse(fs.readFileSync(path.join(__dirname, "..", "artifacts", n + ".json"), "utf8"));
    const tokArt = read("MockUSDG"), escArt = read("ElyraEscrow");
    expect(escArt.compiler).to.match(/^solc 0\.8\./);
    expect(tokArt.compiler).to.equal(escArt.compiler);
    const t = await new ethers.ContractFactory(tokArt.abi, tokArt.bytecode, consumer).deploy();
    await t.waitForDeployment();
    const c = await new ethers.ContractFactory(escArt.abi, escArt.bytecode, consumer).deploy(t.target);
    await c.waitForDeployment();
    await fund(t, c, consumer, 5n);
    await c.connect(consumer).deposit(5n);
    const sig = await sign(consumer, providerA, 5n, domain(chainId, c));
    await c.connect(providerA).redeem(consumer.address, 5n, sig);
    expect(await t.balanceOf(providerA.address)).to.equal(5n);
  });

  it("voucherDigest matches EIP-712 hash", async () => {
    const d = await escrow.voucherDigest(consumer.address, providerA.address, 7n);
    expect(d).to.equal(ethers.TypedDataEncoder.hash(domain(), TYPES, { consumer: consumer.address, provider: providerA.address, cumulative: 7n }));
  });

  it("deposit pulls tokens and credits the sender; zero reverts; plain ETH is refused", async () => {
    expect(await escrow.deposits(consumer.address)).to.equal(USD(1));
    expect(await bal(usdg, escrow)).to.equal(USD(1));
    await expect(escrow.connect(consumer).deposit(0n)).to.be.reverted;
    await expect(consumer.sendTransaction({ to: escrow.target, value: 1n })).to.be.reverted;
  });

  it("deposit without approval reverts and changes nothing", async () => {
    await usdg.mint(other.address, USD(5));
    await expect(escrow.connect(other).deposit(USD(5))).to.be.reverted;
    expect(await escrow.deposits(other.address)).to.equal(0n);
    expect(await bal(usdg, escrow)).to.equal(USD(1));
  });

  it("depositFor credits the beneficiary, not the funder", async () => {
    await fund(usdg, escrow, other, USD(2));
    await expect(escrow.connect(other).depositFor(consumer.address, USD(2)))
      .to.emit(escrow, "Deposited").withArgs(consumer.address, other.address, USD(2));
    expect(await escrow.deposits(consumer.address)).to.equal(USD(3));
    expect(await escrow.deposits(other.address)).to.equal(0n);
    expect(await bal(usdg, other)).to.equal(0n);
    await expect(escrow.connect(other).depositFor(ethers.ZeroAddress, 1n)).to.be.reverted;
    await expect(escrow.connect(other).depositFor(consumer.address, 0n)).to.be.reverted;
  });

  it("fee-on-transfer token is rejected with TransferMismatch", async () => {
    const ft = await deploy("FeeToken");
    const e = await deploy("ElyraEscrow", ft.target);
    await fund(ft, e, consumer, USD(10));
    await expect(e.connect(consumer).deposit(USD(10))).to.be.revertedWithCustomError(e, "TransferMismatch");
    await expect(e.connect(consumer).depositFor(other.address, USD(10))).to.be.revertedWithCustomError(e, "TransferMismatch");
    expect(await e.deposits(consumer.address)).to.equal(0n);
    expect(await bal(ft, consumer)).to.equal(USD(10));
  });

  it("token returning no value (non-standard) works for deposit, redeem, withdraw", async () => {
    const nt = await deploy("NoReturnToken", 18);
    const e = await deploy("ElyraEscrow", nt.target);
    await nt.mint(consumer.address, 1000n);
    await nt.connect(consumer).approve(e.target, 1000n);
    await e.connect(consumer).deposit(1000n);
    expect(await nt.balanceOf(e.target)).to.equal(1000n);
    const sig = await sign(consumer, providerA, 400n, domain(chainId, e));
    await e.connect(providerA).redeem(consumer.address, 400n, sig);
    expect(await nt.balanceOf(providerA.address)).to.equal(400n);
    await e.connect(consumer).requestWithdraw();
    await increase(24 * 3600 + 1);
    await e.connect(consumer).withdraw(600n);
    expect(await nt.balanceOf(consumer.address)).to.equal(600n);
    expect(await e.deposits(consumer.address)).to.equal(0n);
  });

  it("token decimals are irrelevant: amounts are raw base units", async () => {
    for (const d of [0, 6, 18]) {
      const nt = await deploy("NoReturnToken", d);
      const e = await deploy("ElyraEscrow", nt.target);
      await nt.mint(consumer.address, 77n);
      await nt.connect(consumer).approve(e.target, 77n);
      await e.connect(consumer).deposit(77n);
      const sig = await sign(consumer, providerA, 33n, domain(chainId, e));
      await e.connect(providerA).redeem(consumer.address, 33n, sig);
      expect(await nt.balanceOf(providerA.address)).to.equal(33n);
      expect(await e.deposits(consumer.address)).to.equal(44n);
    }
  });

  it("token that reverts on transfer makes redeem and withdraw revert atomically", async () => {
    const bt = await deploy("BlockableToken");
    const e = await deploy("ElyraEscrow", bt.target);
    await fund(bt, e, consumer, USD(1));
    await e.connect(consumer).deposit(USD(1));
    const sig = await sign(consumer, providerA, USD(0.4), domain(chainId, e));
    for (const returnFalse of [false, true]) {
      await bt.setBlocked(true, returnFalse);
      await expect(e.connect(providerA).redeem(consumer.address, USD(0.4), sig)).to.be.reverted;
      expect(await e.deposits(consumer.address)).to.equal(USD(1));
      expect(await e.claimed(consumer.address, providerA.address)).to.equal(0n);
      expect(await bal(bt, e)).to.equal(USD(1));
    }
    await e.connect(consumer).requestWithdraw();
    await increase(24 * 3600 + 1);
    await expect(e.connect(consumer).withdraw(USD(1))).to.be.reverted;
    expect(await e.deposits(consumer.address)).to.equal(USD(1));
    expect(await e.withdrawAt(consumer.address)).to.not.equal(0n);
    // once the token allows transfers again, the funds are recoverable
    await bt.setBlocked(false, false);
    await e.connect(providerA).redeem(consumer.address, USD(0.4), sig);
    expect(await bt.balanceOf(providerA.address)).to.equal(USD(0.4));
    await e.connect(consumer).withdraw(USD(0.6));
    expect(await bt.balanceOf(consumer.address)).to.equal(USD(0.6));
  });

  it("redeem pays exactly the delta; same voucher cannot be replayed", async () => {
    const sig = await sign(consumer, providerA, USD("0.3"));
    await expect(escrow.connect(providerA).redeem(consumer.address, USD("0.3"), sig)).to.changeTokenBalances(
      usdg, [escrow, providerA], [-USD("0.3"), USD("0.3")]);
    expect(await escrow.deposits(consumer.address)).to.equal(USD("0.7"));
    expect(await escrow.claimed(consumer.address, providerA.address)).to.equal(USD("0.3"));
    await expect(escrow.connect(providerA).redeem(consumer.address, USD("0.3"), sig)).to.be.reverted;
    expect(await escrow.deposits(consumer.address)).to.equal(USD("0.7"));
  });

  it("higher cumulative voucher pays only the difference; lower one reverts", async () => {
    const s1 = await sign(consumer, providerA, USD("0.2"));
    const s2 = await sign(consumer, providerA, USD("0.5"));
    await escrow.connect(providerA).redeem(consumer.address, USD("0.2"), s1);
    await expect(escrow.connect(providerA).redeem(consumer.address, USD("0.5"), s2)).to.changeTokenBalance(usdg, providerA, USD("0.3"));
    await expect(escrow.connect(providerA).redeem(consumer.address, USD("0.2"), s1)).to.be.reverted;
    expect(await escrow.claimed(consumer.address, providerA.address)).to.equal(USD("0.5"));
  });

  it("voucher for provider A cannot be redeemed by provider B", async () => {
    const sig = await sign(consumer, providerA, USD("0.1"));
    await expect(escrow.connect(providerB).redeem(consumer.address, USD("0.1"), sig)).to.be.reverted;
    expect(await escrow.deposits(consumer.address)).to.equal(USD(1));
  });

  it("rejects wrong signer, forged, tampered amount, other chain id, other contract", async () => {
    const wrongSigner = await other.signTypedData(domain(), TYPES, { consumer: consumer.address, provider: providerA.address, cumulative: 100n });
    await expect(escrow.connect(providerA).redeem(consumer.address, 100n, wrongSigner)).to.be.reverted;

    const good = await sign(consumer, providerA, 100n);
    await expect(escrow.connect(providerA).redeem(consumer.address, 101n, good)).to.be.reverted;

    const garbage = "0x" + "11".repeat(65);
    await expect(escrow.connect(providerA).redeem(consumer.address, 100n, garbage)).to.be.reverted;
    await expect(escrow.connect(providerA).redeem(consumer.address, 100n, "0x1234")).to.be.reverted;

    const otherChain = await sign(consumer, providerA, 100n, domain(chainId + 1n));
    await expect(escrow.connect(providerA).redeem(consumer.address, 100n, otherChain)).to.be.reverted;

    const otherContract = await sign(consumer, providerA, 100n, domain(chainId, other.address));
    await expect(escrow.connect(providerA).redeem(consumer.address, 100n, otherContract)).to.be.reverted;

    // sanity: the good one works
    await escrow.connect(providerA).redeem(consumer.address, 100n, good);
  });

  it("rejects malleable high-s and bad v", async () => {
    const sig = ethers.Signature.from(await sign(consumer, providerA, 100n));
    const N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141n;
    const highS = ethers.toBeHex(N - BigInt(sig.s), 32);
    const flippedV = sig.v === 27 ? 28 : 27;
    const malleable = ethers.concat([sig.r, highS, ethers.toBeHex(flippedV, 1)]);
    await expect(escrow.connect(providerA).redeem(consumer.address, 100n, malleable)).to.be.reverted;
    const badV = ethers.concat([sig.r, sig.s, "0x00"]);
    await expect(escrow.connect(providerA).redeem(consumer.address, 100n, badV)).to.be.reverted;
    const badV2 = ethers.concat([sig.r, sig.s, "0x1d"]);
    await expect(escrow.connect(providerA).redeem(consumer.address, 100n, badV2)).to.be.reverted;
  });

  it("underfunded deposit pays partial; later top-up lets provider claim the rest", async () => {
    const sig = await sign(consumer, providerA, USD("1.5"));
    await expect(escrow.connect(providerA).redeem(consumer.address, USD("1.5"), sig)).to.changeTokenBalance(usdg, providerA, USD(1));
    expect(await escrow.deposits(consumer.address)).to.equal(0n);
    expect(await escrow.claimed(consumer.address, providerA.address)).to.equal(USD(1));
    // nothing left: reverts, claimed unchanged
    await expect(escrow.connect(providerA).redeem(consumer.address, USD("1.5"), sig)).to.be.reverted;
    await fund(usdg, escrow, consumer, USD(2));
    await escrow.connect(consumer).deposit(USD(2));
    await expect(escrow.connect(providerA).redeem(consumer.address, USD("1.5"), sig)).to.changeTokenBalance(usdg, providerA, USD("0.5"));
    expect(await escrow.claimed(consumer.address, providerA.address)).to.equal(USD("1.5"));
    expect(await escrow.deposits(consumer.address)).to.equal(USD("1.5"));
    await expect(escrow.connect(providerA).redeem(consumer.address, USD("1.5"), sig)).to.be.reverted;
  });

  it("withdraw: blocked without request and before delay, allowed after; provider can redeem during delay", async () => {
    await expect(escrow.connect(consumer).withdraw(1n)).to.be.reverted;
    await escrow.connect(consumer).requestWithdraw();
    await expect(escrow.connect(consumer).withdraw(1n)).to.be.reverted;
    await increase(3600);
    await expect(escrow.connect(consumer).withdraw(1n)).to.be.reverted;

    const sig = await sign(consumer, providerA, USD("0.4"));
    await expect(escrow.connect(providerA).redeem(consumer.address, USD("0.4"), sig)).to.changeTokenBalance(usdg, providerA, USD("0.4"));

    await increase(24 * 3600);
    await expect(escrow.connect(consumer).withdraw(USD("0.7"))).to.be.reverted; // > deposits (0.6)
    await expect(escrow.connect(consumer).withdraw(USD("0.6"))).to.changeTokenBalance(usdg, consumer, USD("0.6"));
    expect(await escrow.deposits(consumer.address)).to.equal(0n);
    expect(await escrow.withdrawAt(consumer.address)).to.equal(0n);
    // request consumed
    await expect(escrow.connect(consumer).withdraw(0n)).to.be.reverted;
  });

  it("cancelWithdraw clears the request", async () => {
    await escrow.connect(consumer).requestWithdraw();
    await escrow.connect(consumer).cancelWithdraw();
    expect(await escrow.withdrawAt(consumer.address)).to.equal(0n);
    await increase(2 * 24 * 3600);
    await expect(escrow.connect(consumer).withdraw(1n)).to.be.reverted;
  });

  it("reentrant provider (token hook) cannot double-pay", async () => {
    const ht = await deploy("HookToken");
    const e = await deploy("ElyraEscrow", ht.target);
    await fund(ht, e, consumer, USD(1));
    await e.connect(consumer).deposit(USD(1));
    const att = await deploy("ReentrantProvider", e.target);
    const sig = await consumer.signTypedData(domain(chainId, e), TYPES, { consumer: consumer.address, provider: att.target, cumulative: USD("0.25") });
    await att.attack(consumer.address, USD("0.25"), sig);
    expect(await ht.balanceOf(att.target)).to.equal(USD("0.25"));
    expect(await att.reentries()).to.be.greaterThan(0n);
    expect(await att.reentrySucceeded()).to.equal(false);
    expect(await e.deposits(consumer.address)).to.equal(USD("0.75"));
    expect(await e.claimed(consumer.address, att.target)).to.equal(USD("0.25"));
  });
  describe("withdraw request lifecycle", () => {
    it("is single use: second withdraw needs a new request", async () => {
      await escrow.connect(consumer).requestWithdraw();
      await increase(2 * 24 * 3600);
      await expect(escrow.connect(consumer).withdraw(USD("0.4"))).to.changeTokenBalance(usdg, consumer, USD("0.4"));
      expect(await escrow.withdrawAt(consumer.address)).to.equal(0n);
      expect(await escrow.withdrawExpires(consumer.address)).to.equal(0n);
      await expect(escrow.connect(consumer).withdraw(USD("0.1"))).to.be.revertedWithCustomError(escrow, "WithdrawNotRequested");
    });

    it("expires after WITHDRAW_WINDOW; a fresh request is required", async () => {
      await escrow.connect(consumer).requestWithdraw();
      await increase(8 * 24 * 3600);
      await expect(escrow.connect(consumer).withdraw(1n)).to.be.revertedWithCustomError(escrow, "WithdrawExpired");
      await escrow.connect(consumer).requestWithdraw();
      await increase(2 * 24 * 3600);
      await expect(escrow.connect(consumer).withdraw(USD(1))).to.changeTokenBalance(usdg, consumer, USD(1));
    });

    it("consumer's own deposit clears a pending request (delay restarts only via a fresh request)", async () => {
      await escrow.connect(consumer).requestWithdraw();
      await increase(2 * 24 * 3600);
      await fund(usdg, escrow, consumer, USD(1));
      await escrow.connect(consumer).deposit(USD(1));
      expect(await escrow.withdrawAt(consumer.address)).to.equal(0n);
      expect(await escrow.withdrawExpires(consumer.address)).to.equal(0n);
      await expect(escrow.connect(consumer).withdraw(1n)).to.be.revertedWithCustomError(escrow, "WithdrawNotRequested");
      await escrow.connect(consumer).requestWithdraw();
      await expect(escrow.connect(consumer).withdraw(1n)).to.be.revertedWithCustomError(escrow, "WithdrawLocked");
    });

    it("third-party depositFor does not clear someone else's pending request", async () => {
      await escrow.connect(consumer).requestWithdraw();
      const at = await escrow.withdrawAt(consumer.address);
      const exp = await escrow.withdrawExpires(consumer.address);
      await fund(usdg, escrow, other, USD(1));
      await escrow.connect(other).depositFor(consumer.address, USD(1));
      expect(await escrow.withdrawAt(consumer.address)).to.equal(at);
      expect(await escrow.withdrawExpires(consumer.address)).to.equal(exp);
      await increase(2 * 24 * 3600);
      await expect(escrow.connect(consumer).withdraw(USD(2))).to.changeTokenBalance(usdg, consumer, USD(2));
    });

    it("depositFor by the consumer itself clears the request", async () => {
      await escrow.connect(consumer).requestWithdraw();
      await fund(usdg, escrow, consumer, 5n);
      await escrow.connect(consumer).depositFor(consumer.address, 5n);
      expect(await escrow.withdrawAt(consumer.address)).to.equal(0n);
    });

    it("cancelWithdraw clears both fields", async () => {
      await escrow.connect(consumer).requestWithdraw();
      await escrow.connect(consumer).cancelWithdraw();
      expect(await escrow.withdrawAt(consumer.address)).to.equal(0n);
      expect(await escrow.withdrawExpires(consumer.address)).to.equal(0n);
    });

    it("redeem keeps working during the delay and after expiry", async () => {
      await escrow.connect(consumer).requestWithdraw();
      const s1 = await sign(consumer, providerA, USD("0.1"));
      await escrow.connect(providerA).redeem(consumer.address, USD("0.1"), s1);
      await increase(9 * 24 * 3600); // past delay and past the window
      const s2 = await sign(consumer, providerA, USD("0.3"));
      await expect(escrow.connect(providerA).redeem(consumer.address, USD("0.3"), s2)).to.changeTokenBalance(usdg, providerA, USD("0.2"));
    });
  });

  it("documented limitation: consumer can self-redeem through a second address", async () => {
    // providerA has been served on credit and holds a valid voucher for 0.6
    const vA = await sign(consumer, providerA, USD("0.6"));
    // the consumer drains the whole deposit by paying a second address it controls, no delay involved
    const vSelf = await sign(consumer, other, USD(1));
    await expect(escrow.connect(other).redeem(consumer.address, USD(1), vSelf)).to.changeTokenBalance(usdg, other, USD(1));
    expect(await escrow.deposits(consumer.address)).to.equal(0n);
    await expect(escrow.connect(providerA).redeem(consumer.address, USD("0.6"), vA)).to.be.revertedWithCustomError(escrow, "NothingToPay");
  });
});
