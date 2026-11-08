import { expect, test, type Page } from "@playwright/test";
import { applyAction, createGame, legalActions } from "../src/engine";
import { finalScoringSteps } from "../src/motion-events";
import { MOTION } from "../src/motion-timing";
import type { State } from "../src/types";

const SAVE_KEY = "burgundy-table.state.v1";
function lastTurn(): State {
  const state = createGame(42);
  state.phase = state.round = 4;
  state.order = [1, 0];
  state.turnIndex = 1;
  state.active = 0;
  state.players.forEach((player, index) => {
    player.dice = [null, null];
    player.score = 30 + index * 3;
    player.goods = [2, 0, 0, 0, 0, 0];
    player.sold = [2, 1, 0, 0, 0, 0];
    player.silver = 1;
    player.workers = 1;
    player.board[24] = { id: `mine-${index}`, color: "mine" };
    player.board[12] = { id: `knowledge-${index}`, color: "knowledge", knowledge: index === 0 ? 15 : 25 };
  });
  state.players[0].board[13] = { id: "mining", color: "knowledge", knowledge: 2 };
  state.players[0].board[14] = { id: "zero", color: "knowledge", knowledge: 26 };
  state.players[0].storage = [{ id: "reserved", color: "knowledge", knowledge: 24 }];
  return state;
}
async function open(page: Page, state: State) {
  await page.addInitScript(({ state, key }) => {
    if (!sessionStorage.getItem("seeded-final")) {
      localStorage.setItem(key, JSON.stringify(state));
      sessionStorage.setItem("seeded-final", "true");
    }
  }, { state, key: SAVE_KEY });
  await page.goto("/");
  await expect(page.locator("#board canvas")).toBeAttached();
  await page.evaluate(() => document.fonts.ready);
}
async function end(page: Page, state: State) {
  const next = applyAction(state, legalActions(state).find(action => action.kind === "end")!);
  await page.locator("#turn-controls .turn-tools .end-turn").click();
  expect(await page.evaluate(key => JSON.parse(localStorage.getItem(key)!), SAVE_KEY)).toEqual(next);
  return next;
}

test("final bonuses count up by resource and knowledge before revealing the winner", async ({ page }) => {
  const before = lastTurn();
  await open(page, before);
  await page.clock.install();
  await page.clock.pauseAt(new Date(Date.now() + 1000));
  const next = await end(page, before);
  const results = page.locator("[data-final-scoring]");
  await expect(results).toHaveAttribute("data-counting", "true");
  await expect(results.locator("[data-final-total]")).toHaveText(["30", "33"]);
  await expect(results.locator(".winner-crown")).not.toBeVisible();
  await expect(results.locator('[data-score-item="knowledge-15"] dd')).toHaveText("2 × 3 = +6");
  await expect(results.locator('[data-score-item="knowledge-26"] dd')).toHaveText("0 × 2 = +0");
  await expect(results.locator('[data-score-item="knowledge-24"]')).toHaveCount(0);
  await page.clock.runFor(MOTION.receipt + 100 + MOTION.finalCount + 100);
  await expect(results.locator("[data-final-total]")).toHaveText(["32", "35"]);
  await expect(results.locator(".final-scoring-status")).toContainText("Unsold goods");
  await page.clock.runFor(MOTION.finalStep * 3);
  await expect(results.locator(".final-scoring-status")).toContainText("Knowledge 15");
  await expect(results.locator("[data-final-total]")).toHaveText(["41", "37"]);
  await expect(results.locator('[data-score-item="knowledge"] .result-score-value')).toHaveText(["+6", "+0"]);
  await page.clock.runFor(MOTION.finalStep * 3);
  await expect(results).not.toHaveAttribute("data-counting", "true");
  await expect(results.locator("[data-final-total]")).toHaveText(next.players.map(player => String(player.score)));
  await expect(results.locator(".winner-crown")).toBeVisible();
  await expect(results.locator(".final-scoring-status")).toContainText("complete");
  expect(await page.evaluate(key => JSON.parse(localStorage.getItem(key)!), SAVE_KEY)).toEqual(next);
});

for (const interrupt of ["skip", "close", "reduced", "resize", "replace"] as const) {
  test(`${interrupt} settles final totals and cancels the remaining sequence`, async ({ page }) => {
    const before = lastTurn();
    await open(page, before);
    const next = await end(page, before);
    await expect(page.locator("[data-counting]")).toHaveCount(1);
    if (interrupt === "skip") await page.getByRole("button", { name: "Show final totals" }).click();
    if (interrupt === "close") {
      await page.keyboard.press("Escape");
      await page.getByRole("button", { name: "View final scores" }).click();
    }
    if (interrupt === "reduced") await page.emulateMedia({ reducedMotion: "reduce" });
    if (interrupt === "resize") await page.setViewportSize({ width: 390, height: 844 });
    if (interrupt === "replace") {
      await page.getByRole("button", { name: "Begin another legacy" }).click();
      await expect(page.locator("#modal-title")).toHaveText("Start a new estate?");
      await page.getByRole("button", { name: "Keep this table" }).click();
      await page.getByRole("button", { name: "View final scores" }).click();
    }
    await expect(page.locator("[data-counting]")).toHaveCount(0);
    await expect(page.locator("[data-final-total]")).toHaveText(next.players.map(player => String(player.score)));
    await expect(page.locator(".winner-crown")).toBeVisible();
    await page.reload();
    await expect(page.locator("[data-counting]")).toHaveCount(0);
    await expect(page.locator("[data-final-total]")).toHaveText(next.players.map(player => String(player.score)));
    expect(await page.evaluate(key => JSON.parse(localStorage.getItem(key)!), SAVE_KEY)).toEqual(next);
  });
}

test("reduced motion shows the complete knowledge calculation without a count-up", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  const before = lastTurn();
  await open(page, before);
  const next = await end(page, before);
  await expect(page.locator("[data-counting]")).toHaveCount(0);
  await expect(page.locator("[data-final-total]")).toHaveText(next.players.map(player => String(player.score)));
  await expect(page.locator('[data-score-item="knowledge-15"] dd')).toHaveText("2 × 3 = +6");
  await expect(page.getByRole("button", { name: "Show final totals" })).toBeHidden();
  for (const width of [844, 390, 320]) {
    await page.setViewportSize({ width, height: 740 });
    expect(await page.locator(".result-player, .final-knowledge > div").evaluateAll(nodes => nodes.every(node => node.scrollWidth <= node.clientWidth + 1))).toBe(true);
  }
  expect(finalScoringSteps(next)).toHaveLength(6);
});
