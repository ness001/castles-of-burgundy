import { expect, test, type Page } from "@playwright/test";
import { expectRestored } from "./undo-assertions";
import { actionKey, applyAction, createGame, legalActions } from "../src/engine";
import { boardFor } from "../src/boards";
import { placementOutcome } from "../src/presentation";
import type { Action, GameOptions, State, Tile } from "../src/types";

const KEY = "burgundy-table.state.v1";
test.use({ reducedMotion: "reduce" });

function position(options: GameOptions = {}): State {
  const state = createGame(42, options);
  state.active = 0;
  state.order = state.players.map((_, index) => index);
  state.turnIndex = 0;
  state.players[0].dice = [1, 2];
  state.players[0].workers = 2;
  state.players[0].silver = 2;
  return state;
}

function takeTile(state: State, matches: (tile: Tile) => boolean): Tile {
  const sources = [...Object.values(state.pools), ...state.depots.map(depot => depot.tiles), state.black, state.blackPool];
  const source = sources.find(tiles => tiles.some(matches));
  if (!source) throw new Error("Scenario tile is unavailable");
  return source.splice(source.findIndex(matches), 1)[0];
}

function settle(state: State, matches: (tile: Tile) => boolean, who = 0): Tile {
  const tile = takeTile(state, matches);
  const player = state.players[who];
  const cell = boardFor(player).find(cell => cell.color === tile.color && !player.board[cell.id]);
  if (!cell) throw new Error("Scenario has no matching empty estate space");
  player.board[cell.id] = tile;
  return tile;
}

async function openTable(page: Page, state: State) {
  await page.addInitScript(({ key, state }) => {
    if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify(state));
  }, { key: KEY, state });
  await page.goto("/");
  await page.evaluate(() => document.fonts.ready);
  await expect(page.locator("#turn-controls")).toBeVisible();
}

async function saved(page: Page): Promise<State> {
  return page.evaluate(key => JSON.parse(localStorage.getItem(key)!), KEY);
}

function actionButton(page: Page, action: Action, scope = "#legal-actions") {
  return page.locator(`${scope} [data-action-key=${JSON.stringify(actionKey(action))}]`);
}

for (const scenario of [
  { cycle: 11, playerCount: 2, ruleset: "original-2011", knowledge: false, dice: [1, 2], points: 6, silver: 1, cost: 0 },
  { cycle: 12, playerCount: 3, ruleset: "original-2011", knowledge: true, dice: [2, 3], points: 9, silver: 2, cost: 1 },
  { cycle: 13, playerCount: 4, ruleset: "special-edition", knowledge: true, dice: [3, 4], points: 12, silver: 2, cost: 2 },
] as const) {
  test(`${scenario.cycle} ${scenario.playerCount}p ${scenario.ruleset} sale shows gross rewards and separate worker payment`, async ({ page }) => {
    const state = position({ playerCount: scenario.playerCount, ruleset: scenario.ruleset });
    state.players[0].goods = [3, 0, 0, 0, 0, 0];
    state.players[0].dice = [...scenario.dice];
    if (scenario.knowledge) for (const id of [3, 4]) settle(state, tile => tile.knowledge === id);
    const sale = legalActions(state).find(action => action.kind === "sell" && action.die === 0)!;
    const expected = applyAction(state, sale);
    expect(sale.cost).toBe(scenario.cost);
    expect(expected.players[0].score - state.players[0].score).toBe(scenario.points);
    expect(expected.players[0].silver - state.players[0].silver).toBe(scenario.silver);
    expect(expected.players[0].workers - state.players[0].workers).toBe((scenario.knowledge ? 1 : 0) - scenario.cost);
    const reward = `+${scenario.points} VP · +${scenario.silver} silver${scenario.knowledge ? " · +1 worker" : ""}`;
    await openTable(page, state);
    await expect(page.locator('[data-good="1"] .sale-quote')).toHaveCount(0);
    await expect(page.locator('[data-good="1"]')).toHaveAttribute("title", `Silk: ${reward} · ${scenario.cost ? `Pay ${scenario.cost} worker${scenario.cost === 1 ? "" : "s"}` : "No worker cost"}`);
    await page.locator("#legal-details > summary").click();
    await expect(actionButton(page, sale).locator(".action-payout")).toHaveText(`Earn ${reward}`);
    expect(await saved(page)).toEqual(state);
    await actionButton(page, sale).click();
    expect(await saved(page)).toEqual(expected);
    await expectRestored(page, state, () => page.locator('[data-ui="undo"]').click(), sale.label);
  });
}

