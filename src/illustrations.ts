import type { Animal, Building, Color, Tile } from "./types";

// Matte printed miniatures: one olive-ink contour, a restrained pigment palette,
// and paper highlights from the upper left. No filters, gradients, or SVG IDs.
const C = {
  ink: "#454a3b", ivory: "#f0e7d2", stone: "#d6c5a3", shade: "#a8916d",
  shadow: "#777056", recess: "#2f3931",
  gold: "#b3975b", light: "#e3d5b4", roof: "#843d50", red: "#562c3d",
  teal: "#698479", deep: "#3f6056", blue: "#a6b5a4", green: "#7c8967",
  timber: "#977b58", timberDeep: "#6c5943", silver: "#cbd1c5", silverLight: "#e0e3d6",
  slate: "#798985", slateDeep: "#53675f", indigo: "#687a91", indigoDeep: "#4e5d77",
  indigoLight: "#a4b1be", rose: "#c69c8b", roseLight: "#dec1ac", roseShade: "#ab8173",
  copper: "#aa815e", copperLight: "#d4b187", lavender: "#958791",
};
const contour = 1.5;
const path = (d: string, fill: string, stroke = C.ink, width = contour) =>
  `<path d="${d}" fill="${fill}" stroke="${stroke}" stroke-width="${width}" stroke-linejoin="round" stroke-linecap="round"/>`;
const etch = (d: string, stroke = C.ink, opacity = 0.4) =>
  `<path d="${d}" fill="none" stroke="${stroke}" stroke-width=".9" stroke-opacity="${opacity}" stroke-linecap="round" stroke-linejoin="round"/>`;
const rect = (x: number, y: number, w: number, h: number, fill: string, radius = 0) =>
  `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${radius}" fill="${fill}"/>`;
const circle = (x: number, y: number, r: number, fill: string, stroke = "none") =>
  `<circle cx="${x}" cy="${y}" r="${r}" fill="${fill}" stroke="${stroke}" stroke-width="${contour}"/>`;
const ellipse = (x: number, y: number, rx: number, ry: number, fill: string, stroke = "none") =>
  `<ellipse cx="${x}" cy="${y}" rx="${rx}" ry="${ry}" fill="${fill}" stroke="${stroke}" stroke-width="${contour}"/>`;
const group = (transform: string, content: string) => `<g transform="${transform}">${content}</g>`;
const svg = (content: string, size: number) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 64 64" aria-hidden="true" focusable="false">${content}</svg>`;
const ground = () => ellipse(33, 57.5, 23, 1.5, "#454a3b18");
const arch = (x: number, y: number, w: number, h: number, fill = C.recess) =>
  path(`M${x} ${y + h}V${y + w / 2}a${w / 2} ${w / 2} 0 0 1 ${w} 0v${h - w / 2}Z`, fill, C.ink, 1);
const windows = (xs: number[], y: number, w = 5, h = 9) =>
  xs.map((x) => arch(x, y, w, h)).join("");
const plinth = (x = 7, y = 53, w = 50) =>
  path(`M${x} ${y}h${w}l1.5 4h${-w - 3}Z`, C.stone) +
  path(`M${x + 1} ${y + 1}h${w - 2}`, "none", C.ivory, 1);
const roof = (x: number, y: number, w: number, h: number) =>
  path(`M${x} ${y + h}L${x + w * 0.47} ${y} ${x + w} ${y + h}Z`, C.roof) +
  path(`M${x + w * 0.47} ${y + 1}L${x + w - 1.5} ${y + h - 1}H${x + w * 0.55}Z`, C.red, "none") +
  etch(`M${x + w * 0.18} ${y + h * 0.76}L${x + w * 0.46} ${y + h * 0.15}`, C.light, 0.55);
const facade = (x: number, y: number, w: number, h: number) =>
  path(`M${x} ${y}h${w}v${h}H${x}Z`, C.ivory) +
  rect(x + w - 6, y + 1, 5, h - 2, C.shade) +
  rect(x + 1, y + 1, w - 2, 4, C.shadow) +
  etch(`M${x + w - 6} ${y + h * 0.4}h5m-5 ${h * 0.35}h5`, C.shadow, 0.65);
