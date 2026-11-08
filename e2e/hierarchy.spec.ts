import { expect, test, type Page } from "@playwright/test";
import { expectRestored } from "./undo-assertions";
import { BOARD } from "../src/data";
import { actionKey, applyAction, canPlace, createGame, legalActions } from "../src/engine";
import type { State } from "../src/types";

const SAVE_KEY = "burgundy-table.state.v1";

function position(scenario: "normal" | "costs" | "empty" | "knowledge" | "region" = "costs"): State {
  const state = createGame(42);
  state.active = 0;
  state.order = [0, 1];
  state.turnIndex = 0;
  if (scenario === "normal") return state;
  const player = state.players[0];
  player.dice = [1, 2];
  player.workers = 1;
  player.silver = 4;
  if (scenario === "region") {
    state.phase = 2;
    const first = BOARD.find(cell => cell.color === "mine")!;
    const region = BOARD.filter(cell => cell.region === first.region);
    for (const cell of region.slice(0, -1)) player.board[cell.id] = state.pools.mine.pop()!;
    player.storage = [state.pools.mine.pop()!];
    player.dice = [region.at(-1)!.die, 2];
  } else {
    // A genuine supply tile that can be built beside the starting castle.
    const supply = Object.values(state.pools).find(tiles =>
      tiles.some(tile => BOARD.some(cell => canPlace(player, tile, cell.id))),
    )!;
    const index = supply.findIndex(tile => BOARD.some(cell => canPlace(player, tile, cell.id)));
    player.storage = supply.splice(index, 1);
  }
  if (scenario === "empty") {
    for (const tile of state.depots[5].tiles) state.pools[tile.color].push(tile);
    state.depots[5].tiles = [];
  }
  if (scenario === "knowledge") {
    // Move the real numbered tile, rather than inventing a benefit-bearing mock.
    const sources = [...Object.values(state.pools), ...state.depots.map(depot => depot.tiles), state.black];
    const source = sources.find(tiles => tiles.some(tile => tile.knowledge === 19))!;
    const depot = state.depots[1].tiles;
    const from = source.findIndex(tile => tile.knowledge === 19);
    const to = depot.findIndex(tile => tile.color === "knowledge");
    [depot[to], source[from]] = [source[from], depot[to]];
  }
  return state;
}

async function openTable(page: Page, state = position()): Promise<State> {
  // Seed before the app boots, so an AI turn cannot race the fixture setup.
  await page.addInitScript(({ key, state }) => {
    localStorage.setItem(key, JSON.stringify(state));
  }, { key: SAVE_KEY, state });
  await page.goto("/");
  await expect(page.locator("#turn-controls")).toBeVisible();
  await expect(page.locator("#board canvas")).toBeAttached();
  await page.evaluate(() => document.fonts.ready);
  return state;
}

async function saved(page: Page): Promise<State> {
  return page.evaluate(key => JSON.parse(localStorage.getItem(key)!), SAVE_KEY);
}

async function expectBoardReady(page: Page) {
  // The central starting castle responds only once Phaser has loaded its art.
  const canvas = page.locator("#board canvas");
  await expect(canvas).toBeVisible();
  await expect.poll(async () => {
    // Re-enter the map if the first hover happened before scene creation.
    await page.mouse.move(0, 0);
    await canvas.hover();
    return page.locator("#board-tooltip").textContent();
  }).toContain("Take a free action");
}

async function expectTakeTargets(page: Page, state: State, die: number) {
  const legal = legalActions(state).filter(action => action.kind === "take" && action.die === die);
  const expectedIds = [...new Set(legal.map(action => action.tile!))].sort();
  expect(expectedIds.length).toBeGreaterThan(0);
  expect(expectedIds.length).toBeLessThan(state.depots.flatMap(depot => depot.tiles).length);
  const targets = page.locator('#depots [data-source="market"].action-target');
  await expect.poll(() => targets.evaluateAll(tiles => tiles.map(tile => tile.getAttribute("data-tile")!).sort()))
    .toEqual(expectedIds);
  for (const action of legal) {
    const tile = page.locator(`#depots [data-tile="${action.tile}"]`);
    const cost = page.locator('#depots .depot').nth(action.depot!).locator('.depot-cost');
    await expect(tile).toBeEnabled();
    await expect(cost).toBeVisible();
    await expect(cost).toHaveText(action.cost
      ? `${action.cost} worker${action.cost === 1 ? "" : "s"}`
      : "No workers");
  }
  await expect(page.locator('#depots .depot:not(:has(.action-target)) .depot-cost')).toHaveCount(0);
  await expect(page.locator("#depots")).not.toContainText(/\b\d+w\b/i);
}

