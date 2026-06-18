import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ethers } from "ethers";
import { HUSHPOT_ABI, CUSDT_ABI } from "./abi";
import { HUSHPOT_ADDRESS, CUSDT_ADDRESS } from "./config";
import { encryptU64, publicDecryptOne, userDecryptU64, isZeroHandle } from "./fhe";
import type { CircleView, Seat, DeskEvent } from "./types";
import type { WalletState } from "./useWallet";

const FAR_FUTURE_OPERATOR = 2_000_000_000; // uint48 deadline for setOperator
const CIRCLE_ID_KEY = "hushpot.circleId";

function shortHash(): string {
  return Math.random().toString(36).slice(2, 9);
}

/// Remember the last circle the user was looking at, so a refresh/return lands on it.
function loadCircleId(): number {
  try {
    const raw = localStorage.getItem(CIRCLE_ID_KEY);
    const n = raw === null ? 0 : Number(raw);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  } catch {
    return 0;
  }
}

export function useHushpot(wallet: WalletState) {
  const [circleId, setCircleId] = useState<number>(loadCircleId);
  const [circle, setCircle] = useState<CircleView | null>(null);
  const [seats, setSeats] = useState<Seat[]>([]);
  const [events, setEvents] = useState<DeskEvent[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [potClear, setPotClear] = useState<bigint | null>(null);
  const eventsRef = useRef<DeskEvent[]>([]);

  const log = useCallback((kind: string, text: string, txHash?: string) => {
    const e: DeskEvent = { id: shortHash(), kind, text, ts: Date.now(), txHash };
    eventsRef.current = [e, ...eventsRef.current].slice(0, 200);
    setEvents([...eventsRef.current]);
  }, []);

  const readContract = useMemo(() => {
    if (!wallet.provider || !HUSHPOT_ADDRESS) return null;
    return new ethers.Contract(HUSHPOT_ADDRESS, HUSHPOT_ABI, wallet.provider);
  }, [wallet.provider]);

  const writeContract = useMemo(() => {
    if (!wallet.signer || !HUSHPOT_ADDRESS) return null;
    return new ethers.Contract(HUSHPOT_ADDRESS, HUSHPOT_ABI, wallet.signer);
  }, [wallet.signer]);

  const token = useMemo(() => {
    if (!wallet.signer || !CUSDT_ADDRESS) return null;
    return new ethers.Contract(CUSDT_ADDRESS, CUSDT_ABI, wallet.signer);
  }, [wallet.signer]);

  /// Pull the full circle + per-seat state for the selected circle.
  const refresh = useCallback(async () => {
    if (!readContract) return;
    try {
      const c = await readContract.getCircle(circleId);
      const view: CircleView = {
        id: circleId,
        members: c.members as string[],
        contribution: c.contribution as bigint,
        collateral: c.collateral as bigint,
        feeBps: Number(c.feeBps),
        totalRounds: Number(c.totalRounds),
        currentRound: Number(c.currentRound),
        roundDeadline: Number(c.roundDeadline),
        state: Number(c.state),
        active: c.active as boolean,
        completed: c.completed as boolean,
      };
      setCircle(view);

      const round = view.currentRound;
      const you = wallet.address?.toLowerCase();
      const winner: string = await readContract.roundWinner(circleId, round);
      const seatRows = await Promise.all(
        view.members.map(async (addr, index) => {
          const [joined, paid, bid, hasWon, defaulted] = await Promise.all([
            readContract.joined(circleId, addr),
            readContract.paidThisRound(circleId, round, addr),
            readContract.bidThisRound(circleId, round, addr),
            readContract.hasWon(circleId, addr),
            readContract.defaulted(circleId, addr),
          ]);
          return {
            address: addr,
            index,
            joined: joined as boolean,
            paid: paid as boolean,
            bid: bid as boolean,
            hasWon: hasWon as boolean,
            defaulted: defaulted as boolean,
            isRoundWinner: winner.toLowerCase() === addr.toLowerCase(),
            isYou: you === addr.toLowerCase(),
          } as Seat;
        }),
      );
      setSeats(seatRows);
    } catch {
      setCircle(null);
      setSeats([]);
    }
  }, [readContract, circleId, wallet.address]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Persist the selected circle id across visits.
  useEffect(() => {
    try {
      localStorage.setItem(CIRCLE_ID_KEY, String(circleId));
    } catch {
      // ignore storage failures (private mode, quota)
    }
  }, [circleId]);

  // Subscribe to on-chain events for the live log.
  useEffect(() => {
    if (!readContract) return;
    const seatName = (addr: unknown) => {
      const a = String(addr);
      return `${a.slice(0, 6)}…${a.slice(-4)}`;
    };

    // Each formatter receives the decoded indexed args (ethers passes them positionally, then an
    // EventPayload). We read by index so unused leading args (the circleId) don't trip the linter.
    const specs: Array<[string, (a: unknown[]) => string]> = [
      ["Contributed", (a) => `${seatName(a[2])} contributed (round ${a[1]})`],
      ["SealedBidSubmitted", (a) => `${seatName(a[2])} sealed a bid (round ${a[1]})`],
      ["RoundResolving", (a) => `Round ${a[1]} resolving over ${a[2]} bidders`],
      ["WinnerRevealed", (a) => `Winner revealed: ${seatName(a[2])} (round ${a[1]})`],
      ["PotClaimed", (a) => `${seatName(a[2])} claimed the pot (round ${a[1]})`],
      ["MemberDefaulted", (a) => `${seatName(a[2])} defaulted — collateral slashed`],
      ["CollateralWithdrawn", (a) => `${seatName(a[1])} withdrew collateral`],
      ["CircleCompleted", () => `Circle completed`],
      ["CircleActivated", () => `Circle activated — round 0 open`],
    ];
    const kindOf: Record<string, string> = {
      Contributed: "contribute",
      SealedBidSubmitted: "bid",
      RoundResolving: "resolve",
      WinnerRevealed: "winner",
      PotClaimed: "claim",
      MemberDefaulted: "default",
      CollateralWithdrawn: "withdraw",
      CircleCompleted: "complete",
      CircleActivated: "active",
    };

    const registered: Array<[string, (...a: unknown[]) => void]> = specs.map(([name, fmt]) => {
      const wrapped = (...args: unknown[]) => {
        log(kindOf[name], fmt(args));
        void refresh();
      };
      readContract.on(name, wrapped);
      return [name, wrapped];
    });

    return () => {
      for (const [name, fn] of registered) readContract.off(name, fn);
    };
  }, [readContract, log, refresh]);

  /// Ensure Hushpot is an operator on cUSDT so it can pull the caller's confidential transfers.
  const ensureOperator = useCallback(async () => {
    if (!token) throw new Error("No token contract");
    const isOp = await token.isOperator(wallet.address, HUSHPOT_ADDRESS);
    if (!isOp) {
      log("operator", "Authorising Hushpot as cUSDT operator…");
      const tx = await token.setOperator(HUSHPOT_ADDRESS, FAR_FUTURE_OPERATOR);
      await tx.wait();
      log("operator", "Operator authorised", tx.hash);
    }
  }, [token, wallet.address, log]);

  const run = useCallback(
    async (label: string, fn: () => Promise<void>) => {
      setBusy(label);
      try {
        await fn();
      } catch (err: unknown) {
        const msg = (err as { shortMessage?: string; message?: string }).shortMessage ?? (err as Error).message;
        log("error", `${label} failed: ${msg}`);
      } finally {
        setBusy(null);
        await refresh();
      }
    },
    [log, refresh],
  );

  // --- Actions ---

  const createCircle = useCallback(
    (members: string[], contribution: bigint, collateral: bigint, feeBps: number) =>
      run("create", async () => {
        if (!writeContract) throw new Error("Connect a wallet");
        const tx = await writeContract.createCircle(members, contribution, collateral, feeBps);
        const rc = await tx.wait();
        log("create", `Circle created (${members.length} seats)`, rc?.hash);
      }),
    [writeContract, run, log],
  );

  const joinCircle = useCallback(
    (collateral: bigint) =>
      run("join", async () => {
        if (!writeContract || !wallet.address) throw new Error("Connect a wallet");
        await ensureOperator();
        const { handle, proof } = await encryptU64(HUSHPOT_ADDRESS, wallet.address, collateral);
        const tx = await writeContract.joinCircle(circleId, handle, proof);
        const rc = await tx.wait();
        log("join", "Collateral locked — seat taken", rc?.hash);
      }),
    [writeContract, wallet.address, circleId, ensureOperator, run, log],
  );

  const contribute = useCallback(
    (amount: bigint) =>
      run("contribute", async () => {
        if (!writeContract || !wallet.address) throw new Error("Connect a wallet");
        await ensureOperator();
        const { handle, proof } = await encryptU64(HUSHPOT_ADDRESS, wallet.address, amount);
        const tx = await writeContract.contribute(circleId, handle, proof);
        const rc = await tx.wait();
        log("contribute", "Contribution sealed into the pot", rc?.hash);
      }),
    [writeContract, wallet.address, circleId, ensureOperator, run, log],
  );

  const submitBid = useCallback(
    (amount: bigint) =>
      run("bid", async () => {
        if (!writeContract || !wallet.address) throw new Error("Connect a wallet");
        const { handle, proof } = await encryptU64(HUSHPOT_ADDRESS, wallet.address, amount);
        const tx = await writeContract.submitBid(circleId, handle, proof);
        const rc = await tx.wait();
        log("bid", "Sealed bid submitted — value stays private", rc?.hash);
      }),
    [writeContract, wallet.address, circleId, run, log],
  );

  /// The signature moment: resolve → public-decrypt the winner index → finalize on-chain.
  const resolveAndFinalize = useCallback(
    () =>
      run("resolve", async () => {
        if (!writeContract || !readContract) throw new Error("Connect a wallet");
        log("resolve", "Resolving round — running argmax over sealed bids…");
        const tx1 = await writeContract.resolveRound(circleId);
        await tx1.wait();

        const round = Number((await readContract.getCircle(circleId)).currentRound);
        const handle: string = await readContract.winnerIndexHandle(circleId, round);
        log("resolve", "Decrypting the winning index (only the index is revealed)…");
        const { clear, decryptionProof } = await publicDecryptOne(handle);

        log("resolve", `Winner index = ${clear}. Finalizing on-chain…`);
        const tx2 = await writeContract.finalizeRound(circleId, Number(clear), decryptionProof);
        const rc = await tx2.wait();
        log("winner", "Round finalized — winner sealed in", rc?.hash);
      }),
    [writeContract, readContract, circleId, run, log],
  );

  const claimPot = useCallback(
    () =>
      run("claim", async () => {
        if (!writeContract) throw new Error("Connect a wallet");
        const tx = await writeContract.claimPot(circleId);
        const rc = await tx.wait();
        log("claim", "Pot claimed", rc?.hash);
      }),
    [writeContract, circleId, run, log],
  );

  const slashDefaulter = useCallback(
    (member: string) =>
      run("slash", async () => {
        if (!writeContract) throw new Error("Connect a wallet");
        const tx = await writeContract.slashDefaulter(circleId, member);
        const rc = await tx.wait();
        log("default", "Defaulter slashed — pot made whole", rc?.hash);
      }),
    [writeContract, circleId, run, log],
  );

  const withdrawCollateral = useCallback(
    () =>
      run("withdraw", async () => {
        if (!writeContract) throw new Error("Connect a wallet");
        const tx = await writeContract.withdrawCollateral(circleId);
        const rc = await tx.wait();
        log("withdraw", "Collateral withdrawn", rc?.hash);
      }),
    [writeContract, circleId, run, log],
  );

  /// Reveal the pot amount to the connected winner via user-decryption.
  const revealPot = useCallback(async () => {
    if (!readContract || !wallet.signer) return;
    try {
      const handle: string = await readContract.potHandle(circleId);
      if (isZeroHandle(handle)) {
        setPotClear(0n);
        return;
      }
      const clear = await userDecryptU64(handle, HUSHPOT_ADDRESS, wallet.signer);
      setPotClear(clear);
      log("reveal", "Pot decrypted for you");
    } catch (err: unknown) {
      const msg = (err as { shortMessage?: string; message?: string }).shortMessage ?? (err as Error).message;
      log("error", `Pot reveal failed: ${msg}`);
    }
  }, [readContract, wallet.signer, circleId, log]);

  return {
    circleId,
    setCircleId,
    circle,
    seats,
    events,
    busy,
    potClear,
    refresh,
    createCircle,
    joinCircle,
    contribute,
    submitBid,
    resolveAndFinalize,
    claimPot,
    slashDefaulter,
    withdrawCollateral,
    revealPot,
    configured: !!HUSHPOT_ADDRESS,
  };
}
