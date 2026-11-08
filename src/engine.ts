import {
  START_CELL,
  COLORS,
  depotColors,
  createTiles,
  tileName,
  KNOWLEDGE_BUILDING,
} from "./data";
import { BOARDS, BOARD_SIDES, boardFor } from "./boards";
import { RULESETS, rulesFor } from "./rules";
import type { Action, Color, GameOptions, Pending, Player, Ruleset, State, Tile } from "./types";

export const knowledgeIds = (p: Player): number[] =>
  p.board.flatMap((t) => (t?.knowledge ? [t.knowledge] : []));
const has = (p: Player, n: number) => p.board.some((t) => t?.knowledge === n);
const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);
function random(s: State): number {
  let t = (s.rng += 0x6d2b79f5);
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  s.rng >>>= 0;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
function shuffle<T>(s: State, a: T[]): T[] {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(random(s) * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
function note(s: State, text: string) {
  s.log.push(text);
  if (s.log.length > 100) s.log.shift();
}
export function actionKey(a: Action): string {
  return JSON.stringify([
    a.kind,
    a.die,
    a.depot,
    a.tile,
    a.cell,
    a.good,
    a.depots,
    a.types,
    a.discard,
    a.boardId,
  ]);
}
export function createGame(
  seed = Math.floor(Math.random() * 4294967296),
  options: GameOptions = {},
): State {
  const playerCount = options.playerCount ?? 2;
  if (![2, 3, 4].includes(playerCount)) throw Error("Choose two, three or four players.");
  const estates = options.estates ?? "beginner";
  if (!["beginner", "open", "secret"].includes(estates)) throw Error("Unknown estate setup.");
  if (options.ruleset !== undefined && !Object.hasOwn(RULESETS, options.ruleset)) throw Error("Unknown rules option.");
  const s: State = {
    version: 1,
    rng: seed >>> 0,
    phase: 0,
    round: 0,
    players: [],
    depots: Array.from({ length: 6 }, () => ({ tiles: [], goods: [] })),
    black: [],
    pools: Object.fromEntries(
      COLORS.map((c) => [c, [] as Tile[]]),
    ) as State["pools"],
    blackPool: [],
    goodsPool: [],
    phaseGoods: [],
    whiteDie: 1,
    order: [],
    turnIndex: 0,
    active: 0,
    purchased: false,
    pending: [],
    claimed: Object.fromEntries(
      COLORS.map((c) => [c, [] as number[]]),
    ) as State["claimed"],
    status: "playing",
    log: [],
    serial: 0,
    winner: null,
  };
  if (options.ruleset !== undefined) s.ruleset = options.ruleset;
  if (rulesFor(s).knowledge6 === "worker-building") s.knowledge6Used = false;
  const tiles = createTiles();
  for (const t of tiles) (t.black ? s.blackPool : s.pools[t.color]).push(t);
  for (const c of COLORS) shuffle(s, s.pools[c]);
  shuffle(s, s.blackPool);
  s.goodsPool = shuffle(
    s,
    Array.from({ length: 42 }, (_, i) => (i % 6) + 1),
  );
  s.order = playerCount === 2
    ? random(s) < 0.5 ? [0, 1] : [1, 0]
    : shuffle(s, Array.from({ length: playerCount }, (_, i) => i));
  s.players = ["You", "The Steward", "The Merchant", "The Castellan"].slice(0, playerCount).map((name, id) => {
    const board: (Tile | null)[] = BOARDS[1].map(() => null);
    board[START_CELL] = s.pools.castle.pop()!;
    const goods = Array(6).fill(0);
    for (let i = 0; i < 3; i++) goods[s.goodsPool.pop()! - 1]++;
    return {
      name,
      board,
      storage: [],
      goods,
      sold: Array(6).fill(0),
      silver: 1,
      workers: s.order.indexOf(id) + 1,
      score: 0,
      dice: [null, null],
      ships: 0,
      arrival: playerCount - s.order.indexOf(id),
      bonuses: [],
    };
  });
  s.serial = playerCount;
  if (estates === "beginner") {
    setupPhase(s);
    beginRound(s);
  }
  else {
    s.status = "setup";
    s.active = s.order[0];
    s.setup = {
      mode: estates,
      boards: shuffle(s, BOARD_SIDES.map((sides) => [...sides])).slice(0, playerCount),
      choices: s.players.map(() => null),
      castles: s.players.map((p) => p.board[START_CELL]!),
    };
    for (const p of s.players) p.board[START_CELL] = null;
    note(s, `Choose a side of your dealt board and a starting castle space (${estates} choices).`);
  }
  return s;
}
function setupPhase(s: State) {
  const slots = depotColors(s.players.length, s.phase);
  s.depots.forEach((d, i) => {
    d.tiles = slots[i].map((c) => {
      const tile = s.pools[c].pop();
      if (!tile) throw Error(`Tile supply exhausted: ${c}`);
      return tile;
    });
  });
  s.black = s.blackPool.splice(-2 * s.players.length);
  s.phaseGoods = s.goodsPool.splice(-5);
  note(
    s,
    `Phase ${"ABCDE"[s.phase]} · New tiles arrive. Regions earn +${10 - s.phase * 2} points.`,
  );
}
export function turnOrder(s: State): number[] {
  return s.players.map((_, i) => i).sort(
    (a, b) =>
      s.players[b].ships - s.players[a].ships ||
      s.players[b].arrival - s.players[a].arrival,
  );
}
function beginRound(s: State) {
  s.order = turnOrder(s);
  s.turnIndex = 0;
  s.active = s.order[0];
  s.purchased = false;
  if (s.knowledge6Used !== undefined) s.knowledge6Used = false;
  s.pending = [];
  for (const p of s.players)
    p.dice = [Math.floor(random(s) * 6) + 1, Math.floor(random(s) * 6) + 1];
  s.whiteDie = Math.floor(random(s) * 6) + 1;
  const good = s.phaseGoods.shift();
  if (good) s.depots[s.whiteDie - 1].goods.push(good);
  note(
    s,
    `Round ${s.round + 1} · Goods ${good} arrive at depot ${s.whiteDie}. ${s.players[s.active].name} play first.`,
  );
}
function dieCost(p: Player, die: number, target: number, free: number) {
  const delta = Math.abs(die - target),
    distance = Math.min(delta, 6 - delta);
  return Math.ceil(Math.max(0, distance - free) / (has(p, 8) ? 2 : 1));
}
export function canPlace(p: Player, t: Tile, id: number): boolean {
  const BOARD = boardFor(p);
  const c = BOARD[id];
  if (!c || p.board[id] || c.color !== t.color) return false;
  if (
    !BOARD.some((n) => {
      const dq = n.q - c.q,
        dr = n.r - c.r;
      return (
        Math.max(Math.abs(dq), Math.abs(dr), Math.abs(dq + dr)) === 1 &&
        p.board[n.id]
      );
    })
  )
    return false;
  return (
    t.color !== "building" ||
    has(p, 1) ||
    !BOARD.some(
      (n) => n.region === c.region && p.board[n.id]?.building === t.building,
    )
  );
}
function placeDiscount(p: Player, t: Tile) {
  return +(
    (has(p, 9) && t.color === "building") ||
    (has(p, 10) && ["ship", "animal"].includes(t.color)) ||
    (has(p, 11) && ["castle", "mine", "knowledge"].includes(t.color))
  );
}
function choices<T>(items: T[], count: number): T[][] {
  if (count === 0) return [[]];
  return items.flatMap((v, i) =>
    choices(items.slice(i + 1), count - 1).map((rest) => [v, ...rest]),
  );
}
function withStorage(p: Player, a: Action, ruleset?: Ruleset): Action[] {
  return p.storage.length < 3
    ? [a]
    : p.storage.map((t) => ({
        ...a,
        discard: t.id,
        label: `${a.label} · replace ${tileName(t, ruleset)}`,
      }));
}
export function legalActions(s: State): Action[] {
  if (s.status === "setup") {
    return s.setup!.boards[s.active].flatMap((boardId) => BOARDS[boardId]
      .filter((c) => c.color === "castle")
      .map((c, index) => ({ kind: "choose-estate" as const, boardId, cell: c.id, cost: 0,
        label: `Estate #${boardId} · starting castle ${index + 1}` })));
  }
  if (s.status !== "playing") return [];
  const p = s.players[s.active],
    BOARD = boardFor(p),
    pending = s.pending[0],
    out: Action[] = [];
  const rules = rulesFor(s);
  const take = (
    die: number | undefined,
    value: number | undefined,
    colors?: Color[],
  ) =>
    s.depots.forEach((d, i) => {
      const cost =
        value === undefined ? 0 : dieCost(p, value, i + 1, +has(p, 12));
      if (cost > p.workers) return;
      for (const t of d.tiles)
        if (!colors || colors.includes(t.color))
          out.push(
            ...withStorage(p, {
              kind: "take",
              die,
              depot: i,
              tile: t.id,
              cost,
              label: `Take ${tileName(t, s.ruleset)} · depot ${i + 1}`,
            }, s.ruleset),
          );
    });
  const place = (die: number | undefined, value: number | undefined) => {
    for (const t of p.storage)
      for (const c of BOARD) {
        const cost =
          value === undefined
            ? 0
            : dieCost(p, value, c.die, placeDiscount(p, t));
        if (cost <= p.workers && canPlace(p, t, c.id))
          out.push({
            kind: "place",
            die,
            tile: t.id,
            cell: c.id,
            cost,
            label: `Place ${tileName(t, s.ruleset)}`,
          });
      }
  };
  const sell = (die: number | undefined, value: number | undefined) =>
    p.goods.forEach((count, i) => {
      const cost = value === undefined ? 0 : dieCost(p, value, i + 1, 0);
      if (count && cost <= p.workers)
        out.push({
          kind: "sell",
          die,
          good: i + 1,
          cost,
          label: `Sell ${count} goods · type ${i + 1} · ${count * s.players.length} VP`,
        });
    });
  const workers = (die?: number) =>
    out.push({
      kind: "workers",
      die,
      cost: 0,
      label: `Take ${has(p, 14) ? 4 : 2} workers${has(p, 13) ? " + 1 silver" : ""}`,
    });
  // Purchasing is independent of dice and may interrupt a bonus-action chain.
  const extras = () => {
    if (has(p, 6) && rules.knowledge6 === "worker-building" && !s.knowledge6Used && p.workers >= 2) {
      s.depots.forEach((depot, index) => {
        for (const tile of depot.tiles) if (tile.color === "building")
          out.push(...withStorage(p, {
            kind: "trade", depot: index, tile: tile.id, cost: 2,
            label: `Knowledge 6 · take ${tileName(tile, s.ruleset)} · depot ${index + 1}`,
          }, s.ruleset));
      });
    }
    if (s.purchased || p.silver < 2) return;
    const sources = [
      { tiles: s.black, index: -1 },
      ...(has(p, 6) && rules.knowledge6 === "silver-purchase"
        ? s.depots.map((d, i) => ({ tiles: d.tiles, index: i }))
        : []),
    ];
    for (const source of sources)
      for (const t of source.tiles)
        out.push(
          ...withStorage(p, {
            kind: "buy",
            depot: source.index,
            tile: t.id,
            cost: 0,
            label: `Buy ${tileName(t, s.ruleset)} · 2 silver`,
          }, s.ruleset),
        );
  };
  if (pending) {
    switch (pending.kind) {
      case "take":
        take(undefined, undefined, pending.colors);
        break;
      case "place":
        place(undefined, undefined);
        break;
      case "sell":
        sell(undefined, undefined);
        break;
      case "free":
        take(undefined, undefined);
        place(undefined, undefined);
        sell(undefined, undefined);
        workers();
        break;
      case "ship":
        for (let i = 0; i < 6; i++) {
          out.push({
            kind: "ship",
            depots: [i],
            cost: 0,
            label: `Collect goods from depot ${i + 1}`,
          });
          if (has(p, 5))
            out.push({
              kind: "ship",
              depots: [i, (i + 1) % 6],
              cost: 0,
              label: `Collect goods from depots ${i + 1} & ${((i + 1) % 6) + 1}`,
            });
        }
        break;
      case "goods": {
        const types = [
          ...new Set(pending.depots.flatMap((d) => s.depots[d].goods)),
        ];
        const existing = types.filter((t) => p.goods[t - 1] > 0);
        const fresh = types.filter((t) => p.goods[t - 1] === 0);
        const room = 3 - p.goods.filter(Boolean).length;
        for (const set of choices(fresh, Math.min(room, fresh.length))) {
          const selected = [...existing, ...set].sort();
          out.push({
            kind: "goods",
            types: selected,
            cost: 0,
            label: selected.length
              ? `Load goods ${selected.join(", ")}`
              : "No goods fit · continue",
          });
        }
        break;
      }
    }
    if (!["goods", "ship", "free"].includes(pending.kind))
      out.push({ kind: "skip", cost: 0, label: "Decline this bonus action" });
    extras();
    return out;
  }
  p.dice.forEach((v, i) => {
    if (v !== null) {
      take(i, v);
      place(i, v);
      sell(i, v);
      workers(i);
    }
  });
  extras();
  if (p.dice.every((v) => v === null))
    out.push({ kind: "end", cost: 0, label: "End turn" });
  return out;
}
function receive(p: Player, t: Tile, discard?: string) {
  if (discard) p.storage = p.storage.filter((t) => t.id !== discard);
  p.storage.push(t);
}
function sellGoods(s: State, p: Player, good: number) {
  const count = p.goods[good - 1];
  p.goods[good - 1] = 0;
  p.sold[good - 1] += count;
  p.silver += has(p, 3) ? 2 : 1;
  if (has(p, 4)) p.workers++;
  p.score += count * s.players.length;
}
function placed(s: State, p: Player, t: Tile, id: number) {
  const BOARD = boardFor(p);
  p.board[id] = t;
  const region = BOARD.filter((c) => c.region === BOARD[id].region);
  if (region.every((c) => p.board[c.id])) {
    const score = (region.length * (region.length + 1)) / 2 + 10 - s.phase * 2;
    p.score += score;
    note(s, `${p.name} complete a ${t.color} region: +${score} VP.`);
  }
  if (
    !p.bonuses.includes(t.color) &&
    BOARD.filter((c) => c.color === t.color).every((c) => p.board[c.id])
  ) {
    const claimed = s.claimed[t.color];
    if (claimed.length < 2) {
      const score = claimed.length === 0 ? s.players.length + 3 : s.players.length;
      claimed.push(s.active);
      p.bonuses.push(t.color);
      p.score += score;
      note(s, `${p.name} finish ${t.color}: +${score} VP.`);
    }
  }
  const push = (pending: Pending) => s.pending.unshift(pending);
  switch (t.color) {
    case "castle":
      push({ kind: "free" });
      break;
    case "ship":
      p.ships++;
      p.arrival = ++s.serial;
      push({ kind: "ship" });
      break;
    case "animal":
      p.score += sum(
        region
          .map((c) => p.board[c.id])
          .filter((other) => other?.animal === t.animal)
          .map((other) => other!.count! + (has(p, 7) ? 1 : 0)),
      );
      break;
    case "building":
      switch (t.building) {
        case "warehouse":
          push({ kind: "sell" });
          break;
        case "workshop":
          push({ kind: "take", colors: ["building"] });
          break;
        case "church":
          push({ kind: "take", colors: ["mine", "castle", "knowledge"] });
          break;
        case "market":
          push({ kind: "take", colors: ["ship", "animal"] });
          break;
        case "boarding":
          p.workers += 4;
          break;
        case "bank":
          p.silver += 2;
          break;
        case "hall":
          push({ kind: "place" });
          break;
        case "watchtower":
          p.score += 4;
          break;
      }
      break;
  }
}
export function finalKnowledgeScores(player: Player, ruleset?: Ruleset): {
  cell: number; knowledge: number; count: number; pointsPerUnit: number; points: number;
}[] {
  const rules = rulesFor({ ruleset });
  return player.board.flatMap((tile, cell) => {
    const knowledge = tile?.knowledge;
    if (knowledge === undefined || knowledge < 15 || knowledge > 26) return [];
    let count = 0, pointsPerUnit = 4;
    if (knowledge === 15) {
      count = player.sold.filter(Boolean).length;
      pointsPerUnit = rules.soldTypePoints;
    } else if (knowledge <= 23) {
      count = player.board.filter((t) => t?.building === KNOWLEDGE_BUILDING[knowledge]).length;
    } else if (knowledge === 24) {
      count = new Set(
        player.board.filter((t) => t?.color === "animal").map((t) => t!.animal),
      ).size;
    } else if (knowledge === 25) {
      count = sum(player.sold);
      pointsPerUnit = 1;
    } else if (knowledge === 26) {
      count = player.bonuses.length;
      pointsPerUnit = rules.colorBonusPoints;
    }
    return [{ cell, knowledge, count, pointsPerUnit, points: count * pointsPerUnit }];
  });
}
function finish(s: State) {
  const rules = rulesFor(s);
  for (const p of s.players) {
    const knowledge = sum(finalKnowledgeScores(p, s.ruleset).map((score) => score.points));
    p.final = {
      goods: sum(p.goods),
      silver: p.silver,
      workers: Math.floor(p.workers / 2),
      knowledge,
    };
    p.score += sum(Object.values(p.final));
  }
  const order = turnOrder(s);
  // The original German rule uses more empty spaces; Special Edition's
  // supplied English rulebook prints fewer. Keep the selected rule explicit.
  const ranking = s.players.map((_, i) => i).sort(
    (a, b) =>
      s.players[b].score - s.players[a].score ||
      (s.players[b].board.filter((t) => !t).length -
        s.players[a].board.filter((t) => !t).length) * (rules.tieBreak === "most-empty" ? 1 : -1) ||
      order.indexOf(b) - order.indexOf(a),
  );
  s.status = "finished";
  s.winner = ranking[0];
  note(
    s,
    `${s.players[s.winner].name} win with ${s.players[s.winner].score} points.`,
  );
}
function endTurn(s: State) {
  s.turnIndex++;
  s.purchased = false;
  if (s.knowledge6Used !== undefined) s.knowledge6Used = false;
  if (s.turnIndex < s.order.length) {
    s.active = s.order[s.turnIndex];
    return;
  }
  s.round++;
  if (s.round === 5) {
    for (const p of s.players) {
      const mines = p.board.filter((t) => t?.color === "mine").length;
      p.silver += mines;
      if (has(p, 2)) p.workers += mines;
    }
    if (s.phase === 4) {
      s.round = 4;
      finish(s);
      return;
    }
    s.phase++;
    s.round = 0;
    setupPhase(s);
  }
  beginRound(s);
}
function chooseEstate(s: State, a: Action) {
  const setup = s.setup!;
  setup.choices[s.active] = { boardId: a.boardId!, cell: a.cell! };
  const reveal = (who: number) => {
    const choice = setup.choices[who]!;
    const p = s.players[who];
    p.boardId = choice.boardId;
    p.board[choice.cell] = setup.castles[who];
    note(s, `${p.name} settle estate #${choice.boardId}.`);
  };
  if (setup.mode === "open") reveal(s.active);
  s.turnIndex++;
  if (s.turnIndex < s.order.length) {
    s.active = s.order[s.turnIndex];
    return;
  }
  if (setup.mode === "secret") s.order.forEach(reveal);
  delete s.setup;
  s.status = "playing";
  setupPhase(s);
  beginRound(s);
}
/** Commands are validated at the engine boundary; callers never mutate the authoritative state. */
export function applyAction(state: State, requested: Action): State {
  const action = legalActions(state).find(
    (a) => actionKey(a) === actionKey(requested),
  );
  if (!action) throw Error("That action is not legal in the current position.");
  return applyLegalAction(state, action);
}
/** For search over actions JUST returned by legalActions; UI must use applyAction. */
export function applyLegalAction(state: State, a: Action): State {
  const s = structuredClone(state),
    p = s.players[s.active];
  if (a.kind === "choose-estate") {
    chooseEstate(s, a);
    return s;
  }
  const pending = s.pending[0];
  if (pending && a.kind !== "buy" && a.kind !== "trade") s.pending.shift();
  else if (a.die !== undefined) p.dice[a.die] = null;
  p.workers -= a.cost;
  if (a.kind !== "end" && a.kind !== "skip")
    note(s, `${p.name}: ${a.label}${a.cost ? ` (−${a.cost} workers)` : ""}.`);
  switch (a.kind) {
    case "take":
    case "trade": {
      const d = s.depots[a.depot!],
        i = d.tiles.findIndex((t) => t.id === a.tile);
      receive(p, d.tiles.splice(i, 1)[0], a.discard);
      if (a.kind === "trade") s.knowledge6Used = true;
      break;
    }
    case "buy": {
      const tiles = a.depot === -1 ? s.black : s.depots[a.depot!].tiles;
      receive(
        p,
        tiles.splice(
          tiles.findIndex((t) => t.id === a.tile),
          1,
        )[0],
        a.discard,
      );
      p.silver -= 2;
      s.purchased = true;
      break;
    }
    case "place": {
      const t = p.storage.splice(
        p.storage.findIndex((t) => t.id === a.tile),
        1,
      )[0];
      placed(s, p, t, a.cell!);
      break;
    }
    case "sell":
      sellGoods(s, p, a.good!);
      break;
    case "workers":
      p.workers += has(p, 14) ? 4 : 2;
      if (has(p, 13)) p.silver++;
      break;
    case "ship":
      s.pending.unshift({ kind: "goods", depots: a.depots! });
      break;
    case "goods":
      if (pending?.kind === "goods")
        for (const index of pending.depots) {
          const depot = s.depots[index];
          for (const good of depot.goods)
            if (a.types!.includes(good)) p.goods[good - 1]++;
          depot.goods = depot.goods.filter((g) => !a.types!.includes(g));
        }
      break;
    case "skip":
      note(s, `${p.name} decline a bonus action.`);
      break;
    case "end":
      endTurn(s);
      break;
  }
  return s;
}
