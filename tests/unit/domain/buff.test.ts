import { describe, expect, it } from "vitest";
import {
  buffCategories,
  buffCategoryMask,
  groupBuffRows,
} from "../../../src/domain/buff";

describe("WCL Buff 分类", () => {
  it("按法术 ID 保留网页确认的多个分类", () => {
    expect(buffCategoryMask(80353)).toBe(128 | 1 | 32);
    expect(buffCategoryMask(97463)).toBe(128 | 4);
    expect(buffCategoryMask(31821)).toBe(128 | 4);
  });

  it("未收录法术及 WCL 未分类法术都归入其他", () => {
    expect(buffCategoryMask(1999999999)).toBe(512);
    expect(buffCategoryMask(1284616)).toBe(512);
  });

  it("按 WCL 顺序分组，复用同一行数据并保留组内排序", () => {
    const first = { ability: { gameID: 80353 }, keys: ["time-warp"] };
    const second = { ability: { gameID: 97463 }, keys: ["rallying-cry"] };
    const other = { ability: { gameID: 1999999999 }, keys: ["unknown"] };
    const rows = [second, first, other];
    const sections = groupBuffRows(rows);
    expect(sections.map((section) => section.category.id)).toEqual([
      128, 1, 4, 32, 512,
    ]);
    expect(sections[0].rows).toEqual([second, first]);
    expect(sections[0].rows[1]).toBe(first);
    expect(sections[1].rows[0]).toBe(first);
    expect(sections.at(-1)?.rows).toEqual([other]);
    expect(rows).toEqual([second, first, other]);
    expect(new Set(buffCategories.map((category) => category.id)).size).toBe(
      10,
    );
    expect(groupBuffRows([])).toEqual([]);
  });
});
