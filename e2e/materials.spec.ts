import { expect, test, type Locator, type Page } from "@playwright/test";
import { BOARD, COLORS, tileName } from "../src/data";
import { canPlace, createGame, legalActions } from "../src/engine";
import { tileBenefit } from "../src/presentation";
import type { State } from "../src/types";

const SAVE_KEY = "burgundy-table.state.v1";
const COLOR_LABELS = ["Castles", "Ships", "Pastures", "Mines", "Knowledge", "Buildings"];

function position() {
  const state = createGame(42);
  state.active = 0;
  state.order = [0, 1];
  state.turnIndex = 0;
  const player = state.players[0];
  player.dice = [1, 4];
  player.workers = 1;
  player.silver = 4;

  // Relocate a real four-animal tile, returning the displaced shop tile to
  // its supply. Do not fabricate IDs, duplicate tiles, or grow a depot.
  const sources = [state.pools.animal, ...state.depots.map(depot => depot.tiles)];
  const source = sources.find(tiles => tiles.some(tile => tile.color === "animal" && tile.count === 4))!;
  const [animal] = source.splice(source.findIndex(tile => tile.color === "animal" && tile.count === 4), 1);
  const depot = state.depots[3].tiles;
  const displaced = depot.shift();
  if (displaced) state.pools[displaced.color].push(displaced);
  depot.push(animal);
  const shopIndex = state.pools.animal.findIndex(tile => tile.count === 4);
  const [shopAnimal] = state.pools.animal.splice(shopIndex, 1);
  const shopDisplaced = state.black.shift()!;
  state.pools[shopDisplaced.color].push(shopDisplaced);
  state.black.unshift(shopAnimal);

  const supply = Object.values(state.pools).find(tiles =>
    tiles.some(tile => BOARD.some(cell => canPlace(player, tile, cell.id))),
  )!;
  player.storage = supply.splice(supply.findIndex(tile => BOARD.some(cell => canPlace(player, tile, cell.id))), 1);
  return { state, animal };
}

async function openTable(page: Page, state: State) {
  // Playwright's isolated context never touches the user's existing table.
  // Seed before boot to prevent a Steward turn racing the fixture.
  await page.addInitScript(({ key, state }) => {
    localStorage.setItem(key, JSON.stringify(state));
  }, { key: SAVE_KEY, state });
  await page.goto("/");
  await expect(page.locator("#turn-controls")).toBeVisible();
  await expect(page.locator("#board canvas")).toBeAttached();
  await page.evaluate(() => document.fonts.ready);
}

async function expectUnchanged(page: Page, state: State) {
  expect(await page.evaluate(key => JSON.parse(localStorage.getItem(key)!), SAVE_KEY)).toEqual(state);
}

async function expectNoOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
}

async function expectQuantityUnclipped(card: Locator) {
  const art = card.locator(".tile-art");
  const badge = art.locator(".tile-number");
  await expect(badge).toHaveText("×4");
  await expect(badge).toBeVisible();
  await expect(art).toHaveCSS("clip-path", "none");
  await expect(art).toHaveCSS("overflow", "visible");
  await expect(art).toHaveCSS("background-image", /\/terrain\/animal\.svg/);
  const bounds = (await badge.boundingBox())!;
  expect(bounds.width).toBeGreaterThanOrEqual(20);
  const geometry = await art.evaluate(element => {
    const face = element.getBoundingClientRect();
    const caption = element.querySelector('.tile-number')!.getBoundingClientRect();
    const miniature = element.querySelector(':scope > svg')!.getBoundingClientRect();
    const r = face.width * 51 / 106;
    const cx = face.left + face.width / 2, cy = face.top + face.height / 2;
    const corners = [caption.left, caption.right].flatMap(x => [caption.top, caption.bottom].map(y => [x,y]));
    return { gap: caption.top - miniature.bottom, clearance: Math.min(...corners.map(([x,y]) =>
      r * Math.sqrt(3) / 2 - Math.max(Math.abs(x-cx), Math.abs((x-cx)/2+(y-cy)*Math.sqrt(3)/2), Math.abs((x-cx)/2-(y-cy)*Math.sqrt(3)/2)))) };
  });
  expect(geometry.gap).toBeGreaterThanOrEqual(0);
  expect(geometry.clearance).toBeGreaterThanOrEqual(1);
  // A bounding box alone does not detect a badge clipped by its parent hex.
  // All four inset corners must actually be painted and hit-testable.
  expect(await badge.evaluate(element => {
    const rect = element.getBoundingClientRect();
    return [rect.left + 2, rect.right - 2].every(x =>
      [rect.top + 2, rect.bottom - 2].every(y => {
        const hit = document.elementFromPoint(x, y);
        return hit !== null && (hit === element || element.contains(hit));
      }),
    );
  })).toBe(true);
}

