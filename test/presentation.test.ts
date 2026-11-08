import { describe, expect, it } from "vitest";
import { boardFor } from "../src/boards";
import { BOARD, KNOWLEDGE_BUILDING, tileName } from "../src/data";
import { applyAction, createGame, legalActions } from "../src/engine";
import { placementOutcome, regionOutcome, saleOutcome, tileBenefit } from "../src/presentation";
import type { GameOptions, State, Tile } from "../src/types";

describe("tileBenefit", () => {
  it.each([
    ["workshop", "Free building to reserve from any numbered depot"],
    ["church", "Free castle, mine or knowledge to reserve from any numbered depot"],
    ["market", "Free ship or animal tile to reserve from any numbered depot"],
    ["hall", "Build 1 tile from reserve for free"],
  ] as const)("states the source and destination of the %s benefit", (building, benefit) => {
    expect(tileBenefit({ id: building, color: "building", building })).toBe(benefit);
  });

  it("marks mine silver as phase-end income, not an immediate reward", () => {
    expect(tileBenefit({ id: "mine", color: "mine" }))
      .toBe("Each phase end: +1 silver");
  });

  it("pairs knowledge 2 workers with mine silver at every phase end, including the final phase", () => {
    expect(tileBenefit({ id: "knowledge-2", color: "knowledge", knowledge: 2 }))
      .toBe("Each phase end (including final): +1 worker per mine, alongside silver");
  });

  it.each([2, 3, 4])("keeps printed animal count %i and limits rescoring to the same species and connected pasture", count => {
    expect(tileBenefit({ id: "sheep", color: "animal", animal: "sheep", count }))
      .toBe(`Score ${count} animals + same species in this connected pasture`);
  });

  it("limits knowledge 9's free die step to building placement", () => {
    expect(tileBenefit({ id: "knowledge-9", color: "knowledge", knowledge: 9 }))
      .toBe("Build buildings: 1 free die step");
  });

  it("distinguishes the worker action from its silver reward", () => {
    expect(tileBenefit({ id: "knowledge-13", color: "knowledge", knowledge: 13 }))
      .toBe("Taking workers: +1 silver");
  });

  it("shows Knowledge 19's scoring consequence rather than just its number", () => {
    expect(tileBenefit({ id: "knowledge-19", color: "knowledge", knowledge: 19 }))
      .toBe("End: +4 VP per Church");
  });

  it("maps every building-scoring knowledge tile to the correct building", () => {
    for (const [knowledge, building] of Object.entries(KNOWLEDGE_BUILDING)) {
      const name = tileName({ id: "building", color: "building", building }).replace("Carpenter’s ", "");
      expect(tileBenefit({ id: knowledge, color: "knowledge", knowledge: Number(knowledge) }))
        .toBe(`End: +4 VP per ${name}`);
    }
  });
});

describe("saleOutcome", () => {
  it.each([
    { playerCount: 2, count: 1, knowledge: [], silver: 1, workers: 0 },
    { playerCount: 3, count: 1, knowledge: [], silver: 1, workers: 0 },
    { playerCount: 4, count: 1, knowledge: [], silver: 1, workers: 0 },
    { playerCount: 2, count: 3, knowledge: [], silver: 1, workers: 0 },
    { playerCount: 2, count: 3, knowledge: [3], silver: 2, workers: 0 },
    { playerCount: 2, count: 3, knowledge: [4], silver: 1, workers: 1 },
    { playerCount: 4, count: 3, knowledge: [3, 4], silver: 2, workers: 1 },
  ] as const)("matches a $count-item sale for $playerCount players with knowledge $knowledge", ({ playerCount, count, knowledge, silver, workers }) => {
    const state = createGame(42, { playerCount });
    const player = state.players[state.active];
    player.goods.fill(0);
    player.goods[3] = count;
    player.dice = [3, null];
    player.workers = 2;
    const cells = BOARD.filter(cell => cell.color === "knowledge");
    knowledge.forEach((id, index) => {
      player.board[cells[index].id] = { id: `owned-${id}`, color: "knowledge", knowledge: id };
    });
    const before = structuredClone(state);
    const outcome = saleOutcome(state, player, 4);
    expect(outcome).toEqual({ points: count * playerCount, silver, workers });
    expect(state).toEqual(before);

    const action = legalActions(state).find(a => a.kind === "sell" && a.good === 4 && a.die === 0)!;
    expect(action.cost).toBe(1);
    const sold = applyAction(state, action).players[state.active];
    expect(outcome).toEqual({
      points: sold.score - player.score,
      silver: sold.silver - player.silver,
      workers: sold.workers - player.workers + action.cost,
    });
    expect(sold.goods[3]).toBe(0);
  });

  it("returns no rewards for an empty stack, even with knowledge 3 and 4", () => {
    const state = createGame(42);
    const player = state.players[state.active];
    player.goods.fill(0);
    player.dice = [4, null];
    const cells = BOARD.filter(cell => cell.color === "knowledge");
    [3, 4].forEach((id, index) => {
      player.board[cells[index].id] = { id: `owned-${id}`, color: "knowledge", knowledge: id };
    });
    const before = structuredClone(state);
    expect(saleOutcome(state, player, 4)).toEqual({ points: 0, silver: 0, workers: 0 });
    expect(legalActions(state).some(a => a.kind === "sell")).toBe(false);
    expect(() => applyAction(state, { kind: "sell", die: 0, good: 4, cost: 0, label: "Sell empty stack" }))
      .toThrow("That action is not legal in the current position.");
    expect(state).toEqual(before);
  });
});

