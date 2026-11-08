import { expect, test } from "@playwright/test";
import { createGame } from "../src/engine";

test.use({ viewport: { width: 390, height: 844 }, reducedMotion: "reduce" });

test("keyboard panel switching keeps the focused phone switch visible", async ({ page }) => {
  const state = createGame(42);
  state.active = 0;
  state.order = [0, 1];
  state.turnIndex = 0;
  await page.addInitScript(state => localStorage.setItem("burgundy-table.state.v1", JSON.stringify(state)), state);
  await page.goto("/");
  for (const panel of ["estate", "market"]) {
    const button = page.locator(`.mobile-navigation [data-panel="${panel}"]`);
    await button.focus();
    await page.keyboard.press("Enter");
    await expect(button).toBeFocused();
    await expect(button).toHaveAttribute("aria-pressed", "true");
    await expect(button).toBeInViewport({ ratio: 1 });
    await expect(page.locator("#app")).toHaveAttribute("data-panel", panel);
  }
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("burgundy-table.state.v1")!))).toEqual(state);
});
