import { expect, test, type Locator, type Page } from "@playwright/test";
import { createGame } from "../src/engine";
import { boardFor } from "../src/boards";
import type { State } from "../src/types";

const KEY = "burgundy-table.state.v1";
const palette = {
  "--paper": "#14181a", "--panel": "#1e2427", "--raised": "#283034",
  "--line": "#3b4448", "--ink": "#edece7", "--muted": "#b0b7b9", "--gold": "#d8bb80",
};
test.use({ reducedMotion: "reduce" });

function position(players: 2 | 4 = 2): State {
  const state = createGame(42, { playerCount: players });
  state.active = 0;
  state.order = state.players.map((_, index) => index);
  state.turnIndex = 0;
  state.players[0].dice = [1, 2];
  state.players[0].workers = 4;
  state.players[0].silver = 4;
  return state;
}

async function open(page: Page, state = position(), width = 1440, height = 1000) {
  await page.setViewportSize({ width, height });
  await page.addInitScript(({ key, state }) => localStorage.setItem(key, JSON.stringify(state)), { key: KEY, state });
  // Expose the existing renderer for read-only scene measurements; do not replace rendering.
  await page.route(/\/src\/main\.ts(?:\?.*)?$/, async route => {
    const response = await route.fetch();
    await route.fulfill({ response, body: `${await response.text()}\nwindow.__uiVisualBoard = board;\n` });
  });
  await page.goto("/");
  await page.evaluate(() => document.fonts.ready);
  await expect(page.locator("#turn-controls")).toBeVisible();
  await expect.poll(() => page.evaluate(() =>
    (window as any).__uiVisualBoard?.scene?.children.list.filter((node: any) => node.type === "Zone").length ?? 0,
  )).toBe(37);
}

async function evidence(name: string, value: unknown) {
  await test.info().attach(name, { body: JSON.stringify(value, null, 2), contentType: "application/json" });
}

async function fits(page: Page, selectors: string) {
  const measurements = await page.locator(selectors).evaluateAll(nodes => nodes
    .filter(node => node.getBoundingClientRect().width > 0)
    .map(node => ({ selector: node.id || node.className, width: node.clientWidth, scroll: node.scrollWidth,
      left: node.getBoundingClientRect().left, right: node.getBoundingClientRect().right })));
  await evidence("layout", measurements);
  expect.soft(await page.evaluate(() => document.documentElement.scrollWidth), "document horizontal overflow")
    .toBeLessThanOrEqual(page.viewportSize()!.width + 1);
  expect.soft(measurements.filter(node => node.scroll > node.width + 1), "container horizontal overflow").toEqual([]);
  expect.soft(measurements.filter(node => node.left < -1 || node.right > page.viewportSize()!.width + 1), "offscreen containers").toEqual([]);
}

async function readable(locator: Locator, minimum = 4.5, pips = false) {
  const samples = await locator.evaluateAll((nodes, pips) => {
    const rgba = (color: string) => {
      const values = color.match(/[\d.]+/g)!.map(Number);
      return [values[0], values[1], values[2], values[3] ?? 1];
    };
    const over = (front: number[], back: number[]) => [0, 1, 2].map(i => front[i] * front[3] + back[i] * (1 - front[3])).concat(1);
    const luminance = (rgb: number[]) => rgb.slice(0, 3).map(value => {
      const channel = value / 255;
      return channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4;
    }).reduce((value, channel, i) => value + channel * [.2126, .7152, .0722][i], 0);
    return nodes.filter(node => node.checkVisibility()).map(node => {
      const ancestors: Element[] = [];
      for (let ancestor: Element | null = pips ? node.parentElement : node; ancestor; ancestor = ancestor.parentElement) ancestors.unshift(ancestor);
      let background = [255, 255, 255, 1];
      for (const ancestor of ancestors) background = over(rgba(getComputedStyle(ancestor).backgroundColor), background);
      const css = getComputedStyle(node);
      const foreground = over(rgba(pips ? css.backgroundColor : css.color), background);
      const a = luminance(foreground), b = luminance(background);
      return { selector: node.className, text: node.textContent?.trim().slice(0, 80), foreground, background,
        ratio: (Math.max(a, b) + .05) / (Math.min(a, b) + .05) };
    });
  }, pips);
  await evidence(pips ? "dice-contrast" : "text-contrast", samples);
  expect(samples.length, "real visible contrast samples").toBeGreaterThan(0);
  expect.soft(samples.filter(sample => sample.ratio < minimum), `contrast below ${minimum}:1`).toEqual([]);
}

