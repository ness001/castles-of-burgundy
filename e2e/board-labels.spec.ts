import { expect, test } from "@playwright/test";

test("placed tile numbers stay inside the hex rim without overlapping the artwork", async ({ page }) => {
  // Exercise the real renderer independently of game actions and saved positions.
  await page.route("**/board-labels-fixture", route => route.fulfill({
    contentType: "text/html",
    body: '<link rel="stylesheet" href="/node_modules/@fontsource/source-sans-3/latin-400.css"><style>body{margin:0}#board{width:min(100vw,760px);aspect-ratio:760/664}</style><div id="board"></div>',
  }));
  await page.goto("/board-labels-fixture");
  await page.evaluate(async () => {
    const { BoardView } = await import("/src/board-view.ts");
    const { createGame } = await import("/src/engine.ts");
    const { BOARD } = await import("/src/boards.ts");
    await document.fonts.load('13px "Source Sans 3"', "123456№×");
    const player = createGame(42).players[0];
    const numbers = [18, 6, 23, 1, 19, 26];
    let knowledge = 0, animal = 0;
    for (const cell of BOARD) {
      if (cell.color === "knowledge") player.board[cell.id] = {
        id: `label-knowledge-${cell.id}`, color: "knowledge", knowledge: numbers[knowledge++],
      };
      if (cell.color === "animal") player.board[cell.id] = {
        id: `label-animal-${cell.id}`, color: "animal", animal: "sheep", count: 2 + animal++ % 3,
      };
    }
    const view = new BoardView(document.querySelector("#board")!, () => {}, () => {});
    view.render(player, [], false);
    (window as any).labelBoard = view;
  });
  await expect.poll(() => page.evaluate(() =>
    (window as any).labelBoard.scene?.children.list.filter((object: any) =>
      object.type === "Text" && /^(№|×)/.test(object.text),
    ).length ?? 0,
  )).toBe(12);

  for (const width of [760, 390]) {
    await page.setViewportSize({ width, height: 844 });
    const measurements = await page.evaluate(() => {
      const view = (window as any).labelBoard;
      view.refreshSize();
      view.scene.children.depthSort();
      const objects = view.scene.children.list;
      const zones = objects.filter((object: any) => object.type === "Zone");
      const owner = (object: any) => zones.reduce((nearest: any, zone: any) =>
        Math.hypot(object.x - zone.x, object.y - zone.y) < Math.hypot(object.x - nearest.x, object.y - nearest.y)
          ? zone : nearest,
      );
      return objects.filter((object: any) => object.type === "Text" && /^(№|×)/.test(object.text))
        .map((label: any) => {
          const zone = owner(label);
          const images = objects.filter((object: any) => object.type === "Image" &&
            object.texture.key.startsWith("miniature-") && Math.abs(object.x - zone.x) < 0.01 && owner(object) === zone,
          );
          if (images.length !== 1) throw Error(`${label.text}: expected one miniature at (${zone.x}, ${zone.y}), got ${images.length}`);
          const bounds = label.getBounds();
          // In a point-up hex the lower diagonal is y = r - |x| / sqrt(3).
          const cornerDepth = Math.max(Math.abs(bounds.top - zone.y), Math.abs(bounds.bottom - zone.y)) +
            Math.max(Math.abs(bounds.left - zone.x), Math.abs(bounds.right - zone.x)) / Math.sqrt(3);
          return {
            text: label.text,
            rimClearance: zone.width / 2 - cornerDepth,
            artGap: bounds.top - images[0].getBounds().bottom,
          };
        });
    });
    expect(measurements).toHaveLength(12);
    for (const { text, rimClearance, artGap } of measurements) {
      expect(rimClearance, `${text}: inset from the beveled hex rim`).toBeGreaterThanOrEqual(6);
      expect(artGap, `${text}: separate from the illustration`).toBeGreaterThanOrEqual(0);
    }
  }
});
