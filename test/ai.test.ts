import { afterEach, describe, expect, it, vi } from "vitest";
import { chooseAction } from "../src/ai";
import * as engine from "../src/engine";
import { BOARD, START_CELL, boardFor } from "../src/boards";
import type { Action, State, Tile } from "../src/types";

afterEach(() => vi.restoreAllMocks());

function position(): State {
  const s = engine.createGame(42);
  s.active = 0;
  s.order = [0, 1];
  s.turnIndex = 0;
  s.players[0].dice = [1, 2];
  s.players[0].workers = 6;
  return s;
}

function multiplayerPosition(playerCount: 3 | 4): State {
  const s = engine.createGame(42, { playerCount });
  s.order = s.players.map((_, i) => i);
  s.active = s.turnIndex = playerCount - 1;
  s.players.forEach((p, i) => {
    p.boardId = [2, 4, 7, 9][i];
    const board = boardFor(p);
    p.board = board.map(() => null);
    p.board[board.find((c) => c.color === "castle")!.id] = {
      id: `start-${i}`,
      color: "castle",
    };
    p.dice = [1, 2];
    p.workers = 6;
    p.ships = i;
  });
  return s;
}

function expectLegal(s: State, a: Action) {
  expect(engine.legalActions(s).map(engine.actionKey)).toContain(
    engine.actionKey(a),
  );
}

function freeze(value: object) {
  Object.freeze(value);
  for (const child of Object.values(value))
    if (child && typeof child === "object") freeze(child);
}

function forbidSecrets(s: State) {
  for (const key of [
    "rng",
    "pools",
    "blackPool",
    "goodsPool",
    "phaseGoods",
    "log",
  ])
    Object.defineProperty(s, key, {
      get() {
        throw new Error(`Read secret: ${key}`);
      },
    });
}

