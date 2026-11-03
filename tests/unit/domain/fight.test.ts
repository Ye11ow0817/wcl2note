import { expect, it } from "vitest";
import {
  fightDifficulty,
  fightGroups,
  fightProgress,
  fightResultNumbers,
  fightSummary,
} from "../../../src/domain/fight";
import type { Fight } from "../../../src/domain/model";

const fight: Fight = {
  id: 1,
  name: "测试首领",
  encounterID: 99,
  difficulty: 5,
  kill: true,
  startTime: 1000,
  endTime: 181000,
};

it("战斗按首领 ID 和难度分组，同首领改名不拆组，同名不同首领不合并", () => {
  const groups = fightGroups([
    { ...fight, id: 4, encounterID: 100, startTime: 4000 },
    { ...fight, id: 3, difficulty: 4, startTime: 3000 },
    { ...fight, id: 2, name: "首领别名", startTime: 2000 },
    fight,
  ]);
  expect(groups.map((group) => group.fights.map((item) => item.id))).toEqual([
    [1, 2],
    [3],
    [4],
  ]);
  expect(groups.map((group) => group.name)).toEqual([
    "测试首领 · 史诗",
    "测试首领 · 英雄",
    "测试首领 · 史诗",
  ]);
});

it("小怪按名称区分，大秘境不同层数分别分组", () => {
  const groups = fightGroups([
    { ...fight, id: 1, encounterID: 0, name: "小怪甲" },
    { ...fight, id: 2, encounterID: 0, name: "小怪乙" },
    { ...fight, id: 3, difficulty: 10, keystoneLevel: 10 },
    { ...fight, id: 4, difficulty: 10, keystoneLevel: 12 },
  ]);
  expect(groups).toHaveLength(4);
  expect(groups.map((group) => group.name)).toEqual([
    "测试首领 · 大秘境 +10",
    "测试首领 · 大秘境 +12",
    "小怪甲 · 史诗",
    "小怪乙 · 史诗",
  ]);
  expect(fightDifficulty(groups[0].fights[0])).toBe("大秘境 +10");
  expect(fightDifficulty({ ...fight, difficulty: 27 })).toBe("难度 27");
});

it("团本和大秘境优先，小怪统一后置，各类保留原始时间顺序且不改变输入", () => {
  const fights: Fight[] = [
    { ...fight, id: 1, encounterID: 0, name: "小怪甲", startTime: 1000 },
    { ...fight, id: 5, difficulty: 4, startTime: 5000 },
    {
      ...fight,
      id: 3,
      encounterID: undefined,
      name: "小怪乙",
      startTime: 3000,
    },
    {
      ...fight,
      id: 4,
      encounterID: 0,
      difficulty: 10,
      keystoneLevel: 12,
      startTime: 4000,
    },
    { ...fight, id: 2, startTime: 2000 },
    { ...fight, id: 6, startTime: 6000 },
  ];
  expect(
    fightGroups(fights).map((group) => group.fights.map((item) => item.id)),
  ).toEqual([[2, 6], [4], [5], [1], [3]]);
  expect(fights.map((item) => item.id)).toEqual([1, 5, 3, 4, 2, 6]);
});

it("WCL 首领血量和整体遭遇进度分别使用原始字段，转阶段可标记 I", () => {
  expect(
    fightProgress({
      ...fight,
      bossPercentage: 75,
      fightPercentage: 40,
      lastPhase: 2,
    }),
  ).toEqual({
    remaining: 75,
    percent: "75%",
    phase: "P2",
    completed: 60,
  });
  expect(
    fightProgress({
      ...fight,
      bossPercentage: 8.44,
      lastPhase: 1,
      lastPhaseIsIntermission: true,
    }),
  ).toEqual({
    remaining: 8.44,
    percent: "8.4%",
    phase: "I1",
    completed: 91.56,
  });
});

it.each([undefined, null, NaN, -1, 101])(
  "缺失或异常血量 %s 不生成虚假的百分比和进度",
  (bossPercentage) => {
    expect(fightProgress({ ...fight, bossPercentage, lastPhase: 0 })).toEqual({
      remaining: undefined,
      percent: undefined,
      phase: undefined,
      completed: undefined,
    });
  },
);

it.each([
  { changes: {}, name: "测试首领 Kill (03:00)", result: "kill" },
  { changes: { kill: false }, name: "测试首领 Wipe (03:00)", result: "wipe" },
  {
    changes: { kill: undefined },
    name: "测试首领 Wipe (03:00)",
    result: "neutral",
  },
  {
    changes: { encounterID: 0, kill: false },
    name: "测试首领 (03:00)",
    result: "neutral",
  },
  {
    changes: { encounterID: undefined, kill: false },
    name: "测试首领 (03:00)",
    result: "neutral",
  },
  {
    changes: { difficulty: 10, kill: false },
    name: "测试首领 (03:00)",
    result: "neutral",
  },
  {
    changes: { difficulty: 10, keystoneLevel: 15, keystoneTime: 125000 },
    name: "测试首领+15 (02:05)",
    result: "kill",
  },
  {
    changes: { difficulty: 10, keystoneLevel: 15, kill: false },
    name: "测试首领+15 (03:00)",
    result: "wipe",
  },
  {
    changes: { keystoneLevel: 15, keystoneTime: 0 },
    name: "测试首领+15 (00:00)",
    result: "kill",
  },
  {
    changes: { keystoneLevel: 0 },
    name: "测试首领 Kill (03:00)",
    result: "kill",
  },
])("名称和结果颜色遵循原版：$name / $result", ({ changes, name, result }) => {
  expect(fightSummary({ ...fight, ...changes }, 0)).toMatchObject({
    displayName: name,
    result,
  });
});

