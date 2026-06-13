// Minimal human-readable ABIs for the frontend. Kept hand-curated (rather than importing the
// full artifact) so the bundle stays small and the surface is obvious.

export const HUSHPOT_ABI = [
  // --- lifecycle ---
  "function createCircle(address[] members, uint64 contribution, uint64 collateral, uint16 feeBps) returns (uint256)",
  "function joinCircle(uint256 circleId, bytes32 encCollateral, bytes proof)",
  "function contribute(uint256 circleId, bytes32 encAmount, bytes proof)",
  // --- sealed bids & resolution ---
  "function submitBid(uint256 circleId, bytes32 encBid, bytes proof)",
  "function resolveRound(uint256 circleId)",
  "function finalizeRound(uint256 circleId, uint32 clearWinnerIdx, bytes decryptionProof)",
  "function claimPot(uint256 circleId)",
  // --- anti-default ---
  "function slashDefaulter(uint256 circleId, address member)",
  "function withdrawCollateral(uint256 circleId)",
  // --- views ---
  "function circleCount() view returns (uint256)",
  "function getCircle(uint256 circleId) view returns (address[] members, uint64 contribution, uint64 collateral, uint16 feeBps, uint8 totalRounds, uint8 currentRound, uint64 roundDeadline, uint8 state, bool active, bool completed)",
  "function getMembers(uint256 circleId) view returns (address[])",
  "function getBidders(uint256 circleId, uint8 round) view returns (address[])",
  "function joined(uint256 circleId, address member) view returns (bool)",
  "function hasWon(uint256 circleId, address member) view returns (bool)",
  "function paidThisRound(uint256 circleId, uint8 round, address member) view returns (bool)",
  "function bidThisRound(uint256 circleId, uint8 round, address member) view returns (bool)",
  "function defaulted(uint256 circleId, address member) view returns (bool)",
  "function collateralWithdrawn(uint256 circleId, address member) view returns (bool)",
  "function roundWinner(uint256 circleId, uint8 round) view returns (address)",
  "function potClaimed(uint256 circleId, uint8 round) view returns (bool)",
  "function potHandle(uint256 circleId) view returns (bytes32)",
  "function reserveHandle(uint256 circleId) view returns (bytes32)",
  "function winnerIndexHandle(uint256 circleId, uint8 round) view returns (bytes32)",
  // --- events ---
  "event CircleCreated(uint256 indexed circleId, address indexed creator, uint8 members, uint64 contribution, uint64 collateral)",
  "event CollateralLocked(uint256 indexed circleId, address indexed member)",
  "event CircleActivated(uint256 indexed circleId, uint64 roundDeadline)",
  "event Contributed(uint256 indexed circleId, uint8 indexed round, address indexed member)",
  "event RoundStateChanged(uint256 indexed circleId, uint8 indexed round, uint8 state)",
  "event SealedBidSubmitted(uint256 indexed circleId, uint8 indexed round, address indexed member)",
  "event RoundResolving(uint256 indexed circleId, uint8 indexed round, uint8 eligibleBidders)",
  "event WinnerRevealed(uint256 indexed circleId, uint8 indexed round, address indexed winner)",
  "event PotClaimed(uint256 indexed circleId, uint8 indexed round, address indexed winner)",
  "event CircleCompleted(uint256 indexed circleId)",
  "event MemberDefaulted(uint256 indexed circleId, uint8 indexed round, address indexed member)",
  "event CollateralWithdrawn(uint256 indexed circleId, address indexed member)",
] as const;

// ERC-7984 confidential token (cUSDT): only what the Desk needs.
export const CUSDT_ABI = [
  "function setOperator(address operator, uint48 until)",
  "function isOperator(address holder, address spender) view returns (bool)",
  "function confidentialBalanceOf(address account) view returns (bytes32)",
  "function decimals() view returns (uint8)",
  "function name() view returns (string)",
  "function symbol() view returns (string)",
] as const;