test("14 Original knowledge 6 can buy with an empty black market and reports the used purchase", async ({ page }) => {
  const state = position({ ruleset: "original-2011" });
  settle(state, tile => tile.knowledge === 6);
  state.blackPool.push(...state.black.splice(0));
  state.players[0].dice = [null, null];
  const buy = legalActions(state).find(action => action.kind === "buy" && action.depot! >= 0)!;
  await openTable(page, state);
  await expect(page.locator(".purchase-status")).toHaveText("Black market empty · buy from numbered depots");
  // With no dice left, the only remaining action is already selected.
  await expect(page.locator('#black-market [data-mode="take"]')).toHaveText("Stop buying from depots");
  await page.locator(`#depots [data-tile="${buy.tile}"]`).click();
  expect(await saved(page)).toEqual(applyAction(state, buy));
  await expect(page.locator(".purchase-status")).toHaveText("Purchase used this turn");
  expect(legalActions(await saved(page)).some(action => action.kind === "buy")).toBe(false);
});

test("15 Special Edition knowledge 6 worker trade and silver purchase remain independent", async ({ page }) => {
  const state = position({ ruleset: "special-edition" });
  settle(state, tile => tile.knowledge === 6);
  state.players[0].dice = [null, null];
  const trade = legalActions(state).find(action => action.kind === "trade")!;
  expect(trade).toBeDefined();
  await openTable(page, state);
  await expect(page.locator(".target-step > p")).toContainText("and/or");
  await expect(page.locator(".target-step > p")).toContainText("trade 2 workers");
  await page.locator('#black-market [data-mode="trade"]').click();
  await expect(page.locator(".turn-hint")).toContainText("This worker trade spends no die or silver.");
  await expect(page.locator(".turn-hint")).toContainText("buy for 2 silver and/or trade 2 workers for a building, then End turn.");
  await page.locator(`#depots [data-tile="${trade.tile}"]`).click();
  const afterTrade = applyAction(state, trade);
  expect(await saved(page)).toEqual(afterTrade);
  expect(afterTrade.purchased).toBe(false);
  expect(afterTrade.knowledge6Used).toBe(true);
  await expect(page.locator('#black-market [data-mode="trade"]')).toHaveText("Knowledge 6 used this turn");
  const buy = legalActions(afterTrade).find(action => action.kind === "buy")!;
  await page.locator(`#black-market [data-tile="${buy.tile}"]`).click();
  expect(await saved(page)).toEqual(applyAction(afterTrade, buy));
  await expect(page.locator(".purchase-status")).toHaveText("Purchase used this turn");
});

test("16 empty ordinary black market does not advertise an available purchase", async ({ page }) => {
  const state = position();
  state.blackPool.push(...state.black.splice(0));
  state.players[0].dice = [null, null];
  expect(legalActions(state).some(action => action.kind === "buy")).toBe(false);
  await openTable(page, state);
  await expect(page.locator(".purchase-status")).toHaveText("No tiles left this phase");
  await expect(page.locator(".target-step > p")).toHaveText("No moves left. End your turn.");
  await expect(page.locator("#black-market [data-tile]")).toHaveCount(0);
  expect(await saved(page)).toEqual(state);
});

