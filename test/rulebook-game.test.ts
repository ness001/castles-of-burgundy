import { describe, expect, it } from "vitest";
import { BOARDS, BOARD_SIDES, START_CELL, boardFor } from "../src/boards";
import { COLORS } from "../src/data";
import { actionKey, applyAction, canPlace, createGame, legalActions, turnOrder } from "../src/engine";
import { regionOutcome } from "../src/presentation";
import { chooseAction } from "../src/ai";
import type { Action, Color, GameOptions, State, Tile } from "../src/types";

const tile = (color: Color, id: string): Tile => ({ id, color,
  ...(color === "animal" ? { animal: "sheep" as const, count: 2 } : {}),
  ...(color === "building" ? { building: "watchtower" as const } : {}),
  ...(color === "knowledge" ? { knowledge: 1 } : {}),
});
function act(s: State, kind: Action["kind"], match: Partial<Action> = {}) {
  const a = legalActions(s).find(a => a.kind === kind && Object.entries(match).every(([key, value]) => a[key as keyof Action] === value));
  expect(a, `Legal ${kind}: ${JSON.stringify(match)}`).toBeDefined();
  return applyAction(s, a!);
}
const neighbors = (a: typeof BOARDS[1][number], b: typeof BOARDS[1][number]) =>
  Math.max(Math.abs(a.q - b.q), Math.abs(a.r - b.r), Math.abs(a.q + a.r - b.q - b.r)) === 1;

