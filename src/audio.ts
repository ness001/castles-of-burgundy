import { motionForAction } from "./motion-events";
import { MOTION, rewardLeadIn, rollLeadIn } from "./motion-timing";
import type { Action, ActionKind, Building, State, Tile } from "./types";

const MUTE_KEY = "burgundy-table.audio-muted.v1";
const MAX_CUE_LATENESS = 0.5;
const SAME_SOUND_INTERVAL = 0.1;
const VOICE_RELEASE = 0.012;
export const RECORDED_SOUNDS = {
  ship: "ship.mp3",
  knowledge: "knowledge.mp3",
  sheep: "sheep.mp3",
  cattle: "cattle.mp3",
  pig: "pig.mp3",
  chicken: "chicken.mp3",
  tile: "tile.mp3",
  coins: "coins.mp3",
  dice: "dice.mp3",
  workers: "workers.mp3",
  cargo: "cargo.mp3",
  build: "build.mp3",
  castle: "castle.mp3",
  mine: "mine.mp3",
  bell: "bell.mp3",
  stamp: "stamp.mp3",
} as const;

// Original, short plucked tones for interface feedback; foley carries game actions.
const TONES = {
  select: { notes: [880], step: 0.04, decay: 0.08, volume: 0.11 },
  open: { notes: [523.25, 659.25], step: 0.045, decay: 0.12, volume: 0.10 },
  close: { notes: [659.25, 523.25], step: 0.045, decay: 0.12, volume: 0.10 },
  undo: { notes: [659.25, 523.25, 392], step: 0.06, decay: 0.15, volume: 0.12 },
  error: { notes: [146.83, 138.59], step: 0.07, decay: 0.13, volume: 0.14 },
  turn: { notes: [329.63, 440], step: 0.09, decay: 0.24, volume: 0.12 },
  score: { notes: [659.25, 880], step: 0.09, decay: 0.28, volume: 0.10 },
  region: { notes: [523.25, 659.25, 783.99], step: 0.12, decay: 0.36, volume: 0.12 },
  bonus: { notes: [783.99, 1046.50], step: 0.12, decay: 0.28, volume: 0.10 },
  phase: { notes: [392, 523.25, 659.25, 783.99], step: 0.14, decay: 0.42, volume: 0.12 },
  finish: { notes: [523.25, 659.25, 783.99, 1046.50], step: 0.19, decay: 0.65, volume: 0.14 },
} as const;
export type Sound = keyof typeof RECORDED_SOUNDS | keyof typeof TONES;
const SOUND_IMPORTANCE: Partial<Record<Sound, number>> = {
  select: 0, open: 0, close: 0,
  score: 2, region: 2, bonus: 2, phase: 2, finish: 3,
};
export interface SoundCue { sound: Sound; delay: number }
export interface ActionSoundTiming {
  /** Seconds after the action: the cinematic landing, or 0 for reduced motion. */
  diceDelay?: number;
  /** Seconds after the action for silver gains; defaults to the silver's arrival. */
  silverDelay?: number;
}

const BUILDING_SOUNDS: Record<Building, Sound> = {
  warehouse: "cargo", workshop: "build", church: "bell", market: "tile",
  boarding: "workers", bank: "coins", hall: "stamp", watchtower: "castle",
};
const ACTION_SOUNDS: Record<Exclude<ActionKind, "place">, Sound> = {
  "choose-estate": "castle",
  take: "tile", buy: "coins", trade: "tile", sell: "coins", workers: "workers",
  ship: "cargo", goods: "cargo", skip: "close", end: "turn",
};

export function soundForTile(tile: Tile): Sound {
  if (tile.color === "animal") return tile.animal ?? "tile";
  if (tile.color === "building") return tile.building ? BUILDING_SOUNDS[tile.building] : "build";
  return tile.color;
}

