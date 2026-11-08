import { expect, test } from "@playwright/test";
import { createGame } from "../src/engine";

test.use({ viewport: { width: 320, height: 844 }, reducedMotion: "reduce" });

test("320px skip links reveal their targets and retain usable focus when legal choices are empty", async ({ page }) => {
  const state = createGame(42);
  state.active = 0;
  state.order = [0, 1];
  state.turnIndex = 0;
  state.players[0].dice = [1, 2];
  await page.addInitScript(state => {
    const key = "burgundy-table.state.v1";
    if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify(state));
  }, state);
  await page.goto("/");
  await page.evaluate(() => document.fonts.ready);

  await expect(page.locator("#estate")).toBeHidden();
  await page.getByRole("link", { name: "Skip to your estate", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("#app")).toHaveAttribute("data-panel", "estate");
  await expect(page.locator("#estate")).toBeVisible();
  await expect(page.locator("#estate")).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.locator('[data-view="0"]')).toBeFocused();
  await expect(page.locator('[data-view="0"]')).toBeInViewport({ ratio: 1 });

  await page.getByRole("link", { name: "Skip to turn controls", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("#turn-controls")).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.locator('#turn-controls [data-die="0"]')).toBeFocused();
  await expect(page.locator('#turn-controls [data-die="0"]')).toBeInViewport({ ratio: 1 });

  const legalLink = page.getByRole("link", { name: "Skip to legal choices", exact: true });
  const details = page.locator("#legal-details");
  await legalLink.focus();
  await page.keyboard.press("Enter");
  await expect(details).toHaveJSProperty("open", true);
  await expect(page.locator("#legal-actions button").first()).toBeFocused();
  await expect(page.locator("#legal-actions button").first()).toBeInViewport({ ratio: 1 });

  state.status = "finished";
  await page.evaluate(state => localStorage.setItem("burgundy-table.state.v1", JSON.stringify(state)), state);
  await page.reload();
  await expect(page.locator("#modal")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator("#modal")).toBeHidden();
  await legalLink.focus();
  await page.keyboard.press("Enter");
  await expect(details).toHaveJSProperty("open", true);
  await expect(details.locator("summary")).toBeFocused();
  await expect(details.locator("summary")).toBeInViewport({ ratio: 1 });
  await expect(page.locator("#legal-actions")).toContainText("No choices remain");
  await page.keyboard.press("Escape");
  await expect(details).toHaveJSProperty("open", false);
  await expect(details.locator("summary")).toBeFocused();
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("burgundy-table.state.v1")!))).toEqual(state);
});
