import Phaser from "phaser";
import { BUILDINGS, COLORS } from "./data";
import { boardFor } from "./boards";
import { iconSvg } from "./illustrations";
import { MOTION } from "./motion-timing";
import type { MotionPlan } from "./motion-events";
import type { Color, Player, Tile } from "./types";

// Retain the public entry point used by the DOM interface.
export { iconSvg } from "./illustrations";

export const PALETTE: Record<
  Color,
  { fill: string; ink: string; name: string }
> = {
  castle: { fill: "#3e7159", ink: "#344d3b", name: "Castles" },
  ship: { fill: "#327c96", ink: "#34566a", name: "Ships" },
  animal: { fill: "#879342", ink: "#454e23", name: "Pastures" },
  mine: { fill: "#8f9892", ink: "#39494b", name: "Mines" },
  knowledge: { fill: "#bc8c32", ink: "#654b1c", name: "Knowledge" },
  building: { fill: "#d4c6a8", ink: "#5b4f3c", name: "Buildings" },
};

const DIE_PIPS = [
  [], [4], [0, 8], [0, 4, 8], [0, 2, 6, 8], [0, 2, 4, 6, 8], [0, 2, 3, 5, 6, 8],
];

const hex = (x: number, y: number, radius: number) =>
  Array.from({ length: 6 }, (_, i) => {
    const angle = ((60 * i - 30) * Math.PI) / 180;
    return new Phaser.Math.Vector2(
      x + Math.cos(angle) * radius,
      y + Math.sin(angle) * radius,
    );
  });
const numberColor = (value: string) => Number.parseInt(value.slice(1), 16);
const textureKey = (tile: Pick<Tile, "color" | "building" | "animal">) =>
  `miniature-${tile.building ?? tile.animal ?? tile.color}`;

const BOARD_WIDTH = 760, BOARD_HEIGHT = 664;
// Drawing, DOM travel endpoints and motion all use these same logical positions.
const boardLayout = (player: Player) => {
  const raw = boardFor(player).map((c) => ({
    c,
    x: Math.sqrt(3) * (c.q + c.r / 2),
    y: 1.5 * c.r,
  }));
  const minX = Math.min(...raw.map((c) => c.x)),
    maxX = Math.max(...raw.map((c) => c.x));
  const minY = Math.min(...raw.map((c) => c.y)),
    maxY = Math.max(...raw.map((c) => c.y));
  const radius = Math.min(
    60,
    (BOARD_WIDTH - 40) / (maxX - minX + Math.sqrt(3)),
    (BOARD_HEIGHT - 24) / (maxY - minY + 2),
  );
  return {
    radius,
    cells: raw.map(({ c, x, y }) => ({
      c,
      x: BOARD_WIDTH / 2 + (x - (minX + maxX) / 2) * radius,
      y: BOARD_HEIGHT / 2 + (y - (minY + maxY) / 2) * radius,
    })),
  };
};
type BoardCell = ReturnType<typeof boardLayout>["cells"][number];
const neighbors = [[1, 0], [0, 1], [-1, 1], [-1, 0], [0, -1], [1, -1]];
const adjacent = (a: BoardCell, b: BoardCell) =>
  neighbors.some(([q, r]) => a.c.q + q === b.c.q && a.c.r + r === b.c.r);

/** Stitch exposed edges at the socket radius: one perimeter, no internal hex seams. */
const regionBoundary = (cells: BoardCell[], radius: number) => {
  const occupied = new Set(cells.map(({ c }) => `${c.q},${c.r}`));
  const key = (p: Phaser.Math.Vector2) => `${p.x.toFixed(3)},${p.y.toFixed(3)}`;
  const edges = new Map<string, [Phaser.Math.Vector2, Phaser.Math.Vector2]>();
  for (const { c, x, y } of cells) {
    const points = hex(x, y, radius);
    neighbors.forEach(([q, r], i) => {
      if (!occupied.has(`${c.q + q},${c.r + r}`))
        edges.set(key(points[i]), [points[i], points[(i + 1) % 6]]);
    });
  }
  const paths: Phaser.Math.Vector2[][] = [];
  while (edges.size) {
    const first = edges.values().next().value!;
    const path = [first[0]];
    let edge: typeof first | undefined = first;
    while (edge) {
      edges.delete(key(edge[0]));
      path.push(edge[1]);
      edge = edges.get(key(edge[1]));
    }
    paths.push(path);
  }
  return paths;
};