/** A successful operation and its rewards, never speculative engine/AI evaluation. */
export function soundsForAction(
  previous: State, action: Action, next: State,
  { diceDelay, silverDelay }: ActionSoundTiming = {},
): SoundCue[] {
  const before = previous.players[previous.active];
  const after = next.players[previous.active];
  const plan = motionForAction(previous, action, next);
  // main passes zero for reduced motion; use the same committed visual beats.
  const reduced = diceDelay === 0;
  const arrival = rewardLeadIn(plan, reduced) / 1000;
  const silverAt = silverDelay ?? (reduced ? 0 : arrival + MOTION.flight / 1000);
  const silverGained = next.players.some((player, index) => player.silver > previous.players[index].silver);
  const tile = action.kind === "place" ? after.board[action.cell!] : undefined;
  const primary = action.kind === "place" ? tile ? soundForTile(tile) : "tile" : ACTION_SOUNDS[action.kind];
  const cues: SoundCue[] = [{ sound: primary, delay: primary === "coins" && silverGained ? silverAt : arrival }];
  const add = (sound: Sound, delay = cues.length * 0.18) => {
    if (!cues.some(cue => cue.sound === sound)) cues.push({ sound, delay });
  };
  if (action.kind === "buy") add("tile");
  if (action.cost > 0) add("workers");
  // One payout cue for the whole transition, including final-phase mines on other estates.
  if (silverGained) add("coins", silverAt);
  if (next.status === "finished" && previous.status !== "finished") {
    add("finish", Math.max(cues.length * 0.18, silverGained ? silverAt + 0.18 : 0));
    return cues;
  }
  if (after.workers > before.workers) add("workers", Math.max(arrival, cues.length * 0.18));
  if (plan.regions.length) add("region", reduced ? cues.length * 0.18 : arrival + MOTION.rewardDelay / 1000);
  else if (after.score > before.score) add("score", Math.max(arrival, cues.length * 0.18));
  if (after.bonuses.length > before.bonuses.length ||
      (tile && next.pending.length > Math.max(0, previous.pending.length - 1))) add("bonus", Math.max(arrival, cues.length * 0.18));
  if (plan.roll) add("dice", diceDelay ?? (rollLeadIn(plan) + MOTION.diceLanding) / 1000);
  if (plan.phaseChanged) add("phase", !reduced && silverGained ? (MOTION.receipt + 200) / 1000 : 0);
  return cues;
}

/** Presentation only: never play sounds while rendering, loading, or searching moves. */
export class GameAudio {
  private context?: AudioContext;
  private output?: GainNode;
  private buffers = new Map<Sound, Promise<AudioBuffer | undefined>>();
  private voices = new Map<AudioBufferSourceNode, {
    sound: Sound; startTime: number; endTime: number; importance: number; gain: GainNode;
  }>();
  private resumed?: Promise<void>;
  private generation = 0;
  muted = false;

  constructor() {
    try { this.muted = localStorage.getItem(MUTE_KEY) === "true"; }
    catch { /* Sound preferences must not prevent play when storage is unavailable. */ }
  }

  /** Called from a real pointer/keyboard gesture to satisfy browser autoplay rules. */
  unlock(): void {
    if (this.muted) return;
    try {
      if (this.context?.state === "closed") {
        this.stop();
        this.output?.disconnect();
        this.context = undefined;
        this.output = undefined;
        this.resumed = undefined;
        this.buffers.clear();
      }
      if (!this.context) {
        this.context = new AudioContext();
        this.output = this.context.createGain();
        this.output.gain.value = 0.45;
        this.output.connect(this.context.destination);
        for (const sound of Object.keys(RECORDED_SOUNDS) as (keyof typeof RECORDED_SOUNDS)[])
          void this.load(sound);
      }
      // Safari can report "interrupted" after losing the audio device/focus.
      if (this.context.state !== "running" && !this.resumed) {
        const resumed = this.context.resume().catch(() => {}).finally(() => {
          if (this.resumed === resumed) this.resumed = undefined;
        });
        this.resumed = resumed;
      }
    } catch { /* Web Audio may be unavailable; the game remains fully playable. */ }
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    if (muted) this.stop();
    else this.unlock();
    try { localStorage.setItem(MUTE_KEY, String(muted)); }
    catch { /* Keep the preference for this session even if persistence is blocked. */ }
  }

  stop(): void {
    this.generation++;
    for (const voice of this.voices.keys()) this.stopVoice(voice);
  }

  private stopVoice(voice: AudioBufferSourceNode): void {
    const { gain, startTime, endTime } = this.voices.get(voice)!;
    this.voices.delete(voice);
    try {
      const now = this.context!.currentTime;
      if (this.context!.state === "running" && startTime <= now && now < endTime) {
        gain.gain.setValueAtTime(gain.gain.value, now);
        gain.gain.linearRampToValueAtTime(0, now + VOICE_RELEASE);
        voice.stop(now + VOICE_RELEASE);
        return; // Keep the gain connected until its release has finished.
      }
      voice.stop();
    } catch { /* A lost audio device must not prevent Undo or a new game. */ }
    voice.onended = null;
    try { voice.disconnect(); gain.disconnect(); }
    catch { /* The device may already have disposed its graph. */ }
  }

  playAction(previous: State, action: Action, next: State, timing: ActionSoundTiming = {}): void {
    // A new commit replaces pending visual beats, not already-audible foley tails.
    this.generation++;
    for (const [voice, { startTime }] of this.voices) {
      if (startTime > this.context!.currentTime) this.stopVoice(voice);
    }
    for (const cue of soundsForAction(previous, action, next, timing)) void this.play(cue.sound, cue.delay);
  }

