import { expect, test, type Page } from "@playwright/test";
import { chooseAction } from "../src/ai";
import { BOARDS, boardFor } from "../src/boards";
import { actionKey, applyAction, canPlace, createGame, legalActions, turnOrder } from "../src/engine";
import type { GameOptions, State } from "../src/types";

const SAVE_KEY = "burgundy-table.state.v1";
const NAMES = ["You", "The Steward", "The Merchant", "The Castellan"];

function humanFirst(options: GameOptions = {}): State {
  const state = createGame(42, options);
  state.order = state.players.map((_, who) => who);
  state.active = 0;
  state.turnIndex = 0;
  state.players.forEach((player, who) => {
    player.arrival = state.players.length - who;
    player.workers = who + 1;
  });
  return state;
}

async function openTable(page: Page, state: State) {
  // Apply once, BEFORE boot: neither an old AI timer nor a reload may replace
  // the position whose persistence the test is exercising.
  await page.addInitScript(({ key, state }) => {
    const marker = "rulebook-fixture-applied";
    if (sessionStorage.getItem(marker)) return;
    localStorage.setItem(key, JSON.stringify(state));
    sessionStorage.setItem(marker, "yes");
  }, { key: SAVE_KEY, state });
  await page.goto("/");
  await expect(page.locator("#turn-controls")).toBeVisible();
  await expect(page.locator("#board canvas")).toBeAttached();
  await page.evaluate(() => document.fonts.ready);
}

async function saved(page: Page): Promise<State> {
  return page.evaluate(key => JSON.parse(localStorage.getItem(key)!), SAVE_KEY);
}

async function expectSizedMap(page: Page) {
  const canvas = page.locator("#board canvas");
  await expect(canvas).toBeVisible();
  await expect.poll(async () => (await canvas.boundingBox())?.width ?? 0).toBeGreaterThan(0);
  await expect.poll(async () => (await canvas.boundingBox())?.height ?? 0).toBeGreaterThan(0);
  expect(await canvas.evaluate((node: HTMLCanvasElement) => node.width > 0 && node.height > 0)).toBe(true);
}

async function expectNoOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const outside = await page.locator(".estate-switch button, .estate-setup button, #start-castle, #board canvas")
    .evaluateAll(nodes => nodes.filter(node => {
      const rect = node.getBoundingClientRect();
      return rect.width > 0 && (rect.left < -1 || rect.right > innerWidth + 1);
    }).map(node => node.textContent || node.tagName));
  expect(outside).toEqual([]);
}

async function hoverHex(page: Page, boardId: number, cellId: number, text: string) {
  // Use the same normalized hex geometry as the existing table canvas test;
  // the tooltip proves Phaser rendered an interactive map, not just a canvas.
  const raw = BOARDS[boardId].map(cell => ({
    id: cell.id, x: Math.sqrt(3) * (cell.q + cell.r / 2), y: 1.5 * cell.r,
  }));
  const minX = Math.min(...raw.map(cell => cell.x)), maxX = Math.max(...raw.map(cell => cell.x));
  const minY = Math.min(...raw.map(cell => cell.y)), maxY = Math.max(...raw.map(cell => cell.y));
  const radius = Math.min(60, 720 / (maxX - minX + Math.sqrt(3)), 640 / (maxY - minY + 2));
  const cell = raw.find(cell => cell.id === cellId)!;
  const canvas = page.locator("#board canvas");
  await expectSizedMap(page);
  await expect.poll(async () => {
    const rect = (await canvas.boundingBox())!;
    await page.mouse.move(0, 0);
    await canvas.hover({ position: {
      x: (380 + (cell.x - (minX + maxX) / 2) * radius) / 760 * rect.width,
      y: (332 + (cell.y - (minY + maxY) / 2) * radius) / 664 * rect.height,
    } });
    return page.locator("#board-tooltip").textContent();
  }).toContain(text);
}

