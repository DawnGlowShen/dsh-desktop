# mnemon CLI 内置规格

## ADDED Requirements

### Requirement: 平台二进制通过 vendor 归档物化

仓库必须在 `vendor/mnemon/` 中随源码跟踪 mnemon CLI 的平台归档，并通过 `scripts/prepare-mnemon.mjs` 把它们物化到桌面变体的 `build/mnemon/host/` 目录，而不是把平台二进制声明为 Yarn 依赖。

#### Scenario: 物化 darwin-arm64 目标

- **WHEN** 在仓库根执行 `node scripts/prepare-mnemon.mjs --desktop dsh-plugin-desktop --target darwin-arm64`
- **THEN** `dsh-plugin-desktop/build/mnemon/host/bin/mnemon` 存在且带有可执行位
- **AND** `dsh-plugin-desktop/build/mnemon/host/package.json` 的 `license` 为 `Apache-2.0`
- **AND** 脚本写出 `dsh-plugin-desktop/build/mnemon/.prepared.json` 标记文件，其中记录该归档的 SHA-256

#### Scenario: 物化 win32-x64 目标

- **WHEN** 在仓库根执行 `node scripts/prepare-mnemon.mjs --desktop dsh-plugin-desktop-beta --target win32-x64`
- **THEN** `dsh-plugin-desktop-beta/build/mnemon/host/bin/mnemon.exe` 存在

#### Scenario: 归档校验失败时中止

- **WHEN** vendor 归档的 SHA-256 与脚本内置期望值不一致，或归档内 `package.json` 的 `license` 不是 `Apache-2.0`
- **THEN** 脚本以非零退出码结束，并向 stderr 输出以 `prepare-mnemon: ` 开头的错误说明
- **AND** 不写出 `.prepared.json` 标记文件

#### Scenario: 校验模式不写盘

- **WHEN** 执行 `node scripts/prepare-mnemon.mjs --desktop dsh-plugin-desktop --target darwin-arm64 --check` 且该目标尚未物化
- **THEN** 脚本以非零退出码结束，并提示需要先运行 `node scripts/prepare-mnemon.mjs`
- **AND** 不创建 `build/mnemon/` 下任何文件

#### Scenario: 重复执行保持幂等

- **WHEN** 同一目标连续物化两次，且两次之间 vendor 归档未变化
- **THEN** 第二次执行不重新解包，复用既有 `build/mnemon/host/`
- **AND** 两次执行后 `build/mnemon/.prepared.json` 中的归档 SHA-256 相同

#### Scenario: 拒绝非桌面包目录

- **WHEN** `--desktop` 指向的目录其 `package.json` 的 `name` 既不是 `dsh-plugin-desktop` 也不是 `dsh-plugin-desktop-beta`
- **THEN** 脚本以非零退出码结束，且不写出任何文件

### Requirement: mnemon 二进制随安装包分发

两个桌面变体的 `build.extraResources` 必须把物化后的 mnemon 目录打进安装包，且 macOS universal 构建必须把该路径纳入 `x64ArchFiles`，使两个架构切片内容一致。

#### Scenario: extraResources 声明

- **WHEN** 读取 `dsh-plugin-desktop/package.json` 与 `dsh-plugin-desktop-beta/package.json`
- **THEN** 两份 `build.extraResources` 均含 `{ "from": "build/mnemon/host", "to": "mnemon" }`

#### Scenario: macOS universal 切片一致

- **WHEN** 读取任一变体 `package.json` 的 `build.mac.x64ArchFiles`
- **THEN** 其值包含 `Resources/mnemon/**`

#### Scenario: 打包前自动物化

- **WHEN** 读取任一变体 `package.json` 的 `package:dir`、`dist:mac`、`dist:mac-smoke`、`dist:win`、`dist:win-portable` 脚本
- **THEN** 每个脚本均以 `node ../scripts/prepare-mnemon.mjs && ` 与 `node ../scripts/prepare-codegraph.mjs && ` 作为前缀

### Requirement: mnemon CLI 对 Host 进程可见

Host 启动时必须把安装包内 mnemon 的 `bin` 目录前插到本进程 PATH，使插件通过 PATH 查找即可解析到 `mnemon`，并在应用退出时精确还原原 PATH。

#### Scenario: 架构匹配时发布

- **WHEN** 安装包内 `resources/mnemon/package.json` 的 `os`/`cpu` 与当前主机一致，且 `bin/mnemon`（Windows 为 `bin/mnemon.exe`）存在
- **THEN** `installDesktopMnemonRuntime` 返回的 `pathDir` 等于 `<bundleDir>/bin`
- **AND** 调用后 `process.env.PATH` 的首个条目为该 `pathDir`
- **AND** 调用返回的 `dispose()` 执行后 `process.env.PATH` 与调用前逐字符相同

#### Scenario: 架构不匹配时跳过

- **WHEN** 安装包内 mnemon 的平台清单声明 `cpu: ["arm64"]` 而当前主机为 `x64`
- **THEN** `desktopMnemonBundleSupportsHost` 返回 `false`
- **AND** 调用方不调用 `installDesktopMnemonRuntime`，PATH 不被修改

#### Scenario: 无法读取清单时视为不支持

- **WHEN** 传入的 `bundleDir` 不存在，或其中的 `package.json` 不是合法 JSON
- **THEN** `desktopMnemonBundleSupportsHost` 返回 `false`，且不抛错

