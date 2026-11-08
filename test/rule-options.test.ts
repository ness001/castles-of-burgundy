import { describe, expect, it } from "vitest";
import { soundsForAction } from "../src/audio";
import { BOARDS } from "../src/boards";
import { KNOWLEDGE, createTiles, knowledgeInfo, tileDescription, tileName } from "../src/data";
import { applyAction, createGame, legalActions } from "../src/engine";
import { motionForAction } from "../src/motion-events";
import { tileBenefit } from "../src/presentation";
import { rulesFor } from "../src/rules";
import { chooseAction } from "../src/ai";
import type { Action, Color, Pending, Player, Ruleset, State, Tile } from "../src/types";

const profiles = [undefined, "original-2011", "special-edition"] as const;

it("finishes a four-player Special Edition rules game across all phases and a save round-trip", () => {
  let s = createGame(941, { playerCount: 4, estates: "secret", ruleset: "special-edition" });
  let moves = 0;
  const phases = new Set<number>(), diceUsed = [0, 0, 0, 0];
  while (s.status !== "finished" && moves++ < 2000) {
    if (s.status === "playing") phases.add(s.phase);
    const action = chooseAction(s);
    if (action.die !== undefined) diceUsed[s.active]++;
    s = applyAction(s, action);
    if (moves === 80) s = JSON.parse(JSON.stringify(s)) as State;
    expect(s.ruleset).toBe("special-edition");
  }
  expect(s.status).toBe("finished");
  expect([...phases]).toEqual([0, 1, 2, 3, 4]);
  expect(diceUsed).toEqual([50, 50, 50, 50]);
  expect(s.players.every(p => p.final && Number.isFinite(p.score))).toBe(true);
}, 30_000);
const tile = (id: string, color: Color, extra: Partial<Tile> = {}): Tile => ({ id, color, ...extra });

function game(ruleset?: Ruleset): State {
  const s = createGame(891, ruleset === undefined ? {} : { ruleset });
  s.active = 0;
  s.order = [0, 1];
  s.turnIndex = 0;
  s.depots = [
    [tile("0-bank", "building", { building: "bank" }), tile("0-ship", "ship")],
    [tile("1-castle", "castle"), tile("1-knowledge", "knowledge", { knowledge: 6 })],
    [tile("2-animal", "animal", { animal: "pig", count: 2 }), tile("2-tower", "building", { building: "watchtower" })],
    [tile("3-ship", "ship"), tile("3-workshop", "building", { building: "workshop" })],
    [tile("4-mine", "mine"), tile("4-knowledge", "knowledge", { knowledge: 15 })],
    [tile("5-animal", "animal", { animal: "sheep", count: 3 }), tile("5-hall", "building", { building: "hall" })],
  ].map(tiles => ({ tiles, goods: [] }));
  s.black = [tile("black-mine", "mine", { black: true }), tile("black-bank", "building", { building: "bank", black: true })];
  for (const [id, p] of s.players.entries()) {
    p.goods = [0, 0, 0, 0, 0, 0];
    p.sold = [0, 0, 0, 0, 0, 0];
    p.silver = 0;
    p.workers = 0;
    p.score = 0;
    p.dice = [1, 2];
    p.ships = 0;
    p.arrival = 2 - id;
  }
  return s;
}

function teach(p: Player, ...ids: number[]) {
  for (const knowledge of ids) {
    const cell = [12, 7, 3, 30, 34, 35].find(id => !p.board[id]);
    if (cell === undefined) throw Error("Knowledge fixture exceeds estate capacity");
    p.board[cell] = tile(`owned-${knowledge}`, "knowledge", { knowledge });
  }
}

function choice(s: State, kind: Action["kind"], match: Partial<Action> = {}): Action {
  const a = legalActions(s).find(a => a.kind === kind &&
    Object.entries(match).every(([key, value]) => a[key as keyof Action] === value));
  expect(a, `Expected legal ${kind}: ${JSON.stringify(match)}`).toBeDefined();
  return a!;
}

const act = (s: State, kind: Action["kind"], match: Partial<Action> = {}) => applyAction(s, choice(s, kind, match));
const offers = (s: State, kind: Action["kind"]) => legalActions(s).filter(a => a.kind === kind);
const restore = (s: State): State => JSON.parse(JSON.stringify(s));