/** Route short seam links through the pasture, never across an unrelated region. */
const pastureLinks = (pasture: BoardCell[], origin: BoardCell, matches: BoardCell[]) => {
  const parent = new Map<number, BoardCell>([[origin.c.id, origin]]);
  const queue = [origin];
  for (let i = 0; i < queue.length; i++) {
    for (const cell of pasture) {
      if (!parent.has(cell.c.id) && adjacent(queue[i], cell)) {
        parent.set(cell.c.id, queue[i]);
        queue.push(cell);
      }
    }
  }
  const links = new Map<number, [BoardCell, BoardCell]>();
  for (let cell of matches) {
    while (cell !== origin && parent.has(cell.c.id)) {
      const previous = parent.get(cell.c.id)!;
      links.set(cell.c.id, [previous, cell]);
      cell = previous;
    }
  }
  return [...links.values()];
};

/** Disposable board projection. All decisions and state changes remain outside Phaser. */
export class BoardView {
  private game: Phaser.Game;
  private scene?: Phaser.Scene;
  private player?: Player;
  private targets = new Set<number>();
  private region?: number;
  private interactive = false;
  private lastPlaced: number | undefined;
  private layers: Phaser.GameObjects.GameObject[] = [];
  private disposed = false;
  private reducedMotion: MediaQueryList;
  private motion?: {
    graphics: Phaser.GameObjects.Graphics;
    tween?: Phaser.Tweens.Tween;
    expiry?: number;
    width: number;
    height: number;
  };
  private readonly stopMotion = () => this.cancelMotion();
  private readonly onCanvasExit = (event: Event) => {
    if (event.target === this.game.canvas) this.onInspect(null);
  };
  private readonly checkMotion = () => {
    if (!this.motion) return;
    const bounds = this.canvasBounds();
    if (!bounds || bounds.width !== this.motion.width || bounds.height !== this.motion.height)
      this.cancelMotion();
  };

  constructor(
    parent: HTMLElement,
    private onPick: (cell: number) => void,
    private onInspect: (cell: number | null) => void,
  ) {
    const self = this;
    this.reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    this.reducedMotion.addEventListener("change", this.stopMotion);
    document.addEventListener("visibilitychange", this.stopMotion);
    this.game = new Phaser.Game({
      type: Phaser.AUTO,
      parent,
      width: BOARD_WIDTH,
      height: BOARD_HEIGHT,
      transparent: true,
      banner: false,
      audio: { noAudio: true },
      // DOM action lists can overlap the estate. Never treat their presses as
      // canvas input (Phaser otherwise listens for down events on window too).
      input: { windowEvents: false },
      scale: { mode: Phaser.Scale.FIT, autoCenter: Phaser.Scale.CENTER_BOTH },
      render: { antialias: true, roundPixels: false },
      scene: {
        preload() {
          const tiles: Pick<Tile, "color" | "building" | "animal">[] = [
            ...COLORS.map((color) => ({ color })),
            ...BUILDINGS.map((building) => ({ color: "building" as const, building })),
            ...(["sheep", "cattle", "pig", "chicken"] as const).map((animal) => ({ color: "animal" as const, animal })),
          ];
          // Phaser rasterizes each original SVG once at 3x display resolution.
          // Preloading keeps render/input synchronous and shares art with the UI.
          for (const tile of tiles) {
            this.load.svg(textureKey(tile), `data:image/svg+xml;base64,${btoa(iconSvg(tile, 144))}`);
          }
          // The six printed terrains are shared with supply/reserve CSS and cached once.
          for (const color of COLORS) {
            this.load.svg(`terrain-${color}`, `${import.meta.env.BASE_URL}terrain/${color}.svg`, { width: 318, height: 318 });
          }
        },
        create() {
          if (self.disposed) return;
          self.scene = this;
          this.scale.on("resize", self.stopMotion);
          self.draw();
          // Captions need one redraw after their shared UI font becomes ready.
          void document.fonts.load('13px "Source Sans 3"', "123456№×")
            .then(() => { if (!self.disposed && this.sys.isActive()) self.draw(); })
            .catch(() => { /* Keep the synchronous Georgia fallback if unavailable. */ });
        },
      },
    });
    document.addEventListener("pointerout", this.onCanvasExit);
  }

