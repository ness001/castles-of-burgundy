import { describe, expect, it, vi } from "vitest";
import { boardFor } from "../src/boards";
import * as engine from "../src/engine";
import { motionForAction } from "../src/motion-events";
import type { Action, Color, Ruleset, State, Tile } from "../src/types";

const tile = (id: string, color: Color, extra: Partial<Tile> = {}): Tile => ({ id, color, ...extra });
const empty = (actor: number) => ({
  actor, roll: false, phaseChanged: false, regions: [], freeAction: false,
  silver: [], scores: [], goods: [],
});

function game(actor = 0, ruleset?: Ruleset): State {
  const state = engine.createGame(20261002, { playerCount: actor < 2 ? 2 : 4, ruleset });
  state.active = actor;
  state.order = state.players.map((_, player) => player);
  state.turnIndex = actor;
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
  const action = engine.legalActions(state).find(action => action.kind === kind && match(action));
  expect(action, `Expected legal ${kind}`).toBeDefined();
  return action!;
}

function commit(state: State, kind: Action["kind"], match: (action: Action) => boolean = () => true) {
  const action = choice(state, kind, match);
  const next = engine.applyAction(state, action);
  return { action, next, plan: motionForAction(state, action, next) };
}

function reserve(state: State, placed: Tile, cell: number) {
  const player = state.players[state.active];
  player.storage = [placed];
  player.dice = [boardFor(player)[cell].die, 2];
}

