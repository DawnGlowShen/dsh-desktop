# macOS 桌面打包规格

## MODIFIED Requirements

### Requirement: macOS 平台的默认 CLI target 为 universal

`scripts/prepare-codegraph.mjs` 与 `scripts/prepare-mnemon.mjs` 在**未传 `--target`** 且宿主平台为 `darwin` 时，**必须**解析为 `darwin-universal`，而非宿主架构对应的 `darwin-arm64` / `darwin-x64`。

原行为：无 `--target` 时按 `${process.platform}-${process.arch}` 推断。在 Intel Mac 上推断出 `darwin-x64`，而 `vendor/` 无该归档，构建直接失败于 `no vendored archive for darwin-x64`。
新行为：darwin 平台一律解析为 `darwin-universal`，产物与构建主机架构无关。Windows 仍按 `${process.platform}-${process.arch}` 推断为 `win32-x64`。

选此方案而非在调用点显式传参，是因为 `package.json` 中有 10 处调用点、测试中有 10 处字符串断言（两个变体各一份），改动调用点需同改 20 处且易漏；改默认推断只需 2 个脚本文件。

#### Scenario: 在 Intel Mac 上构建 macOS 产物

- **WHEN** 在 x64 主机的 macOS 上执行 `node scripts/prepare-codegraph.mjs`（不带 `--target`）
- **THEN** 脚本按 `darwin-universal` 处理，不因缺少 `darwin-x64` 归档而失败，`build/codegraph/host` 为 universal bundle

#### Scenario: 在 Apple Silicon 上构建 macOS 产物（回归）

- **WHEN** 在 arm64 主机的 macOS 上执行 `node scripts/prepare-mnemon.mjs`（不带 `--target`）
- **THEN** 脚本按 `darwin-universal` 处理，`build/mnemon/host/bin/mnemon` 为含 `x86_64` 与 `arm64` 的 universal binary

#### Scenario: Windows 平台的默认 target 不变

- **WHEN** 在 Windows 主机上执行 `node scripts/prepare-mnemon.mjs`（不带 `--target`）
- **THEN** 脚本按 `win32-x64` 处理，产出 `build/mnemon/host/bin/mnemon.exe`

#### Scenario: 显式 target 仍然生效

- **WHEN** 执行 `node scripts/prepare-codegraph.mjs --target win32-x64`（宿主为 macOS）
- **THEN** 脚本按 `win32-x64` 处理，忽略平台默认推断
