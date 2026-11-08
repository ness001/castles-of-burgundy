import { expect, test } from "@playwright/test";
import { actionKey, applyAction, createGame, legalActions } from "../src/engine";
import type { State } from "../src/types";

test.use({ reducedMotion: "reduce" });

test("058 double-clicking Take does not spend the other die on the next rendered choice", async ({ page }) => {
  const key = "burgundy-table.state.v1";
  const state = createGame(42);
  state.active = 0;
  state.order = [0, 1];
  state.turnIndex = 0;
  state.pending = [];
  state.players[0].dice = [1, 1];
  state.players[0].workers = 0;
  state.players[0].silver = 0;
  state.players[0].goods = [0, 0, 0, 0, 0, 0];
  state.players[0].storage = [];
  for (const depot of state.depots) depot.tiles = [];
  state.depots[0].tiles = state.pools.mine.splice(0, 2);
  const take = legalActions(state).find(action => action.kind === "take" && action.die === 0)!;
  const expected = applyAction(state, take);

  await page.addInitScript(({ key, state }) => {
    localStorage.setItem(key, JSON.stringify(state));
  }, { key, state });
  await page.goto("/");
  await page.locator("#legal-details > summary").click();
  const button = page.locator(`#legal-actions [data-action-key=${JSON.stringify(actionKey(take))}]`);

  // The first click rerenders index 0 with the other mine and the other die.
  // The second click of the same pointer gesture must not execute that new action.
  await button.dblclick();

  const actual: State = await page.evaluate(key => JSON.parse(localStorage.getItem(key)!), key);
  expect(actual.players[0].dice, "one double-click must consume only its original die").toEqual([null, 1]);
  expect(actual).toEqual(expected);
});
