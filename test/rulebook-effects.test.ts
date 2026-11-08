import { describe, expect, it } from "vitest";
import { BOARD } from "../src/data";
import { applyAction, canPlace, createGame, legalActions, turnOrder } from "../src/engine";
import type { Action, Building, Color, Player, State, Tile } from "../src/types";

// Rulebook pp. 5–11. Expectations below are independent of production reward
// tables; estate #1 coordinates are fixture locations, not scoring oracles.
let serial = 0;
const tile = (color: Color, extra: Partial<Tile> = {}): Tile => ({
  id: `rulebook-effect-${++serial}`,
  color,
  ...extra,
});

function game(): State {
  const s = createGame(20260930);
  s.active = 0;
  s.order = [0, 1];
  s.turnIndex = 0;
  s.pending = [];
  s.black = [];
  s.depots = Array.from({ length: 6 }, () => ({ tiles: [], goods: [] }));
  for (const p of s.players) {
    p.goods = [0, 0, 0, 0, 0, 0];
    p.sold = [0, 0, 0, 0, 0, 0];
    p.silver = 0;
    p.workers = 0;
    p.score = 0;
    p.dice = [1, 2];
  }
  return s;
}

function teach(p: Player, ids: readonly number[]) {
  for (const knowledge of ids) {
    const cell = [12, 7, 3, 30, 34, 35].find((id) => !p.board[id]);
    if (cell === undefined) throw Error("Knowledge fixture exceeds estate capacity");
    p.board[cell] = tile("knowledge", { knowledge });
  }
}

function prepare(t: Tile, cell = 25): State {
  const s = game();
  const p = s.players[0];
  p.storage = [t];
  p.dice = [BOARD[cell].die, 2];
  // Existing connecting tiles keep the new placement legal on estate #1.
  if (cell === 6) p.board[11] = tile("building", { building: "watchtower" });
  if (cell === 27) {
    p.board[19] = tile("ship");
    p.board[20] = tile("ship");
  }
  if (cell === 30) p.board[25] = tile("building", { building: "bank" });
  return s;
}

function choice(
  s: State,
  kind: Action["kind"],
  filter: (a: Action) => boolean = () => true,
): Action {
  const a = legalActions(s).find((a) => a.kind === kind && filter(a));
  expect(a, `Expected a legal ${kind} action`).toBeDefined();
  return a!;
}

function act(
  s: State,
  kind: Action["kind"],
  filter: (a: Action) => boolean = () => true,
): State {
  return applyAction(s, choice(s, kind, filter));
}

function finish(s: State): State {
  s.phase = 4;
  s.round = 4;
  s.order = [1, 0];
  s.turnIndex = 1;
  s.active = 0;
  s.players[0].dice = [null, null];
  return act(s, "end");
}

function stockDepots(s: State) {
  const tiles: Tile[][] = [
    [tile("ship", { id: "1-ship" }), tile("building", { id: "1-building", building: "bank" })],
    [tile("castle", { id: "2-castle" }), tile("knowledge", { id: "2-knowledge", knowledge: 23 })],
    [tile("animal", { id: "3-animal", animal: "pig", count: 2 }), tile("building", { id: "3-building", building: "bank" })],
    [tile("ship", { id: "4-ship" }), tile("building", { id: "4-building", building: "bank" })],
    [tile("mine", { id: "5-mine" }), tile("knowledge", { id: "5-knowledge", knowledge: 24 })],
    [tile("animal", { id: "6-animal", animal: "sheep", count: 3 }), tile("building", { id: "6-building", building: "bank" })],
  ];
  s.depots = tiles.map((tiles) => ({ tiles, goods: [] }));
}

