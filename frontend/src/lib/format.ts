import { ethers } from "ethers";
import { TOKEN_DECIMALS } from "./config";

export function shortAddr(a?: string | null): string {
  if (!a) return "—";
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

export function fmtToken(v: bigint | null | undefined): string {
  if (v === null || v === undefined) return "•••";
  return ethers.formatUnits(v, TOKEN_DECIMALS);
}

export function parseToken(s: string): bigint {
  return ethers.parseUnits(s.trim() || "0", TOKEN_DECIMALS);
}

export function fmtTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour12: false });
}

export function fmtDeadline(unix: number): string {
  if (!unix) return "—";
  const d = new Date(unix * 1000);
  const now = Date.now();
  const diff = d.getTime() - now;
  if (diff <= 0) return "passed";
  const h = Math.floor(diff / 3_600_000);
  const m = Math.floor((diff % 3_600_000) / 60_000);
  if (h >= 24) return `${Math.floor(h / 24)}d ${h % 24}h`;
  return `${h}h ${m}m`;
}
