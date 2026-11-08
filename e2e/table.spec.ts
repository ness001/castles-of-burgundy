import { expect, test, type Page } from "@playwright/test";
import { expectRestored } from "./undo-assertions";
import { actionKey } from "../src/engine";
import type { Action, State } from "../src/types";
const KEY = "burgundy-table.state.v1";
interface HarborSetup {
  goods: number[];
  depots: number[][];
  knowledge5?: boolean;
  pendingGoods?: number[];
}
async function seedTable(page: Page, scenario = "opening", harbor?: HarborSetup) {
  await page.goto("/");
  const seeded = await page.evaluate(
    async ({ key, scenario, harbor }) => {
      // Import the actual dev engine to arrange a reproducible position, never mock the rules.
      const { createGame } = await import("/src/engine.ts");
      const { BOARD, START_CELL } = await import("/src/data.ts");
      const s = createGame(42);
      s.active = 0;
      s.order = [0, 1];
      s.turnIndex = 0;
      s.players[0].dice = [1, 2];
      s.players[0].workers = 6;
      if (scenario === "ship") {
        s.pending = harbor?.pendingGoods
          ? [{ kind: "goods", depots: harbor.pendingGoods }]
          : [{ kind: "ship" }];
        s.players[0].goods = harbor?.goods ?? [1, 1, 0, 0, 0, 0];
        const depotGoods = harbor?.depots ?? [[1, 3, 3, 4]];
        s.depots.forEach((depot, i) => { depot.goods = depotGoods[i] ?? []; });
        if (harbor?.knowledge5) {
          const cell = BOARD.find((cell) => cell.color === "knowledge")!;
          s.players[0].board[cell.id] = { id: "test-knowledge-5", color: "knowledge", knowledge: 5 };
        }
      }
      if (scenario === "sell") s.players[0].goods = [2, 1, 0, 0, 0, 0];
      if (scenario === "replacement") {
        s.players[0].storage = [
          { id: "test-a", color: "mine" },
          { id: "test-b", color: "ship" },
          { id: "test-c", color: "castle" },
        ];
      }
      if (scenario === "build" || scenario === "build-many") {
        const c = BOARD.find(
          (c) =>
            c.id !== START_CELL &&
            Math.max(
              Math.abs(c.q - BOARD[START_CELL].q),
              Math.abs(c.r - BOARD[START_CELL].r),
              Math.abs(c.q + c.r - BOARD[START_CELL].q - BOARD[START_CELL].r),
            ) === 1,
        );
        s.players[0].storage = [
          {
            id: "test-build",
            color: c.color,
            building: c.color === "building" ? "bank" : undefined,
            animal: c.color === "animal" ? "sheep" : undefined,
            count: c.color === "animal" ? 3 : undefined,
            knowledge: c.color === "knowledge" ? 8 : undefined,
          },
        ];
        s.players[0].dice = [c.die, 2];
        if (scenario === "build-many")
          s.players[0].storage.push({
            ...s.players[0].storage[0],
            id: "test-build-second",
          });
      }
      if (scenario === "finish") {
        s.phase = 4;
        s.round = 4;
        s.order = [1, 0];
        s.turnIndex = 1;
        s.players[0].dice = [null, null];
      }
      return s;
    },
    { key: KEY, scenario, harbor },
  );
  // Install the fixture before app startup; an already-running AI timer must
  // not overwrite it between this helper's import and the subsequent reload.
  await page.addInitScript(({ key, state, marker }) => {
    if (sessionStorage.getItem(marker)) return;
    localStorage.setItem(key, JSON.stringify(state));
    sessionStorage.setItem(marker, "applied");
  }, { key: KEY, state: seeded, marker: `fixture-${Date.now()}-${Math.random()}` });
  await page.reload();
  // The market panel intentionally hides the estate on mobile.
  await expect(page.locator("#board canvas")).toBeAttached();
  await expect(page.locator("#turn-controls")).toBeVisible();
  return seeded;
}
async function saved(page: Page): Promise<State> {
  return page.evaluate((key) => JSON.parse(localStorage.getItem(key)!), KEY);
}
async function expectSizedBoard(page: Page) {
  const canvas = page.locator("#board canvas");
  await expect(canvas).toBeVisible();
  await expect.poll(async () => (await canvas.boundingBox())?.width ?? 0).toBeGreaterThan(0);
  await expect.poll(async () => (await canvas.boundingBox())?.height ?? 0).toBeGreaterThan(0);
}
async function expectedAction(page: Page, match: Partial<Action>) {
  return page.evaluate(
    async ({ key, match }) => {
      const { applyAction, legalActions } = await import("/src/engine.ts");
      const state = JSON.parse(localStorage.getItem(key)!);
      const action = legalActions(state).find((action) =>
        Object.entries(match).every(([key, value]) => action[key] === value),
      );
      if (!action) throw new Error(`No legal action matching ${JSON.stringify(match)}`);
      return { action, state: applyAction(state, action) };
    },
    { key: KEY, match },
  );
}
async function expectedVoyage(page: Page, depots: number[]) {
  return page.evaluate(async ({ key, depots }) => {
    const { applyAction, legalActions } = await import("/src/engine.ts");
    const state = JSON.parse(localStorage.getItem(key)!);
    const ship = legalActions(state).find((action) =>
      action.kind === "ship" && JSON.stringify(action.depots) === JSON.stringify(depots));
    if (!ship) throw new Error(`No ship action for depots ${depots}`);
    const afterShip = applyAction(state, ship);
    const loads = legalActions(afterShip).filter((action) => action.kind === "goods");
    return {
      ship, afterShip, loads,
      afterLoad: loads.length === 1 ? applyAction(afterShip, loads[0]) : null,
    };
  }, { key: KEY, depots });
}
async function expectedHarbors(page: Page) {
  return page.evaluate(async (key) => {
    const { applyAction, legalActions } = await import("/src/engine.ts");
    const state = JSON.parse(localStorage.getItem(key)!);
    return legalActions(state).filter((action) => action.kind === "ship").map((action) => {
      const loads = legalActions(applyAction(state, action)).filter((load) => load.kind === "goods");
      const goods = action.depots!.flatMap((depot) => state.depots[depot].goods)
        .filter((good) => loads.some((load) => load.types!.includes(good)));
      return { action, goods };
    });
  }, KEY);
}
for (const cost of [1, 2, 3]) {
  test(`taking a tile animates ${cost} spent workers without shorthand badges`, async ({ page }, testInfo) => {
    await seedTable(page);
    const before = await saved(page);
    const expected = await expectedAction(page, { kind: "take", die: 0, cost });
    await expect(page.locator(".tile-cost")).toHaveCount(0);
    const tile = page.locator(`[data-source="market"][data-tile="${expected.action.tile}"]`);
    await expect(tile).toHaveAccessibleName(new RegExp(`Click to take · ${cost} worker`));
    await tile.focus();
    await expect(page.locator("#market-tooltip")).toContainText(`Click to take · ${cost} worker`);
    await tile.click();
    expect(await saved(page)).toEqual(expected.state);
    const receipt = page.locator(".worker-spend");
    await expect(receipt).toBeVisible();
    await expect(receipt.locator(".spent-worker")).toHaveCount(cost);
    await expect(receipt).toContainText(`−${cost} worker`);
    await expect(receipt).toContainText(`6 → ${6 - cost} remaining`);
    await expect(receipt.locator(".spent-worker").first()).toHaveCSS("animation-name", "worker-depart");
    await expect(page.locator('[data-resource="workers"]')).toHaveClass(/workers-spent/);
    await expect(page.locator("#feedback")).toContainText(`Used ${cost} worker`);
    if (cost === 2) {
      // Pause at the readable hold frame to capture the actual visual effect.
      await receipt.evaluate(el => el.getAnimations({ subtree: true }).forEach(animation => { animation.pause(); animation.currentTime = 250; }));
      await page.screenshot({ path: testInfo.outputPath("workers-spent.png") });
    }
    await expectRestored(page, before, () => page.locator('[data-ui="undo"]').click());
    await expect(receipt).toHaveCount(0);
    // Taking from the matching depot should never suggest workers were spent.
    const free = await expectedAction(page, { kind: "take", die: 0, cost: 0 });
    await page.locator(`[data-source="market"][data-tile="${free.action.tile}"]`).click();
    expect(await saved(page)).toEqual(free.state);
    await expect(receipt).toHaveCount(0);
  });
}

