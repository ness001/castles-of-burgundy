import "@fontsource/source-sans-3/latin-400.css";
import "@fontsource/source-sans-3/latin-500.css";
import "@fontsource/source-sans-3/latin-600.css";
import "@fontsource/source-sans-3/latin-700.css";
import "@fontsource/im-fell-english/latin-400.css";
import "@fontsource/libre-caslon-display/latin-400.css";
import "./style.css";
import { COLORS, KNOWLEDGE, knowledgeInfo, tileDescription, tileName } from "./data";
import { RULESETS, rulesFor } from "./rules";
import { BOARDS, boardFor } from "./boards";
import {
  actionKey,
  applyAction,
  canPlace,
  createGame,
  finalKnowledgeScores,
  knowledgeIds,
  legalActions,
  turnOrder,
} from "./engine";
import { chooseAction } from "./ai";
import { BoardView, iconSvg, PALETTE } from "./board-view";
import { crownIcon, goodsIcon, resourceIcon, harborScene } from "./illustrations";
import { tileBenefit, regionOutcome, saleOutcome, placementOutcome } from "./presentation";
import { GameAudio } from "./audio";
import { GameMotion } from "./motion";
import { motionForAction } from "./motion-events";
import { DICE_SEQUENCE, MOTION, motionReadingTime, rewardLeadIn, rollLeadIn } from "./motion-timing";
import type { Action, ActionKind, GameOptions, Player, State, Tile } from "./types";

// The saved value is the State itself; version belongs to the engine contract.
const SAVE_KEY = "burgundy-table.state.v1";
const SHORTCUTS_KEY = "burgundy-table.shortcuts.v1";
const ACTION_KEYS: Partial<Record<ActionKind, string>> = { take: "1", place: "2", sell: "3", workers: "4" };
// Visual cargo identities only: the engine still uses the same six numbered types.
const GOODS = ["Silk", "Spices", "Ceramics", "Dyes", "Copperware", "Wool"];
const COLOR_NAMES = { castle: "Forest green", ship: "Water blue", animal: "Meadow green", mine: "Slate gray", knowledge: "Gold", building: "Pale stone" };
const escape = (value: unknown) =>
  String(value).replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        char
      ]!,
  );
const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);
let notice = "";
let tableSaved = true;
const STORAGE_NOTICE = "Browser storage is unavailable. This table will not survive a reload.";
function load(): State {
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    if (raw) {
      const saved: State = JSON.parse(raw);
      if (
        saved.version === 1 &&
        (saved.ruleset === undefined || Object.hasOwn(RULESETS, saved.ruleset)) &&
        [2, 3, 4].includes(saved.players?.length) &&
        saved.players.every((p) => BOARDS[p.boardId ?? 1] && p.board?.length === BOARDS[1].length) &&
        ["setup", "playing", "finished"].includes(saved.status)
      ) {
        legalActions(saved); // Reject an incompatible save before mounting the interface.
        return saved;
      }
      notice =
        "The saved table is incompatible. A new estate has been prepared.";
    }
  } catch {
    notice =
      "The saved table could not be restored. A new estate has been prepared.";
  }
  return createGame();
}
let state = load();
let shortcutsEnabled = true;
try {
  shortcutsEnabled = localStorage.getItem(SHORTCUTS_KEY) !== "off";
} catch {
  // Shortcuts still work when browser storage is unavailable.
}
const audio = new GameAudio();
let actions: Action[] = [];
let selectedDie: number | null = null;
let mode: ActionKind = "take";
let selectedTile: string | null = null;
let selectedCell: number | null = null;
let selectedGood: number | null = null;
let regionCell: number | undefined;
let inspected = 0;
let lastPlaced: number | undefined;
let aiTimer: ReturnType<typeof setTimeout> | undefined;
let aiNotBefore = 0;
let aiFailed = false;
let endShown = false;
let modalOpener: HTMLElement | null = null;
let undoHistory: { state: State; label: string }[] = [];
let feedback = "";
let lastFeedback = "";
let feedbackTimer: ReturnType<typeof setTimeout> | undefined;
let workerSpendTimer: ReturnType<typeof setTimeout> | undefined;
let choiceDialog = false;
let marketTooltipAnchor: HTMLButtonElement | null = null;
let marketTooltipTimer: ReturnType<typeof setTimeout> | undefined;
let panel: "market" | "estate" = "market";
const humanTurn = () => state.status === "playing" && state.active === 0;
const humanSetup = () => state.status === "setup" && state.active === 0;
let setupPreview: number | undefined;
let setupCell: number | undefined;
const estateTitle = (who: number) => who === 0 ? "Your estate" : `${state.players[who].name}’s estate`;
const root = document.querySelector<HTMLDivElement>("#app")!;
root.innerHTML = `
  <nav class="skip-navigation" aria-label="Skip to game section"><a href="#turn-controls">Skip to turn controls</a><a href="#estate" data-jump="estate">Skip to your estate</a><a href="#legal-details" data-jump="legal">Skip to legal choices</a></nav>
  <header id="game-status" class="masthead" aria-label="Game status">
    <div class="masthead-scene" aria-hidden="true">${harborScene()}</div>
    <a class="wordmark" href="#estate" data-jump="estate" aria-label="Burgundy, your estate"><span class="crest">${iconSvg({ color: "castle" }, 33)}</span><span><span class="brand">Burgundy<span class="brand-period">.</span></span><span class="wordmark-sub">ESTATES · GUILDS · TRADE ROUTES</span></span></a>
    <div id="scoreboard" class="scoreboard" role="group" aria-label="Player scores and public dice"></div>
    <div id="season" class="season" role="group" aria-label="Game progress"></div>
    <nav class="header-tools" aria-label="Table controls"><span id="save-status" class="save-status">● Table saved</span><button data-ui="sound" class="header-button sound-toggle" aria-label="Sound effects" aria-pressed="true" title="Mute sound effects"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11 4 6 8H3v8h3l5 4Z"/><path class="sound-waves" d="M15 8a6 6 0 0 1 0 8m3-11a10 10 0 0 1 0 14"/><path class="sound-muted-mark" d="m16 9 6 6m0-6-6 6"/></svg></button><button data-ui="help" class="header-button">Field guide <span aria-hidden="true">?</span></button><details id="table-details" class="table-details"><summary class="header-button">Table details</summary></details><button data-ui="new" class="header-button">New game <span aria-hidden="true">↗</span></button></nav>
  </header>
  <div id="notice" class="notice" role="status"></div>
  <section id="turn-controls" class="play-toolbar" tabindex="-1" aria-label="Your turn controls"></section>
  <div id="feedback" class="move-feedback"></div>
  <nav class="mobile-navigation" aria-label="Table view"><button data-panel="market">Market · take tiles</button><button data-panel="estate">Estate · build tiles</button></nav>
  <main class="table-layout">
    <aside class="market-column" aria-labelledby="market-title"><div class="section-title"><h2 id="market-title">The merchants’ quay</h2></div><div id="depots" class="depots"></div><section id="black-market" class="black-market" aria-label="Black market"></section></aside>
    <section class="estate-column" id="estate" tabindex="-1" aria-labelledby="estate-title">
      <div class="estate-sheet">
        <div class="map-sheet">
          <div class="estate-heading"><div class="estate-heading-title"><h1 id="estate-title">Your estate</h1><span id="estate-view-status" class="estate-view-status" hidden>Read-only · opponent estate</span></div><div class="estate-switch" role="group" aria-label="Inspect estate"><button data-view="0">You</button><button data-view="1">The Steward</button></div></div>
          <div id="board" aria-label="Hex estate map. Equivalent placement buttons are available in the legal choices list below." role="img"></div><div id="board-tooltip" class="board-tooltip" aria-live="off"></div>
        </div>
        <section id="estate-scoring" class="estate-summary" aria-labelledby="estate-scoring-title">
          <h3 id="estate-scoring-title">Estate scoring</h3>
          <section id="color-ledger" class="color-ledger" aria-label="Color completion bonuses"><div class="estate-section-heading"><span>First +5 · Second +2 VP</span></div><div id="legend" class="legend" aria-label="Estate color key and bonus progress"></div></section>
          <section class="region-panel" aria-label="Region completion rewards"><div id="region-insight"></div><p id="region-detail" role="status" hidden></p></section>
        </section>
      </div>
      <div class="estate-tools">
        <details id="estate-details" class="estate-detail-menu"><summary>Scoring & sold goods</summary><div class="estate-detail-content"></div></details>
        <details class="journal"><summary>Recent moves</summary><ol id="journal"></ol></details>
        <details id="turn-order" class="journal"><summary>Turn order</summary><div id="turn-order-content"></div></details>
      </div>
      <details id="sold-goods" class="journal"><summary id="sold-goods-summary">Your sold goods</summary><div id="sold-goods-content"></div></details>
    </section>
    <aside class="player-column" aria-label="Player controls"><div class="reserve-panel"><section id="storage" class="storage-section"></section><section id="resources" class="resources"></section><section id="goods" class="goods-section"></section><section id="estate-knowledge" class="estate-knowledge" aria-labelledby="advantages-title" hidden></section></div><section id="choices" class="choices" aria-labelledby="choices-title"></section></aside>
    <section class="legal-section"><details id="legal-details"><summary data-ui="legal-toggle">All legal choices <span id="legal-count"></span></summary><div id="legal-actions" class="legal-actions"></div></details></section>
  </main><footer class="table-footer"><span class="table-credit">UNOFFICIAL FAN-MADE TABLE · NOT ENDORSED BY THE GAME’S RIGHTS HOLDERS</span><span>Board 01 <span aria-hidden="true">✦</span> Two-player estate game <span aria-hidden="true">✦</span> Saved on this device</span></footer>
  <div id="announcer" class="sr-only" role="status" aria-live="polite" aria-atomic="true"></div>
  <div id="market-tooltip" class="market-tooltip" role="tooltip" hidden></div>
  <dialog id="modal" aria-labelledby="modal-title"><div id="modal-content"></div></dialog>`;
const el = (id: string) => document.getElementById(id)!;
const dialog = el("modal") as HTMLDialogElement;
function renderSoundControl(): void {
  const button = root.querySelector<HTMLButtonElement>('[data-ui="sound"]')!;
  button.setAttribute("aria-pressed", String(!audio.muted));
  button.title = audio.muted ? "Enable sound effects" : "Mute sound effects";
}
renderSoundControl();
const mobileLayout = matchMedia("(max-width: 1000px)");
function positionChoices(): void {
  // Scoring stays on demand; acquired advantages stay directly below the goods.
  document.querySelector(".estate-detail-content")!.append(el("estate-scoring"), el("sold-goods"));
  const map = document.querySelector(".map-sheet")!;
  el("table-details").append(document.querySelector(".estate-tools")!);
  // Let the board, not a long tile description, follow the reserve on phones.
  if (mobileLayout.matches) {
    map.after(el("choices"));
  } else {
    el("storage").after(el("choices"));
  }
}
function fitDesktopTable(): void {
  if (mobileLayout.matches) return;
  const table = document.querySelector<HTMLElement>(".table-layout")!;
  const footer = document.querySelector<HTMLElement>(".table-footer")!;
  const height = Math.max(260, innerHeight - table.getBoundingClientRect().top - scrollY - footer.offsetHeight - 12);
  const headingHeight = document.querySelector<HTMLElement>(".estate-heading")!.offsetHeight;
  const value = `${height}px`;
  const mapHeight = `${Math.max(180, height - headingHeight)}px`;
  if (root.style.getPropertyValue("--play-height") === value && root.style.getPropertyValue("--map-height") === mapHeight) return;
  root.style.setProperty("--play-height", value);
  root.style.setProperty("--map-height", mapHeight);
  requestAnimationFrame(() => board.refreshSize());
}
positionChoices();
mobileLayout.addEventListener("change", () => {
  positionChoices();
  requestAnimationFrame(() => board.refreshSize());
});
document.querySelector(".market-column > .section-title")!.insertAdjacentHTML(
  "beforeend",
  '<details class="phase-goods-disclosure"><summary>Upcoming goods</summary><section id="phase-goods" class="phase-goods" aria-label="Remaining face-up phase goods"></section></details>',
);
const board = new BoardView(
  el("board"),
  (cell) => {
    if (inspected !== 0) return;
    if (humanSetup()) {
      const action = actions.find(a => a.kind === "choose-estate" && a.boardId === setupPreview && a.cell === cell);
      if (action) {
        setupCell = cell;
        void audio.play("select");
        render();
      }
      return;
    }
    selectedCell = cell;
    const available = contextual().filter((a) => a.cell === cell);
    if (available.length === 1) execute(available[0]);
    else {
      const tile = selectedTile ? findTile(selectedTile) : undefined;
      void audio.play(state.players[0].board[cell] ? "select" : "error");
      feedback = state.players[0].board[cell]
        ? `${tileName(state.players[0].board[cell]!, state.ruleset)}: ${tileDescription(state.players[0].board[cell]!, state.ruleset)}`
        : !tile || mode !== "place" ? "Choose a tile from your reserve first, then a highlighted hex."
        : boardFor(state.players[0])[cell].color !== tile.color ? `This tile needs a ${PALETTE[tile.color].name.toLowerCase()} hex. Choose a highlighted space.`
        : !canPlace(state.players[0], tile, cell) ? "Build next to an existing tile. A city cannot repeat the same building."
        : "This die needs more workers. Try your other die or take workers.";
      selectedCell = null;
      render();
    }
  },
  (cell) => {
    if (cell === null) {
      el("board-tooltip").textContent = "";
      return;
    }
    const location = boardFor(humanSetup() && inspected === 0 ? { boardId: setupPreview } : state.players[inspected])[cell],
      tile = state.players[inspected].board[cell];
    if (humanSetup() && inspected === 0) {
      el("board-tooltip").textContent = `Estate #${setupPreview} · ${PALETTE[location.color].name}${location.color === "castle" ? " · Choose this green starting castle space" : " · Start on a highlighted green castle space"} · Starting castle grants no action or points.`;
      return;
    }
    const r = regionOutcome(state.players[inspected], cell, state.phase);
    const placement = inspected === 0 ? contextual().find(action => action.kind === "place" && action.cell === cell) : undefined;
    el("board-tooltip").textContent = tile
      ? `${tileLabel(tile)} — ${tileBenefit(tile, state.ruleset)}`
      : placement ? `${PALETTE[location.color].name} · ${costText(placement)} · ${placementReward(placement)}`
      : `${COLOR_NAMES[location.color]} · ${PALETTE[location.color].name} · ${r.remaining} left → +${r.points} VP`;
  },
);
const motion = new GameMotion(board);

