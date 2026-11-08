import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GameAudio, RECORDED_SOUNDS } from "../src/audio";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function audioContext() {
  const voices: {
    buffer: AudioBuffer | null;
    start: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
    connect: ReturnType<typeof vi.fn>;
    disconnect: ReturnType<typeof vi.fn>;
    onended: (() => void) | null;
  }[] = [];
  const gains: {
    gain: {
      value: number;
      cancelScheduledValues: ReturnType<typeof vi.fn>;
      setValueAtTime: ReturnType<typeof vi.fn>;
      linearRampToValueAtTime: ReturnType<typeof vi.fn>;
    };
    connect: ReturnType<typeof vi.fn>;
    disconnect: ReturnType<typeof vi.fn>;
  }[] = [];
  const context = {
    state: "running",
    currentTime: 5,
    sampleRate: 44100,
    destination: {},
    resume: vi.fn(async () => { context.state = "running"; }),
    decodeAudioData: vi.fn(async (_bytes: ArrayBuffer) => ({ duration: 1 }) as AudioBuffer),
    createBuffer: vi.fn((_channels: number, length: number, sampleRate: number) => {
      const samples = new Float32Array(length);
      return { duration: length / sampleRate, getChannelData: () => samples };
    }),
    createGain: vi.fn(() => {
      const gain = {
        gain: {
          value: 1, cancelScheduledValues: vi.fn(), setValueAtTime: vi.fn(),
          linearRampToValueAtTime: vi.fn(),
        },
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
  return { context, voices, gains };
}

let fixture: ReturnType<typeof audioContext>;
let audio: GameAudio;

beforeEach(() => {
  fixture = audioContext();
  vi.stubGlobal("document", { hidden: false });
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: vi.fn() });
  vi.stubGlobal("AudioContext", vi.fn(function () { return fixture.context; }));
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(4) })));
  audio = new GameAudio();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("audio playback resilience", () => {
  it("softens tile pickups without lowering other action sounds", async () => {
    audio.unlock();
    await audio.play("tile", 0.2);
    const envelope = fixture.gains[1];
    expect(envelope.gain.value).toBe(0.4);
    expect(envelope.gain.setValueAtTime).toHaveBeenCalledWith(0, 5.2);
    expect(envelope.gain.linearRampToValueAtTime).toHaveBeenCalledWith(0.4, 5.215);
    expect(fixture.voices[0].start).toHaveBeenCalledWith(5.2);

    await audio.play("coins");
    expect(fixture.gains[2].gain.value).toBe(1);
    expect(fixture.gains[2].gain.linearRampToValueAtTime).not.toHaveBeenCalled();
  });

  it("001 coalesces gesture unlocks while one resume is pending", async () => {
    const resumed = deferred<void>();
    fixture.context.state = "suspended";
    fixture.context.resume.mockImplementation(() => resumed.promise.then(() => { fixture.context.state = "running"; }));
    audio.unlock();
    audio.unlock();
    const pending = audio.play("select");
    expect(fixture.voices).toHaveLength(0);
    const resumeCalls = fixture.context.resume.mock.calls.length;
    resumed.resolve();
    await pending;
    expect(resumeCalls).toBe(1);
    expect(fixture.voices).toHaveLength(1);
  });

  it("001 permits a later gesture to retry a rejected resume", async () => {
    fixture.context.state = "suspended";
    fixture.context.resume.mockRejectedValueOnce(new Error("Autoplay blocked"));
    audio.unlock();
    await audio.play("select");
    expect(fixture.voices).toHaveLength(0);
    audio.unlock();
    await audio.play("select");
    expect(fixture.context.resume).toHaveBeenCalledTimes(2);
    expect(fixture.voices).toHaveLength(1);
  });

  it("002 replaces a closed context without replaying its pending work or cached tones", async () => {
    const decoded = deferred<AudioBuffer>();
    fixture.context.decodeAudioData.mockImplementationOnce(() => decoded.promise);
    audio.unlock();
    await audio.play("select");
    const pending = audio.play("ship");
    fixture.context.state = "closed";
    const replacement = audioContext();
    replacement.context.sampleRate = 48000;
    vi.stubGlobal("AudioContext", vi.fn(function () { return replacement.context; }));
    audio.unlock();
    await audio.play("select");
    decoded.resolve({ duration: 1 } as AudioBuffer);
    await pending;
    expect(AudioContext).toHaveBeenCalledOnce();
    expect(replacement.voices).toHaveLength(1);
    expect(replacement.context.createBuffer).toHaveBeenCalledOnce();
    expect(replacement.voices[0].buffer).not.toBe(fixture.voices[0].buffer);
    expect(fixture.voices).toHaveLength(1);
    expect(fixture.voices[0].stop).toHaveBeenCalledOnce();
    expect(fixture.gains[0].disconnect).toHaveBeenCalledOnce();
  });

  it("002 resumes an interrupted context on the next gesture", async () => {
    fixture.context.state = "interrupted";
    audio.unlock();
    await audio.play("select");
    expect(fixture.context.resume).toHaveBeenCalledOnce();
    expect(fixture.voices).toHaveLength(1);
  });

  it.each(["audio", "wall"] as const)("003 drops a decoded cue that missed its landing on the %s clock", async clock => {
    const decoding = deferred<void>();
    const decoded = deferred<AudioBuffer>();
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    fixture.context.decodeAudioData.mockImplementationOnce(() => {
      decoding.resolve();
      return decoded.promise;
    });
    audio.unlock();
    const pending = audio.play("ship", 0.28);
    await decoding.promise;
    if (clock === "audio") fixture.context.currentTime = 6;
    else now = 1000; // A suspended/interrupted audio clock need not advance with a stall.
    decoded.resolve({ duration: 1 } as AudioBuffer);
    await pending;
    expect(fixture.voices).toHaveLength(0);
    await audio.play("ship");
    expect(fixture.voices).toHaveLength(1);
    expect(fixture.voices[0].start).toHaveBeenCalledWith(fixture.context.currentTime);
  });

  it("004 coalesces same-sound bursts without suppressing later feedback", async () => {
    audio.unlock();
    await Promise.all(Array.from({ length: 12 }, () => audio.play("ship")));
    expect(fixture.voices).toHaveLength(1);
    fixture.context.currentTime += 0.05;
    await audio.play("ship");
    expect(fixture.voices).toHaveLength(1);
    fixture.context.currentTime += 0.06;
    await audio.play("ship");
    expect(fixture.voices).toHaveLength(2);
    await audio.play("coins");
    expect(fixture.voices).toHaveLength(3);
    audio.stop();
    await audio.play("ship");
    expect(fixture.voices).toHaveLength(4);
  });

  it("004 preserves deliberately separated repeats of one sound", async () => {
    audio.unlock();
    await Promise.all([audio.play("ship", 0.2), audio.play("ship", 0.4)]);
    expect(fixture.voices.map(voice => voice.start.mock.calls[0][0])).toEqual([5.2, 5.4]);
  });

  it.each([false, true])("005 separates non-overlapping current and future voices (future first: %s)", async futureFirst => {
    audio.unlock();
    if (!futureFirst) await audio.play("finish");
    for (const sound of ["ship", "tile", "coins", "dice", "workers", "cargo"] as const) await audio.play(sound, 3);
    if (futureFirst) await audio.play("finish");
    expect(fixture.voices).toHaveLength(7);
    for (const voice of fixture.voices) expect(voice.stop).not.toHaveBeenCalled();
  });

  it("005 does not cut a playing voice early to admit an overlapping future cue", async () => {
    audio.unlock();
    for (const sound of ["ship", "tile", "coins", "dice", "workers", "cargo"] as const) await audio.play(sound);
    await audio.play("phase", 0.2);
    expect(fixture.voices).toHaveLength(6);
    for (const voice of fixture.voices) expect(voice.stop).not.toHaveBeenCalled();
  });

  it("006 drops a UI click rather than cutting any overlapping reward", async () => {
    audio.unlock();
    for (const sound of ["finish", "region", "phase", "bonus", "score"] as const) await audio.play(sound);
    fixture.context.currentTime += 0.11;
    await audio.play("finish");
    await audio.play("select");
    expect(fixture.voices).toHaveLength(6);
    for (const voice of fixture.voices) expect(voice.stop).not.toHaveBeenCalled();
  });

  it("006 admits a reward by evicting the lowest-importance voice, not the oldest reward", async () => {
    audio.unlock();
    for (const sound of ["finish", "region", "phase", "bonus", "ship", "select"] as const) await audio.play(sound);
    await audio.play("score");
    expect(fixture.voices).toHaveLength(7);
    expect(fixture.voices[5].stop).toHaveBeenCalledOnce();
    for (const voice of fixture.voices.slice(0, 5)) expect(voice.stop).not.toHaveBeenCalled();
  });

  it.each(["stop", "eviction"] as const)("007 releases a playing voice before disconnecting on %s", async reason => {
    audio.unlock();
    await audio.play("ship");
    if (reason === "eviction") {
      for (const sound of ["tile", "coins", "dice", "workers", "cargo"] as const) await audio.play(sound);
    }
    fixture.context.currentTime = 5.1;
    if (reason === "stop") audio.stop();
    else await audio.play("build");
    const voice = fixture.voices[0];
    expect(voice.stop).toHaveBeenCalledOnce();
    const releasedAt = voice.stop.mock.calls[0][0];
    expect(releasedAt).toBeCloseTo(5.112, 8);
    const envelope = fixture.gains[1];
    expect(voice.connect).toHaveBeenCalledWith(envelope);
    expect(envelope.connect).toHaveBeenCalledWith(fixture.gains[0]);
    expect(envelope.gain.setValueAtTime).toHaveBeenCalledWith(1, 5.1);
    expect(envelope.gain.linearRampToValueAtTime).toHaveBeenCalledWith(0, releasedAt);
    expect(voice.disconnect).not.toHaveBeenCalled();
    voice.onended?.();
    expect(voice.disconnect).toHaveBeenCalledOnce();
    expect(envelope.disconnect).toHaveBeenCalledOnce();
  });

  it("007 cancels future sources immediately without a fade or double cleanup", async () => {
    audio.unlock();
    await audio.play("ship", 1);
    const voice = fixture.voices[0];
    audio.stop();
    expect(voice.stop).toHaveBeenCalledWith();
    expect(voice.disconnect).toHaveBeenCalledOnce();
    expect(fixture.gains[1].gain.linearRampToValueAtTime).not.toHaveBeenCalled();
    voice.onended?.();
    expect(voice.disconnect).toHaveBeenCalledOnce();
  });

  it.each(["HTTP", "decode"] as const)("008 shares a retry after a recorded sound's %s failure", async failure => {
    const response = deferred<Response>();
    const bytes = new ArrayBuffer(4);
    vi.mocked(fetch).mockImplementationOnce(() => response.promise);
    if (failure === "decode") fixture.context.decodeAudioData.mockImplementation(async data => {
      if (data === bytes) throw new Error("Invalid audio");
      return { duration: 1 } as AudioBuffer;
    });
    audio.unlock();
    const pending = audio.play("ship");
    await Promise.resolve();
    response.resolve({ ok: failure !== "HTTP", arrayBuffer: async () => bytes } as Response);
    await pending;
    expect(fixture.voices).toHaveLength(0);
    await Promise.all([audio.play("ship"), audio.play("ship")]);
    expect(fixture.voices).toHaveLength(1);
    expect(fetch).toHaveBeenCalledTimes(Object.keys(RECORDED_SOUNDS).length + 1);
    expect(vi.mocked(fetch).mock.calls.filter(([url]) => String(url).endsWith("/ship.mp3"))).toHaveLength(2);
  });

  it("008 keeps a replacement context's cached load when an obsolete decode fails", async () => {
    const oldStarted = deferred<void>();
    const oldDecoded = deferred<AudioBuffer>();
    fixture.context.decodeAudioData.mockImplementationOnce(() => {
      oldStarted.resolve();
      return oldDecoded.promise;
    });
    audio.unlock();
    const oldPlayback = audio.play("ship");
    await oldStarted.promise;
    fixture.context.state = "closed";
    const replacement = audioContext();
    const newStarted = deferred<void>();
    const newDecoded = deferred<AudioBuffer>();
    replacement.context.decodeAudioData.mockImplementationOnce(() => {
      newStarted.resolve();
      return newDecoded.promise;
    });
    vi.stubGlobal("AudioContext", vi.fn(function () { return replacement.context; }));
    audio.unlock();
    const pending = audio.play("ship");
    await newStarted.promise;
    oldDecoded.reject(new Error("Closed device"));
    await oldPlayback;
    const duplicate = audio.play("ship");
    newDecoded.resolve({ duration: 1 } as AudioBuffer);
    await Promise.all([pending, duplicate]);
    expect(vi.mocked(fetch).mock.calls.filter(([url]) => String(url).endsWith("/ship.mp3"))).toHaveLength(2);
    expect(replacement.context.decodeAudioData).toHaveBeenCalledTimes(Object.keys(RECORDED_SOUNDS).length);
    expect(replacement.voices).toHaveLength(1);
    expect(fixture.voices).toHaveLength(0);
  });

  it.each([
    ["resume", "stop"], ["resume", "mute"], ["decode", "stop"], ["decode", "mute"],
  ] as const)("009 cancels pending %s playback across %s, while allowing a fresh cue", async (stage, reason) => {
    const started = deferred<void>();
    const ready = deferred<void>();
    if (stage === "resume") {
      fixture.context.state = "suspended";
      fixture.context.resume.mockImplementation(() => {
        started.resolve();
        return ready.promise.then(() => { fixture.context.state = "running"; });
      });
    } else {
      fixture.context.decodeAudioData.mockImplementationOnce(() => {
        started.resolve();
        return ready.promise.then(() => ({ duration: 1 }) as AudioBuffer);
      });
    }
    audio.unlock();
    const pending = audio.play("ship");
    await started.promise;
    if (reason === "mute") {
      audio.setMuted(true);
      audio.setMuted(false);
    } else audio.stop();
    ready.resolve();
    await pending;
    expect(fixture.voices).toHaveLength(0);
    await audio.play("ship");
    expect(fixture.voices).toHaveLength(1);
  });

  it.each([44100, 48000, 96000])("010 keeps all synthesized cue envelopes finite, quiet, and tapered at %s Hz", async rate => {
    fixture.context.sampleRate = rate;
    audio.unlock();
    for (const sound of ["select", "open", "close", "undo", "error", "turn", "score", "region", "bonus", "phase", "finish"] as const) {
      audio.stop(); // Inspect each cue without deliberately saturating the voice budget.
      await audio.play(sound);
      const buffer = fixture.voices.at(-1)!.buffer!;
      const samples = buffer.getChannelData(0);
      expect(buffer.duration).toBeGreaterThan(0);
      expect(buffer.duration).toBeLessThan(1.3);
      expect(samples.every(Number.isFinite)).toBe(true);
      expect(samples.every(sample => Math.abs(sample) < 0.4)).toBe(true);
      expect(samples.some(sample => Math.abs(sample) > 0.01)).toBe(true);
      expect(samples[0]).toBe(0);
      expect(Math.abs(samples.at(-1)!)).toBeLessThan(0.00001);
    }
    expect(fixture.context.createBuffer).toHaveBeenCalledTimes(11);
    expect(fixture.gains[0].gain.value).toBe(0.45);
    expect(fetch).toHaveBeenCalledTimes(Object.keys(RECORDED_SOUNDS).length);
  });
});
