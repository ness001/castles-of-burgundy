import { expect, test } from "@playwright/test";
import { createGame } from "../src/engine";

test.use({ reducedMotion: "reduce" });

test("estate tooltips clear on canvas exit and keyboard owner changes", async ({ page }) => {
  const state = createGame(42);
  state.active = 0;
  state.order = [0, 1];
  state.turnIndex = 0;
  await page.addInitScript(state => {
    localStorage.setItem("burgundy-table.state.v1", JSON.stringify(state));
  }, state);
  await page.goto("/");
  await page.evaluate(() => document.fonts.ready);
  const canvas = page.locator("#board canvas");
  const tooltip = page.locator("#board-tooltip");
  await expect.poll(async () => {
    await page.mouse.move(0, 0);
    await canvas.hover();
    return tooltip.textContent();
  }).toContain("Take a free action");

  await page.mouse.move(0, 0);
  await expect(tooltip).toBeEmpty();
  await expect.poll(async () => {
    await page.mouse.move(0, 0);
    await canvas.hover();
    return tooltip.textContent();
  }).toContain("Take a free action");
  await page.locator('[data-view="1"]').focus();
  await page.keyboard.press("Enter");
  await expect(tooltip).toBeEmpty();
  await expect(page.locator("#estate-view-status")).toBeVisible();
  await expect(page.locator("#estate-title")).toHaveText("The Steward’s estate");
  await page.locator('[data-view="0"]').focus();
  await page.keyboard.press("Enter");
  await expect(tooltip).toBeEmpty();
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("burgundy-table.state.v1")!))).toEqual(state);
});