describe("rulebook setup, number of players, and optional estates", () => {
  it.each([2, 3, 4] as const)("deals the exact %i-player starting resources and printed depot slots", playerCount => {
    const s = createGame(891, { playerCount });
    const expected: Color[][] = [
      ["ship", "building", "knowledge", "animal"],
      ["castle", "knowledge", "building", "building"],
      ["animal", "building", "ship", "knowledge"],
      ["ship", "building", "animal", "mine"],
      ["mine", "knowledge", "building", "building"],
      ["animal", "building", "castle", "ship"],
    ];
    expect(s.depots.map(d => d.tiles.map(t => t.color))).toEqual(expected.map(row => row.slice(0, playerCount)));
    expect(s.black).toHaveLength(playerCount * 2);
    expect(s.black.every(t => t.black)).toBe(true);
    expect(s.players).toHaveLength(playerCount);
    expect(s.order).toEqual(turnOrder(s));
    for (const [id, p] of s.players.entries()) {
      expect(p.board.filter(Boolean)).toHaveLength(1);
      expect(p.board[START_CELL]?.color).toBe("castle");
      expect(p.storage).toEqual([]);
      expect(p.goods.reduce((a, b) => a + b)).toBe(3);
      expect(p.goods.filter(Boolean).length).toBeLessThanOrEqual(3);
      expect(p.workers).toBe(s.order.indexOf(id) + 1);
      expect(p.silver).toBe(1);
      expect(p.score).toBe(0);
      expect(p.dice.every(d => d !== null && d >= 1 && d <= 6)).toBe(true);
    }
    expect(s.phaseGoods).toHaveLength(4);
    expect(s.depots.flatMap(d => d.goods)).toHaveLength(1);
    expect(s.depots[s.whiteDie - 1].goods).toHaveLength(1);
    expect(s.pending).toEqual([]);
  });

  it.each(["open", "secret"] as const)("deals physical boards without replacement and resolves %s starting choices", estates => {
    let s = createGame(998, { playerCount: 4, estates });
    expect(s).toEqual(createGame(998, { playerCount: 4, estates }));
    // Page 12 changes Game Setup, before phase A reveals market and round goods.
    expect(s.phaseGoods).toEqual([]);
    expect(s.depots.flatMap(d => d.tiles)).toEqual([]);
    expect(s.black).toEqual([]);
    expect(s.depots.flatMap(d => d.goods)).toEqual([]);
    expect(new Set(s.setup!.boards.map(pair => pair.join(","))).size).toBe(4);
    for (const pair of s.setup!.boards) expect(BOARD_SIDES).toContainEqual(pair);
    const order = [...s.order];
    const selections: { who: number; boardId: number; cell: number }[] = [];
    for (let index = 0; index < 4; index++) {
      expect(s.active).toBe(order[index]);
      expect(s.players.every(p => p.dice.every(d => d === null))).toBe(true);
      const options = legalActions(s);
      expect(options).toHaveLength(8);
      expect(new Set(options.map(actionKey)).size).toBe(8);
      expect(options.every(a => a.kind === "choose-estate" && BOARDS[a.boardId!][a.cell!].color === "castle")).toBe(true);
      const a = options[index + 2];
      selections.push({ who: s.active, boardId: a.boardId!, cell: a.cell! });
      const before = structuredClone(s);
      s = applyAction(s, a);
      expect(before.status).toBe("setup");
      expect(s.players.every(p => p.score === 0 && !p.bonuses.length)).toBe(true);
      if (index < 3) {
        expect(s.status).toBe("setup");
        expect(s.depots.flatMap(d => d.tiles)).toEqual([]);
        expect(s.black).toEqual([]);
        expect(s.phaseGoods).toEqual([]);
        expect(s.pending).toEqual([]);
        expect(s.players.reduce((n, p) => n + p.board.filter(Boolean).length, 0)).toBe(estates === "open" ? index + 1 : 0);
        if (estates === "secret") expect(s.log.join("\n")).not.toMatch(/settle estate #/);
        const restored = JSON.parse(JSON.stringify(s)) as State;
        expect(legalActions(restored)).toEqual(legalActions(s));
        s = restored;
      }
    }
    expect(s.status).toBe("playing");
    expect(s.setup).toBeUndefined();
    expect(s.order).toEqual(order);
    expect(s.active).toBe(order[0]);
    expect(s.phaseGoods).toHaveLength(4);
    expect(s.depots.flatMap(d => d.goods)).toHaveLength(1);
    expect(s.pending).toEqual([]);
    for (const { who, boardId, cell } of selections) {
      expect(s.players[who].boardId).toBe(boardId);
      expect(s.players[who].board.filter(Boolean)).toHaveLength(1);
      expect(s.players[who].board[cell]?.color).toBe("castle");
    }
  });

  it("rejects a starting castle on the wrong color or a board not dealt to that player", () => {
    const s = createGame(129, { estates: "open" });
    const a = legalActions(s)[0];
    expect(() => applyAction(s, { ...a, cell: BOARDS[a.boardId!].find(c => c.color !== "castle")!.id })).toThrow();
    const undealt = Object.keys(BOARDS).map(Number).find(id => !s.setup!.boards[s.active].includes(id))!;
    expect(() => applyAction(s, { ...a, boardId: undealt })).toThrow();
    expect(() => applyAction(s, { kind: "workers", die: 0, cost: 0, label: "" })).toThrow();
  });

  it.each([2, 3, 4, 5, 6, 7, 8, 9])("uses estate #%i's colors, neighbors and regions instead of estate #1", boardId => {
    const s = createGame(7), p = s.players[s.active], board = BOARDS[boardId];
    p.boardId = boardId;
    p.board.fill(null);
    const start = board.find(c => c.color === "castle")!;
    p.board[start.id] = tile("castle", "start");
    p.workers = 0;
    for (const c of board.filter(c => neighbors(c, start))) {
      const t = tile(c.color, `neighbor-${c.id}`);
      expect(canPlace(p, t, c.id)).toBe(true);
      p.storage = [t];
      p.dice = [c.die, null];
      const a = legalActions(s).find(a => a.kind === "place" && a.cell === c.id);
      expect(a?.cost).toBe(0);
      const next = applyAction(s, a!);
      expect(next.players[s.active].board[c.id]?.id).toBe(t.id);
      expect(p.board[c.id]).toBeNull();
    }
    const wrong = board.find(c => c.id !== start.id && c.color !== "castle")!;
    expect(canPlace(p, tile("castle", "wrong-color"), wrong.id)).toBe(false);
  });
});

describe("rulebook scoring and chronology", () => {
  it("rounds add exactly the next face-up good using only the white die and preserve earlier depot goods", () => {
    let s = createGame(51, { playerCount: 4 });
    const phaseGoods = [...s.phaseGoods];
    const beforeGoods = s.depots.map(d => [...d.goods]);
    const beforeDice = s.players.map(p => [...p.dice]);
    const beforeOrder = [...s.order];
    for (let turn = 0; turn < 4; turn++) {
      expect(s.active).toBe(beforeOrder[turn]);
      const white = s.whiteDie;
      s = act(s, "workers", { die: 0 });
      s = act(s, "workers", { die: 1 });
      expect(s.whiteDie).toBe(white);
      s = act(s, "end");
      if (turn < 3) {
        expect(s.round).toBe(0);
        expect(s.phaseGoods).toEqual(phaseGoods);
        expect(s.depots.map(d => d.goods)).toEqual(beforeGoods);
        expect(s.players[s.active].dice).toEqual(beforeDice[s.active]);
      }
    }
    expect(s.round).toBe(1);
    expect(s.phaseGoods).toEqual(phaseGoods.slice(1));
    beforeGoods[s.whiteDie - 1].push(phaseGoods[0]);
    expect(s.depots.map(d => d.goods)).toEqual(beforeGoods);
    expect(s.players.every(p => p.dice.every(d => d !== null))).toBe(true);
  });

  it.each(["before", "between", "after"])("permits the one purchase %s dice, resets for each player and removes a replaced reserve permanently", when => {
    let s = createGame(93, { playerCount: 3 });
    const who = s.active, p = s.players[who];
    p.silver = 8;
    p.storage = [tile("mine", "discard-this"), tile("ship", "keep-ship"), tile("castle", "keep-castle")];
    for (let spent = 0; spent < (when === "after" ? 2 : when === "between" ? 1 : 0); spent++)
      s = act(s, "workers", { die: spent });
    const dice = [...s.players[who].dice], buy = legalActions(s).find(a => a.kind === "buy" && a.discard === "discard-this")!;
    s = applyAction(s, buy);
    expect(s.players[who].silver).toBe(6);
    expect(s.players[who].dice).toEqual(dice);
    expect(s.players[who].storage.map(t => t.id)).toEqual(["keep-ship", "keep-castle", buy.tile]);
    expect(legalActions(s).some(a => a.kind === "buy")).toBe(false);
    for (let die = 0; die < 2; die++) if (s.players[who].dice[die] !== null) s = act(s, "workers", { die });
    s = act(s, "end");
    expect(s.purchased).toBe(false);
    s.players[s.active].silver = 2;
    expect(legalActions(s).some(a => a.kind === "buy")).toBe(true);
    expect(JSON.stringify(s)).not.toContain("discard-this");
  });

  it("final mine income and knowledge workers precede scoring; ties use the final track, not the previous round order", () => {
    let s = createGame(892, { playerCount: 4 });
    s.phase = 4; s.round = 4; s.active = 0; s.turnIndex = 3; s.order = [3, 2, 1, 0];
    for (const [who, p] of s.players.entries()) {
      p.board.fill(null); p.goods.fill(0); p.sold.fill(0);
      p.workers = 0; p.silver = 0; p.score = 0; p.dice = [null, null];
      p.ships = who === 2 ? 1 : 0; p.arrival = who + 1;
    }
    s.players[0].board[24] = tile("mine", "final-mine");
    s.players[0].board[12] = { id: "final-guild", color: "knowledge", knowledge: 2 };
    s.players[0].workers = 1;
    // Equal final score and occupancy, but player 1 later on the ship track wins.
    s.players[1].board[18] = tile("castle", "tie-castle");
    s.players[1].board[19] = tile("ship", "tie-ship");
    s.players[1].score = 2;
    s.players[0].arrival = 5;
    expect(turnOrder(s).indexOf(1)).toBeGreaterThan(turnOrder(s).indexOf(0));
    s = act(s, "end");
    expect(s.players[0].final).toEqual({ goods: 0, silver: 1, workers: 1, knowledge: 0 });
    expect(s.players[0].score).toBe(2);
    expect(s.players[1].score).toBe(2);
    expect(s.winner).toBe(1);
  });

  it.each([2, 3, 4] as const)("sells the full type for %i points per tile and one silver per sale", playerCount => {
    let s = createGame(41, { playerCount });
    const who = s.active, p = s.players[who];
    p.goods = [3, 2, 0, 0, 0, 0];
    p.dice = [1, 2];
    p.workers = 0;
    s = act(s, "sell", { good: 1, die: 0 });
    expect(s.players[who].score).toBe(playerCount * 3);
    expect(s.players[who].silver).toBe(2);
    expect(s.players[who].goods).toEqual([0, 2, 0, 0, 0, 0]);
    expect(s.players[who].sold).toEqual([3, 0, 0, 0, 0, 0]);
    expect(s.players[who].dice).toEqual([null, 2]);
  });

  it.each([2, 3, 4] as const)("awards every color's first/second bonus exactly once with %i players", playerCount => {
    for (const color of COLORS) {
      let s = createGame(51, { playerCount });
      for (let who = 0; who < playerCount; who++) {
        s.active = who;
        s.pending = [];
        const p = s.players[who], board = boardFor(p);
        const cell = board.find(c => c.color === color)!;
        // Knowledge 1 allows repeated fixture buildings, without changing rewards.
        p.board = board.map(c => c.id === cell.id ? null : c.color === "knowledge"
          ? { id: `fixture-${who}-${c.id}`, color: "knowledge", knowledge: 1 }
          : tile(c.color, `fixture-${who}-${c.id}`));
        p.storage = [tile(color, `last-${who}-${color}`)];
        p.dice = [cell.die, null];
        p.workers = 0;
        const baseline = { ...structuredClone(s), claimed: { ...structuredClone(s.claimed), [color]: [0, 1] } };
        const nextWithoutBonus = act(baseline, "place", { cell: cell.id });
        s = act(s, "place", { cell: cell.id });
        expect(s.players[who].score - nextWithoutBonus.players[who].score).toBe(who === 0 ? playerCount + 3 : who === 1 ? playerCount : 0);
        expect(s.players[who].bonuses).toEqual(who < 2 ? [color] : []);
        expect(s.claimed[color]).toEqual(Array.from({ length: Math.min(who + 1, 2) }, (_, i) => i));
      }
    }
  });

  it("scores all original region sizes 1–8 in every phase using that estate's shape", () => {
    const examples = new Map<number, { boardId: number; cells: typeof BOARDS[1] }>();
    for (const [id, board] of Object.entries(BOARDS))
      for (const region of new Set(board.map(c => c.region))) {
        const cells = board.filter(c => c.region === region);
        examples.set(cells.length, { boardId: Number(id), cells });
      }
    expect([...examples.keys()].sort()).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    const sizeScores = [0, 1, 3, 6, 10, 15, 21, 28, 36];
    for (const [size, { boardId, cells }] of examples) for (let phase = 0; phase < 5; phase++) {
      const s = createGame(34), p = s.players[s.active];
      p.boardId = boardId;
      const board = boardFor(p), last = cells[0];
      p.board = board.map(() => null);
      for (const c of cells.slice(1)) p.board[c.id] = tile(c.color, `region-${c.id}`);
      const adjacent = board.find(c => c.region !== last.region && neighbors(c, last))!;
      p.board[adjacent.id] = tile(adjacent.color, "adjacent");
      const knowledge = board.find(c => c.color === "knowledge" && c.id !== last.id)!;
      p.board[knowledge.id] = { id: "allow-duplicates", color: "knowledge", knowledge: 1 };
      p.storage = [tile(last.color, "complete-region")];
      p.dice = [last.die, null];
      p.workers = 0;
      s.phase = phase;
      s.claimed[last.color] = [0, 1];
      const outcome = regionOutcome(p, last.id, phase);
      expect(outcome).toMatchObject({ size, remaining: 1, base: sizeScores[size], timing: [10, 8, 6, 4, 2][phase] });
      const next = act(s, "place", { cell: last.id });
      const effect = last.color === "animal" ? cells.length * 2 : last.color === "building" ? 4 : 0;
      expect(next.players[s.active].score).toBe(sizeScores[size] + [10, 8, 6, 4, 2][phase] + effect);
      expect(regionOutcome(next.players[s.active], last.id, phase).remaining).toBe(0);
    }
  });

  it("ships move atop equal ship counts, without changing the current round or dice", () => {
    let s = createGame(85, { playerCount: 4 });
    const who = s.order[1], order = [...s.order];
    s.active = who; s.turnIndex = 1;
    const p = s.players[who];
    const c = boardFor(p)[19];
    p.storage = [tile("ship", "ship-tie")]; p.dice = [c.die, 2];
    for (const [id, rival] of s.players.entries()) { rival.ships = id === who ? 0 : 1; rival.arrival = id; }
    s.serial = 20;
    const white = s.whiteDie, otherDice = s.players.map(p => [...p.dice]);
    s = act(s, "place", { cell: c.id });
    expect(s.order).toEqual(order);
    expect(turnOrder(s)[0]).toBe(who);
    expect(s.players[who].arrival).toBe(21);
    expect(s.whiteDie).toBe(white);
    for (let id = 0; id < 4; id++) if (id !== who) expect(s.players[id].dice).toEqual(otherDice[id]);
  });
});

const runs: GameOptions[] = ([2, 3, 4] as const).flatMap(playerCount =>
  (["beginner", "open", "secret"] as const).map(estates => ({ playerCount, estates })));
it.each(runs)("completes 25 rounds with exact inventories and 50 dice actions per player: $playerCount / $estates", options => {
  let s = createGame(1937, options), rng = 1937, steps = 0;
  const rounds = new Set<string>(), phaseSeen = new Set<number>();
  const spent = s.players.map(() => 0), ended = s.players.map(() => 0);
  const allIds = new Set<string>();
  while (s.status !== "finished" && steps++ < 2000) {
    if (s.status === "playing") {
      rounds.add(`${s.phase}:${s.round}`);
      if (!phaseSeen.has(s.phase)) {
        phaseSeen.add(s.phase);
        const last = s.depots[5].tiles.map(t => t.color);
        if (options.playerCount === 3) expect(last).toEqual(["animal", "building", s.phase % 2 ? "mine" : "castle"]);
        if (options.playerCount === 4) expect(last).toEqual(["animal", "building", "castle", "ship"]);
        expect(s.depots.flatMap(d => d.tiles)).toHaveLength(options.playerCount! * 6);
        expect(s.black).toHaveLength(options.playerCount! * 2);
        for (const t of [...s.depots.flatMap(d => d.tiles), ...s.black]) {
          expect(allIds.has(t.id)).toBe(false);
          allIds.add(t.id);
        }
      }
    }
    const actions = legalActions(s);
    expect(actions.length).toBeGreaterThan(0);
    rng = (Math.imul(rng, 1664525) + 1013904223) >>> 0;
    const preferred = actions.filter(a => ["place", "goods", "ship", "sell", "end", "choose-estate"].includes(a.kind));
    const candidates = preferred.length ? preferred : actions;
    const a = candidates[rng % candidates.length];
    if (a.die !== undefined) spent[s.active]++;
    if (a.kind === "end") ended[s.active]++;
    s = applyAction(s, a);
    for (const p of s.players) {
      expect(p.storage.length).toBeLessThanOrEqual(3);
      expect(p.goods.filter(Boolean).length).toBeLessThanOrEqual(3);
      for (const value of [p.workers, p.silver, p.score, ...p.goods, ...p.sold]) {
        expect(Number.isInteger(value)).toBe(true); expect(value).toBeGreaterThanOrEqual(0);
      }
      for (const c of boardFor(p)) if (p.board[c.id]) expect(p.board[c.id]!.color).toBe(c.color);
    }
    const liveTiles = [...s.players.flatMap(p => [...p.board.filter((t): t is Tile => t !== null), ...p.storage]),
      ...s.depots.flatMap(d => d.tiles), ...s.black, ...s.blackPool, ...COLORS.flatMap(c => s.pools[c])];
    expect(new Set(liveTiles.map(t => t.id)).size).toBe(liveTiles.length);
    const goods = s.goodsPool.length + s.phaseGoods.length + s.depots.flatMap(d => d.goods).length +
      s.players.reduce((n, p) => n + [...p.goods, ...p.sold].reduce((a, b) => a + b), 0);
    expect(goods).toBe(42);
    const restored = JSON.parse(JSON.stringify(s)) as State;
    expect(legalActions(restored)).toEqual(legalActions(s));
  }
  expect(s.status).toBe("finished");
  expect(rounds.size).toBe(25);
  expect([...phaseSeen]).toEqual([0, 1, 2, 3, 4]);
  expect(spent).toEqual(s.players.map(() => 50));
  expect(ended).toEqual(s.players.map(() => 25));
  expect(s.players.every(p => p.final !== undefined)).toBe(true);
  expect(s.winner).not.toBeNull();
  expect(legalActions(s)).toEqual([]);
});

it("all four AI seats finish an advanced private-setup match on their chosen estates", () => {
  let s = createGame(2946, { playerCount: 4, estates: "secret" }), moves = 0;
  const spent = [0, 0, 0, 0];
  while (s.status !== "finished" && moves++ < 2000) {
    const action = chooseAction(s);
    if (action.die !== undefined) spent[s.active]++;
    // The authoritative boundary revalidates every AI choice, including the
    // final player's last turn and all nested actions on alternative boards.
    s = applyAction(s, action);
  }
  expect(s.status).toBe("finished");
  expect(s.players.some(p => p.boardId !== 1)).toBe(true);
  expect(spent).toEqual([50, 50, 50, 50]);
  expect(s.players.every(p => p.final !== undefined && Number.isFinite(p.score))).toBe(true);
  expect(moves).toBeLessThan(2000);
}, 30_000);
