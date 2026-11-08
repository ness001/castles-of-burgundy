import { expect, test } from "@playwright/test";
import { createGame } from "../src/engine";

const KEY = "burgundy-table.state.v1";
test.use({ reducedMotion: "reduce" });

test("fresh-006: full reserve explains replacement without confusing selection or ownership", async ({ page }, testInfo) => {
  const state = createGame(42);
  state.active = 0;
  state.order = [0, 1];
  state.turnIndex = 0;
  state.players[0].dice = [1, 2];
  state.players[0].workers = 6;
  state.players[0].storage = [state.pools.mine.pop()!, state.pools.ship.pop()!, state.pools.castle.pop()!];
  state.players[1].storage = [state.pools.building.pop()!];
  await page.addInitScript(({ key, state }) => {
    if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify(state));
  }, { key: KEY, state });
  await page.goto("/");

  const reserve = page.locator("#storage");
  await expect(reserve.locator("h3")).toHaveText("Your reserve");
  await expect(reserve.locator(".small-section-heading > span")).toHaveText("3 / 3 tiles");
  await expect(reserve.locator(".reserve-guidance")).toHaveText("Reserve full · Taking a tile requires a replacement.");
  await page.evaluate(() => document.fonts.ready);
  await reserve.screenshot({ path: testInfo.outputPath("reserve-full.png") });
  for (const width of [1024, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(reserve.locator(".reserve-benefit")).toHaveCount(3);
    for (const benefit of await reserve.locator(".reserve-benefit").all()) {
      if (width > 1000) {
        await expect(benefit).toBeHidden();
        continue;
      }
      await expect(benefit).toBeVisible();
      expect(await benefit.evaluate(element => {
        const text = element.getBoundingClientRect();
        const slot = element.closest(".storage-slot")!.getBoundingClientRect();
        return element.scrollWidth <= element.clientWidth + 1 && text.left >= slot.left - 1 && text.right <= slot.right + 1;
      })).toBe(true);
    }
    if (width === 1024) {
      await expect(reserve.locator(".storage-slot").first()).toHaveCSS("display", "flex");
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`merged-reserve-${width}.png`) });
  }
  await page.setViewportSize({ width: 1440, height: 1000 });

  const tile = reserve.locator(`[data-tile="${state.players[0].storage[0].id}"]`);
  await tile.click();
  await expect(tile).toHaveAttribute("aria-pressed", "true");
  expect(await page.evaluate(key => JSON.parse(localStorage.getItem(key)!), KEY)).toEqual(state);

  await page.locator('[data-view="1"]').click();
  await expect(reserve.locator("h3")).toHaveText(`${state.players[1].name}’s reserve`);
  await expect(reserve.locator(".small-section-heading > span")).toHaveText("1 / 3 tiles");
  await expect(reserve.locator(".reserve-guidance")).toHaveText("Read-only reserve · Select You to build.");
  await expect(reserve.locator("[data-tile]")).toHaveAttribute("aria-disabled", "true");
  expect(await page.evaluate(key => JSON.parse(localStorage.getItem(key)!), KEY)).toEqual(state);

  state.players[0].storage = [];
  await page.evaluate(({ key, state }) => localStorage.setItem(key, JSON.stringify(state)), { key: KEY, state });
  await page.reload();
  await expect(reserve.locator("h3")).toHaveText("Your reserve");
  await expect(reserve.locator(".small-section-heading > span")).toHaveText("0 / 3 tiles");
  await expect(reserve.locator(".slot-outline")).toHaveCount(3);
  await expect(reserve.locator(".reserve-guidance")).toHaveCount(0);
});
