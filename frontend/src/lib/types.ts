// Shared view-model types for the Desk.

export type CircleView = {
  id: number;
  members: string[];
  contribution: bigint;
  collateral: bigint;
  feeBps: number;
  totalRounds: number;
  currentRound: number;
  roundDeadline: number;
  roundDuration: number;
  state: number;
  active: boolean;
  completed: boolean;
};

export type SeatStatus = "idle" | "paid" | "bid" | "won" | "defaulted" | "winner";

export type Seat = {
  address: string;
  index: number;
  joined: boolean;
  paid: boolean;
  bid: boolean;
  hasWon: boolean;
  defaulted: boolean;
  isRoundWinner: boolean;
  isYou: boolean;
};

export type DeskEvent = {
  id: string;
  kind: string;
  text: string;
  ts: number;
  txHash?: string;
};
