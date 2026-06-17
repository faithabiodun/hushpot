# 🔒 Hushpot

**A confidential, sealed-bid rotating savings circle (ROSCA) on the Zama Protocol.**

Hushpot brings the centuries-old _esusu / ajo / tanda / chit-fund_ to the chain without putting
anyone's money on display. A group of friends each commits a fixed confidential **cUSDT**
contribution every round; the contributions form a pot, and each round one member takes the whole
pot home. Who takes it is decided by a **sealed-bid blind auction** computed entirely over
encrypted values — the most eager member wins, **only the winner's identity is ever revealed, and
every losing bid stays private forever.**

Built for the **Zama Developer Program — Mainnet Season 3, Builder Track**.

---

## Why it's interesting

A ROSCA's hardest social problem is _ordering_: who gets the pot first, and is that fair? Real-world
circles solve it with bidding — members discount their future payout to get cash now — but doing that
transparently leaks everyone's liquidity stress and bargaining position. Hushpot runs that auction
**confidentially**:

- **Contributions are confidential.** Amounts move as ERC-7984 ciphertext; only the _act_ of paying
  is public, never the figure.
- **Bids are sealed and stay sealed.** A bid is imported as a ciphertext that **only the contract**
  can compute on. It is compared inside an on-chain argmax but is **never** made decryptable to
  anyone — not even the bidder. Losing bids are private forever; you never learn how badly a
  neighbour wanted the pot.
- **Only the winner index is revealed.** The blind auction reduces to a single publicly-decryptable
  `euint32` index. The winning _amount_ is never disclosed.
- **Anti-default by design.** Every member locks **collateral** (e.g. 2× the contribution). If
  someone misses a round, anyone can slash them: their collateral makes the pot whole, and the rest
  tops up a confidential **insurance reserve**. The pot is identical whether a member paid or
  defaulted, so a default is invisible from the pot's perspective.

---

## How a round works

```
        OPEN ──────────────► RESOLVING ──────────► SETTLED ───► (next round / completed)
   contribute() + submitBid()    │                    │
   slashDefaulter() (after        │ off-chain          │ winner
   deadline)                      │ public-decrypt     │ claimPot()
                                  ▼ winner index       ▼
                            resolveRound()        finalizeRound()
                            (branchless argmax,   (KMS signature check
                             makePubliclyDecryptable)  binds index → winner)
```

1. **`createCircle(members, contribution, collateral, feeBps)`** — register the group. Inactive
   until everyone has joined.
2. **`joinCircle(circleId, encCollateral, proof)`** — lock collateral via the ERC-7984 operator
   flow. When the last member joins, the circle activates and the first deadline is set.
3. **`contribute(circleId, encAmount, proof)`** — fund the pot. An insurance fee (`feeBps`) is
   skimmed into the confidential reserve; the remainder funds the encrypted pot.
4. **`submitBid(circleId, encBid, proof)`** — submit a sealed bid for this round's pot. Past winners
   can't bid again.
5. **`slashDefaulter(circleId, member)`** — after the deadline, slash anyone who didn't pay; their
   collateral makes the pot whole.
6. **`resolveRound(circleId)`** — after the deadline, run a **branchless argmax** over the sealed
   bids and expose **only** the winning index for public decryption.
7. **off-chain `publicDecrypt(handle)`** → **`finalizeRound(circleId, clearIdx, proof)`** — the
   on-chain `FHE.checkSignatures` proves the index is the genuine KMS decryption, so no winner can be
   forged. The winner is set and granted ACL access to the pot.
8. **`claimPot(circleId)`** — the winner pulls the encrypted pot; the circle advances to the next
   round or completes.
9. **`withdrawCollateral(circleId)`** — after completion, non-defaulters reclaim their deposit.

---

## The FHE design, concretely

| Concern | Mechanism |
| --- | --- |
| No branching on ciphertext | Argmax uses `FHE.gt` + `FHE.select` to carry `bestBid` (`euint64`) and `bestIdx` (`euint32`) — no plaintext branch ever touches a bid. |
| Mandatory ACL | Bids are `allowThis` **only** → never decryptable off-chain. The pot is `allow(winner)` only **after** finalization. Stored pot/reserve are re-`allowThis`'d after each update. |
| Decryption (no oracle callback) | `FHE.makePubliclyDecryptable(idx)` → off-chain `instance.publicDecrypt([handle])` → on-chain `FHE.checkSignatures(handles, abi.encode(idx), proof)`. |
| Encrypted-input binding | External inputs bind to **one** contract. Hushpot calls `FHE.fromExternal`, then `allowTransient(amount, token)` and the token's no-proof `confidentialTransferFrom` / `confidentialTransfer`. Members `setOperator(hushpot, until)` first. |
| Money layer | The official **Sepolia cUSDT** wrapper (ERC-7984). A mintable mock stands in for local tests only. |