describe("public-turn computer search", () => {
  it("returns deterministic engine actions without mutating a frozen input", () => {
    const s = position();
    const before = structuredClone(s);
    freeze(s);
    const a = chooseAction(s);
    expectLegal(s, a);
    expect(chooseAction(s)).toEqual(a);
    expect(s).toEqual(before);
  });

  it("never even reads hidden supplies, random state, or history", () => {
    const s = position();
    const expected = chooseAction(s);
    forbidSecrets(s);
    expect(chooseAction(s)).toEqual(expected);
  });

  it("does not simulate ordinary ends or roll the next round after the last pending choice", () => {
    const s = position();
    s.turnIndex = 1;
    s.order = [1, 0];
    s.phase = 3;
    s.round = 4;
    s.players[0].dice = [null, null];
    s.players[0].silver = 4;
    s.pending = [{ kind: "free" }];
    const apply = engine.applyLegalAction;
    const spy = vi
      .spyOn(engine, "applyLegalAction")
      .mockImplementation((parent, a) => {
        expect(a.kind).not.toBe("end");
        const child = apply(parent, a);
        expect([child.active, child.phase, child.round, child.status]).toEqual([
          0,
          3,
          4,
          "playing",
        ]);
        return child;
      });
    const expected = engine.legalActions(s).map(engine.actionKey);
    forbidSecrets(s);
    expect(expected).toContain(engine.actionKey(chooseAction(s)));
    expect(spy).toHaveBeenCalled();
  });

  it("can use public final scoring but never buys a stranded tile at game end", () => {
    const s = position();
    s.phase = 4;
    s.round = 4;
    s.turnIndex = 1;
    s.order = [1, 0];
    s.players[0].dice = [null, null];
    s.players[0].silver = 4;
    const spy = vi.spyOn(engine, "applyLegalAction");
    expect(chooseAction(s).kind).toBe("end");
    expect(spy.mock.calls.some(([, a]) => a.kind === "end")).toBe(true);
    expect(s.status).toBe("playing");
  });

  it("uses both dice to acquire and place a region-completing tile", () => {
    const s = position();
    const c = BOARD.find((c) => c.color === "mine")!;
    const p = s.players[0];
    p.board = BOARD.map((cell) =>
      cell.id === c.id
        ? null
        : { id: `occupied-${cell.id}`, color: cell.color },
    );
    p.storage = [];
    p.goods.fill(0);
    p.workers = 0;
    p.silver = 0;
    p.dice = [1, c.die];
    s.depots.forEach((d) => {
      d.tiles = [];
      d.goods = [];
    });
    s.black = [];
    s.depots[0].tiles = [{ id: "complete-mine", color: "mine" }];
    const a = chooseAction(s);
    expect(a.kind).toBe("take");
    expect(a.tile).toBe("complete-mine");
    const next = engine.applyAction(s, a);
    const b = chooseAction(next);
    expect(b.kind).toBe("place");
    expect(b.cell).toBe(c.id);
    expect(engine.applyAction(next, b).players[0].score).toBeGreaterThan(0);
  });

  it("buys and then places when a purchase unlocks the best use of the last die", () => {
    const s = position();
    const c = BOARD.find((c) => c.color === "mine")!;
    const p = s.players[0];
    p.board = BOARD.map((cell) =>
      cell.id === c.id ? null : { id: `filled-${cell.id}`, color: cell.color },
    );
    p.storage = [];
    p.goods.fill(0);
    p.workers = 0;
    p.silver = 2;
    p.dice = [c.die, null];
    s.depots.forEach((d) => {
      d.tiles = [];
      d.goods = [];
    });
    s.black = [{ id: "black-mine", color: "mine", black: true }];
    const a = chooseAction(s);
    expect(a.kind).toBe("buy");
    const next = engine.applyAction(s, a);
    expect(chooseAction(next).kind).toBe("place");
  });

  it("can purchase during a pending hall placement without consuming the bonus", () => {
    const s = position();
    const c = BOARD.find((c) => c.color === "mine")!;
    const p = s.players[0];
    p.board = BOARD.map((cell) =>
      cell.id === c.id ? null : { id: `filled-${cell.id}`, color: cell.color },
    );
    p.storage = [];
    p.goods.fill(0);
    p.workers = 0;
    p.silver = 2;
    p.dice = [null, null];
    s.pending = [{ kind: "place" }];
    s.phase = 4;
    s.round = 4;
    s.turnIndex = 1;
    s.order = [1, 0];
    s.black = [{ id: "pending-mine", color: "mine", black: true }];
    const a = chooseAction(s);
    expect(a.kind).toBe("buy");
    const next = engine.applyAction(s, a);
    expect(next.pending).toEqual([{ kind: "place" }]);
    expect(chooseAction(next).kind).toBe("place");
  });

  it("resolves a castle bonus through ship depot choice and goods-type selection", () => {
    let s = position();
    const c = BOARD.find((c) => c.color === "ship")!;
    const p = s.players[0];
    p.board = BOARD.map((cell) =>
      cell.id === c.id ? null : { id: `filled-${cell.id}`, color: cell.color },
    );
    p.dice = [null, null];
    p.goods.fill(0);
    p.silver = 0;
    p.workers = 0;
    p.storage = [{ id: "bonus-ship", color: "ship" }];
    s.pending = [{ kind: "free" }];
    s.depots.forEach((d) => {
      d.tiles = [];
      d.goods = [];
    });
    s.depots[4].goods = [1, 1, 1, 1, 2, 3, 4];
    const place = chooseAction(s);
    expect(place.kind).toBe("place");
    s = engine.applyAction(s, place);
    const ship = chooseAction(s);
    expect(ship.kind).toBe("ship");
    expect(ship.depots).toContain(4);
    s = engine.applyAction(s, ship);
    const goods = chooseAction(s);
    expect(goods.kind).toBe("goods");
    expect(goods.types).toContain(1);
    s = engine.applyAction(s, goods);
    expect(s.players[0].goods[0]).toBe(4);
    expect(s.pending).toEqual([]);
  });

  it("uses a warehouse sale rather than declining its pending bonus", () => {
    const s = position();
    s.pending = [{ kind: "sell" }];
    s.players[0].dice = [null, null];
    s.players[0].goods = [1, 5, 0, 0, 0, 0];
    s.players[0].silver = 0;
    const a = chooseAction(s);
    expect(a.kind).toBe("sell");
    expect(a.good).toBe(2);
  });

  it("builds a useful reserved ship instead of hoarding excess workers", () => {
    const s = position();
    s.phase = 1;
    s.round = 4;
    const p = s.players[0];
    p.dice = [null, 2];
    p.workers = 12;
    p.silver = 0;
    p.goods.fill(0);
    p.storage = [0, 1, 2].map((i) => ({ id: `reserve-${i}`, color: "ship" }));
    s.black = [];
    s.depots.forEach((d) => {
      d.tiles = [];
      d.goods = [];
    });
    s.depots[3].goods = [6, 2, 2];
    // Three reserved ships must not outweigh actually building one and loading goods.
    const a = chooseAction(s);
    expectLegal(s, a);
    expect(a.kind).toBe("place");
    expect(a.cost).toBe(0);
  });

  it("values endgame knowledge matching the public estate", () => {
    const s = position();
    const c = BOARD.find((c) => c.color === "knowledge")!;
    const p = s.players[0];
    p.board = BOARD.map((cell) =>
      cell.id === c.id ? null : { id: `filled-${cell.id}`, color: cell.color },
    );
    p.storage = [
      { id: "scoring-knowledge", color: "knowledge", knowledge: 15 },
      { id: "utility-knowledge", color: "knowledge", knowledge: 8 },
    ];
    p.sold = [1, 1, 1, 1, 1, 1];
    p.dice = [c.die, null];
    p.workers = 0;
    p.silver = 0;
    p.goods.fill(0);
    s.phase = 4;
    s.round = 4;
    s.turnIndex = 1;
    s.order = [1, 0];
    s.depots.forEach((d) => {
      d.tiles = [];
      d.goods = [];
    });
    s.black = [];
    const a = chooseAction(s);
    expect(a.kind).toBe("place");
    expect(a.tile).toBe("scoring-knowledge");
  });

  it("handles hundreds of legal storage replacement and purchase choices within a desktop move budget", () => {
    const s = position();
    const p = s.players[0];
    p.silver = 8;
    p.workers = 12;
    p.storage = ["mine", "ship", "castle"].map(
      (color, i) => ({ id: `stored-${i}`, color }) as Tile,
    );
    // Public knowledge permits buying from all six depots.
    const c = BOARD.find(
      (c) => c.color === "knowledge" && c.id !== START_CELL,
    )!;
    p.board[c.id] = { id: "buy-any-depot", color: "knowledge", knowledge: 6 };
    for (const [i, d] of s.depots.entries())
      d.tiles = Array.from({ length: 8 }, (_, j) => ({
        id: `depot-${i}-${j}`,
        color: j % 2 ? "mine" : "castle",
      }));
    expect(engine.legalActions(s).length).toBeGreaterThan(300);
    const start = performance.now();
    const a = chooseAction(s);
    const elapsed = performance.now() - start;
    expectLegal(s, a);
    expect(elapsed).toBeLessThan(500);
  });

  it("reports that a finished game has no action", () => {
    const s = position();
    s.status = "finished";
    expect(() => chooseAction(s)).toThrow("No legal action");
  });
});

