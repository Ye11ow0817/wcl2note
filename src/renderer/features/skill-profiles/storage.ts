import { z } from "zod";
import type { SkillProfileLibrary } from "../../../domain/skillProfile";
import { uniqueProfileSkills } from "../../../domain/skillProfile";

export const skillProfilesStorageKey = "wcl2note.skill-profiles.v1";
const skillSchema = z
  .object({
    eventType: z.enum(["Casts", "Buffs", "Debuffs"]),
    side: z.enum(["friendly", "enemy"]),
    abilityId: z.number().int().positive().safe(),
    name: z.string().min(1).max(1024),
    icon: z.string().max(2048).nullable().optional(),
  })
  .strict();
const librarySchema = z
  .object({
    version: z.literal(1),
    profiles: z.array(
      z
        .object({
          id: z.string().min(1).max(128),
          name: z.string().trim().min(1).max(60),
          skills: z.array(skillSchema),
        })
        .strict(),
    ),
    activeId: z.string().optional(),
  })
  .strict();
export function readSkillProfiles(
  storage: Pick<Storage, "getItem">,
): SkillProfileLibrary {
  const raw = storage.getItem(skillProfilesStorageKey);
  if (raw === null) return { version: 1, profiles: [] };
  const parsed = librarySchema.parse(JSON.parse(raw));
  if (
    new Set(parsed.profiles.map((profile) => profile.id)).size !==
    parsed.profiles.length
  )
    throw new Error("配置编号重复。");
  return {
    ...parsed,
    profiles: parsed.profiles.map((profile) => ({
      ...profile,
      skills: uniqueProfileSkills(profile.skills),
    })),
    activeId: parsed.profiles.some((profile) => profile.id === parsed.activeId)
      ? parsed.activeId
      : undefined,
  };
}
export function writeSkillProfiles(
  storage: Pick<Storage, "getItem" | "setItem">,
  library: SkillProfileLibrary,
) {
  const value = librarySchema.parse(library);
  const old = storage.getItem(skillProfilesStorageKey);
  if (old !== null) {
    try {
      librarySchema.parse(JSON.parse(old));
    } catch {
      // Preserve unreadable data before the user explicitly saves a replacement.
      storage.setItem(skillProfilesStorageKey + ".backup", old);
    }
  }
  storage.setItem(skillProfilesStorageKey, JSON.stringify(value));
}
