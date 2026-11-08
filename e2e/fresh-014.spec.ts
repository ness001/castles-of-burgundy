import { expect, test } from "@playwright/test";
import { expectRestored } from "./undo-assertions";
import { boardFor } from "../src/boards";
import { applyAction, createGame, legalActions } from "../src/engine";
import type { State } from "../src/types";

test.use({ reducedMotion: "reduce" });

test("014 goods distinguish worker cost from rewards and rival inspection from selling", async ({ page }) => {
  const key = "burgundy-table.state.v1";
  const state = createGame(42);
  state.active = 0;
  state.order = [0, 1];
  state.turnIndex = 0;
  const player = state.players[0];
  player.dice = [1, 2];
  player.workers = 0;
  player.goods = [2, 0, 0, 0, 0, 0];
  state.players[1].goods = [0, 3, 0, 0, 0, 0];
  const sources = [...Object.values(state.pools), ...state.depots.map(depot => depot.tiles), state.black, state.blackPool];
  const source = sources.find(tiles => tiles.some(tile => tile.knowledge === 4))!;
  const tile = source.splice(source.findIndex(tile => tile.knowledge === 4), 1)[0];
  const cell = boardFor(player).find(cell => cell.color === tile.color && !player.board[cell.id])!;
  player.board[cell.id] = tile;
  const sale = legalActions(state).find(action => action.kind === "sell" && action.good === 1 && action.die === 0)!;
  expect(sale.cost).toBe(0);

  await page.addInitScript(({ key, state }) => {
    localStorage.setItem(key, JSON.stringify(state));
  }, { key, state });
  await page.goto("/");
  const saved = (): Promise<State> => page.evaluate(key => JSON.parse(localStorage.getItem(key)!), key);
  const stack = page.locator('#goods [data-good="1"]');
  await expect(stack.locator(".sale-quote")).toHaveCount(0);
  await expect(stack).toHaveAttribute("title", "Silk: +4 VP · +1 silver · +1 worker · No worker cost");
  await expect(stack).toHaveAccessibleName(/Sell type 1 goods, 2 in storage,.*\+1 worker, No worker cost/);
  await page.evaluate(() => document.fonts.ready);

  await page.locator('[data-view="1"]').click();
  await expect(page.locator('#goods [data-good="2"]')).toBeDisabled();
  await expect(page.locator("#goods .sale-quote")).toHaveCount(0);
  await expect(page.locator("#goods > .fine-print")).toHaveText("Read-only goods. Select You above the map to sell your goods.");
  expect(await saved()).toEqual(state);

  await page.locator('[data-view="0"]').click();
  await stack.click();
  const expected = applyAction(state, sale);
  expect(await saved()).toEqual(expected);
  expect(expected.players[0].workers).toBe(1);
  await expect(page.locator("#goods .good-stack")).toHaveCount(0);
  await expect(page.locator("#goods .empty-goods-note")).toHaveText("No goods stored. Build a ship to collect cargo.");
  await expect(page.locator("#modal")).not.toBeVisible();
  await expectRestored(page, state, () => page.locator('[data-ui="undo"]').click());
});
