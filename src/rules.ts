import type { Ruleset } from "./types";

/** These four rule options do not change estate inventory or add expansions. */
export const RULESETS = {
  "original-2011": {
    label: "Original 2011",
    knowledge6: "silver-purchase",
    soldTypePoints: 3,
    colorBonusPoints: 2,
    tieBreak: "most-empty",
  },
  "special-edition": {
    label: "Special Edition rule changes",
    knowledge6: "worker-building",
    soldTypePoints: 2,
    colorBonusPoints: 3,
    tieBreak: "fewest-empty",
  },
} as const;

export const rulesFor = (game: { ruleset?: Ruleset }) =>
  RULESETS[game.ruleset ?? "original-2011"];
