import { afterEach, expect, it, vi } from "vitest";
import { allEvents, query } from "../../../src/renderer/api/wcl/client";
import type { DesktopBridge, Reply } from "../../../src/shared/desktop";
import { report, enemies, friendlies } from "../../fixtures/report";
import { abilityRows } from "../../../src/domain/ability";
import { groupEvents } from "../../../src/domain/group";
function bridge(handler: DesktopBridge["query"]) {
  const cancel = vi.fn();
  vi.stubGlobal("window", { wcl2note: { query: handler, cancel } });
  return cancel;
}
afterEach(() => vi.unstubAllGlobals());
it("Buff 获得与移除跨分页时仍使用完整持续时间", async () => {
  bridge(async (_id, payload) => {
    if (payload.operation !== "fightAbilityEvents") throw Error();
    const first = payload.variables.startTime === 1000;
    return {
      ok: true,
      data: {
        report: {
          events: {
            data: [
              {
                type: first ? "applybuff" : "removebuff",
                timestamp: first ? 11000 : 71000,
                abilityGameID: 200,
                targetID: 20,
                sourceID: 20,
              },
            ],
            nextPageTimestamp: first ? 60000 : null,
          },
        },
      },
    };
  });
  const fight = report.fights![0];
  const events = await allEvents(
    "abc",
    fight,
    report,
    "Buffs",
    "friendly",
    new AbortController().signal,
  );
  const segment = { ...fight, id: "full", relative: false };
  expect(
    abilityRows(groupEvents(events, segment, fight, true), segment, fight)[0],
  ).toMatchObject({ count: 1, uptime: 50 });
});
it.each(["enemy", "friendly"] as const)(
  "%s 仅请求当前阵营并完成分页",
  async (side) => {
    const raw = side === "enemy" ? enemies : friendlies;
    const calls = vi.fn<DesktopBridge["query"]>(async (_id, payload) => {
      if (payload.operation !== "fightAbilityEvents") throw Error();
      const v = payload.variables;
      return {
        ok: true,
        data: {
          report: {
            events: {
              data: [raw[v.startTime === 1000 ? 0 : 2]],
              nextPageTimestamp: v.startTime === 1000 ? 60000 : null,
            },
          },
        },
      };
    });
    bridge(calls);
    const events = await allEvents(
      "abc",
      report.fights![0],
      report,
      "Casts",
      side,
      new AbortController().signal,
    );
    expect(events).toHaveLength(2);
    expect(calls).toHaveBeenCalledTimes(2);
    expect(calls.mock.calls.map(([, payload]) => payload.variables)).toEqual(
      [1000, 60000].map((startTime) => ({
        reportCode: "abc",
        fightId: 1,
        startTime,
        endTime: 121000,
        hostilityType: side === "enemy" ? "Enemies" : "Friendlies",
        dataType: "Casts",
      })),
    );
  },
);
it("重复游标报错，不能导出第一页冒充完整结果", async () => {
  bridge(async () => ({
    ok: true,
    data: { report: { events: { data: [], nextPageTimestamp: 1000 } } },
  }));
  await expect(
    allEvents(
      "abc",
      report.fights![0],
      report,
      "Casts",
      "enemy",
      new AbortController().signal,
    ),
  ).rejects.toThrow("下一页");
});
it("取消后不再发起下一页", async () => {
  const c = new AbortController();
  c.abort();
  const handler = vi.fn();
  bridge(handler);
  await expect(
    allEvents("abc", report.fights![0], report, "Casts", "enemy", c.signal),
  ).rejects.toThrow();
  expect(handler).not.toHaveBeenCalled();
});
it("加载中取消通过 preload 传到主进程，迟到结果不会使用", async () => {
  let finish!: (value: Reply<{ report: unknown }>) => void;
  const cancel = bridge(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const controller = new AbortController();
  const request = query(
    { operation: "reportFights", variables: { reportCode: "abc" } },
    controller.signal,
  );
  controller.abort();
  finish({ ok: true, data: { report } });
  await expect(request).rejects.toThrow();
  expect(cancel).toHaveBeenCalledTimes(1);
});
it("本地查询错误保留重试信息", async () => {
  bridge(async () => ({
    ok: false,
    error: {
      message: "稍后重试",
      code: "RATE",
      status: 429,
      retryAfter: 10000,
    },
  }));
  await expect(
    query(
      { operation: "reportFights", variables: { reportCode: "abc" } },
      new AbortController().signal,
    ),
  ).rejects.toMatchObject({ status: 429, retryAfter: 10000 });
});
