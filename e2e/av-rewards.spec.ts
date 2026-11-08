import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { expectRestored } from "./undo-assertions";
import { writeFile } from "node:fs/promises";
import { boardFor } from "../src/boards";
import { actionKey, applyAction, createGame, legalActions } from "../src/engine";
import type { GameMotion } from "../src/motion";
import { motionForAction } from "../src/motion-events";
import { MOTION } from "../src/motion-timing";
import type { Action, State } from "../src/types";

const SAVE_KEY = "burgundy-table.state.v1";
type Runtime = { play: GameMotion["play"]; receipt(kind: string, text: string, icon?: string): HTMLElement };
declare global {
  interface Window {
    __avRewards: {
      calls: number;
      receipts: { kind: string; text: string; duration: number | string | undefined }[];
    };
  }
}

// Seeded checkpoints shorten the history, not the move: every reward below is
// emitted by production GameMotion after a UI action and a real engine commit.
// No synthetic MotionPlan, receipt DOM, private receipt invocation, or fake play.
function table(count: 2 | 4 = 4): State {
  const state = createGame(42, { playerCount: count });
  state.active = 0;
  state.order = state.players.map((_, i) => i);
  state.turnIndex = 0;
  state.players.forEach((player, i) => {
    player.dice = i === 0 ? [1, 2] : [null, null];
    player.goods.fill(0);
    player.silver = 1;
    player.workers = 0;
    player.arrival = count - i;
  });
  return state;
}

function phaseEnd(final = false): State {
  const state = table();
  state.phase = final ? 4 : 0;
  state.round = 4;
  state.order = [1, 2, 3, 0];
  state.turnIndex = 3;
  state.players.forEach((player, i) => {
    player.dice = [null, null];
    const mines = (final ? [[24, 29], [24], [24, 29, 33], [24]] : [[24], [24], [24], [24]])[i];
    for (const cell of mines) player.board[cell] = state.pools.mine.pop()!;
    if (final) {
      player.goods[i] = i + 1;
      player.workers = i * 2;
      player.score = i * 10;
    }
  });
  return state;
}

function castleRegion(): State {
  const state = table(2);
  state.phase = 2;
  const player = state.players[0];
  for (const cell of [1, 2]) player.board[cell] = state.pools.castle.pop()!;
  const bridge = state.pools.building.find(tile => tile.building === "bank")!;
  state.pools.building.splice(state.pools.building.indexOf(bridge), 1);
  player.board[11] = bridge;
  player.storage = [state.pools.castle.pop()!];
  player.dice[0] = boardFor(player)[6].die;
  return state;
}

function saleTable(): State {
  const state = table(2);
  state.players[0].goods = [2, 2, 0, 0, 0, 0];
  return state;
}

function legal(state: State, match: Partial<Action>): Action {
  const action = legalActions(state).find(action => Object.entries(match).every(([key, value]) =>
    JSON.stringify(action[key as keyof Action]) === JSON.stringify(value)));
  if (!action) throw new Error(`No reward checkpoint action: ${JSON.stringify(match)}`);
  return action;
}

async function openTable(page: Page, state: State) {
  await page.addInitScript(({ key, state }) => localStorage.setItem(key, JSON.stringify(state)), { key: SAVE_KEY, state });
  await page.goto("/");
  await expect(page.locator("#turn-controls")).toBeVisible();
  await expect(page.locator("#board canvas")).toBeAttached();
  await page.evaluate(() => document.fonts.ready);
  await page.evaluate(async () => {
    const resource = performance.getEntriesByType("resource").find(entry =>
      new URL(entry.name).pathname === "/src/motion.ts")!;
    const { GameMotion } = await import(resource.name);
    const probe = window.__avRewards = { calls: 0, receipts: [] } as Window["__avRewards"];
    const play = GameMotion.prototype.play;
    GameMotion.prototype.play = function (this: Runtime, ...args: Parameters<GameMotion["play"]>) {
      probe.calls++;
      return play.apply(this, args);
    };
    const receipt = GameMotion.prototype.receipt;
    GameMotion.prototype.receipt = function (this: Runtime, kind: string, text: string, icon?: string) {
      const element = receipt.call(this, kind, text, icon);
      probe.receipts.push({ kind, text, duration: element.getAnimations()[0]?.effect?.getTiming().duration });
      return element;
    };
  });
}

