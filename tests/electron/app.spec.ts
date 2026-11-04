import {
  test as base,
  expect,
  _electron,
  type ElectronApplication,
  type Page,
} from "@playwright/test";
import { mkdir, readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { report, enemies, friendlies } from "../fixtures/report";
import { timelineReport, timelineEvents } from "../fixtures/timeline";
import type { RawEvent } from "../../src/domain/model";
import { skillProfilesStorageKey } from "../../src/renderer/features/skill-profiles/storage";
import type { SkillProfileLibrary } from "../../src/domain/skillProfile";

const checkedShutdowns = new WeakSet<ElectronApplication>();

// Fail before launching any windows: this account makes Electron's Windows
// sandbox access check fail even when its runtime directory has the required ACL.
if (process.platform === "win32") {
  const groups = execFileSync("whoami.exe", ["/groups", "/fo", "csv", "/nh"], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (/\\CodexSandboxUsers"/i.test(groups))
    throw new Error(
      "已阻止启动 Electron：当前为 Codex Windows 受限测试账户，会触发运行时访问检查失败（0x80000003）。请在正常 Windows 用户上下文运行 npm run test:electron；Codex 执行时需使用沙箱外运行权限。",
    );
}

async function launch(profile: string) {
  await mkdir(profile, { recursive: true });
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
  delete env.ELECTRON_RUN_AS_NODE;
  return _electron.launch({
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
}
async function mockWcl(desktop: ElectronApplication, fixtureReport = report) {
  await desktop.evaluate(
    (electron, fixtures) => {
      const state = {
        slow: false,
        failures: 0,
        canceled: 0,
        tokenRequests: 0,
        eventRequests: [] as { dataType: string; hostilityType: string }[],
        openedUrl: "",
        iconRequests: [] as string[],
        iconsFail: false,
        tooltipRequests: [] as string[],
        tooltipDelay: 0,
        tooltipsFail: false,
        tooltipNotFound: false,
        loadErrors: [] as string[],
      };
      (globalThis as typeof globalThis & { testWcl: typeof state }).testWcl =
        state;
      electron.dialog.showErrorBox = (title, content) => {
        state.loadErrors.push(title + ": " + content);
      };
      const nativeFetch = electron.net.fetch.bind(electron.net);
      const icon = electron.nativeImage
        .createFromBitmap(Buffer.from([255, 170, 85, 255]), {
          width: 1,
          height: 1,
        })
        .toPNG();
      electron.net.fetch = async (url, init) => {
        const requestUrl = typeof url === "string" ? url : url.url;
        if (!requestUrl.startsWith("https://assets.rpglogs.com/"))
          return nativeFetch(url, init);
        state.iconRequests.push(requestUrl);
        return state.iconsFail
          ? new Response(null, { status: 403 })
          : new Response(new Uint8Array(icon), {
              headers: { "Content-Type": "image/png" },
            });
      };
      globalThis.fetch = async (url, init) => {
        if (url === "https://www.warcraftlogs.com/oauth/token") {
          state.tokenRequests++;
          return Response.json({
            access_token: "fixture-token",
            token_type: "Bearer",
            expires_in: 3600,
          });
        }
        if (url !== "https://cn.warcraftlogs.com/api/v2/client")
          throw Error("Unexpected endpoint");
        const body = JSON.parse(init!.body as string);
        const v = body.variables;
        if (state.failures > 0) {
          state.failures--;
          return new Response(null, { status: 403 });
        }
        if (v.reportCode === "slow") {
          state.slow = true;
          init?.signal?.addEventListener("abort", () => state.canceled++, {
            once: true,
          });
          await new Promise((done) => setTimeout(done, 700));
        }
        const events = body.query.includes("query GetFightAbilityEvents");
        if (events)
          state.eventRequests.push({
            dataType: v.dataType,
            hostilityType: v.hostilityType,
          });
        const data = events
          ? {
              events: {
                data:
                  v.dataType === "Casts"
                    ? v.hostilityType === "Enemies"
                      ? fixtures.enemies
                      : fixtures.friendlies
                    : [
                        {
                          type:
                            v.dataType === "Buffs"
                              ? "applybuff"
                              : "applydebuff",
                          timestamp: 71000,
                          abilityGameID:
                            v.hostilityType === "Friendlies" ? 200 : 100,
                          targetID: v.hostilityType === "Friendlies" ? 20 : 10,
                        },
                      ],
                nextPageTimestamp: null,
              },
            }
          : v.reportCode === "slow"
            ? {
                ...fixtures.report,
                fights: [{ ...fixtures.report.fights![0], name: "旧报告" }],
              }
            : fixtures.report;
        return Response.json({ data: { reportData: { report: data } } });
      };
    },
    { report: fixtureReport, enemies, friendlies },
  );
}
const test = base.extend<{
  desktop: ElectronApplication;
  appPage: Page;
  profile: string;
}>({
  // eslint-disable-next-line no-empty-pattern -- Playwright requires a destructured fixtures argument.
  profile: async ({}, use, info) => {
    await use(info.outputPath("profile"));
  },
  desktop: async ({ profile }, use) => {
    const desktop = await launch(profile);
    await mockWcl(desktop);
    await installWowheadFixture(desktop);
    await use(desktop);
    await desktop.close().catch(() => {});
  },
  appPage: async ({ desktop }, use) => {
    const page = await desktop.firstWindow();
    await expect
      .poll(() =>
        desktop.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows()[0].isVisible(),
        ),
      )
      .toBe(true);
    await page.bringToFront();
    await expect(page.getByRole("button", { name: "加载报告" })).toBeEnabled();
    await page.reload();
    await expect(page.getByRole("button", { name: "加载报告" })).toBeEnabled();
    await expect
      .poll(() => page.evaluate(() => !!window.WH?.Tooltips))
      .toBe(true);
    await use(page);
    if (!checkedShutdowns.has(desktop)) await expectNoLocalLoadErrors(desktop);
  },
});
async function expectNoLocalLoadErrors(desktop: ElectronApplication) {
  expect(
    await desktop.evaluate(
      () =>
        (
          globalThis as typeof globalThis & {
            testWcl: { loadErrors: string[] };
          }
        ).testWcl.loadErrors,
    ),
  ).toEqual([]);
}
async function closeAfterLoadCheck(desktop: ElectronApplication) {
  await expectNoLocalLoadErrors(desktop);
  await desktop.close();
  checkedShutdowns.add(desktop);
}
async function load(
  page: Page,
  input = "https://cn.warcraftlogs.com/reports/abc?fight=last",
) {
  await page.getByLabel("报告链接").fill(input);
  await page.getByRole("button", { name: "加载报告" }).click();
}
async function seedSkillProfiles(page: Page, library: SkillProfileLibrary) {
  await page.evaluate(
    ({ key, library }) => localStorage.setItem(key, JSON.stringify(library)),
    { key: skillProfilesStorageKey, library },
  );
  await page.reload();
  await expect(
    page.getByRole("button", { name: "加载报告", exact: true }),
  ).toBeEnabled();
  await expect
    .poll(() => page.evaluate(() => !!window.WH?.Tooltips))
    .toBe(true);
}
async function chooseSkillProfile(page: Page, name: string) {
  await page.getByLabel("选择技能配置", { exact: true }).click();
  await page
    .locator(".profile-options")
    .getByRole("button", { name, exact: true })
    .click();
}
async function profileCommand(page: Page, name: "配置管理" | "另存为") {
  const controls = page.locator(".skill-profile-controls");
  const command = controls.getByRole("button", { name, exact: true });
  if (!(await command.isVisible()))
    await controls.getByLabel("选择技能配置", { exact: true }).click();
  await command.click();
}
async function savedSkillProfiles(page: Page): Promise<SkillProfileLibrary> {
  return page.evaluate(
    (key) => JSON.parse(localStorage.getItem(key)!),
    skillProfilesStorageKey,
  );
}
async function firstCastActor(
  page: Page,
  count = 2,
  side: "队友" | "敌对" = "敌对",
) {
  await page.getByRole("button", { name: side, exact: true }).click();
  await expect(page.locator(".actor-row")).toHaveCount(count);
  await page.locator(".actor-row").first().click();
  await expect(page.locator(".skill")).toHaveCount(1);
}

async function configureWowhead(
  desktop: ElectronApplication,
  config: Partial<{
    tooltipDelay: number;
    tooltipsFail: boolean;
    tooltipNotFound: boolean;
  }>,
) {
  await desktop.evaluate((_electron, config) => {
    Object.assign(
      (globalThis as typeof globalThis & { testWcl: object }).testWcl,
      config,
    );
  }, config);
}
async function wowheadRequests(desktop: ElectronApplication) {
  return desktop.evaluate(
    () =>
      (
        globalThis as typeof globalThis & {
          testWcl: { tooltipRequests: string[] };
        }
      ).testWcl.tooltipRequests,
  );
}
const officialScript = readFile(
  resolve("tests/fixtures/wowhead/tooltips.js.txt"),
  "utf8",
);
const officialStyles = readFile(
  resolve("tests/fixtures/wowhead/universal.css"),
  "utf8",
);
async function installWowheadFixture(desktop: ElectronApplication) {
  await desktop.evaluate(
    ({ protocol, net }, resources) => {
      const cors = { "Access-Control-Allow-Origin": "*" };
      protocol.handle("https", async (request) => {
        const url = new URL(request.url);
        if (url.href === "https://wow.zamimg.com/js/tooltips.js")
          return new Response(resources.script, {
            headers: { ...cors, "Content-Type": "text/javascript" },
          });
        if (
          url.hostname === "wow.zamimg.com" &&
          url.pathname.startsWith("/css/")
        )
          return new Response(resources.styles, {
            headers: { ...cors, "Content-Type": "text/css" },
          });
        if (url.hostname !== "nether.wowhead.com")
          return net.fetch(request, { bypassCustomProtocolHandlers: true });
        const match = url.pathname.match(/\/tooltip\/spell\/(\d+)/);
        if (!match) return Response.json({}, { headers: cors });
        const state = (
          globalThis as typeof globalThis & {
            testWcl: {
              tooltipRequests: string[];
              tooltipDelay: number;
              tooltipsFail: boolean;
              tooltipNotFound: boolean;
            };
          }
        ).testWcl;
        state.tooltipRequests.push(url.href);
        const { tooltipDelay, tooltipsFail, tooltipNotFound } = state;
        if (tooltipDelay)
          await new Promise((done) => setTimeout(done, tooltipDelay));
        if (tooltipsFail)
          return new Response(null, { status: 503, headers: cors });
        const id = Number(match[1]);
        const name =
          id === 200
            ? "时间扭曲"
            : id === 100
              ? "裂解"
              : id === 642
                ? "圣盾术"
                : "技能 " + id;
        return Response.json(
          tooltipNotFound
            ? { error: "Not found" }
            : {
                name,
                icon: "spell_holy_divineshield",
                tooltip:
                  '<table><tr><td><b class="whtt-name">' +
                  name +
                  '</b><br>瞬发<br><span class="q">来自 Wowhead 的中文技能说明 ' +
                  id +
                  "。</span></td></tr></table>",
              },
          { headers: cors },
        );
      });
    },
    { script: await officialScript, styles: await officialStyles },
  );
}
function officialTooltip(page: Page) {
  return page.locator('.wowhead-tooltip[data-visible="yes"]').first();
}

test("Wowhead 官方：按需加载中文说明，使用原生加载和成功外观，图标点击仍生成 Note", async ({
  appPage: page,
  desktop,
}, info) => {
  await configureWowhead(desktop, { tooltipDelay: 1200 });
  await load(page);
  await firstCastActor(page, 1, "队友");
  expect(await wowheadRequests(desktop)).toEqual([]);
  await expect(page.locator(".skill .game-icon")).toHaveAttribute(
    "data-wowhead",
    "spell=200&domain=cn",
  );
  await expect(page.locator(".skill .skill-name")).toHaveText("时间扭曲");
  await page.locator(".actor-icon").first().hover();
  await expect(officialTooltip(page)).toHaveCount(0);
  const skill = page.locator('.skill[data-ability-id="200"]');
  const icon = skill.locator(".game-icon");
  await icon.hover();
  const tooltip = officialTooltip(page);
  await expect(tooltip).toContainText("正在载入");
  await page.screenshot({
    path: info.outputPath("wowhead-official-loading.png"),
  });
  await expect(tooltip).toContainText("中文技能说明 200");
  await expect(tooltip.locator(".wowhead-tooltip-powered")).toHaveCount(1);
  await expect(
    page.locator(
      ".wowhead-spell-tooltip, .wowhead-tooltip-source, .wowhead-tooltip-event",
    ),
  ).toHaveCount(0);
  expect(await wowheadRequests(desktop)).toEqual([
    "https://nether.wowhead.com/tooltip/spell/200?dataEnv=1&locale=4",
  ]);
  await expect(page.locator(".skill .game-icon img")).toHaveCount(1);
  await page.screenshot({
    path: info.outputPath("wowhead-official-success.png"),
  });
  await page.getByLabel("报告链接").hover();
  await expect(tooltip).toHaveCount(0);
  await icon.hover();
  await expect(tooltip).toContainText("中文技能说明 200");
  expect(await wowheadRequests(desktop)).toHaveLength(1);
  const url = page.url();
  await icon.click();
  await expect(skill.getByRole("checkbox")).toBeChecked();
  await expect(page.getByLabel("Note 预览", { exact: true })).toHaveValue(
    /time:00:17\.0.*时间扭曲/,
  );
  expect(page.url()).toBe(url);
  expect(await page.evaluate(() => window.whTooltips)).toEqual({
    colorLinks: false,
    iconizeLinks: false,
    renameLinks: false,
  });
});

test("Wowhead 官方：原生无响应、重新悬浮重试和未找到状态", async ({
  appPage: page,
  desktop,
}, info) => {
  await configureWowhead(desktop, { tooltipsFail: true });
  await load(page);
  await firstCastActor(page, 1, "队友");
  const icon = page.locator(".skill .game-icon");
  const tooltip = officialTooltip(page);
  await icon.hover();
  await expect(tooltip).toContainText("服务器没有响应");
  await page.screenshot({
    path: info.outputPath("wowhead-official-error.png"),
  });
  await page.getByLabel("报告链接").hover();
  await configureWowhead(desktop, { tooltipsFail: false });
  await icon.hover();
  await expect(tooltip).toContainText("中文技能说明 200");
  expect(await wowheadRequests(desktop)).toHaveLength(2);
  await configureWowhead(desktop, { tooltipNotFound: true });
  await firstCastActor(page);
  await page.locator(".skill .game-icon").hover();
  await expect(tooltip).toContainText("未找到");
});

test("Wowhead 官方：迟到响应不会覆盖当前技能，离开和 Escape 关闭提示", async ({
  appPage: page,
  desktop,
}) => {
  await configureWowhead(desktop, { tooltipDelay: 1500 });
  await load(page);
  await firstCastActor(page, 1, "队友");
  const earlier = page.waitForResponse((response) =>
    response.url().includes("/tooltip/spell/200?"),
  );
  await page.locator(".skill .game-icon").hover();
  await expect
    .poll(async () => (await wowheadRequests(desktop)).length)
    .toBe(1);
  await configureWowhead(desktop, { tooltipDelay: 0 });
  await firstCastActor(page);
  await page.locator(".skill .game-icon").hover();
  const tooltip = officialTooltip(page);
  await expect(tooltip).toContainText("中文技能说明 100");
  await earlier;
  await expect(tooltip).toContainText("中文技能说明 100");
  await expect(tooltip).not.toContainText("中文技能说明 200");
  await page.keyboard.press("Escape");
  await expect(tooltip).toHaveCount(0);
  await page.getByLabel("报告链接").hover();
  await page.locator(".skill .game-icon").hover();
  await expect(tooltip).toBeVisible();
  await page.getByRole("button", { name: "时间轴视图", exact: true }).click();
  await expect(tooltip).toHaveCount(0);
});

test("Wowhead 官方：时间轴行和事件使用标准链接，点击及键盘聚焦保留，960 窗口边缘避让", async ({
  appPage: page,
  desktop,
}, info) => {
  await load(page);
  await page.getByRole("button", { name: "时间轴视图", exact: true }).click();
  await timelineWindow(page, "full");
  const row = page.locator('.timeline-row[data-side="friendly"]').first();
  const marker = row.locator(".timeline-marker").first();
  const tooltip = officialTooltip(page);
  await marker.hover();
  await expect(tooltip).toContainText("中文技能说明 200");
  await expect(page.locator(".timeline-event-tooltip")).toHaveCount(0);
  await page.getByLabel("报告链接").hover();
  await row.locator(".timeline-skill-label .game-icon").hover();
  await expect(tooltip).toContainText("中文技能说明 200");
  await expect(row.locator("a a")).toHaveCount(0);
  await marker.focus();
  await marker.press(" ");
  await expect(marker).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".timeline-event-detail")).toContainText(
    "00:17.000",
  );
  await desktop.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setSize(960, 720),
  );
  await expect.poll(() => page.evaluate(() => window.outerWidth)).toBe(960);
  await page.getByLabel("报告链接").hover();
  await marker.hover();
  await expect(tooltip).toBeVisible();
  const box = (await tooltip.boundingBox())!;
  const viewport = await page.evaluate(() => ({
    width: innerWidth,
    height: innerHeight,
  }));
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
  expect(box.y + box.height).toBeLessThanOrEqual(viewport.height);
  await page.screenshot({
    path: info.outputPath("wowhead-official-timeline-960.png"),
  });
});

test("Wowhead 官方：配置和添加技能窗口使用原生外观，提示在模态窗口上方", async ({
  appPage: page,
}, info) => {
  await seedSkillProfiles(page, {
    version: 1,
    profiles: [
      {
        id: "tooltip",
        name: "提示验证",
        skills: [
          {
            abilityId: 642,
            name: "圣盾术",
            eventType: "Casts",
            side: "friendly",
          },
        ],
      },
    ],
  });
  await page.getByRole("button", { name: "配置管理", exact: true }).click();
  const manager = page.getByRole("dialog", { name: "配置管理", exact: true });
  const profile = manager.locator(".profile-library-item");
  if (
    !(await profile.evaluate((element) => (element as HTMLDetailsElement).open))
  )
    await profile.locator("summary").click();
  await manager.locator(".profile-skill .game-icon").hover();
  const tooltip = officialTooltip(page);
  await expect(tooltip).toContainText("中文技能说明 642");
  expect(
    await tooltip.evaluate((element) => !!element.closest("dialog[open]")),
  ).toBe(true);
  await expect(tooltip).toHaveCSS("position", "fixed");
  await page.screenshot({
    path: info.outputPath("wowhead-official-profile.png"),
  });
  await manager.getByRole("button", { name: "添加技能", exact: true }).click();
  const picker = page.getByRole("dialog", { name: "添加技能", exact: true });
  await picker
    .getByRole("searchbox", { name: "搜索可添加技能", exact: true })
    .fill("圣盾术");
  await picker.locator(".profile-skill-option .game-icon").first().hover();
  await expect(tooltip).toContainText("中文技能说明 642");
  await expect(
    picker.locator(".profile-skill-option input").first(),
  ).toBeDisabled();
});

async function chooseSegment(page: Page, name: string | RegExp) {
  await page.getByRole("button", { name: "选择阶段", exact: true }).click();
  await page.locator(".segment-list").getByRole("button", { name }).click();
}

async function ensureNoteOpen(page: Page) {
  const expand = page.getByRole("button", {
    name: "展开 Note 预览",
    exact: true,
  });
  if (await expand.isVisible()) await expand.click();
}

async function selectFight(page: Page, index: number) {
  const selector = page.getByRole("button", { name: "选择战斗", exact: true });
  if ((await selector.getAttribute("aria-expanded")) !== "true")
    await selector.click();
  const card = page
    .locator(
      ".fight-card, .fight-boss-select[data-only-fight-id], .fight-trash-item",
    )
    .nth(index);
  if (
    !(await card.evaluate((element) =>
      element.classList.contains("fight-card"),
    ))
  ) {
    await card.click();
    return;
  }
  const toggle = card
    .locator('xpath=ancestor::section[contains(@class, "fight-boss-group")]')
    .locator(".fight-boss-toggle");
  if ((await toggle.getAttribute("aria-expanded")) !== "true")
    await toggle.click();
  await card.click();
}

// 这些交互回归只调整视窗；阶段筛选由 chooseSegment 单独验证。
async function timelineWindow(page: Page, window: "first" | "second" | "full") {
  const start = page.getByRole("slider", { name: "时间轴范围起点" });
  const end = page.getByRole("slider", { name: "时间轴范围终点" });
  await start.press("Home");
  await end.press("End");
  if (window !== "full") {
    await page.getByRole("button", { name: "放大时间轴", exact: true }).click();
    await page.locator(".timeline-viewport").dispatchEvent("wheel", {
      shiftKey: true,
      deltaX: window === "first" ? -10000 : 10000,
    });
  }
}
async function mockEventData(
  desktop: ElectronApplication,
  events: Record<string, RawEvent[]>,
) {
  await desktop.evaluate((_electron, events) => {
    const original = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      if (url === "https://cn.warcraftlogs.com/api/v2/client") {
        const body = JSON.parse(init!.body as string);
        const variables = body.variables;
        const data = events[`${variables.dataType}:${variables.hostilityType}`];
        if (body.query.includes("query GetFightAbilityEvents") && data) {
          const filter = variables.filterExpression as string | undefined;
          const ids = filter
            ? new Set(filter.match(/\d+/g)?.map(Number) ?? [])
            : undefined;
          return Response.json({
            data: {
              reportData: {
                report: {
                  events: {
                    data: ids
                      ? data.filter((event) => ids.has(event.abilityGameID))
                      : data,
                    nextPageTimestamp: null,
                  },
                },
              },
            },
          });
        }
      }
      return original(url, init);
    };
  }, events);
}

async function loadTimelineFixture(
  page: Page,
  desktop: ElectronApplication,
  select = true,
  showBothSides = true,
  initialWindow: "first" | "default" = "first",
) {
  await mockWcl(desktop, timelineReport);
  await mockEventData(desktop, {
    "Casts:Enemies": timelineEvents("Casts", "enemy"),
    "Casts:Friendlies": timelineEvents("Casts", "friendly"),
    "Buffs:Friendlies": timelineEvents("Buffs", "friendly"),
    "Buffs:Enemies": [],
    "Debuffs:Friendlies": [],
    "Debuffs:Enemies": [],
  });
  await load(page);
  await page.getByRole("button", { name: "时间轴视图", exact: true }).click();
  if (showBothSides)
    await page.getByRole("button", { name: "全部", exact: true }).click();
  await expect(page.locator(".timeline-row")).toHaveCount(
    showBothSides ? 6 : 4,
  );
  if (select)
    for (const checkbox of await page
      .getByRole("checkbox", { name: /^导出整行 / })
      .all())
      await checkbox.check();
  if (initialWindow === "first") await timelineWindow(page, "first");
}

test("阶段同时筛选两种视图和跨类型 Note，恢复全部保留勾选，清除全部覆盖所有阶段", async ({
  appPage: page,
  desktop,
}, info) => {
  await load(page);
  await firstCastActor(page, 1, "队友");
  await page.locator(".skill").getByRole("checkbox").check();
  await firstCastActor(page);
  await page.locator(".skill").getByRole("checkbox").check();
  await page.getByRole("tab", { name: "Buff", exact: true }).click();
  await page.getByRole("button", { name: "队友", exact: true }).click();
  await page.locator(".skill").getByRole("checkbox").check();
  const preview = page.getByLabel("Note 预览", { exact: true });
  const complete = await preview.inputValue();
  for (const time of ["00:17.0", "00:35.0", "01:05.0", "01:10.0"])
    expect(complete).toContain("{time:" + time + "}");
  await chooseSegment(page, /第二阶段/);
  await expect(preview).toHaveValue(/01:05\.0/);
  await expect(preview).toHaveValue(/01:10\.0/);
  await expect(preview).not.toHaveValue(/00:17|00:35/);
  const filtered = await preview.inputValue();
  await page.getByRole("button", { name: "时间轴视图", exact: true }).click();
  await expect(page.getByLabel("时间轴可见范围")).toHaveText("01:00 – 02:00");
  await expect(preview).toHaveValue(filtered);
  await page.getByRole("button", { name: "NSRT", exact: true }).click();
  await expect(preview).toHaveValue(/ph:2;time:5;/);
  await expect(preview).toHaveValue(/ph:2;time:10;/);
  await expect(preview).not.toHaveValue(/ph:1;time:17|ph:1;time:35/);
  await page.getByRole("button", { name: "MRT", exact: true }).click();
  const expected = filtered.replace(/\r?\n/g, "\r\n");
  await page.getByRole("button", { name: "复制笔记", exact: true }).click();
  expect(await desktop.evaluate(({ clipboard }) => clipboard.readText())).toBe(
    expected,
  );
  const file = info.outputPath("阶段笔记.txt");
  await desktop.evaluate(({ dialog }, file) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: file });
  }, file);
  await page.getByRole("button", { name: "保存 txt", exact: true }).click();
  await expect
    .poll(() => readFile(file, "utf8").catch(() => ""))
    .toBe(expected);
  expect(await readFile(file, "utf8")).toBe(expected);
  await page.getByRole("tab", { name: "施法", exact: true }).click();
  await page.getByRole("button", { name: "敌对", exact: true }).click();
  await expect(page.locator(".timeline-marker")).toHaveCount(2);
  expect(
    await page
      .locator(".timeline-marker")
      .evaluateAll((markers) =>
        markers.every(
          (marker) => !marker.getAttribute("aria-label")?.includes("00:35"),
        ),
      ),
  ).toBe(true);
  await chooseSegment(page, /^全部阶段/);
  await expect(preview).toHaveValue(complete);
  await chooseSegment(page, /第一阶段/);
  await expect(preview).toHaveValue(/00:17\.0/);
  await expect(preview).toHaveValue(/00:35\.0/);
  await expect(preview).not.toHaveValue(/01:05|01:10/);
  await page
    .getByRole("button", { name: /首领.*裂解 00:35.000 施法/, exact: true })
    .click();
  await page
    .getByRole("checkbox", {
      name: /导出事件 首领.*裂解 00:35.000 施法/,
      exact: true,
    })
    .uncheck();
  await chooseSegment(page, /第二阶段/);
  await expect(preview).toHaveValue(/01:05\.0/);
  await chooseSegment(page, /^全部阶段/);
  await expect(preview).not.toHaveValue(/00:35\.0/);
  await expect(preview).toHaveValue(/01:05\.0/);
  await chooseSegment(page, /第一阶段/);
  await page.getByRole("button", { name: "清除全部", exact: true }).click();
  await expect(preview).toHaveValue("");
  await chooseSegment(page, /^全部阶段/);
  await expect(preview).toHaveValue("");
  await page.getByRole("button", { name: "图表视图", exact: true }).click();
  await page.getByRole("tab", { name: "Buff", exact: true }).click();
  await page.getByRole("button", { name: "队友", exact: true }).click();
  await expect(page.locator(".skill").getByRole("checkbox")).not.toBeChecked();
});

test("Pull 筛选在图表和时间轴统一使用相对 MRT，NSRT 保留原始时间基准", async ({
  appPage: page,
  desktop,
}) => {
  const fixture = structuredClone(report);
  fixture.fights![0].dungeonPulls = [
    { id: 7, name: "Pull 7", startTime: 61000, endTime: 121000 },
  ];
  await mockWcl(desktop, fixture);
  await load(
    page,
    "https://cn.warcraftlogs.com/reports/pulls?fight=last&pull=7",
  );
  await firstCastActor(page);
  await page.locator(".skill").getByRole("checkbox").check();
  const preview = page.getByLabel("Note 预览", { exact: true });
  await expect(preview).toHaveValue(/time:00:05\.0/);
  await expect(preview).not.toHaveValue(/time:01:05|00:35/);
  const mrt = await preview.inputValue();
  await page.getByRole("button", { name: "时间轴视图", exact: true }).click();
  await expect(preview).toHaveValue(mrt);
  await expect(page.getByLabel("时间轴可见范围")).toHaveText("00:00 – 01:00");
  await page.getByRole("button", { name: "NSRT", exact: true }).click();
  await expect(preview).toHaveValue(/ph:2;time:5;/);
  await page
    .getByRole("checkbox", { name: "动态计时器", exact: true })
    .uncheck();
  await expect(preview).toHaveValue(/ph:1;time:65;/);
  await page.getByRole("button", { name: "图表视图", exact: true }).click();
  await expect(preview).toHaveValue(/ph:1;time:65;/);
  await chooseSegment(page, /^全部阶段/);
  await expect(preview).toHaveValue(/time:35;/);
  await expect(preview).toHaveValue(/time:65;/);
});

test("Buff 按 WCL 多分类显示，其他兜底且重复行同步选择", async ({
  desktop,
  appPage: page,
}) => {
  await mockWcl(desktop, {
    ...report,
    masterData: {
      ...report.masterData!,
      abilities: [
        ...report.masterData!.abilities,
        { gameID: 80353, name: "时间扭曲", type: 64 },
        { gameID: 1999999999, name: "未收录增益", type: 1 },
      ],
    },
  });
  await mockEventData(desktop, {
    "Buffs:Friendlies": [80353, 1999999999].flatMap((abilityGameID) => [
      {
        type: "applybuff",
        timestamp: 71000,
        abilityGameID,
        sourceID: 20,
        targetID: 20,
      },
      {
        type: "removebuff",
        timestamp: 81000,
        abilityGameID,
        sourceID: 20,
        targetID: 20,
      },
    ]),
    "Buffs:Enemies": [],
  });
  await load(page);
  await page.getByRole("tab", { name: "Buff", exact: true }).click();
  const timeWarp = page.locator('.skill[data-ability-id="80353"]');
  await expect(timeWarp).toHaveCount(3);
  await expect(page.locator('.skill[data-buff-category="512"]')).toHaveText(
    /未收录增益/,
  );
  await expect(page.locator(".buff-category")).toHaveText([
    "团队大招1",
    "伤害增益1",
    "玩具增益1",
    "其他1",
  ]);
  await timeWarp.first().getByRole("checkbox").check();
  await expect(timeWarp.locator("input:checked")).toHaveCount(3);
  await page.getByLabel("技能图标", { exact: true }).check();
  await expect(page.getByLabel("Note 预览", { exact: true })).toHaveValue(
    /spell:80353/,
  );
  expect(
    (await page.getByLabel("Note 预览", { exact: true }).inputValue()).match(
      /spell:80353/g,
    ),
  ).toHaveLength(1);
  await expect(page.locator(".abilities .panel-foot")).toContainText(
    "2 组技能",
  );
  await expect(page.locator(".abilities .panel-foot")).toContainText(
    "已选 1 组",
  );
  await page.screenshot({ path: "docs/screenshots/buff-categories.png" });
  await timeWarp.last().getByRole("checkbox").uncheck();
  await expect(timeWarp.locator("input:checked")).toHaveCount(0);
  await page.getByRole("tab", { name: "Debuff", exact: true }).click();
  await expect(page.locator(".buff-category")).toHaveCount(0);
});