async function boardIntact(page: Page, occupied?: number) {
  const data = await page.evaluate(() => {
    const nodes = (window as any).__uiVisualBoard.scene.children.list;
    const canvas = document.querySelector("#board canvas") as HTMLCanvasElement;
    const box = canvas.getBoundingClientRect();
    return { zones: nodes.filter((node: any) => node.type === "Zone").length,
      terrain: nodes.filter((node: any) => node.type === "Image" && node.texture.key.startsWith("terrain-")).length,
      art: nodes.filter((node: any) => node.type === "Image" && node.texture.key.startsWith("miniature-")).length,
      width: box.width, height: box.height, filter: getComputedStyle(canvas).filter };
  });
  await evidence("board-scene", data);
  expect(data.zones).toBe(37);
  expect(data.terrain).toBe(37);
  if (occupied !== undefined) expect(data.art).toBe(occupied);
  expect(data.filter).toBe("none");
  expect(data.width / data.height).toBeCloseTo(760 / 664, 2);
}

async function dialogFits(page: Page) {
  await expect(page.locator("#modal")).toBeVisible();
  await expect(page.locator("#modal")).toHaveCSS("background-color", "rgb(30, 36, 39)");
  // The harbor scene intentionally bleeds into the dialog padding; its outer dialog must not scroll horizontally.
  const harbor = await page.locator("#modal").evaluate(node => node.classList.contains("harbor-dialog"));
  await fits(page, harbor ? "#modal" : "#modal, #modal-content");
  const bounds = (await page.locator("#modal").boundingBox())!;
  expect.soft(bounds.y).toBeGreaterThanOrEqual(8);
  expect.soft(bounds.y + bounds.height).toBeLessThanOrEqual(page.viewportSize()!.height - 8 + 1);
}

test.afterEach(async ({ page }, info) => {
  if (info.status !== info.expectedStatus) await page.screenshot({ path: info.outputPath("defect.png"), fullPage: true });
});

test("11 desktop reference palette and preserved wordmark", async ({ page }) => {
  await open(page);
  const colors = await page.locator(":root").evaluate((root, names) => Object.fromEntries(names.map(name => [name, getComputedStyle(root).getPropertyValue(name).trim()])), Object.keys(palette));
  await evidence("palette", colors);
  expect(colors).toEqual(palette);
  await expect(page.locator("body")).toHaveCSS("background-color", "rgb(20, 24, 26)");
  const shellImage = await page.locator("body").evaluate(node => getComputedStyle(node).backgroundImage);
  await evidence("shell-background-image", shellImage);
  expect(shellImage, "shell has no parchment texture asset").not.toContain("url(");
  await expect(page.locator("#game-status")).toHaveCSS("background-color", "rgb(30, 36, 39)");
  await expect(page.getByRole("link", { name: "Burgundy, your estate", exact: true })).toBeVisible();
  await expect(page.locator("#game-status .crest")).toBeVisible();
  expect((await page.locator("#game-status").boundingBox())!.height).toBeLessThanOrEqual(96);
  await page.screenshot({ path: ".playwright-mcp/hundred-cycles/final-desktop-1440.png", fullPage: true });
});

test("12 selected ordinary and rival dice remain readable", async ({ page }) => {
  await open(page);
  for (const die of [0, 1]) {
    await page.locator(`#turn-controls [data-die="${die}"]`).click();
    await readable(page.locator(".die-face .pip"), 4.5, true);
    await expect(page.locator(".die-button.chosen .die-face")).toHaveCSS("border-top-color", "rgb(216, 187, 128)");
  }
});

test("13 all actionable ordinary empty and arrival depots retain their frames", async ({ page }) => {
  const state = position();
  state.depots[5].tiles.forEach(tile => state.pools[tile.color].push(tile));
  state.depots[5].tiles = [];
  await open(page, state);
  await expect(page.locator("#depots .depot.empty")).toHaveCount(1);
  for (const mode of ["take", "sell"]) {
    const action = page.locator(`.quick-actions [data-mode="${mode}"]`);
    if (mode === "sell") {
      await page.locator('.quick-actions [data-mode="take"]').hover();
      const hit = await action.evaluate(node => {
        const box = node.getBoundingClientRect();
        const top = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
        return { clickable: node.contains(top), interceptor: top?.closest("[id]")?.id };
      });
      await evidence("toolbar-hit-target", hit);
      expect.soft(hit.clickable, `Sell obstructed by ${hit.interceptor}`).toBe(true);
      if (!hit.clickable) await page.keyboard.press("Escape");
    }
    await action.click();
    const frames = await page.locator("#depots .depot").evaluateAll(nodes => nodes.map(node => {
      const css = getComputedStyle(node);
      return [css.borderTopWidth, css.borderTopStyle, css.borderTopColor, css.backgroundColor];
    }));
    await evidence(`depot-frames-${mode}`, frames);
    expect(frames).toEqual(Array.from({ length: 6 }, () => ["1px", "solid", "rgb(59, 68, 72)", "rgb(30, 36, 39)"]));
  }
});

