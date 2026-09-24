# Mnemon CLI 打包规格

## MODIFIED Requirements

### Requirement: macOS 内置 Mnemon CLI 支持双架构

macOS 安装包内置的 Mnemon CLI **必须**同时支持 arm64 与 x64 主机。打包产物必须是单份 universal bundle，两个构建切片内容逐字节相同，运行时无需按架构选择资源目录。

原行为：`vendor/` 只有 darwin-arm64 归档，两切片共用同一份 arm64 资源；Intel Mac 上 `desktopMnemonBundleSupportsHost()` 返回 false，`dsh-mnemon` 无法从 PATH 解析 `mnemon`。
新行为：`build/mnemon/host` 是 lipo 合成的 universal bundle，manifest 声明 `cpu: ["arm64","x64"]`，两个架构的主机都能通过 `desktopMnemonBundleSupportsHost()` 并发布 CLI。

#### Scenario: Intel Mac 上发布内置 Mnemon CLI

- **WHEN** 在 x64 主机的 macOS 上启动已安装的桌面应用，且包内 `Resources/mnemon` 是 universal bundle
- **THEN** `desktopMnemonBundleSupportsHost(join(process.resourcesPath,'mnemon'),'darwin','x64')` 返回 true，`publishDesktopMnemonRuntime()` 返回带 `installation` 的结果，`~/.dsh/bin` 中出现 `mnemon` 启动器

#### Scenario: Apple Silicon 上发布内置 Mnemon CLI（回归）

- **WHEN** 在 arm64 主机的 macOS 上启动已安装的桌面应用，且包内 `Resources/mnemon` 是 universal bundle
- **THEN** 发布的 CLI 能执行 `mnemon --version` 并输出 `mnemon version 0.2.9`

### Requirement: prepare-mnemon 支持 darwin-universal target

`scripts/prepare-mnemon.mjs` **必须**接受 `--target darwin-universal`，从 vendor 目录中的 arm64 与 x64 两份归档合成 universal bundle。

#### Scenario: 合成 universal bundle

- **WHEN** 执行 `node scripts/prepare-mnemon.mjs --target darwin-universal`
- **THEN** `build/mnemon/host/bin/mnemon` 是含 `x86_64` 与 `arm64` 两个架构的 Mach-O universal binary，`package.json` 的 `cpu` 数组同时含 `arm64` 与 `x64`，且该文件带可执行权限

#### Scenario: 缺少其中一份归档时失败

- **WHEN** `vendor/mnemon/` 中缺少 darwin-x64 归档，执行 `--target darwin-universal`
- **THEN** 脚本以非零退出码失败，并输出指明缺失架构的英文错误信息

### Requirement: Mnemon 每目标 sha256 钉值

`scripts/prepare-mnemon.mjs` 的 `TARGETS` **必须**为每个 target 声明源归档的 sha256 钉值，校验不符即以非零退出码失败。

原行为：`TARGETS` 含 `darwin-arm64` 与 `win32-x64` 两个条目，各有硬编码 sha256。
新行为：新增 `darwin-x64` 条目（sha256 为 `cbdc4053f889008d34c831888420132fcfe367578b120f660bbf90252c02eb9d`），`darwin-universal` target 校验其两份源归档的 sha256。

#### Scenario: vendor 归档被替换时失败

- **WHEN** `vendor/mnemon/mnemon-darwin-x64-0.2.9.tgz` 的内容与其钉值不符
- **THEN** 脚本以非零退出码失败，输出实际与期望的 sha256
