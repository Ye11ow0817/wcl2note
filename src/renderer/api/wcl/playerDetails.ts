import type { Report } from "../../../domain/model";
import { actorClass } from "../../../domain/actor";
import { classIcons } from "../../../shared/icons";

const object = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

// playerDetails is a JSON scalar. Limit parsing to player role buckets, and
// tolerate missing metadata without dropping the report's actors or events.
export function applyPlayerSpecs(report: Report): Report {
  const root = object(report.playerDetails);
  const data = object(root?.data) ?? root;
  const roles = object(data?.playerDetails) ?? data;
  const players = new Map<number, Record<string, unknown>>();
  for (const role of ["tanks", "healers", "dps"]) {
    const entries = roles?.[role];
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      const player = object(entry);
      if (typeof player?.id === "number" && Number.isSafeInteger(player.id))
        players.set(player.id, player);
    }
  }
  if (!report.masterData || !players.size) return report;
  return {
    ...report,
    masterData: {
      ...report.masterData,
      actors: report.masterData.actors.map((actor) => {
        if (actor.type?.toLowerCase() !== "player") return actor;
        const player = players.get(actor.id);
        const base = classIcons[actorClass(actor.subType)]?.replace(
          /\.jpg$/,
          "",
        );
        if (!player || !base) return actor;
        const specs = Array.isArray(player.specs)
          ? [
              ...new Set(
                player.specs.flatMap((value) => {
                  const spec = object(value)?.spec;
                  return typeof spec === "string" &&
                    /^[A-Za-z ]{1,40}$/.test(spec)
                    ? [spec.replace(/\s/g, "")]
                    : [];
                }),
              ),
            ]
          : [];
        const supplied =
          typeof player.icon === "string"
            ? player.icon.replace(/\.jpg$/, "")
            : "";
        const iconSpec = supplied.startsWith(`${base}-`)
          ? supplied.slice(base.length + 1)
          : "";
        const spec = /^[A-Za-z]{1,40}$/.test(iconSpec)
          ? iconSpec
          : specs.length === 1
            ? specs[0]
            : undefined;
        return spec
          ? { ...actor, spec, specIcon: `${base}-${spec}.jpg` }
          : actor;
      }),
    },
  };
}