describe("rule-profile computer search", () => {
  function tradePosition(): State {
    const s = position();
    s.ruleset = "special-edition";
    s.knowledge6Used = false;
    s.phase = 3;
    s.round = 4;
    s.turnIndex = 1;
    s.order = [1, 0];
    s.pending = [{ kind: "place" }];
    const p = s.players[0];
    const building = BOARD.find((c) => c.color === "building")!;
    const knowledge = BOARD.find((c) => c.color === "knowledge")!;
    p.board = BOARD.map((c) =>
      c.id === building.id ? null : { id: `filled-${c.id}`, color: c.color },
    );
    p.board[knowledge.id] = { id: "knowledge-6", color: "knowledge", knowledge: 6 };
    p.storage = [];
    p.goods.fill(0);
    p.dice = [null, null];
    p.workers = 2;
    p.silver = 0;
    s.depots.forEach((d) => {
      d.tiles = [];
      d.goods = [];
    });
    s.depots[5].tiles = [
      { id: "trade-watchtower", color: "building", building: "watchtower" },
    ];
    s.black = [];
    return s;
  }

  it("preserves absent rule fields in legacy inputs and public simulations", () => {
    const s = position();
    const before = structuredClone(s);
    const legal = vi.spyOn(engine, "legalActions");
    const a = chooseAction(s);
    expect(legal).toHaveBeenCalled();
    for (const state of [s, ...legal.mock.calls.map(([state]) => state)]) {
      expect(Object.hasOwn(state, "ruleset")).toBe(false);
      expect(Object.hasOwn(state, "knowledge6Used")).toBe(false);
    }
    expectLegal(s, a);
    expect(s).toStrictEqual(before);
  });

  it("keeps legacy/default rules equivalent to explicit original depot purchases", () => {
    const legacy = tradePosition();
    delete legacy.ruleset;
    delete legacy.knowledge6Used;
    legacy.players[0].silver = 2;
    const original = structuredClone(legacy);
    original.ruleset = "original-2011";
    const a = chooseAction(legacy);
    expectLegal(legacy, a);
    expect(a).toMatchObject({ kind: "buy", depot: 5, tile: "trade-watchtower", cost: 0 });
    expect(chooseAction(original)).toEqual(a);
    expect(engine.legalActions(legacy).some((a) => a.kind === "trade")).toBe(false);
  });

  it.each([false, true])(
    "prefers a worker trade with purchased=%s and preserves the independent bonus and silver",
    (purchased) => {
      const s = tradePosition();
      s.purchased = purchased;
      s.players[0].silver = 2;
      s.black = [{ id: "black-watchtower", color: "building", building: "watchtower", black: true }];
      const a = chooseAction(s);
      expectLegal(s, a);
      expect(a).toMatchObject({ kind: "trade", depot: 5, tile: "trade-watchtower", cost: 2 });
      expect(a.die).toBeUndefined();
      const next = engine.applyAction(s, a);
      expect(next.purchased).toBe(purchased);
      expect(next.knowledge6Used).toBe(true);
      expect(next.pending).toEqual(s.pending);
      expect(next.players[0]).toMatchObject({ workers: 0, silver: 2, dice: [null, null] });
      expect(engine.legalActions(next).some((a) => a.kind === "buy")).toBe(!purchased);
      expect(engine.legalActions(next).some((a) => a.kind === "trade")).toBe(false);
      expect(chooseAction(next)).toMatchObject({ kind: "place", tile: "trade-watchtower" });
    },
  );

  it("ranks useful trades before pruning a crowded supply with reserve replacements", () => {
    const s = tradePosition();
    s.players[0].storage = [0, 1, 2].map((i) => ({ id: `stranded-${i}`, color: "mine" }));
    for (let i = 0; i < 5; i++)
      s.depots[i].tiles = Array.from({ length: 3 }, (_, j) => ({
        id: `bank-${i}-${j}`, color: "building", building: "bank",
      }));
    expect(engine.legalActions(s).length).toBeGreaterThan(40);
    const a = chooseAction(s);
    expectLegal(s, a);
    expect(a).toMatchObject({ kind: "trade", tile: "trade-watchtower", cost: 2 });
    expect(s.players[0].storage.map((t) => t.id)).toContain(a.discard);
    const next = engine.applyAction(s, a);
    expect(next.players[0].storage).toHaveLength(3);
    expect(next.players[0].storage.some((t) => t.id === a.discard)).toBe(false);
    expect(chooseAction(next)).toMatchObject({ kind: "place", tile: "trade-watchtower" });
  });

  it.each([false, true])(
    "honors knowledge6Used=%s without reading secrets or simulating the next turn",
    (used) => {
      const s = tradePosition();
      s.knowledge6Used = used;
      const expected = chooseAction(s);
      expectLegal(s, expected);
      expect(expected.kind).toBe(used ? "skip" : "trade");
      const apply = engine.applyLegalAction;
      vi.spyOn(engine, "applyLegalAction").mockImplementation((parent, a) => {
        expect(a.kind).not.toBe("end");
        const child = apply(parent, a);
        expect([child.active, child.phase, child.round, child.status]).toEqual([0, 3, 4, "playing"]);
        return child;
      });
      forbidSecrets(s);
      expect(chooseAction(s)).toEqual(expected);
    },
  );

  it("keeps otherwise identical successor states with different trade quotas in the beam", () => {
    const s = tradePosition();
    const successor = structuredClone(s);
    successor.pending = [];
    successor.players[0].workers = 0;
    // Isolate the quota bit: both legal root choices lead to the same other public data.
    vi.spyOn(engine, "applyLegalAction").mockImplementation((_, a) => ({
      ...structuredClone(successor),
      knowledge6Used: a.kind === "trade",
    }));
    const legal = vi.spyOn(engine, "legalActions");
    chooseAction(s);
    const quotas = legal.mock.calls
      .filter(([state]) => state.pending.length === 0)
      .map(([state]) => state.knowledge6Used);
    expect(quotas).toHaveLength(2);
    expect(quotas).toEqual(expect.arrayContaining([false, true]));
  });

  it.each([
    ["original-2011", 15],
    ["special-edition", 26],
  ] as const)("values knowledge 15/26 under %s without ending the round", (ruleset, preferred) => {
    const s = position();
    s.ruleset = ruleset;
    s.phase = 4;
    s.round = 4;
    const p = s.players[0];
    const cell = BOARD.find((c) => c.color === "knowledge")!;
    p.board = BOARD.map((c) =>
      c.id === cell.id ? null : { id: `filled-${c.id}`, color: c.color },
    );
    p.storage = [15, 26].map((knowledge) => ({
      id: `knowledge-${knowledge}`, color: "knowledge", knowledge,
    }));
    p.sold = [1, 1, 1, 0, 0, 0];
    p.bonuses = ["castle", "mine"];
    p.dice = [cell.die, null];
    p.workers = p.silver = 0;
    p.goods.fill(0);
    s.depots.forEach((d) => { d.tiles = []; d.goods = []; });
    s.black = [];
    const a = chooseAction(s);
    expectLegal(s, a);
    expect(a).toMatchObject({ kind: "place", tile: `knowledge-${preferred}` });
  });

  it.each([
    ["original-2011", 16],
    ["special-edition", 14],
  ] as const)("simulates public terminal scoring with %s weights", (ruleset, knowledge) => {
    const s = position();
    s.ruleset = ruleset;
    s.phase = s.round = 4;
    s.turnIndex = 1;
    s.order = [1, 0];
    const p = s.players[0];
    p.board = BOARD.map((c) => ({ id: `filled-${c.id}`, color: c.color }));
    BOARD.filter((c) => c.color === "knowledge").slice(0, 2).forEach((c, i) => {
      p.board[c.id] = { id: `knowledge-${i}`, color: "knowledge", knowledge: [15, 26][i] };
    });
    p.sold = [1, 1, 1, 1, 0, 0];
    p.bonuses = ["castle", "mine"];
    p.dice = [null, null];
    p.workers = 5;
    p.silver = 4;
    p.goods = [1, 2, 0, 0, 0, 0];
    s.black = [{ id: "stranded-castle", color: "castle", black: true }];
    const silver = p.silver + p.board.filter((t) => t?.color === "mine").length;
    const apply = engine.applyLegalAction;
    const finals: State[] = [];
    vi.spyOn(engine, "applyLegalAction").mockImplementation((parent, a) => {
      const child = apply(parent, a);
      if (child.status === "finished") finals.push(child);
      return child;
    });
    forbidSecrets(s);
    expect(chooseAction(s).kind).toBe("end");
    expect(finals.length).toBeGreaterThan(0);
    for (const final of finals) {
      expect(final.ruleset).toBe(ruleset);
      expect(final.players[0].final?.knowledge).toBe(knowledge);
    }
    expect(finals.find((final) => final.players[0].silver === silver)?.players[0]).toMatchObject({
      score: p.score + 3 + silver + 2 + knowledge,
      final: { goods: 3, silver, workers: 2, knowledge },
    });
  });
});