describe("rulebook buildings: actual bonus resolution", () => {
  it.each([
    ["workshop", ["1-building", "3-building", "4-building", "6-building"], "6-building"],
    ["church", ["2-castle", "2-knowledge", "5-mine", "5-knowledge"], "5-mine"],
    ["market", ["1-ship", "3-animal", "4-ship", "6-animal"], "6-animal"],
  ] as const)("%s takes only its allowed colours, from numbered depots into storage", (building, expected, selected) => {
    let s = prepare(tile("building", { building }));
    stockDepots(s);
    s.black = [tile("building", { building: "bank" }), tile("mine"), tile("ship")];
    s = act(s, "place", (a) => a.cell === 25 && a.die === 0);
    const offers = legalActions(s).filter((a) => a.kind === "take");
    expect(offers.map((a) => a.tile).sort()).toEqual([...expected].sort());
    expect(offers.every((a) => a.die === undefined && a.cost === 0)).toBe(true);
    const board = structuredClone(s.players[0].board);
    s = act(s, "take", (a) => a.tile === selected);
    expect(s.players[0].storage.map((t) => t.id)).toEqual([selected]);
    expect(s.players[0].board).toEqual(board);
    expect(s.depots.flatMap((d) => d.tiles).some((t) => t.id === selected)).toBe(false);
    expect(s.players[0].dice).toEqual([null, 2]);
    expect(s.players[0].workers).toBe(0);
    expect(s.pending).toEqual([]);
  });

  it.each(["warehouse", "workshop", "church", "market", "hall"] as const)(
    "%s remains buildable when its optional advantage has no target",
    (building) => {
      const t = tile("building", { building });
      let s = prepare(t);
      s = act(s, "place", (a) => a.cell === 25 && a.die === 0);
      expect(s.players[0].board[25]).toEqual(t);
      expect(legalActions(s).map((a) => a.kind)).toEqual(["skip"]);
      s = act(s, "skip");
      expect(s.pending).toEqual([]);
      expect(s.players[0].dice).toEqual([null, 2]);
      expect(s.players[0].score).toBe(0);
    },
  );

  it.each([
    [[3], 2, 0],
    [[4], 1, 1],
    [[3, 4], 2, 1],
  ] as const)("warehouse applies knowledge %j once per sale, not per goods tile", (ids, silver, workers) => {
    let s = prepare(tile("building", { building: "warehouse" }));
    teach(s.players[0], ids);
    s.players[0].goods = [0, 0, 2, 0, 0, 3];
    s = act(s, "place", (a) => a.cell === 25 && a.die === 0);
    expect(legalActions(s).filter((a) => a.kind === "sell").map((a) => a.good)).toEqual([3, 6]);
    expect(choice(s, "sell", (a) => a.good === 6)).toMatchObject({ cost: 0, die: undefined });
    s = act(s, "sell", (a) => a.good === 6);
    expect(s.players[0].goods).toEqual([0, 0, 2, 0, 0, 0]);
    expect(s.players[0].sold).toEqual([0, 0, 0, 0, 0, 3]);
    expect(s.players[0]).toMatchObject({ silver, workers, score: 6, dice: [null, 2] });
    expect(s.pending).toEqual([]);
  });

  it("knowledge 1 permits a second bank in a city; its silver buys a tile, and knowledge 22 scores only built banks", () => {
    const second = tile("building", { building: "bank" });
    const unbuilt = tile("building", { building: "bank", black: true });
    let s = prepare(second, 26);
    const p = s.players[0];
    p.board[25] = tile("building", { building: "bank" });
    expect(canPlace(p, second, 26)).toBe(false);
    teach(p, [1, 22]);
    expect(canPlace(p, second, 25)).toBe(false); // Occupied, even with knowledge 1.
    expect(canPlace(p, second, 19)).toBe(false); // Wrong colour.
    expect(canPlace(p, second, 28)).toBe(false); // No connection to the estate.
    s.black = [unbuilt];
    s = act(s, "place", (a) => a.cell === 26 && a.die === 0);
    expect(s.players[0].silver).toBe(2);
    s = act(s, "buy", (a) => a.tile === unbuilt.id);
    expect(s.players[0]).toMatchObject({ silver: 0, dice: [null, 2], storage: [unbuilt] });
    s = finish(s);
    expect(s.players[0].final?.knowledge).toBe(8);
    expect(s.players[0].score).toBe(8);
  });

  it("boarding house is not a worker action: knowledge 13/14 apply only to the following die action", () => {
    let s = prepare(tile("building", { building: "boarding" }));
    teach(s.players[0], [13, 14]);
    s.players[0].workers = 1;
    s = act(s, "place", (a) => a.cell === 25 && a.die === 0);
    expect(s.players[0]).toMatchObject({ workers: 5, silver: 0, dice: [null, 2] });
    expect(s.pending).toEqual([]);
    s = act(s, "workers");
    expect(s.players[0]).toMatchObject({ workers: 9, silver: 1, dice: [null, null] });
  });

  it("city hall's watchtower scores its own reward and the completed five-space city's phase-C reward exactly once", () => {
    let s = prepare(tile("building", { building: "hall" }));
    const p = s.players[0];
    s.phase = 2;
    p.board[24] = tile("mine");
    p.board[30] = tile("knowledge", { knowledge: 15 });
    p.board[31] = tile("building", { building: "bank" });
    p.board[32] = tile("building", { building: "church" });
    p.board[36] = tile("building", { building: "market" });
    p.storage.push(tile("building", { building: "watchtower" }));
    s = act(s, "place", (a) => a.cell === 25 && a.die === 0);
    expect(s.players[0].score).toBe(0);
    s = act(s, "place", (a) => a.cell === 26);
    expect(s.players[0].score).toBe(25); // 4 tower + 15 city + 6 phase C.
    expect(s.players[0].bonuses).toEqual([]);
    expect(s.players[0].dice).toEqual([null, 2]);
    s = act(s, "workers");
    expect(s.players[0].score).toBe(25);
  });

  it.each([
    ["building", 26], ["ship", 19], ["animal", 27],
    ["mine", 24], ["castle", 6], ["knowledge", 12],
  ] as const)("city hall can build a reserved %s with a mismatching remaining die and no workers", (color, cell) => {
    let s = prepare(tile("building", { building: "hall" }));
    const next = tile(color, {
      ...(color === "building" ? { building: "bank" as const } : {}),
      ...(color === "animal" ? { animal: "pig" as const, count: 2 } : {}),
      ...(color === "knowledge" ? { knowledge: 15 } : {}),
    });
    s.players[0].dice = [3, 3];
    s.players[0].storage.push(next);
    if (color === "castle") s.players[0].board[11] = tile("building", { building: "watchtower" });
    if (color === "animal") {
      s.players[0].board[19] = tile("ship");
      s.players[0].board[20] = tile("ship");
    }
    s = act(s, "place", (a) => a.cell === 25 && a.die === 0);
    expect(choice(s, "place", (a) => a.cell === cell)).toMatchObject({ cost: 0, die: undefined });
    s = act(s, "place", (a) => a.cell === cell);
    expect(s.players[0].board[cell]).toEqual(next);
    expect(s.players[0].storage).toEqual([]);
    expect(s.players[0].dice).toEqual([null, 3]);
    expect(s.players[0].workers).toBe(0);
  });

  it("resolves city hall → castle → warehouse → enhanced sale before returning to the remaining die", () => {
    let s = prepare(tile("building", { building: "hall" }), 13);
    teach(s.players[0], [3, 4]);
    s.players[0].storage.push(tile("castle"), tile("building", { building: "warehouse" }));
    s.players[0].goods = [0, 0, 0, 3, 0, 0];
    s = act(s, "place", (a) => a.cell === 13 && a.die === 0);
    expect(s.pending[0]?.kind).toBe("place");
    s = act(s, "place", (a) => a.cell === 6);
    expect(s.pending[0]?.kind).toBe("free");
    s = act(s, "place", (a) => a.cell === 14);
    expect(s.pending[0]?.kind).toBe("sell");
    s = act(s, "sell", (a) => a.good === 4);
    expect(s.pending).toEqual([]);
    expect(s.players[0]).toMatchObject({ score: 6, silver: 2, workers: 1, dice: [null, 2], storage: [] });
  });
});

