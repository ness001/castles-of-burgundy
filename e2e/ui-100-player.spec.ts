import { expect, test, type Page } from "@playwright/test";
import { expectRestored } from "./undo-assertions";
import { actionKey, applyAction, canPlace, createGame, legalActions, turnOrder } from "../src/engine";
import { BOARD, boardFor } from "../src/boards";
import { tileName } from "../src/data";
import { tileBenefit } from "../src/presentation";
import type { Action, State } from "../src/types";

const KEY = "burgundy-table.state.v1";
test.use({ reducedMotion: "reduce" });

function position(): State {
  const state = createGame(42);
  state.active = 0;
  state.order = [0, 1];
  state.turnIndex = 0;
  state.players[0].dice = [1, 2];
  state.players[0].workers = 2;
  state.players[0].silver = 1;
  return state;
}

async function openTable(page: Page, state: State, width = 1440) {
  await page.setViewportSize({ width, height: width <= 600 ? 844 : 1000 });
  await page.addInitScript(({ key, state }) => {
    if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify(state));
  }, { key: KEY, state });
  await page.goto("/");
  await page.evaluate(() => document.fonts.ready);
  await expect(page.locator("#turn-controls")).toBeVisible();
}

async function replacePosition(page: Page, state: State) {
  await page.evaluate(({ key, state }) => localStorage.setItem(key, JSON.stringify(state)), { key: KEY, state });
  await page.reload();
  await expect(page.locator("#turn-controls")).toBeVisible();
}

const saved = (page: Page): Promise<State> => page.evaluate(key => JSON.parse(localStorage.getItem(key)!), KEY);
const actionButton = (page: Page, scope: string, action: Action) =>
  page.locator(`${scope} [data-action-key=${JSON.stringify(actionKey(action))}]`);

async function clickCell(page: Page, player: { boardId?: number }, id: number) {
  const cells = boardFor(player).map(c => ({ id: c.id, x: Math.sqrt(3) * (c.q + c.r / 2), y: 1.5 * c.r }));
  const minX = Math.min(...cells.map(c => c.x)), maxX = Math.max(...cells.map(c => c.x));
  const minY = Math.min(...cells.map(c => c.y)), maxY = Math.max(...cells.map(c => c.y));
  const radius = Math.min(60, 720 / (maxX - minX + Math.sqrt(3)), 640 / (maxY - minY + 2));
  const cell = cells.find(c => c.id === id)!;
  const canvas = page.locator("#board canvas");
  await expect(canvas).toBeVisible();
  await canvas.scrollIntoViewIfNeeded();
  const bounds = (await canvas.boundingBox())!;
  await canvas.click({ position: {
    x: (380 + (cell.x - (minX + maxX) / 2) * radius) / 760 * bounds.width,
    y: (332 + (cell.y - (minY + maxY) / 2) * radius) / 664 * bounds.height,
  } });
}

function harborPosition(): State {
  const state = position();
  state.pending = [{ kind: "ship" }];
  state.players[0].goods = [1, 1, 0, 0, 0, 0];
  state.depots.forEach(depot => { depot.goods = []; });
  state.depots[0].goods = [3, 3, 4];
  return state;
}

function finalTurn(): State {
  const state = position();
  state.phase = 4;
  state.round = 4;
  state.order = [1, 0];
  state.turnIndex = 1;
  state.players[1].dice = [null, null];
  state.players[0].silver = 0;
  return state;
}

