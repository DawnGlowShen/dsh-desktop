# CodeGraph CLI 内置规格

## MODIFIED Requirements

### Requirement: Windows 终端可直接使用 codegraph

Windows 上 CodeGraph CLI 的终端可见性**必须**由应用启动时生成的转发 shim 提供，而不是由安装器把安装目录下的 `resources\codegraph\bin` 写进用户 PATH。安装版与便携版**必须**使用同一个 shim 目录和同一条 PATH 条目。

原行为：`build/installer.nsh` 的 `customInstall` 把 `<安装目录>\resources\codegraph\bin` 追加到 `HKCU\Environment\Path`（`installer.nsh:107-134`），卸载时按末尾位置判断移除（`installer.nsh:186-198`）。便携版没有安装流程，终端里完全不可用；安装版则把安装目录本身暴露进 PATH。
新行为：应用启动时在 `<homeDir>\bin`（默认 `%USERPROFILE%\.dsh\bin`）生成 `codegraph.cmd` 转发 shim，PATH 中只登记这一个与安装位置无关的目录。安装器与便携版首次启动提示都指向同一目录。

#### Scenario: 生成 codegraph shim

- **WHEN** Windows 上 Host 启动且包内 `resources\codegraph` 通过架构校验
- **THEN** `<homeDir>\bin\codegraph.cmd` 存在，内容引用包内 `node.exe` 与 `lib\dist\bin\codegraph.js`
- **AND** PATH 中不出现 `<安装目录>\resources\codegraph\bin`

#### Scenario: 便携版终端可用

- **WHEN** 未安装的便携版用户在设置中确认登记，随后新开一个终端执行 `codegraph --version`
- **THEN** 命令解析到 shim 并输出 `1.6.0`

#### Scenario: 安装版终端可用（回归）

- **WHEN** 用户通过 NSIS 安装器安装，随后新开一个终端执行 `codegraph --version`
- **THEN** 命令解析到 shim 并输出 `1.6.0`

#### Scenario: 升级后 shim 自动指向新位置

- **WHEN** 应用升级到新版本且安装目录发生变化，用户启动一次新版本后再执行 `codegraph --version`
- **THEN** shim 内容已更新为新安装目录下的路径
- **AND** 命令正常输出新版本的版本号

#### Scenario: 不复制上游 codegraph.cmd

- **WHEN** 读取生成的 `codegraph.cmd`
- **THEN** 其内容不引用 `%~dp0`，也不等于 `<bundleDir>\bin\codegraph.cmd` 的内容

### Requirement: Windows 安装器写 PATH 的目标为 shim 目录

`build/installer.nsh` 的 `customInstall` **必须**把 `.dsh\bin` 写入 `HKCU\Environment\Path`，而不是各 CLI 在安装目录下的 `bin` 子目录。卸载时**必须**移除该条目。

原行为：安装分支两条，分别追加 `resources\codegraph\bin` 与 `resources\mnemon\bin`；卸载分支两条，各自按末尾位置判断移除；`WriteRegExpandStr HKCU "Environment" "Path"` 在文件中恰好出现四次。
新行为：安装分支一条，追加 `$PROFILE\.dsh\bin`；卸载分支一条，移除同一值；`WriteRegExpandStr HKCU "Environment" "Path"` 在文件中恰好出现两次。

#### Scenario: 安装时登记 shim 目录

- **WHEN** 执行 `customInstall`
- **THEN** `HKCU\Environment` 的 `Path`（`REG_EXPAND_SZ`）末尾被追加 `$PROFILE\.dsh\bin`
- **AND** 追加前把原值备份到 `HKCU\Software\${PRODUCT_NAME}\PathBackup`（仅首次）
- **AND** 追加后广播 `WM_WININICHANGE`

#### Scenario: 已登记时不重复追加

- **WHEN** 用户 PATH 中已包含 `.dsh\bin` 条目
- **THEN** 安装器不修改 PATH

#### Scenario: 卸载时移除自身条目

- **WHEN** 执行 `customUnInstall` 且该条目仍位于 PATH 末尾
- **THEN** 该条目被移除
- **AND** 若用户已把它移到别处，则保留不动

#### Scenario: 不再登记安装目录

- **WHEN** 读取 `build/installer.nsh`
- **THEN** 文件中不出现 `resources\codegraph\bin` 作为 PATH 登记目标
- **AND** `WriteRegExpandStr HKCU "Environment" "Path"` 恰好出现两次

#### Scenario: 两个变体一致

- **WHEN** 比较 `dsh-plugin-desktop/build/installer.nsh` 与 `dsh-plugin-desktop-beta/build/installer.nsh`
- **THEN** 两者内容相同
