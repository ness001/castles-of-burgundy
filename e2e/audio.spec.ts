import { expect, test, type Page } from "@playwright/test";
import { expectRestored } from "./undo-assertions";
import type { ActionSoundTiming, GameAudio, Sound, SoundCue } from "../src/audio";
import { MOTION } from "../src/motion-timing";
import type { Action, Cell, State, Tile } from "../src/types";

const SAVE_KEY = "burgundy-table.state.v1";
const MUTE_KEY = "burgundy-table.audio-muted.v1";

interface AudioProbe {
  cues: SoundCue[];
  commits: { key: string; cues: SoundCue[] }[];
  starts: { duration: number; when: number }[];
  pending: Promise<void>[];
  runtime?: GameAudio;
}
declare global {
  interface Window { __audioProbe: AudioProbe }
}

interface Fixture {
  tile?: Omit<Tile, "id">;
  scenario?: "ship" | "goods" | "skip" | "end" | "phase" | "finish";
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const probe: AudioProbe = { cues: [], commits: [], starts: [], pending: [] };
    window.__audioProbe = probe;
    const start = AudioBufferSourceNode.prototype.start;
    AudioBufferSourceNode.prototype.start = function (...args) {
      // Count only successful calls to the native method, never a playback stub.
      start.apply(this, args);
      probe.starts.push({ duration: this.buffer?.duration ?? 0, when: args[0] ?? 0 });
    };
  });
});

async function observeCues(page: Page) {
  await page.evaluate(async () => {
    // An already-running Vite server can add HMR timestamps to imports. Patch
    // the module the app actually loaded, not a second, unversioned class.
    const resource = performance.getEntriesByType("resource")
      .find(entry => new URL(entry.name).pathname === "/src/audio.ts");
    if (!resource) throw Error("The game did not load its audio module");
    const { GameAudio } = await import(resource.name);
    const { actionKey } = await import("/src/engine.ts");
    const play = GameAudio.prototype.play;
    const playAction = GameAudio.prototype.playAction;
    GameAudio.prototype.play = function (this: GameAudio, sound: Sound, delay = 0) {
      const probe = window.__audioProbe;
      probe.runtime = this;
      probe.cues.push({ sound, delay });
      const result: Promise<void> = play.call(this, sound, delay);
      probe.pending.push(result);
      return result;
    };
    GameAudio.prototype.playAction = function (this: GameAudio, previous: State, action: Action, next: State, timing?: ActionSoundTiming) {
      const probe = window.__audioProbe;
      const offset = probe.cues.length;
      playAction.call(this, previous, action, next, timing);
      probe.commits.push({ key: actionKey(action), cues: probe.cues.slice(offset) });
    };
  });
}