test("Take targets and readable costs follow the selected die; Build leaves buying independent", async ({ page }) => {
  const state = await openTable(page);
  await page.locator('[data-mode="take"]').click();
  await expectTakeTargets(page, state, 0);
  const adjusted = legalActions(state).find(action => action.kind === "take" && action.die === 0 && action.depot === 1)!;
  expect(adjusted.cost).toBe(1);
  const cost = page.locator('#depots .depot').nth(adjusted.depot!).locator('.depot-cost');
  await expect(cost).toHaveText("1 worker");
  await page.locator('[data-die="1"]').click();
  await expectTakeTargets(page, state, 1);
  await expect(cost).toHaveText("No workers");
  expect(await saved(page)).toEqual(state);

  await page.locator('[data-mode="place"]').click();
  await expect(page.locator("#depots .action-target, #depots .depot-cost")).toHaveCount(0);
  const buy = legalActions(state).find(action => action.kind === "buy")!;
  const purchase = page.locator(`#black-market [data-tile="${buy.tile}"]`);
  await expect(purchase).toBeEnabled();
  await expect(purchase).toHaveClass(/action-target/);
  await expect(purchase.locator(".target-cost")).toHaveCount(0);
  await expect(page.locator("#black-market .black-heading .resource-amount")).toHaveText("2 silver");
  await purchase.click();
  expect(await saved(page)).toEqual(applyAction(state, buy));
  expect((await saved(page)).players[0].dice).toEqual(state.players[0].dice);
});

test("empty depots are visibly distinct from stocked actionable depots", async ({ page }) => {
  await openTable(page, position("empty"));
  const empty = page.locator('.depot[aria-label="Depot 6"]');
  const stocked = page.locator(".depot:has(.action-target)").first();
  await expect(empty).toHaveClass(/\bempty\b/);
  await expect(empty).toHaveAccessibleName("Depot 6");
  await expect(empty.locator('.empty-tile')).toHaveCount(2);
  await expect(empty.locator('.empty-tile-outline').first()).toBeVisible();
  await expect(empty.locator(".action-target")).toHaveCount(0);
  await expect(stocked).not.toHaveClass(/\bempty\b/);
  await expect(stocked.locator('.empty-tile')).toHaveCount(0);
  await expect(stocked.locator('.market-card .tile-art').first()).toBeVisible();
});

test("turn controls group die, action, target, legal choices and Undo", async ({ page }) => {
  const state = await openTable(page);
  const steps = page.locator("#turn-controls .turn-step");
  await expect(steps).toHaveCount(3);
  await expect(steps.locator(".step-label")).toHaveText(["1 Choose die", "2 Choose action", "3 Choose target"]);
  await expect(steps.nth(0)).toHaveClass(/die-step/);
  await expect(steps.nth(1)).toHaveClass(/action-step/);
  await expect(steps.nth(2)).toHaveClass(/target-step/);
  await expect(page.locator('.masthead [data-ui="undo"]')).toHaveCount(0);
  await expect(page.locator('#turn-controls #legal-details')).toHaveCount(1);
  const undo = page.locator('#turn-controls [data-ui="undo"]');
  await expect(undo).toBeVisible();
  await expect(undo).toBeDisabled();
  await page.locator('[data-mode="workers"]').click();
  await expect(undo).toBeEnabled();
  await expectRestored(page, state, () => undo.click());
});

test("Knowledge 19 keeps its short label and explains Church scoring on hover", async ({ page }) => {
  const state = await openTable(page, position("knowledge"));
  const knowledge = state.depots.flatMap(depot => depot.tiles).find(tile => tile.knowledge === 19)!;
  const tile = page.locator(`#depots [data-tile="${knowledge.id}"]`);
  await expect(tile.locator(".tile-name")).toHaveText("Knowledge 19");
  await expect(tile.locator(".tile-benefit")).toHaveCount(0);
  await expect(tile).toHaveAccessibleName(/Knowledge 19/);
  await tile.hover();
  await expect(page.locator('#market-tooltip[role="tooltip"]')).toBeVisible();
  await expect(page.locator("#market-tooltip .tile-benefit")).toHaveText("End: +4 VP per Church");
  const take = legalActions(state).find(action => action.kind === "take" && action.die === 0 && action.tile === knowledge.id)!;
  await tile.click();
  expect(await saved(page)).toEqual(applyAction(state, take));
  await expect(page.locator("#storage .reserve-benefit")).toHaveText("End: +4 VP per Church");
});

