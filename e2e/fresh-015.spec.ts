import { expect, test } from "@playwright/test";
import { createGame } from "../src/engine";

const KEY = "burgundy-table.state.v1";
test.use({ reducedMotion: "reduce" });

test("new-game replacement consequences are accessible and edited options cancel without saving", async ({ page }) => {
  const state = createGame(42);
  state.active = 0;
  state.order = [0, 1];
  state.turnIndex = 0;
  await page.addInitScript(({ key, state }) => {
    if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify(state));
  }, { key: KEY, state });
  await page.goto("/");
  const opener = page.locator('[data-ui="new"]');
  await expect(opener).toBeVisible();
  const saved = await page.evaluate(key => localStorage.getItem(key), KEY);

  for (const cancel of ["button", "escape"]) {
    await opener.click();
    const dialog = page.getByRole("dialog", { name: "Start a new estate?" });
    await expect(dialog.getByRole("button", { name: "Start new game" })).toHaveAccessibleDescription(
      "The current table and its saved progress will be replaced. This cannot be undone.",
    );
    const players = dialog.getByRole("combobox", { name: "Players", exact: true });
    const estates = dialog.getByRole("combobox", { name: "Estate setup", exact: true });
    const rules = dialog.getByRole("combobox", { name: "Rules", exact: true });
    await players.selectOption("3");
    await estates.selectOption("secret");
    await rules.selectOption("special-edition");
    await expect(players.locator("option:checked")).toHaveText("3 · You and two rivals");
    await expect(estates.locator("option:checked")).toHaveText("Advanced · simultaneous private choices");
    await expect(rules.locator("option:checked")).toContainText("Special Edition");
    await expect(rules).toHaveAccessibleDescription(/2 workers/);
    if (cancel === "button") await dialog.getByRole("button", { name: "Keep this table" }).click();
    else await page.keyboard.press("Escape");
    await expect(dialog).not.toBeVisible();
    await expect(opener).toBeFocused();
    expect(await page.evaluate(key => localStorage.getItem(key), KEY)).toBe(saved);
  }
});
