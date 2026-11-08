import * as THREE from "three";
import { createDie, disposeDie } from "./dice-mesh";
import { DICE_SEQUENCE, MOTION } from "./motion-timing";

export interface DiceRenderOptions {
  host: HTMLElement;
  values: number[];
  positions: { x: number; y: number }[];
  width: number;
  height: number;
  size: number;
  onLand?: () => void;
  onComplete?: () => void;
  onUnavailable?: () => void;
}
const clamp = (x: number) => Math.max(0, Math.min(1, x));
const smooth = (x: number) => { const t = clamp(x); return t * t * (3 - 2 * t); };
const faceNormal = (die: THREE.Group, value: number) => {
  const face = die.children.find(child => child.userData.value === value);
  return new THREE.Vector3(...(face?.userData.normal ?? [0, 0, 1]) as [number, number, number]);
};

/** One reusable GPU context. Meshes and shaders are warmed before the first roll. */
export class DiceRenderer {
  renderer?: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.OrthographicCamera(-1, 1, 1, -1, .1, 6000);
  readonly dice: THREE.Group[] = [];
  private shadows: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>[] = [];
  private shadowTexture?: THREE.CanvasTexture;
  private frame?: number;
  private started = 0;
  private options?: DiceRenderOptions;
  private bases: THREE.Quaternion[] = [];
  private rotation = new THREE.Quaternion();
  private euler = new THREE.Euler();
  private phase = "idle";
  private landed = false;
  private revision = 0;
  private unavailable = false;
  private lost = (event: Event) => {
    event.preventDefault();
    const fallback = this.options?.onUnavailable;
    this.stop();
    fallback?.();
  };

