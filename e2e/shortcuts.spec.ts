import { expect, test, type Page } from "@playwright/test";
import { expectRestored } from "./undo-assertions";
import { BOARD } from "../src/data";
import { applyAction, canPlace, createGame, legalActions } from "../src/engine";
import type { State, Tile } from "../src/types";

const SAVE_KEY = "burgundy-table.state.v1";
const SHORTCUTS_KEY = "burgundy-table.shortcuts.v1";

function position(): State {
  const state = createGame(42);
  state.active = 0;
  state.order = [0, 1];
  state.turnIndex = 0;
  state.players[0].dice = [1, 2];
  state.players[0].workers = 6;
  state.players[0].goods = [2, 1, 0, 0, 0, 0];
  return state;
}

async function openTable(page: Page, state = position()) {
  await page.addInitScript(({ key, state }) => {
    if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify(state));
  }, { key: SAVE_KEY, state });
  await page.goto("/");
  await expect(page.locator("#turn-controls")).toBeVisible();
  await expect(page.locator("#board canvas")).toBeAttached();
}

async function saved(page: Page): Promise<State> {
  return page.evaluate(key => JSON.parse(localStorage.getItem(key)!), SAVE_KEY);
}

test("action shortcuts use the selected die, retain focus and undo exactly once", async ({ page }) => {
  const before = position();
  const tile: Tile = { id: "shortcut-build", color: "building", building: "bank" };
  const cell = BOARD.find(cell => canPlace(before.players[0], tile, cell.id))!;
  before.players[0].storage = [tile];
  before.players[0].dice[0] = cell.die;
  await openTable(page, before);

  for (const [kind, key] of [["take", "1"], ["place", "2"], ["sell", "3"], ["workers", "4"]]) {
    await expect(page.locator(`[data-mode="${kind}"]`)).toHaveAttribute("aria-keyshortcuts", key);
    await expect(page.locator(`[data-mode="${kind}"] kbd`)).toHaveCount(0);
  }
  await page.keyboard.press("2");
  await expect(page.locator('[data-mode="place"]')).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator('[data-mode="place"]')).toBeFocused();
  await expect(page.locator('#storage [aria-pressed="true"]')).toHaveAttribute("data-tile", tile.id);
  expect(await saved(page)).toEqual(before);

  await page.keyboard.press("1");
  await expect(page.locator('[data-mode="take"]')).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator('[data-mode="take"]')).toBeFocused();
  await page.keyboard.press("3");
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Sell a goods type" })).toBeVisible();
  await page.keyboard.press("4");
  expect(await saved(page)).toEqual(before);
  await page.keyboard.press("Escape");
  await expect(page.locator('[data-mode="sell"]')).toBeFocused();

  await page.locator('[data-die="1"]').click();
  const workers = legalActions(before).find(action => action.kind === "workers" && action.die === 1)!;
  const after = applyAction(before, workers);
  await page.keyboard.down("4");
  await page.keyboard.down("4"); // The repeated keydown must not spend the second die.
  await page.keyboard.up("4");
  expect(await saved(page)).toEqual(after);
  await expectRestored(page, before, () => page.keyboard.press("z"), workers.label);
  await expect(page.locator('[data-ui="undo"]')).toBeDisabled();
  await expect(page.locator('[data-die="0"]')).toBeFocused();

  for (const shortcut of ["Control+z", "Meta+z"]) {
    await page.keyboard.press("4");
    await expectRestored(page, before, () => page.keyboard.press(shortcut), workers.label);
  }
});

test("shortcuts respect disabled actions, bonus resolution, end-turn legality and AI turns", async ({ page }) => {
  const before = position();
  await openTable(page, before);
  await expect(page.locator('[data-mode="place"]')).toBeDisabled();
  for (const key of ["2", "e", "z"]) await page.keyboard.press(key);
  expect(await saved(page)).toEqual(before);

  await page.clock.install();
  await page.clock.pauseAt(new Date(Date.now() + 1000));
  await page.keyboard.press("4");
  await page.keyboard.press("4");
  const end = page.locator("#turn-controls .turn-tools .end-turn");
  await expect(end).toBeEnabled();
  await expect(end).toHaveAttribute("aria-keyshortcuts", "e");
  await expect(end.locator("kbd")).toHaveCount(0);
  await expect(end).toBeFocused();
  await page.keyboard.press("e");
  const aiTurn = await saved(page);
  expect(aiTurn.active).toBe(1);
  await expect(page.locator('[data-ui="undo"]')).toBeDisabled();
  for (const key of ["1", "2", "3", "4", "e", "z", "Control+z", "Meta+z"]) await page.keyboard.press(key);
  expect(await saved(page)).toEqual(aiTurn);

  const bonus = position();
  bonus.players[0].dice = [null, null];
  bonus.pending = [{ kind: "sell" }];
  await page.evaluate(({ key, state }) => localStorage.setItem(key, JSON.stringify(state)), { key: SAVE_KEY, state: bonus });
  await page.reload();
  await expect(page.locator("#turn-controls h2")).toHaveText("Bonus action");
  for (const key of ["4", "e", "z"]) await page.keyboard.press(key);
  expect(await saved(page)).toEqual(bonus);
  await page.keyboard.press("3");
  await expect(page.getByRole("dialog")).toBeVisible();
});

