import { expect, test } from "@playwright/test";
import { createGame } from "../src/engine";

test.use({ hasTouch: true, isMobile: true, reducedMotion: "reduce" });

for (const viewport of [
  { width: 390, height: 844 },
  { width: 844, height: 390 },
  { width: 1071, height: 555 },
]) {
  test(`turn controls do not cover touch gameplay at ${viewport.width}×${viewport.height}`, async ({ page }) => {
    const state = createGame(42);
    state.active = 0;
    state.order = [0, 1];
    state.turnIndex = 0;
    state.players[0].dice = [1, 2];
    state.players[0].workers = 6;
    await page.setViewportSize(viewport);
    await page.addInitScript(state => {
      localStorage.setItem("burgundy-table.state.v1", JSON.stringify(state));
    }, state);
    await page.goto("/");
    await page.evaluate(() => document.fonts.ready);

    const toolbar = page.locator("#turn-controls");
    await expect(toolbar).toHaveCSS("position", "relative");
    await expect(toolbar).toHaveCSS("background-color", "rgb(250, 246, 236)");
    const tile = page.locator("#depots .market-card.action-target").first();
    await expect(tile).toBeVisible();
    const tileId = await tile.getAttribute("data-tile");
    await page.evaluate(() => {
      const market = document.querySelector(".market-column")!.getBoundingClientRect();
      scrollTo(0, scrollY + market.top - 12);
    });
    await expect.poll(async () => {
      const bounds = (await toolbar.boundingBox())!;
      const market = (await page.locator(".market-column").boundingBox())!;
      return bounds.y + bounds.height - market.y;
    }).toBeLessThanOrEqual(0);
    await expect(tile).toBeInViewport({ ratio: 1 });
    // Tap near the viewport top where the old sticky controls intercepted input.
    await tile.tap();
    const reserved = page.locator(`[data-source="storage"][data-tile="${tileId}"]`);
    await expect(reserved).toBeVisible();

    if (viewport.width <= 1000) {
      await reserved.tap();
      await expect(page.locator("#app")).toHaveAttribute("data-panel", "estate");
      // Keep a fitting board visible; align taller landscape boards at the top.
      await expect.poll(async () => {
        const bounds = (await page.locator(".map-sheet").boundingBox())!;
        return bounds.y >= 11 && (bounds.y + bounds.height <= viewport.height || bounds.y <= 13);
      }).toBe(true);
      await page.locator('.mobile-navigation [data-panel="market"]').tap();
      await expect(page.locator(".market-column > .section-title")).toBeInViewport({ ratio: 1 });
      await expect(page.locator("#depots .market-card").first()).toBeInViewport({ ratio: 1 });
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}
