import { expect, test } from "@playwright/test";
import { createGame, legalActions } from "../src/engine";
import { boardFor } from "../src/boards";

const KEY = "burgundy-table.state.v1";
test.use({ reducedMotion: "reduce" });

for (const phase of [0, 4]) {
  test(`phase ${phase + 1} rules live in help, not the status bar`, async ({ page }) => {
    const state = createGame(42);
    state.active = 0;
    state.order = [0, 1];
    state.turnIndex = 0;
    state.phase = phase;
    state.round = 4;
    await page.addInitScript(({ state, key }) => localStorage.setItem(key, JSON.stringify(state)), { state, key: KEY });
    await page.goto("/");
    await expect(page.locator("#season .round-label")).toContainText("5");
    await expect(page.locator(".phase-boundary")).toHaveCount(0);
    await expect(page.locator("#game-status")).not.toContainText("After everyone finishes");
    await page.locator('[data-ui="help"]').click();
    await expect(page.locator("#guide-table")).toContainText("mines pay income");
    await expect(page.locator("#guide-table")).toContainText("uncollected depot goods remain");
    await expect(page.locator("#guide-table")).toContainText("final mine income is followed by final scoring");
    await page.keyboard.press("Escape");
    expect(await page.evaluate(key => JSON.parse(localStorage.getItem(key)!), KEY)).toEqual(state);
  });
}

