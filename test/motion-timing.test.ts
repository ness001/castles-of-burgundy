import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createGame } from "../src/engine";
import { GameMotion, type MotionOrigin } from "../src/motion";
import type { DiceRenderOptions } from "../src/dice-renderer";
import type { MotionPlan } from "../src/motion-events";
import { DICE_SEQUENCE, MOTION, motionReadingTime, rewardLeadIn, rollLeadIn } from "../src/motion-timing";

const plan = (overrides: Partial<MotionPlan> = {}): MotionPlan => ({
  actor: 1, roll: false, phaseChanged: false, regions: [], freeAction: false,
  silver: [], scores: [], goods: [], ...overrides,
});
const placement = (overrides: Partial<MotionPlan> = {}) => plan({
  tile: { tile: { id: "placed-mine", color: "mine" }, from: "reserve", cell: 0 }, ...overrides,
});
const income: MotionPlan["silver"] = [{ player: 1, amount: 3, source: "mines", cells: [0, 1, 2] }];
const region = () => placement({ regions: [{ player: 1, cells: [0, 1], points: 11 }], scores: [{ player: 1, amount: 11 }] });

function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

/** Run the real play/deal/toss/receipt timers; fake only DOM, board drawing and GPU rendering. */
function playback(input: MotionPlan, reduced = false) {
  const receipts: { kind: string; start: number; end?: number; element: ElementStub }[] = [];
  const animations: { kind: string; start: number; duration: number; delay: number }[] = [];
  const rolls: { start: number; land?: number; end?: number }[] = [];
  const boardStarts: number[] = [];
  const rect = { x: 20, y: 20, width: 600, height: 500 };

  class ElementStub {
    className = "";
    innerHTML = "";
    textContent = "";
    offsetHeight = 40;
    dataset: Record<string, string> = {};
    style: Record<string, string> = {};
    classList = { add: vi.fn(), remove: vi.fn() };
    children: ElementStub[] = [];
    parentElement?: ElementStub;
    get isConnected(): boolean { return this === body || Boolean(this.parentElement?.isConnected); }
    setAttribute = vi.fn();
    getClientRects = () => [rect];
    getBoundingClientRect = () => rect;
    append(...children: ElementStub[]): void {
      for (const child of children) {
        child.parentElement = this;
        this.children.push(child);
        if (child.className === "motion-receipt") receipts.push({ kind: child.dataset.motion, start: Date.now(), element: child });
      }
    }
    remove(): void {
      const receipt = receipts.find(item => item.element === this);
      if (receipt && receipt.end === undefined) receipt.end = Date.now();
      if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(child => child !== this);
      this.parentElement = undefined;
    }
    replaceChildren(): void { [...this.children].forEach(child => child.remove()); }
    querySelectorAll(selector: string): ElementStub[] {
      const classes = selector.split(",").map(item => item.trim().slice(1));
      return this.children.flatMap(child => [
        ...(classes.some(name => child.className.split(" ").includes(name)) ? [child] : []),
        ...child.querySelectorAll(selector),
      ]);
    }
    querySelector(selector: string): ElementStub | null {
      if (selector === ".motion-order-marker" && this.innerHTML.includes("motion-order-marker")) {
        const marker = new ElementStub();
        marker.className = "motion-order-marker";
        this.append(marker);
        return marker;
      }
      return this.querySelectorAll(selector)[0] ?? null;
    }
    animate(_frames: Keyframe[], options: { duration: number; delay: number }) {
      animations.push({ kind: this.dataset.motion ?? this.className, start: Date.now(), duration: options.duration, delay: options.delay });
      return { cancel: vi.fn(), finished: new Promise<void>(() => {}) };
    }
  }

  const body = new ElementStub(), layer = new ElementStub(), host = new ElementStub(), control = new ElementStub();
  const phase = new ElementStub(), depots = Array.from({ length: 7 }, () => new ElementStub());
  body.append(layer, host, control, phase, ...depots);
  const targets = new Map([
    ["#board", host], ["#turn-controls", control], ['.phase-track [aria-current="step"]', phase],
  ]);
  vi.stubGlobal("document", {
    hidden: false, body, createElement: () => new ElementStub(),
    querySelector: (selector: string) => targets.get(selector) ?? null,
    querySelectorAll: (selector: string) => selector === ".depot-tiles, .black-tiles" ? depots : [],
  });
  vi.stubGlobal("innerWidth", 1280);
  vi.stubGlobal("innerHeight", 800);
  vi.stubGlobal("scrollX", 0);
  vi.stubGlobal("scrollY", 0);
  vi.stubGlobal("CSS", { escape: (value: string) => value });
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0));
  vi.stubGlobal("cancelAnimationFrame", clearTimeout);

  const diceRenderer = {
    stop: vi.fn(),
    play: vi.fn((options: DiceRenderOptions) => {
      const roll: typeof rolls[number] = { start: Date.now() };
      rolls.push(roll);
      setTimeout(() => { roll.land = Date.now(); options.onLand?.(); }, MOTION.diceRoll);
      setTimeout(() => { roll.end = Date.now(); options.onComplete?.(); }, DICE_SEQUENCE);
    }),
  };
  // Avoid the constructor's browser listeners/prewarm; all scheduling methods stay real.
  const motion = Object.assign(Object.create(GameMotion.prototype), {
    layer, preference: { matches: reduced }, revision: 0,
    animations: new Set(), cleanups: new Map(), timers: new Set(), diceRenderer,
    board: { refreshSize: vi.fn(), cancelMotion: vi.fn(), cellBounds: () => rect,
      playMotion: vi.fn(() => boardStarts.push(Date.now())) },
  }) as GameMotion;
  const previous = freeze(createGame(37)), next = freeze(structuredClone(previous));
  const saved = structuredClone(input);
  freeze(input);
  const timerCount = vi.getTimerCount();
  const deadline = motionReadingTime(input, reduced);
  expect(motionReadingTime(input, reduced)).toBe(deadline);
  expect(input).toEqual(saved);
  expect(vi.getTimerCount()).toBe(timerCount);
  const origin: MotionOrigin = { tile: rect, phase: rect, goods: new Map(), scrollX: 0, scrollY: 0 };
  motion.play(input, previous, next, origin, input.actor);
  vi.advanceTimersByTime(0);
  return { motion, deadline, receipts, animations, rolls, boardStarts, diceRenderer };
}

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(0); });
afterEach(() => { vi.clearAllTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("061–070 feedback pacing against GameMotion's schedule", () => {
  it("061 keeps ordinary no-reward turns at 700 ms and timing helpers pure", () => {
    const cases = freeze([plan(), placement(), region(), plan({ silver: income, roll: true, phaseChanged: true })]);
    const saved = structuredClone(cases);
    const timers = vi.spyOn(globalThis, "setTimeout"), random = vi.spyOn(Math, "random");
    const read = () => cases.flatMap(item => [rollLeadIn(item), ...[false, true].flatMap(reduced => [rewardLeadIn(item, reduced), motionReadingTime(item, reduced)])]);
    const first = read();
    vi.setSystemTime(10000);
    expect(read()).toEqual(first);
    expect(cases).toEqual(saved);
    expect(timers).not.toHaveBeenCalled();
    expect(random).not.toHaveBeenCalled();
    vi.setSystemTime(0);
    const env = playback(cases[0]);
    expect(env.deadline).toBe(700);
    expect(motionReadingTime(cases[0], true)).toBe(700);
    expect(rollLeadIn(cases[0])).toBe(0);
    expect(rewardLeadIn(cases[0], false)).toBe(0);
    vi.advanceTimersByTime(env.deadline);
    expect(env.receipts).toEqual([]);
    expect(env.rolls).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("062 gives the immediate reserve receipt its full lifetime, without an arrival lead-in", () => {
    const input = plan({ tile: { tile: { id: "reserved", color: "mine" }, from: "depot", depot: 0 } });
    const env = playback(input);
    expect(rewardLeadIn(input, false)).toBe(0);
    expect(env.receipts.map(item => [item.kind, item.start])).toEqual([["rival-action", 0]]);
    expect(env.animations.find(item => item.kind === "tile-flight")?.duration).toBe(850);
    vi.advanceTimersByTime(2649);
    expect(env.receipts[0].element.isConnected).toBe(true);
    vi.advanceTimersByTime(1);
    expect(env.receipts[0].end).toBe(2650);
    expect(env.deadline).toBe(2750);
  });

  it("063 does not add a reward-arrival wait to a placement with no delayed reward", () => {
    const input = placement(), env = playback(input);
    expect(rewardLeadIn(input, false)).toBe(850);
    expect(env.receipts.map(item => [item.kind, item.start])).toEqual([["rival-action", 0]]);
    vi.advanceTimersByTime(849);
    expect(env.boardStarts).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(env.boardStarts).toEqual([850]);
    expect(env.boardStarts[0] + MOTION.landing).toBe(1500);
    vi.advanceTimersByTime(1800);
    expect(env.receipts[0].end).toBe(2650);
    expect(env.deadline).toBe(2750);
    expect(env.deadline - env.receipts[0].end!).toBe(100);

    // Real placement rewards still start on arrival, including castle and ship notices.
    const rewards: Partial<MotionPlan>[] = [
      { silver: [{ player: 1, amount: 2, source: "bank", cells: [0] }] },
      { scores: [{ player: 1, amount: 4 }] },
      { goods: [{ player: 1, type: 1, amount: 2, depots: [0] }] },
      { freeAction: true },
      { ship: { player: 1, from: 0, to: 1, order: [1, 0] } },
    ];
    for (const reward of rewards) {
      vi.setSystemTime(0);
      const withReward = playback(placement(reward));
      vi.advanceTimersByTime(850);
      const receipt = withReward.receipts.at(-1)!;
      expect(receipt.start).toBe(850);
      vi.advanceTimersByTime(2650);
      expect(receipt.end).toBe(3500);
      expect(withReward.deadline).toBe(3600);
    }
  });

  it("064 preserves arrival, full region trace, then the score receipt", () => {
    const env = playback(region());
    vi.advanceTimersByTime(1799);
    expect(env.boardStarts).toEqual([850]);
    expect(env.receipts.some(item => item.kind === "score-gain")).toBe(false);
    vi.advanceTimersByTime(1);
    const score = env.receipts.find(item => item.kind === "score-gain")!;
    expect(score.start).toBe(env.boardStarts[0] + MOTION.regionTrace);
    expect(score.start).toBe(1800);
    vi.advanceTimersByTime(2650);
    expect(score.end).toBe(4450);
    expect(env.deadline).toBe(4550);
    expect(env.deadline - score.end!).toBe(100);
  });

  it("065 reads income while silver travels, rather than serializing independent beats", () => {
    const input = plan({ silver: income }), env = playback(input);
    expect(env.receipts.map(item => [item.kind, item.start])).toEqual([["silver-gain", 0]]);
    expect(env.boardStarts).toEqual([0]);
    expect(rollLeadIn(input)).toBe(0);
    expect(MOTION.mines).toBe(1600);
    vi.advanceTimersByTime(2650);
    expect(env.receipts[0].end).toBe(2650);
    expect(env.deadline).toBe(2750);
  });

  it("066 deals after phase income and finishes all seven supply groups before rolling", () => {
    const input = plan({ silver: income, phaseChanged: true, roll: true }), env = playback(input);
    vi.advanceTimersByTime(2799);
    expect(env.receipts[0].end).toBe(2650);
    expect(env.animations.some(item => item.kind === "depot-deal")).toBe(false);
    vi.advanceTimersByTime(1);
    const deals = env.animations.filter(item => item.kind === "depot-deal");
    expect(deals.map(item => [item.start, item.duration, item.delay])).toEqual(
      Array.from({ length: 7 }, (_, index) => [2800, 650, index * 65]),
    );
    expect(Math.max(...deals.map(item => item.start + item.duration + item.delay))).toBe(3840);
    vi.advanceTimersByTime(1239);
    expect(env.rolls).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(rollLeadIn(input)).toBe(4040);
    expect(env.rolls[0].start).toBe(4040);
    vi.advanceTimersByTime(5750);
    const goods = env.receipts.find(item => item.kind === "white-die")!;
    expect([goods.start, goods.end]).toEqual([7140, 9790]);
    expect(env.deadline).toBe(9840);
    expect(env.deadline - goods.end!).toBe(50);
  });

  it("067 skips nonexistent income but keeps the complete phase deal and goods result", () => {
    const input = plan({ phaseChanged: true, roll: true }), env = playback(input);
    const deals = env.animations.filter(item => item.kind === "depot-deal");
    expect(deals).toHaveLength(7);
    expect(Math.max(...deals.map(item => item.start + item.duration + item.delay))).toBe(1040);
    vi.advanceTimersByTime(1239);
    expect(env.rolls).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(env.rolls[0].start).toBe(1240);
    expect(rollLeadIn(input)).toBe(1240);
    vi.advanceTimersByTime(5750);
    expect(env.receipts.map(item => [item.kind, item.start, item.end])).toEqual([["white-die", 4340, 6990]]);
    expect(env.deadline).toBe(7040);
  });

  it("068 preserves the cinematic constants and reads the goods die after the full roll/hold/return", () => {
    expect(MOTION).toEqual({
      flight: 850, receipt: 2600, emphasis: 1800, landing: 650, region: 1800, regionTrace: 950,
      animals: 1500, mines: 1600, rewardDelay: 950, diceRoll: 1400, diceHold: 1100,
      diceReturn: 600, diceLanding: 1100, deal: 650, dealStagger: 65, finalStep: 1500, finalCount: 650,
    });
    expect(DICE_SEQUENCE).toBe(3100);
    const env = playback(plan({ roll: true }));
    expect(env.rolls[0].start).toBe(0);
    vi.advanceTimersByTime(2500);
    expect(env.rolls[0].land).toBe(1400);
    const labels = env.animations.filter(item => item.kind === "dice-owner");
    expect(labels.length).toBeGreaterThan(0);
    expect(labels.every(item => item.start === 2500 && item.duration === 600)).toBe(true);
    expect(env.receipts).toEqual([]);
    vi.advanceTimersByTime(600);
    expect(env.rolls[0].end).toBe(3100);
    expect(env.receipts.map(item => [item.kind, item.start])).toEqual([["white-die", 3100]]);
    vi.advanceTimersByTime(2650);
    expect(env.receipts[0].end).toBe(5750);
    expect(env.deadline).toBe(5800);
  });

  it("069 removes spatial waiting, not meaningful receipts, with reduced motion", () => {
    for (const input of [region(), plan({ phaseChanged: true, roll: true, silver: income })]) {
      vi.setSystemTime(0);
      const env = playback(input, true);
      expect(rewardLeadIn(input, true)).toBe(0);
      expect(env.boardStarts).toEqual([0]);
      expect(env.rolls).toEqual([]);
      expect(env.animations).toEqual([]);
      expect(env.receipts.map(item => item.kind)).toEqual(input.roll ? ["silver-gain", "white-die"] : ["rival-action", "score-gain"]);
      expect(env.receipts.every(item => item.start === 0)).toBe(true);
      vi.advanceTimersByTime(2649);
      expect(env.receipts.every(item => item.element.isConnected)).toBe(true);
      vi.advanceTimersByTime(1);
      expect(env.receipts.every(item => item.end === 2650)).toBe(true);
      expect(env.deadline).toBe(input.roll ? 2700 : 2750);
      env.motion.cancel();
    }
  });

  it("070 gives worker gains and named rival spends their actual receipt clock, not human-only costs", () => {
    // Worker receipts now render in rewardEffects; measure their actual timers.
    const gains: MotionPlan["workers"] = [{ player: 1, amount: 2 }, { player: 0, amount: 1 }];
    for (const workers of [gains, [{ player: 1, amount: -2 }]]) {
      for (const placed of [false, true]) {
        for (const reduced of [false, true]) {
          vi.setSystemTime(0);
          const input = freeze((placed ? placement : plan)({ workers }));
          const saved = structuredClone(input), count = vi.getTimerCount();
          const deadline = motionReadingTime(input, reduced);
          expect(motionReadingTime(input, reduced)).toBe(deadline);
          expect(input).toEqual(saved);
          expect(vi.getTimerCount()).toBe(count);
          const env = playback(input, reduced);
          vi.advanceTimersByTime(placed && !reduced ? 3500 : 2650);
          const receipt = env.receipts.find(item => item.kind === (workers[0].amount > 0 ? "workers-gain" : "workers-spend"))!;
          expect(receipt.start).toBe(placed && !reduced ? 850 : 0);
          expect(receipt.end).toBe(receipt.start + 2650);
          expect(deadline).toBe(receipt.end! + 100);
          expect(deadline).toBe(placed && !reduced ? 3600 : 2750);
          env.motion.cancel();
        }
      }
    }
    for (const workers of [undefined, [], [{ player: 0, amount: -2 }], [{ player: 1, amount: 0 }]]) {
      expect(motionReadingTime(plan({ actor: 0, workers }), false)).toBe(700);
      expect(motionReadingTime(placement({ actor: 0, workers }), false)).toBe(2750);
    }
    expect(motionReadingTime(plan({ workers: [{ player: 1, amount: -2 }, { player: 0, amount: 1 }] }), false)).toBe(2750);
  });
});
