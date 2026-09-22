# 内置 mnemon 插件与 mnemon CLI 提案

## Why

`billion-context`、`dsh-rewind-plugin`、`dsh-mnemon` 三个插件目前只存在于用户自己 profile 的 `package.json` 里，属于「手工装过一次」的私有状态：

- 安装包里没有它们，新机器装完 DSH Desktop 后这三项能力直接缺失
- `DEFAULT_PROFILE_PLUGIN_BUNDLES` 里没有它们，即使用户手动装了插件、新建 Profile 时也不会自动启用
- `dsh-mnemon` 依赖的 mnemon CLI 需要用户自己想办法装到 PATH 上，应用内的 mnemon 插件因此可能整体不可用

同时仓库已有成熟先例可循：CodeGraph CLI 已经走通「vendor 平台 tgz → `scripts/prepare-codegraph.mjs` 物化 → `build.extraResources` 打进安装包 → 运行时把 `bin` 目录前插到 Host PATH → macOS 写 shell shim、Windows NSIS 写 HKCU PATH」的完整链路。mnemon CLI 是一个自包含的 Go 单文件可执行程序，比 CodeGraph 更简单（不依赖 Node，darwin-arm64 的 tgz 仅 6.0 MB），完全可以复用同一套机制。

## What Changes

- 新增 `scripts/prepare-mnemon.mjs`，镜像 `scripts/prepare-codegraph.mjs`：从 `vendor/mnemon/` 的平台 tgz 中解出 mnemon 可执行文件到 `{desktop}/build/mnemon/host/`，带 `--target` / `--check` / 幂等复用与 license 断言
- vendor 两个平台 tgz（对齐 CodeGraph 的 macOS + Windows 覆盖）：`mnemon-darwin-arm64-0.2.9.tgz`、`mnemon-win32-x64-0.2.9.tgz`
- 两个变体的 `package.json`：`build.extraResources` 增加 `build/mnemon/host` → `resources/mnemon`；`build.mac.x64ArchFiles` 追加 `Resources/mnemon/**`；五个打包脚本前缀 `node ../scripts/prepare-mnemon.mjs && `
- `desktop-codegraph-shell.ts` 泛化为 CLI 无关的 shell 集成模块：一次调用可登记多个 shim（`codegraph` 与 `mnemon`），共用同一个 `~/.dsh/bin` 目录与同一段 PATH marker block（不产生第二个块、不需要改用户 PATH）
- `desktop-runtime-environment.ts` 新增 `installDesktopMnemonRuntime` 与 `desktopMnemonBundleSupportsHost`，与 CodeGraph 版本同构
- `main.ts` 在 Host 启动期发布 mnemon runtime（失败仅记日志、不阻塞启动），并在 macOS 一并写入 mnemon shim
- `build/installer.nsh`（Windows）增加 mnemon 的 HKCU PATH 分支，与 codegraph 分支并存
- 两个变体的 `src/product-identity.ts`：`DEFAULT_PROFILE_PLUGIN_BUNDLES` 增加 `billion-context`、`dsh-mnemon`、`dsh-rewind-plugin`（按字母序插入）
- 两个变体的 `package.json` dependencies 增加 `billion-context@0.1.131`、`dsh-mnemon@0.5.12`、`dsh-rewind-plugin@0.12.2`
- 相应更新测试（打包脚本字符串、`extraResources` 深比较、NSIS 断言、Profile 预装清单断言）
- 新增中文说明文档，记录 mnemon CLI 的内置方案与实测数据

## Capabilities

### New Capabilities
- `mnemon-cli-bundling`：mnemon CLI 平台二进制的 vendor、物化、打进安装包、发布到 Host PATH 与用户终端 PATH 的完整链路，包含 shell 集成从 CodeGraph 专用泛化为 CLI 无关

### Modified Capabilities
- `desktop-preinstalled-plugins`：默认预装插件清单由 7 个扩展为 10 个，新增 `billion-context`、`dsh-mnemon`、`dsh-rewind-plugin`，并保证清单与 dependencies 一致

## Impact

- `scripts/prepare-mnemon.mjs`：新增，镜像 `scripts/prepare-codegraph.mjs`
- `vendor/mnemon/`：新增两个平台 tgz（合计约 12 MB）
- `.gitignore`：新增 `dsh-plugin-desktop/build/mnemon/`、`dsh-plugin-desktop-beta/build/mnemon/`
- `dsh-plugin-desktop{,-beta}/src/desktop-codegraph-shell.ts`：泛化为多 CLI shell 集成（文件名与导出名一并调整）
- `dsh-plugin-desktop{,-beta}/src/desktop-runtime-environment.ts`：新增 mnemon runtime 安装函数
- `dsh-plugin-desktop{,-beta}/src/main.ts`：接入 mnemon runtime 与 shell shim
- `dsh-plugin-desktop{,-beta}/src/product-identity.ts`：默认预装清单增加 3 项
- `dsh-plugin-desktop{,-beta}/package.json`：dependencies、`build.extraResources`、`build.mac.x64ArchFiles`、打包脚本
- `dsh-plugin-desktop{,-beta}/build/installer.nsh`：mnemon 的 HKCU PATH 安装/卸载分支
- `dsh-plugin-desktop{,-beta}/tests/`：`package.spec.ts`、`installer-nsh.spec.ts`、`desktop-codegraph-shell.spec.ts`、`desktop-runtime-environment.spec.ts`
- `docs/`：新增 mnemon CLI 内置方案说明（中文）

## 不在本次范围

- `billion-context` 自带的 `bili` / `bili-proxy` 可执行文件：本次只内置 mnemon CLI，`billion-context` 作为普通插件随安装包分发，其 bin 不做 PATH 发布
- Linux 平台：与 CodeGraph 保持一致，仅覆盖 macOS 与 Windows
- 用户自己 profile 里 `billion-context` 的版本：那是用户本地 profile 的状态，不属于仓库变更；内置清单只声明依赖版本
- 跨越 Yarn `npmMinimalAgeGate` 观察期的版本：内置清单只采用已通过 24h 供应链观察期的版本（`billion-context` 因此取 `0.1.131` 而非最新的 `0.1.135`）
