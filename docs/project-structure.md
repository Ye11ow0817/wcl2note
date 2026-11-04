# 项目结构

## 组织依据

Electron 官方的 [Process Model](https://www.electronjs.org/docs/latest/tutorial/process-model) 说明了主进程、渲染进程和 preload 的职责与通信方式。它没有规定应用必须采用哪一套完整目录树；本项目按这些运行边界组织源码。

[Electron Fiddle 的 src](https://github.com/electron/fiddle/tree/main/src) 将 `main`、`preload`、`renderer` 分开；[GitHub Desktop 的 app/src](https://github.com/desktop/desktop/tree/development/app/src) 将 `main-process`、`ui`、`models` 等职责分开。本项目参考这种职责划分，结合已有领域模块和 React 功能组织目录，保留现有 Vite／esbuild／electron-builder 工具链。

### 与 WoWGearMatrix 的取舍

两个项目都按 `main`、`preload`、`renderer` 区分运行职责，区别来自前端技术栈与业务内容。WoWGearMatrix 直接运行 JavaScript／CommonJS 和普通 DOM 页面，另有独立 SimC／WASM 引擎；WCL2NOTE 使用 TypeScript、React、Vite、Vitest 和 Playwright，需要对应的类型、编译和测试配置。目录不必完全相同，根目录文件数量也不是评判标准。

- WCL2NOTE 保留 `domain` 表达报告解析、事件筛选和笔记规则，`shared` 专门表达跨进程协议，比把业务代码全部归入 `shared` 更便于辨认职责。
- 根目录的 `vite.config.ts`、`vitest.config.ts`、`playwright.config.ts` 和 `tsconfig*.json` 都是工具配置，应用代码仍在 `src/`。保留常规配置入口便于查找；移动到 `config/` 虽可减少根目录文件，但需维护显式配置路径及相对路径，当前收益有限。[Vite 配置说明](https://vite.dev/config/)支持默认发现与显式 `--config`，[TypeScript 配置说明](https://www.typescriptlang.org/docs/handbook/tsconfig-json.html)说明 `tsconfig.json` 与项目范围的关系。
- WoWGearMatrix 将 `package`（生成包）与 `release`（测试、打包、成品验证及源码归档）分开，适合其完整发布准备流程。WCL2NOTE 当前入口只负责构建和打包，因此命名为 `package:win`；目录版启动检查单独使用 `test:packaged`。以后若加入完整发布准备，应再增加职责明确的 `release:win`。
- WCL2NOTE 的单元测试和桌面测试分别使用现有 Vitest、Playwright 框架；无需复制另一项目为普通 CommonJS 脚本编写的测试运行器。

当前选择是统一进程与命令的语义，保留适合各自工具链的配置、领域和引擎结构。

## 目录

```text
wcl2note/
├─ src/
│  ├─ main/
│  │  ├─ index.ts                 # 应用生命周期、窗口、IPC、资源协议
│  │  ├─ wcl/                     # OAuth、固定 GraphQL 查询、内置凭据
│  │  ├─ settings.ts              # 本地加密与顺序保存
│  │  ├─ icons.ts                 # 图标下载校验和磁盘缓存
│  │  ├─ export.ts                # 原生导出的文件名与换行
│  │  └─ errors.ts                # IPC 错误封装
│  ├─ preload/index.ts            # contextBridge 桌面接口
│  ├─ renderer/
│  │  ├─ index.html               # Vite 页面入口
│  │  ├─ main.tsx                 # React 与 QueryClient 启动
│  │  ├─ env.d.ts                 # window.wcl2note 类型声明
│  │  ├─ app/App.tsx              # 工作区、查询与选择状态编排
│  │  ├─ components/             # ActorPicker、GameIcon、MetricBar
│  │  ├─ features/
│  │  │  ├─ fights/               # 战斗导航
│  │  │  ├─ timeline/             # 时间轴界面
│  │  │  └─ skill-profiles/       # 技能配置界面、hook、存储和样式
│  │  ├─ api/wcl/                 # preload 调用、响应校验、分页、角色详情
│  │  ├─ integrations/            # Wowhead 加载、链接和样式
│  │  ├─ hooks/                   # 可复用的 React hook
│  │  ├─ styles/                  # 全局样式
│  │  └─ assets/icons/            # 随界面打包的默认图标与来源说明
│  ├─ domain/                     # 纯业务模型、解析、筛选、笔记生成
│  │  └─ data/buff-categories.json # 由原始观察生成的紧凑索引
│  └─ shared/                     # IPC 类型、输入 schema、图标约定
├─ tests/
│  ├─ unit/{domain,main,renderer}/ # 按职责归类；可组合调用多个层验证行为
│  ├─ electron/                   # Playwright 桌面集成
│  └─ fixtures/                   # 公共测试数据与第三方脚本快照
├─ scripts/
│  ├─ package-win.mjs            # Windows 打包与产物校验
│  ├─ test-packaged.mjs          # 已打包 EXE 冒烟测试
│  └─ lib/electron-build.mjs      # 开发与生产共用主进程构建配置
├─ build/                        # electron-builder 打包资源
├─ data/wcl-buff-categories/      # 原始观察及生成依据
├─ docs/                         # 结构、验证记录、UI 文档与截图
├─ dist/                         # 渲染器构建产物（忽略）
├─ dist-electron/                # main.cjs、preload.cjs、窗口图标（忽略）
└─ release/                      # 安装版、便携版与目录版（忽略）
```

根目录保留包管理文件、工具配置，以及便于 Windows 用户双击的 `start-dev.cmd`、`package-win.cmd`。`build/` 是打包输入，`dist/` 与 `dist-electron/` 是构建输出，`release/` 是分发输出。

## 脚本命名

npm 命令使用 `操作:对象[:形式]`；脚本文件使用 `操作-对象` 的小写连字符命名。构建 `build` 生成本地运行资源，打包 `package` 生成分发产物，测试 `test` 验证行为，数据和凭据检查继续使用 `check`。

| 命令                      | 用途                                                           |
| ------------------------- | -------------------------------------------------------------- |
| `npm run build`           | 构建渲染器、主进程和 preload                                   |
| `npm run package:win`     | 构建并生成 Windows 安装版及便携版                              |
| `npm run package:win:dir` | 构建并生成 Windows 目录版                                      |
| `npm run test:unit`       | 单元测试；`npm test` 为同一入口                                |
| `npm run test:electron`   | 构建并运行真实 Electron 集成测试，可用 `-- --grep=表达式` 筛选 |
| `npm run test:packaged`   | 检查已有目录版或已安装 EXE，可用 `-- EXE路径` 指定文件         |

Windows 双击入口为 `package-win.cmd`，调用 `package:win`；打包实现为 `scripts/package-win.mjs`，已打包程序测试实现为 `scripts/test-packaged.mjs`。原 `dist:win`、`pack:win`、`test:e2e` 命令和 `build-win.cmd`、`scripts/smoke-portable.mjs` 文件已替换为这些名称。

## 依赖方向

| 位置       | 职责与允许的依赖                                                                  |
| ---------- | --------------------------------------------------------------------------------- |
| `main`     | 使用 Node／Electron，依赖 `shared` 和纯业务 `domain`；不导入 UI 或 preload 实现   |
| `preload`  | 使用 Electron 的桥接 API，依赖 `shared` 契约；不导入主进程或 UI 实现              |
| `renderer` | 使用 React、浏览器 API、`domain` 和 `shared`；通过 `window.wcl2note` 调用桌面功能 |
| `domain`   | 处理业务规则和静态数据，不依赖 React、Electron、Node 或浏览器全局状态             |
| `shared`   | 放跨进程协议和无副作用的共同约定，不引用进程实现                                  |

ESLint 限制上述源码层之间的静态导入，并阻止渲染器、领域层和共享层导入 Electron／Node 内置模块。`tsconfig.main.json` 检查主进程与 preload，`tsconfig.renderer.json` 检查渲染器（不注入 Node 全局类型），根 `tsconfig.json` 检查测试和工具配置。`npm run typecheck` 执行全部三项。Electron 主进程也使用 Fetch／Request／Response 等 Web API，因此主进程配置保留相应标准库类型。

功能专用的组件、hook、存储和样式放在同一个 `features/<功能>/`；被多个功能使用的界面放 `components/`。领域算法继续集中在 `domain/`，避免按 UI 功能重复实现。Wowhead 仅供渲染器使用，其链接与加载代码放在 `integrations/`。

## 迁移与构建约定

| 旧位置                                                   | 新位置                                                |
| -------------------------------------------------------- | ----------------------------------------------------- |
| `electron/main.ts`                                       | `src/main/index.ts`                                   |
| `electron/preload.ts`                                    | `src/preload/index.ts`                                |
| 其余 `electron/*`                                        | `src/main/*`                                          |
| `src/app/*`                                              | `src/renderer/app`、`components`、`features`、`hooks` |
| `src/infrastructure/{client,dto,playerDetails}.ts`       | `src/renderer/api/wcl/`                               |
| `src/infrastructure/skillProfiles.ts`                    | `src/renderer/features/skill-profiles/storage.ts`     |
| `src/infrastructure/wowhead.ts`、`src/shared/wowhead.ts` | `src/renderer/integrations/`                          |
| 根 `index.html`、`src/main.tsx`                          | `src/renderer/index.html`、`main.tsx`                 |
| `src/style.css`、`src/assets`                            | `src/renderer/styles/global.css`、`assets`            |
| `src/data/buff-categories.json`                          | `src/domain/data/buff-categories.json`                |
| `tests/unit/*.test.ts`                                   | `tests/unit/{domain,main,renderer}/*.test.ts`         |

Vite 的根目录为 `src/renderer`，单元测试使用独立 `vitest.config.ts`，避免测试根目录随页面入口迁移。构建输出路径和 `package.json` 的应用入口保持现有约定，原生资源协议、打包暂存和 Windows 启动方式继续使用相同产物路径。

原始分类观察保存在根 `data/`；生成索引保存在 `src/domain/data/`，通过 `npm run build:buff-categories` 更新，`npm run check:buff-categories` 校验。历史验证记录中保留当时的源码路径，新代码以本页为准。

`.cache/`、`.tmp/`、`test-results/` 等本地产物加入忽略规则。忽略规则不会撤销已暂存的文件；本次整理保留既有暂存区，未移除其中已有的临时缓存。
