# Windows 终端 CLI 统一 shim 目录提案

## Why

Windows 上 `codegraph` 与 `mnemon` 在用户自己的终端里能否解析，取决于安装方式，两条路径互不一致：

- **安装版**：`build/installer.nsh` 的 `customInstall` 把 `<安装目录>\resources\codegraph\bin` 与 `<安装目录>\resources\mnemon\bin` 两个目录**分别**追加到 `HKCU\Environment\Path`（`installer.nsh:104-163`）。用户 PATH 里于是多出两条指向安装目录的条目。
- **便携版**：electron-builder 对 portable 目标**不注入**自定义 include（`NsisTarget.js` 的 `if (!this.isPortable)` 分支），且便携版本来就没有安装流程。文档明确写着「便携版用户只能用应用内的 codegraph」（`docs/build-custom-client.zh.md:362`）。

同时，macOS 侧早已用另一套做法解决了同一个问题，且做得更彻底：`desktop-cli-shell.ts` 把每个 CLI 生成为一个**转发 shim** 写进 `~/.dsh/bin`，再在 shell profile 里写一段 marker 包裹的 PATH 块。shim 只有 172–178 字节，内容是 `exec '<app bundle 内真实 launcher 绝对路径>' "$@"`，因此**升级装了新版 app 后 shim 自动指向新二进制**——这是「跟随升级」成立的机制。

于是有三个可改进点：

1. **便携版在终端里完全不可用**，与安装版能力不对等。
2. **安装版把安装目录写进 PATH**，带来三个连带问题：用户若把应用装到 `C:\Program Files\...`，该目录不可写；NSIS 升级时旧卸载器 `RMDir /r $INSTDIR`（`uninstaller.nsh:187`）会清空该目录；便携版被删目录后 PATH 残留死条目。
3. **两个平台两套约定**，Windows 的 CLI 发布逻辑与 shim 逻辑都不能复用 mac 已有实现。

本次变更把 Windows 收敛到与 mac 相同的模型：**统一 shim 目录 + 转发 shim + 一次性 PATH 登记**，安装版与便携版产物一致，仅触发时机不同。

## What Changes

- 新增 Windows 分支到 `desktop-cli-shell.ts`：为 `codegraph` 与 `mnemon` 生成 `.cmd` 转发 shim，落在 `<homeDir>\bin`（默认即 `%USERPROFILE%\.dsh\bin`），写入策略与 mac 一致——**内容比对后覆盖**，而非「不存在才新建」。
- `codegraph` 的 shim 直接调用包内自带的 `node.exe` 与 `lib\dist\bin\codegraph.js`，**不复制**上游 `bin\codegraph.cmd`（后者靠 `%~dp0..` 反查，复制即断链）。
- `main.ts:742` 的平台判断由 `=== 'darwin'` 放开为 darwin + win32，使 Host 启动时自动生成并修复 shim。
- `build/installer.nsh` 的 PATH 目标由两个 `resources\<cli>\bin` 改为单一的 `.dsh\bin`（`$PROFILE\.dsh\bin`），安装与卸载分支同步收敛为一条；`WriteRegExpandStr HKCU "Environment" "Path"` 出现次数由四次改为两次。
- 新增便携版首次启动的一次性提示：检测到本机没有安装记录时，引导用户确认把 `.dsh\bin` 登记进用户 PATH。
- 新增设置里的可重复入口：任何时候可重新执行或撤销该登记，便于便携版换解压目录后修正。
- PATH 写入统一走 PowerShell 的 `[Microsoft.Win32.Registry]` + `RegistryValueKind.ExpandString`，避免 `reg.exe` 展开 `REG_EXPAND_SZ`、也避免 `setx` 固化 `%USERPROFILE%` 与 1024 字符截断。
- `dsh` 命令**不搬**，保持现有 per-profile 的内容寻址 generation 目录。

### 不在本次范围