describe("multiplayer estate search", () => {
  it.each([3, 4] as const)(
    "chooses a deterministic legal action for the last of %i different estates without reading secrets",
    (playerCount) => {
      const s = multiplayerPosition(playerCount);
      const before = structuredClone(s);
      const hidden = structuredClone(s);
      freeze(s);
      const a = chooseAction(s);
      expectLegal(s, a);
      expect(chooseAction(s)).toEqual(a);
      expect(s).toEqual(before);
      forbidSecrets(hidden);
      expect(chooseAction(hidden)).toEqual(a);
    },
  );

  it.each([3, 4] as const)(
    "uses the active estate's cells and printed dice in a %i-player placement",
    (playerCount) => {
      const s = multiplayerPosition(playerCount);
      const p = s.players[s.active];
      const board = boardFor(p);
      const c = board.find(
        (cell) => cell.color === "mine" && BOARD[cell.id].color !== "mine",
      )!;
      expect(c).toBeDefined();
      p.board = board.map((cell) =>
        cell.id === c.id ? null : { id: `filled-${cell.id}`, color: cell.color },
      );
      p.dice = [c.die, null];
      p.workers = p.silver = 0;
      p.goods.fill(0);
      p.storage = [{ id: "estate-mine", color: "mine" }];
      s.black = [];
      s.depots.forEach((d) => {
        d.tiles = [];
        d.goods = [];
      });
      const a = chooseAction(s);
      expectLegal(s, a);
      expect(a).toMatchObject({ kind: "place", cell: c.id, cost: 0 });
      expect(engine.applyAction(s, a).players[s.active].board[c.id]?.id).toBe(
        "estate-mine",
      );
    },
  );

  it("treats all opponents alike regardless of their seat or estate", () => {
    const s = multiplayerPosition(4);
    s.active = s.turnIndex = 0;
    s.players[0].storage = [{ id: "reserve-ship", color: "ship" }];
    s.players[1].ships = 0;
    s.players[2].ships = 1;
    s.players[3].ships = 4;
    const a = chooseAction(s);
    expectLegal(s, a);
    const reordered = structuredClone(s);
    reordered.players = [
      reordered.players[0],
      reordered.players[3],
      reordered.players[1],
      reordered.players[2],
    ];
    // Preserve the same public turn order while renumbering the opponents.
    reordered.order = [0, 2, 3, 1];
    expect(chooseAction(reordered)).toEqual(a);
  });

  it("keeps legacy missing board IDs equivalent to explicit estate #1", () => {
    const legacy = position();
    legacy.players.forEach((p) => delete p.boardId);
    const explicit = structuredClone(legacy);
    explicit.players.forEach((p) => {
      p.boardId = 1;
    });
    expect(chooseAction(explicit)).toEqual(chooseAction(legacy));
  });
});

