import { describe, expect, it } from "vitest";
import { soundsForAction, type Sound } from "../src/audio";
import { boardFor } from "../src/boards";
import { applyAction, createGame, legalActions } from "../src/engine";
import { motionForAction } from "../src/motion-events";
import { MOTION, rollLeadIn } from "../src/motion-timing";
import type { Action, State, Tile } from "../src/types";

function position(): State {
  const state = createGame(42);
  state.active = 0;
  state.order = [0, 1];
  state.turnIndex = 0;
  state.players[0].dice = [1, 2];
  state.players[0].workers = 8;
  state.players[0].silver = 6;
  return state;
}

function place(tile: Tile, complete = false) {
  const state = position(), player = state.players[0], board = boardFor(player);
  const cell = board.find(cell => cell.color === tile.color && !player.board[cell.id])!;
  const neighbor = board.find(other => other.id !== cell.id && Math.max(
    Math.abs(other.q - cell.q), Math.abs(other.r - cell.r),
    Math.abs(other.q + other.r - cell.q - cell.r),
  ) === 1)!;
  player.board[neighbor.id] = { id: "anchor", color: neighbor.color };
  if (complete) for (const other of board) {
    if (other.region === cell.region && other.id !== cell.id)
      player.board[other.id] = { ...tile, id: `region-${other.id}` };
  }
  player.storage = [tile];
  player.dice = [cell.die, 2];
  return move(state, "place", action => action.cell === cell.id && action.cost === 0);
}

function move(state: State, kind: Action["kind"], matches: (action: Action) => boolean = () => true) {
  const action = legalActions(state).find(action => action.kind === kind && matches(action));
  expect(action, `legal ${kind} fixture`).toBeDefined();
  const next = applyAction(state, action!);
  const plan = motionForAction(state, action!, next);
  return { state, action: action!, next, plan, cues: soundsForAction(state, action!, next) };
}

function boundary(phase: number, income: boolean) {
  const state = position();
  state.phase = phase;
  state.round = 4;
  state.order = [1, 0];
  state.turnIndex = 1;
  state.players.forEach(player => { player.dice = [null, null]; });
  if (income) {
    const board = boardFor(state.players[1]);
    const cell = board.find(cell => cell.color === "mine")!;
    state.players[1].board[cell.id] = { id: "mine", color: "mine" };
  }
  return move(state, "end");
}

const cueTime = (cues: ReturnType<typeof soundsForAction>, sound: Sound) => {
  const cue = cues.find(cue => cue.sound === sound);
  expect(cue, `${sound} cue exists`).toBeDefined();
  return cue!.delay;
};

describe("041–050 sound and visual reading beats", () => {
  it("041 keeps reserve-taking responsive, but lands placed-tile foley with the tile", () => {
    const taken = move(position(), "take", action => action.cost === 0);
    expect(cueTime(taken.cues, "tile")).toBe(0);
    const placed = place({ id: "building", color: "building", building: "workshop" });
    expect(cueTime(placed.cues, "build")).toBe(MOTION.flight / 1000);
  });

  it("042 scores a pasture only once the newly placed animals arrive", () => {
    const placed = place({ id: "sheep", color: "animal", animal: "sheep", count: 2 });
    expect(placed.plan.regions).toHaveLength(0);
    expect(cueTime(placed.cues, "sheep")).toBe(MOTION.flight / 1000);
    expect(cueTime(placed.cues, "score")).toBeGreaterThanOrEqual(MOTION.flight / 1000);
  });

  it("043 celebrates a completed region at its score receipt, after the boundary trace", () => {
    const placed = place({ id: "mine", color: "mine" }, true);
    expect(placed.plan.regions).toHaveLength(1);
    expect(cueTime(placed.cues, "region")).toBeCloseTo((MOTION.flight + MOTION.rewardDelay) / 1000, 8);
  });

  it("044 announces a castle privilege only once its placement is visible", () => {
    const placed = place({ id: "castle", color: "castle" });
    expect(placed.plan.freeAction).toBe(true);
    expect(cueTime(placed.cues, "bonus")).toBeGreaterThanOrEqual(MOTION.flight / 1000);
    expect(placed.cues.filter(cue => cue.sound === "bonus")).toHaveLength(1);
  });

  it("045 keeps one bank payout at the end of placement and silver travel", () => {
    const placed = place({ id: "bank", color: "building", building: "bank" });
    expect(placed.cues.filter(cue => cue.sound === "coins")).toEqual([
      { sound: "coins", delay: MOTION.flight * 2 / 1000 },
    ]);
  });

  it("046 preserves supplied payout timing and keeps spending feedback immediate", () => {
    const state = position();
    state.players[0].goods[0] = 2;
    const sold = move(state, "sell", action => action.good === 1);
    expect(cueTime(soundsForAction(state, sold.action, sold.next, { silverDelay: 0.36 }), "coins")).toBe(0.36);
    const bought = move(position(), "buy");
    expect(cueTime(bought.cues, "coins")).toBe(0);
    expect(cueTime(bought.cues, "tile")).toBe(0.18);
  });

  it.each([false, true])("047 waits for phase income and dealing before the dice contact cue (income %s)", income => {
    const ended = boundary(0, income);
    expect(cueTime(ended.cues, "dice")).toBe((rollLeadIn(ended.plan) + MOTION.diceLanding) / 1000);
    expect(cueTime(ended.cues, "phase")).toBe(income ? (MOTION.receipt + 200) / 1000 : 0);
  });

  it("048 keeps the final fanfare after the last mine payout, without a new roll", () => {
    const ended = boundary(4, true);
    expect(ended.next.status).toBe("finished");
    const cues = soundsForAction(ended.state, ended.action, ended.next, { silverDelay: MOTION.flight / 1000 });
    expect(cueTime(cues, "finish")).toBeGreaterThan(cueTime(cues, "coins"));
    expect(cues.some(cue => cue.sound === "dice" || cue.sound === "phase")).toBe(false);
  });

  it("049 removes spatial delays under the existing reduced-motion timing contract", () => {
    const placed = place({ id: "mine", color: "mine" }, true);
    const cues = soundsForAction(placed.state, placed.action, placed.next, { diceDelay: 0, silverDelay: 0 });
    expect(cueTime(cues, "mine")).toBe(0);
    expect(cueTime(cues, "region")).toBeLessThan(MOTION.flight / 1000);
    expect(cues.every(cue => Number.isFinite(cue.delay) && cue.delay >= 0)).toBe(true);
  });

  it("050 leaves state, randomness, cue uniqueness and explicit roll overrides intact", () => {
    const ended = boundary(0, true);
    const saved = JSON.stringify([ended.state, ended.next]);
    const cues = soundsForAction(ended.state, ended.action, ended.next, { diceDelay: 1.23 });
    expect(cueTime(cues, "dice")).toBe(1.23);
    expect(cues.map(cue => cue.sound)).toEqual([...new Set(cues.map(cue => cue.sound))]);
    expect(cues).toEqual(soundsForAction(ended.state, ended.action, ended.next, { diceDelay: 1.23 }));
    expect(JSON.stringify([ended.state, ended.next])).toBe(saved);
  });
});
