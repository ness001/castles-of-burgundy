import { describe, expect, it } from "vitest";
import { BOARD, BOARDS, BOARD_SIDES, START_CELL, boardFor } from "../src/boards";
import type { Cell, Color } from "../src/types";

const colors: Color[] = ["castle", "ship", "animal", "mine", "knowledge", "building"];
const ids = [1, 2, 3, 4, 5, 6, 7, 8, 9];
const directions = [[1, 0], [0, 1], [-1, 1], [-1, 0], [0, -1], [1, -1]];

// Fixed pre-extraction #1 reference: q, r, color, die, region. No production
// constants are used to construct these expected cells or region numbers.
const original: [number, number, Color, number, number][] = [
  [0, -3, "animal", 6, 0],
  [1, -3, "castle", 5, 1],
  [2, -3, "castle", 4, 1],
  [3, -3, "knowledge", 3, 2],
  [-1, -2, "animal", 2, 0],
  [0, -2, "animal", 1, 0],
  [1, -2, "castle", 6, 1],
  [2, -2, "knowledge", 5, 2],
  [3, -2, "building", 4, 3],
  [-2, -1, "animal", 5, 0],
  [-1, -1, "animal", 4, 0],
  [0, -1, "building", 3, 4],
  [1, -1, "knowledge", 1, 2],
  [2, -1, "building", 2, 3],
  [3, -1, "building", 3, 3],
  [-3, 0, "ship", 6, 5],
  [-2, 0, "ship", 1, 5],
  [-1, 0, "ship", 2, 5],
  [0, 0, "castle", 6, 6],
  [1, 0, "ship", 5, 7],
  [2, 0, "ship", 4, 7],
  [3, 0, "ship", 1, 7],
  [-3, 1, "building", 2, 8],
  [-2, 1, "building", 5, 8],
  [-1, 1, "mine", 4, 9],
  [0, 1, "building", 3, 10],
  [1, 1, "building", 1, 10],
  [2, 1, "animal", 2, 11],
  [-3, 2, "building", 6, 8],
  [-2, 2, "mine", 1, 9],
  [-1, 2, "knowledge", 2, 12],
  [0, 2, "building", 5, 10],
  [1, 2, "building", 6, 10],
  [-3, 3, "mine", 3, 9],
  [-2, 3, "knowledge", 4, 12],
  [-1, 3, "knowledge", 1, 12],
  [0, 3, "building", 3, 10],
];

// Independently inspected source diagrams, then checked against their raster
// colors and pip counts; no third-party implementation or artwork is shipped.
// https://github.com/mangorine/Burgundy/tree/main/images/boards
// Anchor tuple: row-major cell id, color, die.
const anchors: Record<number, [number, Color, number][]> = {
  2: [[0, "ship", 6], [12, "building", 1], [18, "building", 6], [31, "knowledge", 5], [36, "castle", 3]],
  3: [[0, "animal", 6], [12, "knowledge", 1], [18, "castle", 6], [31, "mine", 5], [36, "building", 3]],
  4: [[0, "castle", 6], [12, "ship", 1], [18, "knowledge", 6], [31, "knowledge", 5], [36, "castle", 3]],
  5: [[0, "animal", 6], [12, "ship", 1], [18, "knowledge", 6], [31, "castle", 5], [36, "mine", 3]],
  6: [[0, "knowledge", 6], [12, "ship", 1], [18, "castle", 6], [31, "animal", 5], [36, "castle", 3]],
  7: [[0, "knowledge", 6], [12, "building", 1], [18, "building", 6], [31, "knowledge", 5], [36, "knowledge", 3]],
  8: [[0, "building", 6], [12, "knowledge", 1], [18, "mine", 6], [31, "castle", 5], [36, "building", 3]],
  9: [[0, "building", 6], [12, "animal", 1], [18, "mine", 6], [31, "building", 5], [36, "building", 3]],
};
// Source-space connected components, in the colors order above. These are
// fixed expectations, not computed from BOARDS while constructing the tests.
const regionSizes: Record<number, number[][]> = {
  1: [[1, 3], [3, 3], [1, 5], [3], [3, 3], [1, 3, 3, 5]],
  2: [[1, 1, 1, 1], [2, 2, 2], [2, 4], [1, 2], [2, 2, 2], [2, 2, 8]],
  3: [[1, 1, 1, 1], [1, 2, 3], [2, 4], [1, 2], [6], [1, 1, 5, 5]],
  4: [[1, 1, 1, 1], [1, 1, 4], [3, 3], [1, 2], [3, 3], [2, 5, 5]],
  5: [[1, 1, 1, 1], [1, 2, 3], [3, 3], [1, 2], [1, 2, 3], [1, 2, 3, 3, 3]],
  6: [[1, 1, 1, 1], [6], [2, 4], [1, 1, 1], [3, 3], [2, 4, 6]],
  7: [[2, 2], [2, 2, 2], [3, 3], [1, 1, 1], [2, 2, 2], [2, 3, 7]],
  8: [[1, 1, 1, 1], [1, 1, 1, 1, 1, 1], [6], [1, 2], [2, 4], [2, 2, 2, 2, 2, 2]],
  9: [[1, 1, 1, 1], [2, 4], [2, 4], [1, 2], [1, 1, 1, 3], [6, 6]],
};

