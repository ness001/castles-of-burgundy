import type { Animal, Building, Color, Ruleset, Tile } from "./types";
import { rulesFor } from "./rules";
export { BOARD, START_CELL } from "./boards";

export const COLORS: Color[] = [
  "castle",
  "ship",
  "animal",
  "mine",
  "knowledge",
  "building",
];
export const BUILDINGS: Building[] = [
  "warehouse",
  "workshop",
  "church",
  "market",
  "boarding",
  "bank",
  "hall",
  "watchtower",
];
export const DEPOT_COLORS: Color[][] = [
  ["ship", "building"],
  ["castle", "knowledge"],
  ["animal", "building"],
  ["ship", "building"],
  ["mine", "knowledge"],
  ["animal", "building"],
];
export const BLACK_COUNT = 4;
/** Printed depot slots; the third-player castle changes to a mine in B and D. */
export function depotColors(playerCount: number, phase: number): Color[][] {
  const third: Color[] = ["knowledge", "building", "ship", "animal", "building", phase % 2 ? "mine" : "castle"];
  const fourth: Color[] = ["animal", "building", "knowledge", "mine", "building", "ship"];
  return DEPOT_COLORS.map((colors, index) => [
    ...colors,
    ...(playerCount >= 3 ? [playerCount === 4 && index === 5 ? "castle" as const : third[index]] : []),
    ...(playerCount === 4 ? [fourth[index]] : []),
  ]);
}
export const KNOWLEDGE_BUILDING: Record<number, Building> = {
  16: "warehouse",
  17: "watchtower",
  18: "workshop",
  19: "church",
  20: "market",
  21: "boarding",
  22: "bank",
  23: "hall",
};
const buildingNames: Record<Building, string> = {
  warehouse: "Warehouse",
  workshop: "Carpenter’s Workshop",
  church: "Church",
  market: "Market",
  boarding: "Boarding House",
  bank: "Bank",
  hall: "City Hall",
  watchtower: "Watchtower",
};
const buildingDescriptions: Record<Building, string> = {
  warehouse: "Immediately sell one goods type without spending a die.",
  workshop: "Immediately reserve one building from any numbered depot.",
  church:
    "Immediately reserve a castle, mine or knowledge tile from any numbered depot.",
  market: "Immediately reserve a ship or animal tile from any numbered depot.",
  boarding: "Immediately gain 4 workers.",
  bank: "Immediately gain 2 silver.",
  hall: "Immediately build another reserved tile on any legal hex, ignoring its die value. Resolve its effect too.",
  watchtower: "Immediately gain 4 victory points.",
};
export const KNOWLEDGE: Record<number, { name: string; description: string }> =
  {
    1: {
      name: "Open cities",
      description: "You may build duplicate building types in the same city.",
    },
    2: {
      name: "Mining guild",
      description:
        "Each mine also produces one worker at the end of every phase.",
    },
    3: {
      name: "Trade contracts",
      description: "Selling a goods type earns two silver instead of one.",
    },
    4: {
      name: "Trading crews",
      description: "Every goods sale also earns one worker.",
    },
    5: {
      name: "River trade",
      description:
        "Ships may collect goods from two consecutive numbered depots, including 6 and 1. The three-type storage limit still applies.",
    },
    6: {
      name: "Open markets",
      description:
        "Your once-per-turn purchase may come from any numbered depot as well as the black market.",
    },
    7: {
      name: "Animal husbandry",
      description:
        "When scoring livestock, add one point for every tile scored, including matching animals already in that pasture.",
    },
    8: {
      name: "Skilled workers",
      description:
        "Each worker adjusts a die by up to two steps instead of one, including wrapping 1↔6.",
    },
    9: {
      name: "Master builders",
      description:
        "Building placement receives a free one-step die adjustment.",
    },
    10: {
      name: "Land and water",
      description:
        "Ship and animal placement receives a free one-step die adjustment.",
    },
    11: {
      name: "Estate planning",
      description:
        "Castle, mine and knowledge placement receives a free one-step die adjustment.",
    },
    12: {
      name: "Depot access",
      description:
        "Taking a tile from a numbered depot receives a free one-step die adjustment.",
    },
    13: {
      name: "Paid labour",
      description:
        "The workers dice action also earns one silver. Boarding Houses are unaffected.",
    },
    14: {
      name: "Labour guild",
      description: "The workers dice action earns four workers instead of two.",
    },
    15: {
      name: "Diverse exports",
      description: "At the end, score 3 points per different goods type sold.",
    },
    24: {
      name: "Diverse herds",
      description:
        "At the end, score 4 points per different animal type in your estate.",
    },
    25: {
      name: "Export ledger",
      description: "At the end, score 1 point per goods tile sold.",
    },
    26: {
      name: "Distinguished estate",
      description:
        "At the end, score 2 points per colour-completion bonus claimed.",
    },
  };
