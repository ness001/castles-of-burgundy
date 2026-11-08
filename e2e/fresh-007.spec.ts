import { expect, test } from "@playwright/test";
import { createGame } from "../src/engine";

test.use({ reducedMotion: "reduce" });

test("dialog dismissal returns to a live opener or the pending bonus control", async ({ page }) => {
  const state = createGame(42);
  state.active = 0;
  state.order = [0, 1];
  state.turnIndex = 0;
  state.players[0].dice = [1, 2];
  state.players[0].goods = [1, 1, 0, 0, 0, 0];
  state.pending = [{ kind: "ship" }];
  state.depots[0].goods = [3, 4];
  await page.addInitScript(state => {
    localStorage.setItem("burgundy-table.state.v1", JSON.stringify(state));
  }, state);
  await page.goto("/");

  const dialog = page.locator("#modal");
  const resume = page.locator('[data-ui="resume-bonus"]');
  await expect(dialog).toHaveAccessibleName("Choose a harbor");
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
  await expect(resume).toBeFocused();

  await page.keyboard.press("Enter");
  await dialog.locator(".harbor-card").filter({ hasText: "Harbor 1" }).click();
  await expect(dialog).toHaveAccessibleName("Choose your cargo");
  await dialog.getByRole("button", { name: "Back to table · bonus stays pending", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(resume).toBeFocused();
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("burgundy-table.state.v1")!).players[0].goods))
    .toEqual(state.players[0].goods);

  await page.keyboard.press("Enter");
  await dialog.locator(".harbor-card").first().click();
  await expect(dialog).not.toBeVisible();
  await expect(page.locator('#turn-controls [data-die="0"]')).toBeFocused();

  const sell = page.locator('.quick-actions [data-mode="sell"]');
  await sell.focus();
  await page.keyboard.press("Enter");
  await expect(dialog).toHaveAccessibleName("Sell a goods type");
  await page.keyboard.press("Escape");
  await expect(sell).toBeFocused();

  const guide = page.locator('[data-ui="help"]');
  await guide.focus();
  await page.keyboard.press("Enter");
  await dialog.locator('[data-ui="shortcuts"]').click();
  await page.keyboard.press("Escape");
  await expect(guide).toBeFocused();
});