function persist(): void {
  try {
    localStorage.setItem(SAVE_KEY, JSON.stringify(state));
    tableSaved = true;
    el("save-status").textContent = "● Table saved";
    if (notice === STORAGE_NOTICE) notice = "";
  } catch {
    tableSaved = false;
    el("save-status").textContent = "○ Not saved";
    notice = STORAGE_NOTICE;
  }
}
function modeName(kind: ActionKind): string {
  return {
    "choose-estate": "Choose your estate",
    take: "Take a tile",
    place: "Build",
    sell: "Sell goods",
    workers: "Workers",
    buy: "Buy · 2 silver",
    trade: "Knowledge 6 · 2 workers",
    ship: "Choose depot",
    goods: "Load goods",
    skip: "Decline bonus",
    end: "End turn",
  }[kind];
}
function currentModes(): ActionKind[] {
  return (
    ["take", "place", "sell", "workers", "ship", "goods", "buy", "trade"] as ActionKind[]
  ).filter((kind) => actions.some((a) => a.kind === kind));
}
function resetSelection(): void {
  selectedDie = state.players[0].dice.findIndex((die) => die !== null);
  if (selectedDie < 0 || state.pending.length) selectedDie = null;
  selectedTile = null;
  selectedCell = null;
  selectedGood = null;
  const options = currentModes();
  mode = options.includes("take") ? "take" : (options[0] ?? "end");
}
function setPanel(next: "market" | "estate"): void {
  const changed = root.dataset.panel !== next;
  panel = next;
  root.dataset.panel = next;
  document.querySelectorAll<HTMLButtonElement>("[data-panel]").forEach((button) => {
    if (button.tagName === "BUTTON") button.setAttribute("aria-pressed", String(button.dataset.panel === next));
  });
  // Phaser may have mounted while its phone tab was hidden.
  if (changed) requestAnimationFrame(() => board.refreshSize());
}
function matching(kind: ActionKind, tile?: string): Action[] {
  return actions.filter((a) => a.kind === kind && (!tile || a.tile === tile) &&
    (a.die === undefined || selectedDie === null || a.die === selectedDie));
}
function costText(action: Action): string {
  return action.kind === "buy" ? "2 silver" : action.cost ? `${action.cost} worker${action.cost === 1 ? "" : "s"}` : "no workers";
}
function saleReward(player: Player, good: number): string {
  const reward = saleOutcome(state, player, good);
  return `+${reward.points} VP · +${reward.silver} silver${reward.workers ? ` · +${reward.workers} worker` : ""}`;
}
function placementReward(action: Action): string {
  const reward = placementOutcome(state, action);
  const parts = [`+${reward.points} VP now`];
  if (reward.tilePoints) parts.push(`tile +${reward.tilePoints}`);
  if (reward.regionPoints) parts.push(`region +${reward.regionPoints}`);
  if (reward.colorPoints) parts.push(`color bonus +${reward.colorPoints}`);
  if (reward.silver) parts.push(`+${reward.silver} silver`);
  if (reward.workers) parts.push(`+${reward.workers} workers`);
  return parts.join(" · ");
}
function clearWorkerSpend(): void {
  clearTimeout(workerSpendTimer);
  el("feedback").querySelector(".worker-spend")?.remove();
  document.querySelector("[data-resource='workers']")?.classList.remove("workers-spent");
}
function animateWorkerSpend(cost: number, before: number, after: number): void {
  const receipt = document.createElement("div");
  receipt.className = "worker-spend";
  // The existing live feedback announces the exact cost. This is its visual
  // counterpart, never a second source of game state or a delayed deduction.
  receipt.setAttribute("aria-hidden", "true");
  receipt.innerHTML = `<span class="spent-workers">${Array.from({ length: cost }, (_, i) => `<span class="spent-worker" style="--worker-delay:${i * 140}ms">${resourceIcon("workers", 32)}</span>`).join("")}</span><span><strong>−${cost} worker${cost === 1 ? "" : "s"}</strong><span class="worker-balance">${before} → ${after} remaining</span></span>`;
  el("feedback").prepend(receipt);
  document.querySelector("[data-resource='workers']")?.classList.add("workers-spent");
  workerSpendTimer = setTimeout(clearWorkerSpend, 1900);
}
function eligible(a: Action): boolean {
  return (
    a.kind === mode &&
    (state.pending.length > 0 ||
      mode === "buy" ||
      selectedDie === null ||
      a.die === selectedDie)
  );
}
function contextual(): Action[] {
  return actions.filter(
    (a) =>
      eligible(a) &&
      (!selectedTile || a.tile === selectedTile) &&
      (selectedCell === null || a.cell === selectedCell) &&
      (selectedGood === null || a.good === selectedGood),
  );
}
function dieFace(value: number | null, small = false): string {
  const positions: Record<number, number[]> = {
    1: [4],
    2: [0, 8],
    3: [0, 4, 8],
    4: [0, 2, 6, 8],
    5: [0, 2, 4, 6, 8],
    6: [0, 2, 3, 5, 6, 8],
  };
  return `<span class="die-face ${small ? "small" : ""} ${value === null ? "spent" : ""}" aria-hidden="true">${value === null ? '<span class="spent-mark">—</span>' : Array.from({ length: 9 }, (_, i) => `<i class="${positions[value]?.includes(i) ? "pip" : ""}"></i>`).join("")}</span>`;
}
function tileContent(tile: Tile): string {
  return `${iconSvg(tile, 44)}${tile.count ? `<span class="tile-number" aria-hidden="true">×${tile.count}</span>` : ""}`;
}
function resourceAmount(amount: number, kind: "silver" | "workers"): string {
  const unit = kind === "workers" && amount === 1 ? "worker" : kind;
  return `<span class="resource-amount" title="${amount} ${unit}">${resourceIcon(kind, 22)}<span>${amount}</span><span class="sr-only"> ${unit}</span></span>`;
}
function benefitMarkup(tile: Tile): string {
  // Keep action names readable; a quantity and its resource are one printed unit.
  return escape(tileBenefit(tile, state.ruleset)).replace(/([+−-]?\d+) (silver|workers?)\b/g, (_, amount: string, unit: string) => `<span class="inline-resource" title="${amount} ${unit}">${amount} ${resourceIcon(unit === "silver" ? "silver" : "workers", 20)}<span class="sr-only">${unit}</span></span>`);
}
function cargoToken(type: number, count?: number, named = false): string {
  return `<span class="cargo-item type-${type}" title="${GOODS[type - 1]} · goods type ${type}">${goodsIcon(type, named ? 42 : 28)}<span class="cargo-number">${type}</span>${named ? `<span class="cargo-name">${GOODS[type - 1]}</span>` : ""}${count !== undefined ? `<b class="cargo-count">×${count}</b>` : ""}</span>`;
}
function cargoManifest(goods: number[], named = true): string {
  return [...new Set(goods)].sort((a,b) => a-b).map(type => cargoToken(type, goods.filter(g => g === type).length, named)).join("");
}
function tileLabel(tile: Tile): string {
  if (tile.knowledge) return "Knowledge";
  return tileName(tile, state.ruleset).replace("Carpenter’s ", "").replace("Boarding House", "Boarding house");
}
function purchaseHint(): string {
  if (!humanTurn()) return state.status === "finished" ? "Game complete" : "Available on your turn";
  if (state.purchased) return "Purchase used this turn";
  const depotPurchase = rulesFor(state).knowledge6 === "silver-purchase" && knowledgeIds(state.players[0]).includes(6) && state.depots.some(depot => depot.tiles.length);
  if (!state.black.length && !depotPurchase) return "No tiles left this phase";
  if (state.players[0].silver < 2) return `Need ${2 - state.players[0].silver} more silver · no die`;
  const hint = !state.black.length ? "Black market empty · buy from numbered depots" : "";
  return [hint, state.pending.length ? "Bonus stays pending" : ""].filter(Boolean).join(" · ");
}
function tileButton(
  tile: Tile,
  source: "market" | "black" | "storage",
): string {
  const kind =
    source === "storage"
      ? "place"
      : source === "black"
        ? "buy"
        : mode === "buy" || mode === "trade"
          ? mode
          : "take";
  const possible = actions.filter(
    (a) =>
      a.kind === kind &&
      a.tile === tile.id &&
      (a.die === undefined || selectedDie === null || a.die === selectedDie),
  );
  // Reserve tiles stay inspectable even when the chosen die cannot build them.
  const enabled = humanTurn() && (source === "storage" ? inspected === 0 : possible.length > 0);
  const cost = possible.length ? Math.min(...possible.map((a) => a.cost)) : 0;
  const instruction = source === "storage" ? "Select to build" : kind === "buy" ? "Buy for 2 silver" : kind === "trade" ? "Knowledge 6 · take building" : "Click to take";
  const reason = state.status === "finished"
    ? `Game complete · Read-only ${source === "storage" ? "reserve" : "market"}.`
    : source === "storage" && !humanTurn()
      ? "Read-only reserve. Build from your reserve on your turn."
      : source === "storage" && inspected !== 0 ? "Read-only reserve. Select You above the map to build." : source === "black" ? purchaseHint() : !humanTurn() ? "Wait for your turn" : state.pending.length ? "Resolve your bonus first" : selectedDie === null ? "Both dice spent" : "Try another die or gain workers";
  const target = humanTurn() && possible.length > 0 && (source === "black" || mode === kind || (source === "storage" && mode === "place"));
  const replacesTile = source !== "storage" && possible.some(action => action.discard);
  const prompt = enabled ? source === "storage" && !possible.length ? "Select to inspect. No build spaces with this die." : `${instruction}${cost ? ` · ${cost} worker${cost === 1 ? "" : "s"}` : kind === "buy" ? " · no die" : " · no workers"}${replacesTile ? " · reserve full: choose a tile to replace" : ""}` : reason;
  const name = tileLabel(tile).replace(/^\d+ /, "");
  const label = tile.knowledge ? `Knowledge ${tile.knowledge}` : name[0].toUpperCase() + name.slice(1);
  const caption = `<span class="tile-name"${tile.knowledge ? ` data-short-label="K. ${tile.knowledge}"` : ""}><span>${escape(label)}</span></span>`;
  return `<button class="tile-token ${tile.color} ${source === "storage" ? "reserve-token" : "market-card"} ${selectedTile === tile.id ? "selected" : ""} ${enabled ? "available" : ""} ${target ? "action-target" : ""}" data-tile="${escape(tile.id)}" data-source="${source}" aria-disabled="${!enabled}" data-tile-prompt="${escape(prompt)}" aria-label="${escape(`${tileName(tile, state.ruleset)}. ${tileDescription(tile, state.ruleset)} ${prompt}`)}" aria-pressed="${selectedTile === tile.id}"><span class="tile-art ${tile.color}">${tileContent(tile)}</span>${source !== "storage" ? caption : ""}${target && source === "storage" ? `<span class="target-cost">${resourceAmount(cost, "workers")}</span>` : ""}</button>`;
}
function emptySupplyTile(): string {
  return '<span class="market-tile empty-tile" role="img" aria-label="Empty tile space"><svg class="empty-tile-outline" viewBox="0 0 64 64" aria-hidden="true"><path d="M32 3 59 18v28L32 61 5 46V18Z"/></svg></span>';
}
function hideMarketTooltip(): void {
  clearTimeout(marketTooltipTimer);
  marketTooltipAnchor?.removeAttribute("aria-describedby");
  marketTooltipAnchor = null;
  el("market-tooltip").hidden = true;
}
function showMarketTooltip(button: HTMLButtonElement): void {
  clearTimeout(marketTooltipTimer);
  if (marketTooltipAnchor === button) return;
  if (button.dataset.actionHint) {
    hideMarketTooltip();
    marketTooltipAnchor = button;
    const tooltip = el("market-tooltip");
    tooltip.innerHTML = `<strong>${escape(button.textContent)}</strong><p>${escape(button.dataset.actionHint)}</p>`;
    tooltip.hidden = false;
    button.setAttribute("aria-describedby", "market-tooltip");
    positionMarketTooltip(button);
    return;
  }
  const tile = findTile(button.dataset.tile!);
  if (!tile) return;
  hideMarketTooltip();
  marketTooltipAnchor = button;
  const tooltip = el("market-tooltip");
  tooltip.innerHTML = `<strong>${escape(tileName(tile, state.ruleset))}</strong><span class="tile-benefit">${benefitMarkup(tile)}</span><p>${escape(tileDescription(tile, state.ruleset))}</p><span class="tile-prompt">${escape(button.dataset.tilePrompt)}</span>`;
  tooltip.hidden = false;
  button.setAttribute("aria-describedby", "market-tooltip");
  positionMarketTooltip(button);
}
function positionMarketTooltip(button: HTMLButtonElement): void {
  const tooltip = el("market-tooltip");
  const actionHint = Boolean(button.dataset.actionHint);
  const anchor = (actionHint ? button.closest(".quick-actions") ?? button : button.closest(".storage-slots") ?? button).getBoundingClientRect();
  const bounds = tooltip.getBoundingClientRect();
  const right = anchor.right + 8;
  const left = right + bounds.width <= innerWidth - 8 ? right : anchor.left - bounds.width - 8;
  const beside = !actionHint && left >= 8;
  const top = beside ? anchor.top : anchor.bottom + 8 + bounds.height <= innerHeight - 8 ? anchor.bottom + 8 : anchor.top - bounds.height - 8;
  const x = Math.max(8, Math.min(beside ? left : anchor.left, innerWidth - bounds.width - 8));
  const positions = [top, anchor.bottom + 8, anchor.top - bounds.height - 8, innerHeight - bounds.height - 8]
    .map(y => Math.max(8, Math.min(y, innerHeight - bounds.height - 8)));
  const controls = Array.from(root.querySelectorAll<HTMLElement>(".quick-actions button, .estate-switch button"))
    .map(control => control.getBoundingClientRect())
    .filter(rect => rect.width > 0 && rect.height > 0 && rect.left < x + bounds.width && rect.right > x);
  // Try another in-bounds position before covering neighboring action or estate controls.
  const y = positions.find(y => controls.every(rect => y + bounds.height <= rect.top || y >= rect.bottom)) ?? positions[0];
  tooltip.style.left = `${x}px`;
  tooltip.style.top = `${y}px`;
}
function renderMarket(): void {
  hideMarketTooltip();
  el("phase-goods").innerHTML =
    `<div class="phase-goods-heading"><span class="eyebrow">GOODS TO COME</span><span>next → last</span></div><div class="phase-goods-queue">${state.phaseGoods.length ? state.phaseGoods.map((good, index) => `<span class="goods-crate type-${good}" role="img" aria-label="${index === 0 ? "Next arrival" : `Arrival ${index + 1}`}: goods type ${good} (${GOODS[good - 1]})" title="${index === 0 ? "Next arrival" : `Arrival ${index + 1}`}: goods type ${good} (${GOODS[good - 1]})">${cargoToken(good)}</span>`).join("") : '<span class="empty-goods">All phase goods have arrived</span>'}</div>`;
  const depotActions = humanTurn() && ["take", "buy", "trade"].includes(mode) ? matching(mode) : [];
  el("depots").innerHTML = state.depots.map((depot, index) => {
    const available = depotActions.filter(action => action.depot === index);
    const cost = available.length ? Math.min(...available.map(action => action.cost)) : 0;
    const price = mode === "buy" ? "2 silver" : cost ? `${cost} worker${cost === 1 ? "" : "s"}` : "No workers";
    const cargo = depot.goods.length
      ? cargoManifest(depot.goods, false)
      : '<svg class="empty-cargo" viewBox="0 0 32 24" aria-hidden="true"><path d="M4 8 16 2l12 6v11l-12 4L4 19Zm0 0 12 5 12-5M16 13v10M10 5l12 5"/></svg>';
    return `<section class="depot ${depot.tiles.length ? "" : "empty"} ${state.whiteDie === index + 1 ? "arrival-depot" : ""}" data-depot="${index}" aria-label="Depot ${index + 1}">
      <div class="depot-heading"><span class="sr-only">Depot ${index + 1}</span>${dieFace(index + 1, true)}${available.length ? `<span class="depot-cost${cost ? " adjusted" : ""}" title="${price} per tile">${escape(price)}</span>` : ""}</div>
      <div class="depot-tiles">${depot.tiles.map(tile => `<div class="market-tile">${tileButton(tile, "market")}</div>`).join("")}${Array.from({ length: Math.max(0, state.players.length - depot.tiles.length) }, emptySupplyTile).join("")}</div>
      <div class="depot-goods" role="group" aria-label="${depot.goods.length ? "Goods waiting" : "No goods"} at depot ${index + 1}" title="${state.whiteDie === index + 1 ? "Goods arrived here this round. " : ""}${depot.goods.length ? "Goods waiting at this depot" : "No goods waiting"}">${cargo}</div>
    </section>`;
  }).join("");
  const purchaseStatus = purchaseHint();
  const workerTrade = rulesFor(state).knowledge6 === "worker-building";
  const knowledgeMode = workerTrade ? "trade" : "buy";
  const knowledgeButton = knowledgeIds(state.players[0]).includes(6) && humanTurn()
    ? `<button class="secondary-button" data-mode="${mode === knowledgeMode ? "take" : knowledgeMode}"${workerTrade && mode !== "trade" && !actions.some(a => a.kind === "trade") ? " disabled" : ""}>${mode === knowledgeMode ? workerTrade ? "Stop trading workers" : "Stop buying from depots" : workerTrade ? state.knowledge6Used ? "Knowledge 6 used this turn" : "Knowledge 6 · building for 2 workers" : "Buy from any depot"}</button>`
    : "";
  el("black-market").innerHTML =
    `<div class="black-heading"><h3>Black market</h3><span>${resourceAmount(2, "silver")} / tile</span></div>${purchaseStatus ? `<span class="purchase-status">${purchaseStatus}</span>` : ""}<div class="black-tiles">${state.black.map(tile => `<div class="market-tile">${tileButton(tile, "black")}</div>`).join("")}${Array.from({ length: Math.max(0, state.players.length * 2 - state.black.length) }, emptySupplyTile).join("")}</div>${knowledgeButton}`;
}
function renderSeason(): void {
  const finished = state.status === "finished";
  el("season").innerHTML = `<div class="progress-group phase-group">
    <span class="progress-label phase-label">Phase</span>
    <ol class="progress-track phase-track" aria-label="Phase${finished ? ", complete" : ` ${"ABCDE"[state.phase]} of 5`}. Region completion timing rewards in victory points">${[..."ABCDE"].map((value, index) => {
      const status = finished || index < state.phase ? "past" : index === state.phase ? "current" : "upcoming";
      const description = `Phase ${value}, ${status === "past" ? "completed" : status}`;
      const step = `<span class="progress-step ${status}"${status === "current" ? ' aria-current="step"' : ""}>${value}</span>`;
      return `<li class="phase-stop" aria-label="${description}; +${10 - index * 2} VP per completed region" title="${description} · +${10 - index * 2} VP per completed region">${step}<span class="phase-reward" aria-hidden="true">+${10 - index * 2}</span></li>`;
    }).join("")}</ol></div><div class="round-summary" role="group" aria-label="Round ${state.round + 1} of 5${finished ? ", complete" : ""}"><span class="round-label">Round <strong>${state.round + 1}</strong><span class="progress-total"> / 5</span></span><span class="phase-caption">Region bonus · +${10 - state.phase * 2} VP</span></div>`;
}
function renderScores(): void {
  el("scoreboard").innerHTML = state.players
    .map(
      (p, index) => {
        const active = state.active === index && state.status === "playing";
        return `<div class="score-row ${active ? "active" : ""}" data-player-index="${index}"><div class="score-name"><strong>${escape(p.name)}</strong><span class="score-turn">${active ? "Playing" : state.status === "finished" ? "Final score" : ""}</span></div><div class="public-dice" data-player-dice="${index}" role="img" aria-label="${escape(p.name)}: die 1 ${p.dice[0] ?? "used"}, die 2 ${p.dice[1] ?? "used"}" title="${escape(p.name)} · public dice (read only)">${p.dice.map((die) => dieFace(die, true)).join("")}</div><div class="score-value">${p.score}<span>VP</span></div></div>`;
      },
    )
    .join("");
  const names = (order: number[], current = false) => order.map(who => `<span class="turn-order-player" data-order-player="${who}">${escape(state.players[who].name)}${current && state.status === "playing" && who === state.active ? ' <strong class="order-playing">Playing</strong>' : ""}</span>`).join(" → ");
  const next = turnOrder(state);
  const finalRound = state.status === "finished" || (state.phase === 4 && state.round === 4);
  const timing = finalRound ? "No next round; if points and empty spaces tie, later on this track wins." : "Changes take effect next round.";
  el("turn-order-content").innerHTML = `<p><strong>${state.status === "setup" ? "Starting" : "This round"}:</strong> ${names(state.order, true)}.</p><p><strong>${finalRound ? "Final track" : "Next round"}:</strong> ${names(next)}.</p><p>More ships go first. At the same step, the most recent ship goes on top. ${timing}</p>`;
}
function pendingText(): string {
  const pending = state.pending[0];
  if (!pending) return "Choose how to spend your dice.";
  if (pending.kind === "take") {
    const names = pending.colors.map(color => color === "animal" ? "pasture" : color);
    const types = names.length > 1 ? `${names.slice(0, -1).join(", ")} or ${names.at(-1)}` : names[0];
    return `Bonus: take one ${types} tile from any numbered depot into your reserve. No die or workers spent.`;
  }
  return {
    free: "Castle: take a tile, build, sell goods, or take workers once. Ignore die values; no die or workers spent. Buying is separate.",
    place: "City Hall: place a tile without a die.",
    sell: "Warehouse: sell a goods type for free.",
    ship: "Your ship arrives. Choose a goods depot.",
    goods: "Choose the goods to bring into your estate.",
  }[pending.kind];
}
function endTurnHint(): string {
  const extras: string[] = [];
  if (actions.some(action => action.kind === "buy")) extras.push("buy for 2 silver");
  if (actions.some(action => action.kind === "trade")) extras.push("trade 2 workers for a building");
  return extras.length ? `Optional: ${extras.join(" and/or ")}, then End turn.` : "No moves left. End your turn.";
}
function actionHint(kind: ActionKind): string {
  if (kind === "place" && !state.players[0].storage.length) return "Take a market tile into your reserve before building.";
  if (kind === "sell" && !state.players[0].goods.some(Boolean)) return "No goods stored. Build a ship to collect cargo before selling.";
  const choices = actions.filter(action => action.kind === kind);
  if (!choices.length) {
    if (state.pending.length) return `Resolve your bonus first. ${pendingText()}`;
    if (state.players[0].dice.every(die => die === null)) return `Both dice are spent. ${endTurnHint()}`;
    if (kind === "take") return state.depots.every(depot => !depot.tiles.length)
      ? "The numbered depots are empty. Take workers for later, or choose another action."
      : "No take is affordable with your dice and workers. Take workers for a later action.";
    return "No legal choices right now. Try your other die, gain workers, or keep the tile for later.";
  }
  if (!matching(kind).length) {
    const die = choices.find(action => action.die !== undefined)?.die;
    return `No choices with the selected die. Switch to die ${die! + 1} (${state.players[0].dice[die!]}) to ${kind === "place" ? "build from your reserve" : kind === "sell" ? "sell goods" : "take a market tile"}.`;
  }
  return {
    take: "Take a tile into your reserve. Building it normally uses another die.",
    place: "Select a reserved tile, then a highlighted space on your estate.",
    sell: "Sell a whole goods type. Check its points, silver and worker cost before choosing.",
    workers: state.pending.length ? "Take workers immediately. Castle privilege: no die spent." : `Take workers immediately. Uses die ${(selectedDie ?? 0) + 1}; its value does not affect the reward.`,
  }[kind as "take" | "place" | "sell" | "workers"] ?? modeName(kind);
}
function turnHint(): string {
  if (state.status === "finished") return "The final scores are ready. Inspect the estates or start a new game.";
  if (!humanTurn()) return aiFailed ? `${state.players[state.active].name} paused. Retry to continue.` : `${state.players[state.active].name} is playing. Your next turn starts automatically.`;
  if (!state.pending.length && state.players[0].dice.every((d) => d === null)) return `Both dice spent. ${endTurnHint()}${mode === "trade" ? " This worker trade spends no die or silver." : ""}`;
  if (mode === "trade") return "Knowledge 6: reserve a highlighted building for 2 workers, once per turn. No die or silver is spent.";
  if (state.pending.length) return pendingText();
  if (mode === "place" && selectedTile) return matching("place", selectedTile).length
    ? `Build ${tileName(findTile(selectedTile)!, state.ruleset)}: click a highlighted hex.`
    : "No build spaces with this die. Try another die, take workers, or keep the tile for later.";
  if (mode === "place") return "Click a tile in your reserve, then a highlighted hex.";
  if (mode === "sell") return "Click a stocked goods type to sell it. Worker costs are shown.";
  if (mode === "buy") return "Click a black-market tile to buy it for 2 silver. No die needed.";
  return `Your die shows ${state.players[0].dice[selectedDie ?? 0]}. Click a market tile to take it, or a reserve tile to build.`;
}
function targetHint(): string {
  if (!humanTurn()) return state.status === "finished" ? "Final scores ready" : `${state.players[state.active].name} is playing`;
  if (inspected !== 0 && mode === "place") return "Select You above the map to build on your estate.";
  if (mode === "trade") return `${new Set(matching("trade").map(a => a.tile)).size} buildings · 2 workers · no die`;
  if (state.pending.length) return pendingText();
  if (state.players[0].dice.every(d => d === null)) return endTurnHint();
  if (mode === "place") return selectedTile ? `${matching("place", selectedTile).length} highlighted build spaces` : "Select a tile from your reserve";
  if (mode === "sell") return "Choose goods to sell";
  const choices = matching(mode === "buy" ? "buy" : "take");
  const count = new Set(choices.map(a => a.tile)).size;
  if (!count) {
    const hint = mode === "take" ? actionHint("take") : purchaseHint();
    return mobileLayout.matches && panel === "estate" && (mode === "take" || mode === "buy") ? `Market · ${hint}` : hint;
  }
  const costs = choices.map(action => action.cost);
  const minCost = Math.min(...costs);
  const maxCost = Math.max(...costs);
  const payment = mode === "buy" ? "2 silver" : maxCost === 0 ? "no workers"
    : `${minCost === maxCost ? minCost : `${minCost}–${maxCost}`} worker${maxCost === 1 ? "" : "s"}`;
  if (mobileLayout.matches && panel === "estate" && (mode === "take" || mode === "buy")) return `Market · ${count} highlighted tiles · ${payment}`;
  return `${count} highlighted tiles · ${payment} · click to ${mode === "buy" ? "buy" : "take"}`;
}
function renderControls(): void {
  const p = state.players[state.active];
  // Preserve the legal-choice disclosure state across toolbar renders.
  const legalSection = document.querySelector(".legal-section")!;
  if (state.status === "setup") {
    el("turn-controls").innerHTML = `<div class="turn-guidance"><h2>${humanSetup() ? "Choose your starting estate" : `${escape(state.players[state.active].name)} is choosing an estate`}</h2></div>${humanSetup() ? '<section id="estate-setup" class="estate-setup" aria-label="Choose starting estate"></section>' : ""}<div class="target-step"></div>`;
    el("turn-controls").querySelector(".target-step")!.append(legalSection);
    return;
  }
  const end = actions.find((a) => a.kind === "end");
  const workers = matching("workers")[0];
  const skip = actions.find(a => a.kind === "skip");
  const bonus = humanTurn() && state.pending.length > 0;
  const pendingCount = state.pending.length > 1 ? `<small class="pending-count">${state.pending.length} bonuses pending</small>` : "";
  const goodsBonus = humanTurn() && ["ship", "goods"].includes(state.pending[0]?.kind ?? "");
  const availableModes = currentModes();
  el("turn-controls").innerHTML = `
    <div class="turn-guidance"><div class="turn-heading"><span class="turn-dot ${humanTurn() ? "" : "ai"}"></span><h2>${state.status === "finished" ? "Game complete" : humanTurn() ? state.pending.length ? "Bonus action" : "Your turn" : `${escape(p.name)}’s turn`}</h2><span class="action-count">${humanTurn() && !state.pending.length ? p.dice.filter(d => d !== null).length + " / 2 dice left" : ""}</span></div><p class="turn-hint">${escape(turnHint())}</p></div>
    ${state.status === "finished" ? '<div class="target-step"></div>' : `
    <div class="turn-step die-step"><span class="step-label"><b>1</b> ${bonus ? "No die needed" : humanTurn() ? "Choose die" : "Your dice"}</span><div class="dice-row">${state.players[0].dice.map((die, index) => `<button class="die-button ${selectedDie === index && humanTurn() ? "chosen" : ""}" data-die="${index}" ${humanTurn() && die !== null && !state.pending.length ? "" : "disabled"} aria-pressed="${selectedDie === index && humanTurn()}" aria-label="Die ${index + 1}: ${die ?? "used"}">${dieFace(die)}<span>${die === null ? "Used" : "Die " + (index + 1)}</span></button>`).join("")}</div></div>
    <div class="turn-step action-step"><span class="step-label"><b>2</b> Choose action</span><div class="quick-actions" role="group" aria-label="Actions">${humanTurn() ? (["take", "place", "sell", "workers"] as ActionKind[]).map(kind => `<button data-mode="${kind}" data-action-hint="${escape(actionHint(kind))}" class="action-tab ${mode === kind ? "selected" : ""}" ${shortcutsEnabled ? `aria-keyshortcuts="${ACTION_KEYS[kind]}"` : ""} ${kind !== "workers" ? 'aria-pressed="' + (mode === kind) + '"' : ""} aria-disabled="${!availableModes.includes(kind)}">${kind === "workers" ? resourceIcon("workers", 24) : kind === "place" ? iconSvg({color:"building",building:"workshop"},24) : kind === "sell" ? resourceIcon("silver",24) : iconSvg({color:"building",building:"market"},24)}<span>${kind === "workers" ? (workers?.label ?? "Take 2 workers") : modeName(kind)}</span></button>`).join("") : ""}</div></div>
    <div class="turn-step target-step"><span class="step-label"><b>3</b> Choose target</span><p>${escape(targetHint())}</p>${pendingCount}</div>`}
    <div class="turn-tools" role="group" aria-label="Turn actions"><button data-ui="undo" class="secondary-button turn-undo" ${!humanTurn() || !undoHistory.length ? "disabled" : ""} aria-keyshortcuts="${shortcutsEnabled ? "z " : ""}Control+z Meta+z" title="Undo your last move until the turn ends or you reload. Keyboard: ${shortcutsEnabled ? "Z, " : ""}Ctrl+Z or ⌘+Z.">↶ Undo</button>${goodsBonus ? `<button class="primary-button" data-ui="resume-bonus">${state.pending[0].kind === "ship" ? "Choose harbor" : "Choose cargo"} →</button>` : ""}${skip ? actionButton(skip) : ""}${end ? actionButton(end) : ""}${end && undoHistory.length ? '<small class="turn-finality">Ending your turn makes these moves final.</small>' : ""}${aiFailed ? `<button class="primary-button" data-ui="retry-ai">Retry ${escape(p.name)}</button>` : ""}${state.status === "finished" ? '<button class="primary-button" data-ui="results">View final scores</button>' : ""}</div>`;
  el("turn-controls").querySelector(".target-step")!.append(legalSection);
}
function renderStorage(): void {
  const p = state.players[inspected];
  el("storage").dataset.empty = String(p.storage.length === 0);
  el("storage").innerHTML =
    `<div class="small-section-heading"><h3>${inspected === 0 ? "Your reserve" : `${escape(p.name)}’s reserve`}</h3><span>${p.storage.length} / 3 tiles</span></div><div class="storage-slots">${Array.from(
      { length: 3 },
      (_, index) => {
        const tile = p.storage[index];
        return `<div class="storage-slot reserve-tile ${tile ? "filled" : ""}">${tile ? tileButton(tile, "storage") : `<span class="slot-outline" role="img" aria-label="Empty reserve slot ${index + 1}"></span>`}${tile ? `<span class="slot-label">${escape(tileLabel(tile))}</span>` : ""}${tile ? `<span class="reserve-benefit">${escape(tileBenefit(tile, state.ruleset))}</span>` : ""}</div>`;
      },
    ).join("")}</div>${state.status === "finished" || inspected !== 0 || p.storage.length === 3 ? `<p class="fine-print reserve-guidance">${state.status === "finished" ? "Game complete · Read-only reserve." : inspected !== 0 ? "Read-only reserve · Select You to build." : "Reserve full · Taking a tile requires a replacement."}</p>` : ""}`;
}
function renderResources(): void {
  const p = state.players[inspected];
  const finished = state.status === "finished";
  el("resources").innerHTML =
    `<div class="resource" data-resource="silver" title="Spend 2 silver on one tile purchase per turn. Mines supply silver between phases.">${resourceIcon("silver", 30)}<strong>${p.silver}</strong><span>Silver</span></div><div class="resource" data-resource="workers" title="Workers pay the exact adjustment cost shown on each legal choice.">${resourceIcon("workers", 30)}<strong>${p.workers}</strong><span>Workers</span></div><div class="resource" data-resource="ships" title="More ships improve turn order; most recent arrival breaks equal ship counts.">${resourceIcon("ships", 30)}<strong>${p.ships}</strong><span>Ships</span></div>`;
  el("goods").innerHTML =
    `<div class="small-section-heading"><h3>${inspected === 0 ? "Your goods" : `${escape(p.name)}’s goods`}</h3><span>${p.goods.filter(Boolean).length} types stored</span></div><div class="goods-stacks">${p.goods.map((count, index) => {
      if (!count) return "";
      const action = inspected === 0 ? matching("sell").find(a => a.good === index + 1) : undefined;
      const payout = saleReward(p, index + 1);
      const cost = action ? action.cost ? `Pay ${costText(action)}` : "No worker cost" : humanTurn() ? state.pending.length ? "Resolve bonus first" : p.dice.every(die => die === null) ? "Both dice spent" : "Not with this die" : "";
      return `<button class="good-stack stocked" data-good="${index + 1}" ${humanTurn() && inspected === 0 && action ? "" : "disabled"} title="${escape(`${GOODS[index]}: ${payout}${inspected === 0 && cost ? ` · ${cost}` : ""}`)}" aria-label="${escape(`${inspected === 0 ? finished ? "Your" : "Sell" : p.name + "’s"} type ${index + 1} goods, ${count} in storage, ${payout}${inspected === 0 && cost ? `, ${cost}` : ""}`)}">${cargoToken(index + 1, count, true)}</button>`;
    }).join("")}</div>${p.goods.some(Boolean) ? "" : `<p class="empty-goods-note">${finished ? "No goods stored." : "No goods stored. Build a ship to collect cargo."}</p>`}<p class="fine-print">${finished ? "Game complete — goods are read-only." : inspected === 0 ? "Click a stack to sell all of that type for points & silver." : "Read-only goods. Select You above the map to sell your goods."}</p>`;
  const sold = p.sold;
  const cargo = sold.flatMap((count, index) => Array(count).fill(index + 1));
  el("sold-goods-summary").textContent = `${inspected === 0 ? "Sold goods" : `${p.name}’s sold goods`} · ${sum(sold)} tiles, ${sold.filter(Boolean).length} types`;
  el("sold-goods-content").innerHTML = `<div class="sold-cargo">${cargo.length ? cargoManifest(cargo) : "No goods sold yet."}</div><p class="fine-print">${inspected === 0 ? "Your" : `${escape(p.name)}’s`} export history counts toward knowledge 15 and 25.</p>`;
}
function describeAction(a: Action): string {
  const die = a.die === undefined ? "" : `Die ${a.die + 1} · `;
  return `${die}${a.label}`;
}
function placementLocation(action: Action): string {
  const cells = boardFor(action.kind === "choose-estate" ? { boardId: action.boardId } : state.players[state.active]);
  const cell = cells[action.cell!];
  const rows = [...new Set(cells.map(cell => cell.r))].sort((a, b) => a - b);
  const row = cells.filter(other => other.r === cell.r).sort((a, b) => a.q - b.q);
  return `Row ${rows.indexOf(cell.r) + 1} · space ${row.findIndex(other => other.id === cell.id) + 1} · die ${cell.die}`;
}
function actionButton(a: Action, compact = false): string {
  const index = actions.indexOf(a);
  const cost =
    a.kind === "buy"
      ? "Pay 2 silver"
      : a.cost
        ? `${a.cost} worker${a.cost === 1 ? "" : "s"}`
        : "No worker cost";
  const goods = a.kind === "ship" ? a.depots!.flatMap(d => state.depots[d].goods) : a.kind === "goods" ? state.pending[0]?.kind === "goods" ? state.pending[0].depots.flatMap(d => state.depots[d].goods).filter(g => a.types?.includes(g)) : [] : undefined;
  const discarded = a.discard ? findTile(a.discard) : undefined;
  const preview = discarded && !compact ? `<span class="replacement-loss">Give up ${escape(tileName(discarded, state.ruleset))}: ${benefitMarkup(discarded)}</span>` : a.kind === "place" ? `<span class="action-location">${placementLocation(a)}</span>` : goods ? `<span class="action-goods">${goods.length ? cargoManifest(goods, false) : "No goods"}</span>` : a.kind === "sell" ? `<span class="action-payout">Earn ${saleReward(state.players[state.active], a.good!)}</span>` : "";
  const artwork = compact ? "" : discarded ? iconSvg(discarded, 36) : a.kind === "sell" ? goodsIcon(a.good!, 36) : a.kind === "workers" ? resourceIcon("workers", 32) : a.tile && findTile(a.tile) ? iconSvg(findTile(a.tile)!, 36) : "";
  let skipLabel = "";
  if (a.kind === "skip") {
    const pending = state.pending[0];
    skipLabel = pending.kind === "take"
      ? `Decline bonus ${pending.colors.map(color => color === "animal" ? "pasture" : color).join(" / ")} tile`
      : pending.kind === "place" ? "Decline City Hall placement" : "Decline Warehouse sale";
  }
  return `<button class="legal-action ${compact ? "compact" : ""} ${a.kind === "end" ? "end-turn" : ""} ${a.kind === "skip" ? "skip-action" : ""}" data-action="${index}" data-action-key="${escape(actionKey(a))}" ${a.kind === "end" && shortcutsEnabled ? 'aria-keyshortcuts="e" title="Keyboard shortcut: E"' : ""} ${humanTurn() || humanSetup() ? "" : "disabled"}>${artwork}<span>${escape(a.kind === "skip" ? skipLabel : a.kind === "sell" && !compact ? `${GOODS[a.good! - 1]} · ${describeAction(a)}` : describeAction(a))}${preview}</span><span class="action-cost ${a.cost ? "has-cost" : ""}">${a.kind === "end" || a.kind === "choose-estate" ? "→" : a.kind === "skip" ? "Optional · no dice spent" : a.die === undefined && !a.cost && a.kind !== "buy" ? "Free bonus" : cost}</span></button>`;
}
function renderChoices(): void {
  if (humanSetup()) {
    const sides = state.setup!.boards[0];
    setupPreview = sides.includes(setupPreview!) ? setupPreview : sides[0];
    const starts = actions.filter(a => a.boardId === setupPreview);
    setupCell = starts.some(a => a.cell === setupCell) ? setupCell : starts[0].cell;
    el("estate-setup").innerHTML = `<div class="estate-choice"><span class="step-label">Choose estate</span><div class="estate-sides" role="group" aria-label="Board side">${sides.map(id => `<button class="secondary-button" data-setup-board="${id}" aria-pressed="${id === setupPreview}">Estate #${id}</button>`).join("")}</div></div><div class="castle-choice"><label class="step-label" for="start-castle">Starting castle</label><select id="start-castle" data-setup-cell>${starts.map((a, index) => `<option value="${a.cell}" ${a.cell === setupCell ? "selected" : ""}>Castle ${index + 1} · ${placementLocation(a)}</option>`).join("")}</select></div><button class="primary-button estate-confirm" data-ui="confirm-estate">Confirm estate #${setupPreview} · Castle ${starts.findIndex(a => a.cell === setupCell) + 1}</button><div class="setup-notes"><p>Preview either side; choose a highlighted green hex or use the list, then confirm your estate. Your starting castle grants no action or points.</p><p>${state.setup!.mode === "secret" ? "Choices stay hidden until everyone is ready." : "Choose openly in starting turn order."}</p></div>`;
    if (inspected === 0) {
      board.render({ ...state.players[0], boardId: setupPreview }, starts.map(a => a.cell!), true, setupCell);
      el("choices").innerHTML = "";
      return;
    }
  }
  const placements = mode === "place" && selectedTile ? matching("place", selectedTile) : [];
  el("choices").dataset.buildable = String(placements.length > 0);
  board.render(state.players[inspected], inspected === 0 ? placements.flatMap(a => a.cell === undefined ? [] : [a.cell]) : [], humanTurn() && inspected === 0, lastPlaced, new Map(placements.flatMap(a => a.cell === undefined ? [] : [[a.cell, a.cost]])), regionCell === undefined ? undefined : boardFor(state.players[inspected])[regionCell].region);
  if (!humanTurn() || inspected !== 0) {
    el("choices").innerHTML = "";
    return;
  }
  const tile = selectedTile ? findTile(selectedTile) : undefined;
  const pending = state.pending[0];
  let content = "";
  if (tile && mode === "place") {
    const otherDie = actions.find(a => a.kind === "place" && a.tile === tile.id && a.die !== undefined && a.die !== selectedDie)?.die;
    const costs = placements.map(action => action.cost);
    const minCost = Math.min(...costs), maxCost = Math.max(...costs);
    const payment = maxCost === 0 ? "no workers" : `${minCost === maxCost ? minCost : `${minCost}–${maxCost}`} worker${maxCost === 1 ? "" : "s"}`;
    const buildHint = placements.length ? `Highlighted spaces: ${placements[0].die === undefined ? "no die" : `die ${placements[0].die + 1}`} · ${payment}. Choose a hex, or use Build in All legal choices for keyboard placement.` : "";
    content = `<div class="selected-tile-description"><span class="description-icon ${tile.color}">${iconSvg(tile, 25)}</span><div><strong>${escape(tileName(tile, state.ruleset))}</strong><p>${escape(tileDescription(tile, state.ruleset))}</p></div></div><p class="choice-hint">${placements.length ? buildHint : otherDie !== undefined ? "No spaces with the selected die. Your other die can build this tile. Switching dice spends nothing." : state.pending.length ? "This bonus cannot build that tile. Resolve the highlighted bonus first." : state.players[0].dice.every(d => d === null) ? "No dice left. Keep this tile for your next turn." : "No legal spaces yet. Build beside an existing tile, match its color and number, or gain workers."}</p>${!placements.length && otherDie !== undefined ? `<button class="secondary-button switch-build-die" data-die="${otherDie}">Use die ${otherDie + 1} · ${state.players[0].dice[otherDie]}</button>` : ""}`;
  }
  if (pending) content += `<div class="bonus-callout"><strong>${escape(pendingText())}</strong><p>No die is needed. Complete this before your next regular move.</p></div>`;
  el("choices").innerHTML = content ? `<h3 id="choices-title">${pending ? "Your bonus" : tile && mode === "place" ? `Selected · ${escape(tileName(tile, state.ruleset))}` : "Tile details"}</h3>${content}` : "";
}
function showActionChoices(title: string, description: string, choices: Action[]): void {
  void audio.play("open");
  choiceDialog = true;
  openModal(`${modalHeading("CHOOSE YOUR MOVE", title)}<p class="results-intro">${escape(description)}</p><div class="modal-action-choices">${choices.map(a => actionButton(a)).join("")}</div><button class="secondary-button" data-ui="close">Back to table</button>`);
}
function showPendingChoice(): void {
  const pending = state.pending[0];
  if (!humanTurn() || !pending || !["ship", "goods"].includes(pending.kind)) return;
  const p = state.players[0];
  const stored = p.goods.flatMap((count, i) => Array(count).fill(i + 1) as number[]);
  const choices = actions.filter(a => a.kind === pending.kind);
  const previews = choices.map(action => {
    const source = action.kind === "ship" ? action.depots! : pending.kind === "goods" ? pending.depots : [];
    const goods = source.flatMap(d => state.depots[d].goods);
    const loads = action.kind === "ship" ? legalActions(applyAction(state, action)).filter(a => a.kind === "goods") : [action];
    const loadable = goods.filter(g => loads.some(a => a.types?.includes(g)));
    return { action, goods, loadable, loads };
  });
  const productive = previews.filter(p => p.loadable.length > 0);
  const quiet = previews.filter(p => p.loadable.length === 0);
  const card = ({ action, goods, loadable, loads }: typeof previews[number]) => {
    const title = action.kind === "ship" ? `Harbor ${action.depots!.map(d => d + 1).join(" + ")}` : `Load ${[...new Set(loadable)].map(g => GOODS[g - 1]).join(" & ")}`;
    const count = loads.length === 1 ? loadable.length : Math.max(...loads.map(a => goods.filter(g => a.types?.includes(g)).length));
    const needsChoice = action.kind === "ship" && loads.length > 1;
    const room = 3 - p.goods.filter(Boolean).length;
    const capacity = needsChoice ? `Choose ${room} new type${room === 1 ? "" : "s"}; the rest stays here.` : "";
    const left = !needsChoice ? goods.filter(g => !loadable.includes(g)) : [];
    const leftText = left.length ? `Left behind: ${[...new Set(left)].map(g => `${GOODS[g - 1]} ×${left.filter(type => type === g).length}`).join(" · ")}` : "";
    return `<button class="harbor-card" data-action="${actions.indexOf(action)}" data-action-key="${escape(actionKey(action))}" aria-label="${escape(action.label)}. ${escape(title)}. ${needsChoice ? `Choose cargo. Up to ${count} goods. ${capacity}` : `Collect ${count} goods`}${leftText ? `. ${escape(leftText)}` : ""}"><span class="harbor-card-heading"><span class="harbor-seal">${action.kind === "ship" ? iconSvg({ color: "ship" }, 30) : resourceIcon("silver", 28)}</span><strong>${escape(title)}</strong><span class="cargo-total">${needsChoice ? "Up to " : ""}${count} goods</span></span><span class="cargo-manifest">${cargoManifest(loadable)}</span>${leftText ? `<span class="cargo-left">${escape(leftText)}</span>` : ""}${capacity ? `<span class="cargo-capacity">${capacity}</span>` : ""}<span class="harbor-card-footer">${needsChoice ? "Choose your cargo" : `Collect ${count} goods`}<span aria-hidden="true">→</span></span></button>`;
  };
  const empty = productive.length ? "" : `<div class="empty-harbor"><strong>${pending.kind === "ship" ? "No cargo can be collected" : "Your hold is full"}</strong><p>${previews.some(p => p.goods.length) ? "Your three trade-good slots are occupied. Sell a type on a later action to make room." : "The quays are empty. Your ship still improves your place in the turn order."}</p>${choices[0] ? `<button class="primary-button" data-action="${actions.indexOf(choices[0])}" data-action-key="${escape(actionKey(choices[0]))}">Continue without cargo →</button>` : ""}</div>`;
  choiceDialog = true;
  openModal(`<div class="harbor-scene" aria-hidden="true">${harborScene()}</div>${modalHeading("THE MERCHANT VOYAGE", pending.kind === "ship" ? "Choose a harbor" : "Choose your cargo")}<p class="harbor-intro">${pending.kind === "ship" ? "Sail to a stocked quay. If everything fits, your crew loads it in one click." : "Your hold has room for three types. Choose what to bring home; the rest stays on the quay."}</p><div class="ship-hold"><div><strong>Your cargo hold</strong><span>${p.goods.filter(Boolean).length} / 3 types stored</span></div><div class="hold-cargo">${stored.length ? cargoManifest(stored) : '<span class="empty-hold">Empty hold — room for three types</span>'}</div></div><div class="harbor-grid">${productive.map(card).join("")}</div>${empty}${productive.length && quiet.length && pending.kind === "ship" ? `<p class="quiet-harbors">No cargo to load: ${quiet.map(p => `Harbor ${p.action.depots!.map(d => d + 1).join(" + ")}`).join(" · ")}</p>` : ""}<button class="text-button" data-ui="close">Back to table · bonus stays pending</button>`, "harbor-dialog");
}
function chooseTile(id: string, source: string): void {
  selectedCell = null;
  selectedGood = null;
  if (source === "storage") {
    selectedTile = id;
    mode = "place";
    inspected = 0;
    setPanel("estate");
    render();
    revealBoard();
    return;
  }
  const kind = source === "black" ? "buy" : mode === "buy" || mode === "trade" ? mode : "take";
  const choices = matching(kind, id);
  if (choices.length === 1) execute(choices[0]);
  else if (choices.length) showActionChoices("Your reserve is full", `Taking ${tileName(findTile(id)!, state.ruleset)} replaces one reserved tile. Choose which tile to give up, or go back to keep everything.`, choices);
}
function revealBoard(): void {
  if (!mobileLayout.matches) return;
  requestAnimationFrame(() => {
    const map = document.querySelector<HTMLElement>(".map-sheet")!;
    const bounds = map.getBoundingClientRect();
    if (bounds.bottom > innerHeight || bounds.top < 12)
      window.scrollTo({ top: Math.max(0, scrollY + bounds.top - 12), behavior: "instant" });
  });
}
function revealMarket(): void {
  if (!mobileLayout.matches) return;
  requestAnimationFrame(() => {
    const top = document.querySelector<HTMLElement>(".market-column")!.getBoundingClientRect().top;
    if (top < 12 || top > innerHeight - 180)
      window.scrollTo({ top: Math.max(0, scrollY + top - 12), behavior: "instant" });
  });
}
function findTile(id: string): Tile | undefined {
  return [
    ...state.players.flatMap((p) => [
      ...p.storage,
      ...p.board.filter((t): t is Tile => t !== null),
    ]),
    ...state.depots.flatMap((d) => d.tiles),
    ...state.black,
  ].find((t) => t.id === id);
}
function renderEstate(): void {
  const p = state.players[inspected];
  const BOARD = boardFor(p);
  el("estate-title").textContent = `${estateTitle(inspected)}${p.boardId && p.boardId !== 1 ? ` · #${p.boardId}` : ""}`;
  el("estate-view-status").hidden = inspected === 0;
  el("estate-scoring-title").textContent = inspected === 0 ? "Estate scoring" : `${p.name}’s scoring`;
  el("color-ledger").querySelector(".estate-section-heading span")!.textContent = `First +${state.players.length + 3} · Second +${state.players.length} VP`;
  const switcher = document.querySelector<HTMLElement>(".estate-switch")!;
  if (switcher.childElementCount !== state.players.length)
    switcher.innerHTML = state.players.map((player, who) => `<button data-view="${who}">${escape(player.name)}</button>`).join("");
  document
    .querySelectorAll<HTMLButtonElement>("[data-view]")
    .forEach((button) =>
      button.setAttribute(
        "aria-pressed",
        String(Number(button.dataset.view) === inspected),
      ),
    );
  const expandedColors = new Set(Array.from(el("legend").querySelectorAll<HTMLDetailsElement>("details[open]"), item => item.dataset.colorProgress));
  el("legend").innerHTML = COLORS.map((color) => {
    const cells = BOARD.filter((cell) => cell.color === color);
    const filled = cells.filter((cell) => p.board[cell.id]).length;
    const claimed = state.claimed[color];
    const rewards = [state.players.length + 3, state.players.length].map((points, index) => {
      const owner = claimed[index];
      return {
        text: `${index === 0 ? "1st" : "2nd"} +${points} VP: ${owner === undefined ? "unclaimed" : state.players[owner].name}`,
        short: `${index === 0 ? "First" : "Second"} +${points} · ${owner === undefined ? state.status === "finished" ? "unclaimed" : "available" : escape(state.players[owner].name)}`,
        claimed: owner !== undefined,
      };
    });
    const nextReward = claimed.includes(inspected) ? "Color bonus already earned" : state.status === "finished" ? "Game complete · No color bonus earned" : claimed.length === 0 ? `+${state.players.length + 3} VP available` : claimed.length === 1 ? `+${state.players.length} VP available` : "Both claimed · No color bonus";
    const detail = `${PALETTE[color].name} · ${p.name}: ${filled} of ${cells.length} settled. ${nextReward}. ${rewards.map((reward) => reward.text).join(". ")}.`;
    return `<details class="legend-item" data-color-progress="${color}"${expandedColors.has(color) ? " open" : ""}><summary data-color-summary="${color}" aria-label="${escape(detail)}"><i class="color-swatch" style="--swatch:${PALETTE[color].fill}" aria-hidden="true"></i><span>${PALETTE[color].name}</span><b>${filled}/${cells.length}</b></summary><div class="color-rewards"><span class="bonus-available">${nextReward}</span>${rewards.map((reward) => `<span class="${reward.claimed ? "claimed" : ""}">${reward.short}</span>`).join("")}</div></details>`;
  }).join("");
  const ids = knowledgeIds(p);
  el("estate-knowledge").hidden = ids.length === 0;
  el("estate-knowledge").innerHTML =
    `${ids.length ? `<h3 id="advantages-title">${inspected === 0 ? "Your advantages" : `${escape(p.name)}’s advantages`}</h3>` + ids.map((id) => `<button class="knowledge-tag" data-knowledge="${id}" title="${escape(`Knowledge ${id} · ${knowledgeInfo(id, state.ruleset)?.name}: ${knowledgeInfo(id, state.ruleset)?.description}`)}">${iconSvg({color:"knowledge"},22)} ${escape(tileBenefit({id:"",color:"knowledge",knowledge:id}, state.ruleset))}</button>`).join("") : ""}`;
  renderRegionInsight();
  const earlier = el("journal").querySelector<HTMLDetailsElement>("details")?.open;
  const entries = state.log.slice().reverse().map((text, index) =>
    `<li class="${index === 0 ? "latest" : ""}"><span class="journal-mark">${index === 0 ? "✦" : "·"}</span><span>${escape(text.replace(/ · hex \d+(?: \(\d+\))?|, castle hex \d+/g, ""))}</span></li>`);
  el("journal").innerHTML = entries.slice(0, 4).join("") + (entries.length > 4 ? `<li class="earlier-moves"><details${earlier ? " open" : ""}><summary>Earlier moves (${entries.length - 4})</summary><ol>${entries.slice(4).join("")}</ol></details></li>` : "");
}
function renderRegionInsight(): void {
  const p = state.players[inspected];
  const BOARD = boardFor(p);
  const finished = state.status === "finished";
  const regions = [...new Map(BOARD.map(c => [c.region, c])).values()]
    .map(c => ({cell:c, ...regionOutcome(p, c.id, state.phase)}))
    .filter(r => r.remaining > 0 && r.remaining < r.size)
    .sort((a,b) => a.remaining-b.remaining || b.points-a.points);
  document.querySelector<HTMLElement>(".region-panel")!.hidden = regions.length === 0 && regionCell === undefined;
  el("region-insight").innerHTML = regions.length ? `<h4 class="region-heading">${finished ? "Incomplete regions" : "Next region rewards"}</h4>${regions.slice(0,3).map(r => `<button class="region-reward" data-region-cell="${r.cell.id}" aria-controls="board region-detail" aria-pressed="${regionCell !== undefined && BOARD[regionCell].region === r.region}">${iconSvg({color:r.cell.color},24)}<span>${PALETTE[r.cell.color].name}<strong>${finished ? `${r.remaining} unfilled` : `${r.remaining} left · +${r.points} VP`}</strong><small>Region ${r.region + 1}</small></span></button>`).join("")}` : "";
  el("region-detail").hidden = regionCell === undefined;
  if (regionCell === undefined) el("region-detail").textContent = "";
  else {
    const r = regionOutcome(p, regionCell, state.phase);
    el("region-detail").textContent = `${PALETTE[BOARD[regionCell].color].name} region · ${r.size-r.remaining}/${r.size} filled. ${r.remaining ? finished ? "Game complete — no region points awarded." : `Fill ${r.remaining} remaining hex${r.remaining===1?"":"es"} for +${r.points} VP (${r.base} for size + ${r.timing} this phase).` : "Completed — points already awarded."}`;
  }
}
function render(newReceipt = false): void {
  const focused = document.activeElement as HTMLElement | null;
  const focusKey = focused?.dataset.actionKey;
  const focusDie = focused?.dataset.die;
  const focusMode = focused?.dataset.mode;
  const focusTile = focused?.dataset.tile;
  const focusView = focused?.dataset.view;
  const focusGood = focused?.dataset.good;
  const focusUI = focused?.dataset.ui;
  const wasLegalList = Boolean(focused?.closest("#legal-actions"));
  actions = legalActions(state);
  root.dataset.players = String(state.players.length);
  root.dataset.status = state.status;
  document.querySelector(".table-footer > span:last-child")!.textContent = `Estate ${state.players[inspected].boardId ?? 1} · ${state.players.length}-player game · ${rulesFor(state).label} · ${tableSaved ? "Saved on this device" : "Not saved · keep this tab open"}`;
  if (humanSetup()) setPanel("estate");
  setPanel(panel);
  el("notice").textContent = notice;
  el("notice").hidden = !notice;
  if (newReceipt || el("feedback").dataset.message !== feedback) {
    delete el("feedback").dataset.presented;
    clearWorkerSpend();
    el("feedback").textContent = feedback;
    el("feedback").dataset.message = feedback;
    if (feedback) el("announcer").textContent = `${feedback} ${state.status === "finished" ? "Game complete." : humanTurn() ? "Your turn." : `${state.players[state.active].name} is playing.`}`;
  }
  el("feedback").hidden = !feedback || el("feedback").dataset.presented === feedback;
  if (feedback && (newReceipt || feedback !== lastFeedback)) {
    lastFeedback = feedback;
    clearTimeout(feedbackTimer);
    feedbackTimer = setTimeout(() => {
      feedback = "";
      lastFeedback = "";
      el("feedback").hidden = true;
    }, 6500);
  }
  renderSeason();
  renderScores();
  renderControls();
  renderMarket();
  renderStorage();
  renderResources();
  renderEstate();
  renderChoices();
  el("legal-count").textContent = `(${actions.length})`;
  const legalMessage = state.status === "finished"
    ? "<p>Game complete. No choices remain.</p>"
    : !humanTurn() && !humanSetup()
      ? `<p>Waiting for ${escape(state.players[state.active].name)}. Choices are disabled until your turn.</p>`
      : actions.length ? "" : "<p>No legal choices are available.</p>";
  el("legal-actions").innerHTML = legalMessage +
    [...new Set(actions.map(action => action.kind))].map(kind => {
      const group = actions.filter(action => action.kind === kind);
      return `<section class="legal-group" aria-labelledby="legal-${kind}"><h4 id="legal-${kind}" class="legal-group-title">${modeName(kind)} <span>${group.length}</span></h4><div class="legal-group-actions">${group.map(action => actionButton(action, true)).join("")}</div></section>`;
    }).join("");
  if (focusKey) {
    const match = Array.from(
      document.querySelectorAll<HTMLButtonElement>(
        wasLegalList ? "#legal-actions [data-action-key]" : "[data-action-key]",
      ),
    ).find((b) => b.dataset.actionKey === focusKey && !b.disabled);
    const fallback = document.querySelector<HTMLButtonElement>(
      wasLegalList
        ? "#legal-actions button:not(:disabled)"
        : "[data-die]:not(:disabled)",
    );
    (match ?? fallback)?.focus({ preventScroll: true });
  } else if (focusDie !== undefined)
    document
      .querySelector<HTMLButtonElement>(
        `[data-die="${focusDie}"]:not(:disabled)`,
      )
      ?.focus({ preventScroll: true });
  else if (focusMode)
    document
      .querySelector<HTMLButtonElement>(
        `[data-mode="${focusMode}"]:not(:disabled)${newReceipt ? ':not([aria-disabled="true"])' : ""}`,
      )
      ?.focus({ preventScroll: true });
  else if (focusTile)
    Array.from(document.querySelectorAll<HTMLButtonElement>("[data-tile]"))
      .find((b) => b.dataset.tile === focusTile && !b.disabled)
      ?.focus({ preventScroll: true });
  else if (focusView !== undefined)
    document
      .querySelector<HTMLButtonElement>(`[data-view="${focusView}"]`)
      ?.focus({ preventScroll: true });
  else if (focusGood)
    document
      .querySelector<HTMLButtonElement>(
        `[data-good="${focusGood}"]:not(:disabled)`,
      )
      ?.focus({ preventScroll: true });
  else if (focusUI)
    document.querySelector<HTMLButtonElement>(`[data-ui="${focusUI}"]:not(:disabled)`)?.focus({ preventScroll: true });
  // A direct move may remove its originating tile. Keep keyboard focus at the
  // remaining die/end-turn control instead of dropping back to the document.
  if ((focusTile || focusDie !== undefined || focusMode || focusGood || focusKey || focusUI === "undo") &&
      (document.activeElement === document.body || !document.activeElement?.isConnected)) {
    const nextControl = document.querySelector<HTMLButtonElement>('#turn-controls .turn-tools .end-turn:not(:disabled)')
      ?? document.querySelector<HTMLButtonElement>('#turn-controls .die-button:not(:disabled)')
      ?? document.querySelector<HTMLButtonElement>('#turn-controls button:not(:disabled):not([aria-disabled="true"])');
    (nextControl ?? el("turn-controls")).focus({ preventScroll: true });
  }
  if (state.status === "finished" && !endShown) {
    endShown = true;
    showResults();
  }
  fitDesktopTable();
}
function execute(requested: Action): void {
  if (!humanTurn() && !humanSetup()) return;
  commit(requested);
}
function commit(requested: Action): void {
  try {
    const current = legalActions(state).find(
      (a) => actionKey(a) === actionKey(requested),
    );
    if (!current)
      throw new Error(
        "This choice is no longer available. Please choose again.",
      );
    const previous = state;
    let next = applyAction(state, current);
    // Loading a single legal cargo manifest is not a decision. Bundle it with
    // the harbor click and its undo step; never auto-pick between alternatives.
    let loaded = "";
    if (previous.active === 0 && current.kind === "ship") {
      const loads = legalActions(next).filter(a => a.kind === "goods");
      if (loads.length === 1) {
        next = applyAction(next, loads[0]);
        loaded = loads[0].types?.length ? ` Loaded ${loads[0].types.map(g => GOODS[g - 1]).join(", ")}.` : " No cargo collected.";
      }
    }
    // Capture origins before replacing the DOM; play only the committed delta.
    const motionPlan = motionForAction(previous, current, next);
    const motionOrigin = motion.capture(motionPlan, current, inspected);
    motion.cancel();
    state = next;
    clearWorkerSpend();
    if (previous.active === 0 && current.kind !== "end" && current.kind !== "choose-estate") undoHistory.push({ state: previous, label: current.label });
    else undoHistory = [];
    if (choiceDialog && dialog.open) dialog.close();
    choiceDialog = false;
    const earned = state.players[previous.active].score - previous.players[previous.active].score;
    feedback = `${previous.players[previous.active].name}: ${current.label}.`;
    feedback += loaded;
    if (earned > 0 && current.kind !== "sell") feedback += ` +${earned} VP.`;
    if (motionPlan.silver.length) feedback += " " + motionPlan.silver.map(gain =>
      `${gain.player === previous.active ? "" : `${state.players[gain.player].name}: `}+${gain.amount} silver${gain.source === "mines" ? " from mines" : ""}.`).join(" ");
    if (current.cost) feedback += ` Used ${current.cost} worker${current.cost === 1 ? "" : "s"}.`;
    if (previous.active === 0 && ["take", "buy", "trade"].includes(current.kind)) feedback += " Added to your reserve.";
    if (previous.status === "setup" && state.status === "setup" && state.setup?.mode === "secret")
      feedback = `${previous.players[previous.active].name} chose an estate privately.`;
    lastPlaced = current.kind === "place" && previous.active === inspected ? current.cell : undefined;
    actions = legalActions(state);
    resetSelection();
    if (previous.active !== 0 && humanTurn()) {
      inspected = 0;
      regionCell = undefined;
    }
    // After taking, reveal what the next die can build; never spend it implicitly.
    if (previous.active === 0 && ["take", "buy", "trade"].includes(current.kind) && !state.pending.length &&
        actions.some(a => a.kind === "place" && a.tile === current.tile && a.die === selectedDie)) {
      selectedTile = current.tile!;
      mode = "place";
      inspected = 0;
      setPanel("estate");
    }
    if (state.pending[0]?.kind === "take") setPanel("market");
    if (state.pending[0]?.kind === "place") {
      mode = "place";
      setPanel("estate");
    }
    persist();
    if (motionPlan.roll && mobileLayout.matches && !motion.reduced) setPanel("estate");
    render(true);
    if (previous.active === 0 && current.cost > 0)
      animateWorkerSpend(current.cost, previous.players[0].workers, state.players[0].workers);
    if (mode === "place" && selectedTile && previous.active === 0) revealBoard();
    if (motionPlan.roll && !motion.reduced) revealBoard();
    motion.play(motionPlan, previous, state, motionOrigin, inspected);
    audio.playAction(previous, current, state, {
      diceDelay: motion.reduced ? 0 : (rollLeadIn(motionPlan) + MOTION.diceLanding) / 1000,
      silverDelay: motion.reduced ? 0 : (rewardLeadIn(motionPlan, false) + MOTION.flight) / 1000,
    });
    // Rivals wait for the actual reading beat, not a timer that cuts it short.
    // Human controls remain immediate and can dismiss an unfinished effect.
    aiNotBefore = performance.now() + motionReadingTime(motionPlan, motion.reduced);
    showPendingChoice();
    scheduleAI();
  } catch (error) {
    notice =
      error instanceof Error
        ? error.message
        : "The table could not complete that choice.";
    aiFailed = state.active !== 0;
    void audio.play("error");
    render();
  }
}
function scheduleAI(): void {
  clearTimeout(aiTimer);
  if (state.status === "finished" || state.active === 0 || aiFailed || document.hidden) return;
  aiTimer = setTimeout(() => {
    // Lazy GPU preparation can start the toss after the estimated deadline.
    // Do not let a rival cut off the actual roll or its goods result.
    if (dialog.open || motion.reading) {
      scheduleAI();
      return;
    }
    try {
      commit(chooseAction(state));
    } catch (error) {
      aiFailed = true;
      notice = `${state.players[state.active].name} paused: ${error instanceof Error ? error.message : "Unable to choose a move"}`;
      render();
    }
  }, Math.max(350, aiNotBefore - performance.now()));
}
function openModal(content: string, theme = ""): void {
  if (dialog.querySelector("[data-counting]")) motion.cancel();
  if (!dialog.open) {
    const active = document.activeElement;
    modalOpener = active instanceof HTMLElement && active !== document.body && !dialog.contains(active) ? active : null;
  }
  dialog.className = theme;
  el("modal-content").innerHTML = content;
  if (!dialog.open) dialog.showModal();
  motion.observeHarbor(dialog.querySelector(".harbor-scene"));
  dialog.querySelector<HTMLElement>("button")?.focus();
}
function modalHeading(kicker: string, title: string): string {
  return `<div class="modal-heading"><div><span class="eyebrow">${kicker}</span><h2 id="modal-title">${title}</h2></div><button data-ui="close" class="close-button" aria-label="Close dialog">×</button></div>`;
}
function ruleSummary(ruleset: GameOptions["ruleset"]): string {
  const rules = rulesFor({ ruleset });
  return `<p><strong>Knowledge 6:</strong> ${rules.knowledge6 === "worker-building" ? "Once per turn, take a numbered-depot building for 2 workers without a die; separate from the silver purchase." : "Your once-per-turn 2-silver purchase may come from any depot."}</p><p><strong>Knowledge 15:</strong> ${rules.soldTypePoints} VP per sold goods type. <strong>Knowledge 26:</strong> ${rules.colorBonusPoints} VP per color bonus.</p><p><strong>Tied scores:</strong> ${rules.tieBreak === "most-empty" ? "Most" : "Fewest"} empty estate spaces, then later on the final turn-order track.</p><p class="fine-print">These options change only knowledge 6, 15, 26 and tied scores. Both use the existing estates #1–9 and setup choices, without expansions or Special Edition's extra boards.</p>`;
}
function scoringGuide(): string {
  // Derive the reference from this estate's regions, not a second rules table.
  const BOARD = boardFor(state.players[inspected]);
  const sizes = [...new Map(BOARD.map(cell => {
    const outcome = regionOutcome(state.players[inspected], cell.id, state.phase);
    return [outcome.size, outcome.base];
  })).entries()].sort(([a], [b]) => a - b);
  return `<section id="guide-scoring" tabindex="-1" aria-labelledby="scoring-title"><h3 id="scoring-title" class="guide-section-title">Scoring your estate</h3><p>Fill every hex in a connected region of the same color to score its size points plus the current phase bonus. Each region scores once, when completed.</p><dl class="scoring-sizes" aria-label="Region size points">${sizes.map(([size, points]) => `<div><dt>${size} hex${size === 1 ? "" : "es"}</dt><dd>${points} VP</dd></div>`).join("")}</dl><p><strong>Phase bonus:</strong> A +10 · B +8 · C +6 · D +4 · E +2 VP. This phase (${"ABCDE"[state.phase]}) adds ${10 - state.phase * 2} VP to the size points.</p><p><strong>Color bonuses:</strong> completing every hex of one color across the estate earns the first player +${state.players.length + 3} VP and the second player +${state.players.length} VP, in addition to region points. Later finishers receive no color bonus.</p><p>On the table, region reward buttons appear once a region is partly settled. Select one to outline its hexes and preview its total points.</p><p><strong>Selling goods:</strong> each tile sold earns ${state.players.length} VP in this ${state.players.length}-player game. Selling an entire type earns one silver, not one per tile, before knowledge bonuses.</p><p><strong>Final ledger:</strong> after the last mine income, each unsold good and silver earns 1 VP; each pair of workers earns 1 VP. Scoring knowledge counts only tiles built in the estate. Reserved tiles earn nothing.</p><p><strong>Ties:</strong> most points wins; if tied, ${rulesFor(state).tieBreak === "most-empty" ? "most" : "fewest"} empty estate spaces wins, then the player later on the final turn-order track. ${rulesFor(state).tieBreak === "most-empty" ? "This follows the original German 2011 rule." : "This follows the supplied Special Edition rulebook."}</p><p><strong>New games:</strong> choose two to four players. Standard setup uses estate #1 and its center castle. Advanced setup deals a random two-sided board: choose a side and any castle space, either openly in starting order or privately until everyone has chosen.</p></section>`;
}
function showHelp(knowledge?: number): void {
  choiceDialog = false;
  const entries = Object.keys(KNOWLEDGE).map(id => [id, knowledgeInfo(Number(id), state.ruleset)] as const).filter(
    ([id]) => knowledge === undefined || Number(id) === knowledge,
  );
  openModal(
    `${modalHeading("NOTES", knowledge === undefined ? "A field guide to your estate" : "An acquired advantage")}<div class="guide-content">${
      knowledge === undefined
        ? `<p class="guide-intro">Make a small domain into a thriving estate. Your two dice open the possibilities; the most valuable choice is yours.</p><div class="guide-steps"><section><b>01</b><h3>Take & build</h3><p>A die is selected for you; click the other die to switch. Click a tile in a numbered depot to spend that die and move it into your reserve. Selecting a reserved tile spends nothing; click a highlighted hex to build it immediately. Taking and building normally use one die each. New tiles must touch your estate and match the hex color.</p></section><section><b>02</b><h3>Make a die work</h3><p>Workers are spent automatically when you need to adjust a die. A brief animation shows the workers spent and your remaining supply. Hover a tile or use All legal choices to check its cost first. Adjustments wrap between 1 and 6. Click Take 2 workers to trade a die for flexibility. Hover a highlighted build space or open its placement list to see the exact worker cost.</p></section><section><b>03</b><h3>Trade & prosper</h3><p>Click a stocked goods stack to sell that entire type for points and silver. Click a black-market tile to buy it for 2 silver without using a die, once per turn. A full reserve opens a replacement choice before anything changes.</p></section><section><b>04</b><h3>Finish the story</h3><p>Complete regions early for larger bonuses. Resolve tile bonuses, then click End turn in the toolbar. Undo corrects a move until you end your turn (or reload). After phase E, goods, silver, workers and knowledge add to the final score.</p></section></div><h3 class="guide-section-title">The merchant goods</h3><p class="guide-accessibility">Silk (1), Spices (2), Ceramics (3), Dyes (4), Copperware (5) and Wool (6) are visual identities for the six original goods types. The medieval trade theme does not change scoring or dice rules. A stocked harbor loads automatically when there is only one legal cargo choice; Undo restores the entire voyage.</p><h3 class="guide-section-title">A language of six colors</h3><p class="guide-accessibility">Empty land shows its terrain texture and required die. Illustrated tiles are settled land; their counts stay inside the hex. Inset burgundy outlines mark legal placements, and Estate scoring identifies every color.</p><div class="color-guide">${COLORS.map(
            (color) => {
              const samples: Record<string, Tile> = {
                castle: { id: "", color: "castle" },
                ship: { id: "", color: "ship" },
                animal: { id: "", color: "animal", animal: "sheep", count: 2 },
                mine: { id: "", color: "mine" },
                knowledge: { id: "", color: "knowledge", knowledge: 1 },
                building: { id: "", color: "building", building: "watchtower" },
              };
              const t = samples[color];
              return `<div><span class="description-icon ${color}">${iconSvg(t, 26)}</span><p><strong>${COLOR_NAMES[color]} · ${PALETTE[color].name}</strong><span>${escape(color === "knowledge" ? "Permanent abilities or end-game scoring; see the numbered notes below." : color === "building" ? "Each building has its own one-time benefit. Hover a tile for details." : tileDescription(t, state.ruleset))}</span></p></div>`;
            },
          ).join(
            "",
          )}</div><section class="guide-accessibility" aria-labelledby="keyboard-title"><h3 id="keyboard-title">Keyboard shortcuts</h3><p>Tab through controls; Enter or Space selects. “All legal choices” includes every canvas placement and every bonus or replacement. Escape closes dialogs.</p><p>${Object.entries(ACTION_KEYS).map(([kind, key]) => `<kbd>${key}</kbd> ${kind === "workers" ? "Take workers" : modeName(kind as ActionKind)}`).join(" · ")}<br><kbd>E</kbd> End turn · <kbd>Z</kbd> Undo · <kbd>Ctrl+Z</kbd> / <kbd>⌘+Z</kbd> Undo</p><p>Shortcuts use the selected die and only available actions. They pause while typing or while a dialog is open.</p><button class="secondary-button" data-ui="shortcuts" aria-pressed="${shortcutsEnabled}">Single-key shortcuts <span aria-hidden="true">${shortcutsEnabled ? "On" : "Off"}</span></button><p>Turn off single-key shortcuts to avoid conflicts with speech input or assistive technology. Ctrl+Z and ⌘+Z remain available.</p></section><h3 class="guide-section-title">The knowledge folio</h3>`
        : ""
    }<div class="knowledge-folio">${entries.map(([id, k]) => `<section><span class="folio-number">${id}</span><div><h3>${escape(k.name)}</h3><p>${escape(k.description)}</p></div></section>`).join("")}</div></div>`,
  );
  if (knowledge === undefined) {
    dialog.querySelector(".guide-steps")!.insertAdjacentHTML("afterend", `<section id="guide-table" class="rules-reference" aria-label="Table reference"><h3>Rounds & phases</h3><p>Each phase has five rounds. After everyone finishes the fifth round, mines pay income. For the next phase, tiles refresh and uncollected depot goods remain. After phase E, final mine income is followed by final scoring.</p><h3>Inspecting estates</h3><p>Use the name buttons above the map to inspect estates. Other estates are read-only; select You to return and build on your estate.</p></section><section class="rules-reference" aria-label="Current rules"><h3>Rules: ${rulesFor(state).label}</h3>${ruleSummary(state.ruleset)}</section>${scoringGuide()}`);
    dialog.querySelector(".guide-content")!.insertAdjacentHTML("beforeend", `<p class="guide-accessibility">Sound effects follow your moves and the other estates. Use the speaker button at the top to mute them; your preference is saved on this device. <a href="${import.meta.env.BASE_URL}audio/ATTRIBUTION.txt" target="_blank" rel="noopener">Sound credits and licenses</a>.</p>`);
  }
}
function showResults(): void {
  const rules = rulesFor(state);
  const winner =
    state.winner === null
      ? "A shared legacy"
      : `${state.players[state.winner].name === "You" ? "Your" : `${state.players[state.winner].name}’s`} legacy endures`;
  const highestTotal = Math.max(...state.players.map(p => p.score));
  const categories = [
    {
      key: "estate", label: "Estate & trading", icon: iconSvg({ color: "castle" }, 24),
      values: state.players.map(p => p.score - sum(Object.values(p.final ?? {}))),
    },
    ...(["goods", "silver", "workers", "knowledge"] as const).map(key => ({
      key, label: key[0].toUpperCase() + key.slice(1),
      icon: key === "goods" ? goodsIcon(1, 24) : key === "knowledge" ? iconSvg({ color: "knowledge" }, 24) : resourceIcon(key, 24),
      values: state.players.map(p => p.final?.[key] ?? 0),
    })),
  ].map(category => {
    const highest = Math.max(...category.values);
    return { ...category, highest, tied: category.values.filter(value => value === highest).length > 1 };
  });
  const knowledgeDetails = state.players.map(player => {
    const entries = finalKnowledgeScores(player, state.ruleset);
    return entries.length ? `<h4 class="final-knowledge-title">Scoring knowledge</h4><dl class="final-knowledge">${entries.map(entry => `<div data-score-item="knowledge-${entry.knowledge}"><dt><span><strong>Knowledge ${entry.knowledge} · ${escape(knowledgeInfo(entry.knowledge, state.ruleset).name)}</strong><small>${escape(tileBenefit(player.board[entry.cell]!, state.ruleset))}</small></span></dt><dd>${entry.count} × ${entry.pointsPerUnit} = +${entry.points}</dd></div>`).join("")}</dl>` : "";
  });
  openModal(
    `<div data-final-scoring>${modalHeading("FIVE SEASONS, WELL SPENT", winner)}<p class="results-intro">Estate & trading is earned during play; + rows are final bonuses.</p><p class="final-scoring-status" role="status" aria-live="polite" aria-atomic="true">Final scoring complete. All bonuses are included.</p><div class="results-players">${state.players.map((p, index) => `<section class="result-player ${state.winner === index ? "winner" : ""}" aria-labelledby="result-name-${index}"><div class="result-status">${state.winner === index ? `<span class="winner-crown">${crownIcon()}</span>` : ""}<span class="eyebrow">${state.winner === index ? "THE VICTOR" : "A WORTHY RIVAL"}</span></div><h3 id="result-name-${index}">${escape(p.name)}</h3><div class="final-score ${p.score === highestTotal ? "score-leader" : ""}"><b data-final-total>${p.score}</b><span>victory points</span></div><dl>${categories.map(category => {
      const leading = category.values[index] === category.highest;
      return `<div data-score-item="${category.key}" class="${leading ? "score-leader" : ""}"><dt>${category.icon}<span>${category.label}</span></dt><dd>${leading ? `<span class="score-lead-label">${category.tied ? "Tied best" : "Best"}</span>` : ""}<span class="result-score-value">${category.key === "estate" ? "" : "+"}${category.values[index]}</span></dd></div>`;
    }).join("")}</dl>${knowledgeDetails[index]}</section>`).join("")}</div><p class="results-rules"><strong>Final bonuses:</strong> 1 VP per unsold good or silver, 1 VP per pair of workers, plus scoring knowledge built in the estate. Reserved tiles earn nothing.<br><strong>Tie order · ${rules.label}:</strong> most VP, then ${rules.tieBreak === "most-empty" ? "most" : "fewest"} empty estate spaces, then later on the final turn-order track.</p><div class="modal-actions"><button class="secondary-button" data-ui="skip-final-scoring" hidden>Show final totals</button><button class="secondary-button" data-ui="close">Inspect the estates</button><button class="primary-button" data-ui="new">Begin another legacy →</button></div></div>`,
  );
}
function confirmNew(): void {
  openModal(
    `${modalHeading("A FRESH BEGINNING", "Start a new estate?")}<p id="new-game-consequences" class="results-intro">The current table and its saved progress will be replaced. This cannot be undone.</p><div class="game-options"><label for="player-count">Players</label><select id="player-count"><option value="2">2 · You and The Steward</option><option value="3">3 · You and two rivals</option><option value="4">4 · You and three rivals</option></select><label for="estate-mode">Estate setup</label><select id="estate-mode" aria-describedby="estate-mode-summary"><option value="beginner">Standard · estate #1, center castle</option><option value="open">Advanced · open choices in turn order</option><option value="secret">Advanced · simultaneous private choices</option></select><p id="estate-mode-summary">Advanced setup deals one random double-sided board per player. Choose either side and any green castle space. Open choices follow starting turn order; private choices stay hidden until everyone is ready.</p><label for="ruleset">Rules</label><select id="ruleset" aria-describedby="rule-options-summary">${Object.entries(RULESETS).map(([id, rules]) => `<option value="${id}"${id === (state.ruleset ?? "original-2011") ? " selected" : ""}>${rules.label}</option>`).join("")}</select><div id="rule-options-summary" class="rule-options-summary" aria-live="polite">${ruleSummary(state.ruleset)}</div></div><div class="modal-actions"><button class="secondary-button" data-ui="close">Keep this table</button><button class="primary-button" data-ui="confirm-new" aria-describedby="new-game-consequences">Start new game →</button></div>`,
  );
}
root.addEventListener("change", (event) => {
  const target = event.target as HTMLSelectElement;
  if (target.id === "ruleset") {
    el("rule-options-summary").innerHTML = ruleSummary(target.value as GameOptions["ruleset"]);
    return;
  }
  if (target.matches("[data-setup-cell]") && humanSetup()) {
    setupCell = Number(target.value);
    renderChoices();
    document.querySelector<HTMLSelectElement>("[data-setup-cell]")?.focus({ preventScroll: true });
  }
});
const marketButton = (target: EventTarget | null) => target instanceof Element
  ? target.closest<HTMLButtonElement>(".tile-token[data-tile], .action-tab[data-action-hint]") : null;
