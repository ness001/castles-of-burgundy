import { describe, expect, it } from "vitest";
import { applyAction, createGame, legalActions } from "../src/engine";
import { finalScoringSteps } from "../src/motion-events";

function finished() {
  const state = createGame(42);
  state.phase = state.round = 4;
  state.order = [1, 0];
  state.turnIndex = 1;
  state.active = 0;
  state.players.forEach((player, index) => {
    player.dice = [null, null];
    player.goods = [index + 1, 0, 0, 0, 0, 0];
    player.sold = [2, 1, 0, 0, 0, 0];
    player.board[12] = { id: `knowledge-${index}`, color: "knowledge", knowledge: index === 0 ? 15 : 25 };
    player.board[24] = { id: `mine-${index}`, color: "mine" };
  });
  state.players[0].board[13] = { id: "zero", color: "knowledge", knowledge: 26 };
  state.players[0].board[14] = { id: "mining", color: "knowledge", knowledge: 2 };
  return applyAction(state, legalActions(state).find(action => action.kind === "end")!);
}

describe("final scoring sequence", () => {
  it("counts post-income resources then each built scoring knowledge, including zero-point knowledge", () => {
    const state = finished(), before = structuredClone(state);
    const steps = finalScoringSteps(state);
    expect(steps.map(step => step.key)).toEqual(["goods", "silver", "workers", "knowledge-15", "knowledge-25", "knowledge-26"]);
    expect(steps[3].gains).toEqual([{ player: 0, points: 6 }]);
    expect(steps[4].gains).toEqual([{ player: 1, points: 3 }]);
    expect(steps[5].gains).toEqual([{ player: 0, points: 0 }]);
    state.players.forEach((player, index) => {
      const points = steps.flatMap(step => step.gains).filter(gain => gain.player === index).reduce((sum, gain) => sum + gain.points, 0);
      expect(points).toBe(Object.values(player.final!).reduce((sum, value) => sum + value, 0));
    });
    expect(state).toEqual(before);
  });

  it("has no sequence during play or for an empty final ledger", () => {
    const state = createGame(42);
    expect(finalScoringSteps(state)).toEqual([]);
    state.status = "finished";
    state.players.forEach(player => { player.final = { goods: 0, silver: 0, workers: 0, knowledge: 0 }; });
    expect(finalScoringSteps(state)).toEqual([]);
  });
});