const coin = (x: number, y: number, r: number, silver = false) =>
  circle(x + 0.5, y + 1.5, r, silver ? C.slate : C.timberDeep, C.ink) +
  circle(x, y, r, silver ? C.silver : C.gold, C.ink) +
  `<circle cx="${x}" cy="${y}" r="${r - 2.5}" fill="none" stroke="${silver ? C.slate : C.timber}" stroke-width="1"/>` +
  etch(`M${x - r + 2} ${y}a${r - 2} ${r - 2} 0 0 1 ${r - 2} ${2 - r}`, silver ? C.silverLight : C.ivory, 0.9) +
  path(`M${x} ${y - r + 3}l2 ${r - 3}-2 ${r - 3}-2 ${3 - r}Z`, silver ? C.slateDeep : C.ivory, "none");

const castle = ground() +
  facade(17, 24, 30, 30) + path("M18 28l28-.3v4l-28 .4Z", C.shadow, "none") +
  facade(7, 22, 14, 32) + facade(43, 19, 14, 35) +
  roof(4, 8, 20, 16) + roof(40, 5, 20, 16) +
  path("M22 29l.3-13 5 .2v5l4.4-.2v-5h5.1v5l4.5.2v-5h5L46 29Z", C.ivory) +
  path("M34 16V3m0 0 12 1-4 3 3 3-11-1", C.roof, C.ink, 1.3) +
  windows([11, 47], 29, 5, 10) + arch(26, 36, 12, 18) +
  path("M28 53l.2-10q1-5 4-5l-.2 15Z", C.shadow, "none") +
  etch("M30 43v8m4-8v8M24 32h6m6 0h5M25 24h5m5 2h6", C.ink, 0.5) +
  path("M7 45l14 .3v2H7Z", C.stone, "none") + path("M43 44l14-.2V46H43Z", C.stone, "none") + plinth();

const ship =
  path("M4 54q7-4 14-1t14 0 14 0 14-1v5H4Z", C.teal, "none") +
  path("M5 44q20 5 53-4L48 53H16Z", C.timberDeep) +
  path("M8 44q24 3 47-3l-3 5q-23 6-41 2Z", C.timber, "none") +
  etch("M15 50q18 3 36-3", C.light, 0.5) +
  path("M30 46V6M13 13L52 33", "none", C.ink, 2) +
  path("M16 15L49 32L18 38Q26 28 16 15Z", C.roof) +
  path("M31 24l16 8-17 3Z", C.red, "none") +
  etch("M21 20q5 8 2 14l19-3", C.light, 0.65) +
  path("M35 28h6l4 3-10 1Z", C.recess, "none") +
  path("M34 10L53 28H35Z", C.ivory) +
  path("M35 13l5 14h11Z", C.shade, "none") +
  `<g class="harbor-pennant">${path("M30 6l11 1-6 5-5-1Z", C.gold)}</g>` +
  rect(18, 39, 8, 5, C.stone, 1) + rect(34, 37, 9, 6, C.red, 1) +
  path("M8 56q5-2 10 0m10 0q5-2 10 0m9 0q5-2 10 0", "none", C.blue, 1);

const knowledge = ground() +
  path("M5 15q16-4 27 4 11-8 27-4v35q-16-3-27 5Q20 47 5 50Z", C.red) +
  path("M8 11q12-3 24 5 12-8 24-5v34q-13-2-24 5Q21 43 8 45Z", C.ivory) +
  path("M32 16q8-5 12-5v33q-7 1-12 6Z", C.stone, "none") +
  path("M32 17v32", "none", C.shade, 1) +
  rect(12, 18, 12, 14, C.teal, 1) +
  path("M18 29v-8m0 5q-5 0-3-4 3 0 3 4m0-2q0-4 4-3 0 4-4 3", "none", C.ivory, 1.3) +
  path("M38 22l5-5 5 4-5 6Z", C.gold, "none") +
  path("M12 36l14 3m-14 2 14 3m11-13 14-3m-14 8 14-3", "none", C.shade, 1.5) +
  path("M45 43v13l4-3 4 3V41", C.roof);