  render(
    player: Player,
    targets: number[],
    interactive: boolean,
    lastPlaced?: number,
    _targetCosts = new Map<number, number>(),
    region?: number,
  ): void {
    if (this.disposed) return;
    // Inspect/undo/new state cancels old cues; selection-only redraws leave them alone.
    if (this.player && (this.player.board !== player.board || this.player.boardId !== player.boardId))
      this.cancelMotion();
    this.player = player;
    this.targets = new Set(targets);
    this.region = region;
    this.interactive = interactive;
    this.lastPlaced = lastPlaced;
    this.draw();
  }

  /** Viewport CSS bounds of the hex face, not the square hit zone or its shadow. */
  cellBounds(cell: number): { x: number; y: number; width: number; height: number } | undefined {
    if (!this.player || !this.scene?.sys.isActive()) return;
    const bounds = this.canvasBounds();
    if (!bounds) return;
    const layout = boardLayout(this.player), position = layout.cells.find(({ c }) => c.id === cell);
    if (!position) return;
    const r = layout.radius - 1, halfWidth = Math.sqrt(3) * r / 2;
    const scaleX = bounds.width / BOARD_WIDTH, scaleY = bounds.height / BOARD_HEIGHT;
    return {
      x: bounds.left + (position.x - halfWidth) * scaleX,
      y: bounds.top + (position.y - r) * scaleY,
      width: halfWidth * 2 * scaleX,
      height: r * 2 * scaleY,
    };
  }