function finish(s: State): State {
  s.phase = 4;
  s.round = 4;
  s.order = [1, 0];
  s.turnIndex = 1;
  s.active = 0;
  s.players[0].dice = [null, null];
  return act(s, "end");
}

describe("rule-option compatibility and saves", () => {
  it("defaults to the original four rules and gives each explicit profile its own values", () => {
    const original = {
      label: "Original 2011", knowledge6: "silver-purchase", soldTypePoints: 3,
      colorBonusPoints: 2, tieBreak: "most-empty",
    };
    expect(rulesFor({})).toEqual(original);
    expect(rulesFor({ ruleset: "original-2011" })).toEqual(original);
    expect(rulesFor({ ruleset: "special-edition" })).toEqual({
      label: "Special Edition rule changes", knowledge6: "worker-building", soldTypePoints: 2,
      colorBonusPoints: 3, tieBreak: "fewest-empty",
    });
  });

  it("does not add save fields to unselected games or change the seeded estate/tile deal", () => {
    const legacy = createGame(891);
    expect(legacy).toEqual(createGame(891, {}));
    expect(legacy).not.toHaveProperty("ruleset");
    expect(legacy).not.toHaveProperty("knowledge6Used");
    for (const ruleset of ["original-2011", "special-edition"] as const) {
      const explicit = createGame(891, { ruleset });
      expect(explicit.ruleset).toBe(ruleset);
      if (ruleset === "special-edition") expect(explicit.knowledge6Used).toBe(false);
      else expect(explicit).not.toHaveProperty("knowledge6Used");
      const { ruleset: _ruleset, knowledge6Used: _used, ...unchanged } = explicit;
      expect(unchanged).toEqual(legacy);
    }
    expect(Object.keys(BOARDS)).toEqual(["1", "2", "3", "4", "5", "6", "7", "8", "9"]);
    expect(legacy.players.map(p => p.board.length)).toEqual([37, 37]);
    expect(createTiles()).toHaveLength(164);
  });

  it.each(profiles)("round-trips %s and continues through the public command boundary", ruleset => {
    const original = game(ruleset);
    teach(original.players[0], 6);
    original.players[0].workers = 4;
    original.players[0].silver = 4;
    const loaded = restore(original);
    expect(loaded).toEqual(original);
    expect(loaded.ruleset).toBe(ruleset);
    expect(legalActions(loaded)).toEqual(legalActions(original));
    const action = choice(loaded, "workers", { die: 0 });
    const next = applyAction(loaded, action);
    expect(next).toEqual(applyAction(original, action));
    expect(next.ruleset).toBe(ruleset);
    expect(next.players[0].dice).toEqual([null, 2]);
    if (ruleset === undefined) {
      let ended = act(next, "workers", { die: 1 });
      ended = act(ended, "end");
      expect(ended).not.toHaveProperty("ruleset");
      expect(ended).not.toHaveProperty("knowledge6Used");
    }
  });

  it("retains a used worker trade and its interrupted bonus across JSON save/restore", () => {
    const s = game("special-edition");
    teach(s.players[0], 6);
    s.players[0].workers = 6;
    s.players[0].silver = 4;
    s.pending = [{ kind: "take", colors: ["ship", "animal"] }, { kind: "free" }];
    const unusedTarget = choice(s, "trade", { tile: "2-tower" });
    const used = act(s, "trade", { tile: "0-bank" });
    const loaded = restore(used);
    expect(loaded).toEqual(used);
    expect(loaded).toMatchObject({ ruleset: "special-edition", knowledge6Used: true, purchased: false });
    expect(loaded.players[0]).toMatchObject({ workers: 4, silver: 4, dice: [1, 2] });
    expect(loaded.pending).toEqual([{ kind: "take", colors: ["ship", "animal"] }, { kind: "free" }]);
    expect(legalActions(loaded)).toEqual(legalActions(used));
    expect(offers(loaded, "trade")).toEqual([]);
    expect(() => applyAction(loaded, unusedTarget)).toThrow(/not legal/);
    const purchased = act(loaded, "buy", { tile: "black-mine" });
    expect(purchased).toMatchObject({ knowledge6Used: true, purchased: true });
    expect(purchased.players[0].silver).toBe(2);
    expect(purchased.pending).toEqual(loaded.pending);
  });
});

