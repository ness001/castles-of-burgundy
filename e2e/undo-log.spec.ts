import { expect, test, type Page } from "@playwright/test";
import { applyAction, createGame, legalActions } from "../src/engine";
import type { State } from "../src/types";

const KEY = "burgundy-table.state.v1";
test.use({ reducedMotion: "reduce" });

function position(): State {
  const state = createGame(42);
  state.active = 0;
  state.order = [0, 1];
  state.turnIndex = 0;
  state.players[0].dice = [1, 2];
  state.players[0].workers = 6;
  state.players[0].goods = [2, 0, 0, 0, 0, 0];
  return state;
}

async function openTable(page: Page, state: State) {
  await page.addInitScript(({ key, state }) => {
    if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify(state));
  }, { key: KEY, state });
  await page.goto("/");
  await expect(page.locator("#turn-controls")).toBeVisible();
}

const saved = (page: Page): Promise<State> => page.evaluate(key => JSON.parse(localStorage.getItem(key)!), KEY);

test("recent moves retain actions and named undo entries through repeated undo, replay and reload", async ({ page }) => {
  const before = position();
  await openTable(page, before);
  const worker = legalActions(before).find(action => action.kind === "workers" && action.die === 0)!;
  const first = applyAction(before, worker);
  await page.locator('#turn-controls [data-mode="workers"]').click();
  expect(await saved(page)).toEqual(first);

  const sale = legalActions(first).find(action => action.kind === "sell" && action.good === 1 && action.die === 1)!;
  const second = applyAction(first, sale);
  await page.locator('#goods [data-good="1"]').click();
  expect(await saved(page)).toEqual(second);

  const undoSale = `You: Undo — ${sale.label}.`;
  const undoWorkers = `You: Undo — ${worker.label}.`;
  await page.locator('[data-ui="undo"]').click();
  expect(await saved(page)).toEqual({ ...first, log: [...second.log, undoSale] });
  await page.keyboard.press("Control+z");
  const restored = { ...before, log: [...second.log, undoSale, undoWorkers] };
  expect(await saved(page)).toEqual(restored);
  await expect(page.locator('[data-ui="undo"]')).toBeDisabled();
  await page.keyboard.press("z");
  expect(await saved(page)).toEqual(restored);

  await page.getByText("Recent moves", { exact: true }).click();
  await expect(page.locator("#journal > li:not(.earlier-moves) > span:last-child")).toHaveText([
    undoWorkers, undoSale, second.log.at(-1)!, first.log.at(-1)!,
  ]);
  await page.locator("#journal summary").click();
  await page.locator('#turn-controls [data-die="1"]').click();
  await expect(page.locator("#journal details")).toHaveJSProperty("open", true);
  expect(await saved(page)).toEqual(restored);

  // A new branch and another undo must not erase the previous reversals.
  await page.locator('#turn-controls [data-die="0"]').click();
  await page.locator('#turn-controls [data-mode="workers"]').click();
  const replayed = applyAction(restored, worker);
  expect(await saved(page)).toEqual(replayed);
  await page.keyboard.press("z");
  const final = { ...before, log: [...replayed.log, undoWorkers] };
  expect(await saved(page)).toEqual(final);
  await page.reload();
  await expect(page.locator('[data-ui="undo"]')).toBeDisabled();
  expect(await saved(page)).toEqual(final);
  await page.getByText("Recent moves", { exact: true }).click();
  await expect(page.locator("#journal > .latest > span:last-child")).toHaveText(undoWorkers);
});

test("undo keeps the existing 100-entry journal limit without restoring evicted entries", async ({ page }) => {
  const before = position();
  before.log = Array.from({ length: 100 }, (_, index) => `Earlier event ${index + 1}`);
  await openTable(page, before);
  const worker = legalActions(before).find(action => action.kind === "workers" && action.die === 0)!;
  const moved = applyAction(before, worker);
  await page.locator('#turn-controls [data-mode="workers"]').click();
  await page.locator('[data-ui="undo"]').click();
  const log = [...moved.log, `You: Undo — ${worker.label}.`].slice(-100);
  expect(await saved(page)).toEqual({ ...before, log });
  expect(log).toHaveLength(100);
  expect(log[0]).toBe("Earlier event 3");
  await page.getByText("Recent moves", { exact: true }).click();
  await expect(page.locator("#journal > .latest")).toContainText("You: Undo — Take 2 workers.");
  await expect(page.locator("#journal summary")).toHaveText("Earlier moves (96)");
});

test("an automatic harbor load stays one undo step with one persistent undo entry", async ({ page }) => {
  const before = position();
  before.pending = [{ kind: "ship" }];
  before.players[0].goods = [1, 1, 0, 0, 0, 0];
  before.depots.forEach((depot, index) => { depot.goods = index === 0 ? [1, 3, 3] : []; });
  const ship = legalActions(before).find(action => action.kind === "ship" && action.depots?.length === 1 && action.depots[0] === 0)!;
  const atHarbor = applyAction(before, ship);
  const loads = legalActions(atHarbor).filter(action => action.kind === "goods");
  expect(loads).toHaveLength(1);
  const loaded = applyAction(atHarbor, loads[0]);
  await openTable(page, before);
  await page.getByRole("dialog").getByRole("button", { name: /^Collect goods from depot 1\./ }).click();
  expect(await saved(page)).toEqual(loaded);
  await page.locator('[data-ui="undo"]').click();
  const undo = `You: Undo — ${ship.label}.`;
  expect(await saved(page)).toEqual({ ...before, log: [...loaded.log, undo] });
  await expect(page.locator('[data-ui="undo"]')).toBeDisabled();
  await page.getByText("Recent moves", { exact: true }).click();
  await expect(page.locator("#journal > .latest > span:last-child")).toHaveText(undo);
});
