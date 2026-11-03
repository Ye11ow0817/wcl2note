import {
  compare,
  filterKey,
  selectionKey,
  sourceKey,
  type Actor,
  type EventType,
  type EventActor,
  type Fight,
  type Group,
  type RawEvent,
  type Report,
  type Segment,
  type Side,
  type SideFilter,
  type SourceNode,
  type TimelineEvent,
} from "./model";
import { actorClass, compareActorNames } from "./actor";
import { identifyEvents } from "./timeline";
import { castStarts } from "./casts";
export function actorCatalog(report: Report, fight: Fight) {
  const participants = {
    ...fight,
    ...report.fights?.find((f) => f.id === fight.id),
  };
  const master = new Map(
    (report.masterData?.actors ?? []).map((a) => [a.id, a]),
  );
  const entries: { actor: Actor; side: Side; instance?: number }[] = [];
  for (const side of ["friendly", "enemy"] as const) {
    for (const id of participants[
      side === "friendly" ? "friendlyPlayers" : "enemyPlayers"
    ] ?? [])
      entries.push({
        actor: {
          ...master.get(id),
          id,
          name: master.get(id)?.name ?? `未知角色 ${id}`,
          type: "Player",
        },
        side,
      });
    for (const a of [
      ...(participants[side === "friendly" ? "friendlyNPCs" : "enemyNPCs"] ??
        []),
      ...(participants[side === "friendly" ? "friendlyPets" : "enemyPets"] ??
        []),
    ]) {
      const actor = master.get(a.id) ?? { id: a.id, name: `未知角色 ${a.id}` };
      for (
        let instance = 1;
        instance <= Math.max(1, a.instanceCount ?? 1);
        instance++
      )
        entries.push({
          actor: {
            ...actor,
            gameID: actor.gameID ?? a.gameID,
            petOwner: actor.petOwner ?? a.petOwner,
          },
          side,
          instance,
        });
    }
  }
  return entries.map((e) => ({
    ...e,
    actor: {
      ...e.actor,
      petOwner:
        e.actor.petOwner ??
        entries.find(
          (a) =>
            a.side === e.side &&
            a.actor.id === e.actor.id &&
            a.actor.petOwner != null,
        )?.actor.petOwner,
    },
  }));
}
export function mapEvents(
  raw: RawEvent[],
  type: EventType,
  report: Report,
  fight: Fight,
  queried: Side,
): TimelineEvent[] {
  const actors = new Map(
      (report.masterData?.actors ?? []).map((a) => [a.id, a]),
    ),
    abilities = new Map(
      (report.masterData?.abilities ?? []).map((a) => [a.gameID, a]),
    );
  const catalog = actorCatalog(report, fight),
    aura = type !== "Casts";
  function participant(
    id: number | undefined,
    instance: number | undefined,
    friendly: boolean | undefined,
  ): EventActor | undefined {
    if (id === undefined) return;
    const actor = actors.get(id) ?? { id, name: `未知角色 ${id}` };
    const known =
      catalog.find((a) => a.actor.id === id && a.side === "friendly") ??
      catalog.find((a) => a.actor.id === id);
    const side =
      known?.side ??
      (actor.type?.toLowerCase() === "player"
        ? "friendly"
        : typeof friendly === "boolean"
          ? friendly
            ? "friendly"
            : "enemy"
          : queried);
    return { actor: { ...actor, ...known?.actor }, side, instance };
  }
  const output: TimelineEvent[] = [];
  const active = new Map<string, Map<string, TimelineEvent>>();
  const seen = new Set<string>();
  const suffix = type === "Buffs" ? "buff" : "debuff";
  const starts = aura ? undefined : castStarts(raw);
  for (const e of [...raw].sort((a, b) => a.timestamp - b.timestamp)) {
    const kind = e.type?.toLowerCase();
    if (
      !Number.isSafeInteger(e.abilityGameID) ||
      !Number.isFinite(e.timestamp) ||
      (aura
        ? !["apply", "refresh", "remove", "applystack"].some(
            (action) =>
              kind ===
              (action === "applystack"
                ? `apply${suffix}stack`
                : `${action}${suffix}`),
          )
        : e.fake || (kind != null && kind !== "cast" && kind !== "empowerend"))
    )
      continue;
    const source = participant(
      e.sourceID,
      e.sourceInstance ?? e.sourceInstanceID,
      e.sourceIsFriendly,
    );
    const target = participant(
      e.targetID,
      e.targetInstance ?? e.targetInstanceID,
      e.targetIsFriendly,
    );
    const primary = aura ? (target ?? source) : source;
    if (!primary) continue;
    const mapped: TimelineEvent = {
      timestamp: e.timestamp,
      time: Math.max(0, e.timestamp - fight.startTime),
      ...primary,
      source,
      target,
      ability: abilities.get(e.abilityGameID) ?? {
        gameID: e.abilityGameID,
        name: `未知技能 ${e.abilityGameID}`,
      },
      eventType: type,
    };
    if (!aura) {
      mapped.castStart = starts?.get(e);
      output.push(mapped);
      continue;
    }
    const key = `${filterKey(primary.side, primary.actor, primary.instance)}:${e.abilityGameID}`;
    const caster = source
      ? filterKey(source.side, source.actor, source.instance)
      : "";
    const holders = active.get(key) ?? new Map<string, TimelineEvent>();
    active.set(key, holders);
    if (kind === `remove${suffix}`) {
      // Fade events can omit their source. Close matching applications across pages.
      const endings = source
        ? [holders.get(caster)].filter((event) => event != null)
        : [...holders.values()];
      if (!endings.length && !seen.has(key)) {
        output.push({
          ...mapped,
          timestamp: fight.startTime,
          time: 0,
          auraOnly: true,
          auraEnd: e.timestamp,
        });
      }
      for (const event of endings) {
        event.auraEnd = e.timestamp;
        for (const [id, holder] of holders)
          if (holder === event) holders.delete(id);
      }
    } else if (kind === `apply${suffix}` || !holders.has(caster)) {
      const previous = holders.get(caster);
      if (previous) previous.auraEnd = e.timestamp;
      if (kind !== `apply${suffix}`) {
        mapped.auraOnly = true;
        if (!seen.has(key)) {
          mapped.timestamp = fight.startTime;
          mapped.time = 0;
        }
      }
      mapped.auraUses = [e.timestamp];
      mapped.auraEnd = fight.endTime;
      holders.set(caster, mapped);
      output.push(mapped);
    } else {
      holders.get(caster)!.auraUses!.push(e.timestamp);
    }
    seen.add(key);
  }
  return identifyEvents(output);
}
export function groupEvents(
  events: TimelineEvent[],
  segment: Segment,
  fight: Fight,
  includeActiveAuras = false,
  includeActiveCasts = false,
): Group[] {
  const start = Math.max(segment.startTime, fight.startTime),
    end = Math.min(segment.endTime, fight.endTime);
  if (end <= start) return [];
  const filtered = events
    .filter(
      (e) =>
        (!e.auraOnly && e.timestamp >= start && e.timestamp <= end) ||
        (includeActiveAuras && e.timestamp < end && (e.auraEnd ?? 0) > start) ||
        (includeActiveCasts &&
          e.castStart != null &&
          e.castStart < end &&
          e.timestamp > start),
    )
    .map((e) => ({
      ...e,
      time:
        e.timestamp - (segment.relative ? segment.startTime : fight.startTime),
    }));
  const identities = new Map<string, TimelineEvent>();
  for (const e of filtered) {
    const k = sourceKey(e.side, e.actor.id, e.instance);
    if (!identities.has(k)) identities.set(k, e);
  }
  const names = new Map<string, string>();
  for (const e of identities.values()) {
    const same = [...identities.values()]
      .filter((x) => x.side === e.side && x.actor.name === e.actor.name)
      .sort(
        (a, b) =>
          (a.instance ?? 2147483647) - (b.instance ?? 2147483647) ||
          a.actor.id - b.actor.id,
      );
    const useInstances =
      same.every((a) => (a.instance ?? 0) > 0) &&
      new Set(same.map((a) => a.instance)).size === same.length;
    same.forEach((a, i) =>
      names.set(
        sourceKey(a.side, a.actor.id, a.instance),
        `${a.actor.name}${same.length > 1 ? ` ${useInstances ? a.instance : i + 1}` : ""}`,
      ),
    );
  }
  const groups = new Map<string, Group>();
  for (const e of filtered) {
    const sk = sourceKey(e.side, e.actor.id, e.instance),
      k = `${e.eventType}:${sk}:${e.ability.gameID}:${e.ability.name}:${e.ability.icon ?? ""}:${e.ability.type ?? ""}`;
    if (!groups.has(k))
      groups.set(k, {
        key: selectionKey(e.eventType, e.side, e.actor.id, e.ability.gameID),
        sourceKey: filterKey(e.side, e.actor, e.instance),
        actor: { ...e.actor, name: names.get(sk)! },
        baseName: e.actor.name,
        side: e.side,
        instance: e.instance,
        ability: e.ability,
        eventType: e.eventType,
        events: [],
      });
    groups.get(k)!.events.push(e);
  }
  return [...groups.values()]
    .map((g) => ({ ...g, events: g.events.sort((a, b) => a.time - b.time) }))
    .sort(
      (a, b) =>
        (a.side === "friendly" ? 0 : 1) - (b.side === "friendly" ? 0 : 1) ||
        compare(a.actor.name, b.actor.name) ||
        b.events.length - a.events.length ||
        compare(a.ability.name, b.ability.name),
    );
}
export function sourceTree(
  groups: Group[],
  report: Report,
  fight: Fight,
  side: SideFilter,
): SourceNode[] {
  if (side === "all")
    return (["friendly", "enemy"] as const).flatMap((side) =>
      sourceTree(groups, report, fight, side),
    );
  const catalog = actorCatalog(report, fight).filter((e) => e.side === side);
  const actors = new Map<
    number,
    { actor: Actor; instances: Map<string, number | undefined> }
  >();
  const add = (actor: Actor, instance?: number) => {
    let entry = actors.get(actor.id);
    if (!entry) {
      entry = { actor, instances: new Map() };
      actors.set(actor.id, entry);
    }
    const key = filterKey(side, entry.actor, instance);
    if (!entry.instances.has(key)) entry.instances.set(key, instance);
  };
  for (const { actor, instance } of catalog) add(actor, instance);
  // Events can contain actors or instance IDs missing from the fight catalog.
  // Their report identity is authoritative; a shared name does not imply ownership.
  for (const g of groups.filter((g) => g.side === side))
    add({ ...g.actor, name: g.baseName }, g.instance);
  for (const { actor } of actors.values()) {
    if (actor.petOwner == null || actors.has(actor.petOwner)) continue;
    const owner = report.masterData?.actors.find(
      (a) => a.id === actor.petOwner,
    );
    add(
      owner ?? {
        id: actor.petOwner,
        name: `未知角色 ${actor.petOwner}`,
        type: "Player",
      },
    );
  }
  const sortNodes = (a: SourceNode, b: SourceNode) =>
    Number(b.player) - Number(a.player) ||
    Number(b.boss ?? false) - Number(a.boss ?? false) ||
    (a.player && b.player
      ? compareActorNames(a.className || "~", b.className || "~")
      : 0) ||
    compareActorNames(a.name, b.name) ||
    a.actorId - b.actorId;
  const buildNode = (id: number, ancestors = new Set<number>()): SourceNode => {
    const { actor, instances } = actors.get(id)!;
    const player = actor.type?.toLowerCase() === "player";
    const metadata = {
      actorId: id,
      gameID: player ? undefined : actor.gameID,
      className: player ? actorClass(actor.subType) : undefined,
      spec: player ? actor.spec : undefined,
      specIcon: player ? actor.specIcon : undefined,
      player,
      boss:
        actor.type?.toLowerCase() === "boss" ||
        actor.subType?.toLowerCase() === "boss",
    };
    const path = new Set([...ancestors, id]);
    const children = [...actors.values()]
      .filter((e) => e.actor.petOwner === id && !path.has(e.actor.id))
      .map((e) => buildNode(e.actor.id, path))
      .sort(sortNodes);
    const numbered = [...instances]
      .filter((entry): entry is [string, number] => (entry[1] ?? 0) > 0)
      .sort((a, b) => a[1] - b[1]);
    return {
      ...metadata,
      key: `actor:${side}:${id}`,
      name: actor.name,
      matches: [...instances.keys()],
      children: [
        ...(!player && numbered.length > 1
          ? numbered.map(([key, instance]) => ({
              ...metadata,
              key: `instance:${key}`,
              name: `${actor.name} #${instance}`,
              instance,
              matches: [key],
              children: [],
            }))
          : []),
        ...children,
      ],
    };
  };
  return [...actors.values()]
    .filter((e) => e.actor.petOwner == null || !actors.has(e.actor.petOwner))
    .map((e) => buildNode(e.actor.id))
    .sort(sortNodes);
}
export function visibleGroups(
  groups: Group[],
  side: SideFilter,
  filter: SourceNode | undefined,
  report: Report,
  fight: Fight,
): Group[] {
  if (side === "all")
    return (["friendly", "enemy"] as const).flatMap((side) =>
      visibleGroups(groups, side, filter, report, fight),
    );
  const catalog = actorCatalog(report, fight);
  const filtered = groups
    .filter(
      (g) =>
        g.side === side && (!filter || filter.matches.includes(g.sourceKey)),
    )
    .filter(
      (g) =>
        side === "enemy" ||
        filter ||
        !(
          g.actor.petOwner != null ||
          g.actor.type?.toLowerCase() === "pet" ||
          catalog.some(
            (a) =>
              a.side === "friendly" &&
              a.actor.id === g.actor.id &&
              a.actor.petOwner != null,
          )
        ),
    );
  if (
    (side === "enemy" && !filter) ||
    (filter && !filter.key.startsWith("instance:") && filter.matches.length > 1)
  ) {
    const merged = new Map<string, Group>();
    for (const g of filtered) {
      if (!merged.has(g.key))
        merged.set(g.key, {
          ...g,
          actor: { ...g.actor, name: g.baseName },
          events: [],
        });
      merged.get(g.key)!.events.push(...g.events);
    }
    return [...merged.values()].sort(
      (a, b) =>
        (!filter
          ? compare(a.baseName, b.baseName) || a.actor.id - b.actor.id
          : 0) ||
        b.events.length - a.events.length ||
        compare(a.ability.name, b.ability.name),
    );
  }
  return side === "friendly" && !filter
    ? [...filtered].sort(
        (a, b) =>
          Number(b.actor.type?.toLowerCase() === "player") -
            Number(a.actor.type?.toLowerCase() === "player") ||
          compare(a.baseName, b.baseName) ||
          b.events.length - a.events.length ||
          compare(a.ability.name, b.ability.name),
      )
    : filtered;
}
