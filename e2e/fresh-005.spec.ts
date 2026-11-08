import { expect, test } from "@playwright/test";
import { applyAction, createGame, legalActions, turnOrder } from "../src/engine";

test.use({ reducedMotion: "reduce" });

test("fresh-005: final round shows the tie-break track, not a nonexistent next round", async ({ page }) => {
  const key = "burgundy-table.state.v1";
  const state = createGame(42);
  state.phase = 4;
  state.round = 3;
  state.active = 0;
  state.order = [1, 0];
  state.turnIndex = 1;
  state.players.forEach(player => { player.dice = [null, null]; });
  state.players[0].ships = 1;
  await page.addInitScript(({ key, state }) => {
    if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify(state));
  }, { key, state });
  await page.goto("/");
  const order = page.locator("#turn-order-content");
  await expect(order.locator("p:nth-child(2) strong")).toHaveText("Next round:");
  await expect(order).toContainText("Changes take effect next round.");

  state.round = 4;
  await page.evaluate(({ key, state }) => localStorage.setItem(key, JSON.stringify(state)), { key, state });
  await page.reload();
  await page.locator("#turn-order > summary").click();
  await expect(order.locator("p:nth-child(2) strong")).toHaveText("Final track:");
  await expect(order).toContainText("No next round; if points and empty spaces tie, later on this track wins.");
  await expect(order).not.toContainText("Changes take effect next round.");
  expect(await order.locator("p:nth-child(2) [data-order-player]").evaluateAll(nodes => nodes.map(node => Number(node.getAttribute("data-order-player")))))
    .toEqual(turnOrder(state));
  await expect(page.locator(".phase-boundary")).toHaveCount(0);

  const expected = applyAction(state, legalActions(state).find(action => action.kind === "end")!);
  await page.locator(".turn-tools .end-turn").click();
  await expect(page.locator("#modal")).toBeVisible();
  expect(await page.evaluate(key => JSON.parse(localStorage.getItem(key)!), key)).toEqual(expected);
  await expect(order.locator("p:nth-child(2) strong")).toHaveText("Final track:");
  await expect(order).not.toContainText("Changes take effect next round.");
});