test("shortcuts leave dialogs, editable controls, IME and modified keys alone", async ({ page }) => {
  await openTable(page);
  await page.keyboard.press("4");
  const before = await saved(page);
  await page.locator('[data-ui="help"]').click();
  for (const key of ["1", "2", "3", "4", "e", "z", "Control+z", "Meta+z"]) await page.keyboard.press(key);
  expect(await saved(page)).toEqual(before);
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");

  await page.evaluate(() => {
    const fields = document.createElement("div");
    fields.id = "shortcut-editables";
    fields.innerHTML = '<input aria-label="Test input"><textarea aria-label="Test textarea"></textarea><select aria-label="Test select"><option>4</option><option>e</option></select><div contenteditable="true" aria-label="Test editor"><span>Edit here</span></div><div role="textbox" tabindex="0" aria-label="Test textbox">Text</div>';
    document.body.append(fields);
  });
  for (const field of await page.locator("#shortcut-editables > *").all()) {
    await field.focus();
    for (const key of ["1", "2", "3", "4", "e", "z", "Control+z", "Meta+z"]) await page.keyboard.press(key);
    expect(await saved(page)).toEqual(before);
  }
  await page.evaluate(() => document.getElementById("shortcut-editables")!.remove());
  await page.locator('[data-ui="help"]').focus();
  for (const key of ["Control+4", "Meta+4", "Alt+4", "Shift+4", "Control+Shift+z", "Meta+Shift+z"]) {
    await page.keyboard.press(key);
  }
  const consumed = await page.evaluate(() => {
    const target = document.querySelector('[data-ui="help"]')!;
    return [{ key: "4", isComposing: true }, { key: "4", repeat: true }].map(init => {
      const event = new KeyboardEvent("keydown", { ...init, bubbles: true, cancelable: true });
      target.dispatchEvent(event);
      return event.defaultPrevented;
    });
  });
  expect(consumed).toEqual([false, false]);
  expect(await saved(page)).toEqual(before);
});

test("single-key shortcuts can be disabled persistently without losing standard undo", async ({ page }) => {
  const before = position();
  await openTable(page, before);
  await page.locator('[data-ui="help"]').click();
  const toggle = page.getByRole("button", { name: "Single-key shortcuts", exact: true });
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  await toggle.focus();
  await page.keyboard.press("Space");
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  await expect(toggle).toBeFocused();
  await page.keyboard.press("Escape");
  expect(await page.evaluate(key => localStorage.getItem(key), SHORTCUTS_KEY)).toBe("off");
  await expect(page.locator('[data-ui="undo"]')).toHaveAttribute("aria-keyshortcuts", "Control+z Meta+z");
  await expect(page.locator('.quick-actions [aria-keyshortcuts]')).toHaveCount(0);
  for (const key of ["1", "2", "3", "4", "e", "z"]) await page.keyboard.press(key);
  expect(await saved(page)).toEqual(before);
  await page.locator('[data-mode="workers"]').click();
  const restored = await expectRestored(page, before, () => page.keyboard.press("Control+z"));

  await page.reload();
  await expect(page.locator('.quick-actions [aria-keyshortcuts]')).toHaveCount(0);
  await page.keyboard.press("4");
  expect(await saved(page)).toEqual(restored);
  await page.locator('[data-ui="help"]').click();
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  await toggle.click();
  await page.keyboard.press("Escape");
  await page.keyboard.press("4");
  expect((await saved(page)).players[0].workers).toBe(before.players[0].workers + 2);
});

test("shortcuts stay off buttons and remain documented in the field guide", async ({ page }, testInfo) => {
  await openTable(page);
  await page.evaluate(() => document.fonts.ready);
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    for (const control of await page.locator('.quick-actions button, [data-ui="undo"]').all()) {
      await expect(control.locator("kbd")).toHaveCount(0);
      expect(await control.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await expect(page.locator(".quick-actions button")).toHaveText(["Take a tile", "Build", "Sell goods", "Take 2 workers"]);
    await expect(page.locator('[data-ui="undo"]')).toHaveText("↶ Undo");
    if (width !== 320) await page.locator("#turn-controls").screenshot({ path: testInfo.outputPath(`shortcuts-${width}.png`) });
  }
  await page.locator('[data-ui="help"]').click();
  await expect(page.getByRole("heading", { name: "Keyboard shortcuts" })).toBeVisible();
  await expect(page.locator(".guide-accessibility kbd")).toHaveText(["1", "2", "3", "4", "E", "Z", "Ctrl+Z", "⌘+Z"]);
});
