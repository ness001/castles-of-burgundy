import { boardFor } from "./boards";
import { finalKnowledgeScores, turnOrder } from "./engine";
import { knowledgeInfo } from "./data";
import type { Action, State, Tile } from "./types";

export interface FinalScoringStep {
  key: string;
  label: string;
  gains: { player: number; points: number }[];
}

/** Present the committed ledger; knowledge formulas are shared with the engine. */
export function finalScoringSteps(state: State): FinalScoringStep[] {
  if (state.status !== "finished") return [];
  const steps: FinalScoringStep[] = (["goods", "silver", "workers"] as const).map(key => ({
    key, label: key === "goods" ? "Unsold goods" : key === "silver" ? "Silver (including final mine income)" : "Worker pairs",
    gains: state.players.map((player, index) => ({ player: index, points: player.final?.[key] ?? 0 })),
  })).filter(step => step.gains.some(gain => gain.points > 0));
  const knowledge = state.players.map(player => finalKnowledgeScores(player, state.ruleset));
  const ids = [...new Set(knowledge.flatMap(entries => entries.map(entry => entry.knowledge)))].sort((a, b) => a - b);
  for (const id of ids) steps.push({
    key: `knowledge-${id}`, label: `Knowledge ${id} · ${knowledgeInfo(id, state.ruleset).name}`,
    gains: knowledge.flatMap((entries, player) => {
      const matching = entries.filter(entry => entry.knowledge === id);
      return matching.length ? [{ player, points: matching.reduce((total, entry) => total + entry.points, 0) }] : [];
    }),
  });
  return steps;
}

export interface MotionPlan {
  actor: number;
  roll: boolean;
  phaseChanged: boolean;
  tile?: { tile: Tile; from: "depot" | "black" | "reserve"; depot?: number; cell?: number };
  regions: { player: number; cells: number[]; points: number }[];
  /** Previously placed matching tiles, excluding cell; knowledge 7 changes points, not the herd. */
  animals?: { player: number; cell: number; matching: number[] };
  freeAction: boolean;
  silver: { player: number; amount: number; source: "mines" | "bank" | "sale" | "workers" | "other"; cells: number[] }[];
  /** Signed committed net changes; omitted when every worker balance is unchanged. */
  workers?: { player: number; amount: number }[];
  scores: { player: number; amount: number }[];
  goods: { player: number; type: number; amount: number; depots: number[] }[];
  /** Track positions are ship counts; order is the next round's order, not State.order. */
  ship?: { player: number; from: number; to: number; order: number[] };
}

function movedTile(previous: State, action: Action, next: State): MotionPlan["tile"] {
  const before = previous.players[previous.active], after = next.players[previous.active];
  if (action.kind === "place" && action.cell !== undefined) {
    const tile = after.board[action.cell];
    if (tile && tile.id === action.tile && !before.board[action.cell] &&
        before.storage.some(t => t.id === action.tile) && !after.storage.some(t => t.id === action.tile))
      return { tile, from: "reserve", cell: action.cell };
  }
  if (action.kind !== "take" && action.kind !== "buy" && action.kind !== "trade") return;
  const tile = after.storage.find(t => t.id === action.tile);
  if (!tile || before.storage.some(t => t.id === tile.id)) return;
  // Knowledge 6 permits buying from numbered depots. Tile.black is not its origin.
  const depot = previous.depots.findIndex((d, index) =>
    d.tiles.some(t => t.id === tile.id) && !next.depots[index].tiles.some(t => t.id === tile.id));
  if (depot !== -1) return { tile, from: "depot", depot };
  if (action.kind === "buy" && previous.black.some(t => t.id === tile.id) &&
      !next.black.some(t => t.id === tile.id)) return { tile, from: "black" };
}

const countGoods = (goods: number[], type: number) => goods.filter(good => good === type).length;

