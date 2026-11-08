import { expect, test, type Page } from "@playwright/test";
import { createGame } from "../src/engine";

const KEY = "burgundy-table.state.v1";
test.use({ reducedMotion: "reduce" });

async function openTable(page: Page) {
  const state = createGame(42);
  state.active = 0;
  state.order = [0, 1];
  state.turnIndex = 0;
  await page.addInitScript(({ key, state }) => {
    if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify(state));
  }, { key: KEY, state });
  await page.goto("/");
  await page.evaluate(() => document.fonts.ready);
  await expect(page.locator("#turn-controls")).toBeVisible();
}

test("01 setup selects have a clear keyboard focus ring and touch-readable text", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openTable(page);
  await page.locator('[data-ui="new"]').click();
  for (const id of ["player-count", "estate-mode", "ruleset"]) {
    await page.keyboard.press("Tab");
    const select = page.locator(`#${id}`);
    await expect(select).toBeFocused();
    const style = await select.evaluate(el => {
      const css = getComputedStyle(el);
      return { width: css.outlineWidth, style: css.outlineStyle, offset: css.outlineOffset, size: css.fontSize };
    });
    expect(style).toEqual({ width: "3px", style: "solid", offset: "3px", size: "16px" });
  }
});

test("02 the long guide keeps its close control visible and clickable at the end", async ({ page }) => {
  await openTable(page);
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    await page.locator('[data-ui="help"]').click();
    const dialog = page.locator("#modal");
    await dialog.evaluate(el => el.scrollTop = el.scrollHeight);
    const close = dialog.getByRole("button", { name: "Close dialog", exact: true });
    const bounds = (await dialog.boundingBox())!;
    const button = (await close.boundingBox())!;
    expect(button.y).toBeGreaterThanOrEqual(bounds.y);
    expect(button.y + button.height).toBeLessThanOrEqual(bounds.y + bounds.height);
    expect(await close.evaluate(el => {
      const box = el.getBoundingClientRect();
      return el.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2));
    })).toBe(true);
    await close.click();
    await expect(dialog).not.toBeVisible();
  }
});

test("03 guide prose uses a readable measure and wraps without horizontal scrolling", async ({ page }) => {
  await openTable(page);
  await page.locator('[data-ui="help"]').click();
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    const prose = await page.locator("#guide-scoring > p").first().evaluate(el => {
      const css = getComputedStyle(el);
      return { size: parseFloat(css.fontSize), width: el.getBoundingClientRect().width,
        max: parseFloat(css.maxInlineSize), wrapping: css.overflowWrap };
    });
    expect(prose.size).toBeGreaterThanOrEqual(16);
    expect(prose.width).toBeLessThanOrEqual(prose.max + 1);
    expect(prose.wrapping).toBe("anywhere");
    expect(await page.locator("#modal, .guide-content, .knowledge-folio section").evaluateAll(nodes =>
      nodes.every(el => el.scrollWidth <= el.clientWidth + 1))).toBe(true);
  }
});

test("04 short touch viewports contain modal scrolling instead of moving the table", async ({ browser }) => {
  const context = await browser.newContext({
    baseURL: "http://127.0.0.1:5178", viewport: { width: 390, height: 400 },
    hasTouch: true, isMobile: true, reducedMotion: "reduce",
  });
  try {
    const page = await context.newPage();
    await openTable(page);
    expect(await page.evaluate(() => matchMedia("(pointer: coarse)").matches)).toBe(true);
    for (const sample of [
      { trigger: "new", width: 390, height: 400 },
      { trigger: "help", width: 844, height: 320 },
    ]) {
      await page.setViewportSize({ width: sample.width, height: sample.height });
      await page.locator(`[data-ui="${sample.trigger}"]`).click();
      const dialog = page.locator("#modal");
      const bounds = (await dialog.boundingBox())!;
      expect(bounds.x).toBeGreaterThanOrEqual(8);
      expect(bounds.y).toBeGreaterThanOrEqual(8);
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(sample.width - 8);
      expect(bounds.y + bounds.height).toBeLessThanOrEqual(sample.height - 8);
      expect(await dialog.evaluate(el => el.scrollHeight > el.clientHeight)).toBe(true);
      await dialog.evaluate(el => el.scrollTop = el.scrollHeight);
      const scrollBefore = await page.evaluate(() => window.scrollY);
      await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height - 24);
      await page.mouse.wheel(0, 600);
      // Wheel dispatch completes before the browser's scrolling frames settle.
      await page.waitForTimeout(180);
      expect(await page.evaluate(() => window.scrollY)).toBe(scrollBefore);
      await page.keyboard.press("Escape");
    }
  } finally {
    await context.close();
  }
});

test("05 the guide shortcut toggle visibly distinguishes on/off while retaining keyboard focus", async ({ page }) => {
  await openTable(page);
  await page.locator('[data-ui="help"]').click();
  await page.keyboard.press("Tab");
  const toggle = page.locator('#modal [data-ui="shortcuts"]');
  await expect(toggle).toBeFocused();
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  const enabledBackground = await toggle.evaluate(el => getComputedStyle(el).backgroundColor);
  await page.keyboard.press("Space");
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  expect(await toggle.evaluate(el => getComputedStyle(el).backgroundColor)).not.toBe(enabledBackground);
  await expect(toggle).toBeFocused();
  await expect(toggle).toHaveCSS("outline-width", "3px");
  await page.keyboard.press("Enter");
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  await expect(toggle).toHaveCSS("background-color", enabledBackground);
});
