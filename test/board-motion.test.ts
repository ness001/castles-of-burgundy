import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BoardView } from "../src/board-view";
import { boardFor } from "../src/boards";
import { createGame } from "../src/engine";
import { MOTION } from "../src/motion-timing";
import type { MotionPlan } from "../src/motion-events";
import type { Player, Tile } from "../src/types";

const harness = vi.hoisted(() => ({
  game: undefined as unknown,
  boot: undefined as undefined | ((this: unknown) => void),
}));
vi.mock("phaser", () => ({
  default: {
    AUTO: 0,
    Scale: { FIT: 3, CENTER_BOTH: 1 },
    Game: vi.fn(function (config: { scene: { create: (this: unknown) => void } }) {
      harness.boot = config.scene.create;
      return harness.game;
    }),
    Math: { Vector2: class { constructor(public x: number, public y: number) {} } },
    Geom: { Polygon: class { static Contains = vi.fn(); } },
  },
}));

type Point = { x: number; y: number };
class Graphic {
  setDepth = vi.fn((_depth: number) => this);
  clear = vi.fn();
  destroy = vi.fn();
  lineStyle = vi.fn((_width: number, _color: number, _alpha?: number) => this);
  strokePoints = vi.fn((_points: Point[], _closed?: boolean) => this);
  strokeEllipse = vi.fn();
  strokeCircle = vi.fn();
  strokeTriangle = vi.fn();
  lineBetween = vi.fn();
  fillStyle = vi.fn();
  fillTriangle = vi.fn();
  fillPoints = vi.fn();
  fillRoundedRect = vi.fn();
  strokeRoundedRect = vi.fn();
  fillCircle = vi.fn();
}
class BaseObject {
  input: { cursor?: string } = {};
  constructor(public x = 0, public y = 0, public width = 0, public height = 0) {}
  destroy = vi.fn();
  setResolution = vi.fn(() => this);
  setOrigin = vi.fn(() => this);
  setDisplaySize = vi.fn(() => this);
  setDepth = vi.fn(() => this);
  setShadow = vi.fn(() => this);
  setInteractive = vi.fn(() => this);
  on = vi.fn(() => this);
}
class Events {
  listeners = new Map<string, Set<() => void>>();
  on = (event: string, callback: () => void) => {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event)!.add(callback);
  };
  off = (event: string, callback: () => void) => { this.listeners.get(event)?.delete(callback); };
  emit(event: string) { this.listeners.get(event)?.forEach(callback => callback()); }
}

function runtime() {
  const graphics: Graphic[] = [], zones: BaseObject[] = [];
  const events = new Events(), documentEvents = new Events(), mediaEvents = new Events();
  const media = { matches: false, addEventListener: mediaEvents.on, removeEventListener: mediaEvents.off };
  let fontsReady!: () => void;
  const document = {
    hidden: false,
    addEventListener: documentEvents.on, removeEventListener: documentEvents.off,
    fonts: { check: vi.fn(() => true), load: vi.fn(() => new Promise<void>(resolve => { fontsReady = resolve; })) },
  };
  const rect = { left: 41, top: 73, width: 760, height: 664 };
  const canvas = {
    isConnected: true,
    getClientRects: vi.fn(() => [rect]),
    checkVisibility: vi.fn(() => true),
    getBoundingClientRect: vi.fn(() => rect),
  };
  const scale = Object.assign(new Events(), {
    getParentBounds: vi.fn(), parentSize: { width: 760, height: 664 },
    displaySize: { setParent: vi.fn() }, refresh: vi.fn(),
  });
  const scene = {
    scale, events, sys: { isActive: vi.fn(() => true) },
    add: {
      graphics: vi.fn(() => { const g = new Graphic(); graphics.push(g); return g; }),
      text: vi.fn(() => new BaseObject()), image: vi.fn(() => new BaseObject()),
      zone: vi.fn((x: number, y: number, width: number, height: number) => {
        const zone = new BaseObject(x, y, width, height); zones.push(zone); return zone;
      }),
    },
    tweens: { add: vi.fn((_config: { targets: { time: number }; duration: number; onUpdate: () => void }) => ({
      remove: vi.fn(), destroy: vi.fn(),
    })) },
  };
  const game = { canvas, scale, destroy: vi.fn() };
  harness.game = game;
  vi.stubGlobal("document", document);
  vi.stubGlobal("window", { matchMedia: () => media, setTimeout, clearTimeout });
  const view = new BoardView({} as HTMLElement, vi.fn(), vi.fn());
  const boot = () => harness.boot!.call(scene);
  return { view, boot, scene, game, graphics, zones, rect, canvas, document, documentEvents,
    media, mediaEvents, fontsReady: () => fontsReady() };
}