it.each([
  [0, 0, "12:00 凌晨"],
  [5, 59, "05:59 凌晨"],
  [6, 0, "06:00 上午"],
  [11, 59, "11:59 上午"],
  [12, 0, "12:00 下午"],
  [17, 59, "05:59 下午"],
  [18, 0, "06:00 晚上"],
  [23, 59, "11:59 晚上"],
] as const)(
  "开始时间使用本机时区和原版十二小时分段：%i:%i",
  (hour, minute, expected) => {
    const absoluteTime = new Date(2026, 9, 21, hour, minute).getTime();
    const summary = fightSummary(fight, absoluteTime - fight.startTime);
    expect(summary.startTimeText).toBe(expected);
    expect(summary.startTimeIso).toBe(new Date(absoluteTime).toISOString());
  },
);

it("战斗开始时间叠加报告偏移后跨越午夜", () => {
  const reportStart = new Date(2026, 9, 20, 23, 59).getTime();
  const summary = fightSummary(
    { ...fight, startTime: 180000, endTime: 360000 },
    reportStart,
  );
  expect(summary.startTimeText).toBe("12:02 凌晨");
  expect(summary.startTimeIso).toBe(new Date(2026, 9, 21, 0, 2).toISOString());
});

it("同一首领的 Kill 和 Wipe 分别计数，击杀不重置灭团编号", () => {
  const fights = [false, false, true, false, true].map((kill, index) => ({
    ...fight,
    id: index * 3 + 2,
    startTime: index * 200000,
    kill,
  }));
  const numbers = fightResultNumbers(fights);
  expect(fights.map((f) => numbers.get(f.id))).toEqual([1, 2, 1, 3, 2]);
});

it("按首领 ID 和难度分别计数，名称相同的不同首领不混在一起", () => {
  const fights = [
    { encounterID: 99, difficulty: 5 },
    { encounterID: 100, difficulty: 5 },
    { encounterID: 99, difficulty: 4 },
    { encounterID: 99, difficulty: 5, name: "同一首领的另一个名称" },
    { encounterID: 100, difficulty: 5 },
    { encounterID: 99, difficulty: 4 },
  ].map((changes, index) => ({
    ...fight,
    ...changes,
    id: index + 1,
    startTime: index * 200000,
    kill: false,
  }));
  const numbers = fightResultNumbers(fights);
  expect(fights.map((f) => numbers.get(f.id))).toEqual([1, 1, 1, 2, 2, 2]);
});

it("小怪、普通地下城、大秘境和未知结果不占用团本编号", () => {
  const fights = [
    {},
    { encounterID: 0 },
    { encounterID: undefined },
    { difficulty: 10 },
    { keystoneLevel: 15 },
    { kill: undefined },
    {},
  ].map((changes, index) => ({
    ...fight,
    kill: false,
    ...changes,
    id: index + 1,
    startTime: index * 200000,
  }));
  expect([...fightResultNumbers(fights)]).toEqual([
    [1, 1],
    [7, 2],
  ]);
});

it("编号按开始时间计算，不改变 API 返回顺序或对象", () => {
  const fights = Object.freeze(
    [
      { id: 25, startTime: 3000 },
      { id: 10, startTime: 1000 },
      { id: 2, startTime: 1000 },
    ].map((changes) => Object.freeze({ ...fight, ...changes })),
  );
  const numbers = fightResultNumbers(fights);
  expect(fights.map((f) => numbers.get(f.id))).toEqual([3, 2, 1]);
  expect(fights.map((f) => f.id)).toEqual([25, 10, 2]);
});

it("新报告从 1 重新编号，重复加载和报告追加不会累加旧状态", () => {
  const first = { ...fight, kill: false };
  const second = { ...first, id: 2, startTime: 200000 };
  expect([...fightResultNumbers([first, second])]).toEqual([
    [1, 1],
    [2, 2],
  ]);
  expect(fightResultNumbers([first, second]).get(2)).toBe(2);
  expect(fightResultNumbers([second]).get(2)).toBe(1);
  expect(fightResultNumbers([first, second, { ...second, id: 3 }]).get(3)).toBe(
    3,
  );
  expect(fightResultNumbers([]).size).toBe(0);
});

it.each([
  { kill: true, number: 2, name: "测试首领 Kill 2 (03:00)" },
  { kill: false, number: 13, name: "测试首领 Wipe 13 (03:00)" },
])("在结果后显示报告内编号：$name", ({ kill, number, name }) => {
  expect(fightSummary({ ...fight, kill }, 0, number).displayName).toBe(name);
});
