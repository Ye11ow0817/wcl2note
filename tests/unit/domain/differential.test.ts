import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { formatNote } from "../../../src/domain/format";
import type { Group, Options } from "../../../src/domain/model";
const cases = JSON.parse(
  readFileSync(
    new URL("../../fixtures/desktop-mrt.json", import.meta.url),
    "utf8",
  ),
) as {
  name: string;
  title: string;
  groups: Group[];
  options: Options;
  expected: string;
}[];
// Legacy fixtures use whole seconds. Preserve their independently generated
// content expectations while dedicated MRT tests cover the new timing/order.
function contents(note: string) {
  const [title, ...lines] = note.replace(/\r\n/g, "\n").split("\n");
  return {
    title,
    items: lines
      .flatMap((line) => line.replace(/^\{time:[^}]+\} /, "").split("  "))
      .sort(),
  };
}
it.each(cases)("desktop content preserved: $name", (c) =>
  expect(contents(formatNote(c.title, c.groups, c.options))).toEqual(
    contents(c.expected),
  ),
);