test("worker payment stays visible on phones with reduced motion and expires", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await seedTable(page);
  await page.clock.install();
  const expected = await expectedAction(page, { kind: "take", die: 0, cost: 2 });
  await page.locator(`[data-source="market"][data-tile="${expected.action.tile}"]`).click();
  const receipt = page.locator(".worker-spend");
  await expect(receipt).toBeInViewport();
  await expect(receipt.locator(".spent-worker").first()).toHaveCSS("animation-name", "none");
  await expect(receipt).toContainText("6 → 4 remaining");
  // Switching panels rerenders the UI, but must not erase payment feedback.
  await page.locator('[data-mode="take"]').click();
  await expect(receipt).toBeVisible();
  expect(await saved(page)).toEqual(expected.state);
  await page.clock.runFor(2000);
  await expect(receipt).toHaveCount(0);
  await expect(page.locator('[data-resource="workers"]')).not.toHaveClass(/workers-spent/);
  await expect(page.locator("#feedback")).toContainText("Used 2 workers");
});

test("immediate workers, turn-scoped undo, AI reply, save/resume and help", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await seedTable(page);
  await page.getByRole("button", { name: /Field guide/ }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "A field guide to your estate" }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  const before = await saved(page);
  await page.locator('#turn-controls [data-mode="workers"]').click();
  expect((await saved(page)).players[0].workers).toBe(before.players[0].workers + 2);
  expect((await saved(page)).players[0].dice).toEqual([null, 2]);
  await expect(page.locator("#feedback")).toContainText(/workers/i);
  await expectRestored(page, before, () => page.locator('[data-ui="undo"]').click());
  await page.locator('#turn-controls [data-mode="workers"]').click();
  await page.locator('#turn-controls [data-mode="workers"]').click();
  await expect(page.locator('[data-ui="undo"]')).toBeEnabled();
  const endTurn = page.locator("#turn-controls .turn-tools [data-action]").filter({ hasText: "End turn" });
  await expect(endTurn).toBeVisible();
  await endTurn.click();
  await expect(page.locator('[data-ui="undo"]:not(:disabled)')).toHaveCount(0);
  await expect
    .poll(
      async () => {
        const s = await saved(page);
        return s.active === 0 && s.round === 1;
      },
      // The arrival tie-break gives the rival the first turn of the next round too.
      { timeout: 45000 },
    )
    .toBe(true);
  await expect(page.locator('[data-ui="undo"]:not(:disabled)')).toHaveCount(0);
  expect(
    (await saved(page)).log.some((line: string) =>
      line.startsWith("The Steward:"),
    ),
  ).toBe(true);
  const resumed = await saved(page);
  await page.reload();
  await expect(page.locator("#board canvas")).toBeVisible();
  expect(await saved(page)).toEqual(resumed);
  await page.screenshot({
    path: "test-results/table-desktop.png",
    fullPage: true,
  });
  expect(errors).toEqual([]);
});