async function seedTable(page: Page, fixture: Fixture = {}): Promise<State> {
  if (page.url() === "about:blank") await page.goto("/");
  const seeded = await page.evaluate(async ({ tile: specification, scenario }) => {
    const { createGame, applyAction, legalActions, canPlace } = await import("/src/engine.ts");
    const { boardFor } = await import("/src/boards.ts");
    let state: State = createGame(42);
    state.active = 0;
    state.order = [0, 1];
    state.turnIndex = 0;
    state.players[0].dice = [1, 2];
    state.players[0].workers = 6;
    state.players[0].silver = 6;
    state.players[0].goods = [2, 1, 0, 0, 0, 0];

    if (specification) {
      const tile: Tile = { id: "audio-placement", ...specification };
      const board: Cell[] = boardFor(state.players[0]);
      if (!board.some(cell => canPlace(state.players[0], tile, cell.id))) {
        // One legal bank placement connects the default estate to its
        // castle/pasture. Do not manufacture occupied cells or mock adjacency.
        const bridge: Tile = { id: "audio-bridge", color: "building", building: "bank" };
        const cell = board.find(cell => canPlace(state.players[0], bridge, cell.id))!;
        state.players[0].storage = [bridge];
        state.players[0].dice = [cell.die, 2];
        const action = legalActions(state).find((a: Action) => a.kind === "place" && a.cell === cell.id && a.die === 0)!;
        state = applyAction(state, action);
      }
      const cell = board.find(cell => canPlace(state.players[0], tile, cell.id));
      if (!cell) throw Error(`Fixture has no legal placement for ${JSON.stringify(tile)}`);
      state.players[0].storage = [tile];
      state.players[0].dice = [cell.die, 2];
    }
    if (scenario === "ship" || scenario === "goods") {
      state.pending = scenario === "ship" ? [{ kind: "ship" }] : [{ kind: "goods", depots: [0] }];
      state.players[0].goods = [1, 0, 0, 0, 0, 0];
      state.depots.forEach((depot, index) => {
        depot.goods = index ? [] : scenario === "ship" ? [1, 1] : [1, 2, 3, 4];
      });
    }
    if (scenario === "skip") state.pending = [{ kind: "sell" }];
    if (scenario === "end" || scenario === "phase" || scenario === "finish") {
      state.order = [1, 0];
      state.turnIndex = 1;
      state.players.forEach(player => { player.dice = [null, null]; });
      // The human starts the next round, avoiding an unrelated AI timer race.
      state.players[0].arrival = state.players[1].arrival + 1;
      if (scenario !== "end") state.round = 4;
      if (scenario === "finish") state.phase = 4;
    }
    return state;
  }, fixture);
  // As in table.spec.ts, seed before startup so an old AI timer cannot win
  // a race with the reload. A subsequent reload must retain real saved moves.
  await page.addInitScript(({ key, state, marker }) => {
    if (sessionStorage.getItem(marker)) return;
    localStorage.setItem(key, JSON.stringify(state));
    sessionStorage.setItem(marker, "applied");
  }, { key: SAVE_KEY, state: seeded, marker: `audio-fixture-${Date.now()}-${Math.random()}` });
  await page.reload();
  await expect(page.locator("#turn-controls")).toBeVisible();
  await expect(page.locator("#board canvas")).toBeAttached();
  await observeCues(page);
  return seeded;
}

async function saved(page: Page): Promise<State> {
  return page.evaluate(key => JSON.parse(localStorage.getItem(key)!), SAVE_KEY);
}

async function expectedAction(page: Page, match: Partial<Action>) {
  return page.evaluate(async ({ key, match }) => {
    const { applyAction, legalActions, actionKey } = await import("/src/engine.ts");
    const { soundsForAction } = await import("/src/audio.ts");
    const { motionForAction } = await import("/src/motion-events.ts");
    const { MOTION, rollLeadIn, rewardLeadIn } = await import("/src/motion-timing.ts");
    const previous: State = JSON.parse(localStorage.getItem(key)!);
    const action: Action = legalActions(previous).find((action: Action) =>
      Object.entries(match).every(([field, value]) =>
        JSON.stringify(action[field as keyof Action]) === JSON.stringify(value)));
    if (!action) throw Error(`No legal audio fixture action: ${JSON.stringify(match)}`);
    let next: State = applyAction(previous, action);
    if (action.kind === "ship") {
      const loads: Action[] = legalActions(next).filter((a: Action) => a.kind === "goods");
      if (loads.length === 1) next = applyAction(next, loads[0]);
    }
    const plan = motionForAction(previous, action, next);
    const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
    return { action, key: actionKey(action) as string, state: next, cues: soundsForAction(previous, action, next, {
      diceDelay: reduced ? 0 : (rollLeadIn(plan) + MOTION.diceLanding) / 1000,
      silverDelay: reduced ? 0 : (rewardLeadIn(plan, false) + MOTION.flight) / 1000,
    }) as SoundCue[] };
  }, { key: SAVE_KEY, match });
}

async function clearProbe(page: Page) {
  await page.evaluate(async () => {
    const probe = window.__audioProbe;
    await Promise.all(probe.pending);
    probe.cues = [];
    probe.commits = [];
    probe.starts = [];
    probe.pending = [];
  });
}

async function captured(page: Page) {
  return page.evaluate(async () => {
    const probe = window.__audioProbe;
    await Promise.all(probe.pending);
    return { cues: probe.cues, commits: probe.commits, starts: probe.starts };
  });
}

