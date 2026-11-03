import {
  duration,
  type Fight,
  type Group,
  type Segment,
  type TimelineEvent,
} from "./model";
import { noteTimestamp } from "./format";

export interface EventOverride {
  groupKey: string;
  included: boolean;
}
export type EventOverrides = ReadonlyMap<string, EventOverride>;
export interface TimeWindow {
  start: number;
  end: number;
}
export interface PhaseLabelSize {
  id: string;
  time: number;
  width: number;
  height: number;
}
export interface PhaseLabelLayout {
  height: number;
  labels: {
    id: string;
    left: number;
    top: number;
    width: number;
    height: number;
  }[];
}

export function visibleTimelinePhases(
  segments: Segment[],
  origin: number,
  window: TimeWindow,
) {
  return segments
    .filter((segment) => segment.id !== "full")
    .map((segment) => ({ ...segment, time: segment.startTime - origin }))
    .filter(
      (phase) =>
        phase.time < window.end && phase.endTime - origin > window.start,
    );
}

export function layoutPhaseLabels(
  items: PhaseLabelSize[],
  window: TimeWindow,
  width: number,
): PhaseLabelLayout {
  if (width <= 0 || !items.length) return { height: 52, labels: [] };
  const inset = 6,
    gap = 4;
  const available = Math.max(1, width - inset * 2);
  const span = Math.max(1, window.end - window.start);
  const sizes = items
    .map((item) => ({
      ...item,
      width: Math.min(item.width, available),
      left: Math.max(
        inset,
        Math.min(
          width - inset - Math.min(item.width, available),
          ((item.time - window.start) / span) * width,
        ),
      ),
    }))
    .sort((a, b) => a.left - b.left || a.time - b.time);
  const rows: { end: number; height: number }[] = [];
  const placed = sizes.map((item) => {
    let row = rows.findIndex((candidate) => candidate.end + gap <= item.left);
    if (row < 0) {
      row = rows.length;
      rows.push({ end: 0, height: 0 });
    }
    rows[row].end = item.left + item.width;
    rows[row].height = Math.max(rows[row].height, item.height);
    return { ...item, row };
  });
  const labels = placed.map((item) => ({
    id: item.id,
    left: item.left,
    width: item.width,
    height: item.height,
    top:
      inset +
      rows.slice(0, item.row).reduce((sum, row) => sum + row.height + gap, 0),
  }));
  return {
    height: Math.max(
      52,
      inset +
        rows.reduce((sum, row) => sum + row.height, 0) +
        gap * (rows.length - 1) +
        23,
    ),
    labels,
  };
}
export interface TimelineEntry {
  id: string;
  event: TimelineEvent;
  selectable: boolean;
  included: boolean;
}
export interface TimelineRow {
  id: string;
  group: Group;
  entries: TimelineEntry[];
}

export function timelineInterval(event: TimelineEvent) {
  return event.castStart != null
    ? { start: event.time + event.castStart - event.timestamp, end: event.time }
    : {
        start: event.time,
        end: event.time + (event.auraEnd ?? event.timestamp) - event.timestamp,
      };
}

function eventSignature(event: TimelineEvent) {
  return JSON.stringify([
    event.eventType,
    event.side,
    event.actor.id,
    event.instance ?? null,
    event.ability.gameID,
    event.timestamp,
    event.source?.actor.id ?? null,
    event.source?.instance ?? null,
    event.target?.actor.id ?? null,
    event.target?.instance ?? null,
    !!event.auraOnly,
  ]);
}

export function eventKey(event: TimelineEvent) {
  return event.id ?? `${eventSignature(event)}:0`;
}

// Identify the complete event stream before phase/actor filtering. Identical
// timestamps and repeated targets still remain independently selectable.
export function identifyEvents(events: TimelineEvent[]): TimelineEvent[] {
  const counts = new Map<string, number>();
  return events.map((event) => {
    const signature = eventSignature(event);
    const occurrence = counts.get(signature) ?? 0;
    counts.set(signature, occurrence + 1);
    return { ...event, id: `${signature}:${occurrence}` };
  });
}

export function isEventIncluded(
  event: TimelineEvent,
  groupKey: string,
  selected: ReadonlySet<string>,
  overrides: EventOverrides,
) {
  return (
    !event.auraOnly &&
    (overrides.get(eventKey(event))?.included ?? selected.has(groupKey))
  );
}

export function selectedEventGroups(
  groups: Group[],
  selected: ReadonlySet<string>,
  overrides: EventOverrides,
): Group[] {
  return groups
    .map((group) => ({
      ...group,
      events: group.events.filter((event) =>
        isEventIncluded(event, group.key, selected, overrides),
      ),
    }))
    .filter((group) => group.events.length > 0);
}

export function timelineBounds(fight: Fight, segment: Segment): TimeWindow {
  const origin = segment.relative ? segment.startTime : fight.startTime;
  const start = Math.max(fight.startTime, segment.startTime) - origin;
  return {
    start,
    end: Math.max(start + 1, Math.min(fight.endTime, segment.endTime) - origin),
  };
}