async function saved(page: Page): Promise<State> {
  return page.evaluate(key => JSON.parse(localStorage.getItem(key)!), SAVE_KEY);
}

async function end(page: Page, before: State) {
  const action = legal(before, { kind: "end" });
  await page.locator("#turn-controls .turn-tools .end-turn").click();
  expect(await saved(page)).toEqual(applyAction(before, action));
}

async function placeCastle(page: Page, before: State) {
  const action = legal(before, { kind: "place", cell: 6, die: 0, cost: 0 });
  const details = page.locator("#legal-details");
  await details.locator("summary").click();
  const choice = page.locator(`#legal-actions [data-action-key=${JSON.stringify(actionKey(action))}]`);
  await choice.focus();
  await choice.press("Enter");
  expect(await saved(page)).toEqual(applyAction(before, action));
  return action;
}

const receipts = (page: Page, kind?: string) => page.locator(`#motion-layer .motion-receipt${kind ? `[data-motion="${kind}"]` : ""}`);

// Capture the native readable hold, not a seeked compositor frame.
async function observe(page: Page, info: TestInfo, image?: string) {
  // Opt-in keeps ordinary regression runs from generating extra visual sets.
  image = process.env.AV_REWARDS_CAPTURE === "1" ? image : undefined;
  if (image) {
    await expect.poll(() => receipts(page).evaluateAll(elements => elements.every(element => {
      const animation = element.getAnimations()[0];
      return animation && Number(animation.currentTime) > 400 && Number(animation.currentTime) < 1800;
    }))).toBe(true);
  }
  const evidence = await page.evaluate(() => {
    const layer = document.querySelector<HTMLElement>("#motion-layer")!;
    const header = document.querySelector("#game-status")!.getBoundingClientRect();
    const visibleHeader = header.width > 0 && header.height > 0 && header.bottom > 0 && header.top < innerHeight;
    return {
      width: innerWidth, height: innerHeight,
      reduced: matchMedia("(prefers-reduced-motion: reduce)").matches,
      forcedColors: matchMedia("(forced-colors: active)").matches,
      headerBottom: visibleHeader ? header.bottom : null,
      paddingTop: parseFloat(layer.style.paddingTop),
      parent: layer.parentElement?.tagName,
      announcer: document.querySelector("#announcer")?.textContent,
      history: window.__avRewards,
      boxes: Array.from(layer.querySelectorAll<HTMLElement>(".motion-receipt"), element => {
        const rect = element.getBoundingClientRect(), css = getComputedStyle(element);
        return {
          text: element.querySelector(":scope > span:last-child")?.textContent,
          kind: element.dataset.motion, top: rect.top, right: rect.right, bottom: rect.bottom, left: rect.left,
          height: element.offsetHeight, font: parseFloat(css.fontSize), foreground: css.color, background: css.backgroundColor,
          border: css.borderTopColor, borderWidth: css.borderTopWidth,
          opacity: css.opacity, pointerEvents: css.pointerEvents, animations: element.getAnimations().length,
        };
      }),
    };
  });
  await writeFile(info.outputPath("receipt-observation.json"), JSON.stringify(evidence, null, 2));
  if (image) await page.screenshot({ path: info.outputPath(image) });
  return evidence;
}