const mine = ground() +
  path("M5 50l8-23 14-12 8 4 12-4 13 35Z", C.slate) +
  path("M13 27l14-12 8 4-9 12-8 19H5Z", C.silver, "none") +
  path("M35 19l12-4 13 35H39l5-19Z", C.slateDeep, "none") +
  etch("M14 29l7-7M47 24l6 17", C.ivory, 0.5) +
  path("M20 52V34l7-8h14l6 8v18Z", C.recess) +
  path("M19 52V31l7-9h18l6 9v21h-6V33l-4-5H29l-4 5v19Z", C.timber) +
  path("M40 28l4 5v19h3V32l-5-7Z", C.timberDeep, "none") +
  path("M20 31l7-8h16", "none", C.light, 1) +
  etch("M21 36v13m25-14v13") +
  path("M31 51l-3-12 6-8 6 8-3 12Z", C.silverLight) +
  path("M34 31v20h3l3-12Z", C.slate, "none") +
  path("M40 53l1-10 7-4 6 7-5 7Z", C.gold) +
  path("M48 39l-1 14h2l5-7Z", C.timber, "none") + coin(17, 51, 5, true);

const buildings: Record<Building, string> = {
  warehouse: ground() + facade(7, 29, 49, 25) + roof(3, 12, 58, 19) +
    arch(12, 36, 21, 18, C.timberDeep) +
    path("M22.5 37V54M13 44h19m-19 6h19", "none", C.stone, 1) +
    path("M38 41h15v13H38Z", C.timber) +
    path("M39 42l13 11m0-11L39 53", "none", C.light, 1) +
    path("M41 34h10v7H41Z", C.roof) + windows([26], 23, 7, 6) + plinth(),
  workshop: ground() + facade(8, 32, 44, 22) +
    path("M40 32l1-23h8l1 25Z", C.stone) + path("M39 8h12v4H39Z", C.red) +
    path("M45 6q-4-2-1-4", "none", C.slate, 1.5) + roof(3, 17, 53, 17) +
    arch(13, 36, 19, 18, C.red) +
    path("M17 52q-2-6 4-10l3 5 3-8q6 8 0 13Z", C.gold, "none") +
    path("M38 45l15-15 3 3-15 15Z", C.timber) +
    path("M47 28l6-4 8 8-5 4Z", C.slate) +
    etch("M49 28l4-2 5 5", C.ivory, 0.8) +
    path("M35 49h21l-4 4H39Z", C.deep) + plinth(),
  church: ground() + facade(8, 36, 46, 18) + roof(5, 24, 53, 14) +
    facade(22, 23, 17, 31) + roof(19, 7, 23, 18) +
    path("M30 9V2m-3 3h6", "none", C.ink, 1.5) +
    arch(26, 27, 9, 11) + path("M28 33l1-4h3l1 4Z", C.gold, "none") +
    arch(26, 41, 10, 13) + windows([12, 45], 43, 5, 9) + plinth(),
  market: ground() +
    path("M10 28v26m43-26v26", "none", C.timberDeep, 2.5) +
    path("M4 29l10-17q18 2 36 0l10 17q-27 3-56 0Z", C.ivory) +
    path("M14 12l8 .6-3 17.8L4 29ZM31 13h9l3 17.5-15 .5ZM47 12.3l3-.3 10 17-9 .8Z", C.roof, "none") +
    path("M4 29v3q7 4 15 1 8 4 13 1 8 3 13-1 8 3 15-1v-3q-27 3-56 0Z", C.red) +
    path("M7 44h49v11H7Z", C.stone) + rect(8, 45, 47, 2, C.light) +
    etch("M18 48v5m13-5v5m13-5v5", C.shade, 0.7) +
    circle(15, 40, 3, C.roof) + circle(21, 38, 4, C.gold) + circle(26, 41, 3, C.green) +
    path("M36 43l-2-10h8l-2 10Z", C.teal) + rect(46, 36, 6, 7, C.red, 1),
  boarding: ground() + facade(13, 28, 35, 26) +
    path("M39 21V9h6v15Z", C.red) + roof(7, 5, 47, 25) + windows([18, 37], 32, 6, 7) +
    arch(25, 41, 11, 13, C.red) +
    path("M14 30v23m33-23v23M14 40h33M15 42l7 10m23-10-7 10", "none", C.timberDeep, 1.5) +
    path("M48 26h10v6", "none", C.ink) +
    path("M51 32h11v14H51Z", C.teal) +
    path("M57 35a4 4 0 1 0 2 7 4 4 0 0 1-2-7Z", C.ivory, "none") + plinth(9, 54, 44),
  bank: ground() + facade(9, 28, 46, 25) + roof(5, 8, 54, 22) +
    path("M8 29h48v3H8Z", C.stone, "none") + windows([12, 23, 34, 45], 35, 7, 15) +
    circle(31, 22, 4.5, C.gold, C.ink) + path("M31 19l1.5 3-1.5 3-1.5-3Z", C.ivory, "none") + plinth(5, 52, 54) +
    coin(44, 52, 6) + coin(53, 55, 5),
  hall: ground() + facade(8, 29, 48, 25) + roof(4, 16, 56, 15) +
    facade(24, 15, 16, 24) + roof(21, 3, 22, 14) +
    circle(32, 24, 4.2, C.ivory, C.ink) + path("M32 21v3l2 1", "none", C.red, 1) +
    windows([13, 45], 31, 6, 9) + arch(27, 40, 10, 14) +
    path("M17 40h5v11l-2.5-3-2.5 3Z", C.roof, "none") +
    path("M42 40h5v11l-2.5-3-2.5 3Z", C.teal, "none") + plinth(),
  watchtower: ground() + facade(21, 21, 22, 33) +
    path("M17 24V11h6v6h5v-6h8v6h5v-6h6v13Z", C.ivory) +
    path("M17 24h30l-4 5H21Z", C.stone) + rect(38, 30, 4, 23, C.stone) +
    arch(29, 32, 6, 12) + arch(27, 47, 10, 8, C.timberDeep) +
    path("M32 11V2m0 0 14 1-5 3 4 3-13-1Z", C.roof) +
    path("M20 45l5 1v8h-7Zm19 1 5-1 2 9h-7Z", C.stone) + plinth(15, 54, 34),
};

