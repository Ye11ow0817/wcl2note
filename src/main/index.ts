import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  nativeTheme,
  net,
  protocol,
  safeStorage,
  session,
  shell,
  type IpcMainInvokeEvent,
} from "electron";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve, relative, isAbsolute, extname } from "node:path";
import { z } from "zod";
import { AppError, reply } from "./errors";
import { SettingsStore } from "./settings";
import { WclClient } from "./wcl/client";
import { defaultCredentials } from "./wcl/default-credentials";
import { noteFilename, windowsText } from "./export";
import { IconCache } from "./icons";
import { allowedUpdateUrl, UpdateService } from "./updates";

app.setName("WCL2NOTE");
app.setAppUserModelId("com.ye11ow.wcl2note");
if (app.isPackaged && process.platform === "win32") {
  app.commandLine.appendSwitch("lang", "zh-CN");
}
// Also allows a separate Windows profile for QA without touching the user's settings.
const profile = process.argv
  .find((arg) => arg.startsWith("--user-data-dir="))
  ?.slice("--user-data-dir=".length);
if (profile) app.setPath("userData", resolve(profile));
protocol.registerSchemesAsPrivileged([
  {
    scheme: "app",
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
    },
  },
]);

const devUrl =
  !app.isPackaged && process.env.WCL2NOTE_DEV_URL === "http://127.0.0.1:5173"
    ? process.env.WCL2NOTE_DEV_URL
    : undefined;