  async play(sound: Sound, delay = 0): Promise<void> {
    const context = this.context;
    // Restored games and AI moves before the first gesture stay silent, not queued.
    if (this.muted || !context || document.hidden) return;
    const generation = this.generation;
    const startTime = context.currentTime + delay;
    const deadline = performance.now() + (delay + MAX_CUE_LATENESS) * 1000;
    const stale = () => context.currentTime - startTime > MAX_CUE_LATENESS || performance.now() > deadline;
    try {
      await this.resumed;
      if (this.muted || generation !== this.generation || document.hidden || context.state !== "running" || stale()) return;
      const buffer = await this.load(sound);
      if (!buffer || this.muted || generation !== this.generation || document.hidden || context.state !== "running" || stale()) return;
      const when = Math.max(context.currentTime, startTime);
      if ([...this.voices.values()].some(voice => voice.sound === sound && Math.abs(voice.startTime - when) < SAME_SOUND_INTERVAL)) return;
      // Short bonus/AI chains may overlap, but never build into a wall of sound.
      const endTime = when + buffer.duration;
      const importance = SOUND_IMPORTANCE[sound] ?? 1;
      const overlapping = [...this.voices].filter(([, voice]) => voice.startTime < endTime && when < voice.endTime);
      if (overlapping.length >= 6) {
        // A future cue must not cut feedback that is still playing now.
        // A long cue spanning separate full groups would require multiple cuts.
        if (when > context.currentTime || overlapping.length > 6) return;
        const [quietest, metadata] = overlapping.reduce((lowest, voice) => voice[1].importance < lowest[1].importance ? voice : lowest);
        if (metadata.importance > importance) return;
        this.stopVoice(quietest);
      }
      const voice = context.createBufferSource();
      const gain = context.createGain();
      if (sound === "tile") {
        // Keep frequent tile pickups soft, without a sharp initial transient.
        gain.gain.value = 0.4;
        gain.gain.setValueAtTime(0, when);
        gain.gain.linearRampToValueAtTime(0.4, when + 0.015);
      }
      voice.buffer = buffer;
      voice.connect(gain);
      gain.connect(this.output!);
      voice.onended = () => {
        voice.onended = null;
        voice.disconnect();
        gain.disconnect();
        this.voices.delete(voice);
      };
      // Decode/resume latency must not add another full motion delay.
      try { voice.start(when); }
      catch {
        voice.onended = null;
        voice.disconnect();
        gain.disconnect();
        return;
      }
      this.voices.set(voice, { sound, startTime: when, endTime, importance, gain });
    } catch { /* Missing files, blocked playback, and device errors cannot break a move. */ }
  }

  private load(sound: Sound): Promise<AudioBuffer | undefined> {
    const context = this.context!;
    let buffer = this.buffers.get(sound);
    if (!buffer) {
      if (!(sound in RECORDED_SOUNDS)) {
        buffer = Promise.resolve(this.tone(sound as keyof typeof TONES));
        this.buffers.set(sound, buffer);
        return buffer;
      }
      buffer = fetch(`${import.meta.env.BASE_URL}audio/${RECORDED_SOUNDS[sound as keyof typeof RECORDED_SOUNDS]}`)
        .then(response => {
          if (!response.ok) throw new Error("Sound unavailable");
          return response.arrayBuffer();
        })
        .then(bytes => context.decodeAudioData(bytes))
        .catch(() => {
          if (this.buffers.get(sound) === buffer) this.buffers.delete(sound);
          return undefined;
        });
      this.buffers.set(sound, buffer);
    }
    return buffer;
  }

  private tone(sound: keyof typeof TONES): AudioBuffer {
    const { notes, step, decay, volume } = TONES[sound];
    const rate = this.context!.sampleRate;
    const buffer = this.context!.createBuffer(1, Math.ceil(((notes.length - 1) * step + decay) * rate), rate);
    const samples = buffer.getChannelData(0);
    notes.forEach((frequency, note) => {
      const offset = Math.round(note * step * rate);
      for (let i = 0; i < decay * rate && offset + i < samples.length; i++) {
        const time = i / rate;
        const envelope = Math.min(time / 0.004, 1) * Math.exp(-6 * time / decay) * (1 - time / decay);
        const phase = 2 * Math.PI * frequency * time;
        samples[offset + i] += volume * envelope * (Math.sin(phase) + 0.2 * Math.sin(2 * phase));
      }
    });
    return buffer;
  }
}
