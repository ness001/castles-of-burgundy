import { describe, expect, it, vi } from "vitest";
import { boardFor } from "../src/boards";
import { applyAction, createGame, legalActions, turnOrder } from "../src/engine";
import { motionForAction } from "../src/motion-events";
import type { Action, Color, State, Tile } from "../src/types";

const tile = (id: string, color: Color, extra: Partial<Tile> = {}): Tile => ({ id, color, ...extra });
const empty = (actor: number) => ({
  actor, roll: false, phaseChanged: false, regions: [], freeAction: false,
  silver: [], scores: [], goods: [],
});

function game(playerCount: 2 | 3 | 4 = 2): State {
  const state = createGame(20260930, { playerCount });
  state.active = 0;
  state.order = state.players.map((_, index) => index);
  state.turnIndex = 0;
  for (const player of state.players) {
    player.dice = [1, 2];
    player.workers = 8;
    player.silver = 3;
    player.goods.fill(0);
    player.sold.fill(0);
  }
  return state;
}

function choice(state: State, kind: Action["kind"], match: (action: Action) => boolean = () => true): Action {
  const action = legalActions(state).find(action => action.kind === kind && match(action));
  expect(action, `Expected legal ${kind}`).toBeDefined();
  return action!;
}

function commit(state: State, kind: Action["kind"], match: (action: Action) => boolean = () => true) {
  const action = choice(state, kind, match);
  const next = applyAction(state, action);
  return { action, next, plan: motionForAction(state, action, next) };
}

function reserve(state: State, placed: Tile, cell: number) {
  const player = state.players[state.active];
  player.storage = [placed];
  player.dice = [boardFor(player)[cell].die, 2];
}

describe("committed round and setup effects", () => {
  it("does not roll for consumed dice, worker adjustments, or an ordinary end-turn", () => {
    let state = game();
    for (const die of [0, 1]) {
      const { next, plan } = commit(state, "workers", action => action.die === die);
      expect(plan).toEqual({ ...empty(0), workers: [{ player: 0, amount: 2 }] });
      state = next;
    }
    const ended = commit(state, "end");
    expect(ended.next.active).toBe(1);
    expect(ended.next.players[1].dice).toEqual([1, 2]);
    expect(ended.plan).toEqual(empty(0));

    const adjusted = structuredClone(ended.next);
    adjusted.players[1].dice[0] = 6;
    adjusted.players[1].workers--;
    expect(motionForAction(ended.next, choice(ended.next, "workers"), adjusted)).toEqual(empty(1));
  });

  it("rolls only when the last end-turn begins the next round, not on restore", () => {
    const state = game();
    state.active = 1;
    state.turnIndex = 1;
    state.players[1].dice = [null, null];
    const { next, action, plan } = commit(state, "end");
    expect(next.round).toBe(1);
    expect(plan).toEqual({ ...empty(1), roll: true });
    expect(motionForAction(next, action, state)).toEqual(empty(next.active));
    expect(motionForAction(next, action, structuredClone(next))).toEqual(empty(next.active));
  });

  it.each(["open", "secret"] as const)("keeps %s setup choices silent until the actual start", estates => {
    let state = createGame(998, { playerCount: 3, estates });
    for (let turn = 0; turn < 3; turn++) {
      const { next, plan, action } = commit(state, "choose-estate");
      expect(plan).toEqual({ ...empty(state.active), roll: turn === 2 });
      expect(motionForAction(next, action, state)).toEqual(empty(next.active));
      expect(motionForAction(next, action, structuredClone(next))).toEqual(empty(next.active));
      state = next;
    }
    expect(state.status).toBe("playing");
  });
});

