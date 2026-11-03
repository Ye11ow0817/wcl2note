import { groupEvents, sourceTree } from "./group";
import {
  compare,
  filterKey,
  type Ability,
  type Fight,
  type Group,
  type Report,
  type Segment,
  type SourceNode,
  type TimelineEvent,
} from "./model";

export function findActorNode(
  nodes: SourceNode[],
  key: string,
): SourceNode | undefined {
  for (const node of nodes) {
    if (node.key === key) return node;
    const found = findActorNode(node.children, key);
    if (found) return found;
  }
}

export function relatedActorTree(
  events: TimelineEvent[],
  report: Report,
  fight: Fight,
  casts: boolean,
) {
  const related = events.flatMap((event) => {
    const actor = casts ? event.target : event.source;
    return actor && actor.actor.id > 0
      ? [{ ...event, ...actor, auraOnly: false }]
      : [];
  });
  const groups = groupEvents(
    related,
    { ...fight, id: "full", relative: false },
    fight,
  );
  return (["friendly", "enemy"] as const).flatMap((side) =>
    sourceTree(groups, report, fight, side),
  );
}

export function filterRelatedGroups(groups: Group[], filter?: SourceNode) {
  if (!filter) return groups;
  return groups.flatMap((group) => {
    const events = group.events.filter((event) => {
      const actor = event.eventType === "Casts" ? event.target : event.source;
      return (
        actor &&
        (filter.instance == null
          ? filter.key === `actor:${actor.side}:${actor.actor.id}`
          : filter.matches.includes(
              filterKey(actor.side, actor.actor, actor.instance),
            ))
      );
    });
    return events.length ? [{ ...group, events }] : [];
  });
}

function range(segment: Segment, fight: Fight) {
  const start = Math.max(segment.startTime, fight.startTime);
  const end = Math.min(segment.endTime, fight.endTime);
  return { start, end, duration: Math.max(0, end - start) };
}

export function castsPerMinute(count: number, duration: number) {
  return duration > 0 ? (count * 60000) / duration : 0;
}

export function castActorRows(groups: Group[], nodes: SourceNode[]) {
  const rows = new Map<string, { node: SourceNode; count: number }>();
  for (const group of groups) {
    const node = findActorNode(nodes, `actor:${group.side}:${group.actor.id}`);
    if (!node) continue;
    const row = rows.get(node.key) ?? { node, count: 0 };
    row.count += group.events.length;
    rows.set(node.key, row);
  }
  return [...rows.values()].sort(
    (a, b) =>
      b.count - a.count ||
      compare(a.node.name, b.node.name) ||
      a.node.actorId - b.node.actorId,
  );
}

export interface UptimeInterval {
  start: number;
  end: number;
}

function coverageIntervals(
  events: TimelineEvent[],
  start: number,
  end: number,
) {
  const intervals = events
    .flatMap((event) => {
      const left = Math.max(start, event.timestamp);
      const right = Math.min(end, event.auraEnd ?? event.timestamp);
      return right > left ? [[left, right]] : [];
    })
    .sort((a, b) => a[0] - b[0]);
  const merged: UptimeInterval[] = [];
  for (const [left, right] of intervals) {
    const previous = merged.at(-1);
    if (previous && left <= previous.end) {
      previous.end = Math.max(previous.end, right);
    } else {
      merged.push({ start: left, end: right });
    }
  }
  return merged;
}

export interface AbilityRow {
  ability: Ability;
  keys: string[];
  count: number;
  cpm: number;
  uptime: number;
  uptimeIntervals: UptimeInterval[];
}

export function abilityRows(
  groups: Group[],
  segment: Segment,
  fight: Fight,
): AbilityRow[] {
  const { start, end, duration } = range(segment, fight);
  const rows = new Map<number, Group[]>();
  for (const group of groups) {
    const entries = rows.get(group.ability.gameID) ?? [];
    entries.push(group);
    rows.set(group.ability.gameID, entries);
  }
  return [...rows.values()]
    .map((entries) => {
      const events = entries.flatMap((group) => group.events);
      const gained = (event: TimelineEvent) =>
        !event.auraOnly && event.timestamp >= start && event.timestamp <= end;
      const count = events.filter(gained).length;
      const uptimeIntervals = coverageIntervals(events, start, end);
      const covered = uptimeIntervals.reduce(
        (total, interval) => total + interval.end - interval.start,
        0,
      );
      return {
        ability: entries[0].ability,
        keys: [
          ...new Set(
            entries
              .filter((group) => group.events.some(gained))
              .map((group) => group.key),
          ),
        ],
        count,
        cpm: castsPerMinute(count, duration),
        uptime: duration ? (covered / duration) * 100 : 0,
        uptimeIntervals,
      };
    })
    .sort(
      (a, b) =>
        b.uptime - a.uptime ||
        b.count - a.count ||
        compare(a.ability.name, b.ability.name),
    );
}
