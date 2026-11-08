import { describe, expect, it } from "vitest";
import { applyAction, createGame, finalKnowledgeScores, legalActions } from "../src/engine";
import type { Building, Player, Tile } from "../src/types";

const profiles = [undefined, "original-2011", "special-edition"] as const;
const knowledgeOrder = [26, 16, 24, 17, 25, 18, 15, 19, 20, 21, 22, 23];
const buildings: Building[] = ["warehouse", "watchtower", "workshop", "church", "market", "boarding", "bank", "hall"];
const knowledgeTile = (knowledge: number): Tile => ({ id: `knowledge-${knowledge}`, color: "knowledge", knowledge });

function player(): Player {
  const p = createGame(819).players[0];
  p.board.fill(null);
  for (const [index, knowledge] of knowledgeOrder.entries()) p.board[index + 1] = knowledgeTile(knowledge);
  p.goods = [0, 0, 0, 0, 0, 0];
  p.sold = [0, 0, 0, 0, 0, 0];
  p.bonuses = [];
  return p;
}

function scoringPlayer(): Player {
  const p = player();
  for (const [index, building] of buildings.entries())
    p.board[index + 20] = { id: building, color: "building", building };
  p.board[28] = { id: "second-warehouse", color: "building", building: "warehouse" };
  p.board[30] = { id: "sheep", color: "animal", animal: "sheep", count: 4 };
  p.board[31] = { id: "pig", color: "animal", animal: "pig", count: 2 };
  p.board[32] = { id: "more-sheep", color: "animal", animal: "sheep", count: 3 };
  p.sold = [2, 0, 4, 0, 1, 0];
  p.goods = [0, 3, 0, 2, 0, 1];
  p.bonuses = ["ship", "knowledge"];
  p.storage = [
    { id: "reserved-warehouse", color: "building", building: "warehouse" },
    { id: "reserved-cattle", color: "animal", animal: "cattle", count: 4 },
    { ...knowledgeTile(25), id: "reserved-knowledge" },
  ];
  return p;
}

describe("final knowledge breakdown", () => {
  it.each(profiles)("%s scores all twelve knowledge types in board order without mutation", ruleset => {
    const p = scoringPlayer();
    const before = structuredClone(p);
    const soldTypePoints = ruleset === "special-edition" ? 2 : 3;
    const colorBonusPoints = ruleset === "special-edition" ? 3 : 2;
    expect(finalKnowledgeScores(p, ruleset)).toEqual([
      { cell: 1, knowledge: 26, count: 2, pointsPerUnit: colorBonusPoints, points: 2 * colorBonusPoints },
      { cell: 2, knowledge: 16, count: 2, pointsPerUnit: 4, points: 8 },
      { cell: 3, knowledge: 24, count: 2, pointsPerUnit: 4, points: 8 },
      { cell: 4, knowledge: 17, count: 1, pointsPerUnit: 4, points: 4 },
      { cell: 5, knowledge: 25, count: 7, pointsPerUnit: 1, points: 7 },
      { cell: 6, knowledge: 18, count: 1, pointsPerUnit: 4, points: 4 },
      { cell: 7, knowledge: 15, count: 3, pointsPerUnit: soldTypePoints, points: 3 * soldTypePoints },
      { cell: 8, knowledge: 19, count: 1, pointsPerUnit: 4, points: 4 },
      { cell: 9, knowledge: 20, count: 1, pointsPerUnit: 4, points: 4 },
      { cell: 10, knowledge: 21, count: 1, pointsPerUnit: 4, points: 4 },
      { cell: 11, knowledge: 22, count: 1, pointsPerUnit: 4, points: 4 },
      { cell: 12, knowledge: 23, count: 1, pointsPerUnit: 4, points: 4 },
    ]);
    expect(p).toEqual(before);
  });

  it.each(profiles)("%s retains zero contributions and ignores reserved buildings and animals", ruleset => {
    const p = player();
    p.storage = [
      { id: "reserved-warehouse", color: "building", building: "warehouse" },
      { id: "reserved-sheep", color: "animal", animal: "sheep", count: 4 },
      { ...knowledgeTile(15), id: "reserved-knowledge" },
    ];
    p.goods = [1, 1, 1, 1, 1, 1];
    expect(finalKnowledgeScores(p, ruleset)).toEqual(knowledgeOrder.map((knowledge, index) => ({
      cell: index + 1,
      knowledge,
      count: 0,
      pointsPerUnit: knowledge === 15 ? (ruleset === "special-edition" ? 2 : 3)
        : knowledge === 26 ? (ruleset === "special-edition" ? 3 : 2)
        : knowledge === 25 ? 1 : 4,
      points: 0,
    })));
  });

  it("excludes knowledge 1–14 and unbuilt scoring knowledge", () => {
    const p = player();
    p.board.fill(null);
    expect(finalKnowledgeScores(p)).toEqual([]);
    for (let knowledge = 1; knowledge <= 14; knowledge++) p.board[knowledge] = knowledgeTile(knowledge);
    p.storage = [knowledgeTile(15), knowledgeTile(24), knowledgeTile(26)];
    p.sold = [2, 1, 0, 0, 0, 0];
    p.bonuses = ["ship", "knowledge"];
    expect(finalKnowledgeScores(p)).toEqual([]);
  });

  it.each(profiles)("%s matches authoritative final scoring after final mining income and knowledge 2 workers", ruleset => {
    const s = createGame(819, { ruleset });
    const p = scoringPlayer();
    s.players[0] = p;
    p.board[14] = knowledgeTile(2);
    p.board[15] = { id: "first-mine", color: "mine" };
    p.board[16] = { id: "second-mine", color: "mine" };
    p.silver = 5;
    p.workers = 3;
    p.score = 10;
    p.dice = [null, null];
    s.phase = 4;
    s.round = 4;
    s.order = [1, 0];
    s.turnIndex = 1;
    s.active = 0;
    const before = structuredClone(s);
    const end = legalActions(s).find(action => action.kind === "end");
    expect(end).toBeDefined();
    const next = applyAction(s, end!);
    const knowledge = ruleset === "special-edition" ? 63 : 64;
    expect(next.status).toBe("finished");
    expect(next.players[0]).toMatchObject({
      silver: 7,
      workers: 5,
      final: { goods: 6, silver: 7, workers: 2, knowledge },
      score: 10 + 6 + 7 + 2 + knowledge,
    });
    for (const finishedPlayer of next.players) {
      const scores = finalKnowledgeScores(finishedPlayer, next.ruleset);
      expect(scores.reduce((total, score) => total + score.points, 0)).toBe(finishedPlayer.final?.knowledge);
      expect(Object.keys(finishedPlayer.final!)).toEqual(["goods", "silver", "workers", "knowledge"]);
    }
    expect(finalKnowledgeScores(next.players[0], next.ruleset)).toEqual(finalKnowledgeScores(p, ruleset));
    expect(s).toEqual(before);
  });
});
