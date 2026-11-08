import { expect, test } from "@playwright/test";
import { actionKey, applyAction, createGame, legalActions } from "../src/engine";
import type { Action, State } from "../src/types";

test.use({ reducedMotion: "reduce" });

test("009 legal-action costs distinguish silver payments from free worker rewards", async ({ page }) => {
  const key = "burgundy-table.state.v1";
  const state = createGame(42);
  state.active = 0;
  state.order = [0, 1];
  state.turnIndex = 0;
  state.players[0].dice = [1, 2];
  state.players[0].workers = 0;
  state.players[0].silver = 2;
  state.pending = [{ kind: "free" }];

  await page.addInitScript(({ key, state }) => {
    localStorage.setItem(key, JSON.stringify(state));
  }, { key, state });
  await page.goto("/");
  await page.locator("#legal-details > summary").click();

  const button = (action: Action) => page.locator(`#legal-actions [data-action-key=${JSON.stringify(actionKey(action))}]`);
  const saved = (): Promise<State> => page.evaluate(key => JSON.parse(localStorage.getItem(key)!), key);
  const buy = legalActions(state).find(action => action.kind === "buy")!;
  const bonus = legalActions(state).find(action => action.kind === "workers")!;
  await expect(button(buy).locator(".action-cost")).toHaveText("Pay 2 silver");
  await expect(button(bonus)).toContainText("Take 2 workers");
  await expect(button(bonus).locator(".action-cost")).toHaveText("Free bonus");

  await button(buy).click();
  const afterBuy = applyAction(state, buy);
  expect(await saved()).toEqual(afterBuy);
  expect(afterBuy.players[0].silver - state.players[0].silver).toBe(-2);
  expect(afterBuy.pending).toEqual(state.pending);

  const workers = legalActions(afterBuy).find(action => action.kind === "workers")!;
  await expect(button(workers).locator(".action-cost")).toHaveText("Free bonus");
  await button(workers).click();
  const afterBonus = applyAction(afterBuy, workers);
  expect(await saved()).toEqual(afterBonus);
  expect(afterBonus.players[0].workers - afterBuy.players[0].workers).toBe(2);
  expect(afterBonus.players[0].dice).toEqual(state.players[0].dice);

  const normalWorkers = legalActions(afterBonus).find(action => action.kind === "workers" && action.die === 0)!;
  await expect(button(normalWorkers)).toContainText("Die 1 · Take 2 workers");
  await expect(button(normalWorkers).locator(".action-cost")).toHaveText("No worker cost");
});
