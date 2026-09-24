# macOS Universal 产物内置 CLI 提案

## Why

macOS 安装包以 **universal** 方式构建（`scripts/package-mac.ts:135`、`scripts/release-mac.ts:105` 均传 `--universal`），一个 `.app` 同时含 x64 与 arm64 两个切片。但 `build.extraResources` 是**静态单份拷贝**，`vendor/` 里 macOS 只有 darwin-arm64 归档，于是两个切片共用同一份 arm64 资源。

结果是 **Intel Mac 上内置 CLI 完全缺失**：`process.arch === 'x64'` 与资源清单里的 `cpu: ["arm64"]` 不匹配，`bundleSupportsHost()` 返回 false，`publishBundledCliRuntime()` 静默返回空对象（`desktop-runtime-environment.ts:699-713`），launchers 为空 → 不写 shim、**不创建 `~/.dsh/bin`**、不写 `.zshrc` PATH 块。用户在 Intel Mac 上装完发现 `.dsh` 下没有 `bin` 目录，即由此而来。

`EdanSpec/feature/20260922140939-bundle-mnemon-and-plugins/specs/mnemon-cli-bundling-spec.md:76` 已把「清单声明 arm64 而主机为 x64」写成显式 scenario，说明这是**当初接受的已知限制**而非缺陷。本次变更的目标是消除该限制：让 Intel Mac 也拿到 `codegraph` 与 `mnemon`。

## What Changes

- `vendor/codegraph/`、`vendor/mnemon/` 各补入 darwin-x64 归档（`@colbymchenry/codegraph-darwin-x64@1.6.0`、`@mnemon-dev/mnemon@0.2.9-darwin-x64`）。
- `scripts/prepare-codegraph.mjs`、`scripts/prepare-mnemon.mjs` 新增 **`darwin-universal`** target：分别解包 arm64 与 x64 归档，对包内 Mach-O 执行 `lipo -create` 合成单份 universal bundle 落到 `build/<cli>/host`，并把 manifest 的 `cpu` 改为 `["arm64","x64"]`。
- 两个桌面变体的 `package.json` 中 `package:*` / `dist:*` 脚本（各 5 处，共 10 处）**不修改**：改由 prepare 脚本的默认 target 推断承接。
- `scripts/prepare-codegraph.mjs`、`scripts/prepare-mnemon.mjs` 在 darwin 平台下的默认 target 由宿主架构改为 `darwin-universal`，使 `package.json` 中的 10 处调用点与 10 处测试断言无需改动。
- `build.extraResources` **保持不变**（仍为 `build/codegraph/host → codegraph` 单份静态拷贝），运行时 `join(process.resourcesPath, 'codegraph')` 路径与 `bundleSupportsHost()` 判定逻辑**均不改动**。
- `vendor/` 的 darwin-x64 归档纳入许可证与校验审计。

### 不在本次范围

- **Linux 平台**：`20260921191517-linux-appimage` feature 正在处理 `linux-x64`，本次不触碰其任何改动点。
- **代码签名 / 公证**：`resetAdHocDarwinSignature: true` 且当前为未签名 DMG 路线；签名方案属长期独立议题（见 `docs/bundle-codegraph-cli.zh.md:397`）。
- **`MACOS_UNIVERSAL_NATIVE_ENTRIES` 白名单**：该白名单只覆盖 sharp/koffi/ripgrep 等已知条目，codegraph 与 mnemon 仍不在其中，本次不变更。
- **上游 npm 上的 CLI 版本**：仍取 1.6.0 / 0.2.9，不升级。

## Capabilities

### Modified Capabilities

- `codegraph-cli-bundling`：CodeGraph CLI 的 macOS 打包产物由「单架构 arm64 一份」变为「universal 一份」，使 x64 主机也能发布内置 CLI。新增 `darwin-universal` target 与双架构校验。
- `mnemon-cli-bundling`：Mnemon CLI 同上。此外 `prepare-mnemon.mjs` 的 `TARGETS` 需为 darwin-x64 归档补上 sha256 钉值（该脚本对每个 target 硬编码校验和，与 `prepare-codegraph.mjs` 不同）。
- `desktop-macos-packaging`：两个 prepare 脚本在 darwin 平台下的**默认 target 推断**由「宿主架构」改为 `darwin-universal`。这让 Intel/Apple Silicon 主机上构建出的产物一致，并修掉 Intel 主机上 `dist:mac-smoke` 直接失败于 `no vendored archive for darwin-x64` 的问题。选择改默认推断而非在 10 处 `package.json` 调用点显式传参，是为避免同改 20 处字符串（含 10 处测试断言）。

## Impact

- `vendor/codegraph/colbymchenry-codegraph-darwin-x64-1.6.0.tgz`：新增（约 56 MB）
- `vendor/mnemon/mnemon-darwin-x64-0.2.9.tgz`：新增（约 6.3 MB）
- `scripts/prepare-codegraph.mjs`：新增 `darwin-universal` target、lipo 合成、manifest 归一、双架构校验
- `scripts/prepare-mnemon.mjs`：同上，外加 darwin-x64 的 sha256 钉值
- `dsh-plugin-desktop/package.json`：**不改动**（脚本调用点保持原样）
- `dsh-plugin-desktop-beta/package.json`：**不改动**（同上）
- `dsh-plugin-desktop/src/desktop-runtime-environment.ts`：**不改动**（`bundleSupportsHost()` 靠 universal manifest 的 `cpu` 自然通过）
- `dsh-plugin-desktop/src/main.ts`：**不改动**（资源路径不变）
- `docs/bundle-codegraph-cli.zh.md`、`docs/bundle-mnemon-cli.zh.md`：更新 vendor 清单、体积表与 universal 构建说明
- 体积：解压 +174.5 MB（codegraph +158 MB、mnemon +16 MB），按仓库实测压缩比 0.322 推算 DMG 约 **+56 MB**