it("exports exactly original estates 1–9 and preserves the complete #1 reference", () => {
  expect(Object.keys(BOARDS).map(Number)).toEqual(ids);
  expect(BOARD).toBe(BOARDS[1]);
  expect(BOARD).toEqual(original.map(([q, r, color, die, region], id) => ({
    id, q, r, color, die, region,
  })));
  expect(START_CELL).toBe(18);
  expect(BOARD[START_CELL]).toMatchObject({ q: 0, r: 0, color: "castle", die: 6 });
});

it("resolves the selected estate and defaults old or unknown selections to #1", () => {
  expect(boardFor({})).toBe(BOARD);
  expect(boardFor({ boardId: undefined })).toBe(BOARD);
  expect(boardFor({ boardId: 0 })).toBe(BOARD);
  expect(boardFor({ boardId: 10 })).toBe(BOARD);
  for (const id of ids) expect(boardFor({ boardId: id })).toBe(BOARDS[id]);
});

it("preserves the six physical boards and their source-confirmed front/back pairings", () => {
  // http://www.fwtwr.com/fwtwr/cob/boards.asp, Base Game Boards, "Backed by".
  expect(BOARD_SIDES).toEqual([[1, 2], [1, 3], [1, 4], [1, 5], [6, 7], [8, 9]]);
  expect(BOARD_SIDES.flat().sort((a, b) => a - b)).toEqual([
    1, 1, 1, 1, 2, 3, 4, 5, 6, 7, 8, 9,
  ]);
  for (const pair of BOARD_SIDES) {
    for (const id of pair) expect(BOARDS[id]).toBeDefined();
  }
});

describe.each(ids)("estate #%i", (id) => {
  const board = BOARDS[id];

  it("has 37 distinct radius-three axial cells with the original color inventory", () => {
    expect(board).toHaveLength(37);
    expect(board.map((c) => c.id)).toEqual(Array.from({ length: 37 }, (_, i) => i));
    expect(new Set(board.map((c) => `${c.q},${c.r}`)).size).toBe(37);
    expect(board.map((c) => [c.q, c.r])).toEqual(original.map(([q, r]) => [q, r]));
    for (const c of board) {
      expect(Number.isInteger(c.q) && Number.isInteger(c.r)).toBe(true);
      expect(Math.max(Math.abs(c.q), Math.abs(c.r), Math.abs(c.q + c.r))).toBeLessThanOrEqual(3);
      expect(colors).toContain(c.color);
      expect(Number.isInteger(c.die) && c.die >= 1 && c.die <= 6).toBe(true);
    }
    expect(colors.map((color) => board.filter((c) => c.color === color).length))
      .toEqual([4, 6, 6, 3, 6, 12]);
    if (id !== 1) {
      for (const c of board) expect(c).not.toBe(BOARD[c.id]);
    }
  });

  it("matches all source die values and the independent representative cells", () => {
    // All 333 source dice were checked: the same printed pattern on every board.
    expect(board.map((c) => c.die)).toEqual(original.map(([, , , die]) => die));
    for (const [cell, color, die] of anchors[id] ?? []) {
      expect(board[cell]).toMatchObject({ id: cell, color, die });
    }
  });

  it("uses exactly maximal connected same-color regions and source region sizes", () => {
    const positions = new Map(board.map((c) => [`${c.q},${c.r}`, c]));
    const regions = new Map<number, Cell[]>();
    for (const cell of board) {
      expect(Number.isInteger(cell.region) && cell.region >= 0).toBe(true);
      const group = regions.get(cell.region) ?? [];
      group.push(cell);
      regions.set(cell.region, group);
      for (const [q, r] of directions) {
        const neighbor = positions.get(`${cell.q + q},${cell.r + r}`);
        if (neighbor?.color === cell.color) expect(neighbor.region).toBe(cell.region);
      }
    }
    expect([...regions.keys()]).toEqual(Array.from({ length: regions.size }, (_, i) => i));
    for (const cells of regions.values()) {
      expect(new Set(cells.map((c) => c.color)).size).toBe(1);
      const reached = new Set([cells[0].id]);
      const pending = [cells[0]];
      while (pending.length) {
        const c = pending.pop()!;
        for (const [q, r] of directions) {
          const n = positions.get(`${c.q + q},${c.r + r}`);
          if (n && n.region === c.region && !reached.has(n.id)) {
            reached.add(n.id);
            pending.push(n);
          }
        }
      }
      expect(reached.size).toBe(cells.length);
    }
    expect(colors.map((color) => [...regions.values()]
      .filter((cells) => cells[0].color === color)
      .map((cells) => cells.length).sort((a, b) => a - b)))
      .toEqual(regionSizes[id]);
  });
});