describe("Knowledge 6: original purchase", () => {
  it.each([undefined, "original-2011"] as const)("%s buys every colour from all seven sources for two silver, without a die", ruleset => {
    const s = game(ruleset);
    teach(s.players[0], 6);
    s.players[0].silver = 4;
    s.players[0].dice = [null, null];
    const buys = offers(s, "buy");
    expect([...new Set(buys.map(a => a.depot))]).toEqual([-1, 0, 1, 2, 3, 4, 5]);
    expect(buys.map(a => a.tile)).toEqual([
      "black-mine", "black-bank", "0-bank", "0-ship", "1-castle", "1-knowledge", "2-animal",
      "2-tower", "3-ship", "3-workshop", "4-mine", "4-knowledge", "5-animal", "5-hall",
    ]);
    expect(buys.every(a => a.cost === 0 && a.die === undefined)).toBe(true);
    expect(offers(s, "trade")).toEqual([]);
    const next = act(s, "buy", { tile: "4-mine" });
    expect(next.players[0]).toMatchObject({ silver: 2, workers: 0, dice: [null, null] });
    expect(next.players[0].storage.map(t => t.id)).toEqual(["4-mine"]);
    expect(next.depots[4].tiles.map(t => t.id)).toEqual(["4-knowledge"]);
    expect(next.purchased).toBe(true);
    expect(next).not.toHaveProperty("knowledge6Used");
    expect(offers(next, "buy")).toEqual([]);
    expect(() => applyAction(next, choice(s, "buy", { tile: "black-bank" }))).toThrow(/not legal/);
  });

  it.each([undefined, "original-2011"] as const)("%s cannot replace silver with workers", ruleset => {
    const s = game(ruleset);
    teach(s.players[0], 6);
    s.players[0].workers = 8;
    s.players[0].silver = 1;
    expect(offers(s, "buy")).toEqual([]);
    expect(offers(s, "trade")).toEqual([]);
    expect(() => applyAction(s, { kind: "buy", depot: 0, tile: "0-bank", cost: 0, label: "" })).toThrow(/not legal/);
  });
});

