import { describe, expect, it } from "vitest";
import {
  abilityRows,
  castActorRows,
  castsPerMinute,
  filterRelatedGroups,
  findActorNode,
  relatedActorTree,
} from "../../../src/domain/ability";
import {
  groupEvents,
  mapEvents,
  sourceTree,
  visibleGroups,
} from "../../../src/domain/group";
import type { EventType, RawEvent, Segment } from "../../../src/domain/model";
import { enemies, friendlies, report } from "../../fixtures/report";

const fight = report.fights![0];
const full: Segment = { ...fight, id: "full", relative: false };
const second: Segment = { ...full, id: "phase-2", startTime: 61000 };
function aura(type: EventType, raw: RawEvent[], segment = full) {
  const events = mapEvents(raw, type, report, fight, "friendly");
  const groups = groupEvents(events, segment, fight, true);
  return { events, groups, rows: abilityRows(groups, segment, fight) };
}
const buff = (
  type: string,
  timestamp: number,
  overrides: Partial<RawEvent> = {},
): RawEvent => ({
  type,
  timestamp,
  abilityGameID: 200,
  sourceID: 10,
  sourceInstance: 1,
  targetID: 20,
  ...overrides,
});

describe("技能列表与关联 actor 筛选", () => {
  it("全部阵营同时提供双方角色和施法，选择角色后仍严格限定该角色", () => {
    const events = [
      ...mapEvents(friendlies, "Casts", report, fight, "friendly"),
      ...mapEvents(enemies, "Casts", report, fight, "enemy"),
    ];
    const groups = groupEvents(events, full, fight, true);
    const nodes = sourceTree(groups, report, fight, "all");
    expect(findActorNode(nodes, "actor:friendly:20")).toBeDefined();
    expect(findActorNode(nodes, "actor:enemy:10")).toBeDefined();
    const visible = visibleGroups(groups, "all", undefined, report, fight);
    expect(new Set(visible.map((group) => group.side))).toEqual(
      new Set(["friendly", "enemy"]),
    );
    const actor = findActorNode(nodes, "actor:friendly:20")!;
    expect(
      visibleGroups(groups, "all", actor, report, fight).map(
        (group) => group.sourceKey,
      ),
    ).toEqual(["friendly:20:"]);
  });

  it("全部阵营中的相同 actor ID 按阵营独立排行与钻取", () => {
    const friendly = groupEvents(
      mapEvents(friendlies, "Casts", report, fight, "friendly"),
      full,
      fight,
    )[0];
    const enemy = {
      ...friendly,
      key: friendly.key.replace(":friendly:", ":enemy:"),
      sourceKey: friendly.sourceKey.replace("friendly:", "enemy:"),
      side: "enemy" as const,
    };
    const groups = [friendly, enemy];
    const rows = castActorRows(
      groups,
      sourceTree(groups, report, fight, "all"),
    );
    expect(rows.map((row) => row.node.key).sort()).toEqual([
      `actor:enemy:${friendly.actor.id}`,
      `actor:friendly:${friendly.actor.id}`,
    ]);
    expect(rows.map((row) => row.count)).toEqual([
      friendly.events.length,
      friendly.events.length,
    ]);
  });

  it("排行与 CPM 排除 WCL 的 fake 补充施法和未完成的读条", () => {
    const events = mapEvents(
      [
        ...enemies,
        { ...enemies[0], fake: true },
        { ...enemies[0], type: "begincast" },
      ],
      "Casts",
      report,
      fight,
      "enemy",
    );
    expect(events).toHaveLength(3);
    expect(
      abilityRows(groupEvents(events, full, fight), full, fight)[0],
    ).toMatchObject({ count: 3, cpm: 1.5 });
  });
  it("蓄力法术在 empowerend 完成时计数，empowerstart 不重复计数", () => {
    const events = mapEvents(
      [
        { ...enemies[0], type: "empowerstart" },
        { ...enemies[0], timestamp: 38000, type: "empowerend" },
      ],
      "Casts",
      report,
      fight,
      "enemy",
    );
    expect(events).toHaveLength(1);
    expect(events[0].timestamp).toBe(38000);
  });
  it("施法保留 Source、Target 与实例，Target 菜单包含双方和事件补充的实例", () => {
    const events = mapEvents(
      [
        { ...enemies[0], targetID: 20 },
        { ...enemies[1], targetID: 30, targetInstance: 7 },
      ],
      "Casts",
      report,
      fight,
      "enemy",
    );
    expect(events[1]).toMatchObject({
      source: { actor: { id: 10 }, instance: 2 },
      target: { actor: { id: 30 }, instance: 7 },
    });
    const nodes = relatedActorTree(events, report, fight, true);
    expect(findActorNode(nodes, "actor:enemy:11")).toBeDefined();
    const pet = findActorNode(nodes, "instance:friendly:30:7")!;
    const groups = groupEvents(events, full, fight);
    expect(
      filterRelatedGroups(groups, pet).flatMap((group) => group.events),
    ).toEqual([events[1]]);
    expect(
      filterRelatedGroups(groups, findActorNode(nodes, "actor:friendly:20"))[0]
        .events,
    ).toEqual([events[0]]);
  });

  it("Buff、Debuff 的 Source 筛选使用施加者身份与实例", () => {
    for (const type of ["Buffs", "Debuffs"] as const) {
      const suffix = type === "Buffs" ? "buff" : "debuff";
      const { events, groups } = aura(type, [
        buff(`apply${suffix}`, 11000),
        buff(`apply${suffix}`, 21000, { sourceID: 11 }),
        buff(`apply${suffix}`, 31000, { sourceInstance: 2 }),
      ]);
      const nodes = relatedActorTree(events, report, fight, false);
      const filtered = filterRelatedGroups(
        groups,
        findActorNode(nodes, "instance:enemy:10:2"),
      );
      expect(
        filtered
          .flatMap((group) => group.events)
          .map((event) => event.timestamp),
      ).toEqual([31000]);
      expect(filtered[0].actor.id).toBe(20);
    }
  });

  it("全部施法按次数排列 actor，合并同一 actor 实例并保留同名身份", () => {
    const events = mapEvents(enemies, "Casts", report, fight, "enemy");
    const groups = groupEvents(events, full, fight);
    const rows = castActorRows(
      visibleGroups(groups, "enemy", undefined, report, fight),
      sourceTree(groups, report, fight, "enemy"),
    );
    expect(rows.map((row) => [row.node.actorId, row.count])).toEqual([
      [10, 2],
      [11, 1],
    ]);
  });

  it("所有队友施法隐藏宠物，仍可从菜单单独选择宠物", () => {
    const groups = groupEvents(
      mapEvents(friendlies, "Casts", report, fight, "friendly"),
      full,
      fight,
    );
    const nodes = sourceTree(groups, report, fight, "friendly");
    expect(
      castActorRows(
        visibleGroups(groups, "friendly", undefined, report, fight),
        nodes,
      ).map((row) => row.node.actorId),
    ).toEqual([20]);
    const pet = findActorNode(nodes, "actor:friendly:30")!;
    expect(
      abilityRows(
        visibleGroups(groups, "friendly", pet, report, fight),
        full,
        fight,
      )[0],
    ).toMatchObject({ count: 2, cpm: 1 });
  });

  it("CPM 使用当前阶段时长，空区间不会产生无穷值", () => {
    const groups = groupEvents(
      mapEvents(enemies, "Casts", report, fight, "enemy"),
      second,
      fight,
    );
    expect(abilityRows(groups, second, fight)[0]).toMatchObject({
      count: 2,
      cpm: 2,
    });
    expect(castsPerMinute(10, 0)).toBe(0);
  });

  it("事件缺失 Source 或 Target 时保留全部视图，具体筛选不会误命中", () => {
    const events = mapEvents(enemies, "Casts", report, fight, "enemy");
    const groups = groupEvents(events, full, fight);
    expect(filterRelatedGroups(groups)).toEqual(groups);
    const nodes = relatedActorTree(events, report, fight, true);
    expect(
      filterRelatedGroups(groups, findActorNode(nodes, "actor:friendly:20")),
    ).toEqual([]);
  });
});

