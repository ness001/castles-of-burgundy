import { expect, test, type Locator, type Page } from "@playwright/test";
import { BOARD } from "../src/data";
import { createGame, legalActions } from "../src/engine";
import { regionOutcome } from "../src/presentation";
import type { State, Tile } from "../src/types";

const SAVE_KEY = "burgundy-table.state.v1";
const VIEWPORTS = [{ width: 1280, height: 720 }, { width: 390, height: 844 }];

function position(partial = false): State {
  const state = createGame(42);
  state.active = 0;
  state.order = [0, 1];
  state.turnIndex = 0;
  state.players[0].dice = [1, 2];
  state.players[0].workers = 1;
  state.players[0].silver = 4;
  if (partial) {
    state.phase = 2;
    const first = BOARD.find(cell => cell.color === "mine")!;
    for (const cell of BOARD.filter(cell => cell.region === first.region).slice(0, -1)) {
      state.players[0].board[cell.id] = state.pools.mine.pop()!;
    }
  }
  return state;
}

// Exchange genuine supply tiles without duplicating IDs or growing a depot/shop.
function swapInto(state: State, destination: Tile[], index: number, matches: (tile: Tile) => boolean) {
  const sources = [...Object.values(state.pools), state.blackPool, ...state.depots.map(d => d.tiles), state.black];
  const source = sources.find(tiles => tiles.some(matches))!;
  const from = source.findIndex(matches);
  [destination[index], source[from]] = [source[from], destination[index]];
  return destination[index];
}

