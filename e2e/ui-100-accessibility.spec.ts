import { expect, test, type Locator, type Page } from "@playwright/test";
import { expectRestored } from "./undo-assertions";
import { actionKey, applyAction, createGame, legalActions } from "../src/engine";
import { BOARD } from "../src/data";
import type { State } from "../src/types";

const KEY = "burgundy-table.state.v1";
test.use({ reducedMotion: "reduce" });

function position(): State {
  const state = createGame(42);
  state.active = 0;
  state.order = [0, 1];
  state.turnIndex = 0;
  state.players[0].dice = [1, 2];
  state.players[0].workers = 2;
  state.players[0].arrival = 1;
  state.players[1].arrival = 0;
  return state;
}

async function openTable(page: Page, state: State, width = 1440) {
  await page.setViewportSize({ width, height: width <= 600 ? 844 : 1000 });
  await page.addInitScript(({ key, state }) => {
    // Seed this isolated context once; a reload must retain committed progress.
    if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify(state));
  }, { key: KEY, state });
  await page.goto("/");
  await page.evaluate(() => document.fonts.ready);
  await expect(page.locator("#turn-controls")).toBeVisible();
}

async function saved(page: Page): Promise<State> {
  return page.evaluate(key => JSON.parse(localStorage.getItem(key)!), KEY);
}

async function expectVisibleFocus(control: Locator) {
  await expect(control).toBeFocused();
  await expect(control).toBeInViewport({ ratio: 1 });
  expect(await control.evaluate(el => {
    const box = el.getBoundingClientRect();
    return el.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2));
  })).toBe(true);
}

test("01 leaving legal choices exposes the next phone keyboard target without losing actions", async ({ page }) => {
  const state = position();
  await openTable(page, state, 390);
  const details = page.locator("#legal-details");
  const summary = details.locator("summary");
  const choices = page.locator("#legal-actions [data-action-key]");
  const keys = legalActions(state).map(actionKey);
  await summary.focus();
  await page.keyboard.press("Enter");
  await expect(choices).toHaveCount(keys.length);
  await choices.last().focus();
  await page.keyboard.press("Tab");
  await expect(details).toHaveJSProperty("open", false);
  await expectVisibleFocus(page.locator('.mobile-navigation [data-panel="market"]'));

  await summary.focus();
  await page.keyboard.press("Enter");
  expect(await choices.evaluateAll(nodes => nodes.map(el => el.getAttribute("data-action-key")).sort()))
    .toEqual([...keys].sort());
  expect(await saved(page)).toEqual(state);
});

test("02 End turn retains meaningful focus during and after a rival turn with no human buttons", async ({ page }) => {
  const state = position();
  state.players[0].dice = [null, null];
  state.players[1].dice = [null, null];
  state.players[1].silver = 0;
  const end = legalActions(state).find(action => action.kind === "end")!;
  const rivalTurn = applyAction(state, end);
  expect(legalActions(rivalTurn).map(action => action.kind)).toEqual(["end"]);
  await openTable(page, state);
  await page.locator("#turn-controls .turn-tools .end-turn").focus();
  await page.keyboard.press("Enter");
  const controls = page.locator("#turn-controls");
  await expect(controls).toBeFocused();
  // The seeded rival only needs to end its turn; no arbitrary animation sleeps.
  await expect.poll(async () => (await saved(page)).round, { timeout: 10_000 }).toBe(state.round + 1);
  expect((await saved(page)).active).toBe(0);
  await expect(controls).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.locator('#turn-controls [data-die="0"]')).toBeFocused();
});

