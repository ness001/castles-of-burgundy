import { expect, test, type Page } from "@playwright/test";
import { BOARD, tileDescription, tileName } from "../src/data";
import { createGame, legalActions } from "../src/engine";
import { tileBenefit } from "../src/presentation";
import type { State } from "../src/types";

const SAVE_KEY = "burgundy-table.state.v1";

function position(): State {
  const state = createGame(42);
  state.active = 0;
  state.order = [0, 1];
  state.turnIndex = 0;
  state.players[0].dice = [1, 4];
  state.players[0].workers = 1;
  state.players[0].silver = 4;
  return state;
}

async function openTable(page: Page, state: State) {
  await page.addInitScript(({ key, state }) => {
    if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify(state));
  }, { key: SAVE_KEY, state });
  await page.goto("/");
  await expect(page.locator("#board canvas")).toBeAttached();
  await expect(page.locator("#depots .depot")).toHaveCount(6);
  await page.evaluate(() => document.fonts.ready);
}

async function saved(page: Page): Promise<State> {
  return page.evaluate(key => JSON.parse(localStorage.getItem(key)!), SAVE_KEY);
}

async function expectQuietSupply(page: Page) {
  // Keep screen-reader instructions; only the printed copy should disappear.
  const copy = await page.locator(".market-column").evaluate(element => {
    const clone = element.cloneNode(true) as HTMLElement;
    clone.querySelectorAll(".sr-only, svg").forEach(node => node.remove());
    return clone.textContent;
  });
  expect(copy).not.toMatch(/Depot [1-6]|No goods|Empty depot|Once per turn|no die|Click to take|Buy for 2 silver/);
}

async function depotBounds(page: Page) {
  return page.locator("#depots .depot").evaluateAll(depots => {
    const origin = depots[0].parentElement!.getBoundingClientRect();
    return depots.map(depot => {
      const rect = depot.getBoundingClientRect();
      const style = getComputedStyle(depot);
      return {
        x: rect.x - origin.x, y: rect.y - origin.y, width: rect.width, height: rect.height,
        surface: { background: style.backgroundColor, image: style.backgroundImage, shadow: style.boxShadow, border: style.borderWidth },
        slots: [...depot.querySelector(".depot-tiles")!.children].map(slot => {
          const bounds = slot.getBoundingClientRect();
          return { x: bounds.x - rect.x, y: bounds.y - rect.y, width: bounds.width, height: bounds.height };
        }),
      };
    });
  });
}

test("market tooltip shares full benefits across hover and keyboard focus; Escape only dismisses inspection", async ({ page }) => {
  const state = position();
  const tiles = state.depots[1].tiles;
  const knowledge = tiles.find(tile => tile.color === "knowledge")!;
  const preceding = tiles[0];
  await openTable(page, state);
  const card = page.locator(`#depots .market-card[data-tile="${knowledge.id}"]`);
  const tooltip = page.locator('#market-tooltip[role="tooltip"]');
  await expect(card.locator(".tile-name")).toHaveText(`Knowledge ${knowledge.knowledge}`);
  await expect(card.locator(".tile-benefit")).toHaveCount(0);
  expect(await card.getAttribute("aria-label")).toContain(tileName(knowledge));
  expect(await card.getAttribute("aria-label")).toContain(tileDescription(knowledge));
  await expect(tooltip).toBeHidden();

  await card.hover();
  await expect(tooltip).toHaveCount(1);
  await expect(tooltip).toBeVisible();
  await expect(tooltip.locator(".tile-benefit")).toHaveText(tileBenefit(knowledge));
  await page.keyboard.press("Escape");
  await expect(tooltip).toBeHidden();
  await page.locator("#market-title").hover();
  await card.hover();
  await expect(tooltip).toBeVisible();
  await page.locator("#market-title").hover();
  await expect(tooltip).toBeHidden();

  await page.locator(`#depots [data-tile="${preceding.id}"]`).focus();
  await expect(tooltip).toBeVisible();
  await expect(tooltip.locator(".tile-benefit")).toHaveText(tileBenefit(preceding));
  await page.keyboard.press("Tab");
  await expect(card).toBeFocused();
  await expect(tooltip).toHaveCount(1);
  await expect(tooltip.locator(".tile-benefit")).toHaveText(tileBenefit(knowledge));
  await page.keyboard.press("Escape");
  await expect(tooltip).toBeHidden();
  await expect(card).toBeFocused();
  expect(await saved(page)).toEqual(state);
});