async function captureMap(page: Page) {
  const canvas = page.locator("#board canvas");
  await page.evaluate(() => scrollTo(0, 0));
  await canvas.hover({ position: { x: 1, y: 1 } });
  await expect(page.locator("#board-tooltip")).toBeEmpty();
  await page.mouse.move(0, 0);
  const bounds = (await canvas.boundingBox())!;
  const x = Math.ceil(bounds.x), y = Math.ceil(bounds.y);
  // Compare only actual map pixels, excluding the tooltip, changed side-button
  // text and fractional paper/shadow edges (as the existing hierarchy test does).
  return page.screenshot({ clip: {
    x, y, width: Math.floor(bounds.x + bounds.width) - x, height: Math.floor(bounds.y + bounds.height) - y,
  } });
}

for (const playerCount of [3, 4] as const) {
  for (const estates of ["beginner", "open", "secret"] as const) {
    test(`New game selects ${playerCount} players / ${estates}; cancel preserves the current table`, async ({ page }) => {
      const before = humanFirst();
      await openTable(page, before);
      await page.getByRole("button", { name: /New game/ }).click();
      const modal = page.getByRole("dialog");
      await expect(modal.getByLabel("Players", { exact: true })).toHaveValue("2");
      await expect(modal.getByLabel("Estate setup", { exact: true })).toHaveValue("beginner");
      await modal.locator("#player-count").selectOption(String(playerCount));
      await modal.locator("#estate-mode").selectOption(estates);
      expect(await saved(page)).toEqual(before);
      await modal.getByRole("button", { name: "Keep this table" }).click();
      await expect(modal).not.toBeVisible();
      expect(await saved(page)).toEqual(before);
      await expect(page.locator("#scoreboard .score-name strong")).toHaveText(NAMES.slice(0, 2));

      await page.getByRole("button", { name: /New game/ }).click();
      await modal.locator("#player-count").selectOption(String(playerCount));
      await modal.locator("#estate-mode").selectOption(estates);
      await modal.locator('[data-ui="confirm-new"]').click();
      await expect(modal).not.toBeVisible();
      // Random first-player order is legitimate. Let any earlier AI choices
      // finish; the human's turn then provides a stable, observable checkpoint.
      await expect.poll(async () => (await saved(page)).active, { timeout: 20_000 }).toBe(0);
      const started = await saved(page);
      expect(started.players).toHaveLength(playerCount);
      await expect(page.locator("#scoreboard .score-name strong")).toHaveText(NAMES.slice(0, playerCount));
      await expect(page.locator(".estate-switch button")).toHaveText(NAMES.slice(0, playerCount));
      if (estates === "beginner") {
        expect(started.status).toBe("playing");
        expect(started.setup).toBeUndefined();
        expect(started.players.every(player => (player.boardId ?? 1) === 1)).toBe(true);
        await expect(page.locator('#turn-controls [data-mode="workers"]')).toBeEnabled();
      } else {
        expect(started.status).toBe("setup");
        expect(started.setup?.mode).toBe(estates);
        await expect(page.locator("#turn-controls .estate-setup")).toBeVisible();
        await expect(page.locator("#depots .market-card, .black-tiles .market-card")).toHaveCount(0);
      }
    });
  }
}

test("hex and die references are hidden in hover hints and saved history without changing the save", async ({ page }) => {
  const before = humanFirst();
  before.log.push(
    "You settle estate #1, castle hex 19.",
    "You: Place Mine · hex 25 (4) (−1 workers).",
    "The Steward: Place Ship · hex 8 (2).",
  );
  await openTable(page, before);
  await expect(page.locator("#journal")).toContainText("You settle estate #1.");
  await expect(page.locator("#journal")).toContainText("You: Place Mine (−1 workers).");
  await expect(page.locator("#journal")).toContainText("The Steward: Place Ship.");
  await expect(page.locator("#journal")).not.toContainText(/\bhex \d+/i);

  const player = before.players[0];
  const empty = boardFor(player).find(cell => !player.board[cell.id])!;
  await hoverHex(page, player.boardId ?? 1, empty.id, "left →");
  await expect(page.locator("#board-tooltip")).not.toContainText(/\b(?:hex|die) \d+/i);
  expect(await saved(page)).toEqual(before);
});