async function expectAmount(amount: Locator, count: number, unit: string) {
  await expect(amount).toBeVisible();
  await expect(amount).toHaveText(`${count} ${unit}`);
  await expect(amount.locator(":scope > span:not(.sr-only)")).toHaveText(String(count));
  await expect(amount.locator(".sr-only")).toHaveText(unit);
  await expect(amount.locator("svg")).toHaveCount(1);
  await expect(amount.locator("svg")).toHaveAttribute("aria-hidden", "true");
  await expect(amount.locator("svg")).toHaveAttribute("focusable", "false");
}

test("print headings and readable controls use local fonts with tabular counters", async ({ page }) => {
  const { state } = position();
  await openTable(page, state);
  await expect.poll(() => page.evaluate(() => [
    '400 27px "IM Fell English"', '400 14px "Source Sans 3"',
    '600 14px "Source Sans 3"', '700 14px "Source Sans 3"',
  ].every(font => document.fonts.check(font)))).toBe(true);
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 1280, height: 720 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    await expect(page.locator("#market-title")).toHaveCSS("font-family", /IM Fell English/);
    await expect(page.locator("#market-title")).toHaveCSS("text-shadow", "none");
    await expect(page.locator("[data-mode='take']")).toHaveCSS("font-family", /Source Sans 3/);
    for (const selector of [".score-value", ".resource strong"]) {
      const counter = page.locator(selector).first();
      await expect(counter).toHaveCSS("font-variant-numeric", /tabular-nums/);
      await expect(counter).toHaveCSS("font-family", /Source Sans 3/);
    }
    await page.locator("#depots .market-card.knowledge").first().hover();
    await expect(page.locator('#market-tooltip[role="tooltip"]')).toBeVisible();
    await expect(page.locator("#market-tooltip .tile-benefit")).toHaveCSS("line-height", "18.9px");
    await page.locator("#market-title").hover();
    await expect(page.locator("#depots .depot").first()).toHaveAccessibleName("Depot 1");
    expect((await page.locator(".depot-heading").first().locator(":scope > :not(.sr-only)").allInnerTexts()).join(" ")).not.toContain("Depot 1");
    await expect(page.locator(".resource > span")).toHaveText(["Silver", "Workers", "Ships"]);
    await expectNoOverflow(page);
  }
  await expectUnchanged(page, state);
});

test("distinct table materials and quiet prices preserve unbroken knowledge tooltip rewards", async ({ page }) => {
  const { state } = position();
  const sources = [...Object.values(state.pools), state.black, ...state.depots.map(depot => depot.tiles)];
  const source = sources.find(tiles => tiles.some(tile => tile.knowledge === 13))!;
  const [knowledge] = source.splice(source.findIndex(tile => tile.knowledge === 13), 1);
  const depot = state.depots[0].tiles;
  const displaced = depot.shift();
  if (displaced) state.pools[displaced.color].push(displaced);
  depot.push(knowledge);
  await openTable(page, state);
  const card = page.locator(`#depots [data-tile="${knowledge.id}"]`);
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 1280, height: 720 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    await expect(page.locator("body")).toHaveCSS("background-color", "rgb(239, 229, 202)");
    await expect(page.locator(".player-column")).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    await expect(page.locator("#storage")).toHaveCSS("background-color", "rgb(48, 79, 67)");
    await expect(card.locator(".tile-name")).toHaveText("Knowledge 13");
    await expect(card.locator(".tile-benefit")).toHaveCount(0);
    await card.hover();
    const tooltip = page.locator('#market-tooltip[role="tooltip"]');
    await expect(tooltip).toBeVisible();
    await expect(tooltip.locator(".tile-benefit")).toHaveText(tileBenefit(knowledge));
    const reward = tooltip.locator(".inline-resource");
    await expect(reward).toHaveCount(1);
    await expect(reward).toHaveText("+1 silver");
    await expect(reward).toHaveCSS("white-space", "nowrap");
    await expect(reward).toHaveCSS("flex-wrap", "nowrap");
    await expect(reward.locator("svg")).toHaveCount(1);
    const bounds = (await reward.boundingBox())!;
    const tooltipBounds = (await tooltip.boundingBox())!;
    expect(bounds.x).toBeGreaterThanOrEqual(tooltipBounds.x);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(tooltipBounds.x + tooltipBounds.width);
    const quote = page.locator("#depots .depot").first().locator(".depot-heading .depot-cost");
    await expect(quote).toBeVisible();
    await expect(quote).toHaveText("No workers", { useInnerText: true });
    await expect(card.locator(".target-cost, .depot-cost")).toHaveCount(0);
    await expectNoOverflow(page);
    await page.locator("#market-title").hover();
  }
  await expectUnchanged(page, state);
});

