import { describe, expect, it } from "vitest";
import { applyAction, createGame, legalActions } from "../src/engine";
import type { Action, State } from "../src/types";

function act(s: State, kind: Action["kind"], die?: number) {
  const action = legalActions(s).find(a => a.kind === kind && (die === undefined || a.die === die));
  expect(action, `Legal ${kind} action`).toBeDefined();
  return applyAction(s, action!);
}

function expectPublicRoll(s: State) {
  expect(s).toMatchObject({ status: "playing", turnIndex: 0, active: s.order[0] });
  for (const player of s.players) {
    expect(player.dice).toHaveLength(2);
    for (const die of player.dice) expect([1, 2, 3, 4, 5, 6]).toContain(die);
  }
  expect([1, 2, 3, 4, 5, 6]).toContain(s.whiteDie);
}

describe.each([2, 3, 4] as const)("%i-player simultaneous round rolls", playerCount => {
  // The seeded generator advances once per player die and once for the shared white die.
  const roundRngAdvance = (2 * playerCount + 1) * 0x6d2b79f5;

  it("publishes every pair before play and rerolls only at round and phase boundaries", () => {
    let s = createGame(51, { playerCount });
    expect(s.players).toHaveLength(playerCount);
    expect(s).toMatchObject({ phase: 0, round: 0 });
    expectPublicRoll(s);
    expect(s.phaseGoods).toHaveLength(4);
    expect(s.depots.flatMap(d => d.goods)).toHaveLength(1);
    expect(s.depots[s.whiteDie - 1].goods).toHaveLength(1);

    // Five complete rounds exercise ordinary handoffs and the first phase rollover.
    for (let round = 0; round < 5; round++) {
      const roundStart = s;
      for (let turn = 0; turn < playerCount; turn++) {
        expect(s).toMatchObject({ phase: 0, round, turnIndex: turn, active: roundStart.order[turn] });
        expect(s.players[s.active].dice).toEqual(roundStart.players[s.active].dice);
        s = act(s, "workers", 0);
        s = act(s, "workers", 1);
        expect(s.players.map(p => p.dice)).toEqual(roundStart.players.map((p, id) =>
          roundStart.order.indexOf(id) <= turn ? [null, null] : p.dice));
        expect(s).toMatchObject({
          rng: roundStart.rng,
          whiteDie: roundStart.whiteDie,
          phaseGoods: roundStart.phaseGoods,
          goodsPool: roundStart.goodsPool,
        });
        expect(s.depots.map(d => d.goods)).toEqual(roundStart.depots.map(d => d.goods));

        const beforeEnd = s;
        s = act(s, "end");
        if (turn < playerCount - 1) {
          expect(s).toMatchObject({
            status: "playing", phase: 0, round, turnIndex: turn + 1, active: roundStart.order[turn + 1],
            rng: beforeEnd.rng, whiteDie: beforeEnd.whiteDie,
            phaseGoods: beforeEnd.phaseGoods, goodsPool: beforeEnd.goodsPool,
          });
          expect(s.players.map(p => p.dice)).toEqual(beforeEnd.players.map(p => p.dice));
          expect(s.depots.map(d => d.goods)).toEqual(beforeEnd.depots.map(d => d.goods));
        } else {
          const phaseEnds = round === 4;
          const supply = phaseEnds ? beforeEnd.goodsPool.slice(-5) : beforeEnd.phaseGoods;
          expectPublicRoll(s);
          expect(s).toMatchObject({ phase: phaseEnds ? 1 : 0, round: phaseEnds ? 0 : round + 1 });
          expect(s.rng).toBe((beforeEnd.rng + roundRngAdvance) >>> 0);
          expect(s.phaseGoods).toEqual(supply.slice(1));
          expect(s.goodsPool).toEqual(phaseEnds ? beforeEnd.goodsPool.slice(0, -5) : beforeEnd.goodsPool);
          expect(s.depots.map(d => d.goods)).toEqual(beforeEnd.depots.map((d, index) =>
            index === s.whiteDie - 1 ? [...d.goods, supply[0]] : d.goods));
        }
      }
    }
  });

  it.each(["open", "secret"] as const)("rolls everyone only after the final %s estate choice", estates => {
    let s = createGame(51, { playerCount, estates });
    const setupStart = s;
    for (let choice = 0; choice < playerCount; choice++) {
      expect(s).toMatchObject({
        status: "setup", turnIndex: choice, active: setupStart.order[choice],
        rng: setupStart.rng, whiteDie: setupStart.whiteDie,
        phaseGoods: [], goodsPool: setupStart.goodsPool,
      });
      expect(s.players.map(p => p.dice)).toEqual(Array.from({ length: playerCount }, () => [null, null]));
      expect(s.depots.flatMap(d => d.goods)).toEqual([]);
      s = act(s, "choose-estate");
    }

    expect(s.setup).toBeUndefined();
    expect(s).toMatchObject({ phase: 0, round: 0 });
    expectPublicRoll(s);
    expect(s.rng).toBe((setupStart.rng + roundRngAdvance) >>> 0);
    const supply = setupStart.goodsPool.slice(-5);
    expect(s.phaseGoods).toEqual(supply.slice(1));
    expect(s.goodsPool).toEqual(setupStart.goodsPool.slice(0, -5));
    expect(s.depots.map(d => d.goods)).toEqual(s.depots.map((_, index) =>
      index === s.whiteDie - 1 ? [supply[0]] : []));
  });
});
