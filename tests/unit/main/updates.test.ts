import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { allowedUpdateUrl, UpdateService } from "../../../src/main/updates";
import {
  isNewerVersion,
  updateManifestSchema,
  updateManifestUrl,
  type UpdateSnapshot,
} from "../../../src/shared/updates";
import { updateBytes, updateManifest } from "../../fixtures/updates";

const directories: string[] = [];
const services: UpdateService[] = [];
async function create(
  fetcher?: (url: string, init: RequestInit) => Promise<Response>,
  currentVersion = "1.0.0",
) {
  const directory = await mkdtemp(join(tmpdir(), "wcl2note-updates-test-"));
  directories.push(directory);
  const changes: UpdateSnapshot[] = [];
  const fetch = vi.fn(
    fetcher ??
      (async (url) =>
        url === updateManifestUrl
          ? Response.json(updateManifest())
          : new Response(updateBytes)),
  );
  const service = new UpdateService({
    currentVersion,
    downloadsDirectory: directory,
    fetch,
    changed: (snapshot) => changes.push(snapshot),
  });
  services.push(service);
  return { directory, changes, fetch, service };
}
afterEach(async () => {
  services.splice(0).forEach((service) => service.dispose());
  vi.useRealTimers();
  await Promise.all(
    directories.splice(0).map((directory) => {
      const target = resolve(directory);
      if (
        dirname(target) !== resolve(tmpdir()) ||
        !basename(target).startsWith("wcl2note-updates-test-")
      )
        throw Error("Unexpected cleanup path");
      return rm(target, { recursive: true, force: true });
    }),
  );
});
it("按数字比较正式版本，不将同版本、旧版本或预发布识别为更新", () => {
  expect(isNewerVersion("1.10.0", "1.9.9")).toBe(true);
  expect(isNewerVersion("2.0.0", "1.99.99")).toBe(true);
  for (const candidate of [
    "1.0.0",
    "0.99.0",
    "1.1.0-beta.1",
    "01.1.0",
    "garbage",
  ])
    expect(isNewerVersion(candidate, "1.0.0")).toBe(false);
});
it("清单只接受同一发布仓库、对应版本和固定文件名的附件", () => {
  expect(updateManifestSchema.safeParse(updateManifest()).success).toBe(true);
  for (const url of [
    "https://evil.example/setup.exe",
    updateManifest().artifacts.setup.url.replace("v1.1.0", "v2.0.0"),
    "file:///tmp/update.exe",
  ]) {
    const manifest = updateManifest();
    manifest.artifacts.setup.url = url;
    expect(updateManifestSchema.safeParse(manifest).success).toBe(false);
  }
  const manifest = updateManifest();
  manifest.artifacts.setup.filename = "../setup.exe";
  expect(updateManifestSchema.safeParse(manifest).success).toBe(false);
});
it("并发检查复用请求，更新状态由主进程推送，快照不能修改内部状态", async () => {
  const { service, changes, fetch } = await create();
  const first = service.check();
  expect(service.check()).toBe(first);
  expect((await first).status).toBe("available");
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(changes.map((change) => change.status)).toEqual([
    "checking",
    "available",
  ]);
  const snapshot = service.snapshot();
  snapshot.release!.version = "9.9.9";
  expect(service.snapshot().release!.version).toBe("1.1.0");
});
it.each(["1.1.0", "2.0.0"])(
  "当前版本 %s 不提示升级到 1.1.0",
  async (version) => {
    const { service } = await create(undefined, version);
    expect((await service.check()).status).toBe("current");
    await expect(service.download()).rejects.toThrow("先检查");
  },
);
it.each([404, 403, 500])("GitHub 返回 %s 时显示可重试错误", async (status) => {
  const { service } = await create(async () => new Response(null, { status }));
  expect(await service.check()).toMatchObject({
    status: "error",
    release: undefined,
  });
});
it.each(["not json", "x".repeat(256 * 1024 + 1)])(
  "拒绝损坏或过大的更新清单",
  async (text) => {
    const { service } = await create(async () => new Response(text));
    expect((await service.check()).status).toBe("error");
  },
);
it("检查超时会取消请求并允许再次重试", async () => {
  const { service } = await create(
    async (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal!.addEventListener(
          "abort",
          () => reject(new Error("aborted")),
          { once: true },
        );
      }),
  );
  vi.useFakeTimers();
  const check = service.check();
  await vi.advanceTimersByTimeAsync(15_001);
  expect(await check).toMatchObject({
    status: "error",
    error: expect.stringContaining("超时"),
  });
});
it("安装包下载校验后才暴露完整 EXE，支持重查与再次校验", async () => {
  const { directory, service, changes, fetch } = await create();
  await service.check();
  const download = service.download();
  expect(service.download()).toBe(download);
  expect((await service.check()).status).toBe("downloading");
  expect((await download).status).toBe("downloaded");
  const result = await service.downloadedFile();
  expect(await readFile(result.path)).toEqual(updateBytes);
  expect(result.path.startsWith(directory)).toBe(true);
  expect((await service.check()).status).toBe("downloaded");
  expect(fetch.mock.calls[1][0]).toBe(updateManifest().artifacts.setup.url);
  expect(
    changes.some(
      (change) =>
        change.status === "downloading" &&
        change.transferred === updateBytes.length,
    ),
  ).toBe(true);
  await writeFile(result.path, "modified after download");
  await expect(service.downloadedFile()).rejects.toThrow("校验失败");
  expect(service.snapshot().status).toBe("error");
});
it.each([
  Buffer.from(
    "wrong hash with same length".padEnd(updateBytes.length, "x"),
  ).subarray(0, updateBytes.length),
  updateBytes.subarray(0, 4),
  Buffer.concat([updateBytes, Buffer.from("extra")]),
])("哈希或大小不匹配时清除临时文件，不能打开", async (bytes) => {
  const { directory, service } = await create(async (url) =>
    url === updateManifestUrl
      ? Response.json(updateManifest())
      : new Response(bytes),
  );
  await service.check();
  expect((await service.download()).status).toBe("error");
  expect(await readdir(directory)).toEqual([]);
  await expect(service.downloadedFile()).rejects.toThrow("先下载");
});
it("取消未完成的下载后回到可下载状态并清除临时文件", async () => {
  let downloading!: () => void;
  const started = new Promise<void>((resolve) => {
    downloading = resolve;
  });
  const { directory, service } = await create(async (url, init) => {
    if (url === updateManifestUrl) return Response.json(updateManifest());
    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          init.signal!.addEventListener(
            "abort",
            () => controller.error(new Error("aborted")),
            { once: true },
          );
          controller.enqueue(updateBytes.subarray(0, 3));
          downloading();
        },
      }),
    );
  });
  await service.check();
  const pending = service.download();
  await started;
  service.cancel();
  expect((await pending).status).toBe("available");
  expect(await readdir(directory)).toEqual([]);
});
it("允许 GitHub 官方 CDN 重定向，拒绝其他域名、仓库和非 HTTPS 地址", async () => {
  const cdn =
    "https://release-assets.githubusercontent.com/github-production-release-asset/file?signature=abc";
  expect(allowedUpdateUrl(cdn)).toBe(true);
  for (const url of [
    "https://evil.example/a",
    "https://github.com/other/repo/releases/latest",
    "http://github.com/Ye11ow0817/wcl2note/releases/latest",
    "https://user@release-assets.githubusercontent.com/a",
    "https://release-assets.githubusercontent.com.evil.example/a",
  ])
    expect(allowedUpdateUrl(url)).toBe(false);
  const { service } = await create(async (url) =>
    url === updateManifestUrl
      ? Response.json(updateManifest())
      : url === cdn
        ? new Response(updateBytes)
        : new Response(null, { status: 302, headers: { location: cdn } }),
  );
  await service.check();
  expect((await service.download()).status).toBe("downloaded");
});
it("不跟随清单请求中的第三方重定向，也不无限跟随循环", async () => {
  for (const location of [
    "https://evil.example/update.json",
    updateManifestUrl,
  ]) {
    const { service, fetch } = await create(
      async () => new Response(null, { status: 302, headers: { location } }),
    );
    expect((await service.check()).status).toBe("error");
    expect(fetch.mock.calls.length).toBeLessThanOrEqual(6);
  }
});