test("tile illustrations stay large and square with bold labels across supply and reserve", async ({ page }) => {
  const { state } = position();
  await openTable(page, state);
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 1280, height: 720 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    if (viewport.width < 1000) await page.locator('.mobile-navigation [data-panel="market"]').click();
    const illustrations = await page.locator(".tile-art").evaluateAll(elements => elements.flatMap(element => {
      const face = element.getBoundingClientRect();
      if (!face.width) return [];
      const svg = element.querySelector(":scope > svg")!;
      const art = svg.getBoundingClientRect();
      const numbered = Boolean(element.querySelector(".tile-number"));
      return [{ numbered, width: art.width, height: art.height, faceWidth: face.width,
        centerX: art.x + art.width / 2, faceCenterX: face.x + face.width / 2,
        centerY: art.y + art.height / 2, faceCenterY: face.y + face.height / 2,
        filter: getComputedStyle(svg).filter }];
    }));
    expect(illustrations.length).toBeGreaterThan(0);
    for (const art of illustrations) {
      if (!art.numbered) {
        expect(art.width / art.faceWidth).toBeGreaterThanOrEqual(.89);
        expect(Math.abs(art.centerY - art.faceCenterY)).toBeLessThan(.1);
      }
      expect(Math.abs(art.width - art.height)).toBeLessThan(.1);
      expect(Math.abs(art.centerX - art.faceCenterX)).toBeLessThan(.1);
      expect(art.filter).toBe("none");
    }
    const weights = await page.locator(".market-card .tile-name, .storage-slot.filled .slot-label")
      .evaluateAll(labels => labels.map(label => getComputedStyle(label).fontWeight));
    expect(weights.every(weight => weight === "700")).toBe(true);
    const animal = page.locator(`#black-market [data-tile="${state.black[0].id}"]`);
    await animal.scrollIntoViewIfNeeded();
    await expectQuantityUnclipped(animal);
    await expectNoOverflow(page);
  }
  await expectUnchanged(page, state);
});

test("four-animal badges stay unclipped on readable disabled cards; resource icons retain spoken units", async ({ page }) => {
  const { state, animal } = position();
  await openTable(page, state);
  const card = page.locator(`#depots [data-tile="${animal.id}"]`);
  expect(legalActions(state).some(action => action.kind === "take" && action.die === 0 && action.tile === animal.id)).toBe(false);
  await expect(card).toBeDisabled();
  await expect(card).toHaveAttribute("aria-disabled", "true");
  await expect(card).toHaveJSProperty("disabled", false);
  await expect(card).toHaveAccessibleName(new RegExp(`^${tileName(animal)}\\.`));
  await expect(card).toHaveCSS("opacity", "1");
  await expect(card).toHaveCSS("filter", "none");
  await expect(card.locator(".tile-name")).toBeVisible();
  await expectQuantityUnclipped(card);
  // The shop's smaller art box was the original clipped-count regression.
  await expectQuantityUnclipped(page.locator(`#black-market [data-tile="${state.black[0].id}"]`));
  const nameStyles = await card.locator(".tile-name").evaluate(element => {
    const css = getComputedStyle(element);
    return { size: parseFloat(css.fontSize), color: css.color };
  });
  expect(nameStyles.size).toBeGreaterThanOrEqual(13);
  expect(nameStyles.color).not.toBe("rgba(0, 0, 0, 0)");

  const adjusted = legalActions(state).find(action => action.kind === "take" && action.die === 0 && action.cost === 1)!;
  const workerCard = page.locator(`#depots [data-tile="${adjusted.tile}"]`);
  const workerQuote = page.locator("#depots .depot").nth(adjusted.depot!).locator(".depot-heading .depot-cost");
  await expect(workerQuote).toBeVisible();
  await expect(workerQuote).toHaveText("1 worker", { useInnerText: true });
  await expect(workerCard.locator(".target-cost, .depot-cost")).toHaveCount(0);
  await expect(workerCard).toHaveAccessibleName(/1 workers?/);
  const buy = legalActions(state).find(action => action.kind === "buy")!;
  const buyCard = page.locator(`#black-market [data-tile="${buy.tile}"]`);
  await expect(buyCard.locator(".target-cost")).toHaveCount(0);
  await expectAmount(page.locator("#black-market .black-heading .resource-amount"), 2, "silver");
  await expect(buyCard).toHaveAccessibleName(/Buy for 2 silver/);

  await page.locator('[data-die="1"]').click();
  await expect(card).toBeEnabled();
  await expect(card).toHaveClass(/action-target/);
  await expectQuantityUnclipped(card);
  const action = legalActions(state).find(action => action.kind === "take" && action.die === 1 && action.tile === animal.id)!;
  const quote = page.locator("#depots .depot").nth(action.depot!).locator(".depot-heading .depot-cost");
  await expect(quote).toBeVisible();
  await expect(quote).toHaveText("No workers", { useInnerText: true });
  await expectUnchanged(page, state);
});

