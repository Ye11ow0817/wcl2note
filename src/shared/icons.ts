export type IconFolder = "abilities" | "icons";

export function parseIcon(folder: string, icon: unknown) {
  if (
    (folder !== "abilities" && folder !== "icons") ||
    typeof icon !== "string" ||
    icon.length > 320
  )
    return undefined;
  const match = icon.match(
    /^([a-z0-9_-][a-z0-9_.-]{0,179}\.(?:jpg|jpeg|png|webp))(\?[a-z0-9._~%=&+-]{1,128})?$/i,
  );
  return match ? { folder, name: match[1], search: match[2] ?? "" } : undefined;
}

export function iconSource(icon: unknown, folder: IconFolder = "abilities") {
  const parsed = parseIcon(folder, icon);
  return parsed
    ? `app://wcl2note/icons/${parsed.folder}/${parsed.name}${parsed.search}`
    : undefined;
}

// These CDN filenames are case-sensitive.
export const classIcons: Readonly<Record<string, string>> = {
  deathknight: "DeathKnight.jpg",
  demonhunter: "DemonHunter.jpg",
  druid: "Druid.jpg",
  evoker: "Evoker.jpg",
  hunter: "Hunter.jpg",
  mage: "Mage.jpg",
  monk: "Monk.jpg",
  paladin: "Paladin.jpg",
  priest: "Priest.jpg",
  rogue: "Rogue.jpg",
  shaman: "Shaman.jpg",
  warlock: "Warlock.jpg",
  warrior: "Warrior.jpg",
};
