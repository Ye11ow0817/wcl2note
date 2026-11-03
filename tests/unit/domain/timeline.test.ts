import { describe, expect, it } from "vitest";
import { mapEvents, groupEvents } from "../../../src/domain/group";
import { formatNote } from "../../../src/domain/format";
import { segments } from "../../../src/domain/report";
import {
  clampWindow,
  defaultTimelineWindow,
  eventKey,
  layoutPhaseLabels,
  noteEventRange,
  preciseTime,
  selectedEventGroups,
  timelineBounds,
  timelineRows,
  timelineTicks,
  timelineMediumTicks,
  timelineMinorTicks,
  visibleTimelinePhases,
  zoomWindow,
  type EventOverride,
} from "../../../src/domain/timeline";
import { report, enemies } from "../../fixtures/report";

const fight = report.fights![0];
const [full, first, second] = segments(fight, report);
const events = mapEvents(enemies, "Casts", report, fight, "enemy");

describe("时间轴独立事件选择", () => {
  it("同毫秒的完全相同事件也能分别选择，身份不依赖当前阶段", () => {
    const repeated = mapEvents(
      [enemies[0], enemies[0], enemies[1]],
      "Casts",
      report,
      fight,
      "enemy",
    );
    expect(new Set(repeated.map(eventKey)).size).toBe(3);
    const groups = groupEvents(repeated, full, fight);
    const selected = new Set(groups.map((group) => group.key));
    const overrides = new Map([
      [eventKey(repeated[0]), { groupKey: groups[0].key, included: false }],
    ]);
    expect(
      selectedEventGroups(groups, selected, overrides).flatMap(
        (group) => group.events,
      ),
    ).toHaveLength(2);
    expect(eventKey(groupEvents(repeated, second, fight)[0].events[0])).toBe(
      eventKey(repeated[2]),
    );
    expect(eventKey({ ...repeated[0], time: 9000 })).toBe(
      eventKey(repeated[0]),
    );
  });

  it("排除保持跨阶段和实例独立，导出重新编号，原始时间和列表计数不变", () => {
    const groups = groupEvents(events, full, fight);
    const selected = new Set(groups.map((group) => group.key));
    const overrides = new Map<string, EventOverride>([
      [eventKey(events[1]), { groupKey: groups[1].key, included: false }],
    ]);
    const filtered = selectedEventGroups(groups, selected, overrides);
    expect(formatNote("首领", filtered)).toBe(
      "# 首领\r\n{time:00:35.0} 裂解(1)\r\n{time:01:35.0} 裂解(2)",
    );
    expect(
      selectedEventGroups(
        groupEvents(events, second, fight),
        selected,
        overrides,
      )
        .flatMap((group) => group.events)
        .map((event) => event.time),
    ).toEqual([95000]);
    expect(groups.flatMap((group) => group.events)).toHaveLength(3);
    expect(events.map((event) => event.timestamp)).toEqual([
      36000, 66000, 96000,
    ]);
  });

  it("可以只勾选一次事件而不选整组；不同目标、来源实例保持独立", () => {
    const source = { ...enemies[0], targetID: 20 };
    const mapped = mapEvents(
      [source, { ...source, targetID: 30 }, { ...source, sourceInstance: 2 }],
      "Casts",
      report,
      fight,
      "enemy",
    );
    const groups = groupEvents(mapped, full, fight);
    const overrides = new Map([
      [eventKey(mapped[1]), { groupKey: groups[0].key, included: true }],
    ]);
    expect(
      selectedEventGroups(groups, new Set(), overrides)
        .flatMap((group) => group.events)
        .map(eventKey),
    ).toEqual([eventKey(mapped[1])]);
    expect(new Set(mapped.map(eventKey)).size).toBe(3);
  });

  it("没有逐次覆盖时保留原 MRT 输出，同秒合并和选项继续生效", () => {
    const groups = groupEvents(events, full, fight);
    const selected = new Set(groups.map((group) => group.key));
    expect(
      formatNote("首领", selectedEventGroups(groups, selected, new Map())),
    ).toBe(formatNote("首领", groups));
  });

  it("固定参照保留被 Target 筛掉的事件，但不能勾选或显示为已导出", () => {
    const groups = groupEvents(events, full, fight);
    const selected = new Set(groups.map((group) => group.key));
    const exportable = new Set([eventKey(events[1])]);
    const rows = timelineRows(
      groups,
      selected,
      new Map(),
      timelineBounds(fight, full),
      exportable,
    );
    expect(rows.flatMap((row) => row.entries)).toHaveLength(3);
    const entries = rows.flatMap((row) => row.entries);
    expect(
      entries.filter((entry) => entry.selectable).map((entry) => entry.id),
    ).toEqual([...exportable]);
    expect(
      entries.filter((entry) => entry.included).map((entry) => entry.id),
    ).toEqual([...exportable]);
  });

  it("跨阶段持续的光环只画持续区间，不能制造获得或导出事件", () => {
    const auras = mapEvents(
      [
        {
          type: "applybuff",
          timestamp: 41000,
          abilityGameID: 200,
          sourceID: 20,
          targetID: 20,
        },
        {
          type: "removebuff",
          timestamp: 81000,
          abilityGameID: 200,
          sourceID: 20,
          targetID: 20,
        },
      ],
      "Buffs",
      report,
      fight,
      "friendly",
    );
    const groups = groupEvents(auras, second, fight, true);
    const rows = timelineRows(
      groups,
      new Set(groups.map((group) => group.key)),
      new Map(),
      timelineBounds(fight, second),
    );
    expect(rows[0].entries[0]).toMatchObject({
      selectable: false,
      included: false,
    });
    expect(rows[0].entries[0].event.auraEnd).toBe(81000);
    expect(groupEvents(auras, second, fight)).toEqual([]);
  });
});

