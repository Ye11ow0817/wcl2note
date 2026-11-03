import type { Query } from "../../../shared/contract";
import type {
  EventType,
  Fight,
  RawEvent,
  Report,
  Side,
  TimelineEvent,
} from "../../../domain/model";
import { mapEvents } from "../../../domain/group";
import { reportSchema } from "./dto";
import { applyPlayerSpecs } from "./playerDetails";
import type {
  Credentials,
  Reply,
  SettingsSnapshot,
} from "../../../shared/desktop";
export class RequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
    readonly retryAfter: number = 0,
  ) {
    super(message);
  }
}
export function desktop() {
  if (!window.wcl2note)
    throw new RequestError("请在 WCL2NOTE 桌面应用中打开。", 400, "DESKTOP");
  return window.wcl2note;
}
export function unwrap<T>(reply: Reply<T>): T {
  if (!reply.ok)
    throw new RequestError(
      reply.error.message,
      reply.error.status,
      reply.error.code,
      reply.error.retryAfter,
    );
  return reply.data;
}
export async function loadSettings(): Promise<SettingsSnapshot> {
  return unwrap(await desktop().getSettings());
}
export async function saveSettings(
  settings: Credentials,
): Promise<SettingsSnapshot> {
  return unwrap(await desktop().saveSettings(settings));
}
export async function query(
  payload: Query,
  signal: AbortSignal,
): Promise<Report> {
  signal.throwIfAborted();
  const bridge = desktop();
  const id = crypto.randomUUID();
  const cancel = () => bridge.cancel(id);
  signal.addEventListener("abort", cancel, { once: true });
  let data;
  try {
    const result = await bridge.query(id, payload);
    signal.throwIfAborted();
    data = unwrap(result);
  } finally {
    signal.removeEventListener("abort", cancel);
  }
  const parsed = reportSchema.safeParse(data.report);
  if (!parsed.success)
    throw new RequestError(
      "Warcraft Logs 响应格式异常，已停止加载。",
      502,
      "REPORT",
    );
  const report = parsed.data;
  if (
    payload.operation !== "fightAbilityEvents" &&
    !Array.isArray(report.fights)
  )
    throw new RequestError("响应缺少战斗列表。", 502, "REPORT");
  if (payload.operation === "fightContext" && !report.masterData)
    throw new RequestError("响应缺少参与者目录。", 502, "REPORT");
  if (
    payload.operation === "fightSegments" &&
    !report.fights?.some((f) => f.id === payload.variables.fightId)
  )
    throw new RequestError("报告中不存在此战斗。", 404, "REPORT");
  if (report.fights)
    report.fights = report.fights.map((f) => ({
      ...f,
      name: f.name ?? `战斗 ${f.id}`,
    }));
  if (report.masterData) {
    report.masterData.actors = report.masterData.actors.map((a) => ({
      ...a,
      name: a.name ?? `未知角色 ${a.id}`,
    }));
    report.masterData.abilities = report.masterData.abilities.map((a) => ({
      ...a,
      name: a.name ?? `未知技能 ${a.gameID}`,
    }));
  }
  return applyPlayerSpecs(report as unknown as Report);
}
export async function allEvents(
  code: string,
  fight: Fight,
  context: Report,
  type: EventType,
  side: Side,
  signal: AbortSignal,
  abilityIds?: number[],
): Promise<TimelineEvent[]> {
  const output: RawEvent[] = [];
  // Pair cast starts and finishes only after every page for this side is loaded.
  let cursor = fight.startTime,
    pages = 0;
  while (cursor <= fight.endTime) {
    signal.throwIfAborted();
    if (++pages > 10000)
      throw new RequestError(
        "分页数异常，已停止加载，未导出不完整数据。",
        502,
        "PAGES",
      );
    const page = await query(
      {
        operation: "fightAbilityEvents",
        variables: {
          reportCode: code,
          fightId: fight.id,
          startTime: cursor,
          endTime: fight.endTime,
          hostilityType: side === "friendly" ? "Friendlies" : "Enemies",
          dataType: type,
          ...(abilityIds ? { abilityIds } : {}),
        },
      },
      signal,
    );
    if (!Array.isArray(page.events?.data))
      throw new RequestError(
        "Warcraft Logs 返回的事件数据不是数组。",
        502,
        "EVENTS",
      );
    output.push(...page.events.data);
    const next = page.events.nextPageTimestamp;
    if (next == null) break;
    if (!Number.isFinite(next) || next <= cursor)
      throw new RequestError(
        "Warcraft Logs 返回了无效下一页时间戳，已停止翻页。",
        502,
        "CURSOR",
      );
    cursor = next;
  }
  return mapEvents(output, type, context, fight, side).sort(
    (a, b) => a.timestamp - b.timestamp,
  );
}