test("inactive market tiles remain inspectable but ignore pointer and Enter activation", async ({ page }) => {
  const state = position();
  state.players[0].silver = 1;
  state.players[0].storage = [state.pools.mine.pop()!];
  const unavailable = state.depots[3].tiles[0];
  const actions = legalActions(state);
  expect(actions.some(action => action.kind === "take" && action.tile === unavailable.id && action.die === 0)).toBe(false);
  expect(actions.some(action => action.kind === "take" && action.tile === unavailable.id && action.die === 1)).toBe(true);
  expect(actions.some(action => action.kind === "buy")).toBe(false);
  await openTable(page, state);

  const reserve = page.locator('#storage [data-source="storage"]');
  await expect(reserve).toBeEnabled();
  await expect(reserve).toHaveJSProperty("disabled", false);
  for (const [source, tile] of [["market", unavailable], ["black", state.black[0]]] as const) {
    const card = page.locator(`.market-card[data-source="${source}"][data-tile="${tile.id}"]`);
    await expect(card).toHaveAttribute("aria-disabled", "true");
    await expect(card).toHaveJSProperty("disabled", false);
    expect(await card.evaluate(element => (element as HTMLButtonElement).tabIndex)).toBeGreaterThanOrEqual(0);
    await card.focus();
    await expect(card).toBeFocused();
    await expect(page.locator('#market-tooltip[role="tooltip"]')).toBeVisible();
    await expect(page.locator("#market-tooltip .tile-benefit")).toHaveText(tileBenefit(tile));
    await page.keyboard.press("Enter");
    expect(await saved(page)).toEqual(state);
    await expect(page.locator("#modal")).not.toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.locator("#market-tooltip")).toBeHidden();
    // Bypass Playwright's aria-disabled actionability check, not the real click handler.
    await card.click({ force: true });
    expect(await saved(page)).toEqual(state);
    await expect(page.locator("#modal")).not.toBeVisible();
  }
  await expect(page.locator('#turn-controls [data-ui="undo"]')).toBeDisabled();
});

test("each eligible depot quotes its worker cost once and follows the selected die", async ({ page }) => {
  const state = position();
  state.players[0].workers = 2;
  await openTable(page, state);
  const depots = page.locator("#depots .depot");
  for (const die of [0, 1, 0]) {
    await page.locator(`#turn-controls [data-die="${die}"]`).click();
    const takes = legalActions(state).filter(action => action.kind === "take" && action.die === die);
    expect([...new Set(takes.map(action => action.cost))].sort()).toEqual([0, 1, 2]);
    await expect(depots.locator(".depot-cost")).toHaveCount(new Set(takes.map(action => action.depot)).size);
    await expect(depots.locator(".target-cost")).toHaveCount(0);
    for (let index = 0; index < state.depots.length; index++) {
      const actions = takes.filter(action => action.depot === index);
      const quote = depots.nth(index).locator(".depot-heading .depot-cost");
      await expect(quote).toHaveCount(actions.length ? 1 : 0);
      if (!actions.length) continue;
      const cost = Math.min(...actions.map(action => action.cost));
      await expect(quote).toBeVisible();
      await expect(quote).toHaveText(cost ? `${cost} worker${cost === 1 ? "" : "s"}` : "No workers", { useInnerText: true });
      for (const tile of state.depots[index].tiles) {
        const card = depots.nth(index).locator(`[data-tile="${tile.id}"]`);
        await expect(card).toHaveAttribute("aria-disabled", "false");
        await expect(card).toHaveAccessibleName(new RegExp(`Click to take · ${cost ? `${cost} workers?` : "no workers"}`));
      }
    }
    expect(await saved(page)).toEqual(state);
  }
});