describe("Knowledge 6: Special Edition worker trade", () => {
  it.each([[1, 2], [null, 2], [null, null]])("takes only numbered-depot buildings before, between or after dice %j", (first, second) => {
    const s = game("special-edition");
    teach(s.players[0], 6);
    s.players[0].workers = 2;
    s.players[0].dice = [first, second];
    const trades = offers(s, "trade");
    expect(trades.map(a => [a.depot, a.tile, a.cost, a.die])).toEqual([
      [0, "0-bank", 2, undefined], [2, "2-tower", 2, undefined],
      [3, "3-workshop", 2, undefined], [5, "5-hall", 2, undefined],
    ]);
    const before = structuredClone(s);
    const next = act(s, "trade", { tile: "5-hall" });
    expect(next.players[0]).toMatchObject({ workers: 0, silver: 0, dice: [first, second] });
    expect(next.players[0].storage.map(t => t.id)).toEqual(["5-hall"]);
    expect(next.players[0].board).toEqual(before.players[0].board);
    expect(next.depots[5].tiles.map(t => t.id)).toEqual(["5-animal"]);
    expect(next).toMatchObject({ knowledge6Used: true, purchased: false, pending: [] });
    expect(s).toEqual(before);
  });

  it.each([
    [-1, "black-bank"], [0, "0-ship"], [1, "1-castle"], [1, "1-knowledge"],
    [2, "2-animal"], [4, "4-mine"], [6, "0-bank"],
  ] as const)("rejects a forged trade from depot %i for %s", (depot, id) => {
    const s = game("special-edition");
    teach(s.players[0], 6);
    s.players[0].workers = 8;
    s.players[0].silver = 8;
    const before = structuredClone(s);
    expect(() => applyAction(s, { kind: "trade", depot, tile: id, cost: 2, label: "" })).toThrow(/not legal/);
    expect(s).toEqual(before);
  });

  it.each([0, 1, 2])("requires exactly two workers, not silver or die-adjustment discounts (%i workers)", workers => {
    const s = game("special-edition");
    teach(s.players[0], 6, 8, 9, 12);
    s.players[0].workers = workers;
    s.players[0].silver = 8;
    s.pending = [{ kind: "free" }];
    if (workers < 2) {
      expect(offers(s, "trade")).toEqual([]);
      expect(() => applyAction(s, { kind: "trade", depot: 0, tile: "0-bank", cost: 0, label: "" })).toThrow(/not legal/);
    } else {
      const trade = choice(s, "trade", { tile: "0-bank" });
      expect(trade.cost).toBe(2);
      expect(() => applyAction(s, { ...trade, die: 0 })).toThrow(/not legal/);
      const next = applyAction(s, { ...trade, cost: -100, label: "Forged discount" });
      expect(next.players[0]).toMatchObject({ workers: 0, silver: 8, dice: [1, 2] });
      expect(next.pending).toEqual([{ kind: "free" }]);
      expect(next.log.at(-1)).toBe("You: Knowledge 6 · take Bank · depot 1 (−2 workers).");
    }
    expect(offers(s, "buy").map(a => a.depot)).toEqual([-1, -1]);
    expect(() => applyAction(s, { kind: "buy", depot: 0, tile: "0-bank", cost: 0, label: "" })).toThrow(/not legal/);
  });

  it.each(["buy", "trade"] as const)("keeps silver and worker quotas independent with %s first", first => {
    let s = game("special-edition");
    teach(s.players[0], 6);
    s.players[0].workers = 6;
    s.players[0].silver = 4;
    s = act(s, first, { tile: first === "buy" ? "black-mine" : "0-bank" });
    expect(s.purchased).toBe(first === "buy");
    expect(s.knowledge6Used).toBe(first === "trade");
    const second = first === "buy" ? "trade" : "buy";
    s = act(s, second, { tile: second === "buy" ? "black-mine" : "0-bank" });
    expect(s).toMatchObject({ purchased: true, knowledge6Used: true });
    expect(s.players[0]).toMatchObject({ silver: 2, workers: 4, dice: [1, 2] });
    expect(offers(s, "buy")).toEqual([]);
    expect(offers(s, "trade")).toEqual([]);
  });

  it("resets the used trade for the next player and again at the next round", () => {
    let s = game("special-edition");
    for (const p of s.players) {
      teach(p, 6);
      p.workers = 6;
      p.dice = [null, null];
    }
    s = act(s, "trade", { tile: "0-bank" });
    expect(s.knowledge6Used).toBe(true);
    s = act(s, "end");
    expect(s).toMatchObject({ active: 1, round: 0, knowledge6Used: false });
    s = act(s, "trade", { tile: "2-tower" });
    expect(s.knowledge6Used).toBe(true);
    s = act(s, "end");
    expect(s).toMatchObject({ active: 0, round: 1, knowledge6Used: false });
    s = act(s, "trade", { tile: "3-workshop" });
    expect(s.players.map(p => p.workers)).toEqual([2, 4]);
    expect(s.knowledge6Used).toBe(true);
  });

  it("does not reset the trade during a real castle → free City Hall → placement chain", () => {
    let s = game("special-edition");
    const p = s.players[0];
    teach(p, 6);
    p.board[11] = tile("connecting-tower", "building", { building: "watchtower" });
    p.storage = [tile("reserved-castle", "castle"), tile("reserved-hall", "building", { building: "hall" })];
    p.dice = [6, 3];
    p.workers = 6;
    s = act(s, "trade", { tile: "0-bank" });
    s = act(s, "place", { tile: "reserved-castle", cell: 6, die: 0 });
    expect(s.pending).toEqual([{ kind: "free" }]);
    expect(s.knowledge6Used).toBe(true);
    expect(offers(s, "trade")).toEqual([]);
    s = act(s, "place", { tile: "reserved-hall", cell: 25, die: undefined });
    expect(s.pending).toEqual([{ kind: "place" }]);
    expect(s.knowledge6Used).toBe(true);
    expect(offers(s, "trade")).toEqual([]);
    s = act(s, "place", { tile: "0-bank", cell: 31, die: undefined });
    expect(s.pending).toEqual([]);
    expect(s.players[0]).toMatchObject({ dice: [null, 3], workers: 4, silver: 2 });
    expect(s.knowledge6Used).toBe(true);
    expect(offers(s, "trade")).toEqual([]);
  });

  it.each([
    { kind: "take", colors: ["ship", "animal"] }, { kind: "place" }, { kind: "sell" },
    { kind: "free" }, { kind: "ship" }, { kind: "goods", depots: [5, 0] },
  ] satisfies Pending[])("interrupts $kind without consuming any pending bonus, even after a silver purchase", pending => {
    const s = game("special-edition");
    teach(s.players[0], 6);
    s.players[0].workers = 4;
    s.purchased = true;
    s.pending = [pending, { kind: "free" }];
    const next = act(s, "trade", { tile: "0-bank" });
    expect(next.pending).toEqual([pending, { kind: "free" }]);
    expect(next).toMatchObject({ purchased: true, knowledge6Used: true });
    expect(next.players[0]).toMatchObject({ workers: 2, silver: 0, dice: [1, 2] });
  });
});