for (const { width, height } of [
  { width: 1440, height: 900 },
  { width: 1280, height: 720 },
  { width: 390, height: 844 },
  { width: 320, height: 740 },
]) {
  test(`estate setup controls stay together in the top bar at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height });
    const before = humanFirst({ playerCount: 3, estates: "open" });
    await openTable(page, before);
    const toolbar = page.locator("#turn-controls");
    const setup = toolbar.locator(".estate-setup");
    await expect(setup).toBeVisible();
    await expect(page.locator(".estate-setup")).toHaveCount(1);
    await expect(page.locator("#choices .estate-setup, .player-column .estate-setup")).toHaveCount(0);
    const sides = before.setup!.boards[0];
    await setup.locator(`[data-setup-board="${sides[1]}"]`).focus();
    await page.keyboard.press("Enter");
    await expect(setup.locator(`[data-setup-board="${sides[1]}"]`)).toBeFocused();
    await expect(setup.locator(`[data-setup-board="${sides[1]}"]`)).toHaveAttribute("aria-pressed", "true");
    const last = legalActions(before).filter(a => a.boardId === sides[1]).at(-1)!;
    await setup.getByLabel("Starting castle", { exact: true }).selectOption(String(last.cell));
    await expect(setup.locator('[data-ui="confirm-estate"]')).toHaveText(`Confirm estate #${sides[1]}`);
    if (width <= 1000) {
      await page.locator('.mobile-navigation [data-panel="market"]').click();
      await expect(setup.locator('[data-ui="confirm-estate"]')).toBeVisible();
      await page.locator('.mobile-navigation [data-panel="estate"]').click();
      await expect(setup.locator("#start-castle")).toHaveValue(String(last.cell));
    }
    await page.evaluate(() => scrollTo(0, 0));
    const bar = (await toolbar.boundingBox())!;
    for (const control of await setup.locator("button, select").all()) {
      await expect(control).toBeVisible();
      const rect = (await control.boundingBox())!;
      expect(rect.y).toBeGreaterThanOrEqual(bar.y);
      expect(rect.y + rect.height).toBeLessThanOrEqual(bar.y + bar.height + 1);
      expect(rect.height).toBeGreaterThanOrEqual(44);
      expect(rect.x).toBeGreaterThanOrEqual(0);
      expect(rect.x + rect.width).toBeLessThanOrEqual(width);
    }
    if (width >= 1280) {
      const heading = (await toolbar.locator(".turn-guidance").boundingBox())!;
      const choices = (await setup.boundingBox())!;
      const legal = (await toolbar.locator(".target-step").boundingBox())!;
      expect(choices.x).toBeGreaterThanOrEqual(heading.x + heading.width);
      expect(choices.x + choices.width).toBeLessThanOrEqual(legal.x);
    }
    expect(bar.height).toBeLessThan(width < 1000 ? 330 : 150);
    await expectNoOverflow(page);
    expect(await saved(page)).toEqual(before);
    await page.screenshot({ path: testInfo.outputPath(`setup-bar-${width}.png`), fullPage: true });
  });
}