#### Scenario: 发布失败不阻断启动

- **WHEN** mnemon runtime 安装过程中抛出任何异常
- **THEN** Host 启动流程继续执行，异常信息以错误日志形式记录
- **AND** 应用仍能进入主界面

### Requirement: macOS 终端可直接使用 mnemon

macOS 上 Host 启动时必须把安装包内 mnemon 发布为 `~/.dsh/bin` 下的 shim，并在用户 shell 配置中写入一段被 marker 包裹、指向 `~/.dsh/bin` 的 PATH 块。shell 集成必须对 CLI 泛化：codegraph 与 mnemon 共用同一目录与同一段 marker 块。

#### Scenario: 生成 shim

- **WHEN** 以 `homeDir`、`userHomeDir` 与 `launcherPath` 调用 shell 集成
- **THEN** `<homeDir>/bin/mnemon` 存在、内容引用 `launcherPath`、且带有可执行位

#### Scenario: 同一段 marker 块承载多个 CLI

- **WHEN** 先为 codegraph 登记一次 shell 集成，再为 mnemon 登记一次
- **THEN** `<userHomeDir>/.zshrc` 中 marker 起始行 `# >>> dsh-desktop codegraph >>>` 只出现一次
- **AND** 该块内的 PATH 目录仍是 `<homeDir>/bin`，不出现第二个 marker 块
- **AND** `.zshrc` 中除 `~/.dsh/bin` 外不再新增其他 PATH 条目

#### Scenario: 重复登记不重复写盘

- **WHEN** 以相同参数连续调用两次 shell 集成
- **THEN** 第二次调用返回的 `changed` 为 `false`
- **AND** shell 配置内容与第一次调用后完全相同

#### Scenario: 保留用户已有内容

- **WHEN** shell 配置中已存在用户自己的内容与既有 marker 块
- **THEN** 用户内容原样保留，marker 块被更新为最新内容而不是追加第二份
- **AND** 更新前生成一份 `.dsh-backup-*` 备份文件

#### Scenario: 卸载时移除自身痕迹

- **WHEN** 调用 shell 集成的卸载入口
- **THEN** `<homeDir>/bin/mnemon` 被删除
- **AND** marker 块及其前一行的分隔空行从 shell 配置中移除，用户其余内容不变

### Requirement: Windows 安装时写入用户 PATH

Windows 安装器必须在本用户 PATH 中登记安装目录下的 mnemon `bin` 目录，不写机器级 PATH、不申请管理员权限；卸载时只有在条目仍位于末尾时才移除。

#### Scenario: 安装时登记

- **WHEN** 安装目录下存在 `resources\mnemon\bin\mnemon.exe`
- **THEN** `build/installer.nsh` 的 `customInstall` 在 `HKCU\Environment` 的 `Path`（REG_EXPAND_SZ）末尾追加该目录
- **AND** 追加前把原值备份到 `HKCU\Software\${PRODUCT_NAME}\PathBackup`
- **AND** 追加后广播 `WM_WININICHANGE`

#### Scenario: 已登记时不重复追加

- **WHEN** 用户 PATH 中已包含该 mnemon 目录字符串
- **THEN** 安装器不修改 PATH

#### Scenario: 卸载时按位置判断

- **WHEN** 卸载时该 mnemon 目录仍是 PATH 的最后一项
- **THEN** 安装器移除该条目
- **AND** 若用户已把它移到别处，则保留不动

#### Scenario: 未随包分发时不动 PATH

- **WHEN** 安装目录下不存在 `resources\mnemon\bin\mnemon.exe`
- **THEN** 安装器不修改 PATH

#### Scenario: codegraph 分支保持不变

- **WHEN** 读取 `build/installer.nsh`
- **THEN** 原有 codegraph 的安装/卸载分支仍完整存在（`DSH_CODEGRAPH_BIN`、`FileExists`、`StrContains`、安装段末尾位置判断）
- **AND** `WriteRegExpandStr HKCU "Environment" "Path"` 在文件中恰好出现四次——安装两次（codegraph、mnemon 各一次）、卸载两次（各一次）。新增分支必然改变原「恰好两次」的计数，故该断言按 design.md 决策同步为四，而非放宽为「至少两次」

### Requirement: 平台归档可追溯

社区用户与维护者必须能从仓库直接确认内置的是哪个版本的 mnemon CLI 及其许可证。

#### Scenario: 归档命名与版本

- **WHEN** 列出 `vendor/mnemon/` 目录
- **THEN** 其中含 `mnemon-darwin-arm64-0.2.9.tgz` 与 `mnemon-win32-x64-0.2.9.tgz`
- **AND** 两者的 `package.json` 中 `license` 均为 `Apache-2.0`、`name` 均为 `@mnemon-dev/mnemon`

#### Scenario: 生成物不入库

- **WHEN** 读取仓库根 `.gitignore`
- **THEN** 其中含 `dsh-plugin-desktop/build/mnemon/` 与 `dsh-plugin-desktop-beta/build/mnemon/`

#### Scenario: 文档说明

- **WHEN** 查阅 `docs/` 下 mnemon CLI 内置方案文档
- **THEN** 该文档说明归档来源与版本、两个平台的 PATH 机制差异、安装体积增量、验证命令与回滚方式
