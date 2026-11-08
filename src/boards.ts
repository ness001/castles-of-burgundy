import type { Cell, Color } from "./types";

// Original estate facts, read from board1.jpg–board9.jpg (no artwork reused):
// https://github.com/mangorine/Burgundy/tree/main/images/boards
// Row-major axial coordinates: top to bottom, left to right.
// The printed dice are identical across the nine original estates.
const dice = [
  [6, 5, 4, 3],
  [2, 1, 6, 5, 4],
  [5, 4, 3, 1, 2, 3],
  [6, 1, 2, 6, 5, 4, 1],
  [2, 5, 4, 3, 1, 2],
  [6, 1, 2, 5, 6],
  [3, 4, 1, 3],
];
const colors: Record<string, Color> = {
  C: "castle", S: "ship", A: "animal",
  M: "mine", K: "knowledge", B: "building",
};
const layouts: Record<number, string[]> = {
  1: ["ACCK", "AACKB", "AABKBB", "SSSCSSS", "BBMBBA", "BMKBB", "MKKB"],
  2: ["SBAC", "ASBAB", "AAABKB", "BBBBBKC", "KKMKMS", "BBMKS", "CSSC"],
  3: ["AAAA", "SSCSS", "BMKKSB", "BBKCKBB", "BBKKBB", "CAMMC", "BASB"],
  4: ["CABS", "AABSS", "BBBSCM", "AAAKKMS", "BCKBBB", "BMBKK", "SBKC"],
  5: ["ABBS", "AABMM", "BCKSSS", "BBAKCBB", "KCAKSB", "BABCS", "KKBM"],
  6: ["KKCS", "KBBSB", "AAMSBB", "KBBCSBB", "KBBMSB", "KMAAS", "CAAC"],
  7: ["KCCS", "KAAAS", "SMBBMA", "SKBBBAB", "BKBBAB", "BSMKB", "SCCK"],
  8: ["BBSB", "SCKCB", "BKMKKS", "BAKMAKB", "SAAAMB", "BCACS", "BSBB"],
  9: ["BBCK", "BBAAS", "BBAASS", "CKKMSCK", "SSKMBA", "KBBBA", "MCBB"],
};

export const BOARDS: Record<number, Cell[]> = {};
for (const [number, rows] of Object.entries(layouts)) {
  const board: Cell[] = rows.flatMap((row, i) =>
    [...row].map((color, j) => ({
      id: 0,
      q: Math.max(-3, -i) + j,
      r: i - 3,
      color: colors[color],
      die: dice[i][j],
      region: -1,
    })),
  );
  board.forEach((cell, id) => (cell.id = id));
  let region = 0;
  for (const start of board) {
    if (start.region !== -1) continue;
    start.region = region;
    const queue = [start];
    while (queue.length) {
      const cell = queue.pop()!;
      for (const neighbor of board) {
        const q = cell.q - neighbor.q, r = cell.r - neighbor.r;
        if (
          neighbor.region === -1 && neighbor.color === cell.color &&
          Math.max(Math.abs(q), Math.abs(r), Math.abs(q + r)) === 1
        ) {
          neighbor.region = region;
          queue.push(neighbor);
        }
      }
    }
    region++;
  }
  BOARDS[Number(number)] = board;
}

export const BOARD = BOARDS[1];
export const START_CELL = 18;
// Physical front/back pairs, not all arbitrary pairs of estate numbers:
// http://www.fwtwr.com/fwtwr/cob/boards.asp ("Base Game Boards", "Backed by").
export const BOARD_SIDES: [number, number][] = [
  [1, 2], [1, 3], [1, 4], [1, 5], [6, 7], [8, 9],
];
export const boardFor = (player: { boardId?: number }): Cell[] =>
  BOARDS[player.boardId ?? 1] ?? BOARD;