test("region rewards link to a rendered board group and explain full-region scoring", async ({ page }, testInfo) => {
  const state = await openTable(page, position("region"));
  const first = BOARD.find(cell => cell.color === "mine")!;
  const cells = BOARD.filter(cell => cell.region === first.region);
  const base = cells.length * (cells.length + 1) / 2;
  const timing = 10 - 2 * state.phase;
  const reward = page.locator('#region-insight button[data-region-cell]').filter({ hasText: "Mines" });
  const detail = page.locator("#estate-scoring .region-panel #region-detail");
  await expect(detail).toBeHidden();
  await expect(detail).toBeEmpty();
  await expect(reward).toContainText(`1 left · +${base + timing} VP`);
  const representative = Number(await reward.getAttribute("data-region-cell"));
  expect(BOARD[representative].region).toBe(first.region);
  const canvas = page.locator("#board canvas");
  const captureBoard = async () => {
    const bounds = (await canvas.boundingBox())!;
    const x = Math.ceil(bounds.x), y = Math.ceil(bounds.y);
    // Fractional element screenshots include antialiased paper/shadow pixels
    // outside the canvas. Compare every fully enclosed board pixel exactly.
    return page.screenshot({ clip: { x, y, width: Math.floor(bounds.x + bounds.width) - x, height: Math.floor(bounds.y + bounds.height) - y } });
  };
  await page.evaluate(() => scrollTo(0, 0));
  await expectBoardReady(page);
  const unselected = await captureBoard();
  await reward.click();
  await expect(reward).toHaveAttribute("aria-pressed", "true");
  await expect(detail).toBeVisible();
  expect(await saved(page)).toEqual(state);
  await expect(page.locator("#region-detail")).toContainText(`${cells.length - 1}/${cells.length} filled`);
  await expect(page.locator("#region-detail")).toContainText(`Fill 1 remaining hex for +${base + timing} VP`);
  await expect(page.locator("#region-detail")).toContainText(`${base} for size + ${timing} this phase`);
  await page.evaluate(() => scrollTo(0, 0));
  // The contextual tooltip overlays the canvas now; compare the same hover state.
  await expectBoardReady(page);
  // Inspect actual canvas output, not just the button's pressed state.
  await expect.poll(async () => (await captureBoard()).equals(unselected)).toBe(false);
  await testInfo.attach("selected-region-board", { body: await captureBoard(), contentType: "image/png" });
  await reward.click();
  await expect(reward).toHaveAttribute("aria-pressed", "false");
  await expect(detail).toBeHidden();
  await expect(detail).toBeEmpty();
  await page.evaluate(() => scrollTo(0, 0));
  await expectBoardReady(page);
  await expect.poll(async () => (await captureBoard()).equals(unselected)).toBe(true);
  expect(await saved(page)).toEqual(state);

  // Inspecting another owner clears both the details and the rendered focus.
  await reward.click();
  await page.locator('[data-view="1"]').click();
  await expect(detail).toBeHidden();
  await expect(detail).toBeEmpty();
  await expect(page.locator('#region-insight [aria-pressed="true"]')).toHaveCount(0);
  await page.locator('[data-view="0"]').click();
  await expect(reward).toHaveAttribute("aria-pressed", "false");
  await expect(detail).toBeHidden();
  await expect(detail).toBeEmpty();
  await page.evaluate(() => scrollTo(0, 0));
  await expectBoardReady(page);
  await expect.poll(async () => (await captureBoard()).equals(unselected)).toBe(true);
  expect(await saved(page)).toEqual(state);

  await reward.click();
  await page.locator('#storage [data-source="storage"]').click();
  const finish = legalActions(state).find(action => action.kind === "place" && action.die === 0 && action.cell === cells.at(-1)!.id)!;
  expect(finish).toBeDefined();
  await page.locator("#legal-details summary").click();
  await page.locator(`#legal-actions button[data-action-key=${JSON.stringify(actionKey(finish))}]`).click();
  expect(await saved(page)).toEqual(applyAction(state, finish));
  await expect(page.locator("#region-detail")).toContainText("Completed — points already awarded.");
  await expect(page.locator("#region-detail")).toContainText(`${cells.length}/${cells.length} filled`);
  await expect(page.locator('#region-insight button[data-region-cell]').filter({ hasText: "Mines" })).toHaveCount(0);
});

