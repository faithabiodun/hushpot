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
    error CircleCompleted();
    error AlreadyContributed();
    error WrongRoundState();

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
        if (c.completed) revert CircleCompleted();
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
