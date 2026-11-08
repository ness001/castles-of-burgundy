import { expect, test, type Page } from "@playwright/test";
import { BOARDS } from "../src/boards";
import { BUILDINGS, COLORS } from "../src/data";
import { createGame } from "../src/engine";
import type { Player, Tile } from "../src/types";

type Point = { x: number; y: number };
type Bounds = { left: number; right: number; top: number; bottom: number };
const corners = (bounds: Bounds): Point[] => [
  { x: bounds.left, y: bounds.top }, { x: bounds.right, y: bounds.top },
  { x: bounds.left, y: bounds.bottom }, { x: bounds.right, y: bounds.bottom },
];

function layout(boardId: number) {
  const cells = BOARDS[boardId].map(cell => ({ ...cell,
    x: Math.sqrt(3) * (cell.q + cell.r / 2), y: 1.5 * cell.r,
  }));
  const minX = Math.min(...cells.map(cell => cell.x)), maxX = Math.max(...cells.map(cell => cell.x));
  const minY = Math.min(...cells.map(cell => cell.y)), maxY = Math.max(...cells.map(cell => cell.y));
  const radius = Math.min(60, 720 / (maxX - minX + Math.sqrt(3)), 640 / (maxY - minY + 2));
  return { radius: radius - 1, cells: cells.map(cell => ({ ...cell,
    x: 380 + (cell.x - (minX + maxX) / 2) * radius,
    y: 332 + (cell.y - (minY + maxY) / 2) * radius,
  })) };
}

// Signed perpendicular clearance from every edge of the owning point-up hex.
function clearance(point: Point, center: Point, radius: number) {
  const x = point.x - center.x, y = point.y - center.y;
  return radius * Math.sqrt(3) / 2 - Math.max(
    Math.abs(x), Math.abs(x / 2 + y * Math.sqrt(3) / 2), Math.abs(x / 2 - y * Math.sqrt(3) / 2),
  );
}

async function openBoard(page: Page) {
  await page.route("**/terrain-fixture", route => route.fulfill({
    contentType: "text/html",
    body: '<link rel="stylesheet" href="/node_modules/@fontsource/source-sans-3/latin-400.css"><style>body{margin:0}#board{width:min(100vw,760px);aspect-ratio:760/664}</style><div id="board"></div>',
  }));
  await page.goto("/terrain-fixture");
  await page.evaluate(async player => {
    const source = "/src/board-view.ts";
    const { BoardView } = await import(source);
    await document.fonts.load('13px "Source Sans 3"', "123456№×");
    const view = new BoardView(document.querySelector("#board")!, () => {}, () => {});
    view.render(player, [], false);
    (window as any).terrainFixture = { view };
  }, createGame(42).players[0]);
  await expect.poll(() => page.evaluate(() =>
    (window as any).terrainFixture.view.scene?.children.list.filter((object: any) => object.type === "Zone").length ?? 0,
  )).toBe(37);
  await page.evaluate(colors => {
    const fixture = (window as any).terrainFixture;
    fixture.textures = Object.fromEntries(colors.map(color => {
      const key = `terrain-${color}`;
      return [key, fixture.view.scene.textures.get(key)];
    }));
  }, COLORS);
}

