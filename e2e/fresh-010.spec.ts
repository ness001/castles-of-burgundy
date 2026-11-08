import { expect, test } from "@playwright/test";
import { tileDescription, tileName } from "../src/data";
import { createGame } from "../src/engine";
import { tileBenefit } from "../src/presentation";

test("market effect and unavailable purchase reason have one sentence boundary", async ({ page }) => {
  const state = createGame(42);
  state.active = 0;
  state.order = [0, 1];
  state.turnIndex = 0;
  state.players[0].dice = [1, 4];
  state.players[0].silver = 1;
  await page.addInitScript(state => {
    localStorage.setItem("burgundy-table.state.v1", JSON.stringify(state));
  }, state);
  await page.goto("/");

  for (const tile of [...state.depots.flatMap(depot => depot.tiles), ...state.black]) {
    const card = page.locator(`.market-card[data-tile="${tile.id}"]`);
    const prompt = await card.getAttribute("data-tile-prompt");
    await expect(card).toHaveAccessibleName(`${tileName(tile, state.ruleset)}. ${tileDescription(tile, state.ruleset)} ${prompt}`);
  }

  const tile = state.black[0];
  const card = page.locator(`.market-card[data-source="black"][data-tile="${tile.id}"]`);
  await expect(card).toHaveAttribute("aria-disabled", "true");
  await card.focus();
  const tooltip = page.locator("#market-tooltip");
  await expect(tooltip).toBeVisible();
  await expect(tooltip.locator(".tile-benefit")).toHaveText(tileBenefit(tile, state.ruleset));
  await expect(tooltip.locator("p")).toHaveText(tileDescription(tile, state.ruleset));
  await expect(tooltip.locator(".tile-prompt")).toHaveText("Need 1 more silver · no die");
  await page.keyboard.press("Enter");
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("burgundy-table.state.v1")!))).toEqual(state);
});
