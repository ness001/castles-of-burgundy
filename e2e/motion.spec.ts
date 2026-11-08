import { expect, test, type Page } from "@playwright/test";
import { expectRestored } from "./undo-assertions";
import { boardFor } from "../src/boards";
import { chooseAction } from "../src/ai";
import { actionKey, applyAction, canPlace, createGame, legalActions } from "../src/engine";
import { motionForAction } from "../src/motion-events";
import { DICE_SEQUENCE, MOTION, motionReadingTime } from "../src/motion-timing";
import type { Action, State, Tile } from "../src/types";
import type { Camera, Group, Scene, WebGLRenderer } from "three";

const SAVE_KEY = "burgundy-table.state.v1";
interface MotionEntry {
  kind: string | null;
  text: string;
  state: string | null;
  frames: ComputedKeyframe[];
  at: number;
  cancelled?: { at: number; currentTime: number | null };
  animation: Animation;
}
interface DiceRun {
  values: number[];
  state: State;
  at: number;
  context?: number;
  completed?: number;
  unavailable?: number;
  frames: { at: number; elapsed: number | null; phase: string | undefined; x?: number; heights: number[] }[];
}
interface DiceProbe {
  runs: DiceRun[];
  pending: Set<number>;
  contexts: WebGLRenderingContext[];
  runtime?: { renderer?: WebGLRenderer; scene: Scene; dice: Group[] };
  camera?: Camera;
}
declare global {
  interface Window { __motionProbe: MotionEntry[]; __diceProbe: DiceProbe }
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    // Observe the real browser API; never stub playback or expose a game action.
    window.__motionProbe = [];
    window.__diceProbe = { runs: [], pending: new Set(), contexts: [] };
    const animate = Element.prototype.animate;
    Element.prototype.animate = function (...args) {
      const animation = animate.apply(this, args);
      window.__motionProbe.push({
        kind: this.closest("[data-motion]")?.getAttribute("data-motion") ?? null,
        text: this.textContent ?? "",
        state: localStorage.getItem("burgundy-table.state.v1"),
        at: performance.now(),
        frames: (animation.effect as KeyframeEffect).getKeyframes(), animation,
      });
      return animation;
    };
    const cancel = Animation.prototype.cancel;
    Animation.prototype.cancel = function () {
      const entry = window.__motionProbe.find(entry => entry.animation === this);
      if (entry && this.currentTime !== null) entry.cancelled = { at: performance.now(), currentTime: Number(this.currentTime) };
      cancel.call(this);
    };
  });
});

async function observeDice(page: Page) {
  // Wait for the app's idle import so the observer uses its exact HMR module,
  // not an unversioned second copy of the renderer class.
  await page.waitForFunction(() => matchMedia("(prefers-reduced-motion: reduce)").matches ||
    performance.getEntriesByType("resource").some(entry => new URL(entry.name).pathname === "/src/dice-renderer.ts"));
  await page.evaluate(async () => {
    // Match the app's loaded module, including any Vite HMR version. Instrument
    // native rendering and RAF; no fake canvas, fake frames, or action API.
    const resource = performance.getEntriesByType("resource")
      .find(entry => new URL(entry.name).pathname === "/src/dice-renderer.ts");
    // Reduced motion never requests a renderer. Importing its class for the
    // observer must not prepare a context or start a render loop.
    const { DiceRenderer } = await import(resource?.name ?? "/src/dice-renderer.ts");
    const probe = window.__diceProbe;
    const raf = window.requestAnimationFrame.bind(window);
    const cancel = window.cancelAnimationFrame.bind(window);
    let inDice = false;
    window.requestAnimationFrame = callback => {
      if (!inDice) return raf(callback);
      const id = raf(time => {
        probe.pending.delete(id);
        inDice = true;
        try { callback(time); } finally { inDice = false; }
      });
      probe.pending.add(id);
      return id;
    };
    window.cancelAnimationFrame = id => { probe.pending.delete(id); cancel(id); };
    const wrapped = new WeakSet<WebGLRenderer>();
    let elapsed: number | null = null;
    const renderFrame = DiceRenderer.prototype.render;
    DiceRenderer.prototype.render = function (time: number) {
      elapsed = time;
      try { return renderFrame.call(this, time); } finally { elapsed = null; }
    };
    const watchRenderer = (runtime: NonNullable<DiceProbe["runtime"]>) => {
      const renderer = runtime.renderer;
      if (!renderer || wrapped.has(renderer)) return;
      wrapped.add(renderer);
      const render = renderer.render;
      renderer.render = function (scene, camera) {
        render.call(this, scene, camera);
        probe.camera = camera;
        probe.runs.at(-1)?.frames.push({ at: performance.now(), elapsed,
          phase: renderer.domElement.dataset.state, x: runtime.dice[0]?.position.x,
          heights: runtime.dice.filter(die => die.visible).map(die => die.position.z) });
      };
    };
    const prepare = DiceRenderer.prototype.prepare;
    DiceRenderer.prototype.prepare = function () {
      const result = prepare.call(this);
      watchRenderer(this);
      return result;
    };
    const play = DiceRenderer.prototype.play;
    DiceRenderer.prototype.play = function (options: {
      values: number[]; onComplete?: () => void; onUnavailable?: () => void;
    }) {
      probe.runtime = this;
      const run: DiceRun = { values: [...options.values], state: JSON.parse(localStorage.getItem("burgundy-table.state.v1")!), at: performance.now(), frames: [] };
      probe.runs.push(run);
      watchRenderer(this);
      inDice = true;
      try {
        play.call(this, { ...options,
          onComplete: () => { run.completed = performance.now(); options.onComplete?.(); },
          onUnavailable: () => { run.unavailable = performance.now(); options.onUnavailable?.(); },
        });
      } finally { inDice = false; }
      watchRenderer(this);
      const context = this.renderer?.getContext();
      if (context) {
        if (!probe.contexts.includes(context)) probe.contexts.push(context);
        run.context = probe.contexts.indexOf(context);
      }
    };
  });
}