describe("public estate setup choice", () => {
  it.each(["open", "secret"] as const)(
    "chooses a legal %s estate deterministically without simulating hidden setup",
    (estates) => {
      let s = engine.createGame(42, { playerCount: 4, estates });
      for (let i = 0; i < s.players.length; i++) {
        const before = structuredClone(s);
        const spy = vi.spyOn(engine, "applyLegalAction");
        const a = chooseAction(s);
        expect(a.kind).toBe("choose-estate");
        expectLegal(s, a);
        expect(chooseAction(s)).toEqual(a);
        expect(s).toEqual(before);
        expect(spy).not.toHaveBeenCalled();
        spy.mockRestore();
        s = engine.applyAction(s, a);
      }
      expect(s.status).toBe("playing");
      expect(s.players.every((p) => p.board.filter(Boolean).length === 1)).toBe(
        true,
      );
      expectLegal(s, chooseAction(s));
    },
  );

  it("never reads concealed selections, setup castles, or other players' dealt faces", () => {
    let s = engine.createGame(42, { playerCount: 4, estates: "secret" });
    s = engine.applyAction(s, engine.legalActions(s)[0]);
    const expected = chooseAction(s);
    const hidden = structuredClone(s);
    forbidSecrets(hidden);
    for (const key of ["choices", "castles"])
      Object.defineProperty(hidden.setup!, key, {
        get() {
          throw new Error(`Read secret setup: ${key}`);
        },
      });
    for (let i = 0; i < hidden.players.length; i++)
      if (i !== hidden.active)
        Object.defineProperty(hidden.setup!.boards, i, {
          get() {
            throw new Error(`Read another estate deal: ${i}`);
          },
        });
    expect(chooseAction(hidden)).toEqual(expected);
  });
});