test("player cycle 11: starting castle coordinates, map selection and confirmation agree", async ({ page }) => {
  let state = createGame(42, { estates: "open" });
  state.order = [1, 0];
  state.active = 1;
  state.turnIndex = 0;
  state = applyAction(state, legalActions(state).find(a => a.kind === "choose-estate")!);
  expect(state.active).toBe(0);
  await openTable(page, state);
  const boardId = state.setup!.boards[0][1];
  await page.locator(`[data-setup-board="${boardId}"]`).click();
  const starts = legalActions(state).filter(a => a.boardId === boardId);
  expect(starts.length).toBeGreaterThan(1);
  const labels = await page.locator("#start-castle option").allTextContents();
  labels.forEach(label => expect(label).toMatch(/^Castle \d+ · Row \d+ · space \d+ · die \d+$/));
  await page.locator("#start-castle").selectOption(String(starts[1].cell));
  await expect(page.locator('[data-ui="confirm-estate"]')).toHaveText(`Confirm estate #${boardId} · Castle 2`);
  expect(await saved(page)).toEqual(state);
  await clickCell(page, { boardId }, starts[0].cell!);
  await expect(page.locator("#start-castle")).toHaveValue(String(starts[0].cell));
  await expect(page.locator('[data-ui="confirm-estate"]')).toHaveText(`Confirm estate #${boardId} · Castle 1`);
  await page.locator('[data-ui="confirm-estate"]').click();
  await expect.poll(async () => (await saved(page)).players[0].boardId).toBe(boardId);
  const player = (await saved(page)).players[0];
  expect(player.board[starts[0].cell!]?.color).toBe("castle");
  expect(player.board.filter(Boolean)).toHaveLength(1);
});

test("player cycle 12: all six reserve tile types expose benefits without selecting or spending", async ({ page }) => {
  const state = position();
  state.players[0].storage = [state.pools.mine.pop()!, state.pools.ship.pop()!, state.pools.castle.pop()!];
  await openTable(page, state);
  for (const group of [state.players[0].storage, [state.pools.building.pop()!, state.pools.knowledge.pop()!, state.pools.animal.pop()!]]) {
    const fixture = structuredClone(state);
    fixture.players[0].storage = group;
    await replacePosition(page, fixture);
    await expect(page.locator("#storage .reserve-benefit")).toHaveText(group.map(tile => tileBenefit(tile, fixture.ruleset)));
    for (const tile of group) {
      await page.locator(`#storage [data-tile="${tile.id}"]`).focus();
      await expect(page.locator("#market-tooltip .tile-benefit")).toHaveText(tileBenefit(tile, fixture.ruleset));
    }
    await expect(page.locator('#storage [aria-pressed="true"]')).toHaveCount(0);
    expect(await saved(page)).toEqual(fixture);
    await page.locator(`#storage [data-tile="${group[0].id}"]`).click();
    await expect(page.locator("#choices .selected-tile-description strong")).toHaveText(tileName(group[0], fixture.ruleset));
    expect(await saved(page)).toEqual(fixture);
  }
});

test("player cycle 13: rival goods and export history retain their owner and cannot sell", async ({ page }) => {
  const state = position();
  state.players[0].goods = [2, 0, 0, 0, 0, 0];
  state.players[0].sold = [1, 0, 0, 0, 0, 0];
  state.players[1].goods = [0, 0, 3, 0, 0, 0];
  state.players[1].sold = [0, 2, 0, 0, 1, 0];
  await openTable(page, state);
  await page.locator('[data-view="1"]').click();
  await expect(page.locator("#goods h3")).toHaveText("The Steward’s goods");
  await expect(page.locator('#goods [data-good="3"]')).toBeDisabled();
  await expect(page.locator("#goods > .fine-print")).toHaveText("Read-only goods. Select You above the map to sell your goods.");
  await expect(page.locator("#sold-goods-summary")).toHaveText("The Steward’s sold goods · 3 tiles, 2 types");
  await page.locator('#estate-details > summary').click();
  await page.locator("#sold-goods-summary").click();
  await expect(page.locator("#sold-goods-content .fine-print")).toContainText("The Steward’s export history");
  expect(await saved(page)).toEqual(state);
  await page.locator('[data-view="0"]').click();
  await expect(page.locator("#goods h3")).toHaveText("Your goods");
  await expect(page.locator('#goods [data-good="1"]')).toBeEnabled();
  await expect(page.locator("#sold-goods-summary")).toHaveText("Sold goods · 1 tiles, 1 types");
  await expect(page.locator("#sold-goods-content .fine-print")).toContainText("Your export history");
  expect(await saved(page)).toEqual(state);
});