async function diceRuns(page: Page) {
  return page.evaluate(() => window.__diceProbe.runs);
}

async function expectDiceIdle(page: Page) {
  const activity = await page.evaluate(async () => {
    const probe = window.__diceProbe;
    const count = () => probe.runs.reduce((total, run) => total + run.frames.length, 0);
    const before = count();
    // Several genuine display frames, not a sleep or a disabled renderer.
    for (let i = 0; i < 4; i++) await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    return { before, after: count(), pending: probe.pending.size };
  });
  expect(activity.after).toBe(activity.before);
  expect(activity.pending).toBe(0);
}

function position(): State {
  const state = createGame(42);
  state.active = 0;
  state.order = [0, 1];
  state.turnIndex = 0;
  state.players[0].dice = [1, 2];
  state.players[0].workers = 6;
  state.players[0].goods = [2, 1, 0, 0, 0, 0];
  return state;
}

function legal(state: State, match: Partial<Action>): Action {
  const action = legalActions(state).find(action => Object.entries(match).every(([key, value]) =>
    JSON.stringify(action[key as keyof Action]) === JSON.stringify(value)));
  if (!action) throw Error(`No legal motion fixture action: ${JSON.stringify(match)}`);
  return action;
}

function bankPosition(): { state: State; action: Action } {
  const state = position();
  const tile: Tile = { id: "motion-bank", color: "building", building: "bank" };
  const cell = boardFor(state.players[0]).find(cell => canPlace(state.players[0], tile, cell.id));
  if (!cell) throw Error("The bank fixture has no adjacent legal building space");
  state.players[0].storage = [tile];
  state.players[0].dice[0] = cell.die;
  return { state, action: legal(state, { kind: "place", tile: tile.id, cell: cell.id, die: 0, cost: 0 }) };
}

function roundEnd(phaseBoundary = false): State {
  const state = position();
  state.order = [1, 0];
  state.turnIndex = 1;
  state.players.forEach(player => { player.dice = [null, null]; });
  state.players[0].arrival = state.players[1].arrival + 1; // Human starts next; no AI race.
  if (phaseBoundary) state.round = 4;
  return state;
}

async function openTable(page: Page, state: State) {
  // Install before startup, just as table/audio fixtures do. Reloads must retain
  // committed saves, and an AI timer from the previous page cannot overwrite it.
  await page.addInitScript(({ key, state, marker }) => {
    if (sessionStorage.getItem(marker)) return;
    localStorage.setItem(key, JSON.stringify(state));
    sessionStorage.setItem(marker, "applied");
  }, { key: SAVE_KEY, state, marker: `motion-fixture-${Date.now()}-${Math.random()}` });
  await page.goto("/");
  await expect(page.locator("#turn-controls")).toBeVisible();
  await expect(page.locator("#board canvas")).toBeAttached();
  await page.evaluate(() => document.fonts.ready);
  await observeDice(page);
}

async function saved(page: Page): Promise<State> {
  return page.evaluate(key => JSON.parse(localStorage.getItem(key)!), SAVE_KEY);
}

async function observed(page: Page) {
  return page.evaluate(() => window.__motionProbe.map(({ animation, ...entry }) => ({
    ...entry, playState: animation.playState,
    duration: animation.effect?.getTiming().duration, delay: animation.effect?.getTiming().delay,
  })));
}

async function expectEffect(page: Page, kind: string) {
  await expect.poll(async () => (await observed(page)).filter(entry => entry.kind === kind).length,
    { timeout: 5000 }).toBeGreaterThan(0);
  return (await observed(page)).filter(entry => entry.kind === kind);
}

async function keyboardAction(page: Page, action: Action) {
  const details = page.locator("#legal-details");
  if (!await details.evaluate(element => element.hasAttribute("open"))) await details.locator("summary").click();
  const choice = page.locator(`#legal-actions [data-action-key=${JSON.stringify(actionKey(action))}]`);
  await choice.focus();
  await choice.press("Enter");
}

