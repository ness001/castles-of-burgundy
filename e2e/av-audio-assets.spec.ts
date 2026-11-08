import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test, type TestInfo } from "@playwright/test";
import type { GameAudio, Sound } from "../src/audio";
import { createGame, legalActions } from "../src/engine";
import { MOTION } from "../src/motion-timing";

let EVIDENCE: string;
const TONES: Sound[] = ["select", "open", "close", "undo", "error", "turn", "score", "region", "bonus", "phase", "finish"];

interface Frame { ms: number; lengthMs: number; min: number; max: number; rms: number }
interface Measurement {
  durationMs: number; channels: number; sampleRate: number; finite: boolean;
  peak: number; peakMs: number; rms: number; activeRms: number; peak50msRms: number;
  onsetMs: number; endMs: number; tailMs: number; gate: number;
  energy95Ms: number; energy99Ms: number; last20msRms: number;
  firstSample: number; lastSample: number; maxStep: number; frames: Frame[];
}
interface Analysis {
  masterGain: number; browser: string; measuredAt: string;
  assets: Record<string, Measurement>;
  mixes: Record<string, Measurement>;
  toneHighBand: Record<string, number>;
}
interface NativeProbe {
  starts: { durationMs: number; when: number; clock: number; wall: number; baseLatency: number }[];
  requests: { sound: Sound; delay: number; wall: number; clock: number }[];
  frames: { elapsed: number; wall: number; height: number; phase: string | undefined }[];
  rollAt?: number;
}
declare global {
  interface Window { __avMixRuntime: GameAudio; __avMixNative: NativeProbe }
}

let analysis: Analysis;
const db = (amplitude: number) => 20 * Math.log10(Math.max(amplitude, 1e-6));
const rmsBetween = (asset: Measurement, startMs: number, endMs: number) => {
  let energy = 0, duration = 0;
  for (const frame of asset.frames) {
    const overlap = Math.max(0, Math.min(endMs, frame.ms + frame.lengthMs) - Math.max(startMs, frame.ms));
    energy += frame.rms ** 2 * overlap;
    duration += overlap;
  }
  return Math.sqrt(energy / Math.max(duration, 1));
};

// Safety/integrity checks, not assertions of subjective loudness or pleasantness.
function intact(name: string, documentedSeconds?: number) {
  const asset = analysis.assets[name];
  expect(asset.finite, `${name}: finite PCM`).toBe(true);
  expect(asset.channels, `${name}: attributed mono source`).toBe(1);
  expect(asset.peak, `${name}: non-silent`).toBeGreaterThan(0.001);
  expect(asset.peak, `${name}: no full-scale sample clipping`).toBeLessThan(1);
  if (documentedSeconds !== undefined) {
    // Accommodate MP3 encoder padding, not changes to the recording's contour.
    expect(Math.abs(asset.durationMs - documentedSeconds * 1000)).toBeLessThan(50);
  }
  return asset;
}

async function record(info: TestInfo, data: unknown) {
  const body = JSON.stringify(data, null, 2);
  await writeFile(`${EVIDENCE}/${info.title.slice(0, 3)}.json`, body);
  await info.attach("waveform-derived-measurements", { body, contentType: "application/json" });
}

