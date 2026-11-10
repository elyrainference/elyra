const { expect } = require("chai");
const { ethers, network } = require("hardhat");
const fs = require("fs");
const path = require("path");

const USD = (n) => ethers.parseUnits(String(n), 6);
const DAY = 86400;
const H = (s) => ethers.id(s);
const NODE = H("node"), BOX = H("box"), META = H("meta"), URL = "https://seller.example/r/abcd";

describe("ElyraRegistry", () => {
  let reg, usdg, a, b, other;
  const deploy = async (name, ...args) => { const c = await (await ethers.getContractFactory(name)).deploy(...args); await c.waitForDeployment(); return c; };
  const now = async () => (await ethers.provider.getBlock("latest")).timestamp;
  const increase = async (s) => { await network.provider.send("evm_increaseTime", [s]); await network.provider.send("evm_mine"); };
  const announce = (who = a, ttl = 0, url = URL, node = NODE) => reg.connect(who).announce(node, BOX, url, META, ttl);

  beforeEach(async () => {
    [a, b, other] = await ethers.getSigners();
    usdg = await deploy("MockUSDG");
    reg = await deploy("ElyraRegistry", ethers.ZeroAddress, 0);
  });

  describe("announce / refresh / expire / revoke (no bond)", () => {
    it("emits every field and lists the caller for the default TTL", async () => {
      const tx = await announce();
      const t = await now();
      await expect(tx).to.emit(reg, "Announced").withArgs(a.address, NODE, BOX, URL, META, t + 7 * DAY);
      expect(await reg.expiresAt(a.address)).to.equal(t + 7 * DAY);
      expect(await reg.isListed(a.address)).to.equal(true);
      expect(await reg.isListed(b.address)).to.equal(false);
    });

    it("honours an explicit TTL; the wallet is always msg.sender, never an argument", async () => {
      await announce(b, 2 * DAY);
      const t = await now();
      expect(await reg.expiresAt(b.address)).to.equal(t + 2 * DAY);
      expect(await reg.expiresAt(a.address)).to.equal(0);
    });

    it("re-announcing refreshes the expiry and emits a new event (latest wins)", async () => {
      await announce(a, DAY);
      await increase(DAY / 2);
      const tx = await reg.connect(a).announce(H("node2"), BOX, "https://new.example", META, 3 * DAY);
      const t = await now();
      await expect(tx).to.emit(reg, "Announced").withArgs(a.address, H("node2"), BOX, "https://new.example", META, t + 3 * DAY);
      expect(await reg.expiresAt(a.address)).to.equal(t + 3 * DAY);
    });

    it("entries expire by themselves", async () => {
      await announce(a, DAY);
      await increase(DAY + 5);
      expect(await reg.isListed(a.address)).to.equal(false);
    });

    it("revoke unlists immediately, emits Revoked, and only for the caller; double revoke reverts", async () => {
      await announce(a); await announce(b);
      await expect(reg.connect(a).revoke()).to.emit(reg, "Revoked").withArgs(a.address);
      expect(await reg.isListed(a.address)).to.equal(false);
      expect(await reg.isListed(b.address)).to.equal(true);
      await expect(reg.connect(a).revoke()).to.be.revertedWithCustomError(reg, "NotListed");
      await expect(reg.connect(other).revoke()).to.be.revertedWithCustomError(reg, "NotListed");
    });

    it("can announce again after a revoke", async () => {
      await announce(a); await reg.connect(a).revoke(); await announce(a);
      expect(await reg.isListed(a.address)).to.equal(true);
    });
  });

  describe("input caps", () => {
    it("rejects ttl above 30 days and below 1 hour; accepts the bounds", async () => {
      await expect(announce(a, 30 * DAY + 1)).to.be.revertedWithCustomError(reg, "BadTtl");
      await expect(announce(a, 3599)).to.be.revertedWithCustomError(reg, "BadTtl");
      await announce(a, 30 * DAY); await announce(a, 3600);
    });
    it("url must be 1..256 bytes (bytes, not characters)", async () => {
      await expect(announce(a, 0, "")).to.be.revertedWithCustomError(reg, "BadUrlLength");
      await announce(a, 0, "h".repeat(256));
      await expect(announce(a, 0, "h".repeat(257))).to.be.revertedWithCustomError(reg, "BadUrlLength");
      await expect(announce(a, 0, "é".repeat(129))).to.be.revertedWithCustomError(reg, "BadUrlLength"); // 258 bytes
    });
    it("rejects a zero node id", async () => {
      await expect(announce(a, 0, URL, ethers.ZeroHash)).to.be.revertedWithCustomError(reg, "ZeroNodeId");
    });
    it("rejects plain ETH and unknown calls", async () => {
      await expect(a.sendTransaction({ to: reg.target, value: 1n })).to.be.reverted;
    });
    it("constructor refuses a bond without a token; a zero bond may have no token", async () => {
      await expect((await ethers.getContractFactory("ElyraRegistry")).deploy(ethers.ZeroAddress, 1n)).to.be.reverted;
      expect(await reg.bondAmount()).to.equal(0n);
    });
    it("without a bond: withdraw flow has nothing to do", async () => {
      await announce();
      await expect(reg.connect(a).requestWithdraw()).to.be.revertedWithCustomError(reg, "NothingBonded");
      await expect(reg.connect(a).withdraw()).to.be.revertedWithCustomError(reg, "WithdrawNotRequested");
    });
  });

  describe("bond", () => {
    const BOND = USD(5);
    let breg;
    const fund = async (who, amount = BOND, token = usdg, r = breg) => { await token.mint(who.address, amount); await token.connect(who).approve(r.target, amount); };
    beforeEach(async () => { breg = await deploy("ElyraRegistry", usdg.target, BOND); });
    const bannounce = (who = a, ttl = 0) => breg.connect(who).announce(NODE, BOX, URL, META, ttl);

    it("announce pulls the bond once; refresh does not pull again", async () => {
      await fund(a, BOND * 2n);
      await expect(bannounce()).to.emit(breg, "BondPosted").withArgs(a.address, BOND);
      expect(await breg.bonded(a.address)).to.equal(BOND);
      expect(await usdg.balanceOf(breg.target)).to.equal(BOND);
      await bannounce();
      expect(await usdg.balanceOf(breg.target)).to.equal(BOND);
      expect(await usdg.balanceOf(a.address)).to.equal(BOND);
    });

    it("announce without approval or balance reverts and lists nothing", async () => {
      await expect(bannounce(b)).to.be.reverted;
      await usdg.mint(b.address, BOND);
      await expect(bannounce(b)).to.be.reverted; // no approval
      expect(await breg.isListed(b.address)).to.equal(false);
      expect(await breg.bonded(b.address)).to.equal(0n);
    });

    it("revoke keeps the bond; re-announcing needs no new bond", async () => {
      await fund(a); await bannounce();
      await breg.connect(a).revoke();
      expect(await breg.bonded(a.address)).to.equal(BOND);
      await bannounce();
      expect(await usdg.balanceOf(breg.target)).to.equal(BOND);
    });

    it("exit: requestWithdraw unlists now; locked for 1 day; then pays exactly the bond once", async () => {
      await fund(a); await bannounce();
      await expect(breg.connect(a).withdraw()).to.be.revertedWithCustomError(breg, "WithdrawNotRequested");
      await expect(breg.connect(a).requestWithdraw()).to.emit(breg, "Revoked").withArgs(a.address);
      expect(await breg.isListed(a.address)).to.equal(false);
      await expect(breg.connect(a).withdraw()).to.be.revertedWithCustomError(breg, "WithdrawLocked");
      await increase(DAY + 1);
      await expect(breg.connect(a).withdraw()).to.emit(breg, "BondWithdrawn").withArgs(a.address, BOND);
      expect(await usdg.balanceOf(a.address)).to.equal(BOND);
      expect(await usdg.balanceOf(breg.target)).to.equal(0n);
      expect(await breg.bonded(a.address)).to.equal(0n);
      await expect(breg.connect(a).withdraw()).to.be.revertedWithCustomError(breg, "WithdrawNotRequested"); // single use
      await expect(breg.connect(a).requestWithdraw()).to.be.revertedWithCustomError(breg, "NothingBonded");
    });

    it("withdraw window expires after 7 more days; a fresh request is needed", async () => {
      await fund(a); await bannounce();
      await breg.connect(a).requestWithdraw();
      await increase(DAY + 7 * DAY + 5);
      await expect(breg.connect(a).withdraw()).to.be.revertedWithCustomError(breg, "WithdrawExpired");
      await breg.connect(a).requestWithdraw();
      await increase(DAY + 1);
      await breg.connect(a).withdraw();
      expect(await usdg.balanceOf(a.address)).to.equal(BOND);
    });

    it("announcing again cancels a pending exit; cancelWithdraw works too", async () => {
      await fund(a); await bannounce();
      await breg.connect(a).requestWithdraw();
      await expect(bannounce()).to.emit(breg, "WithdrawCancelled").withArgs(a.address);
      expect(await breg.withdrawAt(a.address)).to.equal(0n);
      await breg.connect(a).requestWithdraw();
      await breg.connect(a).cancelWithdraw();
      await increase(DAY + 1);
      await expect(breg.connect(a).withdraw()).to.be.revertedWithCustomError(breg, "WithdrawNotRequested");
    });

    it("bonds are per wallet: nobody else can request, cancel or take another wallet's bond", async () => {
      await fund(a); await bannounce();
      await expect(breg.connect(b).requestWithdraw()).to.be.revertedWithCustomError(breg, "NothingBonded");
      await expect(breg.connect(b).withdraw()).to.be.revertedWithCustomError(breg, "WithdrawNotRequested");
      expect(await breg.bonded(a.address)).to.equal(BOND);
    });

    it("an exited wallet must re-bond to list again", async () => {
      await fund(a, BOND * 2n); await bannounce();
      await breg.connect(a).requestWithdraw(); await increase(DAY + 1); await breg.connect(a).withdraw();
      await bannounce();
      expect(await breg.bonded(a.address)).to.equal(BOND);
      expect(await usdg.balanceOf(breg.target)).to.equal(BOND);
    });

    it("fee-on-transfer token is rejected with TransferMismatch", async () => {
      const fee = await deploy("FeeToken");
      const r = await deploy("ElyraRegistry", fee.target, BOND);
      await fee.mint(a.address, BOND * 2n); await fee.connect(a).approve(r.target, BOND * 2n);
      await expect(r.connect(a).announce(NODE, BOX, URL, META, 0)).to.be.revertedWithCustomError(r, "TransferMismatch");
      expect(await r.isListed(a.address)).to.equal(false);
    });

    it("token returning no value (non-standard) works for bond and withdraw", async () => {
      const nr = await deploy("NoReturnToken", 6);
      const r = await deploy("ElyraRegistry", nr.target, BOND);
      await nr.mint(a.address, BOND); await nr.connect(a).approve(r.target, BOND);
      await r.connect(a).announce(NODE, BOX, URL, META, 0);
      await r.connect(a).requestWithdraw(); await increase(DAY + 1); await r.connect(a).withdraw();
      expect(await nr.balanceOf(a.address)).to.equal(BOND);
    });

    it("a token that blocks transfers makes withdraw revert atomically; the bond stays recoverable", async () => {
      for (const rf of [false, true]) {
        const bt = await deploy("BlockableToken");
        const r = await deploy("ElyraRegistry", bt.target, BOND);
        await bt.mint(a.address, BOND); await bt.connect(a).approve(r.target, BOND);
        await r.connect(a).announce(NODE, BOX, URL, META, 0);
        await r.connect(a).requestWithdraw(); await increase(DAY + 1);
        await bt.setBlocked(true, rf);
        await expect(r.connect(a).withdraw()).to.be.reverted;
        expect(await r.bonded(a.address)).to.equal(BOND);
        expect(await r.withdrawAt(a.address)).to.not.equal(0n);
        await bt.setBlocked(false, false);
        await r.connect(a).withdraw();
        expect(await bt.balanceOf(a.address)).to.equal(BOND);
      }
    });

    it("a contract seller cannot re-enter withdraw/announce from the token hook", async () => {
      const hook = await deploy("HookToken");
      const r = await deploy("ElyraRegistry", hook.target, BOND);
      const seller = await deploy("ReentrantSeller", r.target);
      await hook.mint(seller.target, BOND * 3n);
      await seller.announce(hook.target, BOND);
      await seller.exit(); await increase(DAY + 1);
      await seller.pull();
      expect(await seller.reentries()).to.be.greaterThan(0n);
      expect(await seller.reentrySucceeded()).to.equal(false);
      expect(await hook.balanceOf(seller.target)).to.equal(BOND * 3n); // paid exactly once
      expect(await hook.balanceOf(r.target)).to.equal(0n);
      expect(await r.bonded(seller.target)).to.equal(0n);
    });
  });

  it("committed artifacts deploy and work", async () => {
    const read = (n) => JSON.parse(fs.readFileSync(path.join(__dirname, "..", "artifacts", n + ".json"), "utf8"));
    const art = read("ElyraRegistry");
    expect(art.compiler).to.equal(read("ElyraEscrow").compiler);
    const c = await new ethers.ContractFactory(art.abi, art.bytecode, a).deploy(ethers.ZeroAddress, 0);
    await c.waitForDeployment();
    await expect(c.announce(NODE, BOX, URL, META, DAY)).to.emit(c, "Announced");
    expect(await c.isListed(a.address)).to.equal(true);
  });
});
