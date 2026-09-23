# Mnemon CLI 内置规格

## MODIFIED Requirements

### Requirement: Windows 终端可直接使用 mnemon

Windows 上 Mnemon CLI 的终端可见性**必须**由应用启动时生成的转发 shim 提供，而不是由安装器把安装目录下的 `resources\mnemon\bin` 写进用户 PATH。安装版与便携版**必须**使用同一个 shim 目录和同一条 PATH 条目。

原行为：`build/installer.nsh` 的 `customInstall` 把 `<安装目录>\resources\mnemon\bin` 追加到 `HKCU\Environment\Path`（`installer.nsh:144-162`），卸载时按末尾位置判断移除（`installer.nsh:169-180`）。
新行为：应用启动时在 `<homeDir>\bin` 生成 `mnemon.cmd` 转发 shim，内容指向包内 `mnemon.exe` 的绝对路径；`mnemon.exe` 本身是自包含单文件，但**不复制**到 shim 目录，以保证随版本升级。

#### Scenario: 生成 mnemon shim

- **WHEN** Windows 上 Host 启动且包内 `resources\mnemon` 通过架构校验
- **THEN** `<homeDir>\bin\mnemon.cmd` 存在，内容引用包内 `bin\mnemon.exe` 的绝对路径
- **AND** `<homeDir>\bin` 下不存在 `mnemon.exe` 副本

#### Scenario: 升级后 shim 指向新二进制

- **WHEN** 应用升级到内置更高版本 mnemon 的新包，用户启动一次新版本后执行 `mnemon --version`
- **THEN** 输出新包内 mnemon 的版本号，而非旧版本

#### Scenario: 便携版终端可用

- **WHEN** 便携版用户完成登记后新开终端执行 `mnemon --version`
- **THEN** 命令解析到 shim 并输出 `mnemon version 0.2.9`

#### Scenario: 与 codegraph 共用同一目录与同一条 PATH 条目

- **WHEN** codegraph 与 mnemon 的 shim 都已生成
- **THEN** 两者位于同一个 `<homeDir>\bin` 目录
- **AND** 用户 PATH 中该目录只出现一次

### Requirement: 卸载时的 PATH 清理

Windows 卸载时**必须**移除 `.dsh\bin` 这一条 PATH 条目；该条目是安装器写入的唯一条目，不再有第二条指向安装目录的条目需要处理。

原行为：`customUnInstall` 先按末尾位置移除 mnemon 的 `resources\mnemon\bin`，再移除 codegraph 的 `resources\codegraph\bin`，两条互为镜像以匹配安装顺序。
新行为：`customUnInstall` 只处理 `.dsh\bin` 一条。shim 文件本身留在 `<homeDir>\bin`，因为该目录属于用户数据目录而非安装目录。

#### Scenario: 卸载移除 PATH 条目

- **WHEN** 执行卸载且 `.dsh\bin` 仍位于 PATH 末尾
- **THEN** `HKCU\Environment\Path` 中该条目被移除
- **AND** 其余 PATH 内容不变

#### Scenario: 卸载不动用户数据目录

- **WHEN** 执行卸载
- **THEN** `<homeDir>\bin` 下的 shim 文件不被安装器删除
- **AND** 卸载流程不写入 `HKCU\Environment` 之外的位置

#### Scenario: 条目已被移到别处时保留

- **WHEN** 用户已把 `.dsh\bin` 条目移到 PATH 中间位置
- **THEN** 卸载器不改动 PATH，保留用户安排