test("03 phone Build shortcuts and Enter retain visible focus and the complete placement fallback", async ({ page }) => {
  const state = position();
  state.players[0].storage = [state.pools.ship.pop()!];
  state.players[0].workers = 6;
  const placements = legalActions(state).filter(action => action.kind === "place");
  expect(placements.length).toBeGreaterThan(0);
  await openTable(page, state, 390);
  const build = page.locator('.quick-actions [data-mode="place"]');
  await page.keyboard.press("2");
  await expect(page.locator("#app")).toHaveAttribute("data-panel", "estate");
  await expectVisibleFocus(build);
  await page.keyboard.press("1");
  await expect(page.locator("#app")).toHaveAttribute("data-panel", "market");
  await build.focus();
  await page.keyboard.press("Enter");
  await expectVisibleFocus(build);

  const summary = page.locator("#legal-details > summary");
  await summary.focus();
  await page.keyboard.press("Enter");
  const choices = page.locator("#legal-place + .legal-group-actions [data-action-key]");
  await expect(choices).toHaveCount(placements.length);
  await choices.first().focus();
  await expectVisibleFocus(choices.first());
  expect(await saved(page)).toEqual(state);
});

test("04 each move and Undo has one live receipt while visible feedback remains available", async ({ page }) => {
  const state = position();
  const workers = legalActions(state).find(action => action.kind === "workers" && action.die === 0)!;
  await openTable(page, state);
  await page.locator('.quick-actions [data-mode="workers"]').focus();
  await page.keyboard.press("Enter");
  const feedback = page.locator("#feedback");
  const announcer = page.locator("#announcer");
  const liveRegions = page.locator('[role="status"], [role="alert"], [aria-live="polite"], [aria-live="assertive"]');
  const receipt = `You: ${workers.label}.`;
  await expect(feedback).toBeVisible();
  await expect(feedback).toHaveText(receipt);
  await expect(announcer).toHaveText(`${receipt} Your turn.`);
  await expect(liveRegions.filter({ hasText: receipt })).toHaveCount(1);
  expect(await saved(page)).toEqual(applyAction(state, workers));

  await page.locator('[data-ui="undo"]').focus();
  await expectRestored(page, state, () => page.keyboard.press("Enter"), workers.label);
  const undone = "Move undone. Your die, tiles, points and resources are restored.";
  await expect(feedback).toBeVisible();
  await expect(feedback).toHaveText(undone);
  await expect(announcer).toHaveText(`${undone} Your turn.`);
  await expect(liveRegions.filter({ hasText: undone })).toHaveCount(1);
});

for (const knowledge of [false, true]) {
  test(`${knowledge ? "06" : "05"} compact sales expose exact ${knowledge ? "knowledge-enhanced" : "standard"} rewards and worker costs`, async ({ page }) => {
    const state = position();
    const player = state.players[0];
    player.goods = [0, 2, 0, 0, 0, 0];
    if (knowledge) {
      const cells = BOARD.filter(cell => cell.color === "knowledge" && !player.board[cell.id]);
      for (const [index, id] of [3, 4].entries()) {
        const sources = [...Object.values(state.pools), ...state.depots.map(depot => depot.tiles), state.black];
        const source = sources.find(tiles => tiles.some(tile => tile.knowledge === id))!;
        player.board[cells[index].id] = source.splice(source.findIndex(tile => tile.knowledge === id), 1)[0];
      }
    }
    const sale = legalActions(state).find(action => action.kind === "sell" && action.die === 0)!;
    expect(sale.cost).toBe(1);
    const next = applyAction(state, sale);
    const points = next.players[0].score - player.score;
    const silver = next.players[0].silver - player.silver;
    const workers = next.players[0].workers - player.workers + sale.cost;
    const payout = `Earn +${points} VP · +${silver} silver${workers ? ` · +${workers} worker` : ""}`;
    await openTable(page, state);
    await page.locator("#legal-details > summary").focus();
    await page.keyboard.press("Enter");
    const button = page.locator(`#legal-actions [data-action-key=${JSON.stringify(actionKey(sale))}]`);
    await button.focus();
    await expect(button.locator(".action-payout")).toHaveText(payout);
    await expect(button).toHaveAccessibleName(new RegExp(`\\+${silver} silver`));
    await expect(button.locator(".action-cost")).toHaveText("1 worker");
    expect(await saved(page)).toEqual(state);
    await page.keyboard.press("Enter");
    expect(await saved(page)).toEqual(next);
  });
}