const pageUrl = devUrl ? new URL(devUrl).href : "app://wcl2note/index.html";
const contentSecurityPolicy = [
  "default-src 'self'",
  `script-src 'self' https://wow.zamimg.com/js/tooltips.js${devUrl ? " 'unsafe-inline'" : ""}`,
  "style-src 'self' 'unsafe-inline' https://wow.zamimg.com/css/",
  "img-src 'self' data: app://wcl2note https://wow.zamimg.com",
  `connect-src https://nether.wowhead.com${devUrl ? " 'self' ws://127.0.0.1:5173" : ""}`,
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-src 'none'",
].join("; ");
let window: BrowserWindow | null = null;
let store: SettingsStore;
let icons: IconCache;
let updates: UpdateService;
let startupUpdateCheck: ReturnType<typeof setTimeout> | undefined;
let settingsError: Error | undefined;
const wcl = new WclClient(defaultCredentials, (input, init) =>
  fetch(input, init),
);
const active = new Map<string, AbortController>();
function cancelRequests() {
  for (const controller of active.values()) controller.abort();
}
function trusted(event: {
  sender: Electron.WebContents;
  senderFrame: Electron.WebFrameMain | null;
}) {
  return (
    !!window &&
    event.sender === window.webContents &&
    event.senderFrame === event.sender.mainFrame &&
    event.senderFrame?.url === pageUrl
  );
}
function assertTrusted(event: IpcMainInvokeEvent) {
  if (!trusted(event)) throw new AppError("不允许的本地调用。", "IPC", 403);
}
const requestId = z.string().regex(/^[a-zA-Z0-9-]{1,128}$/);
const noteText = z.string().max(20 * 1024 * 1024);
function registerHandlers() {
  ipcMain.handle("updates:state", (event) =>
    reply(() => {
      assertTrusted(event);
      return updates.snapshot();
    }),
  );
  ipcMain.handle("updates:check", (event) =>
    reply(() => {
      assertTrusted(event);
      return updates.check();
    }),
  );
  ipcMain.handle("updates:download", (event) =>
    reply(() => {
      assertTrusted(event);
      return updates.download();
    }),
  );
  ipcMain.handle("updates:install", (event) =>
    reply(async () => {
      assertTrusted(event);
      const result = await updates.install((path) => shell.openPath(path));
      if (result.status === "installing") app.quit();
      return result;
    }),
  );
  ipcMain.handle("app:version", (event) =>
    reply(() => {
      assertTrusted(event);
      return app.getVersion();
    }),
  );
  ipcMain.handle("settings:get", (event) =>
    reply(async () => {
      assertTrusted(event);
      if (settingsError) throw settingsError;
      return store.load();
    }),
  );
  ipcMain.handle("settings:save", (event, input: unknown) =>
    reply(async () => {
      assertTrusted(event);
      const saved = await store.save(input);
      cancelRequests();
      wcl.setCredentials(saved);
      settingsError = undefined;
      return saved;
    }),
  );
  ipcMain.handle("wcl:query", (event, id: unknown, input: unknown) =>
    reply(async () => {
      assertTrusted(event);
      const parsed = requestId.safeParse(id);
      if (!parsed.success || active.has(parsed.data))
        throw new AppError("无效的请求编号。", "INPUT");
      if (settingsError) throw settingsError;
      if (active.size >= 12)
        throw new AppError(
          "正在处理的请求过多，请稍后重试。",
          "BUSY",
          429,
          1000,
        );
      const controller = new AbortController();
      active.set(parsed.data, controller);
      try {
        return await wcl.query(input, controller.signal);
      } catch (error) {
        if (
          controller.signal.aborted ||
          (error instanceof Error && error.name === "AbortError")
        )
          throw new AppError("已取消加载。", "ABORTED", 499);
        throw error;
      } finally {
        active.delete(parsed.data);
      }
    }),
  );
  ipcMain.on("wcl:cancel", (event, id: unknown) => {
    if (trusted(event) && typeof id === "string") active.get(id)?.abort();
  });
  ipcMain.handle("note:copy", (event, text: unknown) =>
    reply(() => {
      assertTrusted(event);
      const parsed = noteText.safeParse(text);
      if (!parsed.success) throw new AppError("笔记内容无效或过长。", "INPUT");
      clipboard.writeText(windowsText(parsed.data));
    }),
  );
  ipcMain.handle("note:save", (event, name: unknown, text: unknown) =>
    reply(async () => {
      assertTrusted(event);
      if (
        typeof name !== "string" ||
        name.length > 1024 ||
        !noteText.safeParse(text).success
      )
        throw new AppError("导出内容无效或过长。", "INPUT");
      const result = await dialog.showSaveDialog(window!, {
        title: "保存 MRT 笔记",
        defaultPath: noteFilename(name),
        filters: [{ name: "文本文件", extensions: ["txt"] }],
        properties: ["showOverwriteConfirmation"],
      });
      if (result.canceled || !result.filePath) return { canceled: true };
      try {
        await writeFile(result.filePath, windowsText(text as string), "utf8");
      } catch {
        throw new AppError(
          "无法保存笔记，请检查文件权限或选择其他位置。",
          "FILE",
        );
      }
      return { canceled: false };
    }),
  );
  ipcMain.handle("wcl:credentials-page", (event) =>
    reply(async () => {
      assertTrusted(event);
      await shell.openExternal("https://cn.warcraftlogs.com/api/clients/");
    }),
  );
}
async function registerProtocol() {
  const root = resolve(__dirname, "../dist");
  const types: Record<string, string> = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".ico": "image/x-icon",
    ".woff2": "font/woff2",
  };
  protocol.handle("app", async (request) => {
    try {
      const url = new URL(request.url);
      if (url.host !== "wcl2note" || request.method !== "GET")
        return new Response(null, { status: 403 });
      if (url.pathname.startsWith("/icons/")) {
        const parts = url.pathname.split("/");
        const image =
          parts.length === 4
            ? await icons.get(
                parts[2],
                decodeURIComponent(parts[3]) + url.search,
              )
            : undefined;
        return image
          ? new Response(new Uint8Array(image.bytes), {
              headers: {
                "Content-Type": image.type,
                "Cache-Control": "public, max-age=31536000, immutable",
                "X-Content-Type-Options": "nosniff",
              },
            })
          : new Response(null, {
              status: 404,
              headers: { "Cache-Control": "no-store" },
            });
      }
      const target = resolve(root, `.${decodeURIComponent(url.pathname)}`);
      const path = relative(root, target);
      if (
        isAbsolute(path) ||
        path === ".." ||
        path.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)
      )
        return new Response(null, { status: 403 });
      const type = types[extname(target)];
      if (!type) return new Response(null, { status: 404 });
      return new Response(new Uint8Array(await readFile(target)), {
        headers: {
          "Content-Type": type,
          "Content-Security-Policy": contentSecurityPolicy,
          "X-Content-Type-Options": "nosniff",
        },
      });
    } catch {
      return new Response(null, { status: 404 });
    }
  });
}
function createWindow() {
  nativeTheme.themeSource = "dark";
  window = new BrowserWindow({
    title: "WCL2NOTE",
    width: 1440,
    height: 960,
    minWidth: 960,
    minHeight: 720,
    show: false,
    backgroundColor: "#111923",
    autoHideMenuBar: true,
    icon: join(__dirname, "icon.png"),
    webPreferences: {
      preload: join(__dirname, "preload.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      webviewTag: false,
      spellcheck: false,
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event, url) => {
    if (url !== pageUrl) event.preventDefault();
  });
  window.webContents.on("will-attach-webview", (event) =>
    event.preventDefault(),
  );
  window.webContents.on("render-process-gone", () => cancelRequests());
  window.once("ready-to-show", () => {
    window?.show();
    if (app.isPackaged)
      startupUpdateCheck = setTimeout(() => {
        if (updates.snapshot().status === "idle") void updates.check();
      }, 3000);
  });
  window.on("closed", () => {
    cancelRequests();
    window = null;
  });
  window.webContents.on("context-menu", (_event, params) => {
    if (params.isEditable || params.selectionText)
      Menu.buildFromTemplate([
        { role: "cut", label: "剪切", enabled: params.editFlags.canCut },
        { role: "copy", label: "复制", enabled: params.editFlags.canCopy },
        { role: "paste", label: "粘贴", enabled: params.isEditable },
        { type: "separator" },
        { role: "selectAll", label: "全选" },
      ]).popup({ window: window! });
  });
  void window.loadURL(pageUrl).catch((error: unknown) => {
    // Reloading while an async external resource is still loading cancels the
    // previous navigation. Electron reports ERR_ABORTED for that normal case.
    if (
      !window ||
      window.isDestroyed() ||
      (typeof error === "object" &&
        error !== null &&
        (("code" in error && error.code === "ERR_ABORTED") ||
          ("errno" in error && error.errno === -3)))
    )
      return;
    console.error("Failed to load the local application page", error);
    dialog.showErrorBox(
      "WCL2NOTE",
      "无法加载本地应用资源，请重新安装或重新构建应用。",
    );
    app.quit();
  });
}
app
  .whenReady()
  .then(async () => {
    session.defaultSession.setPermissionRequestHandler(
      (_contents, _permission, callback) => callback(false),
    );
    session.defaultSession.setPermissionCheckHandler(() => false);
    session.defaultSession.webRequest.onHeadersReceived((details, callback) =>
      callback({
        responseHeaders: {
          ...details.responseHeaders,
          "Content-Security-Policy": [contentSecurityPolicy],
        },
      }),
    );
    icons = new IconCache(
      join(app.getPath("userData"), "icon-cache", "v1"),
      (url, init) => net.fetch(url, init),
      (bytes) => {
        const image = nativeImage.createFromBuffer(bytes);
        const { width, height } = image.getSize();
        return !image.isEmpty() && width <= 512 && height <= 512;
      },
    );
    await registerProtocol();
    const updateSession = session.fromPartition("updates");
    // Chromium fetch rejects manual redirects. Validate every hop in this
    // dedicated session before allowing its native streaming fetch to follow it.
    updateSession.webRequest.onBeforeRequest((details, callback) => {
      callback({ cancel: !allowedUpdateUrl(details.url) });
    });
    updates = new UpdateService({
      currentVersion: app.getVersion(),
      downloadsDirectory: profile
        ? join(app.getPath("userData"), "downloads")
        : app.getPath("downloads"),
      fetch: (url, init) =>
        updateSession.fetch(url, { ...init, redirect: "follow" }),
      changed: (snapshot) => {
        if (
          window &&
          !window.isDestroyed() &&
          !window.webContents.isDestroyed()
        )
          window.webContents.send("updates:changed", snapshot);
      },
    });
    store = new SettingsStore(app.getPath("userData"), safeStorage);
    try {
      wcl.setCredentials(await store.load());
    } catch (error) {
      settingsError = error as Error;
    }
    registerHandlers();
    Menu.setApplicationMenu(
      Menu.buildFromTemplate([
        { label: "文件", submenu: [{ role: "quit", label: "退出" }] },
        {
          label: "编辑",
          submenu: [
            { role: "undo", label: "撤销" },
            { role: "redo", label: "重做" },
            { type: "separator" },
            { role: "cut", label: "剪切" },
            { role: "copy", label: "复制" },
            { role: "paste", label: "粘贴" },
            { role: "selectAll", label: "全选" },
          ],
        },
        {
          label: "视图",
          submenu: [
            { role: "resetZoom", label: "实际大小" },
            { role: "zoomIn", label: "放大" },
            { role: "zoomOut", label: "缩小" },
            { role: "togglefullscreen", label: "全屏" },
            ...(!app.isPackaged
              ? [{ role: "toggleDevTools" as const, label: "开发者工具" }]
              : []),
          ],
        },
      ]),
    );
    createWindow();
  })
  .catch(() => {
    dialog.showErrorBox("WCL2NOTE", "应用初始化失败，请重新启动。");
    app.quit();
  });
app.on("window-all-closed", () => app.quit());
let flushing = false;
app.on("before-quit", (event) => {
  clearTimeout(startupUpdateCheck);
  updates?.dispose();
  cancelRequests();
  wcl.dispose();
  if (store && !flushing) {
    event.preventDefault();
    flushing = true;
    void store.flush().finally(() => app.quit());
  }
});
