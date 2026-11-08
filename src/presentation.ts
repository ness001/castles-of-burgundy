import { KNOWLEDGE, KNOWLEDGE_BUILDING, tileName } from "./data";
import { boardFor } from "./boards";
import { applyAction } from "./engine";
import { rulesFor } from "./rules";
import type { Action, Player, Ruleset, State, Tile } from "./types";

/** Short consequences, not alternative rules: the full descriptions stay in help. */
export function tileBenefit(tile: Tile, ruleset?: Ruleset): string {
  if (tile.color === "knowledge") {
    const id = tile.knowledge!;
    const rules = rulesFor({ ruleset });
    const building = KNOWLEDGE_BUILDING[id];
    if (building) return `End: +4 VP per ${tileName({ id: "", color: "building", building }).replace("Carpenter’s ", "")}`;
    const effects: Record<number, string> = {
      1: "Repeat buildings in a city", 2: "Each phase end (including final): +1 worker per mine, alongside silver",
      3: "Sell goods: earn 2 silver", 4: "Sell goods: +1 worker",
      5: "Ships collect from 2 depots", 6: rules.knowledge6 === "worker-building" ? "2 workers: take a building / turn" : "Buy from any depot",
      7: "Animals: +1 VP per tile scored", 8: "Each worker adjusts up to 2 steps",
      9: "Build buildings: 1 free die step", 10: "Ships & animals: 1 free adjustment",
      11: "Castle, mine & knowledge: 1 free adjustment", 12: "Take: 1 free die adjustment",
      13: "Taking workers: +1 silver", 14: "Take 4 workers instead of 2",
      15: `End: +${rules.soldTypePoints} VP per goods type sold`, 24: "End: +4 VP per animal species",
      25: "End: +1 VP per goods tile sold", 26: `End: +${rules.colorBonusPoints} VP per color bonus`,
    };
    return effects[id] ?? KNOWLEDGE[id]?.description ?? "Estate advantage";
  }
  if (tile.building) return {
    warehouse: "Sell goods for free", workshop: "Free building to reserve from any numbered depot",
    church: "Free castle, mine or knowledge to reserve from any numbered depot", market: "Free ship or animal tile to reserve from any numbered depot",
    boarding: "+4 workers", bank: "+2 silver", hall: "Build 1 tile from reserve for free", watchtower: "+4 VP",
  }[tile.building];
  return { castle: "Take a free action", ship: "Collect goods · improve turn order", mine: "Each phase end: +1 silver", animal: `Score ${tile.count ?? 0} animals + same species in this connected pasture`, knowledge: "Estate advantage", building: "Building benefit" }[tile.color];
}
/** Gross sale rewards; worker adjustment costs are charged separately. */
export function saleOutcome(state: State, player: Player, good: number) {
  const count = player.goods[good - 1];
  if (!count) return { points: 0, silver: 0, workers: 0 };
  return {
    points: count * state.players.length,
    silver: player.board.some(tile => tile?.knowledge === 3) ? 2 : 1,
    workers: player.board.some(tile => tile?.knowledge === 4) ? 1 : 0,
  };
}

export interface PlacementOutcome {
  points: number;
  silver: number;
  workers: number;
  regionPoints: number;
  colorPoints: number;
  tilePoints: number;
}

/** Preview a current legal place action; rewards are gross, with no follow-up choices or future scoring. */
export function placementOutcome(state: State, action: Action): PlacementOutcome {
  if (action.kind !== "place") throw Error("Placement previews require a place action.");
  const player = state.players[state.active];
  const placed = applyAction(state, action).players[state.active];
  const points = placed.score - player.score;
  const region = regionOutcome(player, action.cell!, state.phase);
  const regionPoints = region.remaining === 1 ? region.points : 0;
  const color = placed.board[action.cell!]!.color;
  // Split only a color bonus actually awarded by the engine.
  const colorPoints = placed.bonuses.length > player.bonuses.length
    ? state.players.length + (state.claimed[color].length === 0 ? 3 : 0)
    : 0;
  return {
    points,
    silver: placed.silver - player.silver,
    workers: placed.workers - player.workers + action.cost,
    regionPoints,
    colorPoints,
    tilePoints: points - regionPoints - colorPoints,
  };
}

export function regionOutcome(player: Player, cell: number, phase: number) {
  const BOARD = boardFor(player);
  const region = BOARD.filter(c => c.region === BOARD[cell].region);
  const remaining = region.filter(c => !player.board[c.id]).length;
  const base = region.length * (region.length + 1) / 2;
  const timing = 10 - phase * 2;
  return { region: BOARD[cell].region, size: region.length, remaining, base, timing, points: base + timing };
}
