# 桌面预装插件规格

## MODIFIED Requirements

### Requirement: 默认预装插件清单

安装包必须把清单内的插件作为直接依赖随包分发，并在新建 Profile 时把它们写入该 Profile 的 `bundles`。原清单为 7 项（`@edan/edan-spec`、`@huanlin/dsh-plugin-better-sidebar-plugin-office`、`@hyzyn/dsh-codegraph`、`@linxin666/dsh-client-ui-git-graph`、`dsh-better-sidebar`、`dsh-dream-skin`、`dsh-session-manager`），现扩展为 10 项，新增 `billion-context`、`dsh-mnemon`、`dsh-rewind-plugin`。

#### Scenario: 清单内容

- **WHEN** 读取任一变体 `src/product-identity.ts` 的 `DEFAULT_PROFILE_PLUGIN_BUNDLES`
- **THEN** 其包含 `billion-context`、`dsh-mnemon`、`dsh-rewind-plugin`
- **AND** 该数组按字典序排列，`billion-context` 位于 `@linxin666/dsh-client-ui-git-graph` 与 `dsh-better-sidebar` 之间

#### Scenario: 新 Profile 自动启用

- **WHEN** 在全新数据目录中首次启动应用并创建默认 Profile
- **THEN** 该 Profile 的 `package.json` 的 `bundles` 含 `billion-context`、`dsh-mnemon`、`dsh-rewind-plugin`

#### Scenario: 清单与依赖一致

- **WHEN** 执行 `node scripts/preinstall-plugins.mjs list`
- **THEN** 上述三个插件在两个变体中均同时标记为「在 dependencies」与「在清单」
- **AND** 输出中不存在「在清单里但不在 dependencies」的告警

#### Scenario: 版本与上游一致

- **WHEN** 读取任一变体 `package.json` 的 dependencies
- **THEN** `billion-context` 为 `0.1.131`、`dsh-mnemon` 为 `0.5.12`、`dsh-rewind-plugin` 为 `0.12.2`
- **AND** `billion-context` 的版本已通过 Yarn 的 `npmMinimalAgeGate` 观察期，`corepack corepack yarn install` 不报 `YN0016` 隔离错误

#### Scenario: 许可证门禁通过

- **WHEN** 在任一变体执行 `corepack yarn run verify:licenses`
- **THEN** 三个插件及其传递依赖均通过 `ALLOWED_LICENSES` 校验，不产生需要人工处理的失败项

#### Scenario: 既有清单项不回归

- **WHEN** 读取 `DEFAULT_PROFILE_PLUGIN_BUNDLES`
- **THEN** 原有 7 项仍全部存在，且两个变体的该数组内容完全一致