it("检查失败保留已发现的更新和已下载安装包", async () => {
  let failed = false;
  const { service } = await create(async (url) =>
    failed
      ? new Response(null, { status: 503 })
      : url === updateManifestUrl
        ? Response.json(updateManifest())
        : new Response(updateBytes),
  );
  await service.check();
  failed = true;
  expect(await service.check()).toMatchObject({
    status: "available",
    errorPhase: "check",
    release: { version: "1.1.0" },
  });
  failed = false;
  await service.download();
  failed = true;
  expect(await service.check()).toMatchObject({
    status: "downloaded",
    errorPhase: "check",
  });
  expect((await service.downloadedFile()).path).toBeTruthy();
});

it("安装前再次校验，合并重复安装请求，成功后不会重复启动安装程序", async () => {
  const { service, changes } = await create();
  await service.check();
  await service.download();
  const open = vi.fn(async () => "");
  const installing = service.install(open);
  expect(service.install(open)).toBe(installing);
  expect((await service.check()).status).toBe("verifying");
  expect((await installing).status).toBe("installing");
  await service.install(open);
  expect(open).toHaveBeenCalledTimes(1);
  expect(changes.map((state) => state.status)).toContain("verifying");
});

it("安装程序启动失败可重试，不重复下载安装包", async () => {
  const { service, fetch } = await create();
  await service.check();
  await service.download();
  expect(await service.install(async () => "failed to open")).toMatchObject({
    status: "error",
    errorPhase: "install",
  });
  expect((await service.install(async () => "")).status).toBe("installing");
  expect(fetch).toHaveBeenCalledTimes(2);
});

it("安装前发现文件被篡改时禁止运行，改为重新下载", async () => {
  const { service } = await create();
  await service.check();
  await service.download();
  const downloaded = await service.downloadedFile();
  await writeFile(downloaded.path, "corrupt");
  const open = vi.fn(async () => "");
  expect(await service.install(open)).toMatchObject({
    status: "error",
    errorPhase: "download",
  });
  expect(open).not.toHaveBeenCalled();
  expect((await service.download()).status).toBe("downloaded");
});