describe("WCL 时间轴排序", () => {
  it("单位按合计次数排序，技能按次数排序，同次数采用 WCL 名称顺序", () => {
    const fixture = structuredClone(report);
    fixture.fights![0].friendlyPlayers = [20, 21, 22, 23];
    fixture.masterData!.actors = [
      { id: 10, name: "敌人", type: "NPC" },
      { id: 20, name: "Aardvark", type: "Player", subType: "Mage" },
      { id: 21, name: "Zebra", type: "Player", subType: "Warrior" },
      { id: 22, name: "升星", type: "Player" },
      { id: 23, name: "货运", type: "Player" },
    ];
    fixture.masterData!.abilities = [
      { gameID: 100, name: "风暴守护者" },
      { gameID: 200, name: "升腾" },
      { gameID: 300, name: "货运者水壶" },
      { gameID: 400, name: "灵魂行者的恩赐" },
    ];
    const raw = [
      [10, 100, 1],
      [20, 100, 4],
      [21, 100, 3],
      [21, 200, 2],
      [21, 300, 2],
      [21, 400, 2],
      [22, 100, 1],
      [23, 100, 1],
    ].flatMap(([sourceID, abilityGameID, count]) =>
      Array.from({ length: count }, (_, i) => ({
        type: "cast",
        timestamp: 5000 + i * 1000,
        sourceID,
        abilityGameID,
      })),
    );
    const groups = groupEvents(
      mapEvents(raw, "Casts", fixture, fight, "friendly"),
      full,
      fight,
    );
    const original = [...groups];
    const rows = timelineRows(
      groups,
      new Set(),
      new Map(),
      timelineBounds(fight, full),
    );
    expect(
      rows.map((row) => [row.group.actor.name, row.group.ability.name]),
    ).toEqual([
      ["敌人", "风暴守护者"],
      ["Zebra", "风暴守护者"],
      ["Zebra", "升腾"],
      ["Zebra", "灵魂行者的恩赐"],
      ["Zebra", "货运者水壶"],
      ["Aardvark", "风暴守护者"],
      ["升星", "风暴守护者"],
      ["货运", "风暴守护者"],
    ]);
    expect(groups).toEqual(original);
  });

  it("同名 NPC 与实例有固定顺序，不让不同单位的技能行交错", () => {
    const raw = [
      [11, 1, 200],
      [10, 10, 100],
      [10, 2, 200],
      [11, 1, 100],
      [10, 10, 200],
      [10, 2, 100],
    ].map(([sourceID, sourceInstance, abilityGameID]) => ({
      type: "cast",
      timestamp: 5000,
      sourceID,
      sourceInstance,
      abilityGameID,
    }));
    const groups = groupEvents(
      mapEvents(raw, "Casts", report, fight, "enemy"),
      full,
      fight,
    );
    const rows = timelineRows(
      groups,
      new Set(),
      new Map(),
      timelineBounds(fight, full),
    );
    expect(rows.map((row) => [row.group.actor.id, row.group.instance])).toEqual(
      [
        [10, 2],
        [10, 2],
        [10, 10],
        [10, 10],
        [11, 1],
        [11, 1],
      ],
    );
  });

  it.each(["Buffs", "Debuffs"] as const)(
    "%s 将当前阶段的刷新和叠层计入排序，跨阶段延续仍不制造导出事件",
    (type) => {
      const suffix = type === "Buffs" ? "buff" : "debuff";
      const raw = [
        ["apply", 41000, 200],
        ["refresh", 66000, 200],
        ["applystack", 71000, 200],
        ["remove", 81000, 200],
        ["apply", 62000, 300],
        ["remove", 118000, 300],
        ["remove", 90000, 100],
      ].map(([action, timestamp, abilityGameID]) => ({
        type:
          action === "applystack"
            ? `apply${suffix}stack`
            : `${action}${suffix}`,
        timestamp: Number(timestamp),
        abilityGameID: Number(abilityGameID),
        sourceID: 20,
        targetID: 20,
      }));
      const mapped = mapEvents(raw, type, report, fight, "friendly");
      const groups = groupEvents(mapped, second, fight, true);
      const selected = new Set(groups.map((group) => group.key));
      const rows = timelineRows(
        groups,
        selected,
        new Map(),
        timelineBounds(fight, second),
      );
      expect(rows.map((row) => row.group.ability.gameID)).toEqual([
        200, 300, 100,
      ]);
      expect(rows[0].entries[0]).toMatchObject({
        selectable: false,
        included: false,
      });
      expect(rows[0].entries[0].event.auraUses).toEqual([41000, 66000, 71000]);
      expect(
        selectedEventGroups(
          groupEvents(mapped, second, fight),
          selected,
          new Map(),
        ).flatMap((group) => group.events),
      ).toHaveLength(1);
      expect(mapped).toHaveLength(3);
    },
  );
});

