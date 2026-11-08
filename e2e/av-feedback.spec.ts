import { expect, test, type Page } from "@playwright/test";
import { expectRestored } from "./undo-assertions";
import { chooseAction } from "../src/ai";
import { boardFor } from "../src/boards";
import { actionKey, applyAction, canPlace, createGame, legalActions } from "../src/engine";
import type { GameMotion } from "../src/motion";
import type { MotionPlan } from "../src/motion-events";
import { MOTION } from "../src/motion-timing";
import type { Action, State, Tile } from "../src/types";

const SAVE_KEY = "burgundy-table.state.v1";
const GAIN = '#motion-layer [data-motion="workers-gain"]';
const SPEND = '#motion-layer [data-motion="workers-spend"]';
const BALANCE = '[data-resource="workers"]';

// Observation only: every move goes through a real control and the real engine.
// No direct play/cancel/receipt calls, fake DOM, clock control, or AI replacement.
interface MotionRuntime {
  animations: Set<Animation>;
  timers: Set<number>;
  cleanups: Map<HTMLElement, () => void>;
  frame?: number;
  reading: boolean;
}
declare global {
  interface Window {
    __avFeedback: {
      motion?: MotionRuntime;
      plays: { at: number; plan: MotionPlan }[];
      receipts: { at: number; kind: string; text: string }[];
    };
  }
}

function position(playerCount: 2 | 4 = 2): State {
  const state = createGame(42, { playerCount });
  state.active = 0;
  state.order = state.players.map((_, player) => player);
  state.turnIndex = 0;
  state.players[0].dice = [1, 2];
  state.players[0].workers = 6;
  state.players[0].goods = [2, 1, 0, 0, 0, 0];
  return state;
}

function legal(state: State, match: Partial<Action>): Action {
  const action = legalActions(state).find(action => Object.entries(match).every(([key, value]) =>
    JSON.stringify(action[key as keyof Action]) === JSON.stringify(value)));
  if (!action) throw new Error(`No legal worker-feedback action: ${JSON.stringify(match)}`);
  return action;
}

function boarding(cost = 0) {
  const state = position();
  const tile: Tile = { id: "feedback-boarding", color: "building", building: "boarding" };
  const cell = boardFor(state.players[0]).find(cell => canPlace(state.players[0], tile, cell.id))!;
  state.players[0].storage = [tile];
  state.players[0].dice[0] = (cell.die - 1 + cost) % 6 + 1;
  return { state, action: legal(state, { kind: "place", tile: tile.id, cell: cell.id, die: 0, cost }) };
}

function knowledge(enhanced = false) {
  const state = position();
  const spaces = boardFor(state.players[0]).filter(cell => cell.color === "knowledge");
  for (const [index, id] of (enhanced ? [13, 14] : [13]).entries()) {
    state.players[0].board[spaces[index].id] = { id: `feedback-knowledge-${id}`, color: "knowledge", knowledge: id };
  }
  return state;
}

function rivalPosition(actor: number, playerCount: 2 | 4 = 4) {
  const state = position(playerCount);
  state.order = [0, actor, ...state.order.filter(player => player !== 0 && player !== actor)];
  state.players[0].dice = [null, null];
  const rival = state.players[actor];
  rival.dice = [1, null];
  rival.workers = 0;
  rival.silver = 0;
  rival.goods.fill(0);
  rival.storage = [];
  state.depots.forEach(depot => { depot.tiles = []; });
  state.black = [];
  return state;
}

function rivalSpending() {
  const state = rivalPosition(1, 2);
  const rival = state.players[1];
  rival.workers = 3;
  rival.storage = [{ id: "feedback-rival-watchtower", color: "building", building: "watchtower" }];
  // Choose a real, deterministic AI route with a paid adjustment, not a mocked move.
  for (let die = 1; die <= 6; die++) {
    rival.dice = [die, null];
    const handed = applyAction(state, legal(state, { kind: "end" }));
    const action = chooseAction(handed);
    if (action.kind === "place" && action.cost > 0) return { state, handed, action };
  }
  throw new Error("No deterministic paid rival placement in the fixture");
}