describe("placementOutcome", () => {
  function preparePlace(tile: Tile, options: GameOptions = {}, boardId = 1) {
    const state = createGame(42, options);
    state.active = state.players.length - 1;
    state.order = [state.active, ...state.order.filter(id => id !== state.active)];
    state.turnIndex = 0;
    const player = state.players[state.active];
    player.boardId = boardId;
    const board = boardFor(player);
    const cell = board.find(cell => cell.color === tile.color)!;
    const neighbor = board.find(other => other.color !== cell.color &&
      Math.max(Math.abs(other.q - cell.q), Math.abs(other.r - cell.r),
        Math.abs(other.q + other.r - cell.q - cell.r)) === 1)!;
    player.board = board.map(() => null);
    player.board[neighbor.id] = state.pools[neighbor.color].pop()!;
    player.storage = [tile];
    player.dice = [cell.die, null];
    player.score = 13;
    player.silver = 3;
    player.workers = 4;
    return { state, player, board, cell };
  }

  function preview(state: State, cell: number) {
    const action = legalActions(state).find(action => action.kind === "place" && action.cell === cell)!;
    expect(action).toBeDefined();
    const before = structuredClone(state);
    const outcome = placementOutcome(state, action);
    expect(state).toEqual(before);
    const next = applyAction(state, action);
    const player = state.players[state.active];
    const placed = next.players[state.active];
    expect(outcome).toMatchObject({
      points: placed.score - player.score,
      silver: placed.silver - player.silver,
      workers: placed.workers - player.workers + action.cost,
    });
    expect(outcome.points).toBe(outcome.tilePoints + outcome.regionPoints + outcome.colorPoints);
    return { action, outcome, next };
  }

  it.each([
    { building: "watchtower", cost: 0, points: 4, silver: 0, workers: 0 },
    { building: "bank", cost: 1, points: 0, silver: 2, workers: 0 },
    { building: "boarding", cost: 1, points: 0, silver: 0, workers: 4 },
  ] as const)("matches $building rewards with a $cost-worker adjustment, without netting the cost", ({ building, cost, points, silver, workers }) => {
    const { state, player, cell } = preparePlace({ id: building, color: "building", building });
    player.dice = [((cell.die - 1 + cost) % 6) + 1, null];
    const result = preview(state, cell.id);
    expect(result.action.cost).toBe(cost);
    expect(result.outcome).toEqual({ points, silver, workers, tilePoints: points, regionPoints: 0, colorPoints: 0 });
  });

  it("keeps a discounted boarding-house reward gross and a bonus placement free", () => {
    const { state, player, board, cell } = preparePlace({ id: "boarding", color: "building", building: "boarding" });
    const knowledgeCells = board.filter(cell => cell.color === "knowledge");
    [8, 9].forEach((knowledge, index) => {
      player.board[knowledgeCells[index].id] = { id: `owned-${knowledge}`, color: "knowledge", knowledge };
    });
    player.dice = [((cell.die - 1 + 3) % 6) + 1, null];
    player.workers = 1;
    const paid = preview(state, cell.id);
    expect(paid.action.cost).toBe(1);
    expect(paid.outcome.workers).toBe(4);
    expect(paid.next.players[state.active].workers).toBe(4);

    state.pending = [{ kind: "place" }];
    const free = preview(state, cell.id);
    expect(free.action.die).toBeUndefined();
    expect(free.action.cost).toBe(0);
    expect(free.outcome).toEqual(paid.outcome);
    expect(free.next.players[state.active].dice).toEqual(player.dice);
  });

  it.each([false, true])("rescores only matching animals in this pasture (knowledge 7: %s)", knowledge7 => {
    const { state, player, board, cell } = preparePlace({ id: "new-sheep", color: "animal", animal: "sheep", count: 2 });
    const region = board.filter(other => other.region === cell.region);
    player.board[region[1].id] = { id: "old-sheep", color: "animal", animal: "sheep", count: 3 };
    player.board[region[2].id] = { id: "cattle", color: "animal", animal: "cattle", count: 4 };
    const otherPasture = board.find(other => other.color === "animal" && other.region !== cell.region)!;
    player.board[otherPasture.id] = { id: "other-sheep", color: "animal", animal: "sheep", count: 4 };
    if (knowledge7) {
      const knowledgeCell = board.find(other => other.color === "knowledge")!;
      player.board[knowledgeCell.id] = { id: "knowledge-7", color: "knowledge", knowledge: 7 };
    }
    const points = knowledge7 ? 7 : 5;
    expect(preview(state, cell.id).outcome).toEqual({ points, silver: 0, workers: 0, tilePoints: points, regionPoints: 0, colorPoints: 0 });
  });

  it.each([
    { boardId: 1, phase: 0, regionPoints: 16 },
    { boardId: 1, phase: 4, regionPoints: 8 },
    { boardId: 8, phase: 2, regionPoints: 9 },
  ])("separates watchtower and region points on estate $boardId in phase $phase", ({ boardId, phase, regionPoints }) => {
    const { state, player, board, cell } = preparePlace({ id: "watchtower", color: "building", building: "watchtower" }, {}, boardId);
    state.phase = phase;
    const buildings = ["bank", "boarding"] as const;
    board.filter(other => other.region === cell.region && other.id !== cell.id).forEach((other, index) => {
      player.board[other.id] = { id: `built-${other.id}`, color: "building", building: buildings[index] };
    });
    expect(preview(state, cell.id).outcome).toEqual({ points: 4 + regionPoints, silver: 0, workers: 0, tilePoints: 4, regionPoints, colorPoints: 0 });
  });

  it.each([
    { playerCount: 2, claims: 0, colorPoints: 5 },
    { playerCount: 2, claims: 1, colorPoints: 2 },
    { playerCount: 3, claims: 0, colorPoints: 6 },
    { playerCount: 3, claims: 1, colorPoints: 3 },
    { playerCount: 3, claims: 2, colorPoints: 0 },
    { playerCount: 4, claims: 0, colorPoints: 7 },
    { playerCount: 4, claims: 1, colorPoints: 4 },
    { playerCount: 4, claims: 2, colorPoints: 0 },
  ] as const)("separates color completion with $playerCount players and $claims prior claims", ({ playerCount, claims, colorPoints }) => {
    const { state, player, board, cell } = preparePlace({ id: "last-mine", color: "mine" }, { playerCount });
    state.phase = 3;
    for (const other of board.filter(other => other.color === "mine" && other.id !== cell.id)) {
      player.board[other.id] = { id: `mine-${other.id}`, color: "mine" };
    }
    state.claimed.mine = state.players.map((_, id) => id).filter(id => id !== state.active).slice(0, claims);
    const result = preview(state, cell.id);
    expect(result.outcome).toEqual({ points: 10 + colorPoints, silver: 0, workers: 0, tilePoints: 0, regionPoints: 10, colorPoints });
    expect(result.next.players[state.active].bonuses.includes("mine")).toBe(colorPoints > 0);
  });

  it.each([
    [{ id: "castle", color: "castle" }, "free"],
    [{ id: "ship", color: "ship" }, "ship"],
    [{ id: "warehouse", color: "building", building: "warehouse" }, "sell"],
    [{ id: "hall", color: "building", building: "hall" }, "place"],
    [{ id: "mine", color: "mine" }, undefined],
  ] as const)("does not value unresolved choices or phase income for %j", (tile, pending) => {
    const { state, cell } = preparePlace(tile);
    const result = preview(state, cell.id);
    expect(result.outcome).toEqual({ points: 0, silver: 0, workers: 0, tilePoints: 0, regionPoints: 0, colorPoints: 0 });
    expect(result.next.pending[0]?.kind).toBe(pending);
  });

  it.each([undefined, "original-2011", "special-edition"] as const)("does not add final knowledge or resource points under %s rules", ruleset => {
    const { state, player, board, cell } = preparePlace({ id: "knowledge-26", color: "knowledge", knowledge: 26 }, { ruleset });
    state.phase = 4;
    state.round = 4;
    state.order = [0, 1];
    state.turnIndex = 1;
    for (const other of board.filter(other => other.color === "mine")) {
      player.board[other.id] = { id: `mine-${other.id}`, color: "mine" };
    }
    state.claimed.mine = [state.active];
    player.bonuses = ["mine"];
    const result = preview(state, cell.id);
    expect(result.outcome).toEqual({ points: 0, silver: 0, workers: 0, tilePoints: 0, regionPoints: 0, colorPoints: 0 });
    expect(result.next.status).toBe("playing");
    expect(result.next.players[state.active].final).toBeUndefined();
  });

  it("rejects non-placement and stale actions without mutating state", () => {
    const { state, cell } = preparePlace({ id: "bank", color: "building", building: "bank" });
    const before = structuredClone(state);
    const workers = legalActions(state).find(action => action.kind === "workers")!;
    expect(() => placementOutcome(state, workers)).toThrow("Placement previews require a place action.");
    expect(state).toEqual(before);
    const { action, next } = preview(state, cell.id);
    const after = structuredClone(next);
    expect(() => placementOutcome(next, action)).toThrow("That action is not legal in the current position.");
    expect(next).toEqual(after);
  });
});

