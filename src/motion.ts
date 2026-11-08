import { iconSvg, goodsIcon, resourceIcon } from "./illustrations";
import { tileName } from "./data";
import { turnOrder } from "./engine";
import type { BoardView } from "./board-view";
import { finalScoringSteps, type MotionPlan } from "./motion-events";
import { MOTION, rewardLeadIn, rollLeadIn } from "./motion-timing";
import type { DiceRenderer } from "./dice-renderer";
import type { Action, State, Tile } from "./types";
import "./motion.css";

type Bounds = { x: number; y: number; width: number; height: number };
export interface MotionOrigin {
  tile?: Bounds;
  goods: Map<string, Bounds>;
  workers?: Bounds;
  phase?: Bounds;
  die?: number;
  scrollX: number;
  scrollY: number;
}
const query = (selector: string) => document.querySelector<HTMLElement>(selector);
const center = (rect: Bounds) => ({ x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 });
const withinView = (rect?: Bounds): rect is Bounds => Boolean(rect && rect.width > 0 && rect.height > 0 &&
  rect.x < innerWidth && rect.y < innerHeight && rect.x + rect.width > 0 && rect.y + rect.height > 0);
function bounds(element: Element | null | undefined): Bounds | undefined {
  if (!element || !element.getClientRects().length) return;
  const rect = element.getBoundingClientRect();
  return withinView(rect) ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : undefined;
}

/** A disposable projection of committed moves. Never owns state, delays input, or rolls dice. */
export class GameMotion {
  private layer = document.createElement("div");
  private preference = matchMedia("(prefers-reduced-motion: reduce)");
  private animations = new Set<Animation>();
  private cleanups = new Map<HTMLElement, () => void>();
  private timers = new Set<ReturnType<typeof setTimeout>>();
  private harborVisibility = new Map<HTMLElement, boolean>();
  private harborObserver: IntersectionObserver;
  private frame?: number;
  private diceRenderer?: DiceRenderer;
  private diceLoading?: Promise<DiceRenderer>;
  private diceStage?: HTMLElement;
  private paintedScroll?: { x: number; y: number };
  private revision = 0;
  private finishFinalScoring?: () => void;

  constructor(private board: BoardView) {
    this.layer.id = "motion-layer";
    this.layer.setAttribute("aria-hidden", "true");
    document.body.append(this.layer);
    this.harborObserver = new IntersectionObserver(entries => {
      for (const entry of entries) this.harborVisibility.set(entry.target as HTMLElement, entry.isIntersecting);
      this.syncHarbor();
    });
    this.observeHarbor(query(".masthead-scene"));
    this.preference.addEventListener("change", () => { this.cancel(); this.syncHarbor(); if (!this.reduced) void this.prepareDice().catch(() => {}); });
    document.addEventListener("visibilitychange", () => this.syncHarbor());
    document.addEventListener("close", event => {
      if (event.target instanceof HTMLDialogElement && !event.target.open &&
          (this.layer.parentElement === event.target || this.finishFinalScoring)) this.cancel();
    }, true);
    window.addEventListener("resize", () => this.cancel());
    window.addEventListener("scroll", () => {
      // Automatic phone-panel scrolling happens before a queued move is painted.
      if (this.frame === undefined && !this.rolling &&
          (!this.paintedScroll || scrollX !== this.paintedScroll.x || scrollY !== this.paintedScroll.y)) this.cancel();
    }, { passive: true });
    // Fetch/compile the separately bundled 3D renderer before the first toss,
    // without making startup or the 2D board wait for it.
    const warm = () => { if (!this.reduced && !document.hidden) void this.prepareDice().catch(() => {}); };
    if ("requestIdleCallback" in window) window.requestIdleCallback(warm, { timeout: 1500 });
    else setTimeout(warm, 300);
    window.addEventListener("pagehide", () => { this.diceRenderer?.dispose(); });
  }