/** Derive effects from forward committed deltas, never by replaying the engine. */
export function motionForAction(previous: State, action: Action, next: State): MotionPlan {
  const actor = previous.active;
  const plan: MotionPlan = {
    actor, roll: false, phaseChanged: false, regions: [], freeAction: false,
    silver: [], scores: [], goods: [],
  };
  const before = previous.players[actor], after = next.players[actor];
  if (previous === next || !before || !after || previous.players.length !== next.players.length) return plan;

  if (previous.status === "setup") {
    // Settling starting castles is not a placement/reward, even in open setup.
    plan.roll = action.kind === "choose-estate" && next.status === "playing" &&
      previous.turnIndex === previous.order.length - 1 && next.turnIndex === 0 &&
      next.phase === 0 && next.round === 0 && previous.setup?.choices[actor] === null &&
      action.cell !== undefined && after.boardId === action.boardId &&
      after.board[action.cell]?.id === previous.setup?.castles[actor].id;
    return plan;
  }
  if (previous.status !== "playing" || next.status === "setup") return plan;

  let phaseEnd = false;
  if (action.kind === "end") {
    // Ordinary end-turn never rolls, even when the next player has unused dice.
    if (previous.pending.length || before.dice.some(die => die !== null) ||
        previous.turnIndex !== previous.order.length - 1) return plan;
    phaseEnd = previous.round === 4;
    const finished = phaseEnd && previous.phase === 4;
    if (finished) {
      if (next.status !== "finished" || next.phase !== previous.phase || next.round !== previous.round ||
          next.turnIndex !== previous.turnIndex + 1) return plan;
    } else {
      if (next.status !== "playing" || next.phase !== previous.phase + Number(phaseEnd) ||
          next.round !== (phaseEnd ? 0 : previous.round + 1) || next.turnIndex !== 0 ||
          next.active !== next.order[0]) return plan;
      plan.roll = true;
      plan.phaseChanged = phaseEnd;
    }
  } else {
    if (next.status !== "playing" || next.phase !== previous.phase || next.round !== previous.round ||
        next.active !== actor || next.turnIndex !== previous.turnIndex || after.boardId !== before.boardId) return plan;
    const tile = movedTile(previous, action, next);
    const sold = action.kind === "sell" && action.good !== undefined &&
      before.goods[action.good - 1] > after.goods[action.good - 1] &&
      after.sold[action.good - 1] > before.sold[action.good - 1];
    const workers = action.kind === "workers" && after.workers > before.workers &&
      (previous.pending[0]?.kind === "free"
        ? next.pending.length === previous.pending.length - 1
        : action.die !== undefined && before.dice[action.die] != null && after.dice[action.die] === null);
    const loaded = (action.kind === "goods" && previous.pending[0]?.kind === "goods" ||
      action.kind === "ship" && previous.pending[0]?.kind === "ship") &&
      after.goods.some((amount, index) => amount > before.goods[index] && previous.depots.some((d, depot) =>
        countGoods(d.goods, index + 1) > countGoods(next.depots[depot].goods, index + 1)));
    if (!tile && !sold && !workers && !loaded) return plan;
    if (tile) plan.tile = tile;
  }

  const placement = plan.tile?.from === "reserve" ? plan.tile : undefined;
  if (placement && placement.cell !== undefined) {
    const cell = placement.cell, board = boardFor(after);
    const region = board.filter(c => c.region === board[cell].region);
    if (region.some(c => !before.board[c.id]) && region.every(c => after.board[c.id]))
      plan.regions.push({ player: actor, cells: region.map(c => c.id),
        points: region.length * (region.length + 1) / 2 + 10 - previous.phase * 2 });
    if (placement.tile.color === "animal") {
      plan.animals = { player: actor, cell, matching: region
        .filter(c => c.id !== cell && before.board[c.id]?.animal === placement.tile.animal &&
          after.board[c.id]?.animal === placement.tile.animal)
        .map(c => c.id) };
    }
    plan.freeAction = placement.tile.color === "castle" && next.pending[0]?.kind === "free";
    if (placement.tile.color === "ship" && after.ships > before.ships)
      plan.ship = { player: actor, from: before.ships, to: after.ships, order: turnOrder(next) };
  }

  for (const [player, current] of next.players.entries()) {
    const prior = previous.players[player];
    const workers = current.workers - prior.workers;
    if (workers !== 0) (plan.workers ??= []).push({ player, amount: workers });
    const silver = current.silver - prior.silver;
    if (silver > 0) {
      let source: MotionPlan["silver"][number]["source"] = "other";
      let cells: number[] = [];
      if (phaseEnd) {
        cells = prior.board.flatMap((tile, cell) => tile?.color === "mine" ? [cell] : []);
        if (cells.length) source = "mines";
      } else if (player === actor) {
        if (placement?.tile.building === "bank") {
          source = "bank";
          cells = [placement.cell!];
        } else if (action.kind === "sell") source = "sale";
        else if (action.kind === "workers") {
          cells = prior.board.flatMap((tile, cell) => tile?.knowledge === 13 ? [cell] : []);
          if (cells.length) source = "workers";
        }
      }
      plan.silver.push({ player, amount: silver, source, cells });
    }
    const score = current.score - prior.score;
    if (score > 0) plan.scores.push({ player, amount: score });
    current.goods.forEach((count, index) => {
      const amount = count - prior.goods[index], type = index + 1;
      if (amount < 0 && action.kind === "sell")
        plan.goods.push({ player, type, amount, depots: [] });
      else if (amount > 0 && (action.kind === "goods" || action.kind === "ship")) {
        const depots = previous.depots.flatMap((depot, id) =>
          countGoods(depot.goods, type) > countGoods(next.depots[id].goods, type) ? [id] : []);
        plan.goods.push({ player, type, amount, depots });
      }
    });
  }
  return plan;
}