const legs = (color: string) =>
  path("M16 43v12h6V44m18-1v12h6V43", color) +
  rect(16, 53, 6, 3, C.ink) + rect(40, 53, 6, 3, C.ink);
const animals: Record<Animal, string> = {
  sheep: ground() + legs(C.shade) +
    path("M10 39q-8-7 0-12-2-10 8-10 5-8 12-3 10-5 14 3 9 0 10 8l-4 16q-5 10-14 7-7 5-14-1-11 1-12-8Z", C.ivory) +
    path("M11 36q-1 9 10 7 7 6 15 1l9-7v10q-6 5-11 1-9 3-13-1-9 1-11-8Z", C.stone, "none") +
    path("M43 26q-5-10-10-5l8 10m10-4q7-7 10-1l-8 7", C.slate) +
    path("M42 25q7-4 13 2l-1 12q-5 9-12 0Z", C.slateDeep) +
    path("M43 25q4-8 10-2l2 5Z", C.ivory, "none") +
    path("M16 24q3-4 7-1m-3 11q3 4 7 0m4-12q4-2 6 2", "none", C.stone, 1.5) +
    circle(46, 31, 1.2, C.ivory) + circle(52, 31, 1.2, C.ivory),
  cattle: ground() + legs(C.ivory) +
    path("M10 31q-8-4-6 9", "none", C.ink, 1.5) +
    path("M10 26q7-8 24-5l14 5v17q-8 8-28 3-12-3-10-20Z", C.ivory) +
    path("M12 38q10 9 34 1v4q-8 7-25 3-7-1-9-8Z", C.stone, "none") +
    path("M15 23q5 6 2 11 8 6 15-1l-2-12q-8-2-15 2Zm18 17 12-9 2 12-7 3Z", C.timberDeep, "none") +
    path("M40 25q-9-6-5-14l7 7m12 6q10-5 7-13l-7 7", C.stone) +
    path("M40 21q7-5 15 1l3 17-9 7-12-6Z", C.timber) +
    path("M45 20h5l-1 13h-5Z", C.ivory, "none") +
    ellipse(48, 39, 10, 6, C.roseLight, C.ink) + circle(42, 29, 1.5, C.ink) + circle(54, 29, 1.5, C.ink) +
    circle(44, 39, 1.2, C.timberDeep) + circle(52, 39, 1.2, C.timberDeep),
  pig: ground() + legs(C.roseShade) +
    path("M10 34q-9-1-7-8 5-4 6 1-1 3-4 1", "none", C.ink, 1.5) +
    path("M10 26q12-15 31-4 12 5 10 17-1 13-22 11-24-1-19-24Z", C.rose) +
    path("M12 39q16 13 37-2-1 14-22 13-14-1-15-11Z", C.roseShade, "none") +
    path("M37 25l-3-13q9 1 12 10l7-8 2 17", C.rose) +
    path("M38 18l2 8 4-3m5 3 3-6v8", C.roseShade, "none") +
    ellipse(49, 36, 12, 9, C.roseLight, C.ink) + circle(45, 37, 1.5, C.timberDeep) + circle(53, 37, 1.5, C.timberDeep) +
    circle(37, 29, 1.5, C.ink) + circle(52, 28, 1.5, C.ink) +
    etch("M17 26q6-5 14-2", C.ivory, 0.65),
  chicken: ground() +
    path("M27 47v8h-6m18-9v9h6", "none", C.timber, 2) +
    path("M19 40Q3 35 4 19l10 9Q8 13 15 12l11 21", C.deep) +
    path("M11 26l11 10M16 20l8 11", "none", C.blue, 1) +
    path("M18 34q5-13 16-12l6-6 9 5q2 10-1 21-5 11-18 8-14-1-12-16Z", C.ivory) +
    path("M21 36q10-10 19-2-1 10-11 10Z", C.stone) +
    etch("M25 36q3 4 6 4m0-6q3 3 5 3", C.shade, 0.75) +
    path("M37 21q-6-8 0-10l4 4q1-11 6-7l1 7q9-6 9 1l-9 9Z", C.roof) +
    path("M48 25l12 5-11 3Z", C.gold) +
    path("M48 32q9 5 4 10-7 2-7-6", C.roof) + circle(44, 25, 1.8, C.ink),
};

