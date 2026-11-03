import { useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronDown, ChevronUp, FileText } from "lucide-react";
import { duration, type Fight, type Segment } from "../../../domain/model";
import {
  fightDifficulty,
  fightGroupKey,
  fightGroups,
  fightProgress,
  fightResultNumbers,
  fightSummary,
  isTrashFight,
} from "../../../domain/fight";

export type NavigationPanel = "fight" | "phase" | undefined;

interface Props {
  fights: Fight[];
  currentFight?: Fight;
  reportStart: number;
  segments: Segment[];
  segment?: Segment;
  open: NavigationPanel;
  loading: boolean;
  hasReport: boolean;
  onOpen: (panel: NavigationPanel) => void;
  onFight: (fight: Fight) => void;
  onSegment: (id: string) => void;
}

const resultLabels = { kill: "Kill", wipe: "Wipe", neutral: "战斗" };

function fightDuration(fight: Fight) {
  return duration(
    (fight.keystoneLevel ?? 0) > 0
      ? (fight.keystoneTime ?? fight.endTime - fight.startTime)
      : fight.endTime - fight.startTime,
  );
}

export function FightNavigation(props: Props) {
  const [expandedGroups, setExpandedGroups] = useState(
    new Map<string, boolean>(),
  );
  const initializedGroups = useRef(false);
  const navigation = useRef<HTMLElement>(null);
  const fightButton = useRef<HTMLButtonElement>(null);
  const phaseButton = useRef<HTMLButtonElement>(null);
  const groups = useMemo(() => fightGroups(props.fights), [props.fights]);
  const bossGroups = groups.filter((group) => !isTrashFight(group.fights[0]));
  const trashFights = useMemo(
    () =>
      props.fights
        .filter(isTrashFight)
        .sort((a, b) => a.startTime - b.startTime || a.id - b.id),
    [props.fights],
  );
  const numbers = useMemo(
    () => fightResultNumbers(props.fights),
    [props.fights],
  );
  const summary = props.currentFight
    ? fightSummary(
        props.currentFight,
        props.reportStart,
        numbers.get(props.currentFight.id),
      )
    : undefined;
  const currentDifficulty = props.currentFight
    ? fightDifficulty(props.currentFight)
    : "";
  const currentNumber = props.currentFight
    ? numbers.get(props.currentFight.id)
    : undefined;
  const currentLabel =
    props.currentFight && summary
      ? `${props.currentFight.name}${currentDifficulty ? ` · ${currentDifficulty}` : ""} · ${resultLabels[summary.result]}${currentNumber == null ? "" : ` ${currentNumber}`} (${fightDuration(props.currentFight)})`
      : "选择战斗";

  useEffect(() => {
    if (initializedGroups.current || !groups.length) return;
    initializedGroups.current = true;
    const initialKey = props.currentFight && fightGroupKey(props.currentFight);
    const initialGroup = groups.find((group) => group.key === initialKey);
    if (
      initialGroup &&
      !isTrashFight(initialGroup.fights[0]) &&
      initialGroup.fights.length > 1
    )
      setExpandedGroups(new Map([[initialGroup.key, true]]));
  }, [groups, props.currentFight]);

  useEffect(() => {
    if (!props.open) return;
    const dismiss = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || document.querySelector("dialog[open]"))
        return;
      event.preventDefault();
      props.onOpen(undefined);
      (props.open === "fight" ? fightButton : phaseButton).current?.focus();
    };
    const outside = (event: PointerEvent) => {
      if (
        props.open === "phase" &&
        !navigation.current?.contains(event.target as Node)
      )
        props.onOpen(undefined);
    };
    document.addEventListener("keydown", dismiss);
    document.addEventListener("pointerdown", outside);
    return () => {
      document.removeEventListener("keydown", dismiss);
      document.removeEventListener("pointerdown", outside);
    };
  }, [props.open, props.onOpen]);

  function chooseFight(fight: Fight) {
    props.onFight(fight);
    fightButton.current?.focus();
  }

  function renderFight(fight: Fight) {
    const summary = fightSummary(
      fight,
      props.reportStart,
      numbers.get(fight.id),
    );
    const progress = fightProgress(fight);
    const result = summary.result;
    const caption =
      `${numbers.get(fight.id) ?? ""} (${fightDuration(fight)})`.trim();
    return (
      <button
        key={fight.id}
        className={`fight-card ${result}${props.currentFight?.id === fight.id ? " active" : ""}`}
        data-fight-id={fight.id}
        aria-label={`${summary.displayName} · 开始时间 ${summary.startTimeText}`}
        aria-pressed={props.currentFight?.id === fight.id}
        onClick={() => chooseFight(fight)}
      >
        <span className="fight-outcome">
          <span className="fight-result">
            {result === "kill"
              ? "KILL"
              : result === "wipe"
                ? (progress.percent ?? "Wipe")
                : "战斗"}
          </span>
          <span className="fight-last-phase">
            {result === "kill" ? (
              <Check size={13} aria-label="击杀" />
            ) : (
              progress.phase
            )}
          </span>
        </span>
        <span className={`fight-name ${result}`}>{caption}</span>
        <time
          className="fight-start-time"
          dateTime={summary.startTimeIso}
          aria-label={`开始时间 ${summary.startTimeText}`}
        >
          {summary.startTimeText}
        </time>
        {result === "wipe" && progress.completed != null && (
          <span
            className="fight-progress"
            role="img"
            aria-label={`战斗完成进度 ${Number(progress.completed.toFixed(1))}%`}
          >
            <i style={{ width: `${progress.completed}%` }} />
          </span>
        )}
      </button>
    );
  }

  function renderTrashFight(fight: Fight) {
    const summary = fightSummary(fight, props.reportStart);
    return (
      <button
        key={fight.id}
        className={`fight-trash-item${props.currentFight?.id === fight.id ? " active" : ""}`}
        data-fight-id={fight.id}
        aria-label={`${summary.displayName} · 开始时间 ${summary.startTimeText}`}
        aria-pressed={props.currentFight?.id === fight.id}
        onClick={() => chooseFight(fight)}
      >
        <span className="fight-trash-name">{fight.name}</span>
        <span className="fight-trash-duration">({fightDuration(fight)})</span>
        <time dateTime={summary.startTimeIso}>{summary.startTimeText}</time>
      </button>
    );
  }

  return (
    <>
      <nav
        className="report-navigation"
        aria-label="战斗与阶段选择"
        ref={navigation}
      >
        <button
          ref={fightButton}
          className="fight-selector"
          aria-label="选择战斗"
          aria-expanded={props.open === "fight"}
          aria-controls="fight-navigation"
          title={summary?.displayName}
          onClick={() =>
            props.onOpen(props.open === "fight" ? undefined : "fight")
          }
        >
          <span>{currentLabel}</span>
          {props.open === "fight" ? (
            <ChevronUp size={15} />
          ) : (
            <ChevronDown size={15} />
          )}
        </button>
        <div className="phase-selector">
          <button
            ref={phaseButton}
            aria-label="选择阶段"
            aria-expanded={props.open === "phase"}
            aria-controls="segment-navigation"
            disabled={!props.segments.length}
            title={props.segment?.name}
            onClick={() =>
              props.onOpen(props.open === "phase" ? undefined : "phase")
            }
          >
            <span>{props.segment?.name ?? "选择阶段"}</span>
            {props.open === "phase" ? (
              <ChevronUp size={15} />
            ) : (
              <ChevronDown size={15} />
            )}
          </button>
          <div
            id="segment-navigation"
            className="segment-list"
            role="group"
            aria-label="阶段列表"
            hidden={props.open !== "phase"}
          >
            {props.segments.map((segment) => (
              <button
                key={segment.id}
                data-segment-id={segment.id}
                className={`segment${segment.id === props.segment?.id ? " active" : ""}`}
                aria-pressed={segment.id === props.segment?.id}
                onClick={() => {
                  props.onSegment(segment.id);
                  props.onOpen(undefined);
                  phaseButton.current?.focus();
                }}
              >
                <span>{segment.name}</span>
                <small>
                  {duration(
                    segment.startTime - (props.currentFight?.startTime ?? 0),
                  )}
                  {" – "}
                  {duration(
                    segment.endTime - (props.currentFight?.startTime ?? 0),
                  )}
                </small>
              </button>
            ))}
          </div>
        </div>
      </nav>
      <section
        id="fight-navigation"
        className="panel fights"
        aria-label="战斗列表"
        hidden={props.open !== "fight"}
      >
        <div className="panel-body">
          {groups.length ? (
            <>
              {bossGroups.map((group, index) => {
                const canExpand = group.fights.length > 1;
                const expanded =
                  canExpand && (expandedGroups.get(group.key) ?? false);
                const latest =
                  group.fights.filter((fight) => fight.kill === true).at(-1) ??
                  group.fights.at(-1)!;
                const latestSummary = fightSummary(latest, props.reportStart);
                return (
                  <section
                    className="fight-boss-group"
                    data-boss-group={group.key}
                    key={group.key}
                  >
                    <h2 className="fight-boss-heading">
                      <button
                        className={`fight-boss-select${props.currentFight?.id === latest.id ? " active" : ""}`}
                        data-default-fight-id={latest.id}
                        data-only-fight-id={canExpand ? undefined : latest.id}
                        aria-label={`选择 ${group.name}`}
                        aria-describedby={`fight-group-summary-${index}`}
                        aria-pressed={props.currentFight?.id === latest.id}
                        title={latestSummary.displayName}
                        onClick={() => chooseFight(latest)}
                      >
                        <span className="fight-boss-name">{group.name}</span>
                        <span
                          id={`fight-group-summary-${index}`}
                          className={`fight-boss-summary ${latestSummary.result}`}
                        >
                          {resultLabels[latestSummary.result]}
                          {` (${fightDuration(latest)})`}
                          <time dateTime={latestSummary.startTimeIso}>
                            {latestSummary.startTimeText}
                          </time>
                        </span>
                      </button>
                      {canExpand && (
                        <button
                          className="fight-boss-toggle"
                          aria-label={`${expanded ? "收起" : "展开"} ${group.name}`}
                          aria-expanded={expanded}
                          aria-controls={`fight-group-${index}`}
                          onClick={() =>
                            setExpandedGroups((old) =>
                              new Map(old).set(group.key, !expanded),
                            )
                          }
                        >
                          {expanded ? "收起" : "展开"}
                          {expanded ? (
                            <ChevronUp size={14} />
                          ) : (
                            <ChevronDown size={14} />
                          )}
                        </button>
                      )}
                    </h2>
                    {canExpand && (
                      <div
                        className="fight-boss-body"
                        id={`fight-group-${index}`}
                        hidden={!expanded}
                      >
                        {(["kill", "wipe", "neutral"] as const).map(
                          (result) => {
                            const fights = group.fights.filter(
                              (fight) =>
                                fightSummary(fight, props.reportStart)
                                  .result === result,
                            );
                            return fights.length ? (
                              <div
                                className={`fight-result-group ${result}`}
                                key={result}
                              >
                                <div className="fight-result-heading">
                                  {resultLabels[result]} ({fights.length})
                                </div>
                                <div className="fight-items">
                                  {fights.map(renderFight)}
                                </div>
                              </div>
                            ) : null;
                          },
                        )}
                      </div>
                    )}
                  </section>
                );
              })}
              {trashFights.length > 0 && (
                <section
                  className="fight-trash-section"
                  aria-labelledby="trash-fights-heading"
                >
                  <h2 className="fight-trash-heading" id="trash-fights-heading">
                    Trash Fights <small>({trashFights.length})</small>
                  </h2>
                  <div className="fight-trash-list">
                    {trashFights.map(renderTrashFight)}
                  </div>
                </section>
              )}
            </>
          ) : (
            <div className="empty">
              <FileText />
              <p>
                {props.loading
                  ? "正在读取报告…"
                  : props.hasReport
                    ? "报告中没有战斗"
                    : "加载报告后选择战斗"}
              </p>
            </div>
          )}
        </div>
      </section>
    </>
  );
}
