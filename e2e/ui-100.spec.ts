import { expect, test, type Page } from "@playwright/test";
import { actionKey, applyAction, canPlace, createGame, legalActions } from "../src/engine";
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

test("001 unavailable actions remain focusable and explain how to recover without spending a die", async ({ page }) => {
  const state = position();
  await openTable(page, state);
  const build = page.locator('.quick-actions [data-mode="place"]');
  await expect(build).toBeDisabled();
  await expect(build).toHaveJSProperty('disabled', false);
  await build.focus();
  await expect(build).toBeFocused();
  await expect(page.locator('#market-tooltip')).toContainText('Take a market tile into your reserve before building.');
  await expect(build).toHaveAttribute('aria-describedby', 'market-tooltip');
  await page.keyboard.press('Enter');
  expect(await saved(page)).toEqual(state);
  await expect(page.locator('#announcer')).toContainText('before building');
  await page.keyboard.press('Escape');
  await expect(page.locator('#market-tooltip')).toBeHidden();
});

test("002 a blocked build offers the other legal die without spending it", async ({ page }) => {
  const state = position();
  const player = state.players[0];
  const tile = state.pools.building.find(tile => BOARD.some(cell => canPlace(player, tile, cell.id)))!;
  state.pools.building.splice(state.pools.building.indexOf(tile), 1);
  player.storage = [tile];
  player.workers = 0;
  const buildable = BOARD.filter(cell => canPlace(player, tile, cell.id)).map(cell => cell.die);
  player.dice = [Array.from({ length:6 }, (_, i) => i + 1).find(die => !buildable.includes(die))!, buildable[0]];
  expect(player.dice[0]).toBeDefined();
  await openTable(page, state);
  await page.locator('#storage [data-tile]').click();
  const switchDie = page.locator('#choices .switch-build-die');
  await expect(switchDie).toHaveText(`Use die 2 · ${player.dice[1]}`);
  await expect(page.locator('#choices .choice-hint')).toContainText('Your other die can build');
  await switchDie.click();
  await expect(page.locator('#turn-controls [data-die="1"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#choices .switch-build-die')).toHaveCount(0);
  await expect(page.locator('#choices .choice-hint')).toHaveText('Highlighted spaces: die 2 · no workers. Choose a hex, or use Build in All legal choices for keyboard placement.');
  expect(await saved(page)).toEqual(state);
});

test("003 Take recovers an unusable selected die without silently taking a tile", async ({ page }) => {
  const state = position();
  state.players[0].workers = 0;
  state.depots[0].tiles.forEach(tile => state.pools[tile.color].push(tile));
  state.depots[0].tiles = [];
  expect(legalActions(state).some(a => a.kind === 'take' && a.die === 0)).toBe(false);
  expect(legalActions(state).some(a => a.kind === 'take' && a.die === 1)).toBe(true);
  await openTable(page, state);
  const take = page.locator('.quick-actions [data-mode="take"]');
  await take.focus();
  await expect(page.locator('#market-tooltip')).toContainText('Switch to die 2 (2)');
  await take.click();
  await expect(page.locator('#turn-controls [data-die="1"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#depots .action-target').first()).toBeVisible();
  expect(await saved(page)).toEqual(state);
});

test("004 reserved tiles support keyboard inspection even on a rival estate", async ({ page }) => {
  const state = position();
  state.players[0].storage = [state.pools.mine.pop()!];
  state.players[1].storage = [state.pools.ship.pop()!];
  await openTable(page, state);
  await page.locator('#storage [data-tile]').focus();
  await expect(page.locator('#market-tooltip .tile-benefit')).toHaveText('Each phase end: +1 silver');
  await page.locator('[data-view="1"]').click();
  const tile = page.locator('#storage [data-tile]');
  await expect(tile).toBeDisabled();
  await expect(tile).toHaveJSProperty('disabled', false);
  await tile.focus();
  await expect(tile).toBeFocused();
  await expect(page.locator('#market-tooltip .tile-benefit')).toHaveText('Collect goods · improve turn order');
  await expect(page.locator('#market-tooltip .tile-prompt')).toContainText('Read-only reserve');
  await page.keyboard.press('Enter');
  expect(await saved(page)).toEqual(state);
  await expect(page.locator('#estate-title')).toHaveText('The Steward’s estate');
});

test("005 keyboard placement previews show exact immediate rewards without changing the save", async ({ page }) => {
  const state = position();
  const player = state.players[0];
  player.workers = 6;
  const source = [...Object.values(state.pools), ...state.depots.map(depot => depot.tiles), state.black]
    .find(tiles => tiles.some(tile => tile.building === 'watchtower'))!;
  player.storage = [source.splice(source.findIndex(tile => tile.building === 'watchtower'), 1)[0]];
  await openTable(page, state);
  const place = legalActions(state).find(a => a.kind === 'place')!;
  const expected = applyAction(state, place);
  await page.locator('#legal-details > summary').click();
  const button = page.locator(`#legal-actions [data-action-key=${JSON.stringify(actionKey(place))}]`);
  await button.focus();
  const points = expected.players[0].score - player.score;
  await expect(button).toHaveAttribute('title', new RegExp(`\\+${points} VP now`));
  await expect(page.locator('#announcer')).toContainText(`+${points} VP now`);
  expect(await saved(page)).toEqual(state);
  await page.keyboard.press('Enter');
  expect(await saved(page)).toEqual(expected);
});

