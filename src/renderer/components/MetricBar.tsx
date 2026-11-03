import type { UptimeInterval } from "../../domain/ability";

export function MetricBar({
  value,
  max,
  background,
}: {
  value: number;
  max: number;
  background?: string;
}) {
  const width = max > 0 ? Math.min(100, Math.max(0, (value / max) * 100)) : 0;
  return (
    <b className="skill-stat skill-count">
      <span className="skill-bar" aria-hidden="true">
        <span
          className="skill-bar-fill"
          style={{
            width: `${width}%`,
            background: background ?? "var(--text-muted)",
          }}
        />
      </span>
      <span
        className="skill-stat-value"
        style={{ minWidth: `${String(max).length}ch` }}
      >
        {value}
      </span>
    </b>
  );
}

export function UptimeBar({
  value,
  intervals,
  start,
  duration,
  background,
}: {
  value: number;
  intervals: UptimeInterval[];
  start: number;
  duration: number;
  background?: string;
}) {
  return (
    <b className="skill-stat skill-uptime">
      <span className="skill-stat-value">{value.toFixed(2)}%</span>
      <span className="skill-bar skill-aura-bar" aria-hidden="true">
        {duration > 0 &&
          intervals.map((interval) => (
            <span
              className="skill-bar-fill"
              key={interval.start}
              style={{
                left: `${((interval.start - start) / duration) * 100}%`,
                width: `${((interval.end - interval.start) / duration) * 100}%`,
                background: background ?? "var(--text-muted)",
              }}
            />
          ))}
      </span>
    </b>
  );
}