async function expectClean(page: Page) {
  await expect(page.locator("#motion-layer > *")).toHaveCount(0, { timeout: 7000 });
  await expect(page.locator("[data-motion]")).toHaveCount(0, { timeout: 7000 });
  await expect.poll(async () => (await observed(page)).every(entry =>
    entry.playState === "idle" || entry.playState === "finished"), { timeout: 5000 }).toBe(true);
}

async function expectLowerCenteredReceipts(page: Page) {
  const geometry = await page.locator("#motion-layer .motion-receipt").evaluateAll(elements => ({
    width: innerWidth, height: innerHeight,
    headerBottom: document.querySelector("#game-status")!.getBoundingClientRect().bottom,
    boxes: elements.map(element => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom,
        fontSize: parseFloat(style.fontSize), pointerEvents: style.pointerEvents };
    }),
  }));
  expect(geometry.boxes.length).toBeGreaterThan(0);
  for (const [index, box] of geometry.boxes.entries()) {
    expect(box.fontSize).toBeGreaterThanOrEqual(20);
    expect(box.pointerEvents).toBe("none");
    expect(Math.abs((box.left + box.right) / 2 - geometry.width / 2)).toBeLessThan(1);
    expect(box.left).toBeGreaterThanOrEqual(16);
    expect(box.right).toBeLessThanOrEqual(geometry.width - 16);
    expect(box.top).toBeGreaterThanOrEqual(16);
    expect(box.bottom).toBeLessThanOrEqual(geometry.height - 16);
    if (index > 0) expect(box.top - geometry.boxes[index - 1].bottom).toBeGreaterThanOrEqual(8);
  }
  // The notice sits in the turn area, not over scores and phase information.
  expect(geometry.boxes[0].top).toBeGreaterThanOrEqual(geometry.headerBottom + 48);
  // The existing entrance animation can offset the stack by up to four pixels.
  expect(geometry.boxes[0].top).toBeLessThanOrEqual(geometry.headerBottom + 52);
}

test("load, reload and selection never toss dice or deal tiles", async ({ page }) => {
  const before = position();
  await openTable(page, before);
  await expect(page.locator("body > #motion-layer")).toHaveAttribute("aria-hidden", "true");
  await expect(page.locator("#motion-layer")).toHaveCSS("pointer-events", "none");
  expect(await observed(page)).toEqual([]);
  await expect(page.locator(".dice-stage, canvas.dice-webgl")).toHaveCount(0);
  expect(await diceRuns(page)).toEqual([]);
  await page.locator('[data-die="1"]').click();
  await page.keyboard.press("1");
  await page.locator('[data-view="1"]').click();
  await page.locator('[data-view="0"]').click();
  await page.locator('[data-ui="help"]').click();
  await page.keyboard.press("Escape");
  expect(await saved(page)).toEqual(before);
  expect((await observed(page)).filter(entry => ["dice-toss", "depot-deal", "tile-flight"].includes(entry.kind ?? ""))).toEqual([]);
  await expect(page.locator(".dice-stage, canvas.dice-webgl")).toHaveCount(0);
  expect(await diceRuns(page)).toEqual([]);
  await page.reload();
  await expect(page.locator("#turn-controls")).toBeVisible();
  expect(await saved(page)).toEqual(before);
  expect(await observed(page)).toEqual([]);
  await expectClean(page);
});