test("the six-color map key and field guide explain empty land, settled artwork, and both color bonuses", async ({ page }, testInfo) => {
  const { state } = position();
  await openTable(page, state);
  const key = page.locator("#legend");
  await expect(key).toBeVisible();
  await expect(key.locator("summary > span:not(.bonus-available)")).toHaveText(COLOR_LABELS);
  await expect(key.locator('i[aria-hidden="true"]')).toHaveCount(6);
  const swatches = await key.locator("i").evaluateAll(elements => elements.map(element => getComputedStyle(element).backgroundColor));
  expect(new Set(swatches).size).toBe(6);
  const canvas = page.locator("#board canvas");
  const canvasBounds = (await canvas.boundingBox())!;
  expect((await key.boundingBox())!.x).toBeGreaterThanOrEqual(canvasBounds.x + canvasBounds.width - 1);
  // Wait for Phaser's occupied starting castle, not just an attached canvas.
  await expect.poll(async () => {
    await page.mouse.move(0, 0);
    await canvas.hover();
    return page.locator("#board-tooltip").textContent();
  }).toContain("Take a free action");
  await testInfo.attach("color-key-and-settled-estate", { body: await page.locator(".map-sheet").screenshot(), contentType: "image/png" });

  const ledger = page.locator("#color-ledger");
  await expect(page.locator("#estate-scoring > h3")).toHaveText("Estate scoring");
  await expect(ledger.locator("h3")).toHaveCount(0);
  await expect(ledger.locator(".estate-section-heading")).toContainText("First +5 · Second +2 VP");
  await expect(ledger.locator(":scope > p")).toHaveCount(0);
  for (const color of COLORS) {
    const row = ledger.locator(`[data-color-progress="${color}"]`);
    await expect(row).toBeVisible();
    await expect(row).toHaveJSProperty("open", false);
    await expect(row.locator(".bonus-available")).toHaveText("+5 VP available");
    await expect(row.locator("summary .bonus-available")).toHaveCount(0);
    await expect(row.locator(".color-rewards .bonus-available")).toBeHidden();
    await row.locator("summary").click();
    await expect(row.locator(".color-rewards .bonus-available")).toBeVisible();
    await expect(row.locator(".color-rewards")).toContainText("First +5 · available");
    await expect(row.locator(".color-rewards")).toContainText("Second +2 · available");
    await expect(row.locator("summary")).toHaveAccessibleName(/1st \+5 VP: unclaimed\. 2nd \+2 VP: unclaimed/);
  }
  const help = page.locator('.masthead [data-ui="help"]');
  await help.click();
  const dialog = page.getByRole("dialog", { name: "A field guide to your estate" });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("Empty land shows its terrain texture and required die.");
  await expect(dialog).toContainText("Illustrated tiles are settled land; their counts stay inside the hex.");
  await expect(dialog.locator(".color-guide > div")).toHaveCount(6);
  for (const label of COLOR_LABELS) await expect(dialog.locator(".color-guide")).toContainText(label);
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
  await expect(help).toBeFocused();
  await expectUnchanged(page, state);
});