root.addEventListener("pointerover", (event) => {
  const button = marketButton(event.target);
  if (button) showMarketTooltip(button);
  else if (el("market-tooltip").contains(event.target as Node)) clearTimeout(marketTooltipTimer);
});
root.addEventListener("pointerout", (event) => {
  if (!marketTooltipAnchor) return;
  const next = event.relatedTarget as Node | null;
  if (marketTooltipAnchor.contains(next) || el("market-tooltip").contains(next)) return;
  if (document.activeElement !== marketTooltipAnchor)
    marketTooltipTimer = setTimeout(hideMarketTooltip, 150);
});
root.addEventListener("focusin", (event) => {
  const legal = event.target instanceof Element ? event.target.closest<HTMLButtonElement>('#legal-actions [data-action]') : null;
  const placement = legal ? actions[Number(legal.dataset.action)] : undefined;
  if (placement?.kind === "place") {
    legal!.title = `${costText(placement)} · ${placementReward(placement)}`;
    el("announcer").textContent = legal!.title;
  }
  const button = marketButton(event.target);
  if (button) showMarketTooltip(button);
  else hideMarketTooltip();
});
root.addEventListener("focusout", (event) => {
  if (marketButton(event.target) === marketTooltipAnchor) hideMarketTooltip();
  const details = el("legal-details") as HTMLDetailsElement;
  if (event.relatedTarget instanceof Node && details.contains(event.target as Node) && !details.contains(event.relatedTarget)) details.open = false;
});
// Hover inspection also needs Escape when keyboard focus is outside the app.
document.addEventListener("pointerdown", () => {
  audio.unlock();
  if (motion.rolling) { motion.cancel(); audio.stop(); aiNotBefore = 0; scheduleAI(); }
}, true);
document.addEventListener("keydown", () => audio.unlock(), true);
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    const inspectedTile = marketTooltipAnchor !== null;
    if (motion.rolling) { motion.cancel(); audio.stop(); aiNotBefore = 0; scheduleAI(); }
    hideMarketTooltip();
    const estateMenu = document.querySelector<HTMLDetailsElement>(".estate-tools > details[open]");
    const tableDetails = el("table-details") as HTMLDetailsElement;
    if (!dialog.open && estateMenu) {
      estateMenu.open = false;
      estateMenu.querySelector<HTMLElement>("summary")?.focus({ preventScroll: true });
      event.preventDefault();
      return;
    }
    if (!dialog.open && tableDetails.open) {
      tableDetails.open = false;
      tableDetails.querySelector<HTMLElement>("summary")?.focus({ preventScroll: true });
      event.preventDefault();
      return;
    }
    if (!dialog.open && !inspectedTile && (el("legal-details") as HTMLDetailsElement).open) {
      (el("legal-details") as HTMLDetailsElement).open = false;
      el("legal-details").querySelector<HTMLElement>("summary")?.focus({ preventScroll: true });
      event.preventDefault();
    }
    return;
  }
  const target = event.target instanceof HTMLElement ? event.target : null;
  if (event.defaultPrevented || event.repeat || event.isComposing || dialog.open || !humanTurn() ||
      target?.isContentEditable || target?.closest('input, textarea, select, [role="textbox"]')) return;

  const key = event.key.toLowerCase();
  const undo = key === "z" && (event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey;
  let selector: string | undefined;
  if (undo) selector = '[data-ui="undo"]';
  else {
    if (!shortcutsEnabled || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const kind = Object.entries(ACTION_KEYS).find(([, value]) => value === key)?.[0];
    selector = kind ? `[data-mode="${kind}"]` : key === "e" ? '.turn-tools .end-turn' : key === "z" ? '[data-ui="undo"]' : undefined;
  }
  if (!selector) return;
  const button = el("turn-controls").querySelector<HTMLButtonElement>(selector);
  if (!button || button.disabled || button.getAttribute("aria-disabled") === "true") return;
  event.preventDefault();
  // Reuse the button path, including legal-action checks and focus restoration.
  button.focus({ preventScroll: true });
  button.click();
});
document.addEventListener("scroll", () => {
  // Focusing a supply tile may scroll its column after focusin. Keep that
  // focused or hovered tooltip aligned instead of immediately hiding it.
  if (marketTooltipAnchor && (document.activeElement === marketTooltipAnchor || marketTooltipAnchor.matches(":hover"))) {
    clearTimeout(marketTooltipTimer);
    positionMarketTooltip(marketTooltipAnchor);
  }
  else hideMarketTooltip();
}, true);
window.addEventListener("resize", hideMarketTooltip);
root.addEventListener("click", (event) => {
  const target = event.target as HTMLElement;
  if (!dialog.open && !target.closest("#table-details")) {
    (el("table-details") as HTMLDetailsElement).open = false;
    document.querySelectorAll<HTMLDetailsElement>(".estate-tools > details[open]").forEach(details => { details.open = false; });
  }
  const jump = target.closest<HTMLAnchorElement>('.skip-navigation a, .wordmark[data-jump]');
  if (jump) {
    event.preventDefault();
    if (jump.dataset.jump === "estate") {
      inspected = 0;
      setPanel("estate");
      render();
      el("estate").focus();
      revealBoard();
    } else if (jump.dataset.jump === "legal") {
      const details = el("legal-details") as HTMLDetailsElement;
      details.open = true;
      (el("legal-actions").querySelector<HTMLButtonElement>('button:not(:disabled)') ??
        details.querySelector<HTMLElement>("summary"))?.focus();
    } else el("turn-controls").focus();
    return;
  }
  const summary = target.closest("summary");
  if (summary?.parentElement?.parentElement?.classList.contains("estate-tools")) {
    document.querySelectorAll<HTMLDetailsElement>(".estate-tools > details[open]").forEach(details => {
      if (details !== summary.parentElement) details.open = false;
    });
  }
  if (summary) void audio.play(summary.parentElement?.hasAttribute("open") ? "close" : "open");
  if (target.closest(".wordmark")) void audio.play("select");
  const button = target.closest<HTMLElement>("button");
  if (!button || button.hasAttribute("disabled")) return;
  // A committed move can replace this button with another legal move under the pointer.
  if (event.detail > 1 && button.matches('[data-action], [data-good], [data-source="market"], [data-source="black"], [data-mode="workers"]')) return;
  if (motion.rolling) { motion.cancel(); audio.stop(); aiNotBefore = 0; }
  if (button.getAttribute("aria-disabled") === "true") {
    void audio.play("error");
    if (button.dataset.actionHint) {
      el("announcer").textContent = button.dataset.actionHint;
      showMarketTooltip(button as HTMLButtonElement);
    }
    return;
  }
  hideMarketTooltip();
  if (button.dataset.setupBoard !== undefined && humanSetup()) {
    void audio.play("select");
    setupPreview = Number(button.dataset.setupBoard);
    setupCell = undefined;
    inspected = 0;
    render();
    document.querySelector<HTMLButtonElement>(`[data-setup-board="${setupPreview}"]`)?.focus({ preventScroll: true });
    return;
  }
  if (button.dataset.action !== undefined) {
    const action = actions[Number(button.dataset.action)];
    if (action) execute(action);
    return;
  }
  if (button.dataset.die !== undefined) {
    void audio.play("select");
    selectedDie = Number(button.dataset.die);
    selectedCell = null;
    render();
    motion.selectDie(selectedDie);
    return;
  }
  if (button.dataset.panel) {
    motion.cancel();
    void audio.play("select");
    setPanel(button.dataset.panel as "market" | "estate");
    renderControls();
    if (humanSetup()) renderChoices();
    if (event.detail !== 0) {
      if (button.dataset.panel === "estate") revealBoard();
      else revealMarket();
    }
    return;
  }
  if (button.dataset.mode) {
    if (button.dataset.mode === "take" && !matching("take").length && !state.pending.length) {
      const alternative = actions.find(action => action.kind === "take" && action.die !== undefined)?.die;
      if (alternative !== undefined) selectedDie = alternative;
    }
    mode = button.dataset.mode as ActionKind;
    selectedTile = null;
    selectedCell = null;
    selectedGood = null;
    if (mode === "workers") {
      const action = matching("workers")[0];
      if (action) execute(action);
      return;
    }
    void audio.play("select");
    if (mode === "place") {
      inspected = 0;
      const tiles = [...new Set(matching("place").map(a => a.tile!))];
      if (tiles.length === 1) selectedTile = tiles[0];
      setPanel("estate");
    }
    if (["take", "buy", "trade"].includes(mode)) setPanel("market");
    if (mode === "sell") {
      render();
      const sales = matching("sell");
      const description = sales.length && sales.every(action => action.die === undefined)
        ? "Bonus sale: choose one stack. No die or workers are spent. Rewards are shown for the whole stack."
        : sales.length ? "Choose one stack to sell. This spends the selected die; any worker cost is shown." : "This die cannot sell your goods. These alternatives use your other die; each choice shows which die and worker cost.";
      showActionChoices("Sell a goods type", description, sales.length ? sales : actions.filter(a => a.kind === "sell"));
      return;
    }
    render();
    if (event.detail === 0) {
      el("turn-controls").querySelector<HTMLButtonElement>(`[data-mode="${mode}"]`)?.scrollIntoView({ block: "nearest" });
    } else {
      if (mode === "place") revealBoard();
      if (["take", "buy", "trade"].includes(mode)) revealMarket();
    }
    return;
  }
  if (button.dataset.tile) {
    if (button.dataset.source === "storage") void audio.play("select");
    chooseTile(button.dataset.tile, button.dataset.source!);
    return;
  }
  if (button.dataset.good) {
    const action = matching("sell").find(a => a.good === Number(button.dataset.good));
    if (action) execute(action);
    return;
  }
  if (button.dataset.view !== undefined) {
    motion.cancel();
    void audio.play("select");
    inspected = Number(button.dataset.view);
    lastPlaced = undefined;
    regionCell = undefined;
    render();
    return;
  }
  if (button.dataset.regionCell !== undefined) {
    void audio.play("select");
    const cell = Number(button.dataset.regionCell);
    regionCell = regionCell === cell ? undefined : cell;
    renderRegionInsight();
    renderChoices();
    document.querySelector<HTMLButtonElement>(`[data-region-cell="${cell}"]`)?.focus({ preventScroll: true });
    return;
  }
  if (button.dataset.knowledge) {
    void audio.play("knowledge");
    showHelp(Number(button.dataset.knowledge));
    return;
  }
  switch (button.dataset.ui) {
    case "confirm-estate": {
      const choice = actions.find(a => a.kind === "choose-estate" && a.boardId === setupPreview && a.cell === setupCell);
      if (choice) execute(choice);
      break;
    }
    case "sound":
      audio.setMuted(!audio.muted);
      if (!audio.muted) void audio.play("select");
      renderSoundControl();
      break;
    case "resume-bonus":
      void audio.play("open");
      showPendingChoice();
      break;
    case "undo": {
      const undone = humanTurn() ? undoHistory.pop() : undefined;
      if (!undone) break;
      motion.cancel();
      audio.stop();
      void audio.play("undo");
      // Undo restores gameplay, not the audit trail of moves and reversals.
      state = {
        ...undone.state,
        log: [...state.log, `${state.players[state.active].name}: Undo — ${undone.label}.`].slice(-100),
      };
      actions = legalActions(state);
      lastPlaced = undefined;
      feedback = "Move undone. Your die, tiles, points and resources are restored.";
      resetSelection();
      persist();
      render(true);
      break;
    }
    case "help":
      void audio.play("knowledge");
      showHelp();
      break;
    case "shortcuts":
      void audio.play("select");
      shortcutsEnabled = !shortcutsEnabled;
      try {
        localStorage.setItem(SHORTCUTS_KEY, shortcutsEnabled ? "on" : "off");
      } catch {
        // Keep the preference for this session if storage is unavailable.
      }
      button.setAttribute("aria-pressed", String(shortcutsEnabled));
      button.querySelector("span")!.textContent = shortcutsEnabled ? "On" : "Off";
      render();
      break;
    case "close":
      void audio.play("close");
      dialog.close();
      break;
    case "new":
      void audio.play("open");
      confirmNew();
      break;
    case "skip-final-scoring":
      motion.cancel();
      break;
    case "results":
      void audio.play("open");
      showResults();
      break;
    case "retry-ai":
      void audio.play("select");
      aiFailed = false;
      notice = "";
      render();
      scheduleAI();
      break;
    case "confirm-new": {
      const options: GameOptions = {
        playerCount: Number(dialog.querySelector<HTMLSelectElement>("#player-count")!.value) as 2 | 3 | 4,
        estates: dialog.querySelector<HTMLSelectElement>("#estate-mode")!.value as GameOptions["estates"],
        ruleset: dialog.querySelector<HTMLSelectElement>("#ruleset")!.value as GameOptions["ruleset"],
      };
      audio.stop();
      motion.cancel();
      clearTimeout(aiTimer);
      dialog.close();
      state = createGame(undefined, options);
      setupPreview = undefined;
      setupCell = undefined;
      regionCell = undefined;
      inspected = 0;
      lastPlaced = undefined;
      notice = "";
      aiFailed = false;
      endShown = false;
      undoHistory = [];
      feedback = "New game ready. Choose a die, then click a market tile to begin.";
      setPanel(state.status === "playing" && mobileLayout.matches && !motion.reduced ? "estate" : "market");
      actions = legalActions(state);
      resetSelection();
      persist();
      render();
      if (!motion.reduced) revealBoard();
      motion.startGame(state);
      if (state.status === "playing") void audio.play("dice", motion.reduced ? 0 : MOTION.diceLanding / 1000);
      aiNotBefore = performance.now() + (state.status === "playing" ? (motion.reduced ? MOTION.receipt : DICE_SEQUENCE + MOTION.receipt) + 100 : 700);
      scheduleAI();
      break;
    }
  }
});
root.addEventListener("change", (event) => {
  if ((event.target as HTMLElement).matches("select, input")) void audio.play("select");
});
dialog.addEventListener("cancel", () => { void audio.play("close"); });
dialog.addEventListener("close", () => {
  if (!dialog.open) {
    choiceDialog = false;
    const controls = el("turn-controls");
    const opener = [modalOpener, controls.querySelector<HTMLButtonElement>('[data-ui="resume-bonus"]'),
      ...Array.from(controls.querySelectorAll<HTMLButtonElement>("button"))]
      .find(control => control?.isConnected && control.checkVisibility({ checkVisibilityCSS: true })
        && !control.matches(':disabled, [aria-disabled="true"]')) ?? controls;
    opener.focus({ preventScroll: true });
    modalOpener = null;
  }
  scheduleAI();
});
dialog.addEventListener("click", (event) => {
  if (event.target === dialog) {
    const rect = dialog.getBoundingClientRect();
    if (
      event.clientX < rect.left ||
      event.clientX > rect.right ||
      event.clientY < rect.top ||
      event.clientY > rect.bottom
    ) {
      void audio.play("close");
      dialog.close();
    }
  }
});
window.addEventListener("pagehide", () => {
  clearTimeout(aiTimer);
  clearWorkerSpend();
  audio.stop();
  motion.cancel();
});
document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    clearTimeout(aiTimer);
    audio.stop();
    motion.cancel();
  } else scheduleAI();
});
window.addEventListener("pageshow", () => scheduleAI());
actions = legalActions(state);
resetSelection();
persist();
render();
const tableSizeObserver = new ResizeObserver(fitDesktopTable);
for (const element of [el("game-status"), el("turn-controls"), el("notice"), document.querySelector(".estate-heading")!, document.querySelector(".table-footer")!]) tableSizeObserver.observe(element);
window.addEventListener("resize", fitDesktopTable);
showPendingChoice();
scheduleAI();