function lowerCentered(evidence: Awaited<ReturnType<typeof observe>>) {
  const { boxes, width, height, headerBottom, paddingTop } = evidence;
  expect(boxes.length).toBeGreaterThan(0);
  const stack = boxes.reduce((total, box) => total + box.height, 0) + (boxes.length - 1) * 12;
  expect(paddingTop).toBe(Math.max(16, Math.min(headerBottom === null ? 64 : headerBottom + 48, height - stack - 16)));
  for (const [i, box] of boxes.entries()) {
    expect(box.font).toBeGreaterThanOrEqual(20);
    expect(box.pointerEvents).toBe("none");
    expect(Math.abs((box.left + box.right) / 2 - width / 2)).toBeLessThan(1);
    expect(box.left).toBeGreaterThanOrEqual(16);
    expect(box.right).toBeLessThanOrEqual(width - 16);
    expect(box.top).toBeGreaterThanOrEqual(16);
    expect(box.bottom).toBeLessThanOrEqual(height - 12); // At most 4px native entrance translation.
    if (i) expect(box.top - boxes[i - 1].bottom).toBeGreaterThanOrEqual(8);
  }
  for (const item of evidence.history.receipts)
    if (item.duration !== undefined) expect(item.duration).toBe(MOTION.receipt);
}

test("091 four-player final rewards identify each scoring player", async ({ page }, info) => {
  const before = phaseEnd(true);
  await openTable(page, before);
  await end(page, before);
  await expect(receipts(page, "score-gain")).toHaveCount(4);
  const evidence = await observe(page, info, "rewards-desktop-final.png");
  lowerCentered(evidence);
  const next = await saved(page);
  expect(evidence.boxes.filter(box => box.kind === "score-gain").map(box => box.text)).toEqual(
    next.players.map((player, i) => `${player.name}: +${player.score - before.players[i].score} VP · +${player.silver - before.players[i].silver} silver · mines`));
  await expect(receipts(page, "silver-gain")).toHaveCount(0);
});

test("092 four-player mine income preserves owners and exact amounts", async ({ page }, info) => {
  const before = phaseEnd();
  await openTable(page, before);
  await end(page, before);
  await expect(receipts(page, "silver-gain")).toHaveCount(4);
  const evidence = await observe(page, info);
  lowerCentered(evidence);
  const next = await saved(page);
  const text = evidence.boxes.map(box => box.text);
  next.players.forEach((player, i) => expect(text).toContain(`${i === 0 ? "" : `${player.name}: `}+${player.silver - before.players[i].silver} silver · mines`));
  await expect(page.locator('#resources [data-resource="silver"]')).toBeInViewport();
});

test("093 castle privilege and region points have separate readable roles", async ({ page }, info) => {
  const before = castleRegion();
  await openTable(page, before);
  const action = await placeCastle(page, before);
  await expect(receipts(page, "score-gain")).toHaveCount(1);
  await expect(receipts(page, "free-action")).toContainText("Castle privilege · one free action");
  const evidence = await observe(page, info);
  lowerCentered(evidence);
  const plan = motionForAction(before, action, applyAction(before, action));
  expect(evidence.boxes.find(box => box.kind === "score-gain")?.text).toBe(`+${plan.scores[0].amount} VP · region +${plan.regions[0].points}`);
  await expect(page.locator("#turn-controls .action-step")).toContainText("Choose action");
});

test("094 three goods types remain distinct after a real harbor load", async ({ page }, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const before = table(2);
  before.pending = [{ kind: "ship" }];
  const knowledge = before.pools.knowledge.find(tile => tile.knowledge === 5)!;
  before.pools.knowledge.splice(before.pools.knowledge.indexOf(knowledge), 1);
  before.players[0].board[12] = knowledge;
  before.players[0].goods[0] = 1;
  before.depots.forEach(depot => { depot.goods = []; });
  before.depots[0].goods = [1, 3, 3];
  before.depots[5].goods = [1, 2, 2, 4];
  const choosing = applyAction(before, legal(before, { kind: "ship", depots: [5, 0] }));
  const action = legal(choosing, { kind: "goods", types: [1, 2, 3] });
  await openTable(page, choosing);
  await page.getByRole("dialog").locator(`[data-action-key=${JSON.stringify(actionKey(action))}]`).click();
  expect(await saved(page)).toEqual(applyAction(choosing, action));
  await expect(receipts(page, "cargo-receipt")).toHaveCount(3);
  const evidence = await observe(page, info);
  lowerCentered(evidence);
  expect(evidence.boxes.map(box => box.text)).toEqual([1, 2, 3].map(type => `+2 goods · type ${type} stored`));
});