test("buy mode quotes two silver once per eligible depot, never on empty stations or individual tiles", async ({ page }) => {
  const state = position();
  const sources = [...Object.values(state.pools), ...state.depots.map(depot => depot.tiles), state.blackPool, state.black];
  const source = sources.find(tiles => tiles.some(tile => tile.knowledge === 6))!;
  const [knowledge] = source.splice(source.findIndex(tile => tile.knowledge === 6), 1);
  state.players[0].board[BOARD.find(cell => cell.color === "knowledge")!.id] = knowledge;
  for (const tile of state.depots[0].tiles) state.pools[tile.color].push(tile);
  state.depots[0].tiles = [];
  const buys = legalActions(state).filter(action => action.kind === "buy" && action.depot! >= 0);
  expect(buys.length).toBeGreaterThan(0);
  await openTable(page, state);
  await page.locator('#black-market [data-mode="buy"]').click();
  const depots = page.locator("#depots .depot");
  await expect(depots.locator(".depot-cost")).toHaveCount(new Set(buys.map(action => action.depot)).size);
  await expect(page.locator(".market-column .target-cost")).toHaveCount(0);
  for (let index = 0; index < state.depots.length; index++) {
    const actions = buys.filter(action => action.depot === index);
    const quote = depots.nth(index).locator(".depot-heading .depot-cost");
    await expect(quote).toHaveCount(actions.length ? 1 : 0);
    if (!actions.length) continue;
    await expect(quote).toBeVisible();
    await expect(quote).toHaveText("2 silver", { useInnerText: true });
    for (const action of actions) {
      await expect(depots.nth(index).locator(`[data-tile="${action.tile}"]`)).toHaveAccessibleName(/Buy for 2 silver/);
    }
  }
  expect(await saved(page)).toEqual(state);
});

test("empty reserve slots show only hex outlines while filled slots retain their labels", async ({ page }, testInfo) => {
  const state = position();
  state.players[0].storage = [];
  await openTable(page, state);

  const slots = page.locator("#storage .storage-slot");
  await expect(slots).toHaveText(["", "", ""]);
  await expect(slots.locator(".slot-label")).toHaveCount(0);
  for (let index = 0; index < 3; index++) {
    const outline = slots.nth(index).locator(".slot-outline");
    await expect(outline).toBeVisible();
    await expect(outline).toHaveAccessibleName(`Empty reserve slot ${index + 1}`);
  }
  await page.locator("#storage .storage-slots").screenshot({ path: testInfo.outputPath("empty-reserve.png") });

  const tile = state.pools.mine.pop()!;
  state.players[0].storage.push(tile);
  await page.evaluate(({ key, state }) => localStorage.setItem(key, JSON.stringify(state)), { key: SAVE_KEY, state });
  await page.reload();
  await expect(slots.locator(".slot-label")).toHaveText([tileName(tile)]);
  await expect(slots.filter({ has: page.locator(".slot-outline") })).toHaveText(["", ""]);
});

