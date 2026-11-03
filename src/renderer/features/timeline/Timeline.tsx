import {
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent,
  type CSSProperties,
} from "react";
import { createPortal } from "react-dom";
import { ConfigProvider, Slider, theme } from "antd";
import {
  ChevronDown,
  ChevronRight,
  Eye,
  EyeOff,
  Minus,
  Plus,
  RotateCcw,
  X,
} from "lucide-react";
import {
  duration,
  type Fight,
  type EventType,
  type Group,
  type Segment,
  type Side,
  type SideFilter,
  type Actor,
  type TimelineEvent,
} from "../../../domain/model";
import {
  clampWindow,
  defaultTimelineWindow,
  preciseTime,
  timelineBounds,
  timelineRows,
  timelineInterval,
  timelineTicks,
  timelineMediumTicks,
  timelineMinorTicks,
  visibleTimelinePhases,
  zoomWindow,
  type EventOverrides,
  type TimeWindow,
  type TimelineEntry,
  type TimelineRow,
} from "../../../domain/timeline";
import { ActorIcon, GameIcon } from "../../components/GameIcon";
import { spellSchool, spellSchoolBackground } from "../../../domain/casts";
import { actorClass } from "../../../domain/actor";
import { actorTextColors } from "../../components/ActorPicker";
import { useKeyboardFocus } from "../../hooks/useKeyboardFocus";
import { wowheadSpellLink } from "../../integrations/wowhead-links";

function ActorName({ actor, instance }: { actor?: Actor; instance?: number }) {
  return (
    <span
      className="timeline-actor-name"
      style={{
        color: actor ? actorTextColors[actorClass(actor.subType)] : undefined,
      }}
    >
      {actor?.name ?? "日志未提供"}
      {instance != null ? ` ${instance}` : ""}
    </span>
  );
}

function eventActor(event: TimelineEvent, kind: "source" | "target") {
  const related = event[kind];
  if (related) return related;
  if ((kind === "source") === (event.eventType === "Casts"))
    return { actor: event.actor, instance: event.instance };
  return undefined;
}

const labels = { Casts: "施法", Buffs: "Buff", Debuffs: "Debuff" };
const intervalLabels = {
  Casts: "开始时间 – 完成时间",
  Buffs: "获得时间 – 移除时间",
  Debuffs: "施加时间 – 移除时间",
};
export interface TimelineViewState {
  segmentId?: string;
  window?: TimeWindow;
  hidden: Set<string>;
  collapsed: Set<string>;
  regionVisibility: Map<string, boolean>;
  scrollTop: number;
}
interface Props {
  fight?: Fight;
  segment?: Segment;
  segments: Segment[];
  groups: Group[];
  eventType: EventType;
  side: SideFilter;
  onlyIncluded: boolean;
  includedEventCount: number;
  exportableEventIds: ReadonlySet<string>;
  selected: ReadonlySet<string>;
  overrides: EventOverrides;
  focusedId?: string;
  loading: boolean;
  error?: string;
  noteFormat: "MRT" | "NSRT";
  initialState?: TimelineViewState;
  onRemember: (state: TimelineViewState) => void;
  onFocus: (id?: string) => void;
  onSelectEvents: (
    row: TimelineRow,
    entries: TimelineEntry[],
    included: boolean,
  ) => void;
  onLocateNote: () => void;
}

