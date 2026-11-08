import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as THREE from "three";
import { DiceRenderer, type DiceRenderOptions } from "../src/dice-renderer";
import { DICE_SEQUENCE, MOTION } from "../src/motion-timing";

// Keep real meshes, materials, resource disposal, and quaternion math. Only the
// browser/GPU boundary is mocked; these tests do not measure physical GPU work.
vi.mock("three", async importOriginal => {
  const actual = await importOriginal<typeof import("three")>();
  return {
    ...actual,
    WebGLRenderer: vi.fn(class {
      domElement = document.createElement("canvas");
      private context = { isContextLost: vi.fn(() => false) };
      getContext = vi.fn(() => this.context);
      setPixelRatio = vi.fn();
      setSize = vi.fn((width: number, height: number) => {
        this.domElement.width = width;
        this.domElement.height = height;
      });
      setClearColor = vi.fn();
      compile = vi.fn();
      render = vi.fn();
      dispose = vi.fn();
      forceContextLoss = vi.fn();
    }),
  };
});

class TestHost {
  isConnected = true;
  children: TestCanvas[] = [];
  append(canvas: TestCanvas): void {
    canvas.remove();
    canvas.parentElement = this;
    this.children.push(canvas);
  }
  remove(): void { this.isConnected = false; }
}

class TestCanvas extends EventTarget {
  className = "";
  dataset: Record<string, string> = {};
  style = { opacity: "" };
  width = 0;
  height = 0;
  parentElement: TestHost | null = null;
  private attributes = new Map<string, string>();
  get isConnected(): boolean { return this.parentElement?.isConnected ?? false; }
  setAttribute(name: string, value: string): void { this.attributes.set(name, value); }
  getAttribute(name: string): string | null { return this.attributes.get(name) ?? null; }
  getContext = vi.fn(() => ({
    createRadialGradient: vi.fn(() => ({ addColorStop: vi.fn() })),
    fillStyle: "",
    fillRect: vi.fn(),
  }));
  remove(): void {
    if (this.parentElement) {
      this.parentElement.children = this.parentElement.children.filter(child => child !== this);
      this.parentElement = null;
    }
  }
}

let subject: DiceRenderer;
let clock: number;
let frames: Map<number, FrameRequestCallback>;
let page: { hidden: boolean };
const returnAt = MOTION.diceRoll + MOTION.diceHold;

beforeEach(() => {
  vi.clearAllMocks();
  clock = 10_000;
  frames = new Map();
  page = { hidden: false };
  let frameId = 0;
  vi.stubGlobal("devicePixelRatio", 2);
  vi.stubGlobal("document", {
    get hidden() { return page.hidden; },
    createElement: vi.fn(() => new TestCanvas()),
  });
  vi.stubGlobal("performance", { now: () => clock });
  vi.stubGlobal("requestAnimationFrame", vi.fn((callback: FrameRequestCallback) => {
    frames.set(++frameId, callback);
    return frameId;
  }));
  vi.stubGlobal("cancelAnimationFrame", vi.fn((id: number) => { frames.delete(id); }));
  subject = new DiceRenderer();
});