test("only a real round boundary tosses final dice; a phase boundary also deals", async ({ page }) => {
  for (const phaseBoundary of [false, true]) {
    const before = roundEnd(phaseBoundary);
    if (!phaseBoundary) before.players[1].arrival = before.players[0].arrival + 1;
    const expected = applyAction(before, legal(before, { kind: "end" }));
    await openTable(page, before);
    await page.locator("#turn-controls .turn-tools .end-turn").click();
    expect(await saved(page)).toEqual(expected);
    await expect(page.locator('.dice-stage canvas.dice-webgl[data-motion="dice-toss"]')).toHaveAttribute("data-renderer", "three");
    const [roll] = await diceRuns(page);
    expect(roll.values).toEqual([...expected.players.flatMap(player => player.dice), expected.whiteDie]);
    expect(roll.state).toEqual(expected); // State is final before the renderer starts.
    for (const [index, player] of expected.players.entries()) {
      await expect(page.locator(`[data-player-dice="${index}"]`)).toHaveAttribute("aria-label",
        `${player.name}: die 1 ${player.dice[0]}, die 2 ${player.dice[1]}`);
    }
    // The human pair stays visible while a rival goes first; it is not replaced
    // by the active rival's already-public header dice.
    for (const [index, die] of expected.players[0].dice.entries())
      await expect(page.locator(`[data-die="${index}"]`)).toHaveAttribute("aria-label", `Die ${index + 1}: ${die}`);
    if (phaseBoundary) {
      const deals = await expectEffect(page, "depot-deal");
      expect(deals.every(deal => deal.duration === MOTION.deal)).toBe(true);
    }
    else expect((await observed(page)).some(entry => entry.kind === "depot-deal")).toBe(false);
    // Goods routing has its own reading beat after the board-local toss.
    await expect(page.locator(".dice-stage")).toHaveCount(0, { timeout: 5000 });
    const [finished] = await diceRuns(page);
    expect(finished.completed! - finished.at).toBeGreaterThanOrEqual(DICE_SEQUENCE - 1000 / 60);
    expect(finished.frames.length).toBeGreaterThan(12);
    for (const phase of ["rolling", "settled", "returning"]) {
      expect(finished.frames.some(frame => frame.phase === phase)).toBe(true);
    }
    const returning = finished.frames.find(frame => frame.phase === "returning")!;
    expect(returning.elapsed).toBeGreaterThanOrEqual(DICE_SEQUENCE - MOTION.diceReturn);
    await expectDiceIdle(page);
    if (expected.active === 1) {
      await expectEffect(page, "white-die");
      // The AI must preserve the complete reading beat. At its boundary the
      // timer can cancel a final fractional WAAPI frame before 'finished' fires.
      const afterReading = await page.evaluate(async () => {
        const receipt = window.__motionProbe.find(entry => entry.kind === "white-die")!;
        const completion = await receipt.animation.finished.then(() => "finished", () => "cancelled");
        return {
          completion, elapsed: performance.now() - receipt.at,
          cancelled: receipt.cancelled,
          duration: receipt.animation.effect!.getTiming().duration,
          state: JSON.parse(localStorage.getItem("burgundy-table.state.v1")!),
        };
      });
      expect(afterReading.elapsed).toBeGreaterThanOrEqual(MOTION.receipt);
      if (afterReading.completion === "cancelled") {
        expect(afterReading.cancelled?.currentTime).toBeGreaterThanOrEqual(MOTION.receipt - 1000 / 60);
        expect(afterReading.state).toEqual(applyAction(expected, chooseAction(expected)));
      } else expect(afterReading.state).toEqual(expected);
      await expect.poll(() => saved(page), { timeout: 2500 })
        .toEqual(applyAction(expected, chooseAction(expected)));
    } else {
      await expectClean(page);
      expect(await saved(page)).toEqual(expected);
    }
  }
});

