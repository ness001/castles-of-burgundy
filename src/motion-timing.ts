import type { MotionPlan } from "./motion-events";

/** Reading beats, not game clocks. State and human input never wait for these. */
export const MOTION = {
  flight: 850,
  receipt: 2600,
  emphasis: 1800,
  landing: 650,
  region: 1800,
  regionTrace: 950,
  animals: 1500,
  mines: 1600,
  rewardDelay: 950,
  diceRoll: 1400,
  diceHold: 1100,
  diceReturn: 600,
  diceLanding: 1100,
  deal: 650,
  dealStagger: 65,
  finalStep: 1500,
  finalCount: 650,
} as const;

export const DICE_SEQUENCE = MOTION.diceRoll + MOTION.diceHold + MOTION.diceReturn;

/** Finish income and the new supply before asking players to watch their roll. */
export function rollLeadIn(plan: MotionPlan): number {
  return plan.phaseChanged ? (plan.silver.length ? MOTION.receipt + 200 : 0) + MOTION.deal + MOTION.dealStagger * 6 + 200 : 0;
}

export function motionReadingTime(plan: MotionPlan, reduced: boolean): number {
  if (plan.roll) return (reduced ? 0 : rollLeadIn(plan) + DICE_SEQUENCE) + MOTION.receipt + 100;
  const rewards = plan.silver.length || plan.scores.length || plan.goods.length || plan.freeAction || plan.ship ||
    plan.workers?.some(item => item.amount > 0 || item.amount < 0 && item.player > 0);
  // Tile notices start immediately; only rewardEffects waits for placement arrival.
  const arrival = rewards ? rewardLeadIn(plan, reduced) : 0;
  const reward = !reduced && plan.regions.length ? MOTION.rewardDelay : 0;
  return plan.tile || rewards
    ? arrival + reward + MOTION.receipt + 150 : 700;
}

export function rewardLeadIn(plan: MotionPlan, reduced: boolean): number {
  return !reduced && plan.tile?.cell !== undefined ? MOTION.flight : 0;
}
