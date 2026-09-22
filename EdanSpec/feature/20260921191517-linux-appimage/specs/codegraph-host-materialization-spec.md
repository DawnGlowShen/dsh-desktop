# CodeGraph CLI 物化规格

## MODIFIED Requirements

### Requirement: 目标平台集合

CodeGraph CLI 物化原先只支持 npm 平台包可用的 `darwin-arm64`、`darwin-x64`、`win32-x64`、`win32-arm64`；现增加 `linux-x64`，其归档来自 GitHub Releases bundle 的格式适配产物。

#### Scenario: 在 Linux 上物化

- **WHEN** 在 linux-x64 执行 `prepare-codegraph.mjs`
- **THEN** 解包 `vendor/codegraph/` 中对应的 linux-x64 归档，校验顶层 `package.json` 的 `name` 为 `@colbymchenry/codegraph-linux-x64`、`license` 为 `MIT`，并确认 `bin/codegraph` 与 `node` 存在且可执行

#### Scenario: 已支持平台行为不变

- **WHEN** 在 darwin-arm64 或 win32-x64 执行同一脚本
- **THEN** 行为与改动前一致：解包对应归档、校验清单、设置可执行位并写出物化标记

#### Scenario: 未知平台仍显式失败

- **WHEN** 传入仍不在目标集合中的平台（如 `linux-arm64`）
- **THEN** 脚本以非零退出码结束并打印期望的目标列表

### Requirement: GitHub Releases bundle 的格式适配

GitHub Releases 提供的 `codegraph-linux-x64.tar.gz` 与 npm 平台包布局不同：顶层没有 `package.json`，其 `lib/package.json` 的 `name` 为主包名 `@colbymchenry/codegraph`。适配产物必须提供平台包布局，使既有校验逻辑无需改动即可通过。

#### Scenario: 适配产物通过既有校验

- **WHEN** 对适配后的归档执行既有校验逻辑
- **THEN** strip-components=1 后顶层存在 `package.json`，其 `name` 为 `@colbymchenry/codegraph-linux-x64`、`license` 为 `MIT`，且 `bin/codegraph` 与 `node` 均存在

#### Scenario: 适配不改动可执行文件

- **WHEN** 比较适配产物与 GitHub bundle 中的 `bin/codegraph` 及 `node`
- **THEN** 两者的字节内容完全一致，适配只涉及布局与清单，不修改二进制

#### Scenario: 许可证门禁仍然通过

- **WHEN** 打包流程执行许可证校验
- **THEN** linux-x64 归档与既有平台归档受到同等校验，不因新增平台而放宽
