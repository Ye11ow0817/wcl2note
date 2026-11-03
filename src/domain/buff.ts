import classifications from "./data/buff-categories.json";

export const buffCategories = [
  { id: 128, name: "团队大招", wclName: "Major Group Cooldown" },
  { id: 256, name: "个人大招", wclName: "Major Individual Cooldown" },
  { id: 1, name: "伤害增益", wclName: "Damage Buffs" },
  { id: 4, name: "防御增益", wclName: "Defensive Buffs" },
  { id: 2, name: "治疗增益", wclName: "Healing Buffs" },
  { id: 8, name: "移动增益", wclName: "Movement Buffs" },
  { id: 16, name: "团队增益", wclName: "Raid Buffs" },
  { id: 64, name: "姿态、形态与圣印", wclName: "Stances, Forms and Seals" },
  { id: 32, name: "玩具增益", wclName: "Toy Buffs" },
  { id: 512, name: "其他", wclName: null },
] as const;

export type BuffCategory = (typeof buffCategories)[number];
const masks: Readonly<Record<number, number>> = classifications;

export function buffCategoryMask(spellId: number): number {
  return masks[spellId] || 512;
}

export function groupBuffRows<T extends { ability: { gameID: number } }>(
  rows: T[],
): { category: BuffCategory; rows: T[] }[] {
  const sections = buffCategories.map((category) => ({
    category,
    rows: [] as T[],
  }));
  for (const row of rows) {
    const mask = buffCategoryMask(row.ability.gameID);
    for (const section of sections)
      if (mask & section.category.id) section.rows.push(row);
  }
  return sections.filter((section) => section.rows.length > 0);
}
