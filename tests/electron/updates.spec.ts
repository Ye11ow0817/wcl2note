import {
  test as base,
  expect,
  _electron,
  type ElectronApplication,
  type Page,
} from "@playwright/test";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { execFileSync } from "node:child_process";
import { updateBytes, updateManifest } from "../fixtures/updates";
import metadata from "../../package.json" with { type: "json" };

const parts = metadata.version.split(".").map(Number);
const nextVersion = `${parts[0]}.${parts[1]}.${parts[2] + 1}`;
const nextRelease = updateManifest(nextVersion);
if (process.platform === "win32") {
  const groups = execFileSync("whoami.exe", ["/groups", "/fo", "csv", "/nh"], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (/\\CodexSandboxUsers"/i.test(groups))
    throw Error(
      "Electron 测试需要正常 Windows 用户上下文，请使用沙箱外运行权限。",
    );
}
const test = base.extend<{
  desktop: ElectronApplication;
  page: Page;
  profile: string;
}>({
  // eslint-disable-next-line no-empty-pattern -- Playwright fixture signature.
  profile: async ({}, use, info) => {
    const path = info.outputPath("profile");
    await mkdir(path, { recursive: true });
    await use(path);
  },
  desktop: async ({ profile }, use, info) => {
    const env = Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    );
    delete env.ELECTRON_RUN_AS_NODE;
    const desktop = await _electron.launch({
      ...(process.env.WCL2NOTE_EXECUTABLE
        ? { executablePath: process.env.WCL2NOTE_EXECUTABLE }
        : {}),
      args: [
        ...(process.env.WCL2NOTE_EXECUTABLE ? [] : ["."]),
        `--user-data-dir=${profile}`,
      ],
      cwd: resolve("."),
      env,
      timeout: 30000,
    });
    let closed = false;
    desktop.on("close", () => {
      closed = true;
    });
    await desktop.evaluate(
      ({ session, shell }, fixture) => {
        session.defaultSession.webRequest.onBeforeRequest(
          { urls: ["https://wow.zamimg.com/*"] },
          (_details, callback) => callback({ cancel: true }),
        );
        const state = {
          mode: fixture.auto ? "new" : "current",
          requests: [] as string[],
          opened: "",
          finishDownload: undefined as (() => void) | undefined,
        };
        (
          globalThis as typeof globalThis & { testUpdates: typeof state }
        ).testUpdates = state;
        const updates = session.fromPartition("updates");
        (
          globalThis as typeof globalThis & {
            testUpdateFetch: typeof updates.fetch;
          }
        ).testUpdateFetch = updates.fetch.bind(updates);
        updates.fetch = async (input, init) => {
          const url = typeof input === "string" ? input : input.url;
          state.requests.push(url);
          if (state.mode === "failed")
            return new Response(null, { status: 503 });
          if (url.endsWith("update.json"))
            return Response.json(
              state.mode === "current" ? fixture.current : fixture.manifest,
            );
          if (state.mode === "slow")
            return new Response(
              new ReadableStream<Uint8Array>({
                start(controller) {
                  init?.signal?.addEventListener(
                    "abort",
                    () => controller.error(Error("aborted")),
                    { once: true },
                  );
                  const middle = Math.floor(fixture.bytes.length / 2);
                  controller.enqueue(
                    new Uint8Array(fixture.bytes.slice(0, middle)),
                  );
                  state.finishDownload = () => {
                    controller.enqueue(
                      new Uint8Array(fixture.bytes.slice(middle)),
                    );
                    controller.close();
                  };
                },
              }),
            );
          return new Response(
            new Uint8Array(
              state.mode === "corrupt"
                ? fixture.bytes.map((value) => value ^ 255)
                : fixture.bytes,
            ),
          );
        };
        shell.openPath = async (path) => {
          state.opened = path;
          return state.mode === "install-failed" ? "failed to open" : "";
        };
      },
      {
        manifest: nextRelease,
        current: updateManifest(metadata.version),
        bytes: [...updateBytes],
        auto: info.title.includes("正式包启动"),
      },
    );
    await use(desktop);
    // Keep the inspector attached while credentials flush during shutdown.
    if (!closed)
      await desktop
        .evaluate(
          ({ app }) =>
            new Promise<void>((resolve) => {
              app.once("will-quit", () => resolve());
              app.quit();
            }),
        )
        .catch(() => {});
    if (!closed) await desktop.close().catch(() => {});
  },
  page: async ({ desktop }, use) => {
    const page = await desktop.firstWindow();
    await expect(page.getByRole("button", { name: "加载报告" })).toBeEnabled();
    await use(page);
  },
});
async function mode(desktop: ElectronApplication, mode: string) {
  await desktop.evaluate((_electron, mode) => {
    (
      globalThis as typeof globalThis & { testUpdates: { mode: string } }
    ).testUpdates.mode = mode;
  }, mode);
}
const headerAction = (page: Page) =>
  page.locator(".header-right .update-action");
const panel = (page: Page) =>
  page.getByRole("region", { name: "应用更新", exact: true });
async function settings(page: Page) {
  await page.getByRole("button", { name: "设置", exact: true }).click();
}
async function check(desktop: ElectronApplication, page: Page) {
  await mode(desktop, "new");
  const checked = await page.evaluate(() => window.wcl2note.checkForUpdates());
  expect(checked).toMatchObject({ ok: true, data: { status: "available" } });
}
async function downloadedPath(profile: string) {
  const directory = join(profile, "downloads");
  const subdirectories = await readdir(directory);
  for (const name of subdirectories) {
    const path = join(directory, name, nextRelease.artifacts.setup.filename);
    try {
      await readFile(path);
      return path;
    } catch {
      /* Still downloading or another completed download. */
    }
  }
  throw Error("No downloaded installer");
}

test("更新：无更新隐藏按钮，设置只保留检查与更新操作，作者移入设置", async ({
  desktop,
  page,
}) => {
  await expect(
    page.locator("main > footer, .mode, .update-notice"),
  ).toHaveCount(0);
  await expect(headerAction(page)).toHaveCount(0);
  await expect(page.getByText("Ye11ow", { exact: false })).not.toBeVisible();
  await settings(page);
  await expect(page.locator(".settings-meta")).toContainText("Ye11ow");
  await expect(page.locator(".settings-meta")).toHaveText(
    `WCL2NOTE ${metadata.version} · Ye11ow`,
  );
  await expect(panel(page).getByRole("heading")).toHaveCount(0);
  await expect(panel(page).getByRole("button")).toHaveCount(1);
  await mode(desktop, "current");
  await panel(page)
    .getByRole("button", { name: "检查更新", exact: true })
    .click();
  await expect(panel(page).getByRole("status")).toHaveText("当前已是最新版本");
  await expect(headerAction(page)).toHaveCount(0);
  await mode(desktop, "failed");
  await panel(page)
    .getByRole("button", { name: "检查更新", exact: true })
    .click();
  await expect(panel(page).getByRole("alert")).toContainText("503");
  await expect(headerAction(page)).toHaveCount(0);
  await mode(desktop, "new");
  await panel(page)
    .getByRole("button", { name: "检查更新", exact: true })
    .click();
  await expect(panel(page).getByRole("button")).toHaveCount(2);
  await expect(panel(page).getByRole("status")).toHaveText(
    `有新版本v${nextVersion}`,
  );
  await expect(panel(page).locator(".update-action")).toHaveText("更新");
  await expect(headerAction(page)).toHaveText("更新");
  await expect(
    page.locator(".update-notes, .update-progress, .update-meta"),
  ).toHaveCount(0);
  await expect(page.getByRole("combobox", { name: "更新包类型" })).toHaveCount(
    0,
  );
});

test("更新：首页直接下载，设置同步百分比和颜色，校验后安装", async ({
  desktop,
  page,
  profile,
}, info) => {
  await check(desktop, page);
  await mode(desktop, "slow");
  await headerAction(page).click();
  await expect(headerAction(page)).toHaveText("50%");
  await expect(
    headerAction(page).locator(".update-progress-fill"),
  ).toHaveAttribute("style", "width: 50%;");
  await expect(headerAction(page)).toBeDisabled();
  await expect(headerAction(page)).toHaveAttribute(
    "data-update-tone",
    "downloading",
  );
  await settings(page);
  await expect(
    panel(page).getByRole("button", { name: "检查更新", exact: true }),
  ).toBeDisabled();
  await expect(panel(page).locator(".update-action")).toHaveText("50%");
  await expect(panel(page).locator(".update-progress-fill")).toHaveAttribute(
    "style",
    "width: 50%;",
  );
  await expect(panel(page).locator(".update-action")).toBeDisabled();
  // Wait for each button to reach the download color after its transition.
  const downloadColor = "rgb(23, 79, 98)";
  await expect(headerAction(page)).toHaveCSS("background-color", downloadColor);
  await expect(panel(page).locator(".update-action")).toHaveCSS(
    "background-color",
    downloadColor,
  );
  await page.screenshot({ path: info.outputPath("updates-progress.png") });
  await desktop.evaluate(() => {
    (
      globalThis as typeof globalThis & {
        testUpdates: { finishDownload?: () => void };
      }
    ).testUpdates.finishDownload!();
  });
  await expect(panel(page).locator(".update-action")).toHaveText("安装");
  await expect(headerAction(page)).toHaveText("安装");
  await expect(headerAction(page)).toHaveAttribute("data-update-tone", "ready");
  const file = await downloadedPath(profile);
  expect(await readFile(file)).toEqual(updateBytes);
  expect(file.endsWith(`WCL2NOTE-${nextVersion}-win-x64-setup.exe`)).toBe(true);
  await desktop.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setSize(960, 720),
  );
  await expect(
    panel(page).getByRole("button", { name: "安装", exact: true }),
  ).toBeInViewport({ ratio: 1 });
  await page.screenshot({ path: info.outputPath("updates-settings-960.png") });
  await page.getByRole("button", { name: "关闭设置" }).click();
  await page.screenshot({ path: info.outputPath("updates-home-960.png") });
  const closed = desktop.waitForEvent("close");
  await headerAction(page).click();
  await closed;
});