test("all players and the white die roll together top-down on the board, then stop on input", async ({ page }, testInfo) => {
  for (const { width, playerCount } of [{ width: 1440, playerCount: 2 }, { width: 390, playerCount: 2 },
    { width: 390, playerCount: 4 }] as const) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
    const before = playerCount === 2 ? roundEnd() : createGame(42, { playerCount });
    if (playerCount !== 2) {
      before.order = [1, 2, 3, 0];
      before.active = 0;
      before.turnIndex = playerCount - 1;
      before.players.forEach(player => { player.dice = [null, null]; });
      before.players[0].arrival = Math.max(...before.players.map(player => player.arrival)) + 1;
    }
    const expected = applyAction(before, legal(before, { kind: "end" }));
    await openTable(page, before);
    await page.locator("#turn-controls .turn-tools .end-turn").click();
    expect(await saved(page)).toEqual(expected);
    const focused = await page.locator(":focus").elementHandle();
    const stage = page.locator("#board > .dice-stage");
    const canvas = stage.locator('canvas.dice-webgl[data-renderer="three"]');
    await expect(canvas).toHaveAttribute("data-state", "settled", { timeout: 5000 });
    await page.screenshot({ path: testInfo.outputPath(`board-dice-top-down-${width}-${playerCount}p.png`) });
    await expect(page.locator(".cinematic-die, .roll-face")).toHaveCount(0);
    const view = await stage.evaluate(async element => {
      const modulePath = "/node_modules/.vite/deps/three.js";
      const resource = performance.getEntriesByType("resource").find(entry => new URL(entry.name).pathname === modulePath);
      const { Box3, Vector3, Quaternion } = await import(resource?.name ?? modulePath);
      const probe = window.__diceProbe;
      const runtime = probe.runtime!;
      const renderer = runtime.renderer!;
      const camera = probe.camera!;
      const rect = (node: Element) => {
        const box = node.getBoundingClientRect();
        return { x: box.x, y: box.y, width: box.width, height: box.height };
      };
      return {
        stage: rect(element), board: rect(element.parentElement!),
        backdrop: element.querySelector(".dice-scrim"),
        backdropPaint: getComputedStyle(element).backgroundColor,
        pointerEvents: getComputedStyle(element).pointerEvents,
        heading: element.querySelector(".dice-round")!.textContent,
        owners: Array.from(element.querySelectorAll(".dice-owner"), owner => owner.textContent),
        scrollWidth: document.documentElement.scrollWidth, canvas: rect(renderer.domElement),
        webgl: renderer.getContext() instanceof WebGL2RenderingContext,
        lost: renderer.getContext().isContextLost(), pixelRatio: renderer.getPixelRatio(),
        triangles: renderer.info.render.triangles,
        cubes: runtime.dice.map((die, index) => {
          const bounds = new Box3().setFromObject(die);
          const corners = [bounds.min.x, bounds.max.x].flatMap(x => [bounds.min.y, bounds.max.y].flatMap(y =>
            [bounds.min.z, bounds.max.z].map(z => new Vector3(x, y, z).project(camera))));
          const xs = corners.map(point => (point.x + 1) * element.clientWidth / 2);
          const ys = corners.map(point => (1 - point.y) * element.clientHeight / 2);
          const rotation = die.getWorldQuaternion(new Quaternion());
          const faces = die.children.filter(face => face.userData.normal && face.userData.value).map(face => {
            const raw = face.userData.normal;
            const normal = Array.isArray(raw) ? new Vector3(...raw) : new Vector3(raw.x, raw.y, raw.z);
            return { value: Number(face.userData.value), pips: face.children.filter(child => child.name === "pip").length,
              normal: normal.toArray(), facing: normal.applyQuaternion(rotation).z };
          });
          return { index, value: Number(die.userData.value), visible: die.visible,
            faces, top: [...faces].sort((a, b) => b.facing - a.facing)[0],
            box: { x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) },
          };
        }),
        frames: probe.runs.at(-1)!.frames,
      };
    });
    expect(view.stage).toEqual(view.board);
    expect(view.stage.width).toBeLessThan(width);
    expect(view.stage.height).toBeLessThan(width === 390 ? 844 : 1000);
    expect(view.backdrop).toBeNull();
    expect(view.backdropPaint).toBe("rgba(0, 0, 0, 0)");
    expect(view.pointerEvents).toBe("none");
    expect(view.heading).toContain(`Phase ${"ABCDE"[expected.phase]} · Round ${expected.round + 1}`);
    expect(view.heading).toContain("All players roll");
    expect(view.owners).toEqual([...expected.players.map(player => player.name), "Goods die"]);
    expect(view.scrollWidth).toBeLessThanOrEqual(width);
    expect(view.canvas).toEqual(view.stage);
    expect(view.webgl).toBe(true);
    expect(view.lost).toBe(false);
    expect(view.pixelRatio).toBeLessThanOrEqual(1.5);
    expect(view.triangles).toBeGreaterThan(0);
    const frameTimes = view.frames.filter(frame => frame.phase === "rolling").map(frame => frame.at);
    expect(frameTimes.length).toBeGreaterThan(8);
    expect(new Set(view.frames.filter(frame => frame.phase === "rolling").map(frame => frame.x)).size).toBeGreaterThan(8);
    const gaps = frameTimes.slice(1).map((time, index) => time - frameTimes[index]).sort((a, b) => a - b);
    testInfo.annotations.push({ type: `WebGL cadence ${width}px`, description:
      `${frameTimes.length} rolling frames; median gap ${gaps[Math.floor(gaps.length / 2)].toFixed(1)}ms; max gap ${gaps.at(-1)!.toFixed(1)}ms (headless, not a smoothness guarantee)` });
    const values = [...expected.players.flatMap(player => player.dice), expected.whiteDie];
    expect(view.cubes).toHaveLength(values.length);
    const airborne = view.frames.filter(frame => frame.phase === "rolling" && frame.elapsed !== null && frame.elapsed > 0);
    expect(airborne.length).toBeGreaterThan(0);
    for (const frame of airborne) {
      expect(frame.heights).toHaveLength(values.length);
      expect(frame.heights[0]).toBeGreaterThan(0);
      expect(new Set(frame.heights).size).toBe(1); // One shared roll clock, including the white die.
    }
    for (const cube of view.cubes) {
      expect(cube.value).toBe(values[cube.index]);
      expect(cube.top?.value).toBe(cube.value);
      expect(cube.top?.facing).toBeCloseTo(1, 10); // Flat, genuinely overhead, not a tilted 3D pose.
      expect(cube.visible).toBe(true);
      expect(cube.faces.map(face => face.value).sort()).toEqual([1, 2, 3, 4, 5, 6]);
      expect(new Set(cube.faces.map(face => JSON.stringify(face.normal))).size).toBe(6);
      for (const face of cube.faces) expect(face.pips).toBe(face.value);
      expect(Object.values(cube.box).every(Number.isFinite)).toBe(true);
      expect(cube.box.width).toBeGreaterThanOrEqual(playerCount === 4 ? 25 : 32);
      expect(cube.box.height).toBeGreaterThanOrEqual(playerCount === 4 ? 25 : 32);
      expect(cube.box.width).toBeLessThan(80);
      expect(cube.box.height).toBeLessThan(80);
      expect(cube.box.x).toBeGreaterThanOrEqual(0);
      expect(cube.box.y).toBeGreaterThanOrEqual(0);
      expect(cube.box.x + cube.box.width).toBeLessThanOrEqual(view.stage.width);
      expect(cube.box.y + cube.box.height).toBeLessThanOrEqual(view.stage.height);
    }
    expect(await focused!.evaluate(element => element === document.activeElement)).toBe(true);
    if (width === 1440) await page.keyboard.press("Escape");
    else {
      await page.locator('[data-die="1"]').click(); // The rest of the table remains directly usable.
      await expect(page.locator('[data-die="1"]')).toBeFocused();
      await expect(page.locator('[data-die="1"]')).toHaveAttribute("aria-pressed", "true");
    }
    await expect(stage).toHaveCount(0, { timeout: 1000 });
    expect(await saved(page)).toEqual(expected);
    await expectClean(page);
    await expectDiceIdle(page);
    if (width === 390 && playerCount === 2) {
      // A second round in the same page must reuse the context and all meshes.
      const contexts = await page.evaluate(() => ({ count: window.__diceProbe.contexts.length,
        dice: window.__diceProbe.runtime!.dice.map(die => die.uuid) }));
      await page.keyboard.press("4");
      await page.keyboard.press("4");
      await page.locator("#turn-controls .turn-tools .end-turn").click();
      await expect(canvas).toHaveAttribute("data-state", "rolling", { timeout: 20000 });
      const nextRoll = await saved(page);
      expect(await page.evaluate(() => ({ count: window.__diceProbe.contexts.length,
        dice: window.__diceProbe.runtime!.dice.map(die => die.uuid) }))).toEqual(contexts);
      await page.setViewportSize({ width: 391, height: 844 });
      await expect(stage).toHaveCount(0, { timeout: 1000 });
      await expectClean(page);
      await expectDiceIdle(page);
      expect(await saved(page)).toEqual(nextRoll);
    }
  }
});

