import { expect, test, type Page } from "@playwright/test";
import { expectRestored } from "./undo-assertions";
import { createGame, legalActions, applyAction, actionKey } from "../src/engine";
import { BOARD } from "../src/data";
import type { State } from "../src/types";

const KEY = "burgundy-table.state.v1";
test.use({ reducedMotion: "reduce" });

function position(): State {
  const state = createGame(42);
  state.active = 0;
  state.order = [0, 1];
  state.turnIndex = 0;
  state.players[0].dice = [1, 2];
  state.players[0].workers = 2;
  state.players[0].silver = 1;
  return state;
}

async function openTable(page: Page, state = position(), width = 1440) {
  await page.setViewportSize({ width, height: width <= 600 ? 844 : 1000 });
  await page.addInitScript(({ key, state }) => {
    if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify(state));
  }, { key: KEY, state });
  await page.goto("/");
  await page.evaluate(() => document.fonts.ready);
  await expect(page.locator("#turn-controls")).toBeVisible();
}

async function saved(page: Page): Promise<State> {
  return page.evaluate(key => JSON.parse(localStorage.getItem(key)!), KEY);
}

for (const width of [320, 390]) {
  test(`01 compact phone controls keep Undo beside legal choices at ${width}px`, async ({ page }) => {
    await openTable(page, position(), width);
    const toolbar = (await page.locator("#turn-controls").boundingBox())!;
    const undo = (await page.locator('[data-ui="undo"]').boundingBox())!;
    const legal = (await page.locator("#legal-details > summary").boundingBox())!;
    expect(toolbar.height).toBeLessThan(260);
    expect(Math.abs(undo.y - legal.y)).toBeLessThan(6);
    expect(legal.x + legal.width).toBeLessThanOrEqual(undo.x);
    expect(undo.height).toBeGreaterThanOrEqual(44);
    await page.locator("#legal-details > summary").click();
    await expect(page.locator("#legal-actions button").first()).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}

test("02 empty phone reserve stays compact without repetitive instructions", async ({ page }) => {
  const state = position();
  await openTable(page, state, 390);
  await expect(page.locator("#storage .reserve-guidance")).toHaveCount(0);
  await expect(page.locator("#storage .slot-outline")).toHaveCount(3);
  const reserve = (await page.locator("#storage").boundingBox())!;
  const resources = (await page.locator("#resources").boundingBox())!;
  expect(resources.y + resources.height - reserve.y).toBeLessThan(205);
  // Goods now share the player card; the Market tab still jumps past it.
  await page.locator('.mobile-navigation [data-panel="market"]').click();
  await expect(page.locator("#depots .market-card").first()).toBeInViewport({ ratio: 1 });
  expect(await saved(page)).toEqual(state);
});

test("03 numbered market labels stay readable and retain their full accessible names", async ({ page }) => {
  await openTable(page);
  const knowledge = page.locator('#depots .market-card:has(.tile-name[data-short-label])').first();
  await expect(knowledge).toHaveAccessibleName(/Knowledge \d+/);
  for (const width of [1001, 1280, 1440, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    const label = knowledge.locator('.tile-name');
    const short = (await knowledge.boundingBox())!.width <= 76;
    await expect(label.locator('span')).toBeVisible({ visible: !short });
    if (short) expect(await label.evaluate(e => getComputedStyle(e, '::before').content)).toMatch(/K\. \d+/);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const geometry = await label.evaluate(e => ({ width:e.getBoundingClientRect().width, parent:e.parentElement!.getBoundingClientRect().width }));
    expect(geometry.width).toBeLessThanOrEqual(geometry.parent);
  }
  await knowledge.focus();
  await expect(page.locator('#market-tooltip strong')).toHaveText(/Knowledge \d+/);
});

test("04 black market explains availability before purchase and warns about full reserves", async ({ page }) => {
  const state = position();
  state.players[0].goods = [2, 0, 0, 0, 0, 0];
  await openTable(page, state);
  const status = page.locator('#black-market .purchase-status');
  await expect(status).toHaveText('Need 1 more silver · no die');
  await expect(status).toBeVisible();
  await page.locator('[data-good="1"]').click();
  await expect(status).toHaveCount(0);
  const before = await saved(page);
  const buy = legalActions(before).find(a => a.kind === 'buy' && before.black.some(tile => tile.id === a.tile))!;
  await page.locator(`#black-market [data-tile="${buy.tile}"]`).click();
  expect(await saved(page)).toEqual(applyAction(before, buy));
  await expect(status).toHaveText('Purchase used this turn');
  await expectRestored(page, before, () => page.locator('[data-ui="undo"]').click(), buy.label);
  await expect(status).toHaveCount(0);

  const full = position();
  full.players[0].storage = [full.pools.mine.pop()!, full.pools.castle.pop()!, full.pools.building.pop()!];
  await page.evaluate(({ key, state }) => localStorage.setItem(key, JSON.stringify(state)), { key:KEY, state:full });
  await page.reload();
  const tile = page.locator('#depots .action-target').first();
  await expect(tile).toHaveAccessibleName(/reserve full: choose a tile to replace/);
  await tile.click();
  await expect(page.locator('#modal-title')).toHaveText('Your reserve is full');
  await page.getByRole('button', { name: 'Back to table', exact: true }).click();
  expect(await saved(page)).toEqual(full);
});

test("05 goods preview exact gross rewards separately from worker payment", async ({ page }) => {
  const state = position();
  state.players[0].goods = [3, 0, 0, 0, 0, 0];
  state.players[0].dice = [2, 3];
  const cells = BOARD.filter(cell => cell.color === 'knowledge');
  for (const [index, knowledge] of [3, 4].entries()) {
    const sources = [...Object.values(state.pools), ...state.depots.map(depot => depot.tiles), state.black];
    const source = sources.find(tiles => tiles.some(tile => tile.knowledge === knowledge))!;
    state.players[0].board[cells[index].id] = source.splice(source.findIndex(tile => tile.knowledge === knowledge), 1)[0];
  }
  await openTable(page, state);
  const card = page.locator('[data-good="1"]');
  await expect(card.locator('.sale-quote')).toHaveCount(0);
  await expect(card).toHaveAttribute('title', 'Silk: +6 VP · +2 silver · +1 worker · Pay 1 worker');
  await page.locator('[data-mode="sell"]').click();
  await expect(page.locator('#modal .action-payout')).toHaveText('Earn +6 VP · +2 silver · +1 worker');
  await expect(page.locator('#modal .action-cost')).toHaveText('1 worker');
  const sale = legalActions(state).find(a => a.kind === 'sell' && a.die === 0)!;
  await page.locator('#modal [data-action]').click();
  expect(await saved(page)).toEqual(applyAction(state, sale));
  await expectRestored(page, state, () => page.locator('[data-ui="undo"]').click(), sale.label);
  await expect(page.locator('[data-good="1"]')).toHaveAttribute('title', 'Silk: +6 VP · +2 silver · +1 worker · Pay 1 worker');
});

test("06 bonus sales explain that dice and workers are preserved", async ({ page }) => {
  const state = position();
  state.pending = [{ kind:'sell' }];
  state.players[0].goods = [2, 0, 0, 0, 0, 0];
  await openTable(page, state, 390);
  await expect(page.locator('.die-step .step-label')).toContainText('No die needed');
  await page.locator('[data-mode="sell"]').click();
  await expect(page.locator('#modal .results-intro')).toContainText('No die or workers are spent');
  const sale = legalActions(state).find(a => a.kind === 'sell')!;
  await page.locator('#modal [data-action]').click();
  expect(await saved(page)).toEqual(applyAction(state, sale));
  expect((await saved(page)).players[0].dice).toEqual(state.players[0].dice);
  expect((await saved(page)).players[0].workers).toBe(state.players[0].workers);
});

test("06 restricted tile bonuses name their eligible tile types and destination", async ({ page }) => {
  const state = position();
  state.pending = [{ kind:'take', colors:['castle', 'mine', 'knowledge'] }];
  await openTable(page, state);
  await expect(page.locator('.target-step > p')).toHaveText('Bonus: take one castle, mine or knowledge tile from any numbered depot into your reserve. No die or workers spent.');
  const take = legalActions(state).find(a => a.kind === 'take')!;
  await page.locator(`#depots [data-tile="${take.tile}"]`).click();
  expect(await saved(page)).toEqual(applyAction(state, take));
  expect((await saved(page)).players[0].dice).toEqual(state.players[0].dice);
});

for (const scenario of ['none', 'purchase', 'worker trade'] as const) {
  test(`07 end-turn guidance offers only available extras: ${scenario}`, async ({ page }) => {
    const state = position();
    state.players[0].dice = [null, null];
    state.players[0].silver = scenario === 'purchase' ? 2 : 0;
    if (scenario === 'worker trade') {
      state.ruleset = 'special-edition';
      const sources = [...Object.values(state.pools), ...state.depots.map(depot => depot.tiles), state.black];
      const source = sources.find(tiles => tiles.some(tile => tile.knowledge === 6))!;
      state.players[0].board[BOARD.find(cell => cell.color === 'knowledge')!.id] = source.splice(source.findIndex(tile => tile.knowledge === 6), 1)[0];
      expect(legalActions(state).some(a => a.kind === 'trade')).toBe(true);
    }
    await openTable(page, state, 390);
    const target = page.locator('.target-step > p');
    await expect(page.locator('.turn-tools .end-turn')).toBeEnabled();
    if (scenario === 'none') await expect(target).toHaveText('No moves left. End your turn.');
    if (scenario === 'purchase') await expect(target).toHaveText('Optional: buy for 2 silver, then End turn.');
    if (scenario === 'worker trade') {
      await expect(target).toHaveText(/buildings · 2 workers · no die/);
      await expect(page.locator('.turn-hint')).not.toContainText(/buy/i);
    }
    expect(await saved(page)).toEqual(state);
  });
}

test("08 rival inspection cannot masquerade as your buildable estate", async ({ page }) => {
  const state = position();
  state.players[0].storage = [state.pools.ship.pop()!];
  state.players[0].workers = 6;
  expect(legalActions(state).some(a => a.kind === 'place')).toBe(true);
  await openTable(page, state);
  await page.locator('#storage [data-tile]').click();
  await expect(page.locator('#choices')).not.toBeEmpty();
  await page.locator('[data-view="1"]').click();
  await expect(page.locator('#estate-inspection')).toHaveCount(0);
  await expect(page.locator('#estate-title')).toHaveText('The Steward’s estate');
  await expect(page.locator('#estate-scoring-title')).toHaveText('The Steward’s scoring');
  await expect(page.locator('#storage .reserve-guidance')).toContainText('Read-only');
  await expect(page.locator('#choices')).toBeEmpty();
  await expect(page.locator('.target-step > p')).toContainText('build on your estate');
  expect(await saved(page)).toEqual(state);
  await page.locator('[data-view="0"]').click();
  await expect(page.locator('#estate-inspection')).not.toBeVisible();
  await expect(page.locator('#estate-scoring-title')).toHaveText('Estate scoring');
  await expect(page.locator('#choices')).not.toBeEmpty();
  expect(await saved(page)).toEqual(state);
});

test("09 legal choices are grouped by action without omitting any move or losing keyboard focus", async ({ page }) => {
  const state = position();
  state.players[0].storage = [state.pools.ship.pop()!];
  state.players[0].workers = 6;
  await openTable(page, state, 390);
  await page.locator('#legal-details > summary').focus();
  await page.keyboard.press('Enter');
  const expected = legalActions(state);
  await expect(page.locator('#legal-actions .legal-group')).toHaveCount(new Set(expected.map(a => a.kind)).size);
  const buttons = page.locator('#legal-actions [data-action-key]');
  expect((await buttons.evaluateAll(elements => elements.map(e => e.getAttribute('data-action-key')!))).sort())
    .toEqual(expected.map(actionKey).sort());
  const workers = expected.find(a => a.kind === 'workers' && a.die === 0)!;
  const button = page.locator(`#legal-actions [data-action-key=${JSON.stringify(actionKey(workers))}]`);
  await button.focus();
  await page.keyboard.press('Enter');
  expect(await saved(page)).toEqual(applyAction(state, workers));
  await expect(page.locator('#legal-details')).toHaveJSProperty('open', true);
  await expect(page.locator('#legal-actions button:focus')).toBeEnabled();
  await expectRestored(page, state, () => page.locator('[data-ui="undo"]').click(), workers.label);
});

test("10 harbor previews distinguish selectable cargo from a guaranteed load", async ({ page }) => {
  const state = position();
  state.pending = [{ kind:'ship' }];
  state.players[0].goods = [1, 1, 0, 0, 0, 0];
  state.depots.forEach(depot => { depot.goods = []; });
  state.depots[0].goods = [3, 3, 4];
  await openTable(page, state, 390);
  const harbor = page.locator('#modal .harbor-card').first();
  await expect(harbor.locator('.cargo-total')).toHaveText('Up to 2 goods');
  await expect(harbor.locator('.cargo-capacity')).toHaveText('Choose 1 new type; the rest stays here.');
  await expect(harbor).toHaveAccessibleName(/Up to 2 goods\. Choose 1 new type/);
  expect(await saved(page)).toEqual(state);
  const voyage = legalActions(state).find(a => a.kind === 'ship' && a.depots?.[0] === 0)!;
  await harbor.click();
  const afterVoyage = applyAction(state, voyage);
  expect(await saved(page)).toEqual(afterVoyage);
  const load = legalActions(afterVoyage).find(a => a.kind === 'goods' && a.types?.includes(3))!;
  await page.locator(`#modal [data-action-key=${JSON.stringify(actionKey(load))}]`).click();
  const afterLoad = await saved(page);
  expect(afterLoad).toEqual(applyAction(afterVoyage, load));
  expect(afterLoad.depots[0].goods).toEqual([4]);
  expect(afterLoad.players[0].goods).toEqual([1, 1, 2, 0, 0, 0]);
});

test("05 goods labels align while payment details stay in tooltips", async ({ page }) => {
  const state = position();
  state.players[0].goods = [1, 0, 0, 1, 0, 1];
  await openTable(page, state);
  const captions = await page.locator('#goods .cargo-name').evaluateAll(elements => elements.map(e => e.getBoundingClientRect().y));
  expect(Math.max(...captions) - Math.min(...captions)).toBeLessThan(1);
  await expect(page.locator('#goods .sale-quote, #goods .sale-cost')).toHaveCount(0);
  for (const goods of await page.locator('#goods .good-stack').all()) {
    await expect(goods).toHaveAttribute('title', /\+2 VP · \+1 silver/);
    await expect(goods).toHaveAccessibleName(/\+2 VP · \+1 silver/);
  }
});

test("03 short desktop keeps readable stations, all six reachable, and the shop in view", async ({ page }) => {
  await openTable(page, position(), 1280);
  await page.setViewportSize({ width:1280, height:720 });
  await expect(page.locator('#black-market')).toBeInViewport({ ratio:1 });
  await expect(page.locator('#board canvas')).toBeInViewport({ ratio:1 });
  await expect(page.locator('#depots')).toHaveCSS('overflow-y', 'visible');
  const tiles = page.locator('#depots .tile-name');
  for (const tile of await tiles.all()) expect(await tile.evaluate(e => e.scrollWidth <= e.clientWidth + 1)).toBe(true);
  const last = page.locator('#depots .depot').last();
  await last.scrollIntoViewIfNeeded();
  await expect(last).toBeInViewport({ ratio:1 });
  await expect(page.locator('#black-market')).toBeInViewport({ ratio:1 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