async function openTable(page: Page, state = position()) {
  await page.addInitScript(({ key, state }) => localStorage.setItem(key, JSON.stringify(state)), { key: SAVE_KEY, state });
  await page.goto("/");
  await expect(page.locator("#turn-controls")).toBeVisible();
  await expect(page.locator("#board canvas")).toBeAttached();
  await page.evaluate(() => document.fonts.ready);
  await page.evaluate(async () => {
    const loaded = performance.getEntriesByType("resource")
      .find(entry => new URL(entry.name).pathname === "/src/motion.ts")!.name;
    const { GameMotion } = await import(loaded);
    const probe = window.__avFeedback = { plays: [], receipts: [] } as Window["__avFeedback"];
    const play = GameMotion.prototype.play;
    GameMotion.prototype.play = function (this: MotionRuntime, ...args: Parameters<GameMotion["play"]>) {
      probe.motion = this;
      probe.plays.push({ at: performance.now(), plan: args[0] });
      return play.apply(this, args);
    };
    new MutationObserver(records => {
      for (const record of records) for (const node of record.addedNodes) {
        if (node instanceof HTMLElement && node.matches(".motion-receipt"))
          probe.receipts.push({ at: performance.now(), kind: node.dataset.motion!, text: node.textContent! });
      }
    }).observe(document.querySelector("#motion-layer")!, { childList: true });
  });
}

async function saved(page: Page): Promise<State> {
  return page.evaluate(key => JSON.parse(localStorage.getItem(key)!), SAVE_KEY);
}

async function keyboardAction(page: Page, action: Action) {
  const details = page.locator("#legal-details");
  if (!await details.evaluate(element => element.hasAttribute("open"))) await details.locator("summary").click();
  const choice = page.locator(`#legal-actions [data-action-key=${JSON.stringify(actionKey(action))}]`);
  await choice.focus();
  await choice.press("Enter");
}

async function clean(page: Page) {
  await expect(page.locator("#motion-layer > *, .motion-emphasis, .worker-spend")).toHaveCount(0);
  expect(await page.evaluate(() => {
    const motion = window.__avFeedback.motion!;
    return [motion.animations.size, motion.timers.size, motion.cleanups.size,
      Number(motion.frame !== undefined), Number(motion.reading)];
  })).toEqual([0, 0, 0, 0, 0]);
}

async function receiptBounds(page: Page) {
  const geometry = await page.locator("#motion-layer").evaluate(layer => {
    const receipts = [...layer.querySelectorAll<HTMLElement>(".motion-receipt")];
    const header = document.querySelector("#game-status")!.getBoundingClientRect();
    const visibleHeader = header.width > 0 && header.height > 0 && header.bottom > 0 && header.top < innerHeight;
    const stack = receipts.reduce((height, receipt) => height + receipt.offsetHeight, 0) + (receipts.length - 1) * 12;
    return { width: innerWidth, height: innerHeight, scrollWidth: document.documentElement.scrollWidth,
      top: parseFloat(getComputedStyle(layer).paddingTop),
      expected: Math.max(16, Math.min(visibleHeader ? header.bottom + 48 : 64, innerHeight - stack - 16)),
      boxes: receipts.map(receipt => {
        const r = receipt.getBoundingClientRect();
        return { x: r.x, y: r.y, width: r.width, height: r.height };
      }) };
  });
  expect(geometry.boxes.length).toBeGreaterThan(0);
  expect(geometry.top).toBeCloseTo(geometry.expected, 1);
  expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.width);
  for (const box of geometry.boxes) {
    expect(box.width).toBeGreaterThan(0);
    expect(box.height).toBeGreaterThan(0);
    expect(box.x).toBeGreaterThanOrEqual(16);
    expect(box.y).toBeGreaterThanOrEqual(16);
    expect(box.x + box.width).toBeLessThanOrEqual(geometry.width - 16);
    expect(box.y + box.height).toBeLessThanOrEqual(geometry.height - 16);
    expect(box.x + box.width / 2).toBeCloseTo(geometry.width / 2, 1);
  }
  await expect(page.locator("#motion-layer")).toHaveCSS("pointer-events", "none");
}

test("071 normal gain marks the balance and replaces the redundant toast", async ({ page }, testInfo) => {
  const before = position();
  const expected = applyAction(before, legal(before, { kind: "workers", die: 0 }));
  await openTable(page, before);
  await page.locator('[data-mode="workers"]').click();
  await expect(page.locator(GAIN)).toHaveText("+2 workers");
  expect(await saved(page)).toEqual(expected);
  await expect(page.locator(`${BALANCE} strong`)).toHaveText(String(expected.players[0].workers));
  await expect(page.locator(BALANCE)).toHaveAttribute("data-motion", "workers-balance");
  await expect(page.locator("#feedback")).toBeHidden();
  await expect(page.locator("#announcer")).toContainText("You: Take 2 workers.");
  await expect(page.locator("#motion-layer .motion-receipt")).toHaveCount(1);
  await expect(page.locator(GAIN)).toHaveCSS("opacity", "1");
  await receiptBounds(page);
  await page.screenshot({ path: testInfo.outputPath("feedback-desktop.png") });
});