test("14 scoring captions and occupied cargo counters meet text contrast", async ({ page }) => {
  const state = position();
  state.depots[0].goods = [1, 1];
  state.whiteDie = 1;
  await open(page, state);
  await readable(page.locator("#estate-scoring .estate-section-heading > span, #depots .cargo-count, .depot-cost, #game-status .phase-caption"));
  await page.locator("#legend .legend-item > summary").first().click();
  await readable(page.locator("#legend .color-rewards > span"));
});

test("15 short 1280 desktop contains toolbar panels and all board hexes", async ({ page }) => {
  await open(page, position(), 1280, 720);
  await fits(page, "#game-status, #turn-controls, .table-layout, .market-column, .player-column, .map-sheet");
  await boardIntact(page, 1);
  const board = (await page.locator("#board canvas").boundingBox())!;
  expect.soft(board.y + board.height, "board fits short desktop height").toBeLessThanOrEqual(720);
  await page.screenshot({ path: ".playwright-mcp/hundred-cycles/final-short-1280.png", fullPage: true });
});

test("16 exact 1000 breakpoint exposes both panels without clipping the board", async ({ page }) => {
  await open(page, position(), 1000, 720);
  await expect(page.locator(".mobile-navigation")).toBeVisible();
  await page.locator('.mobile-navigation [data-panel="estate"]').click();
  await expect(page.locator("#board canvas")).toBeVisible();
  await boardIntact(page, 1);
  await fits(page, "#game-status, #turn-controls, .mobile-navigation, .map-sheet, .player-column");
  await page.locator('.mobile-navigation [data-panel="market"]').click();
  await expect(page.locator("#depots")).toBeVisible();
  await fits(page, "#depots, #black-market");
});

test("17 390 phone navigation selection and keyboard focus are visible", async ({ page }) => {
  await open(page, position(), 390, 844);
  for (const panel of ["estate", "market"]) {
    const tab = page.locator(`.mobile-navigation [data-panel="${panel}"]`);
    await tab.focus();
    await page.keyboard.press("Enter");
    await expect(tab).toHaveAttribute("aria-pressed", "true");
    await expect(tab).toHaveCSS("background-color", "rgb(56, 60, 52)");
    await expect(tab).toHaveCSS("border-top-color", "rgb(216, 187, 128)");
    await expect(tab).toHaveCSS("outline-style", "solid");
    expect(parseFloat(await tab.evaluate(node => getComputedStyle(node).outlineWidth))).toBeGreaterThanOrEqual(2);
    expect((await tab.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await readable(tab);
  }
  await fits(page, "#game-status, #turn-controls, .mobile-navigation, #depots");
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: ".playwright-mcp/hundred-cycles/final-phone-390.png", fullPage: true });
});

test("18 320 phone preserves both layouts and 37 terrain cells", async ({ page }) => {
  await open(page, position(), 320, 700);
  await fits(page, "#game-status, #turn-controls, .mobile-navigation, #depots, #black-market");
  await page.locator('.mobile-navigation [data-panel="estate"]').click();
  await fits(page, ".map-sheet, #storage, #resources, #estate-scoring");
  await boardIntact(page, 1);
  await page.screenshot({ path: test.info().outputPath("phone-320-estate.png"), fullPage: true });
});

test("19 four-player desktop keeps scores and full depots within their owners", async ({ page }) => {
  const state = position(4);
  await open(page, state);
  await expect(page.locator("#scoreboard .score-row")).toHaveCount(4);
  await expect(page.locator("#depots .market-card")).toHaveCount(state.depots.reduce((sum, depot) => sum + depot.tiles.length, 0));
  await fits(page, "#game-status, #scoreboard, #scoreboard .score-row, #depots, #depots .depot, #depots .market-card");
  await readable(page.locator("#scoreboard .score-name strong, #scoreboard .score-value"));
  await boardIntact(page, 1);
});

test("20 populated four-player short desktop retains artwork reserve and goods", async ({ page }) => {
  const state = position(4), player = state.players[0];
  const cells = boardFor(player);
  let filled = 1;
  for (const cell of cells) {
    if (cell.id % 3 !== 0 || player.board[cell.id]) continue;
    const tile = state.pools[cell.color].pop();
    if (tile) { player.board[cell.id] = tile; filled++; }
  }
  player.storage = [state.pools.ship.pop()!, state.pools.mine.pop()!, state.pools.building.pop()!];
  player.goods = [4, 0, 2, 0, 0, 3];
  await open(page, state, 1280, 720);
  await expect(page.locator("#storage .reserve-token")).toHaveCount(3);
  await expect(page.locator("#goods .good-stack.stocked")).toHaveCount(3);
  await fits(page, "#turn-controls, #depots .depot, #storage, #goods, #estate-scoring, .estate-switch");
  await boardIntact(page, filled);
  await readable(page.locator("#storage .tile-name, #goods .cargo-name, #goods .goods-outcome"));
  await page.screenshot({ path: test.info().outputPath("populated-four-player-1280.png"), fullPage: true });
});