describe("tile origins and placement consequences", () => {
  it.each([
    { kind: "take" as const, depot: 2, from: "depot" },
    { kind: "buy" as const, depot: -1, from: "black" },
    { kind: "buy" as const, depot: 4, from: "depot" },
  ])("moves $kind from its real $from origin, including reserve replacement", ({ kind, depot, from }) => {
    const state = game(), player = state.players[0];
    // Deliberately different from the origin: a flag must not identify a depot.
    const taken = tile("taken", "ship", { black: depot !== -1 });
    if (depot === -1) state.black = [taken];
    else state.depots[depot].tiles = [taken];
    player.board[12] = tile("knowledge-6", "knowledge", { knowledge: 6 });
    player.storage = [tile("discard", "mine"), tile("keep-1", "ship"), tile("keep-2", "castle")];
    const { next, action, plan } = commit(state, kind, action => action.tile === taken.id && action.discard === "discard");
    expect(next.players[0].storage.map(t => t.id)).toEqual(["keep-1", "keep-2", "taken"]);
    expect(plan).toEqual({ ...empty(0), tile: { tile: taken, from, ...(depot === -1 ? {} : { depot }) },
      ...(kind === "take" ? { workers: [{ player: 0, amount: -2 }] } : {}),
    });
    // Undoing a purchase restores silver, but is not a gain or another take.
    expect(motionForAction(next, action, state)).toEqual(empty(0));
  });

  it("reports only the newly finished region, separately from the actual score gain", () => {
    const state = game(), player = state.players[0];
    state.phase = 2;
    for (const [cell, building] of [[25, "hall"], [31, "bank"], [32, "church"], [36, "market"]] as const)
      player.board[cell] = tile(`city-${cell}`, "building", { building });
    const tower = tile("tower", "building", { building: "watchtower" });
    reserve(state, tower, 26);
    const { next, plan } = commit(state, "place", action => action.cell === 26);
    expect(plan).toEqual({ ...empty(0),
      tile: { tile: tower, from: "reserve", cell: 26 },
      regions: [{ player: 0, cells: [25, 26, 31, 32, 36], points: 21 }],
      scores: [{ player: 0, amount: 25 }],
    });
    expect(commit(next, "workers").plan).toEqual({ ...empty(0), workers: [{ player: 0, amount: 2 }] });
  });

  it("uses the player's alternate estate for a single-cell region", () => {
    const state = game();
    state.phase = 3;
    state.players[0].boardId = 6;
    reserve(state, tile("estate-6-mine", "mine"), 11);
    const { plan } = commit(state, "place", action => action.cell === 11);
    expect(plan.regions).toEqual([{ player: 0, cells: [11], points: 5 }]);
    expect(plan.scores).toEqual([{ player: 0, amount: 5 }]);
    expect(plan.silver).toEqual([]);
  });

  it.each([false, true])("finds the whole matching pasture, not nearby/different herds (knowledge 7: %s)", knowledge => {
    const state = game(), player = state.players[0];
    for (const cell of [16, 17, 19, 20]) player.board[cell] = tile(`ship-${cell}`, "ship");
    player.board[4] = tile("pig", "animal", { animal: "pig", count: 4 });
    player.board[9] = tile("distant-sheep", "animal", { animal: "sheep", count: 3 });
    player.board[27] = tile("other-pasture-sheep", "animal", { animal: "sheep", count: 4 });
    if (knowledge) player.board[12] = tile("knowledge-7", "knowledge", { knowledge: 7 });
    reserve(state, tile("new-sheep", "animal", { animal: "sheep", count: 2 }), 0);
    player.storage.push(tile("more-sheep", "animal", { animal: "sheep", count: 4 }));
    player.dice[1] = 1;
    const first = commit(state, "place", action => action.cell === 0 && action.tile === "new-sheep");
    expect(first.plan.animals).toEqual({ player: 0, cell: 0, matching: [9] });
    expect(first.plan.scores).toEqual([{ player: 0, amount: knowledge ? 7 : 5 }]);
    const second = commit(first.next, "place", action => action.cell === 5);
    expect(second.plan.animals).toEqual({ player: 0, cell: 5, matching: [0, 9] });
    expect(second.plan.scores).toEqual([{ player: 0, amount: knowledge ? 12 : 9 }]);
    expect(second.plan.regions).toEqual([]);
  });

  it.each([false, true])("announces a new castle action even when replacing an existing free action (%s)", nested => {
    const state = game();
    state.players[0].board[11] = tile("connector", "building", { building: "watchtower" });
    reserve(state, tile("castle", "castle"), 6);
    if (nested) state.pending = [{ kind: "free" }];
    const { next, action, plan } = commit(state, "place", action => action.cell === 6);
    expect(plan.freeAction).toBe(true);
    expect(plan.roll).toBe(false);
    expect(motionForAction(next, action, structuredClone(next))).toEqual(empty(0));
    const purchase = commit(next, "buy");
    expect(purchase.next.pending).toEqual(next.pending);
    expect(purchase.plan.freeAction).toBe(false);
  });

  it("moves the ship marker and computes next-round order, including arrival ties", () => {
    const state = game(4);
    state.active = 2;
    state.turnIndex = 2;
    state.serial = 10;
    state.players.forEach((player, id) => { player.ships = id === 2 ? 0 : 1; player.arrival = id + 1; });
    reserve(state, tile("new-ship", "ship"), 19);
    const { next, plan } = commit(state, "place", action => action.cell === 19);
    expect(next.order).toEqual([0, 1, 2, 3]);
    expect(plan.ship).toEqual({ player: 2, from: 0, to: 1, order: [2, 3, 1, 0] });
    expect(plan.ship!.order).toEqual(turnOrder(next));
    expect(plan.freeAction).toBe(false);
    expect(plan.goods).toEqual([]);
    expect(plan.roll).toBe(false);
  });
});