test("095 short landscape keeps the final income and score stack on screen", async ({ page }, info) => {
  await page.setViewportSize({ width: 844, height: 390 });
  const before = phaseEnd(true);
  await openTable(page, before);
  await end(page, before);
  await expect(receipts(page, "score-gain")).toHaveCount(4);
  const evidence = await observe(page, info, "rewards-short-landscape.png");
  lowerCentered(evidence);
  expect(evidence.boxes).toHaveLength(4);
  for (const box of evidence.boxes) expect(box.text).toContain("silver · mines");
});

test("095 phase income survives the automatic short-landscape board reveal before the roll", async ({ page }) => {
  await page.setViewportSize({ width: 844, height: 390 });
  const before = phaseEnd();
  await openTable(page, before);
  await end(page, before);
  await expect(receipts(page, "silver-gain")).toHaveCount(4);
  await expect(page.locator(".dice-stage")).toHaveCount(1, { timeout: 6500 });
  await expect(receipts(page, "white-die")).toHaveCount(1, { timeout: 5500 });
  expect((await saved(page)).phase).toBe(before.phase + 1);
});

test("096 narrow phone wraps long player names without losing identity", async ({ page }, info) => {
  await page.setViewportSize({ width: 320, height: 740 });
  // This one phone frame also gives case 097 real forced-color visual evidence.
  await page.emulateMedia({ forcedColors: "active" });
  const before = phaseEnd(true);
  ["Alexandria of the Northern Vineyards", "The Steward of Saint-Clair-sur-Mer", "The Merchant of the Burgundy Coast", "The Castellan of the Eastern Hills"]
    .forEach((name, i) => { before.players[i].name = name; });
  await openTable(page, before);
  await end(page, before);
  await expect(receipts(page, "score-gain")).toHaveCount(4);
  const evidence = await observe(page, info, "rewards-phone-long-names-forced.png");
  lowerCentered(evidence);
  expect(evidence.boxes).toHaveLength(4);
  before.players.forEach(player => expect(evidence.boxes.some(box => box.text?.startsWith(`${player.name}: `))).toBe(true));
});

test("096 final mining workers and silver appear once in the named score receipt", async ({ page }, info) => {
  await page.setViewportSize({ width: 844, height: 390 });
  const before = phaseEnd(true);
  const knowledge = before.pools.knowledge.find(tile => tile.knowledge === 2)!;
  before.pools.knowledge = before.pools.knowledge.filter(tile => tile.id !== knowledge.id);
  before.players[0].board[12] = knowledge;
  await openTable(page, before);
  await end(page, before);
  await expect(receipts(page, "score-gain")).toHaveCount(4);
  await expect(receipts(page)).toHaveCount(4);
  const next = await saved(page);
  const text = `You: +${next.players[0].score - before.players[0].score} VP · +2 silver · mines · +2 workers`;
  await expect(receipts(page, "score-gain").first()).toHaveText(text);
  await expect(receipts(page, "workers-gain")).toHaveCount(0);
  await expect(receipts(page, "silver-gain")).toHaveCount(0);
  lowerCentered(await observe(page, info));
});

test("097 forced colors preserve gain text, card boundaries and contrast", async ({ page }, info) => {
  await page.emulateMedia({ forcedColors: "active" });
  const before = saleTable();
  await openTable(page, before);
  await page.locator('[data-good="1"]').click();
  expect(await saved(page)).toEqual(applyAction(before, legal(before, { kind: "sell", good: 1, die: 0 })));
  await expect(receipts(page, "score-gain")).toHaveCount(1);
  const evidence = await observe(page, info);
  lowerCentered(evidence);
  for (const box of evidence.boxes) {
    expect(box.foreground).not.toBe(box.background);
    expect(box.border).not.toBe(box.background);
    expect(box.borderWidth).toBe("1px");
  }
  await expect(receipts(page, "silver-gain")).toContainText("+1 silver");
  await expect(receipts(page, "score-gain")).toContainText("+4 VP");
});

