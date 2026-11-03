import { describe, expect, it } from "vitest";
import { spellSchool, spellSchoolBackground } from "../../../src/domain/casts";
import { groupEvents, mapEvents } from "../../../src/domain/group";
import {
  formatNote,
  noteTime,
  noteTimestamp,
} from "../../../src/domain/format";
import {
  timelineBounds,
  timelineInterval,
  timelineRows,
} from "../../../src/domain/timeline";
import { allEvents } from "../../../src/renderer/api/wcl/client";
import type { RawEvent } from "../../../src/domain/model";
import { report } from "../../fixtures/report";
import { vi } from "vitest";
import type { DesktopBridge } from "../../../src/shared/desktop";

const fight = report.fights![0];
const full = { ...fight, id: "full", relative: false };
const cast = (
  type: string,
  timestamp: number,
  values: Partial<RawEvent> = {},
): RawEvent => ({
  type,
  timestamp,
  abilityGameID: 100,
  sourceID: 10,
  sourceInstance: 1,
  ...values,
});
const map = (raw: RawEvent[]) =>
  mapEvents(raw, "Casts", report, fight, "enemy");

describe("真实读条区间与施法开始时间导出", () => {
  it("按来源与实例配对，目标变化不影响配对，瞬发与未完成施法不生成读条", () => {
    const events = map([
      cast("begincast", 2000, { targetID: -1 }),
      cast("begincast", 2500, { sourceInstance: 2 }),
      cast("cast", 4000, { targetID: 20 }),
      cast("cast", 5000, { sourceInstance: 2 }),
      cast("cast", 7000),
      cast("begincast", 10000),
    ]);
    expect(events.map((e) => [e.timestamp, e.castStart])).toEqual([
      [4000, 2000],
      [5000, 2500],
      [7000, undefined],
    ]);
    expect(timelineInterval(events[0])).toEqual({ start: 1000, end: 3000 });
    expect(formatNote("首领", groupEvents(events, full, fight))).toContain(
      "{time:00:01.0}",
    );
    expect(formatNote("首领", groupEvents(events, full, fight))).not.toContain(
      "{time:00:03.0}",
    );
  });
  it("新读条替换被取消的旧读条，瞬发不消耗其他技能的读条，fake 不污染起点", () => {
    const events = map([
      cast("begincast", 2000),
      cast("begincast", 3000, { abilityGameID: 200 }),
      cast("cast", 3500),
      cast("begincast", 3700, { abilityGameID: 200, fake: true }),
      cast("cast", 4000, { abilityGameID: 200, fake: true }),
      cast("cast", 4500, { abilityGameID: 200 }),
      cast("cast", 4600, { abilityGameID: 200 }),
    ]);
    expect(events.map((e) => [e.timestamp, e.castStart])).toEqual([
      [3500, undefined],
      [4500, 3000],
      [4600, undefined],
    ]);
  });
  it("开始时间决定导出顺序与敌方编号，十分之一秒合并，保留相对 Pull 起点", () => {
    const events = map([
      cast("begincast", 2213),
      cast("cast", 2300, { sourceInstance: 2 }),
      cast("cast", 2230, { sourceInstance: 3 }),
      cast("cast", 5000),
    ]);
    expect(formatNote("首领", groupEvents(events, full, fight))).toBe(
      "# 首领\r\n{time:00:01.2} 裂解(1)  裂解(2)\r\n{time:00:01.3} 裂解(3)",
    );
    const completed = events.find((e) => e.castStart != null)!;
    expect(noteTime({ ...completed, time: 500 })).toBe(-2287);
    expect(noteTime({ ...completed, castStart: undefined, time: 500 })).toBe(
      500,
    );
  });
  it.each([
    [0, "00:00.0"],
    [1234, "00:01.2"],
    [1250, "00:01.3"],
    [59950, "01:00.0"],
    [3661999, "61:02.0"],
    [-1234, "-00:01.2"],
  ])("MRT 时间 %i 舍入为 %s", (time, expected) => {
    expect(noteTimestamp(time)).toBe(expected);
  });
  it("蓄力从 empowerstart 到 empowerend，只计完成一次；同毫秒不画假区间", () => {
    const events = map([
      cast("empowerstart", 2000),
      cast("cast", 2000, { fake: true }),
      cast("empowerend", 5000),
      cast("begincast", 6000),
      cast("cast", 6000),
    ]);
    expect(events.map((e) => [e.timestamp, e.castStart])).toEqual([
      [5000, 2000],
      [6000, undefined],
    ]);
  });
  it("跨阶段与 Pull 裁剪读条，但完成不在区间内不能计数或导出", () => {
    const events = map([cast("begincast", 60000), cast("cast", 63000)]);
    const first = { ...full, id: "phase-1", endTime: 61000 };
    const second = { ...full, id: "phase-2", startTime: 61000 };
    expect(groupEvents(events, first, fight, true)).toEqual([]);
    const drawing = groupEvents(events, first, fight, true, true);
    const row = timelineRows(
      drawing,
      new Set(drawing.map((g) => g.key)),
      new Map(),
      timelineBounds(fight, first),
    )[0];
    expect(row.entries[0]).toMatchObject({
      selectable: false,
      included: false,
    });
    expect(timelineInterval(row.entries[0].event)).toEqual({
      start: 59000,
      end: 62000,
    });
    const pull = groupEvents(
      events,
      { ...second, relative: true },
      fight,
      true,
      true,
    );
    expect(timelineInterval(pull[0].events[0])).toEqual({
      start: -1000,
      end: 2000,
    });
  });
  it("开始与完成跨分页时仍能配对，不额外请求或重复计数", async () => {
    const calls = vi.fn<DesktopBridge["query"]>(async (_id, payload) => {
      if (payload.operation !== "fightAbilityEvents")
        throw Error("Unexpected query");
      return {
        ok: true,
        data: {
          report: {
            events: {
              data:
                payload.variables.startTime === 1000
                  ? [cast("begincast", 3000)]
                  : [cast("cast", 5500)],
              nextPageTimestamp:
                payload.variables.startTime === 1000 ? 5000 : null,
            },
          },
        },
      };
    });
    vi.stubGlobal("window", { wcl2note: { query: calls, cancel: vi.fn() } });
    try {
      const events = await allEvents(
        "abc",
        fight,
        report,
        "Casts",
        "enemy",
        new AbortController().signal,
        [100],
      );
      expect(calls).toHaveBeenCalledTimes(2);
      for (const [, payload] of calls.mock.calls)
        expect(
          payload.operation === "fightAbilityEvents" &&
            payload.variables.abilityIds,
        ).toEqual([100]);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ castStart: 3000, timestamp: 5500 });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

it("学派位掩码、名称、复合学派与未知学派均有稳定颜色", () => {
  expect(spellSchool("4")).toEqual(spellSchool("Fire"));
  expect(spellSchool("4").color).toBe("#eb4561");
  expect(spellSchool(36).color).toBe("#b8a8f0");
  expect(spellSchool(80).color).toBe("#8ff2ff");
  expect(spellSchool(106).color).toBe("#8ff2ff");
  expect(spellSchool(127).color).toBe("#a330c9");
  expect(spellSchool(16)).toEqual({ name: "冰霜", color: "#4a80ff" });
  expect(spellSchool("28")).toEqual({
    name: "火焰 / 自然 / 冰霜",
    color: "#4a80ff",
  });
  // Rendered WCL Elemental Blast bar, distinct from its text color.
  expect(spellSchoolBackground("28")).toBe(
    "linear-gradient(45deg, #4a80ff, #d1fa99 50%, #eb4561)",
  );
  for (const invalid of [undefined, null, "", "invalid", 0, 129, -1])
    expect(spellSchool(invalid)).toEqual({
      name: "未知学派",
      color: "#a6b5c4",
    });
});

it("复合学派采用 WCL 脚本内联文字色，并保留 CSS 优先色及特殊类型", () => {
  // Real report: Elemental Blast's three stat Buffs use 28; 日灼 uses 6.
  expect(spellSchool(28).color).toBe("#4a80ff");
  expect(spellSchool(6).color).toBe("#eb4561");
  expect(spellSchool(3).color).toBe("#ffff8f");
  expect(spellSchool(12).color).toBe("#d1fa99");
  expect(spellSchool(48).color).toBe("#b8a8f0");
  expect(spellSchool(62).color).toBe("#b8a8f0");
  expect(spellSchool(96).color).toBe("#8ff2ff");
  // Five schools generate an inline color; CSS !important overrides it.
  expect(spellSchool(124).color).toBe("#a330c9");
  expect(spellSchool(125).color).toBe("#a330c9");
  // WCL does not generate an inline color for six schools.
  for (const mask of [63, 95, 111, 119, 123])
    expect(spellSchool(mask).color).toBe("#46c5ff");
  for (const [type, color] of [
    [128, "#ffa34a"],
    [256, "#2599be"],
    [512, "#bfbfbf"],
    [1024, "#2599be"],
  ] as const)
    expect(spellSchool(String(type)).color).toBe(color);
});