for (const { estates, playerCount } of [
  { estates: "open", playerCount: 3 },
  { estates: "secret", playerCount: 4 },
] as const) {
  test(`${estates} setup previews both sides and a castle, confirms without starter rewards, and survives reload`, async ({ page }, testInfo) => {
    const before = humanFirst({ playerCount, estates });
    await openTable(page, before);
    const setup = page.locator("#turn-controls .estate-setup");
    const sides = before.setup!.boards[0];
    await expect(setup.locator("[data-setup-board]")).toHaveText(sides.map(id => `Estate #${id}`));
    for (const text of [
      "Your starting castle grants no action or points.",
      estates === "secret" ? "Choices stay hidden until everyone is ready." : "Choose openly in starting turn order.",
    ]) {
      const instruction = setup.locator("p").filter({ hasText: text });
      await expect(instruction).toBeVisible();
      await expect(instruction).toHaveCSS("clip-path", "none");
      const bounds = (await instruction.boundingBox())!;
      expect(bounds.width, "Setup instructions must not be visually clipped to a 1px box").toBeGreaterThan(100);
      expect(bounds.height).toBeGreaterThan(16);
    }
    await expect(page.locator("#depots .market-card, .black-tiles .market-card")).toHaveCount(0);

    let selected = legalActions(before)[0];
    const previews: Buffer[] = [];
    for (const boardId of sides) {
      await setup.locator(`[data-setup-board="${boardId}"]`).click();
      await expect(setup.locator(`[data-setup-board="${boardId}"]`)).toHaveAttribute("aria-pressed", "true");
      const starts = legalActions(before).filter(action => action.boardId === boardId);
      await expect(setup.locator("#start-castle option")).toHaveText(starts.map((_, index) =>
        `Castle ${index + 1}`));
      selected = starts.at(-1)!;
      await setup.getByLabel("Starting castle", { exact: true }).selectOption(String(selected.cell));
      await expect(setup.locator('[data-ui="confirm-estate"]')).toHaveText(
        `Confirm estate #${boardId}`);
      await hoverHex(page, boardId, selected.cell!,
        `Estate #${boardId} · Castles · Choose this starting castle space`);
      previews.push(await captureMap(page));
      expect(await saved(page)).toEqual(before);
    }
    expect(previews[1].equals(previews[0]), "Changing board sides must change the rendered estate").toBe(false);

    // Returning to the same side/castle restores its exact map, ruling out
    // unrelated movement or an initial blank frame as the pixel difference.
    await setup.locator(`[data-setup-board="${sides[0]}"]`).click();
    const firstCastle = legalActions(before).filter(action => action.boardId === sides[0]).at(-1)!;
    await setup.locator("#start-castle").selectOption(String(firstCastle.cell));
    await expect.poll(async () => (await captureMap(page)).equals(previews[0])).toBe(true);
    await setup.locator(`[data-setup-board="${selected.boardId}"]`).click();
    await setup.locator("#start-castle").selectOption(String(selected.cell));

    if (estates === "open") {
      await page.mouse.move(0, 0);
      await page.screenshot({ path: testInfo.outputPath("setup-desktop.png"), fullPage: true });
    }
    await expectNoOverflow(page);
    let expected = applyAction(before, selected);
    while (expected.status === "setup") expected = applyAction(expected, chooseAction(expected));
    await setup.locator('[data-ui="confirm-estate"]').click();
    await expect.poll(async () => (await saved(page)).status).toBe("playing");
    expect(await saved(page)).toEqual(expected);
    expect(expected.players.map(player => player.score)).toEqual(Array(playerCount).fill(0));
    expect(expected.pending).toEqual([]);
    expect(expected.players.every(player => player.board.filter(Boolean).length === 1)).toBe(true);
    expect(expected.players.every(player => player.dice.every(die => die !== null))).toBe(true);
    expect(expected.players[0].boardId).toBe(selected.boardId);
    expect(expected.players[0].board[selected.cell!]).toEqual(before.setup!.castles[0]);
    await expect(page.locator(".estate-setup")).toHaveCount(0);
    await expect(page.locator("#turn-controls .action-count")).toHaveText("2 / 2 dice left");
    await expect(page.locator('#depots .market-card').first()).toBeAttached();

    await page.reload();
    await expect(page.locator("#turn-controls .action-count")).toHaveText("2 / 2 dice left");
    expect(await saved(page)).toEqual(expected);
    await expect(page.locator("#estate-title")).toHaveText(`Your estate · #${selected.boardId}`);
    await hoverHex(page, selected.boardId!, selected.cell!, "Take a free action");
  });
}

