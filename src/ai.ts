import { BOARDS, boardFor } from "./boards";
import { KNOWLEDGE_BUILDING } from "./data";
import {
  actionKey,
  applyLegalAction,
  canPlace,
  knowledgeIds,
  legalActions,
} from "./engine";
import { rulesFor } from "./rules";
import type { Action, Cell, Player, State, Tile } from "./types";

// Fixed work limits, rather than a clock cutoff, keep decisions reproducible.
const BEAM = 8;
const DEPTH = 12;
const EXPANSIONS = 1100;
const regionsByBoard = new Map(
  Object.values(BOARDS).map((board) => [
    board,
    new Map(
      [...new Set(board.map((c) => c.region))].map((id) => [
        id,
        board.filter((c) => c.region === id),
      ]),
    ),
  ]),
);
const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);
const turnsLeft = (s: State) => (4 - s.phase) * 5 + 4 - s.round;

/** Deliberately whitelist public information. Even cloning the original would read secrets. */
function publicState(s: State): State {
  return structuredClone({
    version: s.version,
    ...(s.ruleset === undefined ? {} : { ruleset: s.ruleset }),
    phase: s.phase,
    round: s.round,
    players: s.players,
    depots: s.depots,
    black: s.black,
    whiteDie: s.whiteDie,
    order: s.order,
    turnIndex: s.turnIndex,
    active: s.active,
    purchased: s.purchased,
    ...(s.knowledge6Used === undefined ? {} : { knowledge6Used: s.knowledge6Used }),
    pending: s.pending,
    claimed: s.claimed,
    serial: s.serial,
    status: s.status,
    winner: s.winner,
    ...(s.status === "setup"
      ? {
          setup: {
            mode: s.setup!.mode,
            boards: s.players.map((_, i) =>
              i === s.active ? s.setup!.boards[i] : [],
            ),
            // Legal setup choices need neither concealed selections nor castle tiles.
            choices: s.players.map(() => null),
            castles: [],
          },
        }
      : {}),
    // Never advance a simulation into replenishment or another turn's dice.
    rng: 0,
    pools: {
      castle: [],
      ship: [],
      animal: [],
      mine: [],
      knowledge: [],
      building: [],
    },
    blackPool: [],
    goodsPool: [],
    phaseGoods: [],
    log: [],
  });
}

function knowledgeValue(s: State, n: number, p: Player): number {
  const horizon = Math.min(1, turnsLeft(s) / 10);
  const rules = rulesFor(s);
  if (n === 15)
    return p.sold.filter(Boolean).length * rules.soldTypePoints + horizon * 2;
  if (n >= 16 && n <= 23)
    return (
      p.board.filter((t) => t?.building === KNOWLEDGE_BUILDING[n]).length * 4 +
      horizon * 2
    );
  if (n === 24)
    return (
      new Set(p.board.filter((t) => t?.animal).map((t) => t!.animal)).size * 4 +
      horizon * 2
    );
  if (n === 25) return sum(p.sold) + horizon * 3;
  if (n === 26) return p.bonuses.length * rules.colorBonusPoints + horizon * 2;
  // Utility knowledge matters while there are still actions to exploit it.
  const utility: Record<number, number> = {
    1: 3,
    2: 2 + p.board.filter((t) => t?.color === "mine").length,
    3: 3,
    4: 2,
    5: 3,
    6: 4,
    7: 3,
    8: 5,
    9: 4,
    10: 3,
    11: 4,
    12: 5,
    13: 4,
    14: 3,
  };
  return (utility[n] ?? 0) * horizon;
}

function regionPotential(s: State, p: Player, region: Cell[]): number {
  const filled = region.filter((c) => p.board[c.id]).length;
  if (!filled || filled === region.length) return 0; // Completed VP is already in score.
  const missing = region.length - filled;
  const opportunities =
    turnsLeft(s) * 1.2 +
    p.dice.filter((v) => v !== null).length +
    s.pending.filter((b) => b.kind === "place" || b.kind === "free").length;
  const feasible = Math.min(1, opportunities / missing);
  const reward = (region.length * (region.length + 1)) / 2 + 10 - s.phase * 2;
  return reward * (filled / region.length) ** 2 * 0.72 * feasible;
}

