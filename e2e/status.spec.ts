import { expect, test, type Page } from "@playwright/test";
import { createGame } from "../src/engine";
import type { State } from "../src/types";

const SAVE_KEY = "burgundy-table.state.v1";

function position(): State {
  const state = createGame(42);
  state.active = 0;
  state.order = [0, 1];
  state.turnIndex = 0;
  state.phase = 1;
  state.round = 3;
  state.players[0].score = 23;
  state.players[1].score = 50;
  state.players[0].dice = [3, 5];
  return state;
}

async function openTable(page: Page, state: State) {
  await page.addInitScript(({ key, state }) => {
    if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify(state));
  }, { key: SAVE_KEY, state });
  await page.goto("/");
  await expect(page.locator("#board canvas")).toBeAttached();
  await page.evaluate(() => document.fonts.ready);
}

test("one global status bar groups scores and game progress before turn controls at every width", async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  const state = position();
  await openTable(page, state);
  for (const width of [1440, 1280, 1001, 1000, 390, 320]) {
    const height = width === 1280 ? 720 : width > 1000 ? 900 : 844;
    await page.setViewportSize({ width, height });
    await page.evaluate(() => scrollTo(0, 0));
    const status = page.locator("#game-status");
    await expect(status).toHaveCount(1);
    await expect(status).toBeVisible();
    await expect(page.locator("header.masthead#game-status")).toHaveAttribute("aria-label", "Game status");
    await expect(status.locator('.brand')).toHaveText('Burgundy.');
    await expect(status.locator('.crest > svg')).toBeVisible();
    await expect(status.locator('.masthead-scene > svg')).toBeVisible();
    await expect(status.locator('.masthead-scene')).toHaveCSS('opacity', '0.24');
    await expect(status.locator('[data-ui="sound"] > svg')).toBeVisible();
    for (const selector of ["#scoreboard", "#season"]) {
      await expect(page.locator(selector)).toHaveCount(1);
      await expect(status.locator(`:scope > ${selector}`)).toBeVisible();
    }
    await expect(page.locator(".table-layout #game-status, .table-layout #scoreboard, .table-layout #season")).toHaveCount(0);
    expect(await status.evaluate(element => Boolean(element.compareDocumentPosition(document.querySelector("#turn-controls")!) & Node.DOCUMENT_POSITION_FOLLOWING))).toBe(true);
    const statusBounds = (await status.boundingBox())!;
    const controls = (await page.locator("#turn-controls").boundingBox())!;
    expect(statusBounds.y + statusBounds.height).toBeLessThanOrEqual(controls.y + 1);
    expect(await status.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    await expect(page.locator("#scoreboard .score-value")).toHaveText(["23VP", "50VP"]);
    for (const score of await status.locator(".score-value").all()) await expect(score).toBeVisible();
    await expect(page.locator("#scoreboard .active")).toHaveCount(1);
    await expect(page.locator("#scoreboard .active .score-turn")).toHaveText("Playing");
    await expect(page.locator("#scoreboard .active .score-turn")).toBeVisible();
    await expect(page.locator("#scoreboard .active .score-name > strong")).toHaveText("You");
    await expect(page.locator("#scoreboard .public-dice")).toHaveCount(2);
    for (const [index, player] of state.players.entries()) {
      const dice = status.locator(`[data-player-dice="${index}"]`);
      if (index === 0) await expect(dice).toBeHidden(); // Own actionable dice remain in the turn strip.
      else await expect(dice).toBeVisible();
      await expect(dice).toHaveAttribute("aria-label", `${player.name}: die 1 ${player.dice[0] ?? "used"}, die 2 ${player.dice[1] ?? "used"}`);
    }
    for (const row of await status.locator('.score-row').all()) {
      const name = (await row.locator('.score-name').boundingBox())!;
      const score = (await row.locator('.score-value').boundingBox())!;
      expect(name.y + name.height).toBeLessThanOrEqual(score.y + 1);
    }
    const rivalDice = (await status.locator('[data-player-dice="1"]').boundingBox())!;
    const rivalScore = (await status.locator('[data-player-index="1"] .score-value').boundingBox())!;
    expect(rivalDice.x).toBeGreaterThanOrEqual(rivalScore.x + rivalScore.width);
    expect(Math.abs(rivalDice.y + rivalDice.height / 2 - rivalScore.y - rivalScore.height / 2)).toBeLessThanOrEqual(2);
    await expect(page.locator("#scoreboard button, #scoreboard [tabindex]")).toHaveCount(0);
    await expect(status.locator("#season .progress-track")).toHaveCount(1);
    await expect(status.locator("#season .progress-step")).toHaveCount(5);
    await expect(status.locator('#season [aria-current="step"]')).toHaveText(["B"]);
    await expect(status.locator('.round-summary')).toHaveAttribute('aria-label', 'Round 4 of 5');
    await expect(status.locator('.round-label')).toHaveText('Round 4 / 5');
    await expect(status.locator('.phase-caption')).toHaveText('Region bonus · +8 VP');
    for (const step of await status.locator(".progress-step").all()) await expect(step).toBeVisible();
    if (width > 1000) {
      const board = (await page.locator(".map-sheet").boundingBox())!;
      expect(statusBounds.y + statusBounds.height).toBeLessThan(board.y);
      expect(board.y + board.height).toBeLessThanOrEqual(height);
    } else {
      await page.locator('.mobile-navigation [data-panel="market"]').click();
      await expect(status.locator("#scoreboard")).toBeVisible();
      await expect(status.locator("#season")).toBeVisible();
      await page.locator('.mobile-navigation [data-panel="estate"]').click();
      await expect(status.locator("#scoreboard")).toBeVisible();
      await expect(status.locator("#season")).toBeVisible();
    }
    await page.locator('[data-view="1"]').click();
    await expect(page.locator("#estate-title")).toHaveText("The Steward’s estate");
    await expect(page.locator("#scoreboard .score-value")).toHaveText(["23VP", "50VP"]);
    await expect(page.locator("#scoreboard .active .score-name > strong")).toHaveText("You");
    await page.locator('[data-view="0"]').click();
    await page.evaluate(() => scrollTo(0, 0));
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    if (width === 1440 || width === 390) {
      await page.screenshot({ path: testInfo.outputPath(`status-${width}.png`) });
      await status.screenshot({ path: `.playwright-mcp/header-v2/status-${width}.png` });
    }
  }
  // Returning to desktop must not duplicate or relocate either summary.
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(page.locator("#game-status")).toHaveCount(1);
  await expect(page.locator("#scoreboard")).toHaveCount(1);
  await expect(page.locator("#season")).toHaveCount(1);
  await expect(page.locator("#game-status > #scoreboard")).toBeVisible();
  await expect(page.locator("#game-status > #season")).toBeVisible();
  expect(await page.evaluate(key => JSON.parse(localStorage.getItem(key)!), SAVE_KEY)).toEqual(state);
  expect(errors).toEqual([]);
});