test("098 results top layer keeps feedback visible and Escape immediate", async ({ page }, info) => {
  const before = phaseEnd(true);
  await openTable(page, before);
  await end(page, before);
  await expect(receipts(page, "score-gain")).toHaveCount(4);
  const evidence = await observe(page, info);
  expect(evidence.parent).toBe("DIALOG");
  await expect(page.locator("dialog[open] > #motion-layer")).toBeAttached();
  const intercepted = await receipts(page).evaluateAll(elements => elements.some(element => {
    const r = element.getBoundingClientRect();
    return document.elementFromPoint((r.left + r.right) / 2, (r.top + r.bottom) / 2)?.closest("#motion-layer");
  }));
  expect(intercepted).toBe(false);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await expect(receipts(page)).toHaveCount(0);
  await expect(page.locator("body > #motion-layer")).toBeAttached();
  expect(await saved(page)).toEqual(applyAction(before, legal(before, { kind: "end" })));
});

test("099 reduced motion keeps equivalent castle and region feedback", async ({ page }, info) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  const before = castleRegion();
  await openTable(page, before);
  const action = await placeCastle(page, before);
  await expect(receipts(page, "score-gain")).toHaveCount(1);
  const evidence = await observe(page, info);
  lowerCentered(evidence);
  const plan = motionForAction(before, action, applyAction(before, action));
  expect(evidence.boxes.find(box => box.kind === "score-gain")?.text).toBe(`+${plan.scores[0].amount} VP · region +${plan.regions[0].points}`);
  expect(evidence.boxes.find(box => box.kind === "free-action")?.text).toBe("Castle privilege · one free action");
  for (const box of evidence.boxes) {
    expect(box.animations).toBe(0);
    expect(box.opacity).toBe("1");
  }
  await expect(page.locator("#motion-layer")).toHaveAttribute("aria-hidden", "true");
  await expect(page.locator("#announcer")).toContainText(`+${plan.scores[0].amount} VP`);
});

test("100 pointer and keyboard commit immediately during stacked gains", async ({ page }, info) => {
  const before = saleTable();
  await openTable(page, before);
  await page.locator('[data-good="1"]').click();
  const sold = applyAction(before, legal(before, { kind: "sell", good: 1, die: 0 }));
  expect(await saved(page)).toEqual(sold);
  await expect(receipts(page, "score-gain")).toHaveCount(1);
  const evidence = await observe(page, info);
  expect(evidence.boxes.length).toBeGreaterThanOrEqual(2);
  const began = await page.evaluate(() => performance.now());
  await page.locator('#turn-controls [data-mode="workers"]').click();
  expect(await saved(page)).toEqual(applyAction(sold, legal(sold, { kind: "workers", die: 1 })));
  expect(await page.evaluate(start => performance.now() - start, began)).toBeLessThan(MOTION.receipt);
  const restored = await expectRestored(page, sold, () => page.keyboard.press("z"), legal(sold, { kind: "workers", die: 1 }).label);
  await page.locator('[data-good="2"]').click();
  const sale = legal(restored, { kind: "sell", good: 2, die: 1 });
  expect(await saved(page)).toEqual(applyAction(restored, sale));
  await expect(receipts(page, "score-gain")).toHaveCount(1);
  const keyboardStart = await page.evaluate(() => performance.now());
  await expectRestored(page, restored, () => page.keyboard.press("z"), sale.label);
  expect(await page.evaluate(start => performance.now() - start, keyboardStart)).toBeLessThan(MOTION.receipt);
  await expect(receipts(page)).toHaveCount(0);
});
