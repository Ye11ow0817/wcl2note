import { expect, it, vi } from "vitest";
import { applyPlayerSpecs } from "../../../src/renderer/api/wcl/playerDetails";
import { query } from "../../../src/renderer/api/wcl/client";
import { sourceTree } from "../../../src/domain/group";
import { report } from "../../fixtures/report";

it("读取真实 playerDetails 的 data/playerDetails/角色桶结构，图标随战斗专精变化且保持 actor 身份", async () => {
  let spec = "Frost";
  vi.stubGlobal("window", {
    wcl2note: {
      cancel: vi.fn(),
      query: async () => ({
        ok: true,
        data: {
          report: {
            ...report,
            playerDetails: {
              data: {
                playerDetails: {
                  dps: [
                    {
                      id: 20,
                      icon: `Mage-${spec}`,
                      specs: [{ spec, count: 1 }],
                    },
                  ],
                  tanks: [],
                  healers: [],
                },
              },
            },
          },
        },
      }),
    },
  });
  try {
    const payload = {
      operation: "fightContext" as const,
      variables: { reportCode: "abc", fightId: 1 },
    };
    const frost = await query(payload, new AbortController().signal);
    const node = sourceTree([], frost, report.fights![0], "friendly")[0];
    expect(node).toMatchObject({
      actorId: 20,
      className: "mage",
      spec: "Frost",
      specIcon: "Mage-Frost.jpg",
      matches: ["friendly:20:"],
    });
    spec = "Arcane";
    const arcane = await query(payload, new AbortController().signal);
    expect(
      sourceTree([], arcane, report.fights![0], "friendly")[0],
    ).toMatchObject({ actorId: 20, specIcon: "Mage-Arcane.jpg" });
    expect(
      report.masterData!.actors.find((a) => a.id === 20),
    ).not.toHaveProperty("specIcon");
  } finally {
    vi.unstubAllGlobals();
  }
});

it("只按 actor ID 匹配玩家，不按姓名猜测，不把玩家专精传给宠物", () => {
  const context = applyPlayerSpecs({
    ...report,
    playerDetails: {
      data: {
        playerDetails: {
          dps: [
            { id: 20, name: "其他姓名", specs: [{ spec: "Frost" }] },
            { id: 30, icon: "Mage-Frost" },
          ],
        },
      },
    },
  });
  const nodes = sourceTree([], context, report.fights![0], "friendly");
  expect(nodes[0].specIcon).toBe("Mage-Frost.jpg");
  expect(nodes[0].children[0].specIcon).toBeUndefined();
});

it("缺失、歧义或异常专精回退职业，不接受跨职业或 URL/路径形式的图标", () => {
  for (const playerDetails of [
    undefined,
    null,
    "error",
    { data: [] },
    { dps: [null, { id: "20" }] },
    { dps: [{ id: 20, icon: "https://evil/Mage-Frost.jpg" }] },
    { dps: [{ id: 20, icon: "Priest-Holy" }] },
    { dps: [{ id: 20, specs: [{ spec: "Frost" }, { spec: "Fire" }] }] },
    {
      dps: [
        { id: 20, icon: "Mage-../Frost", specs: [{ spec: "../../Frost" }] },
      ],
    },
  ]) {
    expect(
      applyPlayerSpecs({ ...report, playerDetails }).masterData!.actors.find(
        (a) => a.id === 20,
      )?.specIcon,
    ).toBeUndefined();
  }
});
