import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, mkdtemp, open, rename, rm, rmdir } from "node:fs/promises";
import { join } from "node:path";
import {
  isNewerVersion,
  releaseRoot,
  updateManifestSchema,
  updateManifestUrl,
  type UpdateManifest,
  type UpdateSnapshot,
} from "../shared/updates";
import { AppError } from "./errors";

type Fetch = (url: string, init: RequestInit) => Promise<Response>;
const assetHosts = new Set([
  "release-assets.githubusercontent.com",
  "objects.githubusercontent.com",
  "github-releases.githubusercontent.com",
]);
export function allowedUpdateUrl(input: string): boolean {
  try {
    const url = new URL(input);
    return (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.port &&
      !url.hash &&
      (assetHosts.has(url.hostname) ||
        (url.origin === "https://github.com" &&
          url.href.startsWith(`${releaseRoot}/`)))
    );
  } catch {
    return false;
  }
}

export class UpdateService {
  private state: UpdateSnapshot;
  private checking?: Promise<UpdateSnapshot>;
  private downloading?: Promise<UpdateSnapshot>;
  private installing?: Promise<UpdateSnapshot>;
  private checkController?: AbortController;
  private downloadController?: AbortController;
  private ready?: {
    path: string;
    artifact: UpdateManifest["artifacts"]["setup"];
    version: string;
  };
  constructor(
    private readonly options: {
      currentVersion: string;
      downloadsDirectory: string;
      fetch: Fetch;
      changed: (snapshot: UpdateSnapshot) => void;
    },
  ) {
    this.state = {
      currentVersion: options.currentVersion,
      status: "idle",
    };
  }
  snapshot(): UpdateSnapshot {
    return structuredClone(this.state);
  }
  private publish(next: Partial<UpdateSnapshot>) {
    this.state = {
      ...this.state,
      error: undefined,
      errorPhase: undefined,
      ...next,
    };
    this.options.changed(this.snapshot());
    return this.snapshot();
  }
  private async request(url: string, signal: AbortSignal): Promise<Response> {
    for (let redirect = 0; redirect < 6; redirect++) {
      if (!allowedUpdateUrl(url))
        throw new AppError("更新地址无效。", "UPDATE");
      const response = await this.options.fetch(url, {
        redirect: "manual",
        signal,
        cache: "no-store",
        credentials: "omit",
        headers: { "User-Agent": `WCL2NOTE/${this.state.currentVersion}` },
      });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get("location");
        await response.body?.cancel();
        if (!location) throw new AppError("更新地址重定向失败。", "UPDATE");
        url = new URL(location, url).href;
        continue;
      }
      if (!response.ok || !response.body) {
        await response.body?.cancel();
        throw new AppError(
          response.status === 404
            ? "尚无可用的更新发布，请稍后重试。"
            : `GitHub 请求失败（${response.status}），请稍后重试。`,
          "UPDATE",
        );
      }
      return response;
    }
    throw new AppError("更新地址重定向过多。", "UPDATE");
  }
  check(): Promise<UpdateSnapshot> {
    if (
      this.downloading ||
      this.installing ||
      this.state.status === "installing"
    )
      return Promise.resolve(this.snapshot());
    if (this.checking) return this.checking;
    this.checking = this.performCheck().finally(() => {
      this.checking = undefined;
    });
    return this.checking;
  }
  private async performCheck() {
    const previous = this.snapshot();
    this.publish({ status: "checking" });
    const controller = new AbortController();
    this.checkController = controller;
    const timeout = setTimeout(() => controller.abort(), 15_000);
    try {
      const response = await this.request(updateManifestUrl, controller.signal);
      const reader = response.body!.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          size += chunk.value.length;
          if (size > 256 * 1024) throw new AppError("更新清单过大。", "UPDATE");
          chunks.push(chunk.value);
        }
      } finally {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
      let content: unknown;
      try {
        content = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        throw new AppError(
          "更新清单无效，请到 GitHub 发布页面查看。",
          "UPDATE",
        );
      }
      const parsed = updateManifestSchema.safeParse(content);
      if (!parsed.success)
        throw new AppError(
          "更新清单无效，请到 GitHub 发布页面查看。",
          "UPDATE",
        );
      const release = parsed.data;
      const newer = isNewerVersion(release.version, this.state.currentVersion);
      const downloaded =
        newer &&
        this.ready?.version === release.version &&
        this.ready.artifact.sha256 === release.artifacts.setup.sha256;
      if (!downloaded) this.ready = undefined;
      return this.publish({
        status: newer ? (downloaded ? "downloaded" : "available") : "current",
        release,
        transferred: undefined,
        total: undefined,
      });
    } catch (error) {
      return this.publish({
        status: this.ready
          ? "downloaded"
          : previous.release &&
              isNewerVersion(previous.release.version, previous.currentVersion)
            ? "available"
            : "error",
        release: previous.release,
        errorPhase: "check",
        error:
          error instanceof AppError
            ? error.message
            : controller.signal.aborted
              ? "检查更新超时，请检查网络后重试。"
              : "无法检查更新，请确认可以连接 GitHub 后重试。",
      });
    } finally {
      clearTimeout(timeout);
      this.checkController = undefined;
    }
  }
  download(): Promise<UpdateSnapshot> {
    if (this.downloading) return this.downloading;
    if (
      this.checking ||
      this.installing ||
      this.state.status === "installing" ||
      !this.state.release ||
      !isNewerVersion(this.state.release.version, this.state.currentVersion)
    )
      return Promise.reject(new AppError("请先检查可用更新。", "UPDATE"));
    this.downloading = this.performDownload(this.state.release).finally(() => {
      this.downloading = undefined;
    });
    return this.downloading;
  }
  private async performDownload(release: UpdateManifest) {
    const artifact = release.artifacts.setup;
    this.ready = undefined;
    const controller = new AbortController();
    this.downloadController = controller;
    let directory: string | undefined;
    let temporary: string | undefined;
    let response: Response | undefined;
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, 30 * 60_000);
    let stall = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, 45_000);
    this.publish({
      status: "downloading",
      transferred: 0,
      total: artifact.size,
    });
    try {
      response = await this.request(artifact.url, controller.signal);
      await mkdir(this.options.downloadsDirectory, { recursive: true });
      directory = await mkdtemp(
        join(this.options.downloadsDirectory, "WCL2NOTE-"),
      );
      temporary = join(directory, `${artifact.filename}.part`);
      const file = await open(temporary, "wx");
      const reader = response.body!.getReader();
      const hash = createHash("sha256");
      let size = 0;
      let lastProgress = 0;
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          if (controller.signal.aborted)
            throw new AppError("下载已取消。", "UPDATE");
          clearTimeout(stall);
          stall = setTimeout(() => {
            timedOut = true;
            controller.abort();
          }, 45_000);
          size += chunk.value.length;
          if (size > artifact.size)
            throw new AppError("更新文件大小不符，请重新下载。", "UPDATE");
          hash.update(chunk.value);
          // writeFile on an open handle writes from its current position and handles partial writes.
          await file.writeFile(chunk.value);
          if (Date.now() - lastProgress > 150) {
            this.publish({ transferred: size });
            lastProgress = Date.now();
          }
        }
        if (controller.signal.aborted)
          throw new AppError("下载已取消。", "UPDATE");
        this.publish({ status: "verifying", transferred: size });
        if (size !== artifact.size || hash.digest("hex") !== artifact.sha256)
          throw new AppError("更新文件校验失败，请重新下载。", "UPDATE");
        await file.sync();
      } finally {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
        await file.close();
      }
      if (controller.signal.aborted)
        throw new AppError("下载已取消。", "UPDATE");
      const path = join(directory, artifact.filename);
      await rename(temporary, path);
      this.ready = { path, artifact, version: release.version };
      return this.publish({ status: "downloaded", transferred: artifact.size });
    } catch (error) {
      if (temporary) await rm(temporary, { force: true }).catch(() => {});
      if (directory) await rmdir(directory).catch(() => {});
      return this.publish({
        status: controller.signal.aborted && !timedOut ? "available" : "error",
        errorPhase:
          controller.signal.aborted && !timedOut ? undefined : "download",
        error: controller.signal.aborted
          ? timedOut
            ? "下载超时，请检查 GitHub 连接后重试。"
            : undefined
          : error instanceof AppError
            ? error.message
            : "下载更新失败，请检查网络和下载目录权限后重试。",
      });
    } finally {
      await response?.body?.cancel().catch(() => {});
      clearTimeout(timeout);
      clearTimeout(stall);
      this.downloadController = undefined;
    }
  }
  cancel() {
    this.downloadController?.abort();
  }
  dispose() {
    this.checkController?.abort();
    this.cancel();
  }
  install(
    openInstaller: (path: string) => Promise<string>,
  ): Promise<UpdateSnapshot> {
    if (this.installing) return this.installing;
    if (this.state.status === "installing")
      return Promise.resolve(this.snapshot());
    if (!this.ready || this.downloading || this.checking)
      return Promise.reject(new AppError("请先下载更新。", "UPDATE"));
    this.installing = this.performInstall(openInstaller).finally(() => {
      this.installing = undefined;
    });
    return this.installing;
  }
  private async performInstall(
    openInstaller: (path: string) => Promise<string>,
  ) {
    this.publish({ status: "verifying" });
    try {
      const downloaded = await this.downloadedFile();
      this.publish({ status: "installing" });
      const error = await openInstaller(downloaded.path);
      if (error) throw new AppError("无法启动安装程序，请重试。", "UPDATE");
      return this.snapshot();
    } catch (error) {
      if (!this.ready) return this.snapshot();
      return this.publish({
        status: "error",
        errorPhase: "install",
        error:
          error instanceof AppError
            ? error.message
            : "无法启动安装程序，请重试。",
      });
    }
  }
  async downloadedFile() {
    const ready = this.ready;
    if (!ready) throw new AppError("请先下载更新。", "UPDATE");
    try {
      const hash = createHash("sha256");
      let size = 0;
      for await (const chunk of createReadStream(ready.path)) {
        hash.update(chunk);
        size += chunk.length;
      }
      if (
        size !== ready.artifact.size ||
        hash.digest("hex") !== ready.artifact.sha256
      )
        throw Error("checksum");
    } catch {
      this.ready = undefined;
      this.publish({
        status: "error",
        errorPhase: "download",
        error: "已下载文件缺失或校验失败，请重新下载。",
      });
      throw new AppError("已下载文件缺失或校验失败，请重新下载。", "UPDATE");
    }
    return { path: ready.path };
  }
}
