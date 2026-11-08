import { expect, test, type Page } from "@playwright/test";
import { expectRestored } from "./undo-assertions";
import { boardFor } from "../src/boards";
import { actionKey, applyAction, canPlace, createGame, legalActions } from "../src/engine";
import type { DiceRenderOptions } from "../src/dice-renderer";
import type { GameMotion } from "../src/motion";
import { MOTION } from "../src/motion-timing";
import type { Action, State, Tile } from "../src/types";

const SAVE_KEY = "burgundy-table.state.v1";
type Rect = { x: number; y: number; width: number; height: number };
// Observe the production instance, native animations and renderer callbacks.
// Direct presentation calls below isolate lifecycle races, never game actions.
interface MotionRuntime {
  play: GameMotion["play"];
  startGame: GameMotion["startGame"];
  cancel(): void;
  rolling: boolean;
  reading: boolean;
  frame?: number;
  layer: HTMLElement;
  animations: Set<Animation>;
  timers: Set<number>;
  cleanups: Set<() => void> | Map<HTMLElement, () => void>;
  mark(element: HTMLElement, kind: string, duration: number): void;
  receipt(kind: string, text: string): HTMLElement;
  flight(kind: string, content: string, from: Rect, to: Rect): void;
  later(callback: () => void, duration: number): void;
  diceRenderer?: { stop(): void; renderer?: { getContext(): WebGLRenderingContext } };
}
declare global {
  interface Window {
    __avLifecycle: {
      motion: MotionRuntime;
      args: Parameters<GameMotion["play"]>;
      rolls: DiceRenderOptions[];
      completions: { receipts: number; reading: boolean }[];
      delayed?: boolean;
    };
  }
}

function position(roundEnd = false): State {
  const state = createGame(42);
  state.active = 0;
  state.order = roundEnd ? [1, 0] : [0, 1];
  state.turnIndex = roundEnd ? 1 : 0;
  state.players[0].dice = [1, 2];
  state.players[0].workers = 6;
  state.players[0].goods = [2, 1, 0, 0, 0, 0];
  if (roundEnd) {
    state.players.forEach(player => { player.dice = [null, null]; });
    state.players[0].arrival = state.players[1].arrival + 1;
  }
  return state;
}

function legal(state: State, match: Partial<Action>): Action {
  const action = legalActions(state).find(action => Object.entries(match).every(([key, value]) =>
    JSON.stringify(action[key as keyof Action]) === JSON.stringify(value)));
  if (!action) throw new Error(`No lifecycle fixture action: ${JSON.stringify(match)}`);
  return action;
}

async function openTable(page: Page, state = position()) {
  await page.addInitScript(({ key, state }) => localStorage.setItem(key, JSON.stringify(state)), { key: SAVE_KEY, state });
  await page.goto("/");
  await expect(page.locator("#turn-controls")).toBeVisible();
  await expect(page.locator("#board canvas")).toBeAttached();
  await page.evaluate(() => document.fonts.ready);
  await page.waitForFunction(() => performance.getEntriesByType("resource")
    .some(entry => new URL(entry.name).pathname === "/src/dice-renderer.ts"));
  await page.evaluate(async () => {
    const loaded = (path: string) => performance.getEntriesByType("resource")
      .find(entry => new URL(entry.name).pathname === path)!.name;
    const { GameMotion } = await import(loaded("/src/motion.ts"));
    const { DiceRenderer } = await import(loaded("/src/dice-renderer.ts"));
    const probe = window.__avLifecycle = { rolls: [], completions: [] } as unknown as Window["__avLifecycle"];
    const play = GameMotion.prototype.play;
    GameMotion.prototype.play = function (this: MotionRuntime, ...args: Parameters<GameMotion["play"]>) {
      probe.motion = this;
      probe.args = args;
      return play.apply(this, args);
    };
    const roll = DiceRenderer.prototype.play;
    DiceRenderer.prototype.play = function (options: DiceRenderOptions) {
      probe.rolls.push(options);
      return roll.call(this, { ...options, onComplete: () => {
        options.onComplete?.();
        probe.completions.push({ receipts: probe.motion.layer.childElementCount, reading: probe.motion.reading });
      } });
    };
  });
}