async function clickLegal(page: Page, expected: Awaited<ReturnType<typeof expectedAction>>) {
  const modal = page.getByRole("dialog");
  if (await modal.isVisible()) {
    await modal.locator('[data-ui="close"]').first().click();
    await expect(modal).not.toBeVisible();
  }
  const details = page.locator("#legal-details");
  if (!await details.evaluate(element => element.hasAttribute("open"))) await details.locator("summary").click();
  await clearProbe(page);
  // Use the accessible fallback's real keyboard activation. Pointer geometry
  // in the overlaid dropdown is outside these audio assertions.
  const choice = page.locator(`#legal-actions [data-action-key=${JSON.stringify(expected.key)}]`);
  await choice.focus();
  await choice.press("Enter");
  expect(await saved(page)).toEqual(expected.state);
  const result = await captured(page);
  expect(result.commits).toEqual([{ key: expected.key, cues: expected.cues }]);
  return result;
}

const placements: { tile: Omit<Tile, "id">; sound: Sound; reward?: Sound }[] = [
    { tile: { color: "ship" }, sound: "ship", reward: "bonus" },
    { tile: { color: "knowledge", knowledge: 8 }, sound: "knowledge" },
    { tile: { color: "castle" }, sound: "castle", reward: "bonus" },
    { tile: { color: "mine" }, sound: "mine" },
    { tile: { color: "animal", animal: "pig", count: 2 }, sound: "pig", reward: "score" },
    { tile: { color: "animal", animal: "sheep", count: 2 }, sound: "sheep", reward: "score" },
    { tile: { color: "animal", animal: "cattle", count: 2 }, sound: "cattle", reward: "score" },
    { tile: { color: "animal", animal: "chicken", count: 2 }, sound: "chicken", reward: "score" },
    { tile: { color: "building", building: "warehouse" }, sound: "cargo", reward: "bonus" },
    { tile: { color: "building", building: "workshop" }, sound: "build", reward: "bonus" },
    { tile: { color: "building", building: "church" }, sound: "bell", reward: "bonus" },
    { tile: { color: "building", building: "market" }, sound: "tile", reward: "bonus" },
    { tile: { color: "building", building: "boarding" }, sound: "workers" },
    { tile: { color: "building", building: "bank" }, sound: "coins" },
    { tile: { color: "building", building: "hall" }, sound: "stamp", reward: "bonus" },
    { tile: { color: "building", building: "watchtower" }, sound: "castle", reward: "region" },
];
for (const { tile, sound, reward } of placements) {
  test(`placement ${tile.building ?? tile.animal ?? tile.color} commits its specific cue once`, async ({ page }) => {
      await seedTable(page, { tile });
      const mapped = await page.evaluate(async tile => {
        const { soundForTile } = await import("/src/audio.ts");
        return soundForTile({ id: "mapping", ...tile });
      }, tile);
      expect(mapped).toBe(sound);
      const expected = await expectedAction(page, { kind: "place", die: 0, cost: 0 });
      expect(expected.cues[0]).toEqual({ sound, delay: tile.building === "bank" ? 2 * MOTION.flight / 1000 : MOTION.flight / 1000 });
      if (reward) expect(expected.cues.map(cue => cue.sound)).toContain(reward);
      await clickLegal(page, expected);
  });
}

test("taking, buying, selling, workers, cargo, bonus decline and turn boundaries have cue plans", async ({ page }) => {
  const operations: { name: string; fixture?: Fixture; match: Partial<Action>; sounds: Sound[] }[] = [
    { name: "take with worker payment", match: { kind: "take", die: 0, cost: 1 }, sounds: ["tile", "workers"] },
    { name: "buy", match: { kind: "buy" }, sounds: ["coins", "tile"] },
    { name: "sell", match: { kind: "sell", die: 0, cost: 0 }, sounds: ["coins", "score"] },
    { name: "workers", match: { kind: "workers", die: 0 }, sounds: ["workers"] },
    { name: "atomic harbor load", fixture: { scenario: "ship" }, match: { kind: "ship", depots: [0] }, sounds: ["cargo"] },
    { name: "explicit cargo choice", fixture: { scenario: "goods" }, match: { kind: "goods" }, sounds: ["cargo"] },
    { name: "decline bonus", fixture: { scenario: "skip" }, match: { kind: "skip" }, sounds: ["close"] },
    { name: "next round", fixture: { scenario: "end" }, match: { kind: "end" }, sounds: ["turn", "dice"] },
    { name: "next phase", fixture: { scenario: "phase" }, match: { kind: "end" }, sounds: ["turn", "dice", "phase"] },
    { name: "final score", fixture: { scenario: "finish" }, match: { kind: "end" }, sounds: ["turn", "finish"] },
  ];
  for (const { name, fixture, match, sounds } of operations) {
    await test.step(name, async () => {
      await seedTable(page, fixture);
      const expected = await expectedAction(page, match);
      expect(expected.cues[0]).toEqual({ sound: sounds[0], delay: match.kind === "sell" ? MOTION.flight / 1000 : 0 });
      expect(expected.cues.map(cue => cue.sound)).toEqual(expect.arrayContaining(sounds));
      expect(new Set(expected.cues.map(cue => cue.sound)).size).toBe(expected.cues.length);
      // Cues are grouped by meaning, not chronology: a coin can land after a
      // score tone while a cinematic dice cue deliberately waits for impact.
      expect(expected.cues.every(cue => Number.isFinite(cue.delay) && cue.delay >= 0)).toBe(true);
      await clickLegal(page, expected);
    });
  }
});