test("Take only navigates; a market tile immediately uses the selected die and can be undone", async ({ page }) => {
  await seedTable(page);
  const before = await saved(page);
  await page.locator('[data-die="1"]').click();
  await page.locator('[data-mode="take"]').click();
  expect(await saved(page)).toEqual(before);
  const tileId = await page.evaluate(async (key) => {
    const { applyAction, legalActions } = await import("/src/engine.ts");
    const state = JSON.parse(localStorage.getItem(key)!);
    const action = legalActions(state).find((action) =>
      action.kind === "take" && action.die === 1 &&
      legalActions(applyAction(state, action)).some((next) =>
        next.kind === "place" && next.tile === action.tile && next.die === 0),
    );
    if (!action) throw new Error("Seed has no tile buildable after taking");
    return action.tile!;
  }, KEY);
  const tile = page.locator(`[data-source="market"][data-tile="${tileId}"]`);
  const expected = await expectedAction(page, { kind: "take", tile: tileId, die: 1 });
  await tile.focus();
  await page.keyboard.press("Enter");
  expect(await saved(page)).toEqual(expected.state);
  const reserveTile = page.locator(`#storage [data-tile="${tileId}"]`);
  await expect(reserveTile).toBeVisible();
  await expect(reserveTile).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#announcer")).toHaveAttribute("role", "status");
  await expect(page.locator("#announcer")).toContainText(expected.action.label);
  await expect(page.locator('#feedback[role="status"], #feedback[aria-live]')).toHaveCount(0);
  await expect(page.locator("#feedback")).toContainText(expected.action.label);
  await expect(page.locator("#modal")).not.toBeVisible();
  await expect(page.locator("#choices button[data-action]").filter({ hasText: /Take .*depot/ })).toHaveCount(0);
  // The consumed market button is removed: focus must move to a live control,
  // rather than disappearing onto body or an inert/disabled element.
  await expect(page.locator("#app button:focus")).toBeVisible();
  await expect(page.locator("#app button:focus")).toBeEnabled();
  await reserveTile.click();
  await expect(reserveTile).toHaveAttribute("aria-pressed", "true");
  expect(await saved(page)).toEqual(expected.state);
  await expectRestored(page, before, () => page.locator('[data-ui="undo"]').click());
  await expect(page.locator(`#depots [data-tile="${tileId}"]`)).toBeVisible();
});

test("goods stacks sell immediately with the selected die and undo restores the yard", async ({ page }) => {
  await seedTable(page, "sell");
  const before = await saved(page);
  await page.locator('[data-die="1"]').click();
  const expected = await expectedAction(page, { kind: "sell", good: 1, die: 1 });
  await page.locator('[data-good="1"]').click();
  expect(await saved(page)).toEqual(expected.state);
  await expect(page.locator('[data-good="1"]')).toHaveCount(0);
  await expect(page.locator("#feedback")).toContainText(expected.action.label);
  await expect(page.locator("#choices button[data-action]")).toHaveCount(0);
  await expectRestored(page, before, () => page.locator('[data-ui="undo"]').click());
  await expect(page.locator('[data-good="1"]')).toBeEnabled();
});

