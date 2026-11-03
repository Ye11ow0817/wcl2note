import { duration, type Fight } from "./model";

const difficulties: Record<number, string> = {
  1: "随机",
  2: "弹性",
  3: "普通",
  4: "英雄",
  5: "史诗",
  10: "地下城",
};

export function fightDifficulty(fight: Fight) {
  if ((fight.keystoneLevel ?? 0) > 0) return `大秘境 +${fight.keystoneLevel}`;
  return fight.difficulty == null
    ? ""
    : (difficulties[fight.difficulty] ?? `难度 ${fight.difficulty}`);
}

export function fightGroupKey(fight: Fight) {
  const encounter =
    (fight.encounterID ?? 0) > 0 ? fight.encounterID : `name:${fight.name}`;
  return `${encounter}:${fight.difficulty ?? ""}:${fight.keystoneLevel ?? 0}`;
}

export function isTrashFight(fight: Fight) {
  return (fight.encounterID ?? 0) <= 0 && (fight.keystoneLevel ?? 0) <= 0;
}

export function fightGroups(fights: readonly Fight[]) {
  const groups = new Map<
    string,
    { key: string; name: string; fights: Fight[] }
  >();
  for (const fight of [...fights].sort(
    (a, b) => a.startTime - b.startTime || a.id - b.id,
  )) {
    const key = fightGroupKey(fight);
    let group = groups.get(key);
    if (!group) {
      const difficulty = fightDifficulty(fight);
      group = {
        key,
        name: `${fight.name}${difficulty ? ` · ${difficulty}` : ""}`,
        fights: [],
      };
      groups.set(key, group);
    }
    group.fights.push(fight);
  }
  return [...groups.values()].sort(
    (a, b) =>
      Number(isTrashFight(a.fights[0])) - Number(isTrashFight(b.fights[0])),
  );
}

export function fightProgress(fight: Fight) {
  const percent = (value: number | null | undefined) =>
    value != null && Number.isFinite(value) && value >= 0 && value <= 100
      ? value
      : undefined;
  const remaining = percent(fight.bossPercentage);
  const overall = percent(fight.fightPercentage) ?? remaining;
  const phase =
    fight.lastPhase != null && fight.lastPhase > 0
      ? `${fight.lastPhaseIsIntermission ? "I" : "P"}${fight.lastPhase}`
      : undefined;
  return {
    remaining,
    percent: remaining == null ? undefined : `${Number(remaining.toFixed(1))}%`,
    phase,
    completed: overall == null ? undefined : 100 - overall,
  };
}

// WCL numbers kills and wipes separately for each encounter and difficulty.
export function fightResultNumbers(fights: readonly Fight[]) {
  const counts = new Map<string, number>();
  const numbers = new Map<number, number>();
  for (const fight of [...fights].sort(
    (a, b) => a.startTime - b.startTime || a.id - b.id,
  )) {
    if (
      (fight.encounterID ?? 0) <= 0 ||
      fight.difficulty === 10 ||
      (fight.keystoneLevel ?? 0) > 0 ||
      typeof fight.kill !== "boolean"
    )
      continue;
    const key = `${fight.encounterID}:${fight.difficulty ?? 0}:${fight.kill}`;
    const number = (counts.get(key) ?? 0) + 1;
    counts.set(key, number);
    numbers.set(fight.id, number);
  }
  return numbers;
}

// Keeps the original app's names and local time, adding the report result number.
export function fightSummary(
  fight: Fight,
  reportStartTime: number,
  resultNumber?: number,
) {
  const hasFightResult =
    (fight.keystoneLevel ?? 0) > 0 ||
    ((fight.encounterID ?? 0) > 0 && fight.difficulty !== 10);
  const displayName =
    (fight.keystoneLevel ?? 0) > 0
      ? `${fight.name}+${fight.keystoneLevel} (${duration(fight.keystoneTime ?? fight.endTime - fight.startTime)})`
      : `${fight.name}${hasFightResult ? ` ${fight.kill === true ? "Kill" : "Wipe"}${resultNumber === undefined ? "" : ` ${resultNumber}`}` : ""} (${duration(fight.endTime - fight.startTime)})`;
  const startTime = new Date(reportStartTime + fight.startTime);
  const hour = startTime.getHours();
  const period =
    hour < 6 ? "凌晨" : hour < 12 ? "上午" : hour < 18 ? "下午" : "晚上";
  const startTimeText = `${String(hour % 12 || 12).padStart(2, "0")}:${String(startTime.getMinutes()).padStart(2, "0")} ${period}`;
  const result: "kill" | "wipe" | "neutral" =
    hasFightResult && fight.kill === true
      ? "kill"
      : hasFightResult && fight.kill === false
        ? "wipe"
        : "neutral";
  return {
    displayName,
    startTimeText,
    startTimeIso: startTime.toISOString(),
    result,
  };
}