test("phase track and compact round summary update through dice consumption, undo and reload", async ({ page }) => {
  await openTable(page, position());
  await expect(page.locator('.progress-track').nth(0).locator('[aria-current="step"]')).toHaveText("B");
  await expect(page.locator('.round-summary')).toHaveAttribute('aria-label', 'Round 4 of 5');
  await expect(page.locator('.progress-track').nth(0).locator('.past')).toHaveCount(1);
  await expect(page.locator('.round-label')).toHaveText('Round 4 / 5');
  await page.locator('[data-mode="workers"]').click();
  await expect(page.locator('[data-player-dice="0"]')).toHaveAttribute("aria-label", "You: die 1 used, die 2 5");
  await page.locator('[data-ui="undo"]').click();
  await expect(page.locator('[data-player-dice="0"]')).toHaveAttribute("aria-label", "You: die 1 3, die 2 5");
  await page.reload();
  await expect(page.locator('.round-summary')).toHaveAttribute('aria-label', 'Round 4 of 5');
});

for (const final of [false, true]) {
  test(final ? "finished games mark the phase track and round summary complete" : "ending round five advances the phase and resets the round summary", async ({ page }) => {
    const state = position();
    state.phase = final ? 4 : 1;
    state.round = 4;
    state.order = [1, 0];
    state.turnIndex = 1;
    state.players[0].dice = [null, null];
    state.players[1].dice = [null, null];
    await openTable(page, state);
    await page.locator("#turn-controls .turn-tools [data-action]").filter({ hasText: "End turn" }).click();
    if (final) {
      await expect(page.getByRole("dialog")).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(page.locator('.progress-step[aria-current]')).toHaveCount(0);
      await expect(page.locator('.progress-step.past')).toHaveCount(5);
      await expect(page.locator('.round-summary')).toHaveAttribute('aria-label', 'Round 5 of 5, complete');
      await expect(page.locator('#scoreboard .score-turn')).toHaveText(["Final score", "Final score"]);
    } else {
      await expect(page.locator('.progress-track').nth(0).locator('[aria-current="step"]')).toHaveText("C");
      await expect(page.locator('.round-summary')).toHaveAttribute('aria-label', 'Round 1 of 5');
      await expect(page.locator('.phase-caption')).toHaveText('Region bonus · +6 VP');
    }
  });
}
