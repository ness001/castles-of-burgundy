import { expect, test } from "@playwright/test";
import { createGame, legalActions } from "../src/engine";

const KEY = "burgundy-table.state.v1";
test.use({ reducedMotion: "reduce" });

test("selected-die target guidance quotes worker costs without overriding blocked or bonus guidance", async ({ page }) => {
  const state = createGame(42);
  state.active = 0;
  state.order = [0, 1];
  state.turnIndex = 0;
  state.players[0].dice = [1, 2];
  state.players[0].workers = 2;
  state.depots[0].tiles.forEach(tile => state.pools[tile.color].push(tile));
  state.depots[0].tiles = [];
  expect(new Set(legalActions(state).filter(action => action.kind === "take" && action.die === 0).map(action => action.cost))).toEqual(new Set([1, 2]));

  await page.addInitScript(({ key, state }) => {
    if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify(state));
  }, { key: KEY, state });
  await page.goto("/");
  const hint = page.locator(".target-step > p");
  await expect(hint).toHaveText("8 highlighted tiles · 1–2 workers · click to take");
  await page.locator('#turn-controls [data-die="1"]').click();
  await expect(hint).toContainText("0–2 workers");
  expect(await page.evaluate(key => JSON.parse(localStorage.getItem(key)!), KEY)).toEqual(state);

  state.players[0].workers = 0;
  await page.evaluate(({ key, state }) => localStorage.setItem(key, JSON.stringify(state)), { key: KEY, state });
  await page.reload();
  await expect(hint).toContainText("Switch to die 2 (2)");
  await page.locator('#turn-controls [data-die="1"]').click();
  await expect(hint).toContainText("no workers · click to take");

  state.pending = [{ kind: "free" }];
  await page.evaluate(({ key, state }) => localStorage.setItem(key, JSON.stringify(state)), { key: KEY, state });
  await page.reload();
  await expect(hint).toContainText("Ignore die values; no die or workers spent. Buying is separate.");
  expect(await page.evaluate(key => JSON.parse(localStorage.getItem(key)!), KEY)).toEqual(state);
});