test("taking workers plays two clear token taps through the actual action button", async ({ page }) => {
  await seedTable(page);
  const clip = await page.evaluate(async () => {
    const response = await fetch("/audio/workers.mp3");
    if (!response.ok) throw Error(`Worker sound: HTTP ${response.status}`);
    const context = new AudioContext();
    try {
      const buffer = await context.decodeAudioData(await response.arrayBuffer());
      const samples = buffer.getChannelData(0);
      const rms = (start: number, end: number) => {
        const section = samples.subarray(Math.floor(start * buffer.sampleRate), Math.floor(end * buffer.sampleRate));
        return Math.sqrt(section.reduce((total, sample) => total + sample * sample, 0) / section.length);
      };
      return {
        duration: buffer.duration,
        peak: samples.reduce((peak, sample) => Math.max(peak, Math.abs(sample)), 0),
        firstTap: rms(0, 0.18), gap: rms(0.18, 0.26), secondTap: rms(0.26, 0.44),
      };
    } finally { await context.close(); }
  });
  expect(clip.duration).toBeCloseTo(0.56, 2);
  expect(clip.peak).toBeGreaterThan(0.45);
  expect(clip.peak).toBeLessThan(0.8);
  expect(clip.firstTap).toBeGreaterThan(0.05);
  expect(clip.secondTap).toBeGreaterThan(0.05);
  expect(clip.gap).toBeLessThan(Math.min(clip.firstTap, clip.secondTap) * 0.1);

  const expected = await expectedAction(page, { kind: "workers", die: 0 });
  await clearProbe(page);
  await page.locator('#turn-controls [data-mode="workers"]').click();
  expect(await saved(page)).toEqual(expected.state);
  const played = await captured(page);
  expect(played.cues).toEqual([{ sound: "workers", delay: 0 }]);
  expect(played.commits).toEqual([{ key: expected.key, cues: expected.cues }]);
  expect(played.starts).toHaveLength(1);
  expect(played.starts[0].duration).toBeCloseTo(clip.duration, 2);
});

test("selection, dialogs, keyboard operations and undo make sounds without duplicate moves", async ({ page }) => {
  const before = await seedTable(page);
  await page.locator('[data-die="1"]').click();
  expect((await captured(page)).cues.map(cue => cue.sound)).toContain("select");
  expect(await saved(page)).toEqual(before);

  await clearProbe(page);
  await page.locator('[data-ui="help"]').click();
  await expect(page.getByRole("dialog")).toBeVisible();
  expect((await captured(page)).cues.map(cue => cue.sound)).toContain("knowledge");
  await clearProbe(page);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).not.toBeVisible();
  expect((await captured(page)).cues.map(cue => cue.sound)).toContain("close");
  expect(await saved(page)).toEqual(before);

  const expected = await expectedAction(page, { kind: "workers", die: 1 });
  await clearProbe(page);
  await page.keyboard.down("4");
  await page.keyboard.down("4"); // Repeated keydown is not another operation.
  await page.keyboard.up("4");
  expect(await saved(page)).toEqual(expected.state);
  expect((await captured(page)).commits).toEqual([{ key: expected.key, cues: expected.cues }]);
  await clearProbe(page);
  const restored = await expectRestored(page, before, () => page.keyboard.press("Control+z"));
  const undone = await captured(page);
  expect(undone.cues.filter(cue => cue.sound === "undo")).toHaveLength(1);
  expect(undone.commits).toEqual([]);
  await clearProbe(page);
  await page.keyboard.press("z"); // No remaining undo must stay silent.
  expect((await captured(page)).cues).toEqual([]);
  expect(await saved(page)).toEqual(restored);
});

