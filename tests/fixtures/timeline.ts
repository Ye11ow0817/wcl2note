import type { EventType, RawEvent, Report, Side } from "../../src/domain/model";

// Synthetic responses used only by Electron regression tests.
export const timelineReport: Report = {
  startTime: 1700000000000,
  fights: [
    {
      id: 1,
      name: "潮汐演练（示例）",
      encounterID: 9900,
      difficulty: 5,
      kill: true,
      startTime: 1000,
      endTime: 241000,
      friendlyPlayers: [20, 21, 22],
      enemyNPCs: [{ id: 10, instanceCount: 1 }],
      phaseTransitions: [
        { id: 1, startTime: 1000 },
        { id: 2, startTime: 121000 },
      ],
    },
  ],
  phases: [
    {
      encounterID: 9900,
      phases: [
        { id: 1, name: "第一阶段" },
        { id: 2, name: "第二阶段" },
      ],
    },
  ],
  masterData: {
    actors: [
      { id: 10, name: "潮汐守卫", type: "NPC" },
      {
        id: 20,
        name: "示例圣骑士",
        type: "Player",
        subType: "Paladin",
        spec: "Holy",
        specIcon: "Paladin-Holy.jpg",
      },
      {
        id: 21,
        name: "示例牧师",
        type: "Player",
        subType: "Priest",
        spec: "Discipline",
        specIcon: "Priest-Discipline.jpg",
      },
      {
        id: 22,
        name: "示例战士",
        type: "Player",
        subType: "Warrior",
        spec: "Protection",
        specIcon: "Warrior-Protection.jpg",
      },
    ],
    abilities: [
      { gameID: 990001, name: "潮汐冲击", type: "16" },
      { gameID: 990002, name: "深海震荡", type: "1" },
      { gameID: 31821, name: "光环掌握", type: "2" },
      { gameID: 62618, name: "真言术：障", type: "2" },
      { gameID: 871, name: "盾墙", type: "1" },
      { gameID: 82326, name: "圣光术", type: "2" },
    ],
  },
};

export function timelineEvents(type: EventType, side: Side): RawEvent[] {
  const cast = (
    seconds: number,
    abilityGameID: number,
    sourceID: number,
    targetID?: number,
  ): RawEvent => ({
    type: "cast",
    timestamp: 1000 + seconds * 1000,
    abilityGameID,
    sourceID,
    targetID,
    sourceIsFriendly: sourceID !== 10,
  });
  const read = (
    seconds: number,
    ability: number,
    source: number,
    duration: number,
  ) => [
    { ...cast(seconds - duration, ability, source), type: "begincast" },
    cast(seconds, ability, source),
  ];
  if (type === "Casts")
    return side === "enemy"
      ? [30, 70, 110, 150, 190, 230]
          .flatMap((time) => read(time, 990001, 10, 3))
          .concat([55, 175].flatMap((time) => read(time, 990002, 10, 2)))
      : [
          cast(27, 31821, 20),
          cast(147, 31821, 20),
          cast(68, 62618, 21),
          cast(188, 62618, 21),
          cast(54, 871, 22, 22),
          cast(174, 871, 22, 22),
          ...[35, 155].flatMap((time) => read(time, 82326, 20, 2)),
        ];
  if (type === "Buffs" && side === "friendly")
    return [27, 147].flatMap((seconds) => [
      {
        type: "applybuff",
        timestamp: 1000 + seconds * 1000,
        abilityGameID: 31821,
        sourceID: 20,
        targetID: 20,
      },
      {
        type: "removebuff",
        timestamp: 1000 + (seconds + 8) * 1000,
        abilityGameID: 31821,
        sourceID: 20,
        targetID: 20,
      },
    ]);
  return [];
}
