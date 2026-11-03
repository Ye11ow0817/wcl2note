import { expect, it } from "vitest";
import type { TimelineEvent } from "../../../src/domain/model";
import {
  eventGroupKey,
  eventSkill,
  groupMatchesProfileSkill,
  matchingProfileGroups,
  hasPartialProfileSelection,
  sameProfileSkills,
  updateProfileSkills,
  validatedProfileName,
} from "../../../src/domain/skillProfile";
import {
  readSkillProfiles,
  writeSkillProfiles,
  skillProfilesStorageKey,
} from "../../../src/renderer/features/skill-profiles/storage";

function event(
  actor: number,
  id: string,
  type: TimelineEvent["eventType"] = "Casts",
  side: TimelineEvent["side"] = "friendly",
): TimelineEvent {
  return {
    id,
    time: 1000,
    timestamp: 2000,
    actor: { id: actor, name: "玩家 " + actor },
    side,
    eventType: type,
    ability: { gameID: 31821, name: "光环掌握" },
  };
}
it("配置按技能、类型和阵营匹配新日志的全部 Actor", () => {
  const original = event(1, "original");
  const events = [
    event(100, "a"),
    event(200, "b"),
    event(300, "c", "Buffs"),
    event(400, "d", "Casts", "enemy"),
  ];
  expect(matchingProfileGroups(events, [eventSkill(original)])).toEqual(
    new Set(events.slice(0, 2).map(eventGroupKey)),
  );
  expect(
    matchingProfileGroups(events, [eventSkill(original), eventSkill(events[2])])
      .size,
  ).toBe(3);
});
it("取消一个 Actor 时保留其他 Actor 的同技能，取消最后一个时仍保留本场缺失的技能", () => {
  const a = event(1, "a"),
    b = event(2, "b");
  const missing = { ...eventSkill(a), abilityId: 62618, name: "真言术：障" };
  const skills = [eventSkill(a), missing];
  expect(
    updateProfileSkills(
      skills,
      [a, b],
      new Set([eventGroupKey(b)]),
      new Map(),
      [eventGroupKey(a)],
    ),
  ).toEqual(skills);
  expect(
    updateProfileSkills(skills, [a, b], new Set(), new Map(), [
      eventGroupKey(b),
    ]),
  ).toEqual([missing]);
});
it("逐次事件的选择能保存为技能规则，排除的事件和仅有光环延续不会误算成选择", () => {
  const a = event(1, "a"),
    b = { ...event(1, "b"), time: 2000 };
  expect(
    updateProfileSkills(
      [],
      [a, b],
      new Set(),
      new Map([["a", { groupKey: eventGroupKey(a), included: true }]]),
      [eventGroupKey(a)],
    ),
  ).toEqual([eventSkill(a)]);
  expect(
    updateProfileSkills(
      [eventSkill(a)],
      [a, b],
      new Set([eventGroupKey(a)]),
      new Map([
        ["a", { groupKey: eventGroupKey(a), included: false }],
        ["b", { groupKey: eventGroupKey(b), included: false }],
      ]),
      [eventGroupKey(a)],
    ),
  ).toEqual([]);
  expect(
    updateProfileSkills(
      [],
      [{ ...a, auraOnly: true }],
      new Set([eventGroupKey(a)]),
      new Map(),
      [eventGroupKey(a)],
    ),
  ).toEqual([]);
});
it("配置修改状态忽略名称、图标、顺序，保留类型和阵营的区别", () => {
  const skill = eventSkill(event(1, "a"));
  expect(
    sameProfileSkills(
      [skill],
      [{ ...skill, name: "Aura Mastery", icon: "new.jpg" }],
    ),
  ).toBe(true);
  expect(sameProfileSkills([skill], [{ ...skill, eventType: "Buffs" }])).toBe(
    false,
  );
  expect(validatedProfileName("  团队减伤  ")).toBe("团队减伤");
  expect(() => validatedProfileName(" ")).toThrow("请输入");
});
it("只有部分事件被选择时才提示整项技能保存", () => {
  const a = event(1, "a"),
    b = event(1, "b");
  expect(
    hasPartialProfileSelection(
      [a, b],
      new Set(),
      new Map([["a", { groupKey: eventGroupKey(a), included: true }]]),
    ),
  ).toBe(true);
  expect(
    hasPartialProfileSelection([a, b], new Set([eventGroupKey(a)]), new Map()),
  ).toBe(false);
  expect(hasPartialProfileSelection([a, b], new Set(), new Map())).toBe(false);
});
function storage() {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
}
it("持久化恢复多个配置、缺失技能及上次选择，不设固定配置数量上限", () => {
  const disk = storage();
  const skill = eventSkill(event(1, "a"));
  const profiles = Array.from({ length: 512 }, (_, index) => ({
    id: String(index),
    name: "配置 " + index,
    skills: [skill, { ...skill, abilityId: 999999, name: "后续阶段技能" }],
  }));
  writeSkillProfiles(disk, { version: 1, profiles, activeId: "511" });
  expect(readSkillProfiles(disk)).toEqual({
    version: 1,
    profiles,
    activeId: "511",
  });
  expect(disk.getItem(skillProfilesStorageKey)).not.toContain("actor");
});
it("删除技能匹配所有角色的行，同时区分事件类型、阵营和技能 ID", () => {
  const skill = eventSkill(event(1, "a"));
  expect(groupMatchesProfileSkill(eventGroupKey(event(2, "b")), skill)).toBe(
    true,
  );
  expect(
    groupMatchesProfileSkill(eventGroupKey(event(2, "b", "Buffs")), skill),
  ).toBe(false);
  expect(
    groupMatchesProfileSkill(
      eventGroupKey(event(2, "b", "Casts", "enemy")),
      skill,
    ),
  ).toBe(false);
  expect(groupMatchesProfileSkill("Casts:friendly:2:62618", skill)).toBe(false);
});
it("损坏数据先保留备份，写入失败不会破坏原文件，过期的激活项不会残留", () => {
  const disk = storage();
  disk.setItem(skillProfilesStorageKey, "invalid json");
  expect(() => readSkillProfiles(disk)).toThrow();
  expect(() =>
    writeSkillProfiles(
      {
        ...disk,
        setItem: () => {
          throw new Error("full");
        },
      },
      { version: 1, profiles: [] },
    ),
  ).toThrow("full");
  expect(disk.getItem(skillProfilesStorageKey)).toBe("invalid json");
  writeSkillProfiles(disk, { version: 1, profiles: [], activeId: "deleted" });
  expect(disk.getItem(skillProfilesStorageKey + ".backup")).toBe(
    "invalid json",
  );
  expect(readSkillProfiles(disk).activeId).toBeUndefined();
});