for (const [id, b] of Object.entries(KNOWLEDGE_BUILDING))
  KNOWLEDGE[Number(id)] = {
    name: `${buildingNames[b]} patronage`,
    description: `At the end, score 4 points for each ${buildingNames[b]} in your estate.`,
  };
export function knowledgeInfo(id: number, ruleset?: Ruleset) {
  const rules = rulesFor({ ruleset });
  const original = KNOWLEDGE[id];
  if (id === 6 && rules.knowledge6 === "worker-building") return {
    name: "Building crews",
    description: "Once per turn, spend 2 workers to reserve a building from any numbered depot without a die. This is separate from your silver purchase.",
  };
  if (id === 15) return { ...original, description: `At the end, score ${rules.soldTypePoints} points per different goods type sold.` };
  if (id === 26) return { ...original, description: `At the end, score ${rules.colorBonusPoints} points per colour-completion bonus claimed.` };
  return original;
}
export function createTiles(): Tile[] {
  const tiles: Tile[] = [];
  const add = (
    color: Color,
    count: number,
    black = false,
    extra: Partial<Tile> = {},
  ) => {
    for (let i = 0; i < count; i++)
      tiles.push({ id: `tile-${tiles.length + 1}`, color, black, ...extra });
  };
  for (const b of BUILDINGS) {
    add("building", 5, false, { building: b });
    add("building", 2, true, { building: b });
  }
  for (const animal of ["sheep", "cattle", "pig", "chicken"] as Animal[]) {
    for (const count of [2, 2, 3, 3, 4])
      add("animal", 1, false, { animal, count });
    for (const count of [3, 4]) add("animal", 1, true, { animal, count });
  }
  const blackKnowledge = new Set([7, 12, 14, 15, 24, 25]);
  for (let knowledge = 1; knowledge <= 26; knowledge++)
    add("knowledge", 1, blackKnowledge.has(knowledge), { knowledge });
  add("castle", 14);
  add("castle", 2, true);
  add("mine", 10);
  add("mine", 2, true);
  add("ship", 20);
  add("ship", 6, true);
  return tiles;
}
export function tileName(tile: Tile, ruleset?: Ruleset): string {
  if (tile.building) return buildingNames[tile.building];
  if (tile.knowledge)
    return `Knowledge ${tile.knowledge} · ${knowledgeInfo(tile.knowledge, ruleset).name}`;
  if (tile.animal)
    return `${tile.count} ${tile.animal === "cattle" ? "cattle" : tile.animal === "sheep" ? "sheep" : `${tile.animal}s`}`;
  return {
    castle: "Castle",
    ship: "Ship",
    mine: "Mine",
    animal: "Animals",
    knowledge: "Knowledge",
    building: "Building",
  }[tile.color];
}
export function tileDescription(tile: Tile, ruleset?: Ruleset): string {
  if (tile.building) return buildingDescriptions[tile.building];
  if (tile.knowledge) return knowledgeInfo(tile.knowledge, ruleset).description;
  if (tile.color === "animal")
    return "Score every animal on this tile, plus all matching animals already in the same connected pasture.";
  if (tile.color === "castle")
    return "Immediately perform an additional action with a free die of any value.";
  if (tile.color === "ship")
    return "Advance one step in turn order and collect goods from a chosen depot, keeping at most three goods types.";
  if (tile.color === "mine")
    return "Earn one silver at the end of each phase, including the final phase.";
  return "Build on a matching-colour hex beside your estate.";
}
