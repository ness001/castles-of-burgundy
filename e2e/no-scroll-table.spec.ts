import { expect, test, type Page } from "@playwright/test";
import { expectRestored } from "./undo-assertions";
import { boardFor } from "../src/boards";
import { applyAction, createGame, legalActions } from "../src/engine";
import type { State, Tile } from "../src/types";

const KEY = "burgundy-table.state.v1";
test.use({ reducedMotion: "reduce" });

function position(players: 2 | 4 = 2): State {
  const state = createGame(42, { playerCount: players });
  state.active = 0;
  state.order = state.players.map((_, index) => index);
  state.turnIndex = 0;
  state.phase = 3;
  state.round = 4;
  const player = state.players[0];
  player.dice = [1, 2];
  player.workers = 2;
  player.goods = [2, 1, 3, 0, 0, 0];
  const sources = [...Object.values(state.pools), ...state.depots.map(depot => depot.tiles), state.black, state.blackPool];
  const take = (matches: (tile: Tile) => boolean): Tile => {
    const source = sources.find(tiles => tiles.some(matches))!;
    return source.splice(source.findIndex(matches), 1)[0];
  };
  for (const id of [2, 3, 5]) {
    const cell = boardFor(player).find(cell => cell.color === "knowledge" && !player.board[cell.id])!;
    player.board[cell.id] = take(tile => tile.knowledge === id);
  }
  player.storage = [take(tile => tile.color === "mine"), take(tile => tile.color === "ship"), take(tile => tile.color === "castle")];
  return state;
}

async function open(page: Page, state: State) {
  await page.addInitScript(({ key, state }) => localStorage.setItem(key, JSON.stringify(state)), { key: KEY, state });
  await page.goto("/");
  await page.evaluate(() => document.fonts.ready);
  await expect(page.locator("#board canvas")).toBeAttached();
}

for (const [width, height, players] of [[1825, 768, 2], [1440, 900, 2], [1280, 720, 2], [1440, 900, 4]] as const) {
  test(`${players} players at ${width}×${height}: the complete play surface needs no scrolling`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height });
    await open(page, position(players));
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollHeight)).toBeLessThanOrEqual(height + 1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    for (const selector of ["#depots", "#black-market", ".reserve-panel", "#goods", "#estate-knowledge", "#board canvas", "#table-details > summary", ".map-sheet > .estate-heading"]) {
      await expect(page.locator(selector)).toBeInViewport({ ratio: 1 });
    }
    for (const selector of [".market-column", "#depots", ".player-column"]) {
      await expect(page.locator(selector)).toHaveCSS("overflow-y", "visible");
    }
    expect(await page.locator('.market-column .tile-name').evaluateAll(labels => labels.every(label => {
      const rect = label.getBoundingClientRect();
      const card = label.closest('.market-card')!.getBoundingClientRect();
      return label.scrollWidth <= label.clientWidth + 1 && rect.left >= card.left - 1 && rect.right <= card.right + 1;
    }))).toBe(true);
    await expect(page.locator("#depots .depot")).toHaveCount(6);
    await expect(page.locator(".worker-payment, #goods .sale-quote")).toHaveCount(0);
    await expect(page.locator("#estate-details")).not.toHaveAttribute("open");
    expect((await page.locator("#board canvas").boundingBox())!.width).toBeGreaterThan(350);
    await page.screenshot({ path: testInfo.outputPath(`table-${width}-${players}p.png`) });
  });
}

test("table details stay accessible; clean goods retain exact rewards and gameplay", async ({ page }) => {
  const state = position();
  await page.setViewportSize({ width: 1280, height: 720 });
  await open(page, state);
  const summary = page.locator("#estate-details > summary");
  await expect(page.locator(".reserve-panel > #goods + #estate-knowledge")).toBeVisible();
  await expect(page.locator("#estate-details #estate-knowledge")).toHaveCount(0);
  await expect(page.locator("#advantages-title")).toHaveText("Your advantages");
  const goodsBox = (await page.locator("#goods").boundingBox())!;
  const advantagesBox = (await page.locator("#estate-knowledge").boundingBox())!;
  expect(advantagesBox.y).toBeGreaterThanOrEqual(goodsBox.y + goodsBox.height);
  await expect(page.locator("#estate-knowledge button")).toHaveCount(3);
  await page.locator('#estate-knowledge button').first().click();
  await expect(page.getByRole('dialog', { name: 'An acquired advantage' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('#estate-knowledge button').first()).toBeFocused();
  await page.locator("#table-details > summary").click();
  await summary.click();
  await expect(page.locator("#estate-scoring")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(summary).toBeFocused();
  await expect(page.locator("#estate-details")).not.toHaveAttribute("open");
  await page.keyboard.press("Escape");
  await expect(page.locator("#table-details > summary")).toBeFocused();
  await page.locator('.phase-goods-disclosure > summary').click();
  await expect(page.locator('#phase-goods')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollHeight <= innerHeight + 1)).toBe(true);
  await page.locator('.phase-goods-disclosure > summary').click();
  const sale = legalActions(state).find(action => action.kind === "sell" && action.good === 1 && action.die === 0)!;
  const goods = page.locator('#goods [data-good="1"]');
  await expect(goods).toHaveAttribute("title", /\+4 VP · \+2 silver · No worker cost/);
  await goods.click();
  expect(await page.evaluate(key => JSON.parse(localStorage.getItem(key)!), KEY)).toEqual(applyAction(state, sale));
  await expectRestored(page, state, () => page.locator('[data-ui="undo"]').click(), sale.label);
});

test("phone keeps all sections reachable without horizontal overflow or empty reserve hints", async ({ page }) => {
  const state = position();
  state.players[0].storage = [];
  await page.setViewportSize({ width: 390, height: 844 });
  await open(page, state);
  await expect(page.locator(".reserve-panel > #goods + #estate-knowledge")).toBeVisible();
  await expect(page.locator("#storage .reserve-guidance, .worker-payment, #goods .sale-quote")).toHaveCount(0);
  await page.locator('.mobile-navigation [data-panel="estate"]').click();
  await page.locator("#table-details > summary").click();
  await page.locator("#estate-details > summary").click();
  await expect(page.locator("#table-details > .estate-tools")).toBeInViewport({ ratio: 1 });
  await expect(page.locator("#estate-scoring")).toBeVisible();
  await expect(page.locator("#estate-knowledge")).toBeVisible();
  await expect(page.locator("#estate-details #estate-knowledge")).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.keyboard.press("Escape");
  expect(await page.evaluate(key => JSON.parse(localStorage.getItem(key)!), KEY)).toEqual(state);
});