describe("Knowledge 6 ownership and reserve boundary", () => {
  it.each(profiles)("%s requires placing one's own Knowledge 6, not buying itself or storing it", ruleset => {
    let s = game(ruleset);
    const p = s.players[0];
    teach(s.players[1], 6);
    p.workers = 4;
    p.silver = 4;
    p.dice = [2, 1];
    expect(offers(s, "buy").map(a => a.depot)).toEqual([-1, -1]);
    expect(offers(s, "trade")).toEqual([]);
    expect(() => applyAction(s, { kind: "buy", depot: 1, tile: "1-knowledge", cost: 0, label: "" })).toThrow(/not legal/);
    expect(() => applyAction(s, { kind: "trade", depot: 0, tile: "0-bank", cost: 2, label: "" })).toThrow(/not legal/);
    s = act(s, "take", { tile: "1-knowledge", die: 0 });
    expect(s.players[0].storage.map(t => t.id)).toEqual(["1-knowledge"]);
    expect(offers(s, "buy").map(a => a.depot)).toEqual([-1, -1]);
    expect(offers(s, "trade")).toEqual([]);
    s = act(s, "place", { tile: "1-knowledge", cell: 12, die: 1 });
    expect(s.players[0].dice).toEqual([null, null]);
    if (ruleset === "special-edition") {
      expect(offers(s, "trade").map(a => a.tile)).toEqual(["0-bank", "2-tower", "3-workshop", "5-hall"]);
      expect(offers(s, "buy").map(a => a.depot)).toEqual([-1, -1]);
    } else {
      expect([...new Set(offers(s, "buy").map(a => a.depot))]).toEqual([-1, 0, 1, 2, 3, 4, 5]);
      expect(offers(s, "trade")).toEqual([]);
    }
  });

  it.each(profiles)("%s requires a named replacement when all three reserve slots are full", ruleset => {
    const s = game(ruleset);
    teach(s.players[0], 6);
    s.players[0].workers = 4;
    s.players[0].silver = 4;
    s.players[0].storage = [tile("replace", "mine"), tile("keep-ship", "ship"), tile("keep-castle", "castle")];
    const kind = ruleset === "special-edition" ? "trade" : "buy";
    expect(offers(s, kind).filter(a => a.tile === "0-bank").map(a => a.discard))
      .toEqual(["replace", "keep-ship", "keep-castle"]);
    const a = choice(s, kind, { tile: "0-bank", discard: "replace" });
    expect(() => applyAction(s, { ...a, discard: undefined })).toThrow(/not legal/);
    expect(() => applyAction(s, { ...a, discard: "not-in-reserve" })).toThrow(/not legal/);
    const next = applyAction(s, a);
    expect(next.players[0].storage.map(t => t.id)).toEqual(["keep-ship", "keep-castle", "0-bank"]);
    expect(next.players[0].board).toEqual(s.players[0].board);
    expect(next.depots[0].tiles.map(t => t.id)).toEqual(["0-ship"]);
    expect([...next.depots.flatMap(d => d.tiles), ...next.black].some(t => t.id === "replace")).toBe(false);
    expect(next.players[0]).toMatchObject({
      workers: ruleset === "special-edition" ? 2 : 4,
      silver: ruleset === "special-edition" ? 4 : 2, dice: [1, 2],
    });
  });
});