describe("committed resource deltas", () => {
  it.each([0, 4])("groups all players' mine income at phase %i end, including the final payout", phase => {
    const state = game(4);
    state.phase = phase;
    state.round = 4;
    state.active = 3;
    state.turnIndex = 3;
    const mines = [[24, 29], [24], [], [24, 29, 33]];
    state.players.forEach((player, id) => {
      player.dice = [null, null];
      player.silver = 0;
      player.workers = 0;
      for (const cell of mines[id]) player.board[cell] = tile(`mine-${id}-${cell}`, "mine");
    });
    state.players[3].board[12] = tile("knowledge-2", "knowledge", { knowledge: 2 });
    const { next, plan } = commit(state, "end");
    expect(plan.silver).toEqual([
      { player: 0, amount: 2, source: "mines", cells: [24, 29] },
      { player: 1, amount: 1, source: "mines", cells: [24] },
      { player: 3, amount: 3, source: "mines", cells: [24, 29, 33] },
    ]);
    expect(plan.roll).toBe(phase === 0);
    expect(plan.phaseChanged).toBe(phase === 0);
    expect(next.status).toBe(phase === 0 ? "playing" : "finished");
    expect(plan.scores).toEqual(phase === 0 ? [] : [
      { player: 0, amount: 2 }, { player: 1, amount: 1 }, { player: 3, amount: 4 },
    ]);
    expect(plan.regions).toEqual([]);
  });

  it.each([false, true])("groups sale silver, scores and negative goods deltas (enhanced warehouse sale: %s)", enhanced => {
    const state = game(3);
    state.active = 1;
    state.turnIndex = 1;
    state.players[1].goods[2] = 4;
    state.players[1].dice[0] = 3;
    if (enhanced) {
      state.pending = [{ kind: "sell" }];
      state.players[1].board[12] = tile("knowledge-3", "knowledge", { knowledge: 3 });
    }
    const { next, action, plan } = commit(state, "sell", action => action.good === 3);
    expect(plan).toEqual({ ...empty(1),
      silver: [{ player: 1, amount: enhanced ? 2 : 1, source: "sale", cells: [] }],
      scores: [{ player: 1, amount: 12 }],
      goods: [{ player: 1, type: 3, amount: -4, depots: [] }],
    });
    expect(motionForAction(next, action, state)).toEqual(empty(1));
  });

  it("attributes bank and knowledge 13 gains to the actual granting cells", () => {
    const state = game();
    state.players[0].board[12] = tile("knowledge-13", "knowledge", { knowledge: 13 });
    state.players[0].board[7] = tile("knowledge-14", "knowledge", { knowledge: 14 });
    reserve(state, tile("bank", "building", { building: "bank" }), 25);
    const bank = commit(state, "place", action => action.cell === 25);
    expect(bank.plan.silver).toEqual([{ player: 0, amount: 2, source: "bank", cells: [25] }]);
    const workers = commit(bank.next, "workers");
    expect(workers.plan).toEqual({ ...empty(0),
      workers: [{ player: 0, amount: 4 }],
      silver: [{ player: 0, amount: 1, source: "workers", cells: [12] }],
    });
    expect(workers.next.players[0].workers - bank.next.players[0].workers).toBe(4);
  });

  it.each([false, true])("identifies source depots from actual cargo removal (automatic ship loading: %s)", bundled => {
    const state = game();
    state.pending = [{ kind: "ship" }];
    state.players[0].board[12] = tile("knowledge-5", "knowledge", { knowledge: 5 });
    state.players[0].goods[0] = 1;
    for (const depot of state.depots) depot.goods = [];
    state.depots[5].goods = bundled ? [1, 2, 2] : [1, 2, 2, 4];
    state.depots[0].goods = [1, 3, 3];
    state.depots[2].goods = [2, 2];
    const ship = commit(state, "ship", action => action.depots?.join(",") === "5,0");
    expect(ship.plan).toEqual(empty(0));
    const load = commit(ship.next, "goods", action => action.types?.join(",") === "1,2,3");
    if (bundled) expect(legalActions(ship.next).filter(action => action.kind === "goods")).toHaveLength(1);
    const plan = bundled ? motionForAction(state, ship.action, load.next) : load.plan;
    expect(plan).toEqual({ ...empty(0), goods: [
      { player: 0, type: 1, amount: 2, depots: [0, 5] },
      { player: 0, type: 2, amount: 2, depots: [5] },
      { player: 0, type: 3, amount: 2, depots: [0] },
    ] });
    expect(load.next.depots[2].goods).toEqual([2, 2]);
    expect(load.next.depots[5].goods).toEqual(bundled ? [] : [4]);
    expect(motionForAction(load.next, bundled ? ship.action : load.action, state)).toEqual(empty(0));
  });

  it("does not invent cargo when the automatic manifest is empty", () => {
    const state = game();
    state.pending = [{ kind: "ship" }];
    state.players[0].goods = [1, 1, 1, 0, 0, 0];
    state.depots[4].goods = [4, 5, 6];
    const ship = commit(state, "ship", action => action.depots?.join(",") === "4");
    const load = commit(ship.next, "goods");
    expect(load.action.types).toEqual([]);
    expect(load.plan).toEqual(empty(0));
    expect(motionForAction(state, ship.action, load.next)).toEqual(empty(0));
  });
});