// Fifteen distinct scenario reviews; these are review cycles, not fifteen fixes.
test("cycle11 new-game keyboard options are labelled and cancellation restores the opener", async ({ page }) => {
  const state = position();
  await openTable(page, state, 390);
  const opener = page.locator('[data-ui="new"]');
  await opener.focus();
  await page.keyboard.press("Enter");
  for (const label of ["Players", "Estate setup", "Rules"]) {
    await page.keyboard.press("Tab");
    await expect(page.getByRole("combobox", { name: label, exact: true })).toBeFocused();
  }
  // Native type-ahead commits without relying on an OS-owned popup in headless macOS.
  await page.keyboard.press("s");
  await expect(page.getByRole("combobox", { name: "Rules", exact: true })).toHaveValue("special-edition");
  await expect(page.locator("#rule-options-summary")).toContainText("2 workers");
  await page.keyboard.press("Escape");
  await expectVisibleFocus(opener);
  expect(await saved(page)).toEqual(state);
});

test("cycle12 advanced starting-castle keyboard selection names and commits the chosen location", async ({ page }) => {
  const state = createGame(42, { estates: "open" });
  state.active = 0;
  state.order = [0, 1];
  state.turnIndex = 0;
  await openTable(page, state);
  const castle = page.locator("#start-castle");
  expect(await castle.locator("option").count()).toBeGreaterThan(1);
  await castle.focus();
  await page.keyboard.type("Castle 2");
  const cell = Number(await castle.inputValue());
  await expect(castle).toBeFocused();
  await expect(castle.locator("option:checked")).toContainText(/Castle 2 · Row \d+ · space \d+ · die [1-6]/);
  const confirm = page.locator('[data-ui="confirm-estate"]');
  await expect(confirm).toContainText("Castle 2");
  expect(await saved(page)).toEqual(state);
  await page.keyboard.press("Tab");
  await expect(confirm).toBeFocused();
  await page.keyboard.press("Enter");
  expect((await saved(page)).setup?.choices[0]?.cell).toBe(cell);
});

test("cycle13 dismissing an optional sale restores keyboard focus without selling", async ({ page }) => {
  const state = position();
  state.players[0].goods = [2, 0, 0, 0, 0, 0];
  await openTable(page, state);
  const sell = page.locator('.quick-actions [data-mode="sell"]');
  await sell.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog", { name: "Sell a goods type" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(sell).toBeFocused();
  expect(await saved(page)).toEqual(state);
});

