import { expect, test } from "@playwright/test";
import { applyAction, createGame, legalActions } from "../src/engine";

test.use({ reducedMotion: "reduce" });

test("AI handoff returns to your estate without stealing deliberately moved focus", async ({ page }) => {
  const state = createGame(42);
  state.active = 0;
  state.order = [0, 1];
  state.turnIndex = 0;
  [state.players[0].arrival, state.players[1].arrival] = [state.players[1].arrival, state.players[0].arrival];
  state.players.forEach(player => { player.dice = [null, null]; player.silver = 0; });
  const afterHuman = applyAction(state, legalActions(state).find(action => action.kind === "end")!);
  const expected = applyAction(afterHuman, legalActions(afterHuman).find(action => action.kind === "end")!);
  expect(expected.active).toBe(0);
  await page.addInitScript(state => localStorage.setItem("burgundy-table.state.v1", JSON.stringify(state)), state);
  await page.goto("/");
  await page.locator('[data-view="1"]').click();
  await expect(page.locator("#estate-title")).toHaveText("The Steward’s estate");
  await page.locator("#turn-controls .turn-tools .end-turn").focus();
  await page.keyboard.press("Enter");
  const sound = page.locator('[data-ui="sound"]');
  await sound.focus();
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem("burgundy-table.state.v1")!).active)).toBe(0);
  await expect(page.locator('[data-view="0"]')).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#estate-title")).toHaveText("Your estate");
  await expect(page.locator("#storage h3")).toHaveText("Your reserve");
  await expect(sound).toBeFocused();
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("burgundy-table.state.v1")!))).toEqual(expected);
});
