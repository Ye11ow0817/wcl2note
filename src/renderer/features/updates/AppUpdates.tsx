import { desktop } from "../../api/wcl/client";
import { isNewerVersion } from "../../../shared/updates";
import type { AppUpdates } from "./useAppUpdates";

export function UpdateActionButton({ updates }: { updates: AppUpdates }) {
  const { state, run } = updates;
  if (
    !state?.release ||
    !isNewerVersion(state.release.version, state.currentVersion)
  )
    return null;
  const failed =
    state.status === "error" &&
    (state.errorPhase === "download" || state.errorPhase === "install");
  const busy = ["checking", "downloading", "verifying", "installing"].includes(
    state.status,
  );
  const percent = state.total
    ? Math.min(100, Math.floor(((state.transferred ?? 0) / state.total) * 100))
    : 0;
  const label = failed
    ? "重试"
    : state.status === "downloading"
      ? `下载 ${percent}%`
      : state.status === "verifying"
        ? "校验中…"
        : state.status === "installing"
          ? "安装中…"
          : state.status === "downloaded"
            ? "安装"
            : "更新";
  const tone = failed
    ? "error"
    : state.status === "downloaded" || state.status === "installing"
      ? "ready"
      : state.status === "verifying"
        ? "verifying"
        : state.status === "downloading"
          ? "downloading"
          : "available";
  const install =
    state.status === "downloaded" || (failed && state.errorPhase === "install");
  return (
    <button
      type="button"
      className="update-action"
      data-update-tone={tone}
      disabled={busy}
      title={
        failed
          ? state.error
          : install
            ? "运行安装程序并退出应用"
            : `更新至 ${state.release.version}`
      }
      onClick={() =>
        void run(() =>
          install ? desktop().installUpdate() : desktop().downloadUpdate(),
        )
      }
    >
      {label}
    </button>
  );
}

export function UpdatePanel({
  updates,
  version,
}: {
  updates: AppUpdates;
  version: string;
}) {
  const { state, error, run } = updates;
  const busy =
    !state ||
    ["checking", "downloading", "verifying", "installing"].includes(
      state.status,
    );
  const checkError =
    error || (state?.errorPhase === "check" ? state.error : undefined);
  return (
    <section className="update-panel" aria-label="应用更新">
      <h3>应用更新</h3>
      <div className="update-summary">
        <span className="update-version">当前版本 {version || "…"}</span>
        <div className="update-actions">
          <button
            type="button"
            disabled={busy}
            onClick={() => void run(() => desktop().checkForUpdates())}
          >
            {state?.status === "checking" ? "检查中…" : "检查更新"}
          </button>
          <UpdateActionButton updates={updates} />
        </div>
      </div>
      {checkError ? (
        <p className="settings-error" role="alert">
          {checkError}
        </p>
      ) : (
        state?.status === "current" && (
          <p className="update-check-result" role="status">
            当前已是最新版本。
          </p>
        )
      )}
    </section>
  );
}
