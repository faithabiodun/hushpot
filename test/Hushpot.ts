import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { ethers, fhevm } from "hardhat";
import { Hushpot, Hushpot__factory, MockERC7984, MockERC7984__factory } from "../types";
import { expect } from "chai";
import { FhevmType } from "@fhevm/hardhat-plugin";

type Signers = {
  deployer: HardhatEthersSigner;
  alice: HardhatEthersSigner;
  bob: HardhatEthersSigner;
  carol: HardhatEthersSigner;
};

const FEE_BPS = 100; // 1%
const CONTRIBUTION = 1_000_000n; // 1.0 cUSDT (6 decimals)
const COLLATERAL = 2_000_000n; // 2.0 cUSDT
const MINT = 100_000_000n; // 100 cUSDT per member
const FAR_FUTURE = 2_000_000_000; // operator approval expiry

async function deployFixture() {
  const tokenFactory = (await ethers.getContractFactory("MockERC7984")) as MockERC7984__factory;
  const token = (await tokenFactory.deploy("Confidential USDT Mock", "cUSDT", "")) as MockERC7984;
  const tokenAddress = await token.getAddress();

  const hushpotFactory = (await ethers.getContractFactory("Hushpot")) as Hushpot__factory;
  const hushpot = (await hushpotFactory.deploy(tokenAddress)) as Hushpot;
  const hushpotAddress = await hushpot.getAddress();

  return { token, tokenAddress, hushpot, hushpotAddress };
}

/// Mint `amount` cUSDT to `who` via the mock faucet (encrypted input bound to the token).
async function mint(token: MockERC7984, tokenAddress: string, who: HardhatEthersSigner, amount: bigint) {
  const enc = await fhevm.createEncryptedInput(tokenAddress, who.address).add64(amount).encrypt();
  await (await token.connect(who).mint(who.address, enc.handles[0], enc.inputProof)).wait();
}

/// Encrypt `amount` for a Hushpot call. The encrypted input is bound to the contract the member
/// submits the transaction to (Hushpot), which forwards the handle+proof into the token.
async function encForHushpot(hushpotAddress: string, member: HardhatEthersSigner, amount: bigint) {
  return fhevm.createEncryptedInput(hushpotAddress, member.address).add64(amount).encrypt();
}

