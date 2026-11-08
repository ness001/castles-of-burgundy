import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GameAudio, RECORDED_SOUNDS, soundForTile, soundsForAction } from "../src/audio";
import { BUILDINGS } from "../src/data";
import { boardFor } from "../src/boards";
import { applyAction, createGame, legalActions } from "../src/engine";
import { motionForAction } from "../src/motion-events";
import { MOTION, rollLeadIn } from "../src/motion-timing";
import type { Action, State, Tile } from "../src/types";

const ship: Tile = { id: "ship", color: "ship" };
const storage = new Map<string, string>();
const voices: { buffer: unknown; start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn>; connect: ReturnType<typeof vi.fn>; onended: (() => void) | null }[] = [];
const context = {
  state: "running",
  currentTime: 5,
  sampleRate: 44100,
  destination: {},
  createBuffer: vi.fn((_channels: number, size: number, sampleRate: number) => {
    const data = new Float32Array(size);
    return { duration: size / sampleRate, getChannelData: () => data };
  }),
  createGain: vi.fn(() => ({
    gain: { value: 1, setValueAtTime: vi.fn(), linearRampToValueAtTime: vi.fn() },
    connect: vi.fn(), disconnect: vi.fn(),
  })),
  resume: vi.fn(async () => { context.state = "running"; }),
  decodeAudioData: vi.fn(async () => ({ duration: 1 }) as AudioBuffer),
  createBufferSource: vi.fn(() => {
    const voice = { buffer: null as unknown, start: vi.fn(), stop: vi.fn(), disconnect: vi.fn(), connect: vi.fn(), onended: null as (() => void) | null };
    voices.push(voice);
    return voice;
  }),
};

beforeEach(() => {
  storage.clear();
  voices.length = 0;
  context.state = "running";
  context.currentTime = 5;
  vi.clearAllMocks();
  vi.stubGlobal("document", { hidden: false });
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
  });
  vi.stubGlobal("AudioContext", vi.fn(function () { return context; }));
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(4) })));
});
afterEach(() => vi.unstubAllGlobals());

