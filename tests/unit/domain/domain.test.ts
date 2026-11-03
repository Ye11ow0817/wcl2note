import { describe, it, expect } from "vitest";
import {
  parseReport,
  segments,
  initialSegment,
  filename,
} from "../../../src/domain/report";
import {
  groupEvents,
  mapEvents,
  sourceTree,
  visibleGroups,
} from "../../../src/domain/group";
import { formatNote } from "../../../src/domain/format";
import { defaults, type Group } from "../../../src/domain/model";
import { report, enemies, friendlies } from "../../fixtures/report";
const fight = report.fights![0],
  full = segments(fight, report)[0];
const events = [
  ...mapEvents(enemies, "Casts", report, fight, "enemy"),
  ...mapEvents(friendlies, "Casts", report, fight, "friendly"),
];
const groups = () => groupEvents(events, full, fight);
describe("桌面 URL 选择器基线", () => {
  it.each(["AbCd1234", " abc123 "])("纯编号 %s", (input) =>
    expect(parseReport(input).code).toBe(input.trim()),
  );
  it("query 优先且参数大小写不敏感", () =>
    expect(
      parseReport(
        "https://www.warcraftlogs.com/reports/abc?FIGHT=2&pull=0#fight=last&phase=3",
      ),
    ).toEqual({ code: "abc", fight: 2, last: false, pull: 0, phase: 3 }));
  it("last 与非法选择器", () =>
    expect(
      parseReport("https://x/reports/abc#fight=LAST&pull=-1&phase=2"),
    ).toMatchObject({ last: true, pull: undefined, phase: 2 }));
  it.each(["", "not a url", "https://x/foo", "https://x/reports/a-b"])(
    "拒绝无效输入 %s",
    (s) => expect(() => parseReport(s)).toThrow(),
  );
  it("保留空 query 参数对 hash 的优先级", () =>
    expect(parseReport("https://x/reports/abc?fight=#fight=last").last).toBe(
      false,
    ));
  it("优先 pull 并按位置回退", () =>
    expect(
      initialSegment(
        [
          { ...full, id: "pull-5" },
          { ...full, id: "phase-1" },
        ],
        { code: "x", last: false, pull: 1, phase: 1 },
      ).id,
    ).toBe("pull-5"));
});
describe("时间映射与分组", () => {
  it("重复进入同一阶段使用独立标识和时间范围，并保留原阶段链接选择", () => {
    const repeated = {
      ...fight,
      phaseTransitions: [
        { id: 1, startTime: 91000 },
        { id: 2, startTime: 61000 },
        { id: 1, startTime: 1000 },
      ],
    };
    const items = segments(repeated, report);
    expect(items.map((item) => item.id)).toEqual([
      "full",
      "phase-1",
      "phase-2",
      "phase-1-2",
    ]);
    expect(items[3]).toMatchObject({
      name: "第一阶段（第 2 次）",
      startTime: 91000,
      endTime: 121000,
    });
    expect(initialSegment(items, { code: "x", last: false, phase: 1 })).toBe(
      items[1],
    );
    expect(
      groupEvents(events, items[3], repeated).flatMap((group) =>
        group.events.map((event) => event.time),
      ),
    ).toEqual([95000]);
  });
  it("阶段保留整场时间且两端包含", () => {
    const s = segments(fight, report)[2];
    expect(
      groupEvents(events, s, fight)
        .flatMap((g) => g.events)
        .map((e) => e.time)
        .sort((a, b) => a - b),
    ).toEqual([65000, 77000, 95000]);
  });
  it("Pull 从区间起点计时", () => {
    const s = { ...full, id: "pull-1", startTime: 61000, relative: true };
    expect(
      groupEvents(events, s, fight)
        .flatMap((g) => g.events)
        .map((e) => e.time)
        .sort((a, b) => a - b),
    ).toEqual([5000, 17000, 35000]);
  });
  it("同来源实例共享 selection key，不混并不同来源", () => {
    const g = groups().filter((g) => g.side === "enemy");
    expect(g).toHaveLength(3);
    expect(new Set(g.map((g) => g.key)).size).toBe(2);
    expect(visibleGroups(g, "enemy", undefined, report, fight)).toHaveLength(2);
  });
  it("所有友方隐藏宠物，来源树仍可选择", () => {
    const g = groups();
    expect(visibleGroups(g, "friendly", undefined, report, fight)).toHaveLength(
      1,
    );
    const nodes = sourceTree(g, report, fight, "friendly");
    expect(nodes[0].name).toBe("玩家法师");
    expect(nodes[0].children[0].name).toBe("水元素");
    expect(
      visibleGroups(g, "friendly", nodes[0].children[0], report, fight)[0]
        .events,
    ).toHaveLength(2);
    expect(
      visibleGroups(g, "friendly", nodes[0], report, fight)[0].actor.id,
    ).toBe(20);
  });
  it.each(["Buffs", "Debuffs"] as const)(
    "%s 使用获得者并忽略移除事件",
    (type) => {
      const raw = [
        {
          type: type === "Buffs" ? "applybuff" : "applydebuff",
          timestamp: 5000,
          abilityGameID: 200,
          sourceID: 10,
          targetID: 20,
          targetInstance: 4,
        },
        {
          type: "removebuff",
          timestamp: 6000,
          abilityGameID: 200,
          sourceID: 10,
          targetID: 20,
        },
      ];
      const mapped = mapEvents(raw, type, report, fight, "enemy");
      expect(mapped).toHaveLength(1);
      expect(mapped[0]).toMatchObject({
        actor: { id: 20 },
        instance: 4,
        side: "friendly",
      });
    },
  );
  it("缺失实例时按 Actor 找主人", () => {
    const raw = mapEvents(
      [
        {
          type: "applybuff",
          timestamp: 5000,
          abilityGameID: 200,
          targetID: 30,
        },
      ],
      "Buffs",
      report,
      fight,
      "friendly",
    );
    const nodes = sourceTree(
      groupEvents(raw, full, fight),
      report,
      fight,
      "friendly",
    );
    expect(nodes[0].name).toBe("玩家法师");
    expect(nodes[0].children[0].name).toBe("水元素");
  });
  it("友方玩家优先，空区间无结果", () => {
    expect(
      visibleGroups(groups(), "friendly", undefined, report, fight)[0].actor.id,
    ).toBe(20);
    expect(
      groupEvents(events, { ...full, endTime: full.startTime }, fight),
    ).toEqual([]);
  });
});
describe("MRT 输出", () => {
  it("时间、重复敌方编号与默认开关", () =>
    expect(
      formatNote(
        "测试首领",
        groups().filter((g) => g.actor.id !== 30),
      ),
    ).toBe(
      "# 测试首领\r\n{time:00:17.0} FS - 时间扭曲\r\n{time:00:35.0} 裂解(1)\r\n{time:01:05.0} 裂解(2)\r\n{time:01:35.0} 裂解(3)",
    ));
  it("同十分之一秒敌方在先、双空格连接", () => {
    const g = groups()
      .filter((g) => g.actor.id === 20 || g.actor.id === 11)
      .map((g) => ({
        ...g,
        events: g.events.map((e) => ({
          ...e,
          time: g.side === "enemy" ? 17040 : 17000,
        })),
      }));
    expect(formatNote("同秒", g, { ...defaults, icon: true })).toBe(
      "# 同秒\r\n{time:00:17.0} {spell:100}裂解  FS - {spell:200}时间扭曲",
    );
  });
  it("同来源多实例移除姓名后缀", () => {
    const text = formatNote(
      "test",
      groups().filter((g) => g.actor.id === 10),
      { ...defaults, enemy: true },
    );
    expect(text).toContain("首领 - 裂解");
    expect(text).not.toMatch(/首领 \d/);
  });
  it("同名不同来源保留姓名后缀", () => {
    const text = formatNote(
      "test",
      groups().filter((g) => g.side === "enemy" && g.instance === 1),
      { ...defaults, enemy: true },
    );
    expect(text).toMatch(/首领 \d - 裂解/);
  });
  it("宠物后缀被移除，职业编号保留", () => {
    const g = groups().find((g) => g.actor.id === 20)!;
    const numbered: Group = { ...g, actor: { ...g.actor, name: "玩家法师 2" } };
    expect(formatNote("test", [numbered])).toContain("FS 2 - 时间扭曲");
    expect(
      formatNote(
        "test",
        groups().filter((g) => g.actor.id === 30),
      ),
    ).not.toMatch(/水元素 \d/);
  });
  it.each(Array.from({ length: 16 }, (_, i) => i))("输出开关组合 %i", (i) => {
    const o = {
      icon: !!(i & 1),
      friendly: !!(i & 2),
      enemy: !!(i & 4),
      simplify: !!(i & 8),
    };
    const text = formatNote(
      "test",
      groups().filter((g) => g.actor.id === 20 || g.actor.id === 11),
      o,
    );
    expect(text.includes("{spell:")).toBe(o.icon);
    expect(
      text.includes(" - 时间扭曲") || text.includes(" - {spell:200}"),
    ).toBe(o.friendly);
    expect(text.includes("首领")).toBe(o.enemy);
  });
  it("60分钟以上与文件名清理", () => {
    const g = groups()[0];
    expect(
      formatNote("test", [
        { ...g, events: [{ ...g.events[0], time: 3661000 }] },
      ]),
    ).toContain("{time:61:01.0}");
    expect(filename("首领:阶段/2.txt")).toBe("首领_阶段_2.txt");
  });
});