async function openTable(page: Page, state: State) {
  await page.addInitScript(({ key, state }) => localStorage.setItem(key, JSON.stringify(state)), { key: SAVE_KEY, state });
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

async function expectScoring(section: Locator, state: State) {
  const sizes = [...new Map(BOARD.map(cell => {
    const outcome = regionOutcome(state.players[0], cell.id, state.phase);
    return [outcome.size, outcome.base];
  })).entries()].sort(([a], [b]) => a - b);
  await expect(section.locator(".scoring-sizes dt")).toHaveText(sizes.map(([size]) => `${size} hex${size === 1 ? "" : "es"}`));
  await expect(section.locator(".scoring-sizes dd")).toHaveText(sizes.map(([, base]) => `${base} VP`));
  const timing = regionOutcome(state.players[0], BOARD[0].id, state.phase).timing;
  await expect(section).toContainText(`This phase (${"ABCDE"[state.phase]}) adds ${timing} VP`);
  for (let phase = 0; phase < 5; phase++) {
    await expect(section).toContainText(`${"ABCDE"[phase]} +${regionOutcome(state.players[0], BOARD[0].id, phase).timing}`);
  }
  await expect(section).toContainText(/each region scores once/i);
  await expect(section).toContainText(/every hex of one color.*first player \+5 VP.*second player \+2 VP/i);
}

for (const viewport of VIEWPORTS) {
  test(`${viewport.width}px scoring rules stay in the header guide without changing the game`, async ({ page }) => {
    const phone = viewport.width === 390;
    const state = position(phone);
    await page.setViewportSize(viewport);
    await openTable(page, state);
    if (phone) await page.locator('.mobile-navigation [data-panel="estate"]').click();
    const rewards = page.locator("#region-insight [data-region-cell]");
    await expect(rewards).toHaveCount(phone ? 1 : 0);
    await expect(page.locator("#region-detail")).toBeHidden();
    await expect(page.locator("#region-detail")).toBeEmpty();
    await expect(page.locator('[data-ui="scoring-help"]')).toHaveCount(0);
    await expect(page.locator('[data-ui="help"]')).toHaveCount(1);

    const opener = page.locator('.masthead [data-ui="help"]');
    const dialog = page.getByRole("dialog", { name: "A field guide to your estate", exact: true });
    for (const close of ["escape", "button"]) {
      await opener.click();
      const section = dialog.locator("#guide-scoring");
      await expect(dialog).toBeVisible();
      await expect(section).toHaveAttribute("tabindex", "-1");
      await section.locator("h3").scrollIntoViewIfNeeded();
      await expect(section.locator("h3")).toBeInViewport({ ratio: 1 });
      await expectScoring(section, state);
      expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
      await expectNoOverflow(page);
      if (close === "escape") await page.keyboard.press("Escape");
      else await dialog.getByRole("button", { name: "Close dialog" }).click();
      await expect(dialog).not.toBeVisible();
      await expect(opener).toBeFocused();
      await expect(opener).toBeInViewport({ ratio: 1 });
      await expectUnchanged(page, state);
    }

    const help = page.locator('.masthead [data-ui="help"]');
    await help.click();
    await expect(dialog).toBeVisible();
    await expectScoring(dialog.locator("#guide-scoring"), state);
    await expect(dialog).toContainText("Empty land shows its terrain texture and required die.");
    await page.keyboard.press("Escape");
    await expect(help).toBeFocused();
    if (phone) {
      await page.locator('.mobile-navigation [data-panel="market"]').click();
      await page.locator("#legal-details > summary").click();
      await expect(page.locator("#legal-actions button").first()).toBeVisible();
      await expect(page.locator("#legal-actions button").first()).toBeEnabled();
    }
    await expectNoOverflow(page);
    await expectUnchanged(page, state);
  });
}

test("desktop and phone keep market art and short labels readable with unclipped quantities and exact worker quotes", async ({ page }) => {
  const state = position();
  const depot = state.depots[1].tiles;
  const knowledge = swapInto(state, depot, depot.findIndex(tile => tile.color === "knowledge"), tile => tile.knowledge === 19);
  const animals = state.depots[2].tiles;
  const animal = swapInto(state, animals, animals.findIndex(tile => tile.color === "animal"), tile => !tile.black && tile.count === 4);
  const shopAnimal = swapInto(state, state.black, 0, tile => !!tile.black && tile.count === 4);
  const shopKnowledge = swapInto(state, state.black, 1, tile => tile.knowledge === 14);
  await page.setViewportSize(VIEWPORTS[0]);
  await openTable(page, state);

  for (const viewport of VIEWPORTS) {
    await test.step(`${viewport.width}×${viewport.height}`, async () => {
      await page.setViewportSize(viewport);
      for (const [root, tiles] of [["#depots", [knowledge, animal]], ["#black-market", [shopKnowledge, shopAnimal]]] as const) {
        const sizes: number[] = [];
        for (const tile of tiles) {
          const card = page.locator(`${root} [data-tile="${tile.id}"]`);
          await card.scrollIntoViewIfNeeded();
          await expect(card.locator(".tile-name")).toBeVisible();
          expect(await card.locator(".tile-name").evaluate(element => parseFloat(getComputedStyle(element).fontSize)))
            .toBeGreaterThanOrEqual(13);
          if (tile.knowledge) {
            await expect(card.locator(".tile-name")).toHaveText(`Knowledge ${tile.knowledge}`);
            await expect(card.locator(".tile-benefit")).toHaveCount(0);
          }
          const art = card.locator(".tile-art");
          const svg = art.locator(":scope > svg");
          await expect(svg).toBeVisible();
          const bounds = (await svg.boundingBox())!;
          expect(bounds.width).toBeGreaterThanOrEqual(40);
          expect(bounds.height).toBeGreaterThanOrEqual(40);
          sizes.push(bounds.width);
          const frame = (await art.boundingBox())!;
          expect(bounds.width).toBeLessThanOrEqual(frame.width);
          expect(bounds.height).toBeLessThanOrEqual(frame.height);
          expect(await art.evaluate(element => getComputedStyle(element, "::before").clipPath)).toMatch(/^polygon\(/);
          if (tile.count) {
            const badge = art.locator(".tile-number");
            await expect(badge).toHaveText("×4");
            await expect(art).toHaveCSS("clip-path", "none");
            await expect(art).toHaveCSS("overflow", "visible");
            expect(await badge.evaluate(element => {
              const rect = element.getBoundingClientRect();
              return [rect.left + 2, rect.right - 2].every(x => [rect.top + 2, rect.bottom - 2].every(y => {
                const hit = document.elementFromPoint(x, y);
                return hit !== null && (hit === element || element.contains(hit));
              }));
            })).toBe(true);
          }
        }
        expect(Math.abs(sizes[0] - sizes[1])).toBeLessThanOrEqual(1);
      }
      for (const cost of [0, 1]) {
        const action = legalActions(state).find(action => action.kind === "take" && action.die === 0 && action.cost === cost)!;
        const station = page.locator("#depots .depot").nth(action.depot!);
        const quote = station.locator(".depot-heading .depot-cost");
        await expect(station.locator(".depot-cost")).toHaveCount(1);
        await expect(quote).toBeVisible();
        await expect(quote).toHaveText(cost ? `${cost} worker` : "No workers", { useInnerText: true });
        await expect(station.locator(".market-card .target-cost, .market-card .depot-cost")).toHaveCount(0);
        for (const icon of await quote.locator("svg").all()) {
          await expect(icon).toHaveAttribute("aria-hidden", "true");
          await expect(icon).toHaveAttribute("focusable", "false");
        }
      }
      await expectNoOverflow(page);
      await expectUnchanged(page, state);
    });
  }
});

test("estate rewards and color ownership stay by the board; advantages stay with player controls", async ({ page }, testInfo) => {
  const state = position(true);
  state.players[0].storage = [state.pools.mine.pop()!];
  state.players[0].goods = [0, 2, 0, 1, 0, 0];
  state.players[1].storage = [state.pools.ship.pop()!];
  state.players[1].goods = [1, 0, 0, 0, 2, 0];
  state.players[1].silver = 2;
  state.players[1].workers = 3;
  const sources = [...Object.values(state.pools), ...state.depots.map(depot => depot.tiles), state.black];
  const land = BOARD.filter(cell => cell.color === "knowledge");
  for (const [index, id] of [4, 5, 22].entries()) {
    const source = sources.find(tiles => tiles.some(tile => tile.knowledge === id))!;
    state.players[0].board[land[index].id] = source.splice(source.findIndex(tile => tile.knowledge === id), 1)[0];
  }
  state.claimed.mine = [1];
  state.claimed.animal = [1, 0];
  await openTable(page, state);
  for (const width of [1440, 1280, 1001, 1000, 390, 320, 1440]) {
    await page.setViewportSize({ width, height: width === 1280 ? 720 : 1000 });
    if (width <= 1000) await page.locator('.mobile-navigation [data-panel="estate"]').click();
    await expect(page.locator(".estate-heading")).toHaveCount(1);
    await expect(page.locator(".map-sheet > .estate-heading #estate-title")).toHaveText("Your estate");
    await expect(page.locator(".map-sheet > .estate-heading .estate-switch")).toBeVisible();
    await expect(page.locator(".map-sheet > .estate-heading [data-view]")).toHaveCount(2);
    await expect(page.locator("#estate-meta, .estate-column > .estate-heading")).toHaveCount(0);
    await expect(page.locator(".estate-sheet > .map-sheet")).toHaveCount(1);
    await expect(page.locator("#estate-scoring")).toHaveCount(1);
    const scoring = page.locator(".estate-sheet > #estate-scoring");
    await expect(scoring).toBeVisible();
    await expect(scoring.locator(":scope > h3")).toHaveText("Estate scoring");
    await expect(scoring.locator("#color-ledger")).toHaveCount(1);
    await expect(scoring.locator("#color-ledger h3")).toHaveCount(0);
    await expect(scoring.locator(".region-panel #region-insight")).toHaveCount(1);
    await expect(scoring.locator(".region-panel #region-detail")).toHaveCount(1);
    await expect(scoring.locator(".region-heading")).toHaveText("Next region rewards");
    expect(await page.locator(".map-sheet").evaluate(map => Boolean(map.compareDocumentPosition(document.querySelector("#estate-scoring")!) & Node.DOCUMENT_POSITION_FOLLOWING))).toBe(true);
    if (width <= 1000) await expect(page.locator(".estate-sheet > .map-sheet + #choices + #estate-scoring")).toHaveCount(1);
    const map = (await page.locator(".map-sheet").boundingBox())!;
    const scoringBounds = (await scoring.boundingBox())!;
    if (width > 1000) {
      expect(map.x + map.width).toBeLessThanOrEqual(scoringBounds.x + 1);
      expect(scoringBounds.y).toBeLessThan(map.y + map.height);
      expect(scoringBounds.y + scoringBounds.height).toBeGreaterThan(map.y);
      expect(scoringBounds.width).toBeLessThan(map.width);
    } else {
      expect(scoringBounds.y).toBeGreaterThanOrEqual(map.y + map.height - 1);
    }
    for (const selector of ["#depots", "#phase-goods", "#black-market"]) {
      await expect(page.locator(`.market-column ${selector}`)).toHaveCount(1);
    }
    await expect(page.locator(".market-column").locator("#scoreboard, #season, #estate-scoring, #color-ledger, .region-panel, #estate-knowledge, #storage, #resources, #goods")).toHaveCount(0);
    await expect(page.locator(".board-color-key, .scoring-help, .section-caption")).toHaveCount(0);
    await expect(page.locator("#estate-knowledge")).toHaveCount(1);
    await expect(page.locator(".reserve-panel > #goods ~ #estate-knowledge h3")).toHaveText("Your advantages");
    await expect(page.locator(".estate-column #estate-knowledge")).toHaveCount(0);
    await expect(page.locator("#estate-knowledge button")).toHaveCount(3);
    const mines = page.locator('[data-color-progress="mine"]');
    const mineCells = BOARD.filter(cell => cell.color === "mine");
    await expect(mines.locator("b")).toHaveText(`${mineCells.filter(cell => state.players[0].board[cell.id]).length}/${mineCells.length}`);
    await expect(mines.locator(".bonus-available")).toHaveText("+2 VP available");
    await expect(page.locator('[data-color-progress="animal"] .bonus-available')).toHaveText("Both claimed · No color bonus");
    await mines.locator("summary").focus();
    if (!(await mines.evaluate(element => (element as HTMLDetailsElement).open))) {
      await expect(mines.locator(".bonus-available")).toBeHidden();
      await page.keyboard.press("Enter");
    }
    await expect(mines.locator(".color-rewards")).toBeVisible();
    await expect(mines.locator(".color-rewards .bonus-available")).toBeVisible();
    await expect(mines.locator(".color-rewards")).toContainText("First +5 · Steward");
    const reward = scoring.locator('#region-insight [data-region-cell]').filter({ hasText: "Mines" });
    const detail = scoring.locator("#region-detail");
    await expect(detail).toBeHidden();
    await expect(detail).toBeEmpty();
    await reward.click();
    await expect(reward).toHaveAttribute("aria-pressed", "true");
    await expect(detail).toBeVisible();
    await page.locator('[data-view="1"]').click();
    await expect(page.locator("#estate-title")).toHaveText("The Steward’s estate");
    await expect(page.locator("#estate-knowledge")).toBeHidden();
    await expect(mines).toHaveJSProperty("open", true);
    await expect(mines.locator("b")).toHaveText("0/3");
    await expect(detail).toBeHidden();
    await expect(detail).toBeEmpty();
    await expect(scoring.locator('[data-region-cell][aria-pressed="true"]')).toHaveCount(0);
    await expect(page.locator("#storage h3")).toHaveText("Steward’s reserve");
    await expect(page.locator("#storage .filled .slot-label")).toHaveText("Ship");
    await expect(page.locator("#resources .resource strong")).toHaveText(["2", "3", "0"]);
    await expect(page.locator("#goods .cargo-count")).toHaveText(state.players[1].goods.map(count => `×${count}`));
    await expectUnchanged(page, state);
    await page.locator('[data-view="0"]').click();
    await expect(page.locator("#estate-title")).toHaveText("Your estate");
    await expect(mines.locator("b")).toHaveText(`${mineCells.filter(cell => state.players[0].board[cell.id]).length}/${mineCells.length}`);
    await expect(page.locator("#storage h3")).toHaveText("Your reserve");
    await expect(page.locator("#storage .filled .slot-label")).toHaveText("Mine");
    await expect(page.locator("#resources .resource strong")).toHaveText(["4", "1", "0"]);
    await expect(page.locator("#goods .cargo-count")).toHaveText(state.players[0].goods.map(count => `×${count}`));
    await expect(reward).toHaveAttribute("aria-pressed", "false");
    await expect(detail).toBeHidden();
    await expect(detail).toBeEmpty();
    await expect(page.locator(".reserve-panel > #goods ~ #estate-knowledge h3")).toHaveText("Your advantages");
    const advantage = page.locator('#estate-knowledge [data-knowledge="5"]');
    await advantage.click();
    await expect(page.getByRole("dialog", { name: "An acquired advantage", exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(advantage).toBeFocused();
    await expectNoOverflow(page);
    expect(await page.locator(".estate-sheet").evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    expect(await scoring.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    await expectUnchanged(page, state);
    if (width === 1440 || width === 390) {
      await page.mouse.move(0, 0);
      await page.evaluate(() => scrollTo(0, 0));
      await page.screenshot({ path: testInfo.outputPath(`estate-layout-${width}.png`), fullPage: true });
    }
  }
});