test("ordinary turn handoff never rerolls, and your public dice remain visible during a rival turn", async ({ page }) => {
  const before = position();
  before.players[0].dice = [null, null];
  before.players[1].dice = [4, 6];
  const expected = applyAction(before, legal(before, { kind: "end" }));
  await openTable(page, before);
  await page.locator("#turn-controls .turn-tools .end-turn").click();
  await expect(page.locator(".turn-heading")).toContainText("The Steward");
  for (const index of [0, 1]) {
    await expect(page.locator(`[data-die="${index}"]`)).toHaveAttribute("aria-label", `Die ${index + 1}: used`);
    await expect(page.locator(`[data-die="${index}"]`)).toBeDisabled();
  }
  expect((await saved(page)).rng).toBe(expected.rng);
  await expect(page.locator(".dice-stage, canvas.dice-webgl")).toHaveCount(0);
  expect(await diceRuns(page)).toEqual([]);
});

test("WebGL context loss reveals the saved dice and releases rendering without blocking controls", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  const before = roundEnd();
  const expected = applyAction(before, legal(before, { kind: "end" }));
  await openTable(page, before);
  await page.locator("#turn-controls .turn-tools .end-turn").click();
  await expect(page.locator('canvas.dice-webgl[data-state="rolling"]')).toHaveCount(1);
  const lost = await page.evaluate(() => {
    const extension = window.__diceProbe.runtime!.renderer!.getContext().getExtension("WEBGL_lose_context");
    if (!extension) return false;
    extension.loseContext();
    return true;
  });
  expect(lost, "Chromium must expose real context-loss simulation").toBe(true);
  await expect.poll(async () => (await diceRuns(page))[0]?.unavailable).toBeGreaterThan(0);
  expect(await saved(page)).toEqual(expected);
  await expect(page.locator('#motion-layer [data-motion="dice-reveal"]'))
    .toHaveText(expected.players.map(player => `${player.name}: ${player.dice.join(" & ")}`).join(" · "));
  await expect(page.locator(".dice-stage, canvas.dice-webgl")).toHaveCount(0);
  await expect(page.locator('[data-player-dice="0"]')).toHaveAttribute("aria-label",
    `You: die 1 ${expected.players[0].dice[0]}, die 2 ${expected.players[0].dice[1]}`);
  await expectDiceIdle(page);
  await page.keyboard.press("4");
  expect(await saved(page)).toEqual(applyAction(expected, legal(expected, { kind: "workers", die: 0 })));
  await expect(page.locator(".dice-stage, canvas.dice-webgl")).toHaveCount(0);
  await expectDiceIdle(page);
  expect(errors).toEqual([]);
});