test("21 expanded 320 legal list wraps and offers a visible keyboard destination", async ({ page }) => {
  const state = position();
  state.players[0].storage = [state.pools.ship.pop()!];
  await open(page, state, 320, 700);
  await page.locator("#legal-details > summary").click();
  await expect(page.locator("#legal-actions button").first()).toBeVisible();
  await fits(page, "#legal-actions, .legal-group, .legal-group-actions, #legal-actions .legal-action");
  const first = page.locator("#legal-actions button").first();
  await first.focus();
  await page.keyboard.press("Tab");
  await expect(page.locator("#legal-actions button:focus")).toHaveCSS("outline-style", "solid");
  await readable(page.locator("#legal-actions .action-label, #legal-actions .action-location"));
  await page.screenshot({ path: ".playwright-mcp/hundred-cycles/final-legal-320.png", fullPage: true });
});

test("22 new-game 320 dialog has contained readable touch controls", async ({ page }) => {
  await open(page, position(), 320, 700);
  await page.locator('[data-ui="new"]').click();
  await dialogFits(page);
  await page.locator("#player-count").selectOption("4");
  await page.locator("#ruleset").selectOption("special-edition");
  await fits(page, "#modal select, #rule-options-summary, #modal .modal-actions");
  const sizes = await page.locator("#modal select").evaluateAll(nodes => nodes.map(node => ({ height: node.getBoundingClientRect().height, font: parseFloat(getComputedStyle(node).fontSize) })));
  await evidence("setup-controls", sizes);
  expect.soft(sizes.every(size => size.height >= 44 && size.font >= 16)).toBe(true);
  await readable(page.locator("#modal label, #modal select, #rule-options-summary p"));
  await page.keyboard.press("Escape");
  await expect(page.locator("#modal")).toBeHidden();
});

test("23 390 help prose and sticky close remain readable at the folio end", async ({ page }) => {
  await open(page, position(), 390, 844);
  await page.locator('[data-ui="help"]').click();
  await dialogFits(page);
  await fits(page, ".guide-content, .knowledge-folio, .knowledge-folio section");
  await readable(page.locator("#modal .guide-intro, #guide-scoring > p, .knowledge-folio p"));
  await page.locator("#modal").evaluate(node => node.scrollTop = node.scrollHeight);
  const close = page.getByRole("button", { name: "Close dialog", exact: true });
  await expect(close).toBeInViewport();
  expect(await close.evaluate(node => {
    const box = node.getBoundingClientRect();
    return node.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2));
  })).toBe(true);
  await close.click();
  await expect(page.locator("#modal")).toBeHidden();
});

test("24 six-choice 320 harbor cards keep cargo labels and counters readable", async ({ page }) => {
  const state = position();
  state.pending = [{ kind: "ship" }];
  state.players[0].goods.fill(0);
  state.depots.forEach((depot, index) => depot.goods = [index + 1, index + 1]);
  await open(page, state, 320, 700);
  await dialogFits(page);
  await expect(page.locator("#modal .harbor-grid button.harbor-card")).toHaveCount(6);
  await fits(page, ".harbor-grid, .harbor-card, .harbor-card .cargo-item");
  await readable(page.locator("#modal .harbor-card .cargo-name, #modal .harbor-card .cargo-count, #modal .cargo-capacity"));
  await page.screenshot({ path: test.info().outputPath("harbor-320.png"), fullPage: true });
});

test("25 four-player 390 final ledger preserves contrast scores and winner", async ({ page }) => {
  const state = position(4);
  state.status = "finished";
  state.winner = 3;
  state.players.forEach((player, index) => {
    player.score = 100 + index * 23;
    player.final = { goods: 4, silver: index + 2, workers: 2, knowledge: 8 + index * 3 };
  });
  await open(page, state, 390, 844);
  await dialogFits(page);
  await expect(page.locator(".result-player")).toHaveCount(4);
  await expect(page.locator(".winner-crown")).toHaveCount(1);
  await fits(page, ".results-players, .result-player, .result-player dl > div");
  await readable(page.locator(".result-player h3, .final-score, .result-score-value, .score-lead-label"));
  await page.locator(".result-player.winner").scrollIntoViewIfNeeded();
  await expect(page.locator(".winner-crown")).toBeInViewport();
  await page.screenshot({ path: ".playwright-mcp/hundred-cycles/final-results-390.png", fullPage: true });
});