- **`dsh` 命令的部署形态**：它是 per-profile 的（`DSH_DESKTOP_DEFAULT_PROFILE` 随 profile 变化），放进全局单份 shim 会破坏多 profile 隔离。mac 侧 `~/.dsh/bin` 里同样没有 `dsh`，本次沿用这一划分。
- **安装版的 shim 由谁生成**：installer.nsh 只负责写 PATH，shim 仍由应用启动时生成（与 mac 一致）。装完不开应用时 `.dsh\bin` 不存在，PATH 指向空目录由 Windows 自行跳过，开一次应用即补齐。
- **macOS / Linux 行为**：mac 侧已有的 shim 与 profile 逻辑不变；Linux 不在本次范围（由 `20260921191517-linux-appimage` feature 处理）。
- **`resources\<cli>\bin` 的目录布局**：`build.extraResources` 与运行时 `process.resourcesPath` 解析路径均不改动。
- **codegraph 索引位置**：索引落在各项目根的 `.codegraph/`，与 PATH 上的命令目录无关。

## Capabilities

### New Capabilities

- `desktop-windows-cli-shims`：Windows 侧的终端 CLI 发布链路——`.cmd` 转发 shim 的生成与内容比对式幂等更新、`.dsh\bin` 的 PATH 登记与撤销、便携版首次启动提示与设置入口、以及不依赖版本号或安装形态判断的自愈能力。

### Modified Capabilities

- `codegraph-cli-bundling`：Windows 上 CodeGraph CLI 的终端可见性由「安装时把 `<安装目录>\resources\codegraph\bin` 写入用户 PATH」改为「应用启动时在 `<homeDir>\bin` 生成转发 shim，PATH 只登记这一个目录」。安装版与便携版行为收敛。
- `mnemon-cli-bundling`：同上。原需求「Windows 安装时写入用户 PATH」中登记的目录由 `resources\mnemon\bin` 改为 `.dsh\bin`，且卸载清理由「按末尾位置判断两个条目」简化为单条目；`WriteRegExpandStr HKCU "Environment" "Path"` 的计数断言由四次改为两次。

## Impact

- `dsh-plugin-desktop{,-beta}/src/desktop-cli-shell.ts`：新增 win32 分支（`.cmd` shim 渲染、`.cmd` 专用转义、PATH 登记 / 撤销、便携版检测），现有 POSIX 分支保持不变
- `dsh-plugin-desktop{,-beta}/src/main.ts`：`742` 行平台判断放开为 darwin + win32
- `dsh-plugin-desktop{,-beta}/build/installer.nsh`：PATH 目标改为 `.dsh\bin`，安装 / 卸载分支各收敛为一条，`customUnInstall` 同步简化
- `dsh-plugin-desktop{,-beta}/src/desktop-settings-contract.ts`：新增 CLI 注册 / 撤销的设置 API 路径与请求响应类型
- `dsh-plugin-desktop{,-beta}/src/desktop-settings-controller.ts`、`src/desktop-settings-route.ts`、`src/index.ts`：接入上述设置 API
- `dsh-plugin-desktop{,-beta}/src/client/`：设置面板新增命令行工具入口（注册 / 修复 / 移除）
- `dsh-plugin-desktop{,-beta}/tests/`：`desktop-cli-shell.spec.ts` 新增 Windows 用例，`installer-nsh.spec.ts` 断言目标与计数调整
- `docs/build-custom-client.zh.md`、`docs/bundle-codegraph-cli.zh.md`、`docs/bundle-mnemon-cli.zh.md`、`README.md`：更新 Windows 终端可用性说明与便携版指引

### 待确认的未验证项

以下涉及 Windows 实际行为，本机为 macOS，**尚未实测**，需在 Windows 上验证（详见 design.md 风险章节）：升级覆盖后的 shim 自愈、改安装目录 / 换便携版解压位置后的修正、多 profile 并行启动、含中文的用户目录与安装路径下 `.cmd` 的 OEM 代码页解析。
