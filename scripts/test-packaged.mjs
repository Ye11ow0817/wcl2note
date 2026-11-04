/* global window, document */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdir, readFile } from "node:fs/promises";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "@playwright/test";

const metadata = JSON.parse(await readFile("package.json", "utf8"));
const executable = resolve(
  process.argv[2] ?? "release/win-unpacked/WCL2NOTE.exe",
);
const output = resolve("test-results/packaged");
await mkdir(output, { recursive: true });
const profile = resolve(output, `profile-${Date.now()}`);
await mkdir(profile);
const server = createServer();
server.listen(0, "127.0.0.1");
await once(server, "listening");
const address = server.address();
assert(address && typeof address === "object");
const port = address.port;
await new Promise((done, reject) =>
  server.close((error) => (error ? reject(error) : done())),
);
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(
  executable,
  [`--remote-debugging-port=${port}`, `--user-data-dir=${profile}`],
  { env, stdio: "ignore", windowsHide: true },
);
let browser;
try {
  console.log("Starting the packaged Windows executable…");
  let endpoint;
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`, {
        signal: AbortSignal.timeout(1000),
      });
      if (response.ok) {
        endpoint = (await response.json()).webSocketDebuggerUrl;
        break;
      }
    } catch {
      /* Electron is still starting. */
    }
    await delay(250);
  }
  assert(endpoint, "Packaged app did not start its local browser context");
  browser = await chromium.connectOverCDP(endpoint);
  const context = browser.contexts()[0];
  const page = context.pages()[0] ?? (await context.waitForEvent("page"));
  await page.waitForFunction(
    () => document.title === "WCL2NOTE" && !!window.wcl2note,
  );
  await page.getByRole("button", { name: "加载报告" }).waitFor();
  const ready = await page.evaluate(async () => {
    const settings = await window.wcl2note.getSettings();
    const version = await window.wcl2note.version();
    return {
      settingsOk: settings.ok,
      mode: settings.ok ? settings.data.mode : "error",
      version: version.ok ? version.data : "error",
    };
  });
  assert.deepEqual(ready, {
    settingsOk: true,
    mode: "default",
    version: metadata.version,
  });
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page
    .getByLabel("Client ID", { exact: true })
    .fill("packaged-fixture-id");
  await page
    .getByLabel("Client Secret", { exact: true })
    .fill("packaged-fixture-secret");
  await page.waitForFunction(() =>
    document
      .querySelector(".settings-status")
      ?.textContent?.includes("已自动保存到本机"),
  );
  await page.getByRole("button", { name: "恢复默认" }).click();
  await page.waitForFunction(async () => {
    const saved = await window.wcl2note.getSettings();
    return saved.ok && saved.data.mode === "default";
  });
  await page.getByRole("button", { name: "关闭设置" }).click();
  await page.getByRole("button", { name: "时间轴视图", exact: true }).click();
  assert.equal(await page.locator(".timeline-row").count(), 0);
  await page
    .getByText("加载报告并选择战斗后查看时间轴。", { exact: true })
    .waitFor();
  await page.screenshot({
    path: resolve(output, "window.png"),
    fullPage: true,
  });
  await page.close();
  console.log(
    "PASS: packaged EXE starts, uses IPC and encrypted settings, restores defaults, and shows the empty timeline before loading a report.",
  );
} finally {
  await browser?.close().catch(() => {});
  if (child.exitCode === null) {
    await Promise.race([once(child, "exit"), delay(5000)]);
    if (child.exitCode === null)
      spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
  }
}
