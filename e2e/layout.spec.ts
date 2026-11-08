import { expect, test } from "@playwright/test";
import { BOARD } from "../src/data";
import { createGame } from "../src/engine";
import type { Tile } from "../src/types";

const KEY = "burgundy-table.state.v1";

function midgame() {
  const state = createGame(42);
  state.phase = 1;
  state.round = 4;
  state.active = 0;
  state.order = [0, 1];
  state.turnIndex = 0;
  const player = state.players[0];
  player.score = 29;
  state.players[1].score = 54;
  player.dice = [2, 2];
  player.silver = 0;
  player.workers = 1;
  player.ships = 2;
  player.goods = [0, 0, 0, 1, 3, 0];
  const sources = [...Object.values(state.pools), ...state.depots.map(d => d.tiles), state.black, state.blackPool];
  const take = (matches: (tile: Tile) => boolean) => {
    const source = sources.find(tiles => tiles.some(matches))!;
    return source.splice(source.findIndex(matches), 1)[0];
  };
  for (const color of ["castle", "ship", "building"] as const) {
    for (const cell of BOARD.filter(c => c.color === color && !player.board[c.id]).slice(0, 2)) {
      player.board[cell.id] = take(tile => tile.color === color);
    }
  }
  for (const [i, id] of [22, 4, 5].entries()) {
    player.board[BOARD.filter(c => c.color === "knowledge")[i].id] = take(tile => tile.knowledge === id);
  }
  player.storage = [take(tile => tile.color === "animal" && tile.count === 4), take(tile => tile.building === "boarding")];
  state.claimed.mine = [1];
  return state;
}

for (const viewport of [{ width: 1440, height: 900 }, { width: 1280, height: 720 }, { width: 1920, height: 1080 }, { width: 390, height: 844 }]) {
  test(`balanced midgame at ${viewport.width}px with native-size screenshots`, async ({ page }) => {
    const state = midgame();
    await page.setViewportSize(viewport);
    await page.addInitScript(({ key, state }) => localStorage.setItem(key, JSON.stringify(state)), { key: KEY, state });
    await page.goto("/");
    await expect(page.locator("#board canvas")).toBeAttached();
    await page.evaluate(() => document.fonts.ready);
    const phone = viewport.width <= 1000;
    if (phone) {
      await page.screenshot({ path: `.playwright-mcp/ui-refinement/market-${viewport.width}.png` });
      await page.locator('.mobile-navigation [data-panel="estate"]').click();
    }
    const canvas = page.locator("#board canvas");
    await expect(canvas).toBeVisible();
    await expect.poll(async () => {
      await page.mouse.move(0, 0);
      await canvas.hover();
      return page.locator("#board-tooltip").textContent();
    }).toContain("Take a free action");
    await page.locator("#estate-title").hover();
    if (!phone) await page.evaluate(() => scrollTo(0, 0));
    else {
      await page.locator('.mobile-navigation [data-panel="estate"]').click();
      await expect(canvas).toBeInViewport({ ratio: 0.95 });
      await expect(page.locator(".target-step")).toContainText("Market");
    }
    await page.screenshot({ path: `.playwright-mcp/ui-refinement/estate-${viewport.width}.png` });
    await page.screenshot({ path: `.playwright-mcp/ui-refinement/full-${viewport.width}.png`, fullPage: true });
    const metrics = await page.evaluate(() => {
      const bounds = (selector: string) => {
        const r = document.querySelector(selector)!.getBoundingClientRect();
        return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom };
      };
      return { viewport: [innerWidth, innerHeight], zoom: getComputedStyle(document.body).zoom, scale: visualViewport!.scale, overflow: document.documentElement.scrollWidth > innerWidth,
        board: bounds("#board"), map: bounds(".map-sheet"), sheet: bounds(".estate-sheet"), scoring: bounds("#estate-scoring"), market: bounds(".market-column"), player: bounds(".player-column"), regions: bounds(".region-panel"), legend: bounds("#color-ledger") };
    });
    console.log(JSON.stringify(metrics));
    expect(metrics.overflow).toBe(false);
    expect(metrics.scale).toBe(1);
    await expect(page.locator('[data-ui="help"]')).toHaveCount(1);
    await expect(page.locator("#estate-knowledge h3")).toHaveText("Your advantages");
    await expect(page.locator(".reserve-panel > #goods ~ #estate-knowledge")).toHaveCount(1);
    for (const selector of [".estate-sheet", "#estate-scoring"]) {
      expect(await page.locator(selector).evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    }
    if (!phone) {
      await expect(page.locator(".player-column > #goods + #estate-scoring")).toHaveCount(1);
      expect(metrics.map.right).toBeLessThanOrEqual(metrics.scoring.x + 1);
      expect(metrics.scoring.width).toBeLessThan(metrics.map.width);
      expect(metrics.scoring.x).toBeGreaterThanOrEqual(metrics.player.x);
      expect(metrics.scoring.right).toBeLessThanOrEqual(metrics.player.right);
      await expect(page.locator(".player-column > #estate-knowledge")).toBeVisible();
      expect(metrics.board.width).toBeGreaterThanOrEqual(viewport.width === 1280 ? 380 : 490);
      expect(metrics.sheet.bottom).toBeLessThanOrEqual(viewport.height);
      expect(metrics.player.bottom).toBeLessThanOrEqual(viewport.height);
      expect(metrics.market.bottom).toBeLessThanOrEqual(viewport.height);
      // Full labels and counts must not overlap, even in the shortest desktop view.
      for (const card of await page.locator('#goods .good-stack').all()) {
        const label = (await card.locator('.cargo-name').boundingBox())!;
        const count = (await card.locator('.cargo-count').boundingBox())!;
        const box = (await card.boundingBox())!;
        expect(count.y + count.height).toBeLessThanOrEqual(label.y);
        expect(label.x).toBeGreaterThanOrEqual(box.x);
        expect(label.x + label.width).toBeLessThanOrEqual(box.x + box.width);
      }
    } else {
      await expect(page.locator(".estate-sheet > #estate-scoring")).toHaveCount(1);
      expect(metrics.scoring.y).toBeGreaterThanOrEqual(metrics.map.bottom - 1);
      await page.locator('[data-mode="take"]').click();
      await expect(page.locator('.mobile-navigation [data-panel="market"]')).toHaveAttribute('aria-pressed', 'true');
      await expect(page.locator('#depots')).toBeVisible();
    }
    expect(await page.evaluate(key => JSON.parse(localStorage.getItem(key)!), KEY)).toEqual(state);
  });
}