afterEach(() => {
  subject.dispose();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function roll(count = 5, overrides: Partial<DiceRenderOptions> = {}): DiceRenderOptions {
  return {
    host: new TestHost() as unknown as HTMLElement,
    values: Array.from({ length: count }, (_, index) => index % 6 + 1),
    positions: Array.from({ length: count }, (_, index) => ({ x: 100 + index % 3 * 140, y: 100 + Math.floor(index / 3) * 80 })),
    width: 600, height: 450, size: 36,
    onLand: vi.fn(), onComplete: vi.fn(), onUnavailable: vi.fn(),
    ...overrides,
  };
}

function frameAt(now: number): void {
  clock = now;
  const pending = [...frames.values()];
  frames.clear();
  for (const callback of pending) callback(now);
}

function shadows(): THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>[] {
  return subject.scene.children.filter((child): child is THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial> => child instanceof THREE.Mesh);
}

function pose() {
  return {
    dice: subject.dice.map(die => ({
      value: die.userData.value, position: die.position.toArray(),
      quaternion: die.quaternion.toArray(), scale: die.scale.toArray(), visible: die.visible,
    })),
    shadows: shadows().map(shadow => ({ position: shadow.position.toArray(), scale: shadow.scale.toArray(), opacity: shadow.material.opacity })),
    state: subject.renderer?.domElement.dataset.state,
    opacity: subject.renderer?.domElement.style.opacity,
  };
}

function watchResources() {
  const resources = new Set<THREE.BufferGeometry | THREE.Material>();
  subject.scene.traverse(object => {
    if (!(object instanceof THREE.Mesh)) return;
    resources.add(object.geometry);
    for (const material of Array.isArray(object.material) ? object.material : [object.material]) resources.add(material);
  });
  return [...resources].map(resource => vi.spyOn(resource, "dispose"));
}

describe("dice landing and callback ownership", () => {
  it.each([returnAt, DICE_SEQUENCE])("lands once before completion when a frame skips to %i ms", elapsed => {
    const callbacks: string[] = [];
    const options = roll(5, {
      onLand: vi.fn(() => { callbacks.push("land"); }),
      onComplete: vi.fn(() => { callbacks.push("complete"); }),
    });
    const start = clock;
    subject.play(options);
    frameAt(start + elapsed);
    expect(options.onLand).toHaveBeenCalledOnce();
    frameAt(start + DICE_SEQUENCE);
    expect(callbacks).toEqual(["land", "complete"]);
    expect(frames.size).toBe(0);
  });

  describe.each(["stop", "dispose"] as const)("%s inside onLand", cancel => {
    it.each([MOTION.diceRoll, DICE_SEQUENCE])("does not draw, complete, or schedule the canceled roll at %i ms", elapsed => {
      const options = roll(5, { onLand: vi.fn(() => { subject[cancel](); }) });
      const start = clock;
      subject.play(options);
      const gpu = subject.renderer!;
      vi.mocked(gpu.render).mockClear();
      expect(() => frameAt(start + elapsed)).not.toThrow();
      expect(options.onLand).toHaveBeenCalledOnce();
      expect(options.onComplete).not.toHaveBeenCalled();
      expect(gpu.render).not.toHaveBeenCalled();
      expect(frames.size).toBe(0);
      expect(gpu.domElement.parentElement).toBeNull();
      expect(gpu.domElement.dataset.state).toBe("idle");
    });
  });

  it.each([MOTION.diceRoll, DICE_SEQUENCE])("leaves a replacement roll in sole control when onLand runs at %i ms", elapsed => {
    const next = roll(7, { values: [6, 5, 4, 3, 2, 1, 6], width: 700, height: 480, size: 44 });
    const previous = roll(5, { onLand: vi.fn(() => { subject.play(next); }) });
    const start = clock;
    subject.play(previous);
    expect(() => frameAt(start + elapsed)).not.toThrow();
    expect(previous.onLand).toHaveBeenCalledOnce();
    expect(previous.onComplete).not.toHaveBeenCalled();
    expect(frames.size).toBe(1);
    expect(subject.dice.map(die => die.userData.value)).toEqual(next.values);
    expect(subject.renderer!.domElement.parentElement).toBe(next.host);
    expect(subject.renderer!.domElement.dataset.state).toBe("rolling");
    expect(subject.renderer!.domElement.style.opacity).toBe("1");
    expect(subject.dice[0].position.x).toBeCloseTo(next.size * 1.1 - next.width / 2);
    expect(subject.dice[0].position.y).toBeCloseTo(next.height / 2 - next.positions[0].y + next.size * .65);
    frameAt(clock + DICE_SEQUENCE);
    expect(next.onLand).toHaveBeenCalledOnce();
    expect(next.onComplete).toHaveBeenCalledOnce();
    expect(previous.onComplete).not.toHaveBeenCalled();
    expect(frames.size).toBe(0);
  });

  it("recognizes a replacement even when onLand replays the same options object", () => {
    const options = roll();
    options.onLand = vi.fn().mockImplementationOnce(() => { subject.play(options); });
    subject.play(options);
    frameAt(clock + MOTION.diceRoll);
    expect(frames.size).toBe(1);
    expect(subject.renderer!.domElement.dataset.state).toBe("rolling");
    expect(subject.dice[0].position.x).toBeCloseTo(options.size * 1.1 - options.width / 2);
    expect(options.onComplete).not.toHaveBeenCalled();
    frameAt(clock + DICE_SEQUENCE);
    expect(options.onLand).toHaveBeenCalledTimes(2);
    expect(options.onComplete).toHaveBeenCalledOnce();
    expect(frames.size).toBe(0);
  });
});

describe("dice renderer lifecycle", () => {
  it("cancels and detaches before a context-loss fallback, without replaying callbacks", () => {
    const options = roll();
    subject.play(options);
    const gpu = subject.renderer!;
    options.onUnavailable = vi.fn(() => {
      expect(frames.size).toBe(0);
      expect(gpu.domElement.parentElement).toBeNull();
      expect(subject.dice.every(die => !die.visible)).toBe(true);
      expect(shadows().every(shadow => !shadow.visible)).toBe(true);
    });
    const lost = new Event("webglcontextlost", { cancelable: true });
    vi.mocked(gpu.getContext().isContextLost).mockReturnValue(true);
    gpu.domElement.dispatchEvent(lost);
    expect(lost.defaultPrevented).toBe(true);
    expect(cancelAnimationFrame).toHaveBeenCalledOnce();
    expect(options.onUnavailable).toHaveBeenCalledOnce();
    gpu.domElement.dispatchEvent(new Event("webglcontextlost", { cancelable: true }));
    expect(options.onUnavailable).toHaveBeenCalledOnce();
    expect(options.onLand).not.toHaveBeenCalled();
    expect(options.onComplete).not.toHaveBeenCalled();
    subject.dispose();
    const afterDispose = new Event("webglcontextlost", { cancelable: true });
    gpu.domElement.dispatchEvent(afterDispose);
    expect(afterDispose.defaultPrevented).toBe(false);
    expect(gpu.dispose).toHaveBeenCalledOnce();
    expect(gpu.forceContextLoss).toHaveBeenCalledOnce();
  });

  it("waits out context loss and reuses the scene after Three restores its context", () => {
    const previous = roll();
    subject.play(previous);
    const gpu = subject.renderer!;
    const scene = [...subject.scene.children];
    const texture = shadows()[0].material.map;
    const isLost = vi.mocked(gpu.getContext().isContextLost);
    isLost.mockReturnValue(true);
    gpu.domElement.dispatchEvent(new Event("webglcontextlost", { cancelable: true }));
    expect(subject.prepare()).toBe(false);
    const unavailable = roll();
    subject.play(unavailable);
    expect(unavailable.onUnavailable).toHaveBeenCalledOnce();
    expect(frames.size).toBe(0);
    // Three.WebGLRenderer owns the actual GL rebuild. Simulate its recovered
    // context here, rather than pretend a Node test restored physical GPU state.
    isLost.mockReturnValue(false);
    gpu.domElement.dispatchEvent(new Event("webglcontextrestored"));
    expect(subject.prepare()).toBe(true);
    expect(subject.renderer).toBe(gpu);
    expect(subject.scene.children).toEqual(scene);
    expect(shadows()[0].material.map).toBe(texture);
    const recovered = roll(5, { values: [6, 5, 4, 3, 2] });
    subject.play(recovered);
    frameAt(clock + MOTION.diceRoll);
    expect(recovered.onLand).toHaveBeenCalledOnce();
    expect(recovered.onUnavailable).not.toHaveBeenCalled();
    expect(subject.dice.map(die => die.userData.value)).toEqual(recovered.values);
    expect(THREE.WebGLRenderer).toHaveBeenCalledOnce();
    expect(gpu.dispose).not.toHaveBeenCalled();
  });

  it("repeated prepare reuses warm resources and dispose/reprepare does not accumulate them", () => {
    expect(subject.prepare()).toBe(true);
    const gpu = subject.renderer!;
    const scene = [...subject.scene.children];
    const resources = watchResources();
    const texture = shadows()[0].material.map!;
    const disposeTexture = vi.spyOn(texture, "dispose");
    for (let index = 0; index < 3; index++) expect(subject.prepare()).toBe(true);
    expect(subject.scene.children).toEqual(scene);
    expect(scene).toHaveLength(13); // Three lights, five dice, five shadows.
    expect(THREE.WebGLRenderer).toHaveBeenCalledOnce();
    expect(document.createElement).toHaveBeenCalledTimes(2);
    expect(gpu.compile).toHaveBeenCalledOnce();
    expect(gpu.render).toHaveBeenCalledOnce();
    for (const dispose of resources) expect(dispose).not.toHaveBeenCalled();
    subject.dispose();
    subject.dispose();
    for (const dispose of resources) expect(dispose).toHaveBeenCalledOnce();
    expect(disposeTexture).toHaveBeenCalledOnce();
    expect(gpu.dispose).toHaveBeenCalledOnce();
    expect(gpu.forceContextLoss).toHaveBeenCalledOnce();
    expect(subject.scene.children).toHaveLength(0);
    expect(subject.prepare()).toBe(true);
    expect(THREE.WebGLRenderer).toHaveBeenCalledTimes(2);
    expect(subject.scene.children).toHaveLength(13);
    expect(shadows()[0].material.map).not.toBe(texture);
  });

  it("releases replaced 5/7/9-die resources once while retaining the shared shadow texture", () => {
    subject.prepare();
    const texture = shadows()[0].material.map!;
    const disposeTexture = vi.spyOn(texture, "dispose");
    for (const count of [7, 9, 5]) {
      const dice = [...subject.dice];
      const resources = watchResources();
      subject.play(roll(count));
      for (const dispose of resources) expect(dispose).toHaveBeenCalledOnce();
      expect(dice.every(die => die.parent === null && die.children.length === 0)).toBe(true);
      expect(subject.scene.children).toHaveLength(3 + count * 2);
      expect(shadows().every(shadow => shadow.material.map === texture)).toBe(true);
      expect(disposeTexture).not.toHaveBeenCalled();
      expect(frames.size).toBe(1);
    }
    const resources = watchResources();
    subject.dispose();
    for (const dispose of resources) expect(dispose).toHaveBeenCalledOnce();
    expect(disposeTexture).toHaveBeenCalledOnce();
    expect(frames.size).toBe(0);
    expect(THREE.WebGLRenderer).toHaveBeenCalledOnce();
  });

  it.each(["stop", "dispose"] as const)("%s cancels a queued frame and ignores a stale callback without completion", cancel => {
    const options = roll();
    subject.play(options);
    const gpu = subject.renderer!;
    const [id, stale] = [...frames.entries()][0];
    vi.mocked(gpu.render).mockClear();
    subject[cancel]();
    subject[cancel]();
    expect(cancelAnimationFrame).toHaveBeenCalledExactlyOnceWith(id);
    expect(frames.size).toBe(0);
    stale(clock + DICE_SEQUENCE);
    subject.render(MOTION.diceRoll);
    expect(gpu.render).not.toHaveBeenCalled();
    expect(requestAnimationFrame).toHaveBeenCalledOnce();
    expect(options.onLand).not.toHaveBeenCalled();
    expect(options.onComplete).not.toHaveBeenCalled();
    expect(options.onUnavailable).not.toHaveBeenCalled();
  });

  it.each(["hidden", "detached"] as const)("finishes owner cleanup when the document/host becomes %s", reason => {
    const options = roll();
    const host = options.host as unknown as TestHost;
    options.onComplete = vi.fn(() => { host.remove(); });
    subject.play(options);
    const gpu = subject.renderer!;
    vi.mocked(gpu.render).mockClear();
    if (reason === "hidden") page.hidden = true;
    else host.remove();
    frameAt(clock + 16);
    expect(options.onComplete).toHaveBeenCalledOnce();
    expect(host.isConnected).toBe(false);
    expect(gpu.domElement.parentElement).toBeNull();
    expect(gpu.render).not.toHaveBeenCalled();
    expect(options.onLand).not.toHaveBeenCalled();
    expect(options.onUnavailable).not.toHaveBeenCalled();
    expect(frames.size).toBe(0);
    frameAt(clock + DICE_SEQUENCE);
    expect(options.onComplete).toHaveBeenCalledOnce();
  });
});

describe("absolute-time presentation", () => {
  it.each([5, 7, 9])("keeps %i saved faces and simultaneous poses identical at sparse/60/120 Hz", count => {
    const options = roll(count);
    const saved = [...options.values];
    Object.freeze(options.values);
    options.positions.forEach(Object.freeze);
    Object.freeze(options.positions);
    const target = MOTION.diceRoll * .8;
    const sample = (step: number) => {
      subject.play(options);
      const start = clock;
      expect(subject.dice.every(die => die.visible && die.position.z === 0)).toBe(true);
      for (let elapsed = step; elapsed < target; elapsed += step) frameAt(start + elapsed);
      frameAt(start + target);
      return pose();
    };
    const sparse = sample(Infinity);
    expect(sparse.dice.every(die => die.position[2] > 0 && die.position[2] === sparse.dice[0].position[2])).toBe(true);
    expect(sample(1000 / 60)).toEqual(sparse);
    expect(sample(1000 / 120)).toEqual(sparse);
    frameAt(clock + MOTION.diceRoll - target);
    expect(options.onLand).toHaveBeenCalledOnce();
    for (const [index, die] of subject.dice.entries()) {
      const face = die.children.find(child => child.userData.value === saved[index])!;
      const normal = new THREE.Vector3(...face.userData.normal as [number, number, number]).applyQuaternion(die.quaternion);
      expect(normal.distanceTo(new THREE.Vector3(0, 0, 1))).toBeLessThan(1e-12);
      expect(die.position.x).toBe(options.positions[index].x - options.width / 2);
      expect(die.position.y).toBe(options.height / 2 - options.positions[index].y);
      expect(die.position.z).toBeCloseTo(0, 12);
      expect(die.userData.value).toBe(saved[index]);
    }
    expect(options.values).toEqual(saved);
    expect(frames.size).toBe(1);
  });

  it("keeps the board-local transparent render identity and bounded pixel ratio", () => {
    const options = roll();
    subject.play(options);
    const gpu = subject.renderer!;
    expect(THREE.WebGLRenderer).toHaveBeenCalledExactlyOnceWith({ alpha: true, antialias: true, powerPreference: "high-performance" });
    expect(gpu.setPixelRatio).toHaveBeenCalledWith(1.5);
    expect(gpu.setClearColor).toHaveBeenCalledWith(0, 0);
    expect(gpu.setSize).toHaveBeenLastCalledWith(options.width, options.height);
    expect(subject.scene.background).toBeNull();
    expect(gpu.domElement.parentElement).toBe(options.host);
    expect(gpu.domElement.className).toBe("dice-webgl");
    expect(gpu.domElement.getAttribute("aria-hidden")).toBe("true");
    expect(gpu.domElement.dataset.renderer).toBe("three");
    expect(subject.camera.left).toBe(-options.width / 2);
    expect(subject.camera.top).toBe(options.height / 2);
    expect(gpu.outputColorSpace).toBe(THREE.SRGBColorSpace);
    expect(gpu.toneMapping).toBe(THREE.ACESFilmicToneMapping);
    expect(gpu.toneMappingExposure).toBe(1.1);
    expect(shadows().every(shadow => shadow.material.transparent && !shadow.material.depthWrite && !shadow.material.toneMapped)).toBe(true);
  });

  it("draws a static hold once, while retaining its duration, fade, and completion", () => {
    const options = roll();
    const start = clock;
    subject.play(options);
    const gpu = subject.renderer!;
    vi.mocked(gpu.render).mockClear();
    frameAt(start + MOTION.diceRoll);
    const settled = pose();
    for (const elapsed of [MOTION.diceRoll + 16, MOTION.diceRoll + 300, returnAt - 1]) {
      frameAt(start + elapsed);
      expect(pose()).toEqual(settled);
      expect(frames.size).toBe(1);
    }
    expect(gpu.render).toHaveBeenCalledOnce();
    expect(options.onLand).toHaveBeenCalledOnce();
    expect(options.onComplete).not.toHaveBeenCalled();
    frameAt(start + returnAt);
    expect(gpu.domElement.dataset.state).toBe("returning");
    expect(gpu.domElement.style.opacity).toBe("1");
    frameAt(start + returnAt + MOTION.diceReturn / 2);
    expect(gpu.domElement.style.opacity).toBe("0.5");
    frameAt(start + DICE_SEQUENCE);
    expect(options.onLand).toHaveBeenCalledOnce();
    expect(options.onComplete).toHaveBeenCalledOnce();
    expect(gpu.domElement.style.opacity).toBe("0");
    expect(frames.size).toBe(0);
  });
});
