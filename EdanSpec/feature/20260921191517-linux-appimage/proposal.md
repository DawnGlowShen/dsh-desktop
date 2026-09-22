# Linux AppImage 打包提案

## Why

定制版目前只发布 macOS 与 Windows 两种产物，Linux 桌面用户无法安装该客户端。而代码中早已存在完整的 Linux 平台抽象——`LinuxPlatformStrategy`、`setup-wizard-contract` 的 Linux 分支、`cordis.patch.yml` 里针对 Linux 的禁用项——却因为 `build.linux.target` 只声明了 `dir` 而没有可分发产物。

CodeGraph 的 Linux 二进制去年看缺失，实际存在，但分发渠道与现有 vendor 不一致：

- npm registry 上**没有** `@colbymchenry/codegraph-linux-x64`（主包 `optionalDependencies` 声明了它，但从未发布；反向的 `linux-arm64` 反而存在）
- GitHub Releases 上**有** `codegraph-linux-x64.tar.gz`（v1.6.0，已实测 HTTP 200）
- 但两者布局不同：npm 平台包顶层带 `package.json`（`name` 为平台包名、`license: MIT`、含 `node`/`lib`/`bin`），GitHub bundle 顶层只有 `node`/`bin/`/`lib/`，其 `lib/package.json` 的 `name` 是主包名 `@colbymchenry/codegraph`

而 `scripts/prepare-codegraph.mjs` 的校验是硬性的：strip-components=1 后顶层必须有 `package.json`，且 `manifest.name` 必须精确等于平台包名。因此 GitHub bundle 无法直接接入，需要一次格式适配，否则 Linux 版本将缺少 CodeGraph 能力。

## What Changes

- `build.linux.target` 由 `["dir"]` 改为 `["AppImage"]`，产出可分发的单文件产物
- 新增 CI `desktop-linux` job（`ubuntu-latest`）：执行 Linux 打包检查、构建 AppImage 并上传 artifact
- `publish` job 的 `needs` 与产物收集纳入 Linux，三平台齐备后才发布 Release
- `scripts/prepare-codegraph.mjs` 的 `TARGETS` 增加 `linux-x64` 条目
- 将 GitHub Releases 的 `codegraph-linux-x64.tar.gz` 适配为 npm 平台包布局并 vendored 进 `vendor/codegraph/`
- `verify-packaged-runtime.ts` 的平台资产 allowlist 扩展到 Linux
- 两个变体（stable / beta）同步，README 记录 Linux 支持范围与已知功能降级

## Capabilities

### New Capabilities
- `linux-appimage-packaging`：Linux x64 AppImage 的构建、验证与发布，以及 Linux CodeGraph 二进制的获取与格式适配

### Modified Capabilities
- `desktop-release-pipeline`：CI 发布矩阵由 macOS / Windows 扩展为 macOS / Windows / Linux，打包脚本与运行时资产校验随之调整
- `codegraph-host-materialization`：CodeGraph CLI 物化从"仅 npm 平台包"扩展为"支持 GitHub Releases bundle 适配后的归档"，且新增 linux-x64 目标

## Impact

- `dsh-plugin-desktop{,-beta}/package.json`：`build.linux.target` 由 `dir` 改为 `AppImage`
- `.github/workflows/ci.yml`：新增 `desktop-linux` job；`publish` 的 `needs` 与产物收集加入 Linux
- `scripts/prepare-codegraph.mjs`：`TARGETS` 增加 `linux-x64`
- `vendor/codegraph/`：新增 `colbymchenry-codegraph-linux-x64-1.6.0.tgz`（约 59 MiB，由 GitHub bundle 转换）
- 新增适配脚本（或一次性转换步骤）：把 GitHub bundle 重排为 npm 平台包布局
- `dsh-plugin-desktop{,-beta}/scripts/verify-packaged-runtime.ts`：Linux 资产 allowlist
- `dsh-plugin-desktop{,-beta}/README{,.zh}.md` 与 `README.i18n.yaml`：记录 Linux 支持范围与降级
- `docs/`：Linux 构建与验证说明

## 已知降级（本提案显式接受，不在本次修复）

Linux 版本相较 macOS / Windows 仍缺少以下能力，均由上游代码决定，本次不改动：

- 系统终端：`terminal.ts` 在 Linux 下直接抛错
- 应用内更新：`updateDownloadPlatform = undefined`
- 目录选择：`canPickDirectory = false`
- shell 模式切换：`canToggleShellMode = false`
- 窗口材质：`window-material.ts` 强制 `off`
- 运行模式：仅 `compatibility`，`advanced` / `extended` 被拒