function fourEstates(): State {
  let state = humanFirst({ playerCount: 4, estates: "secret" });
  while (state.status === "setup") {
    const boardId = state.setup!.boards[state.active].at(-1)!;
    const choice = legalActions(state).filter(action => action.boardId === boardId).at(-1)!;
    state = applyAction(state, choice);
  }
  // Ships change the following round, not the current round's established order.
  state.players[2].ships = 2;
  return state;
}

for (const width of [1440, 390]) {
  test(`all three rival estates have their own labels and public turn order at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
    const before = fourEstates();
    before.players[0].sold = [2, 0, 1, 0, 0, 0];
    await openTable(page, before);
    if (width === 390) await page.locator('.mobile-navigation [data-panel="estate"]').click();
    if (width === 390) await expect(page.locator("#goods")).not.toBeVisible();
    const soldHistory = page.locator("#sold-goods");
    const soldSummary = soldHistory.locator("summary");
    await expect(page.locator("#scoreboard .score-name strong")).toHaveText(NAMES);
    await page.locator("#turn-order summary").click();
    const orderNames = (order: number[]) => order.map(who => before.players[who].name).join(" → ");
    expect(turnOrder(before)).not.toEqual(before.order);
    await expect(page.locator("#turn-order-content p").nth(0)).toHaveText(`This round: ${orderNames(before.order)}.`);
    await expect(page.locator("#turn-order-content p").nth(1)).toHaveText(`Next round: ${orderNames(turnOrder(before))}.`);
    await page.locator("#turn-order summary").click();

    for (let who = 1; who < 4; who++) {
      const player = before.players[who];
      const button = page.getByRole("group", { name: "Inspect estate", exact: true })
        .getByRole("button", { name: player.name, exact: true });
      await button.click();
      await expect(button).toHaveAttribute("aria-pressed", "true");
      await expect(page.locator("#estate-title")).toHaveText(`${player.name}’s estate · #${player.boardId}`);
      await expect(page.locator("#storage h3")).toHaveText(`${player.name}’s reserve`);
      await expect(page.locator('[data-color-summary="castle"] b')).toHaveText(
        `1/${boardFor(player).filter(cell => cell.color === "castle").length}`);
      await hoverHex(page, player.boardId!, player.board.findIndex(Boolean), "Take a free action");
      await expect(soldSummary).toBeVisible();
      await expect(soldSummary).toHaveText("Sold goods · 3 tiles, 2 types");
      // History remains the human's, even while inspecting a rival. Open it
      // through the real summary on phones, where the goods yard is hidden.
      if (who === 1) {
        await soldSummary.click();
        await expect(soldSummary).toBeInViewport();
      }
      await expect(soldHistory).toHaveJSProperty("open", true);
      await expect(soldHistory.locator(".sold-cargo")).toBeVisible();
      await expect(soldHistory.locator(".cargo-name")).toHaveText(["Silk", "Ceramics"]);
      await expect(soldHistory.locator(".cargo-count")).toHaveText(["×2", "×1"]);
      expect(await saved(page)).toEqual(before);
    }
    await page.locator('[data-view="0"]').click();
    await expect(page.locator("#estate-title")).toHaveText(`Your estate · #${before.players[0].boardId}`);
    await expect(page.locator("#storage h3")).toHaveText("Your reserve");
    await expect(soldSummary).toHaveText("Sold goods · 3 tiles, 2 types");
    await expect(soldHistory).toHaveJSProperty("open", true);
    const journalInk = await soldHistory.evaluate(node => getComputedStyle(node).color);
    for (const text of await soldHistory.locator(".cargo-item, .cargo-name, .fine-print").all()) {
      await expect(text).toHaveCSS("color", journalInk);
    }
    await expect(soldHistory.locator(".sold-cargo")).toHaveCSS("display", "flex");
    await expect(soldHistory.locator(".sold-cargo")).toHaveCSS("flex-wrap", "wrap");
    await expectSizedMap(page);
    if (width === 390) {
      await page.mouse.move(0, 0);
      await page.screenshot({ path: testInfo.outputPath("four-player-phone.png"), fullPage: true });
    }
    await expectNoOverflow(page);
    expect(await saved(page)).toEqual(before);
  });
}