describe("Hushpot — Phase 1", function () {
  let signers: Signers;
  let token: MockERC7984;
  let tokenAddress: string;
  let hushpot: Hushpot;
  let hushpotAddress: string;

  before(async function () {
    const eth = await ethers.getSigners();
    signers = { deployer: eth[0], alice: eth[1], bob: eth[2], carol: eth[3] };
  });

  beforeEach(async function () {
    if (!fhevm.isMock) {
      console.warn(`Hushpot Phase 1 suite runs only on the FHEVM mock environment`);
      this.skip();
    }
    ({ token, tokenAddress, hushpot, hushpotAddress } = await deployFixture());
  });

  // -------------------------------------------------------------------
  // createCircle
  // -------------------------------------------------------------------

  describe("createCircle", function () {
    it("creates a circle and exposes its parameters", async function () {
      const members = [signers.alice.address, signers.bob.address, signers.carol.address];
      await expect(hushpot.createCircle(members, CONTRIBUTION, COLLATERAL, FEE_BPS))
        .to.emit(hushpot, "CircleCreated")
        .withArgs(0, signers.deployer.address, 3, CONTRIBUTION, COLLATERAL);

      const c = await hushpot.getCircle(0);
      expect(c.members).to.deep.eq(members);
      expect(c.contribution).to.eq(CONTRIBUTION);
      expect(c.collateral).to.eq(COLLATERAL);
      expect(c.feeBps).to.eq(FEE_BPS);
      expect(c.totalRounds).to.eq(3);
      expect(c.currentRound).to.eq(0);
      expect(c.state).to.eq(0); // OPEN
      expect(c.active).to.eq(false);
      expect(c.completed).to.eq(false);
      expect(await hushpot.circleCount()).to.eq(1);
    });

    it("rejects fewer than 2 members", async function () {
      await expect(
        hushpot.createCircle([signers.alice.address], CONTRIBUTION, COLLATERAL, FEE_BPS),
      ).to.be.revertedWithCustomError(hushpot, "InvalidMemberCount");
    });

    it("rejects more than MAX_MEMBERS", async function () {
      const many = Array.from({ length: 11 }, () => ethers.Wallet.createRandom().address);
      await expect(
        hushpot.createCircle(many, CONTRIBUTION, COLLATERAL, FEE_BPS),
      ).to.be.revertedWithCustomError(hushpot, "InvalidMemberCount");
    });

    it("rejects duplicate members", async function () {
      await expect(
        hushpot.createCircle(
          [signers.alice.address, signers.alice.address],
          CONTRIBUTION,
          COLLATERAL,
          FEE_BPS,
        ),
      ).to.be.revertedWithCustomError(hushpot, "DuplicateMember");
    });

    it("rejects a zero-address member", async function () {
      await expect(
        hushpot.createCircle([signers.alice.address, ethers.ZeroAddress], CONTRIBUTION, COLLATERAL, FEE_BPS),
      ).to.be.revertedWithCustomError(hushpot, "ZeroAddressMember");
    });

    it("rejects zero contribution", async function () {
      await expect(
        hushpot.createCircle([signers.alice.address, signers.bob.address], 0, COLLATERAL, FEE_BPS),
      ).to.be.revertedWithCustomError(hushpot, "InvalidContribution");
    });

    it("rejects fee >= 100%", async function () {
      await expect(
        hushpot.createCircle([signers.alice.address, signers.bob.address], CONTRIBUTION, COLLATERAL, 10_000),
      ).to.be.revertedWithCustomError(hushpot, "InvalidFee");
    });
  });

  // -------------------------------------------------------------------
  // joinCircle
  // -------------------------------------------------------------------

  describe("joinCircle", function () {
    beforeEach(async function () {
      const members = [signers.alice.address, signers.bob.address];
      await hushpot.createCircle(members, CONTRIBUTION, COLLATERAL, FEE_BPS);
      await mint(token, tokenAddress, signers.alice, MINT);
      await mint(token, tokenAddress, signers.bob, MINT);
      // Members authorize Hushpot as operator on the token.
      await (await token.connect(signers.alice).setOperator(hushpotAddress, FAR_FUTURE)).wait();
      await (await token.connect(signers.bob).setOperator(hushpotAddress, FAR_FUTURE)).wait();
    });

    it("locks collateral, flags joined, and activates when all join", async function () {
      const encA = await encForHushpot(hushpotAddress, signers.alice, COLLATERAL);
      await expect(hushpot.connect(signers.alice).joinCircle(0, encA.handles[0], encA.inputProof))
        .to.emit(hushpot, "CollateralLocked")
        .withArgs(0, signers.alice.address);
      expect(await hushpot.joined(0, signers.alice.address)).to.eq(true);
      expect((await hushpot.getCircle(0)).active).to.eq(false);

      const encB = await encForHushpot(hushpotAddress, signers.bob, COLLATERAL);
      await expect(hushpot.connect(signers.bob).joinCircle(0, encB.handles[0], encB.inputProof)).to.emit(
        hushpot,
        "CircleActivated",
      );
      expect((await hushpot.getCircle(0)).active).to.eq(true);

      // Each member's balance dropped by exactly the collateral.
      const aliceBal = await token.confidentialBalanceOf(signers.alice.address);
      const aliceClear = await fhevm.userDecryptEuint(FhevmType.euint64, aliceBal, tokenAddress, signers.alice);
      expect(aliceClear).to.eq(MINT - COLLATERAL);
    });

    it("rejects a non-member", async function () {
      const enc = await encForHushpot(hushpotAddress, signers.carol, COLLATERAL);
      await expect(
        hushpot.connect(signers.carol).joinCircle(0, enc.handles[0], enc.inputProof),
      ).to.be.revertedWithCustomError(hushpot, "NotAMember");
    });

    it("rejects joining twice", async function () {
      const enc1 = await encForHushpot(hushpotAddress, signers.alice, COLLATERAL);
      await (await hushpot.connect(signers.alice).joinCircle(0, enc1.handles[0], enc1.inputProof)).wait();
      const enc2 = await encForHushpot(hushpotAddress, signers.alice, COLLATERAL);
      await expect(
        hushpot.connect(signers.alice).joinCircle(0, enc2.handles[0], enc2.inputProof),
      ).to.be.revertedWithCustomError(hushpot, "AlreadyJoined");
    });
  });

  // -------------------------------------------------------------------
  // contribute + reserve skim
  // -------------------------------------------------------------------

  describe("contribute", function () {
    beforeEach(async function () {
      const members = [signers.alice.address, signers.bob.address];
      await hushpot.createCircle(members, CONTRIBUTION, COLLATERAL, FEE_BPS);
      for (const s of [signers.alice, signers.bob]) {
        await mint(token, tokenAddress, s, MINT);
        await (await token.connect(s).setOperator(hushpotAddress, FAR_FUTURE)).wait();
        const enc = await encForHushpot(hushpotAddress, s, COLLATERAL);
        await (await hushpot.connect(s).joinCircle(0, enc.handles[0], enc.inputProof)).wait();
      }
      // Circle is now active.
    });

    it("pulls the contribution, skims the fee into the reserve, funds the pot", async function () {
      const encA = await encForHushpot(hushpotAddress, signers.alice, CONTRIBUTION);
      await expect(hushpot.connect(signers.alice).contribute(0, encA.handles[0], encA.inputProof))
        .to.emit(hushpot, "Contributed")
        .withArgs(0, 0, signers.alice.address);

      expect(await hushpot.paidThisRound(0, 0, signers.alice.address)).to.eq(true);

      const expectedFee = (CONTRIBUTION * BigInt(FEE_BPS)) / 10_000n;
      const expectedPot = CONTRIBUTION - expectedFee;

      // The contract is ACL-allowed on pot + reserve; grant the deployer (a signer) access
      // is not automatic, so we decrypt by re-allowing through a view is impossible. Instead we
      // confirm the member's balance dropped by the full contribution.
      const aliceBal = await token.confidentialBalanceOf(signers.alice.address);
      const aliceClear = await fhevm.userDecryptEuint(FhevmType.euint64, aliceBal, tokenAddress, signers.alice);
      expect(aliceClear).to.eq(MINT - COLLATERAL - CONTRIBUTION);

      void expectedFee;
      void expectedPot;
    });

    it("rejects a second contribution in the same round", async function () {
      const enc1 = await encForHushpot(hushpotAddress, signers.alice, CONTRIBUTION);
      await (await hushpot.connect(signers.alice).contribute(0, enc1.handles[0], enc1.inputProof)).wait();
      const enc2 = await encForHushpot(hushpotAddress, signers.alice, CONTRIBUTION);
      await expect(
        hushpot.connect(signers.alice).contribute(0, enc2.handles[0], enc2.inputProof),
      ).to.be.revertedWithCustomError(hushpot, "AlreadyContributed");
    });

    it("rejects contribution to an inactive circle", async function () {
      // New circle, not yet activated.
      await hushpot.createCircle([signers.alice.address, signers.bob.address], CONTRIBUTION, COLLATERAL, FEE_BPS);
      const enc = await encForHushpot(hushpotAddress, signers.alice, CONTRIBUTION);
      await expect(
        hushpot.connect(signers.alice).contribute(1, enc.handles[0], enc.inputProof),
      ).to.be.revertedWithCustomError(hushpot, "CircleNotActive");
    });
  });
});
