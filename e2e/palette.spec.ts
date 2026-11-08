import { expect, test } from "@playwright/test";
import { createGame } from "../src/engine";

for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
  test(`${viewport.width}px keeps pine support, warm board stock and light information panels`, async ({ page }) => {
    await page.setViewportSize(viewport);
    const state = createGame(42);
    state.active = 0;
    state.order = [0, 1];
    state.turnIndex = 0;
    state.players[0].silver = 4;
    const goodType = state.players[0].goods.findIndex(count => count > 0) + 1;
    state.players[0].dice = [goodType, goodType];
    await page.addInitScript(state => {
      localStorage.setItem("burgundy-table.state.v1", JSON.stringify(state));
    }, state);
    await page.goto("/");

    await expect(page.locator("body")).toHaveCSS("background-color", "rgb(25, 61, 52)");
    await expect(page.locator(".map-sheet")).toHaveCSS("background-color", "rgb(241, 230, 204)");
    await expect(page.locator("#market-title")).toHaveCSS("color", "rgb(242, 236, 217)");
    await expect(page.locator("#depots .tile-name").first()).toHaveCSS("color", "rgb(242, 236, 217)");
    await expect(page.locator(".reserve-panel")).toHaveCSS("background-image", /linear-gradient\(135deg, rgb\(250, 247, 238\), rgb\(238, 231, 216\)\)/);

    const market = page.locator("#black-market");
    const goods = page.locator("#goods");
    await expect(market).toHaveCSS("background-image", /linear-gradient\(145deg, rgb\(238, 231, 215\), rgb\(229, 220, 199\)\)/);
    await expect(market.locator("h3")).toHaveCSS("color", "rgb(48, 70, 61)");
    await expect(market.locator(".black-heading > span")).toHaveCSS("color", "rgb(105, 100, 84)");
    await expect(goods).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    await expect(goods.locator("h3")).toHaveCSS("color", "rgb(48, 70, 61)");
    await expect(goods.locator(".small-section-heading > span")).toHaveCSS("color", "rgb(105, 100, 84)");

    if (viewport.width < 1000) await page.locator('.mobile-navigation [data-panel="estate"]').click();
    const stack = goods.locator(".good-stack").first();
    await expect(stack).toBeEnabled();
    await expect(stack).toBeVisible();
    await expect(stack.locator(".cargo-name")).toHaveCSS("color", "rgb(48, 70, 61)");
    await page.keyboard.press("Tab");
    await stack.focus();
    await expect(stack).toBeFocused();
    await expect(stack).toHaveCSS("outline-color", "rgb(128, 59, 76)");

    if (viewport.width < 1000) await page.locator('.mobile-navigation [data-panel="market"]').click();
    const tile = market.locator(".market-card").first();
    await expect(tile).toBeEnabled();
    await expect(tile.locator(".tile-name")).toHaveCSS("color", "rgb(48, 70, 61)");
    await page.keyboard.press("Tab");
    await tile.focus();
    await expect(tile).toBeFocused();
    await expect(tile).toHaveCSS("outline-color", "rgb(128, 59, 76)");
    expect(await tile.locator(".tile-art").evaluate(element => {
      const face = getComputedStyle(element), edge = getComputedStyle(element, "::before");
      return { clip: face.clipPath, edge: edge.clipPath, contact: face.filter };
    })).toEqual({ clip: "none", edge: expect.stringContaining("polygon(evenodd"), contact: expect.stringContaining("1px 1px") });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem("burgundy-table.state.v1")!))).toEqual(state);
  });
}
