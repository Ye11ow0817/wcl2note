// WCL orders players by their English class name, then by character name.
// Keep this separate from the Chinese collation used for skills and MRT output.
export const actorClass = (subType?: string | null) =>
  subType?.replace(/\s+/g, "").toLowerCase() ?? "";

export const classColors: Readonly<Record<string, string>> = {
  deathknight: "#c41f3b",
  demonhunter: "#a330c9",
  druid: "#ff7d0a",
  evoker: "#33937f",
  hunter: "#abd473",
  mage: "#69ccf0",
  monk: "#00ff96",
  paladin: "#f58cba",
  priest: "#ffffff",
  rogue: "#fff569",
  shaman: "#0070de",
  warlock: "#9482c9",
  warrior: "#c79c6e",
};

export function compareActorNames(a: string, b: string) {
  const left = a.toLowerCase(),
    right = b.toLowerCase();
  return left < right ? -1 : left > right ? 1 : 0;
}