describe("worker feedback contexts 051–060", () => {
  it("051 projects the human worker action's committed gain", () => {
    const state = game();
    const { action, next, plan } = commit(state, "workers", action => action.die === 0);
    expect(action.cost).toBe(0);
    expect(next.players[0].dice).toEqual([null, 2]);
    expect(next.players[0].workers).toBe(10);
    expect(plan).toEqual({ ...empty(0), workers: [{ player: 0, amount: 2 }] });
  });

  it("052 attributes gains to each rival rather than the human", () => {
    for (const actor of [1, 2, 3]) {
      const state = game(actor);
      const { next, plan } = commit(state, "workers");
      expect(next.players[actor].workers).toBe(10);
      expect(next.players[0].workers).toBe(8);
      expect(plan).toEqual({ ...empty(actor), workers: [{ player: actor, amount: 2 }] });
    }
  });

  it("053 reports signed die-adjustment costs, including 1↔6 wrapping", () => {
    for (const [depot, cost] of [[1, 1], [2, 2], [3, 3], [5, 1]]) {
      const state = game(1);
      const taken = tile("adjusted-take", "ship");
      state.depots[depot].tiles = [taken];
      const { action, next, plan } = commit(state, "take", action => action.die === 0 && action.tile === taken.id);
      expect(action.cost).toBe(cost);
      expect(next.players[1].workers).toBe(8 - cost);
      expect(next.players[1].dice).toEqual([null, 2]);
      expect(plan).toEqual({ ...empty(1), tile: { tile: taken, from: "depot", depot },
        workers: [{ player: 1, amount: -cost }],
      });
    }
  });

  it("054 distinguishes silver purchases from Special Edition worker trades", () => {
    for (const ruleset of ["original-2011", "special-edition"] as const) {
      const state = game(1, ruleset), player = state.players[1];
      player.board[12] = tile("knowledge-6", "knowledge", { knowledge: 6 });
      state.pending = [{ kind: "sell" }];
      state.black = [tile("black-bank", "building", { building: "bank" })];
      state.depots[0].tiles = [tile("depot-bank", "building", { building: "bank" })];
      const purchase = commit(state, "buy", action => action.tile === "black-bank");
      expect(purchase.action.cost).toBe(0);
      expect(purchase.next.players[1].silver).toBe(1);
      expect(purchase.next.players[1].workers).toBe(8);
      expect(purchase.next.players[1].dice).toEqual(player.dice);
      expect(purchase.next.pending).toEqual(state.pending);
      expect(purchase.plan).toEqual({ ...empty(1), tile: { tile: state.black[0], from: "black" } });
      expect(purchase.plan).not.toHaveProperty("workers");

      const kind = ruleset === "special-edition" ? "trade" : "buy";
      const traded = commit(state, kind, action => action.tile === "depot-bank");
      expect(traded.action.cost).toBe(kind === "trade" ? 2 : 0);
      expect(traded.next.players[1].workers).toBe(kind === "trade" ? 6 : 8);
      expect(traded.next.players[1].silver).toBe(kind === "trade" ? 3 : 1);
      expect(traded.next.players[1].dice).toEqual(player.dice);
      expect(traded.next.pending).toEqual(state.pending);
      expect(traded.plan).toEqual({ ...empty(1), tile: { tile: state.depots[0].tiles[0], from: "depot", depot: 0 },
        ...(kind === "trade" ? { workers: [{ player: 1, amount: -2 }] } : {}),
      });
      if (kind === "trade") expect(traded.next.knowledge6Used).toBe(true);
      expect(motionForAction(traded.next, traded.action, state)).toEqual(empty(1));
    }
  });

  it("055 reports the Boarding House's net gain, not the gross reward or action cost", () => {
    for (const cost of [0, 2]) {
      const state = game(1), player = state.players[1];
      player.board[12] = tile("knowledge-13", "knowledge", { knowledge: 13 });
      player.board[7] = tile("knowledge-14", "knowledge", { knowledge: 14 });
      reserve(state, tile("boarding", "building", { building: "boarding" }), 25);
      player.dice[0] = (boardFor(player)[25].die - 1 + cost) % 6 + 1;
      const { action, next, plan } = commit(state, "place", action => action.cell === 25 && action.die === 0);
      expect(action.cost).toBe(cost);
      expect(next.players[1].workers).toBe(12 - cost);
      expect(next.players[1].silver).toBe(3);
      expect(plan).toEqual({ ...empty(1), tile: { tile: player.storage[0], from: "reserve", cell: 25 },
        workers: [{ player: 1, amount: 4 - cost }],
      });
    }
  });

  it("056 treats knowledge 12 as a taking discount, never a worker gain", () => {
    const state = game();
    state.players[0].board[12] = tile("knowledge-12", "knowledge", { knowledge: 12 });
    for (const depot of [5, 2]) {
      const taken = tile(`discount-${depot}`, "ship");
      state.depots[depot].tiles = [taken];
      const { action, next, plan } = commit(state, "take", action => action.die === 0 && action.tile === taken.id);
      const cost = depot === 5 ? 0 : 1;
      expect(action.cost).toBe(cost);
      expect(next.players[0].workers).toBe(8 - cost);
      expect(plan).toEqual({ ...empty(0), tile: { tile: taken, from: "depot", depot },
        ...(cost ? { workers: [{ player: 0, amount: -1 }] } : {}),
      });
      if (!cost) expect(plan).not.toHaveProperty("workers");
    }
  });

  it("057 keeps knowledge 13 silver and worker gains together, with knowledge 14 amplification", () => {
    for (const enhanced of [false, true]) {
      const state = game(1);
      state.players[1].board[12] = tile("knowledge-13", "knowledge", { knowledge: 13 });
      if (enhanced) state.players[1].board[7] = tile("knowledge-14", "knowledge", { knowledge: 14 });
      const { next, plan } = commit(state, "workers");
      const amount = enhanced ? 4 : 2;
      expect(next.players[1].workers).toBe(8 + amount);
      expect(next.players[1].silver).toBe(4);
      expect(plan).toEqual({ ...empty(1), workers: [{ player: 1, amount }],
        silver: [{ player: 1, amount: 1, source: "workers", cells: [12] }],
      });
    }
  });

  it("058 projects a real castle's free worker action without consuming another die", () => {
    const state = game(1);
    state.players[1].board[11] = tile("connector", "building", { building: "watchtower" });
    reserve(state, tile("castle", "castle"), 6);
    const castle = commit(state, "place", action => action.cell === 6 && action.die === 0);
    expect(castle.next.pending).toEqual([{ kind: "free" }]);
    expect(castle.plan.freeAction).toBe(true);
    expect(castle.plan).not.toHaveProperty("workers");
    const { action, next, plan } = commit(castle.next, "workers");
    expect(action.die).toBeUndefined();
    expect(next.players[1].dice).toEqual(castle.next.players[1].dice);
    expect(next.pending).toEqual([]);
    expect(next.players[1].workers).toBe(10);
    expect(plan).toEqual({ ...empty(1), workers: [{ player: 1, amount: 2 }] });
    expect(motionForAction(next, action, castle.next)).toEqual(empty(1));
  });

  it("059 leaves the old plan shape intact for a declined bonus and a zero-cost move", () => {
    const state = game();
    reserve(state, tile("workshop", "building", { building: "workshop" }), 25);
    const workshop = commit(state, "place", action => action.cell === 25 && action.die === 0);
    expect(workshop.next.pending).toEqual([{ kind: "take", colors: ["building"] }]);
    const declined = commit(workshop.next, "skip");
    expect(declined.next.pending).toEqual([]);
    expect(declined.next.players[0].workers).toBe(8);
    expect(declined.plan).toEqual(empty(0));
    expect(declined.plan).not.toHaveProperty("workers");

    const freeTake = commit(declined.next, "take", action => action.die === 1 && action.depot === 1);
    expect(freeTake.action.cost).toBe(0);
    expect(freeTake.next.players[0].workers).toBe(8);
    expect(freeTake.plan).toEqual({ ...empty(0), tile: {
      tile: declined.next.depots[1].tiles.find(tile => tile.id === freeTake.action.tile), from: "depot", depot: 1,
    } });
    expect(freeTake.plan).not.toHaveProperty("workers");
  });

  it("060 guards reverse/no-op/uncommitted deltas and remains pure without engine replay or randomness", () => {
    const state = game(1);
    const { action, next } = commit(state, "workers", action => action.die === 0);
    for (const snapshot of [state, structuredClone(state)])
      expect(motionForAction(state, action, snapshot)).toEqual(empty(1));
    for (const snapshot of [next, JSON.parse(JSON.stringify(next)) as State, state])
      expect(motionForAction(next, action, snapshot)).toEqual(empty(1));
    for (const amount of [-2, 2]) {
      const uncommitted = structuredClone(state);
      uncommitted.players[1].workers += amount;
      expect(motionForAction(state, action, uncommitted)).toEqual(empty(1));
    }
    expect(motionForAction(state, { ...action, die: 1 }, next)).toEqual(empty(1));
    const restored = structuredClone(next);
    restored.round++;
    expect(motionForAction(state, action, restored)).toEqual(empty(1));

    const spent = commit(state, "take", action => action.die === 0 && action.depot === 2);
    expect(spent.plan.workers).toEqual([{ player: 1, amount: -2 }]);
    expect(motionForAction(spent.next, spent.action, state)).toEqual(empty(1));

    const snapshots = structuredClone({ state, action, next });
    function freeze(value: unknown) {
      if (value && typeof value === "object") {
        Object.values(value).forEach(freeze);
        Object.freeze(value);
      }
    }
    [state, action, next].forEach(freeze);
    const forbidden = () => { throw Error("Projection must not replay the engine or use randomness"); };
    const spies = [
      vi.spyOn(Math, "random").mockImplementation(forbidden),
      vi.spyOn(engine, "applyAction").mockImplementation(forbidden),
      vi.spyOn(engine, "applyLegalAction").mockImplementation(forbidden),
      vi.spyOn(engine, "legalActions").mockImplementation(forbidden),
    ];
    try {
      for (let repeat = 0; repeat < 2; repeat++)
        expect(motionForAction(state, action, next)).toEqual({ ...empty(1), workers: [{ player: 1, amount: 2 }] });
      expect({ state, action, next }).toEqual(snapshots);
      spies.forEach(spy => expect(spy).not.toHaveBeenCalled());
    } finally {
      spies.forEach(spy => spy.mockRestore());
    }
  });
});
