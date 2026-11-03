import type { RawEvent } from "./model";

export function castStarts(raw: RawEvent[]) {
  const pending = new Map<
    string,
    { ability: number; timestamp: number; empower: boolean }
  >();
  const starts = new Map<RawEvent, number>();
  for (const event of [...raw].sort((a, b) => a.timestamp - b.timestamp)) {
    if (
      event.fake ||
      event.sourceID == null ||
      !Number.isFinite(event.timestamp) ||
      !Number.isSafeInteger(event.abilityGameID)
    )
      continue;
    const kind = event.type?.toLowerCase();
    const caster = `${event.sourceID}:${event.sourceInstance ?? event.sourceInstanceID ?? ""}`;
    if (kind === "begincast" || kind === "empowerstart") {
      // A new cast replaces a canceled cast; targets can change before success.
      pending.set(caster, {
        ability: event.abilityGameID,
        timestamp: event.timestamp,
        empower: kind === "empowerstart",
      });
    } else if (kind === "cast" || kind === "empowerend") {
      const begin = pending.get(caster);
      if (
        begin?.ability !== event.abilityGameID ||
        begin.empower !== (kind === "empowerend")
      )
        continue;
      if (begin.timestamp < event.timestamp) starts.set(event, begin.timestamp);
      pending.delete(caster);
    }
  }
  return starts;
}

// WCL school text colors: global CSS overrides and the report's inline colors.
// https://assets.rpglogs.com/css/global.d41717acb60ce8ad.css
// https://assets.rpglogs.cn/js/report.f67b29409ec55fb5.js
const schools = [
  [1, "物理", "#e5cc80"],
  [2, "神圣", "#ffff8f"],
  [4, "火焰", "#eb4561"],
  [8, "自然", "#d1fa99"],
  [16, "冰霜", "#4a80ff"],
  [32, "暗影", "#b8a8f0"],
  [64, "奥术", "#8ff2ff"],
] as const;
const aliases = [
  "physical",
  "holy",
  "fire",
  "nature",
  "frost",
  "shadow",
  "arcane",
];
function schoolMask(type: string | number | null | undefined) {
  const named =
    typeof type === "string" ? aliases.indexOf(type.toLowerCase()) : -1;
  return named >= 0 ? 1 << named : Number(type);
}

export function spellSchool(type: string | number | null | undefined) {
  const mask = schoolMask(type);
  const parts =
    Number.isInteger(mask) && mask > 0 && mask <= 127
      ? schools.filter(([bit]) => (mask & bit) !== 0)
      : [];
  const specialColors: Record<number, string> = {
    36: "#b8a8f0",
    80: "#8ff2ff",
    106: "#8ff2ff",
    124: "#a330c9",
    125: "#a330c9",
    126: "#a330c9",
    127: "#a330c9",
    128: "#ffa34a",
    256: "#2599be",
    512: "#bfbfbf",
    1024: "#2599be",
  };
  // setLineColorForAbilityFromType uses the highest school bit for 2–5
  // schools. CSS !important rules take precedence; six-school combinations
  // without an override keep WCL's link color.
  const color =
    specialColors[mask] ??
    (parts.length > 5 ? "#46c5ff" : (parts.at(-1)?.[2] ?? "#a6b5c4"));

  return {
    name: parts.length ? parts.map(([, name]) => name).join(" / ") : "未知学派",
    color,
  };
}

// WCL uses separate backgrounds for bars. Elemental Blast (28) was also
// checked against the rendered report: frost -> nature -> fire, at 45 degrees.
export function spellSchoolBackground(
  type: string | number | null | undefined,
) {
  const mask = schoolMask(type);
  const backgrounds: Record<number, string> = {
    36: "linear-gradient(45deg, #b8a8f0, #eb4561)",
    62: "linear-gradient(45deg, #eb4561, #4a80ff, #8ff2ff, #d1fa99, #b8a8f0)",
    106: "linear-gradient(45deg, #8ff2ff, #b8a8f0 33%, #d1fa99 66%, #ffff8f)",
    124: "#a330c9",
    125: "#a330c9",
    126: "#a330c9",
    127: "#a330c9",
    128: "#ffa34a",
    256: "#2599be",
    512: "#bfbfbf",
    1024: "#2599be",
  };
  if (backgrounds[mask]) return backgrounds[mask];
  const parts =
    Number.isInteger(mask) && mask > 0 && mask <= 127
      ? [...schools].reverse().filter(([bit]) => (mask & bit) !== 0)
      : [];
  if (parts.length < 2) return parts[0]?.[2] ?? "#a6b5c4";
  const stops = parts.map(([, , color], index) =>
    index > 0 && index < parts.length - 1
      ? `${color} ${Math.floor((index * 100) / (parts.length - 1))}%`
      : color,
  );
  return `linear-gradient(45deg, ${stops.join(", ")})`;
}