test("phone Sell goods opens legal choices with worker costs and commits the selected stack", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await seedTable(page, "sell");
  await expect(page.locator(".goods-section")).not.toBeVisible();
  await page.locator('[data-die="1"]').click();
  const before = await saved(page);
  const expected = await expectedAction(page, { kind: "sell", good: 1, die: 1 });
  expect(expected.action.cost).toBe(1);
  await page.locator('#turn-controls [data-mode="sell"]').click();
  const modal = page.locator("#modal");
  await expect(modal).toBeVisible();
  await expect(modal.getByRole("heading", { name: "Sell a goods type" })).toBeVisible();
  await expect(modal.locator("button[data-action]")).toHaveCount(2);
  expect(await saved(page)).toEqual(before);
  const choice = modal.locator("button[data-action]").filter({ hasText: expected.action.label });
  await expect(choice).toContainText("Die 2");
  await expect(choice.locator(".action-cost")).toHaveText("1 worker");
  await choice.click();
  await expect(modal).not.toBeVisible();
  const sold = await saved(page);
  expect(sold).toEqual(expected.state);
  expect(sold.players[0].dice).toEqual([1, null]);
  expect(sold.players[0].workers).toBe(before.players[0].workers - 1);
  expect(sold.players[0].goods).toEqual([0, 1, 0, 0, 0, 0]);
  expect(sold.players[0].score).toBe(before.players[0].score + 4);
  expect(sold.players[0].silver).toBe(before.players[0].silver + 1);
  await expect(page.locator("#feedback")).toBeVisible();
  await expect(page.locator("#feedback")).toContainText(expected.action.label);
  await expect(page.locator("#feedback")).toContainText(/1 worker/);
  await expect(page.locator('[data-ui="undo"]')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test("full reserve cancellation preserves state before explicit replacement", async ({
  page,
}) => {
  await seedTable(page, "replacement");
  const before = await saved(page);
  const tile = page.locator('[data-source="market"].action-target').first();
  const tileId = (await tile.getAttribute("data-tile"))!;
  const expected = await expectedAction(page, { kind: "take", tile: tileId, die: 0, discard: "test-b" });
  await tile.click();
  const modal = page.locator("#modal");
  await expect(modal).toBeVisible();
  await expect(modal.locator("button[data-action]")).toHaveCount(3);
  expect(await saved(page)).toEqual(before);
  await page.keyboard.press("Escape");
  await expect(modal).not.toBeVisible();
  expect(await saved(page)).toEqual(before);
  await expect(tile).toBeFocused();
  await tile.click();
  await expect(modal).toBeVisible();
  await modal.locator("button[data-action]").filter({ hasText: "replace Ship" }).click();
  await expect(modal).not.toBeVisible();
  expect(await saved(page)).toEqual(expected.state);
  expect((await saved(page)).players[0].storage).toHaveLength(3);
  await expect(page.locator("#feedback")).toContainText(/replace/i);
  await expectRestored(page, before, () => page.locator('[data-ui="undo"]').click());
});

test("ship and goods dialogs can be cancelled, reopened and resumed after reload", async ({ page }, testInfo) => {
  await seedTable(page, "ship");
  const before = await saved(page);
  const voyage = await expectedVoyage(page, [0]);
  expect(voyage.loads.map((load) => load.types)).toEqual([[1, 3], [1, 4]]);
  const modal = page.locator("#modal");
  await expect(modal).toBeVisible();
  await expect(modal).toHaveClass(/harbor-dialog/);
  await page.keyboard.press("Escape");
  await expect(modal).not.toBeVisible();
  expect(await saved(page)).toEqual(before);
  await page.locator('[data-ui="resume-bonus"]').click();
  await modal.getByRole("button", { name: /^Collect goods from depot 1\./ }).click();
  await expect(modal).toBeVisible();
  await expect(modal).toHaveClass(/harbor-dialog/);
  await expect(modal.locator(".harbor-grid button.harbor-card[data-action]")).toHaveCount(2);
  await expect(modal.getByRole("button", { name: /^Load goods 1, 3\./ })).toBeVisible();
  const pendingGoods = await saved(page);
  expect(pendingGoods).toEqual(voyage.afterShip);
  expect(pendingGoods.players[0].goods).toEqual(before.players[0].goods);
  await page.keyboard.press("Escape");
  await expect(modal).not.toBeVisible();
  expect(await saved(page)).toEqual(pendingGoods);
  await page.locator('[data-ui="resume-bonus"]').click();
  await modal.locator('[data-ui="close"]').first().click();
  await expect(modal).not.toBeVisible();
  expect(await saved(page)).toEqual(pendingGoods);
  await page.locator('[data-ui="resume-bonus"]').click();
  await expect(modal).toBeVisible();
  await page.reload();
  await expect(modal).toBeVisible();
  expect(await saved(page)).toEqual(pendingGoods);
  const load = await expectedAction(page, { kind: "goods", label: "Load goods 1, 3" });
  const choice = modal.getByRole("button", { name: /^Load goods 1, 3\./ });
  await expect(choice.locator(".cargo-name")).toHaveText(["Silk", "Ceramics"]);
  await expect(choice.locator(".cargo-count")).toHaveText(["×1", "×2"]);
  await modal.screenshot({ path: testInfo.outputPath("harbor-cargo-choices.png") });
  await choice.click();
  await expect(modal).not.toBeVisible();
  const s = await saved(page);
  expect(s).toEqual(load.state);
  expect(s.pending).toEqual([]);
  expect(s.players[0].goods).toEqual([2, 1, 2, 0, 0, 0]);
  expect(s.depots[0].goods).toEqual([4]);
});

test("one-choice harbor loads immediately in the same undo transaction", async ({ page }) => {
  await seedTable(page, "ship", {
    goods: [1, 1, 0, 0, 0, 0], depots: [[1, 3, 3]],
  });
  const before = await saved(page);
  const voyage = await expectedVoyage(page, [0]);
  expect(voyage.loads).toHaveLength(1);
  const modal = page.locator("#modal");
  const harbor = modal.getByRole("button", { name: /^Collect goods from depot 1\./ });
  await expect(harbor).toHaveClass(/harbor-card/);
  await harbor.focus();
  await page.keyboard.press("Enter");
  await expect(modal).not.toBeVisible();
  expect(await saved(page)).toEqual(voyage.afterLoad);
  expect((await saved(page)).pending).toEqual([]);
  expect((await saved(page)).players[0].goods).toEqual([2, 1, 2, 0, 0, 0]);
  await expectRestored(page, before, () => page.locator('[data-ui="undo"]').click(), voyage.ship.label);
  // Undo restores the pending bonus; the toolbar reopens its chooser.
  await expect(page.locator('[data-ui="undo"]')).toBeDisabled();
  await page.locator('[data-ui="resume-bonus"]').click();
  await expect(modal).toBeVisible();
  await expect(harbor).toBeEnabled();
  await modal.locator('[data-ui="close"]').first().click();
});

test("reloading existing one-choice goods pending never loads cargo without a click", async ({ page }) => {
  const before = await seedTable(page, "ship", {
    goods: [1, 1, 0, 0, 0, 0], depots: [[1, 3, 3]], pendingGoods: [0],
  });
  const modal = page.locator("#modal");
  const choice = modal.getByRole("button", { name: /^Load goods 1, 3\./ });
  await expect(choice).toBeVisible();
  await expect(modal.locator("button.harbor-card[data-action]")).toHaveCount(1);
  expect(await saved(page)).toEqual(before);
  await modal.locator('[data-ui="close"]').first().click();
  await page.locator('[data-ui="resume-bonus"]').click();
  await expect(choice).toBeVisible();
  expect(await saved(page)).toEqual(before);
  await page.reload();
  await expect(choice).toBeVisible();
  expect(await saved(page)).toEqual(before);
  const expected = await expectedAction(page, { kind: "goods", label: "Load goods 1, 3" });
  await choice.click();
  await expect(modal).not.toBeVisible();
  expect(await saved(page)).toEqual(expected.state);
  await expectRestored(page, before, () => page.locator('[data-ui="undo"]').click());
});

test("productive harbor cards omit empty and no-capacity depots", async ({ page }) => {
  await seedTable(page, "ship", {
    goods: [1, 1, 1, 0, 0, 0], depots: [[1, 1, 4], [], [4, 5], [2, 6], [], [6]],
  });
  const before = await saved(page);
  const options = await expectedHarbors(page);
  const productive = options.filter((option) => option.goods.length);
  expect(productive.map((option) => option.action.depots)).toEqual([[0], [3]]);
  const modal = page.locator("#modal");
  await expect(modal.locator(".harbor-grid button.harbor-card[data-action]")).toHaveCount(2);
  await expect(modal.locator("[data-action]")).toHaveCount(2);
  await expect(modal.getByRole("button", { name: /Continue without cargo/ })).toHaveCount(0);
  for (const option of productive) {
    const card = modal.getByRole("button", { name: new RegExp(`^${option.action.label}\\.`) });
    await expect(card).toBeEnabled();
    await expect(card.locator(".cargo-number")).toHaveText([...new Set(option.goods)].map(String));
    await expect(card.locator(".cargo-count")).toHaveText([`×${option.goods.length}`]);
  }
  const quiet = modal.locator(".quiet-harbors");
  await expect(quiet).toBeVisible();
  await expect(quiet.locator("button, a, [data-action], [role=button], [tabindex]")).toHaveCount(0);
  for (const option of options.filter((option) => !option.goods.length)) {
    await expect(quiet).toContainText(`Harbor ${option.action.depots![0] + 1}`);
    await expect(modal.getByRole("button", { name: new RegExp(`^${option.action.label}\\.`) })).toHaveCount(0);
  }
  expect(await saved(page)).toEqual(before);
});

for (const scenario of ["empty", "no-capacity"] as const) {
  test(`all-${scenario} harbors offer one explicit fallback and preserve cargo`, async ({ page }) => {
    await seedTable(page, "ship", {
      goods: [2, 1, 3, 0, 0, 0],
      depots: scenario === "empty" ? [] : [[4, 4], [5], [6], [4, 5], [], [6, 6]],
    });
    const before = await saved(page);
    const voyage = await expectedVoyage(page, [0]);
    expect(voyage.loads).toHaveLength(1);
    expect(voyage.loads[0].types).toEqual([]);
    const modal = page.locator("#modal");
    await expect(modal.locator("button.harbor-card[data-action]")).toHaveCount(0);
    await expect(modal.locator("[data-action]")).toHaveCount(1);
    const fallback = modal.getByRole("button", { name: /^Continue without cargo/ });
    await expect(fallback).toBeVisible();
    expect(await saved(page)).toEqual(before);
    await fallback.click();
    await expect(modal).not.toBeVisible();
    const after = await saved(page);
    expect(after).toEqual(voyage.afterLoad);
    expect(after.pending).toEqual([]);
    expect(after.players[0].goods).toEqual(before.players[0].goods);
    expect(after.depots).toEqual(before.depots);
    await expect(page.locator('#turn-controls [data-mode="workers"]')).toBeEnabled();
    await expectRestored(page, before, () => page.locator('[data-ui="undo"]').click(), voyage.ship.label);
    await page.locator('[data-ui="resume-bonus"]').click();
    await expect(fallback).toBeVisible();
  });
}

for (const depots of [[0, 1], [5, 0]]) {
  test(`knowledge 5 harbor pair ${depots.map((depot) => depot + 1).join(" + ")} loads only fitting cargo`, async ({ page }) => {
    await seedTable(page, "ship", {
      goods: [1, 1, 1, 0, 0, 0],
      depots: [[1, 4, 4], [1, 1, 5], [], [], [2, 6], [6, 6]],
      knowledge5: true,
    });
    const before = await saved(page);
    const options = await expectedHarbors(page);
    expect(options).toHaveLength(12);
    const productive = options.filter((option) => option.goods.length);
    const modal = page.locator("#modal");
    await expect(modal.locator(".harbor-grid button.harbor-card[data-action]")).toHaveCount(productive.length);
    await expect(modal.locator("[data-action]")).toHaveCount(productive.length);
    for (const option of options) {
      const card = modal.getByRole("button", { name: new RegExp(`^${option.action.label}\\.`) });
      await expect(card).toHaveCount(option.goods.length ? 1 : 0);
      if (option.goods.length) {
        const types = [...new Set(option.goods)].sort((a, b) => a - b);
        await expect(card.locator(".cargo-number")).toHaveText(types.map(String));
        await expect(card.locator(".cargo-count")).toHaveText(types.map((type) =>
          `×${option.goods.filter((good) => good === type).length}`));
      } else {
        await expect(modal.locator(".quiet-harbors")).toContainText(`Harbor ${option.action.depots!.map((depot) => depot + 1).join(" + ")}`);
      }
    }
    const voyage = await expectedVoyage(page, depots);
    expect(voyage.loads).toHaveLength(1);
    expect(voyage.loads[0].types).toEqual([1]);
    await modal.getByRole("button", { name: new RegExp(`^${voyage.ship.label}\\.`) }).click();
    await expect(modal).not.toBeVisible();
    expect(await saved(page)).toEqual(voyage.afterLoad);
    expect((await saved(page)).players[0].goods[0]).toBe(depots[0] === 0 ? 4 : 2);
    await expectRestored(page, before, () => page.locator('[data-ui="undo"]').click(), voyage.ship.label);
  });
}

for (const width of [1440, 390]) {
  test(`harbor scene and named cargo icons fit the ${width}px viewport`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
    const names = ["Silk", "Spices", "Ceramics", "Dyes", "Copperware", "Wool"];
    await seedTable(page, "ship", {
      goods: [0, 0, 0, 0, 0, 0],
      depots: names.map((_, i) => [i + 1, i + 1]),
    });
    const before = await saved(page);
    const modal = page.locator("#modal");
    await expect(modal).toHaveClass(/harbor-dialog/);
    await expect(modal.locator(".harbor-scene")).toBeVisible();
    await expect(modal.locator(".harbor-scene svg, .harbor-scene img")).toBeVisible();
    await expect(modal.locator(".harbor-grid button.harbor-card[data-action]")).toHaveCount(6);
    for (const [i, name] of names.entries()) {
      const card = modal.getByRole("button", { name: new RegExp(`^Collect goods from depot ${i + 1}\\.`) });
      await card.scrollIntoViewIfNeeded();
      const cargo = card.locator(".cargo-item");
      await expect(cargo).toHaveCount(1);
      await expect(cargo.locator(".cargo-name")).toHaveText(name);
      await expect(cargo.locator(".cargo-number")).toHaveText(String(i + 1));
      await expect(cargo.locator(".cargo-count")).toHaveText("×2");
      await expect(cargo.locator("svg, img")).toBeVisible();
      const bounds = (await card.boundingBox())!;
      expect(bounds.x).toBeGreaterThanOrEqual(0);
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(width + 1);
      expect(bounds.height).toBeGreaterThanOrEqual(44);
    }
    expect(await modal.evaluate((dialog) => dialog.scrollWidth <= dialog.clientWidth)).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(await saved(page)).toEqual(before);
    await modal.evaluate((dialog) => { dialog.scrollTop = 0; });
    await page.screenshot({ path: testInfo.outputPath(`harbor-${width}.png`), fullPage: true });
  });
}

test("builds through visible controls and displays final scoring", async ({
  page,
}) => {
  await seedTable(page, "build");
  const before = await saved(page);
  await page.locator('[data-source="storage"]').first().click();
  expect(await saved(page)).toEqual(before);
  await expect(page.locator('[data-source="storage"]')).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#choices .choice-hint")).toHaveText("Highlighted spaces: die 1 · no workers. Choose a hex, or use Build in All legal choices for keyboard placement.");
  await expect(page.locator('#choices .placement-options, #choices [data-ui="clear"]')).toHaveCount(0);
  await page.locator('[data-mode="take"]').click();
  await page.locator('[data-mode="place"]').click();
  expect(await saved(page)).toEqual(before);
  await expect(page.locator('[data-source="storage"]')).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#choices .choice-hint")).toBeVisible();
  const point = await page.evaluate(async (key) => {
    const { BOARD } = await import("/src/data.ts");
    const { legalActions } = await import("/src/engine.ts");
    const s = JSON.parse(localStorage.getItem(key)!);
    const action = legalActions(s).find(
      (a) => a.kind === "place" && a.die === 0,
    );
    const raw = BOARD.map((c) => ({
      id: c.id,
      x: Math.sqrt(3) * (c.q + c.r / 2),
      y: 1.5 * c.r,
    }));
    const xs = raw.map((c) => c.x),
      ys = raw.map((c) => c.y),
      minX = Math.min(...xs),
      maxX = Math.max(...xs),
      minY = Math.min(...ys),
      maxY = Math.max(...ys);
    const radius = Math.min(
      60,
      720 / (maxX - minX + Math.sqrt(3)),
      640 / (maxY - minY + 2),
    );
    const c = raw.find((c) => c.id === action.cell)!;
    return {
      x: (380 + (c.x - (minX + maxX) / 2) * radius) / 760,
      y: (332 + (c.y - (minY + maxY) / 2) * radius) / 664,
    };
  }, KEY);
  const canvas = page.locator("#board canvas");
  const rect = (await canvas.boundingBox())!;
  await canvas.click({
    position: { x: point.x * rect.width, y: point.y * rect.height },
  });
  expect((await saved(page)).players[0].board.filter(Boolean)).toHaveLength(2);
  await seedTable(page, "finish");
  await page.locator("#turn-controls .turn-tools .end-turn").click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.locator(".result-player")).toHaveCount(2);
  expect((await saved(page)).status).toBe("finished");
  await page.screenshot({
    path: "test-results/table-results.png",
    fullPage: true,
  });
});

