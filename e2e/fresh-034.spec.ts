import { expect, test } from "@playwright/test";
import { BOARD } from "../src/data";
import { createGame } from "../src/engine";

test.use({ viewport: { width: 1440, height: 1000 }, reducedMotion: "reduce" });

test("finished ledger closes to read-only estate and knowledge inspection without playable instructions", async ({ page }) => {
  const state = createGame(42);
  state.status = "finished";
  state.winner = 1;
  state.phase = 4;
  state.round = 4;
  state.active = 1;
  const sources = [...Object.values(state.pools), ...state.depots.map(depot => depot.tiles), state.black];
  const cell = BOARD.find(cell => cell.color === "knowledge")!;
  for (const [index, id] of [4, 5].entries()) {
    const player = state.players[index];
    const source = sources.find(tiles => tiles.some(tile => tile.knowledge === id))!;
    player.board[cell.id] = source.splice(source.findIndex(tile => tile.knowledge === id), 1)[0];
    player.dice = [null, null];
    player.score = 120 + index * 10;
    player.final = { goods: 0, silver: 1, workers: 1, knowledge: 0 };
  }
  const reserveSource = sources.find(tiles => tiles.some(tile => tile.color === "mine"))!;
  state.players[0].storage = [reserveSource.splice(reserveSource.findIndex(tile => tile.color === "mine"), 1)[0]];
  await page.addInitScript(state => {
    localStorage.setItem("burgundy-table.state.v1", JSON.stringify(state));
  }, state);
  await page.goto("/");
  const dialog = page.getByRole("dialog");
  const reopen = page.getByRole("button", { name: "View final scores", exact: true });
  await dialog.getByRole("button", { name: "Inspect the estates", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(reopen).toBeVisible();
  await expect(page.locator("#choices")).toBeEmpty();
  await expect(page.locator("#turn-controls [data-die]:enabled, #turn-controls [data-mode], #legal-actions [data-action]")).toHaveCount(0);

  for (const [index, id] of [4, 5].entries()) {
    await page.locator(`[data-view="${index}"]`).click();
    await expect(page.locator(`[data-view="${index}"]`)).toHaveAttribute("aria-pressed", "true");
    await page.locator('#estate-details > summary').click();
    await page.locator(`#estate-knowledge [data-knowledge="${id}"]`).click();
    await expect(page.getByRole("dialog", { name: "An acquired advantage", exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
  }
  await reopen.click();
  await expect(dialog.locator(".results-players")).toBeVisible();
  await dialog.getByRole("button", { name: "Inspect the estates", exact: true }).click();
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("burgundy-table.state.v1")!))).toEqual(state);

  // The finished-state guards prevent actions, but normal-play prompts remain.
  await expect.soft(page.locator("#turn-controls")).not.toContainText(/Choose action|Choose target/);
  await expect.soft(page.locator("#estate-inspection")).toHaveCount(0);
  await expect.soft(page.locator("#storage .reserve-guidance")).not.toContainText("map to build");
});