test.beforeAll(async ({ browser, baseURL }, info) => {
  EVIDENCE = join(info.project.outputDir, "av-audio-assets");
  await mkdir(EVIDENCE, { recursive: true });
  const page = await browser.newPage({ baseURL });
  try {
    // An isolated same-origin harness avoids gameplay/AI while decoding assets.
    await page.route("**/__av_mix__", route => route.fulfill({
      contentType: "text/html",
      body: '<!doctype html><meta charset="utf-8"><button id="unlock">Unlock native audio probe</button>',
    }));
    await page.goto("/__av_mix__");
    await page.evaluate(async () => {
      const { GameAudio } = await import("/src/audio.ts");
      window.__avMixRuntime = new GameAudio();
      document.querySelector("button")!.addEventListener("click", () => window.__avMixRuntime.unlock());
    });
    await page.locator("#unlock").click();
    analysis = await page.evaluate(async toneNames => {
      const { GameAudio, RECORDED_SOUNDS } = await import("/src/audio.ts");
      const live = window.__avMixRuntime as unknown as { context: AudioContext; output: GainNode };
      const masterGain = live.output.gain.value;
      const rate = 44_100;
      const decoder = new OfflineAudioContext(1, 1, rate);
      const buffers = new Map<string, AudioBuffer>();
      for (const [name, file] of Object.entries(RECORDED_SOUNDS)) {
        const response = await fetch(`/audio/${file}`);
        if (!response.ok) throw Error(`${file}: HTTP ${response.status}`);
        buffers.set(name, await decoder.decodeAudioData(await response.arrayBuffer()));
      }
      // Run the production tone builder against a genuine OfflineAudioContext.
      // Test-only access avoids exporting internals or duplicating its envelope.
      const synth = new GameAudio() as unknown as { context: OfflineAudioContext; tone(name: Sound): AudioBuffer };
      synth.context = decoder;
      for (const name of toneNames) buffers.set(name, synth.tone(name));

      function measure(buffer: AudioBuffer): Measurement {
        const samples = buffer.getChannelData(0), sampleRate = buffer.sampleRate;
        const step = Math.round(sampleRate * 0.005);
        let sum = 0, peak = 0, peakIndex = 0, maxStep = 0;
        const frames: Frame[] = [];
        for (let start = 0; start < samples.length; start += step) {
          const end = Math.min(samples.length, start + step);
          let energy = 0, min = 0, max = 0;
          for (let i = start; i < end; i++) {
            const value = samples[i];
            energy += value ** 2;
            min = Math.min(min, value); max = Math.max(max, value);
            if (Math.abs(value) > peak) { peak = Math.abs(value); peakIndex = i; }
            if (i) maxStep = Math.max(maxStep, Math.abs(value - samples[i - 1]));
          }
          sum += energy;
          frames.push({ ms: start / sampleRate * 1000, lengthMs: (end - start) / sampleRate * 1000,
            min, max, rms: Math.sqrt(energy / (end - start)) });
        }
        // Activity is a 5-ms RMS gate 20 dB below the strongest frame, floored
        // at -80 dBFS. It is an explicit waveform proxy, not a hearing threshold.
        const gate = Math.max(0.0001, ...frames.map(frame => frame.rms * 0.1));
        const active = frames.filter(frame => frame.rms >= gate);
        const activeMs = active.reduce((total, frame) => total + frame.lengthMs, 0);
        let cumulative = 0, energy95Ms = 0, energy99Ms = 0, tailEnergy = 0;
        for (let i = 0; i < samples.length; i++) {
          cumulative += samples[i] ** 2;
          if (!energy95Ms && cumulative >= sum * 0.95) energy95Ms = i / sampleRate * 1000;
          if (!energy99Ms && cumulative >= sum * 0.99) energy99Ms = i / sampleRate * 1000;
          if (i >= samples.length - Math.round(sampleRate * 0.02)) tailEnergy += samples[i] ** 2;
        }
        let peak50msRms = 0;
        for (let i = 0; i < frames.length; i++) {
          const window = frames.slice(i, i + 10);
          if (window.length !== 10) continue;
          peak50msRms = Math.max(peak50msRms, Math.sqrt(window.reduce((energy, f) => energy + f.rms ** 2, 0) / 10));
        }
        const endMs = active.at(-1) ? active.at(-1)!.ms + active.at(-1)!.lengthMs : 0;
        return { durationMs: buffer.duration * 1000, channels: buffer.numberOfChannels, sampleRate,
          finite: samples.every(Number.isFinite), peak, peakMs: peakIndex / sampleRate * 1000,
          rms: Math.sqrt(sum / samples.length),
          activeRms: Math.sqrt(active.reduce((energy, f) => energy + f.rms ** 2 * f.lengthMs, 0) / Math.max(1, activeMs)),
          peak50msRms, onsetMs: active[0]?.ms ?? 0, endMs, tailMs: buffer.duration * 1000 - endMs,
          gate, energy95Ms, energy99Ms, last20msRms: Math.sqrt(tailEnergy / Math.round(sampleRate * 0.02)),
          firstSample: samples[0], lastSample: samples.at(-1)!, maxStep, frames };
      }
      async function render(cues: { name: string; at?: number }[], highPass = false) {
        const seconds = Math.max(...cues.map(cue => (cue.at ?? 0) + buffers.get(cue.name)!.duration));
        const context = new OfflineAudioContext(1, Math.ceil(seconds * rate), rate);
        const gain = context.createGain();
        gain.gain.value = masterGain;
        gain.connect(context.destination);
        for (const cue of cues) {
          const source = context.createBufferSource();
          source.buffer = buffers.get(cue.name)!;
          if (highPass) {
            const filter = context.createBiquadFilter();
            filter.type = "highpass"; filter.frequency.value = 4000; filter.Q.value = Math.SQRT1_2;
            source.connect(filter); filter.connect(gain);
          } else source.connect(gain);
          source.start(cue.at ?? 0);
        }
        return measure(await context.startRendering());
      }
      const assets = Object.fromEntries([...buffers].map(([name, buffer]) => [name, measure(buffer)]));
      const mixes: Record<string, Measurement> = {};
      for (const name of ["sheep", "cattle", "pig", "chicken", "ship", "knowledge", "bell"]) {
        mixes[name] = await render([{ name }, { name: ["ship", "knowledge", "bell"].includes(name) ? "bonus" : "score", at: 0.18 }]);
      }
      mixes.coinsWorkers = await render([{ name: "coins" }, { name: "workers", at: 0.18 }]);
      mixes.sixRewards = await render(["finish", "phase", "region", "score", "bonus", "turn"].map(name => ({ name })));
      const toneHighBand: Record<string, number> = {};
      for (const name of toneNames) toneHighBand[name] = (await render([{ name }], true)).rms / (assets[name].rms * masterGain);
      window.__avMixRuntime.stop();
      await live.context.close();
      return { masterGain, browser: navigator.userAgent, measuredAt: new Date().toISOString(), assets, mixes, toneHighBand };
    }, TONES);
    await writeFile(`${EVIDENCE}/measurements.json`, JSON.stringify(analysis, null, 2));
    // Vector evidence: identical amplitude/time axes; no raster or audio assets made.
    const rows = Object.entries(analysis.assets);
    const width = 1100, rowHeight = 90;
    const svg = rows.map(([name, m], row) => {
      const y = 65 + row * rowHeight;
      const lines = m.frames.map(f => {
        const x = 320 + f.ms / 3100 * 720;
        return `M${x.toFixed(2)},${(y - f.max * 32).toFixed(2)}V${(y - f.min * 32).toFixed(2)}`;
      }).join("");
      return `<text x="12" y="${y - 12}" font-size="15">${name} · ${m.durationMs.toFixed(0)} ms</text>` +
        `<text x="12" y="${y + 9}" font-size="12">peak ${db(m.peak).toFixed(1)} / RMS ${db(m.rms).toFixed(1)} dBFS · onset ${m.onsetMs.toFixed(0)} ms</text>` +
        `<path d="M320,${y}H1040" stroke="#bbb"/><path d="${lines}" stroke="#255a83"/>` +
        `<path d="M${320 + m.onsetMs / 3100 * 720},${y - 32}v64" stroke="#b76b13"/>`;
    }).join("");
    await writeFile(`${EVIDENCE}/waveforms.svg`, `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${rows.length * rowHeight + 40}"><rect width="100%" height="100%" fill="white"/><g font-family="sans-serif" fill="#202c34"><text x="12" y="21">Actual decoded MP3 / production synth PCM · common 0–3.1 s / ±1 axes · orange: 5-ms RMS activity onset</text>${svg}</g></svg>`);
  } finally { await page.close(); }
});