test("元素冲击 Buff 在列表、时间轴、提示及详情中采用 WCL 蓝色", async ({
  desktop,
  appPage: page,
}, info) => {
  const abilities = [
    { gameID: 173183, name: "元素冲击：急速", type: "28" },
    { gameID: 118522, name: "元素冲击：爆击", type: "28" },
    { gameID: 173184, name: "元素冲击：精通", type: "28" },
  ];
  await mockWcl(desktop, {
    ...report,
    masterData: {
      ...report.masterData!,
      abilities: [...report.masterData!.abilities, ...abilities],
    },
  });
  await mockEventData(desktop, {
    "Buffs:Friendlies": abilities.flatMap(({ gameID: abilityGameID }) => [
      {
        type: "applybuff",
        timestamp: 71000,
        abilityGameID,
        sourceID: 20,
        targetID: 20,
      },
      {
        type: "removebuff",
        timestamp: 81000,
        abilityGameID,
        sourceID: 20,
        targetID: 20,
      },
    ]),
    "Buffs:Enemies": [],
  });
  await load(page);
  await page.getByRole("tab", { name: "Buff", exact: true }).click();
  await expect(page.locator(".skill")).toHaveCount(4);
  for (const { gameID } of abilities) {
    const names = page.locator(
      `.skill[data-ability-id="${gameID}"] .skill-name`,
    );
    for (const name of await names.all())
      await expect(name).toHaveCSS("color", "rgb(74, 128, 255)");
  }
  const haste = page.locator('.skill[data-ability-id="173183"]');
  await expect(haste).toHaveCount(2);
  await haste.first().getByRole("checkbox").check();
  await expect(haste.locator("input:checked")).toHaveCount(2);
  await page.screenshot({ path: info.outputPath("buff-font-colors-list.png") });
  await page.getByRole("button", { name: "时间轴视图", exact: true }).click();
  await timelineWindow(page, "full");
  const rows = page.locator('.timeline-row[data-type="Buffs"]');
  await expect(rows).toHaveCount(3);
  for (const name of await rows.locator(".timeline-skill-label strong").all())
    await expect(name).toHaveCSS("color", "rgb(74, 128, 255)");
  const hasteRow = rows.filter({ hasText: "元素冲击：急速" });
  await hasteRow.locator(".timeline-skill-label").click();
  await expect(page.locator(".timeline-event-detail > strong")).toHaveCSS(
    "color",
    "rgb(74, 128, 255)",
  );
  await hasteRow.locator(".timeline-marker").hover();
  await expect(officialTooltip(page)).toContainText("中文技能说明");
  await page.screenshot({
    path: info.outputPath("buff-font-colors-timeline.png"),
  });
});

test("施法图表与时间轴共用 WCL 学派背景，元素冲击保留三色渐变和独立文字色", async ({
  desktop,
  appPage: page,
}, info) => {
  const abilities = [
    {
      gameID: 117014,
      name: "元素冲击",
      type: "28",
      backgroundImage:
        "linear-gradient(45deg, rgb(74, 128, 255), rgb(209, 250, 153) 50%, rgb(235, 69, 97))",
    },
    {
      gameID: 51505,
      name: "熔岩爆裂",
      type: "Fire",
      backgroundColor: "rgb(235, 69, 97)",
    },
    {
      gameID: 47960,
      name: "暗影烈焰",
      type: 36,
      backgroundImage:
        "linear-gradient(45deg, rgb(184, 168, 240), rgb(235, 69, 97))",
    },
    {
      gameID: 1999000001,
      name: "复合学派 80",
      type: 80,
      backgroundImage:
        "linear-gradient(45deg, rgb(143, 242, 255), rgb(74, 128, 255))",
    },
    {
      gameID: 1999000002,
      name: "复合学派 62",
      type: 62,
      backgroundImage:
        "linear-gradient(45deg, rgb(235, 69, 97), rgb(74, 128, 255), rgb(143, 242, 255), rgb(209, 250, 153), rgb(184, 168, 240))",
    },
    {
      gameID: 1999000003,
      name: "复合学派 106",
      type: 106,
      backgroundImage:
        "linear-gradient(45deg, rgb(143, 242, 255), rgb(184, 168, 240) 33%, rgb(209, 250, 153) 66%, rgb(255, 255, 143))",
    },
    {
      gameID: 116858,
      name: "混乱之箭",
      type: 127,
      backgroundColor: "rgb(163, 48, 201)",
    },
    {
      gameID: 1999000004,
      name: "未知学派",
      type: 0,
      backgroundColor: "rgb(166, 181, 196)",
    },
  ];
  await mockWcl(desktop, {
    ...report,
    masterData: {
      ...report.masterData!,
      abilities: [
        ...report.masterData!.abilities,
        ...abilities.map(({ gameID, name, type }) => ({ gameID, name, type })),
      ],
    },
  });
  await mockEventData(desktop, {
    "Casts:Friendlies": abilities.flatMap(({ gameID: abilityGameID }, index) =>
      ["begincast", "cast"].map((type, end) => ({
        type,
        timestamp: 3000 + index * 2200 + end * 1500,
        abilityGameID,
        sourceID: 20,
      })),
    ),
    "Casts:Enemies": [],
  });
  await load(page);
  await page.locator(".actor-row").click();
  await expect(page.locator(".skill")).toHaveCount(abilities.length);
  for (const ability of abilities) {
    const bar = page.locator(
      `.skill[data-ability-id="${ability.gameID}"] .skill-bar-fill`,
    );
    await expect(bar).toHaveCSS(
      "background-image",
      ability.backgroundImage ?? "none",
    );
    if (ability.backgroundColor)
      await expect(bar).toHaveCSS("background-color", ability.backgroundColor);
    await expect(bar).toHaveCSS("opacity", "0.9");
  }
  const elemental = page.locator('.skill[data-ability-id="117014"]');
  await expect(elemental.locator(".skill-name")).toHaveCSS(
    "color",
    "rgb(74, 128, 255)",
  );
  await elemental.getByRole("checkbox").check();
  const note = await page.getByLabel("Note 预览", { exact: true }).inputValue();
  await page.screenshot({
    path: info.outputPath("cast-school-colors-chart.png"),
  });
  await page.getByRole("button", { name: "时间轴视图", exact: true }).click();
  for (const ability of abilities) {
    const row = page
      .locator('.timeline-row[data-type="Casts"]')
      .filter({ has: page.getByText(ability.name, { exact: true }) });
    const bar = row.locator(".timeline-cast");
    await expect(bar).toHaveCount(1);
    await expect(bar).toHaveCSS(
      "background-image",
      ability.backgroundImage ?? "none",
    );
    if (ability.backgroundColor)
      await expect(bar).toHaveCSS("background-color", ability.backgroundColor);
    await expect(bar).toHaveCSS("opacity", "1");
  }
  const elementalRow = page
    .locator(".timeline-row")
    .filter({ has: page.getByText("元素冲击", { exact: true }) });
  await expect(elementalRow.locator(".timeline-marker")).toHaveClass(
    /included/,
  );
  await expect(elementalRow.locator(".timeline-skill-label strong")).toHaveCSS(
    "color",
    "rgb(74, 128, 255)",
  );
  await expect(page.getByLabel("Note 预览", { exact: true })).toHaveValue(note);
  const canvas = page.locator(".timeline-canvas");
  await canvas.focus();
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Tab");
  await expect(canvas).toBeFocused();
  await expect(canvas).toHaveCSS("outline-style", "solid");
  const lane = page.locator(".timeline-scale");
  const laneBox = (await lane.boundingBox())!;
  await lane.click({ position: { x: laneBox.width * 0.85, y: 10 } });
  await page.keyboard.press("Shift");
  await expect(canvas).toHaveCSS("outline-style", "none");
  await page.screenshot({
    path: info.outputPath("cast-school-colors-timeline.png"),
  });
});

test("技能和职业图标显示、重复请求合并、磁盘缓存与离线重启", async ({
  appPage: page,
  desktop,
  profile,
}, info) => {
  const fixture = structuredClone(report);
  fixture.masterData!.abilities[0].icon = "spell_magearmor.jpg";
  fixture.masterData!.abilities[1].icon = "spell_magearmor.jpg";
  await mockWcl(desktop, fixture);
  await load(page);
  await firstCastActor(page);
  const skillImage = page.locator(".skill .game-icon img");
  await expect(skillImage).toHaveAttribute(
    "src",
    "app://wcl2note/icons/abilities/spell_magearmor.jpg",
  );
  await expect
    .poll(() =>
      skillImage.evaluate((img: HTMLImageElement) => img.naturalWidth),
    )
    .toBe(1);
  const position = await page.locator(".skill").evaluate((row) => ({
    icon: row.querySelector(".game-icon")!.getBoundingClientRect().right,
    name: row.querySelector(".skill-name")!.getBoundingClientRect().left,
  }));
  expect(position.icon).toBeLessThan(position.name);
  await page.getByRole("button", { name: "队友", exact: true }).click();
  const classImage = page.locator(".actor-row .actor-icon img");
  await expect(classImage).toHaveAttribute(
    "src",
    "app://wcl2note/icons/icons/Mage.jpg",
  );
  await expect
    .poll(() =>
      classImage.evaluate((img: HTMLImageElement) => img.naturalWidth),
    )
    .toBe(1);
  await page.locator(".actor-row").click();
  await expect
    .poll(() =>
      page
        .locator(".skill .game-icon img")
        .evaluate((img: HTMLImageElement) => img.naturalWidth),
    )
    .toBe(1);
  await page.locator(".skill").getByRole("checkbox").check();
  await expect(page.getByLabel("Note 预览", { exact: true })).toHaveValue(
    /time:00:17/,
  );
  await page.getByLabel("角色列表", { exact: true }).click();
  const menuIcon = page
    .getByRole("menuitem", { name: "玩家法师", exact: true })
    .locator(".actor-icon img");
  await expect
    .poll(() => menuIcon.evaluate((img: HTMLImageElement) => img.naturalWidth))
    .toBe(1);
  await page.screenshot({
    path: info.outputPath("icons-skills-and-actors.png"),
    fullPage: true,
  });
  const requests = await desktop.evaluate(
    () =>
      (
        globalThis as typeof globalThis & {
          testWcl: { iconRequests: string[] };
        }
      ).testWcl.iconRequests,
  );
  expect(requests.sort()).toEqual([
    "https://assets.rpglogs.com/img/warcraft/abilities/spell_magearmor.jpg",
    "https://assets.rpglogs.com/img/warcraft/icons/Mage.jpg",
  ]);
  expect(
    await readdir(resolve(profile, "icon-cache/v1/abilities")),
  ).toHaveLength(1);
  expect(await readdir(resolve(profile, "icon-cache/v1/icons"))).toHaveLength(
    1,
  );
  await closeAfterLoadCheck(desktop);
  const restarted = await launch(profile);
  try {
    await mockWcl(restarted, fixture);
    await restarted.evaluate(async ({ session }) => {
      (
        globalThis as typeof globalThis & { testWcl: { iconsFail: boolean } }
      ).testWcl.iconsFail = true;
      await session.defaultSession.clearCache();
    });
    const next = await restarted.firstWindow();
    await load(next);
    await firstCastActor(next);
    await expect
      .poll(() =>
        next
          .locator(".skill .game-icon img")
          .evaluate((img: HTMLImageElement) => img.naturalWidth),
      )
      .toBe(1);
    await next.getByRole("button", { name: "队友", exact: true }).click();
    await expect
      .poll(() =>
        next
          .locator(".actor-row .actor-icon img")
          .evaluate((img: HTMLImageElement) => img.naturalWidth),
      )
      .toBe(1);
    expect(
      await restarted.evaluate(
        () =>
          (
            globalThis as typeof globalThis & {
              testWcl: { iconRequests: string[] };
            }
          ).testWcl.iconRequests,
      ),
    ).toEqual([]);
  } finally {
    await restarted.close();
  }
});

test("图标下载失败显示默认标记，技能选择和笔记生成继续可用", async ({
  appPage: page,
  desktop,
}, info) => {
  const fixture = structuredClone(report);
  fixture.masterData!.abilities[0].icon = "missing.jpg";
  fixture.masterData!.actors[0].subType = "Boss";
  const unknownIcon = `data:image/jpeg;base64,${(await readFile(resolve("src/renderer/assets/icons/inv_misc_questionmark.jpg"))).toString("base64")}`;
  await mockWcl(desktop, fixture);
  await desktop.evaluate(() => {
    (
      globalThis as typeof globalThis & { testWcl: { iconsFail: boolean } }
    ).testWcl.iconsFail = true;
  });
  await load(page);
  await page.getByRole("button", { name: "敌对", exact: true }).click();
  await expect(page.locator(".actor-row")).toHaveCount(2);
  await expect(page.locator(".actor-row .actor-icon")).toHaveCount(0);
  await firstCastActor(page);
  await expect(
    page.locator(".analysis-actor > .actor-picker summary .actor-icon"),
  ).toHaveCount(0);
  const skillIcon = page.locator(".skill .game-icon img");
  await expect(skillIcon).toHaveAttribute("src", unknownIcon);
  await expect
    .poll(() => skillIcon.evaluate((img: HTMLImageElement) => img.naturalWidth))
    .toBe(36);
  await page.locator(".skill").getByRole("checkbox").check();
  await expect(page.getByLabel("Note 预览", { exact: true })).toHaveValue(
    /time:00:35/,
  );
  await page.getByLabel("角色列表", { exact: true }).click();
  await expect(
    page
      .getByRole("menu", { name: "角色", exact: true })
      .locator(".actor-icon"),
  ).toHaveCount(0);
  await page.screenshot({
    path: info.outputPath("wow-fallback-icons.png"),
    fullPage: true,
  });
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "队友", exact: true }).click();
  const classIcon = page.locator(".actor-row .actor-icon img");
  await expect(classIcon).toHaveAttribute("src", unknownIcon);
  await expect
    .poll(() => classIcon.evaluate((img: HTMLImageElement) => img.naturalWidth))
    .toBe(36);
});

test("施法 actor 排行、点击同步、Target 宠物实例筛选与 CPM", async ({
  appPage: page,
  desktop,
}, info) => {
  await mockEventData(desktop, {
    "Casts:Enemies": [
      { ...enemies[0], timestamp: 11000, targetID: 20 },
      { ...enemies[0], timestamp: 31000, targetID: 30, targetInstance: 1 },
      { ...enemies[2], timestamp: 21000, abilityGameID: 300, targetID: 20 },
      {
        ...enemies[1],
        timestamp: 71000,
        abilityGameID: 200,
        targetID: 30,
        targetInstance: 2,
      },
    ],
  });
  await load(page);
  await page.getByRole("button", { name: "敌对", exact: true }).click();
  await expect(page.locator(".actor-row")).toHaveCount(2);
  await expect(page.locator(".skill")).toHaveCount(0);
  await expect(page.locator(".actor-row > b:first-of-type")).toHaveText([
    "3",
    "1",
  ]);
  await expect(page.locator(".actor-row > b:last-of-type")).toHaveText([
    "1.5",
    "0.5",
  ]);
  await expect(page.locator(".skill-head")).toHaveText("Actor次数CPM");
  await expect(page.getByLabel("Target列表", { exact: true })).toBeVisible();
  await page.locator(".actor-row").first().click();
  await expect(page.getByLabel("角色列表", { exact: true })).toHaveText("首领");
  await expect(page.locator(".skill")).toHaveCount(2);
  await expect(page.locator(".skill > b:first-of-type")).toHaveText(["2", "1"]);
  await page.getByRole("button", { name: "清除角色筛选", exact: true }).click();
  await expect(page.getByLabel("角色列表", { exact: true })).toHaveText(
    "所有敌对",
  );
  await expect(page.getByRole("menu")).toHaveCount(0);
  await expect(page.locator(".actor-row")).toHaveCount(2);
  await page.locator(".actor-row").first().click();
  await page.getByLabel("角色列表", { exact: true }).click();
  await expect(
    page
      .getByRole("menuitem", { name: "所有敌对", exact: true })
      .locator("svg"),
  ).toHaveCount(0);
  await expect(
    page
      .getByRole("menuitem", { name: "首领", exact: true })
      .filter({ hasText: "900100" }),
  ).toHaveAttribute("aria-current", "true");
  await page.getByLabel("角色列表", { exact: true }).press("Escape");
  await page.getByLabel("Target列表", { exact: true }).click();
  await page.getByRole("menuitem", { name: "玩家法师", exact: true }).hover();
  await page.getByRole("menuitem", { name: "水元素", exact: true }).hover();
  await page.getByRole("menuitem", { name: "水元素 #2", exact: true }).click();
  await expect(page.locator(".skill")).toHaveCount(1);
  await expect(page.locator(".skill-name")).toContainText("时间扭曲");
  await expect(page.locator(".skill > b")).toHaveText(["1", "0.5"]);
  await expect(page.getByLabel("Target列表", { exact: true })).toHaveText(
    "水元素 #2",
  );
  await page.locator(".skill").getByRole("checkbox").check();
  await expect(page.getByLabel("Note 预览", { exact: true })).toHaveValue(
    /time:01:10/,
  );
  await expect(page.getByLabel("Note 预览", { exact: true })).not.toHaveValue(
    /time:00:30/,
  );
  await chooseSegment(page, /第二阶段/);
  await expect(page.locator(".skill > b")).toHaveText(["1", "1.0"]);
  await page.getByLabel("角色列表", { exact: true }).click();
  await page.getByRole("menuitem", { name: "所有敌对", exact: true }).click();
  await expect(page.locator(".actor-row")).toHaveCount(1);
  await expect(page.locator(".actor-row > b")).toHaveText(["1", "1.0"]);
  await desktop.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setSize(960, 720),
  );
  await page.screenshot({
    path: info.outputPath("cast-actors-target.png"),
    fullPage: true,
  });
  await page
    .getByRole("button", { name: "清除Target筛选", exact: true })
    .focus();
  await page
    .getByRole("button", { name: "清除Target筛选", exact: true })
    .press("Enter");
  await expect(page.getByLabel("Target列表", { exact: true })).toHaveText(
    "所有目标",
  );
  await expect(page.getByRole("menu")).toHaveCount(0);
  await page.getByRole("button", { name: "队友", exact: true }).click();
  await expect(page.locator(".actor-row")).toHaveCount(0);
  await chooseSegment(page, /^全部阶段/);
  await expect(page.locator(".actor-row")).toHaveCount(1);
  await expect(page.locator(".actor-row")).toContainText("玩家法师");
  await page.locator(".actor-row").click();
  await expect(page.locator(".skill")).toContainText("时间扭曲");
});

test("Buff 和 Debuff 的 Source 筛选、合并次数、覆盖率与跨阶段延续", async ({
  appPage: page,
  desktop,
}, info) => {
  const data = (suffix: string): RawEvent[] => [
    {
      type: `apply${suffix}`,
      timestamp: 11000,
      abilityGameID: 200,
      sourceID: 10,
      sourceInstance: 1,
      targetID: 20,
    },
    {
      type: `apply${suffix}`,
      timestamp: 31000,
      abilityGameID: 200,
      sourceID: 11,
      targetID: 20,
    },
    {
      type: `remove${suffix}`,
      timestamp: 71000,
      abilityGameID: 200,
      targetID: 20,
    },
    {
      type: `apply${suffix}`,
      timestamp: 81000,
      abilityGameID: 100,
      sourceID: 10,
      sourceInstance: 2,
      targetID: 20,
    },
    {
      type: `remove${suffix}`,
      timestamp: 101000,
      abilityGameID: 100,
      sourceID: 10,
      sourceInstance: 2,
      targetID: 20,
    },
    {
      type: `apply${suffix}`,
      timestamp: 111000,
      abilityGameID: 100,
      sourceID: 10,
      sourceInstance: 2,
      targetID: 20,
    },
    {
      type: `remove${suffix}`,
      timestamp: 116000,
      abilityGameID: 100,
      sourceID: 10,
      sourceInstance: 2,
      targetID: 20,
    },
  ];
  await mockEventData(desktop, {
    "Buffs:Friendlies": data("buff"),
    "Debuffs:Friendlies": data("debuff"),
  });
  await load(page);
  await page.getByRole("tab", { name: "Buff", exact: true }).click();
  await page.getByRole("button", { name: "队友", exact: true }).click();
  await expect(page.getByLabel("Target列表", { exact: true })).toHaveCount(0);
  await expect(page.getByLabel("Source列表", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Source列表", { exact: true })).toHaveText(
    "所有来源",
  );
  await expect(page.locator(".skill-head")).toHaveText("技能次数覆盖率");
  await expect(page.locator(".skill > b:first-of-type")).toHaveText(["2", "2"]);
  await expect(page.locator(".skill > b:last-of-type")).toHaveText([
    "50.00%",
    "20.83%",
  ]);
  const pieces = page
    .locator(".skill-aura-bar")
    .nth(1)
    .locator(".skill-bar-fill");
  await expect(pieces).toHaveCount(2);
  const positions = await pieces.evaluateAll((elements) =>
    elements.map((element) => ({
      left: parseFloat((element as HTMLElement).style.left),
      width: parseFloat((element as HTMLElement).style.width),
    })),
  );
  expect(positions[0].left).toBeCloseTo(200 / 3);
  expect(positions[0].width).toBeCloseTo(50 / 3);
  expect(positions[1].left).toBeCloseTo(275 / 3);
  expect(positions[1].width).toBeCloseTo(25 / 6);
  await page.getByLabel("Source列表", { exact: true }).click();
  const first = page
    .getByRole("menuitem", { name: "首领", exact: true })
    .filter({ hasText: "900100" });
  await first.hover();
  await page.getByRole("menuitem", { name: "首领 #1", exact: true }).click();
  await expect(page.locator(".skill")).toHaveCount(1);
  await expect(page.locator(".skill > b")).toHaveText(["1", "50.00%"]);
  await page.locator(".skill").getByRole("checkbox").check();
  await expect(page.getByLabel("Note 预览", { exact: true })).toHaveValue(
    /time:00:10/,
  );
  await expect(page.getByLabel("Note 预览", { exact: true })).not.toHaveValue(
    /time:00:30/,
  );
  await page.getByLabel("Source列表", { exact: true }).click();
  await page
    .getByRole("menuitem", { name: "首领", exact: true })
    .filter({ hasText: "900101" })
    .click();
  await expect(page.locator(".skill > b")).toHaveText(["1", "33.33%"]);
  await expect(page.getByLabel("Note 预览", { exact: true })).toHaveValue(
    /time:00:30/,
  );
  await expect(page.getByLabel("Note 预览", { exact: true })).not.toHaveValue(
    /time:00:10/,
  );
  await page.getByRole("tab", { name: "Debuff", exact: true }).click();
  await expect(page.getByLabel("Source列表", { exact: true })).toContainText(
    "所有来源",
  );
  await expect(page.locator(".skill > b:last-of-type")).toHaveText([
    "50.00%",
    "20.83%",
  ]);
  await expect(pieces).toHaveCount(2);
  await page.getByRole("tab", { name: "Buff", exact: true }).click();
  await expect(page.getByLabel("Source列表", { exact: true })).toContainText(
    "首领",
  );
  await expect(page.locator(".skill > b")).toHaveText(["1", "33.33%"]);
  await chooseSegment(page, /第二阶段/);
  await expect(page.locator(".skill > b")).toHaveText(["0", "16.67%"]);
  await expect(page.locator(".skill-aura-bar .skill-bar-fill")).toHaveCSS(
    "left",
    "0px",
  );
  await expect(page.locator(".skill").getByRole("checkbox")).toBeDisabled();
  await expect(page.getByLabel("Note 预览", { exact: true })).toHaveValue("");
  await desktop.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setSize(960, 720),
  );
  const stats = await page.locator(".skill > b").evaluateAll((elements) =>
    elements.map((element) => {
      const row = element.closest(".skill")!.getBoundingClientRect();
      const box = element.getBoundingClientRect();
      return box.left >= row.left && box.right <= row.right;
    }),
  );
  expect(stats.every(Boolean)).toBe(true);
  await page.screenshot({
    path: info.outputPath("buff-source-uptime.png"),
    fullPage: true,
  });
  await page.getByLabel("Source列表", { exact: true }).click();
  await page.getByRole("menuitem", { name: "玩家法师", exact: true }).click();
  await expect(page.locator(".skill")).toHaveCount(0);
  await page
    .getByRole("button", { name: "清除Source筛选", exact: true })
    .click();
  await expect(page.getByLabel("Source列表", { exact: true })).toHaveText(
    "所有来源",
  );
  await expect(page.getByRole("menu")).toHaveCount(0);
  await expect(page.locator(".skill")).toHaveCount(2);
  await page.getByRole("button", { name: "加载报告" }).click();
  await expect(page.getByLabel("Target列表", { exact: true })).toContainText(
    "所有目标",
  );
});

test("NSRT 格式切换、动态计时器提示与阶段时间、原生复制和保存", async ({
  appPage: page,
  desktop,
}, info) => {
  await load(page);
  const preview = page.getByLabel("Note 预览", { exact: true });
  const dynamic = page.getByRole("checkbox", {
    name: "动态计时器",
    exact: true,
  });
  await expect(
    page.getByRole("button", { name: "MRT", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(dynamic).toHaveCount(0);
  await page.getByRole("button", { name: "NSRT", exact: true }).click();
  await expect(dynamic).toBeChecked();
  await expect(preview).toHaveValue("");
  const friendly = page.getByRole("checkbox", {
    name: "友方来源",
    exact: true,
  });
  const enemy = page.getByRole("checkbox", { name: "敌方来源", exact: true });
  const simplify = page.getByRole("checkbox", {
    name: "友方简化",
    exact: true,
  });
  await expect(friendly).toBeChecked();
  await expect(enemy).not.toBeChecked();
  await expect(simplify).toBeChecked();
  await expect(
    page.getByRole("checkbox", { name: "技能图标", exact: true }),
  ).toHaveCount(0);
  await dynamic.hover();
  expect(await page.getByRole("tooltip").innerText()).toBe(
    "使用与战斗事件时间点关联的动态计时器",
  );
  await page.getByRole("heading", { name: "Note 预览", exact: true }).hover();
  await expect(page.getByRole("tooltip")).toHaveCount(0);
  await firstCastActor(page, 1, "队友");
  await page.locator(".skill").getByRole("checkbox").check();
  await firstCastActor(page);
  await page.locator(".skill").getByRole("checkbox").check();
  await expect(preview).toHaveValue(
    /^EncounterID:99;Difficulty:Mythic;Name:测试首领;\nph:1;time:17;tag:MAGE;spellid:200;/,
  );
  await expect(preview).toHaveValue(/ph:2;time:5;spellid:100;/);
  await expect(preview).toHaveValue(/tag:MAGE;spellid:200;/);
  await simplify.uncheck();
  await expect(preview).toHaveValue(/tag:玩家法师;spellid:200;/);
  await friendly.uncheck();
  await expect(preview).toHaveValue(/ph:1;time:17;spellid:200;\n/);
  await expect(preview).not.toHaveValue(/text:/);
  await friendly.check();
  await simplify.check();
  await enemy.check();
  await expect(preview).toHaveValue(/tag:首领;spellid:100;/);
  await dynamic.uncheck();
  await expect(preview).toHaveValue(/ph:1;time:65;tag:首领;/);
  await expect(preview).not.toHaveValue(/ph:2;/);
  await chooseSegment(page, /第二阶段/);
  await expect(preview).toHaveValue(/ph:1;time:65;/);
  await dynamic.check();
  await expect(preview).toHaveValue(/ph:2;time:5;/);
  const expected = (await preview.inputValue()).replace(/\r?\n/g, "\r\n");
  await page.getByRole("button", { name: "复制笔记", exact: true }).click();
  expect(await desktop.evaluate(({ clipboard }) => clipboard.readText())).toBe(
    expected,
  );
  await expect(page.locator("main > footer")).toHaveCount(0);
  const file = info.outputPath("NSRT团队笔记.txt");
  await desktop.evaluate(({ dialog }, file) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: file });
  }, file);
  await page.getByRole("button", { name: "保存 txt", exact: true }).click();
  await expect
    .poll(() => readFile(file, "utf8").catch(() => ""))
    .toBe(expected);
  expect(await readFile(file, "utf8")).toBe(expected);
  await desktop.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setSize(960, 720),
  );
  for (const control of [
    dynamic,
    friendly,
    enemy,
    simplify,
    page.getByRole("button", { name: "NSRT", exact: true }),
    page.getByRole("button", { name: "复制笔记", exact: true }),
  ])
    await expect(control).toBeInViewport({ ratio: 1 });
  await page.getByRole("heading", { name: "Note 预览", exact: true }).hover();
  await page.screenshot({
    path: info.outputPath("nsrt-format-960.png"),
    fullPage: true,
  });
  await page.getByRole("button", { name: "MRT", exact: true }).click();
  await expect(dynamic).toHaveCount(0);
  await expect(
    page.getByRole("checkbox", { name: "友方简化", exact: true }),
  ).toBeChecked();
  await expect(preview).toHaveValue(/\{time:01:05\.0\}/);
  await expect(enemy).toBeChecked();
  await expect(preview).toHaveValue(/首领 2 - 裂解/);
  await page.getByRole("button", { name: "NSRT", exact: true }).click();
  await expect(dynamic).toBeChecked();
  await expect(preview).toHaveValue(/ph:2;time:5;/);
  await expect(enemy).toBeChecked();
  await enemy.uncheck();
  await expect(preview).toHaveValue(/ph:2;time:5;spellid:100;/);
});