const colors: Record<Color, string> = {
  castle, ship, knowledge, mine, animal: animals.sheep, building: buildings.hall,
};

// Quantities belong in the surrounding HTML badge, never inside the miniature.
export function iconSvg(tile: Pick<Tile, "color" | "building" | "animal">, size = 32): string {
  return svg(tile.building ? buildings[tile.building] : tile.animal ? animals[tile.animal] : colors[tile.color], size);
}

const goods: Record<number, string> = {
  // Silk: folded burgundy brocade and a green bolt with an ochre selvage.
  1: ground() + path("M8 20l34-7 12 8-33 9Z", C.rose) +
    path("M8 20l13 10 33-9v24L21 56 8 45Z", C.roof) +
    path("M21 30l33-9v24L21 56Z", C.red, "none") +
    path("M13 24v21l8 7 28-10V27", "none", C.gold, 1.5) +
    path("M29 32l4-3 4 3-4 4Zm11 8 4-3 4 3-4 4Z", C.light, "none") +
    path("M10 11l28-4 7 8-28 7Z", C.teal) + path("M10 11v8l7 6 28-7v-3l-28 7Z", C.deep) +
    path("M14 11l5 8 22-4", "none", C.light, 1),
  // Spices: an open saffron sack, cinnamon and star anise.
  2: ground() + path("M14 28l4-12h27l5 12-4 4q12 20-1 24H16Q2 52 16 32Z", C.timber) +
    path("M18 29q-9 18-4 23h22q-6-10 5-23Z", C.stone, "none") +
    ellipse(32, 22, 15, 8, C.timberDeep, C.ink) + path("M18 22l5-8 7-3 7 2 10 9Z", C.gold) +
    etch("M22 21l5-5m3 3 3-5", C.light, 0.75) +
    path("M17 31q15 5 29 0", "none", C.light, 1.5) +
    path("M35 50l19-12 3 5-19 12Z", C.roof) + etch("M39 52l15-10", C.light, 0.65) +
    path("M21 38l2 5 5-2-3 5 4 4-6-1-2 5-1-6-6-1 5-3Z", C.timberDeep, "none"),
  // Ceramics: a green amphora with two handles and an ivory maker's mark.
  3: ground() + path("M21 25Q5 17 10 37q3 9 13 3m18-15q16-8 11 12-3 9-13 3", "none", C.ink, 4.5) +
    path("M21 25Q5 17 10 37q3 9 13 3m18-15q16-8 11 12-3 9-13 3", "none", C.stone, 2) +
    path("M25 11h14v11q0 5 7 10 8 15-5 22H23Q10 47 18 32q7-5 7-10Z", C.teal) +
    path("M27 16v11q-14 15-3 23h7q-9-13 0-23V16Z", C.blue, "none") +
    path("M40 29q13 14 0 24h-7q9-10 7-24Z", C.deep, "none") +
    path("M23 9h18v5H23Z", C.ivory) + path("M20 35q12 5 24 0m-22 9q10 4 20 0", "none", C.gold, 1.5) +
    path("M30 36l-4 5 5 4 5-4Z", C.ivory, "none") + path("M23 53h18v3H23Z", C.stone),
  // Dyes: indigo pigment and a stoppered vial of madder.
  4: ground() + path("M12 23h26l-3 29H15Z", C.indigo) +
    path("M30 31h6l-2 20h-7Z", C.indigoDeep, "none") +
    path("M12 23h26v7H12Z", C.stone) + ellipse(25, 23, 13, 5, C.light, C.ink) +
    path("M14 23l5-9 9-4 8 13Z", C.indigoDeep) +
    path("M19 20l8-8-3 11Z", C.indigoLight, "none") +
    path("M44 24h10v9l6 8v12q-9 5-18 0V41l2-8Z", C.lavender) +
    path("M43 44h16v9q-8 4-16 0Z", C.roof, "none") + path("M44 23h10v6H44Z", C.timber) +
    etch("M46 34v6", C.ivory, 0.75) + rect(18, 36, 13, 9, C.ivory) + circle(24.5, 40.5, 3, C.indigoDeep),
  // Copperware: an ewer with a high handle and a shallow serving dish.
  5: ground() + path("M37 24q18-15 19 2t-15 15", "none", C.ink, 5) +
    path("M37 24q18-15 19 2t-15 15", "none", C.copper, 2.5) +
    path("M18 18h23l-4 10q13 17-2 25H21Q8 46 21 30L10 19l2-7Z", C.copper) +
    path("M21 20h6l-1 13q-9 14 1 18h-6Q9 45 21 30Z", C.copperLight, "none") +
    ellipse(29.5, 18, 11.5, 3, C.timberDeep, C.ink) +
    path("M18 41q10 5 22 0", "none", C.gold, 1.5) + ellipse(44, 54, 16, 4, C.timber, C.ink) +
    ellipse(44, 52, 16, 4, C.copperLight, C.ink) + ellipse(44, 52, 11, 2, C.copper),
  // Wool: pale skeins bound with a burgundy thread and a wooden spindle.
  6: ground() + path("M9 29q0-14 14-15 13 1 13 15v14q-1 11-14 11T9 43Z", C.ivory) +
    path("M15 19q-6 13 0 29m7-30q-4 15 0 32m7-30q-2 14 0 28", "none", C.stone, 1.5) +
    path("M8 31q14 4 28 0v7q-14 5-28 0Z", C.roof) +
    ellipse(44, 42, 14, 13, C.stone, C.ink) +
    path("M33 37q19-7 22 5m-24 0q17-6 24 5m-14-17q-9 13-1 23m7-23q-7 14 0 24", "none", C.ivory, 1.5) +
    path("M38 8l18 23", "none", C.timberDeep, 2) +
    path("M37 14l5-4 11 17-5 4Z", C.ivory) + path("M40 15l5-1m-3 5 5-1m-3 5 5-1", "none", C.stone, 1),
};