test("larger market tiles keep regular hex proportions across viewport sizes", async ({ page }, testInfo) => {
  const state = position();
  state.players[0].storage.push(state.pools.ship.pop()!, state.pools.knowledge.pop()!);
  await openTable(page, state);

  for (const [width, height, marketSize] of [[1825, 900, 72], [1825, 768, 64], [1440, 900, 60], [1280, 720, 60], [390, 844, 72]]) {
    await page.setViewportSize({ width, height });
    for (const selector of ["#depots .tile-art", "#black-market .tile-art"]) {
      const sizes = await page.locator(selector).evaluateAll(tiles => tiles.map(tile => tile.getBoundingClientRect().width));
      expect(Math.min(...sizes), `${selector} at ${width}×${height}`).toBeGreaterThanOrEqual(marketSize);
    }
    for (const selector of ["#depots .tile-art", "#black-market .tile-art", "#storage .tile-art"]) {
      const tiles = page.locator(selector);
      expect(await tiles.count()).toBeGreaterThan(0);
      const proportions = await tiles.evaluateAll(elements => elements.map(element => {
        const { width, height } = element.getBoundingClientRect();
        // Shared square terrain SVGs draw a regular point-up hex at r=51
        // in a 106×106 viewBox; measure its visible width and height.
        return (width * Math.sqrt(3) * 51 / 106) / (height * 102 / 106);
      }));
      for (const ratio of proportions) {
        expect(ratio, `${selector} at ${width}×${height}`).toBeCloseTo(Math.sqrt(3) / 2, 2);
      }
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    if (width === 1825 && height === 768) await page.screenshot({ path: testInfo.outputPath("larger-market-desktop.png") });
    if (width === 1440) await page.screenshot({ path: testInfo.outputPath("tile-proportions-desktop.png") });
    if (width === 390) await page.screenshot({ path: testInfo.outputPath("tile-proportions-phone.png"), fullPage: true });
  }
  expect(await saved(page)).toEqual(state);
});

for (const viewport of [{ width: 1280, height: 720 }, { width: 390, height: 844 }, { width: 320, height: 740 }]) {
  test(`${viewport.width}px open market stations retain a 2×3 layout and permanent tile slots with one shared purchase price`, async ({ page }) => {
    const state = position();
    await page.setViewportSize(viewport);
    await openTable(page, state);
    const depots = page.locator("#depots .depot");
    await expect(depots.locator(".depot-heading .die-face")).toHaveCount(6);
    await expect(depots.locator(".depot-tiles")).toHaveCount(6);
    await expect(depots.locator(".depot-goods")).toHaveCount(6);
    await expect(page.locator(".market-card .tile-benefit")).toHaveCount(0);
    await expect(depots.locator(".empty-tile")).toHaveCount(0);
    const goods = await depots.locator(".depot-goods").allInnerTexts();
    const stocked = await depotBounds(page);
    for (let index = 0; index < stocked.length; index++) {
      await expect(depots.nth(index)).toHaveAccessibleName(`Depot ${index + 1}`);
      expect(stocked[index].surface).toEqual({ background: 'rgba(0, 0, 0, 0)', image: 'none', shadow: 'none', border: '0px' });
      expect(stocked[index].slots).toHaveLength(2);
      const [left, right] = stocked[index].slots;
      expect(Math.abs(left.y - right.y)).toBeLessThanOrEqual(1);
      expect(right.x).toBeGreaterThanOrEqual(left.x + left.width);
    }
    for (let row = 0; row < 3; row++) {
      const [left, right] = stocked.slice(row * 2, row * 2 + 2);
      expect(left.width).toBeGreaterThan(0);
      expect(left.height).toBeGreaterThan(0);
      expect(Math.abs(left.width - right.width)).toBeLessThanOrEqual(1);
      expect(Math.abs(left.y - right.y)).toBeLessThanOrEqual(1);
      expect(right.x).toBeGreaterThanOrEqual(left.x + left.width);
      expect(Math.abs(left.x - stocked[0].x)).toBeLessThanOrEqual(1);
      expect(Math.abs(right.x - stocked[1].x)).toBeLessThanOrEqual(1);
      if (row) expect(left.y).toBeGreaterThanOrEqual(stocked[(row - 1) * 2].y + stocked[(row - 1) * 2].height);
    }
    const shop = page.locator("#black-market");
    await expect(page.locator(".market-column > #black-market")).toHaveCount(1);
    await expect(shop.locator(".resource-amount")).toHaveCount(1);
    await expect(shop.locator(".black-heading .resource-amount")).toHaveText("2 silver");
    await expect(shop.locator(".target-cost")).toHaveCount(0);
    await expect(shop.locator(':scope > p')).toHaveCount(0);
    await expect(shop.locator('.black-tiles > .market-tile')).toHaveCount(4);
    await expect(shop.locator('.market-card[data-source="black"]')).toHaveCount(4);
    await expectQuietSupply(page);
    if (viewport.width >= 1280) {
      const shopBounds = (await shop.boundingBox())!;
      expect(shopBounds.x + shopBounds.width).toBeLessThanOrEqual((await page.locator(".estate-sheet").boundingBox())!.x);
    }
    for (const tile of state.black) {
      await expect(shop.locator(`[data-tile="${tile.id}"]`)).toHaveAccessibleName(/Buy for 2 silver/);
    }
    // Artwork carries the tile face, not a second framed card; labels fit.
    const tileLayout = await page.locator('.market-column .market-card').evaluateAll(cards => cards.map(card => {
      const style = getComputedStyle(card);
      const rect = card.getBoundingClientRect();
      const station = card.closest('.depot, #black-market')!.getBoundingClientRect();
      const art = card.querySelector('.tile-art')!.getBoundingClientRect();
      const label = card.querySelector('.tile-name')!.getBoundingClientRect();
      return {
        background: style.backgroundColor, shadow: style.boxShadow, border: style.borderWidth,
        largeEnough: rect.width >= 44 && rect.height >= 44,
        labelBelowArt: label.top >= art.bottom,
        contentsFit: [...card.children].every(child => {
          const bounds = child.getBoundingClientRect();
          // Flat faces and their labels stay inside the station. Animal
          // captions are checked separately against the interior hex edges.
          return bounds.left >= station.left && bounds.right <= station.right && bounds.bottom <= rect.bottom + 1
            && (child.classList.contains('tile-art') || child.scrollWidth <= child.clientWidth + 1);
        }),
      };
    }));
    for (const tile of tileLayout) {
      expect(tile).toEqual({ background: 'rgba(0, 0, 0, 0)', shadow: 'none', border: '0px', largeEnough: true, labelBelowArt: true, contentsFit: true });
    }
    expect(await saved(page)).toEqual(state);

    // Compare full -> partial -> empty -> restored without replaying take/buy/undo.
    const partial = structuredClone(state);
    for (const depot of partial.depots) {
      const tile = depot.tiles.pop()!;
      partial.pools[tile.color].push(tile);
    }
    const empty = structuredClone(state);
    for (const depot of empty.depots) {
      for (const tile of depot.tiles) empty.pools[tile.color].push(tile);
      depot.tiles = [];
    }
    for (const snapshot of [partial, empty, state]) {
      await page.evaluate(({ key, state }) => localStorage.setItem(key, JSON.stringify(state)), { key: SAVE_KEY, state: snapshot });
      await page.reload();
      await expect(depots).toHaveCount(6);
      await page.evaluate(() => document.fonts.ready);
      await expect(depots.filter({ has: page.locator(".market-card") })).toHaveCount(snapshot === empty ? 0 : 6);
      const bounds = await depotBounds(page);
      for (let index = 0; index < 6; index++) {
        expect(bounds[index].surface).toEqual(stocked[index].surface);
        expect(bounds[index].slots).toHaveLength(2);
        await expect(depots.nth(index).locator(".empty-tile")).toHaveCount(2 - snapshot.depots[index].tiles.length);
        for (const dimension of ["x", "y", "width", "height"] as const) {
          expect(Math.abs(bounds[index][dimension] - stocked[index][dimension]), `Depot ${index + 1} ${dimension}`).toBeLessThanOrEqual(1);
          for (let slot = 0; slot < 2; slot++) {
            expect(Math.abs(bounds[index].slots[slot][dimension] - stocked[index].slots[slot][dimension]), `Depot ${index + 1}, slot ${slot + 1} ${dimension}`).toBeLessThanOrEqual(1);
          }
        }
        expect(await depots.nth(index).locator('.depot-tiles [data-tile]').evaluateAll(tiles => tiles.map(tile => tile.getAttribute("data-tile"))))
          .toEqual(snapshot.depots[index].tiles.map(tile => tile.id));
      }
      expect(await depots.locator(".depot-goods").allInnerTexts()).toEqual(goods);
      await expectQuietSupply(page);
      if (snapshot === empty) await expect(depots.locator(".depot-cost")).toHaveCount(0);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      expect(await saved(page)).toEqual(snapshot);
    }
  });
}

for (const finished of [false, true]) {
  test(`phase rewards stay beneath exact letters in ${finished ? "completed" : "current"} games`, async ({ page }) => {
    const state = position();
    state.phase = finished ? 4 : 2;
    if (finished) {
      state.status = "finished";
      state.round = 4;
      state.players.forEach(player => { player.dice = [null, null]; });
      state.players[0].storage = [state.pools.mine.pop()!];
    }
    await openTable(page, state);
    if (finished) {
      await expect(page.getByRole("dialog")).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(page.getByRole("dialog")).not.toBeVisible();
      await expect(page.locator('#storage [data-source="storage"]')).toHaveJSProperty("disabled", true);
    }
    const track = page.locator("#season .progress-track.phase-track");
    const caption = page.getByText(`Region bonus · +${10 - state.phase * 2} VP`, { exact: true });
    await expect(caption).toHaveCount(1);
    const stops = track.locator(".phase-stop");
    await expect(stops).toHaveCount(5);
    await expect(stops.locator(".progress-step")).toHaveText([..."ABCDE"]);
    await expect(stops.locator(".phase-reward")).toHaveText(Array.from({ length: 5 }, (_, index) => `+${10 - index * 2}`));
    await expect(track.locator(".progress-step.past")).toHaveText(finished ? [..."ABCDE"] : ["A", "B"]);
    await expect(track.locator(".progress-step.current")).toHaveCount(finished ? 0 : 1);
    await expect(track.locator('.progress-step[aria-current="step"]')).toHaveCount(finished ? 0 : 1);
    if (!finished) await expect(track.locator('.progress-step[aria-current="step"]')).toHaveText("C");
    for (const viewport of [{ width: 1280, height: 720 }, { width: 390, height: 844 }]) {
      await page.setViewportSize(viewport);
      await expect(caption).toBeVisible();
      for (const stop of await stops.all()) {
        const letter = (await stop.locator(".progress-step").boundingBox())!;
        const reward = (await stop.locator(".phase-reward").boundingBox())!;
        expect(reward.y).toBeGreaterThanOrEqual(letter.y + letter.height - 1);
        expect(Math.abs(reward.x + reward.width / 2 - letter.x - letter.width / 2)).toBeLessThanOrEqual(1);
      }
    }
    expect(await saved(page)).toEqual(state);
  });
}