test("a rapid next action cancels native pending placement audio without losing either move", async ({ page }) => {
  const before = await seedTable(page, { tile: { color: "animal", animal: "sheep", count: 2 } });
  await page.locator('[data-die="0"]').click();
  // Warm the existing runtime once, so this checks interruption rather than network latency.
  await page.evaluate(async () => {
    const runtime = window.__audioProbe.runtime as unknown as { buffers: Map<string, Promise<AudioBuffer>> };
    await Promise.all(runtime.buffers.values());
  });
  const placed = await expectedAction(page, { kind: "place", die: 0, cost: 0 });
  await page.locator("#legal-details > summary").click();
  const result = await page.evaluate(async ({ key, saveKey }) => {
    const { legalActions, applyAction } = await import("/src/engine.ts");
    const probe = window.__audioProbe;
    const runtime = probe.runtime as unknown as {
      context: AudioContext;
      voices: Map<AudioBufferSourceNode, { sound: Sound; startTime: number }>;
    };
    const stops: number[] = [];
    const stop = AudioBufferSourceNode.prototype.stop;
    AudioBufferSourceNode.prototype.stop = function (...args) {
      stops.push(this.buffer?.duration ?? 0);
      stop.apply(this, args);
    };
    probe.pending = [];
    probe.commits = [];
    document.querySelector<HTMLButtonElement>(`#legal-actions [data-action-key="${CSS.escape(key)}"]`)!.click();
    await Promise.all(probe.pending);
    const sheep = [...runtime.voices].find(([, metadata]) => metadata.sound === "sheep");
    const future = !!sheep && sheep[1].startTime > runtime.context.currentTime;
    const duration = sheep?.[0].buffer?.duration;
    const intermediate: State = JSON.parse(localStorage.getItem(saveKey)!);
    const workers: Action = legalActions(intermediate).find((action: Action) => action.kind === "workers" && action.die === 1);
    const expected = applyAction(intermediate, workers);
    // Use the actual visible controls in the same task; no engine dispatch or audio hook.
    document.querySelector<HTMLButtonElement>('.quick-actions [data-mode="workers"]')!.click();
    await Promise.all(probe.pending);
    return { future, duration, stops, expected, intermediate,
      committed: probe.commits.length,
      sheepStillOwned: [...runtime.voices.values()].some(metadata => metadata.sound === "sheep"),
    };
  }, { key: placed.key, saveKey: SAVE_KEY });
  expect(result.intermediate).toEqual(placed.state);
  expect(result.future).toBe(true);
  expect(result.stops).toContain(result.duration);
  expect(result.sheepStillOwned).toBe(false);
  expect(result.committed).toBe(2);
  expect(await saved(page)).toEqual(result.expected);
  expect(before.players[0].dice.every(die => die !== null)).toBe(true);
  expect(result.expected.players[0].dice).toEqual([null, null]);
});

test("mute persists independently of the save and prevents real playback", async ({ page }) => {
  const before = await seedTable(page);
  const sound = page.locator('[data-ui="sound"]');
  await expect(sound).toHaveAccessibleName("Sound effects");
  await expect(sound).toHaveAttribute("aria-pressed", "true");
  await sound.click();
  await expect(sound).toHaveAttribute("aria-pressed", "false");
  expect(await saved(page)).toEqual(before);
  expect(await page.evaluate(key => localStorage.getItem(key), MUTE_KEY)).toBe("true");
  const expected = await expectedAction(page, { kind: "workers", die: 0 });
  expect((await clickLegal(page, expected)).starts).toEqual([]);

  await page.reload();
  await expect(sound).toHaveAttribute("aria-pressed", "false");
  expect(await saved(page)).toEqual(expected.state);
  expect((await captured(page)).starts).toEqual([]);
  await observeCues(page);
  await sound.click();
  await expect(sound).toHaveAttribute("aria-pressed", "true");
  expect(await saved(page)).toEqual(expected.state);
  expect(await page.evaluate(key => localStorage.getItem(key), MUTE_KEY)).toBe("false");
  const next = await expectedAction(page, { kind: "workers", die: 1 });
  expect((await clickLegal(page, next)).starts.length).toBeGreaterThan(0);
});