for (const playerCount of [2, 4] as const) {
  test(`${playerCount} players keep estate header and board geometry stable when inspecting opponents`, async ({ page }) => {
    const state = createGame(42, { playerCount });
    state.active = 0;
    state.order = state.players.map((_, index) => index);
    state.turnIndex = 0;
    await page.addInitScript(({ state, key }) => localStorage.setItem(key, JSON.stringify(state)), { state, key: KEY });
    await page.goto("/");
    await page.evaluate(() => document.fonts.ready);
    await expect(page.locator("#board canvas")).toBeAttached();
    const geometry = () => page.evaluate(async () => {
      await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      const sheet = document.querySelector(".map-sheet")!.getBoundingClientRect();
      const heading = document.querySelector(".estate-heading")!.getBoundingClientRect();
      const board = document.querySelector("#board canvas")!.getBoundingClientRect();
      // On phones the changing inventory above the map can move the whole sheet.
      return { headingHeight: heading.height, width: board.width, height: board.height,
        x: board.x - sheet.x, y: board.y - sheet.y,
        desktopX: innerWidth > 1000 ? board.x : 0, desktopY: innerWidth > 1000 ? board.y : 0 };
    });
    for (const [width, height] of [[1440, 900], [1280, 720], [820, 844], [390, 844]]) {
      await page.setViewportSize({ width, height });
      if (width <= 1000) await page.locator('.mobile-navigation [data-panel="estate"]').click();
      await page.locator('[data-view="0"]').click();
      await expect(page.locator("#estate-view-status")).toBeHidden();
      const own = await geometry();
      for (const who of [...state.players.slice(1).map((_, index) => index + 1), 0]) {
        await page.locator(`[data-view="${who}"]`).click();
        if (who) await expect(page.locator("#estate-view-status")).toBeVisible();
        else await expect(page.locator("#estate-view-status")).toBeHidden();
        await expect.poll(geometry).toEqual(own);
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    }
    expect(await page.evaluate(key => JSON.parse(localStorage.getItem(key)!), KEY)).toEqual(state);
  });
}

test("one ivory player tray and 2×2 actions retain inspection across screen sizes", async ({ page }, info) => {
  const state = createGame(42);
  state.active = 0;
  state.order = [0, 1];
  state.turnIndex = 0;
  state.players[0].dice = [1, 2];
  const cell = boardFor(state.players[0]).find(cell => cell.color === "knowledge")!;
  state.players[0].board[cell.id] = { id: "reference-advantage", color: "knowledge", knowledge: 1 };
  state.players[0].storage = [state.pools.ship.pop()!];
  state.players[0].workers = 6;
  state.players[0].silver = 2;
  state.players[0].goods = [2, 0, 0, 0, 0, 0];
  expect(legalActions(state).some(action => action.kind === "place")).toBe(true);
  await page.addInitScript(({ state, key }) => localStorage.setItem(key, JSON.stringify(state)), { state, key: KEY });
  await page.goto("/");
  await page.evaluate(() => document.fonts.ready);
  for (const width of [1728, 820, 390]) {
    await page.setViewportSize({ width, height: width <= 1000 ? 844 : 768 });
    await expect(page.locator(".map-sheet > .estate-heading")).toHaveCount(1);
    await expect(page.locator("#estate .estate-switch [data-view]")).toHaveCount(2);
    await expect(page.locator("#turn-controls .estate-heading, #estate .estate-tools")).toHaveCount(0);
    await expect(page.locator("#table-details .estate-tools > details")).toHaveCount(3);
    await expect(page.locator(".table-footer .estate-heading, .table-footer .estate-tools")).toHaveCount(0);
    if (width > 1000) {
      await expect(page.locator("#estate-title")).toHaveCSS("color", "rgb(48, 70, 61)");
      await expect(page.locator("#market-title")).toHaveCSS("color", "rgb(242, 236, 217)");
      const heading = (await page.locator(".estate-heading").boundingBox())!;
      const canvas = (await page.locator("#board canvas").boundingBox())!;
      expect(canvas.height).toBeGreaterThan(420);
      expect(canvas.y).toBeGreaterThanOrEqual(heading.y + heading.height);
      const target = (await page.locator(".target-step").boundingBox())!;
      const undo = (await page.locator(".turn-undo").boundingBox())!;
      expect(undo.x - (target.x + target.width)).toBeLessThanOrEqual(16);
    }
    const card = page.locator(".player-column > .reserve-panel");
    await expect(card).toHaveCSS("color", "rgb(48, 70, 61)");
    await expect(card).toHaveCSS("background-image", /250, 247, 238/);
    await expect(page.locator("#black-market")).toHaveCSS("color", "rgb(48, 70, 61)");
    await expect(page.locator("#estate-title")).toHaveCSS("font-family", /Libre Caslon Display/);
    await expect(page.locator('.die-button.chosen .die-face')).toHaveCSS("outline-style", "solid");
    await expect(card.locator(":scope > #storage, :scope > #resources, :scope > #goods, :scope > #estate-knowledge")).toHaveCount(4);
    const cardBox = (await card.boundingBox())!;
    for (const selector of ["#storage", "#resources", "#goods", "#estate-knowledge"]) {
      const section = card.locator(selector);
      await expect(section).toBeVisible();
      const box = (await section.boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(cardBox.x);
      expect(box.x + box.width).toBeLessThanOrEqual(cardBox.x + cardBox.width);
      expect(box.y + box.height).toBeLessThanOrEqual(cardBox.y + cardBox.height);
      await expect(section).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    }
    const buttons = await page.locator(".quick-actions button").all();
    expect(buttons).toHaveLength(4);
    const boxes = await Promise.all(buttons.map(button => button.boundingBox()));
    expect(boxes[0]!.y).toBeCloseTo(boxes[1]!.y, 0);
    expect(boxes[2]!.y).toBeCloseTo(boxes[3]!.y, 0);
    expect(boxes[2]!.y).toBeGreaterThanOrEqual(boxes[0]!.y + boxes[0]!.height);
    expect(boxes[0]!.x).toBeCloseTo(boxes[2]!.x, 0);
    expect(boxes.every(box => box!.height >= 44)).toBe(true);
    await expect(page.locator("#black-market .purchase-status")).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
  await page.setViewportSize({ width: 1728, height: 768 });
  await expect(page.locator(".reserve-panel > #goods + #estate-knowledge")).toBeVisible();
  await expect(page.locator("#estate-details #estate-knowledge")).toHaveCount(0);
  await expect(page.locator("#advantages-title")).toHaveText("Your advantages");
  await page.locator('#estate-knowledge [data-knowledge="1"]').click();
  await expect(page.getByRole("dialog", { name: "An acquired advantage" })).toBeVisible();
  await page.keyboard.press("Escape");
  await page.locator('#storage [data-tile]').click();
  await expect(page.locator("#choices")).not.toBeEmpty();
  await page.locator('[data-view="1"]').click();
  await expect(page.locator("#estate-title")).toHaveText("The Steward’s estate");
  await expect(page.locator("#estate-view-status")).toBeVisible();
  await expect(page.locator("#estate-view-status")).toHaveText("Read-only · opponent estate");
  await expect(page.locator("#estate-inspection")).toHaveCount(0);
  await expect(page.locator("#choices")).toBeEmpty();
  await page.locator('[data-view="0"]').click();
  await expect(page.locator("#estate-title")).toHaveText("Your estate");
  await expect(page.locator("#estate-view-status")).toBeHidden();
  await expect(page.locator("#choices")).not.toBeEmpty();
  const mapBounds = (await page.locator("#board canvas").boundingBox())!;
  const detailsToggle = page.locator("#table-details > summary");
  await detailsToggle.click();
  for (const summary of await page.locator("#table-details .estate-tools > details > summary").all()) {
    await summary.click();
    const content = page.locator("#table-details .estate-tools > details[open] > :not(summary)");
    await expect(content).toBeVisible();
    await expect(page.locator("#table-details > .estate-tools")).toBeInViewport({ ratio: 1 });
    expect(await page.locator("#board canvas").boundingBox()).toEqual(mapBounds);
    expect(await page.evaluate(() => document.documentElement.scrollHeight <= innerHeight)).toBe(true);
    await page.keyboard.press("Escape");
    await expect(summary).toBeFocused();
    await expect(page.locator(".estate-tools > details[open]")).toHaveCount(0);
  }
  await page.keyboard.press("Escape");
  await expect(page.locator("#table-details")).not.toHaveAttribute("open");
  await expect(detailsToggle).toBeFocused();
  expect(await page.evaluate(key => JSON.parse(localStorage.getItem(key)!), KEY)).toEqual(state);
  await page.mouse.move(0, 0);
  await page.screenshot({ path: info.outputPath("single-player-card.png") });

  // Relocating controls and resizing the canvas must preserve hex hit targets.
  const placement = legalActions(state).find(action => action.kind === "place" && action.die === 0)!;
  const cells = boardFor(state.players[0]).map(cell => ({
    id: cell.id, x: Math.sqrt(3) * (cell.q + cell.r / 2), y: 1.5 * cell.r,
  }));
  const minX = Math.min(...cells.map(cell => cell.x)), maxX = Math.max(...cells.map(cell => cell.x));
  const minY = Math.min(...cells.map(cell => cell.y)), maxY = Math.max(...cells.map(cell => cell.y));
  const radius = Math.min(60, 720 / (maxX - minX + Math.sqrt(3)), 640 / (maxY - minY + 2));
  const target = cells.find(cell => cell.id === placement.cell)!;
  await page.locator("#board canvas").click({ position: {
    x: (380 + (target.x - (minX + maxX) / 2) * radius) / 760 * mapBounds.width,
    y: (332 + (target.y - (minY + maxY) / 2) * radius) / 664 * mapBounds.height,
  } });
  await expect.poll(() => page.evaluate(({ key, cell }) => JSON.parse(localStorage.getItem(key)!).players[0].board[cell]?.id,
    { key: KEY, cell: placement.cell! })).toBe(state.players[0].storage[0].id);
});