test("player cycle 14: earlier moves remain ordered, complete and expanded after rerender", async ({ page }) => {
  const state = position();
  state.log = Array.from({ length: 8 }, (_, index) => `Recorded move ${index + 1} · hex ${index + 1}`);
  await openTable(page, state);
  await page.getByText("Recent moves", { exact: true }).click();
  const recent = page.locator("#journal > li:not(.earlier-moves) > span:last-child");
  await expect(recent).toHaveText(["Recorded move 8", "Recorded move 7", "Recorded move 6", "Recorded move 5"]);
  await expect(page.locator("#journal details")).toHaveJSProperty("open", false);
  await page.locator("#journal summary").click();
  await expect(page.locator("#journal details ol li > span:last-child")).toHaveText(["Recorded move 4", "Recorded move 3", "Recorded move 2", "Recorded move 1"]);
  await page.locator('#turn-controls [data-die="1"]').click();
  await expect(page.locator("#journal details")).toHaveJSProperty("open", true);
  await expect(page.locator("#journal li:not(.earlier-moves)")).toHaveCount(8);
  expect(await saved(page)).toEqual(state);
});

test("player cycle 15: current order marks Playing once without marking the next-round forecast", async ({ page }) => {
  const state = position();
  state.players[1].ships = 2;
  await openTable(page, state);
  await page.locator("#turn-order > summary").click();
  await expect(page.locator("#turn-order-content .order-playing")).toHaveCount(1);
  await expect(page.locator('#turn-order-content > p:first-child [data-order-player="0"]')).toHaveText("You Playing");
  await expect(page.locator("#turn-order-content > p:nth-child(2) .order-playing")).toHaveCount(0);
  expect(await page.locator("#turn-order-content > p:nth-child(2) [data-order-player]").evaluateAll(nodes => nodes.map(node => Number(node.getAttribute("data-order-player")))))
    .toEqual(turnOrder(state));
  const setup = createGame(42, { estates: "open" });
  setup.active = 0; setup.order = [0, 1]; setup.turnIndex = 0;
  await replacePosition(page, setup);
  await expect(page.locator("#turn-order-content .order-playing")).toHaveCount(0);
  const ended = finalTurn();
  ended.players[0].dice = [null, null];
  const finished = applyAction(ended, legalActions(ended).find(a => a.kind === "end")!);
  await replacePosition(page, finished);
  await expect(page.locator("#turn-order-content .order-playing")).toHaveCount(0);
});

test("player cycle 16: queued bonuses count down without spending either die", async ({ page }) => {
  const state = position();
  state.pending = [{ kind: "take", colors: ["mine"] }, { kind: "take", colors: ["castle"] }, { kind: "sell" }];
  state.players[0].goods = [1, 0, 0, 0, 0, 0];
  await openTable(page, state);
  await expect(page.locator(".pending-count")).toHaveText("3 bonuses pending");
  await expect(page.locator(".pending-count")).toBeVisible();
  let current = state;
  for (const color of ["mine", "castle"] as const) {
    const take = legalActions(current).find(a => a.kind === "take")!;
    expect(current.depots.flatMap(d => d.tiles).find(t => t.id === take.tile)?.color).toBe(color);
    await page.locator(`#depots [data-tile="${take.tile}"]`).click();
    current = applyAction(current, take);
    expect(await saved(page)).toEqual(current);
    if (current.pending.length > 1) await expect(page.locator(".pending-count")).toHaveText("2 bonuses pending");
    else await expect(page.locator(".pending-count")).toHaveCount(0);
  }
  await expect(page.locator(".turn-heading h2")).toHaveText("Bonus action");
  const sale = legalActions(current).find(a => a.kind === "sell")!;
  await page.locator('#goods [data-good="1"]').click();
  expect(await saved(page)).toEqual(applyAction(current, sale));
  expect((await saved(page)).players[0].dice).toEqual([1, 2]);
  await expect(page.locator(".turn-heading h2")).toHaveText("Your turn");
});