describe("profile-specific final scoring and tie-breaks", () => {
  it.each([
    [undefined, 9, 28], ["original-2011", 9, 28], ["special-edition", 6, 25],
  ] as const)("%s scores Knowledge 15 by sold types, not sold tiles or unsold types", (ruleset, knowledge, score) => {
    const s = game(ruleset), p = s.players[0];
    teach(p, 15);
    p.sold = [2, 0, 4, 0, 1, 0];
    p.goods = [0, 1, 0, 0, 2, 0];
    p.silver = 4;
    p.workers = 5;
    p.score = 10;
    p.bonuses = ["ship", "knowledge"];
    p.storage = [tile("unbuilt-26", "knowledge", { knowledge: 26 }), tile("unbuilt-mine", "mine")];
    const next = finish(s);
    expect(next.status).toBe("finished");
    expect(next.players[0].final).toEqual({ goods: 3, silver: 4, workers: 2, knowledge });
    expect(next.players[0].score).toBe(score);
    expect(next.players[1].final?.knowledge).toBe(0);
  });

  it.each([
    [undefined, 4, 14], ["original-2011", 4, 14], ["special-edition", 6, 16],
  ] as const)("%s scores Knowledge 26 for this player's claimed bonuses only", (ruleset, knowledge, score) => {
    const s = game(ruleset), p = s.players[0];
    teach(p, 26);
    p.score = 10;
    p.bonuses = ["ship", "knowledge"];
    p.sold = [4, 0, 0, 0, 0, 0];
    p.storage = [tile("unbuilt-15", "knowledge", { knowledge: 15 })];
    s.players[1].bonuses = ["castle", "knowledge", "animal"];
    s.claimed.ship = [0];
    s.claimed.knowledge = [1, 0];
    s.claimed.castle = [1];
    s.claimed.animal = [1];
    const next = finish(s);
    expect(next.players[0].final).toEqual({ goods: 0, silver: 0, workers: 0, knowledge });
    expect(next.players[0].score).toBe(score);
    expect(next.players[1].final?.knowledge).toBe(0);
  });

  it.each(profiles)("%s awards no Knowledge 15/26 points without sales or bonuses", ruleset => {
    const s = game(ruleset);
    teach(s.players[0], 15, 26);
    expect(finish(s).players[0].final?.knowledge).toBe(0);
  });

  it.each([
    [undefined, 0, 1], [undefined, 1, 0],
    ["original-2011", 0, 1], ["original-2011", 1, 0],
    ["special-edition", 0, 0], ["special-edition", 1, 1],
  ] as const)("%s breaks tied scores with player %i having one fewer empty hex: winner %i", (ruleset, fuller, winner) => {
    const s = game(ruleset);
    s.players[fuller].board[25] = tile("extra-bank", "building", { building: "bank" });
    s.players[0].score = 100;
    s.players[1].score = 100;
    expect(s.players.map(p => p.board.filter(t => !t).length)).toEqual(fuller === 0 ? [35, 36] : [36, 35]);
    const next = finish(s);
    expect(next.players.map(p => p.score)).toEqual([100, 100]);
    expect(next.winner).toBe(winner);
  });

  it.each(profiles)("%s keeps the later final turn-order position as the last tie-break", ruleset => {
    const s = game(ruleset);
    s.players[0].ships = 2;
    s.players[1].ships = 1;
    const next = finish(s);
    expect(next.order).toEqual([1, 0]); // The cached round order is deliberately the opposite.
    expect(next.players.map(p => p.board.filter(t => !t).length)).toEqual([36, 36]);
    expect(next.players.map(p => p.score)).toEqual([0, 0]);
    expect(next.winner).toBe(1);
  });
});