test("006 legal build choices identify distinct board destinations", async ({ page }) => {
  const state = position();
  state.players[0].storage = [state.pools.ship.pop()!];
  state.players[0].workers = 6;
  await openTable(page, state);
  await page.locator('#legal-details > summary').click();
  const locations = page.locator('#legal-place + .legal-group-actions .action-location');
  const placements = legalActions(state).filter(a => a.kind === 'place');
  await expect(locations).toHaveCount(placements.length);
  const names = await locations.allTextContents();
  expect(new Set(names).size).toBe(new Set(placements.map(a => a.cell)).size);
  for (const label of names) expect(label).toMatch(/^Row \d+ · space \d+ · die [1-6]$/);
  expect(await saved(page)).toEqual(state);
});

test("007 full-reserve replacement shows the outgoing tile and its lost benefit", async ({ page }) => {
  const state = position();
  state.players[0].storage = [state.pools.mine.pop()!, state.pools.ship.pop()!, state.pools.castle.pop()!];
  await openTable(page, state);
  await page.locator('#depots .action-target').first().click();
  const choices = page.locator('#modal [data-action]');
  await expect(choices).toHaveCount(3);
  await expect(choices.locator('.replacement-loss')).toHaveText([
    'Give up Mine: Each phase end: +1 silver',
    'Give up Ship: Collect goods · improve turn order',
    'Give up Castle: Take a free action',
  ]);
  expect(await choices.locator(':scope > svg').evaluateAll(elements => new Set(elements.map(e => e.innerHTML)).size)).toBe(3);
  await page.getByRole('button', { name:'Back to table', exact:true }).click();
  expect(await saved(page)).toEqual(state);
});

test("008 skip links bypass chrome and reveal phone estate and keyboard choices", async ({ page }) => {
  const state = position();
  await openTable(page, state, 390);
  const links = page.getByRole('navigation', { name:'Skip to game section' });
  const turn = links.getByRole('link', { name:'Skip to turn controls', exact:true });
  await turn.focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('#turn-controls')).toBeFocused();
  const estate = links.getByRole('link', { name:'Skip to your estate', exact:true });
  await estate.focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('#app')).toHaveAttribute('data-panel', 'estate');
  await expect(page.locator('#estate')).toBeFocused();
  const legal = links.getByRole('link', { name:'Skip to legal choices', exact:true });
  await legal.focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('#legal-details')).toHaveJSProperty('open', true);
  await expect(page.locator('#legal-actions button:focus')).toBeVisible();
  expect(await saved(page)).toEqual(state);
});

test("009 Escape closes expanded legal choices and returns keyboard focus to their disclosure", async ({ page }) => {
  const state = position();
  await openTable(page, state);
  const summary = page.locator('#legal-details > summary');
  await summary.click();
  await page.locator('#legal-actions button').first().focus();
  await page.keyboard.press('Escape');
  await expect(page.locator('#legal-details')).toHaveJSProperty('open', false);
  await expect(summary).toBeFocused();
  expect(await saved(page)).toEqual(state);
});

test("010 save failure never claims progress is stored on this device", async ({ page }) => {
  await page.addInitScript(state => {
    const original = Storage.prototype.setItem;
    original.call(localStorage, 'burgundy-table.state.v1', JSON.stringify(state));
    Storage.prototype.setItem = function(key, value) {
      if (key === 'burgundy-table.state.v1') throw new DOMException('Storage unavailable', 'QuotaExceededError');
      return original.call(this, key, value);
    };
  }, position());
  await page.goto('/');
  await expect(page.locator('#notice')).toContainText('This table will not survive a reload');
  await expect(page.locator('.table-footer')).toContainText('Not saved · keep this tab open');
  await expect(page.locator('.table-footer')).not.toContainText('Saved on this device');
  await expect(page.locator('#save-status')).toHaveText('○ Not saved');
  await expect(page.locator('.quick-actions [data-mode="workers"]')).toBeEnabled();
});

test("011 a successful later save clears the obsolete storage warning", async ({ page }) => {
  await page.addInitScript(state => {
    const original = Storage.prototype.setItem;
    original.call(localStorage, 'burgundy-table.state.v1', JSON.stringify(state));
    let first = true;
    Storage.prototype.setItem = function(key, value) {
      if (key === 'burgundy-table.state.v1' && first) {
        first = false;
        throw new DOMException('Storage unavailable', 'QuotaExceededError');
      }
      return original.call(this, key, value);
    };
  }, position());
  await page.goto('/');
  await expect(page.locator('#notice')).toContainText('will not survive a reload');
  await page.locator('.quick-actions [data-mode="workers"]').click();
  await expect(page.locator('#notice')).toBeHidden();
  await expect(page.locator('.table-footer')).toContainText('Saved on this device');
  expect(await saved(page)).toBeTruthy();
});

test("012 the Burgundy home link reveals your estate instead of a hidden phone panel", async ({ page }) => {
  const state = position();
  await openTable(page, state, 390);
  await expect(page.locator('#app')).toHaveAttribute('data-panel', 'market');
  await page.getByRole('link', { name:'Burgundy, your estate', exact:true }).click();
  await expect(page.locator('#app')).toHaveAttribute('data-panel', 'estate');
  await expect(page.locator('#board canvas')).toBeVisible();
  await page.locator('[data-view="1"]').click();
  await page.getByRole('link', { name:'Burgundy, your estate', exact:true }).click();
  await expect(page.locator('#estate-title')).toHaveText('Your estate');
  await expect(page.locator('[data-view="0"]')).toHaveAttribute('aria-pressed', 'true');
  expect(await saved(page)).toEqual(state);
});
