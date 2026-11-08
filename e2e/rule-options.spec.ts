import { expect, test, type Page } from "@playwright/test";
import { expectRestored } from "./undo-assertions";
import { actionKey, applyAction, createGame, legalActions } from "../src/engine";
import type { Ruleset, State } from "../src/types";

const KEY = "burgundy-table.state.v1";
function position(ruleset?: Ruleset): State {
  const s = createGame(42, ruleset ? { ruleset } : {});
  s.active = 0; s.order = [0, 1]; s.turnIndex = 0;
  s.players[0].dice = [1, 2];
  return s;
}
async function open(page: Page, state: State) {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.addInitScript(({ key, state }) => {
    if (sessionStorage.getItem("rule-options-fixture")) return;
    localStorage.setItem(key, JSON.stringify(state));
    sessionStorage.setItem("rule-options-fixture", "yes");
  }, { key: KEY, state });
  await page.goto("/");
  await expect(page.locator("#turn-controls")).toBeVisible();
}
const saved = (page: Page): Promise<State> => page.evaluate(key => JSON.parse(localStorage.getItem(key)!), KEY);

for (const width of [1440, 390]) {
  test(`new-game rule options explain differences, cancel safely and persist at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
    const before = position();
    await open(page, before);
    await page.locator('[data-ui="new"]').click();
    await expect(page.getByLabel("Rules", { exact: true })).toHaveValue("original-2011");
    await expect(page.locator("#rule-options-summary")).toContainText("Most empty estate spaces");
    await page.getByLabel("Rules", { exact: true }).selectOption("special-edition");
    await expect(page.locator("#rule-options-summary")).toContainText("2 workers without a die");
    await expect(page.locator("#rule-options-summary")).toContainText("Knowledge 15: 2 VP");
    await expect(page.locator("#rule-options-summary")).toContainText("Knowledge 26: 3 VP");
    await expect(page.locator("#rule-options-summary")).toContainText("Fewest empty estate spaces");
    await expect(page.locator("#rule-options-summary")).toContainText("without expansions");
    expect(await saved(page)).toEqual(before);
    expect(await page.locator("#modal").evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`rules-${width}.png`), fullPage: true });
    await page.getByRole("button", { name: "Keep this table", exact: true }).click();
    expect(await saved(page)).toEqual(before);

    await page.locator('[data-ui="new"]').click();
    await expect(page.getByLabel("Rules", { exact: true })).toHaveValue("original-2011");
    await page.getByLabel("Rules", { exact: true }).selectOption("special-edition");
    await page.locator('[data-ui="confirm-new"]').click();
    await expect.poll(async () => (await saved(page)).ruleset).toBe("special-edition");
    await page.locator('[data-ui="help"]').click();
    await expect(page.getByRole("region", { name: "Current rules" })).toContainText("Special Edition rule changes");
    await expect(page.locator("#guide-scoring")).toContainText("fewest empty estate spaces wins");
    await expect(page.locator(".knowledge-folio section").filter({ has: page.locator('.folio-number', { hasText: /^15$/ }) })).toContainText("2 points per different goods type sold");
    await page.reload();
    expect((await saved(page)).ruleset).toBe("special-edition");
    await page.locator('[data-ui="new"]').click();
    await expect(page.getByLabel("Rules", { exact: true })).toHaveValue("special-edition");
  });
}

test("Special Edition knowledge 6 uses workers, preserves its bonus, and is independent of silver buying", async ({ page }) => {
  const before = position("special-edition"), p = before.players[0];
  p.board[12] = { id: "owned-6", color: "knowledge", knowledge: 6 };
  p.workers = 2; p.silver = 2;
  p.storage = [{ id: "reserve-a", color: "mine" }, { id: "reserve-b", color: "ship" }, { id: "reserve-c", color: "castle" }];
  before.pending = [{ kind: "place" }];
  before.depots.forEach(d => { d.tiles = []; });
  before.depots[4].tiles = [
    { id: "trade-building", color: "building", building: "bank" },
    { id: "not-a-building", color: "mine" },
  ];
  before.black = [{ id: "silver-building", color: "building", building: "church" }];
  await open(page, before);
  await page.locator('#black-market [data-mode="trade"]').click();
  await expect(page.locator('[data-tile="not-a-building"]')).toHaveAttribute("aria-disabled", "true");
  await expect(page.locator('[data-tile="trade-building"]')).toHaveAttribute("aria-disabled", "false");
  await expect(page.locator('[data-tile="silver-building"]')).toHaveAttribute("aria-disabled", "false");
  await page.locator('[data-tile="trade-building"]').click();
  const trade = legalActions(before).find(a => a.kind === "trade" && a.discard === "reserve-a")!;
  await page.locator(`#modal [data-action-key=${JSON.stringify(actionKey(trade))}]`).click();
  const afterTrade = applyAction(before, trade);
  expect(await saved(page)).toEqual(afterTrade);
  expect(afterTrade.players[0].workers).toBe(0);
  expect(afterTrade.players[0].silver).toBe(2);
  expect(afterTrade.players[0].dice).toEqual([1, 2]);
  expect(afterTrade.pending).toEqual([{ kind: "place" }]);
  await expect(page.locator('#black-market [data-mode="trade"]')).toBeDisabled();
  const restored = await expectRestored(page, before, () => page.locator('[data-ui="undo"]').click(), trade.label);
  const replayedTrade = applyAction(restored, trade);

  await page.locator('#black-market [data-mode="trade"]').click();
  await page.locator('[data-tile="trade-building"]').click();
  await page.locator(`#modal [data-action-key=${JSON.stringify(actionKey(trade))}]`).click();
  await page.reload();
  expect(await saved(page)).toEqual(replayedTrade);
  await expect(page.locator('#black-market [data-mode="trade"]')).toBeDisabled();
  await page.locator('[data-tile="silver-building"]').click();
  const buy = legalActions(replayedTrade).find(a => a.kind === "buy" && a.discard === "reserve-b")!;
  await page.locator(`#modal [data-action-key=${JSON.stringify(actionKey(buy))}]`).click();
  expect(await saved(page)).toEqual(applyAction(replayedTrade, buy));
});

for (const ruleset of ["original-2011", "special-edition"] as const) {
  test(`${ruleset} help, tile tooltips and final winner follow that profile`, async ({ page }) => {
    const before = position(ruleset);
    before.phase = 4; before.round = 4; before.order = [1, 0]; before.turnIndex = 1;
    before.players.forEach(p => { p.dice = [null, null]; p.goods.fill(0); p.silver = 0; p.workers = 0; p.score = 40; });
    before.players[0].board[11] = { id: "extra-building", color: "building", building: "bank" };
    before.depots[0].tiles = [{ id: "preview-6", color: "knowledge", knowledge: 6 }];
    await open(page, before);
    const tooltip = ruleset === "original-2011" ? "once-per-turn purchase" : "spend 2 workers";
    await expect(page.locator('[data-tile="preview-6"]')).toHaveAccessibleName(new RegExp(tooltip));
    const expected = applyAction(before, legalActions(before).find(a => a.kind === "end")!);
    expect(expected.winner).toBe(ruleset === "original-2011" ? 1 : 0);
    await page.locator('#turn-controls .turn-tools .end-turn').click();
    await expect(page.locator('.result-player.winner h3')).toHaveText(expected.players[expected.winner!].name);
    expect(await saved(page)).toEqual(expected);
  });
}