describe("profile labels and unchanged default data", () => {
  it.each([
    [undefined, 6, "Open markets", "Your once-per-turn purchase may come from any numbered depot as well as the black market.", "Buy from any depot"],
    ["original-2011", 6, "Open markets", "Your once-per-turn purchase may come from any numbered depot as well as the black market.", "Buy from any depot"],
    ["special-edition", 6, "Building crews", "Once per turn, spend 2 workers to reserve a building from any numbered depot without a die. This is separate from your silver purchase.", "2 workers: take a building / turn"],
    [undefined, 15, "Diverse exports", "At the end, score 3 points per different goods type sold.", "End: +3 VP per goods type sold"],
    ["original-2011", 15, "Diverse exports", "At the end, score 3 points per different goods type sold.", "End: +3 VP per goods type sold"],
    ["special-edition", 15, "Diverse exports", "At the end, score 2 points per different goods type sold.", "End: +2 VP per goods type sold"],
    [undefined, 26, "Distinguished estate", "At the end, score 2 points per colour-completion bonus claimed.", "End: +2 VP per color bonus"],
    ["original-2011", 26, "Distinguished estate", "At the end, score 2 points per colour-completion bonus claimed.", "End: +2 VP per color bonus"],
    ["special-edition", 26, "Distinguished estate", "At the end, score 3 points per colour-completion bonus claimed.", "End: +3 VP per color bonus"],
  ] as const)("%s describes Knowledge %i using its own rules", (ruleset, id, name, description, benefit) => {
    const t = tile(`label-${id}`, "knowledge", { knowledge: id });
    expect(knowledgeInfo(id, ruleset)).toEqual({ name, description });
    expect(tileName(t, ruleset)).toBe(`Knowledge ${id} · ${name}`);
    expect(tileDescription(t, ruleset)).toBe(description);
    expect(tileBenefit(t, ruleset)).toBe(benefit);
  });

  it("leaves original knowledge, all other descriptions, and tile inventory unchanged after switching profiles", () => {
    const original = structuredClone(KNOWLEDGE);
    const tiles = createTiles();
    for (const t of tiles) {
      tileName(t, "special-edition");
      tileDescription(t, "special-edition");
      tileBenefit(t, "special-edition");
      if (![6, 15, 26].includes(t.knowledge ?? 0)) {
        expect(tileName(t, "special-edition")).toBe(tileName(t));
        expect(tileDescription(t, "special-edition")).toBe(tileDescription(t));
        expect(tileBenefit(t, "special-edition")).toBe(tileBenefit(t));
      }
    }
    expect(KNOWLEDGE).toEqual(original);
    expect(createTiles()).toEqual(tiles);
    expect(knowledgeInfo(6)).toEqual({
      name: "Open markets", description: "Your once-per-turn purchase may come from any numbered depot as well as the black market.",
    });
    expect(knowledgeInfo(15).description).toBe("At the end, score 3 points per different goods type sold.");
    expect(knowledgeInfo(26).description).toBe("At the end, score 2 points per colour-completion bonus claimed.");
  });

  it("uses the selected Knowledge 6 name in legal take/place and reserve-replacement labels", () => {
    let s = game("special-edition");
    s.players[0].dice = [2, 1];
    s.players[0].silver = 2;
    const take = choice(s, "take", { tile: "1-knowledge", die: 0 });
    expect(take.label).toBe("Take Knowledge 6 · Building crews · depot 2");
    s = applyAction(s, take);
    const place = choice(s, "place", { tile: "1-knowledge", cell: 12, die: 1 });
    expect(place.label).toBe("Place Knowledge 6 · Building crews");
    expect(applyAction(s, place).log).toContain("You: Place Knowledge 6 · Building crews.");
    s.players[0].storage.push(tile("reserve-ship", "ship"), tile("reserve-castle", "castle"));
    expect(choice(s, "buy", { tile: "black-mine", discard: "1-knowledge" }).label)
      .toBe("Buy Mine · 2 silver · replace Knowledge 6 · Building crews");
  });
});

it("gives a committed worker trade tile/worker audio and depot-to-reserve motion, not silver or dice effects", () => {
  const s = game("special-edition");
  teach(s.players[0], 6);
  s.players[0].workers = 4;
  const trade = choice(s, "trade", { tile: "0-bank" });
  const next = applyAction(s, trade);
  expect(soundsForAction(s, trade, next)).toEqual([{ sound: "tile", delay: 0 }, { sound: "workers", delay: 0.18 }]);
  expect(motionForAction(s, trade, next)).toEqual({
    actor: 0, roll: false, phaseChanged: false, regions: [], freeAction: false, silver: [], scores: [], goods: [],
    workers: [{ player: 0, amount: -2 }],
    tile: { tile: { id: "0-bank", color: "building", building: "bank" }, from: "depot", depot: 0 },
  });
  expect(motionForAction(next, trade, restore(next)).tile).toBeUndefined();
  expect(motionForAction(next, trade, s).tile).toBeUndefined();
});