test("selling shows exact silver and score immediately; Undo cancels and restores", async ({ page }) => {
  const before = position();
  const action = legal(before, { kind: "sell", good: 1, die: 0, cost: 0 });
  const expected = applyAction(before, action);
  await openTable(page, before);
  await page.locator('[data-good="1"]').click();
  expect(await saved(page)).toEqual(expected);
  const receipt = page.locator('#motion-layer [data-motion="silver-gain"]');
  await expect(receipt).toContainText(`+${expected.players[0].silver - before.players[0].silver} silver`);
  await expect(page.locator('[data-resource="silver"] strong')).toHaveText(String(expected.players[0].silver));
  await expect(page.locator('[data-player-index="0"] .score-value')).toContainText(String(expected.players[0].score));
  await expect(page.locator('#motion-layer [data-motion="score-gain"]')).toContainText("+4 VP");
  const gains = await expectEffect(page, "silver-gain");
  expect(gains[0].duration).toBe(MOTION.receipt);
  expect(JSON.parse(gains[0].state!)).toEqual(expected);
  await expectRestored(page, before, () => page.keyboard.press("z"));
  await expectClean(page);
  await expect(page.locator('[data-ui="undo"]')).toBeDisabled();
  expect((await observed(page)).find(entry => entry.kind === "silver-gain")?.playState).toBe("idle");
  await page.locator('[data-good="1"]').click();
  await expect(receipt).toContainText("+1 silver");
  await expectClean(page);
  expect(await saved(page)).toEqual(expected);
});

test("keyboard taking and placing fly tiles without swallowing controls or another die", async ({ page }) => {
  const before = position();
  // Find a real depot tile with a legal, non-bonus placement on the second die.
  const route = legalActions(before).filter(action => action.kind === "take" && action.die === 0)
    .map(take => {
      const taken = applyAction(before, take);
      const place = legalActions(taken).find(action => action.kind === "place" && action.die === 1 &&
        action.tile === take.tile && !applyAction(taken, action).pending.length);
      return { take, taken, place };
    }).find(route => route.place);
  if (!route?.place) throw Error("No legal two-die take/place fixture");
  await openTable(page, before);
  const tile = page.locator(`[data-source="market"][data-tile="${route.take.tile}"]`);
  await tile.focus();
  await tile.press("Enter");
  expect(await saved(page)).toEqual(route.taken);
  const flights = await expectEffect(page, "tile-flight");
  expect(flights[0].duration).toBe(MOTION.flight);
  await expect(page.locator('[data-die="1"]')).toBeEnabled();
  await page.keyboard.press("2");
  expect(await saved(page)).toEqual(route.taken);
  await keyboardAction(page, route.place);
  const placed = applyAction(route.taken, route.place);
  expect(await saved(page)).toEqual(placed);
  await expect.poll(async () => (await observed(page)).filter(entry => entry.kind === "tile-flight").length).toBe(2);
  await expect(page.locator("#turn-controls .turn-tools .end-turn")).toBeEnabled();
  expect(await page.evaluate(() => document.activeElement instanceof HTMLButtonElement &&
    !document.activeElement.disabled && !document.activeElement.closest("#motion-layer"))).toBe(true);
  await expectRestored(page, route.taken, () => page.keyboard.press("z"));
  await expectRestored(page, before, () => page.keyboard.press("z"));
  await expectClean(page);
});

test("reduced motion keeps the bank receipt but creates no moving Web Animations", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  const { state: before, action } = bankPosition();
  const expected = applyAction(before, action);
  await openTable(page, before);
  await keyboardAction(page, action);
  expect(await saved(page)).toEqual(expected);
  const receipt = page.locator('#motion-layer [data-motion="silver-gain"]');
  await expect(receipt).toContainText("+2 silver");
  await expect(receipt).toHaveCSS("transform", "none");
  await expect(receipt).toHaveCSS("animation-name", "none");
  await expectLowerCenteredReceipts(page);
  expect(await observed(page)).toEqual([]);
  await expect(page.locator('[data-motion="tile-flight"], [data-motion="dice-toss"]')).toHaveCount(0);
  await expectClean(page);
  expect(await saved(page)).toEqual(expected);
  const nextRound = roundEnd();
  await openTable(page, nextRound);
  await page.locator("#turn-controls .turn-tools .end-turn").click();
  expect(await saved(page)).toEqual(applyAction(nextRound, legal(nextRound, { kind: "end" })));
  await expect(page.locator('[data-motion="dice-reveal"]').first()).toBeAttached();
  await expect(page.locator(".dice-stage, canvas.dice-webgl")).toHaveCount(0);
  expect(await observed(page)).toEqual([]);
  expect(await diceRuns(page)).toEqual([]);
  await expectDiceIdle(page);
  await expectClean(page);
});

