import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Activity,
  ArrowRight,
  Clipboard,
  Download,
  FileText,
  LoaderCircle,
  List,
  ChartGantt,
  PanelRightClose,
  PanelRightOpen,
  Settings,
  X,
} from "lucide-react";
import {
  allEvents,
  query,
  desktop,
  unwrap,
  loadSettings,
  saveSettings,
} from "../api/wcl/client";
import type { Credentials } from "../../shared/desktop";
import {
  defaults,
  selectionKey,
  type EventType,
  type Fight,
  type Options,
  type SideFilter,
  type SourceNode,
  type TimelineEvent,
} from "../../domain/model";
import {
  filename,
  initialSegment,
  parseReport,
  segments,
  type ReportRef,
} from "../../domain/report";
import { groupEvents, sourceTree, visibleGroups } from "../../domain/group";
import { formatNote, noteTime } from "../../domain/format";
import { createNSRTNote, nsrtEventRange } from "../../domain/nsrt";
import { spellSchool, spellSchoolBackground } from "../../domain/casts";
import { groupBuffRows, type BuffCategory } from "../../domain/buff";
import {
  abilityRows,
  castActorRows,
  castsPerMinute,
  filterRelatedGroups,
  findActorNode,
  relatedActorTree,
} from "../../domain/ability";
import { ActorPicker, actorTextColors } from "../components/ActorPicker";
import { ActorIcon, GameIcon } from "../components/GameIcon";
import { MetricBar, UptimeBar } from "../components/MetricBar";
import {
  Timeline,
  type TimelineViewState,
} from "../features/timeline/Timeline";
import { useKeyboardFocus } from "../hooks/useKeyboardFocus";
import {
  FightNavigation,
  type NavigationPanel,
} from "../features/fights/FightNavigation";
import { SkillProfileControls } from "../features/skill-profiles/SkillProfileControls";
import type {
  ProfileSkillSource,
  ProfileSkillSearch,
} from "../features/skill-profiles/SkillProfileSkillPicker";
import { useSkillProfiles } from "../features/skill-profiles/useSkillProfiles";
import { useAppUpdates } from "../features/updates/useAppUpdates";
import {
  UpdateActionButton,
  UpdatePanel,
} from "../features/updates/AppUpdates";
import {
  EMPTY_SKILL_PROFILE,
  eventGroupKey,
  eventSkill,
  groupMatchesProfileSkill,
  matchingProfileGroups,
  hasPartialProfileSelection,
  profileSkillKey,
  uniqueProfileSkills,
  updateProfileSkills,
  type ProfileSkill,
  type SkillProfile,
} from "../../domain/skillProfile";
import {
  eventKey,
  isEventIncluded,
  noteEventRange,
  selectedEventGroups,
  timelineBounds,
  type EventOverride,
  type TimelineEntry,
  type TimelineRow,
} from "../../domain/timeline";
const eventTypes: EventType[] = ["Buffs", "Debuffs", "Casts"];
const eventLabels = { Casts: "施法", Buffs: "Buff", Debuffs: "Debuff" };
interface FightDraft {
  segmentId?: string;
  type: EventType;
  side: SideFilter;
  onlyIncluded: boolean;
  source: string;
  previousSource?: SourceNode;
  relatedFilters: Partial<Record<`${EventType}:${SideFilter}`, SourceNode>>;
  selected: Set<string>;
  eventOverrides: Map<string, EventOverride>;
  focusedEventId?: string;
  profileId?: string;
  profileSkills: ProfileSkill[];
  resolvedProfileGroups: Set<string>;
}
export function App() {
  const shell = useKeyboardFocus<HTMLDivElement>();
  const profiles = useSkillProfiles();
  const updates = useAppUpdates();
  const cache = useQueryClient(),
    [input, setInput] = useState(""),
    [ref, setRef] = useState<ReportRef>(),
    [revision, setRevision] = useState(0),
    [fight, setFight] = useState<Fight>(),
    [segmentId, setSegmentId] = useState<string>(),
    [type, setType] = useState<EventType>("Casts"),
    [side, setSide] = useState<SideFilter>("friendly"),
    [onlyIncluded, setOnlyIncluded] = useState(false),
    [source, setSource] = useState(""),
    [relatedFilters, setRelatedFilters] = useState<
      Partial<Record<`${EventType}:${SideFilter}`, SourceNode>>
    >({}),
    [selected, setSelected] = useState(new Set<string>()),
    [eventOverrides, setEventOverrides] = useState(
      new Map<string, EventOverride>(),
    ),
    [profileSkills, setProfileSkills] = useState<ProfileSkill[]>(
      () => profiles.active.skills,
    ),
    [focusedEventId, setFocusedEventId] = useState<string>(),
    [noteFocusRequest, setNoteFocusRequest] = useState(0),
    [view, setView] = useState<"list" | "timeline">("list"),
    [noteOpen, setNoteOpen] = useState(true),
    [openNavigation, setOpenNavigation] = useState<NavigationPanel>(),
    [noteFormat, setNoteFormat] = useState<"MRT" | "NSRT">("MRT"),
    [dynamicTimers, setDynamicTimers] = useState(true),
    [options, setOptions] = useState<Options>(defaults),
    [settings, setSettings] = useState(false),
    [identity, setIdentity] = useState(0),
    [clientId, setClientId] = useState(""),
    [secret, setSecret] = useState(""),
    [secretVisible, setSecretVisible] = useState(false),
    [authBusy, setAuthBusy] = useState(false),
    [settingsReady, setSettingsReady] = useState(false),
    [settingsStatus, setSettingsStatus] = useState(""),
    [version, setVersion] = useState(""),
    [localError, setLocalError] = useState("");
  const authVersion = useRef(0),
    fightDrafts = useRef(new Map<number, FightDraft>()),
    timelineStates = useRef(new Map<number, TimelineViewState>()),
    resolvedProfileGroups = useRef(new Set<string>()),
    credentialDraft = useRef<Credentials>({ clientId: "", clientSecret: "" }),
    previousSource = useRef<SourceNode | undefined>(undefined),
    carriedActor = useRef<{ fightId: number; node: SourceNode } | undefined>(
      undefined,
    ),
    settingsDialog = useRef<HTMLDialogElement>(null),
    previewText = useRef<HTMLTextAreaElement>(null),
    focusNote = useRef(false);
  useEffect(() => {
    const dialog = settingsDialog.current;
    if (settings && !dialog?.open) dialog?.showModal();
    else if (!settings && dialog?.open) dialog.close();
  }, [settings]);
  useEffect(() => {
    if (!settings) setSecretVisible(false);
  }, [settings]);
  useEffect(() => {
    let active = true;
    void loadSettings()
      .then((saved) => {
        if (!active) return;
        credentialDraft.current = {
          clientId: saved.clientId,
          clientSecret: saved.clientSecret,
        };
        setClientId(saved.clientId);
        setSecret(saved.clientSecret);
        setSettingsReady(true);
      })
      .catch((error: Error) => {
        if (active) {
          setLocalError(error.message);
          setSettings(true);
        }
      });
    void (async () => {
      try {
        const value = unwrap(await desktop().version());
        if (active) setVersion(value);
      } catch {
        /* Settings display the bridge failure. */
      }
    })();
    return () => {
      active = false;
    };
  }, []);
  const fightsQuery = useQuery({
    queryKey: ["fights", identity, ref?.code, revision],
    enabled: !!ref && settingsReady && !authBusy,
    queryFn: ({ signal }) =>
      query(
        { operation: "reportFights", variables: { reportCode: ref!.code } },
        signal,
      ),
  });
  const fights = fightsQuery.data?.fights ?? [];
  const initialFight =
    ref?.fight !== undefined
      ? fights.find((f) => f.id === ref.fight)
      : ref?.last
        ? fights.at(-1)
        : undefined;
  const currentFight = fight ?? initialFight;
  const segmentsQuery = useQuery({
    queryKey: ["segments", identity, ref?.code, currentFight?.id],
    enabled: !!currentFight && !!ref && settingsReady && !authBusy,
    queryFn: ({ signal }) =>
      query(
        {
          operation: "fightSegments",
          variables: { reportCode: ref!.code, fightId: currentFight!.id },
        },
        signal,
      ),
  });
  const detailedFight = segmentsQuery.data?.fights?.find(
    (f) => f.id === currentFight?.id,
  );
  const availableSegments = useMemo(
    () =>
      detailedFight && segmentsQuery.data
        ? segments({ ...currentFight, ...detailedFight }, segmentsQuery.data)
        : [],
    [currentFight, detailedFight, segmentsQuery.data],
  );
  const segment =
    availableSegments.find((s) => s.id === segmentId) ??
    (ref && !fight
      ? initialSegment(availableSegments, ref)
      : availableSegments[0]);
  const contextQuery = useQuery({
    queryKey: ["context", identity, ref?.code, currentFight?.id],
    enabled: !!currentFight && !!segment && settingsReady && !authBusy,
    queryFn: ({ signal }) =>
      query(
        {
          operation: "fightContext",
          variables: { reportCode: ref!.code, fightId: currentFight!.id },
        },
        signal,
      ),
  });
  const loadProfileSkills = useCallback(
    async (
      search: ProfileSkillSearch,
      signal: AbortSignal,
    ): Promise<ProfileSkillSource> => {
      const text = search.text.trim().toLocaleLowerCase();
      if (!text || !ref?.code || !currentFight) return { skills: [] };
      signal.throwIfAborted();
      if (!settingsReady || authBusy)
        throw new Error("登录状态尚未就绪，请稍后重试。");
      const channels = (
        search.type === "all" ? eventTypes : [search.type]
      ).flatMap((eventType) =>
        (search.side === "all"
          ? (["friendly", "enemy"] as const)
          : [search.side]
        ).map((side) => ({ eventType, side })),
      );
      const skills: ProfileSkill[] = [];
      const missing = channels.filter(({ eventType, side }) => {
        const cached = cache.getQueryData<TimelineEvent[]>([
          "events",
          identity,
          ref.code,
          currentFight.id,
          eventType,
          side,
        ]);
        if (!cached) return true;
        skills.push(
          ...cached
            .filter(
              (event) =>
                event.ability.name.toLocaleLowerCase().includes(text) ||
                String(event.ability.gameID).includes(text),
            )
            .map(eventSkill),
        );
        return false;
      });
      if (!missing.length) return { skills: uniqueProfileSkills(skills) };
      const context = await cache.fetchQuery({
        queryKey: ["context", identity, ref.code, currentFight.id],
        queryFn: ({ signal }) =>
          query(
            {
              operation: "fightContext",
              variables: { reportCode: ref.code, fightId: currentFight.id },
            },
            signal,
          ),
      });
      signal.throwIfAborted();
      const ids = new Set(
        (context.masterData?.abilities ?? [])
          .filter(
            (ability) =>
              ability.name.toLocaleLowerCase().includes(text) ||
              String(ability.gameID).includes(text),
          )
          .map((ability) => ability.gameID)
          .filter((id) => Number.isSafeInteger(id) && id > 0),
      );
      const exactId = /^\d+$/.test(text) ? Number(text) : 0;
      if (Number.isSafeInteger(exactId) && exactId > 0) ids.add(exactId);
      if (!ids.size) return { skills: uniqueProfileSkills(skills) };
      if (ids.size > 100)
        return {
          skills: uniqueProfileSkills(skills),
          hint: "匹配技能较多，请输入更完整的名称或 ID。",
        };
      const abilityIds = [...ids].sort((a, b) => a - b);
      const results = await Promise.allSettled(
        missing.map(async ({ eventType, side }) => {
          signal.throwIfAborted();
          const queryKey = [
            "profile-skill-search",
            identity,
            ref.code,
            currentFight.id,
            eventType,
            side,
            abilityIds,
          ];
          const cancel = () => {
            void cache.cancelQueries({ queryKey, exact: true });
          };
          signal.addEventListener("abort", cancel, { once: true });
          try {
            return await cache.fetchQuery({
              queryKey,
              retry: false,
              queryFn: ({ signal: requestSignal }) =>
                allEvents(
                  ref.code,
                  currentFight,
                  context,
                  eventType,
                  side,
                  requestSignal,
                  abilityIds,
                ),
            });
          } finally {
            signal.removeEventListener("abort", cancel);
          }
        }),
      );
      signal.throwIfAborted();
      const failed: string[] = [];
      results.forEach((result, index) => {
        if (result.status === "fulfilled")
          skills.push(...result.value.map(eventSkill));
        else
          failed.push(
            (missing[index].side === "friendly" ? "队友" : "敌对") +
              " " +
              eventLabels[missing[index].eventType],
          );
      });
      return {
        skills: uniqueProfileSkills(skills),
        error: failed.length
          ? "部分技能搜索失败（" + failed.join("、") + "），可重试。"
          : undefined,
      };
    },
    [authBusy, cache, currentFight, identity, ref?.code, settingsReady],
  );
  const selectionKeys = new Set([
    ...selected,
    ...[...eventOverrides.values()].map((value) => value.groupKey),
  ]);
  const required = eventTypes.flatMap((t) =>
    (["friendly", "enemy"] as const)
      .filter(
        (s) =>
          t === "Casts" ||
          (t === type && (side === "all" || s === side)) ||
          profileSkills.some(
            (skill) => skill.eventType === t && skill.side === s,
          ) ||
          [...selectionKeys].some((k) => k.startsWith(`${t}:${s}:`)),
      )
      .map((s) => ({ type: t, side: s })),
  );
  const eventQueries = useQueries({
    queries: required.map(({ type: t, side: s }) => ({
      queryKey: ["events", identity, ref?.code, currentFight?.id, t, s],
      enabled: !!contextQuery.data && !!segment && settingsReady && !authBusy,
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        allEvents(ref!.code, currentFight!, contextQuery.data!, t, s, signal),
    })),
  });
  const groupSegment = segment;
  const { allGroups, listGroups, canvasGroups, loadedEvents } = useMemo(
    () =>
      groupSegment && currentFight
        ? {
            allGroups: eventQueries.flatMap((q) =>
              groupEvents(q.data ?? [], groupSegment, currentFight),
            ),
            listGroups: eventQueries.flatMap((q) =>
              groupEvents(q.data ?? [], groupSegment, currentFight, true),
            ),
            canvasGroups: eventQueries.flatMap((q) =>
              groupEvents(q.data ?? [], groupSegment, currentFight, true, true),
            ),
            loadedEvents: eventQueries.flatMap((q) => q.data ?? []),
          }
        : { allGroups: [], listGroups: [], canvasGroups: [], loadedEvents: [] },
    [
      eventQueries[0]?.data,
      eventQueries[1]?.data,
      eventQueries[2]?.data,
      eventQueries[3]?.data,
      eventQueries[4]?.data,
      eventQueries[5]?.data,
      groupSegment,
      currentFight,
    ],
  );
  const activeGroups = useMemo(
    () => listGroups.filter((g) => g.eventType === type),
    [listGroups, type],
  );
  // Map skill-only configuration rules to each report's local actor groups
  // once as channels load. Explicit edits to a loaded group are never re-added.
  useEffect(() => {
    const fresh = new Set<string>();
    for (const event of loadedEvents) {
      const key = eventGroupKey(event);
      if (!resolvedProfileGroups.current.has(key)) fresh.add(key);
    }
    if (!fresh.size) return;
    for (const key of fresh) resolvedProfileGroups.current.add(key);
    const matched = matchingProfileGroups(loadedEvents, profileSkills);
    const additions = [...fresh].filter((key) => matched.has(key));
    if (additions.length) setSelected((old) => new Set([...old, ...additions]));
  }, [loadedEvents, profileSkills]);
  const nodes = useMemo(
    () =>
      contextQuery.data && currentFight
        ? sourceTree(activeGroups, contextQuery.data, currentFight, side)
        : [],
    [activeGroups, contextQuery.data, currentFight, side],
  );
  const filter = source
    ? (findActorNode(nodes, source) ??
      (previousSource.current?.key === source
        ? previousSource.current
        : undefined))
    : undefined;
  const actorResolutionReady =
    !!contextQuery.data &&
    eventQueries.every((query) => !!query.data && !query.isFetching);
  useEffect(() => {
    const pending = carriedActor.current;
    if (
      !pending ||
      pending.fightId !== currentFight?.id ||
      !actorResolutionReady
    )
      return;
    const next =
      findActorNode(nodes, pending.node.key) ??
      (pending.node.instance != null
        ? findActorNode(
            nodes,
            `actor:${pending.node.matches[0]?.split(":")[0]}:${pending.node.actorId}`,
          )
        : undefined);
    carriedActor.current = undefined;
    previousSource.current = next;
    setSource(next?.key ?? "");
  }, [actorResolutionReady, currentFight?.id, nodes, side]);
  const relatedKey = `${type}:${side}` as const;
  const relatedNodes = useMemo(
    () =>
      contextQuery.data && currentFight
        ? relatedActorTree(
            loadedEvents.filter(
              (event) =>
                event.eventType === type &&
                (side === "all" || event.side === side),
            ),
            contextQuery.data,
            currentFight,
            type === "Casts",
          )
        : [],
    [contextQuery.data, currentFight, loadedEvents, type, side],
  );
  const savedRelated = relatedFilters[relatedKey];
  const relatedFilter = savedRelated
    ? (findActorNode(relatedNodes, savedRelated.key) ?? savedRelated)
    : undefined;
  const browsedGroups = filterRelatedGroups(
    contextQuery.data && currentFight
      ? visibleGroups(
          activeGroups,
          side,
          filter,
          contextQuery.data,
          currentFight,
        )
      : [],
    relatedFilter,
  );
  const shown = onlyIncluded
    ? selectedEventGroups(browsedGroups, selected, eventOverrides)
    : browsedGroups;
  const showingActors = type === "Casts" && !filter;
  const actors = showingActors ? castActorRows(shown, nodes) : [];
  const skills =
    segment && currentFight ? abilityRows(shown, segment, currentFight) : [];
  const skillSections: {
    category?: BuffCategory;
    rows: typeof skills;
  }[] = type === "Buffs" ? groupBuffRows(skills) : [{ rows: skills }];
  const maxCount = Math.max(
    0,
    ...(showingActors ? actors : skills).map((row) => row.count),
  );
  const segmentStart =
    segment && currentFight
      ? Math.max(segment.startTime, currentFight.startTime)
      : 0;
  const segmentDuration =
    segment && currentFight
      ? Math.max(
          0,
          Math.min(segment.endTime, currentFight.endTime) - segmentStart,
        )
      : 0;
  const error =
    localError ||
    [fightsQuery, segmentsQuery, contextQuery, ...eventQueries].find(
      (q) => q.error,
    )?.error?.message;
  const loading = [
    fightsQuery,
    segmentsQuery,
    contextQuery,
    ...eventQueries,
  ].some((q) => q.isFetching);
  const relatedGroups = allGroups.flatMap((g) =>
    filterRelatedGroups(
      [g],
      side === "all" && g.eventType === type
        ? relatedFilter
        : relatedFilters[`${g.eventType}:${g.side}`],
    ),
  );
  const selectedGroups = selectedEventGroups(
    relatedGroups,
    selected,
    eventOverrides,
  );
  // Check the whole fight so selections outside the current filters or phase
  // remain clearable, while excluded event overrides do not enable the button.
  const hasSelection = loadedEvents.some((event) =>
    isEventIncluded(
      event,
      selectionKey(
        event.eventType,
        event.side,
        event.actor.id,
        event.ability.gameID,
      ),
      selected,
      eventOverrides,
    ),
  );
  const partialProfileSelection = useMemo(
    () => hasPartialProfileSelection(loadedEvents, selected, eventOverrides),
    [loadedEvents, selected, eventOverrides],
  );
  // The list can merge NPC instances. Build the canvas from the original groups
  // so a selected instance never appears twice or inherits another instance's ID.
  const shownEventIds = new Set(
    filterRelatedGroups(
      contextQuery.data && currentFight
        ? visibleGroups(
            canvasGroups.filter((group) => group.eventType === type),
            side,
            filter,
            contextQuery.data,
            currentFight,
          )
        : [],
      relatedFilter,
    ).flatMap((group) => group.events.map(eventKey)),
  );
  const timelineGroups = canvasGroups.flatMap((group) => {
    if (group.eventType !== type) return [];
    const events = group.events.filter((event) =>
      shownEventIds.has(eventKey(event)),
    );
    return events.length ? [{ ...group, events }] : [];
  });
  const focusedGroup = allGroups.find((group) =>
    group.events.some((event) => eventKey(event) === focusedEventId),
  );
  const focusedNoteEvent = selectedGroups
    .flatMap((group) => group.events)
    .find((event) => eventKey(event) === focusedEventId);
  const title = currentFight
    ? `${currentFight.name}${groupSegment && groupSegment.id !== "full" ? ` - ${groupSegment.name}` : ""}`
    : "";
  const nsrtNote =
    noteFormat === "NSRT" && currentFight
      ? createNSRTNote(
          { ...currentFight, ...detailedFight },
          selectedGroups,
          dynamicTimers,
          options,
        )
      : undefined;
  const note =
    selectedGroups.length && !loading && !error
      ? (nsrtNote?.text ?? formatNote(title, selectedGroups, options))
      : "";
  useEffect(() => {
    const textarea = previewText.current;
    if (
      !textarea ||
      !focusedNoteEvent ||
      !noteOpen ||
      openNavigation === "fight"
    )
      return;
    // Checkbox changes restore controlled textarea values after their handlers.
    // Locate after that restoration so changing formats/timers keeps the row.
    const frame = requestAnimationFrame(() => {
      const range = nsrtNote
        ? nsrtEventRange(
            textarea.value,
            nsrtNote.eventLines.get(eventKey(focusedNoteEvent)),
          )
        : noteEventRange(textarea.value, noteTime(focusedNoteEvent));
      if (!range) return;
      if (focusNote.current) {
        textarea.focus();
        focusNote.current = false;
      }
      textarea.setSelectionRange(range.start, range.end);
      textarea.scrollTop = Math.max(
        0,
        range.line * 21.6 - textarea.clientHeight / 2,
      );
    });
    return () => cancelAnimationFrame(frame);
  }, [focusedEventId, note, view, noteOpen, openNavigation, noteFocusRequest]);
  useEffect(() => {
    if (view === "list")
      document
        .querySelector('.skill[data-linked="true"]')
        ?.scrollIntoView({ block: "nearest" });
  }, [view, focusedEventId, type, side, source]);
  function resetFight() {
    fightDrafts.current.clear();
    timelineStates.current.clear();
    resolvedProfileGroups.current = new Set();
    if (profiles.isEmpty) setProfileSkills([]);
    carriedActor.current = undefined;
    focusNote.current = false;
    setFight(undefined);
    setSegmentId(undefined);
    setSelected(new Set());
    setEventOverrides(new Map());
    setFocusedEventId(undefined);
    setType("Casts");
    setSide("friendly");
    setOnlyIncluded(false);
    setSource("");
    setRelatedFilters({});
    previousSource.current = undefined;
    setLocalError("");
  }
  function loadReport() {
    try {
      const parsed = parseReport(input);
      void cache.cancelQueries();
      resetFight();
      setRef(parsed);
      setOpenNavigation(
        parsed.fight !== undefined || parsed.last ? undefined : "fight",
      );
      setRevision((v) => v + 1);
    } catch (e) {
      setLocalError((e as Error).message);
    }
  }
  function chooseFight(f: Fight) {
    setOpenNavigation(undefined);
    if (f.id === currentFight?.id) return;
    void cache.cancelQueries({ predicate: (q) => q.queryKey[0] !== "fights" });
    if (currentFight)
      fightDrafts.current.set(currentFight.id, {
        segmentId: segment?.id,
        type,
        side,
        onlyIncluded,
        source,
        previousSource: previousSource.current,
        relatedFilters,
        selected,
        eventOverrides,
        focusedEventId,
        profileId: profiles.library.activeId,
        profileSkills,
        resolvedProfileGroups: new Set(resolvedProfileGroups.current),
      });
    const draft = fightDrafts.current.get(f.id);
    try {
      if (draft) profiles.activate(draft.profileId);
    } catch (error) {
      setLocalError((error as Error).message);
      return;
    }
    resolvedProfileGroups.current = new Set(draft?.resolvedProfileGroups ?? []);
    setProfileSkills(
      draft?.profileSkills ?? (profiles.isEmpty ? [] : profileSkills),
    );
    const actor = filter;
    carriedActor.current = actor ? { fightId: f.id, node: actor } : undefined;
    focusNote.current = false;
    setFight(f);
    setSegmentId(draft?.segmentId);
    setType(draft?.type ?? "Casts");
    setSide(actor ? side : (draft?.side ?? "friendly"));
    setOnlyIncluded(draft?.onlyIncluded ?? false);
    setSource(actor?.key ?? draft?.source ?? "");
    previousSource.current = actor ?? draft?.previousSource;
    setRelatedFilters(draft?.relatedFilters ?? {});
    setSelected(draft?.selected ?? new Set());
    setEventOverrides(draft?.eventOverrides ?? new Map());
    setFocusedEventId(draft?.focusedEventId);
    setLocalError("");
  }
  function chooseSegment(id: string) {
    setSegmentId(id);
    setFocusedEventId(undefined);
  }
  async function persistCredentials(credentials: Credentials) {
    const version = ++authVersion.current;
    credentialDraft.current = credentials;
    setClientId(credentials.clientId);
    setSecret(credentials.clientSecret);
    setAuthBusy(true);
    setSettingsStatus("正在保存…");
    setLocalError("");
    void cache.cancelQueries();
    try {
      const result = await saveSettings(credentials);
      if (version !== authVersion.current) return;
      await cache.cancelQueries();
      cache.clear();
      setSettingsReady(true);
      setIdentity((v) => v + 1);
      setRef(undefined);
      resetFight();
      setSettingsStatus(
        result.mode === "incomplete"
          ? "已自动保存，请填写完整的 Client ID 和 Client Secret。"
          : result.mode === "custom"
            ? "已自动保存到本机，下次启动继续使用。"
            : "已恢复内置凭据。",
      );
    } catch (e) {
      if (version === authVersion.current) {
        setSettingsReady(false);
        setLocalError((e as Error).message);
        setSettingsStatus("保存失败，请重试。");
      }
    } finally {
      if (version === authVersion.current) setAuthBusy(false);
    }
  }
  function chooseActor(node?: SourceNode) {
    carriedActor.current = undefined;
    previousSource.current = node;
    setSource(node?.key ?? "");
  }
  function toggle(keys: string[], include: boolean) {
    const next = new Set(selected);
    for (const key of keys) {
      if (include) next.add(key);
      else next.delete(key);
    }
    const overrides = new Map(
      [...eventOverrides].filter(([, value]) => !keys.includes(value.groupKey)),
    );
    setSelected(next);
    setEventOverrides(overrides);
    setProfileSkills(
      updateProfileSkills(profileSkills, loadedEvents, next, overrides, keys),
    );
  }
  function skillSelection(keys: string[]) {
    const bounds =
      currentFight && segment
        ? timelineBounds(currentFight, segment)
        : undefined;
    const entries = browsedGroups
      .filter((group) => keys.includes(group.key))
      .flatMap((group) =>
        group.events
          .filter(
            (event) =>
              !event.auraOnly &&
              bounds &&
              event.time >= bounds.start &&
              event.time <= bounds.end,
          )
          .map((event) =>
            isEventIncluded(event, group.key, selected, eventOverrides),
          ),
      );
    return {
      all: entries.length > 0 && entries.every(Boolean),
      some: entries.some(Boolean),
    };
  }
  function selectEvents(
    row: TimelineRow,
    entries: TimelineEntry[],
    included: boolean,
  ) {
    const next = new Map(eventOverrides);
    for (const entry of entries)
      if (entry.selectable)
        next.set(entry.id, { groupKey: row.group.key, included });
    setEventOverrides(next);
    setProfileSkills(
      updateProfileSkills(profileSkills, loadedEvents, selected, next, [
        row.group.key,
      ]),
    );
  }
  function clearSelection() {
    try {
      profiles.activate(EMPTY_SKILL_PROFILE.id);
    } catch (error) {
      setLocalError((error as Error).message);
      return;
    }
    setSelected(new Set());
    setEventOverrides(new Map());
    setProfileSkills([]);
    setFocusedEventId(undefined);
  }
  function applyProfile(profile: SkillProfile) {
    profiles.activate(profile.id);
    setProfileSkills(profile.skills);
    setSelected(matchingProfileGroups(loadedEvents, profile.skills));
    resolvedProfileGroups.current = new Set(loadedEvents.map(eventGroupKey));
    setEventOverrides(new Map());
    setRelatedFilters({});
    setFocusedEventId(undefined);
  }
  function removeProfileSkill(profile: SkillProfile, skill: ProfileSkill) {
    profiles.removeSkill(profile.id, skill);
    if (profile.id !== profiles.active.id) return;
    const key = profileSkillKey(skill);
    setProfileSkills((previous) =>
      previous.filter((entry) => profileSkillKey(entry) !== key),
    );
    setSelected(
      (previous) =>
        new Set(
          [...previous].filter(
            (group) => !groupMatchesProfileSkill(group, skill),
          ),
        ),
    );
    setEventOverrides(
      (previous) =>
        new Map(
          [...previous].filter(
            ([, override]) =>
              !groupMatchesProfileSkill(override.groupKey, skill),
          ),
        ),
    );
    setFocusedEventId(undefined);
  }
  function addProfileSkills(profile: SkillProfile, skills: ProfileSkill[]) {
    const added = profiles.addSkills(profile.id, skills);
    if (!added.length) return;
    if (profile.id !== profiles.active.id) return;
    setProfileSkills((previous) =>
      uniqueProfileSkills([...previous, ...added]),
    );
    const matching = matchingProfileGroups(loadedEvents, added);
    setSelected((previous) => new Set([...previous, ...matching]));
    setEventOverrides(
      (previous) =>
        new Map(
          [...previous].filter(
            ([, override]) =>
              !added.some((skill) =>
                groupMatchesProfileSkill(override.groupKey, skill),
              ),
          ),
        ),
    );
  }
  async function copy() {
    try {
      unwrap(await desktop().copyNote(note));
    } catch {
      setLocalError("剪贴板不可用，请在预览框中全选并手动复制。");
    }
  }
  async function download() {
    try {
      unwrap(await desktop().saveNote(filename(`${title}.txt`), note));
    } catch (error) {
      setLocalError((error as Error).message);
    }
  }
  function retry() {
    setLocalError("");
    void cache.invalidateQueries({
      predicate: (q) => q.state.status === "error",
    });
  }
  return (
    <div className="app-shell" ref={shell}>
      <header>
        <div className="brand" aria-label="WCL2NOTE">
          <span className="brand-icon">
            <Activity size={21} />
          </span>
          <b>
            WCL2<span>NOTE</span>
          </b>
        </div>
        <form
          className="report-input"
          onSubmit={(e) => {
            e.preventDefault();
            loadReport();
          }}
        >
          <FileText size={16} />
          <input
            aria-label="报告链接"
            placeholder="粘贴 Warcraft Logs 报告链接或报告编号"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            disabled={authBusy || !settingsReady}
          />
          <button className="primary" disabled={authBusy || !settingsReady}>
            加载报告
            <ArrowRight size={15} />
          </button>
        </form>
        <div className="header-right">
          <div className="header-update-slot">
            <UpdateActionButton updates={updates} />
          </div>
          <button
            className={
              settings ? "settings-trigger active" : "settings-trigger"
            }
            onClick={() => setSettings(!settings)}
            aria-label="设置"
            title="设置"
            aria-haspopup="dialog"
            aria-expanded={settings}
          >
            <Settings size={18} />
          </button>
        </div>
      </header>
      <main>
        {error && (
          <div role="alert" className="error">
            <span>{error}</span>
            <button onClick={retry}>重试</button>
          </div>
        )}
        <FightNavigation
          key={`${identity}:${ref?.code}:${revision}`}
          fights={fights}
          currentFight={currentFight}
          reportStart={fightsQuery.data?.startTime ?? 0}
          segments={availableSegments}
          segment={segment}
          open={openNavigation}
          loading={fightsQuery.isFetching}
          hasReport={!!ref}
          onOpen={setOpenNavigation}
          onFight={chooseFight}
          onSegment={chooseSegment}
        />
        <div
          className={`workspace${noteOpen ? "" : " note-collapsed"}`}
          hidden={openNavigation === "fight"}
        >
          <div className="analysis-workspace">
            <section
              className="ability-toolbar analysis-controls"
              aria-label="日志筛选与视图"
            >
              <div className="analysis-row analysis-primary">
                <div className="analysis-actor">
                  <ActorPicker
                    key={`${ref?.code}:${currentFight?.id}:${side}`}
                    nodes={nodes}
                    selected={filter}
                    allLabel={
                      side === "all"
                        ? "所有单位"
                        : side === "enemy"
                          ? "所有敌对"
                          : "所有队友"
                    }
                    onSelect={chooseActor}
                  />
                  <div
                    className="segmented-control side-toggle"
                    role="group"
                    aria-label="阵营"
                  >
                    {(["all", "friendly", "enemy"] as const).map((s) => (
                      <button
                        key={s}
                        aria-pressed={side === s}
                        className={side === s ? "active" : ""}
                        onClick={() => {
                          setSide(s);
                          chooseActor();
                        }}
                      >
                        {s === "all" ? "全部" : s === "enemy" ? "敌对" : "队友"}
                      </button>
                    ))}
                  </div>
                </div>
                <div
                  className="segmented-control view-toggle"
                  role="group"
                  aria-label="工作区视图"
                >
                  <button
                    className={view === "list" ? "active" : ""}
                    aria-label="图表视图"
                    title="图表：技能列表"
                    aria-pressed={view === "list"}
                    onClick={() => setView("list")}
                  >
                    <List size={16} />
                    图表
                  </button>
                  <button
                    className={view === "timeline" ? "active" : ""}
                    aria-label="时间轴视图"
                    title="时间轴"
                    aria-pressed={view === "timeline"}
                    onClick={() => setView("timeline")}
                  >
                    <ChartGantt size={16} />
                    时间轴
                  </button>
                </div>
              </div>
              <div className="analysis-row analysis-events">
                <div className="tabs" role="tablist" aria-label="事件类型">
                  {eventTypes.map((t) => (
                    <button
                      role="tab"
                      aria-selected={type === t}
                      key={t}
                      className={type === t ? "active" : ""}
                      onClick={() => setType(t)}
                    >
                      {eventLabels[t]}
                    </button>
                  ))}
                </div>
                <div
                  className="segmented-control event-display-toggle"
                  role="group"
                  aria-label="显示范围"
                >
                  {([false, true] as const).map((included) => (
                    <button
                      key={String(included)}
                      className={onlyIncluded === included ? "active" : ""}
                      aria-pressed={onlyIncluded === included}
                      onClick={() => {
                        setOnlyIncluded(included);
                        setFocusedEventId(undefined);
                      }}
                    >
                      {included ? "已加入 Note" : "全部事件"}
                    </button>
                  ))}
                </div>
              </div>
              <div className="analysis-row event-filter">
                <ActorPicker
                  key={`${ref?.code}:${currentFight?.id}:${relatedKey}`}
                  label={type === "Casts" ? "Target" : "Source"}
                  nodes={relatedNodes}
                  selected={relatedFilter}
                  allLabel={type === "Casts" ? "所有目标" : "所有来源"}
                  onSelect={(node) =>
                    setRelatedFilters((previous) => ({
                      ...previous,
                      [relatedKey]: node,
                    }))
                  }
                />
                <SkillProfileControls
                  profiles={profiles}
                  skills={profileSkills}
                  matched={
                    new Set(
                      loadedEvents.map((event) =>
                        profileSkillKey(eventSkill(event)),
                      ),
                    )
                  }
                  loadedChannels={
                    new Set(
                      required
                        .filter(
                          (_, index) =>
                            eventQueries[index]?.isSuccess &&
                            !eventQueries[index]?.isFetching,
                        )
                        .map((channel) => channel.type + ":" + channel.side),
                    )
                  }
                  hasFight={!!currentFight}
                  canClear={
                    hasSelection || !profiles.isEmpty || !!profileSkills.length
                  }
                  partialEvents={partialProfileSelection}
                  onApply={applyProfile}
                  onRemoveSkill={removeProfileSkill}
                  onAddSkills={addProfileSkills}
                  loadSkills={loadProfileSkills}
                  onClear={clearSelection}
                  onError={setLocalError}
                />
              </div>
            </section>
            <section className="panel abilities" hidden={view === "timeline"}>
              <div className="ability-content">
                <div className="skill-list" data-event-type={type}>
                  <div className="skill-head">
                    <span>{showingActors ? "Actor" : "技能"}</span>
                    <span>次数</span>
                    <span>{type === "Casts" ? "CPM" : "覆盖率"}</span>
                  </div>
                  {loading ? (
                    <div className="empty">
                      <LoaderCircle className="spin" />
                      <p>正在加载完整技能事件…</p>
                      <button
                        onClick={() => {
                          void cache.cancelQueries();
                        }}
                      >
                        取消
                      </button>
                    </div>
                  ) : showingActors && actors.length ? (
                    actors.map(({ node, count }) => (
                      <button
                        type="button"
                        className="actor-row"
                        key={node.key}
                        onClick={() => chooseActor(node)}
                        title={`查看 ${node.name} 的施法 · Actor ID: ${node.actorId}`}
                      >
                        <span className="actor-identity">
                          <ActorIcon node={node} />
                          <span
                            className="skill-name"
                            style={{
                              color: actorTextColors[node.className ?? ""],
                            }}
                          >
                            {node.name}
                          </span>
                        </span>
                        <MetricBar
                          value={count}
                          max={maxCount}
                          background={actorTextColors[node.className ?? ""]}
                        />
                        <b>
                          {castsPerMinute(count, segmentDuration).toFixed(1)}
                        </b>
                      </button>
                    ))
                  ) : !showingActors && skills.length ? (
                    skillSections.map(({ category, rows }) => (
                      <Fragment key={category?.id ?? "all"}>
                        {category && (
                          <h3
                            className="buff-category"
                            title={category.wclName ?? undefined}
                          >
                            <span>{category.name}</span>
                            <small>{rows.length}</small>
                          </h3>
                        )}
                        {rows.map((row) => {
                          const selection = skillSelection(row.keys);
                          return (
                            <label
                              className="skill"
                              key={row.ability.gameID}
                              data-ability-id={row.ability.gameID}
                              data-buff-category={category?.id}
                              data-linked={
                                focusedGroup?.ability.gameID ===
                                  row.ability.gameID &&
                                focusedGroup.eventType === type &&
                                (side === "all" || focusedGroup.side === side)
                              }
                            >
                              <span>
                                <input
                                  type="checkbox"
                                  checked={selection.all}
                                  ref={(input) => {
                                    if (input)
                                      input.indeterminate =
                                        selection.some && !selection.all;
                                  }}
                                  disabled={!row.keys.length}
                                  onChange={() =>
                                    toggle(row.keys, !selection.all)
                                  }
                                />
                                <GameIcon
                                  icon={row.ability.icon}
                                  spellId={row.ability.gameID}
                                />
                                <span
                                  className="skill-name"
                                  title={`${row.ability.name} · 技能 ID: ${row.ability.gameID}`}
                                  style={{
                                    color: spellSchool(row.ability.type).color,
                                  }}
                                >
                                  {row.ability.name}
                                </span>
                              </span>
                              {type === "Casts" ? (
                                <>
                                  <MetricBar
                                    value={row.count}
                                    max={maxCount}
                                    background={spellSchoolBackground(
                                      row.ability.type,
                                    )}
                                  />
                                  <b>{row.cpm.toFixed(1)}</b>
                                </>
                              ) : (
                                <>
                                  <b>{row.count}</b>
                                  <UptimeBar
                                    value={row.uptime}
                                    intervals={row.uptimeIntervals}
                                    start={segmentStart}
                                    duration={segmentDuration}
                                    background={spellSchoolBackground(
                                      row.ability.type,
                                    )}
                                  />
                                </>
                              )}
                            </label>
                          );
                        })}
                      </Fragment>
                    ))
                  ) : (
                    <div className="empty">
                      <Activity />
                      {!ref ? (
                        <>
                          <p>
                            在顶部加载报告，选择战斗与技能，
                            <br />
                            生成可直接使用的团队笔记。
                          </p>
                        </>
                      ) : (
                        <p>
                          {currentFight
                            ? onlyIncluded
                              ? "当前筛选没有已加入 Note 的事件"
                              : "当前来源没有技能事件"
                            : "选择战斗，查看技能事件"}
                        </p>
                      )}
                    </div>
                  )}
                </div>
              </div>
              <div className="panel-foot">
                <span>
                  {showingActors
                    ? `${actors.length} 个 actor`
                    : `${skills.length} 组技能`}
                </span>
                <span>已选 {selectedGroups.length} 组 · 跨标签保留</span>
              </div>
            </section>
            {view === "timeline" && openNavigation !== "fight" && (
              <Timeline
                key={`${ref?.code}:${currentFight?.id}:${segment?.id}`}
                fight={currentFight}
                segment={segment}
                segments={availableSegments}
                groups={timelineGroups}
                eventType={type}
                side={side}
                onlyIncluded={onlyIncluded}
                includedEventCount={selectedGroups.reduce(
                  (count, group) => count + group.events.length,
                  0,
                )}
                exportableEventIds={
                  new Set(
                    relatedGroups.flatMap((group) =>
                      group.events.map(eventKey),
                    ),
                  )
                }
                selected={selected}
                overrides={eventOverrides}
                focusedId={focusedEventId}
                onFocus={setFocusedEventId}
                loading={loading}
                error={error}
                noteFormat={noteFormat}
                initialState={
                  currentFight
                    ? timelineStates.current.get(currentFight.id)
                    : undefined
                }
                onRemember={(state) => {
                  if (currentFight)
                    timelineStates.current.set(currentFight.id, state);
                }}
                onSelectEvents={selectEvents}
                onLocateNote={() => {
                  focusNote.current = true;
                  setNoteOpen(true);
                  setNoteFocusRequest((request) => request + 1);
                }}
              />
            )}
          </div>
          <section className="panel preview" hidden={!noteOpen}>
            <div className="panel-heading">
              <h2>Note 预览</h2>
              <div
                className="segmented-control segmented-control--compact note-format"
                role="group"
                aria-label="Note 格式"
              >
                {(["MRT", "NSRT"] as const).map((format) => (
                  <button
                    key={format}
                    aria-pressed={noteFormat === format}
                    onClick={() => setNoteFormat(format)}
                  >
                    {format}
                  </button>
                ))}
              </div>
              <button
                className="icon-button"
                aria-label="收起 Note 预览"
                title="收起 Note 预览"
                aria-expanded={noteOpen}
                onClick={() => setNoteOpen(false)}
              >
                <PanelRightClose size={16} />
              </button>
            </div>
            <div className="options" role="group" aria-label="Note 选项">
              {(
                [
                  ["friendly", "友方来源"],
                  ["enemy", "敌方来源"],
                  ["simplify", "友方简化"],
                ] as const
              ).map(([key, label]) => (
                <label key={key}>
                  <input
                    type="checkbox"
                    checked={options[key]}
                    onChange={(event) =>
                      setOptions({ ...options, [key]: event.target.checked })
                    }
                  />
                  {label}
                </label>
              ))}
              {noteFormat === "NSRT" && (
                <label className="dynamic-timer-option">
                  <input
                    type="checkbox"
                    aria-label="动态计时器"
                    aria-describedby="dynamic-timer-tooltip"
                    checked={dynamicTimers}
                    onChange={(event) => setDynamicTimers(event.target.checked)}
                  />
                  动态计时器
                  <span id="dynamic-timer-tooltip" role="tooltip">
                    使用与战斗事件时间点关联的动态计时器
                  </span>
                </label>
              )}
              {noteFormat === "MRT" && (
                <label>
                  <input
                    type="checkbox"
                    checked={options.icon}
                    onChange={(event) =>
                      setOptions({ ...options, icon: event.target.checked })
                    }
                  />
                  技能图标
                </label>
              )}
            </div>
            <div className="note-wrap">
              <div className="note-label">
                <i />
                生成的团队笔记
              </div>
              <textarea
                ref={previewText}
                aria-label="Note 预览"
                spellCheck={false}
                readOnly
                value={note}
                placeholder={
                  noteFormat === "NSRT"
                    ? "勾选技能后，时间轴会显示在这里。\n\nph:1;time:35;tag:角色名;spellid:31821;"
                    : "勾选技能后，时间轴会显示在这里。\n\n{time:00:35.0} 技能名称"
                }
              />
            </div>
            <div className="export-actions">
              <button
                className="primary"
                onClick={() => void copy()}
                disabled={!note}
              >
                <Clipboard size={16} />
                复制笔记
              </button>
              <button
                onClick={() => void download()}
                disabled={!note}
                aria-label="保存 txt"
                title="另存为 UTF-8 文本"
              >
                <Download size={17} />
              </button>
            </div>
          </section>
          {!noteOpen && (
            <aside className="panel note-rail" aria-label="Note 已收起">
              <button
                className="icon-button"
                aria-label="展开 Note 预览"
                title="展开 Note 预览"
                aria-expanded={false}
                onClick={() => setNoteOpen(true)}
              >
                <PanelRightOpen size={16} />
              </button>
              <span>Note</span>
            </aside>
          )}
        </div>
      </main>
      <dialog
        ref={settingsDialog}
        className="settings"
        aria-labelledby="settings-title"
        onCancel={() => setSettings(false)}
        onClose={() => setSettings(false)}
      >
        <div className="section-heading">
          <h2 id="settings-title">设置</h2>
          <button
            className="icon-button"
            onClick={() => setSettings(false)}
            aria-label="关闭设置"
          >
            <X size={16} />
          </button>
        </div>
        <section
          className="settings-credentials"
          aria-labelledby="credentials-title"
        >
          <div className="section-heading">
            <h3 id="credentials-title">Warcraft Logs 凭据</h3>
            <span className="credential-mode">
              {!clientId && !secret
                ? "使用内置凭据"
                : clientId.trim() && secret.trim()
                  ? "使用自定义凭据"
                  : "凭据待补全"}
            </span>
          </div>
          <p className="settings-description">
            留空使用内置凭据，修改后自动保存。
          </p>
          <form onSubmit={(e) => e.preventDefault()}>
            <label>
              Client ID
              <input
                value={clientId}
                onChange={(e) =>
                  void persistCredentials({
                    ...credentialDraft.current,
                    clientId: e.target.value,
                  })
                }
                autoComplete="off"
              />
            </label>
            <div className="settings-field">
              <label htmlFor="settings-client-secret">Client Secret</label>
              <span className="secret-input">
                <input
                  id="settings-client-secret"
                  type={secretVisible ? "text" : "password"}
                  value={secret}
                  onChange={(e) =>
                    void persistCredentials({
                      ...credentialDraft.current,
                      clientSecret: e.target.value,
                    })
                  }
                  autoComplete="off"
                />
                <button
                  type="button"
                  aria-label={
                    secretVisible ? "隐藏 Client Secret" : "显示 Client Secret"
                  }
                  aria-pressed={secretVisible}
                  onClick={() => setSecretVisible((visible) => !visible)}
                >
                  {secretVisible ? "隐藏" : "显示"}
                </button>
              </span>
            </div>
          </form>
          <div className="settings-save-row">
            <p className="settings-status" aria-live="polite">
              {settingsStatus || "凭据修改后自动保存。"}
            </p>
            <button
              type="button"
              disabled={authBusy}
              onClick={() =>
                void persistCredentials({ clientId: "", clientSecret: "" })
              }
            >
              恢复默认
            </button>
          </div>
          {settings && error && (
            <p className="settings-error" role="alert">
              {error}
            </p>
          )}
          <button
            className="link-button"
            onClick={() =>
              void desktop()
                .openCredentialsPage()
                .then(unwrap)
                .catch((error: Error) => setLocalError(error.message))
            }
          >
            申请 WCL API 凭据 ↗
          </button>
        </section>
        <UpdatePanel updates={updates} version={version} />
        <footer className="settings-meta">
          <span>WCL2NOTE</span>
          <span>Ye11ow</span>
        </footer>
      </dialog>
    </div>
  );
}
