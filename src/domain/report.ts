import type { Fight, Report, Segment } from "./model";
export interface ReportRef {
  code: string;
  fight?: number;
  last: boolean;
  pull?: number;
  phase?: number;
}
export function parseReport(input: string): ReportRef {
  const text = input.trim();
  if (!text) throw Error("请输入 Warcraft Logs 报告链接。");
  if (/^[a-zA-Z0-9]+$/.test(text)) return { code: text, last: false };
  let url: URL;
  try {
    url = new URL(
      /^[a-z][a-z\d+.-]*:/i.test(text)
        ? text
        : `https://${text.replace(/^\/\//, "")}`,
    );
  } catch {
    throw Error("输入的内容不是有效的 Warcraft Logs 报告链接。");
  }
  const parts = url.pathname.split("/").filter(Boolean),
    index = parts.findIndex((x) => x.toLowerCase() === "reports");
  const code = parts[index + 1];
  if (index < 0 || !code)
    throw Error("链接中没有找到 Warcraft Logs 报告代码。");
  if (!/^[a-zA-Z0-9]+$/.test(code)) throw Error("Warcraft Logs 报告代码无效。");
  function param(name: string) {
    for (const str of [url.search, url.hash])
      for (const item of str.replace(/^[?#]+/, "").split("&")) {
        const i = item.indexOf("=");
        if (i < 0) continue;
        if (decodeURIComponent(item.slice(0, i)).toLowerCase() === name)
          return decodeURIComponent(item.slice(i + 1).replace(/\+/g, " "));
      }
  }
  const number = (value: string | undefined, nonnegative = false) => {
    if (value === undefined || !/^[+-]?\d+$/.test(value.trim())) return;
    const n = Number(value);
    return Number.isSafeInteger(n) &&
      (!nonnegative || (n >= 0 && n <= 2147483647))
      ? n
      : undefined;
  };
  return {
    code,
    fight: number(param("fight")),
    last: param("fight")?.toLowerCase() === "last",
    pull: number(param("pull"), true),
    phase: number(param("phase"), true),
  };
}
export function segments(fight: Fight, report: Report): Segment[] {
  const full: Segment = {
    id: "full",
    name:
      (fight.keystoneLevel ?? 0) > 0 || fight.difficulty === 10
        ? "全程"
        : "全部阶段",
    startTime: fight.startTime,
    endTime: fight.endTime,
    relative: false,
  };
  if (fight.dungeonPulls?.length)
    return [
      full,
      ...[...fight.dungeonPulls]
        .sort((a, b) => a.startTime - b.startTime)
        .map((p, i) => ({
          id: `pull-${p.id}`,
          name: p.name?.trim() ? p.name : `Pull ${i + 1}`,
          startTime: p.startTime,
          endTime: p.endTime,
          relative: true,
        })),
    ];
  const transitions = [...(fight.phaseTransitions ?? [])].sort(
    (a, b) => a.startTime - b.startTime,
  );
  const names = report.phases?.find(
    (p) => p.encounterID === fight.encounterID,
  )?.phases;
  const occurrences = new Map<number, number>();
  return [
    full,
    ...transitions.map((p, i) => {
      const occurrence = (occurrences.get(p.id) ?? 0) + 1;
      occurrences.set(p.id, occurrence);
      const name = names?.find((n) => n.id === p.id)?.name ?? `阶段 ${p.id}`;
      return {
        id: `phase-${p.id}${occurrence > 1 ? `-${occurrence}` : ""}`,
        name: `${name}${occurrence > 1 ? `（第 ${occurrence} 次）` : ""}`,
        startTime: p.startTime,
        endTime: transitions[i + 1]?.startTime ?? fight.endTime,
        relative: false,
      };
    }),
  ];
}
export function initialSegment(items: Segment[], ref: ReportRef) {
  const prefix = ref.pull !== undefined ? "pull-" : "phase-",
    id = ref.pull ?? ref.phase;
  const matches = items.filter((x) => x.id.startsWith(prefix));
  return (
    items.find((x) => x.id === `${prefix}${id}`) ??
    (id && id > 0 ? matches[id - 1] : undefined) ??
    items[0]
  );
}
export function filename(name: string) {
  return (
    Array.from(name, (ch) =>
      ch.charCodeAt(0) < 32 || '<>:"/\\|?*'.includes(ch) ? "_" : ch,
    )
      .join("")
      .trim() || "wcl2note.txt"
  );
}