describe("regionOutcome", () => {
  it.each([0, 1, 2, 3, 4])("uses whole-region size and phase %i, regardless of remaining hexes", phase => {
    const player = createGame(42).players[0];
    const representatives = [...new Map(BOARD.map(cell => [cell.region, cell])).values()];
    for (const first of representatives) {
      const region = BOARD.filter(cell => cell.region === first.region);
      const base = region.length * (region.length + 1) / 2;
      for (const filled of [...new Set([0, 1, region.length - 1, region.length])]) {
        player.board = BOARD.map(() => null);
        for (const cell of region.slice(0, filled)) player.board[cell.id] = { id: `filled-${cell.id}`, color: cell.color };
        const before = structuredClone(player);
        const expected = {
          region: first.region, size: region.length, remaining: region.length - filled,
          base, timing: 10 - phase * 2, points: base + 10 - phase * 2,
        };
        // Both filled and empty members resolve to the same connected region.
        for (const cell of region) expect(regionOutcome(player, cell.id, phase)).toEqual(expected);
        expect(player).toEqual(before);
      }
    }
  });

  it("does not count occupied hexes in a separate region of the same color", () => {
    const player = createGame(42).players[0];
    player.board = BOARD.map(() => null);
    const first = BOARD.find(cell => BOARD.some(other => other.color === cell.color && other.region !== cell.region))!;
    const region = BOARD.filter(cell => cell.region === first.region);
    for (const cell of BOARD.filter(cell => cell.color === first.color && cell.region !== first.region)) {
      player.board[cell.id] = { id: `other-${cell.id}`, color: cell.color };
    }
    expect(regionOutcome(player, first.id, 0).remaining).toBe(region.length);
  });

  it("agrees with a real completion action, without treating the color bonus as region points", () => {
    const state = createGame(42);
    state.active = 0;
    state.order = [0, 1];
    state.turnIndex = 0;
    state.phase = 3;
    const player = state.players[0];
    const first = BOARD.find(cell => cell.color === "mine")!;
    const region = BOARD.filter(cell => cell.region === first.region);
    const last = region.at(-1)!;
    for (const cell of region.slice(0, -1)) player.board[cell.id] = state.pools.mine.pop()!;
    player.storage = [state.pools.mine.pop()!];
    player.dice = [last.die, null];
    const before = regionOutcome(player, last.id, state.phase);
    expect(before.remaining).toBe(1);
    const action = legalActions(state).find(action => action.kind === "place" && action.cell === last.id)!;
    expect(action).toBeDefined();
    const completed = applyAction(state, action);
    expect(completed.log).toContain(`You complete a mine region: +${before.points} VP.`);
    expect(regionOutcome(completed.players[0], last.id, state.phase)).toEqual({ ...before, remaining: 0 });
  });
});
