import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { GameAudio, soundsForAction } from "../src/audio";
import { boardFor } from "../src/boards";
import { applyAction, createGame, legalActions } from "../src/engine";
import type { Action, State, Tile } from "../src/types";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(yes => { resolve = yes; });
  return { promise, resolve };
}

function audioContext() {
  const recordings = new Map<string, AudioBuffer>();
  const voices: {
    buffer: AudioBuffer | null;
    start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn>;
    connect: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn>;
    onended: (() => void) | null;
  }[] = [];
  const gains: {
    gain: { value: number; setValueAtTime: ReturnType<typeof vi.fn>; linearRampToValueAtTime: ReturnType<typeof vi.fn> };
    connect: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn>;
  }[] = [];
  const context = {
    state: "running", currentTime: 5, sampleRate: 44100, destination: {},
    resume: vi.fn(async () => { context.state = "running"; }),
    decodeAudioData: vi.fn(async (bytes: ArrayBuffer) => {
      const buffer = { duration: 2 } as AudioBuffer;
      recordings.set(new TextDecoder().decode(bytes), buffer);
      return buffer;
    }),
    createBuffer: vi.fn((_channels: number, length: number, rate: number) => {
      const samples = new Float32Array(length);
      return { duration: length / rate, getChannelData: () => samples };
    }),
    createGain: vi.fn(() => {
      const gain = {
        gain: { value: 1, setValueAtTime: vi.fn(), linearRampToValueAtTime: vi.fn() },
        connect: vi.fn(), disconnect: vi.fn(),
      };
      gains.push(gain);
      return gain;
    }),
    createBufferSource: vi.fn(() => {
      const voice = {
        buffer: null as AudioBuffer | null, start: vi.fn(), stop: vi.fn(),
        connect: vi.fn(), disconnect: vi.fn(), onended: null as (() => void) | null,
      };
      voices.push(voice);
      return voice;
    }),
  };
  return { context, recordings, voices, gains };
}

let fixture: ReturnType<typeof audioContext>;
let audio: GameAudio;
let played: MockInstance<GameAudio["play"]>;
let page: { hidden: boolean };

beforeEach(() => {
  fixture = audioContext();
  page = { hidden: false };
  vi.stubGlobal("document", page);
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: vi.fn() });
  vi.stubGlobal("AudioContext", vi.fn(function () { return fixture.context; }));
  vi.stubGlobal("fetch", vi.fn(async (url: string) => ({
    ok: true,
    arrayBuffer: async () => new TextEncoder().encode(url.split("/").at(-1)!.replace(".mp3", "")).buffer,
  })));
  vi.spyOn(performance, "now").mockReturnValue(0);
  audio = new GameAudio();
  played = vi.spyOn(audio, "play");
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function move(state: State, kind: Action["kind"], matches: (action: Action) => boolean = () => true) {
  const action = legalActions(state).find(action => action.kind === kind && action.cost === 0 && matches(action));
  expect(action, `legal ${kind} fixture`).toBeDefined();
  const next = applyAction(state, action!);
  return { state, action: action!, next, cues: soundsForAction(state, action!, next) };
}

function placement(complete = false, repeat = false) {
  const state = createGame(42);
  state.active = 0;
  state.order = [0, 1];
  state.turnIndex = 0;
  const player = state.players[0], board = boardFor(player);
  const tile: Tile = { id: "continuity-sheep", color: "animal", animal: "sheep", count: 2 };
  const cell = board.find(cell => cell.color === "animal" && board.filter(other => other.region === cell.region).length > 2)!;
  const adjacent = (other: typeof cell) => Math.max(
    Math.abs(other.q - cell.q), Math.abs(other.r - cell.r), Math.abs(other.q + other.r - cell.q - cell.r),
  ) === 1;
  const anchor = board.find(other => other.color !== tile.color && adjacent(other))!;
  player.board[anchor.id] = { id: "continuity-anchor", color: anchor.color };
  if (complete) for (const other of board) {
    if (other.region === cell.region && other.id !== cell.id)
      player.board[other.id] = { ...tile, id: `continuity-region-${other.id}` };
  }
  player.storage = [tile];
  player.dice = [cell.die, 2];
  if (repeat) {
    const other = board.find(other => other.region === cell.region && adjacent(other))!;
    player.storage.push({ ...tile, id: "continuity-second-sheep", count: 3 });
    player.dice[1] = other.die;
  }
  return move(state, "place", action => action.cell === cell.id && action.die === 0);
}

function commit(transition: ReturnType<typeof move>) {
  audio.playAction(transition.state, transition.action, transition.next);
}

const settle = () => Promise.all(played.mock.results.map(result => result.value));
const recordedVoice = (sound: string) => fixture.voices.find(voice => voice.buffer === fixture.recordings.get(sound))!;
const startsAt = (voice: typeof fixture.voices[number]) => voice.start.mock.calls[0][0] as number;
const envelope = (voice: typeof fixture.voices[number]) => fixture.gains[fixture.voices.indexOf(voice) + 1];
const regionVoice = (transition: ReturnType<typeof move>) => fixture.voices.find(voice =>
  startsAt(voice) === 5 + transition.cues.find(cue => cue.sound === "region")!.delay)!;