test("rival moves identify their owner, keep the human estate readable and clean up", async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  const before = position();
  before.players[0].dice = [null, null];
  const handedOff = applyAction(before, legal(before, { kind: "end" }));
  let pacing = motionReadingTime(motionForAction(before, legal(before, { kind: "end" }), handedOff), false);
  let expected = handedOff;
  let moves = 0;
  while (expected.active !== 0 && moves < 12) {
    const action = chooseAction(expected);
    const next = applyAction(expected, action);
    if (next.active !== 0) pacing += motionReadingTime(motionForAction(expected, action, next), false);
    expected = next;
    moves++;
  }
  expect(expected.active).toBe(0);
  expect(moves).toBeGreaterThanOrEqual(3);
  await openTable(page, before);
  await page.locator("#turn-controls .turn-tools .end-turn").click();
  expect(await saved(page)).toEqual(handedOff);
  const rivals = await expectEffect(page, "rival-action");
  expect(rivals[0].text).toMatch(/The Steward: (Reserved|Built) /);
  expect(rivals[0].duration).toBe(MOTION.receipt);
  await expect(page.locator('#motion-layer [data-motion="rival-action"]')).toBeInViewport();
  await expect(page.locator('#feedback')).toBeHidden();
  await expect(page.locator('#announcer')).toContainText('The Steward:');
  await expectLowerCenteredReceipts(page);
  await page.screenshot({ path: testInfo.outputPath("lower-centered-receipts-desktop.png") });
  await expect(page.locator("#estate-title")).toHaveText("Your estate");
  await expect.poll(() => saved(page), { timeout: pacing + moves * 300 + 2000 }).toEqual(expected);
  for (const entry of await diceRuns(page)) {
    expect(entry.state.round).toBe(before.round + 1); // A plain handoff never tosses.
  }
  await expectClean(page);
  const results = (await observed(page)).filter(entry =>
    ["rival-action", "silver-gain", "score-gain"].includes(entry.kind ?? ""));
  expect(results.filter(entry => entry.kind === "rival-action").every(entry => !/\bhex \d+/i.test(entry.text))).toBe(true);
  expect(results.every(entry => entry.playState === "finished")).toBe(true);
  await expect(page.locator('[data-player-index="1"]')).toContainText("The Steward");
  expect(await saved(page)).toEqual(expected);
  expect(errors).toEqual([]);
});

test("390px receipts stay on-screen; resize, hidden and new game remove old effects", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const before = position();
  const sale = legal(before, { kind: "sell", good: 1, die: 0 });
  let expected = applyAction(before, sale);
  await openTable(page, before);
  const sell = async () => {
    // Mobile tucks the yard away; use the real sale dialog rather than a hidden stack.
    await page.keyboard.press("3");
    const choice = page.getByRole("dialog").locator(`[data-action-key=${JSON.stringify(actionKey(sale))}]`);
    await choice.focus();
    await choice.press("Enter");
    expect(await saved(page)).toEqual(expected);
    await expect(page.locator('#motion-layer [data-motion="silver-gain"]')).toBeInViewport();
  };
  await sell();
  await expectLowerCenteredReceipts(page);
  await page.screenshot({ path: testInfo.outputPath("lower-centered-receipts-phone.png") });
  const geometry = await page.locator('#motion-layer [data-motion]').evaluateAll(elements => ({
    width: innerWidth, height: innerHeight, scrollWidth: document.documentElement.scrollWidth,
    boxes: elements.map(element => {
      const r = element.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    }),
  }));
  expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.width);
  for (const box of geometry.boxes) {
    expect(Object.values(box).every(Number.isFinite)).toBe(true);
    expect(box.width).toBeGreaterThan(0);
    expect(box.height).toBeGreaterThan(0);
    expect(box.x).toBeGreaterThanOrEqual(-64);
    expect(box.y).toBeGreaterThanOrEqual(-64);
    expect(box.x + box.width).toBeLessThanOrEqual(geometry.width + 64);
    expect(box.y + box.height).toBeLessThanOrEqual(geometry.height + 64);
  }
  await page.setViewportSize({ width: 391, height: 844 });
  await expectClean(page);
  expect(await saved(page)).toEqual(expected);
  expected = applyAction(await expectRestored(page, before, () => page.keyboard.press("z"), sale.label), sale);
  await sell();
  // Simulate the browser visibility signal, not a game action or debug API.
  await page.evaluate(() => {
    Object.defineProperty(document, "hidden", { configurable: true, value: true });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expectClean(page);
  expect(await saved(page)).toEqual(expected);
  await page.evaluate(() => {
    Reflect.deleteProperty(document, "hidden");
    document.dispatchEvent(new Event("visibilitychange"));
  });
  expected = applyAction(await expectRestored(page, before, () => page.keyboard.press("z"), sale.label), sale);
  await sell();
  const oldReceipt = await page.locator('#motion-layer [data-motion="silver-gain"]').elementHandle();
  await page.locator('[data-ui="new"]').click();
  await page.locator('#estate-mode').selectOption("open");
  await page.locator('[data-ui="confirm-new"]').click();
  expect(await oldReceipt!.evaluate(element => element.isConnected)).toBe(false);
  await expect(page.locator('body > #motion-layer')).toHaveAttribute("aria-hidden", "true");
  await expectClean(page);
  expect((await saved(page)).status).toBe("setup");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