describe("placement sounds", () => {
  it("maps waves, pages, and each livestock species without generic animal sounds", () => {
    expect(soundForTile(ship)).toBe("ship");
    expect(soundForTile({ id: "book", color: "knowledge", knowledge: 13 })).toBe("knowledge");
    for (const animal of ["pig", "sheep", "cattle", "chicken"] as const)
      expect(soundForTile({ id: animal, color: "animal", animal, count: 4 })).toBe(animal);
    expect(soundForTile({ id: "castle", color: "castle" })).toBe("castle");
    expect(soundForTile({ id: "mine", color: "mine" })).toBe("mine");
    for (const building of BUILDINGS) {
      const expected = {
        warehouse: "cargo", workshop: "build", church: "bell", market: "tile",
        boarding: "workers", bank: "coins", hall: "stamp", watchtower: "castle",
      };
      expect(soundForTile({ id: building, color: "building", building })).toBe(expected[building]);
    }
  });

  it("stays silent before a gesture, preloads once, and reuses decoded clips", async () => {
    const audio = new GameAudio();
    await audio.play("ship");
    expect(fetch).not.toHaveBeenCalled();
    expect(voices).toHaveLength(0);
    audio.unlock();
    audio.unlock();
    await audio.play("ship");
    context.currentTime += 0.11;
    await audio.play("ship");
    expect(fetch).toHaveBeenCalledTimes(Object.keys(RECORDED_SOUNDS).length);
    expect(fetch).toHaveBeenCalledWith("/audio/ship.mp3");
    expect(context.decodeAudioData).toHaveBeenCalledTimes(Object.keys(RECORDED_SOUNDS).length);
    expect(voices).toHaveLength(2);
    expect(voices[0].buffer).toBe(voices[1].buffer);
    expect(voices[0].start).toHaveBeenCalledOnce();
    expect(context.createGain.mock.results[0].value.gain.value).toBeLessThan(0.5);
  });

  it("resumes a suspended audio context from input", async () => {
    context.state = "suspended";
    const audio = new GameAudio();
    audio.unlock();
    await audio.play("ship");
    expect(context.resume).toHaveBeenCalledOnce();
    expect(voices[0].start).toHaveBeenCalledOnce();
  });

  it("persists mute separately, stops active clips, and prevents stale playback after unmuting", async () => {
    const audio = new GameAudio();
    audio.unlock();
    await audio.play("ship");
    const pending = audio.play("ship");
    audio.setMuted(true);
    expect(voices[0].stop).toHaveBeenCalledOnce();
    expect(new GameAudio().muted).toBe(true);
    expect([...storage.keys()]).toEqual(["burgundy-table.audio-muted.v1"]);
    audio.setMuted(false);
    await pending;
    expect(voices).toHaveLength(1);
    await audio.play("ship");
    expect(voices).toHaveLength(2);
    expect(new GameAudio().muted).toBe(false);
  });

  it("does not initialize audio while the saved preference is muted", async () => {
    storage.set("burgundy-table.audio-muted.v1", "true");
    const audio = new GameAudio();
    audio.unlock();
    await audio.play("ship");
    expect(fetch).not.toHaveBeenCalled();
    expect(AudioContext).not.toHaveBeenCalled();
  });

  it("cancels pending sounds on undo and while the document is hidden", async () => {
    const audio = new GameAudio();
    audio.unlock();
    const pending = audio.play("ship");
    audio.stop();
    await pending;
    expect(voices).toHaveLength(0);
    vi.stubGlobal("document", { hidden: true });
    await audio.play("ship");
    expect(voices).toHaveLength(0);
  });

  it.each([5.1, 5.6])("anchors motion delays to the request even when decoding finishes at %ss", async readyTime => {
    context.decodeAudioData.mockImplementationOnce(async () => {
      context.currentTime = readyTime;
      return { duration: 1 } as AudioBuffer;
    });
    const audio = new GameAudio();
    audio.unlock();
    await audio.play("dice", 0.28);
    expect(voices[0].start).toHaveBeenCalledWith(Math.max(readyTime, 5.28));
  });

  it.each(["stop", "mute", "visibility"] as const)("cancels scheduled dice/coins and pending tone generation on %s", async reason => {
    const audio = new GameAudio();
    audio.unlock();
    await Promise.all([audio.play("dice", 0.28), audio.play("coins", 0.36)]);
    expect(voices.map(voice => voice.start.mock.calls[0][0]).sort((a, b) => a - b)).toEqual([5.28, 5.36]);
    const pending = audio.play("score", 0.54);
    if (reason === "visibility") vi.stubGlobal("document", { hidden: true });
    if (reason === "mute") audio.setMuted(true);
    else audio.stop(); // Shared cancellation API for Undo, a new game, and visibility changes.
    if (reason === "visibility") vi.stubGlobal("document", { hidden: false });
    if (reason === "mute") audio.setMuted(false);
    await pending;
    expect(voices).toHaveLength(2);
    expect(context.createBuffer).not.toHaveBeenCalled();
    for (const voice of voices) {
      expect(voice.stop).toHaveBeenCalledOnce();
      expect(voice.disconnect).toHaveBeenCalledOnce();
    }
    await audio.play("undo");
    expect(voices).toHaveLength(3);
    expect(voices[2].start).toHaveBeenCalledWith(5);
  });

  it("does not queue pre-gesture action rewards or replay them on selection", async () => {
    const state = position();
    const { action, next } = perform(state, "sell");
    const audio = new GameAudio();
    audio.playAction(state, action, next);
    audio.unlock();
    await audio.play("select");
    expect(voices).toHaveLength(1);
    expect(context.createBuffer).toHaveBeenCalledOnce();
    expect(voices[0].buffer).toBe(context.createBuffer.mock.results[0].value);
  });

  it("limits overlapping bonus/AI sounds and releases ended voices", async () => {
    const audio = new GameAudio();
    audio.unlock();
    for (const sound of ["ship", "tile", "coins", "dice", "workers", "cargo", "build"] as const) await audio.play(sound);
    expect(voices[0].stop).toHaveBeenCalledOnce();
    voices[1].onended?.();
    audio.stop();
    expect(voices[1].stop).not.toHaveBeenCalled();
    expect(voices[2].stop).toHaveBeenCalledOnce();
    expect(voices[3].stop).toHaveBeenCalledOnce();
  });

  it("keeps missing files and unsupported Web Audio non-fatal", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false })));
    const audio = new GameAudio();
    expect(() => audio.unlock()).not.toThrow();
    await expect(audio.play("ship")).resolves.toBeUndefined();
    expect(voices).toHaveLength(0);
    vi.stubGlobal("AudioContext", undefined);
    expect(() => new GameAudio().unlock()).not.toThrow();
  });

  it("keeps storage failures non-fatal", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => { throw new Error("Storage blocked"); },
      setItem: () => { throw new Error("Storage blocked"); },
    });
    const audio = new GameAudio();
    expect(() => audio.setMuted(true)).not.toThrow();
    expect(audio.muted).toBe(true);
  });

  it("synthesizes quiet finite UI cues locally and schedules them on the audio clock", async () => {
    const audio = new GameAudio();
    audio.unlock();
    for (const sound of ["select", "open", "close", "undo", "error", "turn", "score", "region", "bonus", "phase", "finish"] as const) {
      await audio.play(sound, 0.2);
      expect(voices.at(-1)!.start).toHaveBeenCalledWith(context.currentTime + 0.2);
      const buffer = voices.at(-1)!.buffer as AudioBuffer;
      const samples = buffer.getChannelData(0);
      expect(samples.every(Number.isFinite)).toBe(true);
      expect(samples.some(sample => Math.abs(sample) > 0.01)).toBe(true);
      expect(samples.every(sample => Math.abs(sample) < 0.4)).toBe(true);
    }
    expect(fetch).toHaveBeenCalledTimes(Object.keys(RECORDED_SOUNDS).length);
  });
});