  get reduced(): boolean { return this.preference.matches; }
  get rolling(): boolean { return Boolean(this.diceStage?.isConnected); }
  get reading(): boolean { return this.frame !== undefined || this.rolling || Boolean(this.layer.querySelector(".motion-receipt")); }

  private prepareDice(): Promise<DiceRenderer> {
    this.diceLoading ??= import("./dice-renderer").then(({ DiceRenderer }) => {
      this.diceRenderer = new DiceRenderer();
      if (!this.reduced && !document.hidden) this.diceRenderer.prepare();
      return this.diceRenderer;
    }).catch(error => { this.diceLoading = undefined; throw error; });
    return this.diceLoading;
  }

  observeHarbor(element: HTMLElement | null): void {
    for (const node of this.harborVisibility.keys()) {
      if (!node.isConnected) { this.harborObserver.unobserve(node); this.harborVisibility.delete(node); }
    }
    if (element && !this.harborVisibility.has(element)) {
      this.harborVisibility.set(element, false);
      this.harborObserver.observe(element);
    }
  }

  private syncHarbor(): void {
    for (const [element, visible] of this.harborVisibility) {
      element.dataset.ambient = visible && !document.hidden && !this.reduced ? "running" : "paused";
    }
  }

  capture(plan: MotionPlan, action: Action, viewedPlayer: number): MotionOrigin {
    const tile = plan.tile;
    const source = tile?.from === "reserve" && plan.actor !== viewedPlayer ? undefined
      : tile ? bounds(query(`[data-tile="${CSS.escape(tile.tile.id)}"] .tile-art`) ?? query(`[data-tile="${CSS.escape(tile.tile.id)}"]`)) : undefined;
    const goods = new Map<string, Bounds>();
    for (const item of plan.goods) {
      const manifest = (document.activeElement as HTMLElement | null)?.closest(".harbor-card")
        ?.querySelector(`.cargo-manifest .type-${item.type}`);
      for (const depot of item.depots) {
        const rect = bounds(manifest) ?? bounds(query(`[data-depot="${depot}"] .depot-goods .type-${item.type}`));
        if (rect) goods.set(`${depot}:${item.type}`, rect);
      }
      const stored = item.player === viewedPlayer ? bounds(query(`[data-good="${item.type}"]`)) : undefined;
      if (stored) goods.set(`stored:${item.type}`, stored);
    }
    return { tile: source, goods, workers: bounds(query('[data-mode="workers"]')),
      phase: bounds(query('.phase-track [aria-current="step"]')), die: action.die, scrollX, scrollY };
  }

  cancel(): void {
    this.finishFinalScoring?.();
    this.finishFinalScoring = undefined;
    this.revision++;
    this.diceRenderer?.stop();
    this.diceStage?.remove();
    this.diceStage = undefined;
    if (this.frame !== undefined) cancelAnimationFrame(this.frame);
    this.frame = undefined;
    this.paintedScroll = undefined;
    for (const animation of this.animations) animation.cancel();
    this.animations.clear();
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    for (const cleanup of this.cleanups.values()) cleanup();
    this.cleanups.clear();
    this.layer.replaceChildren();
    if (this.layer.parentElement !== document.body) document.body.append(this.layer);
    this.board.cancelMotion();
  }

  private later(callback: () => void, duration: number): void {
    const timer = setTimeout(() => { this.timers.delete(timer); callback(); }, duration);
    this.timers.add(timer);
  }

  private animate(element: HTMLElement, keyframes: Keyframe[], duration: number, delay = 0, easing = "cubic-bezier(0.16, 1, 0.3, 1)"): void {
    if (this.reduced || !element.animate) return;
    const animation = element.animate(keyframes, { duration, delay, easing });
    this.animations.add(animation);
    void animation.finished.then(() => this.animations.delete(animation), () => this.animations.delete(animation));
  }

