import {
  selectionKey,
  type EventType,
  type Side,
  type TimelineEvent,
} from "./model";
import { isEventIncluded, type EventOverrides } from "./timeline";

export interface ProfileSkill {
  eventType: EventType;
  side: Side;
  abilityId: number;
  name: string;
  icon?: string | null;
}
export interface SkillProfile {
  id: string;
  name: string;
  skills: ProfileSkill[];
}
export interface SkillProfileLibrary {
  version: 1;
  profiles: SkillProfile[];
  activeId?: string;
}
export const EMPTY_SKILL_PROFILE: SkillProfile = {
  id: "__empty_skill_profile__",
  name: "无",
  skills: [],
};
export const profileSkillKey = (
  skill: Pick<ProfileSkill, "eventType" | "side" | "abilityId">,
) => skill.eventType + ":" + skill.side + ":" + skill.abilityId;
export function groupMatchesProfileSkill(
  groupKey: string,
  skill: ProfileSkill,
) {
  const [eventType, side, , abilityId] = groupKey.split(":");
  return (
    eventType === skill.eventType &&
    side === skill.side &&
    Number(abilityId) === skill.abilityId
  );
}
export const eventGroupKey = (event: TimelineEvent) =>
  selectionKey(
    event.eventType,
    event.side,
    event.actor.id,
    event.ability.gameID,
  );
export function eventSkill(event: TimelineEvent): ProfileSkill {
  return {
    eventType: event.eventType,
    side: event.side,
    abilityId: event.ability.gameID,
    name: event.ability.name,
    icon: event.ability.icon,
  };
}
export function uniqueProfileSkills(skills: ProfileSkill[]) {
  return [
    ...new Map(skills.map((skill) => [profileSkillKey(skill), skill])).values(),
  ];
}
export function sameProfileSkills(a: ProfileSkill[], b: ProfileSkill[]) {
  const left = new Set(a.map(profileSkillKey));
  const right = new Set(b.map(profileSkillKey));
  return left.size === right.size && [...left].every((key) => right.has(key));
}
export function matchingProfileGroups(
  events: TimelineEvent[],
  skills: ProfileSkill[],
) {
  const keys = new Set(skills.map(profileSkillKey));
  return new Set(
    events
      .filter((event) => keys.has(profileSkillKey(eventSkill(event))))
      .map(eventGroupKey),
  );
}
export function hasPartialProfileSelection(
  events: TimelineEvent[],
  selected: ReadonlySet<string>,
  overrides: EventOverrides,
) {
  const counts = new Map<string, { total: number; included: number }>();
  for (const event of events) {
    if (event.auraOnly) continue;
    const key = profileSkillKey(eventSkill(event));
    const count = counts.get(key) ?? { total: 0, included: 0 };
    count.total++;
    if (isEventIncluded(event, eventGroupKey(event), selected, overrides))
      count.included++;
    counts.set(key, count);
  }
  return [...counts.values()].some(
    (count) => count.included > 0 && count.included < count.total,
  );
}
// Reconsider only skills the user touched. Unavailable skills stay in the
// working configuration, including skills from phases this attempt never reached.
export function updateProfileSkills(
  previous: ProfileSkill[],
  events: TimelineEvent[],
  selected: ReadonlySet<string>,
  overrides: EventOverrides,
  touchedGroups: string[],
) {
  const touched = new Set(touchedGroups);
  const changed = new Map<string, ProfileSkill>();
  for (const event of events)
    if (touched.has(eventGroupKey(event)))
      changed.set(profileSkillKey(eventSkill(event)), eventSkill(event));
  const included = new Set<string>();
  for (const event of events) {
    const key = profileSkillKey(eventSkill(event));
    if (
      changed.has(key) &&
      isEventIncluded(event, eventGroupKey(event), selected, overrides)
    )
      included.add(key);
  }
  const next = new Map(
    previous.map((skill) => [profileSkillKey(skill), skill]),
  );
  for (const [key, skill] of changed)
    if (included.has(key)) next.set(key, skill);
    else next.delete(key);
  return [...next.values()];
}
export function validatedProfileName(value: string) {
  const name = value.trim();
  if (!name) throw new Error("请输入配置名称。");
  if (name.length > 60) throw new Error("配置名称不能超过 60 个字符。");
  if (
    [...name].some(
      (character) =>
        character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    )
  )
    throw new Error("配置名称包含无效字符。");
  return name;
}
export const sameProfileName = (a: string, b: string) =>
  a.trim().toLocaleLowerCase() === b.trim().toLocaleLowerCase();
