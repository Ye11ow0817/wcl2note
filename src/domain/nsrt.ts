import { noteSourceNames, noteTime } from "./format";
import { actorClass, classColors } from "./actor";
import {
  compare,
  defaults,
  type Fight,
  type Group,
  type Options,
} from "./model";
import { eventKey } from "./timeline";

const difficulties: Record<number, string> = {
  1: "LFR",
  3: "Normal",
  4: "Heroic",
  5: "Mythic",
};
const field = (value: string) => value.replace(/[;\r\n]+/g, " ").trim();

export function createNSRTNote(
  fight: Fight,
  groups: Group[],
  dynamicTimers = true,
  options: Options = defaults,
) {
  const sourceName = noteSourceNames(groups, { ...options, simplify: false });
  // NSRT starts at phase 1 and advances on encounter events. Number each
  // transition separately, including repeated visits to the same WCL phase.
  const phases = [fight.startTime];
  for (const transition of [...(fight.phaseTransitions ?? [])].sort(
    (a, b) => a.startTime - b.startTime,
  )) {
    if (
      transition.startTime > phases.at(-1)! &&
      transition.startTime < fight.endTime
    )
      phases.push(transition.startTime);
  }
  const difficulty = difficulties[fight.difficulty ?? 0];
  const lines = [
    `EncounterID:${fight.encounterID ?? 0};${difficulty ? `Difficulty:${difficulty};` : ""}Name:${field(fight.name)};`,
  ];
  const eventLines = new Map<string, number>();
  const entries = groups
    .flatMap((group) =>
      group.events.map((event) => ({
        group,
        event,
        // Use report timestamps so phase/Pull filtering never rebases NSRT.
        timestamp: event.timestamp - event.time + noteTime(event),
      })),
    )
    .sort(
      (a, b) =>
        a.timestamp - b.timestamp ||
        compare(a.group.baseName, b.group.baseName) ||
        compare(a.group.ability.name, b.group.ability.name),
    );
  for (const { group, event, timestamp } of entries) {
    let phase = 0;
    if (dynamicTimers)
      while (phase + 1 < phases.length && phases[phase + 1] <= timestamp)
        phase++;
    const time = Math.round((timestamp - phases[phase]) / 100) / 10;
    const showSource = options[group.side === "enemy" ? "enemy" : "friendly"];
    const className = actorClass(group.actor.subType);
    // NSRT matches UnitClass tokens, such as MAGE, rather than MRT's FS alias.
    const name =
      group.side === "friendly" && options.simplify && classColors[className]
        ? className.toUpperCase()
        : sourceName(group);
    const tag = showSource ? `tag:${field(name)};` : "";
    eventLines.set(eventKey(event), lines.length);
    lines.push(
      `ph:${phase + 1};time:${time};${tag}spellid:${group.ability.gameID};`,
    );
  }
  return { text: lines.join("\r\n"), eventLines };
}

export function nsrtEventRange(note: string, line: number | undefined) {
  if (line === undefined) return undefined;
  const lines = note.split("\n");
  if (line < 1 || line >= lines.length) return undefined;
  const start = lines
    .slice(0, line)
    .reduce((total, text) => total + text.length + 1, 0);
  return { start, end: start + lines[line].replace(/\r$/, "").length, line };
}