test("031 tile/build retain distinct short transients and two construction taps", async ({}, info) => {
  const tile = intact("tile", 0.38), build = intact("build", 0.60);
  const first = rmsBetween(build, 0, 180), gap = rmsBetween(build, 180, 230), second = rmsBetween(build, 230, 420);
  await record(info, { tile, build, construction: { first, gap, second } });
  expect(first).toBeGreaterThan(gap);
  expect(second).toBeGreaterThan(gap);
  expect(tile.onsetMs).toBeLessThan(100);
  expect(build.onsetMs).toBeLessThan(100);
});

test("032 coin/worker energy comparison preserves two separate worker taps", async ({}, info) => {
  const coins = intact("coins", 0.66), workers = intact("workers", 0.56);
  const first = rmsBetween(workers, 0, 180), gap = rmsBetween(workers, 180, 260), second = rmsBetween(workers, 260, 440);
  const workerMinusCoinDb = db(workers.peak50msRms / coins.peak50msRms);
  await record(info, { coins, workers, workerMinusCoinDb, first, gap, second, mix: analysis.mixes.coinsWorkers });
  expect(first).toBeGreaterThan(gap * 2);
  expect(second).toBeGreaterThan(gap * 2);
  expect(analysis.mixes.coinsWorkers.peak).toBeLessThan(1);
});