export function timelineRows(
  groups: Group[],
  selected: ReadonlySet<string>,
  overrides: EventOverrides,
  bounds: TimeWindow,
  exportableEventIds?: ReadonlySet<string>,
): TimelineRow[] {
  const counts = new Map<Group, number>();
  const sourceCounts = new Map<string, number>();
  for (const group of groups) {
    const count = group.events.reduce((total, event) => {
      const origin = event.timestamp - event.time;
      return (
        total +
        (event.auraUses
          ? event.auraUses.filter(
              (time) =>
                time - origin >= bounds.start && time - origin <= bounds.end,
            ).length
          : Number(
              !event.auraOnly &&
                event.time >= bounds.start &&
                event.time <= bounds.end,
            ))
      );
    }, 0);
    counts.set(group, count);
    sourceCounts.set(
      group.sourceKey,
      (sourceCounts.get(group.sourceKey) ?? 0) + count,
    );
  }
  // WCL ranks sources and abilities by uses, then compares names directly.
  // Keep this separate from the Chinese collation used for charts and notes.
  const compareNames = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  return groups
    .map((group) => ({
      id: `${group.eventType}:${group.sourceKey}:${group.ability.gameID}`,
      group,
      entries: group.events.map((event) => {
        const selectable =
          !event.auraOnly &&
          event.time >= bounds.start &&
          event.time <= bounds.end &&
          (!exportableEventIds || exportableEventIds.has(eventKey(event)));
        return {
          id: eventKey(event),
          event,
          selectable,
          included:
            selectable &&
            isEventIncluded(event, group.key, selected, overrides),
        };
      }),
    }))
    .sort(
      (a, b) =>
        (a.group.side === "enemy" ? 0 : 1) -
          (b.group.side === "enemy" ? 0 : 1) ||
        sourceCounts.get(b.group.sourceKey)! -
          sourceCounts.get(a.group.sourceKey)! ||
        compareNames(a.group.baseName, b.group.baseName) ||
        a.group.actor.id - b.group.actor.id ||
        (a.group.instance ?? 0) - (b.group.instance ?? 0) ||
        counts.get(b.group)! - counts.get(a.group)! ||
        compareNames(a.group.ability.name, b.group.ability.name) ||
        a.group.ability.gameID - b.group.ability.gameID,
    );
}

export function clampWindow(
  window: TimeWindow,
  bounds: TimeWindow,
  minimumSpan = 2000,
): TimeWindow {
  const minimum = Math.min(minimumSpan, bounds.end - bounds.start);
  const span = Math.max(
    minimum,
    Math.min(bounds.end - bounds.start, window.end - window.start),
  );
  const start = Math.max(
    bounds.start,
    Math.min(bounds.end - span, window.start),
  );
  return { start, end: start + span };
}

export function zoomWindow(
  window: TimeWindow,
  bounds: TimeWindow,
  factor: number,
): TimeWindow {
  const center = (window.start + window.end) / 2;
  const span = (window.end - window.start) * factor;
  return clampWindow(
    { start: center - span / 2, end: center + span / 2 },
    bounds,
    Math.min(2000, window.end - window.start),
  );
}

export function defaultTimelineWindow(bounds: TimeWindow): TimeWindow {
  return clampWindow(
    { start: bounds.start, end: bounds.start + 20000 },
    bounds,
  );
}

function timelineTickStep(window: TimeWindow, count: number) {
  const ideal = (window.end - window.start) / Math.max(1, count);
  const steps = [
    1000, 2000, 5000, 10000, 15000, 30000, 60000, 120000, 300000, 600000,
    1200000, 3600000,
  ];
  return (
    steps.find((value) => value >= ideal) ??
    Math.ceil(ideal / 3600000) * 3600000
  );
}

export function timelineTicks(window: TimeWindow, count = 6) {
  const step = timelineTickStep(window, count);
  const ticks: number[] = [];
  for (
    let time = Math.ceil(window.start / step) * step;
    time <= window.end;
    time += step
  )
    ticks.push(time);
  return ticks;
}

function timelineSubTicks(
  window: TimeWindow,
  count: number,
  divisions: number,
  excludedMultiple: number,
) {
  const major = timelineTickStep(window, count);
  const step = major / divisions;
  const ticks: number[] = [];
  for (
    let index = Math.ceil(window.start / step);
    index <= Math.floor(window.end / step);
    index++
  )
    if (index % excludedMultiple !== 0) ticks.push(index * step);
  return ticks;
}

export function timelineMediumTicks(window: TimeWindow, count = 6) {
  return timelineSubTicks(window, count, 2, 2);
}

export function timelineMinorTicks(window: TimeWindow, count = 6) {
  return timelineSubTicks(window, count, 10, 5);
}

export function preciseTime(time: number) {
  const ms = Math.floor(Math.abs(time));
  return `${time < 0 ? "-" : ""}${duration(ms)}.${String(ms % 1000).padStart(3, "0")}`;
}

export function noteEventRange(note: string, time: number) {
  const marker = `{time:${noteTimestamp(time)}}`;
  const start = note.startsWith(marker) ? 0 : note.indexOf(`\n${marker}`) + 1;
  if (start === 0 && !note.startsWith(marker)) return undefined;
  const newline = note.indexOf("\n", start);
  const end =
    newline < 0
      ? note.length
      : note[newline - 1] === "\r"
        ? newline - 1
        : newline;
  return { start, end, line: note.slice(0, start).split("\n").length - 1 };
}