test("Build asks for a reserve tile when several can be placed", async ({ page }, testInfo) => {
  await seedTable(page, "build-many");
  const before = await saved(page);
  await page.locator('[data-mode="place"]').click();
  expect(await saved(page)).toEqual(before);
  await expect(page.locator('[data-source="storage"][aria-pressed="true"]')).toHaveCount(0);
  await expect(page.locator("#turn-controls")).toContainText(/reserve|choose.*tile|select.*tile/i);
  await expect(page.locator("#choices button[data-action]")).toHaveCount(0);
  await page.locator('[data-source="storage"][data-tile="test-build-second"]').click();
  expect(await saved(page)).toEqual(before);
  await expect(page.locator('[data-tile="test-build-second"][data-source="storage"]')).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#choices .choice-hint")).toHaveText("Highlighted spaces: die 1 · no workers. Choose a hex, or use Build in All legal choices for keyboard placement.");
  await expect(page.locator('#choices .placement-options, #choices [data-ui="clear"]')).toHaveCount(0);
  await expect(page.locator("#choices")).not.toContainText(/Placement list|Cancel selection/);
  await page.locator("#choices").screenshot({ path: testInfo.outputPath("tile-details.png") });

  // The existing legal choices list remains the keyboard-accessible build path.
  const expected = await expectedAction(page, { kind: "place", tile: "test-build-second", die: 0 });
  await page.locator("#legal-details summary").click();
  const placement = page.locator(`#legal-actions button[data-action-key=${JSON.stringify(actionKey(expected.action))}]`);
  await placement.focus();
  await page.keyboard.press("Enter");
  expect(await saved(page)).toEqual(expected.state);
});