  private mark(element: HTMLElement | null, kind: string, duration: number = MOTION.emphasis): void {
    if (!element || !bounds(element)) return;
    this.cleanups.get(element)?.();
    element.dataset.motion = kind;
    element.classList.add("motion-emphasis");
    const cleanup = () => {
      if (this.cleanups.get(element) !== cleanup) return;
      if (element.dataset.motion === kind) {
        delete element.dataset.motion;
        element.classList.remove("motion-emphasis");
      }
      this.cleanups.delete(element);
    };
    this.cleanups.set(element, cleanup);
    this.later(cleanup, duration);
  }

  private anchor(player: number): Bounds | undefined {
    return bounds(query("dialog[open] .ship-hold")) ?? bounds(query("dialog[open] .modal-heading")) ??
      bounds(query(`[data-player-index="${player}"]`)) ?? bounds(query(".turn-heading")) ?? bounds(query("#turn-controls"));
  }

  private receipt(kind: string, text: string, icon = ""): HTMLElement {
    const element = document.createElement("div");
    element.className = "motion-receipt";
    element.dataset.motion = kind;
    if (icon) element.innerHTML = icon;
    const label = document.createElement("span");
    label.textContent = text;
    element.append(label);
    this.layer.append(element);
    // Start below the masthead, in the turn area, without clipping stacked notices.
    const header = bounds(query("#game-status"));
    const receipts = Array.from(this.layer.querySelectorAll<HTMLElement>(".motion-receipt"));
    const stackHeight = receipts.reduce((height, receipt) => height + receipt.offsetHeight, 0) + (receipts.length - 1) * 12;
    const top = header ? header.y + header.height + 48 : 64;
    this.layer.style.paddingTop = `${Math.max(16, Math.min(top, innerHeight - stackHeight - 16))}px`;
    // Resource receipts replace the bottom toast, not its live announcement or
    // the human's existing paid-adjustment receipt (even on a net worker gain).
    if (kind === "rival-action" ||
        (kind === "workers-gain" || kind === "workers-spend") && !query("#feedback .worker-spend")) {
      const feedback = query("#feedback");
      if (feedback?.dataset.message) {
        feedback.dataset.presented = feedback.dataset.message;
        feedback.hidden = true;
      }
    }
    // Keep the faded state through the removal timer's final 50 ms.
    if (!this.reduced && typeof element.animate === "function") element.style.opacity = "0";
    this.animate(element, [{ opacity: 0, transform: "translateY(4px)" }, { opacity: 1, transform: "translateY(0)", offset: .08 }, { opacity: 1, offset: .9 }, { opacity: 0 }], MOTION.receipt, 0, "linear");
    this.later(() => element.remove(), MOTION.receipt + 50);
    return element;
  }

  private flight(kind: string, content: string, from: Bounds | undefined, to: Bounds | undefined, size = 40, terrain?: Tile["color"]): void {
    if (!withinView(from) || !withinView(to) || this.reduced) return;
    const a = center(from), b = center(to);
    const piece = document.createElement("div");
    piece.className = `motion-piece ${kind === "tile-flight" ? "motion-tile" : ""}`;
    piece.dataset.motion = kind;
    piece.innerHTML = content;
    if (terrain) piece.style.backgroundImage = `url("${import.meta.env.BASE_URL}terrain/${terrain}.svg")`;
    // The default pose is the arrival, not the origin, after the animation ends.
    Object.assign(piece.style, { left: `${a.x - size / 2}px`, top: `${a.y - size / 2}px`, width: `${size}px`, height: `${size}px`,
      transform: `translate(${b.x - a.x}px, ${b.y - a.y}px) rotate(0) scale(.94)`, opacity: ".85" });
    this.layer.append(piece);
    this.animate(piece, [
      { transform: "translate(0, 0) rotate(-3deg) scale(1.03)", opacity: 1 },
      { transform: `translate(${(b.x - a.x) * .45}px, ${(b.y - a.y) * .45 - 18}px) rotate(2deg) scale(1.08)`, offset: .45, opacity: 1 },
      { transform: `translate(${b.x - a.x}px, ${b.y - a.y}px) rotate(0) scale(.94)`, opacity: .85 },
    ], MOTION.flight, 0, "cubic-bezier(0.4, 0, 0.2, 1)");
    this.later(() => piece.remove(), MOTION.flight + 30);
  }

