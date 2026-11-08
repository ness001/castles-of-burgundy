import { describe, expect, it } from "vitest";
import {
  createGame,
  legalActions,
  applyAction,
  actionKey,
  canPlace,
  turnOrder,
} from "../src/engine";
import { BOARD, COLORS, KNOWLEDGE_BUILDING, START_CELL } from "../src/data";
import type { Action, Color, State, Tile } from "../src/types";
const tile = (color: Color, extra: Partial<Tile> = {}): Tile => ({
  id: `test-${color}-${JSON.stringify(extra)}`,
  color,
  ...extra,
});
function game() {
  const s = createGame(1234);
  s.active = 0;
  s.turnIndex = 0;
  s.order = [0, 1];
  s.players[0].dice = [1, 2];
  s.players[0].workers = 12;
  return s;
}
function act(
  s: State,
  kind: Action["kind"],
  filter: (a: Action) => boolean = () => true,
) {
  const a = legalActions(s).find((a) => a.kind === kind && filter(a));
  expect(a, `${kind} exists`).toBeDefined();
  return applyAction(s, a!);
}
function teach(s: State, n: number, avoid = -1) {
  const p = s.players[s.active];
  const i = p.board.findIndex(
    (t, id) => !t && id !== START_CELL && id !== avoid,
  );
  p.board[i] = tile("knowledge", { knowledge: n });
}
function preparePlace(t: Tile) {
  const s = game();
  const c = BOARD.find((c) => c.color === t.color && c.id !== START_CELL)!;
  const neighbor = BOARD.find((n) => {
    const dq = n.q - c.q,
      dr = n.r - c.r;
    return (
      n.id !== c.id &&
      Math.max(Math.abs(dq), Math.abs(dr), Math.abs(dq + dr)) === 1
    );
  })!;
  s.players[0].board = BOARD.map(() => null);
  s.players[0].board[neighbor.id] = tile("castle");
  s.players[0].storage = [t];
  s.players[0].dice = [c.die, null];
  return { s, c };
}
describe("setup and commands", () => {
  it("keeps starting castle choices distinct without exposing hex or die numbers", () => {
    const s = createGame(42, { estates: "open" });
    const actions = legalActions(s);
    expect(actions.length).toBeGreaterThan(1);
    expect(new Set(actions.map(actionKey)).size).toBe(actions.length);
    expect(new Set(actions.map(action => action.label)).size).toBe(actions.length);
    for (const action of actions) {
      expect(action.label).toMatch(/^Estate #\d+ · starting castle \d+$/);
      expect(action.label).not.toMatch(/\b(?:hex|die) \d+/i);
    }
    const selected = actions.at(-1)!;
    const next = applyAction(s, selected);
    expect(next.players[s.active].board[selected.cell!]?.color).toBe("castle");
    expect(next.log.at(-1)).toBe(`${s.players[s.active].name} settle estate #${selected.boardId}.`);
  });

  it("is seeded, separate, and starts a 2-player base game", () => {
    const s = createGame(42);
    expect(s).toEqual(createGame(42));
    expect(s.players).toHaveLength(2);
    expect(s.players[0].board).toHaveLength(37);
    expect(s.players.map((p) => p.workers).sort()).toEqual([1, 2]);
    expect(s.depots.every((d) => d.tiles.length === 2)).toBe(true);
    expect(s.depots.flatMap((d) => d.goods)).toHaveLength(1);
  });
  it("rejects illegal and stale commands; ignores supplied costs", () => {
    const s = game();
    expect(() => applyAction(s, { kind: "end", cost: 0, label: "" })).toThrow();
    const a = legalActions(s).find((a) => a.kind === "take")!;
    const next = applyAction(s, { ...a, cost: -200 });
    expect(next.players[0].workers).toBe(s.players[0].workers - a.cost);
    expect(s.players[0].storage).toHaveLength(0);
    expect(() => applyAction(next, a)).toThrow();
  });
  it("requires a discard with a full tile store", () => {
    const s = game();
    s.players[0].storage = [
      tile("mine", { id: "a" }),
      tile("mine", { id: "b" }),
      tile("mine", { id: "c" }),
    ];
    expect(
      legalActions(s)
        .filter((a) => a.kind === "take")
        .every((a) => !!a.discard),
    ).toBe(true);
    const next = act(s, "take", (a) => a.discard === "b");
    expect(next.players[0].storage).toHaveLength(3);
    expect(next.players[0].storage.some((t) => t.id === "b")).toBe(false);
  });
  it("permits one purchase before/between/after dice without using dice", () => {
    let s = game();
    s.players[0].silver = 10;
    const dice = [...s.players[0].dice];
    s = act(s, "buy");
    expect(s.players[0].dice).toEqual(dice);
    expect(s.players[0].silver).toBe(8);
    expect(legalActions(s).some((a) => a.kind === "buy")).toBe(false);
    s.players[0].dice = [null, null];
    expect(legalActions(s).some((a) => a.kind === "end")).toBe(true);
  });
  it("wraps workers 1↔6, and knowledge 8 doubles their adjustment", () => {
    let s = game();
    s.players[0].dice = [1, null];
    expect(
      legalActions(s).find((a) => a.kind === "take" && a.depot === 5)?.cost,
    ).toBe(1);
    teach(s, 8);
    expect(
      legalActions(s).find((a) => a.kind === "take" && a.depot === 2)?.cost,
    ).toBe(1);
    expect(
      legalActions(s).find((a) => a.kind === "take" && a.depot === 3)?.cost,
    ).toBe(2);
  });
});
describe("placement and effects", () => {
  it("allows buying inside a City Hall bonus without consuming it", () => {
    let s = game();
    const c = BOARD.find((c) => c.color === "mine")!;
    const near = BOARD.find(
      (n) =>
        n.id !== c.id &&
        Math.max(
          Math.abs(n.q - c.q),
          Math.abs(n.r - c.r),
          Math.abs(n.q + n.r - c.q - c.r),
        ) === 1,
    )!;
    s.players[0].board[near.id] = tile("castle");
    s.players[0].silver = 2;
    s.black = [tile("mine", { id: "purchase-during-bonus" })];
    s.pending = [{ kind: "place" }];
    const dice = [...s.players[0].dice];
    s = act(s, "buy");
    expect(s.pending).toEqual([{ kind: "place" }]);
    expect(s.players[0].dice).toEqual(dice);
    s = act(s, "place", (a) => a.cell === c.id);
    expect(s.pending).toEqual([]);
    expect(s.players[0].board[c.id]?.id).toBe("purchase-during-bonus");
    expect(s.players[0].dice).toEqual(dice);
  });
  it("requires resolving the castle's free action (workers are always possible)", () => {
    const s = game();
    s.pending = [{ kind: "free" }];
    expect(legalActions(s).some((a) => a.kind === "skip")).toBe(false);
    expect(legalActions(s).some((a) => a.kind === "workers")).toBe(true);
  });
  it("requires matching colour, adjacency, and empty cells", () => {
    const s = game(),
      p = s.players[0];
    expect(canPlace(p, tile("castle"), START_CELL)).toBe(false);
    const distant = BOARD.find(
      (c) =>
        Math.max(
          Math.abs(c.q - BOARD[START_CELL].q),
          Math.abs(c.r - BOARD[START_CELL].r),
          Math.abs(c.q + c.r - BOARD[START_CELL].q - BOARD[START_CELL].r),
        ) > 1,
    )!;
    expect(canPlace(p, tile(distant.color), distant.id)).toBe(false);
  });
  it("blocks duplicate buildings in a city unless knowledge 1 is owned", () => {
    const { s, c } = preparePlace(tile("building", { building: "bank" }));
    const other = BOARD.find((n) => n.id !== c.id && n.region === c.region);
    if (!other) throw Error("Choose a multiple-space city for test");
    s.players[0].board[other.id] = tile("building", { building: "bank" });
    expect(canPlace(s.players[0], s.players[0].storage[0], c.id)).toBe(false);
    teach(s, 1, c.id);
    expect(canPlace(s.players[0], s.players[0].storage[0], c.id)).toBe(true);
  });
  it("scores size and current phase exactly once on region completion", () => {
    const { s, c } = preparePlace(tile("mine"));
    const region = BOARD.filter((n) => n.region === c.region);
    for (const n of region)
      if (n.id !== c.id)
        s.players[0].board[n.id] = tile("mine", { id: `mine-${n.id}` });
    s.phase = 2;
    const next = act(s, "place", (a) => a.cell === c.id);
    expect(next.players[0].score).toBe(
      (region.length * (region.length + 1)) / 2 +
        6 +
        (next.players[0].bonuses.includes("mine") ? 5 : 0),
    );
  });
  it("gives castle actions a free die and resolves nested placement first", () => {
    const { s, c } = preparePlace(tile("castle"));
    s.players[0].dice = [c.die, 4];
    let next = act(s, "place", (a) => a.cell === c.id);
    expect(next.pending[0].kind).toBe("free");
    expect(next.players[0].dice).toEqual([null, 4]);
    expect(
      legalActions(next)
        .filter((a) => a.kind === "take")
        .every((a) => a.cost === 0),
    ).toBe(true);
    next = act(next, "workers");
    expect(next.players[0].dice).toEqual([null, 4]);
    expect(next.pending).toHaveLength(0);
  });
  it.each([
    ["bank", 2, 0, 0],
    ["boarding", 0, 4, 0],
    ["watchtower", 0, 0, 4],
  ] as const)(
    "%s grants its immediate reward",
    (building, coins, workers, points) => {
      const { s, c } = preparePlace(tile("building", { building }));
      const next = act(s, "place", (a) => a.cell === c.id);
      expect(next.players[0].silver).toBe(s.players[0].silver + coins);
      expect(next.players[0].workers).toBe(s.players[0].workers + workers);
      const region = BOARD.filter((n) => n.region === c.region);
      const completed = region.every((n) => next.players[0].board[n.id]);
      expect(next.players[0].score).toBe(
        points +
          (completed ? (region.length * (region.length + 1)) / 2 + 10 : 0),
      );
    },
  );
  it.each([
    ["warehouse", "sell"],
    ["workshop", "take"],
    ["church", "take"],
    ["market", "take"],
    ["hall", "place"],
  ] as const)("%s opens its bonus choice", (building, kind) => {
    const { s, c } = preparePlace(tile("building", { building }));
    const next = act(s, "place", (a) => a.cell === c.id);
    expect(next.pending[0].kind).toBe(kind);
    expect(legalActions(next).some((a) => a.kind === "skip")).toBe(true);
  });
  it("rescores matching animals only in the same pasture, with knowledge 7 per tile", () => {
    const c = BOARD.find(
      (c) =>
        c.color === "animal" &&
        BOARD.filter((n) => n.region === c.region).length >= 2,
    )!;
    const region = BOARD.filter((n) => n.region === c.region);
    const s = game();
    s.players[0].board = BOARD.map(() => null);
    const other = region.find((n) => n.id !== c.id)!;
    s.players[0].board[other.id] = tile("animal", {
      animal: "sheep",
      count: 3,
    });
    const adjacent = BOARD.find(
      (n) =>
        n.id !== c.id &&
        Math.max(
          Math.abs(n.q - c.q),
          Math.abs(n.r - c.r),
          Math.abs(n.q + n.r - c.q - c.r),
        ) === 1,
    )!;
    s.players[0].board[adjacent.id] = tile("animal", {
      animal: "sheep",
      count: 3,
    });
    s.players[0].storage = [tile("animal", { animal: "sheep", count: 4 })];
    s.players[0].dice = [c.die, null];
    teach(s, 7, c.id);
    const before = s.players[0].board.filter(
      (t, i) => t?.animal === "sheep" && BOARD[i].region === c.region,
    ).length;
    const next = act(s, "place", (a) => a.cell === c.id);
    const regionPoints = region.every((n) => next.players[0].board[n.id])
      ? (region.length * (region.length + 1)) / 2 + 10
      : 0;
    expect(next.players[0].score).toBe(5 + before * 4 + regionPoints);
  });
});
describe("knowledge and goods", () => {
  it("sells every matching good, rewarding one silver per sale not per tile", () => {
    let s = game();
    s.players[0].goods = [3, 1, 0, 0, 0, 0];
    s.players[0].dice = [1, null];
    s = act(s, "sell", (a) => a.good === 1);
    expect(s.players[0].silver).toBe(2);
    expect(s.players[0].score).toBe(6);
    expect(s.players[0].goods[0]).toBe(0);
    expect(s.players[0].sold[0]).toBe(3);
  });
  it("knowledge 3/4 add sale silver and workers", () => {
    let s = game();
    teach(s, 3);
    teach(s, 4);
    s.players[0].goods = [1, 0, 0, 0, 0, 0];
    const w = s.players[0].workers;
    s = act(s, "sell", (a) => a.good === 1 && a.die === 0);
    expect(s.players[0].silver).toBe(3);
    expect(s.players[0].workers).toBe(w + 1);
  });
  it("knowledge 6 allows purchasing from numbered depots", () => {
    const s = game();
    s.players[0].silver = 2;
    teach(s, 6);
    expect(
      legalActions(s)
        .filter((a) => a.kind === "buy")
        .some((a) => a.depot === 0),
    ).toBe(true);
  });
  it("knowledge 9/10/11 discount their placement classes", () => {
    for (const [id, color] of [
      [9, "building"],
      [10, "ship"],
      [10, "animal"],
      [11, "mine"],
      [11, "castle"],
      [11, "knowledge"],
    ] as [number, Color][]) {
      const { s, c } = preparePlace(
        tile(color, { building: color === "building" ? "bank" : undefined }),
      );
      s.players[0].dice = [(c.die % 6) + 1, null];
      teach(s, id, c.id);
      expect(
        legalActions(s).find((a) => a.kind === "place" && a.cell === c.id)
          ?.cost,
      ).toBe(0);
    }
  });
  it("knowledge 12 discounts taking, while 13/14 improve worker actions", () => {
    let s = game();
    teach(s, 12);
    expect(
      legalActions(s).find(
        (a) => a.kind === "take" && a.depot === 5 && a.die === 0,
      )?.cost,
    ).toBe(0);
    teach(s, 13);
    teach(s, 14);
    const w = s.players[0].workers;
    s = act(s, "workers");
    expect(s.players[0].workers).toBe(w + 4);
    expect(s.players[0].silver).toBe(2);
  });
  it("ships change next-round order, not the current round", () => {
    const { s, c } = preparePlace(tile("ship"));
    s.order = [1, 0];
    const next = act(s, "place", (a) => a.cell === c.id);
    expect(next.order).toEqual([1, 0]);
    expect(turnOrder(next)[0]).toBe(0);
    expect(next.pending[0].kind).toBe("ship");
  });
  it("ship loading offers choices at the three-type limit and leaves uncollected goods", () => {
    let s = game();
    s.pending = [{ kind: "ship" }];
    s.players[0].goods = [1, 1, 0, 0, 0, 0];
    s.depots[0].goods = [1, 3, 3, 4];
    s = act(s, "ship", (a) => a.depots?.[0] === 0);
    const options = legalActions(s);
    expect(options).toHaveLength(2);
    s = act(s, "goods", (a) => a.types?.includes(3) ?? false);
    expect(s.players[0].goods).toEqual([2, 1, 2, 0, 0, 0]);
    expect(s.depots[0].goods).toEqual([4]);
  });
  it("knowledge 5 collects from two adjacent depots, including 6 and 1", () => {
    let s = game();
    teach(s, 5);
    s.pending = [{ kind: "ship" }];
    s.players[0].goods = Array(6).fill(0);
    s.depots[5].goods = [2];
    s.depots[0].goods = [3];
    s = act(s, "ship", (a) => JSON.stringify(a.depots) === "[5,0]");
    s = act(s, "goods");
    expect(s.players[0].goods[1]).toBe(1);
    expect(s.players[0].goods[2]).toBe(1);
  });
});
describe("rounds, phase income and endgame", () => {
  it("pays mine income and knowledge 2 before refilling a phase, retaining depot goods", () => {
    let s = game();
    s.round = 4;
    s.turnIndex = 1;
    s.order = [1, 0];
    s.players[0].dice = [null, null];
    const spot = BOARD.find((c) => c.color === "mine")!;
    s.players[0].board[spot.id] = tile("mine");
    teach(s, 2);
    s.depots[0].goods = [6, 6];
    const w = s.players[0].workers;
    s = act(s, "end");
    expect(s.phase).toBe(1);
    expect(s.round).toBe(0);
    expect(s.players[0].silver).toBe(2);
    expect(s.players[0].workers).toBe(w + 1);
    expect(
      s.depots[0].goods.filter((g) => g === 6).length,
    ).toBeGreaterThanOrEqual(2);
  });
  it("awards both first/second colour bonuses once", () => {
    let s = game();
    const cells = BOARD.filter((c) => c.color === "mine");
    for (const who of [0, 1]) {
      s.active = who;
      s.players[who].workers = 12;
      s.players[who].board = BOARD.map(() => null);
      for (const c of cells.slice(1)) s.players[who].board[c.id] = tile("mine");
      const c = cells[0];
      const near = BOARD.find(
        (n) =>
          n.id !== c.id &&
          Math.max(
            Math.abs(n.q - c.q),
            Math.abs(n.r - c.r),
            Math.abs(n.q + n.r - c.q - c.r),
          ) === 1,
      )!;
      s.players[who].board[near.id] = tile(near.color);
      s.players[who].storage = [tile("mine")];
      s.players[who].dice = [c.die, null];
      s = act(s, "place", (a) => a.cell === c.id);
      expect(s.players[who].bonuses).toContain("mine");
    }
    expect(s.claimed.mine).toEqual([0, 1]);
  });
  it("computes endgame knowledge 15–26 and resource points, no stored-tile points", () => {
    let s = game();
    s.phase = 4;
    s.round = 4;
    s.turnIndex = 1;
    s.order = [1, 0];
    s.players[0].dice = [null, null];
    s.players[0].board = BOARD.map(() => null);
    for (let n = 15; n <= 26; n++) teach(s, n);
    let index = 20;
    for (const building of Object.values(KNOWLEDGE_BUILDING))
      s.players[0].board[index++] = tile("building", { building });
    s.players[0].board[30] = tile("animal", { animal: "sheep", count: 4 });
    s.players[0].board[31] = tile("animal", { animal: "pig", count: 2 });
    s.players[0].sold = [2, 1, 0, 0, 0, 0];
    s.players[0].goods = [1, 2, 0, 0, 0, 0];
    s.players[0].silver = 5;
    s.players[0].workers = 5;
    s.players[0].bonuses = COLORS.slice(0, 2);
    s.players[0].storage = [tile("castle")];
    s = act(s, "end");
    expect(s.status).toBe("finished");
    expect(s.players[0].final).toEqual({
      goods: 3,
      silver: 5,
      workers: 2,
      knowledge: 6 + 32 + 8 + 3 + 4,
    });
    expect(s.players[0].score).toBe(63);
    expect(legalActions(s)).toEqual([]);
  });
  it("breaks score ties by more empty estate spaces, then later turn order", () => {
    let s = game();
    s.phase = 4;
    s.round = 4;
    s.turnIndex = 1;
    s.order = [1, 0];
    s.players[0].dice = [null, null];
    for (const p of s.players) {
      p.goods = Array(6).fill(0);
      p.silver = 0;
      p.workers = 0;
      p.score = 0;
      p.board = BOARD.map(() => null);
    }
    s.players[1].board[START_CELL] = tile("castle");
    s = act(s, "end");
    expect(s.winner).toBe(0);
    s = game();
    s.phase = 4;
    s.round = 4;
    s.turnIndex = 1;
    s.order = [1, 0];
    s.players[0].dice = [null, null];
    for (const p of s.players) {
      p.goods = Array(6).fill(0);
      p.silver = 0;
      p.workers = 0;
      p.score = 0;
    }
    const later = turnOrder(s)[1];
    s = act(s, "end");
    expect(s.winner).toBe(later);
  });
  it("actions have unique identities", () => {
    const keys = legalActions(game()).map(actionKey);
    expect(new Set(keys).size).toBe(keys.length);
  });
  it("preserves pending choices and deterministic future rolls through JSON save/resume", () => {
    let s = game();
    s.pending = [{ kind: "ship" }];
    s = act(s, "ship");
    let restored = JSON.parse(JSON.stringify(s)) as State;
    expect(legalActions(restored)).toEqual(legalActions(s));
    for (let step = 0; step < 12; step++) {
      const actions = legalActions(s);
      const a =
        actions.find(
          (a) => a.kind === "goods" || a.kind === "workers" || a.kind === "end",
        ) ?? actions[0];
      s = applyAction(s, a);
      restored = applyAction(restored, a);
      expect(restored).toEqual(s);
    }
  });
});