test("phone layout, keyboard choice and new-game cancellation", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await seedTable(page, "build");
  const before = await saved(page);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await expect(page.locator(".mobile-navigation")).toBeVisible();
  await page.locator('[data-mode="take"]').click();
  await expect(page.locator("#app")).toHaveAttribute("data-panel", "market");
  await expect(page.locator(".market-column")).toBeVisible();
  await expect(page.locator(".estate-column")).not.toBeVisible();
  await expect(page.locator("#storage")).toBeVisible();
  const reserve = (await page.locator("#storage").boundingBox())!;
  const market = (await page.locator(".market-column").boundingBox())!;
  expect(reserve.y + reserve.height).toBeLessThanOrEqual(market.y + 1);
  await page.locator('[data-source="storage"]').click();
  await expect(page.locator("#app")).toHaveAttribute("data-panel", "estate");
  await expectSizedBoard(page);
  await expect(page.locator("#board canvas")).toBeInViewport({ ratio: 0.9 });
  await expect.poll(async () => {
    const canvas = (await page.locator("#board canvas").boundingBox())!;
    const toolbar = (await page.locator("#turn-controls").boundingBox())!;
    return canvas.y >= toolbar.y + toolbar.height;
  }).toBe(true);
  expect(await page.locator(".map-sheet").evaluate((map) => map.nextElementSibling?.id)).toBe("choices");
  await expect(page.locator(".market-column")).not.toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(await saved(page)).toEqual(before);
  await page.locator('.mobile-navigation [data-panel="market"]').click();
  await expect(page.locator("#app")).toHaveAttribute("data-panel", "market");
  await page.locator('[data-mode="place"]').click();
  await expectSizedBoard(page);
  await expect(page.locator("#board canvas")).toBeInViewport({ ratio: 0.9 });
  expect(await saved(page)).toEqual(before);
  await page.locator('[data-mode="take"]').click();
  await page.getByRole("button", { name: /New game/ }).click();
  await expect(
    page.getByRole("heading", { name: "Start a new estate?" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Keep this table" }).click();
  expect(await saved(page)).toEqual(before);
  await page.locator("#legal-details summary").click();
  const first = page
    .locator("#legal-actions button")
    .filter({ hasText: "Take 2 workers" })
    .first();
  await first.focus();
  await page.keyboard.press("Enter");
  expect((await saved(page)).players[0].workers).toBe(8);
  await expect(page.locator("#legal-actions button:focus")).toBeEnabled();
  await page.locator("#legal-details summary").click();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({
    path: "test-results/table-phone.png",
    fullPage: true,
  });
});

for (const width of [1440, 1000]) {
  test(`turn controls ${width > 1000 ? "stay sticky" : "scroll with the page"} within the ${width}px viewport`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 });
    await seedTable(page);
    if (width === 1000) {
      // Reproduce Phaser's delayed sizing while the initial estate tab is hidden.
      // This is intentional scenario timing, not a wait for the later assertion.
      await expect(page.locator(".estate-column")).not.toBeVisible();
      await page.waitForTimeout(650);
    }
    const toolbar = page.locator("#turn-controls");
    expect(await toolbar.evaluate((el) => Boolean(el.compareDocumentPosition(document.querySelector("main")!) & Node.DOCUMENT_POSITION_FOLLOWING))).toBe(true);
    await expect(toolbar).toHaveCSS("position", width > 1000 ? "sticky" : "relative");
    await page.locator('[data-mode="workers"]').click();
    await expect(page.locator("#feedback")).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const bounds = (await toolbar.boundingBox())!;
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(width + 1);
    // The compact desktop table can fit entirely; ensure the pinning check can scroll.
    if (width > 1000) await page.locator("#app").evaluate(app => app.style.paddingBottom = "100vh");
    await page.evaluate(() => window.scrollTo(0, 500));
    const scrolled = (await toolbar.boundingBox())!;
    if (width > 1000) {
      expect(scrolled.y).toBeGreaterThanOrEqual(0);
      expect(scrolled.y).toBeLessThan(40);
    } else {
      expect(scrolled.y + scrolled.height).toBeLessThan(0);
    }
    if (width === 1000) {
      await page.locator('.mobile-navigation [data-panel="estate"]').click();
      await expectSizedBoard(page);
      await page.locator('.mobile-navigation [data-panel="market"]').click();
      await expect(page.locator("#board canvas")).not.toBeVisible();
      await page.locator('.mobile-navigation [data-panel="estate"]').click();
      await expectSizedBoard(page);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    }
  });
}

