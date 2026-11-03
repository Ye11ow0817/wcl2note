import type { Report, RawEvent } from "../../src/domain/model";
export const code = "AbCd1234";
export const report: Report = {
  startTime: 1700000000000,
  fights: [
    {
      id: 1,
      name: "测试首领",
      encounterID: 99,
      difficulty: 5,
      kill: true,
      startTime: 1000,
      endTime: 121000,
      phaseTransitions: [
        { id: 1, startTime: 1000 },
        { id: 2, startTime: 61000 },
      ],
      friendlyPlayers: [20],
      friendlyPets: [{ id: 30, instanceCount: 2, petOwner: 20 }],
      enemyNPCs: [
        { id: 10, instanceCount: 2 },
        { id: 11, instanceCount: 1 },
      ],
    },
  ],
  phases: [
    {
      encounterID: 99,
      phases: [
        { id: 1, name: "第一阶段" },
        { id: 2, name: "第二阶段" },
      ],
    },
  ],
  masterData: {
    actors: [
      { id: 10, gameID: 900100, name: "首领", type: "NPC" },
      { id: 11, gameID: 900101, name: "首领", type: "NPC" },
      { id: 20, name: "玩家法师", type: "Player", subType: "Mage" },
      { id: 30, gameID: 510, name: "水元素", type: "Pet", petOwner: 20 },
    ],
    abilities: [
      { gameID: 100, name: "裂解" },
      { gameID: 200, name: "时间扭曲" },
      { gameID: 300, name: "水箭" },
    ],
  },
};
export const enemies: RawEvent[] = [
  {
    type: "cast",
    timestamp: 36000,
    abilityGameID: 100,
    sourceID: 10,
    sourceInstance: 1,
  },
  {
    type: "cast",
    timestamp: 66000,
    abilityGameID: 100,
    sourceID: 10,
    sourceInstance: 2,
  },
  {
    type: "cast",
    timestamp: 96000,
    abilityGameID: 100,
    sourceID: 11,
    sourceInstance: 1,
  },
];
export const friendlies: RawEvent[] = [
  { type: "cast", timestamp: 18000, abilityGameID: 200, sourceID: 20 },
  {
    type: "cast",
    timestamp: 25000,
    abilityGameID: 300,
    sourceID: 30,
    sourceInstance: 1,
  },
  {
    type: "cast",
    timestamp: 78000,
    abilityGameID: 300,
    sourceID: 30,
    sourceInstance: 2,
  },
];