for (const viewport of [{ width: 1440, height: 900 }, { width: 1280, height: 720 }]) {
  for (const scenario of ["normal", "costs"] as const) {
    test(`${viewport.width}×${viewport.height} ${scenario}: actual canvas and entire black market fit at scroll zero`, async ({ page }, testInfo) => {
      await page.setViewportSize(viewport);
      await openTable(page, position(scenario));
      await expect(page.locator(".market-column > #black-market")).toHaveCount(1);
      await expect(page.locator("#depots .depot-cost").first()).toBeVisible();
      await expect.poll(() => page.evaluate(() => scrollY)).toBe(0);
      for (const selector of ["#board canvas", "#black-market"]) {
        const element = page.locator(selector);
        await expect(element).toBeVisible();
        await expect(element).toBeInViewport({ ratio: 1 });
        const rect = (await element.boundingBox())!;
        expect(rect.width).toBeGreaterThan(0);
        expect(rect.height).toBeGreaterThan(0);
        expect(rect.x).toBeGreaterThanOrEqual(0);
        expect(rect.y).toBeGreaterThanOrEqual(0);
        expect(rect.x + rect.width).toBeLessThanOrEqual(viewport.width + 1);
        expect(rect.y + rect.height).toBeLessThanOrEqual(viewport.height + 1);
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      expect(await page.evaluate(() => scrollY)).toBe(0);
      await expectBoardReady(page);
      expect(await page.evaluate(() => scrollY)).toBe(0);
      await testInfo.attach("first-screen-hierarchy", { body: await page.screenshot(), contentType: "image/png" });
    });
  }
}

test("390px mobile keeps market purchases and the estate reachable without horizontal overflow", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const state = await openTable(page);
  await expect(page.locator(".market-column > #black-market")).toHaveCount(1);
  await page.locator("#black-market").scrollIntoViewIfNeeded();
  await expect(page.locator("#black-market")).toBeInViewport({ ratio: 1 });
  const buy = legalActions(state).find(action => action.kind === "buy")!;
  await page.locator(`#black-market [data-tile="${buy.tile}"]`).click();
  expect(await saved(page)).toEqual(applyAction(state, buy));
  await page.locator('.mobile-navigation [data-panel="estate"]').click();
  await expect(page.locator("#board canvas")).toBeVisible();
  await expect(page.locator("#board canvas")).toBeInViewport({ ratio: 0.9 });
  await expectBoardReady(page);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await testInfo.attach("mobile-estate", { body: await page.screenshot(), contentType: "image/png" });
  await page.locator('.mobile-navigation [data-panel="market"]').click();
  await expect(page.locator("#depots")).toBeVisible();
});

test("the visible worker quote still produces the payment animation and exact engine deduction", async ({ page }) => {
  const state = await openTable(page);
  await page.clock.install();
  const take = legalActions(state).find(action => action.kind === "take" && action.die === 0 && action.cost === 1)!;
  const tile = page.locator(`#depots [data-tile="${take.tile}"]`);
  await expect(page.locator('#depots .depot').nth(take.depot!).locator('.depot-cost')).toHaveText("1 worker");
  await tile.click();
  expect(await saved(page)).toEqual(applyAction(state, take));
  const receipt = page.locator(".worker-spend");
  await expect(receipt).toBeVisible();
  await expect(receipt).toContainText("−1 worker");
  await expect(receipt).toContainText("1 → 0 remaining");
  await expect(receipt.locator(".spent-worker")).toHaveCount(1);
  await expect(receipt.locator(".spent-worker")).toHaveCSS("animation-name", "worker-depart");
  await expect(page.locator('[data-resource="workers"]')).toHaveClass(/workers-spent/);
  await expect(page.locator("#feedback")).toContainText("Used 1 worker");
  await page.clock.runFor(2000);
  await expect(receipt).toHaveCount(0);
  await expectRestored(page, state, () => page.locator('#turn-controls [data-ui="undo"]').click());
});