test("17 castle privilege survives buying and resolves worker rewards without spending dice", async ({ page }) => {
  const state = position();
  state.pending = [{ kind: "free" }];
  for (const id of [13, 14]) settle(state, tile => tile.knowledge === id);
  await openTable(page, state);
  await expect(page.locator(".target-step > p")).toContainText("Ignore die values; no die or workers spent. Buying is separate.");
  await expect(page.locator(".worker-payment")).toHaveCount(0);
  await expect(page.locator('.quick-actions [data-mode="workers"]')).toHaveAttribute("data-action-hint", /no die spent/);
  await expect(page.locator('.quick-actions [data-mode="workers"]')).toContainText("Take 4 workers + 1 silver");
  const buy = legalActions(state).find(action => action.kind === "buy")!;
  await page.locator(`#black-market [data-tile="${buy.tile}"]`).click();
  const afterBuy = applyAction(state, buy);
  expect(await saved(page)).toEqual(afterBuy);
  expect(afterBuy.pending).toEqual(state.pending);
  const workers = legalActions(afterBuy).find(action => action.kind === "workers")!;
  await page.locator('.quick-actions [data-mode="workers"]').click();
  const expected = applyAction(afterBuy, workers);
  expect(await saved(page)).toEqual(expected);
  expect(expected.players[0].dice).toEqual(state.players[0].dice);
  expect(expected.players[0].workers).toBe(state.players[0].workers + 4);
  expect(expected.pending).toEqual([]);
});

test("18 warehouse sale preserves dice and shows knowledge 3 and 4 rewards", async ({ page }) => {
  const state = position({ ruleset: "special-edition" });
  state.pending = [{ kind: "sell" }];
  state.players[0].goods = [3, 0, 0, 0, 0, 0];
  state.players[0].dice = [4, 5];
  state.players[0].workers = 0;
  for (const id of [3, 4]) settle(state, tile => tile.knowledge === id);
  const sale = legalActions(state).find(action => action.kind === "sell")!;
  await openTable(page, state);
  await expect(page.locator(".target-step > p")).toHaveText("Warehouse: sell a goods type for free.");
  await expect(page.locator('[data-good="1"]')).toHaveAttribute("title", /No worker cost$/);
  await page.locator('.quick-actions [data-mode="sell"]').click();
  await expect(page.locator("#modal .results-intro")).toContainText("No die or workers are spent");
  await expect(page.locator("#modal .action-payout")).toHaveText("Earn +6 VP · +2 silver · +1 worker");
  await actionButton(page, sale, "#modal").click();
  expect(await saved(page)).toEqual(applyAction(state, sale));
  expect((await saved(page)).players[0].dice).toEqual(state.players[0].dice);
});

test("19 City Hall bonus builds a bank with zero workers and previews immediate silver", async ({ page }) => {
  const state = position();
  state.pending = [{ kind: "place" }];
  state.players[0].workers = 0;
  const bank = takeTile(state, tile => tile.building === "bank");
  state.players[0].storage = [bank];
  const place = legalActions(state).find(action => action.kind === "place" && action.tile === bank.id)!;
  const expected = applyAction(state, place);
  expect(place.cost).toBe(0);
  expect(place.die).toBeUndefined();
  await openTable(page, state);
  await expect(page.locator(".target-step > p")).toHaveText("City Hall: place a tile without a die.");
  await page.locator("#legal-details > summary").click();
  const choice = actionButton(page, place);
  await choice.focus();
  await expect(choice).toHaveAttribute("title", /no workers.*\+2 silver/);
  expect(await saved(page)).toEqual(state);
  await choice.click();
  expect(await saved(page)).toEqual(expected);
  expect(expected.players[0].dice).toEqual(state.players[0].dice);
  expect(expected.players[0].silver).toBe(state.players[0].silver + 2);
});

