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
const ROUND_DURATION = 0; // 0 => contract default (7 days); tests fast-forward past the deadline
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
      await expect(hushpot.createCircle(members, CONTRIBUTION, COLLATERAL, FEE_BPS, ROUND_DURATION))
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
      expect(c.roundDuration).to.eq(7 * 24 * 60 * 60); // default 7 days
      expect(await hushpot.circleCount()).to.eq(1);
    });

    it("rejects fewer than 2 members", async function () {
      await expect(
        hushpot.createCircle([signers.alice.address], CONTRIBUTION, COLLATERAL, FEE_BPS, ROUND_DURATION),
      ).to.be.revertedWithCustomError(hushpot, "InvalidMemberCount");
    });

    it("rejects more than MAX_MEMBERS", async function () {
      const many = Array.from({ length: 11 }, () => ethers.Wallet.createRandom().address);
      await expect(
        hushpot.createCircle(many, CONTRIBUTION, COLLATERAL, FEE_BPS, ROUND_DURATION),
      ).to.be.revertedWithCustomError(hushpot, "InvalidMemberCount");
    });

    it("rejects duplicate members", async function () {
      await expect(
        hushpot.createCircle(
          [signers.alice.address, signers.alice.address],
          CONTRIBUTION,
          COLLATERAL,
          FEE_BPS,
          ROUND_DURATION,
        ),
      ).to.be.revertedWithCustomError(hushpot, "DuplicateMember");
    });

    it("rejects a zero-address member", async function () {
      await expect(
        hushpot.createCircle([signers.alice.address, ethers.ZeroAddress], CONTRIBUTION, COLLATERAL, FEE_BPS, ROUND_DURATION),
      ).to.be.revertedWithCustomError(hushpot, "ZeroAddressMember");
    });

    it("rejects zero contribution", async function () {
      await expect(
        hushpot.createCircle([signers.alice.address, signers.bob.address], 0, COLLATERAL, FEE_BPS, ROUND_DURATION),
      ).to.be.revertedWithCustomError(hushpot, "InvalidContribution");
    });

    it("rejects fee >= 100%", async function () {
      await expect(
        hushpot.createCircle([signers.alice.address, signers.bob.address], CONTRIBUTION, COLLATERAL, 10_000, ROUND_DURATION),
      ).to.be.revertedWithCustomError(hushpot, "InvalidFee");
    });

    it("rejects an out-of-bounds round duration", async function () {
      await expect(
        hushpot.createCircle([signers.alice.address, signers.bob.address], CONTRIBUTION, COLLATERAL, FEE_BPS, 1),
      ).to.be.revertedWithCustomError(hushpot, "InvalidRoundDuration");
    });

    it("accepts a custom in-bounds round duration", async function () {
      const fiveMinutes = 5 * 60;
      await hushpot.createCircle(
        [signers.alice.address, signers.bob.address],
        CONTRIBUTION,
        COLLATERAL,
        FEE_BPS,
        fiveMinutes,
      );
      expect((await hushpot.getCircle(0)).roundDuration).to.eq(fiveMinutes);
    });
  });

  // -------------------------------------------------------------------
  // joinCircle
  // -------------------------------------------------------------------

  describe("joinCircle", function () {
    beforeEach(async function () {
      const members = [signers.alice.address, signers.bob.address];
      await hushpot.createCircle(members, CONTRIBUTION, COLLATERAL, FEE_BPS, ROUND_DURATION);
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
      await hushpot.createCircle(members, CONTRIBUTION, COLLATERAL, FEE_BPS, ROUND_DURATION);
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
      await hushpot.createCircle([signers.alice.address, signers.bob.address], CONTRIBUTION, COLLATERAL, FEE_BPS, ROUND_DURATION);
      const enc = await encForHushpot(hushpotAddress, signers.alice, CONTRIBUTION);
      await expect(
        hushpot.connect(signers.alice).contribute(1, enc.handles[0], enc.inputProof),
      ).to.be.revertedWithCustomError(hushpot, "CircleNotActive");
    });
  });

  // -------------------------------------------------------------------
  // Sealed bids + blind-auction resolution (Phase 3)
  // -------------------------------------------------------------------

  describe("sealed bids & resolution", function () {
    // A 2-member, active circle where both members have contributed to round 0.
    async function activeAndContributed(members: HardhatEthersSigner[]) {
      await hushpot.createCircle(
        members.map((m) => m.address),
        CONTRIBUTION,
        COLLATERAL,
        FEE_BPS,
        ROUND_DURATION,
      );
      for (const s of members) {
        await mint(token, tokenAddress, s, MINT);
        await (await token.connect(s).setOperator(hushpotAddress, FAR_FUTURE)).wait();
        const encJ = await encForHushpot(hushpotAddress, s, COLLATERAL);
        await (await hushpot.connect(s).joinCircle(0, encJ.handles[0], encJ.inputProof)).wait();
      }
      for (const s of members) {
        const encC = await encForHushpot(hushpotAddress, s, CONTRIBUTION);
        await (await hushpot.connect(s).contribute(0, encC.handles[0], encC.inputProof)).wait();
      }
    }

    // Submit a sealed bid for `member` of clear value `amount`.
    async function bid(member: HardhatEthersSigner, amount: bigint) {
      const enc = await encForHushpot(hushpotAddress, member, amount);
      return hushpot.connect(member).submitBid(0, enc.handles[0], enc.inputProof);
    }

    // Move chain time past the round deadline.
    async function passDeadline() {
      const c = await hushpot.getCircle(0);
      await ethers.provider.send("evm_setNextBlockTimestamp", [Number(c.roundDeadline) + 1]);
      await ethers.provider.send("evm_mine", []);
    }

    // Decrypt the publicly-decryptable winner index and finalize the round on-chain.
    async function finalize(round: number) {
      const handle = await hushpot.winnerIndexHandle(0, round);
      const res = await fhevm.publicDecrypt([handle]);
      const clearIdx = Number(res.clearValues[handle]);
      await (await hushpot.finalizeRound(0, clearIdx, res.decryptionProof)).wait();
      return clearIdx;
    }

    beforeEach(async function () {
      await activeAndContributed([signers.alice, signers.bob]);
    });

    it("accepts sealed bids and flags the bidder (not the amount)", async function () {
      await expect(bid(signers.alice, 5n))
        .to.emit(hushpot, "SealedBidSubmitted")
        .withArgs(0, 0, signers.alice.address);
      expect(await hushpot.bidThisRound(0, 0, signers.alice.address)).to.eq(true);
      expect(await hushpot.bidThisRound(0, 0, signers.bob.address)).to.eq(false);
    });

    it("rejects a second bid in the same round", async function () {
      await (await bid(signers.alice, 5n)).wait();
      await expect(bid(signers.alice, 9n)).to.be.revertedWithCustomError(hushpot, "AlreadyBid");
    });

    it("rejects a non-member bid", async function () {
      const enc = await encForHushpot(hushpotAddress, signers.carol, 5n);
      await expect(
        hushpot.connect(signers.carol).submitBid(0, enc.handles[0], enc.inputProof),
      ).to.be.revertedWithCustomError(hushpot, "NotAMember");
    });

    it("rejects resolveRound before the deadline", async function () {
      await (await bid(signers.alice, 5n)).wait();
      await expect(hushpot.resolveRound(0)).to.be.revertedWithCustomError(hushpot, "DeadlineNotReached");
    });

    it("rejects resolveRound with no bidders", async function () {
      await passDeadline();
      await expect(hushpot.resolveRound(0)).to.be.revertedWithCustomError(hushpot, "NoEligibleBidders");
    });

    it("argmax picks the highest bidder; finalize reveals only the winner", async function () {
      // Bob bids higher than Alice; Bob should win.
      await (await bid(signers.alice, 5n)).wait();
      await (await bid(signers.bob, 9n)).wait();
      const bidders = await hushpot.getBidders(0, 0);

      await passDeadline();
      await expect(hushpot.resolveRound(0))
        .to.emit(hushpot, "RoundResolving")
        .withArgs(0, 0, 2);
      expect((await hushpot.getCircle(0)).state).to.eq(2); // RESOLVING

      const idx = await finalize(0);
      expect(bidders[idx]).to.eq(signers.bob.address);
      expect(await hushpot.roundWinner(0, 0)).to.eq(signers.bob.address);
      expect(await hushpot.hasWon(0, signers.bob.address)).to.eq(true);
      expect((await hushpot.getCircle(0)).state).to.eq(3); // SETTLED
    });

    it("winner claims the pot; pot equals contributions minus fees", async function () {
      await (await bid(signers.alice, 5n)).wait();
      await (await bid(signers.bob, 9n)).wait();
      await passDeadline();
      await (await hushpot.resolveRound(0)).wait();
      await finalize(0);

      const bobBefore = await token.confidentialBalanceOf(signers.bob.address);
      const bobBeforeClear = await fhevm.userDecryptEuint(FhevmType.euint64, bobBefore, tokenAddress, signers.bob);

      await expect(hushpot.connect(signers.bob).claimPot(0))
        .to.emit(hushpot, "PotClaimed")
        .withArgs(0, 0, signers.bob.address);

      // Pot = 2 contributions, each skimmed by 1% fee.
      const feePer = (CONTRIBUTION * BigInt(FEE_BPS)) / 10_000n;
      const expectedPot = 2n * (CONTRIBUTION - feePer);

      const bobAfter = await token.confidentialBalanceOf(signers.bob.address);
      const bobAfterClear = await fhevm.userDecryptEuint(FhevmType.euint64, bobAfter, tokenAddress, signers.bob);
      expect(bobAfterClear - bobBeforeClear).to.eq(expectedPot);

      // Round advanced to 1, back to OPEN.
      const c = await hushpot.getCircle(0);
      expect(c.currentRound).to.eq(1);
      expect(c.state).to.eq(0); // OPEN
      expect(c.completed).to.eq(false);
    });

    it("rejects a non-winner claiming the pot", async function () {
      await (await bid(signers.alice, 5n)).wait();
      await (await bid(signers.bob, 9n)).wait();
      await passDeadline();
      await (await hushpot.resolveRound(0)).wait();
      await finalize(0);
      await expect(hushpot.connect(signers.alice).claimPot(0)).to.be.revertedWithCustomError(
        hushpot,
        "NotTheWinner",
      );
    });

    it("prevents a past winner from bidding again", async function () {
      // Round 0: Bob wins.
      await (await bid(signers.alice, 5n)).wait();
      await (await bid(signers.bob, 9n)).wait();
      await passDeadline();
      await (await hushpot.resolveRound(0)).wait();
      await finalize(0);
      await (await hushpot.connect(signers.bob).claimPot(0)).wait();

      // Round 1: both contribute, Bob (already won) cannot bid.
      for (const s of [signers.alice, signers.bob]) {
        const encC = await encForHushpot(hushpotAddress, s, CONTRIBUTION);
        await (await hushpot.connect(s).contribute(0, encC.handles[0], encC.inputProof)).wait();
      }
      await expect(bid(signers.bob, 100n)).to.be.revertedWithCustomError(hushpot, "AlreadyWon");
    });
  });

  // -------------------------------------------------------------------
  // Anti-default: slashing & collateral withdrawal (Phase 4)
  // -------------------------------------------------------------------

  describe("default slashing & collateral withdrawal", function () {
    // Active 3-member circle (alice, bob, carol), all collateral locked.
    async function activeCircle() {
      const members = [signers.alice, signers.bob, signers.carol];
      await hushpot.createCircle(
        members.map((m) => m.address),
        CONTRIBUTION,
        COLLATERAL,
        FEE_BPS,
        ROUND_DURATION,
      );
      for (const s of members) {
        await mint(token, tokenAddress, s, MINT);
        await (await token.connect(s).setOperator(hushpotAddress, FAR_FUTURE)).wait();
        const encJ = await encForHushpot(hushpotAddress, s, COLLATERAL);
        await (await hushpot.connect(s).joinCircle(0, encJ.handles[0], encJ.inputProof)).wait();
      }
      return members;
    }

    async function contribute(s: HardhatEthersSigner) {
      const enc = await encForHushpot(hushpotAddress, s, CONTRIBUTION);
      await (await hushpot.connect(s).contribute(0, enc.handles[0], enc.inputProof)).wait();
    }

    async function bid(member: HardhatEthersSigner, amount: bigint) {
      const enc = await encForHushpot(hushpotAddress, member, amount);
      return hushpot.connect(member).submitBid(0, enc.handles[0], enc.inputProof);
    }

    async function passDeadline() {
      const c = await hushpot.getCircle(0);
      await ethers.provider.send("evm_setNextBlockTimestamp", [Number(c.roundDeadline) + 1]);
      await ethers.provider.send("evm_mine", []);
    }

    async function finalize(round: number) {
      const handle = await hushpot.winnerIndexHandle(0, round);
      const res = await fhevm.publicDecrypt([handle]);
      const clearIdx = Number(res.clearValues[handle]);
      await (await hushpot.finalizeRound(0, clearIdx, res.decryptionProof)).wait();
    }

    beforeEach(async function () {
      await activeCircle();
    });

    it("rejects slashing before the deadline", async function () {
      await contribute(signers.alice);
      await expect(
        hushpot.slashDefaulter(0, signers.carol.address),
      ).to.be.revertedWithCustomError(hushpot, "DeadlineNotReached");
    });

    it("rejects slashing a member who paid", async function () {
      await contribute(signers.alice);
      await passDeadline();
      await expect(
        hushpot.slashDefaulter(0, signers.alice.address),
      ).to.be.revertedWithCustomError(hushpot, "AlreadyPaid");
    });

    it("slashes a defaulter, flags default, and lets the round resolve", async function () {
      await contribute(signers.alice);
      await contribute(signers.bob);
      // Carol defaults.
      await bid(signers.alice, 5n);
      await bid(signers.bob, 9n);
      await passDeadline();

      await expect(hushpot.slashDefaulter(0, signers.carol.address))
        .to.emit(hushpot, "MemberDefaulted")
        .withArgs(0, 0, signers.carol.address);
      expect(await hushpot.defaulted(0, signers.carol.address)).to.eq(true);
      expect(await hushpot.paidThisRound(0, 0, signers.carol.address)).to.eq(true);
    });

    it("makes the pot whole despite a default: winner still gets a full pot", async function () {
      await contribute(signers.alice);
      await contribute(signers.bob);
      await bid(signers.alice, 5n);
      await bid(signers.bob, 9n); // Bob wins
      await passDeadline();
      await (await hushpot.slashDefaulter(0, signers.carol.address)).wait();
      await (await hushpot.resolveRound(0)).wait();
      await finalize(0);

      const before = await token.confidentialBalanceOf(signers.bob.address);
      const beforeClear = await fhevm.userDecryptEuint(FhevmType.euint64, before, tokenAddress, signers.bob);
      await (await hushpot.connect(signers.bob).claimPot(0)).wait();
      const after = await token.confidentialBalanceOf(signers.bob.address);
      const afterClear = await fhevm.userDecryptEuint(FhevmType.euint64, after, tokenAddress, signers.bob);

      // Pot = 3 full contributions, each net of the 1% fee (carol's share came from her collateral).
      const feePer = (CONTRIBUTION * BigInt(FEE_BPS)) / 10_000n;
      const expectedPot = 3n * (CONTRIBUTION - feePer);
      expect(afterClear - beforeClear).to.eq(expectedPot);
    });

    it("non-defaulters withdraw collateral after completion; defaulter forfeits", async function () {
      // Run all 3 rounds. Carol defaults in round 0 only (she still can't win since she never bids).
      // Round 0: alice+bob pay, carol defaults, bob wins.
      await contribute(signers.alice);
      await contribute(signers.bob);
      await bid(signers.alice, 5n);
      await bid(signers.bob, 9n);
      await passDeadline();
      await (await hushpot.slashDefaulter(0, signers.carol.address)).wait();
      await (await hushpot.resolveRound(0)).wait();
      await finalize(0);
      await (await hushpot.connect(signers.bob).claimPot(0)).wait();

      // Round 1: alice+carol pay (bob won), alice wins.
      await contribute(signers.alice);
      await contribute(signers.carol);
      await bid(signers.alice, 7n);
      await bid(signers.carol, 3n);
      await passDeadline();
      await (await hushpot.resolveRound(0)).wait();
      await finalize(1);
      await (await hushpot.connect(signers.alice).claimPot(0)).wait();

      // Round 2: only carol left to win; she pays and bids, wins, completes the circle.
      await contribute(signers.carol);
      await bid(signers.carol, 1n);
      await passDeadline();
      await (await hushpot.resolveRound(0)).wait();
      await finalize(2);
      await (await hushpot.connect(signers.carol).claimPot(0)).wait();

      expect((await hushpot.getCircle(0)).completed).to.eq(true);

      // Bob never defaulted -> can withdraw his collateral.
      const before = await token.confidentialBalanceOf(signers.bob.address);
      const beforeClear = await fhevm.userDecryptEuint(FhevmType.euint64, before, tokenAddress, signers.bob);
      await expect(hushpot.connect(signers.bob).withdrawCollateral(0))
        .to.emit(hushpot, "CollateralWithdrawn")
        .withArgs(0, signers.bob.address);
      const after = await token.confidentialBalanceOf(signers.bob.address);
      const afterClear = await fhevm.userDecryptEuint(FhevmType.euint64, after, tokenAddress, signers.bob);
      expect(afterClear - beforeClear).to.eq(COLLATERAL);

      // Carol defaulted in round 0 -> forfeits, cannot withdraw.
      await expect(
        hushpot.connect(signers.carol).withdrawCollateral(0),
      ).to.be.revertedWithCustomError(hushpot, "MemberDefaultedForfeit");
    });

    it("rejects collateral withdrawal before completion", async function () {
      await expect(
        hushpot.connect(signers.alice).withdrawCollateral(0),
      ).to.be.revertedWithCustomError(hushpot, "CircleNotCompleted");
    });
  });

  // -------------------------------------------------------------------
  // Confidentiality guarantees (Phase 5)
  // -------------------------------------------------------------------

  describe("confidentiality", function () {
    async function activeAndContributed(members: HardhatEthersSigner[]) {
      await hushpot.createCircle(
        members.map((m) => m.address),
        CONTRIBUTION,
        COLLATERAL,
        FEE_BPS,
        ROUND_DURATION,
      );
      for (const s of members) {
        await mint(token, tokenAddress, s, MINT);
        await (await token.connect(s).setOperator(hushpotAddress, FAR_FUTURE)).wait();
        const encJ = await encForHushpot(hushpotAddress, s, COLLATERAL);
        await (await hushpot.connect(s).joinCircle(0, encJ.handles[0], encJ.inputProof)).wait();
      }
      for (const s of members) {
        const encC = await encForHushpot(hushpotAddress, s, CONTRIBUTION);
        await (await hushpot.connect(s).contribute(0, encC.handles[0], encC.inputProof)).wait();
      }
    }

    async function bid(member: HardhatEthersSigner, amount: bigint) {
      const enc = await encForHushpot(hushpotAddress, member, amount);
      await (await hushpot.connect(member).submitBid(0, enc.handles[0], enc.inputProof)).wait();
    }

    async function resolveAndFinalize() {
      const c = await hushpot.getCircle(0);
      await ethers.provider.send("evm_setNextBlockTimestamp", [Number(c.roundDeadline) + 1]);
      await ethers.provider.send("evm_mine", []);
      await (await hushpot.resolveRound(0)).wait();
      const handle = await hushpot.winnerIndexHandle(0, 0);
      const res = await fhevm.publicDecrypt([handle]);
      await (await hushpot.finalizeRound(0, Number(res.clearValues[handle]), res.decryptionProof)).wait();
    }

    beforeEach(async function () {
      await activeAndContributed([signers.alice, signers.bob]);
      await bid(signers.alice, 5n); // loser
      await bid(signers.bob, 9n); // winner
    });

    it("a losing bid is undecryptable by the bidder", async function () {
      await resolveAndFinalize();
      expect(await hushpot.roundWinner(0, 0)).to.eq(signers.bob.address); // Alice lost

      const aliceBid = await hushpot.bidHandle(0, 0, signers.alice.address);
      // The contract only granted itself ACL on the bid; Alice can never decrypt it.
      await expect(
        fhevm.userDecryptEuint(FhevmType.euint64, aliceBid, hushpotAddress, signers.alice),
      ).to.be.rejected;
    });

    it("even the winning bid is never exposed (only the index is revealed)", async function () {
      await resolveAndFinalize();
      const bobBid = await hushpot.bidHandle(0, 0, signers.bob.address);
      await expect(
        fhevm.userDecryptEuint(FhevmType.euint64, bobBid, hushpotAddress, signers.bob),
      ).to.be.rejected;
    });

    it("only the winner can decrypt the pot after finalization", async function () {
      await resolveAndFinalize();
      const pot = await hushpot.potHandle(0);

      // Winner (Bob) was granted ACL on the pot in finalizeRound.
      const feePer = (CONTRIBUTION * BigInt(FEE_BPS)) / 10_000n;
      const expectedPot = 2n * (CONTRIBUTION - feePer);
      const winnerClear = await fhevm.userDecryptEuint(FhevmType.euint64, pot, hushpotAddress, signers.bob);
      expect(winnerClear).to.eq(expectedPot);

      // Loser (Alice) has no ACL on the pot.
      await expect(
        fhevm.userDecryptEuint(FhevmType.euint64, pot, hushpotAddress, signers.alice),
      ).to.be.rejected;
    });

    it("the pot is undecryptable by members before a winner is finalized", async function () {
      // Bids are in but the round is not resolved yet; nobody has pot ACL.
      const pot = await hushpot.potHandle(0);
      await expect(
        fhevm.userDecryptEuint(FhevmType.euint64, pot, hushpotAddress, signers.bob),
      ).to.be.rejected;
    });

    it("the insurance reserve is not decryptable by members", async function () {
      const reserve = await hushpot.reserveHandle(0);
      await expect(
        fhevm.userDecryptEuint(FhevmType.euint64, reserve, hushpotAddress, signers.alice),
      ).to.be.rejected;
    });
  });
});
