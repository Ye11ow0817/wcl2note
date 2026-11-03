import { useRef, useState } from "react";
import {
  EMPTY_SKILL_PROFILE,
  profileSkillKey,
  sameProfileName,
  uniqueProfileSkills,
  validatedProfileName,
  type ProfileSkill,
  type SkillProfileLibrary,
} from "../../../domain/skillProfile";
import { readSkillProfiles, writeSkillProfiles } from "./storage";

export function useSkillProfiles() {
  const [initial] = useState(() => {
    try {
      return { library: readSkillProfiles(window.localStorage), error: "" };
    } catch {
      return {
        library: { version: 1, profiles: [] } as SkillProfileLibrary,
        error: "无法读取已保存的技能配置，原数据仍保留。",
      };
    }
  });
  const [library, setLibrary] = useState(initial.library);
  const libraryRef = useRef(library);
  const [error, setError] = useState(initial.error);
  function commit(next: SkillProfileLibrary) {
    try {
      writeSkillProfiles(window.localStorage, next);
    } catch {
      throw new Error("技能配置保存失败，请检查本机可用空间后重试。");
    }
    libraryRef.current = next;
    setLibrary(next);
    setError("");
  }
  function activate(id?: string) {
    const current = libraryRef.current;
    const activeId = current.profiles.some((profile) => profile.id === id)
      ? id
      : undefined;
    if (activeId !== current.activeId) commit({ ...current, activeId });
  }
  function save(nameInput: string, skills: ProfileSkill[], id?: string) {
    const name = validatedProfileName(nameInput);
    if (
      id === EMPTY_SKILL_PROFILE.id ||
      sameProfileName(name, EMPTY_SKILL_PROFILE.name)
    )
      throw new Error("「无」为固定选项，请使用其他名称另存为。");
    const old = id
      ? library.profiles.find((profile) => profile.id === id)
      : undefined;
    if (id && !old) throw new Error("此配置已不存在，请重新选择。");
    if (
      library.profiles.some(
        (profile) => profile.id !== id && sameProfileName(profile.name, name),
      )
    )
      throw new Error("已有同名配置，请使用其他名称。");
    const profile = {
      id: old?.id ?? crypto.randomUUID(),
      name,
      skills: uniqueProfileSkills(skills),
    };
    commit({
      ...library,
      profiles: old
        ? library.profiles.map((entry) =>
            entry.id === old.id ? profile : entry,
          )
        : [...library.profiles, profile],
      activeId: profile.id,
    });
    return profile;
  }
  function rename(id: string, nameInput: string) {
    const name = validatedProfileName(nameInput);
    if (
      id === EMPTY_SKILL_PROFILE.id ||
      sameProfileName(name, EMPTY_SKILL_PROFILE.name)
    )
      throw new Error("「无」为固定选项，请使用其他名称。");
    if (
      library.profiles.some(
        (profile) => profile.id !== id && sameProfileName(profile.name, name),
      )
    )
      throw new Error("已有同名配置。");
    commit({
      ...library,
      profiles: library.profiles.map((profile) =>
        profile.id === id ? { ...profile, name } : profile,
      ),
    });
  }
  function duplicate(id: string) {
    const source = library.profiles.find((profile) => profile.id === id);
    if (!source) return;
    let index = 1,
      name: string;
    do {
      const suffix = index === 1 ? "（副本）" : "（副本 " + index + "）";
      name = source.name.slice(0, 60 - suffix.length) + suffix;
      index++;
    } while (
      library.profiles.some((profile) => sameProfileName(profile.name, name))
    );
    commit({
      ...library,
      profiles: [
        ...library.profiles,
        {
          ...source,
          id: crypto.randomUUID(),
          name,
          skills: [...source.skills],
        },
      ],
    });
  }
  function remove(id: string) {
    if (id === EMPTY_SKILL_PROFILE.id) return;
    commit({
      ...library,
      profiles: library.profiles.filter((profile) => profile.id !== id),
      activeId: library.activeId === id ? undefined : library.activeId,
    });
  }
  function removeSkill(id: string, skill: ProfileSkill) {
    if (id === EMPTY_SKILL_PROFILE.id) return;
    const key = profileSkillKey(skill);
    commit({
      ...library,
      profiles: library.profiles.map((profile) =>
        profile.id === id
          ? {
              ...profile,
              skills: profile.skills.filter(
                (entry) => profileSkillKey(entry) !== key,
              ),
            }
          : profile,
      ),
    });
  }
  function addSkills(id: string, skills: ProfileSkill[]) {
    const profile = library.profiles.find((entry) => entry.id === id);
    if (!profile) throw new Error("此配置已不存在，请重新选择。");
    const existing = new Set(profile.skills.map(profileSkillKey));
    const added = uniqueProfileSkills(skills).filter(
      (skill) => !existing.has(profileSkillKey(skill)),
    );
    if (!added.length) return added;
    commit({
      ...library,
      profiles: library.profiles.map((entry) =>
        entry.id === id
          ? { ...entry, skills: [...entry.skills, ...added] }
          : entry,
      ),
    });
    return added;
  }
  const namedActive = library.profiles.find(
    (profile) => profile.id === library.activeId,
  );
  return {
    library,
    error,
    activate,
    save,
    rename,
    duplicate,
    remove,
    removeSkill,
    addSkills,
    active: namedActive ?? EMPTY_SKILL_PROFILE,
    isEmpty: !namedActive,
    options: [EMPTY_SKILL_PROFILE, ...library.profiles],
  };
}
export type SkillProfiles = ReturnType<typeof useSkillProfiles>;