describe("时间坐标与 MRT 定位", () => {
  it("缩放到阶段中间保留当前阶段名，窗口结束处尚未开始的阶段不显示", () => {
    const items = [full, first, second];
    expect(
      visibleTimelinePhases(items, fight.startTime, {
        start: 30000,
        end: 90000,
      }).map((phase) => phase.id),
    ).toEqual(["phase-1", "phase-2"]);
    expect(
      visibleTimelinePhases(items, fight.startTime, {
        start: 30000,
        end: 60000,
      }).map((phase) => phase.id),
    ).toEqual(["phase-1"]);
    expect(
      visibleTimelinePhases(items, fight.startTime, {
        start: 60000,
        end: 90000,
      }).map((phase) => phase.id),
    ).toEqual(["phase-2"]);
    expect(
      visibleTimelinePhases(
        [{ ...second, id: "pull-2", relative: true }],
        second.startTime,
        { start: 0, end: 60000 },
      )[0].time,
    ).toBe(0);
  });

  it("阶段标签避让重叠、留出刻度空间，并完整收进时间轴左右边界", () => {
    const result = layoutPhaseLabels(
      [
        { id: "a", time: 0, width: 180, height: 20 },
        { id: "b", time: 90, width: 160, height: 38 },
        { id: "c", time: 99, width: 90, height: 20 },
      ],
      { start: 0, end: 100 },
      300,
    );
    for (const label of result.labels) {
      expect(label.left).toBeGreaterThanOrEqual(6);
      expect(label.left + label.width).toBeLessThanOrEqual(294);
      expect(label.top + label.height).toBeLessThanOrEqual(result.height - 22);
      for (const other of result.labels.filter(
        (other) => other.id !== label.id,
      )) {
        expect(
          label.left + label.width <= other.left ||
            other.left + other.width <= label.left ||
            label.top + label.height <= other.top ||
            other.top + other.height <= label.top,
        ).toBe(true);
      }
    }
    expect(new Set(result.labels.map((label) => label.top)).size).toBe(2);
  });

  it("窄画布和区间前已开始的标签不越界，空画布保留默认时间尺高度", () => {
    const result = layoutPhaseLabels(
      [
        { id: "a", time: 0, width: 200, height: 20 },
        { id: "b", time: 100, width: 200, height: 20 },
      ],
      { start: 50, end: 100 },
      80,
    );
    expect(result.labels.map((label) => [label.left, label.width])).toEqual([
      [6, 68],
      [6, 68],
    ]);
    expect(result.labels[1].top).toBeGreaterThanOrEqual(
      result.labels[0].top + result.labels[0].height,
    );
    expect(layoutPhaseLabels([], { start: 0, end: 1 }, 80)).toEqual({
      height: 52,
      labels: [],
    });
    expect(
      layoutPhaseLabels(
        [{ id: "a", time: 0, width: 10, height: 20 }],
        { start: 0, end: 1 },
        0,
      ),
    ).toEqual({ height: 52, labels: [] });
  });

  it("团本阶段保持战斗绝对时间，Pull 的显示和导出都从零开始", () => {
    expect(timelineBounds(fight, first)).toEqual({ start: 0, end: 60000 });
    expect(timelineBounds(fight, second)).toEqual({
      start: 60000,
      end: 120000,
    });
    const pull = { ...second, id: "pull-2", relative: true };
    expect(timelineBounds(fight, pull)).toEqual({ start: 0, end: 60000 });
    const event = groupEvents(events, pull, fight)
      .flatMap((group) => group.events)
      .find((event) => eventKey(event) === eventKey(events[1]))!;
    expect(event.time).toBe(5000);
  });

  it("缩放和平移限制在当前区间，短战斗和最小缩放不会产生空窗口", () => {
    const bounds = { start: 60000, end: 120000 };
    expect(zoomWindow(bounds, bounds, 0.5)).toEqual({
      start: 75000,
      end: 105000,
    });
    expect(clampWindow({ start: 119000, end: 149000 }, bounds)).toEqual({
      start: 90000,
      end: 120000,
    });
    expect(clampWindow({ start: 0, end: 1 }, bounds)).toEqual({
      start: 60000,
      end: 62000,
    });
    expect(zoomWindow(bounds, bounds, 4)).toEqual(bounds);
    expect(clampWindow({ start: 119000, end: 120000 }, bounds, 1000)).toEqual({
      start: 119000,
      end: 120000,
    });
    expect(zoomWindow({ start: 119000, end: 120000 }, bounds, 0.5)).toEqual({
      start: 119000,
      end: 120000,
    });
    expect(
      clampWindow({ start: 3000, end: 3001 }, { start: 0, end: 500 }),
    ).toEqual({ start: 0, end: 500 });
  });

  it("长短区间刻度数量有界，精确时间保留毫秒和负偏移", () => {
    for (const window of [
      { start: 0, end: 120000 },
      { start: 61333, end: 63333 },
      { start: 0, end: 86400000 },
    ]) {
      const ticks = timelineTicks(window);
      expect(ticks.length).toBeGreaterThan(0);
      expect(ticks.length).toBeLessThanOrEqual(8);
      expect(
        ticks.every((time) => time >= window.start && time <= window.end),
      ).toBe(true);
    }
    expect(preciseTime(61987)).toBe("01:01.987");
    expect(preciseTime(-1234)).toBe("-00:01.234");
  });

  it("长战斗默认查看前 20 秒，短战斗和非零起点保持有效范围", () => {
    expect(defaultTimelineWindow({ start: 0, end: 600000 })).toEqual({
      start: 0,
      end: 20000,
    });
    expect(defaultTimelineWindow({ start: 0, end: 700 })).toEqual({
      start: 0,
      end: 700,
    });
    expect(defaultTimelineWindow({ start: 60000, end: 120000 })).toEqual({
      start: 60000,
      end: 80000,
    });
  });

  it("最小大格一秒，半秒中刻度和十分之一秒小刻度各自独立", () => {
    const window = { start: 0, end: 1000 };
    expect(timelineTicks(window, 100)).toEqual([0, 1000]);
    expect(timelineMediumTicks(window, 100)).toEqual([500]);
    expect(timelineMinorTicks(window, 100)).toEqual([
      100, 200, 300, 400, 600, 700, 800, 900,
    ]);
    expect(timelineTicks({ start: 0, end: 20000 }, 33)).toHaveLength(21);
    const offset = { start: 123, end: 987 };
    expect(timelineTicks(offset, 100)).toEqual([]);
    expect(timelineMediumTicks(offset, 100)).toEqual([500]);
    expect(timelineMinorTicks(offset, 100)).toEqual([
      200, 300, 400, 600, 700, 800, 900,
    ]);
  });

  it("主次刻度随可用宽度变化，次刻度不会重复主刻度", () => {
    const window = { start: 0, end: 120000 };
    const major = timelineTicks(window, 12);
    const minor = timelineMinorTicks(window, 12);
    expect(major).toContain(10000);
    expect(minor).toContain(2000);
    expect(
      minor.every(
        (time) =>
          !major.includes(time) && time >= window.start && time <= window.end,
      ),
    ).toBe(true);
    expect(timelineTicks(window, 2).length).toBeLessThan(major.length);
  });

  it("按导出十分之一秒定位完整行，兼容 CRLF 文件和 textarea 规范化的 LF", () => {
    for (const separator of ["\n", "\r\n"]) {
      const note = [
        "# 首领",
        "{time:00:35.0} 技能A  技能B",
        "{time:01:05.0} 技能C",
      ].join(separator);
      const range = noteEventRange(note, 35040)!;
      expect(note.slice(range.start, range.end)).toBe(
        "{time:00:35.0} 技能A  技能B",
      );
      expect(range.line).toBe(1);
      expect(noteEventRange(note, 90000)).toBeUndefined();
    }
  });
});