  private tileArt(tile: Tile): string {
    return `${iconSvg(tile, 44)}${tile.count ? `<b class="motion-tile-count">×${tile.count}</b>` : ""}`;
  }

  selectDie(index: number): void {
    const face = query(`[data-die="${index}"] .die-face`);
    if (face) this.animate(face, [{ transform: "translateY(0)" }, { transform: "translateY(-2px)" }], 120);
  }

  private tossDice(state: State): void {
    const revision = this.revision;
    const rollSummary = state.players.map(player => `${player.name}: ${player.dice.join(" & ")}`).join(" · ");
    const revealDice = () => document.querySelectorAll<HTMLElement>(".public-dice .die-face:not(.spent), .dice-row .die-face:not(.spent)")
      .forEach(face => this.mark(face, "dice-reveal"));
    const routeGoods = () => {
      // Depot labels are destinations, not rolling dice.
      const source = bounds(query("#phase-goods")) ?? bounds(query("#season"));
      const destination = query(`[data-depot="${state.whiteDie - 1}"] .depot-goods`);
      this.mark(destination, "goods-arrival");
      const arriving = state.depots[state.whiteDie - 1].goods.at(-1);
      if (arriving) this.flight("cargo-arrival", goodsIcon(arriving, 28), source, bounds(destination), 28);
      this.receipt("white-die", `Goods die ${state.whiteDie} · depot ${state.whiteDie}`);
    };
    if (this.reduced) {
      revealDice();
      routeGoods();
      return;
    }

    if (!this.diceRenderer) {
      void this.prepareDice().then(() => {
        if (revision === this.revision && !document.hidden) this.tossDice(state);
      }).catch(() => {
        if (revision === this.revision && !document.hidden) {
          this.receipt("dice-reveal", rollSummary);
          routeGoods();
        }
      });
      return;
    }

    const host = query("#board");
    const boardBounds = bounds(host);
    if (!host || !boardBounds) { revealDice(); routeGoods(); return; }

    // One transparent, board-local toss for every player's pair and the white
    // die. Only committed round results determine the top faces.
    const stage = document.createElement("div");
    stage.className = "dice-stage";
    stage.setAttribute("aria-hidden", "true");
    stage.innerHTML = `<div class="dice-round">Phase ${"ABCDE"[state.phase]} · Round ${state.round + 1} · All players roll</div>`;
    this.diceStage = stage;
    host.append(stage);
    const { width, height } = boardBounds;
    const groups = [...state.players.map(player => ({ name: player.name, values: player.dice as number[] })),
      { name: "Goods die", values: [state.whiteDie] }];
    const rowHeight = (height - 58) / Math.ceil(groups.length / 2);
    const size = Math.floor(Math.min(54, width * .135, rowHeight * .36));
    const positions: { x: number; y: number }[] = [];
    groups.forEach((group, index) => {
      const centered = index === groups.length - 1 && groups.length % 2 === 1;
      const x = width * (centered ? .5 : index % 2 === 0 ? .25 : .75);
      const y = 36 + rowHeight * (Math.floor(index / 2) + .42);
      group.values.forEach((_, die) => positions.push({ x: x + (group.values.length === 1 ? 0 : (die === 0 ? -.68 : .68) * size), y }));
      const label = document.createElement("span");
      label.className = "dice-owner";
      label.dataset.playerRoll = index < state.players.length ? String(index) : "white";
      label.textContent = group.name;
      Object.assign(label.style, { left: `${x}px`, top: `${y + size * .74}px`, maxWidth: `${width / 2 - 12}px` });
      stage.append(label);
    });
    const current = () => revision === this.revision && this.diceStage === stage;
    const visible = () => stage.isConnected && !document.hidden && !this.reduced;
    this.diceRenderer.play({ host: stage, values: groups.flatMap(group => group.values), positions, width, height, size,
      onLand: () => { if (current() && visible()) revealDice(); },
      onComplete: () => {
        if (!current()) return;
        if (!visible()) { this.cancel(); return; }
        stage.remove(); this.diceStage = undefined; routeGoods();
      },
      onUnavailable: () => {
        if (!current()) return;
        const present = visible();
        this.cancel();
        if (!present) return;
        this.receipt("dice-reveal", rollSummary);
        routeGoods();
      },
    });
    if (!stage.isConnected) return;
    this.later(() => {
      stage.querySelectorAll<HTMLElement>(".dice-round, .dice-owner").forEach(label => {
        label.style.opacity = "0";
        this.animate(label, [{ opacity: 1 }, { opacity: 0 }], MOTION.diceReturn);
      });
    }, MOTION.diceRoll + MOTION.diceHold);
  }

