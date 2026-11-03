import { describe, expect, it } from "vitest";
import { mapEvents, groupEvents } from "../../../src/domain/group";
import { createNSRTNote, nsrtEventRange } from "../../../src/domain/nsrt";
import { segments } from "../../../src/domain/report";
import { eventKey } from "../../../src/domain/timeline";
import type {
  Fight,
  Group,
  RawEvent,
  Segment,
} from "../../../src/domain/model";
import { defaults } from "../../../src/domain/model";
import { enemies, friendlies, report } from "../../fixtures/report";

const fight = report.fights![0];
const [full, , second] = segments(fight, report);
function groups(
  events: RawEvent[] = [...enemies, ...friendlies],
  currentFight: Fight = fight,
  segment: Segment = full,
) {
  return groupEvents(
    mapEvents(events, "Casts", report, currentFight, "friendly"),
    segment,
    currentFight,
  );
}
describe("NSRT Note", () => {
  it("默认输出友方职业 tag，省略敌方 tag，保持阶段内秒数和绝对时间顺序", () => {
    const note = createNSRTNote(
      fight,
      groups().filter((g) => g.actor.id !== 30),
    );
    expect(note.text).toBe(
      [
        "EncounterID:99;Difficulty:Mythic;Name:测试首领;",
        "ph:1;time:17;tag:MAGE;spellid:200;",
        "ph:1;time:35;spellid:100;",
        "ph:2;time:5;spellid:100;",
        "ph:2;time:35;spellid:100;",
      ].join("\r\n"),
    );
    expect(note.text).not.toContain("tag:FS;");
    expect(note.text).not.toContain("text:");
    for (const line of note.text.split("\r\n").slice(1))
      expect(line).toMatch(
        /^ph:\d+;time:\d+(?:\.\d)?;(?:tag:[^;]+;)?spellid:\d+;$/,
      );
  });

  it.each(Array.from({ length: 8 }, (_, i) => i))(
    "来源和简化开关组合 %i 直接控制 tag，关闭来源省略 tag，不添加 text",
    (flags) => {
      const options = {
        ...defaults,
        friendly: !!(flags & 1),
        enemy: !!(flags & 2),
        simplify: !!(flags & 4),
      };
      const selected = groups().filter((group) =>
        [10, 20].includes(group.actor.id),
      );
      const text = createNSRTNote(fight, selected, true, options).text;
      const friendly = text
        .split("\r\n")
        .find((line) => line.includes("spellid:200;"))!;
      if (options.friendly)
        expect(friendly).toContain(
          `tag:${options.simplify ? "MAGE" : "玩家法师"};`,
        );
      else expect(friendly).not.toContain("tag:");
      for (const enemy of text
        .split("\r\n")
        .filter((line) => line.includes("spellid:100;"))) {
        if (options.enemy) expect(enemy).toContain("tag:首领;");
        else expect(enemy).not.toContain("tag:");
      }
      expect(text).not.toContain("text:");
    },
  );

  it.each([full, second, { ...second, id: "pull-7", relative: true }])(
    "关闭动态计时器后从开战累计，阶段和 Pull 筛选不改变基准 $id",
    (segment) => {
      const selected = groups(enemies, fight, segment);
      const fixed = createNSRTNote(fight, selected, false).text;
      expect(fixed).toContain("ph:1;time:65;");
      expect(fixed).toContain("ph:1;time:95;");
      expect(fixed).not.toContain("ph:2;");
      expect(createNSRTNote(fight, selected).text).toContain("ph:2;time:5;");
    },
  );

  it("读条按真实开始时间选择阶段，先减阶段起点再四舍五入到 0.1 秒", () => {
    const selected = groups([
      { type: "begincast", timestamp: 60940, abilityGameID: 200, sourceID: 20 },
      { type: "cast", timestamp: 62000, abilityGameID: 200, sourceID: 20 },
      { type: "begincast", timestamp: 61750, abilityGameID: 100, sourceID: 10 },
      { type: "cast", timestamp: 64000, abilityGameID: 100, sourceID: 10 },
    ]);
    expect(createNSRTNote(fight, selected).text).toContain("ph:1;time:59.9;");
    expect(createNSRTNote(fight, selected).text).toContain("ph:2;time:0.8;");
    expect(createNSRTNote(fight, selected, false).text).toContain(
      "ph:1;time:60.8;",
    );
  });

  it("阶段边界属于新阶段，缺少阶段时从开战计时", () => {
    const selected = groups([{ ...friendlies[0], timestamp: 61000 }]);
    expect(createNSRTNote(fight, selected).text).toContain("ph:2;time:0;");
    expect(
      createNSRTNote({ ...fight, phaseTransitions: undefined }, selected).text,
    ).toContain("ph:1;time:60;");
  });

  it("重复进入阶段按发生顺序单独编号，不合并同阶段编号的事件", () => {
    const repeated: Fight = {
      ...fight,
      phaseTransitions: [
        { id: 1, startTime: 81000 },
        { id: 1, startTime: 1000 },
        { id: 2, startTime: 61000 },
      ],
    };
    const selected = groups(
      [
        { ...friendlies[0], timestamp: 11000 },
        { ...friendlies[0], timestamp: 71000 },
        { ...friendlies[0], timestamp: 91000 },
      ],
      repeated,
    );
    expect(
      createNSRTNote(repeated, selected).text.split("\r\n").slice(1),
    ).toEqual([
      "ph:1;time:10;tag:MAGE;spellid:200;",
      "ph:2;time:10;tag:MAGE;spellid:200;",
      "ph:3;time:10;tag:MAGE;spellid:200;",
    ]);
  });

  it("宠物 tag 使用来源名字并移除实例后缀，来源关闭时省略 tag", () => {
    const pets = groups(friendlies).filter((group) => group.actor.id === 30);
    expect(createNSRTNote(fight, pets).text).toContain(
      "ph:1;time:24;tag:水元素;spellid:300;",
    );
    expect(
      createNSRTNote(fight, pets, true, { ...defaults, friendly: false }).text,
    ).not.toContain("tag:");
  });

  it("同秒事件分别输出，可精确定位第二个相同事件，兼容 LF 和 CRLF", () => {
    const selected = groups([friendlies[0], friendlies[0], enemies[0]]);
    const note = createNSRTNote(fight, selected);
    const events = selected.flatMap((group) => group.events);
    expect(note.text.split("\r\n")).toHaveLength(4);
    for (const text of [note.text, note.text.replaceAll("\r\n", "\n")]) {
      const rows = events.map((event) => {
        const range = nsrtEventRange(
          text,
          note.eventLines.get(eventKey(event)),
        )!;
        expect(text.slice(range.start, range.end)).toMatch(
          /^ph:\d+;time:.*;spellid:\d+;/,
        );
        return range.line;
      });
      expect(new Set(rows).size).toBe(3);
      expect(nsrtEventRange(text, undefined)).toBeUndefined();
      expect(nsrtEventRange(text, 0)).toBeUndefined();
      expect(nsrtEventRange(text, 99)).toBeUndefined();
    }
  });

  it.each([
    [1, "LFR"],
    [3, "Normal"],
    [4, "Heroic"],
    [5, "Mythic"],
  ])("将 WCL 难度 %s 转成 %s", (difficulty, expected) => {
    expect(
      createNSRTNote({ ...fight, difficulty: Number(difficulty) }, []).text,
    ).toContain(`Difficulty:${expected};`);
  });

  it("未知难度省略可选字段，并清理战斗名称和 tag 的字段分隔符", () => {
    const selected: Group[] = groups(enemies).map((group) => ({
      ...group,
      actor: { ...group.actor, name: "首领;测试\n续行" },
    }));
    const text = createNSRTNote(
      { ...fight, name: "首领;测试\r\n续行", difficulty: undefined },
      selected,
      true,
      { ...defaults, enemy: true },
    ).text;
    expect(text.split("\r\n")[0]).toBe("EncounterID:99;Name:首领 测试 续行;");
    expect(text).not.toContain("Difficulty:");
    expect(text).toContain("tag:首领 测试 续行;");
    expect(text).not.toContain("text:");
  });
});