  prepare(): boolean {
    if (this.unavailable) return false;
    if (this.renderer) return !this.renderer.getContext().isContextLost();
    try {
      this.renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true, powerPreference: "high-performance" });
      this.renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 1.5));
      this.renderer.setSize(32, 32);
      this.renderer.setClearColor(0, 0);
      this.renderer.outputColorSpace = THREE.SRGBColorSpace;
      this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
      this.renderer.toneMappingExposure = 1.1;
      const canvas = this.renderer.domElement;
      canvas.className = "dice-webgl";
      canvas.dataset.renderer = "three";
      canvas.dataset.state = "idle";
      canvas.setAttribute("aria-hidden", "true");
      canvas.addEventListener("webglcontextlost", this.lost);
      this.camera.position.set(0, 0, 2200);
      this.scene.add(new THREE.HemisphereLight(0xfff4df, 0x29463b, 2.5));
      const key = new THREE.DirectionalLight(0xffebcb, 3.2);
      key.position.set(-3, 5, 7);
      this.scene.add(key);
      const fill = new THREE.DirectionalLight(0xc8e4e1, 1.4);
      fill.position.set(4, 1, 3);
      this.scene.add(fill);
      // Baked soft contact shadow: no shadow-map render or postprocessing pass.
      const texture = document.createElement("canvas");
      texture.width = texture.height = 64;
      const ctx = texture.getContext("2d")!;
      const gradient = ctx.createRadialGradient(32, 32, 2, 32, 32, 31);
      gradient.addColorStop(0, "rgba(2,12,9,0.72)");
      gradient.addColorStop(.4, "rgba(2,12,9,0.36)");
      gradient.addColorStop(1, "rgba(2,12,9,0)");
      ctx.fillStyle = gradient;
      ctx.fillRect(0, 0, 64, 64);
      this.shadowTexture = new THREE.CanvasTexture(texture);
      this.prepareDice(5);
      this.renderer.compile(this.scene, this.camera);
      this.renderer.render(this.scene, this.camera);
      this.dice.forEach(die => { die.visible = false; });
      this.shadows.forEach(shadow => { shadow.visible = false; });
      return true;
    } catch {
      this.dispose();
      this.unavailable = true;
      return false;
    }
  }

  private prepareDice(count: number): void {
    if (this.dice.length === count) return;
    this.dice.forEach(disposeDie);
    this.dice.length = 0;
    this.bases = [];
    for (const shadow of this.shadows) { shadow.geometry.dispose(); shadow.material.dispose(); shadow.removeFromParent(); }
    this.shadows = [];
    const colors = [0x622d42, 0x174a46, 0x81551d, 0x354a78];
    for (let index = 0; index < count; index++) {
      const white = index === count - 1;
      const die = createDie(1, white ? 0x353c36 : colors[Math.floor(index / 2)], white ? 0xffffff : 0xf3e5c8);
      this.dice.push(die);
      this.bases.push(new THREE.Quaternion());
      this.scene.add(die);
      const shadow = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ map: this.shadowTexture, transparent: true, depthWrite: false, toneMapped: false }));
      shadow.position.z = -150;
      this.shadows.push(shadow);
      this.scene.add(shadow);
    }
  }

  play(options: DiceRenderOptions): void {
    this.stop();
    if (!this.prepare()) { options.onUnavailable?.(); return; }
    this.prepareDice(options.values.length);
    this.options = options;
    this.phase = "idle";
    this.landed = false;
    this.camera.left = -options.width / 2;
    this.camera.right = options.width / 2;
    this.camera.top = options.height / 2;
    this.camera.bottom = -options.height / 2;
    this.camera.updateProjectionMatrix();
    this.renderer!.setSize(options.width, options.height);
    const canvas = this.renderer!.domElement;
    canvas.dataset.motion = "dice-toss";
    canvas.style.opacity = "1";
    options.host.append(canvas);
    for (const [index, die] of this.dice.entries()) {
      die.visible = true;
      die.userData.value = options.values[index];
      this.bases[index].setFromUnitVectors(faceNormal(die, options.values[index]), new THREE.Vector3(0, 0, 1));
      this.shadows[index].visible = true;
    }
    this.started = performance.now();
    this.render(0);
    this.frame = requestAnimationFrame(this.tick);
  }

  private tick = (now: number) => {
    this.frame = undefined;
    const options = this.options;
    if (!options) return;
    if (document.hidden || !options.host.isConnected) { this.stop(); options.onComplete?.(); return; }
    const revision = this.revision;
    const elapsed = Math.min(DICE_SEQUENCE, now - this.started);
    this.render(elapsed);
    // Landing callbacks may cancel or start another roll, even with the same options.
    if (revision !== this.revision) return;
    if (elapsed === DICE_SEQUENCE) {
      const complete = options.onComplete;
      this.stop();
      complete?.();
    } else this.frame = requestAnimationFrame(this.tick);
  };

  /** Absolute-time sampling stays smooth at 60/120Hz and after a dropped frame. */
  render(elapsed: number): void {
    const options = this.options;
    if (!options || !this.renderer) return;
    const revision = this.revision;
    const { width, height, size } = options;
    const settledAt = MOTION.diceRoll;
    const returnAt = settledAt + MOTION.diceHold;
    const phase = elapsed < settledAt ? "rolling" : elapsed < returnAt ? "settled" : "returning";
    const staticHold = phase === "settled" && this.phase === phase;
    if (phase !== this.phase) {
      this.phase = phase;
      this.renderer.domElement.dataset.state = phase;
    }
    // A dropped frame can cross the entire hold; landing still happens once.
    if (!this.landed && elapsed >= settledAt) {
      this.landed = true;
      options.onLand?.();
      if (revision !== this.revision) return;
    }
    // Keep the clock running for cleanup/fade, but do not redraw identical poses.
    if (staticHold) return;
    this.renderer.domElement.style.opacity = String(elapsed < returnAt ? 1 : 1 - clamp((elapsed - returnAt) / MOTION.diceReturn));
    for (const [index, die] of this.dice.entries()) {
      const direction = index % 2 === 0 ? -1 : 1;
      // Every player and the white die share this clock. No per-player stagger.
      const progress = clamp(elapsed / MOTION.diceRoll);
      const { x: groundX, y: groundY } = options.positions[index];
      const startX = direction < 0 ? size * 1.1 : width - size * 1.1;
      const x = groundX + (startX - groundX) * (1 - smooth(progress));
      const y = groundY + direction * size * .65 * (1 - smooth(progress));
      const rise = progress < .79 ? Math.sin(progress / .79 * Math.PI) * size * .6
        : Math.sin((progress - .79) / .21 * Math.PI) * size * .09;
      const turn = (1 - smooth(progress)) * Math.PI * 4;
      // The orthographic camera looks straight down at the board's XY plane.
      // Tumbling ends flat on the saved result, with only a small in-plane twist.
      this.rotation.setFromEuler(this.euler.set(turn, direction * turn * .77, direction * (.09 + turn * .12)));
      die.position.set(x - width / 2, height / 2 - y, rise);
      die.scale.setScalar(size);
      die.quaternion.copy(this.rotation).multiply(this.bases[index]);
      const shadow = this.shadows[index];
      shadow.position.set(x - width / 2 + size * .08, height / 2 - y - size * .12, -150);
      shadow.scale.setScalar(size * (1.6 + rise / size * .35));
      shadow.material.opacity = .8 - rise / size * .4;
    }
    this.renderer.render(this.scene, this.camera);
  }

  stop(): void {
    this.revision++;
    if (this.frame !== undefined) cancelAnimationFrame(this.frame);
    this.frame = undefined;
    this.options = undefined;
    this.dice.forEach(die => { die.visible = false; });
    this.shadows.forEach(shadow => { shadow.visible = false; });
    if (this.renderer) {
      this.renderer.domElement.remove();
      this.renderer.domElement.dataset.state = "idle";
      delete this.renderer.domElement.dataset.motion;
    }
  }

  dispose(): void {
    this.stop();
    this.dice.forEach(disposeDie);
    this.dice.length = 0;
    for (const shadow of this.shadows) { shadow.geometry.dispose(); shadow.material.dispose(); }
    this.shadows = [];
    this.shadowTexture?.dispose();
    this.shadowTexture = undefined;
    this.scene.clear();
    if (this.renderer) {
      this.renderer.domElement.removeEventListener("webglcontextlost", this.lost);
      this.renderer.dispose();
      this.renderer.forceContextLoss();
      this.renderer = undefined;
    }
  }
}