function tileBenefit(s: State, p: Player, t: Tile): number {
  const future = turnsLeft(s);
  switch (t.color) {
    case "castle":
      return 5;
    case "mine":
      return (5 - s.phase) * 1.3;
    case "knowledge":
      return knowledgeValue(s, t.knowledge!, p) + 1;
    case "ship": {
      const leadingShips = Math.max(
        ...s.players.filter((other) => other !== p).map((other) => other.ships),
      );
      return (
        1.5 +
        Math.min(4, Math.max(0, ...s.depots.map((d) => d.goods.length))) +
        (p.ships <= leadingShips && p.ships + 1 >= leadingShips
          ? Math.min(3, future * 0.4)
          : 0)
      );
    }
    case "animal":
      return t.count ?? 0;
    case "building":
      switch (t.building) {
        case "watchtower":
          return 4;
        case "bank":
          return 2.8;
        case "boarding":
          return p.workers < 4 && future > 0 ? 4 : 2;
        case "warehouse":
          return Math.max(0, ...p.goods) + (p.goods.some(Boolean) ? 1 : 0);
        case "hall":
          return p.storage.some((other) => other.id !== t.id) ? 4.5 : 0;
        case "workshop":
        case "church":
        case "market":
          return 3;
      }
  }
  return 0;
}

function placementValue(s: State, p: Player, t: Tile, cell: Cell): number {
  const board = boardFor(p);
  const region = regionsByBoard.get(board)!.get(cell.region)!;
  const missing = region.filter((c) => !p.board[c.id]).length;
  const reward = (region.length * (region.length + 1)) / 2 + 10 - s.phase * 2;
  let value = tileBenefit(s, p, t) + reward / (missing * 1.6);
  if (missing === 1)
    value = tileBenefit(s, p, t) + reward - regionPotential(s, p, region);
  if (t.color === "animal")
    value += sum(
      region
        .map((c) => p.board[c.id])
        .filter((other) => other?.animal === t.animal)
        .map((other) => other!.count ?? 0),
    );
  if (
    s.claimed[t.color].length < 2 &&
    board.filter((c) => c.color === t.color && !p.board[c.id]).length === 1
  )
    value += s.players.length + (s.claimed[t.color].length === 0 ? 3 : 0);
  return value;
}

function storedValue(s: State, p: Player, t: Tile): number {
  const board = boardFor(p);
  let best = 0;
  // Placement legality belongs to the engine, including building restrictions and adjacency.
  for (const c of board)
    if (canPlace(p, t, c.id)) best = Math.max(best, placementValue(s, p, t, c));
  // A reserve still costs a placement action and competes with other reserves
  // for the same cells/rewards. Overcrediting its best hypothetical placement
  // makes building it look like a loss, so the search keeps it and farms workers.
  if (best) return best * 0.25;
  return turnsLeft(s) > 3 &&
    board.some((c) => c.color === t.color && !p.board[c.id])
    ? 0.3
    : 0;
}

function evaluate(s: State, who: number): number {
  const p = s.players[who];
  if (s.status === "finished") return p.score;
  const future = turnsLeft(s);
  const dice = p.dice.filter((v) => v !== null).length;
  const freePlacements = s.pending.filter(
    (b) => b.kind === "place" || b.kind === "free",
  ).length;
  const horizon = Math.min(1, (future * 2 + dice + freePlacements) / 8);
  let value = p.score + p.silver + Math.floor(p.workers / 2) + sum(p.goods);
  value += Math.min(4, p.silver) * 0.25 * horizon;
  value += Math.min(6, p.workers) * 0.6 * horizon;
  value += sum(p.goods) * 0.6 * horizon;
  value += sum(knowledgeIds(p).map((n) => knowledgeValue(s, n, p)));
  value +=
    p.board.filter((t) => t?.color === "mine").length *
    (5 - s.phase) *
    (knowledgeIds(p).includes(2) ? 1.7 : 1.2);
  value += sum(
    [...regionsByBoard.get(boardFor(p))!.values()].map((r) =>
      regionPotential(s, p, r),
    ),
  );
  value += p.board.filter(Boolean).length * 0.45 * horizon;
  const ahead = s.players.every(
    (rival, i) =>
      i === who ||
      p.ships > rival.ships ||
      (p.ships === rival.ships && p.arrival > rival.arrival),
  );
  value += (ahead ? 2.5 : 0) * Math.min(1, future / 6);
  const storage = p.storage
    .map((t) => storedValue(s, p, t))
    .sort((a, b) => b - a);
  const capacity = Math.min(3, future * 2 + dice + freePlacements);
  value += sum(storage.slice(0, capacity));
  // Only used at the bounded frontier, not a claim that a pending bonus has resolved.
  value +=
    dice * 2.4 +
    s.pending.reduce(
      (v, b) =>
        v +
        (b.kind === "free"
          ? 3.5
          : b.kind === "place"
            ? 2.5
            : b.kind === "take"
              ? 1.5
              : 0),
      0,
    );
  return value;
}