function pendingSheep() {
  const started = deferred(), ready = deferred();
  const decode = fixture.context.decodeAudioData.getMockImplementation()!;
  fixture.context.decodeAudioData.mockImplementation(async bytes => {
    if (new TextDecoder().decode(bytes) === "sheep") {
      started.resolve();
      await ready.promise;
    }
    return decode(bytes);
  });
  return { started, ready };
}

describe("081–090 committed action audio continuity", () => {
  it("081 cancels a pending placement at the next legal action boundary", async () => {
    const placed = placement();
    audio.unlock();
    const stop = vi.spyOn(audio, "stop");
    commit(placed);
    await settle();
    const stale = [...fixture.voices];
    expect(startsAt(recordedVoice("sheep"))).toBeGreaterThan(fixture.context.currentTime);
    fixture.context.currentTime += 0.05;
    commit(move(placed.next, "workers"));
    await settle();
    for (const voice of stale) {
      expect(voice.stop).toHaveBeenCalledWith();
      expect(voice.disconnect).toHaveBeenCalledOnce();
      expect(envelope(voice).gain.linearRampToValueAtTime).not.toHaveBeenCalled();
    }
    expect(startsAt(recordedVoice("workers"))).toBe(fixture.context.currentTime);
    expect(stop).not.toHaveBeenCalled();
  });

  it("082 cancels a future region receipt without cutting its audible placement", async () => {
    const placed = placement(true);
    audio.unlock();
    commit(placed);
    await settle();
    const sheep = recordedVoice("sheep"), region = regionVoice(placed);
    fixture.context.currentTime = (startsAt(sheep) + startsAt(region)) / 2;
    commit(move(placed.next, "workers"));
    await settle();
    expect(region.stop).toHaveBeenCalledWith();
    expect(region.disconnect).toHaveBeenCalledOnce();
    expect(envelope(region).gain.linearRampToValueAtTime).not.toHaveBeenCalled();
    expect(sheep.stop).not.toHaveBeenCalled();
  });

  it("083 discards an obsolete placement still awaiting decode, retaining its reusable buffer", async () => {
    const blocked = pendingSheep(), placed = placement();
    audio.unlock();
    commit(placed);
    await blocked.started.promise;
    commit(move(placed.next, "workers"));
    blocked.ready.resolve();
    await settle();
    expect(recordedVoice("sheep")).toBeUndefined();
    expect(recordedVoice("workers")).toBeDefined();
    await audio.play("sheep");
    expect(startsAt(recordedVoice("sheep"))).toBe(fixture.context.currentTime);
    expect(vi.mocked(fetch).mock.calls.filter(([url]) => String(url).endsWith("/sheep.mp3"))).toHaveLength(1);
  });

  it("084 preserves the audible animal tail through a new action and natural completion", async () => {
    const placed = placement();
    audio.unlock();
    commit(placed);
    await settle();
    const sheep = recordedVoice("sheep");
    fixture.context.currentTime = startsAt(sheep) + 0.02;
    commit(move(placed.next, "workers"));
    await settle();
    expect(sheep.stop).not.toHaveBeenCalled();
    expect(sheep.disconnect).not.toHaveBeenCalled();
    expect(envelope(sheep).gain.linearRampToValueAtTime).not.toHaveBeenCalled();
    sheep.onended?.();
    expect(sheep.disconnect).toHaveBeenCalledOnce();
    expect(envelope(sheep).disconnect).toHaveBeenCalledOnce();
    expect(sheep.onended).toBeNull();
  });

  it("085 leaves a committed reward scheduled when UI selection unlocks and plays", async () => {
    const placed = placement(true), saved = structuredClone(placed.next);
    audio.unlock();
    commit(placed);
    await settle();
    const region = regionVoice(placed), when = startsAt(region);
    const stop = vi.spyOn(audio, "stop");
    audio.unlock();
    await audio.play("select");
    expect(region.stop).not.toHaveBeenCalled();
    expect(region.disconnect).not.toHaveBeenCalled();
    expect(startsAt(region)).toBe(when);
    expect(stop).not.toHaveBeenCalled();
    expect(placed.next).toEqual(saved);
  });

  it("086 stop/undo clears active, scheduled and unresolved playback", async () => {
    const blocked = pendingSheep(), placed = placement(true);
    audio.unlock();
    await audio.play("ship");
    commit(placed);
    await blocked.started.promise;
    await Promise.all(played.mock.results.filter((_, index) => played.mock.calls[index][0] !== "sheep").map(result => result.value));
    const ship = recordedVoice("ship"), region = regionVoice(placed);
    audio.stop();
    const undo = audio.play("undo");
    blocked.ready.resolve();
    await settle();
    await undo;
    expect(ship.stop).toHaveBeenCalledWith(5.012);
    expect(ship.disconnect).not.toHaveBeenCalled();
    ship.onended?.();
    expect(ship.disconnect).toHaveBeenCalledOnce();
    expect(region.stop).toHaveBeenCalledWith();
    expect(region.disconnect).toHaveBeenCalledOnce();
    expect(recordedVoice("sheep")).toBeUndefined();
    expect(fixture.voices).toHaveLength(3); // ship, region, fresh undo
    expect(startsAt(fixture.voices.at(-1)!)).toBe(5);
  });

  it("087 mute/unmute never replays cancelled action loads or rewards", async () => {
    const blocked = pendingSheep(), placed = placement(true);
    audio.unlock();
    commit(placed);
    await blocked.started.promise;
    await played.mock.results.at(-1)!.value; // The region tone is not decode-blocked.
    const region = regionVoice(placed);
    audio.setMuted(true);
    audio.setMuted(false);
    blocked.ready.resolve();
    await settle();
    expect(audio.muted).toBe(false);
    expect(region.stop).toHaveBeenCalledWith();
    expect(recordedVoice("sheep")).toBeUndefined();
    expect(fixture.voices).toHaveLength(1);
    await audio.play("select");
    expect(fixture.voices).toHaveLength(2);
  });

  it("088 drops pending hidden-tab actions and does not replay them on return", async () => {
    const blocked = pendingSheep(), placed = placement(true);
    audio.unlock();
    commit(placed);
    await blocked.started.promise;
    await played.mock.results.at(-1)!.value;
    const region = regionVoice(placed);
    page.hidden = true;
    audio.stop(); // Existing main visibilitychange contract; no new listener.
    commit(move(placed.next, "workers"));
    blocked.ready.resolve();
    await settle();
    expect(region.stop).toHaveBeenCalledWith();
    expect(recordedVoice("sheep")).toBeUndefined();
    expect(recordedVoice("workers")).toBeUndefined();
    page.hidden = false;
    audio.unlock();
    await audio.play("select");
    expect(fixture.voices).toHaveLength(2); // cancelled region plus fresh selection
  });

  it("089 reschedules a rapid same-sound legal placement without changing committed state", async () => {
    const first = placement(false, true), second = move(first.next, "place");
    const before = structuredClone(first.state), after = structuredClone(second.next);
    audio.unlock();
    commit(first);
    await settle();
    const oldSheep = recordedVoice("sheep");
    fixture.context.currentTime += 0.05;
    commit(second);
    await settle();
    const sheep = fixture.voices.filter(voice => voice.buffer === fixture.recordings.get("sheep"));
    expect(sheep).toHaveLength(2);
    expect(oldSheep.stop).toHaveBeenCalledWith();
    expect(startsAt(sheep[1])).toBe(5.05 + second.cues.find(cue => cue.sound === "sheep")!.delay);
    expect(sheep[1].stop).not.toHaveBeenCalled();
    expect(first.state).toEqual(before);
    expect(second.next).toEqual(after);
    expect(second.next).toEqual(applyAction(applyAction(first.state, first.action), second.action));
    expect(second.next.players[0].dice).toEqual([null, null]);
    expect(second.next.players[0].storage).toEqual([]);
    expect(second.next.players[0].score).toBe(7);
  });

  it("090 retains the six-voice budget and cleans a failed source.start before retry", async () => {
    const createVoice = fixture.context.createBufferSource.getMockImplementation()!;
    fixture.context.createBufferSource.mockImplementationOnce(() => {
      const voice = createVoice();
      voice.start.mockImplementationOnce(() => { throw new Error("Audio device lost at start"); });
      return voice;
    });
    audio.unlock();
    await expect(audio.play("ship")).resolves.toBeUndefined();
    const failed = fixture.voices[0];
    expect(failed.disconnect).toHaveBeenCalledOnce();
    expect(envelope(failed).disconnect).toHaveBeenCalledOnce();
    expect(failed.onended).toBeNull();
    for (const sound of ["ship", "tile", "coins", "dice", "cargo", "build"] as const) await audio.play(sound);
    const active = fixture.voices.slice(1);
    const placed = placement();
    commit(placed);
    await settle();
    expect(fixture.voices).toHaveLength(7); // Failed source plus six audible voices; no future cuts.
    for (const voice of active) expect(voice.stop).not.toHaveBeenCalled();
    fixture.context.currentTime += 0.11;
    commit(move(placed.next, "workers"));
    await settle();
    expect(active[0].stop).toHaveBeenCalledOnce();
    expect(recordedVoice("workers")).toBeDefined();
    expect(fixture.voices.filter(voice => voice.start.mock.results[0].type === "return" && !voice.stop.mock.calls.length)).toHaveLength(6);
    expect(failed.disconnect).toHaveBeenCalledOnce();
  });
});