for (const [index, ruleset] of (["original-2011", "special-edition"] as const).entries()) {
  test(`${20 + index} phase E ${ruleset} results include final mines and correct knowledge 15 and 26`, async ({ page }) => {
    const state = position({ ruleset });
    state.phase = 4;
    state.round = 4;
    state.order = [1, 0];
    state.turnIndex = 1;
    for (const player of state.players) player.dice = [null, null];
    const player = state.players[0];
    player.score = 40;
    player.silver = 3;
    player.workers = 5;
    player.goods = [2, 1, 0, 0, 0, 0];
    player.sold = [2, 1, 0, 0, 0, 0];
    player.bonuses = ["castle"];
    state.claimed.castle = [0];
    for (const id of [15, 26]) settle(state, tile => tile.knowledge === id);
    for (let i = 0; i < 2; i++) settle(state, tile => tile.color === "mine");
    while (boardFor(player).some(cell => cell.color === "castle" && !player.board[cell.id])) settle(state, tile => tile.color === "castle");
    const end = legalActions(state).find(action => action.kind === "end")!;
    const expected = applyAction(state, end);
    const knowledge = ruleset === "original-2011" ? 8 : 7;
    expect(expected.players[0].final).toEqual({ goods: 3, silver: 5, workers: 2, knowledge });
    await openTable(page, state);
    await expect(page.locator(".phase-boundary")).toHaveCount(0);
    await expect(page.locator('[data-knowledge="15"]')).toContainText(`End: +${ruleset === "original-2011" ? 3 : 2} VP per goods type sold`);
    await expect(page.locator('[data-knowledge="26"]')).toContainText(`End: +${ruleset === "original-2011" ? 2 : 3} VP per color bonus`);
    await page.locator(".turn-tools .end-turn").click();
    expect(await saved(page)).toEqual(expected);
    await expect(page.locator("#modal")).toBeVisible();
    for (const [who, finalPlayer] of expected.players.entries()) {
      const result = page.locator(".result-player").nth(who);
      await expect(result.locator(".final-score")).toHaveText(`${finalPlayer.score}victory points`);
      for (const [key, value] of Object.entries(finalPlayer.final!)) {
        await expect(result.locator(`[data-score-item="${key}"] .result-score-value`)).toHaveText(`+${value}`);
      }
    }
  });
}

test("22 claimed color rewards and export history follow the inspected player", async ({ page }) => {
  const state = position({ playerCount: 3 });
  const player = state.players[0];
  while (boardFor(player).some(cell => cell.color === "castle" && !player.board[cell.id])) settle(state, tile => tile.color === "castle");
  player.bonuses = ["castle"];
  state.claimed.castle = [0];
  player.sold = [3, 0, 0, 0, 0, 0];
  state.players[1].sold = [0, 1, 2, 0, 0, 0];
  await openTable(page, state);
  const color = page.locator('[data-color-progress="castle"]');
  await page.locator('#estate-details > summary').click();
  await color.locator("summary").click();
  await expect(color.locator(".bonus-available")).toHaveText("Color bonus already earned");
  await expect(page.locator("#sold-goods-summary")).toHaveText("Sold goods · 3 tiles, 1 types");
  await page.locator('[data-view="1"]').click();
  await page.locator('#estate-details > summary').click();
  await expect(color.locator(".bonus-available")).toHaveText("+3 VP available");
  await expect(page.locator("#sold-goods-summary")).toHaveText("The Steward’s sold goods · 3 tiles, 2 types");
  await page.locator("#sold-goods > summary").click();
  await expect(page.locator("#sold-goods-content .cargo-number")).toHaveText(["2", "3"]);
  expect(await saved(page)).toEqual(state);
});

test("23 phase boundary pays built mines and knowledge 2 but not a reserved mine", async ({ page }) => {
  const state = position();
  state.round = 4;
  state.order = [1, 0];
  state.turnIndex = 1;
  for (const player of state.players) player.dice = [null, null];
  settle(state, tile => tile.knowledge === 2);
  for (let i = 0; i < 2; i++) settle(state, tile => tile.color === "mine");
  settle(state, tile => tile.color === "ship");
  state.players[0].ships = 1;
  state.players[0].storage = [takeTile(state, tile => tile.color === "mine")];
  state.depots[0].goods = [6, 6];
  const end = legalActions(state).find(action => action.kind === "end")!;
  const expected = applyAction(state, end);
  expect(expected.active).toBe(0);
  expect(expected.players[0].silver).toBe(state.players[0].silver + 2);
  expect(expected.players[0].workers).toBe(state.players[0].workers + 2);
  await openTable(page, state);
  await expect(page.locator(".phase-boundary")).toHaveCount(0);
  await page.locator(".turn-tools .end-turn").click();
  expect(await saved(page)).toEqual(expected);
  await expect(page.locator('[data-resource="silver"] strong')).toHaveText(String(expected.players[0].silver));
  await expect(page.locator('[data-resource="workers"] strong')).toHaveText(String(expected.players[0].workers));
  await expect(page.locator("#feedback")).toContainText("+2 silver from mines");
  expect((await saved(page)).depots[0].goods.filter(type => type === 6).length).toBeGreaterThanOrEqual(2);
});