let env: ReturnType<typeof runtime>;
let player: Player;
const plan = (overrides: Partial<MotionPlan> = {}): MotionPlan => ({
  actor: 0, roll: false, phaseChanged: false, regions: [], freeAction: false,
  silver: [], scores: [], goods: [], ...overrides,
});
const placement = (): MotionPlan => {
  const tile: Tile = { id: "placed", color: "animal", animal: "sheep", count: 4 };
  player.board[0] = tile;
  return plan({ tile: { tile, from: "reserve", cell: 0 } });
};
const latestGraphic = () => env.graphics.at(-1)!;
beforeEach(() => {
  vi.useFakeTimers();
  env = runtime();
  player = createGame(37).players[0];
  env.boot();
  env.view.render(player, [], true);
});
afterEach(() => {
  env.view.destroy();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("board motion projection", () => {
  it("maps every drawn hex to live viewport CSS bounds without changing click geometry", () => {
    for (const zone of env.zones) {
      const id = env.zones.indexOf(zone), bounds = env.view.cellBounds(id)!;
      expect(bounds.x + bounds.width / 2).toBeCloseTo(env.rect.left + zone.x);
      expect(bounds.y + bounds.height / 2).toBeCloseTo(env.rect.top + zone.y);
      expect(bounds.width).toBeCloseTo(zone.width * Math.sqrt(3) / 2);
      expect(bounds.height).toBeCloseTo(zone.height);
      expect(zone.setInteractive).toHaveBeenCalledOnce();
    }
    env.rect.left = 130; env.rect.top = -24; env.rect.width = 380; env.rect.height = 332;
    const center = env.view.cellBounds(18)!;
    expect(center.x + center.width / 2).toBeCloseTo(320);
    expect(center.y + center.height / 2).toBeCloseTo(142);
    expect(center.height).toBeCloseTo(env.zones[18].height / 2);
    expect(env.view.cellBounds(999)).toBeUndefined();
  });

  it.each(["phone", "css", "zero", "detached", "document"])("skips %s-hidden boards and never queues effects for reveal", kind => {
    if (kind === "phone") env.canvas.getClientRects.mockReturnValue([]);
    if (kind === "css") env.canvas.checkVisibility.mockReturnValue(false);
    if (kind === "zero") env.rect.width = 0;
    if (kind === "detached") env.canvas.isConnected = false;
    if (kind === "document") env.document.hidden = true;
    const before = env.graphics.length;
    env.view.playMotion(placement(), 0);
    expect(env.view.cellBounds(0)).toBeUndefined();
    expect(env.graphics).toHaveLength(before);
    expect(env.scene.tweens.add).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("only plays a rival placement when that estate is viewed, and does not fly or hide tiles", () => {
    const event = placement(); event.actor = 1;
    env.view.render(player, [], false);
    const base = latestGraphic(), images = env.scene.add.image.mock.calls.length, text = env.scene.add.text.mock.calls.length;
    env.view.playMotion(event, 0);
    expect(latestGraphic()).toBe(base);
    env.view.playMotion(event, 1);
    expect(latestGraphic()).not.toBe(base);
    expect(latestGraphic().fillPoints).not.toHaveBeenCalled();
    expect(base.destroy).not.toHaveBeenCalled();
    expect(env.scene.add.image).toHaveBeenCalledTimes(images);
    expect(env.scene.add.text).toHaveBeenCalledTimes(text);
    expect(env.scene.tweens.add).toHaveBeenCalledOnce();
  });

  it("keeps motion separate from selection/font redraws and cancels on estate replacement", async () => {
    expect(env.scene.tweens.add).not.toHaveBeenCalled();
    env.view.playMotion(placement(), 0);
    const overlay = latestGraphic();
    expect(overlay.setDepth).toHaveBeenCalledWith(10);
    env.view.render(player, [1], true, 0);
    env.fontsReady(); await Promise.resolve();
    expect(overlay.destroy).not.toHaveBeenCalled();
    expect(env.scene.tweens.add).toHaveBeenCalledOnce();
    env.view.render(structuredClone(player), [], false);
    expect(overlay.destroy).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    expect(env.scene.tweens.add).toHaveBeenCalledOnce();
  });
});

describe("bounded estate emphasis", () => {
  it("settles an inset landing pulse without lifting the flat tile or crossing its rim", () => {
    env.view.playMotion(placement(), 0);
    const g = latestGraphic(), tween = env.scene.tweens.add.mock.calls[0][0];
    expect(tween.duration).toBe(MOTION.landing);
    const rimAt = (time: number) => {
      g.strokePoints.mockClear(); g.lineStyle.mockClear();
      tween.targets.time = time; tween.onUpdate();
      const points = g.strokePoints.mock.calls[0][0];
      return {
        y: points.reduce((sum, point) => sum + point.y, 0) / points.length,
        radius: Math.hypot(points[0].x - env.zones[0].x, points[0].y - env.zones[0].y),
        alpha: g.lineStyle.mock.calls[0][2],
      };
    };
    const radius = env.zones[0].width / 2;
    expect(rimAt(0).y).toBeCloseTo(env.zones[0].y);
    expect(rimAt(0).radius).toBeCloseTo(radius - 2.5);
    expect(rimAt(MOTION.landing / 2).radius).toBeCloseTo(radius - 3.625);
    expect(rimAt(MOTION.landing * 0.75).radius).toBeCloseTo(radius - 4);
    expect(rimAt(MOTION.landing * 0.75).y).toBeCloseTo(env.zones[0].y);
    expect(rimAt(MOTION.landing * 0.75).alpha).toBeCloseTo(0.85);
    expect(rimAt(MOTION.landing * 0.875).alpha).toBeCloseTo(0.85 / 2);
    vi.advanceTimersByTime(MOTION.landing + 31);
    expect(g.destroy).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(g.destroy).toHaveBeenCalledOnce();
  });

  it("uses the full region trace beat, holds the completed outline, then fades gradually", () => {
    env.view.playMotion(plan({ regions: [{ player: 0, cells: [18], points: 11 }] }), 0);
    const g = latestGraphic(), tween = env.scene.tweens.add.mock.calls[0][0];
    expect(tween.duration).toBe(MOTION.region);
    const perimeter = 6 * (env.zones[18].height / 2 + 1);
    const traceAt = (time: number) => {
      g.strokePoints.mockClear(); g.lineStyle.mockClear();
      tween.targets.time = time; tween.onUpdate();
      return {
        length: g.strokePoints.mock.calls.reduce((sum, [points], index) =>
          g.lineStyle.mock.calls[index][0] === 3
            ? sum + Math.hypot(points[1].x - points[0].x, points[1].y - points[0].y) : sum, 0),
        alpha: g.lineStyle.mock.calls[0][2],
      };
    };
    expect(traceAt(MOTION.regionTrace / 2).length).toBeCloseTo(perimeter / 2);
    expect(traceAt(MOTION.regionTrace).length).toBeCloseTo(perimeter);
    expect(traceAt(MOTION.region * 0.75).length).toBeCloseTo(perimeter);
    expect(traceAt(MOTION.region * 0.75).alpha).toBeCloseTo(0.16);
    expect(traceAt(MOTION.region * 0.875).alpha).toBeCloseTo(0.08);
    expect(traceAt(MOTION.region).alpha).toBe(0);
  });

  it.each([1, 2, 7, 9])("traces the whole largest region of estate %i, without shared edges or face fills", boardId => {
    player.boardId = boardId;
    player.board.fill(null);
    const board = boardFor(player);
    const groups = [...new Set(board.map(c => c.region))].map(region => board.filter(c => c.region === region));
    const region = groups.sort((a, b) => b.length - a.length)[0];
    region.forEach(c => { player.board[c.id] = { id: `region-${c.id}`, color: c.color }; });
    env.view.render(player, [], false);
    env.media.matches = true;
    env.view.playMotion(plan({ regions: [{ player: 0, cells: region.map(c => c.id), points: 20 }] }), 0);
    const g = latestGraphic();
    const paths = g.strokePoints.mock.calls.filter((_, i) => g.lineStyle.mock.calls[i][0] === 7).map(([points]) => points);
    let adjacentPairs = 0;
    for (let i = 0; i < region.length; i++) for (let j = i + 1; j < region.length; j++) {
      const q = region[i].q - region[j].q, r = region[i].r - region[j].r;
      if (Math.max(Math.abs(q), Math.abs(r), Math.abs(q + r)) === 1) adjacentPairs++;
    }
    expect(paths.reduce((sum, points) => sum + points.length - 1, 0)).toBe(region.length * 6 - adjacentPairs * 2);
    for (const points of paths) {
      expect(points[0].x).toBeCloseTo(points.at(-1)!.x);
      expect(points[0].y).toBeCloseTo(points.at(-1)!.y);
    }
    expect(g.fillPoints).not.toHaveBeenCalled();
    expect(env.scene.tweens.add).not.toHaveBeenCalled();
    vi.advanceTimersByTime(MOTION.region - 1);
    expect(g.destroy).not.toHaveBeenCalled();
    expect(g.clear).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(1);
    expect(g.destroy).toHaveBeenCalledOnce();
  });

  it("limits animal links to the matching pasture and leaves artwork/count bands untouched", () => {
    for (const cell of [0, 10, 28]) player.board[cell] = { id: `sheep-${cell}`, color: "animal", animal: "sheep", count: 2 };
    player.board[5] = { id: "cattle", color: "animal", animal: "cattle", count: 2 };
    const event = plan({ animals: { player: 0, cell: 0, matching: [10, 28, 5] } });
    const before = structuredClone({ player, event });
    env.view.playMotion(event, 0);
    const strokes = latestGraphic().strokePoints.mock.calls.map(([points]) => points);
    expect(strokes.filter(points => points.length === 6)).toHaveLength(4); // Only origin + one match, twin rims.
    expect(strokes.filter(points => points.length === 2)).toHaveLength(2); // Two adjacent pasture seams.
    for (const points of strokes.filter(points => points.length === 2))
      expect(Math.hypot(points[1].x - points[0].x, points[1].y - points[0].y)).toBeLessThan(15);
    expect(latestGraphic().fillPoints).not.toHaveBeenCalled();
    expect({ player, event }).toEqual(before);
    expect(env.scene.tweens.add.mock.calls[0][0].duration).toBe(MOTION.animals);
  });

  it("groups productive mines in one timed cue and excludes other payouts/estates", () => {
    const cells = boardFor(player).filter(c => c.color === "mine").map(c => c.id);
    cells.forEach(cell => { player.board[cell] = { id: `mine-${cell}`, color: "mine" }; });
    env.view.playMotion(plan({ silver: [
      { player: 0, source: "mines", amount: cells.length, cells: [...cells, cells[0], 18] },
      { player: 1, source: "mines", amount: 3, cells: [18] },
      { player: 0, source: "bank", amount: 2, cells: [18] },
    ] }), 0);
    expect(latestGraphic().strokePoints).toHaveBeenCalledTimes(cells.length * 2);
    expect(env.scene.tweens.add).toHaveBeenCalledOnce();
    expect(env.scene.tweens.add.mock.calls[0][0].duration).toBe(MOTION.mines);
  });

  it.each(["cancel", "replace", "hidden", "resize", "size-change", "preference", "expiry", "destroy"])("cleans graphics, tween, timer and frame listener on %s", reason => {
    const event = placement();
    env.view.playMotion(event, 0);
    const overlay = latestGraphic(), tween = env.scene.tweens.add.mock.results[0].value;
    if (reason === "cancel") env.view.cancelMotion();
    if (reason === "replace") env.view.playMotion(plan(), 0);
    if (reason === "hidden") { env.canvas.checkVisibility.mockReturnValue(false); env.scene.events.emit("preupdate"); }
    if (reason === "resize") env.view.refreshSize();
    if (reason === "size-change") { env.rect.width = 380; env.scene.events.emit("preupdate"); }
    if (reason === "preference") { env.media.matches = true; env.mediaEvents.emit("change"); }
    if (reason === "expiry") vi.advanceTimersByTime(MOTION.landing + 32);
    if (reason === "destroy") env.view.destroy();
    expect(overlay.destroy).toHaveBeenCalledOnce();
    expect(tween.remove).toHaveBeenCalledOnce();
    expect(tween.destroy).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    expect(env.scene.events.listeners.get("preupdate")?.size ?? 0).toBe(0);
  });

  it("stops on browser backgrounding and ignores late font callbacks after disposal", async () => {
    env.view.playMotion(placement(), 0);
    const overlay = latestGraphic();
    env.document.hidden = true; env.documentEvents.emit("visibilitychange");
    expect(overlay.destroy).toHaveBeenCalledOnce();
    env.view.destroy();
    const count = env.graphics.length;
    env.fontsReady(); await Promise.resolve();
    env.view.render(player, [], false);
    env.view.refreshSize();
    env.view.playMotion(placement(), 0);
    expect(env.graphics).toHaveLength(count);
    expect(env.view.cellBounds(0)).toBeUndefined();
    expect(env.game.destroy).toHaveBeenCalledOnce();
    expect(env.documentEvents.listeners.get("visibilitychange")?.size).toBe(0);
    expect(env.mediaEvents.listeners.get("change")?.size).toBe(0);
    expect(env.game.scale.listeners.get("resize")?.size).toBe(0);
  });
});
