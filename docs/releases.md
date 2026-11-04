# 发布与应用更新

## 构建与发布

- `.github/workflows/ci.yml`：PR 和 main 推送执行 Lint、单元测试和构建检查。
- `.github/workflows/release.yml`：main 推送、手动运行和 `v*` 标签执行 Windows x64 安装包构建、清单校验、正式包更新流程测试和目录版启动检查；Artifacts 保留 14 天。
- 只生成和上传 `WCL2NOTE-X.Y.Z-win-x64-setup.exe`、`update.json` 和 `SHA256SUMS.txt`。不再生成或发布 portable。`win-unpacked/` 是本地及 CI 验证用的内部目录产物。
- 只有推送正式版本标签才发布 Release；手动运行只生成 Artifacts。
- 发布任务先创建草稿并上传完整附件，再发布。仅更高版本标记 Latest，已发布版本禁止覆盖，失败的草稿可以通过重跑补齐。发布任务串行执行。
- 构建任务只有读取权限，发布任务使用自带 `GITHUB_TOKEN` 的 `contents: write`，客户端不含 GitHub Token。

首次先将工作流合并到 main。修改 `package.json` 和 `package-lock.json` 的版本，更新 `RELEASE_NOTES.md`，提交并推送，再推送对应的 `vX.Y.Z` 标签。标签必须与应用版本一致，版本仅支持稳定的 `X.Y.Z`，同一正式版本不重复发布不同文件。首次安装带更新功能的版本仍需手动下载安装包。

本地 `npm run package:win` 生成安装包、清单和校验文件，不上传。`npm run release:verify` 重新核对附件字节数、SHA-256、清单与发布说明。`npm run package:win:dir` 可只构建内部目录版。

## GitHub 更新源

仓库定义在 `src/shared/update-source.json`，当前为 `Ye11ow0817/wcl2note`。检查入口：

```text
https://github.com/Ye11ow0817/wcl2note/releases/latest/download/update.json
```

清单格式版本为 1，包含版本号、发布日期、说明、Release URL，以及唯一的 `artifacts.setup`（文件名、固定版本下载 URL、字节数、SHA-256）。附件固定到 `/releases/download/vX.Y.Z/`。发布仓库和附件须可公开访问。

网络由主进程的独立 Chromium 会话处理，每次请求及重定向均限制到配置仓库 Releases 和 GitHub 官方附件主机。检查超时 15 秒，下载无数据超时 45 秒，总超时 30 分钟。取消或失败删除临时文件，不支持断点续传。文件写入系统下载目录内独立 `WCL2NOTE-*` 文件夹，先使用 `.part`，校验通过后改为最终 EXE 名称。校验值检测文件损坏，不替代代码签名。

## 客户端界面

正式应用主窗口显示 3 秒后检查一次，开发模式仅手动检查。仅更高版本视为更新。首页不显示凭据状态、更新提示栏或底栏，不保留底栏提示、短暂浮动提示或清除勾选撤销功能。设置元信息为 `WCL2NOTE / 版本号 / Ye11ow`。

设置的更新区域只保留「检查更新」与和首页相同的更新按钮。无更新时隐藏更新按钮，检查失败只在设置显示一条错误，已是最新版本显示简短结果。两个位置共享主进程状态和下载任务，不重复下载。

| 状态             | 按钮    | 颜色 | 行为                     |
| ---------------- | ------- | ---- | ------------------------ |
| 无可用更新       | 隐藏    | —    | —                        |
| 发现更新         | 更新    | 蓝色 | 下载安装包               |
| 下载中           | 下载 N% | 青色 | 禁用                     |
| 校验中           | 校验中… | 紫色 | 禁用                     |
| 下载／校验失败   | 重试    | 红色 | 重新下载                 |
| 下载并校验通过   | 安装    | 绿色 | 启动安装程序并退出       |
| 安装程序启动中   | 安装中… | 绿色 | 禁用                     |
| 安装程序启动失败 | 重试    | 红色 | 重试启动已下载的安装程序 |

下载、校验和安装期间禁用手动检查。检查失败保留此前已发现或已下载的更新。运行安装程序前再次验证文件，文件缺失或被篡改时改为重新下载。保留 appId、应用名称和 AppData 数据目录，覆盖安装不清空 WCL 凭据及技能配置。

## 验证

```text
npm run typecheck
npm run lint
npm run test:unit
npm run test:electron -- tests/electron/updates.spec.ts
npm run package:win
npm run release:verify
npm run test:packaged
```

`test:packaged` 默认启动 `release/win-unpacked/WCL2NOTE.exe`，也可通过 `-- EXE路径` 检查已安装的程序；它不会运行 setup 安装程序。测试使用独立用户配置目录。Electron 更新测试模拟 GitHub 响应和系统安装入口，覆盖两处按钮同步、进度、失败重试、安装前校验、启动检查与 Chromium 重定向。

前一轮验证中，两项原有桌面测试在修改前 `6922871` 上也失败：凭据重启测试超时；最小窗口测试要求已折叠的战斗列表可见。本轮对移除的底栏／凭据状态／撤销断言作相应调整，相关旧测试的其他问题不作为更新功能已通过的依据。

真实发布验收仍需推送工作流和版本标签，通过已安装的旧版本检查并下载更高版本，验证 NSIS 实际覆盖升级和配置保留。本地测试不能替代该步骤。

2026-11-03 本轮验证：类型检查、Lint、格式检查、425 项单元测试、正式目录包的 5 项更新桌面测试，以及程序启动／IPC／Windows 凭据加密保存与恢复默认检查通过。仅安装版 EXE 已生成，清单与 SHA-256 校验通过。测试中的安装入口使用替身；未提交或推送代码，未执行远端 Actions 或真实 NSIS 覆盖升级。