test("a complete 25-round browser match reaches final results through real controls", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  // Motion has dedicated coverage; this match keeps real input without replaying every animation frame.
  await page.emulateMedia({ reducedMotion: "reduce" });
  await seedTable(page);
  await page.clock.install();
  const phases = new Set<number>();
  const rounds = new Set<string>();
  let count = 0;
  while (count++ < 450) {
    const s = await saved(page);
    phases.add(s.phase);
    rounds.add(`${s.phase}:${s.round}`);
    if (s.status === "finished") break;
    if (s.active === 1) {
      await page.clock.fastForward(5000);
      continue;
    }
    const key = await page.evaluate(async (saveKey) => {
      const { chooseAction } = await import("/src/ai.ts");
      const { actionKey } = await import("/src/engine.ts");
      return actionKey(
        chooseAction(JSON.parse(localStorage.getItem(saveKey)!)),
      );
    }, KEY);
    // Bonus modals can be dismissed without consuming the choice; the complete
    // legal-action list must remain an accessible alternative to the canvas.
    if (await page.locator("#modal").isVisible()) await page.keyboard.press("Escape");
    if ((await page.locator("#legal-details").getAttribute("open")) === null)
      await page.locator("#legal-details summary").click();
    await page
      .locator(`#legal-actions button[data-action-key=${JSON.stringify(key)}]`)
      .click();
    if (count === 30) {
      await page.reload();
      await expect(page.locator("#board canvas")).toBeVisible();
    }
  }
  const result = await saved(page);
  expect(result.status).toBe("finished");
  expect(phases.size).toBe(5);
  expect(rounds.size).toBe(25);
  await expect(page.locator(".result-player")).toHaveCount(2);
  expect(result.players.every((p: { score: number }) => p.score > 30)).toBe(
    true,
  );
  await page.screenshot({
    path: "test-results/full-match-results.png",
    fullPage: true,
  });
  expect(errors).toEqual([]);
});

