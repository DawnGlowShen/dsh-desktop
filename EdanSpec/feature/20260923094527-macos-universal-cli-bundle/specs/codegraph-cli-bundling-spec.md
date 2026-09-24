# CodeGraph CLI 打包规格

## MODIFIED Requirements

### Requirement: macOS 内置 CodeGraph CLI 支持双架构

macOS 安装包内置的 CodeGraph CLI **必须**同时支持 arm64 与 x64 主机。打包产物必须是单份 universal bundle，两个构建切片内容逐字节相同，运行时无需按架构选择资源目录。

原行为：`vendor/` 只有 darwin-arm64 归档，两切片共用同一份 arm64 资源；Intel Mac 上 `bundleSupportsHost()` 返回 false，内置 CLI 静默不可用。
新行为：`build/codegraph/host` 是 lipo 合成的 universal bundle，manifest 声明 `cpu: ["arm64","x64"]`，两个架构的主机都能通过 `bundleSupportsHost()` 并发布 CLI。

#### Scenario: Intel Mac 上发布内置 CodeGraph CLI

- **WHEN** 在 x64 主机的 macOS 上启动已安装的桌面应用，且包内 `Resources/codegraph` 是 universal bundle
- **THEN** `desktopCodegraphBundleSupportsHost(join(process.resourcesPath,'codegraph'),'darwin','x64')` 返回 true，`publishDesktopCodegraphRuntime()` 返回带 `installation` 的结果，且 `~/.dsh/bin` 目录被创建

#### Scenario: Apple Silicon 上发布内置 CodeGraph CLI（回归）

- **WHEN** 在 arm64 主机的 macOS 上启动已安装的桌面应用，且包内 `Resources/codegraph` 是 universal bundle
- **THEN** `desktopCodegraphBundleSupportsHost(join(process.resourcesPath,'codegraph'),'darwin','arm64')` 返回 true，且发布的 CLI 能执行 `codegraph --version` 并输出 `1.6.0`

### Requirement: prepare-codegraph 支持 darwin-universal target

`scripts/prepare-codegraph.mjs` **必须**接受 `--target darwin-universal`，并从 vendor 目录中的 arm64 与 x64 两份归档合成 universal bundle。

#### Scenario: 合成 universal bundle

- **WHEN** 执行 `node scripts/prepare-codegraph.mjs --target darwin-universal`
- **THEN** `build/codegraph/host` 中的 `node` 与 `lib/kernel/codegraph-kernel.node` 均为含 `x86_64` 与 `arm64` 两个架构的 Mach-O universal binary，`package.json` 的 `cpu` 数组同时含 `arm64` 与 `x64`，且 `.prepared.json` 记录该 target

#### Scenario: 缺少其中一份归档时失败

- **WHEN** `vendor/codegraph/` 中缺少 darwin-x64 归档，执行 `--target darwin-universal`
- **THEN** 脚本以非零退出码失败，并输出指明缺失架构的英文错误信息

#### Scenario: 校验双架构并存

- **WHEN** universal bundle 合成完成
- **THEN** 脚本用 `lipo -archs` 校验每处 Mach-O 均含 `x86_64` 与 `arm64`，任一缺失即以非零退出码失败

## ADDED Requirements

### Requirement: CodeGraph 归档校验和记录

`darwin-universal` target 合成完成后，`.prepared.json` **必须**记录两份源归档的 sha256，供审计与幂等复用判据使用。

#### Scenario: 记录源归档校验和

- **WHEN** `prepare-codegraph.mjs --target darwin-universal` 成功完成
- **THEN** `build/codegraph/.prepared.json` 含 `archiveSha256` 字段，其值等于 `vendor/codegraph/colbymchenry-codegraph-darwin-arm64-1.6.0.tgz` 的 sha256
