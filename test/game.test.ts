import { expect, it } from "vitest";
import { applyAction, createGame, legalActions } from "../src/engine";
import { COLORS } from "../src/data";

it.each([1, 17, 946])(
  "finishes all 25 rounds without deadlocks or resource/identity violations (seed %i)",
  (seed) => {
    let state = createGame(seed),
      step = 0,
      rng = seed;
    const phases = new Set<number>();
    const rounds = new Set<string>();
    while (state.status === "playing" && step++ < 1200) {
      phases.add(state.phase);
      rounds.add(`${state.phase}:${state.round}`);
      const actions = legalActions(state);
      expect(actions.length).toBeGreaterThan(0);
      rng = (Math.imul(rng, 1664525) + 1013904223) >>> 0;
      const preferred = actions.filter((a) =>
        ["place", "goods", "ship", "sell", "end"].includes(a.kind),
      );
      const candidates = preferred.length ? preferred : actions;
      state = applyAction(state, candidates[rng % candidates.length]);
      for (const player of state.players) {
        expect(player.storage.length).toBeLessThanOrEqual(3);
        expect(player.goods.filter(Boolean).length).toBeLessThanOrEqual(3);
        for (const number of [
          player.silver,
          player.workers,
          player.score,
          ...player.goods,
          ...player.sold,
        ]) {
          expect(Number.isInteger(number)).toBe(true);
          expect(number).toBeGreaterThanOrEqual(0);
        }
      }
      const tiles = [
        ...state.players.flatMap((p) => [
          ...p.board.filter((t) => t !== null),
          ...p.storage,
        ]),
        ...state.depots.flatMap((d) => d.tiles),
        ...state.black,
        ...state.blackPool,
        ...COLORS.flatMap((c) => state.pools[c]),
      ];
      expect(new Set(tiles.map((t) => t.id)).size).toBe(tiles.length);
      const goods =
        state.goodsPool.length +
        state.phaseGoods.length +
        state.depots.reduce((n, d) => n + d.goods.length, 0) +
        state.players.reduce(
          (n, p) => n + [...p.goods, ...p.sold].reduce((a, b) => a + b, 0),
          0,
        );
      expect(goods).toBe(42);
    }
    expect(state.status).toBe("finished");
    expect(state.phase).toBe(4);
    expect(state.round).toBe(4);
    expect(phases.size).toBe(5);
    expect(rounds.size).toBe(25);
    expect([0, 1]).toContain(state.winner);
    expect(state.players.every((p) => p.final)).toBe(true);
  },
);