describe("Buff 与 Debuff 次数和覆盖率", () => {
  it.each(["Buffs", "Debuffs"] as const)(
    "%s 合并相同技能，重叠持续时间只计算一次",
    (type) => {
      const suffix = type === "Buffs" ? "buff" : "debuff";
      const { rows } = aura(type, [
        buff(`apply${suffix}`, 11000),
        buff(`apply${suffix}`, 31000, { targetID: 30 }),
        buff(`remove${suffix}`, 51000),
        buff(`remove${suffix}`, 71000, { targetID: 30 }),
      ]);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ count: 2, uptime: 50 });
      expect(rows[0].uptimeIntervals).toEqual([{ start: 11000, end: 71000 }]);
      expect(rows[0].keys).toHaveLength(2);
    },
  );

  it("阶段开始前获得的 aura 延续到阶段内，次数为零且不生成虚假的 MRT 事件", () => {
    const { events, rows } = aura(
      "Buffs",
      [buff("applybuff", 11000), buff("removebuff", 91000)],
      second,
    );
    expect(rows[0]).toMatchObject({ count: 0, uptime: 50, keys: [] });
    expect(rows[0].uptimeIntervals).toEqual([{ start: 61000, end: 91000 }]);
    expect(groupEvents(events, second, fight)).toEqual([]);
  });

  it("刷新和叠层保留覆盖区间，不重复统计获得次数", () => {
    const { rows } = aura("Buffs", [
      buff("applybuff", 11000),
      buff("refreshbuff", 21000),
      buff("applybuffstack", 31000),
      buff("removebuff", 71000),
    ]);
    expect(rows[0]).toMatchObject({ count: 1, uptime: 50 });
    expect(rows[0].uptimeIntervals).toEqual([{ start: 11000, end: 71000 }]);
  });

  it("战斗开始时已有 aura 可从首次移除事件恢复覆盖时间", () => {
    const { events, rows } = aura("Buffs", [buff("removebuff", 61000)]);
    expect(rows[0]).toMatchObject({ count: 0, uptime: 50 });
    expect(rows[0].uptimeIntervals).toEqual([{ start: 1000, end: 61000 }]);
    expect(groupEvents(events, full, fight)).toEqual([]);
  });

  it.each(["Buffs", "Debuffs"] as const)(
    "%s 重新获得保留间隔，缺失移除按战斗结束裁切且不会超过 100%",
    (type) => {
      const suffix = type === "Buffs" ? "buff" : "debuff";
      const { rows } = aura(type, [
        buff(`apply${suffix}`, 11000),
        buff(`remove${suffix}`, 31000),
        buff(`apply${suffix}`, 81000),
      ]);
      expect(rows[0]).toMatchObject({ count: 2, uptime: 50 });
      expect(rows[0].uptimeIntervals).toEqual([
        { start: 11000, end: 31000 },
        { start: 81000, end: 121000 },
      ]);
    },
  );

  it("移除可缺失来源，Source 筛选保留各自持续时间", () => {
    const { events, groups } = aura("Buffs", [
      buff("applybuff", 11000),
      buff("applybuff", 31000, { sourceID: 11 }),
      buff("removebuff", 71000, { sourceID: undefined }),
    ]);
    const nodes = relatedActorTree(events, report, fight, false);
    const rows = abilityRows(
      filterRelatedGroups(groups, findActorNode(nodes, "actor:enemy:11")),
      full,
      fight,
    );
    expect(rows[0].count).toBe(1);
    expect(rows[0].uptime).toBeCloseTo(100 / 3);
    expect(rows[0].uptimeIntervals).toEqual([{ start: 31000, end: 71000 }]);
  });
});