test("更新：下载和校验失败显示红色重试，安装失败可再次安装", async ({
  desktop,
  page,
  profile,
}) => {
  await check(desktop, page);
  await mode(desktop, "failed");
  await headerAction(page).click();
  await expect(headerAction(page)).toHaveText("重试");
  await expect(headerAction(page)).toHaveAttribute("data-update-tone", "error");
  await settings(page);
  await expect(panel(page).locator(".update-action")).toHaveText("重试");
  await mode(desktop, "corrupt");
  await panel(page).locator(".update-action").click();
  await expect(panel(page).locator(".update-action")).toHaveText("重试");
  await expect(panel(page).locator(".update-action")).toHaveAttribute(
    "title",
    /校验失败/,
  );
  expect(await readdir(join(profile, "downloads"))).toEqual([]);
  await mode(desktop, "new");
  await panel(page).locator(".update-action").click();
  await expect(panel(page).locator(".update-action")).toHaveText("安装");
  await writeFile(await downloadedPath(profile), "modified after verification");
  await panel(page).locator(".update-action").click();
  await expect(panel(page).locator(".update-action")).toHaveText("重试");
  expect(
    await desktop.evaluate(
      () =>
        (globalThis as typeof globalThis & { testUpdates: { opened: string } })
          .testUpdates.opened,
    ),
  ).toBe("");
  await panel(page).locator(".update-action").click();
  await expect(panel(page).locator(".update-action")).toHaveText("安装");
  await mode(desktop, "install-failed");
  await panel(page).locator(".update-action").click();
  await expect(panel(page).locator(".update-action")).toHaveText("重试");
  await expect(panel(page).locator(".update-action")).toHaveAttribute(
    "title",
    "无法启动安装程序，请重试。",
  );
  await mode(desktop, "new");
  const closed = desktop.waitForEvent("close");
  // A successful retry launches the existing verified installer, without another download.
  await panel(page).locator(".update-action").click();
  await closed;
});