  /** Call after rendering the committed estate. A new plan replaces, never queues, cues. */
  playMotion(plan: MotionPlan, viewedPlayer: number): void {
    this.cancelMotion();
    const scene = this.scene, player = this.player, bounds = this.canvasBounds();
    if (!scene?.sys.isActive() || !player || !bounds) return;
    const { cells, radius } = boardLayout(player), r = radius - 1;
    const placed = plan.actor === viewedPlayer && plan.tile?.cell !== undefined &&
      player.board[plan.tile.cell]?.id === plan.tile.tile.id
      ? cells.find(({ c }) => c.id === plan.tile!.cell) : undefined;
    const regions = plan.regions.filter(event => event.player === viewedPlayer).flatMap(event => {
      const members = cells.filter(({ c }) => event.cells.includes(c.id));
      return members.length && members.every(({ c }) => player.board[c.id])
        ? [regionBoundary(members, radius)] : [];
    });
    const animal = plan.animals?.player === viewedPlayer ? plan.animals : undefined;
    const origin = animal && cells.find(({ c }) => c.id === animal.cell && player.board[c.id]?.color === "animal");
    const matches = origin && animal ? cells.filter(({ c }) =>
      c.id !== origin.c.id && c.region === origin.c.region && animal.matching.includes(c.id) &&
      player.board[c.id]?.animal === player.board[origin.c.id]?.animal) : [];
    const links = origin && matches.length
      ? pastureLinks(cells.filter(({ c }) => c.region === origin.c.region), origin, matches) : [];
    const mineIds = new Set(plan.silver.filter(event =>
      event.player === viewedPlayer && event.source === "mines" && event.amount > 0).flatMap(event => event.cells));
    const mines = cells.filter(({ c }) => mineIds.has(c.id) && player.board[c.id]?.color === "mine");
    const duration = Math.max(
      placed ? MOTION.landing : 0, regions.length ? MOTION.region : 0,
      matches.length ? MOTION.animals : 0, mines.length ? MOTION.mines : 0,
    );
    if (!duration) return;

    const reduced = this.reducedMotion.matches;
    // A single noninteractive overlay stays above independently redrawn base layers.
    const graphics = scene.add.graphics().setDepth(10);
    const motion: NonNullable<BoardView["motion"]> = { graphics, width: bounds.width, height: bounds.height };
    this.motion = motion;
    const fade = (time: number, end: number) => reduced ? 1 : Math.max(0, Math.min(1, (end - time) / (end * 0.25)));
    const stroke = (points: Phaser.Math.Vector2[], width: number, color: number, alpha: number, closed = true) => {
      graphics.lineStyle(width, color, alpha);
      graphics.strokePoints(points, closed);
    };
    const drawMotion = (time: number) => {
      graphics.clear();
      if (placed && fade(time, MOTION.landing) > 0) {
        // A gradual sine settle occupies the reading beat before the final quarter fades.
        const progress = Math.min(1, time / (MOTION.landing * 0.75));
        const lift = reduced ? 0 : (1 + Math.cos(Math.PI * progress)) / 2;
        const alpha = fade(time, MOTION.landing);
        // A small inset pulse acknowledges placement without raising the flat
        // face or crossing into neighboring hexes. Art and labels never move.
        stroke(hex(placed.x, placed.y, r - 4 + lift * 1.5), 2, numberColor(PALETTE[placed.c.color].ink), 0.85 * alpha);
        stroke(hex(placed.x, placed.y, r - 7 + lift * 1.5), 2, 0xfff5dc, 0.95 * alpha);
      }
      for (const paths of regions) {
        const alpha = fade(time, MOTION.region);
        const segments = paths.flatMap(path => path.slice(1).map((to, i) => ({
          from: path[i], to, length: Math.hypot(to.x - path[i].x, to.y - path[i].y),
        })));
        let remaining = segments.reduce((sum, edge) => sum + edge.length, 0) * (reduced ? 1 : Math.min(1, time / MOTION.regionTrace));
        for (const path of paths) {
          stroke(path, 7, 0xffd789, 0.16 * alpha, false);
          stroke(path, 1.5, 0x81633d, 0.4 * alpha, false);
        }
        for (const { from, to, length } of segments) {
          if (remaining <= 0) break;
          const fraction = Math.min(1, remaining / length);
          const end = new Phaser.Math.Vector2(from.x + (to.x - from.x) * fraction, from.y + (to.y - from.y) * fraction);
          stroke([from, end], 3, 0xb6893c, 0.95 * alpha, false);
          stroke([from, end], 1, 0xfff5dc, alpha, false);
          remaining -= length;
        }
      }
      if (origin && matches.length) {
        const alpha = fade(time, MOTION.animals);
        for (const [from, to] of links) {
          // Links occupy the gap between rims, leaving animal art and count bands clear.
          stroke([0.43, 0.57].map(t => new Phaser.Math.Vector2(
            from.x + (to.x - from.x) * t, from.y + (to.y - from.y) * t,
          )), 2.5, 0x454e23, 0.8 * alpha, false);
        }
        for (const { x, y } of [origin, ...matches]) {
          stroke(hex(x, y, r - 6), 2, 0xfff5dc, 0.9 * alpha);
          stroke(hex(x, y, r - 3), 1.5, 0x454e23, 0.9 * alpha);
        }
      }
      for (const { x, y } of mines) {
        const alpha = fade(time, MOTION.mines);
        stroke(hex(x, y, r - 3), 2, 0x39494b, 0.85 * alpha);
        stroke(hex(x, y, r - 6), 2, 0xfff5dc, 0.9 * alpha);
      }
    };
    drawMotion(0);
    if (!reduced) {
      const clock = { time: 0 };
      motion.tween = scene.tweens.add({
        targets: clock, time: duration, duration, ease: "Linear",
        onUpdate: () => { if (this.motion === motion) drawMotion(clock.time); },
      });
    }
    scene.events.on("preupdate", this.checkMotion);
    // Wall-clock expiry also bounds static emphasis and paused/low-frame-rate scenes.
    motion.expiry = window.setTimeout(() => this.cancelMotion(), duration + (reduced ? 0 : 32));
  }

  cancelMotion(): void {
    const motion = this.motion;
    if (!motion) return;
    this.motion = undefined;
    this.scene?.events.off("preupdate", this.checkMotion);
    window.clearTimeout(motion.expiry);
    motion.tween?.remove();
    motion.tween?.destroy();
    motion.graphics.destroy();
  }

  destroy(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.cancelMotion();
    this.reducedMotion.removeEventListener("change", this.stopMotion);
    document.removeEventListener("visibilitychange", this.stopMotion);
    document.removeEventListener("pointerout", this.onCanvasExit);
    this.game.scale.off("resize", this.stopMotion);
    this.scene = undefined;
    this.player = undefined;
    this.layers = [];
    this.game.destroy(true);
  }