test("player cycle 17: harbor and cargo can each be left pending and resumed on a phone", async ({ page }) => {
  const state = harborPosition();
  await openTable(page, state, 390);
  await expect(page.locator("#modal-title")).toHaveText("Choose a harbor");
  await page.getByRole("button", { name: "Back to table · bonus stays pending", exact: true }).click();
  expect(await saved(page)).toEqual(state);
  await expect(page.locator('[data-ui="resume-bonus"]')).toHaveText("Choose harbor →");
  await page.locator('[data-ui="resume-bonus"]').click();
  const ship = legalActions(state).find(a => a.kind === "ship" && a.depots?.[0] === 0)!;
  await actionButton(page, "#modal", ship).click();
  const afterShip = applyAction(state, ship);
  expect(await saved(page)).toEqual(afterShip);
  await expect(page.locator("#modal-title")).toHaveText("Choose your cargo");
  await page.getByRole("button", { name: "Back to table · bonus stays pending", exact: true }).click();
  await expect(page.locator('[data-ui="resume-bonus"]')).toHaveText("Choose cargo →");
  expect(await saved(page)).toEqual(afterShip);
  await page.locator('[data-ui="resume-bonus"]').click();
  await expect(page.locator("#modal-title")).toHaveText("Choose your cargo");
  expect(await saved(page)).toEqual(afterShip);
});

test("player cycle 18: final cargo choices preview exact goods left behind before loading", async ({ page }) => {
  const state = harborPosition();
  const ship = legalActions(state).find(a => a.kind === "ship" && a.depots?.[0] === 0)!;
  const cargoState = applyAction(state, ship);
  await openTable(page, cargoState);
  const loads = legalActions(cargoState).filter(a => a.kind === "goods");
  expect(loads).toHaveLength(2);
  for (const load of loads) {
    const button = actionButton(page, "#modal", load);
    const leftType = load.types!.includes(3) ? 4 : 3;
    const leftCount = leftType === 3 ? 2 : 1;
    await expect(button.locator(".cargo-left")).toHaveText(`Left behind: ${leftType === 3 ? "Ceramics" : "Dyes"} ×${leftCount}`);
    await expect(button.locator(".cargo-left")).toBeVisible();
    await expect(button.locator(".cargo-total")).toHaveText(`${load.types!.includes(3) ? 2 : 1} goods`);
  }
  expect(await saved(page)).toEqual(cargoState);
  const load = loads.find(a => a.types!.includes(3))!;
  await actionButton(page, "#modal", load).click();
  expect(await saved(page)).toEqual(applyAction(cargoState, load));
  expect((await saved(page)).depots[0].goods).toEqual([4]);
  expect((await saved(page)).players[0].goods).toEqual([1, 1, 2, 0, 0, 0]);
});

test("player cycle 19: identical ship-region rewards have stable distinct identities", async ({ page }) => {
  const state = position();
  const regions = [...new Set(BOARD.filter(c => c.color === "ship").map(c => c.region))];
  expect(regions).toHaveLength(2);
  for (const region of regions) state.players[0].board[BOARD.find(c => c.region === region)!.id] = state.pools.ship.pop()!;
  await openTable(page, state);
  const buttons = page.locator("#region-insight [data-region-cell]");
  await page.locator('#estate-details > summary').click();
  await expect(buttons).toHaveCount(2);
  const labels = await buttons.locator("small").allTextContents();
  expect(new Set(labels).size).toBe(2);
  expect(labels.slice().sort()).toEqual(regions.map(region => `Region ${region + 1}`).sort());
  for (const button of await buttons.all()) {
    await button.click();
    await expect(button).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator('#region-insight [aria-pressed="true"]')).toHaveCount(1);
    await expect(page.locator("#region-detail")).toContainText("1/3 filled");
  }
  expect(await buttons.locator("small").allTextContents()).toEqual(labels);
  expect(await saved(page)).toEqual(state);
});