test("072 the second die replaces the first receipt without accumulating rewards", async ({ page }) => {
  const before = position();
  const first = applyAction(before, legal(before, { kind: "workers", die: 0 }));
  const second = applyAction(first, legal(first, { kind: "workers", die: 1 }));
  await openTable(page, before);
  await page.keyboard.press("4");
  await expect(page.locator(GAIN)).toHaveText("+2 workers");
  const old = await page.locator(GAIN).elementHandle();
  await page.waitForTimeout(1250); // Cross the first highlight's deadline after replacing it.
  await page.keyboard.press("4");
  expect(await saved(page)).toEqual(second);
  await expect(page.locator(GAIN)).toHaveCount(1);
  await expect(page.locator(GAIN)).toHaveText("+2 workers");
  expect(await old!.evaluate(element => element.isConnected)).toBe(false);
  await page.waitForTimeout(650);
  await expect(page.locator(BALANCE)).toHaveAttribute("data-motion", "workers-balance");
  await expect(page.locator('#turn-controls .turn-tools .end-turn')).toBeEnabled();
  expect(await page.evaluate(() => window.__avFeedback.receipts.filter(item => item.kind === "workers-gain").length)).toBe(2);
});

test("073 Undo clears worker feedback and restores exactly the committed die and balance", async ({ page }) => {
  const before = position();
  await openTable(page, before);
  await page.keyboard.press("4");
  await expect(page.locator(GAIN)).toBeVisible();
  await expectRestored(page, before, () => page.locator('[data-ui="undo"]').click());
  await clean(page);
  await expect(page.locator(`${BALANCE} strong`)).toHaveText(String(before.players[0].workers));
  await expect(page.locator('[data-ui="undo"]')).toBeDisabled();
});

test("074 every rival gain and a viewed rival's spending identify the actual owner", async ({ page }) => {
  for (const actor of [1, 2, 3]) await test.step(`rival ${actor} gain`, async () => {
    const before = rivalPosition(actor);
    const handed = applyAction(before, legal(before, { kind: "end" }));
    const action = legal(handed, { kind: "workers", die: 0 });
    expect(legalActions(handed)).toEqual([action]);
    await openTable(page, before);
    await page.locator('#turn-controls .turn-tools .end-turn').click();
    await expect(page.locator(GAIN)).toHaveText(`${before.players[actor].name}: +2 workers`);
    expect(await saved(page)).toEqual(applyAction(handed, action));
    await expect(page.locator(`[data-player-index="${actor}"]`)).toHaveAttribute("data-motion", "workers-balance");
    await expect(page.locator("#feedback")).toBeHidden();
    await expect(page.locator("#announcer")).toContainText(`${before.players[actor].name}: Take 2 workers.`);
  });
  const { state: before, handed, action } = rivalSpending();
  await openTable(page, before);
  await page.locator('[data-view="1"]').click();
  await page.locator('#turn-controls .turn-tools .end-turn').click();
  await expect(page.locator(SPEND)).toHaveText(`${before.players[1].name}: −${action.cost} worker${action.cost === 1 ? "" : "s"}`);
  expect(await saved(page)).toEqual(applyAction(handed, action));
  await expect(page.locator(BALANCE)).toHaveAttribute("data-motion", "workers-balance");
  await expect(page.locator('#motion-layer [data-motion="rival-action"]')).toContainText(`${before.players[1].name}: Built`);
  await expect(page.locator("#feedback")).toBeHidden();
  await expect(page.locator(".worker-spend")).toHaveCount(0);
});

test("075 Boarding House net gains wait for placement; a paid placement keeps its human spend", async ({ page }) => {
  for (const cost of [0, 2]) await test.step(`placement cost ${cost}`, async () => {
    const { state: before, action } = boarding(cost);
    const expected = applyAction(before, action);
    await openTable(page, before);
    await keyboardAction(page, action);
    expect(await saved(page)).toEqual(expected);
    await expect(page.locator(GAIN)).toHaveCount(0);
    await expect(page.locator(GAIN)).toHaveText(`+${4 - cost} workers`);
    const elapsed = await page.evaluate(() => {
      const probe = window.__avFeedback;
      return probe.receipts.find(item => item.kind === "workers-gain")!.at - probe.plays[0].at;
    });
    expect(elapsed).toBeGreaterThanOrEqual(MOTION.flight - 20);
    await expect(page.locator(BALANCE)).toHaveAttribute("data-motion", "workers-balance");
    if (cost) {
      await expect(page.locator("#feedback .worker-spend")).toBeVisible();
      await expect(page.locator("#feedback .worker-spend")).toContainText("−2 workers");
      await expect(page.locator(SPEND)).toHaveCount(0);
    } else await expect(page.locator("#feedback")).toBeHidden();
  });
});