/** Rank cheaply before cloning. Keep alternatives for each die and action kind. */
function candidates(s: State, actions: Action[], limit: number): Action[] {
  if (actions.length <= limit) return actions;
  const p = s.players[s.active];
  const board = boardFor(p);
  const tiles = new Map(
    [...p.storage, ...s.black, ...s.depots.flatMap((d) => d.tiles)].map((t) => [
      t.id,
      t,
    ]),
  );
  const values = new Map<string, number>();
  const valueOf = (id: string) => {
    if (!values.has(id)) values.set(id, storedValue(s, p, tiles.get(id)!));
    return values.get(id)!;
  };
  const rank = (a: Action): number => {
    let value = -a.cost * 1.1;
    if (a.kind === "take" || a.kind === "buy" || a.kind === "trade")
      value +=
        valueOf(a.tile!) -
        (a.discard ? valueOf(a.discard) : 0) -
        (a.kind === "buy" ? 2 : 0);
    if (a.kind === "place")
      value += placementValue(s, p, tiles.get(a.tile!)!, board[a.cell!]);
    if (a.kind === "sell") value += p.goods[a.good! - 1] + 1.2;
    if (a.kind === "workers") value += p.workers < 4 ? 2.5 : 1;
    if (a.kind === "ship")
      value += sum(a.depots!.map((i) => s.depots[i].goods.length));
    if (a.kind === "goods" && s.pending[0]?.kind === "goods")
      value += sum(
        s.pending[0].depots.map(
          (i) => s.depots[i].goods.filter((g) => a.types!.includes(g)).length,
        ),
      );
    return value;
  };
  const ranked = actions
    .map((a) => ({ a, value: rank(a) }))
    .sort((a, b) => b.value - a.value);
  const selected = new Set<Action>();
  const groups = new Set<string>();
  for (const { a } of ranked) {
    const group = `${a.kind}:${a.die ?? "bonus"}`;
    if (!groups.has(group)) {
      groups.add(group);
      selected.add(a);
    }
  }
  for (const { a } of ranked) {
    if (selected.size >= limit) break;
    selected.add(a);
  }
  return [...selected];
}

interface Node {
  state: State;
  first: Action;
  value: number;
  key: string;
  steps: number;
}
const better = (a: Node, b: Node) =>
  b.value - a.value || a.steps - b.steps || a.key.localeCompare(b.key);

/** Search the current public turn only, including purchases and nested bonus choices. */
export function chooseAction(state: State): Action {
  const root = publicState(state);
  const actions = legalActions(root);
  if (!actions.length) throw new Error("No legal action is available.");
  if (actions.length === 1) return actions[0];
  if (root.status === "setup") {
    // Prefer a central start using only the player's own printed estate.
    // Never simulate setup completion: it reveals choices and rolls the first turn.
    const distance = (a: Action) => {
      const { q, r } = boardFor({ boardId: a.boardId })[a.cell!];
      return Math.max(Math.abs(q), Math.abs(r), Math.abs(q + r));
    };
    return actions.sort((a, b) => distance(a) - distance(b))[0];
  }
  const who = root.active;
  let beam: Node[] = [];
  let best: Node | undefined;
  let expansions = 0;
  for (let depth = 0; depth < DEPTH && expansions < EXPANSIONS; depth++) {
    const next: Node[] = [];
    const parents =
      depth === 0
        ? [{ state: root, first: actions[0], value: 0, key: "", steps: 0 }]
        : beam;
    for (const parent of parents) {
      const s = parent.state;
      const available = depth === 0 ? actions : legalActions(s);
      for (const action of candidates(s, available, depth === 0 ? 40 : 12)) {
        if (expansions++ >= EXPANSIONS) break;
        const first = depth === 0 ? action : parent.first;
        const key = depth === 0 ? actionKey(first) : parent.key;
        // Even an ordinary end that only switches player is outside our search boundary.
        const finalEnd =
          action.kind === "end" &&
          s.phase === 4 &&
          s.round === 4 &&
          s.turnIndex === s.order.length - 1;
        const child =
          action.kind === "end" && !finalEnd ? s : applyLegalAction(s, action);
        const node: Node = {
          state: child,
          first,
          key,
          value: evaluate(child, who),
          steps: depth + 1,
        };
        const terminal =
          action.kind === "end" ||
          child.status === "finished" ||
          child.active !== who ||
          child.phase !== root.phase ||
          child.round !== root.round;
        if (terminal) {
          if (!best || better(node, best) < 0) best = node;
        } else next.push(node);
      }
    }
    next.sort(better);
    // Equivalent orderings of dice/purchases should not occupy the whole beam.
    const seen = new Set<string>();
    beam = [];
    for (const node of next) {
      const s = node.state;
      const signature = JSON.stringify([
        s.players[who],
        s.depots,
        s.black,
        s.pending,
        s.purchased,
        s.knowledge6Used,
      ]);
      if (seen.has(signature)) continue;
      seen.add(signature);
      beam.push(node);
      if (beam.length === BEAM) break;
    }
    if (!beam.length) break;
  }
  // Deep chains may exceed the horizon; the next real move replans from its actual state.
  for (const node of beam) if (!best || better(node, best) < 0) best = node;
  return best?.first ?? actions[0];
}