test("更新：正式包启动后只显示更新按钮，没有提示栏", async ({
  desktop,
  page,
}) => {
  test.skip(!process.env.WCL2NOTE_EXECUTABLE, "仅正式包自动检查");
  await expect(headerAction(page)).toHaveText("更新", { timeout: 15000 });
  await expect(
    page.locator("main > footer, .mode, .update-notice"),
  ).toHaveCount(0);
  expect(
    await desktop.evaluate(
      () =>
        (
          globalThis as typeof globalThis & {
            testUpdates: { requests: string[] };
          }
        ).testUpdates.requests.length,
    ),
  ).toBe(1);
});

test("更新：Chromium 网络处理 GitHub 重定向，拒绝第三方地址并保留已下载状态", async ({
  desktop,
  page,
}) => {
  await desktop.evaluate(
    ({ session }, fixture) => {
      const updates = session.fromPartition("updates");
      updates.fetch = (
        globalThis as typeof globalThis & {
          testUpdateFetch: typeof updates.fetch;
        }
      ).testUpdateFetch;
      updates.protocol.handle("https", (request) =>
        request.url.endsWith("update.json")
          ? new Response(null, {
              status: 302,
              headers: {
                location:
                  "https://release-assets.githubusercontent.com/manifest",
              },
            })
          : request.url.endsWith("/manifest")
            ? Response.json(fixture.manifest)
            : new Response(new Uint8Array(fixture.bytes)),
      );
    },
    { manifest: nextRelease, bytes: [...updateBytes] },
  );
  await check(desktop, page);
  await headerAction(page).click();
  await expect(headerAction(page)).toHaveText("安装");
  await desktop.evaluate(({ session }) => {
    const updates = session.fromPartition("updates");
    updates.protocol.unhandle("https");
    (
      globalThis as typeof globalThis & { escapedUpdateRedirect: boolean }
    ).escapedUpdateRedirect = false;
    updates.protocol.handle("https", (request) => {
      if (request.url.endsWith("update.json"))
        return new Response(null, {
          status: 302,
          headers: { location: "https://example.com/unsafe-update.json" },
        });
      (
        globalThis as typeof globalThis & { escapedUpdateRedirect: boolean }
      ).escapedUpdateRedirect = true;
      return new Response("unsafe");
    });
  });
  const blocked = await page.evaluate(() => window.wcl2note.checkForUpdates());
  expect(blocked).toMatchObject({
    ok: true,
    data: { status: "downloaded", errorPhase: "check" },
  });
  expect(
    await desktop.evaluate(
      () =>
        (globalThis as typeof globalThis & { escapedUpdateRedirect: boolean })
          .escapedUpdateRedirect,
    ),
  ).toBe(false);
  await expect(headerAction(page)).toHaveText("安装");
});