describe("AI-versus-AI integration", () => {
  it.each([42, 2026])(
    "completes seed %i legally within 2000 actions",
    (seed) => {
      let s = engine.createGame(seed);
      let count = 0;
      const times: number[] = [];
      const actionCounts: Partial<Record<Action["kind"], number>>[] = [{}, {}];
      const excessWorkerDice = [0, 0];
      while (s.status === "playing" && count < 2000) {
        const before = structuredClone(s);
        const start = performance.now();
        const a = chooseAction(s);
        times.push(performance.now() - start);
        const counts = actionCounts[s.active];
        counts[a.kind] = (counts[a.kind] ?? 0) + 1;
        if (
          a.kind === "workers" && a.die !== undefined && s.phase < 4 &&
          s.players[s.active].workers >= 6 &&
          engine.legalActions(s).some((choice) => choice.kind === "place")
        ) excessWorkerDice[s.active]++;
        expect(s).toEqual(before);
        // applyAction independently validates each decision against the authoritative rules.
        s = engine.applyAction(s, a);
        count++;
      }
      expect(s.status).toBe("finished");
      expect(count).toBeLessThan(2000);
      expect(s.players.every((p) => p.final && Number.isFinite(p.score))).toBe(
        true,
      );
      expect([0, 1]).toContain(s.winner);
      // Broad smoke bounds, not exact scores or an optimal-play requirement.
      // Workers remain valid for die adjustment and final scoring; repeated early
      // stockpiling with playable reserves was the observed regression.
      for (const [i, p] of s.players.entries()) {
        expect(p.board.filter(Boolean).length).toBeGreaterThanOrEqual(16);
        expect(excessWorkerDice[i]).toBeLessThan(8);
      }
      times.sort((a, b) => a - b);
      console.info(
        `AI seed ${seed}: ${count} actions, scores ${s.players.map((p) => p.score).join("/")}, ` +
          `built ${s.players.map((p) => p.board.filter(Boolean).length).join("/")}, ` +
          `excess worker dice ${excessWorkerDice.join("/")}, actions ${JSON.stringify(actionCounts)}, ` +
          `p95 ${times[Math.floor(times.length * 0.95)].toFixed(1)}ms, max ${times.at(-1)!.toFixed(1)}ms`,
      );
    },
    120_000,
  );
});
