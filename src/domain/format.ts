import {
  compare,
  defaults,
  duration,
  type Group,
  type Options,
  type TimelineEvent,
} from "./model";

export function noteTime(event: TimelineEvent) {
  return event.eventType === "Casts" && event.castStart != null
    ? event.time + event.castStart - event.timestamp
    : event.time;
}

export function noteTimestamp(time: number) {
  const rounded = Math.round(time / 100);
  const tenths = Math.abs(rounded);
  return `${rounded < 0 ? "-" : ""}${duration(tenths * 100)}.${tenths % 10}`;
}
const classes: Record<string, string> = {
  warrior: "ZS",
  paladin: "QS",
  hunter: "LR",
  rogue: "DZ",
  priest: "MS",
  deathknight: "DK",
  shaman: "SM",
  mage: "FS",
  warlock: "SS",
  monk: "WS",
  druid: "XD",
  demonhunter: "DH",
  evoker: "龙",
};
export function noteSourceNames(groups: Group[], options: Options = defaults) {
  const instances = new Map<string, Set<number>>();
  for (const g of groups)
    if (g.actor.type?.toLowerCase() !== "player")
      for (const e of g.events)
        if (e.instance !== undefined) {
          const key = `${g.side}:${g.actor.id}`;
          if (!instances.has(key)) instances.set(key, new Set());
          instances.get(key)!.add(e.instance);
        }
  return (group: Group) => {
    let name = group.actor.name;
    if (
      group.actor.petOwner != null ||
      (instances.get(`${group.side}:${group.actor.id}`)?.size ?? 0) > 1
    )
      name = name.replace(/ \d+$/, "");
    if (group.side === "friendly" && options.simplify) {
      const abbr =
        classes[group.actor.subType?.replace(/ /g, "").toLowerCase() ?? ""];
      if (abbr) name = abbr + (name.match(/ \d+$/)?.[0] ?? "");
    }
    return name;
  };
}
export function formatNote(
  title: string,
  groups: Group[],
  options: Options = defaults,
) {
  const sourceName = noteSourceNames(groups, options);
  const casts = groups
    .flatMap((g) => g.events.map((e) => ({ g, e })))
    .sort(
      (a, b) =>
        noteTime(a.e) - noteTime(b.e) ||
        compare(a.g.actor.name, b.g.actor.name) ||
        compare(a.g.ability.name, b.g.ability.name),
    );
  const totals = new Map<number, number>(),
    counts = new Map<number, number>();
  for (const { g } of casts)
    if (g.side === "enemy")
      totals.set(g.ability.gameID, (totals.get(g.ability.gameID) ?? 0) + 1);
  const lines = new Map<
    number,
    {
      time: number;
      side: string;
      name: string;
      ability: string;
      text: string;
    }[]
  >();
  for (const { g, e } of casts) {
    const name = sourceName(g);
    let count = "";
    if (g.side === "enemy" && (totals.get(g.ability.gameID) ?? 0) > 1) {
      const n = (counts.get(g.ability.gameID) ?? 0) + 1;
      counts.set(g.ability.gameID, n);
      count = `(${n})`;
    }
    const text = `${options[g.side === "enemy" ? "enemy" : "friendly"] ? `${name} - ` : ""}${options.icon ? `{spell:${g.ability.gameID}}` : ""}${g.ability.name}${count}`;
    const time = noteTime(e);
    const tenth = Math.round(time / 100);
    if (!lines.has(tenth)) lines.set(tenth, []);
    lines.get(tenth)!.push({
      time,
      side: g.side,
      name: g.actor.name,
      ability: g.ability.name,
      text,
    });
  }
  return [
    `# ${title}`,
    ...[...lines].map(
      ([tenth, items]) =>
        `{time:${noteTimestamp(tenth * 100)}} ${items
          .sort(
            (a, b) =>
              (a.side === "enemy" ? 0 : 1) - (b.side === "enemy" ? 0 : 1) ||
              a.time - b.time ||
              compare(a.name, b.name) ||
              compare(a.ability, b.ability),
          )
          .map((x) => x.text)
          .join("  ")}`,
    ),
  ].join("\r\n");
}
