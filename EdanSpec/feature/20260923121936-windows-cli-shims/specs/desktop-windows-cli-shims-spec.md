# Windows 终端 CLI shim 规格

## ADDED Requirements

### Requirement: Windows 转发 shim 生成

Windows 上 Host 启动时**必须**在 `<homeDir>\bin` 中为每个已发布的 CLI 生成一个 `.cmd` 转发 shim。shim 内容**必须**是引用包内真实 launcher 绝对路径的转发脚本，而不是二进制副本或上游 `.cmd` 的复制件。

#### Scenario: 生成 mnemon shim

- **WHEN** 以 `homeDir`、`launchers` 中的 `{ name: 'mnemon', launcherPath: '<bundleDir>\\bin\\mnemon.exe' }` 调用 shell 集成
- **THEN** `<homeDir>\bin\mnemon.cmd` 存在，内容含该 `mnemon.exe` 的绝对路径
- **AND** shim 内容不含 mnemon 可执行文件的字节内容（即不是拷贝）

#### Scenario: 生成 codegraph shim

- **WHEN** 以 `launcherPath` 指向 `<bundleDir>\\lib\\dist\\bin\\codegraph.js` 调用 shell 集成
- **THEN** `<homeDir>\bin\codegraph.cmd` 存在，内容同时含 `<bundleDir>\\node.exe` 与 `codegraph.js` 的绝对路径
- **AND** shim 不引用 `%~dp0` 相对路径
- **AND** shim 内容与上游 `bin\\codegraph.cmd` 不相同

#### Scenario: 拒绝会逃逸的裸命令名

- **WHEN** `launchers` 中出现含路径分隔符或 `..` 的 `name`
- **THEN** 调用抛出错误，且不写出任何 shim 文件

### Requirement: shim 内容比对式幂等更新

shim 的写入判据**必须**是「盘上现有内容与期望内容是否相同」，**不得**是「文件是否存在」。路径每次调用时重新推导，使安装目录变更、版本升级、便携版更换解压位置都能被自动修正。

#### Scenario: 重复调用不写盘

- **WHEN** 以完全相同的参数连续调用两次
- **THEN** 第二次返回的 `changed` 为 `false`
- **AND** shim 内容与权限与第一次调用后完全相同

#### Scenario: 路径变化时覆盖旧 shim

- **WHEN** 盘上已存在指向旧安装目录的 `codegraph.cmd`，以新的 `launcherPath` 再次调用
- **THEN** `codegraph.cmd` 内容被更新为指向新路径
- **AND** 返回的 `changed` 为 `true`
- **AND** 不残留指向旧路径的内容

#### Scenario: 已存在的 shim 不会被跳过

- **WHEN** 盘上存在一个同名但内容为空或内容过期的 `mnemon.cmd`
- **THEN** 该文件被覆盖为正确的转发内容

### Requirement: Windows PATH 登记走 ExpandString

把 `<homeDir>\bin` 登记进用户 PATH 时，**必须**保持该值为 `REG_EXPAND_SZ`。**不得**使用 `setx`（会固化 `%VAR%` 并在 1024 字符处截断），**不得**经 `reg.exe` 读改写（会把 `REG_EXPAND_SZ` 展开后写成普通字符串）。

#### Scenario: 保留原有变量引用

- **WHEN** 用户 PATH 当前含 `%USERPROFILE%\bin`，执行登记
- **THEN** 写回后该 `%USERPROFILE%` 仍是字面变量引用，未被展开为绝对路径
- **AND** 注册表值类型仍为 `REG_EXPAND_SZ`

#### Scenario: 查重后不重复追加

- **WHEN** 用户 PATH 中已包含 `.dsh\bin` 条目，再次执行登记
- **THEN** PATH 值不变

#### Scenario: 登记后广播变更

- **WHEN** PATH 登记成功且值确实发生变化
- **THEN** 广播 `WM_SETTINGCHANGE`（`0x001A`）且 `lParam` 为 `Environment`

### Requirement: PATH 登记可撤销

登记操作**必须**提供反向操作，从用户 PATH 中移除自身条目，且不改动用户其余 PATH 内容。

#### Scenario: 移除自身条目

- **WHEN** 用户 PATH 含 `.dsh\bin` 条目及若干其他条目，执行撤销
- **THEN** 用户 PATH 中不再含该条目
- **AND** 其余条目内容与顺序不变

#### Scenario: 未登记时撤销无副作用

- **WHEN** 用户 PATH 中不含该条目，执行撤销
- **THEN** PATH 值不变，不抛错

### Requirement: 便携版首次启动一次性提示

应用**必须**能判断自身是否为未登记安装的便携版，并对便携版用户给出一次性的登记引导。判断**不得**依赖安装目录路径的形状猜测。

#### Scenario: 无安装记录时提示

- **WHEN** 启动时在 `HKCU` 的卸载信息键与自身 `Software\<PRODUCT_NAME>` 键下都读不到安装记录
- **THEN** 应用判定为便携版，展示邀请用户登记 `.dsh\bin` 到 PATH 的提示

#### Scenario: 有安装记录时不提示

- **WHEN** `HKCU` 下存在本产品的卸载信息键（安装版已登记）
- **THEN** 应用不展示便携版提示

#### Scenario: 提示只出现一次

- **WHEN** 用户已对提示做出选择（接受或忽略），应用再次启动
- **THEN** 该提示不再出现
- **AND** 状态记录写在应用数据目录下，而非注册表

### Requirement: 设置中的可重复入口

设置面板**必须**提供一个可重复触发的命令行工具入口，使用户在更换解压目录后能自行修正登记。

#### Scenario: 从设置重新登记

- **WHEN** 用户在设置面板触发该入口
- **THEN** 应用重新生成 `<homeDir>\bin` 下的 shim 并执行 PATH 登记
- **AND** 界面反馈执行结果

#### Scenario: 从设置撤销登记

- **WHEN** 用户在设置面板触发撤销
- **THEN** PATH 中的自身条目被移除，界面反馈结果

#### Scenario: 入口不限安装形态

- **WHEN** 该入口被触发的环境是安装版而非便携版
- **THEN** 操作照常执行，不因安装形态而被拒绝

### Requirement: shim 生成失败不阻断启动

shim 生成与 PATH 登记属于改善项，**不得**因失败而阻止应用进入主窗口。

#### Scenario: 生成失败时继续启动

- **WHEN** shim 生成过程中抛出任何异常
- **THEN** Host 启动流程继续执行，异常以错误日志记录
- **AND** 应用仍能进入主界面

#### Scenario: 单个 launcher 不可用时跳过

- **WHEN** 打包的某个 CLI 因架构不匹配等原因未能发布
- **THEN** 只为实际发布成功的 launcher 生成 shim
- **AND** 不为该 CLI 生成指向不存在路径的 shim

### Requirement: macOS 行为保持不变

本次变更**不得**改变 macOS 上的 shim 内容、shim 目录、shell profile 块或 `.zshrc` 处理逻辑。

#### Scenario: mac 产物不变

- **WHEN** 在 macOS 上以相同参数调用 shell 集成
- **THEN** `<homeDir>/bin/<name>` 仍是 `#!/bin/sh` 开头的三行 POSIX 转发脚本
- **AND** 写入的仍是 `<userHomeDir>/.zshrc` 中的 marker 块
- **AND** 不产生任何 `.cmd` 文件