  refreshSize(): void {
    if (this.disposed) return;
    this.cancelMotion();
    const scale = this.game.scale;
    // refresh() computes the canvas size before measuring its parent. A board
    // revealed from a phone tab must measure first, not reuse hidden 0×0 bounds.
    scale.getParentBounds();
    if (scale.parentSize.width > 0 && scale.parentSize.height > 0) {
      scale.displaySize.setParent(scale.parentSize);
      scale.refresh();
    }
  }

  private canvasBounds(): DOMRect | undefined {
    const canvas = this.game.canvas;
    if (this.disposed || document.hidden || !canvas?.isConnected || !canvas.getClientRects().length) return;
    if (canvas.checkVisibility) {
      if (!canvas.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true, contentVisibilityAuto: true })) return;
    } else if (window.getComputedStyle(canvas).visibility !== "visible") return;
    const bounds = canvas.getBoundingClientRect();
    return bounds.width > 0 && bounds.height > 0 ? bounds : undefined;
  }

  private draw(): void {
    const scene = this.scene,
      player = this.player;
    if (this.disposed || !scene || !player) return;
    // Replaced hit zones do not emit pointerout; never retain their old tooltip.
    this.onInspect(null);
    this.layers.forEach((layer) => layer.destroy());
    this.layers = [];
    const keep = <T extends Phaser.GameObjects.GameObject>(object: T): T => {
      this.layers.push(object);
      return object;
    };
    const g = keep(scene.add.graphics());
    const label = (
      x: number,
      y: number,
      text: string,
      size: number,
      color: string,
      family = '"Source Sans 3", sans-serif',
    ) =>
      keep(
        scene.add
          .text(x, y, text, {
            fontFamily: family,
            fontSize: `${size}px`,
            color,
            align: "center",
          })
          .setResolution(2)
          .setOrigin(0.5)
          .setDepth(4),
      );
    // Keep the manuscript frame quiet so territory and legal moves read first.
    g.lineStyle(1, 0xb9aa8f, 0.18);
    g.strokeEllipse(380, 332, 730, 642);
    g.lineStyle(1, 0xb9aa8f, 0.12);
    g.strokeEllipse(380, 332, 716, 628);
    g.lineStyle(1, 0x7b8371, 0.5);
    g.strokeCircle(668, 74, 24);
    g.strokeCircle(668, 74, 19);
    g.strokePoints([
      new Phaser.Math.Vector2(668, 45),
      new Phaser.Math.Vector2(668, 103),
    ]);
    g.strokePoints([
      new Phaser.Math.Vector2(639, 74),
      new Phaser.Math.Vector2(697, 74),
    ]);
    g.fillStyle(0x59675d, 0.8);
    g.fillTriangle(668, 49, 661, 81, 668, 75);
    label(668, 34, "N", 11, "#59675d");
    const { cells, radius } = boardLayout(player);
    // All material edges stay inside the original sockets. Top-left light is
    // recessed on empty print and raised on the matte cardboard placed over it.
    const surfaces = keep(scene.add.graphics().setDepth(1.5));
    // Explicit layers keep later terrain below earlier art, captions and rims.
    const details = keep(scene.add.graphics().setDepth(3));
    const highlights = keep(scene.add.graphics().setDepth(5));
    for (const { c, x, y } of cells) {
      const r = radius - 1,
        tile = player.board[c.id],
        palette = PALETTE[c.color],
        target = this.targets.has(c.id);
      // The SVG has a two-unit transparent inset. Compensate for it so the
      // faces meet with a fine seam, not the wide gutters of detached buttons.
      const faceSize = r * 106 / 51;
      keep(scene.add.image(x, y, `terrain-${c.color}`).setDisplaySize(faceSize, faceSize).setDepth(1));
      if (tile) {
        // Keep the shared terrain visible beneath the transparent miniature.
        // Only the lower cut edge and its contact shadow cover the printed face.
        const face = hex(x, y - 1.2, r - 2.5);
        const lower = face.slice(0, 4);
        surfaces.fillStyle(0x292c21, 0.4);
        surfaces.fillPoints([...lower, ...hex(x + 0.4, y + 1.8, r - 2.5).slice(0, 4).reverse()], true);
        surfaces.fillStyle(0x70563a, 1);
        surfaces.fillPoints([...lower, ...hex(x, y + 1.1, r - 2.5).slice(0, 4).reverse()], true);
        surfaces.lineStyle(0.8, numberColor(palette.ink), 0.65);
        surfaces.strokePoints(face, true);
        surfaces.lineStyle(1.2, 0xfff5df, 0.8);
        surfaces.strokePoints([face[3], face[4], face[5], face[0]]);
        surfaces.lineStyle(1, 0x503f2d, 0.7);
        surfaces.strokePoints(face.slice(0, 4));
        const hasLabel = Boolean(tile.count || tile.knowledge);
        const size = r * (hasLabel ? 1 : 1.2);
        keep(scene.add.image(x, y - (hasLabel ? r * 0.15 : 0), textureKey(tile))
          .setDisplaySize(size, size).setDepth(2));
        if (hasLabel) {
          details.fillStyle(0xf6edd7, 1);
          details.fillRoundedRect(x - 16, y + r * 0.54 - 8, 32, 16, 3);
          details.lineStyle(0.7, 0x897654, 0.7);
          details.strokeRoundedRect(x - 16, y + r * 0.54 - 8, 32, 16, 3);
          label(
            x,
            y + r * 0.54,
            tile.count ? `×${tile.count}` : `№ ${tile.knowledge}`,
            13,
            palette.ink,
          );
        }
      } else {
        const socket = hex(x, y, r - 1);
        surfaces.fillStyle(0xf1e8cf, 0.32);
        surfaces.fillPoints(socket, true);
        surfaces.lineStyle(1.3, numberColor(palette.ink), 0.28);
        surfaces.strokePoints([socket[3], socket[4], socket[5], socket[0]]);
        surfaces.lineStyle(0.8, 0xfff7df, 0.5);
        surfaces.strokePoints(socket.slice(0, 4));
        // Placement dice are quiet printed marks, not another raised piece.
        // Cost and reference text remain in the accessible DOM interface.
        const ink = target ? 0x843748 : 0x445244;
        details.fillStyle(target ? 0xfff5e3 : 0xf1ead6, 1);
        details.fillRoundedRect(x - 16, y - 16, 32, 32, 4);
        details.lineStyle(target ? 1.8 : 0.8, target ? ink : 0x9c9179, target ? 1 : 0.8);
        details.strokeRoundedRect(x - 16, y - 16, 32, 32, 4);
        details.fillStyle(ink, 1);
        for (const pip of DIE_PIPS[c.die]) {
          details.fillCircle(x + (pip % 3 - 1) * 8, y + (Math.floor(pip / 3) - 1) * 8, 2.15);
        }
      }
      if (target) {
        // A fully inset outline outranks optional region highlighting and
        // never spills over the neighboring art or quantity captions.
        highlights.lineStyle(2.7, 0x843748, 1);
        highlights.strokePoints(hex(x, y, r - 4), true);
        highlights.lineStyle(1, 0xfff5dc, 0.9);
        highlights.strokePoints(hex(x, y, r - 6.5), true);
      } else if (c.region === this.region) {
        highlights.lineStyle(2, 0x245458, 1);
        highlights.strokePoints(hex(x, y, r - 3), true);
        highlights.lineStyle(1.5, 0xffdf8a, 1);
        highlights.strokePoints(hex(x, y, r - 6), true);
      }
      if (this.lastPlaced === c.id) {
        highlights.lineStyle(1.5, 0x8e374b, 0.9);
        highlights.strokePoints(hex(x, y, r - 3.5), true);
      }
      const zone = keep(scene.add.zone(x, y, r * 2, r * 2).setDepth(6));
      const polygon = new Phaser.Geom.Polygon(hex(r, r, r));
      zone.setInteractive(polygon, Phaser.Geom.Polygon.Contains);
      zone.input!.cursor = target && this.interactive ? "pointer" : "help";
      zone.on("pointerover", () => this.onInspect(c.id));
      zone.on("pointermove", () => this.onInspect(c.id));
      zone.on("pointerout", () => this.onInspect(null));
      zone.on("pointerdown", () => {
        if (this.interactive) this.onPick(c.id);
      });
    }
  }
}