test("loading, passive rendering and engine previews stay silent; audio failures cannot break a move", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  const before = await seedTable(page);
  expect(await captured(page)).toEqual({ cues: [], commits: [], starts: [] });
  await page.locator('[data-die="0"]').click(); // Unlock first: no-context alone is not proof of silence.
  await clearProbe(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.locator('[data-source="market"]').first().hover();
  await expectedAction(page, { kind: "take" }); // Speculative applyAction + cue planning must be pure.
  expect(await captured(page)).toEqual({ cues: [], commits: [], starts: [] });
  expect(await saved(page)).toEqual(before);
  await page.reload();
  await expect(page.locator("#turn-controls")).toBeVisible();
  expect((await captured(page)).starts).toEqual([]);

  for (const failure of ["missing recording", "decode rejection", "unavailable audio device"] as const) {
    await test.step(failure, async () => {
      await seedTable(page);
      if (failure === "missing recording") await page.route("**/audio/*.mp3", route => route.abort("failed"));
      else await page.evaluate(failure => {
        if (failure === "decode rejection") {
          BaseAudioContext.prototype.decodeAudioData = () => Promise.reject(new DOMException("Test decode failure", "EncodingError"));
        } else {
          Object.defineProperty(window, "AudioContext", {
            configurable: true,
            value: class { constructor() { throw new Error("Test unavailable device"); } },
          });
        }
      }, failure);
      const expected = await expectedAction(page, { kind: "workers", die: 0 });
      expect((await clickLegal(page, expected)).starts).toEqual([]);
      await expect(page.locator("#notice")).not.toBeVisible();
      if (failure === "missing recording") await page.unroute("**/audio/*.mp3");
    });
  }
  expect(errors).toEqual([]);
});

test("every recorded asset decodes in Chromium and the real audio runtime starts its buffer", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await seedTable(page);
  await page.locator('[data-die="0"]').click(); // Real user gesture unlocks the app's own GameAudio instance.
  const decoded = await page.evaluate(async () => {
    const { RECORDED_SOUNDS } = await import("/src/audio.ts");
    const context = new AudioContext();
    try {
      return await Promise.all(Object.entries(RECORDED_SOUNDS).map(async ([sound, filename]) => {
        const response = await fetch(`/audio/${filename}`);
        if (!response.ok) throw Error(`${filename}: HTTP ${response.status}`);
        const buffer = await context.decodeAudioData(await response.arrayBuffer());
        const audible = Array.from({ length: buffer.numberOfChannels }, (_, channel) =>
          buffer.getChannelData(channel).some(sample => Math.abs(sample) > 0.0001)).some(Boolean);
        return { sound: sound as Sound, duration: buffer.duration, channels: buffer.numberOfChannels, audible };
      }));
    } finally {
      await context.close();
    }
  });
  expect(decoded.map(asset => asset.sound).sort()).toEqual([
    "ship", "knowledge", "sheep", "cattle", "pig", "chicken", "tile", "coins",
    "dice", "workers", "cargo", "build", "castle", "mine", "bell", "stamp",
  ].sort());
  for (const asset of decoded) {
    await test.step(asset.sound, async () => {
      expect(asset.duration).toBeGreaterThan(0);
      expect(asset.channels).toBeGreaterThan(0);
      expect(asset.audible).toBe(true);
      await clearProbe(page);
      await page.evaluate(async sound => { await window.__audioProbe.runtime!.play(sound); }, asset.sound);
      const result = await captured(page);
      expect(result.cues).toEqual([{ sound: asset.sound, delay: 0 }]);
      expect(result.starts).toHaveLength(1);
      expect(result.starts[0].duration).toBeCloseTo(asset.duration, 2);
    });
  }
  expect(errors).toEqual([]);
});
