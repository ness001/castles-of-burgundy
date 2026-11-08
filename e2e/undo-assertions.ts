import { expect, type Page } from "@playwright/test";
import type { State } from "../src/types";

export async function expectRestored(
  page: Page,
  before: State,
  undo: () => Promise<unknown>,
  label?: string,
): Promise<State> {
  const saved = (): Promise<State> => page.evaluate(() =>
    JSON.parse(localStorage.getItem("burgundy-table.state.v1")!));
  const current = await saved();
  await undo();
  const restored = await saved();
  const actor = current.players[current.active].name;
  const entry = label === undefined
    ? expect.stringMatching(new RegExp(`^${actor.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}: Undo — .+\\.$`))
    : `${actor}: Undo — ${label}.`;
  expect(restored).toEqual({ ...before, log: [...current.log, entry].slice(-100) });
  return restored;
}