async function measureBoard(page: Page, player: Player, targets: number[], lastPlaced?: number) {
  return page.evaluate(({ player, targets, lastPlaced }) => {
    const fixture = (window as any).terrainFixture, view = fixture.view;
    const probe = view.scene.add.graphics(), graphics = Object.getPrototypeOf(probe);
    probe.destroy();
    const pips: Array<Point & { radius: number }> = [];
    const plates: Bounds[] = [];
    const rims: Array<{ points: Point[]; width: number; closed: boolean }> = [];
    const { fillCircle, fillRoundedRect, strokePoints } = graphics;
    // Observe real drawing calls; do not replace rendering or depend on private
    // command-buffer opcodes. Hooks exist only during this synchronous redraw.
    graphics.fillCircle = function(x: number, y: number, radius: number) {
      if (this.depth === 3) pips.push({ ...this.getWorldTransformMatrix().transformPoint(x, y), radius });
      return fillCircle.call(this, x, y, radius);
    };
    graphics.fillRoundedRect = function(x: number, y: number, width: number, height: number, radius: number) {
      if (this.depth === 3) {
        const matrix = this.getWorldTransformMatrix();
        const topLeft = matrix.transformPoint(x, y), bottomRight = matrix.transformPoint(x + width, y + height);
        plates.push({ left: topLeft.x, top: topLeft.y, right: bottomRight.x, bottom: bottomRight.y });
      }
      return fillRoundedRect.call(this, x, y, width, height, radius);
    };
    graphics.strokePoints = function(points: Point[], closeShape?: boolean, closePath?: boolean, endIndex?: number) {
      if (this.depth === 5) {
        const matrix = this.getWorldTransformMatrix();
        rims.push({ points: points.slice(0, endIndex ?? points.length).map(point => matrix.transformPoint(point.x, point.y)),
          width: this._lineWidth, closed: Boolean(closeShape || closePath) });
      }
      return strokePoints.call(this, points, closeShape, closePath, endIndex);
    };
    try {
      view.render(player, targets, true, lastPlaced);
      view.refreshSize();
      view.scene.children.depthSort();
      const objects: any[] = view.scene.children.list;
      const bounds = (object: any): Bounds => {
        const box = object.getBounds();
        return { left: box.left, right: box.right, top: box.top, bottom: box.bottom };
      };
      return {
        zones: objects.filter(object => object.type === "Zone").map(object => ({
          x: object.x as number, y: object.y as number, width: object.width as number,
          height: object.height as number, depth: object.depth as number,
        })),
        images: objects.filter(object => object.type === "Image").map(object => ({
          x: object.x as number, y: object.y as number, key: object.texture.key as string,
          width: object.displayWidth as number, height: object.displayHeight as number,
          depth: object.depth as number, bounds: bounds(object),
          cached: object.texture === fixture.textures[object.texture.key],
        })),
        labels: objects.filter(object => object.type === "Text").map(object => ({
          x: object.x as number, y: object.y as number, text: object.text as string,
          depth: object.depth as number, bounds: bounds(object),
        })),
        textureKeys: (view.scene.textures.getTextureKeys() as string[]).filter(key => key.startsWith("terrain-")),
        canvasWidth: (document.querySelector("#board canvas") as HTMLCanvasElement).getBoundingClientRect().width,
        pips, plates, rims,
      };
    } finally {
      Object.assign(graphics, { fillCircle, fillRoundedRect, strokePoints });
    }
  }, { player, targets, lastPlaced });
}

test("placed miniatures leave the shared terrain pixels visible around their artwork", async ({ page }) => {
  await page.setViewportSize({ width: 760, height: 844 });
  await openBoard(page);
  const player = createGame(42).players[0];
  player.boardId = 1;
  player.board = BOARDS[player.boardId].map(cell => ({ id: `texture-${cell.id}`, color: cell.color }));
  await measureBoard(page, player, []);
  const { cells, radius } = layout(player.boardId);
  const samples = COLORS.map(color => ({ color, cell: cells.find(cell => cell.color === color)! }));
  const comparisons = await page.evaluate(async ({ samples, radius }) => {
    const view = (window as any).terrainFixture.view;
    const objects: any[] = view.scene.children.list;
    const snapshot = () => new Promise<Uint8ClampedArray>(resolve => {
      view.scene.game.renderer.snapshot((image: HTMLImageElement) => {
        const canvas = document.createElement("canvas");
        canvas.width = image.width; canvas.height = image.height;
        const context = canvas.getContext("2d")!;
        context.drawImage(image, 0, 0);
        resolve(context.getImageData(0, 0, canvas.width, canvas.height).data);
      });
    });
    const occupied = await snapshot();
    const visibility = objects.map(object => object.visible);
    let terrain: Uint8ClampedArray;
    try {
      // Reference the same cached terrain without any material or miniature overlay.
      objects.forEach(object => object.setVisible(object.type === "Image" && object.texture.key.startsWith("terrain-")));
      terrain = await snapshot();
    } finally {
      objects.forEach((object, i) => object.setVisible(visibility[i]));
    }
    return samples.map(({ color, cell }) => {
      let matches = 0, count = 0;
      const shades = new Set<string>();
      // These side strips are inside the rim but outside the square artwork bounds.
      for (const side of [-1, 1]) {
        for (let dx = Math.ceil(radius * .65); dx <= Math.floor(radius * .74); dx++) {
          for (let dy = -Math.floor(radius * .3); dy <= Math.floor(radius * .3); dy++) {
            const offset = (Math.round(cell.y + dy) * 760 + Math.round(cell.x + side * dx)) * 4;
            const reference = terrain!.slice(offset, offset + 4);
            if (reference.every((value, channel) => Math.abs(occupied[offset + channel] - value) <= 2)) matches++;
            shades.add(Array.from(reference).join(","));
            count++;
          }
        }
      }
      return { color, matches, count, shades: shades.size };
    });
  }, { samples, radius });
  for (const result of comparisons) {
    expect(result.shades, `${result.color}: reference has surface detail`).toBeGreaterThan(8);
    expect(result.matches / result.count, `${result.color}: material must not paint over terrain`).toBeGreaterThan(.95);
  }
});

