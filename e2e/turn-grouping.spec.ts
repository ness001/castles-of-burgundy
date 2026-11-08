import { expect, test } from '@playwright/test';
import { expectRestored } from './undo-assertions';
import { createGame, legalActions, applyAction } from '../src/engine';
import { boardFor } from '../src/boards';

test('bonus decline aligns with Undo across desktop and phone widths', async ({ page }, testInfo) => {
  const state = createGame(42);
  state.active = 0; state.order = [0, 1]; state.turnIndex = 0;
  state.players[0].dice = [null, null];
  state.pending = [{ kind: 'sell' }];
  await page.addInitScript(state => localStorage.setItem('burgundy-table.state.v1', JSON.stringify(state)), state);
  await page.goto('/');
  await page.evaluate(() => document.fonts.ready);
  const commands = page.getByRole('group', { name: 'Turn actions', exact: true });
  const undo = commands.locator('[data-ui="undo"]');
  const decline = commands.getByRole('button', { name: 'Decline Warehouse sale', exact: true });
  for (const width of [1440, 1280, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(undo).toBeVisible();
    await expect(decline).toBeVisible();
    const undoBox = (await undo.boundingBox())!;
    const declineBox = (await decline.boundingBox())!;
    expect(Math.abs(undoBox.y - declineBox.y)).toBeLessThanOrEqual(1);
    expect(Math.abs(undoBox.height - declineBox.height)).toBeLessThanOrEqual(1);
    expect(declineBox.height).toBeGreaterThanOrEqual(44);
    expect(undoBox.x + undoBox.width).toBeLessThanOrEqual(declineBox.x);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    if (width === 1440 || width === 390) await commands.screenshot({ path: testInfo.outputPath(`bonus-controls-${width}.png`) });
  }
  const skip = legalActions(state).find(action => action.kind === 'skip')!;
  await decline.click();
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('burgundy-table.state.v1')!))).toEqual(applyAction(state, skip));
  await expectRestored(page, state, () => undo.click(), skip.label);
});

test('depot purchase toggle stays readable on the parchment market', async ({ page }, testInfo) => {
  const state = createGame(42);
  state.active = 0; state.order = [0, 1]; state.turnIndex = 0;
  state.purchased = true;
  const knowledgeCell = boardFor(state.players[0]).find(cell => cell.color === 'knowledge')!;
  state.players[0].board[knowledgeCell.id] = { id: 'test-knowledge-6', color: 'knowledge', knowledge: 6 };
  await page.addInitScript(state => localStorage.setItem('burgundy-table.state.v1', JSON.stringify(state)), state);
  await page.goto('/');
  await page.evaluate(() => document.fonts.ready);
  const market = page.locator('#black-market');
  const toggle = market.getByRole('button', { name: 'Buy from any depot' });
  const lightText = await market.evaluate(element => getComputedStyle(element).color);
  const darkText = await page.locator('body').evaluate(element => getComputedStyle(element).color);
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await toggle.scrollIntoViewIfNeeded();
    await page.mouse.move(0, 0);
    await expect(toggle).toHaveCSS('color', lightText);
    await market.screenshot({ path: testInfo.outputPath(`market-toggle-${width}.png`) });
    await toggle.hover();
    await expect(toggle).toHaveCSS('color', darkText);
    await page.mouse.move(0, 0);
    await page.keyboard.press('Tab');
    await toggle.focus();
    await expect(toggle).toHaveCSS('outline-color', 'rgb(128, 59, 76)');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('burgundy-table.state.v1')!))).toEqual(state);
});