test("1280×720 and 1440×900 keep legal choices in the turn strip and market quantities reachable", async ({ page }, testInfo) => {
  const { state, animal } = position();
  await page.setViewportSize({ width: 1280, height: 720 });
  await openTable(page, state);
  for (const viewport of [{ width: 1280, height: 720 }, { width: 1440, height: 900 }]) {
    await test.step(`${viewport.width}×${viewport.height}`, async () => {
      await page.setViewportSize(viewport);
      await expect(page.locator("#turn-controls .legal-section")).toHaveCount(1);
      await expect(page.locator(".market-column > #black-market")).toHaveCount(1);
      await expect(page.locator(".player-column > #estate-scoring .region-panel")).toHaveCount(1);
      await expect(page.locator(".player-column > #estate-scoring #color-ledger")).toHaveCount(1);
      await testInfo.attach(`desktop-controls-${viewport.width}`, { body: await page.screenshot(), contentType: "image/png" });
      // Legal choices are first-screen controls on every desktop. Secondary
      // region/color information stays with the estate rather than the depots.
      const selectors = ["#turn-controls", ".masthead [data-ui='help']", "#legal-details > summary"];
      for (const selector of selectors) {
        const control = page.locator(selector);
        await expect(control).toBeVisible();
        await expect(control).toBeInViewport({ ratio: 1 });
        const bounds = (await control.boundingBox())!;
        expect(bounds.x).toBeGreaterThanOrEqual(0);
        expect(bounds.y).toBeGreaterThanOrEqual(0);
        expect(bounds.x + bounds.width).toBeLessThanOrEqual(viewport.width + 1);
        expect(bounds.y + bounds.height).toBeLessThanOrEqual(viewport.height + 1);
      }
      // Trial clicks detect occlusion, without opening disclosures or spending a die.
      for (const selector of ["#legal-details > summary", "[data-die='1']", "[data-mode='workers']"]) {
        await page.locator(selector).click({ trial: true });
        expect(await page.evaluate(() => scrollY)).toBe(0);
      }
      const animalCard = page.locator(`#depots [data-tile="${animal.id}"]`);
      await animalCard.scrollIntoViewIfNeeded();
      await expectQuantityUnclipped(animalCard);
      await expectNoOverflow(page);
    });
  }
  await expectUnchanged(page, state);
});

test("390px mobile preserves help and reserve selection without horizontal overflow", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const { state, animal } = position();
  await openTable(page, state);
  await expect(page.locator("#turn-controls .legal-section")).toHaveCount(1);
  await expect(page.locator(".estate-sheet > #estate-scoring .region-panel")).toHaveCount(1);
  await expect(page.locator(".estate-sheet > #estate-scoring #color-ledger")).toHaveCount(1);
  await expectNoOverflow(page);
  const card = page.locator(`#depots [data-tile="${animal.id}"]`);
  await card.scrollIntoViewIfNeeded();
  await expectQuantityUnclipped(card);

  const help = page.locator('.masthead [data-ui="help"]');
  await help.click();
  const dialog = page.getByRole("dialog", { name: "A field guide to your estate" });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("Empty land shows its terrain texture and required die.");
  expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  await expectNoOverflow(page);
  await dialog.locator('[data-ui="close"]').click();
  await expect(dialog).not.toBeVisible();
  await expect(help).toBeFocused();

  await page.locator('.mobile-navigation [data-panel="estate"]').click();
  const reserve = page.locator(`#storage [data-tile="${state.players[0].storage[0].id}"]`);
  await reserve.click();
  await expect(reserve).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator('[data-mode="place"]')).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator('.mobile-navigation [data-panel="estate"]')).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#board canvas")).toBeInViewport({ ratio: 0.9 });
  await expect(page.locator("#legend summary > span:not(.bonus-available)")).toHaveText(COLOR_LABELS);
  await expectNoOverflow(page);
  await testInfo.attach("mobile-materials-selection", { body: await page.screenshot(), contentType: "image/png" });
  await page.locator('#legend [data-color-progress="animal"] > summary').click();
  await expect(page.locator('#legend [data-color-progress="animal"]')).toHaveJSProperty("open", true);
  await expect(page.locator('#color-ledger [data-color-progress="animal"]')).toContainText("Second +2 · available");
  await expectNoOverflow(page);
  await page.locator('.mobile-navigation [data-panel="market"]').click();
  await expect(page.locator("#depots")).toBeVisible();
  await expectNoOverflow(page);
  await expectUnchanged(page, state);
});