test("MRT 与 NSRT 选项两行对齐，切换格式不移动共享选项和预览", async ({
  appPage: page,
  desktop,
}, info) => {
  const controls = page.getByRole("group", { name: "Note 选项", exact: true });
  const layout = () =>
    controls.evaluate((element) => {
      const inputs = [...element.querySelectorAll("input")].map((input) => {
        const box = input.getBoundingClientRect();
        return { x: box.x, y: box.y };
      });
      const preview = document
        .querySelector(".note-wrap")!
        .getBoundingClientRect();
      return { inputs, previewTop: preview.top, previewHeight: preview.height };
    });
  for (const width of [1440, 960]) {
    await desktop.evaluate(
      ({ BrowserWindow }, width) =>
        BrowserWindow.getAllWindows()[0].setSize(
          width,
          width === 960 ? 720 : 900,
        ),
      width,
    );
    await page.getByRole("button", { name: "MRT", exact: true }).click();
    await expect(controls.getByRole("checkbox")).toHaveCount(4);
    const mrt = await layout();
    expect(mrt.inputs[0].y).toBe(mrt.inputs[1].y);
    expect(mrt.inputs[2].y).toBe(mrt.inputs[3].y);
    expect(mrt.inputs[2].y).toBeGreaterThan(mrt.inputs[0].y);
    await page.screenshot({
      path: info.outputPath(`mrt-options-${width}.png`),
      fullPage: true,
      animations: "disabled",
    });
    await page.getByRole("button", { name: "NSRT", exact: true }).click();
    await expect(controls.getByRole("checkbox")).toHaveCount(4);
    const nsrt = await layout();
    expect(nsrt).toEqual(mrt);
    await controls
      .getByRole("checkbox", { name: "动态计时器", exact: true })
      .hover();
    const tooltip = await page.getByRole("tooltip").boundingBox();
    expect(tooltip!.x).toBeGreaterThanOrEqual(0);
    expect(tooltip!.x + tooltip!.width).toBeLessThanOrEqual(
      await page.evaluate(() => window.innerWidth),
    );
    await page.getByRole("heading", { name: "Note 预览", exact: true }).hover();
    for (const checkbox of await controls.getByRole("checkbox").all())
      await expect(checkbox).toBeInViewport({ ratio: 1 });
    await page.screenshot({
      path: info.outputPath(`nsrt-options-${width}.png`),
      fullPage: true,
      animations: "disabled",
    });
  }
});

test("NSRT 按施法开始定位跨阶段事件，切换格式和计时方式保留选择", async ({
  appPage: page,
  desktop,
}, info) => {
  await mockEventData(desktop, {
    "Casts:Friendlies": [
      { type: "begincast", timestamp: 60940, abilityGameID: 200, sourceID: 20 },
      { type: "cast", timestamp: 62000, abilityGameID: 200, sourceID: 20 },
      { type: "cast", timestamp: 71000, abilityGameID: 200, sourceID: 20 },
    ],
  });
  await load(page);
  await firstCastActor(page, 1, "队友");
  await page.locator(".skill").getByRole("checkbox").check();
  await page.getByRole("button", { name: "时间轴视图", exact: true }).click();
  await ensureNoteOpen(page);
  await page.getByRole("button", { name: "NSRT", exact: true }).click();
  const preview = page.getByLabel("Note 预览", { exact: true });
  await expect(preview).toHaveValue(/ph:1;time:59\.9;tag:MAGE;spellid:200;/);
  await expect(preview).toHaveValue(/ph:2;time:10;tag:MAGE;spellid:200;/);
  await timelineWindow(page, "full");
  const selection = () =>
    preview.evaluate((element: HTMLTextAreaElement) =>
      element.value.slice(element.selectionStart, element.selectionEnd),
    );
  await page
    .getByRole("button", {
      name: "玩家法师 时间扭曲 01:01.000 施法",
      exact: true,
    })
    .click();
  await page.getByRole("button", { name: "定位 Note", exact: true }).click();
  await expect.poll(selection).toBe("ph:1;time:59.9;tag:MAGE;spellid:200;");
  await page.getByLabel("时间轴导出范围").selectOption("phase-2");
  await expect(preview).toHaveValue(/ph:1;time:59\.9;/);
  await page
    .getByRole("button", {
      name: "玩家法师 时间扭曲 01:10.000 施法",
      exact: true,
    })
    .click();
  await page.getByRole("button", { name: "定位 Note", exact: true }).click();
  await expect.poll(selection).toBe("ph:2;time:10;tag:MAGE;spellid:200;");
  const checkbox = page.getByRole("checkbox", {
    name: "动态计时器",
    exact: true,
  });
  await checkbox.uncheck();
  await expect.poll(selection).toBe("ph:1;time:70;tag:MAGE;spellid:200;");
  await page.getByRole("button", { name: "MRT", exact: true }).click();
  await expect.poll(selection).toContain("{time:01:10.0}");
  await page.getByRole("button", { name: "NSRT", exact: true }).click();
  await expect(checkbox).not.toBeChecked();
  await expect(page.locator(".timeline-occurrences-heading")).toContainText(
    "2 / 2 次加入导出",
  );
  await checkbox.check();
  await page.screenshot({
    path: info.outputPath("nsrt-timeline.png"),
    fullPage: true,
  });
  await page
    .getByRole("button", { name: "收起 Note 预览", exact: true })
    .click();
  await ensureNoteOpen(page);
  await page.getByRole("button", { name: "复制笔记", exact: true }).click();
  expect(
    await desktop.evaluate(({ clipboard }) => clipboard.readText()),
  ).toContain("ph:2;time:10;");
});

test("实际 Electron 窗口：跨标签与阶段、原生剪贴板、原生保存 UTF-8", async ({
  appPage: page,
  desktop,
}, info) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await expect(page).toHaveTitle("WCL2NOTE");
  await load(page);
  await firstCastActor(page);
  await page.locator(".skill").first().getByRole("checkbox").check();
  await expect(page.getByLabel("Note 预览", { exact: true })).toHaveValue(
    /裂解\(1\)/,
  );
  await page.getByRole("tab", { name: "Buff", exact: true }).click();
  await page.getByRole("button", { name: "队友", exact: true }).click();
  await page.locator(".skill").getByRole("checkbox").check();
  await expect(page.getByLabel("Note 预览", { exact: true })).toHaveValue(
    /FS - 时间扭曲/,
  );
  await chooseSegment(page, /第二阶段/);
  await expect(page.getByLabel("Note 预览", { exact: true })).toHaveValue(
    /# 测试首领 - 第二阶段/,
  );
  await expect(page.getByLabel("Note 预览", { exact: true })).not.toHaveValue(
    /time:00:35/,
  );
  const expected = (
    await page.getByLabel("Note 预览", { exact: true }).inputValue()
  ).replace(/\r?\n/g, "\r\n");
  await page.getByRole("button", { name: "复制笔记" }).click();
  await expect
    .poll(() => desktop.evaluate(({ clipboard }) => clipboard.readText()))
    .toBe(expected);
  const file = info.outputPath("团队笔记.txt");
  await desktop.evaluate(({ dialog }, file) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: file });
  }, file);
  await page.getByRole("button", { name: "保存 txt" }).click();
  await expect
    .poll(() => readFile(file, "utf8").catch(() => ""))
    .toBe(expected);
  expect(await readFile(file, "utf8")).toBe(expected);
  await page.screenshot({
    path: info.outputPath("desktop.png"),
    fullPage: true,
  });
  await page.getByRole("button", { name: "清除全部" }).click();
  await expect(page.getByLabel("Note 预览", { exact: true })).toHaveValue("");
  expect(errors).toEqual([]);
});

test("战斗列表显示 WCL 结果编号、原版时间与颜色，时间列靠右", async ({
  appPage: page,
  desktop,
}, info) => {
  const reportStart = await page.evaluate(() =>
    new Date(2026, 9, 21, 14, 35).getTime(),
  );
  const baseFight = report.fights![0];
  await desktop.evaluate(
    (_electron, fixture) => {
      const previousFetch = globalThis.fetch;
      globalThis.fetch = async (url, init) => {
        if (
          url === "https://cn.warcraftlogs.com/api/v2/client" &&
          JSON.parse(init!.body as string).query.includes(
            "query GetReportFights",
          )
        )
          return Response.json({ data: { reportData: { report: fixture } } });
        return previousFetch(url, init);
      };
    },
    {
      startTime: reportStart,
      fights: [
        { ...baseFight, name: "击杀首领" },
        {
          ...baseFight,
          id: 2,
          name: "灭团首领",
          kill: false,
          startTime: 61000,
          endTime: 241000,
        },
        {
          ...baseFight,
          id: 3,
          name: "大秘境副本",
          difficulty: 10,
          keystoneLevel: 15,
          keystoneTime: 1720000,
          kill: false,
          startTime: 121000,
          endTime: 1921000,
        },
        { ...baseFight, id: 4, name: "团本小怪", encounterID: 0, kill: false },
        {
          ...baseFight,
          id: 5,
          name: "地下城战斗",
          difficulty: 10,
          kill: false,
        },
        {
          ...baseFight,
          id: 6,
          name: "灭团首领",
          kill: false,
          startTime: 241000,
          endTime: 421000,
        },
        {
          ...baseFight,
          id: 7,
          name: "击杀首领",
          startTime: 421000,
          endTime: 541000,
        },
        {
          ...baseFight,
          id: 8,
          name: "另一难度的超长名称首领",
          difficulty: 4,
          kill: false,
          startTime: 541000,
          endTime: 721000,
        },
      ],
    },
  );
  await load(page, "abc");
  const fights = page.locator(".fight-card");
  await expect(fights).toHaveCount(8);
  await expect(page.locator(".fight-list-head")).toContainText("名称");
  await expect(page.locator(".fight-list-head")).toContainText("开始时间");
  await expect(page.locator(".fight-name")).toHaveText([
    "击杀首领 Kill 1 (02:00)",
    "灭团首领 Wipe 1 (03:00)",
    "大秘境副本+15 (28:40)",
    "团本小怪 (02:00)",
    "地下城战斗 (02:00)",
    "灭团首领 Wipe 2 (03:00)",
    "击杀首领 Kill 2 (02:00)",
    "另一难度的超长名称首领 Wipe 1 (03:00)",
  ]);
  await expect(fights.first().locator("time")).toHaveText("02:35 下午");
  await expect(fights.nth(1).locator("time")).toHaveText("02:36 下午");
  await expect(fights.first().locator("time")).toHaveAttribute(
    "datetime",
    new Date(reportStart + baseFight.startTime).toISOString(),
  );
  const colors = await page
    .locator(".fight-name")
    .evaluateAll((names) => names.map((name) => getComputedStyle(name).color));
  expect(colors).toEqual([
    "rgb(131, 214, 162)",
    "rgb(255, 172, 180)",
    "rgb(255, 172, 180)",
    "rgb(226, 234, 241)",
    "rgb(226, 234, 241)",
    "rgb(255, 172, 180)",
    "rgb(131, 214, 162)",
    "rgb(255, 172, 180)",
  ]);
  await fights.first().click();
  await expect(fights.first()).toHaveAttribute("aria-pressed", "true");
  await expect(fights.first()).toHaveCSS("background-color", "rgb(32, 59, 58)");
  await expect(fights.first().locator(".fight-name")).toHaveCSS(
    "color",
    colors[0],
  );
  await expect(fights.first().locator("time")).toHaveCSS(
    "color",
    "rgb(226, 234, 241)",
  );
  await expect(fights.nth(5).locator(".fight-name")).toHaveText(
    "灭团首领 Wipe 2 (03:00)",
  );
  await desktop.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setSize(960, 720),
  );
  for (const row of await fights.all()) {
    const name = (await row.locator(".fight-name").boundingBox())!;
    const time = (await row.locator("time").boundingBox())!;
    const button = (await row.boundingBox())!;
    expect(name.x + name.width).toBeLessThanOrEqual(time.x);
    expect(time.x + time.width).toBeLessThanOrEqual(button.x + button.width);
  }
  const rightGaps = await fights.evaluateAll((rows) =>
    rows.map((row) => {
      const range = document.createRange();
      range.selectNodeContents(row.querySelector("time")!);
      return (
        row.getBoundingClientRect().right - range.getBoundingClientRect().right
      );
    }),
  );
  for (const gap of rightGaps) {
    expect(gap).toBeGreaterThanOrEqual(6);
    expect(gap).toBeLessThanOrEqual(8);
  }
  await page.screenshot({
    path: info.outputPath("fight-list.png"),
    fullPage: true,
  });
});

test("链接指定 fight 时收起总列表并预展开对应 Boss，未指定时展开总列表且所有分组收起", async ({
  appPage: page,
  desktop,
}, info) => {
  const fixture = structuredClone(report);
  const baseFight = fixture.fights![0];
  fixture.fights = [
    {
      ...baseFight,
      id: 90,
      name: "Trash Fight 早期",
      encounterID: 0,
      startTime: 0,
    },
    baseFight,
    { ...baseFight, id: 4, startTime: 1500 },
    {
      ...baseFight,
      id: 91,
      name: "Trash Fight 后期",
      encounterID: 0,
      startTime: 2000,
    },
    {
      ...baseFight,
      id: 2,
      name: "第二首领",
      encounterID: 100,
      difficulty: 4,
      startTime: 3000,
    },
    {
      ...baseFight,
      id: 5,
      name: "第二首领",
      encounterID: 100,
      difficulty: 4,
      startTime: 3500,
    },
    {
      ...baseFight,
      id: 6,
      name: "大秘境副本",
      encounterID: 0,
      difficulty: 10,
      keystoneLevel: 12,
      startTime: 4000,
    },
    {
      ...baseFight,
      id: 3,
      name: "大秘境副本",
      encounterID: 0,
      difficulty: 10,
      keystoneLevel: 12,
      startTime: 4500,
    },
  ];
  await mockWcl(desktop, fixture);
  const url = "https://cn.warcraftlogs.com/reports/navigation";
  const selector = page.getByRole("button", { name: "选择战斗", exact: true });
  const toggles = page.locator(".fight-boss-toggle");
  await load(page, url);
  await expect(toggles).toHaveCount(3);
  await expect(selector).toHaveAttribute("aria-expanded", "true");
  await expect(page.locator(".fights")).toBeVisible();
  await expect(
    page.locator('.fight-boss-toggle[aria-expanded="false"]'),
  ).toHaveCount(3);
  await expect(page.locator(".fight-boss-body:visible")).toHaveCount(0);
  await expect(page.locator(".fight-boss-name")).toHaveText([
    "测试首领 · 史诗",
    "第二首领 · 英雄",
    "大秘境副本 · 大秘境 +12",
  ]);
  await expect(page.locator(".fight-trash-name")).toHaveText([
    "Trash Fight 早期",
    "Trash Fight 后期",
  ]);
  await page.screenshot({
    path: info.outputPath("fight-list-no-selection.png"),
    fullPage: true,
  });
  await toggles.first().click();
  await toggles.nth(1).click();
  await expect(
    page.locator('.fight-boss-toggle[aria-expanded="true"]'),
  ).toHaveCount(2);
  for (const { suffix, id } of [
    { suffix: "?fight=2", id: 2 },
    { suffix: "#fight=2", id: 2 },
    { suffix: "?fight=last", id: 3 },
  ]) {
    await load(page, url + suffix);
    await expect(
      page.getByRole("button", { name: "选择阶段", exact: true }),
    ).toBeEnabled();
    await expect(selector).toHaveAttribute("aria-expanded", "false");
    await expect(page.locator(".fights")).toBeHidden();
    await expect(page.locator(".workspace")).toBeVisible();
    await selector.click();
    await expect(page.locator(".fight-boss-body:visible")).toHaveCount(1);
    const linkedFight = page.locator('[data-fight-id="' + id + '"]');
    await expect(linkedFight).toBeVisible();
    await expect(linkedFight).toHaveAttribute("aria-pressed", "true");
    await expect(
      page.locator('.fight-boss-toggle[aria-expanded="false"]'),
    ).toHaveCount(2);
    if (id === 3)
      await page.screenshot({
        path: info.outputPath("fight-list-linked-boss.png"),
        fullPage: true,
      });
    await page.keyboard.press("Escape");
  }
  await load(page, url);
  await expect(toggles).toHaveCount(3);
  await expect(selector).toHaveAttribute("aria-expanded", "true");
  await expect(
    page.locator('.fight-boss-toggle[aria-expanded="false"]'),
  ).toHaveCount(3);
  await expect(page.locator(".fight-boss-body:visible")).toHaveCount(0);
});

test("Boss 信息靠左保留长名称空间，Trash Fights 独立按时间逐行选择", async ({
  appPage: page,
  desktop,
}, info) => {
  const fixture = structuredClone(report);
  const baseFight = fixture.fights![0];
  const bossName = "拥有很长名字的首领与其漫长的英雄称号以及第二形态";
  const trash = [
    {
      ...baseFight,
      id: 90,
      encounterID: 0,
      name: "蛛魔潜伏者",
      startTime: 5000,
      endTime: 8000,
    },
    {
      ...baseFight,
      id: 92,
      encounterID: undefined,
      name: "深渊祭司",
      startTime: 5000,
      endTime: 7000,
    },
    {
      ...baseFight,
      id: 91,
      encounterID: 0,
      name: "蛛魔潜伏者",
      startTime: 140000,
      endTime: 144000,
    },
  ];
  fixture.startTime = await page.evaluate(() =>
    new Date(2026, 9, 27, 14, 35).getTime(),
  );
  fixture.fights = [
    trash[2],
    {
      ...baseFight,
      id: 2,
      name: bossName,
      kill: false,
      startTime: 150000,
      endTime: 270000,
    },
    trash[1],
    {
      ...baseFight,
      id: 3,
      encounterID: 0,
      name: "大秘境副本",
      difficulty: 10,
      keystoneLevel: 12,
      startTime: 280000,
      endTime: 300000,
    },
    trash[0],
    { ...baseFight, name: bossName, startTime: 10000, endTime: 130000 },
  ];
  await mockWcl(desktop, fixture);
  const url = "https://cn.warcraftlogs.com/reports/trashlayout";
  const selector = page.getByRole("button", { name: "选择战斗", exact: true });
  await load(page, url);
  const bosses = page.locator(".fight-boss-group");
  const trashSection = page.getByRole("region", {
    name: "Trash Fights (3)",
    exact: true,
  });
  const items = trashSection.locator(".fight-trash-item");
  await expect(bosses).toHaveCount(2);
  await expect(page.locator(".fight-boss-toggle")).toHaveCount(1);
  await expect(items).toHaveCount(3);
  await expect(
    trashSection.locator(
      ".fight-boss-toggle, .fight-card, .fight-progress, .fight-outcome",
    ),
  ).toHaveCount(0);
  await expect(items.locator(".fight-trash-name")).toHaveText([
    "蛛魔潜伏者",
    "深渊祭司",
    "蛛魔潜伏者",
  ]);
  expect(
    await items.evaluateAll((elements) =>
      elements.map((element) => element.getAttribute("data-fight-id")),
    ),
  ).toEqual(["90", "92", "91"]);
  await expect(items.locator(".fight-trash-duration")).toHaveText([
    "(00:03)",
    "(00:02)",
    "(00:04)",
  ]);
  await expect(items.last().locator("time")).toHaveText("02:37 下午");
  await expect(items.first().locator(".fight-trash-name")).toHaveCSS(
    "color",
    "rgb(132, 189, 248)",
  );
  await expect(items.first()).toHaveCSS("border-top-width", "0px");
  for (const [width, height] of [
    [1440, 900],
    [960, 720],
  ]) {
    await desktop.evaluate(
      ({ BrowserWindow }, size) =>
        BrowserWindow.getAllWindows()[0].setSize(size[0], size[1]),
      [width, height],
    );
    const first = bosses.first();
    const nameBox = (await first.locator(".fight-boss-name").boundingBox())!;
    const summaryBox = (await first
      .locator(".fight-boss-summary")
      .boundingBox())!;
    const buttonBox = (await first
      .locator(".fight-boss-select")
      .boundingBox())!;
    const otherSummary = (await bosses
      .last()
      .locator(".fight-boss-summary")
      .boundingBox())!;
    expect(nameBox.width).toBeGreaterThanOrEqual(300);
    expect(nameBox.height).toBeGreaterThan(30);
    expect(summaryBox.x - nameBox.x - nameBox.width).toBeCloseTo(12, 0);
    expect(summaryBox.x).toBeLessThan(buttonBox.x + buttonBox.width * 0.6);
    expect(Math.abs(summaryBox.x - otherSummary.x)).toBeLessThan(1);
    await expect(first.locator(".fight-boss-summary")).toHaveCSS(
      "text-align",
      "left",
    );
    const lastBossBox = (await bosses.last().boundingBox())!;
    const trashBox = (await trashSection.boundingBox())!;
    expect(trashBox.y).toBeGreaterThanOrEqual(
      lastBossBox.y + lastBossBox.height,
    );
    for (const item of await items.all()) {
      await expect(item).toBeInViewport({ ratio: 1 });
      const name = (await item.locator(".fight-trash-name").boundingBox())!;
      const duration = (await item
        .locator(".fight-trash-duration")
        .boundingBox())!;
      const time = (await item.locator("time").boundingBox())!;
      expect(duration.x).toBeGreaterThanOrEqual(name.x + name.width);
      expect(time.x).toBeGreaterThanOrEqual(duration.x + duration.width);
    }
    await page.screenshot({
      path: info.outputPath("fight-list-trash-" + width + ".png"),
      fullPage: true,
    });
  }
  await items.last().locator("time").click();
  await expect(selector).toContainText("蛛魔潜伏者");
  await expect(page.locator(".fights")).toBeHidden();
  await selector.click();
  await expect(items.last()).toHaveAttribute("aria-pressed", "true");
  await expect(items.first()).toHaveAttribute("aria-pressed", "false");
  await load(page, url + "?fight=91");
  await expect(
    page.getByRole("button", { name: "选择阶段", exact: true }),
  ).toBeEnabled();
  await expect(selector).toHaveAttribute("aria-expanded", "false");
  await selector.click();
  await expect(items.last()).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".fight-boss-body:visible")).toHaveCount(0);
  await items.first().press("Enter");
  await expect(page.locator(".fights")).toBeHidden();
  await selector.click();
  await expect(items.first()).toHaveAttribute("aria-pressed", "true");
  fixture.fights = trash;
  await mockWcl(desktop, fixture);
  await load(page, "https://cn.warcraftlogs.com/reports/onlytrash");
  await expect(bosses).toHaveCount(0);
  await expect(items).toHaveCount(3);
  await expect(page.locator(".fights .empty")).toHaveCount(0);
  await expect(items.first()).toBeVisible();
  fixture.fights = [trash[0]];
  await mockWcl(desktop, fixture);
  await load(page, "https://cn.warcraftlogs.com/reports/singletrash");
  await expect(
    page.getByRole("region", { name: "Trash Fights (1)", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".fight-trash-item")).toHaveCount(1);
  await expect(page.locator(".fight-boss-toggle")).toHaveCount(0);
  await page.locator(".fight-trash-item").press("Space");
  await expect(page.locator(".fights")).toBeHidden();
  await expect(selector).toContainText("蛛魔潜伏者");
});