test("076 knowledge 13 groups workers and silver while retaining both balance highlights", async ({ page }) => {
  for (const enhanced of [false, true]) await test.step(`knowledge 14 ${enhanced ? "present" : "absent"}`, async () => {
    const before = knowledge(enhanced);
    const expected = applyAction(before, legal(before, { kind: "workers", die: 0 }));
    await openTable(page, before);
    await page.locator('[data-mode="workers"]').click();
    await expect(page.locator(GAIN)).toHaveText(`+${enhanced ? 4 : 2} workers · +1 silver`);
    expect(await saved(page)).toEqual(expected);
    await expect(page.locator("#motion-layer .motion-receipt")).toHaveCount(1);
    await expect(page.locator('[data-resource="silver"]')).toHaveAttribute("data-motion", "silver-balance");
    await expect(page.locator(BALANCE)).toHaveAttribute("data-motion", "workers-balance");
    await expect(page.locator("#feedback")).toBeHidden();
  });
});

test("077 reduced motion shows immediate static worker rewards without new animations", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  const { state: before, action } = boarding();
  await openTable(page, before);
  await keyboardAction(page, action);
  await expect(page.locator(GAIN)).toHaveText("+4 workers");
  expect(await saved(page)).toEqual(applyAction(before, action));
  await expect(page.locator(GAIN)).toHaveCSS("opacity", "1");
  await expect(page.locator(GAIN)).toHaveCSS("transform", "none");
  await expect(page.locator(GAIN)).toHaveCSS("animation-name", "none");
  await expect(page.locator(".motion-piece, .dice-stage")).toHaveCount(0);
  const probe = await page.evaluate(() => ({ animations: window.__avFeedback.motion!.animations.size,
    elapsed: window.__avFeedback.receipts.find(item => item.kind === "workers-gain")!.at - window.__avFeedback.plays[0].at }));
  expect(probe.animations).toBe(0);
  expect(probe.elapsed).toBeLessThan(MOTION.flight);
  await expect(page.locator(BALANCE)).toHaveAttribute("data-motion", "workers-balance");
});

test("078 phone receipts stay centered, clamped and compact below the current header", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const before = knowledge(true);
  await openTable(page, before);
  await page.locator('[data-mode="workers"]').click();
  await expect(page.locator(GAIN)).toHaveText("+4 workers · +1 silver");
  expect(await saved(page)).toEqual(applyAction(before, legal(before, { kind: "workers", die: 0 })));
  await expect(page.locator("#motion-layer .motion-receipt")).toHaveCount(1);
  await expect(page.locator(BALANCE)).toHaveAttribute("data-motion", "workers-balance");
  await expect(page.locator("#feedback")).toBeHidden();
  await expect(page.locator(GAIN)).toHaveCSS("opacity", "1");
  await receiptBounds(page);
  await page.screenshot({ path: testInfo.outputPath("feedback-phone.png") });
});

test("079 human worker spending marks the balance without a duplicate spending receipt", async ({ page }) => {
  const before = position();
  const action = legal(before, { kind: "take", die: 0, cost: 1 });
  await openTable(page, before);
  await page.locator(`[data-source="market"][data-tile="${action.tile}"]`).click();
  expect(await saved(page)).toEqual(applyAction(before, action));
  await expect(page.locator(BALANCE)).toHaveAttribute("data-motion", "workers-balance");
  await expect(page.locator(".worker-spend")).toHaveCount(1);
  await expect(page.locator(".worker-spend")).toContainText("−1 worker");
  await expect(page.locator("#feedback")).toBeVisible();
  await expect(page.locator(SPEND)).toHaveCount(0);
  await expect(page.locator(GAIN)).toHaveCount(0);
  await expect(page.locator("#announcer")).toContainText("Used 1 worker.");
});

test("080 a rapid next action and Undo cannot resurrect the delayed Boarding House reward", async ({ page }) => {
  const { state: before, action } = boarding();
  const placed = applyAction(before, action);
  const second = applyAction(placed, legal(placed, { kind: "workers", die: 1 }));
  await openTable(page, before);
  await keyboardAction(page, action);
  await page.keyboard.press("4");
  expect(await saved(page)).toEqual(second);
  await expect(page.locator(GAIN)).toHaveText("+2 workers");
  expect(await page.evaluate(() => window.__avFeedback.plays[1].at - window.__avFeedback.plays[0].at)).toBeLessThan(MOTION.flight);
  await page.waitForTimeout(MOTION.flight + MOTION.rewardDelay + 100); // Cross both obsolete placement/reward deadlines.
  await expect(page.locator(GAIN)).toHaveText("+2 workers");
  expect(await page.evaluate(() => window.__avFeedback.receipts.filter(item => item.kind === "workers-gain").map(item => item.text)))
    .toEqual(["+2 workers"]);
  await expectRestored(page, placed, () => page.keyboard.press("z"));
  await clean(page);
  await page.waitForTimeout(150);
  await expect(page.locator(GAIN)).toHaveCount(0);
  await expectRestored(page, before, () => page.keyboard.press("z"));
  await clean(page);
});