  private deal(origin?: Bounds): void {
    const step = query('.phase-track [aria-current="step"]');
    this.mark(step, "phase-advance");
    const destination = bounds(step);
    if (step && destination && origin) this.animate(step, [
      { transform: `translateX(${origin.x - destination.x}px)` }, { transform: "translateX(0)" },
    ], MOTION.deal);
    document.querySelectorAll<HTMLElement>(".depot-tiles, .black-tiles").forEach((tiles, index) => {
      if (!bounds(tiles)) return;
      this.mark(tiles, "depot-deal");
      this.animate(tiles, [{ transform: "translateY(-14px) rotate(-2deg)", opacity: .55 }, { transform: "translateY(0) rotate(0)", opacity: 1 }], MOTION.deal, index * MOTION.dealStagger);
    });
  }

  private finalScoring(state: State, lead: number): void {
    const results = query("[data-final-scoring]");
    if (!results || this.reduced) return;
    const steps = finalScoringSteps(state);
    if (!steps.length) return;
    const status = results.querySelector<HTMLElement>(".final-scoring-status")!;
    const skip = results.querySelector<HTMLButtonElement>('[data-ui="skip-final-scoring"]')!;
    const cards = Array.from(results.querySelectorAll<HTMLElement>(".result-player"));
    const totals = cards.map(card => card.querySelector<HTMLElement>("[data-final-total]")!);
    const knowledge = cards.map(card => card.querySelector<HTMLElement>('[data-score-item="knowledge"] .result-score-value')!);
    const title = query("#modal-title")!;
    const winner = title.textContent!;
    const running = state.players.map(player => player.score - Object.values(player.final ?? {}).reduce((sum, points) => sum + points, 0));
    const knowledgeTotals = state.players.map(() => 0);
    let countFrame: number | undefined;
    const finish = () => {
      if (countFrame !== undefined) cancelAnimationFrame(countFrame);
      delete results.dataset.counting;
      results.querySelectorAll("[data-final-pending]").forEach(row => row.removeAttribute("data-final-pending"));
      totals.forEach((total, player) => { total.textContent = String(state.players[player].score); });
      knowledge.forEach((total, player) => { total.textContent = `+${state.players[player].final?.knowledge ?? 0}`; });
      title.textContent = winner;
      status.textContent = "Final scoring complete. All bonuses are included.";
      skip.hidden = true;
      if (document.activeElement === skip) results.querySelector<HTMLButtonElement>('[data-ui="close"]')?.focus();
      this.finishFinalScoring = undefined;
    };
    this.finishFinalScoring = finish;
    results.dataset.counting = "true";
    title.textContent = "Counting the final bonuses";
    status.textContent = lead ? "Final mine income is paid before silver and worker pairs are counted." : "Adding final bonuses to estate & trading points.";
    skip.hidden = false;
    totals.forEach((total, player) => { total.textContent = String(running[player]); });
    knowledge.forEach(total => { total.textContent = "+0"; });
    for (const step of steps) for (const gain of step.gains)
      cards[gain.player].querySelector(`[data-score-item="${step.key}"]`)?.setAttribute("data-final-pending", "");

    steps.forEach((step, index) => this.later(() => {
      if (countFrame !== undefined) cancelAnimationFrame(countFrame);
      const from = [...running], fromKnowledge = [...knowledgeTotals];
      for (const gain of step.gains) {
        running[gain.player] += gain.points;
        if (step.key.startsWith("knowledge-")) knowledgeTotals[gain.player] += gain.points;
        const row = cards[gain.player].querySelector<HTMLElement>(`[data-score-item="${step.key}"]`);
        row?.removeAttribute("data-final-pending");
        this.mark(row, "final-contribution", MOTION.finalStep - 100);
        if (gain.points) this.animate(totals[gain.player], [{ transform: "scale(1)" }, { transform: "scale(1.06)", offset: .4 }, { transform: "scale(1)" }], MOTION.finalCount);
      }
      status.textContent = `${step.label}: ${step.gains.map(gain => `${state.players[gain.player].name} +${gain.points} VP`).join(" · ")}`;
      const started = performance.now();
      const count = (now: number) => {
        const progress = Math.min(1, (now - started) / MOTION.finalCount);
        totals.forEach((total, player) => { total.textContent = String(from[player] + Math.round((running[player] - from[player]) * progress)); });
        knowledge.forEach((total, player) => { total.textContent = `+${fromKnowledge[player] + Math.round((knowledgeTotals[player] - fromKnowledge[player]) * progress)}`; });
        countFrame = progress < 1 ? requestAnimationFrame(count) : undefined;
      };
      countFrame = requestAnimationFrame(count);
    }, lead + index * MOTION.finalStep));
    this.later(finish, lead + steps.length * MOTION.finalStep);
  }

