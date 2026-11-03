import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  Check,
  ChevronDown,
  FolderOpen,
  Pencil,
  Plus,
  Trash2,
  X,
} from "lucide-react";
import {
  profileSkillKey,
  sameProfileName,
  sameProfileSkills,
  type ProfileSkill,
  type SkillProfile,
} from "../../../domain/skillProfile";
import type { SkillProfiles } from "./useSkillProfiles";
import { GameIcon } from "../../components/GameIcon";
import {
  SkillProfileSkillPicker,
  type ProfileSkillSource,
  type ProfileSkillSearch,
} from "./SkillProfileSkillPicker";
import "./skillProfiles.css";

const sideNames = { friendly: "队友", enemy: "敌对" };
const typeNames = { Casts: "施法", Buffs: "Buff", Debuffs: "Debuff" };
interface ProfileSwitch {
  profile: SkillProfile;
  returnTo?: "manage";
}

function InlineProfileName({
  profile,
  onRename,
}: {
  profile: SkillProfile;
  onRename: (id: string, name: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(profile.name);
  const [error, setError] = useState("");
  const canceled = useRef(false);
  function finish() {
    if (canceled.current) return;
    try {
      if (name.trim() && name.trim() !== profile.name)
        onRename(profile.id, name);
      setEditing(false);
      setError("");
    } catch (failure) {
      setError((failure as Error).message);
    }
  }
  return (
    <span className="profile-name">
      {editing ? (
        <input
          autoFocus
          aria-label={"配置名称 " + profile.name}
          aria-invalid={!!error}
          maxLength={60}
          value={name}
          onFocus={(event) => event.currentTarget.select()}
          onClick={(event) => event.stopPropagation()}
          onChange={(event) => {
            setName(event.target.value);
            setError("");
          }}
          onBlur={finish}
          onKeyDown={(event) => {
            event.stopPropagation();
            if (event.key === "Enter") {
              event.preventDefault();
              finish();
            }
            if (event.key === "Escape") {
              event.preventDefault();
              canceled.current = true;
              setEditing(false);
              setError("");
            }
          }}
        />
      ) : (
        <>
          <strong>{profile.name}</strong>
          <button
            type="button"
            className="profile-rename"
            aria-label={"重命名配置 " + profile.name}
            title="重命名"
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              canceled.current = false;
              setName(profile.name);
              setError("");
              setEditing(true);
            }}
          >
            <Pencil size={13} />
          </button>
        </>
      )}
      {error && (
        <span className="profile-inline-error" role="alert">
          {error}
        </span>
      )}
    </span>
  );
}
function SkillList({
  skills,
  matched,
  loadedChannels,
  onRemove,
}: {
  skills: ProfileSkill[];
  matched: ReadonlySet<string>;
  loadedChannels: ReadonlySet<string>;
  onRemove?: (skill: ProfileSkill) => void;
}) {
  const groups = new Map<string, ProfileSkill[]>();
  for (const skill of skills) {
    const key = skill.side + ":" + skill.eventType;
    groups.set(key, [...(groups.get(key) ?? []), skill]);
  }
  return (
    <div className="profile-skill-list">
      {!skills.length && <p className="profile-empty">此配置没有技能</p>}
      {[...groups].map(([key, entries]) => (
        <section className="profile-skill-section" key={key}>
          <h3>
            {sideNames[entries[0].side]} · {typeNames[entries[0].eventType]}
            <small>{entries.length} 项</small>
          </h3>
          <div className="profile-skill-grid">
            {entries.map((skill) => {
              const present = matched.has(profileSkillKey(skill));
              const loaded = loadedChannels.has(
                skill.eventType + ":" + skill.side,
              );
              return (
                <div className="profile-skill" key={profileSkillKey(skill)}>
                  <GameIcon icon={skill.icon} spellId={skill.abilityId} />
                  <span title={"技能 ID：" + skill.abilityId}>
                    {skill.name}{" "}
                    <small className="profile-skill-id">
                      ({skill.abilityId})
                    </small>
                  </span>
                  {loaded && !present && (
                    <small className="profile-missing">本场未出现</small>
                  )}
                  {onRemove && (
                    <button
                      type="button"
                      className="profile-remove-skill"
                      aria-label={
                        "删除技能 " +
                        skill.name +
                        " " +
                        typeNames[skill.eventType] +
                        " " +
                        sideNames[skill.side]
                      }
                      title="从配置中删除此技能"
                      onClick={() => onRemove(skill)}
                    >
                      <X size={13} />
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );
}
export function SkillProfileControls({
  profiles,
  skills,
  matched,
  loadedChannels,
  hasFight,
  canClear,
  partialEvents,
  onApply,
  onRemoveSkill,
  onAddSkills,
  loadSkills,
  onClear,
  onError,
}: {
  profiles: SkillProfiles;
  skills: ProfileSkill[];
  matched: ReadonlySet<string>;
  loadedChannels: ReadonlySet<string>;
  hasFight: boolean;
  canClear: boolean;
  partialEvents: boolean;
  onApply: (profile: SkillProfile) => void;
  onRemoveSkill: (profile: SkillProfile, skill: ProfileSkill) => void;
  onAddSkills: (profile: SkillProfile, skills: ProfileSkill[]) => void;
  loadSkills: (
    search: ProfileSkillSearch,
    signal: AbortSignal,
  ) => Promise<ProfileSkillSource>;
  onClear: () => void;
  onError: (message: string) => void;
}) {
  const chooser = useRef<HTMLDetailsElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const confirmDialog = useRef<HTMLDialogElement>(null);
  const managerBody = useRef<HTMLDivElement>(null);
  const managerScroll = useRef(0);
  const addTrigger = useRef<HTMLButtonElement | null>(null);
  const [panel, setPanel] = useState<"manage" | "save" | "saveAs">();
  const [search, setSearch] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [expanded, setExpanded] = useState<string>();
  const [pendingDelete, setPendingDelete] = useState<SkillProfile>();
  const [pendingSwitch, setPendingSwitch] = useState<ProfileSwitch>();
  const [switchAfterSave, setSwitchAfterSave] = useState<ProfileSwitch>();
  const [addingId, setAddingId] = useState<string>();
  const addingProfile = profiles.library.profiles.find(
    (profile) => profile.id === addingId,
  );
  const active = profiles.active;
  const dirty = active
    ? !sameProfileSkills(active.skills, skills)
    : !!skills.length;
  const duplicate = profiles.library.profiles.find((profile) =>
    sameProfileName(profile.name, name),
  );
  const adding = panel === "manage" ? addingProfile : undefined;
  const title = adding
    ? "添加技能 · " + adding.name
    : panel === "manage"
      ? "配置管理"
      : panel === "saveAs"
        ? "另存为配置"
        : "保存配置";
  useEffect(() => {
    if (panel && !dialog.current?.open) dialog.current?.showModal();
    else if (!panel && dialog.current?.open) dialog.current.close();
  }, [panel]);
  useEffect(() => {
    if ((pendingDelete || pendingSwitch) && !confirmDialog.current?.open)
      confirmDialog.current?.showModal();
    else if (!pendingDelete && !pendingSwitch && confirmDialog.current?.open)
      confirmDialog.current.close();
  }, [pendingDelete, pendingSwitch]);
  useLayoutEffect(() => {
    if (panel === "manage" && !addingId && addTrigger.current) {
      if (managerBody.current)
        managerBody.current.scrollTop = managerScroll.current;
      addTrigger.current.focus({ preventScroll: true });
      addTrigger.current = null;
    }
  }, [addingId, panel]);
  useEffect(() => {
    function close(event: PointerEvent) {
      if (!chooser.current?.contains(event.target as Node) && chooser.current)
        chooser.current.open = false;
    }
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, []);
  function perform(action: () => void) {
    try {
      action();
      setError("");
      return true;
    } catch (failure) {
      const message = (failure as Error).message;
      setError(message);
      if (!panel && !pendingSwitch) onError(message);
      return false;
    }
  }
  function open(next: "manage" | "save" | "saveAs") {
    if (chooser.current) chooser.current.open = false;
    setSearch("");
    setError("");
    setExpanded(
      profiles.isEmpty ? profiles.library.profiles[0]?.id : active.id,
    );
    setName("");
    setAddingId(undefined);
    setSwitchAfterSave(undefined);
    managerScroll.current = 0;
    addTrigger.current = null;
    setPanel(next);
  }
  function cancelPanel() {
    if (adding) {
      setAddingId(undefined);
      return;
    }
    setPanel(switchAfterSave?.returnTo);
    setSwitchAfterSave(undefined);
    setError("");
  }
  function finishApply(profile: SkillProfile) {
    onApply(profile);
    if (chooser.current) chooser.current.open = false;
    setPendingSwitch(undefined);
    setSwitchAfterSave(undefined);
    setPanel(undefined);
  }
  function apply(profile: SkillProfile) {
    if (chooser.current) chooser.current.open = false;
    if (dirty || partialEvents) {
      setError("");
      setPendingSwitch({
        profile,
        returnTo: panel === "manage" ? "manage" : undefined,
      });
    } else perform(() => finishApply(profile));
  }
  function saveAndSwitch() {
    if (!pendingSwitch) return;
    if (profiles.isEmpty) {
      setName("");
      setError("");
      setSwitchAfterSave(pendingSwitch);
      setPendingSwitch(undefined);
      setPanel("save");
    } else
      perform(() => {
        const saved = profiles.save(active.name, skills, active.id);
        finishApply(
          pendingSwitch.profile.id === saved.id ? saved : pendingSwitch.profile,
        );
      });
  }
  function command(event: React.MouseEvent, action: () => void) {
    event.preventDefault();
    event.stopPropagation();
    perform(action);
  }
  return (
    <div className="skill-profile-controls">
      <details
        className="skill-profile-picker"
        ref={chooser}
        onToggle={(event) => {
          if (event.currentTarget.open) setSearch("");
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape" && chooser.current?.open) {
            event.preventDefault();
            event.stopPropagation();
            chooser.current.open = false;
          }
        }}
      >
        <summary aria-label="选择技能配置" title={active?.name ?? "技能配置"}>
          <FolderOpen size={13} />
          <span>{active?.name ?? "技能配置"}</span>
          {dirty && (
            <i
              className="profile-dirty"
              aria-label="有未保存修改"
              title="有未保存修改"
            />
          )}
          <ChevronDown size={12} />
        </summary>
        <div className="skill-profile-menu" aria-label="技能配置列表">
          <input
            type="search"
            aria-label="搜索技能配置"
            placeholder="搜索配置"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
          <div className="profile-options">
            {profiles.options
              .filter((profile) =>
                profile.name
                  .toLocaleLowerCase()
                  .includes(search.trim().toLocaleLowerCase()),
              )
              .map((profile) => (
                <button
                  key={profile.id}
                  type="button"
                  className={active?.id === profile.id ? "active" : ""}
                  onClick={() => apply(profile)}
                >
                  <span>{profile.name}</span>
                  {active?.id === profile.id && <Check size={13} />}
                </button>
              ))}
          </div>
          <div className="profile-menu-actions">
            <button
              type="button"
              disabled={!hasFight && !skills.length && profiles.isEmpty}
              onClick={() => open("saveAs")}
            >
              另存为
            </button>
            <button type="button" onClick={() => open("manage")}>
              配置管理
            </button>
          </div>
        </div>
      </details>
      <button
        type="button"
        className="profile-save"
        disabled={!dirty}
        title={
          profiles.isEmpty
            ? "命名并保存为新配置"
            : "保存「" + active.name + "」"
        }
        onClick={() => {
          if (profiles.isEmpty) open("save");
          else
            perform(() => {
              profiles.save(active.name, skills, active.id);
            });
        }}
      >
        保存
      </button>
      <button
        type="button"
        className="clear-selection"
        disabled={!canClear}
        title="清除当前战斗所有阶段和标签页的勾选"
        onClick={onClear}
      >
        <Trash2 size={12} />
        清除勾选
      </button>
      <dialog
        ref={dialog}
        className={
          "skill-profile-dialog" +
          (panel === "manage" ? " profile-manager" : "") +
          (adding ? " profile-skill-picker-dialog" : "")
        }
        aria-label={adding ? "添加技能" : title}
        onCancel={(event) => {
          if (adding || switchAfterSave?.returnTo) event.preventDefault();
          cancelPanel();
        }}
        onClose={() => {
          setPanel(undefined);
          setAddingId(undefined);
          setSwitchAfterSave(undefined);
        }}
      >
        <header className="profile-dialog-header">
          <h2>{title}</h2>
          <button
            type="button"
            className="profile-close"
            aria-label={adding ? "关闭添加技能" : "关闭配置窗口"}
            onClick={cancelPanel}
          >
            <X size={17} />
          </button>
        </header>
        {(error || profiles.error) && (
          <p className="profile-error" role="alert">
            {error || profiles.error}
          </p>
        )}
        {panel === "save" || panel === "saveAs" ? (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (
                perform(() => {
                  const saved = profiles.save(name, skills);
                  if (switchAfterSave)
                    finishApply(
                      switchAfterSave.profile.id === saved.id
                        ? saved
                        : switchAfterSave.profile,
                    );
                  else setPanel(undefined);
                })
              )
                setSwitchAfterSave(undefined);
            }}
          >
            <div className="profile-dialog-body">
              <label className="profile-name-field">
                配置名称
                <input
                  autoFocus
                  value={name}
                  maxLength={60}
                  aria-invalid={!!duplicate}
                  aria-describedby={
                    duplicate ? "profile-name-conflict" : undefined
                  }
                  onChange={(event) => {
                    setName(event.target.value);
                    setError("");
                  }}
                  placeholder="例如：治疗团减"
                />
              </label>
              {duplicate && (
                <p
                  className="profile-inline-error"
                  id="profile-name-conflict"
                  role="alert"
                >
                  已有同名配置，请使用其他名称。
                </p>
              )}
              <details className="profile-save-skills">
                <summary>技能清单（{skills.length}）</summary>
                <SkillList
                  skills={skills}
                  matched={matched}
                  loadedChannels={loadedChannels}
                />
              </details>
              {partialEvents && (
                <p className="profile-warning">
                  部分事件未勾选，配置会按整项技能保存。
                </p>
              )}
            </div>
            <footer className="profile-dialog-actions">
              <button type="button" onClick={cancelPanel}>
                取消
              </button>
              <button
                className="primary"
                disabled={!name.trim() || !!duplicate}
              >
                保存新配置
              </button>
            </footer>
          </form>
        ) : panel === "manage" ? (
          <>
            <div hidden={!!adding}>
              <div className="profile-dialog-body" ref={managerBody}>
                <input
                  type="search"
                  className="profile-manager-search"
                  aria-label="搜索已保存配置"
                  placeholder="搜索配置"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                />
                {profiles.library.profiles
                  .filter((profile) =>
                    profile.name
                      .toLocaleLowerCase()
                      .includes(search.trim().toLocaleLowerCase()),
                  )
                  .map((profile) => (
                    <details
                      className="profile-library-item"
                      key={profile.id}
                      open={expanded === profile.id}
                      onToggle={(event) => {
                        if (event.currentTarget.open) setExpanded(profile.id);
                        else
                          setExpanded((old) =>
                            old === profile.id ? undefined : old,
                          );
                      }}
                    >
                      <summary>
                        <InlineProfileName
                          profile={profile}
                          onRename={profiles.rename}
                        />
                        <span className="profile-item-actions">
                          <button
                            type="button"
                            className="profile-apply"
                            disabled={active.id === profile.id}
                            onClick={(event) => {
                              event.preventDefault();
                              event.stopPropagation();
                              apply(profile);
                            }}
                          >
                            {active.id === profile.id ? "使用中" : "应用"}
                          </button>
                          <button
                            type="button"
                            onClick={(event) =>
                              command(event, () =>
                                profiles.duplicate(profile.id),
                              )
                            }
                          >
                            复制
                          </button>
                          <button
                            type="button"
                            className="profile-delete"
                            aria-label={"删除配置 " + profile.name}
                            onClick={(event) =>
                              command(event, () => setPendingDelete(profile))
                            }
                          >
                            <Trash2 size={13} />
                          </button>
                        </span>
                        <ChevronDown className="profile-expand" size={13} />
                      </summary>
                      {active?.id === profile.id && dirty && (
                        <p className="profile-edit-status">
                          当前勾选有未保存修改
                        </p>
                      )}
                      {expanded === profile.id && (
                        <>
                          <div className="profile-skill-list-heading">
                            <span>技能清单</span>
                            <button
                              type="button"
                              onClick={(event) => {
                                managerScroll.current =
                                  managerBody.current?.scrollTop ?? 0;
                                addTrigger.current = event.currentTarget;
                                setAddingId(profile.id);
                              }}
                            >
                              <Plus size={13} />
                              添加技能
                            </button>
                          </div>
                          <SkillList
                            skills={profile.skills}
                            matched={matched}
                            loadedChannels={loadedChannels}
                            onRemove={(skill) =>
                              perform(() => onRemoveSkill(profile, skill))
                            }
                          />
                        </>
                      )}
                    </details>
                  ))}
                {!profiles.library.profiles.length && (
                  <p className="profile-empty">暂无配置</p>
                )}
              </div>
            </div>
            {adding && (
              <SkillProfileSkillPicker
                profile={adding}
                profiles={profiles.library.profiles}
                loadSkills={loadSkills}
                onAdd={(entries) => onAddSkills(adding, entries)}
                onClose={() => setAddingId(undefined)}
              />
            )}
          </>
        ) : null}
        <div data-wowhead-tooltip-host />
      </dialog>
      <dialog
        ref={confirmDialog}
        className="skill-profile-dialog profile-confirm-dialog"
        role="alertdialog"
        aria-labelledby="profile-confirm-title"
        aria-describedby="profile-confirm-description"
        onCancel={() => {
          setPendingDelete(undefined);
          setPendingSwitch(undefined);
        }}
        onClose={() => {
          setPendingDelete(undefined);
          setPendingSwitch(undefined);
        }}
      >
        <header className="profile-dialog-header">
          <h2 id="profile-confirm-title">
            {pendingSwitch ? "保存修改？" : "删除配置"}
          </h2>
        </header>
        <div className="profile-dialog-body">
          <p id="profile-confirm-description">
            {pendingSwitch
              ? "当前勾选有未保存修改，切换到「" +
                pendingSwitch.profile.name +
                "」前要保存吗？"
              : "确定删除配置「" + (pendingDelete?.name ?? "") + "」吗？"}
          </p>
          {pendingSwitch && partialEvents && (
            <p className="profile-warning">
              配置只保存整项技能，本场单次调整不会写入配置。
            </p>
          )}
          {error && (
            <p className="profile-error" role="alert">
              {error}
            </p>
          )}
        </div>
        <footer className="profile-dialog-actions">
          <button
            type="button"
            autoFocus
            onClick={() => {
              setPendingDelete(undefined);
              setPendingSwitch(undefined);
            }}
          >
            取消
          </button>
          {pendingSwitch ? (
            <>
              <button
                type="button"
                onClick={() =>
                  perform(() => finishApply(pendingSwitch.profile))
                }
              >
                不保存并切换
              </button>
              <button type="button" className="primary" onClick={saveAndSwitch}>
                保存并切换
              </button>
            </>
          ) : (
            <button
              type="button"
              className="profile-confirm-delete"
              onClick={() => {
                if (
                  pendingDelete &&
                  perform(() => profiles.remove(pendingDelete.id))
                )
                  setPendingDelete(undefined);
              }}
            >
              删除配置
            </button>
          )}
        </footer>
      </dialog>
    </div>
  );
}
