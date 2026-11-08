export type Color =
  "castle" | "ship" | "animal" | "mine" | "knowledge" | "building";
export type Building =
  | "warehouse"
  | "workshop"
  | "church"
  | "market"
  | "boarding"
  | "bank"
  | "hall"
  | "watchtower";
export type Animal = "sheep" | "cattle" | "pig" | "chicken";
export type Ruleset = "original-2011" | "special-edition";
export interface Tile {
  id: string;
  color: Color;
  building?: Building;
  animal?: Animal;
  count?: number;
  knowledge?: number;
  black?: boolean;
}
export interface Cell {
  id: number;
  q: number;
  r: number;
  color: Color;
  die: number;
  region: number;
}
export interface Player {
  name: string;
  /** Missing in older saves: original estate #1. */
  boardId?: number;
  board: (Tile | null)[];
  storage: Tile[];
  goods: number[];
  sold: number[];
  silver: number;
  workers: number;
  score: number;
  dice: (number | null)[];
  ships: number;
  arrival: number;
  bonuses: Color[];
  final?: { goods: number; silver: number; workers: number; knowledge: number };
}
export interface Depot {
  tiles: Tile[];
  goods: number[];
}
export type Pending =
  | { kind: "take"; colors: Color[] }
  | { kind: "place" }
  | { kind: "free" }
  | { kind: "sell" }
  | { kind: "ship" }
  | { kind: "goods"; depots: number[] };
export interface GameOptions {
  playerCount?: 2 | 3 | 4;
  estates?: "beginner" | "open" | "secret";
  ruleset?: Ruleset;
}
export interface EstateChoice {
  boardId: number;
  cell: number;
}
export interface GameSetup {
  mode: "open" | "secret";
  /** Two faces of each randomly dealt physical player board. */
  boards: number[][];
  choices: (EstateChoice | null)[];
  castles: Tile[];
}
export interface State {
  version: 1;
  /** Missing in legacy saves means original 2011 rules. */
  ruleset?: Ruleset;
  rng: number;
  phase: number;
  round: number;
  players: Player[];
  depots: Depot[];
  black: Tile[];
  pools: Record<Color, Tile[]>;
  blackPool: Tile[];
  goodsPool: number[];
  phaseGoods: number[];
  whiteDie: number;
  order: number[];
  turnIndex: number;
  active: number;
  purchased: boolean;
  /** Special Edition knowledge 6 is separate from the silver purchase. */
  knowledge6Used?: boolean;
  pending: Pending[];
  claimed: Record<Color, number[]>;
  status: "setup" | "playing" | "finished";
  setup?: GameSetup;
  log: string[];
  serial: number;
  winner: number | null;
}
export type ActionKind =
  | "choose-estate"
  | "take"
  | "place"
  | "sell"
  | "workers"
  | "buy"
  | "trade"
  | "ship"
  | "goods"
  | "skip"
  | "end";
export interface Action {
  kind: ActionKind;
  boardId?: number;
  die?: number;
  depot?: number;
  tile?: string;
  cell?: number;
  good?: number;
  depots?: number[];
  types?: number[];
  discard?: string;
  cost: number;
  label: string;
}
