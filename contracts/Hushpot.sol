// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {FHE, euint64, euint32, ebool, externalEuint64} from "@fhevm/solidity/lib/FHE.sol";
import {ZamaEthereumConfig} from "@fhevm/solidity/config/ZamaConfig.sol";
import {IERC7984} from "@openzeppelin/confidential-contracts/interfaces/IERC7984.sol";

/// @title Hushpot — a confidential, sealed-bid rotating savings circle (ROSCA) on the Zama Protocol.
/// @notice Phase 1: circle registry & membership, collateral vault, confidential contributions
///         with an encrypted insurance-reserve skim, and the per-round state machine.
///         Sealed bids, blind-auction resolution, default slashing, and withdrawals arrive in
///         later phases. The money layer is the official Sepolia cUSDT wrapper (ERC-7984); a
///         mintable mock stands in for local mock-mode tests.
/// @dev    All token amounts are euint64 (cUSDT is 6 decimals). Member indices are euint32.
contract Hushpot is ZamaEthereumConfig {
    // ---------------------------------------------------------------------
    // Types
    // ---------------------------------------------------------------------

    /// @notice Lifecycle of a single round, mirrored 1:1 in the frontend badge.
    enum RoundState {
        OPEN, // contributions + bids accepted
        BIDDING, // (reserved for Phase 3 — kept for ABI stability)
        RESOLVING, // resolution requested, awaiting decrypted winner
        SETTLED // winner set, round advanced
    }

    struct Circle {
        address[] members;
        uint64 contribution; // agreed per-round contribution (plain plan param; amounts move as ciphertext)
        uint64 collateral; // required security deposit, locked on join
        uint16 feeBps; // insurance fee in basis points, skimmed from each contribution
        uint8 totalRounds; // == members.length
        uint8 currentRound; // 0-indexed round pointer
        uint64 roundDeadline; // unix ts; contributions/bids due by this time
        RoundState state;
        bool active; // true once every member has joined
        bool completed; // true once all rounds have settled
        uint8 joinedCount; // number of members that have locked collateral
    }

    // ---------------------------------------------------------------------
    // Storage
    // ---------------------------------------------------------------------

    /// @notice The confidential token used for contributions, pot, collateral, and reserve.
    IERC7984 public immutable cUSDT;

    /// @notice Maximum members per circle. Keeps the (future) per-round argmax cheap on testnet.
    uint8 public constant MAX_MEMBERS = 10;

    /// @notice Basis-points denominator.
    uint16 public constant BPS_DENOMINATOR = 10_000;

    uint256 public circleCount;

    mapping(uint256 => Circle) private _circles;

    /// @notice circle => member => has locked collateral / is a member.
    mapping(uint256 => mapping(address => bool)) public joined;

    /// @notice circle => member => has already received the pot once.
    mapping(uint256 => mapping(address => bool)) public hasWon;

    /// @notice circle => round => member => paid this round (public flag: the act, not the amount).
    mapping(uint256 => mapping(uint8 => mapping(address => bool))) public paidThisRound;

    /// @notice circle => encrypted running insurance reserve.
    mapping(uint256 => euint64) private _reserve;

    /// @notice circle => encrypted pot accumulated for the current round.
    mapping(uint256 => euint64) private _pot;

    /// @notice circle => round => member => sealed encrypted bid for the pot.
    mapping(uint256 => mapping(uint8 => mapping(address => euint64))) private _bids;

    /// @notice circle => round => member => has submitted a bid this round (public flag).
    mapping(uint256 => mapping(uint8 => mapping(address => bool))) public bidThisRound;

    /// @notice circle => round => the eligible bidders snapshot taken at resolution.
    mapping(uint256 => mapping(uint8 => address[])) private _bidders;

    /// @notice circle => round => encrypted winning member index (into _bidders) awaiting decryption.
    mapping(uint256 => mapping(uint8 => euint32)) private _encWinnerIdx;

    /// @notice circle => round => the decrypted, settled winner address (0 until finalized).
    mapping(uint256 => mapping(uint8 => address)) public roundWinner;

    /// @notice circle => round => pot already claimed by the winner.
    mapping(uint256 => mapping(uint8 => bool)) public potClaimed;

    // ---------------------------------------------------------------------
    // Events
    // ---------------------------------------------------------------------

    event CircleCreated(
        uint256 indexed circleId,
        address indexed creator,
        uint8 members,
        uint64 contribution,
        uint64 collateral
    );
    event CollateralLocked(uint256 indexed circleId, address indexed member);
    event CircleActivated(uint256 indexed circleId, uint64 roundDeadline);
    event Contributed(uint256 indexed circleId, uint8 indexed round, address indexed member);
    event RoundStateChanged(uint256 indexed circleId, uint8 indexed round, RoundState state);
    event SealedBidSubmitted(uint256 indexed circleId, uint8 indexed round, address indexed member);
    event RoundResolving(uint256 indexed circleId, uint8 indexed round, uint8 eligibleBidders);
    event WinnerRevealed(uint256 indexed circleId, uint8 indexed round, address indexed winner);
    event PotClaimed(uint256 indexed circleId, uint8 indexed round, address indexed winner);
    event CircleCompleted(uint256 indexed circleId);

    // ---------------------------------------------------------------------
    // Errors
    // ---------------------------------------------------------------------

    error InvalidMemberCount();
    error DuplicateMember();
    error ZeroAddressMember();
    error InvalidContribution();
    error InvalidFee();
    error NotAMember();
    error AlreadyJoined();
    error NotJoined();
    error CircleNotActive();
    error CircleAlreadyActive();
    error CircleIsCompleted();
    error AlreadyContributed();
    error WrongRoundState();
    error AlreadyWon();
    error AlreadyBid();
    error DeadlineNotReached();
    error NoEligibleBidders();
    error WinnerNotFinalized();
    error NotTheWinner();
    error PotAlreadyClaimed();
    error InvalidWinnerIndex();

    // ---------------------------------------------------------------------
    // Constructor
    // ---------------------------------------------------------------------

    /// @param token The ERC-7984 confidential token (Sepolia cUSDT wrapper, or a local mock).
    constructor(IERC7984 token) {
        cUSDT = token;
    }

    // ---------------------------------------------------------------------
    // Circle lifecycle
    // ---------------------------------------------------------------------

    /// @notice Create a circle. Sets totalRounds = members.length. The circle is inactive until
    ///         every listed member has locked collateral via {joinCircle}.
    /// @param members Distinct member addresses (2..MAX_MEMBERS).
    /// @param contribution Agreed per-round contribution amount (cUSDT base units).
    /// @param collateral Security deposit each member locks on join (e.g. 2x contribution).
    /// @param feeBps Insurance fee in basis points skimmed from each contribution into the reserve.
    function createCircle(
        address[] calldata members,
        uint64 contribution,
        uint64 collateral,
        uint16 feeBps
    ) external returns (uint256 circleId) {
        uint256 n = members.length;
        if (n < 2 || n > MAX_MEMBERS) revert InvalidMemberCount();
        if (contribution == 0) revert InvalidContribution();
        if (feeBps >= BPS_DENOMINATOR) revert InvalidFee();

        // Reject zero addresses and duplicates (O(n^2), n <= 10).
        for (uint256 i = 0; i < n; i++) {
            if (members[i] == address(0)) revert ZeroAddressMember();
            for (uint256 j = i + 1; j < n; j++) {
                if (members[i] == members[j]) revert DuplicateMember();
            }
        }

        circleId = circleCount++;
        Circle storage c = _circles[circleId];
        c.members = members;
        c.contribution = contribution;
        c.collateral = collateral;
        c.feeBps = feeBps;
        c.totalRounds = uint8(n);
        c.currentRound = 0;
        c.state = RoundState.OPEN;

        emit CircleCreated(circleId, msg.sender, uint8(n), contribution, collateral);
    }

    /// @notice Lock collateral and join a circle. Pulls the deposit into the vault via the
    ///         ERC-7984 operator flow (caller must have called setOperator(hushpot, until) on the
    ///         token first). The circle activates once all members have joined.
    /// @param circleId The circle to join.
    /// @param encCollateral Encrypted collateral amount (must equal the circle's collateral).
    /// @param proof Input proof for the encrypted amount.
    function joinCircle(uint256 circleId, externalEuint64 encCollateral, bytes calldata proof) external {
        Circle storage c = _circles[circleId];
        if (c.totalRounds == 0) revert NotAMember(); // unknown circle
        if (c.active) revert CircleAlreadyActive();
        if (!_isMember(c, msg.sender)) revert NotAMember();
        if (joined[circleId][msg.sender]) revert AlreadyJoined();

        // Import the amount into a ciphertext THIS contract controls, then hand it to the token.
        // The external input is bound to Hushpot, so Hushpot (not the token) calls fromExternal;
        // the token consumes the resulting euint64 via the no-proof transfer overload. The member
        // must have set Hushpot as an operator on the token.
        euint64 amount = FHE.fromExternal(encCollateral, proof);
        FHE.allowThis(amount);
        FHE.allowTransient(amount, address(cUSDT));
        cUSDT.confidentialTransferFrom(msg.sender, address(this), amount);

        joined[circleId][msg.sender] = true;
        c.joinedCount += 1;

        emit CollateralLocked(circleId, msg.sender);

        // Activate when everyone has locked collateral.
        if (c.joinedCount == c.totalRounds) {
            c.active = true;
            c.roundDeadline = uint64(block.timestamp + 7 days);
            emit CircleActivated(circleId, c.roundDeadline);
            emit RoundStateChanged(circleId, c.currentRound, RoundState.OPEN);
        }
    }

    /// @notice Contribute to the current round. Pulls the encrypted contribution into the pot and
    ///         skims an insurance fee into the encrypted reserve. The public paidThisRound flag is
    ///         set (the act of paying, not the amount).
    /// @param circleId The active circle.
    /// @param encAmount Encrypted contribution amount.
    /// @param proof Input proof for the encrypted amount.
    function contribute(uint256 circleId, externalEuint64 encAmount, bytes calldata proof) external {
        Circle storage c = _circles[circleId];
        if (!c.active) revert CircleNotActive();
        if (c.completed) revert CircleIsCompleted();
        if (c.state != RoundState.OPEN) revert WrongRoundState();
        if (!_isMember(c, msg.sender)) revert NotAMember();
        if (!joined[circleId][msg.sender]) revert NotJoined();

        uint8 round = c.currentRound;
        if (paidThisRound[circleId][round][msg.sender]) revert AlreadyContributed();

        // Import the contribution into a ciphertext THIS contract controls, then pull it into the
        // vault via the no-proof transfer overload. The token returns the amount actually moved.
        euint64 amount = FHE.fromExternal(encAmount, proof);
        FHE.allowThis(amount);
        FHE.allowTransient(amount, address(cUSDT));
        euint64 received = cUSDT.confidentialTransferFrom(msg.sender, address(this), amount);

        // Skim the insurance fee from the received amount: fee = received * feeBps / 10000.
        // Computed on ciphertext with a scalar mul + scalar div (single FHE op each).
        euint64 fee = FHE.div(FHE.mul(received, uint64(c.feeBps)), uint64(BPS_DENOMINATOR));

        // The remainder funds the pot.
        euint64 toPot = FHE.sub(received, fee);

        _reserve[circleId] = FHE.add(_reserve[circleId], fee);
        _pot[circleId] = FHE.add(_pot[circleId], toPot);

        // ACL: this contract must retain access to recompute on these stored ciphertexts.
        FHE.allowThis(_reserve[circleId]);
        FHE.allowThis(_pot[circleId]);

        paidThisRound[circleId][round][msg.sender] = true;

        emit Contributed(circleId, round, msg.sender);
    }

    // ---------------------------------------------------------------------
    // Sealed bids & blind-auction resolution (Phase 3)
    // ---------------------------------------------------------------------

    /// @notice Submit a sealed, encrypted bid for the current round's pot. A bid expresses how
    ///         eagerly a member wants the pot now; the most eager eligible bidder wins. Bids are
    ///         stored as ciphertext that ONLY this contract can compute on — never decryptable by
    ///         anyone, so losing bids stay private forever. Past winners cannot bid again.
    /// @param circleId The active circle.
    /// @param encBid Encrypted bid value (bound to Hushpot).
    /// @param proof Input proof for the encrypted bid.
    function submitBid(uint256 circleId, externalEuint64 encBid, bytes calldata proof) external {
        Circle storage c = _circles[circleId];
        if (!c.active) revert CircleNotActive();
        if (c.completed) revert CircleIsCompleted();
        if (c.state != RoundState.OPEN) revert WrongRoundState();
        if (!_isMember(c, msg.sender)) revert NotAMember();
        if (!joined[circleId][msg.sender]) revert NotJoined();
        if (hasWon[circleId][msg.sender]) revert AlreadyWon();

        uint8 round = c.currentRound;
        if (bidThisRound[circleId][round][msg.sender]) revert AlreadyBid();

        // Import the sealed bid into a ciphertext this contract controls. We grant ACL access ONLY
        // to this contract (allowThis) — never to the bidder or anyone else — so the value can be
        // compared inside resolveRound but can never be decrypted off-chain.
        euint64 bid = FHE.fromExternal(encBid, proof);
        FHE.allowThis(bid);

        _bids[circleId][round][msg.sender] = bid;
        bidThisRound[circleId][round][msg.sender] = true;
        _bidders[circleId][round].push(msg.sender);

        emit SealedBidSubmitted(circleId, round, msg.sender);
    }

    /// @notice Resolve the current round once the deadline has passed. Runs a branchless argmax over
    ///         the sealed bids to find the winning member index (entirely on ciphertext), then makes
    ///         ONLY that index publicly decryptable. No bid value is ever revealed. The circle moves
    ///         to RESOLVING; an off-chain caller decrypts the index and calls {finalizeRound}.
    /// @param circleId The active circle whose current round is being resolved.
    function resolveRound(uint256 circleId) external {
        Circle storage c = _circles[circleId];
        if (!c.active) revert CircleNotActive();
        if (c.completed) revert CircleIsCompleted();
        if (c.state != RoundState.OPEN) revert WrongRoundState();
        if (block.timestamp < c.roundDeadline) revert DeadlineNotReached();

        uint8 round = c.currentRound;
        address[] storage bidders = _bidders[circleId][round];
        uint256 n = bidders.length;
        if (n == 0) revert NoEligibleBidders();

        // Branchless argmax: walk the bidders, carrying the best bid and its index as ciphertext.
        // For each candidate i (>0): isMore = bid[i] > bestBid; bestBid = select(isMore, bid[i],
        // bestBid); bestIdx = select(isMore, i, bestIdx). No plaintext branch ever touches a bid.
        euint64 bestBid = _bids[circleId][round][bidders[0]];
        euint32 bestIdx = FHE.asEuint32(0);

        for (uint256 i = 1; i < n; i++) {
            euint64 candidate = _bids[circleId][round][bidders[i]];
            ebool isMore = FHE.gt(candidate, bestBid);
            bestBid = FHE.select(isMore, candidate, bestBid);
            bestIdx = FHE.select(isMore, FHE.asEuint32(uint32(i)), bestIdx);
        }

        // Expose ONLY the winning index for public decryption. The bids themselves remain sealed.
        bestIdx = FHE.makePubliclyDecryptable(bestIdx);
        FHE.allowThis(bestIdx);
        _encWinnerIdx[circleId][round] = bestIdx;

        c.state = RoundState.RESOLVING;
        emit RoundResolving(circleId, round, uint8(n));
        emit RoundStateChanged(circleId, round, RoundState.RESOLVING);
    }

    /// @notice Finalize a resolving round by submitting the KMS-decrypted winning index. The on-chain
    ///         signature check guarantees the index is the genuine decryption of the argmax handle, so
    ///         no party can forge a winner. Sets the winner, grants them ACL access to the pot, and
    ///         advances the circle (or completes it after the last round).
    /// @param circleId The resolving circle.
    /// @param clearWinnerIdx The decrypted winning index into the round's bidder snapshot.
    /// @param decryptionProof The KMS public-decryption proof for the winner-index handle.
    function finalizeRound(uint256 circleId, uint32 clearWinnerIdx, bytes calldata decryptionProof) external {
        Circle storage c = _circles[circleId];
        if (c.state != RoundState.RESOLVING) revert WrongRoundState();

        uint8 round = c.currentRound;
        address[] storage bidders = _bidders[circleId][round];
        if (clearWinnerIdx >= bidders.length) revert InvalidWinnerIndex();

        // Verify the cleartext index is the authentic decryption of the on-chain argmax handle.
        bytes32[] memory handles = new bytes32[](1);
        handles[0] = FHE.toBytes32(_encWinnerIdx[circleId][round]);
        bytes memory cleartexts = abi.encode(clearWinnerIdx);
        FHE.checkSignatures(handles, cleartexts, decryptionProof);

        address winner = bidders[clearWinnerIdx];
        roundWinner[circleId][round] = winner;
        hasWon[circleId][winner] = true;

        // Grant the winner permission to decrypt the pot (so the frontend can show the amount) and
        // to spend it via the no-proof transfer when they claim.
        FHE.allow(_pot[circleId], winner);

        c.state = RoundState.SETTLED;
        emit WinnerRevealed(circleId, round, winner);
        emit RoundStateChanged(circleId, round, RoundState.SETTLED);
    }

    /// @notice Claim the pot for a settled round. Only the revealed winner may call. Transfers the
    ///         encrypted pot to the winner and resets the pot for the next round, then advances the
    ///         circle pointer (or marks it completed after the final round).
    /// @param circleId The circle with a settled current round.
    function claimPot(uint256 circleId) external {
        Circle storage c = _circles[circleId];
        if (c.state != RoundState.SETTLED) revert WrongRoundState();

        uint8 round = c.currentRound;
        address winner = roundWinner[circleId][round];
        if (winner == address(0)) revert WinnerNotFinalized();
        if (msg.sender != winner) revert NotTheWinner();
        if (potClaimed[circleId][round]) revert PotAlreadyClaimed();

        potClaimed[circleId][round] = true;

        // Move the encrypted pot to the winner. The pot ciphertext is allowed to this contract
        // (the holder) and was allowed to the winner in finalizeRound; transfer it out.
        euint64 pot = _pot[circleId];
        FHE.allowTransient(pot, address(cUSDT));
        cUSDT.confidentialTransfer(winner, pot);

        // Reset the pot for the next round.
        _pot[circleId] = FHE.asEuint64(0);
        FHE.allowThis(_pot[circleId]);

        emit PotClaimed(circleId, round, winner);

        // Advance the circle: next round, or complete after the last round.
        if (round + 1 >= c.totalRounds) {
            c.completed = true;
            emit CircleCompleted(circleId);
        } else {
            c.currentRound = round + 1;
            c.state = RoundState.OPEN;
            c.roundDeadline = uint64(block.timestamp + 7 days);
            emit RoundStateChanged(circleId, c.currentRound, RoundState.OPEN);
        }
    }

    // ---------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------

    function getCircle(
        uint256 circleId
    )
        external
        view
        returns (
            address[] memory members,
            uint64 contribution,
            uint64 collateral,
            uint16 feeBps,
            uint8 totalRounds,
            uint8 currentRound,
            uint64 roundDeadline,
            RoundState state,
            bool active,
            bool completed
        )
    {
        Circle storage c = _circles[circleId];
        return (
            c.members,
            c.contribution,
            c.collateral,
            c.feeBps,
            c.totalRounds,
            c.currentRound,
            c.roundDeadline,
            c.state,
            c.active,
            c.completed
        );
    }

    function getMembers(uint256 circleId) external view returns (address[] memory) {
        return _circles[circleId].members;
    }

    /// @notice Encrypted pot handle for the circle (ciphertext; only ACL-allowed parties can decrypt).
    function reserveHandle(uint256 circleId) external view returns (euint64) {
        return _reserve[circleId];
    }

    /// @notice Encrypted pot handle for the current round.
    function potHandle(uint256 circleId) external view returns (euint64) {
        return _pot[circleId];
    }

    /// @notice Encrypted winning-index handle for a resolving round (publicly decryptable).
    function winnerIndexHandle(uint256 circleId, uint8 round) external view returns (euint32) {
        return _encWinnerIdx[circleId][round];
    }

    /// @notice The snapshot of eligible bidders for a round, in argmax index order.
    function getBidders(uint256 circleId, uint8 round) external view returns (address[] memory) {
        return _bidders[circleId][round];
    }

    // ---------------------------------------------------------------------
    // Internal
    // ---------------------------------------------------------------------

    function _isMember(Circle storage c, address who) private view returns (bool) {
        address[] storage m = c.members;
        uint256 len = m.length;
        for (uint256 i = 0; i < len; i++) {
            if (m[i] == who) return true;
        }
        return false;
    }
}
