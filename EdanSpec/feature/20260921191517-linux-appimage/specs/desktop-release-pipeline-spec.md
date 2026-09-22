# 桌面发布流水线规格

## MODIFIED Requirements

### Requirement: 发布矩阵

发布流水线原先仅构建并发布 macOS 与 Windows 产物；现扩展为 macOS、Windows、Linux 三平台，三者全部成功后才发布 Release。

#### Scenario: 三平台齐备才发布

- **WHEN** 推送至 `evo` 分支且变更被判定为产品变更
- **THEN** `publish` job 在 `desktop-macos`、`desktop-windows`、`desktop-linux` 全部成功后执行，Release 中同时含三平台产物

#### Scenario: 任一平台失败即不发布

- **WHEN** 三个平台构建 job 中任一失败
- **THEN** `publish` job 不执行，不产生新的 Release

## ADDED Requirements

### Requirement: Linux 构建 job

CI 必须包含运行于 `ubuntu-latest` 的 Linux 构建 job，其结构与 macOS / Windows job 一致：先执行该平台的打包检查，再构建可分发产物并上传为 workflow artifact。

#### Scenario: Linux job 上传产物

- **WHEN** `desktop-linux` job 成功完成
- **THEN** 对应 workflow artifact 中存在 `.AppImage` 文件

#### Scenario: 非产品变更时跳过

- **WHEN** 变更被分类为非产品变更
- **THEN** `desktop-linux` job 不执行，与其余打包 job 行为一致

### Requirement: Release 产物收集含 Linux

`publish` job 收集的产物集合必须包含 Linux AppImage，且滚动 `evo-latest` 标记同步指向本次发布。

#### Scenario: Release 含三平台产物

- **WHEN** 一次完整发布完成
- **THEN** 该 Release 的产物包含 macOS 的 `.dmg`、Windows 的 `.exe` 与 `.zip`、Linux 的 `.AppImage`