---

## Repository layout

```
hushpot/
├── contracts/
│   ├── Hushpot.sol            # the circle: registry, collateral, bids, argmax, slashing
│   └── mocks/                 # mintable ERC-7984 mock (local tests only)
├── deploy/00_deploy_hushpot.ts  # hardhat-deploy: real cUSDT on Sepolia, mock locally
├── tasks/hushpot.ts          # hushpot:address, hushpot:circle helper tasks
├── test/Hushpot.ts           # 33 tests incl. dedicated confidentiality proofs
├── frontend/                 # "Hushpot Desk" — React + Vite + relayer SDK (see below)
└── hardhat.config.ts
```

---

## Quick start (contracts)

### Prerequisites

- Node.js 20+
- npm

### Install, compile, test

```bash
npm install
npm run compile
npm run test          # 33 passing — Phase 1 lifecycle, bids/resolution, slashing, confidentiality
```

The confidentiality suite explicitly asserts that losing bids, the winning bid, and the reserve are
**undecryptable** by anyone, and that only the winner can decrypt the pot.

### Deploy locally

```bash
# Terminal A — FHEVM-ready local node
npm run chain
# Terminal B
npm run deploy:localhost     # deploys the mock cUSDT, then Hushpot
```

### Deploy to Sepolia

Set your secrets in Hardhat's encrypted vars store:

```bash
npx hardhat vars set MNEMONIC          # account 0 = deployer
npx hardhat vars set INFURA_API_KEY    # Sepolia RPC
npx hardhat vars set ETHERSCAN_API_KEY # optional, for verify
```

Then:

```bash
npm run deploy:sepolia
npm run verify:sepolia <HUSHPOT_ADDRESS> <CUSDT_ADDRESS>

# Helper tasks
npx hardhat hushpot:address --network sepolia
npx hardhat hushpot:circle --id 0 --network sepolia
```

The deploy uses the official Sepolia cUSDT wrapper
`0x4E7B06D78965594eB5EF5414c357ca21E1554491` (override with `CUSDT_ADDRESS` if Zama rotates it).

---

## The Hushpot Desk (frontend)

`frontend/` is **"Hushpot Desk"** — a trading-desk-style cockpit for the circle: a KPI ticker, a
seats table with status LEDs, a circle ring, a live on-chain event log, a round-state badge, and a
`⌘K` command palette. The visual moment is the **resolve sequence**: argmax → public-decrypt →
finalize, animated as the winner is revealed.

Stack: React 18 + Vite + TypeScript, ethers v6, `@zama-fhe/relayer-sdk` (WASM), MetaMask.

```bash
cd frontend
npm install
cp .env.example .env          # set VITE_HUSHPOT_ADDRESS (and VITE_CUSDT_ADDRESS if custom)
npm run dev
```

### Deploy to Vercel

The app is a static Vite SPA. `frontend/vercel.json` already sets the framework, SPA rewrites, and —
critically — the **`Cross-Origin-Opener-Policy: same-origin` + `Cross-Origin-Embedder-Policy:
require-corp`** headers the relayer SDK's WASM workers require.

1. Import the repo into Vercel and set the **Root Directory** to `frontend`.
2. Add the environment variable `VITE_HUSHPOT_ADDRESS` (your deployed Hushpot address). Optionally
   set `VITE_CUSDT_ADDRESS`.
3. Deploy. Build command `npm run build`, output `dist` (already in `vercel.json`).

---

## Deployed addresses

| Network | Contract | Address |
| --- | --- | --- |
| Sepolia | Hushpot | [`0xE48daC934ab134f800ED4356f20b01E0AD5c70f7`](https://sepolia.etherscan.io/address/0xE48daC934ab134f800ED4356f20b01E0AD5c70f7) |
| Sepolia | cUSDT (ERC-7984) | [`0x4E7B06D78965594eB5EF5414c357ca21E1554491`](https://sepolia.etherscan.io/address/0x4E7B06D78965594eB5EF5414c357ca21E1554491) |

Frontend (live): **https://hushpot-desk.vercel.app**

---

## Roadmap (Phase 2 ideas)

- **Encrypted reserve payouts** — let the insurance reserve cover a missed contribution before
  touching collateral, smoothing one-off misses.
- **Confidential bid budgets** — cap bids against a member's encrypted balance on-chain.
- **Variable contributions** — per-member encrypted plans instead of a single flat figure.
- **Reputation without disclosure** — encrypted on-time streaks that gate future circles.

---

## License

Contracts are MIT (see SPDX headers); the template tooling retains its BSD-3-Clause-Clear license.
See [LICENSE](LICENSE).

## Acknowledgements

Built on [Zama's FHEVM](https://docs.zama.ai/protocol) and
[OpenZeppelin Confidential Contracts](https://github.com/OpenZeppelin/openzeppelin-confidential-contracts).