async function sell(page: Page) {
  await page.locator('[data-good="1"]').click();
  await expect(page.locator('#motion-layer [data-motion="silver-gain"]')).toBeVisible();
}

async function roll(page: Page) {
  await page.locator("#turn-controls .turn-tools .end-turn").click();
  await expect(page.locator('canvas.dice-webgl[data-state="rolling"]')).toHaveCount(1);
}

async function saved(page: Page) {
  return page.evaluate(key => JSON.parse(localStorage.getItem(key)!) as State, SAVE_KEY);
}

async function clean(page: Page) {
  await expect(page.locator("#motion-layer > *, .dice-stage, .motion-emphasis")).toHaveCount(0);
  expect(await page.evaluate(() => {
    const motion = window.__avLifecycle.motion;
    return [motion.animations.size, motion.timers.size, motion.cleanups.size,
      Number(motion.frame !== undefined), Number(motion.rolling), Number(motion.reading)];
  })).toEqual([0, 0, 0, 0, 0, 0]);
}

test("021 hidden/tab return cancels effects without replay or save changes", async ({ page }) => {
  await openTable(page);
  await sell(page);
  const committed = await saved(page);
  await page.evaluate(() => {
    Object.defineProperty(document, "hidden", { configurable: true, value: true });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await clean(page);
  await expect(page.locator(".masthead-scene")).toHaveAttribute("data-ambient", "paused");
  await page.evaluate(() => {
    Reflect.deleteProperty(document, "hidden");
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await clean(page);
  expect(await saved(page)).toEqual(committed);
  expect(await page.evaluate(() => window.__avLifecycle.rolls.length)).toBe(0);
});

test("022 reduced motion mid-sequence cancels delayed rewards and keeps static receipts", async ({ page }) => {
  const before = position();
  const tile: Tile = { id: "av-lifecycle-bank", color: "building", building: "bank" };
  const cell = boardFor(before.players[0]).find(cell => canPlace(before.players[0], tile, cell.id))!;
  before.players[0].storage = [tile];
  before.players[0].dice[0] = cell.die;
  const action = legal(before, { kind: "place", tile: tile.id, cell: cell.id, die: 0, cost: 0 });
  const place = async () => {
    await page.locator("#legal-details").evaluate(element => { (element as HTMLDetailsElement).open = true; });
    const choice = page.locator(`#legal-actions [data-action-key=${JSON.stringify(actionKey(action))}]`);
    await choice.focus();
    await choice.press("Enter");
  };
  await openTable(page, before);
  await place();
  await expect.poll(() => page.evaluate(() => window.__avLifecycle.motion.timers.size)).toBeGreaterThan(0);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await clean(page);
  await page.waitForTimeout(MOTION.flight + 50); // Cross the cancelled reward deadline.
  await clean(page);
  expect(await saved(page)).toEqual(applyAction(before, action));
  await page.keyboard.press("z");
  await place();
  await expect(page.locator('[data-motion="silver-gain"]')).toContainText("+2 silver");
  await expect(page.locator('[data-motion="silver-gain"]')).toHaveCSS("opacity", "1");
  expect(await page.evaluate(() => window.__avLifecycle.motion.animations.size)).toBe(0);
});

test("023 scroll and resize cancel screen-space effects, not committed moves", async ({ page }) => {
  await page.setViewportSize({ width: 1000, height: 650 });
  await openTable(page);
  const before = await saved(page);
  const sale = legal(before, { kind: "sell", good: 1, die: 0 });
  await sell(page);
  const committed = await saved(page);
  const moved = await page.evaluate(() => {
    const y = scrollY;
    scrollBy(0, y > 0 ? -100 : 100);
    return y !== scrollY;
  });
  expect(moved).toBe(true);
  await clean(page);
  expect(await saved(page)).toEqual(committed);
  const restored = await expectRestored(page, before, () => page.keyboard.press("z"), sale.label);
  await sell(page);
  await page.setViewportSize({ width: 1001, height: 650 });
  await clean(page);
  expect(await saved(page)).toEqual(applyAction(restored, sale));
});

test("024 short flights stay visible and finish at their destination without snapping back", async ({ page }) => {
  await openTable(page);
  await sell(page);
  const sample = await page.evaluate(async duration => {
    const motion = window.__avLifecycle.motion;
    motion.cancel();
    motion.flight("short-flight", "<strong>+1</strong>", { x: 300, y: 300, width: 40, height: 40 },
      { x: 306, y: 304, width: 40, height: 40 });
    const piece = motion.layer.querySelector<HTMLElement>(".motion-piece")!;
    const animation = piece.getAnimations()[0];
    animation.pause();
    animation.currentTime = duration * .45;
    const visible = Number(getComputedStyle(piece).opacity);
    const timing = animation.effect!.getTiming().duration;
    animation.finish();
    await animation.finished;
    const transform = new DOMMatrixReadOnly(getComputedStyle(piece).transform);
    return { visible, timing, x: transform.m41, y: transform.m42, connected: piece.isConnected };
  }, MOTION.flight);
  expect(sample.visible).toBeGreaterThanOrEqual(.85);
  expect(sample).toMatchObject({ timing: MOTION.flight, x: 6, y: 4, connected: true });
});

test("025 stale renderer callbacks cannot alter a replacement roll", async ({ page }) => {
  await openTable(page, position(true));
  await roll(page);
  const committed = await saved(page);
  await page.evaluate(state => {
    const motion = window.__avLifecycle.motion;
    motion.cancel();
    motion.startGame(state);
  }, committed);
  await expect.poll(() => page.evaluate(() => window.__avLifecycle.rolls.length)).toBe(2);
  expect(await page.evaluate(() => {
    const { rolls, motion } = window.__avLifecycle;
    const replacement = document.querySelector(".dice-stage");
    rolls[0].onLand?.();
    rolls[0].onComplete?.();
    rolls[0].onUnavailable?.();
    return { sameStage: replacement === document.querySelector(".dice-stage"), rolling: motion.rolling,
      receipts: motion.layer.childElementCount, reveal: document.querySelectorAll('[data-motion="dice-reveal"]').length };
  })).toEqual({ sameStage: true, rolling: true, receipts: 0, reveal: 0 });
  expect(await saved(page)).toEqual(committed);
});

test("026 receipts keep their clamped header offset and cannot flash after fading", async ({ page }) => {
  await openTable(page);
  await sell(page);
  const measurement = await page.evaluate(async () => {
    const layer = document.querySelector<HTMLElement>("#motion-layer")!;
    const receipts = [...layer.querySelectorAll<HTMLElement>(".motion-receipt")];
    for (const receipt of receipts) {
      const animation = receipt.getAnimations()[0];
      animation.pause();
      animation.currentTime = Number(animation.effect!.getTiming().duration) / 2;
    }
    const header = document.querySelector("#game-status")!.getBoundingClientRect();
    const height = receipts.reduce((sum, receipt) => sum + receipt.offsetHeight, 0) + (receipts.length - 1) * 12;
    const expected = Math.max(16, Math.min(header.bottom + 48, innerHeight - height - 16));
    const receipt = receipts[0];
    const rect = receipt.getBoundingClientRect();
    const animation = receipt.getAnimations()[0];
    animation.finish();
    await animation.finished;
    return { top: rect.top, expected, centered: Math.abs((rect.left + rect.right) / 2 - innerWidth / 2) < 1,
      connected: receipt.isConnected, opacity: getComputedStyle(receipt).opacity, events: getComputedStyle(layer).pointerEvents };
  });
  expect(measurement.top).toBeCloseTo(measurement.expected, 1);
  expect(measurement).toMatchObject({ centered: true, connected: true, opacity: "0", events: "none" });
});

test("027 repeated emphasis lasts until its own cleanup, not the previous one", async ({ page }) => {
  await openTable(page);
  await sell(page);
  const result = await page.evaluate(async () => {
    const motion = window.__avLifecycle.motion;
    motion.cancel();
    const target = document.querySelector<HTMLElement>('[data-resource="silver"]')!;
    motion.mark(target, "silver-balance", 60);
    motion.mark(target, "silver-balance", 600);
    await new Promise(resolve => setTimeout(resolve, 100));
    const active = target.classList.contains("motion-emphasis") && target.dataset.motion === "silver-balance";
    const owners = motion.cleanups.size;
    motion.cancel();
    return { active, owners, cleared: !target.hasAttribute("data-motion") && !target.classList.contains("motion-emphasis") };
  });
  expect(result).toEqual({ active: true, owners: 1, cleared: true });
  await clean(page);
});

test("028 closing an owning modal clears its feedback before it can reopen", async ({ page }) => {
  await openTable(page);
  await sell(page);
  const committed = await saved(page);
  await page.locator('[data-ui="help"]').click();
  await page.evaluate(() => {
    const { motion, args } = window.__avLifecycle;
    motion.play(...args); // Replay only the already-committed projection inside the real modal.
  });
  await expect(page.locator("dialog[open] #motion-layer .motion-receipt").first()).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator("body > #motion-layer")).toBeAttached();
  await clean(page);
  await page.locator('[data-ui="help"]').click();
  await expect(page.locator("dialog[open] .motion-receipt")).toHaveCount(0);
  expect(await saved(page)).toEqual(committed);
});

test("029 detached/hidden dice completion is silent while real context loss keeps readable fallback", async ({ page }) => {
  await openTable(page, position(true));
  await roll(page);
  const committed = await saved(page);
  await page.locator(".dice-stage").evaluate(stage => stage.remove());
  await expect.poll(() => page.evaluate(() => window.__avLifecycle.completions.length)).toBe(1);
  expect(await page.evaluate(() => window.__avLifecycle.completions[0])).toEqual({ receipts: 0, reading: false });
  await page.evaluate(state => window.__avLifecycle.motion.startGame(state), committed);
  await expect(page.locator(".dice-stage")).toHaveCount(1);
  // No visibility event: exercise the renderer's own early-completion callback,
  // independently of the app-level hidden listener covered by 021.
  await page.evaluate(() => Object.defineProperty(document, "hidden", { configurable: true, value: true }));
  await expect.poll(() => page.evaluate(() => window.__avLifecycle.completions.length)).toBe(2);
  expect(await page.evaluate(() => window.__avLifecycle.completions[1])).toEqual({ receipts: 0, reading: false });
  await page.evaluate(state => {
    Reflect.deleteProperty(document, "hidden");
    window.__avLifecycle.motion.startGame(state);
  }, committed);
  await expect(page.locator('canvas.dice-webgl[data-state="rolling"]')).toHaveCount(1);
  const lost = await page.evaluate(() => {
    const extension = window.__avLifecycle.motion.diceRenderer!.renderer!.getContext().getExtension("WEBGL_lose_context");
    extension?.loseContext();
    return Boolean(extension);
  });
  expect(lost).toBe(true);
  await expect(page.locator('#motion-layer [data-motion="dice-reveal"]')).toHaveText(
    committed.players.map(player => `${player.name}: ${player.dice.join(" & ")}`).join(" · "));
  await expect(page.locator('[data-motion="white-die"]')).toContainText(`Goods die ${committed.whiteDie}`);
  await expect(page.locator(".dice-stage, canvas.dice-webgl")).toHaveCount(0);
  expect(await saved(page)).toEqual(committed);
});

test("030 cancellation clears every owned resource and late timer while board-local rolls survive scroll", async ({ page }) => {
  await openTable(page, position(true));
  await roll(page);
  const committed = await saved(page);
  await page.evaluate(() => window.dispatchEvent(new Event("scroll")));
  expect(await page.evaluate(() => window.__avLifecycle.motion.rolling)).toBe(true);
  await page.evaluate(() => {
    const probe = window.__avLifecycle;
    const motion = probe.motion;
    motion.receipt("cancel-receipt", "Already committed");
    motion.mark(document.querySelector<HTMLElement>('[data-resource="silver"]')!, "cancel-mark", 200);
    motion.later(() => { probe.delayed = true; motion.receipt("stale", "Must not return"); }, 60);
    motion.cancel();
    motion.cancel();
  });
  await clean(page);
  await page.waitForTimeout(100); // Cross the cancelled callback's actual deadline.
  await clean(page);
  expect(await page.evaluate(() => Boolean(window.__avLifecycle.delayed))).toBe(false);
  await expect(page.locator("body > #motion-layer")).toHaveAttribute("aria-hidden", "true");
  expect(await saved(page)).toEqual(committed);
});