function position(): State {
  const state = createGame(42);
  state.active = 0;
  state.order = [0, 1];
  state.turnIndex = 0;
  state.players[0].dice = [1, 2];
  state.players[0].workers = 6;
  state.players[0].silver = 4;
  state.players[0].goods = [2, 0, 0, 0, 0, 0];
  return state;
}
function perform(state: State, kind: Action["kind"]) {
  const action = legalActions(state).find(action => action.kind === kind)!;
  expect(action).toBeDefined();
  const before = structuredClone(state);
  const next = applyAction(state, action);
  const cues = soundsForAction(state, action, next);
  expect(state).toEqual(before);
  return { action, next, cues, sounds: cues.map(cue => cue.sound) };
}

describe("successful operation cues", () => {
  it("covers every gameplay action, including harbor manifests and declined bonuses", () => {
    const expected = { take: "tile", buy: "coins", sell: "coins", workers: "workers", ship: "cargo", goods: "cargo", skip: "close", end: "turn" } as const;
    for (const kind of Object.keys(expected) as (keyof typeof expected)[]) {
      const state = position();
      if (kind === "ship") state.pending = [{ kind: "ship" }];
      if (kind === "goods") { state.pending = [{ kind: "goods", depots: [0] }]; state.depots[0].goods = [1]; }
      if (kind === "skip") state.pending = [{ kind: "sell" }];
      if (kind === "end") state.players[0].dice = [null, null];
      const { sounds } = perform(state, kind);
      expect(sounds[0]).toBe(expected[kind]);
      if (kind === "buy") expect(sounds).toEqual(["coins", "tile"]);
      if (kind === "sell") expect(sounds).toContain("score");
    }
  });

  it("plays each placed tile's foley for both human and computer moves", () => {
    const tiles: Tile[] = [ship, { id: "castle", color: "castle" }, { id: "mine", color: "mine" },
      { id: "knowledge", color: "knowledge", knowledge: 3 },
      ...(["pig", "sheep", "cattle", "chicken"] as const).map(animal => ({ id: animal, color: "animal" as const, animal, count: 2 })),
      ...BUILDINGS.map(building => ({ id: building, color: "building" as const, building }))];
    for (const active of [0, 1]) for (const tile of tiles) {
      const state = position();
      state.active = active;
      const player = state.players[active];
      const board = boardFor(player);
      const target = board.find(cell => cell.color === tile.color && !player.board[cell.id])!;
      const neighbor = board.find(cell => Math.max(Math.abs(cell.q - target.q), Math.abs(cell.r - target.r), Math.abs(cell.q + cell.r - target.q - target.r)) === 1)!;
      player.board[neighbor.id] = { id: "anchor", color: neighbor.color };
      player.storage = [tile];
      player.dice = [target.die, target.die];
      const { sounds } = perform(state, "place");
      expect(sounds[0]).toBe(soundForTile(tile));
    }
  });

  it("acknowledges worker payments without duplicating the primary effect", () => {
    const state = position();
    const action = legalActions(state).find(action => action.kind === "take" && action.cost > 0)!;
    const cues = soundsForAction(state, action, applyAction(state, action));
    expect(cues).toEqual([{ sound: "tile", delay: 0 }, { sound: "workers", delay: 0.18 }]);
  });

  it("uses one synchronized coin cue for a bank payout", () => {
    const state = position();
    const player = state.players[0];
    const board = boardFor(player);
    const target = board.find(cell => cell.color === "building")!;
    const neighbor = board.find(cell => Math.max(Math.abs(cell.q - target.q), Math.abs(cell.r - target.r), Math.abs(cell.q + cell.r - target.q - target.r)) === 1)!;
    player.board[neighbor.id] = { id: "anchor", color: neighbor.color };
    player.storage = [{ id: "bank", color: "building", building: "bank" }];
    player.dice = [target.die, null];
    const { action, next, cues } = perform(state, "place");
    expect(next.players[0].silver - player.silver).toBe(2);
    expect(cues.filter(cue => cue.sound === "coins")).toEqual([{ sound: "coins", delay: 2 * MOTION.flight / 1000 }]);
    const timed = soundsForAction(state, action, next, { silverDelay: 0.36 });
    expect(timed.filter(cue => cue.sound === "coins")).toEqual([{ sound: "coins", delay: 0.36 }]);
    expect(timed.filter(cue => cue.sound !== "coins")).toEqual(cues.filter(cue => cue.sound !== "coins"));
  });

  it.each([false, true])("uses one coin cue for actual sale income, with trade knowledge: %s", improved => {
    const state = position();
    if (improved) {
      const cell = boardFor(state.players[0]).find(cell => cell.color === "knowledge")!;
      state.players[0].board[cell.id] = { id: "trade", color: "knowledge", knowledge: 3 };
    }
    const { action, next, cues } = perform(state, "sell");
    expect(next.players[0].silver - state.players[0].silver).toBe(improved ? 2 : 1);
    expect(cues).toEqual([{ sound: "coins", delay: MOTION.flight / 1000 }, { sound: "score", delay: 0.18 }]);
    expect(soundsForAction(state, action, next, { silverDelay: 0.36 }))
      .toEqual([{ sound: "coins", delay: 0.36 }, { sound: "score", delay: 0.18 }]);
  });

  it.each([false, true])("only adds a worker-income coin cue for knowledge 13: %s", income => {
    const state = position();
    if (income) {
      const cell = boardFor(state.players[0]).find(cell => cell.color === "knowledge")!;
      state.players[0].board[cell.id] = { id: "income", color: "knowledge", knowledge: 13 };
    }
    const { action, next, sounds } = perform(state, "workers");
    expect(next.players[0].silver - state.players[0].silver).toBe(income ? 1 : 0);
    expect(sounds).toEqual(income ? ["workers", "coins"] : ["workers"]);
    const timed = soundsForAction(state, action, next, { silverDelay: 0 });
    expect(timed.filter(cue => cue.sound === "coins")).toEqual(income ? [{ sound: "coins", delay: 0 }] : []);
  });

  it("preserves purchase foley instead of treating spending as a delayed reward", () => {
    const state = position();
    const { action, next, cues } = perform(state, "buy");
    expect(next.players[0].silver - state.players[0].silver).toBe(-2);
    expect(soundsForAction(state, action, next, { silverDelay: 0.36 })).toEqual(cues);
    expect(cues).toEqual([{ sound: "coins", delay: 0 }, { sound: "tile", delay: 0.18 }]);
  });

  it("celebrates region completion, color rewards, and bonus chains", () => {
    const state = position();
    const player = state.players[0];
    const board = boardFor(player);
    const castleCells = board.filter(cell => cell.color === "castle");
    const last = castleCells.find(cell => !player.board[cell.id])!;
    for (const cell of board) if (cell.id !== last.id) player.board[cell.id] = { id: `filled-${cell.id}`, color: cell.color };
    player.storage = [{ id: "last-castle", color: "castle" }];
    player.dice = [last.die, null];
    const { sounds } = perform(state, "place");
    expect(sounds).toEqual(["castle", "region", "bonus"]);
  });

  it("reads completion from the active estate's layout, including four-player games", () => {
    const state = createGame(42, { playerCount: 4 });
    state.active = 3;
    const player = state.players[3];
    player.boardId = 6;
    const board = boardFor(player);
    const target = board.find(cell => cell.color === "mine")!;
    player.board = board.map(cell => cell.id === target.id ? null : { id: `filled-${cell.id}`, color: cell.color });
    player.storage = [{ id: "final-mine", color: "mine" }];
    player.dice = [target.die, null];
    const { sounds } = perform(state, "place");
    expect(sounds).toEqual(["mine", "region", "bonus"]);
  });

  it("distinguishes end-turn, fresh dice, phase income, and the final result", () => {
    for (const round of [0, 4]) {
      const state = position();
      state.turnIndex = 1;
      state.order = [1, 0];
      state.round = round;
      state.players[0].dice = [null, null];
      if (round === 4) {
        const mine = boardFor(state.players[0]).find(cell => cell.color === "mine")!;
        state.players[0].board[mine.id] = { id: "income-mine", color: "mine" };
      }
      const { action, next, sounds, cues } = perform(state, "end");
      expect(sounds).toContain("turn");
      expect(sounds).toContain("dice");
      expect(cues.find(cue => cue.sound === "dice")).toEqual({ sound: "dice",
        delay: (rollLeadIn(motionForAction(state, action, next)) + MOTION.diceLanding) / 1000 });
      if (round === 4) {
        expect(sounds).toContain("phase");
        expect(sounds).toContain("coins");
      }
    }
    const state = position();
    state.phase = 4;
    state.round = 4;
    state.turnIndex = 1;
    state.order = [1, 0];
    state.players[0].dice = [null, null];
    expect(perform(state, "end").sounds).toEqual(["turn", "finish"]);
  });

  it.each([2, 3, 4] as const)("groups %s-player mine income even when the actor earns nothing, including the final phase", playerCount => {
    for (const phase of [0, 4]) {
      const state = createGame(42, { playerCount });
      state.active = playerCount - 1;
      state.order = state.players.map((_, index) => index);
      state.turnIndex = playerCount - 1;
      state.round = 4;
      state.phase = phase;
      state.players[state.active].dice = [null, null];
      state.players[state.active].silver = 0;
      for (const player of state.players.slice(0, -1)) {
        const mine = boardFor(player).find(cell => cell.color === "mine")!;
        player.board[mine.id] = { id: "income-mine", color: "mine" };
      }
      const { action, next, cues, sounds } = perform(state, "end");
      expect(next.players[state.active].silver).toBe(0);
      expect(next.players.slice(0, -1).map((player, index) => player.silver - state.players[index].silver))
        .toEqual(Array(playerCount - 1).fill(1));
      expect(cues.filter(cue => cue.sound === "coins")).toEqual([{ sound: "coins", delay: MOTION.flight / 1000 }]);
      expect(sounds.includes("dice")).toBe(phase !== 4);
      if (phase === 4) expect(sounds).toEqual(["turn", "coins", "finish"]);
      const audio = new GameAudio();
      const play = vi.spyOn(audio, "play").mockResolvedValue(undefined);
      audio.playAction(state, action, next);
      expect(play.mock.calls).toEqual(cues.map(cue => [cue.sound, cue.delay]));
      play.mockClear();
      audio.playAction(state, action, next, { diceDelay: 0, silverDelay: 0 });
      expect(play).toHaveBeenCalledWith("coins", 0);
      if (phase !== 4) expect(play).toHaveBeenCalledWith("dice", 0);
    }
  });

  it("sounds estate selection and rolls dice only when setup is complete", () => {
    let state = createGame(42, { estates: "open" });
    while (state.status === "setup") {
      const { next, sounds, cues } = perform(state, "choose-estate");
      expect(sounds[0]).toBe("castle");
      expect(sounds.includes("dice")).toBe(next.status === "playing");
      if (next.status === "playing") expect(cues.find(cue => cue.sound === "dice")?.delay).toBe(MOTION.diceLanding / 1000);
      state = next;
    }
  });
});