export function goodsIcon(type: number, size = 32): string {
  return svg(goods[type] ?? goods[1], size);
}

export function crownIcon(size = 36): string {
  return svg(
    path("M9 23l12 10L32 12l11 21 12-10-5 28H14Z", C.gold) +
    path("M32 15l11 20 10-9-4 20H34Z", C.shade, "none") +
    path("M14 45h36v8H14Z", C.light) +
    circle(9, 22, 3, C.gold, C.ink) + circle(32, 11, 3, C.gold, C.ink) + circle(55, 22, 3, C.gold, C.ink) +
    path("M32 33l4 5-4 5-4-5Z", C.red) +
    circle(19, 40, 2, C.ivory) + circle(45, 40, 2, C.ivory), size,
  );
}

export function resourceIcon(kind: "silver" | "workers" | "ships", size = 28): string {
  if (kind === "ships") return svg(ship, size);
  if (kind === "silver") return svg(ground() + coin(20, 43, 13, true) + coin(42, 42, 13, true) + coin(31, 24, 15, true), size);
  return svg(ground() +
    path("M8 55l3-16 10-7h20l11 7 4 16Z", C.teal) +
    path("M41 35l10 6 4 13H43Z", C.deep, "none") +
    path("M21 35l10 8 10-8 5 20H16Z", C.stone) +
    path("M25 30v8l6 5 7-5v-8", C.roseShade) +
    path("M19 17q13-13 25 0l-3 12q-10 12-19 0Z", C.roseLight) +
    path("M38 18h5l-3 11-5 4Z", C.rose, "none") +
    path("M16 18q0-14 16-14 12 0 14 12l-8 4-10-3-12 5Z", C.roof) +
    etch("M21 12q3-5 9-5", C.light, 0.55) +
    path("M18 15q11-5 25 0", "none", C.gold, 1.5) +
    circle(26, 23, 1.2, C.ink) + circle(36, 23, 1.2, C.ink) +
    path("M28 30q3 2 6 0", "none", C.timberDeep, 1) +
    path("M43 53l8-24m-5-2 11 4-2 6-11-4Z", C.timber), size);
}