test("24 reserved knowledge and buildings grant no premature sale or placement rewards", async ({ page }) => {
  const state = position();
  const knowledge = takeTile(state, tile => tile.knowledge === 3);
  const bank = takeTile(state, tile => tile.building === "bank");
  const tower = takeTile(state, tile => tile.building === "watchtower");
  state.players[0].storage = [knowledge, bank, tower];
  state.players[0].goods = [2, 0, 0, 0, 0, 0];
  const score = state.players[0].score;
  await openTable(page, state);
  await expect(page.locator('[data-player-index="0"] .score-value')).toHaveText(`${score}VP`);
  await expect(page.locator('#storage .reserve-benefit')).toHaveText(["Sell goods: earn 2 silver", "+2 silver", "+4 VP"]);
  await page.locator(`#storage [data-tile="${knowledge.id}"]`).focus();
  await expect(page.locator("#market-tooltip .tile-benefit")).toContainText("Sell goods: earn 2");
  await expect(page.locator('[data-good="1"]')).toHaveAttribute("title", /\+4 VP · \+1 silver/);
  await expect(page.locator('[data-resource="silver"] strong')).toHaveText("2");
  expect(await saved(page)).toEqual(state);
  const sale = legalActions(state).find(action => action.kind === "sell" && action.die === 0)!;
  await page.locator('[data-good="1"]').click();
  expect(await saved(page)).toEqual(applyAction(state, sale));
  expect((await saved(page)).players[0].storage).toEqual(state.players[0].storage);
});

for (const reason of ["Not with this die", "Both dice spent", "Resolve bonus first"]) {
  test(`blocked sale describes ${reason.toLowerCase()} in its tooltip and accessible name`, async ({ page }) => {
    const state = position();
    state.players[0].goods = [1, 0, 0, 0, 0, 0];
    state.players[0].workers = 0;
    state.players[0].dice = reason === "Both dice spent" ? [null, null] : [2, 3];
    if (reason === "Resolve bonus first") state.pending = [{ kind: "take", colors: ["mine"] }];
    await openTable(page, state);
    const goods = page.locator('[data-good="1"]');
    await expect(goods).toBeDisabled();
    await expect(goods.locator(".sale-cost")).toHaveCount(0);
    await expect(goods).toHaveAccessibleName(new RegExp(reason));
    await expect(goods).toHaveAttribute("title", new RegExp(reason));
    expect(await saved(page)).toEqual(state);
  });
}

test("25 watchtower placement preview separates tile points from region and color totals", async ({ page }) => {
  const state = position();
  state.players[0].workers = 6;
  const tower = takeTile(state, tile => tile.building === "watchtower");
  const player = state.players[0];
  player.storage = [tower];
  const target = legalActions(state).find(action => action.kind === "place" && action.die === 0)!.cell!;
  const estate = boardFor(player);
  // Leave one legal building space, completing both its city and this color.
  for (const cell of estate.filter(cell => cell.color === "building" && cell.id !== target)) {
    player.board[cell.id] = takeTile(state, tile => tile.color === "building" && tile.building !== "watchtower"
      && !estate.some(other => other.region === cell.region && player.board[other.id]?.building === tile.building));
  }
  const place = legalActions(state).find(action => action.kind === "place" && action.die === 0 && action.cell === target)!;
  const outcome = placementOutcome(state, place);
  const expected = applyAction(state, place);
  expect(outcome.tilePoints).toBe(4);
  expect(outcome.regionPoints).toBeGreaterThan(0);
  expect(outcome.colorPoints).toBe(5);
  expect(outcome.points).toBe(outcome.tilePoints + outcome.regionPoints + outcome.colorPoints);
  await openTable(page, state);
  await page.locator("#legal-details > summary").click();
  const choice = actionButton(page, place);
  await choice.focus();
  await expect(choice).toHaveAttribute("title", `${place.cost ? `${place.cost} worker${place.cost === 1 ? "" : "s"}` : "no workers"} · +${outcome.points} VP now · tile +4 · region +${outcome.regionPoints} · color bonus +5`);
  await expect(page.locator("#announcer")).toContainText(`+${outcome.points} VP now`);
  expect(await saved(page)).toEqual(state);
  await choice.click();
  expect(await saved(page)).toEqual(expected);
  await expectRestored(page, state, () => page.locator('[data-ui="undo"]').click());
});