test('Undo is a visible turn-action button beside End turn, not part of the heading', async ({ page }, testInfo) => {
  const state = createGame(42);
  state.active = 0; state.order = [0, 1]; state.turnIndex = 0;
  state.players[0].dice = [1, 2];
  await page.addInitScript(state => localStorage.setItem('burgundy-table.state.v1', JSON.stringify(state)), state);
  await page.goto('/');
  await page.evaluate(() => document.fonts.ready);
  const commands = page.getByRole('group', { name: 'Turn actions', exact: true });
  const undo = commands.locator('[data-ui="undo"]');
  await expect(undo).toBeDisabled();
  await expect(page.locator('.turn-heading [data-ui="undo"], .quick-actions [data-ui="undo"]')).toHaveCount(0);
  await expect(undo).toHaveAttribute('aria-keyshortcuts', 'z Control+z Meta+z');
  for (const width of [1440, 1280, 1001, 1000, 600, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(undo).toBeVisible();
    expect((await undo.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
  await page.locator('[data-mode="workers"]').click();
  await expect(undo).toBeEnabled();
  await expectRestored(page, state, () => undo.click());
  await page.keyboard.press('4');
  await page.keyboard.press('4');
  const end = commands.locator('.end-turn');
  await expect(end).toBeEnabled();
  for (const width of [1440, 1280, 1001, 1000, 600, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(undo).toBeVisible();
    await expect(end).toBeVisible();
    const undoBox = (await undo.boundingBox())!;
    const endBox = (await end.boundingBox())!;
    expect(undoBox.x + undoBox.width).toBeLessThanOrEqual(endBox.x);
    expect(Math.abs(undoBox.y - endBox.y)).toBeLessThanOrEqual(1);
    expect(Math.abs(undoBox.height - endBox.height)).toBeLessThanOrEqual(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    if (width === 1440 || width === 390) await page.locator('#turn-controls').screenshot({ path: testInfo.outputPath(`undo-placement-${width}.png`) });
  }
  await expect(commands.locator('kbd')).toHaveCount(0);
  await page.keyboard.press('z');
  await expect(end).toHaveCount(0);
  await expect(undo).toBeEnabled();
});

for (const width of [1440, 1280, 390]) {
  test(`turn utilities and market purchase remain usable at ${width}px`, async ({ page }) => {
    const state = createGame(42);
    state.active = 0; state.order = [0, 1]; state.turnIndex = 0;
    state.players[0].dice = [1, 2]; state.players[0].silver = 4;
    await page.setViewportSize({ width, height: width === 1280 ? 720 : width === 390 ? 844 : 900 });
    await page.addInitScript(state => localStorage.setItem('burgundy-table.state.v1', JSON.stringify(state)), state);
    await page.goto('/');
    await expect(page.locator('#board canvas')).toBeAttached();
    await page.evaluate(() => document.fonts.ready);
    await expect(page.locator('#turn-controls [data-ui="undo"]')).toBeVisible();
    await expect(page.locator('#turn-controls #legal-details')).toHaveCount(1);
    await expect(page.locator('.market-column > #black-market')).toHaveCount(1);
    await expect(page.locator('.player-column #black-market, .masthead [data-ui="undo"]')).toHaveCount(0);
    await page.screenshot({ path: `.playwright-mcp/turn-grouping-${width}.png`, fullPage: true });
    if (width > 1000) {
      expect(await page.locator('#depots').evaluate(element => [...element.querySelectorAll('.depot')].every(depot => {
        const bounds = depot.getBoundingClientRect();
        return [...depot.querySelectorAll('.market-card')].every(card => card.getBoundingClientRect().bottom <= bounds.bottom + 1);
      }))).toBe(true);
      await page.locator('.depot').last().scrollIntoViewIfNeeded();
      await expect(page.locator('.depot').last()).toBeInViewport({ ratio: 1 });
      await expect(page.locator('#black-market')).toBeInViewport({ ratio: 1 });
      await page.screenshot({ path: `.playwright-mcp/turn-market-scrolled-${width}.png` });
    }
    const toggle = page.locator('#legal-details > summary');
    await toggle.focus(); await page.keyboard.press('Enter');
    await expect(page.locator('#legal-actions button').first()).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: `.playwright-mcp/turn-choices-${width}.png` });
    const workers = legalActions(state).find(a => a.kind === 'workers' && a.die === 0)!;
    await page.locator('#legal-actions button').filter({ hasText: workers.label }).first().click();
    await expect(page.locator('#legal-details')).toHaveJSProperty('open', true);
    const restored = await expectRestored(page, state, () => page.locator('#turn-controls [data-ui="undo"]').click(), workers.label);
    await toggle.click();
    const purchase = legalActions(restored).find(a => a.kind === 'buy' && restored.black.some(t => t.id === a.tile))!;
    await page.locator(`#black-market [data-tile="${purchase.tile}"]`).click();
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('burgundy-table.state.v1')!))).toEqual(applyAction(restored, purchase));
    await expectRestored(page, restored, () => page.locator('#turn-controls [data-ui="undo"]').click(), purchase.label);
    if (width === 390) {
      await page.locator('.mobile-navigation [data-panel="estate"]').click();
      await toggle.click();
      await expect(page.locator('#legal-actions button').first()).toBeVisible();
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}