test("four-player sales award 4 VP per tile; 7/4 color bonuses and sold-goods breakdown are inspectable", async ({ page }) => {
  const before = humanFirst({ playerCount: 4 });
  before.players[0].dice = [1, 2];
  before.players[0].goods = [2, 0, 0, 0, 0, 0];
  before.players[0].sold = [1, 0, 2, 0, 0, 0];
  await openTable(page, before);
  const action = legalActions(before).find(action => action.kind === "sell" && action.die === 0 && action.good === 1)!;
  const expected = applyAction(before, action);
  await expect(page.locator('[data-good="1"]')).toHaveAttribute("title", /8 VP/);
  await page.locator('[data-good="1"]').click();
  expect(await saved(page)).toEqual(expected);
  expect(expected.players[0].score - before.players[0].score).toBe(8);
  await expect(page.locator("#scoreboard .score-value").first()).toHaveText("8VP");
  await expect(page.locator('[data-good="1"]')).toBeDisabled();

  await page.locator("#sold-goods summary").click();
  await expect(page.locator("#sold-goods summary")).toHaveText("Sold goods · 5 tiles, 2 types");
  await expect(page.locator("#sold-goods .cargo-name")).toHaveText(["Silk", "Ceramics"]);
  await expect(page.locator("#sold-goods .cargo-count")).toHaveText(["×3", "×2"]);
  await expect(page.locator("#sold-goods .sold-cargo")).toBeVisible();
  await expect(page.locator("#color-ledger .estate-section-heading span")).toHaveText("First +7 · Second +4 VP");
  const castles = page.locator('[data-color-progress="castle"]');
  await castles.locator("summary").click();
  await expect(castles.locator("summary")).toHaveAccessibleName(/1st \+7 VP: unclaimed\. 2nd \+4 VP: unclaimed/);
  await expect(castles.locator(".color-rewards")).toBeVisible();
  await expect(castles.locator(".color-rewards")).toContainText("First +7 · available");
  await expect(castles.locator(".color-rewards")).toContainText("Second +4 · available");
  expect(await saved(page)).toEqual(expected);
  await page.reload();
  await page.locator("#sold-goods summary").click();
  await expect(page.locator("#sold-goods .cargo-count")).toHaveText(["×3", "×2"]);
  expect(await saved(page)).toEqual(expected);
});