test("player cycle 20: blocked build recovers the other die, places, and undoes exactly", async ({ page }) => {
  const state = position(), player = state.players[0];
  const tile = state.pools.building.find(t => t.building === "bank" && BOARD.some(c => canPlace(player, t, c.id)))!;
  state.pools.building.splice(state.pools.building.indexOf(tile), 1);
  player.storage = [tile];
  player.workers = 0;
  const values = BOARD.filter(c => canPlace(player, tile, c.id)).map(c => c.die);
  player.dice = [Array.from({ length: 6 }, (_, i) => i + 1).find(value => !values.includes(value))!, values[0]];
  expect(player.dice[0]).toBeDefined();
  await openTable(page, state);
  await page.locator(`#storage [data-tile="${tile.id}"]`).click();
  await expect(page.locator(".switch-build-die")).toHaveText(`Use die 2 · ${player.dice[1]}`);
  await page.locator(".switch-build-die").click();
  await expect(page.locator('#turn-controls [data-die="1"]')).toHaveAttribute("aria-pressed", "true");
  expect(await saved(page)).toEqual(state);
  const place = legalActions(state).find(a => a.kind === "place" && a.tile === tile.id && a.die === 1)!;
  await clickCell(page, player, place.cell!);
  expect(await saved(page)).toEqual(applyAction(state, place));
  await expectRestored(page, state, () => page.locator('[data-ui="undo"]').click(), place.label);
});

test("player cycle 21: Take recovers the usable die before the player commits a market tile", async ({ page }) => {
  const state = position();
  state.players[0].workers = 0;
  for (const tile of state.depots[0].tiles) state.pools[tile.color].push(tile);
  state.depots[0].tiles = [];
  expect(legalActions(state).some(a => a.kind === "take" && a.die === 0)).toBe(false);
  await openTable(page, state);
  await page.locator('.quick-actions [data-mode="take"]').click();
  await expect(page.locator('#turn-controls [data-die="1"]')).toHaveAttribute("aria-pressed", "true");
  expect(await saved(page)).toEqual(state);
  const take = legalActions(state).find(a => a.kind === "take" && a.die === 1)!;
  await page.locator(`#depots [data-tile="${take.tile}"]`).click();
  expect(await saved(page)).toEqual(applyAction(state, take));
  expect((await saved(page)).players[0].dice).toEqual([1, null]);
});

test("player cycle 22: exhausted dice expose the available purchase and a working final End turn", async ({ page }) => {
  const state = finalTurn();
  state.players[0].dice = [null, null];
  state.players[0].silver = 2;
  await openTable(page, state);
  await expect(page.locator(".turn-hint")).toContainText("Both dice spent. Optional: buy for 2 silver, then End turn.");
  await expect(page.locator(".turn-tools .end-turn")).toBeEnabled();
  await expect(page.locator(".turn-finality")).toHaveCount(0);
  const end = legalActions(state).find(a => a.kind === "end")!;
  await page.locator(".turn-tools .end-turn").click();
  expect(await saved(page)).toEqual(applyAction(state, end));
  await expect(page.locator(".result-player")).toHaveCount(2);
  await expect(page.locator('[data-ui="undo"]')).toBeDisabled();
});