describe("rulebook knowledge: timing and action boundaries", () => {
  it.each([[true, 3, 1], [false, 1, 0]] as const)(
    "knowledge 2 owned=%s pays only built mines in the final phase, without triggering knowledge 13/14",
    (owned, workers, workerPoints) => {
      let s = game();
      const p = s.players[0];
      teach(p, owned ? [2, 13, 14] : [13, 14]);
      p.board[24] = tile("mine");
      p.board[29] = tile("mine");
      p.storage = [tile("mine")];
      if (!owned) p.storage.push(tile("knowledge", { knowledge: 2 }));
      p.workers = 1;
      s.players[1].board[24] = tile("mine");
      s = finish(s);
      expect(s.players[0]).toMatchObject({ silver: 2, workers });
      expect(s.players[0].final).toEqual({ goods: 0, silver: 2, workers: workerPoints, knowledge: 0 });
      expect(s.players[1]).toMatchObject({ silver: 1, workers: 0 });
    },
  );

  it("knowledge 3/4/8: a sale cannot spend its future worker, and charges only the workers needed before granting one back", () => {
    let s = game();
    teach(s.players[0], [3, 4, 8]);
    s.players[0].dice = [1, null];
    s.players[0].workers = 1;
    s.players[0].goods = [0, 0, 0, 3, 0, 0];
    expect(legalActions(s).some((a) => a.kind === "sell")).toBe(false);
    s.players[0].workers = 2;
    expect(choice(s, "sell", (a) => a.good === 4).cost).toBe(2);
    s = act(s, "sell", (a) => a.good === 4);
    expect(s.players[0]).toMatchObject({ workers: 1, silver: 2, score: 6, dice: [null, null] });
    expect(s.players[0].sold).toEqual([0, 0, 0, 3, 0, 0]);
  });

  it("knowledge 5 uses the physical ring of goods spaces and shares the three-type capacity across both depots", () => {
    let s = prepare(tile("ship"), 19);
    teach(s.players[0], [5]);
    s.players[0].goods = [1, 1, 0, 0, 0, 0];
    s.depots[5].goods = [1, 4, 4];
    s.depots[0].goods = [2, 3, 4];
    s.depots[4].goods = [4, 4];
    s = act(s, "place", (a) => a.cell === 19 && a.die === 0);
    const offers = legalActions(s).filter((a) => a.kind === "ship");
    // Verified against the printed gameboard on p. 2: clockwise from top,
    // the spaces are 1, 2, 3, 4, 5, 6, not the application's rectangular grid.
    expect(offers.filter((a) => a.depots?.length === 2)
      .map((a) => a.depots!.map((i) => i + 1).sort().join("-")).sort())
      .toEqual(["1-2", "1-6", "2-3", "3-4", "4-5", "5-6"]);
    expect(offers.filter((a) => a.depots?.length === 1)).toHaveLength(6);
    s = act(s, "ship", (a) => a.depots?.includes(5) === true && a.depots.includes(0));
    expect(legalActions(s).filter((a) => a.kind === "goods")
      .map((a) => a.types).sort((a, b) => a!.join().localeCompare(b!.join())))
      .toEqual([[1, 2, 3], [1, 2, 4]]);
    s = act(s, "goods", (a) => a.types?.includes(4) === true);
    expect(s.players[0].goods).toEqual([2, 2, 0, 3, 0, 0]);
    expect(s.depots[5].goods).toEqual([]);
    expect(s.depots[0].goods).toEqual([3]);
    expect(s.depots[4].goods).toEqual([4, 4]);
    expect(s.players[0]).toMatchObject({ ships: 1, dice: [null, 2] });
  });

  it("knowledge 6 opens all seven purchase sources, uses normal reserve replacement, and shares one quota with castle actions", () => {
    let s = prepare(tile("castle"), 6);
    teach(s.players[0], [6]);
    stockDepots(s);
    s.black = [tile("mine", { black: true })];
    s.players[0].silver = 4;
    const discard = tile("animal", { animal: "cattle", count: 2 });
    const keep = tile("building", { building: "warehouse" });
    s.players[0].storage.push(discard, keep);
    const buys = legalActions(s).filter((a) => a.kind === "buy");
    expect([...new Set(buys.map((a) => a.depot))].sort()).toEqual([-1, 0, 1, 2, 3, 4, 5]);
    expect(buys.every((a) => a.discard !== undefined)).toBe(true);
    s = act(s, "buy", (a) => a.tile === "5-mine" && a.discard === discard.id);
    expect(s.players[0]).toMatchObject({ silver: 2, dice: [6, 2] });
    expect(s.players[0].storage.map((t) => t.id)).toEqual([expect.any(String), keep.id, "5-mine"]);
    expect(s.players[0].board.some((t) => t?.id === "5-mine")).toBe(false);
    s = act(s, "place", (a) => a.cell === 6 && a.die === 0);
    expect(s.pending[0]?.kind).toBe("free");
    expect(legalActions(s).some((a) => a.kind === "buy")).toBe(false);
    s = act(s, "take", (a) => a.tile === "6-building");
    expect(s.players[0].dice).toEqual([null, 2]);
    expect(s.players[0].workers).toBe(0);
    expect(legalActions(s).some((a) => a.kind === "buy")).toBe(false);
  });

  it("knowledge 7 re-scores non-touching matching tiles in the same pasture on each placement, not other animals or pastures", () => {
    let s = game();
    const p = s.players[0];
    teach(p, [7]);
    p.board[17] = tile("ship");
    p.board[16] = tile("ship");
    p.board[9] = tile("animal", { animal: "sheep", count: 3 });
    p.board[4] = tile("animal", { animal: "pig", count: 4 });
    p.board[19] = tile("ship");
    p.board[20] = tile("ship");
    p.board[27] = tile("animal", { animal: "sheep", count: 4 });
    p.storage = [tile("animal", { animal: "sheep", count: 2 }), tile("animal", { animal: "sheep", count: 4 })];
    p.dice = [6, 1];
    s = act(s, "place", (a) => a.cell === 0 && a.die === 0 && a.tile === p.storage[0].id);
    expect(s.players[0].score).toBe(7); // Two sheep tiles, five animals.
    s = act(s, "place", (a) => a.cell === 5 && a.die === 1);
    expect(s.players[0].score).toBe(19); // Three sheep tiles now score twelve more.
    expect(s.players[0].bonuses).toEqual([]);
  });

  it.each([
    [9, "building", 25, 6], [10, "ship", 19, 2], [10, "animal", 27, 5],
    [11, "castle", 6, 3], [11, "mine", 24, 1], [11, "knowledge", 30, 5],
  ] as const)("knowledge %i + 8: %s placement combines one free pip with a two-pip worker", (id, color, cell, die) => {
    const t = tile(color, {
      ...(color === "building" ? { building: "bank" as const } : {}),
      ...(color === "animal" ? { animal: "pig" as const, count: 2 } : {}),
      ...(color === "knowledge" ? { knowledge: 16 } : {}),
    });
    let s = prepare(t, cell);
    teach(s.players[0], [8, id]);
    s.players[0].dice = [die, null];
    s.players[0].workers = 1;
    const withoutWorkerBonus = structuredClone(s);
    withoutWorkerBonus.players[0].board[12] = null;
    expect(legalActions(withoutWorkerBonus).some((a) => a.kind === "place" && a.cell === cell)).toBe(false);
    expect(choice(s, "place", (a) => a.cell === cell).cost).toBe(1);
    s = act(s, "place", (a) => a.cell === cell);
    expect(s.players[0].board[cell]).toEqual(t);
    expect(s.players[0].workers).toBe(0);
    expect(s.players[0].dice).toEqual([null, null]);
  });

  it.each([[9, "ship", 19, 6], [10, "building", 25, 4], [11, "building", 25, 4], [12, "building", 25, 4]] as const)(
    "knowledge %i does not discount %s placement or goods sales outside its scope",
    (id, color, cell, die) => {
      const s = prepare(tile(color, color === "building" ? { building: "bank" } : {}), cell);
      teach(s.players[0], [id]);
      s.players[0].dice = [die, null];
      s.players[0].goods = [0, 0, 1, 0, 0, 0];
      expect(legalActions(s).some((a) => a.kind === "place" && a.cell === cell)).toBe(false);
      expect(legalActions(s).some((a) => a.kind === "sell")).toBe(false);
      if (id !== 12) {
        s.depots[die === 6 ? 0 : 4].tiles = [tile("mine")];
        expect(legalActions(s).some((a) => a.kind === "take")).toBe(false);
      }
    },
  );

  it("knowledge 11 cannot discount its own placement, but activates for the next die in the same turn", () => {
    const first = tile("knowledge", { knowledge: 11 });
    const second = tile("knowledge", { knowledge: 16 });
    let s = prepare(first, 12);
    s.players[0].storage.push(second);
    s.players[0].dice = [1, 6];
    expect(legalActions(s).some((a) => a.kind === "place" && a.tile === first.id && a.die === 1)).toBe(false);
    s = act(s, "place", (a) => a.tile === first.id && a.cell === 12 && a.die === 0);
    expect(choice(s, "place", (a) => a.tile === second.id && a.cell === 7).cost).toBe(0);
    s = act(s, "place", (a) => a.tile === second.id && a.cell === 7);
    expect(s.players[0].dice).toEqual([null, null]);
    expect(s.players[0].workers).toBe(0);
  });

  it("knowledge 12 + 8 discounts taking before worker rounding, not selling, even with a full reserve", () => {
    let s = game();
    teach(s.players[0], [12, 8]);
    const discard = tile("mine");
    s.players[0].storage = [discard, tile("castle"), tile("ship")];
    s.players[0].dice = [1, null];
    s.players[0].workers = 1;
    s.players[0].goods = [0, 0, 0, 2, 0, 0];
    const taken = tile("building", { building: "bank" });
    s.depots[3].tiles = [taken];
    expect(legalActions(s).some((a) => a.kind === "sell")).toBe(false);
    expect(choice(s, "take", (a) => a.discard === discard.id).cost).toBe(1);
    s = act(s, "take", (a) => a.discard === discard.id);
    expect(s.players[0].storage).toHaveLength(3);
    expect(s.players[0].storage.some((t) => t.id === discard.id)).toBe(false);
    expect(s.players[0].storage).toContainEqual(taken);
    expect(s.players[0]).toMatchObject({ workers: 0, silver: 0, dice: [null, null] });
  });

  it.each([[[13], 2, 1], [[14], 4, 0], [[13, 14], 4, 1]] as const)(
    "castle's free worker action receives knowledge %j without spending the remaining die",
    (ids, workers, silver) => {
      let s = prepare(tile("castle"), 6);
      teach(s.players[0], ids);
      s = act(s, "place", (a) => a.cell === 6 && a.die === 0);
      s = act(s, "workers");
      expect(s.players[0]).toMatchObject({ workers, silver, dice: [null, 2] });
      expect(s.pending).toEqual([]);
    },
  );
});