describe("no-op, restore, and purity regressions", () => {
  it("ignores identical states, serialized rerenders, reversed moves and uncommitted actions", () => {
    const state = game();
    reserve(state, tile("bank", "building", { building: "bank" }), 25);
    const { action, next } = commit(state, "place", action => action.cell === 25);
    for (const snapshot of [state, structuredClone(state)])
      expect(motionForAction(state, action, snapshot)).toEqual(empty(0));
    for (const snapshot of [next, JSON.parse(JSON.stringify(next)) as State, state])
      expect(motionForAction(next, action, snapshot)).toEqual(empty(0));
    expect(motionForAction(state, { ...action, tile: "not-placed" }, next)).toEqual(empty(0));
    expect(motionForAction(state, choice(state, "workers"), next)).toEqual(empty(0));

    const restored = structuredClone(next);
    restored.phase++;
    expect(motionForAction(state, action, restored)).toEqual(empty(0));
  });

  it("is deterministic and reads frozen inputs without randomness or state mutation", () => {
    const state = game();
    reserve(state, tile("ship", "ship"), 19);
    const { action, next, plan } = commit(state, "place", action => action.cell === 19);
    const snapshots = structuredClone({ state, action, next });
    function freeze(value: unknown) {
      if (value && typeof value === "object") {
        Object.values(value).forEach(freeze);
        Object.freeze(value);
      }
    }
    [state, action, next].forEach(freeze);
    const random = vi.spyOn(Math, "random").mockImplementation(() => { throw Error("Unexpected randomness"); });
    try {
      expect(motionForAction(state, action, next)).toEqual(plan);
      expect(motionForAction(state, action, next)).toEqual(plan);
      expect({ state, action, next }).toEqual(snapshots);
    } finally {
      random.mockRestore();
    }
  });
});