test("player cycle 23: visible undo-expiry warning appears only with reversible moves at End turn", async ({ page }) => {
  const state = finalTurn();
  await openTable(page, state);
  await expect(page.locator(".turn-finality")).toHaveCount(0);
  let current = state;
  for (const die of [0, 1]) {
    const workers = legalActions(current).find(a => a.kind === "workers" && a.die === die)!;
    await page.locator('.quick-actions [data-mode="workers"]').click();
    current = applyAction(current, workers);
    expect(await saved(page)).toEqual(current);
  }
  await expect(page.locator(".turn-finality")).toHaveText("Ending your turn makes these moves final.");
  await expect(page.locator(".turn-finality")).toBeVisible();
  const first = legalActions(state).find(a => a.kind === "workers" && a.die === 0)!;
  const restored = await expectRestored(page, applyAction(state, first), () => page.locator('[data-ui="undo"]').click());
  expect((await saved(page)).players[0].dice).toEqual([null, 2]);
  await expect(page.locator(".turn-finality")).toHaveCount(0);
  current = applyAction(restored, legalActions(restored).find(a => a.kind === "workers" && a.die === 1)!);
  await page.locator('.quick-actions [data-mode="workers"]').click();
  expect(await saved(page)).toEqual(current);
  await expect(page.locator(".turn-finality")).toBeVisible();
  const end = legalActions(current).find(a => a.kind === "end")!;
  await page.locator(".turn-tools .end-turn").click();
  expect(await saved(page)).toEqual(applyAction(current, end));
  await expect(page.locator('[data-ui="undo"]')).toBeDisabled();
  await expect(page.locator(".turn-finality")).toHaveCount(0);
});

test("player cycle 24: 320px and 390px take-to-build flow uses one die per step and supports undo", async ({ page }) => {
  const state = position();
  state.players[0].workers = 6;
  const tile = state.pools.building.find(t => t.building === "bank")!;
  state.pools.building.splice(state.pools.building.indexOf(tile), 1);
  state.depots[0].tiles.push(tile);
  await openTable(page, state, 320);
  for (const width of [320, 390]) {
    await page.setViewportSize({ width, height: 844 });
    await replacePosition(page, state);
    await expect(page.locator("#app")).toHaveAttribute("data-panel", "market");
    const take = legalActions(state).find(a => a.kind === "take" && a.tile === tile.id && a.die === 0)!;
    await page.locator(`#depots [data-tile="${tile.id}"]`).click();
    const afterTake = applyAction(state, take);
    expect(await saved(page)).toEqual(afterTake);
    await expect(page.locator("#app")).toHaveAttribute("data-panel", "estate");
    await expect(page.locator(`#storage [data-tile="${tile.id}"]`)).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator("#board canvas")).toBeInViewport({ ratio: 0.9 });
    const place = legalActions(afterTake).find(a => a.kind === "place" && a.tile === tile.id && a.die === 1)!;
    await clickCell(page, afterTake.players[0], place.cell!);
    expect(await saved(page)).toEqual(applyAction(afterTake, place));
    expect((await saved(page)).players[0].dice).toEqual([null, null]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await expectRestored(page, afterTake, () => page.locator('[data-ui="undo"]').click(), place.label);
    await expectRestored(page, state, () => page.locator('[data-ui="undo"]').click(), take.label);
  }
});

test("player cycle 25: full-reserve choice can be cancelled, committed explicitly, then undone", async ({ page }) => {
  const state = position();
  state.players[0].storage = [state.pools.mine.pop()!, state.pools.ship.pop()!, state.pools.castle.pop()!];
  await openTable(page, state);
  const take = legalActions(state).find(a => a.kind === "take" && a.die === 0 && a.discard === state.players[0].storage[0].id)!;
  const target = page.locator(`#depots [data-tile="${take.tile}"]`);
  await target.click();
  await expect(page.locator("#modal-title")).toHaveText("Your reserve is full");
  await expect(page.locator("#modal .replacement-loss")).toHaveCount(3);
  for (const tile of state.players[0].storage) {
    await expect(page.locator("#modal .replacement-loss").filter({ hasText: `Give up ${tileName(tile, state.ruleset)}:` })).toHaveCount(1);
  }
  await page.getByRole("button", { name: "Back to table", exact: true }).click();
  expect(await saved(page)).toEqual(state);
  await target.click();
  await actionButton(page, "#modal", take).click();
  expect(await saved(page)).toEqual(applyAction(state, take));
  expect((await saved(page)).players[0].storage).toHaveLength(3);
  await expectRestored(page, state, () => page.locator('[data-ui="undo"]').click(), take.label);
});