test("Boss 仅右侧整高按钮展开，名称及信息选择最近击杀，单场 Boss 不提供展开", async ({
  appPage: page,
  desktop,
}, info) => {
  const fixture = structuredClone(report);
  const baseFight = fixture.fights![0];
  fixture.fights = [
    baseFight,
    { ...baseFight, id: 2, startTime: 2000 },
    { ...baseFight, id: 3, kill: false, startTime: 3000 },
    {
      ...baseFight,
      id: 4,
      name: "灭团首领",
      encounterID: 100,
      difficulty: 4,
      kill: false,
      startTime: 4000,
    },
    {
      ...baseFight,
      id: 5,
      name: "灭团首领",
      encounterID: 100,
      difficulty: 4,
      kill: false,
      startTime: 5000,
    },
    {
      ...baseFight,
      id: 6,
      name: "单场首领",
      encounterID: 101,
      startTime: 6000,
    },
  ];
  await mockWcl(desktop, fixture);
  const url = "https://cn.warcraftlogs.com/reports/bossactions";
  const selector = page.getByRole("button", { name: "选择战斗", exact: true });
  await load(page, url);
  await expect(page.locator(".fight-boss-group")).toHaveCount(3);
  const first = page.locator(".fight-boss-group").first();
  const toggle = first.locator(".fight-boss-toggle");
  const select = first.locator(".fight-boss-select");
  const single = page.locator(".fight-boss-group").last();
  await expect(page.locator(".fight-boss-toggle")).toHaveCount(2);
  await expect(
    single.locator(".fight-boss-toggle, .fight-boss-body"),
  ).toHaveCount(0);
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(selector).toHaveAttribute("aria-expanded", "true");
  await expect(select).toHaveAttribute("aria-pressed", "false");
  await select.locator(".fight-boss-name").click();
  await expect(selector).toContainText("Kill 2 (01:59)");
  await expect(page.locator(".fights")).toBeHidden();
  await selector.click();
  await expect(first.locator(".fight-boss-body")).toBeVisible();
  await expect(page.locator('[data-fight-id="2"]')).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await toggle.click();
  await expect(first.locator(".fight-boss-body")).toBeHidden();
  await select.locator(".fight-boss-summary").click();
  await expect(page.locator(".fights")).toBeHidden();
  await selector.click();
  await expect(first.locator(".fight-boss-body")).toBeHidden();
  await page
    .getByRole("button", { name: "选择 灭团首领 · 英雄", exact: true })
    .locator(".fight-boss-summary")
    .click();
  await expect(selector).toContainText("Wipe 2 (01:56)");
  await selector.click();
  await expect(page.locator('[data-default-fight-id="5"]')).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(page.locator(".fight-boss-body:visible")).toHaveCount(0);
  for (const [width, height] of [
    [1440, 900],
    [960, 720],
  ]) {
    await desktop.evaluate(
      ({ BrowserWindow }, size) =>
        BrowserWindow.getAllWindows()[0].setSize(size[0], size[1]),
      [width, height],
    );
    const headingBox = (await first
      .locator(".fight-boss-heading")
      .boundingBox())!;
    const toggleBox = (await toggle.boundingBox())!;
    expect(Math.abs(headingBox.y - toggleBox.y)).toBeLessThan(1);
    expect(Math.abs(headingBox.height - toggleBox.height)).toBeLessThan(1);
    expect(
      Math.abs(headingBox.x + headingBox.width - toggleBox.x - toggleBox.width),
    ).toBeLessThan(1);
    expect(toggleBox.width).toBeLessThan(headingBox.width / 2);
    await expect(toggle).toHaveCSS("border-left-width", "1px");
    await expect(toggle).toHaveCSS("border-left-style", "solid");
    await expect(single.locator(".fight-boss-select")).toBeInViewport({
      ratio: 1,
    });
    await page.screenshot({
      path: info.outputPath("boss-row-actions-" + width + ".png"),
      fullPage: true,
    });
  }
  await single.locator(".fight-boss-select").press("Enter");
  await expect(selector).toContainText("单场首领");
  await expect(page.locator(".fights")).toBeHidden();
  await load(page, url + "?fight=6");
  await expect(
    page.getByRole("button", { name: "选择阶段", exact: true }),
  ).toBeEnabled();
  await selector.click();
  await expect(single.locator(".fight-boss-select")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(
    single.locator(".fight-boss-toggle, .fight-boss-body"),
  ).toHaveCount(0);
  await expect(page.locator(".fight-boss-body:visible")).toHaveCount(0);
  await toggle.press("Space");
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(selector).toContainText("单场首领");
  await expect(selector).toHaveAttribute("aria-expanded", "true");
});

test("无 fight 时等待手动选择，新报告清空勾选", async ({ appPage: page }) => {
  await load(page, "abc");
  await expect(page.locator(".fight-card")).toHaveCount(0);
  await expect(
    page.locator(".fight-boss-select[data-only-fight-id]"),
  ).toHaveCount(1);
  await expect(page.locator(".skill")).toHaveCount(0);
  await expect(page.locator(".fight-card")).toBeHidden();
  await selectFight(page, 0);
  await firstCastActor(page);
  await page.locator(".skill").first().getByRole("checkbox").check();
  await page.getByRole("button", { name: "加载报告" }).click();
  await expect(page.getByLabel("Note 预览", { exact: true })).toHaveValue("");
});

test("默认队友施法并加载双方施法，光环按需加载，缓存复用且保留六类勾选", async ({
  appPage: page,
  desktop,
}) => {
  const eventRequests = () =>
    desktop.evaluate(
      () =>
        (
          globalThis as typeof globalThis & {
            testWcl: {
              eventRequests: { dataType: string; hostilityType: string }[];
            };
          }
        ).testWcl.eventRequests,
    );
  await load(page);
  await expect(page.getByLabel("角色列表", { exact: true })).toHaveText(
    "所有队友",
  );
  await expect(
    page.getByRole("button", { name: "队友", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(
    page.getByRole("tab", { name: "施法", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(page.locator(".actor-row")).toHaveCount(1);
  await firstCastActor(page);
  expect(await eventRequests()).toEqual([
    { dataType: "Casts", hostilityType: "Friendlies" },
    { dataType: "Casts", hostilityType: "Enemies" },
  ]);
  await page.locator(".skill").first().getByRole("checkbox").check();
  await page.getByRole("button", { name: "队友", exact: true }).click();
  await firstCastActor(page, 1, "队友");
  await page.locator(".skill").getByRole("checkbox").check();
  await expect(page.getByLabel("Note 预览", { exact: true })).toHaveValue(
    /裂解\(1\)/,
  );
  await expect(page.getByLabel("Note 预览", { exact: true })).toHaveValue(
    /FS - 时间扭曲/,
  );
  expect(await eventRequests()).toEqual([
    { dataType: "Casts", hostilityType: "Friendlies" },
    { dataType: "Casts", hostilityType: "Enemies" },
  ]);
  for (const [side, tab] of [
    ["队友", "Buff"],
    ["队友", "Debuff"],
    ["敌对", "Debuff"],
    ["敌对", "Buff"],
  ]) {
    await page.getByRole("button", { name: side, exact: true }).click();
    await page.getByRole("tab", { name: tab, exact: true }).click();
    await expect(page.locator(".skill")).toHaveCount(1);
    await page.locator(".skill").getByRole("checkbox").check();
  }
  // The selected enemy cast includes two instances, so six combinations yield seven groups.
  await expect(page.getByText("已选 7 组 · 跨标签保留")).toBeVisible();
  expect(await eventRequests()).toEqual([
    { dataType: "Casts", hostilityType: "Friendlies" },
    { dataType: "Casts", hostilityType: "Enemies" },
    { dataType: "Buffs", hostilityType: "Friendlies" },
    { dataType: "Debuffs", hostilityType: "Friendlies" },
    { dataType: "Debuffs", hostilityType: "Enemies" },
    { dataType: "Buffs", hostilityType: "Enemies" },
  ]);
  await page.getByRole("tab", { name: "施法", exact: true }).click();
  await firstCastActor(page);
  await expect(
    page.locator(".skill").first().getByRole("checkbox"),
  ).toBeChecked();
  await expect(page.getByText("已选 7 组 · 跨标签保留")).toBeVisible();
  await expect(page.getByLabel("Note 预览", { exact: true })).toHaveValue(
    /FS - 时间扭曲/,
  );
  await page.getByRole("button", { name: "清除全部" }).click();
  await page.getByRole("button", { name: "队友", exact: true }).click();
  await firstCastActor(page, 1, "队友");
  await expect(page.locator(".skill").getByRole("checkbox")).not.toBeChecked();
  await expect(page.getByLabel("Note 预览", { exact: true })).toHaveValue("");
  expect(await eventRequests()).toHaveLength(6);
});

test("WCL actor：悬停显示右侧宠物和实例菜单，保留职业颜色与键盘操作", async ({
  appPage: page,
}, info) => {
  await load(page);
  await page.getByRole("button", { name: "队友", exact: true }).click();
  await expect(page.locator(".actor-row")).toHaveCount(1);
  const picker = page.getByLabel("角色列表", { exact: true });
  await picker.click();
  await expect(page.getByText("选择 actor", { exact: true })).toHaveCount(0);
  await expect(page.locator(".actor-popups input, .actor-expand")).toHaveCount(
    0,
  );
  const player = page.getByRole("menuitem", { name: "玩家法师", exact: true });
  const pet = page.getByRole("menuitem", { name: "水元素", exact: true });
  await expect(player).toHaveAttribute("aria-expanded", "false");
  await expect(pet).toHaveCount(0);
  await expect(player.locator(".actor-name")).toHaveCSS(
    "color",
    "rgb(105, 204, 240)",
  );
  await player.hover();
  await expect(pet).toBeVisible();
  const playerBounds = (await player.boundingBox())!;
  const petMenu = page.getByRole("menu", { name: "玩家法师", exact: true });
  await expect
    .poll(async () => (await petMenu.boundingBox())!.x)
    .toBeGreaterThanOrEqual(playerBounds.x + playerBounds.width - 1);
  await expect(
    page.locator(".analysis-actor > .actor-picker summary strong"),
  ).toHaveText("所有队友");
  await expect(page.getByText("ID: 510", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("menuitem", { name: "水元素 #2", exact: true }),
  ).toHaveCount(0);
  await pet.hover();
  const instance = page.getByRole("menuitem", {
    name: "水元素 #2",
    exact: true,
  });
  await expect(instance).toBeVisible();
  await expect(instance).toHaveAttribute("title", /Instance ID: 2/);
  await instance.hover();
  await expect(petMenu).toBeVisible();
  await page.screenshot({
    path: info.outputPath("actor-picker-pets.png"),
    fullPage: true,
  });
  // A native screenshot can move the pointer; restore the hover path before clicking.
  await player.hover();
  await pet.hover();
  await instance.click();
  await expect(page.getByRole("menu")).toHaveCount(0);
  await expect(
    page.locator(".analysis-actor > .actor-picker summary strong"),
  ).toHaveText("水元素 #2");
  await expect(page.locator(".skill > b:first-of-type")).toHaveText("1");
  await picker.press("ArrowDown");
  await player.focus();
  await player.press("ArrowRight");
  await expect(pet).toBeFocused();
  await pet.press("ArrowRight");
  const firstInstance = page.getByRole("menuitem", {
    name: "水元素 #1",
    exact: true,
  });
  await expect(firstInstance).toBeFocused();
  await firstInstance.press("ArrowLeft");
  await expect(pet).toBeFocused();
  await expect(instance).toHaveCount(0);
  await pet.press("Escape");
  await expect(picker).toBeFocused();
  await expect(page.getByRole("menu")).toHaveCount(0);
  await picker.click();
  await player.click();
  await expect(
    page.locator(".analysis-actor > .actor-picker summary strong"),
  ).toHaveCSS("color", "rgb(105, 204, 240)");
  await picker.click();
  await page.getByLabel("报告链接").click();
  await expect(page.getByRole("menu")).toHaveCount(0);
});

test("WCL actor：同名 NPC、悬停实例与跨标签来源筛选", async ({
  appPage: page,
}, info) => {
  await load(page);
  await page.getByRole("button", { name: "敌对", exact: true }).click();
  await expect(page.locator(".actor-row")).toHaveCount(2);
  const picker = page.getByLabel("角色列表", { exact: true });
  await picker.click();
  await expect(
    page.getByRole("menuitem", { name: "首领", exact: true }),
  ).toHaveCount(2);
  await expect(
    page
      .getByRole("menu", { name: "角色", exact: true })
      .getByText("ID: 900101", { exact: true }),
  ).toBeVisible();
  const firstActor = page
    .getByRole("menuitem", { name: "首领", exact: true })
    .filter({ hasText: "900100" });
  await firstActor.hover();
  const instance = page.getByRole("menuitem", { name: "首领 #2", exact: true });
  await expect(instance).toHaveAttribute(
    "title",
    /Actor ID: 10.*Instance ID: 2/,
  );
  await page.screenshot({
    path: info.outputPath("actor-picker-npc.png"),
    fullPage: true,
  });
  await instance.click();
  await expect(page.locator(".skill")).toHaveCount(1);
  await expect(page.locator(".skill > b:first-of-type")).toHaveText("1");
  await page.getByRole("tab", { name: "Buff", exact: true }).click();
  await expect(
    page.locator(".analysis-actor > .actor-picker summary strong"),
  ).toHaveText("首领 #2");
  await expect(page.locator(".skill")).toHaveCount(0);
  await picker.click();
  await firstActor.hover();
  await expect(instance).toBeVisible();
  await page.getByRole("menuitem", { name: "所有敌对", exact: true }).click();
  await expect(page.locator(".skill")).toHaveCount(1);
});

test("WCL actor：每列最多 10 个名字、宽度自适应与窄窗口浮层边界", async ({
  appPage: page,
  desktop,
}, info) => {
  const fixture = structuredClone(report);
  const fight = fixture.fights![0];
  for (let i = 0; i < 23; i++) {
    const id = 100 + i;
    fight.friendlyPlayers!.push(id);
    fixture.masterData!.actors.push({
      id,
      name: `A${String(i + 1).padStart(2, "0")}`,
      type: "Player",
      subType: "Mage",
    });
  }
  for (let i = 0; i < 13; i++) {
    const id = 200 + i;
    fight.friendlyPets!.push({ id, petOwner: 20 });
    fixture.masterData!.actors.push({
      id,
      gameID: 100001 + i,
      name: `召唤物 ${String(i + 1).padStart(2, "0")}`,
      type: "Pet",
      petOwner: 20,
    });
  }
  await mockWcl(desktop, fixture);
  await load(page);
  await page.getByRole("button", { name: "队友", exact: true }).click();
  await expect(page.locator(".actor-row")).toHaveCount(1);
  const picker = page.getByLabel("角色列表", { exact: true });
  await picker.click();
  const root = page.getByRole("menu", { name: "角色", exact: true });
  const columns = root.locator(".actor-column");
  await expect(columns).toHaveCount(3);
  await expect(columns.nth(0).getByRole("menuitem")).toHaveCount(10);
  await expect(columns.nth(1).getByRole("menuitem")).toHaveCount(10);
  await expect(columns.nth(2).getByRole("menuitem")).toHaveCount(4);
  const rootBounds = (await root.boundingBox())!;
  const triggerBounds = (await picker.boundingBox())!;
  expect(triggerBounds.width).toBeLessThan(180);
  expect(rootBounds.width).toBeGreaterThan(triggerBounds.width);
  const first = (await columns
    .nth(0)
    .getByRole("menuitem")
    .first()
    .boundingBox())!;
  const second = (await columns
    .nth(1)
    .getByRole("menuitem")
    .first()
    .boundingBox())!;
  expect(second.x).toBeGreaterThan(first.x);
  expect(Math.abs(second.y - first.y)).toBeLessThan(1);
  await picker.press("Escape");
  await desktop.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setSize(960, 720),
  );
  await picker.click();
  const player = page.getByRole("menuitem", { name: "玩家法师", exact: true });
  await player.hover();
  const pets = page.getByRole("menu", { name: "玩家法师", exact: true });
  await expect(pets.locator(".actor-column")).toHaveCount(2);
  await expect(
    pets.locator(".actor-column").nth(0).getByRole("menuitem"),
  ).toHaveCount(10);
  await expect(
    pets.locator(".actor-column").nth(1).getByRole("menuitem"),
  ).toHaveCount(4);
  await expect(pets).toBeInViewport({ ratio: 1 });
  await page.getByRole("menuitem", { name: "水元素", exact: true }).hover();
  await expect(
    page.getByRole("menuitem", { name: "水元素 #2", exact: true }),
  ).toBeVisible();
  const bounds = await page.locator(".actor-menu").evaluateAll((menus) =>
    menus.map((menu) => {
      const box = menu.getBoundingClientRect();
      return {
        left: box.left,
        right: box.right,
        top: box.top,
        bottom: box.bottom,
        viewportWidth: innerWidth,
        viewportHeight: innerHeight,
      };
    }),
  );
  for (const box of bounds) {
    expect(box.left).toBeGreaterThanOrEqual(8);
    expect(box.right).toBeLessThanOrEqual(box.viewportWidth - 8);
    expect(box.top).toBeGreaterThanOrEqual(8);
    expect(box.bottom).toBeLessThanOrEqual(box.viewportHeight - 8);
  }
  await page.screenshot({
    path: info.outputPath("actor-picker-columns.png"),
    fullPage: true,
  });
});

test("WCL actor：选择宠物与跨标签保留角色筛选", async ({ appPage: page }) => {
  await load(page);
  await page.getByRole("button", { name: "队友", exact: true }).click();
  await expect(page.locator(".actor-row")).toHaveCount(1);
  const picker = page.getByLabel("角色列表", { exact: true });
  await picker.click();
  await page.getByRole("menuitem", { name: "玩家法师", exact: true }).hover();
  await page.getByRole("menuitem", { name: "水元素", exact: true }).click();
  await expect(page.getByRole("menu")).toHaveCount(0);
  await expect(page.locator(".skill")).toContainText("水箭");
  await page.locator(".skill").getByRole("checkbox").check();
  await expect(page.getByLabel("Note 预览", { exact: true })).toHaveValue(
    /time:01:17/,
  );
  await picker.click();
  await page.getByRole("menuitem", { name: "玩家法师", exact: true }).click();
  await page.getByRole("tab", { name: "Buff", exact: true }).click();
  await expect(
    page.locator(".analysis-actor > .actor-picker summary strong"),
  ).toHaveText("玩家法师");
  await page.locator(".skill").getByRole("checkbox").check();
  await page.getByRole("button", { name: "清除全部" }).click();
  await page.getByRole("tab", { name: "施法", exact: true }).click();
  await expect(page.locator(".skill").getByRole("checkbox")).not.toBeChecked();
});

test("自定义凭据自动保存、真实 Windows 加密、重启恢复与默认重置", async ({
  appPage: page,
  desktop,
  profile,
}) => {
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await expect(page.getByLabel("Client ID", { exact: true })).toHaveValue("");
  await expect(page.getByLabel("Client Secret", { exact: true })).toHaveValue(
    "",
  );
  await page.getByLabel("Client ID", { exact: true }).fill("fixture-client-id");
  await page
    .getByLabel("Client Secret", { exact: true })
    .fill("fixture-client-secret");
  await expect(page.locator(".settings-status")).toContainText(
    "已自动保存到本机",
  );
  await expect(page.locator(".mode")).toHaveCount(0);
  const disk = await readFile(resolve(profile, "credentials.json"), "utf8");
  expect(disk).not.toContain("fixture-client-secret");
  await closeAfterLoadCheck(desktop);
  const restarted = await launch(profile);
  try {
    const nextPage = await restarted.firstWindow();
    await expect(
      nextPage.getByRole("button", { name: "设置", exact: true }),
    ).toBeEnabled();
    await nextPage.getByRole("button", { name: "设置", exact: true }).click();
    await expect(nextPage.getByLabel("Client ID", { exact: true })).toHaveValue(
      "fixture-client-id",
    );
    await expect(
      nextPage.getByLabel("Client Secret", { exact: true }),
    ).toHaveValue("fixture-client-secret");
    await nextPage.getByRole("button", { name: "恢复默认" }).click();
    await expect(nextPage.locator(".settings-status")).toContainText(
      "已恢复内置凭据",
    );
    await expect(
      nextPage.getByLabel("Client Secret", { exact: true }),
    ).toHaveValue("");
  } finally {
    await restarted.close();
  }
});

test("切换报告会取消主进程请求，迟到的旧报告不会覆盖", async ({
  appPage: page,
  desktop,
}) => {
  await load(page, "slow");
  await expect
    .poll(() =>
      desktop.evaluate(
        () =>
          (globalThis as typeof globalThis & { testWcl: { slow: boolean } })
            .testWcl.slow,
      ),
    )
    .toBe(true);
  await load(page, "fast");
  await expect(page.locator(".fight-boss-name")).toContainText("测试首领");
  await expect
    .poll(() =>
      desktop.evaluate(
        () =>
          (globalThis as typeof globalThis & { testWcl: { canceled: number } })
            .testWcl.canceled,
      ),
    )
    .toBeGreaterThan(0);
  await page.waitForTimeout(800);
  await expect(page.locator(".fight-boss-name")).not.toContainText("旧报告");
});

test("WCL 权限错误可重试恢复，取消另存为不显示保存成功", async ({
  appPage: page,
  desktop,
}) => {
  await desktop.evaluate(() => {
    (
      globalThis as typeof globalThis & { testWcl: { failures: number } }
    ).testWcl.failures = 1;
  });
  await load(page);
  await expect(page.getByRole("alert")).toContainText("没有权限");
  await page.getByRole("button", { name: "重试", exact: true }).click();
  await firstCastActor(page);
  await page.locator(".skill").first().getByRole("checkbox").check();
  await desktop.evaluate(({ dialog }) => {
    dialog.showSaveDialog = async () => ({ canceled: true, filePath: "" });
  });
  await page.getByRole("button", { name: "保存 txt" }).click();
  await expect(page.locator("main > footer")).toHaveCount(0);
});

test("渲染进程隔离、设置弹窗与固定链接、最小窗口三栏可见和战斗栏折叠", async ({
  appPage: page,
  desktop,
}, info) => {
  expect(
    await page.evaluate(
      () => typeof (window as unknown as Record<string, unknown>).require,
    ),
  ).toBe("undefined");
  const cdp = await page.context().newCDPSession(page);
  const contexts: { id: number; name: string }[] = [];
  cdp.on("Runtime.executionContextCreated", ({ context }) =>
    contexts.push(context),
  );
  await cdp.send("Runtime.enable");
  const preload = contexts.find(
    (context) => context.name === "Electron Isolated Context",
  );
  expect(preload).toBeDefined();
  const evaluation = await cdp.send("Runtime.evaluate", {
    expression: "typeof window.wcl2note",
    contextId: preload!.id,
    returnByValue: true,
  });
  expect(evaluation.result.value).toBe("undefined");
  const sandboxed = await desktop.evaluate(({ app }) =>
    app
      .getAppMetrics()
      .filter((process) => process.type === "Tab")
      .every((process) => process.sandboxed),
  );
  expect(sandboxed).toBe(true);
  await cdp.detach();
  await desktop.evaluate(({ shell }) => {
    shell.openExternal = async (url) => {
      (
        globalThis as typeof globalThis & { testWcl: { openedUrl: string } }
      ).testWcl.openedUrl = url;
    };
  });
  const workspaceBefore = await page.locator(".workspace").boundingBox();
  const settingsButton = page.getByRole("button", {
    name: "设置",
    exact: true,
  });
  await settingsButton.click();
  const settingsDialog = page.getByRole("dialog", {
    name: "设置",
  });
  await expect(settingsDialog).toBeVisible();
  expect(await page.locator(".workspace").boundingBox()).toEqual(
    workspaceBefore,
  );
  await page.getByLabel("Client ID", { exact: true }).focus();
  await page.keyboard.press("Escape");
  await expect(settingsDialog).not.toBeVisible();
  await expect(settingsButton).toBeFocused();
  await settingsButton.click();
  await page.getByRole("button", { name: /申请 WCL API/ }).click();
  expect(
    await desktop.evaluate(
      () =>
        (globalThis as typeof globalThis & { testWcl: { openedUrl: string } })
          .testWcl.openedUrl,
    ),
  ).toBe("https://cn.warcraftlogs.com/api/clients/");
  expect(desktop.windows()).toHaveLength(1);
  await page.getByRole("button", { name: "关闭设置" }).click();
  await desktop.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setSize(960, 720),
  );
  await load(page);
  await firstCastActor(page);
  await page.locator(".skill").first().getByRole("checkbox").check();
  expect(
    await page.evaluate(
      () =>
        document.documentElement.scrollWidth <= innerWidth &&
        document.documentElement.scrollHeight <= innerHeight,
    ),
  ).toBe(true);
  for (const selector of [".fights", ".skill-list", ".preview"]) {
    await expect(page.locator(selector)).toBeInViewport({ ratio: 1 });
  }
  await expect(page.getByRole("button", { name: "复制笔记" })).toBeInViewport({
    ratio: 1,
  });
  await expect(page.getByRole("button", { name: "保存 txt" })).toBeInViewport({
    ratio: 1,
  });
  const abilitiesBefore = (await page.locator(".abilities").boundingBox())!;
  const previewBounds = (await page.locator(".preview").boundingBox())!;
  expect(Math.abs(abilitiesBefore.y - previewBounds.y)).toBeLessThan(1);
  const noteBefore = await page
    .getByLabel("Note 预览", { exact: true })
    .inputValue();
  await page.getByRole("button", { name: "折叠战斗与阶段" }).click();
  await expect(
    page.getByRole("button", { name: "展开战斗与阶段" }),
  ).toBeVisible();
  await expect(page.locator(".fight-card")).not.toBeVisible();
  expect(
    (await page.locator(".abilities").boundingBox())!.width,
  ).toBeGreaterThan(abilitiesBefore.width);
  await expect(page.getByLabel("Note 预览", { exact: true })).toHaveValue(
    noteBefore,
  );
  await page.screenshot({
    path: info.outputPath("collapsed-window.png"),
    fullPage: true,
  });
  await page.getByRole("button", { name: "展开战斗与阶段" }).click();
  await expect(page.locator(".fight-card.active")).toBeVisible();
  await expect(
    page.locator(".skill").first().getByRole("checkbox"),
  ).toBeChecked();
  await settingsButton.click();
  await expect(settingsDialog).toBeInViewport({ ratio: 1 });
  await page.screenshot({
    path: info.outputPath("settings-dialog.png"),
    fullPage: true,
  });
  await page.keyboard.press("Escape");
  await expect(settingsButton).toBeFocused();
  await page.screenshot({
    path: info.outputPath("minimum-window.png"),
    fullPage: true,
  });
});

test("时间轴局部视窗、独立阶段导航、概览调整和拖动平移不改变 Note", async ({
  appPage: page,
  desktop,
}, info) => {
  await loadTimelineFixture(page, desktop, false, true, "default");
  const scope = page.getByLabel("时间轴导出范围");
  const range = page.getByLabel("时间轴可见范围");
  const preview = page.getByLabel("Note 预览", { exact: true });
  await expect(page.getByLabel("时间轴战斗", { exact: true })).toHaveCount(0);
  await expect(page.locator(".report-navigation")).toBeVisible();
  await expect(range).toHaveText("00:00 – 00:20");
  await timelineWindow(page, "first");
  await expect(scope).toHaveValue("full");
  await expect(page.locator(".timeline-minor-tick").first()).toBeVisible();
  await expect(page.locator(".timeline-marker-indicator")).toHaveCount(0);
  await expect(page.locator(".timeline-marker .game-icon").first()).toHaveCSS(
    "filter",
    "none",
  );
  await page
    .getByRole("button", {
      name: "潮汐守卫 潮汐冲击 00:30.000 施法",
      exact: true,
    })
    .click();
  await page
    .getByRole("checkbox", {
      name: "导出事件 潮汐守卫 潮汐冲击 00:30.000 施法",
      exact: true,
    })
    .check();
  await expect(preview).toHaveValue(/time:00:27\.0.*潮汐冲击/);
  const note = await preview.inputValue();
  await timelineWindow(page, "second");
  await expect(range).toHaveText("02:00 – 04:00");
  await expect(scope).toHaveValue("full");
  await expect(preview).toHaveValue(note);
  await expect(
    page.getByRole("button", { name: "查看 第一阶段", exact: true }),
  ).toBeVisible();
  const overview = page.getByRole("slider", { name: "全局概览可见范围" });
  const box = (await overview.boundingBox())!;
  await page.mouse.move(box.x + box.width * 0.75, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.25, box.y + box.height / 2, {
    steps: 8,
  });
  await page.mouse.up();
  await expect(range).toHaveText("00:00 – 02:00");
  await page.mouse.move(box.x + 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 8, box.y + box.height / 2, {
    steps: 6,
  });
  await page.mouse.up();
  await expect
    .poll(async () => Number(await overview.getAttribute("aria-valuenow")))
    .toBeGreaterThan(20000);
  await expect(preview).toHaveValue(note);
  await timelineWindow(page, "first");
  await page.getByRole("button", { name: "显示 30 秒", exact: true }).click();
  await expect(range).toHaveText("00:00 – 00:30");
  const lane = page.locator(".timeline-scale");
  const laneBox = (await lane.boundingBox())!;
  await page.mouse.move(laneBox.x + laneBox.width * 0.4, laneBox.y + 15);
  await expect(page.locator(".timeline-crosshair")).toHaveCount(1);
  await expect(page.locator(".timeline-cursor-time")).toHaveText(
    /00:1\d\.\d{3}/,
  );
  await page.getByRole("button", { name: "拖动平移", exact: true }).click();
  await page.mouse.move(laneBox.x + laneBox.width * 0.7, laneBox.y + 15);
  await page.mouse.down();
  await page.mouse.move(laneBox.x + laneBox.width * 0.3, laneBox.y + 15, {
    steps: 8,
  });
  await page.mouse.up();
  await expect(range).not.toHaveText("00:00 – 00:30");
  await expect(preview).toHaveValue(note);
  await page.getByRole("button", { name: "显示全程", exact: true }).click();
  await expect(range).toHaveText("00:00 – 04:00");
  await page.getByRole("button", { name: "恢复默认视窗", exact: true }).click();
  await timelineWindow(page, "first");
  await expect(range).toHaveText("00:00 – 02:00");
  const detailHeight = (await page.locator(".timeline-viewport").boundingBox())!
    .height;
  await page.getByRole("button", { name: "收起事件详情", exact: true }).click();
  await expect
    .poll(
      async () =>
        (await page.locator(".timeline-viewport").boundingBox())!.height,
    )
    .toBeGreaterThan(detailHeight);
  await expect(preview).toHaveValue(note);
  await page.screenshot({
    path: info.outputPath("timeline-navigation.png"),
    fullPage: true,
  });
});

test("时间轴批量加入当前区间、已选过滤与导出范围各自生效", async ({
  appPage: page,
  desktop,
}, info) => {
  await loadTimelineFixture(page, desktop, false);
  const preview = page.getByLabel("Note 预览", { exact: true });
  await page
    .getByRole("button", { name: "折叠 队友施法", exact: true })
    .click();
  await expect(page.getByRole("button", { name: /^加入当前区间/ })).toHaveText(
    "加入当前区间 (4)",
  );
  await page
    .getByRole("button", { name: "展开 队友施法", exact: true })
    .click();
  await page
    .getByRole("button", { name: "隐藏 潮汐守卫 潮汐冲击", exact: true })
    .click();
  await page.getByRole("button", { name: /^加入当前区间/ }).click();
  await expect(page.locator(".timeline-panel .panel-foot")).toContainText(
    "导出 5 次事件",
  );
  await expect(preview).not.toHaveValue(/潮汐冲击/);
  await page.getByRole("button", { name: /显示隐藏 \(1\)/ }).click();
  await page.getByRole("button", { name: /^加入当前区间/ }).click();
  await expect(page.locator(".timeline-panel .panel-foot")).toContainText(
    "导出 8 次事件",
  );
  await expect(preview).not.toHaveValue(/time:02:/);
  await page.getByRole("button", { name: "已加入 Note", exact: true }).click();
  await expect(page.locator(".timeline-marker.available")).toHaveCount(0);
  await page.getByRole("button", { name: "全部事件", exact: true }).click();
  await page.getByLabel("时间轴导出范围").selectOption("phase-2");
  await expect(preview).toHaveValue("");
  await page.getByRole("button", { name: /^加入当前区间/ }).click();
  await expect(preview).toHaveValue(/time:02:/);
  await expect(preview).not.toHaveValue(/time:00:/);
  const scopedNote = await preview.inputValue();
  await timelineWindow(page, "first");
  await expect(page.getByLabel("时间轴导出范围")).toHaveValue("phase-2");
  await expect(preview).toHaveValue(scopedNote);
  await expect(
    page.getByRole("button", { name: /^加入当前区间/ }),
  ).toBeDisabled();
  await page.getByLabel("时间轴导出范围").selectOption("full");
  await expect(page.locator(".timeline-panel .panel-foot")).toContainText(
    "导出 16 次事件",
  );
  await ensureNoteOpen(page);
  await desktop.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setSize(960, 720),
  );
  for (const target of [
    page.locator(".timeline-viewport"),
    page.getByLabel("时间轴导出范围"),
    page.getByRole("button", { name: "复制笔记", exact: true }),
  ])
    await expect(target).toBeInViewport({ ratio: 1 });
  await page.screenshot({
    path: info.outputPath("timeline-editor-960.png"),
    fullPage: true,
  });
});

test("时间轴重叠事件显示数量，纵向展开后同毫秒事件仍可独立勾选", async ({
  appPage: page,
  desktop,
}, info) => {
  await mockEventData(desktop, {
    "Casts:Enemies": Array.from({ length: 6 }, () => ({ ...enemies[0] })),
  });
  await load(page);
  await page.getByRole("button", { name: "时间轴视图", exact: true }).click();
  const cluster = page.locator(".timeline-cluster").first();
  await expect(cluster.locator(".timeline-cluster-count")).toHaveText("6");
  await cluster.click();
  const row = page.locator('.timeline-row[data-side="enemy"]').first();
  await timelineWindow(page, "full");
  await expect(row.locator(".timeline-marker[data-event-id]")).toHaveCount(6);
  const positions = await row
    .locator(".timeline-marker")
    .evaluateAll((elements) =>
      elements.map((element) => {
        const box = element.getBoundingClientRect();
        return { x: box.x, y: box.y };
      }),
    );
  expect(new Set(positions.map((position) => position.x)).size).toBe(1);
  expect(new Set(positions.map((position) => position.y)).size).toBe(6);
  const choices = page.locator(".timeline-occurrence-list input");
  await expect(choices).toHaveCount(6);
  await choices.first().check();
  await expect(choices.nth(1)).not.toBeChecked();
  await expect(page.locator(".timeline-occurrences-heading")).toContainText(
    "1 / 6 次加入导出",
  );
  await expect(row.locator(".timeline-included-badge")).toHaveCount(1);
  await page.screenshot({
    path: info.outputPath("timeline-overlap-expanded.png"),
    fullPage: true,
  });
});

test("切换战斗和视图恢复各自的勾选、视窗、隐藏及滚动，新报告重置", async ({
  appPage: page,
  desktop,
}) => {
  const fixture = structuredClone(timelineReport);
  fixture.fights!.push({
    ...fixture.fights![0],
    id: 2,
    name: "另一场潮汐演练",
    kill: false,
  });
  await mockWcl(desktop, fixture);
  await mockEventData(desktop, {
    "Casts:Enemies": timelineEvents("Casts", "enemy"),
    "Casts:Friendlies": timelineEvents("Casts", "friendly"),
  });
  await load(page);
  await page.getByRole("button", { name: "时间轴视图", exact: true }).click();
  await selectFight(page, 0);
  await timelineWindow(page, "first");
  await page
    .getByRole("button", {
      name: "潮汐守卫 潮汐冲击 00:30.000 施法",
      exact: true,
    })
    .click();
  await page
    .getByRole("checkbox", {
      name: "导出事件 潮汐守卫 潮汐冲击 00:30.000 施法",
      exact: true,
    })
    .check();
  await page
    .getByRole("button", { name: "隐藏 潮汐守卫 深海震荡", exact: true })
    .click();
  await page.getByRole("button", { name: "显示 60 秒", exact: true }).click();
  const preview = page.getByLabel("Note 预览", { exact: true });
  const note = await preview.inputValue();
  await page.locator(".timeline-canvas").evaluate((element) => {
    element.scrollTop = 80;
  });
  await expect
    .poll(() =>
      page.locator(".timeline-canvas").evaluate((element) => element.scrollTop),
    )
    .toBeGreaterThan(0);
  const scrollTop = await page
    .locator(".timeline-canvas")
    .evaluate((element) => element.scrollTop);
  await selectFight(page, 1);
  await expect(preview).toHaveValue("");
  await expect(page.getByLabel("时间轴可见范围")).toHaveText("00:00 – 00:20");
  await expect(page.locator(".timeline-row")).toHaveCount(6);
  await selectFight(page, 0);
  await expect(preview).toHaveValue(note);
  await expect(page.getByLabel("时间轴可见范围")).toHaveText("00:00 – 01:00");
  await expect(page.locator(".timeline-row")).toHaveCount(5);
  await expect(page.locator(".timeline-section").first()).toContainText(
    "潮汐守卫",
  );
  await expect
    .poll(() =>
      page.locator(".timeline-canvas").evaluate((element) => element.scrollTop),
    )
    .toBe(scrollTop);
  await page.getByRole("button", { name: "图表视图", exact: true }).click();
  await page.getByRole("button", { name: "时间轴视图", exact: true }).click();
  await expect(page.getByLabel("时间轴可见范围")).toHaveText("00:00 – 01:00");
  await expect(page.locator(".timeline-row")).toHaveCount(5);
  await page.getByRole("button", { name: "加载报告", exact: true }).click();
  await expect(preview).toHaveValue("");
  await expect(page.getByLabel("时间轴可见范围")).toHaveText("00:00 – 00:20");
  await expect(page.locator(".timeline-row")).toHaveCount(6);
});

test("时间轴模拟响应：逐次选择、MRT 定位、隐藏折叠与技能列表联动", async ({
  appPage: page,
  desktop,
}, info) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await loadTimelineFixture(page, desktop, true, true, "default");
  await expect(page.locator(".timeline-row")).toHaveCount(6);
  await expect(page.getByLabel("时间轴可见范围")).toHaveText("00:00 – 02:00");
  await page
    .getByRole("button", {
      name: "潮汐守卫 潮汐冲击 00:30.000 施法",
      exact: true,
    })
    .click();
  const event = page.getByRole("checkbox", {
    name: "导出事件 潮汐守卫 潮汐冲击 00:30.000 施法",
    exact: true,
  });
  await event.uncheck();
  await expect(page.getByLabel("Note 预览", { exact: true })).not.toHaveValue(
    /time:00:27\.0.*潮汐冲击/,
  );
  await expect(
    page.getByRole("checkbox", {
      name: "导出整行 潮汐守卫 潮汐冲击 施法",
      exact: true,
    }),
  ).toHaveJSProperty("indeterminate", true);
  await event.check();
  await page.getByRole("button", { name: "定位 Note", exact: true }).click();
  const preview = page.getByLabel("Note 预览", { exact: true });
  await expect(preview).toBeFocused();
  expect(
    await preview.evaluate((element: HTMLTextAreaElement) =>
      element.value.slice(element.selectionStart, element.selectionEnd),
    ),
  ).toContain("{time:00:27.0}");
  await page.getByRole("button", { name: "定位 Note", exact: true }).click();
  await expect(preview).toBeFocused();
  const before = await preview.inputValue();
  await page
    .getByRole("button", { name: "隐藏 潮汐守卫 潮汐冲击", exact: true })
    .click();
  await expect(page.locator(".timeline-row")).toHaveCount(5);
  await expect(preview).toHaveValue(before);
  await page.getByRole("button", { name: /已隐藏 \(1\)/ }).click();
  await expect(page.locator(".timeline-row")).toHaveCount(6);
  await expect(preview).toHaveValue(before);
  await page
    .getByRole("button", { name: "折叠 敌对施法", exact: true })
    .click();
  await expect(page.locator(".timeline-row")).toHaveCount(4);
  await expect(preview).toHaveValue(before);
  await page
    .getByRole("button", { name: "展开 敌对施法", exact: true })
    .click();
  await event.uncheck();
  await page.getByRole("button", { name: "图表视图", exact: true }).click();
  await page.getByRole("button", { name: "敌对", exact: true }).click();
  await page.locator(".actor-row").filter({ hasText: "潮汐守卫" }).click();
  const selectedSkill = page.locator(".skill").filter({ hasText: "潮汐冲击" });
  await expect(selectedSkill).toContainText("潮汐冲击");
  await expect(selectedSkill.locator("b").first()).toHaveText("6");
  await expect(selectedSkill.getByRole("checkbox")).toHaveJSProperty(
    "indeterminate",
    true,
  );
  await selectedSkill.getByRole("checkbox").check();
  await expect(preview).toHaveValue(/time:00:27\.0.*潮汐冲击/);
  await page.getByRole("button", { name: "时间轴视图", exact: true }).click();
  await page
    .getByRole("button", { name: "收起 Note 预览", exact: true })
    .click();
  await ensureNoteOpen(page);
  await page.getByRole("button", { name: "复制笔记", exact: true }).click();
  expect(
    await desktop.evaluate(({ clipboard }) => clipboard.readText()),
  ).toContain("{time:00:27.0}");
  const requests = await desktop.evaluate(
    () =>
      (
        globalThis as typeof globalThis & {
          testWcl: { tokenRequests: number; eventRequests: unknown[] };
        }
      ).testWcl,
  );
  expect(requests.tokenRequests).toBeGreaterThan(0);
  // Event responses are intercepted by mockEventData before the base mock.
  expect(requests.eventRequests).toEqual([]);
  await page.screenshot({
    path: info.outputPath("timeline-fixture.png"),
    fullPage: true,
  });
  expect(errors).toEqual([]);
});

test("时间轴框选缩放、阶段和 Pull 计时、逐次选择跨阶段保留与报告重置", async ({
  appPage: page,
  desktop,
}, info) => {
  await load(page);
  await firstCastActor(page);
  await page.locator(".skill").getByRole("checkbox").check();
  await page.getByRole("button", { name: "时间轴视图", exact: true }).click();
  await timelineWindow(page, "full");
  await expect(page.locator(".timeline-marker")).toHaveCount(2);
  await page
    .getByRole("button", { name: /首领 1 裂解 00:35.000 施法/, exact: true })
    .click();
  const first = page.getByRole("checkbox", {
    name: /导出事件 首领 1 裂解 00:35.000 施法/,
    exact: true,
  });
  await first.uncheck();
  await page.getByLabel("时间轴导出范围").selectOption("phase-2");
  await expect(page.getByLabel("时间轴可见范围")).toHaveText("01:00 – 02:00");
  await expect(page.getByLabel("Note 预览", { exact: true })).toHaveValue(
    /time:01:05/,
  );
  await page.getByLabel("时间轴导出范围").selectOption("full");
  await page
    .getByRole("button", { name: /首领 1 裂解 00:35.000 施法/, exact: true })
    .click();
  await expect(first).not.toBeChecked();
  const lane = page.locator(".timeline-scale");
  const box = (await lane.boundingBox())!;
  await page.mouse.move(box.x + box.width * 0.15, box.y + 36);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.55, box.y + 36, { steps: 8 });
  await page.mouse.up();
  await expect(
    page.getByRole("button", { name: "恢复默认视窗", exact: true }),
  ).toBeEnabled();
  await expect(page.getByLabel("时间轴可见范围")).not.toHaveText(
    "00:00 – 02:00",
  );
  await page.getByRole("button", { name: "恢复默认视窗", exact: true }).click();
  await expect(page.getByLabel("时间轴可见范围")).toHaveText("00:00 – 00:20");
  const defaultBox = (await lane.boundingBox())!;
  const y = defaultBox.y + defaultBox.height / 2;
  // 少于两秒的拖选不改变视窗，反向拖选也能正常放大并同步滑块。
  await page.mouse.move(defaultBox.x + defaultBox.width * 0.2, y);
  await page.mouse.down();
  await page.mouse.move(defaultBox.x + defaultBox.width * 0.25, y, {
    steps: 4,
  });
  await page.mouse.up();
  await expect(page.getByLabel("时间轴可见范围")).toHaveText("00:00 – 00:20");
  await page.mouse.move(defaultBox.x + defaultBox.width * 0.65, y);
  await page.mouse.down();
  await page.mouse.move(defaultBox.x + defaultBox.width * 0.25, y, {
    steps: 6,
  });
  await page.mouse.up();
  const from = Number(
    await page
      .getByRole("slider", { name: "时间轴范围起点" })
      .getAttribute("aria-valuenow"),
  );
  const to = Number(
    await page
      .getByRole("slider", { name: "时间轴范围终点" })
      .getAttribute("aria-valuenow"),
  );
  expect(Math.abs(from - 5000)).toBeLessThan(100);
  expect(Math.abs(to - 13000)).toBeLessThan(100);
  await page.getByRole("button", { name: "恢复默认视窗", exact: true }).click();
  await page.locator(".timeline-canvas").focus();
  await page.keyboard.press("+");
  await expect(page.getByLabel("时间轴可见范围")).toHaveText("00:05 – 00:15");
  await page.keyboard.press("Home");
  await expect(page.getByLabel("时间轴可见范围")).toHaveText("00:00 – 00:20");
  await page.screenshot({
    path: info.outputPath("timeline-phases.png"),
    fullPage: true,
  });
  const dungeon = structuredClone(report);
  dungeon.fights![0].dungeonPulls = [
    { id: 7, name: "Pull 7", startTime: 61000, endTime: 121000 },
  ];
  await mockWcl(desktop, dungeon);
  await load(
    page,
    "https://cn.warcraftlogs.com/reports/dungeon?fight=last&pull=7",
  );
  await page.getByLabel("时间轴导出范围").selectOption("pull-7");
  await expect(page.getByLabel("时间轴可见范围")).toHaveText("00:00 – 01:00");
  const pullEvent = page.getByRole("button", {
    name: /裂解 00:05.000 施法/,
    exact: true,
  });
  await expect(pullEvent).toBeVisible();
  await expect(page.getByLabel("Note 预览", { exact: true })).toHaveValue("");
  await page
    .locator(".timeline-row")
    .filter({ has: pullEvent })
    .getByRole("checkbox")
    .check();
  await expect(page.getByLabel("Note 预览", { exact: true })).toHaveValue(
    /time:00:05/,
  );
});

test("时间轴光环跨阶段延续、Source 过滤和最小窗口详情及导出可见", async ({
  appPage: page,
  desktop,
}, info) => {
  await mockEventData(desktop, {
    "Buffs:Friendlies": [
      {
        type: "applybuff",
        timestamp: 41000,
        abilityGameID: 200,
        sourceID: 20,
        targetID: 20,
      },
      {
        type: "removebuff",
        timestamp: 81000,
        abilityGameID: 200,
        sourceID: 20,
        targetID: 20,
      },
      {
        type: "applybuff",
        timestamp: 91000,
        abilityGameID: 200,
        sourceID: 30,
        sourceInstance: 1,
        targetID: 20,
      },
      {
        type: "removebuff",
        timestamp: 111000,
        abilityGameID: 200,
        sourceID: 30,
        sourceInstance: 1,
        targetID: 20,
      },
    ],
  });
  await load(page);
  await page.getByRole("tab", { name: "Buff", exact: true }).click();
  await page.getByRole("button", { name: "队友", exact: true }).click();
  await page.locator(".skill").getByRole("checkbox").check();
  await page.getByRole("button", { name: "时间轴视图", exact: true }).click();
  await page.getByLabel("时间轴导出范围").selectOption("phase-2");
  await expect(page.locator(".timeline-aura")).toHaveCount(2);
  await page
    .locator('.timeline-row[data-type="Buffs"] .timeline-skill-label')
    .click();
  await expect(
    page.getByRole("checkbox", {
      name: "导出事件 玩家法师 时间扭曲 00:40.000 Buff",
      exact: true,
    }),
  ).toBeEnabled();
  await expect(page.getByLabel("Note 预览", { exact: true })).toHaveValue(
    /time:00:40/,
  );
  await page
    .getByRole("button", {
      name: "玩家法师 时间扭曲 01:30.000 Buff",
      exact: true,
    })
    .click();
  await expect(page.getByLabel("事件详情", { exact: true })).toContainText(
    "水元素 1",
  );
  await expect(
    page.getByRole("columnheader", {
      name: "获得时间 – 移除时间",
      exact: true,
    }),
  ).toBeVisible();
  await desktop.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setSize(960, 720),
  );
  await page.getByRole("button", { name: "定位 Note", exact: true }).click();
  for (const selector of [".timeline-panel", ".timeline-inspector", ".preview"])
    await expect(page.locator(selector)).toBeInViewport({ ratio: 1 });
  await expect(
    page.getByRole("button", { name: "复制笔记", exact: true }),
  ).toBeInViewport({ ratio: 1 });
  expect(
    await page.evaluate(
      () =>
        document.documentElement.scrollWidth <= innerWidth &&
        document.documentElement.scrollHeight <= innerHeight,
    ),
  ).toBe(true);
  await page.screenshot({
    path: info.outputPath("timeline-minimum-window.png"),
    fullPage: true,
  });
  await page.getByRole("button", { name: "图表视图", exact: true }).click();
  await page.getByLabel("Source列表", { exact: true }).click();
  await page.getByRole("menuitem", { name: "玩家法师", exact: true }).click();
  await expect(page.getByLabel("Note 预览", { exact: true })).toHaveValue(
    /time:00:40/,
  );
  await page.getByRole("button", { name: "时间轴视图", exact: true }).click();
  await expect(
    page.locator('.timeline-row[data-type="Buffs"] .timeline-marker'),
  ).toHaveCount(1);
  await expect(
    page.locator('.timeline-row[data-type="Buffs"]').getByRole("checkbox"),
  ).toBeEnabled();
});

test("时间轴空状态、密集日志和同毫秒事件独立选择", async ({
  appPage: page,
  desktop,
}, info) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.getByRole("button", { name: "时间轴视图", exact: true }).click();
  await expect(
    page.getByText("加载报告并选择战斗后查看时间轴。"),
  ).toBeVisible();
  const fixture = structuredClone(report);
  fixture.fights![0].enemyNPCs = [{ id: 10, instanceCount: 1 }];
  fixture.masterData!.abilities = Array.from({ length: 60 }, (_, index) => ({
    gameID: 2000 + index,
    name: `密集技能${index + 1}`,
  }));
  const casts: RawEvent[] = fixture.masterData!.abilities.flatMap((ability) =>
    Array.from({ length: 12 }, (_, index) => ({
      type: "cast",
      timestamp: 5000 + index * 9000,
      abilityGameID: ability.gameID,
      sourceID: 10,
      sourceInstance: 1,
    })),
  );
  casts.push({ ...casts[0] });
  await mockWcl(desktop, fixture);
  await mockEventData(desktop, { "Casts:Enemies": casts });
  await load(page);
  await page.getByRole("button", { name: "敌对", exact: true }).click();
  await expect(page.locator(".timeline-row")).toHaveCount(60);
  await timelineWindow(page, "full");
  await expect(page.locator(".timeline-marker")).toHaveCount(720);
  await expect(page.locator(".timeline-cluster-count")).toHaveText("2");
  expect(
    await page
      .locator(".timeline-canvas")
      .evaluate((element) => element.scrollHeight > element.clientHeight),
  ).toBe(true);
  await page
    .getByRole("checkbox", {
      name: "导出整行 首领 密集技能1 施法",
      exact: true,
    })
    .check();
  await page
    .getByRole("button", { name: "展开重叠事件 首领 密集技能1", exact: true })
    .click();
  await expect(page.locator(".timeline-marker")).toHaveCount(721);
  await page
    .getByRole("button", { name: "首领 密集技能1 00:04.000 施法", exact: true })
    .last()
    .click();
  const repeated = page.getByRole("checkbox", {
    name: "导出事件 首领 密集技能1 00:04.000 施法",
    exact: true,
  });
  await expect(repeated).toHaveCount(2);
  await repeated.first().uncheck();
  await expect(repeated.last()).toBeChecked();
  await expect(page.getByLabel("Note 预览", { exact: true })).toHaveValue(
    /\{time:00:04\.0\} 密集技能1\(1\)/,
  );
  await repeated.last().uncheck();
  await expect(page.getByLabel("Note 预览", { exact: true })).not.toHaveValue(
    /time:00:04/,
  );
  await page.screenshot({
    path: info.outputPath("timeline-dense.png"),
    fullPage: true,
  });
  expect(errors).toEqual([]);
});

test("actor 下方阵营筛选、共用显示切换、简洁技能行与敌对优先分组", async ({
  appPage: page,
  desktop,
}, info) => {
  await loadTimelineFixture(page, desktop);
  await expect(page.locator(".timeline-row")).toHaveCount(6);
  const controls = page.getByLabel("日志筛选与视图", { exact: true });
  await expect(controls.locator(":scope > .analysis-row")).toHaveCount(3);
  await expect(page.locator("header .view-toggle")).toHaveCount(0);
  const listButton = page.getByRole("button", {
    name: "图表视图",
    exact: true,
  });
  const timelineButton = page.getByRole("button", {
    name: "时间轴视图",
    exact: true,
  });
  await expect(listButton).toHaveText("图表");
  await expect(timelineButton).toHaveText("时间轴");
  await expect(
    page.getByRole("button", { name: "全部", exact: true }),
  ).toHaveCSS("color", "rgb(240, 245, 249)");
  await expect(
    page.getByRole("button", { name: "敌对", exact: true }),
  ).toHaveCSS("color", "rgb(155, 175, 191)");
  await expect(page.locator(".timeline-skill-label small")).toHaveCount(0);
  expect(
    await page
      .locator(".timeline-skill-label")
      .evaluateAll((elements) =>
        elements.every(
          (element) =>
            element.textContent?.trim() ===
            element.querySelector("strong")?.textContent?.trim(),
        ),
      ),
  ).toBe(true);
  const initial = await page
    .getByLabel("Note 预览", { exact: true })
    .inputValue();
  async function assertEnemyFirst() {
    const sides = await page
      .locator(".timeline-section")
      .evaluateAll((elements) =>
        elements.map((element) => element.getAttribute("data-side")),
      );
    const firstFriendly = sides.indexOf("friendly");
    expect(firstFriendly).toBeGreaterThan(0);
    expect(
      sides.slice(firstFriendly).every((side) => side === "friendly"),
    ).toBe(true);
  }
  await assertEnemyFirst();
  await expect(page.getByRole("button", { name: /^置顶 / })).toHaveCount(0);
  await expect(
    controls.locator(".analysis-events .event-display-toggle"),
  ).toHaveCount(1);
  await expect(
    page.locator(".timeline-tools .event-display-toggle"),
  ).toHaveCount(0);
  await expect(page.locator(".timeline-section").first()).toHaveAttribute(
    "data-side",
    "enemy",
  );
  await expect(page.getByLabel("Note 预览", { exact: true })).toHaveValue(
    initial,
  );
  for (const size of [
    [1440, 900],
    [960, 720],
  ]) {
    await desktop.evaluate(
      ({ BrowserWindow }, size) =>
        BrowserWindow.getAllWindows()[0].setSize(size[0], size[1]),
      size,
    );
    const actor = (await page
      .getByLabel("角色列表", { exact: true })
      .boundingBox())!;
    const all = (await page
      .getByRole("button", { name: "全部", exact: true })
      .boundingBox())!;
    const sides = (await controls
      .getByRole("group", { name: "阵营", exact: true })
      .boundingBox())!;
    const friendly = (await page
      .getByRole("button", { name: "队友", exact: true })
      .boundingBox())!;
    const enemy = (await page
      .getByRole("button", { name: "敌对", exact: true })
      .boundingBox())!;
    const view = (await timelineButton.boundingBox())!;
    const actorControls = (await controls
      .locator(".analysis-actor")
      .boundingBox())!;
    const eventTabs = (await page
      .getByRole("tablist", { name: "事件类型", exact: true })
      .boundingBox())!;
    const target = (await page
      .getByLabel("Target列表", { exact: true })
      .boundingBox())!;
    expect(friendly.y).toBeGreaterThanOrEqual(actor.y + actor.height);
    expect(Math.abs(sides.x - actor.x)).toBeLessThan(3);
    expect(all.x).toBeLessThan(friendly.x);
    expect(friendly.x).toBeLessThan(enemy.x);
    expect(actor.x + actor.width).toBeLessThan(view.x);
    expect(
      Math.abs(
        actorControls.y + actorControls.height / 2 - view.y - view.height / 2,
      ),
    ).toBeLessThan(2);
    expect(eventTabs.y).toBeGreaterThanOrEqual(friendly.y + friendly.height);
    expect(target.y).toBeGreaterThanOrEqual(eventTabs.y + eventTabs.height);
    await expect(controls).toBeInViewport({ ratio: 1 });
    expect(
      await page.evaluate(
        () =>
          document.documentElement.scrollWidth <= innerWidth &&
          document.documentElement.scrollHeight <= innerHeight,
      ),
    ).toBe(true);
    await page.screenshot({
      path: info.outputPath(`filters-timeline-${size[0]}.png`),
      fullPage: true,
    });
  }
  await page.getByRole("button", { name: "队友", exact: true }).click();
  await page.getByLabel("角色列表", { exact: true }).click();
  await page.getByRole("menuitem", { name: "示例圣骑士", exact: true }).click();
  await page.getByRole("tab", { name: "Buff", exact: true }).click();
  await expect(page.getByLabel("Source列表", { exact: true })).toBeVisible();
  await page.getByLabel("Source列表", { exact: true }).click();
  await page.getByRole("menuitem", { name: "示例圣骑士", exact: true }).click();
  await expect(page.getByLabel("角色列表", { exact: true })).toHaveText(
    "示例圣骑士",
  );
  await listButton.click();
  await expect(controls).toBeVisible();
  await expect(page.getByLabel("Source列表", { exact: true })).toHaveText(
    "示例圣骑士",
  );
  await expect(page.locator(".skill")).toHaveCount(2);
  await expect(page.locator(".skill")).toContainText(["光环掌握", "光环掌握"]);
  await expect(
    page.getByRole("tab", { name: "Buff", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await page.screenshot({
    path: info.outputPath("filters-list-960.png"),
    fullPage: true,
  });
  await timelineButton.click();
  await expect(page.getByLabel("Source列表", { exact: true })).toHaveText(
    "示例圣骑士",
  );
  await expect(page.locator('.timeline-row[data-type="Casts"]')).toHaveCount(0);
  await expect(page.locator('.timeline-row[data-side="enemy"]')).toHaveCount(0);
});

test("时间轴严格遵守阵营和关联筛选，隐藏不影响 Note，重新导入恢复默认", async ({
  appPage: page,
  desktop,
}, info) => {
  await mockEventData(desktop, {
    "Casts:Enemies": enemies.map((event, index) => ({
      ...event,
      targetID: index === 0 ? 20 : 30,
      targetInstance: index === 0 ? undefined : 1,
    })),
    "Casts:Friendlies": [
      { ...friendlies[0], targetID: 10 },
      { ...friendlies[0], timestamp: 78000, targetID: 11 },
    ],
    "Buffs:Friendlies": [
      {
        type: "applybuff",
        timestamp: 71000,
        abilityGameID: 200,
        sourceID: 20,
        targetID: 20,
      },
    ],
  });
  await load(page);
  await firstCastActor(page, 1, "队友");
  await page.locator(".skill").getByRole("checkbox").check();
  await page.getByRole("button", { name: "时间轴视图", exact: true }).click();
  const enemyRows = page.locator(
    '.timeline-row[data-side="enemy"][data-type="Casts"]',
  );
  const enemyMarkers = enemyRows.locator(".timeline-marker");
  await timelineWindow(page, "full");
  await expect(enemyMarkers).toHaveCount(0);
  await expect(page.locator(".timeline-region-toggle")).toHaveCount(0);
  await page.getByRole("button", { name: "全部", exact: true }).click();
  await expect(enemyMarkers).toHaveCount(3);
  await expect(page.locator('.timeline-row[data-side="friendly"]')).toHaveCount(
    1,
  );
  await expect(enemyRows.first().getByRole("checkbox")).not.toBeChecked();
  await page.getByRole("button", { name: "敌对", exact: true }).click();
  await expect(page.locator('.timeline-row[data-side="friendly"]')).toHaveCount(
    0,
  );
  await page.getByRole("button", { name: "队友", exact: true }).click();
  await expect(enemyMarkers).toHaveCount(0);
  await page.getByLabel("Target列表", { exact: true }).click();
  await page
    .getByRole("menuitem", { name: "首领", exact: true })
    .filter({ hasText: "900101" })
    .click();
  await expect(enemyMarkers).toHaveCount(0);
  await expect(page.getByLabel("Note 预览", { exact: true })).toHaveValue(
    /time:01:17/,
  );
  await expect(page.getByLabel("Note 预览", { exact: true })).not.toHaveValue(
    /time:00:17/,
  );
  await desktop.evaluate(() => {
    const original = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      if (url === "https://cn.warcraftlogs.com/api/v2/client") {
        const body = JSON.parse(init!.body as string);
        if (
          body.query.includes("query GetFightAbilityEvents") &&
          body.variables.dataType === "Buffs" &&
          body.variables.hostilityType === "Friendlies"
        ) {
          await new Promise<void>((done) => {
            (
              globalThis as typeof globalThis & { releaseBuff: () => void }
            ).releaseBuff = done;
          });
          globalThis.fetch = original;
        }
      }
      return original(url, init);
    };
  });
  await page.getByRole("tab", { name: "Buff", exact: true }).click();
  await expect(
    page.getByText("正在加载其他技能事件…", { exact: true }),
  ).toBeVisible();
  await expect(enemyRows).toHaveCount(0);
  await expect
    .poll(() =>
      desktop.evaluate(
        () =>
          typeof (
            globalThis as typeof globalThis & { releaseBuff?: () => void }
          ).releaseBuff,
      ),
    )
    .toBe("function");
  await desktop.evaluate(() =>
    (
      globalThis as typeof globalThis & { releaseBuff: () => void }
    ).releaseBuff(),
  );
  await page.getByLabel("Source列表", { exact: true }).click();
  await page.getByRole("menuitem", { name: "玩家法师", exact: true }).click();
  await expect(enemyRows).toHaveCount(0);
  await expect(page.locator('.timeline-row[data-type="Buffs"]')).toHaveCount(1);
  await page.getByRole("tab", { name: "Debuff", exact: true }).click();
  await expect(enemyRows).toHaveCount(0);
  await expect(page.locator('.timeline-row[data-type="Buffs"]')).toHaveCount(0);
  await page.getByRole("button", { name: "敌对", exact: true }).click();
  await page.getByRole("tab", { name: "Buff", exact: true }).click();
  const enemyBuff = page.locator(
    '.timeline-row[data-side="enemy"][data-type="Buffs"]',
  );
  await expect(enemyBuff).toHaveCount(1);
  const beforeHide = await page
    .getByLabel("Note 预览", { exact: true })
    .inputValue();
  await enemyBuff.getByRole("button", { name: /^隐藏 / }).click();
  await expect(enemyBuff).toHaveCount(0);
  await expect(enemyRows).toHaveCount(0);
  await expect(page.getByLabel("Note 预览", { exact: true })).toHaveValue(
    beforeHide,
  );
  await page.getByRole("button", { name: /已隐藏 \(1\)/ }).click();
  await expect(enemyBuff).toHaveCount(1);
  await page.screenshot({
    path: info.outputPath("strict-side-filters.png"),
    fullPage: true,
  });
  await page.getByRole("tab", { name: "施法", exact: true }).click();
  await page.getByLabel("Target列表", { exact: true }).click();
  await page.getByRole("menuitem", { name: "玩家法师", exact: true }).click();
  await expect(enemyMarkers).toHaveCount(1);
  await enemyRows.first().getByRole("checkbox").check();
  await expect(enemyMarkers.and(page.locator(".included"))).toHaveCount(1);
  await expect(enemyMarkers.and(page.locator(".available"))).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: /裂解 01:05.000 施法/ }),
  ).toHaveCount(0);
  await expect(page.getByLabel("Note 预览", { exact: true })).toHaveValue(
    /time:00:35.*裂解/,
  );
  await expect(page.getByLabel("Note 预览", { exact: true })).not.toHaveValue(
    /time:01:05|time:01:35/,
  );
  await page
    .getByRole("button", { name: "清除Target筛选", exact: true })
    .click();
  await expect(enemyMarkers).toHaveCount(3);
  await expect(enemyRows.nth(1).getByRole("checkbox")).toBeEnabled();
  await load(page, "https://cn.warcraftlogs.com/reports/reset?fight=last");
  await expect(page.getByLabel("角色列表", { exact: true })).toHaveText(
    "所有队友",
  );
  await expect(
    page.getByRole("button", { name: "队友", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(
    page.getByRole("tab", { name: "施法", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(page.getByLabel("Note 预览", { exact: true })).toHaveValue("");
  await expect(enemyMarkers).toHaveCount(0);
  await expect(page.locator(".timeline-region-toggle")).toHaveCount(0);
});

test("全部阵营与 Note 筛选跨视图同步，单阵营隐藏分类，隐藏和筛选保留逐次勾选", async ({
  appPage: page,
  desktop,
}, info) => {
  await loadTimelineFixture(page, desktop, false, false);
  const sides = page.getByRole("group", { name: "阵营", exact: true });
  await expect(sides.getByRole("button")).toHaveText(["全部", "队友", "敌对"]);
  await expect(
    sides.getByRole("button", { name: "队友", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".timeline-region-toggle")).toHaveCount(0);
  await expect(page.locator("button.timeline-section-toggle")).toHaveCount(3);
  await expect(page.locator(".timeline-section-toggle")).toHaveCount(3);
  const display = page.getByRole("group", { name: "显示范围", exact: true });
  await expect(display.getByRole("button")).toHaveText([
    "全部事件",
    "已加入 Note",
  ]);
  await expect(page.getByRole("button", { name: /^置顶 / })).toHaveCount(0);
  const priest = page
    .locator('.timeline-row[data-side="friendly"]')
    .filter({ hasText: "真言术：障" });
  await priest.getByRole("checkbox").check();
  await timelineWindow(page, "full");
  await priest
    .getByRole("button", {
      name: "示例牧师 真言术：障 01:08.000 施法",
      exact: true,
    })
    .click();
  await page
    .getByRole("checkbox", {
      name: "导出事件 示例牧师 真言术：障 01:08.000 施法",
      exact: true,
    })
    .uncheck();
  const preview = page.getByLabel("Note 预览", { exact: true });
  await expect(preview).not.toHaveValue(/time:01:08/);
  await expect(preview).toHaveValue(/time:03:08/);
  const note = await preview.inputValue();
  await display
    .getByRole("button", { name: "已加入 Note", exact: true })
    .click();
  await expect(page.locator(".timeline-row")).toHaveCount(1);
  await expect(page.locator(".timeline-marker")).toHaveCount(1);
  await page
    .getByRole("button", { name: "隐藏 示例牧师 真言术：障", exact: true })
    .click();
  await expect(page.locator(".timeline-row")).toHaveCount(0);
  await expect(preview).toHaveValue(note);
  const displayBox = (await display.boundingBox())!;
  await page.getByRole("button", { name: "图表视图", exact: true }).click();
  await expect(
    display.getByRole("button", { name: "已加入 Note", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".actor-row")).toHaveCount(1);
  await expect(page.locator(".actor-row .skill-bar")).toHaveCount(1);
  expect((await display.boundingBox())!.y).toBeCloseTo(displayBox.y, 0);
  await page.locator(".actor-row").click();
  await expect(page.locator(".skill")).toHaveCount(1);
  await expect(page.locator(".skill .skill-bar")).toHaveCount(1);
  await expect(page.locator(".skill .skill-stat-value")).toHaveText("1");
  await expect(page.locator(".skill input")).toHaveJSProperty(
    "indeterminate",
    true,
  );
  await page.getByRole("button", { name: "时间轴视图", exact: true }).click();
  await page.getByRole("button", { name: /已隐藏 \(1\)/ }).click();
  await expect(page.locator(".timeline-marker")).toHaveCount(1);
  await expect(preview).toHaveValue(note);
  await sides.getByRole("button", { name: "全部", exact: true }).click();
  await display.getByRole("button", { name: "全部事件", exact: true }).click();
  await expect(page.locator(".timeline-row")).toHaveCount(6);
  await expect(page.locator(".timeline-region-toggle")).toHaveCount(2);
  await page
    .getByRole("button", { name: "折叠 队友施法", exact: true })
    .click();
  await expect(page.locator(".timeline-row")).toHaveCount(2);
  await sides.getByRole("button", { name: "队友", exact: true }).click();
  await expect(page.locator(".timeline-row")).toHaveCount(4);
  await expect(page.locator(".timeline-region-toggle")).toHaveCount(0);
  await expect(page.locator("button.timeline-section-toggle")).toHaveCount(3);
  await sides.getByRole("button", { name: "敌对", exact: true }).click();
  await expect(page.locator(".timeline-row")).toHaveCount(2);
  await expect(page.locator('.timeline-row[data-side="friendly"]')).toHaveCount(
    0,
  );
  await expect(page.locator(".timeline-region-toggle")).toHaveCount(0);
  await expect(preview).toHaveValue(note);
  await sides.getByRole("button", { name: "全部", exact: true }).click();
  await expect(page.locator(".timeline-row")).toHaveCount(2);
  await page
    .getByRole("button", { name: "展开 队友施法", exact: true })
    .click();
  await expect(page.locator(".timeline-row")).toHaveCount(6);
  for (const size of [
    [1440, 900],
    [960, 720],
  ]) {
    await desktop.evaluate(
      ({ BrowserWindow }, size) =>
        BrowserWindow.getAllWindows()[0].setSize(size[0], size[1]),
      size,
    );
    await expect(display).toBeInViewport({ ratio: 1 });
    await page.screenshot({
      path: info.outputPath(`timeline-shared-filters-${size[0]}.png`),
      fullPage: true,
      animations: "disabled",
    });
  }
  await sides.getByRole("button", { name: "队友", exact: true }).click();
  await page.mouse.move(0, 0);
  await page.screenshot({
    path: info.outputPath("timeline-friendly-960.png"),
    fullPage: true,
    animations: "disabled",
  });
  await page.getByRole("button", { name: "图表视图", exact: true }).click();
  await expect(page.locator(".actor-row")).toHaveCount(3);
  await page.screenshot({
    path: info.outputPath("chart-shared-filters-960.png"),
    fullPage: true,
    animations: "disabled",
  });
});

test("阶段等宽下拉完整显示长名称与重复阶段，选择后筛选并限制时间轴范围", async ({
  appPage: page,
  desktop,
}, info) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const fixture = structuredClone(report);
  fixture.fights![0].phaseTransitions = [
    { id: 1, startTime: 1000 },
    { id: 2, startTime: 61000 },
    { id: 1, startTime: 115000 },
    { id: 3, startTime: 120000 },
  ];
  fixture.phases![0].phases = [
    { id: 1, name: "第一阶段：守卫苏醒并召唤潮汐之力的完整阶段名称" },
    { id: 2, name: "第二阶段：深海屏障破碎后的团队转场与增援" },
    { id: 3, name: "终末阶段：最后一秒的全团防御与治疗爆发" },
  ];
  await mockWcl(desktop, fixture);
  await mockEventData(desktop, {
    "Casts:Enemies": [
      ...enemies,
      { ...enemies[0], timestamp: 116000 },
      { ...enemies[0], timestamp: 120500 },
    ],
  });
  await load(page);
  await expect(page.locator(".actor-row")).toHaveCount(1);
  await expect(page.locator(".abilities h2, .timeline-panel h2")).toHaveCount(
    0,
  );
  await page.getByRole("button", { name: "时间轴视图", exact: true }).click();
  await page.getByRole("button", { name: "敌对", exact: true }).click();
  await expect(
    page.locator(".timeline-phase-navigation, .timeline-phase-label"),
  ).toHaveCount(0);
  const trigger = page.getByRole("button", { name: "选择阶段", exact: true });
  const list = page.locator(".segment-list");
  const names = [
    "全部阶段",
    fixture.phases![0].phases[0].name,
    fixture.phases![0].phases[1].name,
    fixture.phases![0].phases[0].name + "（第 2 次）",
    fixture.phases![0].phases[2].name,
  ];
  for (const [width, height] of [
    [1440, 900],
    [960, 720],
  ]) {
    await desktop.evaluate(
      ({ BrowserWindow }, size) =>
        BrowserWindow.getAllWindows()[0].setSize(size[0], size[1]),
      [width, height],
    );
    const contentSize = await desktop.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].getContentSize(),
    );
    await expect
      .poll(() => page.evaluate(() => [innerWidth, innerHeight]))
      .toEqual(contentSize);
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    await trigger.click();
    await expect(list).toBeVisible();
    await expect(list.locator(".segment > span")).toHaveText(names);
    const buttonBox = (await trigger.boundingBox())!;
    const listBox = (await list.boundingBox())!;
    expect(Math.abs(buttonBox.width - listBox.width)).toBeLessThan(1);
    expect(Math.abs(buttonBox.x - listBox.x)).toBeLessThan(1);
    for (const item of await list.locator(".segment").all()) {
      await item.scrollIntoViewIfNeeded();
      await expect(item).toBeInViewport({ ratio: 0.99 });
      expect(
        await item.evaluate(
          (element) =>
            element.scrollWidth <= element.clientWidth + 1 &&
            element.scrollHeight <= element.clientHeight + 1,
        ),
      ).toBe(true);
    }
    await page.screenshot({
      path: info.outputPath("phase-dropdown-" + width + ".png"),
      fullPage: true,
    });
    await page.keyboard.press("Escape");
    await expect(trigger).toBeFocused();
  }
  await chooseSegment(page, /第 2 次/);
  await expect(page.getByLabel("时间轴可见范围")).toHaveText("01:54 – 01:59");
  await page.locator(".timeline-canvas").focus();
  await page.keyboard.press("-");
  await expect(page.getByLabel("时间轴可见范围")).toHaveText("01:54 – 01:59");
  await chooseSegment(page, /终末阶段/);
  await expect(page.getByLabel("时间轴可见范围")).toHaveText("01:59 – 02:00");
  await chooseSegment(page, /^全部阶段/);
  await timelineWindow(page, "full");
  await page.locator(".timeline-canvas").focus();
  await page.keyboard.press("+");
  await expect(page.getByLabel("时间轴可见范围")).toHaveText("00:30 – 01:30");
  await expect(
    page.locator(".timeline-scale > .timeline-phase-line"),
  ).toHaveCount(1);
  expect(errors).toEqual([]);
});

test("玩家专精图标贯穿排行、actor、Source 与时间轴，下载失败回退职业", async ({
  appPage: page,
  desktop,
}, info) => {
  const fixture = structuredClone(report);
  fixture.playerDetails = {
    data: {
      playerDetails: {
        dps: [
          { id: 20, icon: "Mage-Frost", specs: [{ spec: "Frost", count: 1 }] },
        ],
        tanks: [],
        healers: [],
      },
    },
  };
  await mockWcl(desktop, fixture);
  await load(page);
  const image = page.locator(".actor-row .actor-icon img");
  await expect(image).toHaveAttribute(
    "src",
    "app://wcl2note/icons/icons/Mage-Frost.jpg",
  );
  await expect
    .poll(() => image.evaluate((img: HTMLImageElement) => img.naturalWidth))
    .toBe(1);
  await page.locator(".actor-row").click();
  await expect(
    page.getByLabel("角色列表", { exact: true }).locator(".actor-icon img"),
  ).toHaveAttribute("src", /Mage-Frost\.jpg$/);
  await page.getByRole("button", { name: "时间轴视图", exact: true }).click();
  await expect(
    page.locator('.timeline-section[data-side="friendly"] .actor-icon img'),
  ).toHaveAttribute("src", /Mage-Frost\.jpg$/);
  await page.getByRole("tab", { name: "Buff", exact: true }).click();
  await page.getByLabel("Source列表", { exact: true }).click();
  await expect(
    page
      .getByRole("menuitem", { name: "玩家法师", exact: true })
      .locator(".actor-icon img"),
  ).toHaveAttribute("src", /Mage-Frost\.jpg$/);
  await page.keyboard.press("Escape");
  await page.screenshot({
    path: info.outputPath("player-spec-icons.png"),
    fullPage: true,
  });
  fixture.playerDetails = {
    data: {
      playerDetails: {
        dps: [
          { id: 20, icon: "Mage-Fire", specs: [{ spec: "Fire", count: 1 }] },
        ],
      },
    },
  };
  await mockWcl(desktop, fixture);
  await desktop.evaluate((electron) => {
    const original = electron.net.fetch.bind(electron.net);
    electron.net.fetch = async (url, init) =>
      String(url).endsWith("/Mage-Fire.jpg")
        ? new Response(null, { status: 403 })
        : original(url, init);
  });
  await load(
    page,
    "https://cn.warcraftlogs.com/reports/specfallback?fight=last",
  );
  await page.getByRole("button", { name: "图表视图", exact: true }).click();
  await expect(page.locator(".actor-row .actor-icon img")).toHaveAttribute(
    "src",
    "app://wcl2note/icons/icons/Mage.jpg",
  );
  await expect(page.locator('[role="alert"]')).toHaveCount(0);
});

test("刻度尺框选与画布平移按区域分工，框选覆盖可见高度，取消与导航不改变导出", async ({
  appPage: page,
  desktop,
}, info) => {
  await loadTimelineFixture(page, desktop);
  await expect(page.getByLabel("Note 预览", { exact: true })).toHaveValue(
    /time:00:27\.0/,
  );
  const initial = await page
    .getByLabel("Note 预览", { exact: true })
    .inputValue();
  await expect(page.locator(".timeline-region")).toHaveCount(2);
  await expect(page.locator(".timeline-region").first()).toHaveAttribute(
    "data-side",
    "enemy",
  );
  await page
    .getByRole("button", { name: "折叠 敌对施法", exact: true })
    .click();
  await expect(page.locator('.timeline-row[data-side="enemy"]')).toHaveCount(0);
  await expect(page.locator('.timeline-row[data-side="friendly"]')).toHaveCount(
    4,
  );
  await page
    .getByRole("button", { name: "折叠 队友施法", exact: true })
    .click();
  await expect(page.locator(".timeline-row")).toHaveCount(0);
  await page
    .getByRole("button", { name: "展开 敌对施法", exact: true })
    .click();
  await expect(page.locator(".timeline-row")).toHaveCount(2);
  await page
    .getByRole("button", { name: "展开 队友施法", exact: true })
    .click();
  await expect(page.getByLabel("Note 预览", { exact: true })).toHaveValue(
    initial,
  );
  for (const size of [
    [1440, 900],
    [960, 720],
  ]) {
    await desktop.evaluate(
      ({ BrowserWindow }, size) =>
        BrowserWindow.getAllWindows()[0].setSize(size[0], size[1]),
      size,
    );
    const contentSize = await desktop.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].getContentSize(),
    );
    await expect
      .poll(() => page.evaluate(() => [innerWidth, innerHeight]))
      .toEqual(contentSize);
    const start = page.getByRole("slider", { name: "时间轴范围起点" });
    const end = page.getByRole("slider", { name: "时间轴范围终点" });
    for (const origin of ["ruler", "row"]) {
      await timelineWindow(page, "first");
      const lane =
        origin === "ruler"
          ? page.locator(".timeline-scale")
          : page.locator(".timeline-row .timeline-lane").last();
      await lane.scrollIntoViewIfNeeded();
      // 原生窗口缩放和滚动完成后再读取拖选坐标，避免跨帧沿用旧位置。
      await page.evaluate(
        () =>
          new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
          ),
      );
      const box = (await lane.boundingBox())!;
      const y = origin === "ruler" ? box.y + box.height - 8 : box.y + 2;
      await expect(lane).toHaveCSS(
        "cursor",
        origin === "ruler" ? "crosshair" : "grab",
      );
      await page.mouse.move(
        box.x + box.width * (origin === "ruler" ? 0.2 : 0.7),
        y,
      );
      await page.mouse.down();
      await page.mouse.move(
        box.x + box.width * (origin === "ruler" ? 0.7 : 0.45),
        y,
        { steps: 6 },
      );
      const overlay = page.locator(".timeline-zoom-selection");
      if (origin === "row") {
        await expect(overlay).toHaveCount(0);
        await expect(lane).toHaveCSS("cursor", "grabbing");
        await page.mouse.up();
        await expect(lane).toHaveCSS("cursor", "grab");
        const from = Number(await start.getAttribute("aria-valuenow"));
        const to = Number(await end.getAttribute("aria-valuenow"));
        expect(from).toBeGreaterThan(29000);
        expect(from).toBeLessThan(31000);
        expect(to - from).toBe(120000);
        continue;
      }
      await expect(overlay).toHaveCount(1);
      const selection = (await overlay.boundingBox())!,
        area = (await page.locator(".timeline-viewport").boundingBox())!;
      expect(Math.abs(selection.y - area.y)).toBeLessThan(1);
      expect(Math.abs(selection.height - area.height)).toBeLessThan(1);
      expect(Math.abs(selection.width - box.width * 0.5)).toBeLessThan(3);
      if (size[0] === 960)
        await page.screenshot({
          path: info.outputPath("timeline-full-height-selection.png"),
          fullPage: true,
        });
      await page.keyboard.press("Escape");
      await page.mouse.up();
      await expect(overlay).toHaveCount(0);
      await expect(page.getByLabel("时间轴可见范围")).toHaveText(
        "00:00 – 02:00",
      );
    }
    if (size[0] === 1440) {
      // 折叠技能后，行下方的画布留白也能直接平移。
      await timelineWindow(page, "first");
      for (const name of ["折叠 敌对施法", "折叠 队友施法"])
        await page.getByRole("button", { name, exact: true }).click();
      await page.evaluate(
        () =>
          new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
          ),
      );
      const canvasArea = page.locator(".timeline-canvas");
      const canvas = (await page.locator(".timeline-canvas").boundingBox())!;
      const scale = (await page.locator(".timeline-scale").boundingBox())!;
      const y = canvas.y + canvas.height - 12;
      await page.mouse.move(scale.x + scale.width * 0.7, y);
      await page.mouse.down();
      await expect(canvasArea).toHaveAttribute("data-dragging", "pan");
      await page.mouse.move(scale.x + scale.width * 0.45, y, { steps: 6 });
      await page.mouse.up();
      await expect(canvasArea).not.toHaveAttribute("data-dragging", "pan");
      await expect
        .poll(async () => Number(await start.getAttribute("aria-valuenow")))
        .toBeGreaterThan(29000);
      const from = Number(await start.getAttribute("aria-valuenow"));
      const to = Number(await end.getAttribute("aria-valuenow"));
      expect(from).toBeGreaterThan(29000);
      expect(from).toBeLessThan(31000);
      expect(to - from).toBe(120000);
      for (const name of ["展开 敌对施法", "展开 队友施法"])
        await page.getByRole("button", { name, exact: true }).click();
    }
  }
  await expect(page.getByLabel("Note 预览", { exact: true })).toHaveValue(
    initial,
  );
  await page.getByRole("tab", { name: "Buff", exact: true }).click();
  await page.getByRole("button", { name: "队友", exact: true }).click();
  await expect(page.locator(".timeline-region")).toHaveCount(1);
  await expect(page.locator('.timeline-row[data-type="Casts"]')).toHaveCount(0);
  await expect(page.locator('.timeline-row[data-side="friendly"]')).toHaveCount(
    1,
  );
  await selectFight(page, 0);
  await page.getByLabel("角色列表", { exact: true }).click();
  await page.getByRole("menuitem", { name: "示例圣骑士", exact: true }).click();
  await selectFight(page, 3);
  await expect(page.getByLabel("角色列表", { exact: true })).toContainText(
    "示例圣骑士",
  );
  await expect(page.locator('.timeline-row[data-side="friendly"]')).toHaveCount(
    0,
  );
  await selectFight(page, 0);
  await page.getByRole("button", { name: "敌对", exact: true }).click();
  await page.getByLabel("角色列表", { exact: true }).click();
  await page.getByRole("menuitem", { name: "潮汐守卫", exact: true }).hover();
  await page
    .getByRole("menuitem", { name: "潮汐守卫 #1", exact: true })
    .click();
  await selectFight(page, 1);
  await expect(page.getByLabel("角色列表", { exact: true })).toContainText(
    "潮汐守卫",
  );
  await expect(page.getByLabel("角色列表", { exact: true })).not.toContainText(
    "所有敌对",
  );
  await expect(page.locator('.timeline-row[data-side="enemy"]')).toHaveCount(2);
});

test("读条按真实起止与学派显示，条高等于图标，瞬发无读条，MRT 仍用完成时刻", async ({
  appPage: page,
  desktop,
}, info) => {
  const fixture = structuredClone(report);
  fixture.masterData!.abilities[0].type = "4";
  fixture.masterData!.abilities[1].type = "16";
  await mockWcl(desktop, fixture);
  await mockEventData(desktop, {
    "Casts:Friendlies": [
      { type: "begincast", timestamp: 18000, abilityGameID: 200, sourceID: 20 },
      {
        type: "cast",
        timestamp: 20000,
        abilityGameID: 200,
        sourceID: 20,
        targetID: 10,
      },
      {
        type: "cast",
        timestamp: 30000,
        abilityGameID: 200,
        sourceID: 20,
        targetID: 30,
      },
    ],
    "Casts:Enemies": [
      {
        type: "begincast",
        timestamp: 34000,
        abilityGameID: 100,
        sourceID: 10,
        sourceInstance: 1,
      },
      { ...enemies[0] },
      {
        type: "begincast",
        timestamp: 60000,
        abilityGameID: 100,
        sourceID: 10,
        sourceInstance: 2,
      },
      { ...enemies[1], timestamp: 63000 },
    ],
  });
  await load(page);
  await page.getByRole("button", { name: "时间轴视图", exact: true }).click();
  const friendly = page.locator('.timeline-row[data-side="friendly"]');
  await timelineWindow(page, "first");
  await page.getByRole("button", { name: "全部", exact: true }).click();
  await expect(page.locator(".timeline-cast")).toHaveCount(3);
  await expect(friendly.locator(".timeline-marker")).toHaveCount(2);
  const bar = friendly.locator(".timeline-cast");
  const icon = friendly.locator(".timeline-marker .game-icon").first();
  await expect(friendly.locator(".timeline-skill-label strong")).toHaveCSS(
    "color",
    "rgb(74, 128, 255)",
  );
  // Icons use Wowhead's native tooltip; the cast bar keeps its instant timing.
  const marker = friendly.locator(".timeline-marker").first();
  await marker.scrollIntoViewIfNeeded();
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  await marker.hover();
  const markerBox = (await marker.boundingBox())!;
  await page.mouse.move(markerBox.x + 9, markerBox.y + 10);
  await expect(officialTooltip(page)).toContainText("中文技能说明 200");
  expect(await marker.getAttribute("title")).toBeNull();
  await bar.hover({
    position: { x: (await bar.boundingBox())!.width - 2, y: 10 },
  });
  expect(await bar.evaluate((element) => element.matches(":hover"))).toBe(true);
  expect(await page.getByRole("tooltip").innerText()).toBe(
    "时间扭曲\n00:17.000 – 00:19.000",
  );
  await page.screenshot({
    path: info.outputPath("timeline-instant-tooltip.png"),
    fullPage: true,
  });
  await page.locator(".timeline-overview").click({ position: { x: 8, y: 8 } });
  await expect(page.getByRole("tooltip")).toHaveCount(0);
  expect((await bar.boundingBox())!.height).toBe(
    (await icon.boundingBox())!.height,
  );
  await expect(bar).toHaveCSS("border-top-color", "rgb(128, 255, 255)");
  await expect(
    page.locator('.timeline-row[data-side="enemy"] .timeline-cast').first(),
  ).toHaveCSS("border-top-color", "rgb(255, 128, 0)");
  const lane = (await friendly.locator(".timeline-lane").boundingBox())!;
  const interval = (await bar.boundingBox())!;
  expect(Math.abs(interval.x - lane.x - (lane.width * 17) / 60)).toBeLessThan(
    2,
  );
  expect(Math.abs(interval.width - (lane.width * 2) / 60)).toBeLessThan(2);
  await friendly.getByRole("checkbox").check();
  await friendly
    .getByRole("button", {
      name: "玩家法师 时间扭曲 00:19.000 施法",
      exact: true,
    })
    .click();
  await expect(page.getByLabel("事件详情", { exact: true })).toContainText(
    "00:17.000 – 00:19.000",
  );
  const actorName = page.locator(
    '.timeline-section[data-side="friendly"] .timeline-section-toggle > .timeline-actor-name',
  );
  await expect(actorName).toHaveText("玩家法师");
  await expect(actorName).toHaveCSS("color", "rgb(105, 204, 240)");
  await expect(
    page
      .locator('.timeline-section[data-side="enemy"] .timeline-section-toggle')
      .first(),
  ).toHaveText(/首领 1/);
  await expect(
    page
      .locator('.timeline-section[data-side="enemy"] .timeline-section-toggle')
      .first(),
  ).not.toContainText("敌对施法");
  const details = page.getByLabel("该行全部事件", { exact: true });
  await expect(details.getByRole("columnheader")).toHaveText([
    "",
    "开始时间 – 完成时间",
    "来源",
    "目标",
  ]);
  await expect(details.getByRole("columnheader").nth(1)).toHaveCSS(
    "text-align",
    "center",
  );
  const entries = details.locator("tbody tr");
  await expect(entries).toHaveCount(2);
  await expect(entries.first().getByRole("cell").nth(1)).toHaveCSS(
    "text-align",
    "center",
  );
  await expect(entries.first().getByRole("cell").nth(2)).toHaveCSS(
    "padding-left",
    "10px",
  );
  await expect(entries.first().getByRole("cell")).toHaveText([
    "",
    "00:17.000 – 00:19.000",
    "玩家法师",
    "首领",
  ]);
  await expect(entries.nth(1).getByRole("cell")).toHaveText([
    "",
    "00:29.000 – 00:29.000",
    "玩家法师",
    "水元素",
  ]);
  await expect(entries.first().locator("td").nth(2).locator("span")).toHaveCSS(
    "color",
    "rgb(105, 204, 240)",
  );
  await expect(
    page.getByRole("button", { name: "定位技能列表", exact: true }),
  ).toHaveCount(0);
  const firstChoice = entries.first().getByRole("checkbox");
  await expect(firstChoice).toBeChecked();
  const noteBeforeSelection = await page
    .getByLabel("Note 预览", { exact: true })
    .inputValue();
  // Selecting any row cell changes focus only; export choices remain independent.
  for (const column of [1, 2, 3]) {
    await entries.nth(1).getByRole("cell").nth(column).click();
    await expect(entries.nth(1)).toHaveClass("active");
    await expect(firstChoice).toBeChecked();
    await expect(entries.nth(1).getByRole("checkbox")).toBeChecked();
    await expect(page.getByLabel("Note 预览", { exact: true })).toHaveValue(
      noteBeforeSelection,
    );
  }
  await page.getByRole("button", { name: "定位 Note", exact: true }).click();
  expect(
    await page
      .getByLabel("Note 预览", { exact: true })
      .evaluate((el: HTMLTextAreaElement) =>
        el.value.slice(el.selectionStart, el.selectionEnd),
      ),
  ).toContain("{time:00:29.0}");
  await firstChoice.uncheck();
  await entries.first().getByRole("cell").nth(2).click();
  await expect(entries.first()).toHaveClass("active");
  await expect(firstChoice).not.toBeChecked();
  await expect(
    page.getByRole("button", { name: "定位 Note", exact: true }),
  ).toBeDisabled();
  await firstChoice.check();
  expect((await details.locator("table").boundingBox())!.width).toBeLessThan(
    360,
  );
  await firstChoice.focus();
  await page.keyboard.press("Space");
  await expect(firstChoice).not.toBeChecked();
  await page.keyboard.press("Space");
  await expect(firstChoice).toBeChecked();
  expect((await entries.first().boundingBox())!.height).toBeLessThanOrEqual(28);
  await page.screenshot({
    path: info.outputPath("timeline-unified-details.png"),
    fullPage: true,
  });
  await expect(page.getByLabel("Note 预览", { exact: true })).toHaveValue(
    /time:00:19/,
  );
  await expect(page.getByLabel("Note 预览", { exact: true })).not.toHaveValue(
    /time:00:17/,
  );
  await page.getByLabel("时间轴导出范围").selectOption("phase-1");
  const continuation = page
    .locator(".timeline-row")
    .filter({ has: page.getByRole("button", { name: /裂解 01:02.000 施法/ }) });
  await expect(continuation.locator(".timeline-cast")).toHaveCount(1);
  await expect(continuation.getByRole("checkbox")).toBeEnabled();
  await page.getByRole("button", { name: /裂解 01:02.000 施法/ }).click();
  await expect(page.getByLabel("事件详情", { exact: true })).toContainText(
    "00:59.000 – 01:02.000",
  );
  await page.getByLabel("时间轴导出范围").selectOption("full");
  await page.locator(".timeline-canvas").focus();
  await page.keyboard.press("+");
  await page.keyboard.press("+");
  await page.screenshot({
    path: info.outputPath("timeline-cast-intervals.png"),
    fullPage: true,
  });
});

test("技能配置：保存、另存为、管理和重启后恢复", async ({
  appPage: page,
  desktop,
  profile,
}, info) => {
  test.setTimeout(90000);
  await loadTimelineFixture(page, desktop, false);
  const aura = page.getByRole("checkbox", {
    name: "导出整行 示例圣骑士 光环掌握 施法",
    exact: true,
  });
  const barrier = page.getByRole("checkbox", {
    name: "导出整行 示例牧师 真言术：障 施法",
    exact: true,
  });
  const controls = page.locator(".skill-profile-controls");
  const preview = page.getByLabel("Note 预览", { exact: true });
  await aura.check();
  await controls.getByRole("button", { name: "保存", exact: true }).click();
  await expect(
    page.getByRole("dialog", { name: "保存配置", exact: true }),
  ).toBeVisible();
  await page.getByLabel("配置名称", { exact: true }).fill("治疗团减");
  await page.getByRole("button", { name: "保存新配置", exact: true }).click();
  await expect(
    controls.getByRole("button", { name: "保存", exact: true }),
  ).toBeDisabled();
  await barrier.check();
  await expect(
    controls.getByRole("button", { name: "保存", exact: true }),
  ).toBeEnabled();
  const beforeClear = await preview.inputValue();
  await controls.getByRole("button", { name: "清除勾选", exact: true }).click();
  await expect(preview).toHaveValue("");
  await expect(
    controls.locator(".skill-profile-picker > summary"),
  ).toContainText("无");
  await expect(
    controls.getByRole("button", { name: "保存", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "撤销", exact: true }),
  ).toHaveCount(0);
  await chooseSkillProfile(page, "治疗团减");
  await expect(aura).toBeChecked();
  await expect(barrier).not.toBeChecked();
  await barrier.check();
  await expect(preview).toHaveValue(beforeClear);
  await expect(
    controls.locator(".skill-profile-picker > summary"),
  ).toContainText("治疗团减");
  await controls.getByRole("button", { name: "保存", exact: true }).click();
  await expect(
    controls.getByRole("button", { name: "保存", exact: true }),
  ).toBeDisabled();
  await profileCommand(page, "另存为");
  await page.getByLabel("配置名称", { exact: true }).fill("备用方案");
  await page.getByRole("button", { name: "保存新配置", exact: true }).click();
  await profileCommand(page, "配置管理");
  const manager = page.getByRole("dialog", { name: "配置管理", exact: true });
  await expect(
    manager.getByRole("button", { name: "应用", exact: true }),
  ).toHaveCount(1);
  await expect(
    manager.getByRole("button", { name: "使用中", exact: true }),
  ).toBeDisabled();
  await expect(manager.locator(".profile-current")).toHaveCount(0);
  let original = manager
    .locator(".profile-library-item")
    .filter({ has: page.locator("strong").filter({ hasText: /^治疗团减$/ }) });
  await original.getByRole("button", { name: "复制", exact: true }).click();
  await expect(
    manager.getByRole("button", { name: "复制", exact: true }),
  ).toHaveCount(3);
  await original
    .getByRole("button", { name: "重命名配置 治疗团减", exact: true })
    .click();
  const name = page.getByLabel("配置名称 治疗团减", { exact: true });
  await name.fill("团队减伤");
  await name.press("Escape");
  await expect(manager).toBeVisible();
  await original
    .getByRole("button", { name: "重命名配置 治疗团减", exact: true })
    .click();
  await name.fill("团队减伤");
  await name.press("Enter");
  original = manager
    .locator(".profile-library-item")
    .filter({ has: page.locator("strong").filter({ hasText: /^团队减伤$/ }) });
  await expect(
    original.getByRole("button", { name: "重命名配置 团队减伤", exact: true }),
  ).toBeVisible();
  await manager
    .getByRole("button", { name: "删除配置 治疗团减（副本）", exact: true })
    .click();
  const confirmation = page.getByRole("alertdialog", {
    name: "删除配置",
    exact: true,
  });
  await expect(confirmation).toContainText(
    "确定删除配置「治疗团减（副本）」吗？",
  );
  await expect(
    confirmation.getByRole("button", { name: "取消", exact: true }),
  ).toBeFocused();
  await confirmation.getByRole("button", { name: "取消", exact: true }).click();
  await expect(
    manager.getByRole("button", { name: "复制", exact: true }),
  ).toHaveCount(3);
  await manager
    .getByRole("button", { name: "删除配置 治疗团减（副本）", exact: true })
    .click();
  await page.screenshot({
    path: info.outputPath("skill-profile-delete-confirm.png"),
    fullPage: true,
  });
  await confirmation
    .getByRole("button", { name: "删除配置", exact: true })
    .click();
  await expect(confirmation).not.toBeVisible();
  await expect(
    manager.getByRole("button", { name: "复制", exact: true }),
  ).toHaveCount(2);
  await expect(
    manager.getByRole("button", { name: "撤销", exact: true }),
  ).toHaveCount(0);
  await expect(
    manager.getByRole("button", { name: "关闭配置窗口", exact: true }),
  ).toBeInViewport({ ratio: 1 });
  await expect(
    manager.getByRole("button", { name: "完成", exact: true }),
  ).toHaveCount(0);
  await expect(
    manager.getByRole("button", { name: "将当前选择另存为…", exact: true }),
  ).toHaveCount(0);
  await expect(manager.getByText("已匹配", { exact: true })).toHaveCount(0);
  await expect(manager.locator(".profile-skill-id")).toHaveText([
    "(31821)",
    "(62618)",
  ]);
  expect(
    await manager.evaluate(
      (element) => element.scrollHeight - element.clientHeight,
    ),
  ).toBeLessThanOrEqual(1);
  await page.screenshot({
    path: info.outputPath("skill-profile-manager.png"),
    fullPage: true,
  });
  await original.getByRole("button", { name: "应用", exact: true }).click();
  await expect(manager).not.toBeVisible();
  await expect(aura).toBeChecked();
  await expect(barrier).toBeChecked();
  await controls.getByLabel("选择技能配置", { exact: true }).click();
  await expect(page.locator(".profile-options > button")).toHaveText([
    "无",
    "团队减伤",
    "备用方案",
  ]);
  await controls.getByLabel("选择技能配置", { exact: true }).click();
  for (const width of [1440, 960]) {
    await desktop.evaluate(
      ({ BrowserWindow }, width) =>
        BrowserWindow.getAllWindows()[0].setSize(
          width,
          width === 960 ? 720 : 900,
        ),
      width,
    );
    for (const label of ["保存", "清除勾选"])
      await expect(
        controls.getByRole("button", { name: label, exact: true }),
      ).toBeInViewport({ ratio: 1 });
    await controls.getByLabel("选择技能配置", { exact: true }).click();
    for (const label of ["另存为", "配置管理"])
      await expect(
        controls.getByRole("button", { name: label, exact: true }),
      ).toBeInViewport({ ratio: 1 });
    await controls.getByLabel("选择技能配置", { exact: true }).click();
    const labels = await page
      .locator(".analysis-events .tabs button")
      .allTextContents();
    expect(labels).toEqual(["Buff", "Debuff", "施法"]);
    await page.screenshot({
      path: info.outputPath("skill-profiles-" + width + ".png"),
      fullPage: true,
    });
  }
  const saved = await page.evaluate(
    (key) => JSON.parse(localStorage.getItem(key)!),
    skillProfilesStorageKey,
  );
  expect(saved.profiles).toHaveLength(2);
  expect(saved.profiles[0].skills).toHaveLength(2);
  expect(JSON.stringify(saved)).not.toContain("actorId");
  await closeAfterLoadCheck(desktop);
  const restarted = await launch(profile);
  try {
    const next = await restarted.firstWindow();
    await expect(
      next.getByRole("button", { name: "加载报告", exact: true }),
    ).toBeEnabled();
    await loadTimelineFixture(next, restarted, false);
    await expect(next.locator(".skill-profile-picker > summary")).toContainText(
      "团队减伤",
    );
    await expect(
      next.getByRole("checkbox", {
        name: "导出整行 示例圣骑士 光环掌握 施法",
        exact: true,
      }),
    ).toBeChecked();
    await expect(
      next.getByRole("checkbox", {
        name: "导出整行 示例牧师 真言术：障 施法",
        exact: true,
      }),
    ).toBeChecked();
  } finally {
    await closeAfterLoadCheck(restarted);
  }
});

test("技能配置：跨日志重新匹配全部角色，缺失技能保留，旧战斗恢复独立草稿", async ({
  appPage: page,
  desktop,
}) => {
  test.setTimeout(90000);
  await page.evaluate(
    (key) =>
      localStorage.setItem(
        key,
        JSON.stringify({
          version: 1,
          activeId: "raid",
          profiles: [
            {
              id: "raid",
              name: "团减与增益",
              skills: [
                {
                  eventType: "Casts",
                  side: "friendly",
                  abilityId: 31821,
                  name: "光环掌握",
                },
                {
                  eventType: "Casts",
                  side: "friendly",
                  abilityId: 62618,
                  name: "真言术：障",
                },
                {
                  eventType: "Buffs",
                  side: "friendly",
                  abilityId: 31821,
                  name: "光环掌握",
                },
              ],
            },
          ],
        }),
      ),
    skillProfilesStorageKey,
  );
  await page.reload();
  await expect(
    page.getByRole("button", { name: "加载报告", exact: true }),
  ).toBeEnabled();
  const changed = structuredClone(timelineReport);
  changed.masterData!.actors = changed.masterData!.actors.map((actor) => ({
    ...actor,
    id: actor.id + 100,
    name:
      actor.id === 20 ? "新圣骑士一" : actor.id === 22 ? "新战士" : actor.name,
  }));
  changed.masterData!.actors.push({
    id: 123,
    name: "新圣骑士二",
    type: "Player",
    subType: "Paladin",
  });
  changed.fights = [1, 2].map((id) => ({
    ...timelineReport.fights![0],
    id,
    friendlyPlayers: [120, 121, 122, 123],
    enemyNPCs: [{ id: 110, instanceCount: 1 }],
  }));
  const remap = (events: RawEvent[]) =>
    events.map((event) => ({
      ...event,
      sourceID: event.sourceID == null ? undefined : event.sourceID + 100,
      targetID: event.targetID == null ? undefined : event.targetID + 100,
    }));
  await mockWcl(desktop, changed);
  await mockEventData(desktop, {
    "Casts:Enemies": remap(timelineEvents("Casts", "enemy")),
    "Casts:Friendlies": [
      ...remap(
        timelineEvents("Casts", "friendly").filter(
          (event) => event.abilityGameID !== 62618,
        ),
      ),
      { type: "cast", timestamp: 42000, abilityGameID: 31821, sourceID: 123 },
    ],
    "Buffs:Friendlies": remap(timelineEvents("Buffs", "friendly")),
  });
  await load(page, "https://cn.warcraftlogs.com/reports/newcode?fight=last");
  await page.getByRole("button", { name: "时间轴视图", exact: true }).click();
  const first = page.getByRole("checkbox", {
    name: "导出整行 新圣骑士一 光环掌握 施法",
    exact: true,
  });
  const second = page.getByRole("checkbox", {
    name: "导出整行 新圣骑士二 光环掌握 施法",
    exact: true,
  });
  await expect(first).toBeChecked();
  await expect(second).toBeChecked();
  await page
    .getByRole("checkbox", { name: "导出整行 新战士 盾墙 施法", exact: true })
    .check();
  await page.getByRole("button", { name: "保存", exact: true }).click();
  const saved = await page.evaluate(
    (key) => JSON.parse(localStorage.getItem(key)!),
    skillProfilesStorageKey,
  );
  expect(saved.profiles[0].skills).toHaveLength(4);
  expect(
    saved.profiles[0].skills.some(
      (skill: { abilityId: number }) => skill.abilityId === 62618,
    ),
  ).toBe(true);
  await first.uncheck();
  await page.getByRole("button", { name: "选择战斗", exact: true }).click();
  await selectFight(page, 0);
  await expect(first).toBeChecked();
  await expect(second).toBeChecked();
  await page.getByRole("button", { name: "选择战斗", exact: true }).click();
  await selectFight(page, 1);
  await expect(first).not.toBeChecked();
  await expect(second).toBeChecked();
  await page.getByRole("tab", { name: "Buff", exact: true }).click();
  await expect(
    page.getByRole("checkbox", {
      name: "导出整行 新圣骑士一 光环掌握 Buff",
      exact: true,
    }),
  ).toBeChecked();
  await profileCommand(page, "配置管理");
  const manager = page.getByRole("dialog", { name: "配置管理", exact: true });
  await manager
    .getByRole("button", { name: "删除技能 光环掌握 施法 队友", exact: true })
    .click();
  await manager
    .getByRole("button", { name: "删除技能 真言术：障 施法 队友", exact: true })
    .click();
  await manager
    .getByRole("button", { name: "关闭配置窗口", exact: true })
    .click();
  await expect(
    page.getByRole("checkbox", {
      name: "导出整行 新圣骑士一 光环掌握 Buff",
      exact: true,
    }),
  ).toBeChecked();
  await page.getByRole("tab", { name: "施法", exact: true }).click();
  await expect(first).not.toBeChecked();
  await expect(second).not.toBeChecked();
  await expect(
    page.getByRole("checkbox", {
      name: "导出整行 新战士 盾墙 施法",
      exact: true,
    }),
  ).toBeChecked();
  const edited = await page.evaluate(
    (key) => JSON.parse(localStorage.getItem(key)!),
    skillProfilesStorageKey,
  );
  expect(edited.activeId).toBe("raid");
  expect(
    edited.profiles[0].skills
      .map(
        (skill: { eventType: string; abilityId: number }) =>
          skill.eventType + ":" + skill.abilityId,
      )
      .sort(),
  ).toEqual(["Buffs:31821", "Casts:871"]);
  await page.reload();
  await expect(
    page.getByRole("button", { name: "加载报告", exact: true }),
  ).toBeEnabled();
  await profileCommand(page, "配置管理");
  await expect(manager.getByRole("button", { name: /^删除技能/ })).toHaveCount(
    2,
  );
});

test("技能配置：切换完全替换勾选，单项删除不影响其他配置，清除后重启保持未选择配置", async ({
  appPage: page,
  desktop,
  profile,
}) => {
  test.setTimeout(90000);
  await page.evaluate(
    (key) =>
      localStorage.setItem(
        key,
        JSON.stringify({
          version: 1,
          activeId: "aura",
          profiles: [
            {
              id: "aura",
              name: "光环方案",
              skills: [
                {
                  eventType: "Casts",
                  side: "friendly",
                  abilityId: 31821,
                  name: "光环掌握",
                },
              ],
            },
            {
              id: "barrier",
              name: "障方案",
              skills: [
                {
                  eventType: "Casts",
                  side: "friendly",
                  abilityId: 62618,
                  name: "真言术：障",
                },
              ],
            },
          ],
        }),
      ),
    skillProfilesStorageKey,
  );
  await page.reload();
  await expect(
    page.getByRole("button", { name: "加载报告", exact: true }),
  ).toBeEnabled();
  await loadTimelineFixture(page, desktop, false);
  const aura = page.getByRole("checkbox", {
    name: "导出整行 示例圣骑士 光环掌握 施法",
    exact: true,
  });
  const barrier = page.getByRole("checkbox", {
    name: "导出整行 示例牧师 真言术：障 施法",
    exact: true,
  });
  const controls = page.locator(".skill-profile-controls");
  const summary = controls.getByLabel("选择技能配置", { exact: true });
  async function choose(name: string) {
    await summary.click();
    await page
      .locator(".profile-options")
      .getByRole("button", { name, exact: true })
      .click();
  }
  await expect(aura).toBeChecked();
  await expect(barrier).not.toBeChecked();
  await barrier.check();
  await choose("障方案");
  await page
    .getByRole("alertdialog", { name: "保存修改？", exact: true })
    .getByRole("button", { name: "不保存并切换", exact: true })
    .click();
  await expect(aura).not.toBeChecked();
  await expect(barrier).toBeChecked();
  await choose("光环方案");
  await expect(aura).toBeChecked();
  await expect(barrier).not.toBeChecked();
  await profileCommand(page, "配置管理");
  const manager = page.getByRole("dialog", { name: "配置管理", exact: true });
  const inactive = manager
    .locator(".profile-library-item")
    .filter({ has: page.locator("strong").filter({ hasText: /^障方案$/ }) });
  await inactive.locator("summary").click();
  await inactive
    .getByRole("button", { name: "删除技能 真言术：障 施法 队友", exact: true })
    .click();
  await expect(inactive).toContainText("此配置没有技能");
  await expect(
    manager.getByRole("button", { name: "重命名配置 无", exact: true }),
  ).toHaveCount(0);
  await manager
    .getByRole("button", { name: "关闭配置窗口", exact: true })
    .click();
  await expect(summary).toContainText("光环方案");
  await expect(aura).toBeChecked();
  await expect(barrier).not.toBeChecked();
  await controls.getByRole("button", { name: "清除勾选", exact: true }).click();
  await expect(summary).toContainText("无");
  await expect(aura).not.toBeChecked();
  await expect(barrier).not.toBeChecked();
  await expect(controls.locator(".profile-dirty")).toHaveCount(0);
  await barrier.check();
  await expect(controls.locator(".profile-dirty")).toBeVisible();
  await expect(
    controls.getByRole("button", { name: "保存", exact: true }),
  ).toBeEnabled();
  await controls.getByRole("button", { name: "保存", exact: true }).click();
  await page.getByLabel("配置名称", { exact: true }).fill("无");
  await page.getByRole("button", { name: "保存新配置", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("「无」为固定选项");
  await page.getByRole("button", { name: "取消", exact: true }).click();
  await choose("无");
  await page
    .getByRole("alertdialog", { name: "保存修改？", exact: true })
    .getByRole("button", { name: "不保存并切换", exact: true })
    .click();
  await expect(barrier).not.toBeChecked();
  await choose("光环方案");
  await expect(aura).toBeChecked();
  await choose("障方案");
  await expect(aura).not.toBeChecked();
  await expect(
    controls.getByRole("button", { name: "清除勾选", exact: true }),
  ).toBeEnabled();
  await controls.getByRole("button", { name: "清除勾选", exact: true }).click();
  const saved = await page.evaluate(
    (key) => JSON.parse(localStorage.getItem(key)!),
    skillProfilesStorageKey,
  );
  expect(saved.activeId).toBeUndefined();
  expect(saved.profiles).toHaveLength(2);
  expect(saved.profiles[0].skills).toHaveLength(1);
  expect(saved.profiles[1].skills).toHaveLength(0);
  await closeAfterLoadCheck(desktop);
  const restarted = await launch(profile);
  try {
    const next = await restarted.firstWindow();
    await expect(
      next.getByRole("button", { name: "加载报告", exact: true }),
    ).toBeEnabled();
    await loadTimelineFixture(next, restarted, false);
    await expect(next.locator(".skill-profile-picker > summary")).toContainText(
      "无",
    );
    await expect(next.getByLabel("Note 预览", { exact: true })).toHaveValue("");
    await next.getByLabel("选择技能配置", { exact: true }).click();
    await expect(next.locator(".profile-options > button")).toHaveText([
      "无",
      "光环方案",
      "障方案",
    ]);
  } finally {
    await closeAfterLoadCheck(restarted);
  }
});

test("技能配置：管理中跨阶段和角色添加技能，多选去重并保留其他临时调整", async ({
  appPage: page,
  desktop,
}, info) => {
  test.setTimeout(90000);
  await page.evaluate(
    (key) =>
      localStorage.setItem(
        key,
        JSON.stringify({
          version: 1,
          activeId: "raid",
          profiles: [
            {
              id: "raid",
              name: "团队方案",
              skills: [
                {
                  eventType: "Casts",
                  side: "friendly",
                  abilityId: 871,
                  name: "盾墙",
                },
              ],
            },
            {
              id: "other",
              name: "其他方案",
              skills: [
                {
                  eventType: "Casts",
                  side: "friendly",
                  abilityId: 999999,
                  name: "其他战斗技能",
                },
              ],
            },
          ],
        }),
      ),
    skillProfilesStorageKey,
  );
  await page.reload();
  await expect(
    page.getByRole("button", { name: "加载报告", exact: true }),
  ).toBeEnabled();
  const changed = structuredClone(timelineReport);
  changed.fights![0].friendlyPlayers!.push(23);
  changed.masterData!.actors.push({
    id: 23,
    name: "另一圣骑士",
    type: "Player",
    subType: "Paladin",
  });
  await mockWcl(desktop, changed);
  await mockEventData(desktop, {
    "Casts:Friendlies": [
      ...timelineEvents("Casts", "friendly").filter(
        (event) => event.abilityGameID !== 62618 || event.timestamp > 121000,
      ),
      { type: "cast", timestamp: 28000, abilityGameID: 31821, sourceID: 23 },
    ],
    "Casts:Enemies": timelineEvents("Casts", "enemy"),
    "Buffs:Friendlies": timelineEvents("Buffs", "friendly"),
    "Buffs:Enemies": [],
    "Debuffs:Friendlies": [],
    "Debuffs:Enemies": [],
  });
  await load(page);
  await page.getByRole("button", { name: "时间轴视图", exact: true }).click();
  const shield = page.getByRole("checkbox", {
    name: "导出整行 示例战士 盾墙 施法",
    exact: true,
  });
  const heal = page.getByRole("checkbox", {
    name: "导出整行 示例圣骑士 圣光术 施法",
    exact: true,
  });
  await expect(shield).toBeChecked();
  await shield.uncheck();
  await heal.check();
  await chooseSegment(page, /第一阶段/);
  await page.getByLabel("角色列表", { exact: true }).click();
  await page.getByRole("menuitem", { name: "示例圣骑士", exact: true }).click();
  const controls = page.locator(".skill-profile-controls");
  await profileCommand(page, "配置管理");
  const manager = page.getByRole("dialog", { name: "配置管理", exact: true });
  await manager.getByRole("button", { name: "添加技能", exact: true }).click();
  const picker = page.getByRole("dialog", { name: "添加技能", exact: true });
  const search = picker.getByRole("searchbox", {
    name: "搜索可添加技能",
    exact: true,
  });
  const castAura = picker.getByRole("checkbox", {
    name: "添加技能 光环掌握 施法 队友",
    exact: true,
  });
  await expect(picker).toContainText("输入技能名称或 ID 开始搜索");
  await search.fill("盾墙");
  await expect(
    picker.getByRole("checkbox", {
      name: "添加技能 盾墙 施法 队友",
      exact: true,
    }),
  ).toBeDisabled();
  await search.fill("其他战斗技能");
  await expect(
    picker.getByRole("checkbox", {
      name: "添加技能 其他战斗技能 施法 队友",
      exact: true,
    }),
  ).toBeVisible();
  await search.fill("光环掌握");
  await expect(castAura).toHaveCount(1);
  await castAura.check();
  await picker
    .getByLabel("添加技能类型", { exact: true })
    .selectOption("Buffs");
  await picker
    .getByRole("checkbox", { name: "添加技能 光环掌握 Buff 队友", exact: true })
    .check();
  await search.fill("62618");
  await expect(picker).toContainText("没有匹配的技能");
  await picker
    .getByLabel("添加技能类型", { exact: true })
    .selectOption("Casts");
  await picker
    .getByRole("checkbox", {
      name: "添加技能 真言术：障 施法 队友",
      exact: true,
    })
    .check();
  await search.fill("");
  await picker
    .getByLabel("添加技能阵营", { exact: true })
    .selectOption("enemy");
  await search.fill("潮汐");
  await expect(
    picker.getByRole("checkbox", {
      name: "添加技能 潮汐冲击 施法 敌对",
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    picker.getByRole("button", { name: "添加（3）", exact: true }),
  ).toBeEnabled();
  await picker.getByLabel("添加技能阵营", { exact: true }).selectOption("all");
  await picker.getByLabel("添加技能类型", { exact: true }).selectOption("all");
  await search.fill("");
  await desktop.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setSize(960, 720),
  );
  await expect(
    picker.getByRole("button", { name: "添加（3）", exact: true }),
  ).toBeInViewport({ ratio: 1 });
  await expect(
    picker.getByRole("searchbox", { name: "搜索可添加技能", exact: true }),
  ).toBeInViewport({ ratio: 1 });
  expect(
    await picker.evaluate(
      (element) => element.scrollHeight - element.clientHeight,
    ),
  ).toBeLessThanOrEqual(1);
  expect(
    await picker
      .locator(".profile-skill-options")
      .evaluate((element) => element.scrollWidth - element.clientWidth),
  ).toBeLessThanOrEqual(1);
  await page.screenshot({
    path: info.outputPath("skill-profile-add-skills.png"),
    fullPage: true,
  });
  await picker.getByRole("button", { name: "添加（3）", exact: true }).click();
  await expect(picker).not.toBeVisible();
  await expect(manager).toBeVisible();
  await expect(manager.getByRole("button", { name: /^删除技能/ })).toHaveCount(
    4,
  );
  await manager
    .getByRole("button", { name: "关闭配置窗口", exact: true })
    .click();
  await expect(page.getByLabel("角色列表", { exact: true })).toContainText(
    "示例圣骑士",
  );
  await expect(heal).toBeChecked();
  await expect(
    controls.getByRole("button", { name: "保存", exact: true }),
  ).toBeEnabled();
  await page.getByLabel("角色列表", { exact: true }).click();
  await page.getByRole("menuitem", { name: "所有队友", exact: true }).click();
  await chooseSegment(page, /全部阶段/);
  await expect(
    page.getByRole("checkbox", {
      name: "导出整行 示例圣骑士 光环掌握 施法",
      exact: true,
    }),
  ).toBeChecked();
  await expect(
    page.getByRole("checkbox", {
      name: "导出整行 另一圣骑士 光环掌握 施法",
      exact: true,
    }),
  ).toBeChecked();
  await expect(
    page.getByRole("checkbox", {
      name: "导出整行 示例牧师 真言术：障 施法",
      exact: true,
    }),
  ).toBeChecked();
  await expect(shield).not.toBeChecked();
  await expect(heal).toBeChecked();
  await page.getByRole("tab", { name: "Buff", exact: true }).click();
  await expect(
    page.getByRole("checkbox", {
      name: "导出整行 示例圣骑士 光环掌握 Buff",
      exact: true,
    }),
  ).toBeChecked();
  const saved = await page.evaluate(
    (key) => JSON.parse(localStorage.getItem(key)!),
    skillProfilesStorageKey,
  );
  expect(saved.activeId).toBe("raid");
  expect(
    saved.profiles[0].skills
      .map(
        (skill: { eventType: string; abilityId: number }) =>
          skill.eventType + ":" + skill.abilityId,
      )
      .sort(),
  ).toEqual(["Buffs:31821", "Casts:31821", "Casts:62618", "Casts:871"]);
  expect(saved.profiles[1].skills).toHaveLength(1);
  await profileCommand(page, "配置管理");
  await manager.getByRole("button", { name: "添加技能", exact: true }).click();
  await search.fill("光环掌握");
  await expect(
    picker.getByRole("checkbox", {
      name: "添加技能 光环掌握 施法 队友",
      exact: true,
    }),
  ).toBeDisabled();
  await expect(
    picker.getByRole("button", { name: "添加（0）", exact: true }),
  ).toBeDisabled();
  await picker.getByRole("button", { name: "取消", exact: true }).click();
  await manager
    .getByRole("button", { name: "关闭配置窗口", exact: true })
    .click();
  await page.reload();
  await expect(
    page.getByRole("button", { name: "加载报告", exact: true }),
  ).toBeEnabled();
  await load(page);
  await page.getByRole("button", { name: "时间轴视图", exact: true }).click();
  await expect(shield).toBeChecked();
  await expect(heal).not.toBeChecked();
  await expect(
    page.getByRole("checkbox", {
      name: "导出整行 另一圣骑士 光环掌握 施法",
      exact: true,
    }),
  ).toBeChecked();
});

test("技能配置：无日志复用技能、保存失败重试和编辑其他配置不改变当前勾选", async ({
  appPage: page,
  desktop,
}) => {
  test.setTimeout(90000);
  await page.evaluate(
    (key) =>
      localStorage.setItem(
        key,
        JSON.stringify({
          version: 1,
          activeId: "source",
          profiles: [
            {
              id: "source",
              name: "来源配置",
              skills: [
                {
                  eventType: "Casts",
                  side: "friendly",
                  abilityId: 31821,
                  name: "光环掌握",
                },
                {
                  eventType: "Buffs",
                  side: "friendly",
                  abilityId: 31821,
                  name: "光环掌握",
                },
                {
                  eventType: "Debuffs",
                  side: "enemy",
                  abilityId: 31821,
                  name: "光环掌握",
                },
              ],
            },
            { id: "target", name: "目标配置", skills: [] },
          ],
        }),
      ),
    skillProfilesStorageKey,
  );
  await page.reload();
  await expect(
    page.getByRole("button", { name: "加载报告", exact: true }),
  ).toBeEnabled();
  const controls = page.locator(".skill-profile-controls");
  const manager = page.getByRole("dialog", { name: "配置管理", exact: true });
  const target = manager
    .locator(".profile-library-item")
    .filter({ has: page.locator("strong").filter({ hasText: /^目标配置$/ }) });
  const picker = page.getByRole("dialog", { name: "添加技能", exact: true });
  async function editTarget() {
    await profileCommand(page, "配置管理");
    await target.locator("summary").click();
    await target.getByRole("button", { name: "添加技能", exact: true }).click();
    await picker
      .getByRole("searchbox", { name: "搜索可添加技能", exact: true })
      .fill("光环掌握");
  }
  await editTarget();
  await picker
    .getByRole("searchbox", { name: "搜索可添加技能", exact: true })
    .fill("31821");
  await expect(picker.getByRole("checkbox")).toHaveCount(3);
  await picker
    .getByRole("checkbox", { name: "添加技能 光环掌握 施法 队友", exact: true })
    .check();
  await picker
    .getByRole("checkbox", {
      name: "添加技能 光环掌握 Debuff 敌对",
      exact: true,
    })
    .check();
  await page.evaluate((key) => {
    const original = Storage.prototype.setItem;
    (
      window as typeof window & { testProfileSetItem?: typeof original }
    ).testProfileSetItem = original;
    Storage.prototype.setItem = function (name, value) {
      if (name === key) throw new DOMException("full", "QuotaExceededError");
      original.call(this, name, value);
    };
  }, skillProfilesStorageKey);
  await picker.getByRole("button", { name: "添加（2）", exact: true }).click();
  await expect(picker.getByRole("alert")).toContainText("技能配置保存失败");
  expect(
    await page.evaluate(
      (key) => JSON.parse(localStorage.getItem(key)!).profiles[1].skills.length,
      skillProfilesStorageKey,
    ),
  ).toBe(0);
  await expect(
    picker.getByRole("checkbox", {
      name: "添加技能 光环掌握 施法 队友",
      exact: true,
    }),
  ).toBeChecked();
  await page.evaluate(() => {
    const state = window as typeof window & {
      testProfileSetItem?: typeof Storage.prototype.setItem;
    };
    Storage.prototype.setItem = state.testProfileSetItem!;
    delete state.testProfileSetItem;
  });
  await picker.getByRole("button", { name: "添加（2）", exact: true }).click();
  await expect(picker).not.toBeVisible();
  await expect(target.getByRole("button", { name: /^删除技能/ })).toHaveCount(
    2,
  );
  await manager
    .getByRole("button", { name: "关闭配置窗口", exact: true })
    .click();
  await expect(page.locator(".skill-profile-picker > summary")).toContainText(
    "来源配置",
  );
  await loadTimelineFixture(page, desktop, false);
  const aura = page.getByRole("checkbox", {
    name: "导出整行 示例圣骑士 光环掌握 施法",
    exact: true,
  });
  await expect(aura).toBeChecked();
  await aura.uncheck();
  await editTarget();
  await picker
    .getByRole("checkbox", { name: "添加技能 光环掌握 Buff 队友", exact: true })
    .check();
  await picker.getByRole("button", { name: "添加（1）", exact: true }).click();
  await manager
    .getByRole("button", { name: "关闭配置窗口", exact: true })
    .click();
  await expect(aura).not.toBeChecked();
  await expect(
    controls.getByRole("button", { name: "保存", exact: true }),
  ).toBeEnabled();
  await page.getByRole("tab", { name: "Buff", exact: true }).click();
  await expect(
    page.getByRole("checkbox", {
      name: "导出整行 示例圣骑士 光环掌握 Buff",
      exact: true,
    }),
  ).toBeChecked();
  const saved = await page.evaluate(
    (key) => JSON.parse(localStorage.getItem(key)!),
    skillProfilesStorageKey,
  );
  expect(saved.activeId).toBe("source");
  expect(saved.profiles[0].skills).toHaveLength(3);
  expect(saved.profiles[1].skills).toHaveLength(3);
});

test("技能配置：未保存切换支持取消、保存、放弃和写入失败重试，普通切换直接生效", async ({
  appPage: page,
  desktop,
}, info) => {
  test.setTimeout(90000);
  await seedSkillProfiles(page, {
    version: 1,
    activeId: "aura",
    profiles: [
      {
        id: "aura",
        name: "光环方案",
        skills: [
          {
            eventType: "Casts",
            side: "friendly",
            abilityId: 31821,
            name: "光环掌握",
          },
        ],
      },
      {
        id: "barrier",
        name: "障方案",
        skills: [
          {
            eventType: "Casts",
            side: "friendly",
            abilityId: 62618,
            name: "真言术：障",
          },
        ],
      },
    ],
  });
  await loadTimelineFixture(page, desktop, false);
  const aura = page.locator(
    'input[aria-label="导出整行 示例圣骑士 光环掌握 施法"]',
  );
  const barrier = page.locator(
    'input[aria-label="导出整行 示例牧师 真言术：障 施法"]',
  );
  const confirmation = page.getByRole("alertdialog", {
    name: "保存修改？",
    exact: true,
  });
  const controls = page.locator(".skill-profile-controls");
  await barrier.check();
  await chooseSkillProfile(page, "障方案");
  await expect(confirmation).toContainText("切换到「障方案」前要保存吗？");
  await expect(aura).toBeChecked();
  await expect(barrier).toBeChecked();
  await expect(
    confirmation.getByRole("button", { name: "取消", exact: true }),
  ).toBeFocused();
  await page.screenshot({
    path: info.outputPath("skill-profile-unsaved-switch.png"),
    fullPage: true,
  });
  await confirmation.press("Escape");
  await expect(confirmation).not.toBeVisible();
  expect((await savedSkillProfiles(page)).activeId).toBe("aura");
  await expect(
    controls.getByRole("button", { name: "保存", exact: true }),
  ).toBeEnabled();
  await chooseSkillProfile(page, "障方案");
  await confirmation
    .getByRole("button", { name: "保存并切换", exact: true })
    .click();
  await expect(aura).not.toBeChecked();
  await expect(barrier).toBeChecked();
  let saved = await savedSkillProfiles(page);
  expect(saved.activeId).toBe("barrier");
  expect(
    saved.profiles.find((profile) => profile.id === "aura")!.skills,
  ).toHaveLength(2);
  expect(
    saved.profiles.find((profile) => profile.id === "barrier")!.skills,
  ).toHaveLength(1);
  await chooseSkillProfile(page, "光环方案");
  await expect(confirmation).not.toBeVisible();
  await expect(aura).toBeChecked();
  await expect(barrier).toBeChecked();
  await barrier.uncheck();
  await profileCommand(page, "配置管理");
  const manager = page.getByRole("dialog", { name: "配置管理", exact: true });
  const other = manager
    .locator(".profile-library-item")
    .filter({ has: page.locator("strong").filter({ hasText: /^障方案$/ }) });
  await other.getByRole("button", { name: "应用", exact: true }).click();
  await confirmation.getByRole("button", { name: "取消", exact: true }).click();
  await expect(manager).toBeVisible();
  await other.getByRole("button", { name: "应用", exact: true }).click();
  await confirmation
    .getByRole("button", { name: "不保存并切换", exact: true })
    .click();
  await expect(manager).not.toBeVisible();
  await expect(aura).not.toBeChecked();
  expect((await savedSkillProfiles(page)).profiles[0].skills).toHaveLength(2);
  await aura.check();
  await chooseSkillProfile(page, "光环方案");
  await page.evaluate((key) => {
    const original = Storage.prototype.setItem;
    (
      window as typeof window & { testProfileSetItem?: typeof original }
    ).testProfileSetItem = original;
    Storage.prototype.setItem = function (name, value) {
      if (name === key) throw new DOMException("full", "QuotaExceededError");
      original.call(this, name, value);
    };
  }, skillProfilesStorageKey);
  await confirmation
    .getByRole("button", { name: "保存并切换", exact: true })
    .click();
  await expect(confirmation.getByRole("alert")).toContainText("保存失败");
  await expect(aura).toBeChecked();
  await expect(barrier).toBeChecked();
  saved = await savedSkillProfiles(page);
  expect(saved.activeId).toBe("barrier");
  expect(saved.profiles[1].skills).toHaveLength(1);
  await page.evaluate(() => {
    const state = window as typeof window & {
      testProfileSetItem?: typeof Storage.prototype.setItem;
    };
    Storage.prototype.setItem = state.testProfileSetItem!;
    delete state.testProfileSetItem;
  });
  await confirmation
    .getByRole("button", { name: "保存并切换", exact: true })
    .click();
  expect((await savedSkillProfiles(page)).profiles[1].skills).toHaveLength(2);
  await barrier.uncheck();
  await chooseSkillProfile(page, "光环方案");
  await confirmation
    .getByRole("button", { name: "保存并切换", exact: true })
    .click();
  await expect(barrier).not.toBeChecked();
  await expect(aura).toBeChecked();
  expect((await savedSkillProfiles(page)).profiles[0].skills).toHaveLength(1);
  await expect(page.getByRole("alert")).toHaveCount(0);
  await page
    .getByRole("button", {
      name: "示例圣骑士 光环掌握 00:27.000 施法",
      exact: true,
    })
    .click();
  await page
    .getByRole("checkbox", {
      name: "导出事件 示例圣骑士 光环掌握 00:27.000 施法",
      exact: true,
    })
    .uncheck();
  await expect(
    controls.getByRole("button", { name: "保存", exact: true }),
  ).toBeDisabled();
  await chooseSkillProfile(page, "障方案");
  await expect(confirmation).toContainText("本场单次调整不会写入配置");
  await confirmation
    .getByRole("button", { name: "不保存并切换", exact: true })
    .click();
});

test("技能配置：未选择配置时先命名再切换，取消保留选择，另存为重名不覆盖", async ({
  appPage: page,
  desktop,
}, info) => {
  test.setTimeout(90000);
  await seedSkillProfiles(page, {
    version: 1,
    activeId: "aura",
    profiles: [
      {
        id: "aura",
        name: "光环方案",
        skills: [
          {
            eventType: "Casts",
            side: "friendly",
            abilityId: 31821,
            name: "光环掌握",
          },
        ],
      },
    ],
  });
  await loadTimelineFixture(page, desktop, false);
  const controls = page.locator(".skill-profile-controls");
  const aura = page.getByRole("checkbox", {
    name: "导出整行 示例圣骑士 光环掌握 施法",
    exact: true,
  });
  const barrier = page.getByRole("checkbox", {
    name: "导出整行 示例牧师 真言术：障 施法",
    exact: true,
  });
  const confirmation = page.getByRole("alertdialog", {
    name: "保存修改？",
    exact: true,
  });
  await controls.getByRole("button", { name: "清除勾选", exact: true }).click();
  await barrier.check();
  await chooseSkillProfile(page, "光环方案");
  await confirmation
    .getByRole("button", { name: "保存并切换", exact: true })
    .click();
  const naming = page.getByRole("dialog", { name: "保存配置", exact: true });
  await expect(naming).toBeVisible();
  await expect(page.locator("dialog[open]")).toHaveCount(1);
  await naming.getByLabel("配置名称", { exact: true }).fill(" 光环方案 ");
  await expect(naming.getByRole("alert")).toContainText(
    "已有同名配置，请使用其他名称",
  );
  await expect(
    naming.getByRole("button", { name: "保存新配置", exact: true }),
  ).toBeDisabled();
  await expect(
    naming.getByRole("button", { name: "覆盖同名配置", exact: true }),
  ).toHaveCount(0);
  await naming.getByRole("button", { name: "取消", exact: true }).click();
  await expect(barrier).toBeChecked();
  await expect(aura).not.toBeChecked();
  expect((await savedSkillProfiles(page)).activeId).toBeUndefined();
  await chooseSkillProfile(page, "光环方案");
  await confirmation
    .getByRole("button", { name: "保存并切换", exact: true })
    .click();
  await naming.getByLabel("配置名称", { exact: true }).fill("临时方案");
  await naming.getByRole("button", { name: "保存新配置", exact: true }).click();
  await expect(naming).not.toBeVisible();
  await expect(aura).toBeChecked();
  await expect(barrier).not.toBeChecked();
  let saved = await savedSkillProfiles(page);
  expect(saved.activeId).toBe("aura");
  expect(saved.profiles).toHaveLength(2);
  expect(
    saved.profiles.find((profile) => profile.name === "临时方案")!.skills[0]
      .abilityId,
  ).toBe(62618);
  await chooseSkillProfile(page, "临时方案");
  await expect(confirmation).not.toBeVisible();
  await expect(barrier).toBeChecked();
  await profileCommand(page, "另存为");
  const saveAs = page.getByRole("dialog", { name: "另存为配置", exact: true });
  await saveAs.getByLabel("配置名称", { exact: true }).fill("光环方案");
  await expect(
    saveAs.getByRole("button", { name: "保存新配置", exact: true }),
  ).toBeDisabled();
  await page.screenshot({
    path: info.outputPath("skill-profile-name-conflict.png"),
    fullPage: true,
  });
  saved = await savedSkillProfiles(page);
  expect(saved.profiles[0].skills[0].abilityId).toBe(31821);
  await saveAs.getByLabel("配置名称", { exact: true }).fill("新备份");
  await saveAs.getByRole("button", { name: "保存新配置", exact: true }).click();
  expect((await savedSkillProfiles(page)).profiles).toHaveLength(3);
});

test("技能配置：同一窗口添加并恢复管理位置，已添加置前，名称后显示技能 ID", async ({
  appPage: page,
  desktop,
}) => {
  test.setTimeout(90000);
  await seedSkillProfiles(page, {
    version: 1,
    activeId: "source",
    profiles: [
      {
        id: "source",
        name: "方案 来源",
        skills: [
          {
            eventType: "Casts",
            side: "friendly",
            abilityId: 871,
            name: "盾墙",
          },
          {
            eventType: "Casts",
            side: "friendly",
            abilityId: 999999,
            name: "其他战斗技能",
          },
        ],
      },
      ...Array.from({ length: 20 }, (_, index) => ({
        id: "empty-" + index,
        name: "方案 " + index,
        skills: [],
      })),
      {
        id: "target",
        name: "方案 目标",
        skills: [
          {
            eventType: "Casts",
            side: "friendly",
            abilityId: 31821,
            name: "光环掌握",
          },
          {
            eventType: "Buffs",
            side: "friendly",
            abilityId: 31821,
            name: "光环掌握",
          },
        ],
      },
    ],
  });
  await loadTimelineFixture(page, desktop, false);
  await desktop.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setSize(960, 720),
  );
  await profileCommand(page, "配置管理");
  const manager = page.getByRole("dialog", { name: "配置管理", exact: true });
  const originalWindow = (await manager.elementHandle())!;
  await expect(manager.getByText("已匹配", { exact: true })).toHaveCount(0);
  await expect(manager.locator(".profile-missing")).toHaveText("本场未出现");
  await manager
    .getByRole("searchbox", { name: "搜索已保存配置", exact: true })
    .fill("方案");
  const target = manager
    .locator(".profile-library-item")
    .filter({ has: page.locator("strong").filter({ hasText: /^方案 目标$/ }) });
  await target.locator("summary").click();
  const add = target.getByRole("button", { name: "添加技能", exact: true });
  await add.scrollIntoViewIfNeeded();
  const scroll = await manager
    .locator(".profile-dialog-body")
    .evaluate((element) => element.scrollTop);
  expect(scroll).toBeGreaterThan(0);
  await add.click();
  const picker = page.getByRole("dialog", { name: "添加技能", exact: true });
  await expect(page.locator("dialog[open]")).toHaveCount(1);
  expect(
    await picker.evaluate(
      (element, original) => element === original,
      originalWindow,
    ),
  ).toBe(true);
  await picker
    .getByRole("searchbox", { name: "搜索可添加技能", exact: true })
    .fill("1");
  await expect(picker.getByRole("status")).toHaveCount(0);
  const disabled = await picker
    .locator(".profile-skill-options input")
    .evaluateAll((inputs) =>
      inputs.map((input) => (input as HTMLInputElement).disabled),
    );
  expect(disabled.lastIndexOf(true)).toBeLessThan(disabled.indexOf(false));
  await picker
    .getByRole("searchbox", { name: "搜索可添加技能", exact: true })
    .fill("光环掌握");
  await expect(picker.locator(".profile-option-name small")).toHaveText([
    "(31821)",
    "(31821)",
  ]);
  await expect(
    picker
      .locator(".profile-option-name")
      .filter({ hasText: "光环掌握" })
      .first(),
  ).toHaveAttribute("title", "技能 ID：31821");
  await picker
    .getByRole("searchbox", { name: "搜索可添加技能", exact: true })
    .fill("31821");
  await expect(picker.locator(".profile-option-name small")).toHaveText([
    "(31821)",
    "(31821)",
  ]);
  await picker.press("Escape");
  await expect(manager).toBeVisible();
  expect(
    await manager.evaluate(
      (element, original) => element === original,
      originalWindow,
    ),
  ).toBe(true);
  await expect(
    manager.getByRole("searchbox", { name: "搜索已保存配置", exact: true }),
  ).toHaveValue("方案");
  await expect(target).toHaveAttribute("open", "");
  expect(
    Math.abs(
      (await manager
        .locator(".profile-dialog-body")
        .evaluate((element) => element.scrollTop)) - scroll,
    ),
  ).toBeLessThanOrEqual(1);
  await expect(add).toBeFocused();
  await expect(
    manager.getByRole("button", { name: "完成", exact: true }),
  ).toHaveCount(0);
  await expect(manager.locator(".profile-dialog-actions")).toHaveCount(0);
  await add.click();
  await picker
    .getByRole("searchbox", { name: "搜索可添加技能", exact: true })
    .fill("盾墙");
  await picker
    .getByRole("checkbox", { name: "添加技能 盾墙 施法 队友", exact: true })
    .check();
  await picker.getByRole("button", { name: "添加（1）", exact: true }).click();
  await expect(manager).toBeVisible();
  await expect(target.getByRole("button", { name: /^删除技能/ })).toHaveCount(
    3,
  );
  expect(
    Math.abs(
      (await manager
        .locator(".profile-dialog-body")
        .evaluate((element) => element.scrollTop)) - scroll,
    ),
  ).toBeLessThanOrEqual(1);
  await manager
    .getByRole("button", { name: "关闭配置窗口", exact: true })
    .click();
  expect(
    (await savedSkillProfiles(page)).profiles.find(
      (profile) => profile.id === "target",
    )!.skills,
  ).toHaveLength(3);
});

test("技能配置：打开不加载事件，输入后定向搜索、取消旧请求并隔离完整缓存", async ({
  appPage: page,
  desktop,
}, info) => {
  test.setTimeout(90000);
  await seedSkillProfiles(page, {
    version: 1,
    activeId: "target",
    profiles: [
      { id: "target", name: "搜索方案", skills: [] },
      {
        id: "source",
        name: "已有技能",
        skills: [
          {
            eventType: "Casts",
            side: "friendly",
            abilityId: 31821,
            name: "光环掌握",
          },
        ],
      },
    ],
  });
  await loadTimelineFixture(page, desktop, false);
  await desktop.evaluate(() => {
    const original = globalThis.fetch;
    const state = {
      requests: [] as { filter: string | null; type: string; side: string }[],
      canceled: 0,
    };
    (
      globalThis as typeof globalThis & { testSkillSearch: typeof state }
    ).testSkillSearch = state;
    globalThis.fetch = async (url, init) => {
      if (url === "https://cn.warcraftlogs.com/api/v2/client") {
        const body = JSON.parse(init!.body as string);
        if (body.query.includes("query GetFightAbilityEvents")) {
          const variables = body.variables;
          const filter = variables.filterExpression as string | null;
          state.requests.push({
            filter,
            type: variables.dataType,
            side: variables.hostilityType,
          });
          if (
            filter === "ability.id IN (31821)" &&
            variables.dataType === "Buffs" &&
            variables.hostilityType === "Friendlies"
          ) {
            await new Promise<void>((resolve, reject) => {
              const stop = () => {
                clearTimeout(timer);
                state.canceled++;
                reject(new DOMException("Canceled", "AbortError"));
              };
              const timer = setTimeout(() => {
                init?.signal?.removeEventListener("abort", stop);
                resolve();
              }, 3000);
              init?.signal?.addEventListener("abort", stop, { once: true });
              if (init?.signal?.aborted) stop();
            });
          }
        }
      }
      return original(url, init);
    };
  });
  async function requests() {
    return desktop.evaluate(
      () =>
        (
          globalThis as typeof globalThis & {
            testSkillSearch: {
              requests: { filter: string | null; type: string; side: string }[];
              canceled: number;
            };
          }
        ).testSkillSearch,
    );
  }
  await profileCommand(page, "配置管理");
  const manager = page.getByRole("dialog", { name: "配置管理", exact: true });
  await manager.getByRole("button", { name: "添加技能", exact: true }).click();
  const picker = page.getByRole("dialog", { name: "添加技能", exact: true });
  const search = picker.getByRole("searchbox", {
    name: "搜索可添加技能",
    exact: true,
  });
  await expect(picker).toContainText("输入技能名称或 ID 开始搜索");
  await page.waitForTimeout(400);
  expect((await requests()).requests).toHaveLength(0);
  await search.dispatchEvent("compositionstart");
  await search.fill("圣光");
  await page.waitForTimeout(400);
  expect((await requests()).requests).toHaveLength(0);
  await search.dispatchEvent("compositionend");
  await search.fill("");
  await search.pressSequentially("光环掌握", { delay: 10 });
  await expect
    .poll(async () =>
      (await requests()).requests.some(
        (request) => request.type === "Buffs" && request.side === "Friendlies",
      ),
    )
    .toBe(true);
  expect(
    (await requests()).requests.every(
      (request) => request.filter === "ability.id IN (31821)",
    ),
  ).toBe(true);
  await expect(picker.getByRole("status")).toContainText("正在搜索技能");
  await search.fill("62618");
  await expect(
    picker.getByRole("checkbox", {
      name: "添加技能 真言术：障 施法 队友",
      exact: true,
    }),
  ).toBeVisible();
  await expect(picker.getByRole("status")).toHaveCount(0);
  await expect.poll(async () => (await requests()).canceled).toBeGreaterThan(0);
  await expect(
    picker.getByRole("checkbox", {
      name: "添加技能 光环掌握 施法 队友",
      exact: true,
    }),
  ).toHaveCount(0);
  await expect(picker.locator(".profile-skill-id")).toHaveText("(62618)");
  await page.screenshot({
    path: info.outputPath("skill-profile-search.png"),
    fullPage: true,
  });
  const count = (await requests()).requests.length;
  await search.fill("真言术：障");
  await expect(picker.getByRole("status")).toHaveCount(0);
  expect((await requests()).requests).toHaveLength(count);
  await picker
    .getByLabel("添加技能类型", { exact: true })
    .selectOption("Casts");
  await picker
    .getByLabel("添加技能阵营", { exact: true })
    .selectOption("friendly");
  await expect(picker.getByRole("status")).toHaveCount(0);
  expect((await requests()).requests).toHaveLength(count);
  await picker.getByRole("button", { name: "取消", exact: true }).click();
  await manager
    .getByRole("button", { name: "关闭配置窗口", exact: true })
    .click();
  await page.getByRole("tab", { name: "Buff", exact: true }).click();
  await expect(
    page.getByRole("checkbox", {
      name: "导出整行 示例圣骑士 光环掌握 Buff",
      exact: true,
    }),
  ).toBeVisible();
  expect(
    (await requests()).requests.some(
      (request) =>
        request.type === "Buffs" &&
        request.side === "Friendlies" &&
        !request.filter,
    ),
  ).toBe(true);
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("Ant Design 时间范围滑块：双端缩放、整段平移、刻度与阶段同步", async ({
  appPage: page,
  desktop,
}, info) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await loadTimelineFixture(page, desktop, true, true, "default");
  const slider = page.locator(".timeline-overview-slider.ant-slider");
  const start = page.getByRole("slider", { name: "时间轴范围起点" });
  const end = page.getByRole("slider", { name: "时间轴范围终点" });
  const range = page.getByLabel("时间轴可见范围");
  const preview = page.getByLabel("Note 预览", { exact: true });
  const note = await preview.inputValue();
  const values = async () => [
    Number(await start.getAttribute("aria-valuenow")),
    Number(await end.getAttribute("aria-valuenow")),
  ];
  await expect(slider).toBeVisible();
  await expect(slider.locator(".ant-slider-rail")).toHaveCSS("height", "24px");
  await expect(start).toHaveAttribute("aria-valuenow", "0");
  await expect(end).toHaveAttribute("aria-valuenow", "20000");
  await expect(slider.locator(".ant-slider-mark-text").first()).toHaveText(
    "00:00",
  );
  await expect(page.locator(".timeline-overview-phase")).toHaveCount(0);

  const drag = async (target: typeof slider, fraction: number) => {
    // 等待布局稳定并命中控件后再读取拖动坐标。
    await target.hover();
    const box = (await target.boundingBox())!;
    const rail = (await slider.locator(".ant-slider-rail").boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(
      box.x + box.width / 2 + rail.width * fraction,
      box.y + box.height / 2,
      { steps: 8 },
    );
    await page.mouse.up();
  };
  await drag(slider.locator(".ant-slider-track"), 0.2);
  const moved = await values();
  expect(Math.abs(moved[0] - 48000)).toBeLessThan(1000);
  expect(moved[1] - moved[0]).toBe(20000);

  await drag(start, 0.05);
  const narrowed = await values();
  expect(Math.abs(narrowed[0] - moved[0] - 12000)).toBeLessThan(1000);
  expect(narrowed[1]).toBe(moved[1]);
  await drag(end, 0.1);
  const widened = await values();
  expect(widened[0]).toBe(narrowed[0]);
  expect(Math.abs(widened[1] - narrowed[1] - 24000)).toBeLessThan(1000);
  await expect(preview).toHaveValue(note);

  await chooseSegment(page, /第二阶段/);
  await expect(start).toHaveAttribute("aria-valuenow", "120000");
  await expect(end).toHaveAttribute("aria-valuenow", "240000");
  await expect(range).toHaveText("02:00 – 04:00");
  await expect(preview).not.toHaveValue(/time:00:27/);
  await expect(preview).toHaveValue(/time:02:27/);
  await expect(
    page.getByRole("button", { name: "恢复默认视窗", exact: true }),
  ).toHaveAttribute("title", "恢复默认视窗（当前阶段或 Pull 的完整范围）");
  await page.getByRole("button", { name: "放大时间轴", exact: true }).click();
  await expect(range).not.toHaveText("02:00 – 04:00");
  await page.locator(".timeline-canvas").focus();
  await page.keyboard.press("Home");
  await expect(range).toHaveText("02:00 – 04:00");
  await chooseSegment(page, /^全部阶段/);
  await expect(preview).toHaveValue(note);
  await expect(
    page.getByRole("button", { name: "恢复默认视窗", exact: true }),
  ).toBeDisabled();
  await start.press("ArrowRight");
  await expect(start).toHaveAttribute("aria-valuenow", "1");
  await start.press("End");
  await expect(start).toHaveAttribute("aria-valuenow", "18000");
  await expect(end).toHaveAttribute("aria-valuenow", "20000");
  await start.press("Home");
  await end.press("Home");
  await expect(start).toHaveAttribute("aria-valuenow", "0");
  await expect(end).toHaveAttribute("aria-valuenow", "2000");
  // 最小视窗下两端拖柄仍分开，避免较宽的拖柄互相遮挡。
  const startGrip = (await start.boundingBox())!;
  const endGrip = (await end.boundingBox())!;
  expect(startGrip.x + startGrip.width).toBeLessThanOrEqual(endGrip.x);
  const expectRangeLabels = async () => {
    const first = (await range.locator(".timeline-range-start").boundingBox())!;
    const last = (await range.locator(".timeline-range-end").boundingBox())!;
    const rail = (await slider.locator(".ant-slider-rail").boundingBox())!;
    const overview = (await page.locator(".timeline-overview").boundingBox())!;
    const firstHandle = (await start.boundingBox())!;
    const lastHandle = (await end.boundingBox())!;
    expect(first.y + first.height).toBeLessThan(rail.y);
    expect(last.y + last.height).toBeLessThan(rail.y);
    expect(first.x + first.width).toBeLessThan(last.x);
    expect(first.x).toBeGreaterThanOrEqual(overview.x + 12);
    expect(last.x + last.width).toBeLessThanOrEqual(
      overview.x + overview.width - 12,
    );
    expect(
      Math.abs(first.x + first.width - firstHandle.x - firstHandle.width / 2),
    ).toBeLessThan(1);
    expect(Math.abs(last.x - lastHandle.x - lastHandle.width / 2)).toBeLessThan(
      1,
    );
  };
  await expectRangeLabels();
  await start.press("End");
  await end.press("End");
  await start.press("End");
  await expectRangeLabels();
  await start.press("Home");
  await end.press("End");
  await expect(range).toHaveText("00:00 – 04:00");
  await expectRangeLabels();
  await expect(preview).toHaveValue(note);
  await page.getByRole("button", { name: "恢复默认视窗", exact: true }).click();
  await page.mouse.move(0, 0);
  await start.blur();
  await end.blur();
  await page
    .getByRole("button", { name: "折叠 敌对施法", exact: true })
    .click();
  await page.screenshot({
    path: info.outputPath("timeline-antd-slider-1440.png"),
    fullPage: true,
  });
  await ensureNoteOpen(page);
  await desktop.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setSize(960, 720),
  );
  await expect(start).toBeInViewport({ ratio: 1 });
  await expect(end).toBeInViewport({ ratio: 1 });
  await expect(page.locator(".timeline-viewport")).toBeInViewport({ ratio: 1 });
  await expectRangeLabels();
  await end.press("Home");
  await expectRangeLabels();
  await end.press("End");
  await start.press("End");
  await expectRangeLabels();
  await start.press("Home");
  await page.getByRole("button", { name: "恢复默认视窗", exact: true }).click();
  await page.screenshot({
    path: info.outputPath("timeline-antd-slider-960.png"),
    fullPage: true,
  });
  expect(errors).toEqual([]);
});

test("工作区按确认布局排列，单阵营单位折叠保留勾选与状态", async ({
  appPage: page,
  desktop,
}, info) => {
  await loadTimelineFixture(page, desktop, true, false);
  const preview = page.getByLabel("Note 预览", { exact: true });
  const note = await preview.inputValue();
  expect(note).not.toBe("");
  const sides = page.getByRole("group", { name: "阵营", exact: true });
  const priest = page.getByRole("button", {
    name: "折叠 示例牧师",
    exact: true,
  });
  await priest.focus();
  await priest.press("Enter");
  const expandPriest = page.getByRole("button", {
    name: "展开 示例牧师",
    exact: true,
  });
  await expect(expandPriest).toBeFocused();
  await expect(page.locator(".timeline-row")).toHaveCount(3);
  await expect(preview).toHaveValue(note);
  await sides.getByRole("button", { name: "敌对", exact: true }).click();
  await expect(page.locator(".timeline-row")).toHaveCount(2);
  await page
    .getByRole("button", { name: "折叠 潮汐守卫", exact: true })
    .click();
  await expect(page.locator(".timeline-row")).toHaveCount(0);
  await expect(preview).toHaveValue(note);
  await sides.getByRole("button", { name: "全部", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "展开 潮汐守卫", exact: true }),
  ).toBeVisible();
  await expect(expandPriest).toBeVisible();
  await page
    .getByRole("button", { name: "展开 潮汐守卫", exact: true })
    .click();
  await sides.getByRole("button", { name: "队友", exact: true }).click();
  await page.getByRole("button", { name: "图表视图", exact: true }).click();
  await page.getByRole("button", { name: "时间轴视图", exact: true }).click();
  await expect(expandPriest).toBeVisible();
  await expandPriest.click();
  await expect(page.locator(".timeline-row")).toHaveCount(4);
  await expect(preview).toHaveValue(note);

  const controls = page.getByLabel("日志筛选与视图", { exact: true });
  await expect(controls.locator(":scope > .analysis-row")).toHaveCount(3);
  await expect(
    page.locator(".report-navigation .skill-profile-controls"),
  ).toHaveCount(0);
  await expect(
    controls.locator(".event-filter .skill-profile-controls > button"),
  ).toHaveText(["保存", "清除勾选"]);
  for (const [width, height] of [
    [1440, 900],
    [960, 720],
  ]) {
    await desktop.evaluate(
      ({ BrowserWindow }, size) =>
        BrowserWindow.getAllWindows()[0].setSize(size[0], size[1]),
      [width, height],
    );
    const actor = (await controls
      .getByLabel("角色列表", { exact: true })
      .boundingBox())!;
    const faction = (await sides.boundingBox())!;
    const view = (await controls.locator(".view-toggle").boundingBox())!;
    const sideButton = (await sides
      .getByRole("button", { name: "队友", exact: true })
      .boundingBox())!;
    const viewButton = (await page
      .getByRole("button", { name: "时间轴视图", exact: true })
      .boundingBox())!;
    expect(actor.y + actor.height).toBeLessThanOrEqual(faction.y);
    expect(sideButton.height).toBeLessThanOrEqual(24);
    expect(viewButton.height).toBeGreaterThanOrEqual(56);
    expect(view.x).toBeGreaterThanOrEqual(actor.x + actor.width);
    expect(Math.abs(view.y - actor.y)).toBeLessThan(2);
    expect(
      Math.abs(view.y + view.height - faction.y - faction.height),
    ).toBeLessThan(2);
    const range = page.getByLabel("时间轴可见范围", { exact: true });
    const rail = (await page.locator(".ant-slider-rail").boundingBox())!;
    for (const label of [".timeline-range-start", ".timeline-range-end"]) {
      const box = (await range.locator(label).boundingBox())!;
      expect(box.y + box.height).toBeLessThan(rail.y);
    }
    const ruler = await page
      .locator(".timeline-tick")
      .first()
      .evaluate((element) => {
        const tick = element.getBoundingClientRect();
        const label = element.querySelector("span")!.getBoundingClientRect();
        const mark = getComputedStyle(element, "::before");
        return {
          labelBottom: label.bottom,
          markTop:
            tick.bottom - parseFloat(mark.bottom) - parseFloat(mark.height),
        };
      });
    expect(ruler.labelBottom).toBeLessThan(ruler.markTop);
    for (const element of [
      controls,
      page.locator(".timeline-navigation"),
      page.locator(".timeline-viewport"),
      page.getByRole("button", { name: "清除勾选", exact: true }),
    ])
      await expect(element).toBeInViewport({ ratio: 1 });
    await page.mouse.move(0, 0);
    await page.screenshot({
      path: info.outputPath(`workspace-timeline-${width}.png`),
      fullPage: true,
      animations: "disabled",
    });
    await page.getByRole("button", { name: "图表视图", exact: true }).click();
    await expect(controls).toBeInViewport({ ratio: 1 });
    await page.screenshot({
      path: info.outputPath(`workspace-chart-${width}.png`),
      fullPage: true,
      animations: "disabled",
    });
    await page.getByRole("button", { name: "时间轴视图", exact: true }).click();
  }
  await profileCommand(page, "配置管理");
  await expect(
    page.getByRole("dialog", { name: "配置管理", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "关闭配置窗口", exact: true }).click();
  await expect(preview).toHaveValue(note);
});

test("时间轴按 WCL 次数及名称排序，Target 筛选重算单位合计且切换视图保留 Note", async ({
  appPage: page,
  desktop,
}) => {
  const fixture = structuredClone(timelineReport);
  fixture.masterData!.actors.find((actor) => actor.id === 20)!.name =
    "Aardvark";
  fixture.masterData!.actors.find((actor) => actor.id === 21)!.name = "Zebra";
  fixture.masterData!.abilities = [
    { gameID: 191634, name: "风暴守护者", type: "8" },
    { gameID: 114050, name: "升腾", type: "4" },
    { gameID: 79206, name: "灵魂行者的恩赐", type: "8" },
    { gameID: 1250533, name: "货运者水壶", type: "8" },
  ];
  await mockWcl(desktop, fixture);
  await mockEventData(desktop, {
    "Casts:Friendlies": [
      [20, 191634, 4, 20],
      [21, 191634, 3, 20],
      [21, 114050, 2, 22],
      [21, 79206, 2, 22],
      [21, 1250533, 2, 22],
      [22, 191634, 1, 22],
    ].flatMap(([sourceID, abilityGameID, count, targetID]) =>
      Array.from({ length: count }, (_, index) => ({
        type: "cast",
        timestamp: 2000 + index * 1000,
        sourceID,
        targetID,
        abilityGameID,
      })),
    ),
    "Casts:Enemies": [
      { type: "cast", timestamp: 2000, sourceID: 10, abilityGameID: 191634 },
    ],
  });
  await load(page);
  await page.getByRole("button", { name: "时间轴视图", exact: true }).click();
  const friendlyRows = page.locator('.timeline-row[data-side="friendly"]');
  await expect(friendlyRows.locator(".timeline-skill-label strong")).toHaveText(
    [
      "风暴守护者",
      "升腾",
      "灵魂行者的恩赐",
      "货运者水壶",
      "风暴守护者",
      "风暴守护者",
    ],
  );
  async function unitNames() {
    return page
      .locator(
        '.timeline-section[data-side="friendly"] .timeline-section-toggle',
      )
      .evaluateAll((elements) =>
        elements.map((element) => element.getAttribute("aria-label")),
      );
  }
  expect(await unitNames()).toEqual([
    "折叠 Zebra",
    "折叠 Aardvark",
    "折叠 示例战士",
  ]);
  await page
    .getByRole("checkbox", {
      name: "导出整行 Zebra 风暴守护者 施法",
      exact: true,
    })
    .check();
  const preview = page.getByLabel("Note 预览", { exact: true });
  const note = await preview.inputValue();
  expect(note).not.toBe("");
  await page.getByRole("button", { name: "图表视图", exact: true }).click();
  await page.getByRole("button", { name: "时间轴视图", exact: true }).click();
  await expect(preview).toHaveValue(note);
  expect(await unitNames()).toEqual([
    "折叠 Zebra",
    "折叠 Aardvark",
    "折叠 示例战士",
  ]);
  await page.getByRole("button", { name: "全部", exact: true }).click();
  await expect(page.locator(".timeline-section").first()).toHaveAttribute(
    "data-side",
    "enemy",
  );
  await expect(preview).toHaveValue(note);
  await page.getByRole("button", { name: "队友", exact: true }).click();
  await page.getByLabel("Target列表", { exact: true }).click();
  await page.getByRole("menuitem", { name: "Aardvark", exact: true }).click();
  await expect(friendlyRows).toHaveCount(2);
  expect(await unitNames()).toEqual(["折叠 Aardvark", "折叠 Zebra"]);
  await expect(preview).toHaveValue(note);
});