test("cycle14 cancelling a full-reserve replacement restores its original tile target", async ({ page }) => {
  const state = position();
  state.players[0].storage = [state.pools.mine.pop()!, state.pools.ship.pop()!, state.pools.castle.pop()!];
  await openTable(page, state);
  const tile = page.locator("#depots .action-target").first();
  await tile.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog", { name: "Your reserve is full" })).toBeVisible();
  await expect(page.locator("#modal [data-action]")).toHaveCount(3);
  await page.getByRole("button", { name: "Back to table", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(tile).toBeFocused();
  expect(await saved(page)).toEqual(state);
});

test("cycle15 pending harbor choices can be dismissed and resumed without silently loading cargo", async ({ page }) => {
  const state = position();
  state.pending = [{ kind: "ship" }];
  state.depots[0].goods = [1];
  await openTable(page, state);
  await expect(page.getByRole("dialog", { name: "Choose a harbor" })).toBeVisible();
  await page.keyboard.press("Escape");
  const resume = page.locator('[data-ui="resume-bonus"]');
  await expect(resume).toBeEnabled();
  await resume.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog", { name: "Choose a harbor" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(resume).toBeFocused();
  await page.locator("#legal-details > summary").focus();
  await page.keyboard.press("Enter");
  expect(await page.locator("#legal-actions [data-action-key]").evaluateAll(nodes => nodes.map(el => el.getAttribute("data-action-key")).sort()))
    .toEqual(legalActions(state).map(actionKey).sort());
  expect(await saved(page)).toEqual(state);
});

test("cycle16 unavailable Build explains recovery for Enter and Space without spending a die", async ({ page }) => {
  const state = position();
  await openTable(page, state);
  const build = page.locator('.quick-actions [data-mode="place"]');
  await expect(build).toBeDisabled();
  await expect(build).toHaveJSProperty("disabled", false);
  await build.focus();
  await expect(build).toHaveAttribute("aria-describedby", "market-tooltip");
  for (const key of ["Enter", "Space"]) {
    await page.keyboard.press(key);
    await expect(build).toBeFocused();
    await expect(page.locator("#announcer")).toContainText("before building");
    expect(await saved(page)).toEqual(state);
  }
  await page.keyboard.press("Escape");
  await expect(page.locator("#market-tooltip")).toBeHidden();
});

test("cycle17 phone turn-control skip link places visible focus directly at the dice", async ({ page }) => {
  const state = position();
  await openTable(page, state, 390);
  await page.getByRole("link", { name: "Skip to turn controls", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("#turn-controls")).toBeFocused();
  await page.keyboard.press("Tab");
  await expectVisibleFocus(page.locator('#turn-controls [data-die="0"]'));
  expect(await saved(page)).toEqual(state);
});

test("cycle18 phone estate skip link returns from a rival to the human estate", async ({ page }) => {
  const state = position();
  await openTable(page, state, 390);
  await page.locator('.mobile-navigation [data-panel="estate"]').click();
  await page.locator('[data-view="1"]').click();
  await page.locator('.mobile-navigation [data-panel="market"]').click();
  await page.getByRole("link", { name: "Skip to your estate", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("#app")).toHaveAttribute("data-panel", "estate");
  await expect(page.locator("#estate")).toBeFocused();
  await expect(page.locator("#estate-title")).toHaveText("Your estate");
  await expect(page.locator('[data-view="0"]')).toHaveAttribute("aria-pressed", "true");
  expect(await saved(page)).toEqual(state);
});

test("cycle19 phone legal skip link exposes every placement without requiring the canvas", async ({ page }) => {
  const state = position();
  state.players[0].storage = [state.pools.ship.pop()!];
  state.players[0].workers = 6;
  await openTable(page, state, 390);
  await page.getByRole("link", { name: "Skip to legal choices", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("#legal-details")).toHaveJSProperty("open", true);
  await expectVisibleFocus(page.locator("#legal-actions button").first());
  await expect(page.locator("#legal-place + .legal-group-actions button"))
    .toHaveCount(legalActions(state).filter(action => action.kind === "place").length);
  expect(await saved(page)).toEqual(state);
});

test("cycle20 disabling single-key shortcuts retains modified keyboard Undo", async ({ page }) => {
  const state = position();
  await openTable(page, state);
  await page.keyboard.press("4");
  const moved = await saved(page);
  await page.locator('[data-ui="help"]').focus();
  await page.keyboard.press("Enter");
  await page.locator('#modal [data-ui="shortcuts"]').focus();
  await page.keyboard.press("Space");
  await expect(page.locator('#modal [data-ui="shortcuts"]')).toHaveAttribute("aria-pressed", "false");
  await page.keyboard.press("Escape");
  await page.keyboard.press("4");
  expect(await saved(page)).toEqual(moved);
  await expectRestored(page, state, () => page.keyboard.press("Control+z"));
});

test("cycle21 rival completion does not steal focus deliberately moved away from the turn fallback", async ({ page }) => {
  const state = position();
  state.players[0].dice = [null, null];
  state.players[1].dice = [null, null];
  state.players[1].silver = 0;
  await openTable(page, state);
  await page.locator("#turn-controls .turn-tools .end-turn").focus();
  await page.keyboard.press("Enter");
  const sound = page.locator('[data-ui="sound"]');
  await sound.focus();
  await expect.poll(async () => (await saved(page)).round, { timeout: 10_000 }).toBe(state.round + 1);
  expect((await saved(page)).active).toBe(0);
  await expect(sound).toBeFocused();
});

test("cycle22 reduced motion permits consecutive immediate worker moves and Undo", async ({ page }) => {
  const state = position();
  const first = legalActions(state).find(action => action.kind === "workers" && action.die === 0)!;
  const once = applyAction(state, first);
  const second = legalActions(once).find(action => action.kind === "workers" && action.die === 1)!;
  await openTable(page, state);
  expect(await page.evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches)).toBe(true);
  await page.keyboard.press("4");
  await page.keyboard.press("4");
  expect(await saved(page)).toEqual(applyAction(once, second));
  await expectRestored(page, once, () => page.keyboard.press("z"), second.label);
});

test("cycle23 denied storage retains honest warnings and playable session-only keyboard moves", async ({ page }) => {
  const state = position();
  await page.addInitScript(({ key, state }) => {
    const original = Storage.prototype.setItem;
    original.call(localStorage, key, JSON.stringify(state));
    Storage.prototype.setItem = function(name, value) {
      if (name === key) throw new DOMException("Storage unavailable", "QuotaExceededError");
      return original.call(this, name, value);
    };
  }, { key: KEY, state });
  await openTable(page, state);
  await expect(page.locator("#notice")).toContainText("will not survive a reload");
  await expect(page.locator(".table-footer")).toContainText("Not saved · keep this tab open");
  await page.keyboard.press("4");
  await expect(page.locator('#turn-controls [data-die="0"]')).toHaveAccessibleName("Die 1: used");
  await expect(page.locator("#announcer")).toContainText("Take 2 workers");
  await expect(page.locator("#save-status")).toHaveText("○ Not saved");
  await expect(page.locator(".table-footer")).not.toContainText("Saved on this device");
  expect(await saved(page)).toEqual(state);
});

test("cycle24 Escape closes legal choices and restores their visible disclosure", async ({ page }) => {
  const state = position();
  await openTable(page, state, 390);
  const summary = page.locator("#legal-details > summary");
  await summary.focus();
  await page.keyboard.press("Enter");
  await page.locator("#legal-actions button").first().focus();
  await page.keyboard.press("Escape");
  await expect(page.locator("#legal-details")).toHaveJSProperty("open", false);
  await expectVisibleFocus(summary);
  expect(await saved(page)).toEqual(state);
});

test("cycle25 identical worker and Undo receipts each announce once without selection reannouncements", async ({ page }) => {
  const state = position();
  await openTable(page, state);
  await page.evaluate(() => {
    const announcer = document.getElementById("announcer")!;
    announcer.dataset.receipts = "0";
    announcer.dataset.undos = "0";
    new MutationObserver(() => {
      if (announcer.textContent?.includes("You: Take 2 workers.")) {
        announcer.dataset.receipts = String(Number(announcer.dataset.receipts) + 1);
      }
      if (announcer.textContent?.includes("Move undone.")) {
        announcer.dataset.undos = String(Number(announcer.dataset.undos) + 1);
      }
    }).observe(announcer, { childList: true, characterData: true, subtree: true });
  });
  await page.keyboard.press("4");
  await expect(page.locator("#announcer")).toHaveAttribute("data-receipts", "1");
  const once = await saved(page);
  await page.keyboard.press("4");
  await expect(page.locator("#announcer")).toHaveAttribute("data-receipts", "2");
  await expect(page.locator('[role="status"], [aria-live="polite"]').filter({ hasText: "You: Take 2 workers." }))
    .toHaveCount(1);
  expect((await saved(page)).players[0].dice).toEqual([null, null]);
  await expectRestored(page, once, () => page.keyboard.press("z"));
  await expect(page.locator("#announcer")).toHaveAttribute("data-undos", "1");
  const restored = await expectRestored(page, state, () => page.keyboard.press("z"));
  await expect(page.locator("#announcer")).toHaveAttribute("data-undos", "2");
  await page.locator('#turn-controls [data-die="1"]').focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("#announcer")).toHaveAttribute("data-receipts", "2");
  await expect(page.locator("#announcer")).toHaveAttribute("data-undos", "2");
  expect(await saved(page)).toEqual(restored);
});