  startGame(state: State): void {
    this.cancel();
    if (state.status !== "playing" || document.hidden) return;
    this.frame = requestAnimationFrame(() => { this.frame = undefined; this.tossDice(state); });
  }

  play(plan: MotionPlan, previous: State, next: State, origin: MotionOrigin, viewedPlayer: number): void {
    this.cancel();
    if (document.hidden) return;
    if (previous.status === "playing" && next.status === "finished") this.finalScoring(next, MOTION.receipt + 100);
    this.frame = requestAnimationFrame(() => {
      this.frame = undefined;
      // Harbor decisions are modal; feedback belongs in their top layer too.
      (query("dialog[open]") ?? document.body).append(this.layer);
      this.board.refreshSize();
      // scroll events can be delivered one frame after revealBoard has already
      // moved the viewport. That queued event must not erase the new phase.
      this.paintedScroll = { x: scrollX, y: scrollY };
      // Never fly from a stale screen position after the phone reveals its board.
      const moved = origin.scrollX !== scrollX || origin.scrollY !== scrollY;
      const modal = Boolean(query("dialog[open]"));
      const sourceTile = moved || modal ? undefined : origin.tile;
      const tile = plan.tile;
      const cell = !modal && tile?.cell !== undefined && viewedPlayer === plan.actor ? this.board.cellBounds(tile.cell) : undefined;
      const reserve = tile && viewedPlayer === plan.actor
        ? bounds(query(`#storage [data-tile="${CSS.escape(tile.tile.id)}"]`)) : undefined;
      const destination = withinView(cell) ? cell : reserve ?? this.anchor(plan.actor);
      const arrival = rewardLeadIn(plan, this.reduced);
      if (!modal) {
        if (arrival) this.later(() => this.board.playMotion(plan, viewedPlayer), arrival);
        else this.board.playMotion(plan, viewedPlayer);
      }

      if (tile) {
        this.flight("tile-flight", this.tileArt(tile.tile), sourceTile ?? (tile.from === "reserve" && plan.actor !== viewedPlayer ? this.anchor(plan.actor) : undefined), destination, 48, tile.tile.color);
        const target = tile.cell === undefined && viewedPlayer === plan.actor
          ? query(`#storage [data-tile="${CSS.escape(tile.tile.id)}"]`) : query(`[data-player-index="${plan.actor}"]`);
        this.mark(target, "tile-arrival");
        if (plan.actor > 0) {
          const verb = tile.cell === undefined ? "Reserved" : "Built";
          this.receipt("rival-action", `${next.players[plan.actor].name}: ${verb} ${tileName(tile.tile, next.ruleset)}`,
            iconSvg(tile.tile, 28));
        } else if (!sourceTile || this.reduced) {
          this.receipt("tile-arrival", tile.cell === undefined ? "Added to reserve" : `${tileName(tile.tile, next.ruleset)} placed`);
        }
      }

      const rewardEffects = () => {
      for (const item of plan.silver) {
        const resource = !modal && viewedPlayer === item.player ? query('[data-resource="silver"]') : null;
        const target = bounds(resource) ?? this.anchor(item.player);
        const source = item.source === "sale" ? (moved ? undefined : origin.goods.get(`stored:${plan.goods.find(g => g.amount < 0)?.type}`))
          : item.source === "workers" ? moved ? undefined : origin.workers
          : viewedPlayer === item.player && item.cells.length ? this.board.cellBounds(item.cells[0]) : cell;
        this.flight("silver-flight", resourceIcon("silver", 30), source, target, 30);
        this.mark(resource ?? query(`[data-player-index="${item.player}"]`), "silver-balance");
        // Keep resource flights/highlights; combine simultaneous rewards into
        // one receipt per player instead of duplicating final payouts.
        if (!plan.workers?.some(worker => worker.player === item.player && worker.amount > 0) &&
            !(next.status === "finished" && plan.scores.some(score => score.player === item.player)))
          this.receipt("silver-gain", `${item.player === viewedPlayer && bounds(resource) ? "" : `${next.players[item.player].name}: `}+${item.amount} silver${item.source === "mines" ? " · mines" : ""}`, resourceIcon("silver", 24));
      }

      for (const item of plan.workers ?? []) {
        const resource = !modal && viewedPlayer === item.player ? query('[data-resource="workers"]') : null;
        const visible = bounds(resource);
        this.mark(visible ? resource : query(`[data-player-index="${item.player}"]`), "workers-balance");
        // main.ts already presents the human's exact adjustment cost.
        if (item.amount < 0 && item.player === 0) continue;
        if (next.status === "finished" && plan.scores.some(score => score.player === item.player)) continue;
        const silver = item.amount > 0 ? plan.silver.find(gain => gain.player === item.player) : undefined;
        const owner = item.player === 0 && viewedPlayer === 0 && visible ? "" : `${next.players[item.player].name}: `;
        const amount = item.amount > 0 ? `+${item.amount}` : `−${Math.abs(item.amount)}`;
        const extra = silver ? ` · +${silver.amount} silver${silver.source === "mines" ? " · mines" : ""}` : "";
        this.receipt(item.amount > 0 ? "workers-gain" : "workers-spend",
          `${owner}${amount} worker${Math.abs(item.amount) === 1 ? "" : "s"}${extra}`, resourceIcon("workers", 24));
      }

      for (const item of plan.goods) {
        const stored = item.player === viewedPlayer ? query(`[data-good="${item.type}"]`) : null;
        const source = item.amount > 0 ? origin.goods.get(`${item.depots[0]}:${item.type}`) : origin.goods.get(`stored:${item.type}`);
        const target = item.amount > 0 ? bounds(stored) ?? this.anchor(item.player) : bounds(query("#sold-goods-summary"));
        this.flight("cargo-flight", goodsIcon(item.type, 30), moved ? undefined : source, target, 30);
        this.mark(stored, item.amount > 0 ? "cargo-loaded" : "cargo-sold");
        if (this.reduced || !source || !bounds(stored))
          this.receipt("cargo-receipt", `${item.amount > 0 ? "+" : ""}${item.amount} goods · type ${item.type}${item.amount > 0 ? " stored" : " sold"}`, goodsIcon(item.type, 24));
      }

      for (const item of plan.scores) {
        const score = !modal ? query(`[data-player-index="${item.player}"] .score-value`) : null;
        const target = bounds(score) ?? this.anchor(item.player);
        const region = plan.regions.find(r => r.player === item.player);
        const source = region && viewedPlayer === item.player ? this.board.cellBounds(region.cells[0]) : cell;
        const detail = region ? item.amount === region.points ? " · region complete" : ` · region +${region.points}` : "";
        const income = next.status === "finished" ? plan.silver.find(gain => gain.player === item.player) : undefined;
        const payout = income ? ` · +${income.amount} silver${income.source === "mines" ? " · mines" : ""}` : "";
        const workers = next.status === "finished" ? plan.workers?.find(gain => gain.player === item.player && gain.amount > 0) : undefined;
        const workforce = workers ? ` · +${workers.amount} worker${workers.amount === 1 ? "" : "s"}` : "";
        const owner = item.player !== 0 || plan.scores.length > 1 ? `${next.players[item.player].name}: ` : "";
        const celebrate = () => {
          this.flight("score-flight", `<strong>+${item.amount}</strong>`, source, target, 38);
          this.mark(score, "score-balance");
          this.receipt("score-gain", `${owner}+${item.amount} VP${detail}${payout}${workforce}`);
        };
        if (region && !this.reduced) this.later(celebrate, MOTION.rewardDelay);
        else celebrate();
      }

      if (plan.freeAction) {
        const control = plan.actor === 0 ? query(".action-step") : query(`[data-player-index="${plan.actor}"]`);
        this.mark(control, "free-action");
        this.receipt("free-action", `${plan.actor === 0 ? "" : `${next.players[plan.actor].name}: `}Castle privilege · one free action`, iconSvg({ color: "castle" }, 26));
      }
      if (plan.ship) {
        const ship = plan.ship;
        const rank = ship.order.indexOf(ship.player) + 1;
        const counter = !modal && viewedPlayer === ship.player ? query('[data-resource="ships"]') : null;
        this.mark(counter, "ship-progress");
        const trackMarkup = `<span class="motion-order-track">${ship.order.map((_, index) => `<i>${index + 1}</i>`).join("")}<b class="motion-order-marker" style="left:${(rank - 1) * 23}px">${resourceIcon("ships", 20)}</b></span>`;
        const note = this.receipt("ship-order", `${next.players[ship.player].name}: ships ${ship.from} → ${ship.to} · next round #${rank}`, trackMarkup);
        if (note) {
          const marker = note.querySelector<HTMLElement>(".motion-order-marker")!;
          const distance = turnOrder(previous).indexOf(ship.player) - rank + 1;
          this.animate(marker, [{ transform: `translateX(${distance * 23}px)` }, { transform: "translateX(0)" }], MOTION.flight);
        }
      }
      };
      if (arrival) this.later(rewardEffects, arrival);
      else rewardEffects();
      if (origin.die !== undefined && !plan.roll && previous.players[plan.actor].dice[origin.die] !== null && next.players[plan.actor].dice[origin.die] === null) {
        const face = query(`[data-player-dice="${plan.actor}"] .die-face:nth-child(${origin.die + 1})`);
        if (face) this.animate(face, [{ transform: "translateY(-2px)", opacity: .9 }, { transform: "translateY(0)", opacity: .55 }], 150);
      }
      if (plan.phaseChanged) {
        const incomeDelay = !this.reduced && plan.silver.length ? MOTION.receipt + 200 : 0;
        if (incomeDelay) this.later(() => this.deal(origin.phase), incomeDelay);
        else this.deal(origin.phase);
      }
      if (plan.roll) {
        const lead = this.reduced ? 0 : rollLeadIn(plan);
        if (lead) this.later(() => this.tossDice(next), lead);
        else this.tossDice(next);
      }
    });
  }
}
