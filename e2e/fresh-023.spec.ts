import { expect, test } from "@playwright/test";
import { createGame } from "../src/engine";

test.use({ viewport: { width: 1280, height: 480 }, reducedMotion: "reduce" });

test("focused tooltips clear adjacent controls and Escape preserves focus on a short viewport", async ({ page }) => {
  const state = createGame(42);
  state.active = 0;
  state.order = [0, 1];
  state.turnIndex = 0;
  state.players[0].dice = [1, 4];
  const sources = [...state.depots.map(depot => depot.tiles), state.black, ...Object.values(state.pools)];
  const source = sources.find(tiles => tiles.some(tile => tile.knowledge === 18))!;
  const index = source.findIndex(tile => tile.knowledge === 18);
  const knowledge = source[index];
  source[index] = state.depots[1].tiles[1];
  state.depots[1].tiles[1] = knowledge;
  await page.addInitScript(state => {
    localStorage.setItem("burgundy-table.state.v1", JSON.stringify(state));
  }, state);
  await page.goto("/");
  await page.evaluate(() => document.fonts.ready);

  const tooltip = page.locator("#market-tooltip");
  for (const anchor of [page.locator('.quick-actions [data-mode="place"]'), page.locator(`#depots [data-tile="${knowledge.id}"]`)]) {
    await anchor.focus();
    await expect(anchor).toBeFocused();
    await expect(anchor).toHaveAttribute("aria-describedby", "market-tooltip");
    await expect(tooltip).toBeVisible();
    await expect(tooltip).toHaveAttribute("role", "tooltip");
    await page.mouse.move(1270, 470);
    await expect(tooltip).toBeVisible();
    const overlaps = await tooltip.evaluate(element => {
      const tip = element.getBoundingClientRect();
      return [...document.querySelectorAll<HTMLElement>(".quick-actions button, .estate-switch button, #depots summary, #black-market button")]
        .filter(control => {
          const rect = control.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0 && rect.left < tip.right && rect.right > tip.left && rect.top < tip.bottom && rect.bottom > tip.top;
        }).map(control => control.textContent!.trim());
    });
    expect(overlaps).toEqual([]);
    const bounds = (await tooltip.boundingBox())!;
    expect(bounds.x).toBeGreaterThanOrEqual(8);
    expect(bounds.y).toBeGreaterThanOrEqual(8);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(1272);
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(472);
    await page.keyboard.press("Escape");
    await expect(tooltip).toBeHidden();
    await expect(anchor).toBeFocused();
    await expect(anchor).not.toHaveAttribute("aria-describedby");
  }
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("burgundy-table.state.v1")!))).toEqual(state);
});
