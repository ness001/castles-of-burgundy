import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { expect, test } from "@playwright/test";
import ts from "typescript";
import { createGame, knowledgeIds, legalActions } from "../src/engine";
import { rulesFor } from "../src/rules";

// Execute only the owning hint functions; no browser or app bootstrap is needed.
const source = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
const parsed = ts.createSourceFile("main.ts", source, ts.ScriptTarget.Latest, true);
const names = ["matching", "actionHint", "targetHint", "purchaseHint"];
const declarations = parsed.statements.filter(statement =>
  ts.isFunctionDeclaration(statement) && names.includes(statement.name?.text ?? ""));
const script = ts.transpileModule(declarations.map(statement => statement.getText(parsed)).join("\n"), {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;

for (const scenario of [
  {
    name: "exhausted numbered depots",
    depot: -1,
    mode: "take",
    expected: "The numbered depots are empty. Take workers for later, or choose another action.",
  },
  {
    name: "stock exists but neither die can afford it",
    depot: 3,
    mode: "take",
    expected: "No take is affordable with your dice and workers. Take workers for a later action.",
  },
  {
    name: "another die can reach the remaining stock",
    depot: 1,
    mode: "take",
    expected: "No choices with the selected die. Switch to die 2 (2) to take a market tile.",
  },
  {
    name: "purchase is blocked by silver, not a die",
    depot: 1,
    mode: "buy",
    expected: "Need 1 more silver · no die",
  },
]) {
  test(`source hints distinguish ${scenario.name} on desktop and mobile`, () => {
    expect(declarations).toHaveLength(names.length);
    const state = createGame(42);
    state.active = 0;
    state.players[0].dice = [1, 2];
    state.players[0].workers = 0;
    state.players[0].silver = 1;
    state.depots.forEach((depot, index) => {
      if (index !== scenario.depot) {
        depot.tiles.forEach(tile => state.pools[tile.color].push(tile));
        depot.tiles = [];
      }
    });
    const mobileLayout = { matches: false };
    const context = {
      state, actions: legalActions(state), selectedDie: 0, inspected: 0,
      mode: scenario.mode, panel: "estate", mobileLayout, knowledgeIds, rulesFor,
      humanTurn: () => true,
    };
    const hints = runInNewContext(`${script}\n({ actionHint, targetHint })`, context);
    if (scenario.mode === "take") expect(hints.actionHint("take")).toBe(scenario.expected);
    expect(hints.targetHint()).toBe(scenario.expected);
    mobileLayout.matches = true;
    expect(hints.targetHint()).toBe(`Market · ${scenario.expected}`);
  });
}
