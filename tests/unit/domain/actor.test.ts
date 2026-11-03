import { describe, expect, it } from "vitest";
import {
  actorCatalog,
  groupEvents,
  mapEvents,
  sourceTree,
  visibleGroups,
} from "../../../src/domain/group";
import { segments } from "../../../src/domain/report";
import type { Actor, Report, SourceNode } from "../../../src/domain/model";
import { enemies, friendlies, report } from "../../fixtures/report";

const fight = report.fights![0];
const full = segments(fight, report)[0];
const groups = groupEvents(
  [
    ...mapEvents(enemies, "Casts", report, fight, "enemy"),
    ...mapEvents(friendlies, "Casts", report, fight, "friendly"),
  ],
  full,
  fight,
);
const flatten = (nodes: SourceNode[]): SourceNode[] =>
  nodes.flatMap((n) => [n, ...flatten(n.children)]);

describe("WCL actor 目录", () => {
  it("从详细战斗响应读取参与者，即使报告列表只有战斗基本信息", () => {
    const summary = {
      id: 1,
      name: fight.name,
      startTime: fight.startTime,
      endTime: fight.endTime,
    };
    expect(actorCatalog(report, summary)).toHaveLength(6);
    expect(sourceTree([], report, summary, "friendly")[0]).toMatchObject({
      name: "玩家法师",
      className: "mage",
      children: [{ name: "水元素" }],
    });
  });
  it("没有当前事件时仍保留整场目录与稳定 key", () => {
    expect(sourceTree([], report, fight, "friendly")).toEqual(
      sourceTree(groups, report, fight, "friendly"),
    );
  });
  it("玩家按职业英文名再按文本姓名排序，NPC 排在玩家后面", () => {
    const actors: Actor[] = [
      { id: 1, name: "三斤", type: "Player", subType: "Warrior" },
      { id: 2, name: "八福", type: "Player", subType: "Warrior" },
      { id: 3, name: "法师", type: "Player", subType: "Mage" },
      { id: 4, name: "死骑", type: "Player", subType: "Death Knight" },
      { id: 5, name: "恶魔猎手", type: "Player", subType: "DemonHunter" },
      { id: 6, name: "AAA", type: "NPC" },
    ];
    const context: Report = {
      startTime: 0,
      masterData: { actors, abilities: [] },
    };
    const selectedFight = {
      ...fight,
      friendlyPlayers: [2, 3, 1, 5, 4],
      friendlyPets: [],
      friendlyNPCs: [{ id: 6 }],
    };
    expect(
      sourceTree([], context, selectedFight, "friendly").map((n) => n.actorId),
    ).toEqual([4, 5, 3, 1, 2, 6]);
  });
  it("同名不同 report actor 独立，实例 ID 不因重名而重新编号", () => {
    const nodes = sourceTree(groups, report, fight, "enemy");
    expect(nodes).toHaveLength(2);
    expect(nodes.map((n) => n.actorId)).toEqual([10, 11]);
    expect(nodes[0].children.map((n) => n.instance)).toEqual([1, 2]);
    expect(nodes[0].children[1].matches).toEqual(["enemy:10:2"]);
    expect(
      visibleGroups(
        groups,
        "enemy",
        nodes[0].children[1],
        report,
        fight,
      )[0].events.map((e) => e.timestamp),
    ).toEqual([66000]);
    expect(
      visibleGroups(groups, "enemy", nodes[1], report, fight)[0].actor.id,
    ).toBe(11);
  });
  it("敌对首领优先，随后按 NPC 名字的文本顺序排序", () => {
    const actors = [
      { id: 1, name: "幽蔽毒液", type: "NPC", subType: "NPC" },
      { id: 2, name: "燃烧剧毒", type: "NPC", subType: "NPC" },
      { id: 3, name: "瓦什尼克", type: "NPC", subType: "Boss" },
    ];
    const context = { startTime: 0, masterData: { actors, abilities: [] } };
    expect(
      sourceTree(
        [],
        context,
        { ...fight, enemyNPCs: [{ id: 2 }, { id: 1 }, { id: 3 }] },
        "enemy",
      ).map((n) => n.actorId),
    ).toEqual([3, 1, 2]);
  });
  it("目录外稀疏实例按真实 ID 数值排序", () => {
    const sparse = groups
      .filter((g) => g.actor.id === 10)
      .map((g, i) => ({
        ...g,
        instance: [12, 3][i],
        sourceKey: `enemy:10:${[12, 3][i]}`,
      }));
    const context = { ...report, fights: [] };
    const nodes = sourceTree(
      sparse,
      context,
      { ...fight, enemyNPCs: [] },
      "enemy",
    );
    expect(nodes[0].children.map((n) => [n.name, n.matches])).toEqual([
      ["首领 #3", ["enemy:10:3"]],
      ["首领 #12", ["enemy:10:12"]],
    ]);
  });
  it("NPC ID 来自 gameID，报告 actor ID 单独保留", () => {
    const context = {
      ...report,
      masterData: {
        ...report.masterData!,
        actors: report.masterData!.actors.map((a) =>
          a.id === 10 ? { ...a, gameID: 900100 } : a,
        ),
      },
    };
    expect(sourceTree([], context, fight, "enemy")[0]).toMatchObject({
      actorId: 10,
      gameID: 900100,
    });
    const withoutMasterId = {
      ...fight,
      enemyNPCs: [{ id: 10, gameID: 900100, instanceCount: 2 }],
    };
    expect(
      sourceTree([], { ...report, fights: [] }, withoutMasterId, "enemy")[0]
        .gameID,
    ).toBe(900100);
  });
  it("同名宠物分别保留主人与 actor 身份", () => {
    const context: Report = {
      ...report,
      fights: [],
      masterData: {
        ...report.masterData!,
        actors: [
          ...report.masterData!.actors,
          { id: 21, name: "第二玩家", type: "Player", subType: "Mage" },
          { id: 31, name: "水元素", type: "Pet", petOwner: 21 },
          { id: 32, name: "水元素", type: "Pet", petOwner: 20 },
        ],
      },
    };
    const selectedFight = {
      ...fight,
      friendlyPlayers: [20, 21],
      friendlyPets: [
        ...fight.friendlyPets!,
        { id: 31, petOwner: 21 },
        { id: 32, petOwner: 20 },
      ],
    };
    const nodes = sourceTree([], context, selectedFight, "friendly");
    expect(
      nodes.find((n) => n.actorId === 20)!.children.map((n) => n.actorId),
    ).toEqual([30, 32]);
    expect(
      nodes.find((n) => n.actorId === 21)!.children.map((n) => n.actorId),
    ).toEqual([31]);
  });
  it("玩家无当前事件时，选玩家不会改为筛选宠物", () => {
    const petsOnly = groups.filter((g) => g.actor.id === 30);
    const player = sourceTree(petsOnly, report, fight, "friendly")[0];
    expect(player.matches).toEqual(["friendly:20:"]);
    expect(visibleGroups(petsOnly, "friendly", player, report, fight)).toEqual(
      [],
    );
  });
  it("没有主人自身事件时，仍可单独选择宠物实例", () => {
    const nodes = sourceTree(
      groups.filter((g) => g.actor.id === 30),
      report,
      fight,
      "friendly",
    );
    const instance = flatten(nodes).find(
      (n) => n.actorId === 30 && n.instance === 2,
    )!;
    expect(instance.name).toBe("水元素 #2");
    expect(
      visibleGroups(groups, "friendly", instance, report, fight)[0].events.map(
        (e) => e.timestamp,
      ),
    ).toEqual([78000]);
  });
});