for (const [id, name, seconds] of [["033", "sheep", 0.95], ["034", "cattle", 2.901], ["035", "pig", 0.58], ["036", "chicken", 2.05]] as const) {
  test(`${id} ${name} preserves its attributed call, fade, and reward headroom`, async ({}, info) => {
    const asset = intact(name, seconds), score = analysis.assets.score;
    const overlapRms = rmsBetween(asset, 180, 180 + score.durationMs);
    await record(info, { asset, mix: analysis.mixes[name],
      callMinusScoreDb: db(overlapRms / score.rms),
      lateCallRms: rmsBetween(asset, MOTION.animals, asset.durationMs) });
    expect(asset.last20msRms).toBeLessThan(asset.rms);
    expect(Math.abs(asset.lastSample)).toBeLessThan(0.001);
    expect(analysis.mixes[name].peak).toBeLessThan(1);
  });
}

test("037 ship wash length and reward overlap retain a tapered, unclipped mix", async ({}, info) => {
  const ship = intact("ship", 1.75), bonus = analysis.assets.bonus;
  await record(info, { ship, mix: analysis.mixes.ship,
    shipMinusBonusDb: db(rmsBetween(ship, 180, 180 + bonus.durationMs) / bonus.rms),
    after1500msRms: rmsBetween(ship, 1500, ship.durationMs) });
  expect(ship.last20msRms).toBeLessThan(ship.rms);
  expect(Math.abs(ship.lastSample)).toBeLessThan(0.001);
  expect(analysis.mixes.ship.peak).toBeLessThan(1);
});

test("038 knowledge/bell preserve page attack, bell release, and reward headroom", async ({}, info) => {
  const knowledge = intact("knowledge", 0.55), bell = intact("bell", 1.40);
  const bonus = analysis.assets.bonus;
  await record(info, { knowledge, bell,
    bellMinusPageDb: db(bell.peak50msRms / knowledge.peak50msRms),
    pageMinusBonusDb: db(rmsBetween(knowledge, 180, 180 + bonus.durationMs) / bonus.rms),
    bellMinusBonusDb: db(rmsBetween(bell, 180, 180 + bonus.durationMs) / bonus.rms),
    mixes: { knowledge: analysis.mixes.knowledge, bell: analysis.mixes.bell } });
  expect(knowledge.last20msRms).toBeLessThan(knowledge.rms);
  expect(bell.last20msRms).toBeLessThan(bell.rms);
  expect(analysis.mixes.knowledge.peak).toBeLessThan(1);
  expect(analysis.mixes.bell.peak).toBeLessThan(1);
});

