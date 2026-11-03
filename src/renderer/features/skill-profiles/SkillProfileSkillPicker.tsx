import { useEffect, useState } from "react";
import type { EventType, Side } from "../../../domain/model";
import {
  profileSkillKey,
  uniqueProfileSkills,
  type ProfileSkill,
  type SkillProfile,
} from "../../../domain/skillProfile";
import { GameIcon } from "../../components/GameIcon";

const sideNames = { friendly: "队友", enemy: "敌对" };
const typeNames = { Casts: "施法", Buffs: "Buff", Debuffs: "Debuff" };
const typeOrder = { Casts: 0, Buffs: 1, Debuffs: 2 };
const sideOrder = { friendly: 0, enemy: 1 };
export interface ProfileSkillSource {
  skills: ProfileSkill[];
  error?: string;
  hint?: string;
}
export interface ProfileSkillSearch {
  text: string;
  type: EventType | "all";
  side: Side | "all";
}
export function SkillProfileSkillPicker({
  profile,
  profiles,
  loadSkills,
  onAdd,
  onClose,
}: {
  profile: SkillProfile;
  profiles: SkillProfile[];
  loadSkills: (
    search: ProfileSkillSearch,
    signal: AbortSignal,
  ) => Promise<ProfileSkillSource>;
  onAdd: (skills: ProfileSkill[]) => void;
  onClose: () => void;
}) {
  const [source, setSource] = useState<ProfileSkillSource & { key?: string }>({
    skills: [],
  });
  const [loadingKey, setLoadingKey] = useState<string>();
  const [retry, setRetry] = useState(0);
  const [search, setSearch] = useState("");
  const [type, setType] = useState<EventType | "all">("all");
  const [side, setSide] = useState<Side | "all">("all");
  const [selected, setSelected] = useState(new Map<string, ProfileSkill>());
  const [error, setError] = useState("");
  const [composing, setComposing] = useState(false);
  const query = search.trim().toLocaleLowerCase();
  const requestKey = JSON.stringify([query, type, side]);
  const currentSource = source.key === requestKey ? source : undefined;
  const loading =
    !!query && !composing && (!currentSource || loadingKey === requestKey);
  useEffect(() => {
    if (!query || composing) return;
    const controller = new AbortController();
    setLoadingKey(requestKey);
    const timer = window.setTimeout(() => {
      void loadSkills({ text: query, type, side }, controller.signal)
        .then((result) => {
          if (!controller.signal.aborted)
            setSource({ ...result, key: requestKey });
        })
        .catch((failure: unknown) => {
          if (!controller.signal.aborted)
            setSource({
              key: requestKey,
              skills: [],
              error:
                failure instanceof Error ? failure.message : "技能搜索失败。",
            });
        })
        .finally(() => {
          if (!controller.signal.aborted) setLoadingKey(undefined);
        });
    }, 300);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [loadSkills, query, requestKey, type, side, retry, composing]);
  const existing = new Set(profile.skills.map(profileSkillKey));
  const candidates = uniqueProfileSkills(
    query
      ? [
          ...profiles.flatMap((entry) => entry.skills),
          ...(currentSource?.skills ?? []),
          ...selected.values(),
        ]
      : [...selected.values()],
  );
  const visible = candidates
    .filter(
      (skill) =>
        (type === "all" || skill.eventType === type) &&
        (side === "all" || skill.side === side) &&
        (query
          ? skill.name.toLocaleLowerCase().includes(query) ||
            String(skill.abilityId).includes(query)
          : selected.has(profileSkillKey(skill))),
    )
    .sort(
      (a, b) =>
        Number(existing.has(profileSkillKey(b))) -
          Number(existing.has(profileSkillKey(a))) ||
        typeOrder[a.eventType] - typeOrder[b.eventType] ||
        sideOrder[a.side] - sideOrder[b.side] ||
        a.name.localeCompare(b.name, "zh-CN") ||
        a.abilityId - b.abilityId ||
        profileSkillKey(a).localeCompare(profileSkillKey(b)),
    );
  const added = [...selected.values()].filter(
    (skill) => !existing.has(profileSkillKey(skill)),
  );
  return (
    <>
      <div className="profile-dialog-body">
        <input
          type="search"
          autoFocus
          aria-label="搜索可添加技能"
          placeholder="搜索技能名称或 ID"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          onCompositionStart={() => setComposing(true)}
          onCompositionEnd={() => setComposing(false)}
        />
        <div className="profile-skill-filters">
          <label>
            类型
            <select
              aria-label="添加技能类型"
              value={type}
              onChange={(event) =>
                setType(event.target.value as EventType | "all")
              }
            >
              <option value="all">全部类型</option>
              {Object.entries(typeNames).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <label>
            阵营
            <select
              aria-label="添加技能阵营"
              value={side}
              onChange={(event) => setSide(event.target.value as Side | "all")}
            >
              <option value="all">全部阵营</option>
              {Object.entries(sideNames).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
        </div>
        {loading && (
          <p className="profile-skill-loading" role="status">
            正在搜索技能…
          </p>
        )}
        {currentSource?.error && !loading && (
          <div className="profile-source-error" role="alert">
            <span>{currentSource.error}</span>
            <button
              type="button"
              onClick={() => setRetry((value) => value + 1)}
            >
              重试
            </button>
          </div>
        )}
        <div className="profile-skill-options" aria-label="可添加技能">
          {visible.map((skill) => {
            const key = profileSkillKey(skill);
            const present = existing.has(key);
            return (
              <label
                className={
                  "profile-skill-option" + (present ? " is-added" : "")
                }
                key={key}
              >
                <input
                  type="checkbox"
                  aria-label={
                    "添加技能 " +
                    skill.name +
                    " " +
                    typeNames[skill.eventType] +
                    " " +
                    sideNames[skill.side]
                  }
                  disabled={present}
                  checked={present || selected.has(key)}
                  onChange={(event) => {
                    const checked = event.target.checked;
                    setSelected((previous) => {
                      const next = new Map(previous);
                      if (checked) next.set(key, skill);
                      else next.delete(key);
                      return next;
                    });
                  }}
                />
                <GameIcon icon={skill.icon} spellId={skill.abilityId} />
                <span
                  className="profile-option-name"
                  title={"技能 ID：" + skill.abilityId}
                >
                  {skill.name}{" "}
                  <small className="profile-skill-id">
                    ({skill.abilityId})
                  </small>
                </span>
                <span className="profile-option-channel">
                  {sideNames[skill.side]} · {typeNames[skill.eventType]}
                </span>
                {present && (
                  <small className="profile-option-added">已添加</small>
                )}
              </label>
            );
          })}
          {!visible.length && !loading && (
            <p className="profile-empty">
              {!query
                ? "输入技能名称或 ID 开始搜索"
                : (currentSource?.hint ?? "没有匹配的技能")}
            </p>
          )}
          {!!visible.length && currentSource?.hint && !loading && (
            <p className="profile-empty">{currentSource.hint}</p>
          )}
        </div>
        {error && (
          <p className="profile-error" role="alert">
            {error}
          </p>
        )}
      </div>
      <footer className="profile-dialog-actions">
        <button type="button" onClick={onClose}>
          取消
        </button>
        <button
          type="button"
          className="primary"
          disabled={!added.length}
          onClick={() => {
            try {
              onAdd(added);
              onClose();
            } catch (failure) {
              setError((failure as Error).message);
            }
          }}
        >
          添加（{added.length}）
        </button>
      </footer>
    </>
  );
}