describe("rulebook knowledge: independent end-scoring cases", () => {
  it.each([[[15], 9, 29], [[25], 7, 27], [[15, 25], 16, 36]] as const)(
    "knowledge %j distinguishes sold types from sold tile counts, ignoring unsold goods and stored knowledge",
    (ids, knowledge, total) => {
      let s = game();
      const p = s.players[0];
      teach(p, ids);
      p.sold = [2, 0, 4, 0, 1, 0];
      p.goods = [1, 3, 0, 2, 0, 0];
      p.score = 14;
      p.storage = [tile("knowledge", { knowledge: ids.length === 2 ? 26 : ids[0] === 15 ? 25 : 15 }), tile("mine")];
      s = finish(s);
      expect(s.players[0].final).toEqual({ goods: 6, silver: 0, workers: 0, knowledge });
      expect(s.players[0].score).toBe(total);
    },
  );

  // Literal rulebook correspondence, deliberately not KNOWLEDGE_BUILDING.
  it.each([
    [16, "warehouse"], [17, "watchtower"], [18, "workshop"], [19, "church"],
    [20, "market"], [21, "boarding"], [22, "bank"], [23, "hall"],
  ] as const)("knowledge %i scores each built %s, excluding other buildings, reserves, and the opponent", (id, building) => {
    let s = game();
    const p = s.players[0];
    teach(p, [id]);
    p.board[25] = tile("building", { building });
    p.board[13] = tile("building", { building });
    const other: Building = building === "watchtower" ? "bank" : "watchtower";
    p.board[11] = tile("building", { building: other });
    p.storage = [tile("building", { building }), tile("knowledge", { knowledge: 15 })];
    p.sold = [3, 0, 0, 0, 0, 0];
    p.score = 20;
    s.players[1].board[25] = tile("building", { building });
    s = finish(s);
    expect(s.players[0].final).toEqual({ goods: 0, silver: 0, workers: 0, knowledge: 8 });
    expect(s.players[0].score).toBe(28);
    expect(s.players[1].final?.knowledge).toBe(0);
  });

  it("knowledge 24 counts animal species, not animal totals, tiles, or pastures; a reserved fourth species does not count", () => {
    let s = game();
    const p = s.players[0];
    teach(p, [24]);
    p.board[0] = tile("animal", { animal: "sheep", count: 4 });
    p.board[4] = tile("animal", { animal: "sheep", count: 2 });
    p.board[5] = tile("animal", { animal: "cattle", count: 3 });
    p.board[9] = tile("animal", { animal: "pig", count: 4 });
    p.board[27] = tile("animal", { animal: "cattle", count: 2 });
    p.storage = [tile("animal", { animal: "chicken", count: 4 })];
    p.score = 40;
    s = finish(s);
    expect(s.players[0].final?.knowledge).toBe(12);
    expect(s.players[0].score).toBe(52);
  });

  it.each([[0, 25], [1, 22]] as const)(
    "knowledge 26 held by claimant %i scores a large or small colour bonus, not a completed city",
    (owner, total) => {
      let s = game();
      s.phase = 4;
      s.round = 4;
      teach(s.players[owner], [26]);
      for (const who of [0, 1]) {
        s.active = who;
        s.turnIndex = who;
        const p = s.players[who];
        p.board[24] = tile("mine");
        p.board[29] = tile("mine");
        p.storage = [tile("building", { building: "watchtower" }), tile("mine")];
        p.dice = [3, 3];
        s = act(s, "place", (a) => a.cell === 11 && a.die === 0);
        expect(s.players[who].bonuses).toEqual([]);
        s = act(s, "place", (a) => a.cell === 33 && a.die === 1);
      }
      expect(s.claimed.mine).toEqual([0, 1]);
      expect(s.players.map((p) => p.score)).toEqual([20, 17]);
      s = act(s, "end");
      expect(s.players[owner].final).toEqual({ goods: 0, silver: 3, workers: 0, knowledge: 2 });
      expect(s.players[1 - owner].final?.knowledge).toBe(0);
      expect(s.players[owner].score).toBe(total);
    },
  );

  it("score ties favour more empty estate spaces before later turn order (English p. 9 erratum)", () => {
    // https://www.yucata.de/en/Rules/CastlesOfBurgundy explicitly corrects
    // the first English printing; the original German rules say 'mehr leere'.
    let s = game();
    s.players[0].board[25] = tile("building", { building: "warehouse" });
    s.players[0].arrival = 2;
    s.players[1].arrival = 1;
    expect(turnOrder(s)).toEqual([0, 1]);
    s = finish(s);
    expect(s.players.map((p) => p.score)).toEqual([0, 0]);
    expect(s.winner).toBe(1);
  });
});
