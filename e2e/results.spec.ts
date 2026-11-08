import { expect, test } from '@playwright/test';
import { createGame } from '../src/engine';

test('final ledger highlights each category leader and crowns only the victor', async ({ page }, testInfo) => {
  const state = createGame(42);
  state.status = 'finished';
  state.winner = 1;
  state.players[0].score = 112;
  state.players[0].final = { goods: 4, silver: 2, workers: 1, knowledge: 8 };
  state.players[1].score = 170;
  state.players[1].final = { goods: 2, silver: 6, workers: 2, knowledge: 30 };
  await page.addInitScript(state => localStorage.setItem('burgundy-table.state.v1', JSON.stringify(state)), state);
  await page.goto('/');
  await page.evaluate(() => document.fonts.ready);
  const dialog = page.getByRole('dialog');
  const players = dialog.locator('.result-player');
  await expect(dialog).toBeVisible();
  await expect(players.locator('dt svg[aria-hidden="true"]')).toHaveCount(10);
  await expect(players.locator('.winner-crown svg')).toHaveCount(1);
  await expect(players.nth(1).locator('.winner-crown')).toBeVisible();
  await expect(players.locator('.final-score.score-leader')).toHaveText('170victory points');

  const categories = ['estate', 'goods', 'silver', 'workers', 'knowledge'];
  const scores = [['97', '+4', '+2', '+1', '+8'], ['130', '+2', '+6', '+2', '+30']];
  for (let player = 0; player < 2; player++) {
    await expect(players.nth(player).locator('.result-score-value')).toHaveText(scores[player]);
    for (const category of categories) {
      const row = players.nth(player).locator(`[data-score-item="${category}"]`);
      const leading = category === 'goods' ? player === 0 : player === 1;
      if (leading) {
        await expect(row).toHaveClass('score-leader');
        await expect(row.locator('.score-lead-label')).toHaveText('Best');
      } else {
        await expect(row).not.toHaveClass('score-leader');
        await expect(row.locator('.score-lead-label')).toHaveCount(0);
      }
    }
  }

  for (const width of [1440, 768, 601, 390, 320]) {
    await page.setViewportSize({ width, height: width === 1440 ? 1000 : 844 });
    expect(await dialog.locator('.results-players, .result-player, dl > div').evaluateAll(nodes =>
      nodes.every(node => node.scrollWidth <= node.clientWidth + 1))).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    if (width > 600) {
      for (const category of categories) {
        const first = (await players.nth(0).locator(`[data-score-item="${category}"]`).boundingBox())!;
        const second = (await players.nth(1).locator(`[data-score-item="${category}"]`).boundingBox())!;
        expect(Math.abs(first.y - second.y)).toBeLessThanOrEqual(1);
        expect(Math.abs(first.height - second.height)).toBeLessThanOrEqual(1);
      }
    }
    if (width === 1440 || width === 390) {
      await dialog.screenshot({ path: testInfo.outputPath(`final-ledger-${width}.png`) });
      if (width === 390) {
        await players.nth(1).scrollIntoViewIfNeeded();
        await expect(players.nth(1).locator('.winner-crown')).toBeInViewport();
        await dialog.screenshot({ path: testInfo.outputPath('final-ledger-winner-390.png') });
      }
    }
  }

  await dialog.getByRole('button', { name: 'Inspect the estates' }).click();
  await expect(dialog).not.toBeVisible();
  await page.getByRole('button', { name: 'View final scores' }).click();
  await expect(players.locator('.winner-crown svg')).toHaveCount(1);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('burgundy-table.state.v1')!))).toEqual(state);
});
