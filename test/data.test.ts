import { expect, it } from "vitest";
import {
  BOARD,
  START_CELL,
  COLORS,
  BUILDINGS,
  createTiles,
  KNOWLEDGE,
  DEPOT_COLORS,
  BLACK_COUNT,
} from "../src/data";
it("encodes the original board #1 functional layout and connected regions", () => {
  expect(BOARD).toHaveLength(37);
  expect(BOARD.map((c) => c.id)).toEqual(
    Array.from({ length: 37 }, (_, i) => i),
  );
  expect(BOARD[START_CELL]).toMatchObject({
    q: 0,
    r: 0,
    color: "castle",
    die: 6,
  });
  expect(
    COLORS.map((color) => BOARD.filter((c) => c.color === color).length),
  ).toEqual([4, 6, 6, 3, 6, 12]);
  const sizes = (color: string) =>
    [...new Set(BOARD.filter((c) => c.color === color).map((c) => c.region))]
      .map((r) => BOARD.filter((c) => c.region === r).length)
      .sort((a, b) => a - b);
  expect(sizes("building")).toEqual([1, 3, 3, 5]);
  expect(sizes("animal")).toEqual([1, 5]);
  expect(sizes("castle")).toEqual([1, 3]);
  expect(sizes("ship")).toEqual([3, 3]);
  expect(sizes("knowledge")).toEqual([3, 3]);
  expect(sizes("mine")).toEqual([3]);
  expect(BOARD.every((c) => c.die >= 1 && c.die <= 6)).toBe(true);
});
it("has the exact 164-tile physical inventory and black/normal partitions", () => {
  const tiles = createTiles();
  expect(tiles).toHaveLength(164);
  expect(new Set(tiles.map((t) => t.id)).size).toBe(164);
  expect(tiles.filter((t) => t.black)).toHaveLength(40);
  expect(COLORS.map((c) => tiles.filter((t) => t.color === c).length)).toEqual([
    16, 26, 28, 12, 26, 56,
  ]);
  for (const b of BUILDINGS) {
    expect(tiles.filter((t) => t.building === b && !t.black)).toHaveLength(5);
    expect(tiles.filter((t) => t.building === b && t.black)).toHaveLength(2);
  }
  for (const a of ["sheep", "cattle", "pig", "chicken"]) {
    expect(
      tiles.filter((t) => t.animal === a && !t.black).map((t) => t.count),
    ).toEqual([2, 2, 3, 3, 4]);
    expect(
      tiles.filter((t) => t.animal === a && t.black).map((t) => t.count),
    ).toEqual([3, 4]);
  }
  expect(
    tiles.filter((t) => t.knowledge && t.black).map((t) => t.knowledge),
  ).toEqual([7, 12, 14, 15, 24, 25]);
  expect(Object.keys(KNOWLEDGE)).toHaveLength(26);
});
it("uses the 2-player depot distribution and four black-depot tiles each phase", () => {
  expect(DEPOT_COLORS).toEqual([
    ["ship", "building"],
    ["castle", "knowledge"],
    ["animal", "building"],
    ["ship", "building"],
    ["mine", "knowledge"],
    ["animal", "building"],
  ]);
  expect(BLACK_COUNT).toBe(4);
});