test("a legal-list placement over the canvas commits once without a Phaser selection rerender", async ({ page }) => {
  const before = humanFirst({ playerCount: 4 });
  const player = before.players[0];
  player.dice = [1, 2];
  player.workers = 6;
  const source = Object.values(before.pools).find(tiles => tiles.some(tile =>
    boardFor(player).some(cell => canPlace(player, tile, cell.id))))!;
  const index = source.findIndex(tile => boardFor(player).some(cell => canPlace(player, tile, cell.id)));
  player.storage = source.splice(index, 1);
  await openTable(page, before);
  await hoverHex(page, 1, player.board.findIndex(Boolean), "Take a free action");
  await page.locator('#storage [data-source="storage"]').click();
  await page.locator("#legal-details summary").click();
  const action = legalActions(before).find(action => action.kind === "place" && action.die === 0)!;
  const button = page.locator(`#legal-actions button[data-action-key=${JSON.stringify(actionKey(action))}]`);
  await button.scrollIntoViewIfNeeded();
  const buttonBox = (await button.boundingBox())!;
  const canvasBox = (await page.locator("#board canvas").boundingBox())!;
  const overlap = {
    left: Math.max(buttonBox.x, canvasBox.x), right: Math.min(buttonBox.x + buttonBox.width, canvasBox.x + canvasBox.width),
    top: Math.max(buttonBox.y, canvasBox.y), bottom: Math.min(buttonBox.y + buttonBox.height, canvasBox.y + canvasBox.height),
  };
  expect(overlap.right - overlap.left, "The actual legal button must overlap the canvas").toBeGreaterThan(8);
  expect(overlap.bottom - overlap.top).toBeGreaterThan(8);
  // Hit the overlapping part, not merely an uncovered edge of the DOM button.
  await button.click({ position: {
    x: (overlap.left + overlap.right) / 2 - buttonBox.x,
    y: (overlap.top + overlap.bottom) / 2 - buttonBox.y,
  } });
  expect(await saved(page)).toEqual(applyAction(before, action));
  expect((await saved(page)).players[0].board.filter(Boolean)).toHaveLength(2);
  await expect(page.locator("#feedback")).toContainText(action.label);
});

for (const width of [1440, 390]) {
  test(`tied four-player final scoreboard awards MOST empty spaces without overflow at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
    const before = humanFirst({ playerCount: 4 });
    before.phase = 4;
    before.round = 4;
    before.order = [1, 2, 3, 0];
    before.turnIndex = 3;
    before.players.forEach(player => {
      player.dice = [null, null];
      player.goods.fill(0);
      player.silver = 0;
      player.workers = 0;
      player.score = 40;
    });
    // Corrected rule: MORE empty spaces wins. The Merchant uniquely has the
    // emptiest estate; the later track position must not override that tie-break.
    for (const who of [0, 1, 3]) {
      const player = before.players[who];
      const cell = boardFor(player).find(cell => cell.color === "building")!;
      player.board[cell.id] = before.pools.building.pop()!;
    }
    const end = legalActions(before).find(action => action.kind === "end")!;
    const expected = applyAction(before, end);
    expect(expected.players.map(player => player.score)).toEqual([40, 40, 40, 40]);
    expect(expected.winner).toBe(2);
    const winnerName = before.players[expected.winner!].name;
    await openTable(page, before);
    await page.locator("#turn-controls .turn-tools [data-action]").filter({ hasText: "End turn" }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    expect(await saved(page)).toEqual(expected);
    await expect(page.locator("#modal-title")).toHaveText(`${winnerName}’s legacy endures`);
    await expect(page.locator(".result-player h3")).toHaveText(NAMES);
    await expect(page.locator(".result-player .final-score")).toHaveText(Array(4).fill("40victory points"));
    await expect(page.locator(".result-player.winner h3")).toHaveText(winnerName);
    await expect(page.locator(".result-player .winner-crown")).toHaveCount(1);
    await expect(page.locator(".result-player.winner .winner-crown svg")).toHaveCount(1);
    await expect(page.locator(".final-score.score-leader")).toHaveCount(4);
    await expect(page.locator(".result-player dl > .score-leader")).toHaveCount(20);
    await expect(page.locator(".score-lead-label")).toHaveText(Array(20).fill("Tied best"));
    await expect(page.locator(".result-player dt svg[aria-hidden='true']")).toHaveCount(20);
    expect(await page.locator("#modal, .results-players, .result-player").evaluateAll(nodes =>
      nodes.every(node => node.scrollWidth <= node.clientWidth + 1))).toBe(true);
    await expectNoOverflow(page);
    await page.getByRole("button", { name: "Inspect the estates", exact: true }).click();
    if (width === 390) await page.locator('.mobile-navigation [data-panel="estate"]').click();
    await page.locator('[data-view="2"]').click();
    await expect(page.locator("#estate-title")).toHaveText("The Merchant’s estate");
    expect(await saved(page)).toEqual(expected);
  });
}