export function Timeline(props: Props) {
  const panel = useKeyboardFocus<HTMLElement>();
  const { fight, focusedId, onFocus, onSelectEvents, onlyIncluded } = props;
  const bounds =
    fight && props.segment
      ? timelineBounds(fight, props.segment)
      : {
          start: 0,
          end: Math.max(1, (fight?.endTime ?? 1) - (fight?.startTime ?? 0)),
        };
  const [viewport, setViewport] = useState(
    props.initialState?.segmentId === props.segment?.id
      ? props.initialState?.window
      : undefined,
  );
  const defaultWindow =
    props.segment && props.segment.id !== "full"
      ? bounds
      : defaultTimelineWindow(bounds);
  const view = viewport
    ? clampWindow(
        viewport,
        bounds,
        Math.min(2000, viewport.end - viewport.start),
      )
    : defaultWindow;
  const [hidden, setHidden] = useState(
    props.initialState?.hidden ?? new Set<string>(),
  );
  const [collapsed, setCollapsed] = useState(
    props.initialState?.collapsed ?? new Set<string>(),
  );
  const [regionVisibility, setRegionVisibility] = useState(
    props.initialState?.regionVisibility ?? new Map<string, boolean>(),
  );
  const [tooltip, setTooltip] = useState<{
    entry: TimelineEntry;
    x: number;
    y: number;
  }>();
  const viewportArea = useRef<HTMLDivElement>(null);
  const rulerScale = useRef<HTMLDivElement>(null);
  const scrollTop = useRef(props.initialState?.scrollTop ?? 0);
  const [laneWidth, setLaneWidth] = useState(800);
  const [cursor, setCursor] = useState<{ time: number; left: number }>();
  const [drag, setDrag] = useState<{
    start: number;
    end: number;
    x: number;
    left: number;
    width: number;
    mode: "zoom" | "pan";
    window: TimeWindow;
  }>();
  const rows = useMemo(
    () =>
      timelineRows(
        props.groups,
        props.selected,
        props.overrides,
        bounds,
        props.exportableEventIds,
      ),
    [
      props.groups,
      props.selected,
      props.overrides,
      bounds.start,
      bounds.end,
      props.exportableEventIds,
    ],
  );
  const focusedRow = rows.find((row) =>
    row.entries.some((entry) => entry.id === focusedId),
  );
  const focused = focusedRow?.entries.find((entry) => entry.id === focusedId);
  const shown = rows
    .filter((row) => !hidden.has(row.id))
    .map((row) =>
      onlyIncluded
        ? { ...row, entries: row.entries.filter((entry) => entry.included) }
        : row,
    )
    .filter((row) => row.entries.length > 0);
  const sections: {
    id: string;
    name: string;
    side: Side;
    rows: TimelineRow[];
  }[] = [];
  for (const category of ["enemy-casts", "enemy-other", "friendly"] as const) {
    const side = category === "friendly" ? "friendly" : "enemy";
    const sideRows = shown.filter(
      (row) =>
        row.group.side === side &&
        (side === "friendly" ||
          (row.group.eventType === "Casts") === (category === "enemy-casts")),
    );
    for (const row of sideRows) {
      const id = `${category}:${row.group.sourceKey}`;
      let section = sections.find((item) => item.id === id);
      if (!section) {
        section = {
          id,
          name: row.group.actor.name,
          side,
          rows: [],
        };
        sections.push(section);
      }
      section.rows.push(row);
    }
  }
  const regions = (
    props.side === "all" ? (["enemy", "friendly"] as const) : [props.side]
  ).map((side) => ({
    id: `${props.eventType}:${side}`,
    side,
    name: `${side === "enemy" ? "敌对" : "队友"}${labels[props.eventType]}`,
    sections: sections.filter((section) => section.side === side),
    count: shown.filter((row) => row.group.side === side).length,
  }));
  const span = view.end - view.start;
  const tickCount = Math.max(2, Math.floor(laneWidth / 24));
  const ticks = timelineTicks(view, tickCount);
  const labeledTicks = new Set(
    timelineTicks(view, Math.max(2, Math.floor(laneWidth / 44))),
  );
  const mediumTicks = timelineMediumTicks(view, tickCount);
  const minorTicks = timelineMinorTicks(view, tickCount);
  const currentWindow = useRef(view);
  useLayoutEffect(() => {
    currentWindow.current = view;
  });
  const overviewMarks = Object.fromEntries(
    [
      bounds.start,
      ...timelineTicks(bounds, Math.max(2, Math.floor(laneWidth / 140))).filter(
        (time) =>
          Math.min(time - bounds.start, bounds.end - time) >
          ((bounds.end - bounds.start) * 56) / laneWidth,
      ),
      bounds.end,
    ].map((time) => [
      time,
      {
        label: duration(time),
        style: {
          transform:
            time === bounds.start
              ? "none"
              : time === bounds.end
                ? "translateX(-100%)"
                : "translateX(-50%)",
        },
      },
    ]),
  );
  // Ant Design 将这些约束透传给底层滑块，避免手柄交叉或拖出零宽视窗。
  const overviewConstraints = {
    allowCross: false,
    pushable: Math.min(2000, span),
  };
  const percent = (time: number) => `${((time - view.start) / span) * 100}%`;
  const origin = props.segment?.relative
    ? props.segment.startTime
    : (fight?.startTime ?? 0);
  const visiblePhases = useMemo(
    () => visibleTimelinePhases(props.segments, origin, view),
    [props.segments, origin, view.start, view.end],
  );
  const zoomed = view.start > bounds.start || view.end < bounds.end;
  const atDefault =
    view.start === defaultWindow.start && view.end === defaultWindow.end;
  const ready =
    !!fight &&
    props.segments.length > 0 &&
    (rows.length > 0 || (!props.loading && !props.error));
  const showCanvas = ready && rows.length > 0;
  const showRegionHeaders = props.side === "all";
  function regionIsCollapsed(id: string) {
    return showRegionHeaders && (regionVisibility.get(id) ?? false);
  }
  function sectionIsCollapsed(id: string) {
    return collapsed.has(id);
  }
  function remember() {
    props.onRemember({
      segmentId: props.segment?.id,
      window: viewport,
      hidden,
      collapsed,
      regionVisibility,
      scrollTop: scrollTop.current,
    });
  }
  useLayoutEffect(remember);
  useLayoutEffect(() => {
    const scale = rulerScale.current;
    if (!scale) return;
    const update = () => setLaneWidth(scale.clientWidth);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(scale);
    const canvas =
      viewportArea.current?.querySelector<HTMLDivElement>(".timeline-canvas");
    if (canvas) canvas.scrollTop = scrollTop.current;
    return () => observer.disconnect();
  }, [showCanvas]);
  function setWindow(window: TimeWindow) {
    setViewport(
      clampWindow(
        window,
        bounds,
        Math.max(1, Math.min(2000, window.end - window.start)),
      ),
    );
    setTooltip(undefined);
    setCursor(undefined);
  }
  useLayoutEffect(() => {
    const area = viewportArea.current;
    if (!area) return;
    const wheel = (event: WheelEvent) => {
      if (!event.shiftKey || event.ctrlKey || event.metaKey) return;
      const delta =
        Math.abs(event.deltaX) > Math.abs(event.deltaY)
          ? event.deltaX
          : event.deltaY;
      if (!delta) return;
      event.preventDefault();
      const width = Math.max(1, rulerScale.current?.clientWidth ?? 800);
      const pixels =
        delta *
        (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? width : 1);
      const window = currentWindow.current;
      const offset = (pixels / width) * (window.end - window.start);
      setWindow({ start: window.start + offset, end: window.end + offset });
    };
    area.addEventListener("wheel", wheel, { passive: false });
    return () => area.removeEventListener("wheel", wheel);
  }, [showCanvas, bounds.end]);
  function toggle(
    set: Set<string>,
    id: string,
    update: (set: Set<string>) => void,
  ) {
    const next = new Set(set);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    update(next);
  }
  function pointerTime(event: PointerEvent<HTMLDivElement>) {
    const box = rulerScale.current!.getBoundingClientRect();
    return Math.round(
      view.start +
        Math.max(0, Math.min(1, (event.clientX - box.left) / box.width)) * span,
    );
  }
  function startDrag(
    event: PointerEvent<HTMLDivElement>,
    mode: "zoom" | "pan",
  ) {
    if (
      event.defaultPrevented ||
      event.button !== 0 ||
      (event.target as HTMLElement).closest(
        "button, a, input, .timeline-cast, .timeline-aura",
      )
    )
      return;
    setTooltip(undefined);
    onFocus(undefined);
    viewportArea.current
      ?.querySelector<HTMLDivElement>(".timeline-canvas")
      ?.focus({ preventScroll: true });
    const box = rulerScale.current!.getBoundingClientRect();
    if (event.clientX < box.left || event.clientX > box.right) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    const time = pointerTime(event);
    const area = viewportArea.current!.getBoundingClientRect();
    setDrag({
      start: time,
      end: time,
      x: event.clientX,
      left: box.left - area.left,
      width: box.width,
      mode,
      window: view,
    });
  }
  function finishDrag(event: PointerEvent<HTMLDivElement>) {
    if (!drag) return;
    const end = pointerTime(event);
    if (
      drag.mode === "zoom" &&
      Math.abs(event.clientX - drag.x) >= 5 &&
      Math.abs(end - drag.start) >= 2000
    )
      setWindow({
        start: Math.min(drag.start, end),
        end: Math.max(drag.start, end),
      });
    setDrag(undefined);
  }
  function phaseLines() {
    return visiblePhases
      .filter((phase) => phase.time >= view.start)
      .map((phase) => (
        <span
          key={phase.id}
          className="timeline-phase-line"
          style={{ left: percent(phase.time) }}
          aria-hidden="true"
        />
      ));
  }
  function movePointer(event: PointerEvent<HTMLDivElement>) {
    if (drag) {
      if (drag.mode === "pan") {
        const offset =
          (-(event.clientX - drag.x) / drag.width) *
          (drag.window.end - drag.window.start);
        setWindow({
          start: drag.window.start + offset,
          end: drag.window.end + offset,
        });
      } else setDrag({ ...drag, end: pointerTime(event) });
    } else {
      const box = rulerScale.current!.getBoundingClientRect();
      if (event.clientX < box.left || event.clientX > box.right) {
        setCursor(undefined);
        return;
      }
      const area = viewportArea.current!.getBoundingClientRect();
      setCursor({
        time: pointerTime(event),
        left: event.clientX - area.left,
      });
    }
  }
  function tooltipHandlers(entry: TimelineEntry) {
    const show = (event: PointerEvent<HTMLElement>) => {
      if ((event.target as Element).closest(".timeline-marker")) {
        setTooltip(undefined);
        return;
      }
      if (!drag) setTooltip({ entry, x: event.clientX, y: event.clientY });
    };
    return {
      onPointerEnter: show,
      onPointerMove: show,
      onPointerLeave: () => setTooltip(undefined),
      onFocus: (event: React.FocusEvent<HTMLElement>) => {
        if ((event.target as Element).closest(".timeline-marker")) {
          setTooltip(undefined);
          return;
        }
        const box = event.currentTarget.getBoundingClientRect();
        setTooltip({ entry, x: box.left, y: box.bottom });
      },
      onBlur: () => setTooltip(undefined),
    };
  }
  return (
    <section
      ref={panel}
      className="panel timeline-panel"
      aria-label="可视化时间轴"
      onScrollCapture={(event) => {
        setTooltip(undefined);
        setCursor(undefined);
        const target = event.target as HTMLElement;
        if (target.classList.contains("timeline-canvas")) {
          scrollTop.current = target.scrollTop;
          remember();
        }
      }}
    >
      {tooltip &&
        createPortal(
          <div
            id="timeline-event-tooltip"
            role="tooltip"
            className="timeline-event-tooltip"
            style={{
              left: Math.max(
                8,
                Math.min(tooltip.x + 14, window.innerWidth - 290),
              ),
              top: Math.max(
                8,
                Math.min(tooltip.y + 18, window.innerHeight - 90),
              ),
            }}
          >
            <strong
              style={{
                color: spellSchool(tooltip.entry.event.ability.type).color,
              }}
            >
              {tooltip.entry.event.ability.name}
            </strong>
            <span>
              {preciseTime(timelineInterval(tooltip.entry.event).start)} –{" "}
              {preciseTime(timelineInterval(tooltip.entry.event).end)}
            </span>
          </div>,
          document.body,
        )}
      <div className="timeline-navigation" role="group" aria-label="时间轴导航">
        {fight && (
          <div className="timeline-overview">
            <ConfigProvider
              theme={{
                algorithm: theme.darkAlgorithm,
                token: {
                  colorPrimary: "#66d5bd",
                  colorBgElevated: "#16212c",
                  colorText: "#e2eaf1",
                  colorTextDescription: "#9bafbf",
                  fontFamily: '"Segoe UI", "Microsoft YaHei UI", sans-serif',
                  fontSize: 11,
                },
                components: {
                  Slider: {
                    railBg: "#344553",
                    railHoverBg: "#455c6e",
                    trackBg: "rgb(102 213 189 / 18%)",
                    trackHoverBg: "rgb(102 213 189 / 24%)",
                    handleColor: "#66d5bd",
                    handleActiveColor: "#88e2cd",
                  },
                },
              }}
            >
              <Slider
                {...overviewConstraints}
                className="timeline-overview-slider"
                range={{ draggableTrack: true }}
                min={bounds.start}
                max={bounds.end}
                step={1}
                value={[view.start, view.end]}
                marks={overviewMarks}
                ariaLabelForHandle={["时间轴范围起点", "时间轴范围终点"]}
                ariaValueTextFormatterForHandle={duration}
                // 保持关闭 Portal 提示，范围时间由拖柄上方的内联标注显示。
                tooltip={{ open: false, formatter: null }}
                onChange={([start, end]: number[]) => setWindow({ start, end })}
              />
            </ConfigProvider>
            <output
              aria-label="时间轴可见范围"
              style={
                {
                  "--range-start": `${((view.start - bounds.start) / (bounds.end - bounds.start)) * 100}%`,
                  "--range-end": `${((view.end - bounds.start) / (bounds.end - bounds.start)) * 100}%`,
                } as CSSProperties
              }
            >
              <span className="timeline-range-start">
                {duration(view.start)}
              </span>
              <span className="timeline-range-separator"> – </span>
              <span className="timeline-range-end">{duration(view.end)}</span>
            </output>
          </div>
        )}
        <div className="timeline-tools">
          <div
            className="timeline-zoom-tools"
            role="group"
            aria-label="时间轴缩放"
          >
            <button
              aria-label="放大时间轴"
              disabled={
                !ready || span <= Math.min(2000, bounds.end - bounds.start)
              }
              onClick={() => setWindow(zoomWindow(view, bounds, 0.5))}
            >
              <Plus size={15} />
            </button>
            <button
              aria-label="缩小时间轴"
              disabled={!ready || !zoomed}
              onClick={() => setWindow(zoomWindow(view, bounds, 2))}
            >
              <Minus size={15} />
            </button>
            <button
              aria-label="恢复默认视窗"
              title={
                props.segment?.id === "full"
                  ? "恢复默认视窗（前 20 秒）"
                  : "恢复默认视窗（当前阶段或 Pull 的完整范围）"
              }
              disabled={!ready || atDefault}
              onClick={() => {
                setWindow(defaultWindow);
                setDrag(undefined);
              }}
            >
              <RotateCcw size={14} />
            </button>
          </div>
          {props.loading && (
            <span className="timeline-loading" role="status">
              正在加载其他技能事件…
            </span>
          )}
          {hidden.size > 0 && (
            <button
              className="text-button timeline-restore-hidden"
              title="恢复隐藏的技能，不改变 Note 勾选"
              onClick={() => setHidden(new Set())}
            >
              <Eye size={14} />
              已隐藏 ({hidden.size})
            </button>
          )}
        </div>
      </div>
      {!showCanvas ? (
        <div className="empty timeline-empty">
          <p>
            {props.loading
              ? "正在加载完整技能事件…"
              : props.error
                ? "日志加载失败，请重试。"
                : fight
                  ? "当前筛选没有技能事件，可在技能列表中选择其他来源。"
                  : "加载报告并选择战斗后查看时间轴。"}
          </p>
        </div>
      ) : (
        <>
          <div className="timeline-viewport" ref={viewportArea}>
            <div
              className="timeline-canvas"
              data-dragging={drag?.mode}
              aria-label="时间轴画布"
              tabIndex={0}
              onFocus={(event) => {
                if (event.target === event.currentTarget) onFocus(undefined);
              }}
              onPointerDown={(event) => startDrag(event, "pan")}
              onPointerMove={movePointer}
              onPointerLeave={() => setCursor(undefined)}
              onPointerUp={finishDrag}
              onPointerCancel={() => setDrag(undefined)}
              onLostPointerCapture={() => setDrag(undefined)}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  setDrag(undefined);
                  setTooltip(undefined);
                  setCursor(undefined);
                }
                if (event.target !== event.currentTarget) return;
                if (
                  ["ArrowLeft", "ArrowRight", "+", "=", "-", "Home"].includes(
                    event.key,
                  )
                )
                  event.preventDefault();
                if (event.key === "Home") setWindow(defaultWindow);
                else if (["+", "=", "-"].includes(event.key))
                  setWindow(
                    zoomWindow(view, bounds, event.key === "-" ? 2 : 0.5),
                  );
                else if (
                  event.key === "ArrowLeft" ||
                  event.key === "ArrowRight"
                ) {
                  const offset =
                    (span / 2) * (event.key === "ArrowLeft" ? -1 : 1);
                  setWindow({
                    start: view.start + offset,
                    end: view.end + offset,
                  });
                }
              }}
            >
              <div className="timeline-ruler">
                <div className="timeline-ruler-label" aria-hidden="true" />
                <div
                  className="timeline-lane timeline-scale"
                  ref={rulerScale}
                  onPointerDown={(event) => startDrag(event, "zoom")}
                >
                  {ticks.map((time) => (
                    <span
                      className="timeline-tick"
                      key={time}
                      style={{
                        left: percent(time),
                      }}
                    >
                      {labeledTicks.has(time) && (
                        <span
                          style={{
                            transform:
                              time === view.start
                                ? "none"
                                : time === view.end
                                  ? "translateX(-100%)"
                                  : undefined,
                          }}
                        >
                          {duration(time)}
                        </span>
                      )}
                    </span>
                  ))}
                  {mediumTicks.map((time) => (
                    <span
                      className="timeline-medium-tick"
                      key={time}
                      style={{ left: percent(time) }}
                    />
                  ))}
                  {minorTicks.map((time) => (
                    <span
                      className="timeline-minor-tick"
                      key={time}
                      style={{ left: percent(time) }}
                    />
                  ))}
                  {phaseLines()}
                </div>
              </div>
              {!shown.length && (
                <div className="empty">
                  <p>
                    {onlyIncluded
                      ? "当前没有可显示的已加入 Note 事件。"
                      : "所有技能行已隐藏，导出选择仍然保留。"}
                  </p>
                </div>
              )}
              {regions.map((region) => (
                <section
                  className="timeline-region"
                  key={region.id}
                  data-side={region.side}
                  aria-label={region.name}
                >
                  {showRegionHeaders && (
                    <button
                      className="timeline-region-toggle"
                      aria-expanded={!regionIsCollapsed(region.id)}
                      aria-label={`${regionIsCollapsed(region.id) ? "展开" : "折叠"} ${region.name}`}
                      onClick={() =>
                        setRegionVisibility(
                          new Map([
                            ...regionVisibility,
                            [region.id, !regionIsCollapsed(region.id)],
                          ]),
                        )
                      }
                    >
                      {regionIsCollapsed(region.id) ? (
                        <ChevronRight size={15} />
                      ) : (
                        <ChevronDown size={15} />
                      )}
                      <strong>{region.name}</strong>
                      <small>{region.count} 组技能</small>
                    </button>
                  )}
                  {!regionIsCollapsed(region.id) && (
                    <>
                      {!region.count && (
                        <p className="timeline-region-empty">
                          当前筛选没有{region.name}事件
                        </p>
                      )}
                      {region.sections.map((section) => (
                        <div
                          className="timeline-section"
                          key={section.id}
                          data-side={section.side}
                        >
                          <button
                            type="button"
                            className="timeline-section-toggle"
                            aria-expanded={!sectionIsCollapsed(section.id)}
                            aria-label={`${sectionIsCollapsed(section.id) ? "展开" : "折叠"} ${section.name}`}
                            onClick={() =>
                              toggle(collapsed, section.id, setCollapsed)
                            }
                          >
                            {sectionIsCollapsed(section.id) ? (
                              <ChevronRight size={14} />
                            ) : (
                              <ChevronDown size={14} />
                            )}
                            <ActorIcon
                              node={{
                                player:
                                  section.rows[0].group.actor.type?.toLowerCase() ===
                                  "player",
                                className: actorClass(
                                  section.rows[0].group.actor.subType,
                                ),
                                specIcon: section.rows[0].group.actor.specIcon,
                              }}
                            />
                            <ActorName actor={section.rows[0].group.actor} />
                            <small>{section.rows.length} 组</small>
                          </button>
                          {!sectionIsCollapsed(section.id) &&
                            section.rows.map((row) => {
                              const selectable = row.entries.filter(
                                (entry) => entry.selectable,
                              );
                              const count = selectable.filter(
                                (entry) => entry.included,
                              ).length;
                              return (
                                <div
                                  className={`timeline-row ${focusedRow?.id === row.id ? "focused" : ""}`}
                                  key={row.id}
                                  data-side={row.group.side}
                                  data-type={row.group.eventType}
                                  data-row-id={row.id}
                                  style={
                                    {
                                      ...(row.group.eventType === "Casts"
                                        ? {
                                            "--cast-background":
                                              spellSchoolBackground(
                                                row.group.ability.type,
                                              ),
                                          }
                                        : {}),
                                    } as CSSProperties
                                  }
                                >
                                  <div className="timeline-row-label">
                                    <input
                                      type="checkbox"
                                      aria-label={`导出整行 ${row.group.actor.name} ${row.group.ability.name} ${labels[row.group.eventType]}`}
                                      checked={
                                        selectable.length > 0 &&
                                        count === selectable.length
                                      }
                                      disabled={!selectable.length}
                                      ref={(input) => {
                                        if (input)
                                          input.indeterminate =
                                            count > 0 &&
                                            count < selectable.length;
                                      }}
                                      onChange={() =>
                                        onSelectEvents(
                                          row,
                                          selectable,
                                          count !== selectable.length,
                                        )
                                      }
                                    />
                                    <a
                                      className="timeline-skill-label"
                                      role="button"
                                      {...wowheadSpellLink(
                                        row.group.ability.gameID,
                                      )}
                                      onKeyDown={(event) => {
                                        if (event.key === " ") {
                                          event.preventDefault();
                                          event.currentTarget.click();
                                        }
                                      }}
                                      onClick={(event) => {
                                        event.preventDefault();
                                        if (row.entries[0])
                                          onFocus(row.entries[0].id);
                                      }}
                                    >
                                      <GameIcon icon={row.group.ability.icon} />
                                      <strong
                                        title={`${row.group.actor.name} · ${row.group.ability.name} · ${labels[row.group.eventType]}`}
                                        style={{
                                          color: spellSchool(
                                            row.group.ability.type,
                                          ).color,
                                        }}
                                      >
                                        {row.group.ability.name}
                                      </strong>
                                    </a>
                                    <button
                                      className="timeline-row-action"
                                      aria-label={`隐藏 ${row.group.actor.name} ${row.group.ability.name}`}
                                      onClick={() =>
                                        toggle(hidden, row.id, setHidden)
                                      }
                                    >
                                      <EyeOff size={13} />
                                    </button>
                                  </div>
                                  <div className="timeline-lane">
                                    {phaseLines()}
                                    {row.entries.map((entry) => {
                                      const event = entry.event;
                                      const interval = timelineInterval(event);
                                      const iconMargin =
                                        (20 / Math.max(1, laneWidth)) * span;
                                      if (
                                        interval.start > view.end ||
                                        (interval.end < view.start &&
                                          interval.start <
                                            view.start - iconMargin)
                                      )
                                        return null;
                                      const start = Math.max(
                                        view.start,
                                        interval.start,
                                      );
                                      const clippedEnd = Math.min(
                                        view.end,
                                        interval.end,
                                      );
                                      return (
                                        <span
                                          key={entry.id}
                                          {...tooltipHandlers(entry)}
                                        >
                                          {clippedEnd > start && (
                                            <span
                                              className={`${event.castStart != null ? "timeline-cast" : "timeline-aura"} ${entry.included ? "included" : ""}`}
                                              aria-hidden="true"
                                              style={{
                                                left: percent(start),
                                                width: `${((clippedEnd - start) / span) * 100}%`,
                                              }}
                                            />
                                          )}
                                          <a
                                            className={`timeline-marker ${entry.included ? "included" : "available"} ${!entry.selectable ? "reference" : ""} ${event.auraOnly ? "continued" : ""} ${focusedId === entry.id ? "active" : ""}`}
                                            role="button"
                                            {...wowheadSpellLink(
                                              event.ability.gameID,
                                            )}
                                            style={{
                                              left: percent(interval.start),
                                            }}
                                            data-event-id={entry.id}
                                            aria-label={`${row.group.actor.name} ${event.ability.name} ${preciseTime(event.time)} ${labels[event.eventType]}`}
                                            aria-pressed={
                                              focusedId === entry.id
                                            }
                                            aria-describedby={
                                              tooltip?.entry.id === entry.id
                                                ? "timeline-event-tooltip"
                                                : undefined
                                            }
                                            onKeyDown={(event) => {
                                              if (event.key === " ") {
                                                event.preventDefault();
                                                event.currentTarget.click();
                                              }
                                            }}
                                            onClick={(event) => {
                                              event.preventDefault();
                                              onFocus(entry.id);
                                            }}
                                          >
                                            <GameIcon
                                              icon={event.ability.icon}
                                            />
                                            {entry.included && (
                                              <span
                                                className="timeline-included-badge"
                                                aria-hidden="true"
                                              >
                                                ✓
                                              </span>
                                            )}
                                          </a>
                                        </span>
                                      );
                                    })}
                                  </div>
                                </div>
                              );
                            })}
                        </div>
                      ))}
                    </>
                  )}
                </section>
              ))}
            </div>
            {cursor && !drag && (
              <div
                className="timeline-crosshair"
                style={{ left: cursor.left }}
                aria-hidden="true"
              >
                <span className="timeline-cursor-time">
                  {preciseTime(cursor.time)}
                </span>
              </div>
            )}
            {drag?.mode === "zoom" && (
              <span
                className="timeline-zoom-selection"
                style={{
                  left:
                    drag.left +
                    ((Math.min(drag.start, drag.end) - view.start) / span) *
                      drag.width,
                  width: (Math.abs(drag.end - drag.start) / span) * drag.width,
                }}
                aria-hidden="true"
              />
            )}
          </div>
          {focused && focusedRow && (
            <div className="timeline-inspector" aria-label="事件详情">
              <div className="timeline-event-detail">
                <strong
                  style={{
                    color: spellSchool(focused.event.ability.type).color,
                  }}
                >
                  {focused.event.ability.name}{" "}
                  <small>#{focused.event.ability.gameID}</small>
                </strong>
                <div className="timeline-occurrences-heading">
                  逐次勾选 ·{" "}
                  {focusedRow.entries.filter((entry) => entry.included).length}{" "}
                  /{" "}
                  {
                    focusedRow.entries.filter((entry) => entry.selectable)
                      .length
                  }{" "}
                  次加入导出
                </div>
                <div className="timeline-detail-actions">
                  <button
                    disabled={!focused.included}
                    onClick={props.onLocateNote}
                  >
                    定位 Note
                  </button>
                  <button
                    aria-label="收起事件详情"
                    title="收起事件详情，扩大时间轴"
                    onClick={() => onFocus(undefined)}
                  >
                    <X size={13} />
                  </button>
                </div>
                {!focused.selectable && !focused.event.auraOnly && (
                  <span>
                    {focused.event.time > bounds.end ||
                    focused.event.time < bounds.start
                      ? "事件不在当前战斗范围，仅作时间轴参照。"
                      : "当前 Target/Source 筛选已排除此事件，仅作时间轴参照。"}
                  </span>
                )}
              </div>
              <div className="timeline-occurrences" aria-label="该行全部事件">
                <div className="timeline-occurrence-list">
                  <table>
                    <thead>
                      <tr>
                        <th scope="col" aria-label="选择导出" />
                        <th scope="col">
                          {intervalLabels[focused.event.eventType]}
                        </th>
                        <th scope="col">来源</th>
                        <th scope="col">目标</th>
                      </tr>
                    </thead>
                    <tbody>
                      {focusedRow.entries.map((entry) => {
                        const interval = timelineInterval(entry.event);
                        const source = eventActor(entry.event, "source");
                        const target = eventActor(entry.event, "target");
                        return (
                          <tr
                            className={entry.id === focusedId ? "active" : ""}
                            key={entry.id}
                            onClick={() => onFocus(entry.id)}
                          >
                            <td>
                              <input
                                type="checkbox"
                                aria-label={`导出事件 ${focusedRow.group.actor.name} ${entry.event.ability.name} ${preciseTime(entry.event.time)} ${labels[entry.event.eventType]}`}
                                disabled={!entry.selectable}
                                checked={entry.included}
                                onClick={(event) => event.stopPropagation()}
                                onChange={(event) => {
                                  onFocus(entry.id);
                                  onSelectEvents(
                                    focusedRow,
                                    [entry],
                                    event.target.checked,
                                  );
                                }}
                              />
                            </td>
                            <td>
                              {preciseTime(interval.start)} –{" "}
                              {preciseTime(interval.end)}
                            </td>
                            <td>
                              <ActorName
                                actor={source?.actor}
                                instance={source?.instance}
                              />
                            </td>
                            <td>
                              <ActorName
                                actor={target?.actor}
                                instance={target?.instance}
                              />
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          )}
          <div className="panel-foot">
            <span>
              显示 {shown.length} / {rows.length} 组 ·
              {props.side === "all"
                ? "全部"
                : props.side === "enemy"
                  ? "敌对"
                  : "队友"}{" "}
              {labels[props.eventType]}
            </span>
            <span>导出 {props.includedEventCount} 次事件</span>
          </div>
        </>
      )}
    </section>
  );
}