test("public information, immediate bonus purchases and resumed computer turns stay usable", async ({ page }) => {
  const external: string[] = [];
  page.on("request", (request) => {
    if (/^https?:/.test(request.url()) && !request.url().startsWith("http://127.0.0.1:5178"))
      external.push(request.url());
  });
  await seedTable(page);
  await expect(page.locator(".public-dice")).toHaveCount(2);
  await expect(page.locator('#phase-goods [role="img"]')).toHaveCount(4);
  await expect(page.locator("[data-color-progress]")).toHaveCount(6);
  await page.locator('[data-view="1"]').click();
  await expect(page.locator("#estate-title")).toHaveText("The Steward’s estate");
  await page.locator('[data-view="0"]').click();
  await page.evaluate(async (key) => {
    const { canPlace } = await import("/src/engine.ts");
    const { BOARD } = await import("/src/data.ts");
    const s = JSON.parse(localStorage.getItem(key)!);
    s.pending = [{ kind: "place" }];
    s.players[0].silver = 2;
    s.players[0].storage = [];
    // Keep an actual buildable supply tile so buying creates a real bonus move.
    const source = [...s.black, ...s.depots.flatMap((depot) => depot.tiles)]
      .find((tile) => BOARD.some((cell) => canPlace(s.players[0], tile, cell.id)));
    if (!source) throw new Error("Seed has no buildable tile");
    s.black = s.black.filter((tile) => tile.id !== source.id);
    for (const depot of s.depots) depot.tiles = depot.tiles.filter((tile) => tile.id !== source.id);
    s.black.unshift(source);
    localStorage.setItem(key, JSON.stringify(s));
  }, KEY);
  await page.reload();
  const before = await saved(page);
  const blackTile = page.locator('[data-source="black"].action-target').first();
  const tileId = (await blackTile.getAttribute("data-tile"))!;
  const expected = await expectedAction(page, { kind: "buy", tile: tileId });
  await blackTile.click();
  const purchased = await saved(page);
  expect(purchased).toEqual(expected.state);
  expect(purchased.pending).toEqual([{ kind: "place" }]);
  expect(purchased.players[0].dice).toEqual(before.players[0].dice);
  expect(purchased.players[0].silver).toBe(0);
  await expect(page.locator(`#storage [data-tile="${tileId}"]`)).toBeVisible();
  await expect(page.locator("#feedback")).toContainText(expected.action.label);
  await expect(page.locator('[data-mode="place"]')).toBeEnabled();
  await expectRestored(page, before, () => page.locator('[data-ui="undo"]').click());
  await page.evaluate((key) => {
    const s = JSON.parse(localStorage.getItem(key)!);
    s.pending = [];
    s.active = 1;
    s.turnIndex = 1;
    s.order = [0, 1];
    s.players[1].dice = [3, 4];
    localStorage.setItem(key, JSON.stringify(s));
  }, KEY);
  await page.reload();
  await expect.poll(async () => {
    const s = await saved(page);
    return s.round > 0 && s.active === 0;
  }, { timeout: 45000 }).toBe(true);
  expect(external).toEqual([]);
});