/** A text-free port vignette, sized by its container rather than a fixed width. */
export function harborScene(): string {
  const palazzo = (x: number, y: number, w: number, h: number, color: string) =>
    group(`translate(${x} ${y})`,
      path(`M0 0h${w}v${h}H0Z`, color, C.shade, 0.8) +
      path(`M-4 0l8-10h${w - 8}l8 10Z`, C.roof, "none") +
      rect(1, 4, w - 2, 3, C.ivory) +
      windows(Array.from({ length: Math.floor(w / 15) }, (_, i) => 6 + i * 15), 14, 6, 14) +
      windows(Array.from({ length: Math.floor(w / 19) }, (_, i) => 6 + i * 19), h - 23, 10, 23) +
      rect(0, h - 29, w, 3, C.ivory));
  return `<svg xmlns="http://www.w3.org/2000/svg" width="760" height="180" viewBox="0 0 760 180" preserveAspectRatio="xMidYMid slice" style="display:block;max-width:100%" aria-hidden="true" focusable="false">` +
    rect(0, 0, 760, 180, C.ivory) + circle(583, 33, 23, C.light) +
    path("M0 73Q90 42 151 63T304 59 459 58 613 52 760 59V123H0Z", C.silver, "none") +
    path("M0 84h37V66h20V52h8v14h24v19h20V69h21v17h35V57h27v25h37V64h28v20h26V50h8v35h39v31H0Z", C.blue, "none") +
    palazzo(0, 63, 70, 59, C.shade) + palazzo(78, 45, 72, 77, C.light) +
    palazzo(154, 61, 53, 61, C.rose) + palazzo(218, 34, 85, 88, C.stone) +
    palazzo(313, 65, 60, 57, C.copperLight) +
    group("translate(189 3)", facade(0, 26, 19, 92) + rect(1, 28, 5, 88, C.stone) + roof(-5, 11, 29, 16) +
      rect(-3, 26, 25, 4, C.ivory) + windows([5, 12], 33, 3, 14) +
      circle(9.5, 62, 6, C.ivory) + path("M9.5 58v5h3", "none", C.red, 1) +
      path("M10 11V3", "none", C.gold, 1.5)) +
    path("M0 119h378v7H0Z", C.stone, "none") +
    path("M0 127q86-9 176 0t176 0 176-3 232-2v58H0Z", C.teal, "none") +
    `<g class="harbor-water">` +
    path("M0 143q82-9 169-1t170-2 172-2 249-1M4 166q76-7 145-2t169-1 176-5 266 0", "none", C.blue, 1) +
    path("M10 130h48m31 7h24m44-5h60m35 10h37m-266 13h28m530 18h52m58-24h35m36 16h42", "none", C.silver, 1) + `</g>` +
    // A small arcaded bridge joins the quay and the merchant island.
    path("M351 124q50-68 101 0h-18q-34-41-65 0Z", C.ivory, C.shade, 1) +
    path("M352 111q50-48 98 0M366 98v13m13-21v11m15-17v12m15-12v12m15-6v12m13-5v13", "none", C.shade, 1.5) +
    // Large lateen merchant ship: the exact tile miniature, not a second icon.
    group("translate(440 -9) scale(2.75)", ship) +
    path("M598 154h162v26H582Z", C.stone, "none") +
    path("M600 156h160M597 163h163", "none", C.shade, 1) +
    group("translate(628 93) scale(1.16)", buildings.market) +
    group("translate(711 124) scale(.62)", goods[3]) +
    group("translate(604 141) scale(.49)", goods[1]) +
    // Portolan trade route and an eight-point compass, kept clear of architecture.
    `<path d="M325 164C377 128 421 159 447 149S536 112 626 89 675 53 710 37" fill="none" stroke="${C.gold}" stroke-width="1" stroke-dasharray="3 5"/>` +
    circle(326, 164, 3, C.gold) + circle(626, 89, 3, C.gold) +
    `<circle cx="710" cy="38" r="23" fill="none" stroke="${C.shade}" stroke-width=".8"/>` +
    group("translate(710 38)",
      path("M0-30 4-5 24-16 6-1 30 0 5 4 18 23 1 6 0 30-4 5-24 16-6 1-30 0-5-4-18-23-1-6Z", C.stone, C.shade, 0.8) +
      path("M0-30 0 0 4-5ZM30 0 0 0 5 4ZM0 30 0 0-4 5ZM-30 0 0 0-5-4Z", C.deep, "none") + circle(0, 0, 3, C.gold)) +
    path("M416 32q5-6 10 0 5-6 10 0m-369-8q4-5 8 0 4-5 8 0m495-6q4-5 8 0 4-5 8 0", "none", C.slate, 1) +
    `</svg>`;
}