for (const width of [760, 390]) {
  test(`all nine estates keep cached terrain, dice, art and inset rims inside their hexes at ${width}px`, async ({ page }) => {
    const requests: string[] = [], errors: string[] = [];
    page.on("request", request => {
      const path = new URL(request.url()).pathname;
      if (/^\/terrain\/[^/]+\.svg$/.test(path)) requests.push(path);
    });
    page.on("pageerror", error => errors.push(error.message));
    await page.setViewportSize({ width, height: 844 });
    await openBoard(page);

    for (const boardId of Object.keys(BOARDS).map(Number)) {
      for (const occupied of [false, true]) {
        await test.step(`estate ${boardId}, ${occupied ? "occupied" : "empty"}`, async () => {
          const player = createGame(42).players[0];
          player.boardId = boardId;
          // Display-only fixtures cover every face and artwork variant without
          // involving legal moves, saves, AI timers or the changing app shell.
          let animal = 0, building = 0, knowledge = 0;
          player.board = BOARDS[boardId].map((cell): Tile | null => {
            if (!occupied) return null;
            const tile: Tile = { id: `terrain-${boardId}-${cell.id}`, color: cell.color };
            if (cell.color === "animal") {
              tile.animal = (["sheep", "cattle", "pig", "chicken"] as const)[animal % 4];
              tile.count = 2 + animal++ % 3;
            }
            if (cell.color === "building") tile.building = BUILDINGS[building++ % BUILDINGS.length];
            if (cell.color === "knowledge") tile.knowledge = [1, 6, 18, 19, 23, 26][knowledge++ % 6];
            return tile;
          });
          const { cells, radius } = layout(boardId);
          const targets = occupied ? [] : cells.map(cell => cell.id);
          const lastPlaced = occupied ? cells[cells.length - 1].id : undefined;
          const snapshot = await measureBoard(page, player, targets, lastPlaced);
          const owner = (point: Point) => cells.reduce((nearest, cell) =>
            Math.hypot(point.x - cell.x, point.y - cell.y) < Math.hypot(point.x - nearest.x, point.y - nearest.y) ? cell : nearest,
          ).id;
          const center = (box: Bounds): Point => ({ x: (box.left + box.right) / 2, y: (box.top + box.bottom) / 2 });
          const rimCenter = (points: Point[]): Point => ({
            x: points.reduce((sum, point) => sum + point.x, 0) / points.length,
            y: points.reduce((sum, point) => sum + point.y, 0) / points.length,
          });
          const terrains = snapshot.images.filter(image => image.key.startsWith("terrain-"));
          const miniatures = snapshot.images.filter(image => image.key.startsWith("miniature-"));
          const captions = snapshot.labels.filter(label => /^(№|×)/.test(label.text));
          expect(snapshot.canvasWidth).toBeCloseTo(width, 0);
          expect(snapshot.zones).toHaveLength(37);
          expect(terrains).toHaveLength(37);
          expect(miniatures).toHaveLength(occupied ? 37 : 0);
          expect(snapshot.images).toHaveLength(occupied ? 74 : 37);
          expect(snapshot.textureKeys.sort()).toEqual(COLORS.map(color => `terrain-${color}`).sort());
          expect(snapshot.labels.filter(label => /^[1-6]$/.test(label.text)), "placement dice must not be numeral Text").toEqual([]);
          expect(captions).toHaveLength(occupied ? animal + knowledge : 0);
          expect(snapshot.rims).toHaveLength(targets.length * 2 + (lastPlaced === undefined ? 0 : 1));
          expect(snapshot.pips).toHaveLength(occupied ? 0 : cells.reduce((sum, cell) => sum + cell.die, 0));
          expect(snapshot.plates).toHaveLength(occupied ? animal + knowledge : 37);

          for (const cell of cells) {
            const description = `estate ${boardId} cell ${cell.id} (${cell.color})`;
            const zone = snapshot.zones.filter(zone => owner(zone) === cell.id);
            expect(zone, `${description}: one hit zone`).toHaveLength(1);
            expect(zone[0].x).toBeCloseTo(cell.x, 5);
            expect(zone[0].y).toBeCloseTo(cell.y, 5);
            expect(zone[0].width).toBeCloseTo(radius * 2, 5);
            expect(zone[0].height).toBeCloseTo(radius * 2, 5);
            expect(zone[0].depth).toBe(6);
            const terrain = terrains.filter(image => owner(image) === cell.id);
            expect(terrain, `${description}: one shared terrain image`).toHaveLength(1);
            expect(terrain[0].key).toBe(`terrain-${cell.color}`);
            expect(terrain[0].cached, `${description}: reuse the original texture object`).toBe(true);
            expect(terrain[0].x).toBeCloseTo(cell.x, 5);
            expect(terrain[0].y).toBeCloseTo(cell.y, 5);
            expect(terrain[0].width).toBeCloseTo(radius * 106 / 51, 5);
            expect(terrain[0].height).toBeCloseTo(radius * 106 / 51, 5);
            expect(terrain[0].depth).toBe(1);
            const art = miniatures.filter(image => owner(image) === cell.id);
            const labels = captions.filter(label => owner(label) === cell.id);
            const tile = player.board[cell.id];
            expect(art).toHaveLength(tile ? 1 : 0);
            expect(labels.map(label => label.text)).toEqual(tile?.count ? [`×${tile.count}`] : tile?.knowledge ? [`№ ${tile.knowledge}`] : []);
            if (tile) {
              expect(art[0].key).toBe(`miniature-${tile.building ?? tile.animal ?? tile.color}`);
              expect(art[0].depth).toBe(2);
              expect(art[0].x).toBeCloseTo(cell.x, 5);
            }
            for (const label of labels) {
              expect(label.depth).toBe(4);
              expect(label.bounds.top - art[0].bounds.bottom, `${description}: caption clears art`).toBeGreaterThanOrEqual(0);
              for (const corner of corners(label.bounds)) {
                const inset = radius - Math.abs(corner.y - cell.y) - Math.abs(corner.x - cell.x) / Math.sqrt(3);
                expect(inset, `${description}: preserve 6px caption boundary margin`).toBeGreaterThanOrEqual(6);
              }
            }
            // Terrain SVGs draw their outer rim at 51 in a 106×106 viewport.
            // Check the visible hex, not the larger square Image bounds.
            const faceRadius = radius;
            for (const content of [...art, ...labels]) for (const corner of corners(content.bounds)) {
              expect(clearance(corner, cell, faceRadius), `${description}: artwork/caption corner inside terrain rim`).toBeGreaterThan(0);
            }
            const pips = snapshot.pips.filter(pip => owner(pip) === cell.id);
            expect(pips, `${description}: dice only on empty cells`).toHaveLength(tile ? 0 : cell.die);
            for (const pip of pips) expect(clearance(pip, cell, faceRadius) - pip.radius, `${description}: pip fits`).toBeGreaterThan(0);
            const plates = snapshot.plates.filter(plate => owner(center(plate)) === cell.id);
            expect(plates).toHaveLength(!tile || labels.length ? 1 : 0);
            for (const plate of plates) for (const corner of corners(plate)) {
              expect(clearance(corner, cell, faceRadius), `${description}: dice/caption background fits`).toBeGreaterThan(0);
            }
            const rims = snapshot.rims.filter(rim => owner(rimCenter(rim.points)) === cell.id);
            expect(rims).toHaveLength(targets.includes(cell.id) ? 2 : lastPlaced === cell.id ? 1 : 0);
            for (const rim of rims) {
              expect(rim.closed).toBe(true);
              expect(rim.points).toHaveLength(6);
              expect(rim.width).toBeGreaterThan(0);
              for (const point of rim.points) {
                expect(clearance(point, cell, faceRadius) - rim.width / 2,
                  `${description}: entire target/last-placement stroke is inset`).toBeGreaterThan(0);
              }
            }
          }
        });
      }
    }
    expect(requests.sort(), "exactly six static SVG loads despite board switches and occupancy redraws")
      .toEqual(COLORS.map(color => `/terrain/${color}.svg`).sort());
    expect(errors).toEqual([]);
  });
}