test("039 native dice scheduling measures decoded onset against a rendered contact", async ({ page }, info) => {
  const dice = intact("dice", 1.40);
  const state = createGame(42);
  state.active = 0; state.order = [1, 0]; state.turnIndex = 1;
  state.players.forEach(player => { player.dice = [null, null]; });
  state.players[0].arrival = state.players[1].arrival + 1;
  const end = legalActions(state).find(action => action.kind === "end")!;
  expect(end).toBeDefined();
  await page.addInitScript(state => {
    localStorage.setItem("burgundy-table.state.v1", JSON.stringify(state));
    window.__avMixNative = { starts: [], requests: [], frames: [] };
    const start = AudioBufferSourceNode.prototype.start;
    AudioBufferSourceNode.prototype.start = function (...args) {
      start.apply(this, args);
      const context = this.context as AudioContext;
      window.__avMixNative.starts.push({ durationMs: (this.buffer?.duration ?? 0) * 1000,
        when: args[0] ?? 0, clock: context.currentTime, wall: performance.now(), baseLatency: context.baseLatency });
    };
  }, state);
  await page.goto("/");
  await expect(page.locator("#board canvas")).toBeAttached();
  await page.waitForFunction(() => performance.getEntriesByType("resource").some(entry => new URL(entry.name).pathname === "/src/dice-renderer.ts"));
  await page.evaluate(async () => {
    const resource = (path: string) => performance.getEntriesByType("resource").find(entry => new URL(entry.name).pathname === path)!.name;
    const { GameAudio } = await import(resource("/src/audio.ts"));
    const { DiceRenderer } = await import(resource("/src/dice-renderer.ts"));
    const play = GameAudio.prototype.play;
    GameAudio.prototype.play = function (sound: Sound, delay = 0) {
      window.__avMixNative.requests.push({ sound, delay, wall: performance.now(), clock: this.context?.currentTime ?? 0 });
      return play.call(this, sound, delay);
    };
    const roll = DiceRenderer.prototype.play, render = DiceRenderer.prototype.render;
    DiceRenderer.prototype.play = function (...args: unknown[]) {
      window.__avMixNative.rollAt = performance.now();
      return roll.apply(this, args);
    };
    DiceRenderer.prototype.render = function (elapsed: number) {
      const result = render.call(this, elapsed);
      if (this.renderer?.domElement.isConnected && this.dice[0]?.visible) {
        window.__avMixNative.frames.push({ elapsed, wall: performance.now(), height: this.dice[0].position.z,
          phase: this.renderer.domElement.dataset.state });
      }
      return result;
    };
  });
  await page.locator("#turn-controls .turn-tools .end-turn").click();
  await page.waitForFunction(() => window.__avMixNative.frames.some(frame => frame.elapsed >= 1000));
  await page.screenshot({ path: `${EVIDENCE}/039-native-dice.png` });
  await page.waitForFunction(() => window.__avMixNative.frames.some(frame => frame.phase === "settled"));
  const probe = await page.evaluate(() => window.__avMixNative);
  const starts = probe.starts.filter(start => Math.abs(start.durationMs - dice.durationMs) < 2);
  const requests = probe.requests.filter(request => request.sound === "dice");
  expect(starts).toHaveLength(1);
  expect(requests).toHaveLength(1);
  const expectedContactMs = MOTION.diceRoll * 0.79; // First ground contact in the inspected renderer, not final face reveal.
  const frame = probe.frames.filter(frame => Math.abs(frame.elapsed - expectedContactMs) < 100)
    .sort((a, b) => a.height - b.height)[0];
  expect(frame, "real WebGL frames around the first rebound").toBeDefined();
  const start = starts[0], request = requests[0];
  const estimatedOnsetWall = start.wall + (start.when - start.clock) * 1000 + dice.onsetMs;
  await record(info, { dice, probe, expectedContactMs, observedContactFrame: frame,
    estimatedOnsetWall, onsetMinusContactMs: estimatedOnsetWall - frame.wall,
    scheduledMinusRequestedMs: (start.when - request.clock - request.delay) * 1000,
    limitation: "Native scheduler and submitted WebGL geometry; not speaker latency or human listening. Screenshot is a real roll, not an exact-contact freeze." });
  expect(request.delay).toBeCloseTo(MOTION.diceLanding / 1000, 3);
  expect(Math.abs(start.when - request.clock - request.delay)).toBeLessThan(0.05);
});

test("040 production UI/reward tones keep smooth boundaries and six-voice headroom", async ({}, info) => {
  const tones = Object.fromEntries(TONES.map(name => [name, intact(name)]));
  await record(info, { tones, highPass4000HzRmsRatio: analysis.toneHighBand, sixRewards: analysis.mixes.sixRewards,
    limitation: "Unweighted PCM/filtered energy cannot establish subjective comfort or safe acoustic listening level." });
  for (const tone of Object.values(tones)) {
    expect(Math.abs(tone.firstSample)).toBeLessThan(0.0001);
    expect(Math.abs(tone.lastSample)).toBeLessThan(0.0001);
    expect(tone.last20msRms).toBeLessThan(tone.rms / 10);
  }
  expect(analysis.mixes.sixRewards.peak).toBeLessThan(1);
});
