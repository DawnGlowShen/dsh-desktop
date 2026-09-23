# 任务清单 — Windows 终端 CLI 统一 shim 目录

## 概述

把 Windows 的 `codegraph` / `mnemon` 终端发布从「安装器把安装目录下的两个 bin 写进 PATH」改为与 macOS 同构的「应用启动时在 `<homeDir>\bin` 生成转发 shim + 只登记这一个目录」。安装版与便携版共用同一目录与同一条 PATH 条目，并为便携版提供首次启动提示与设置里的可重复入口。

---

## 全局约定

### 失败策略

同一增量的修复尝试次数触及阈值时，自动升级应对：

| 连续修复失败次数 | 动作 |
|------------------|------|
| 2 次 | 停止当前增量，调用 `edanspec-debugging` 定位根因 |
| 3 次 | 调用 `edanspec-explore` 重新审视方案 |
| 4 次 | 停止并报告用户，等待决策 |

### 覆盖率说明

本仓库未接入覆盖率工具（`@vitest/coverage-v8` 与 `@vitest/coverage-istanbul` 均未安装于根目录或各工作区）。因此各任务的完成判定改为**穷举分支的行为断言**：新增模块的单测必须覆盖每个错误分支（非法 launcher 名、内容相同不写盘、PATH 值不变不写注册表、注册表键缺失、PowerShell 失败），由 `vitest run` 全量执行。待仓库引入覆盖率工具后另行补齐阈值断言。

### 变体同步约定

依据根 `AGENTS.md:18`：Desktop 共享改动**先在 `dsh-plugin-desktop-beta/` 落地验证**，再同步到 `dsh-plugin-desktop/`。`scripts/verify-desktop-variants.mjs:10` 强制要求两包 `src/` 逐字节一致（仅 `product-identity.ts` 例外），因此同步不是可选项。

### Windows 行为不可在本机验证

开发机为 macOS，Windows 注册表与 `.cmd` 执行行为**无法在本机真实运行**。因此：

- 涉及注册表与进程调用的代码必须把外部访问抽成**可注入的窄接口**，单测注入假实现；
- 所有「真机才能确认」的结论一律不写进验收标准，统一收敛到 Task-013 之前的人工验证清单（见 `design.md` 的「需在 Windows 上实测的验证清单」）；
- 任何声称「Windows 上可用」的交付物必须带有对应的假实现单测，否则视为未完成。

---

## 架构决策

- 技术栈：TypeScript ESM + Node `^22.19.0` / `>=24.0.0`，测试用 Vitest；PATH 写入经 PowerShell 的 `[Microsoft.Win32.Registry]` 接口
- 架构模式：shim 生成（纯文件操作）与 PATH 登记（外部注册表操作）分为两个模块，后者依赖注入
- 关键决策：**shim 写入判据是内容比对而非存在性检查**（`design.md` 决策三）。这样覆盖安装、原地升级、换安装目录、便携版换解压位置四种场景全部自愈，无需版本号检测
- 关键决策：**PATH 目标收敛为 `<homeDir>\bin` 单一目录**（`design.md` 决策一）。安装器与便携版提示写同一个值，`WriteRegExpandStr HKCU "Environment" "Path"` 计数由 4 降为 2
- 关键约束：**`dsh` 命令不搬**。它是 per-profile 的，全局单份 shim 会破坏多 profile 隔离（`design.md` 范围排除）
- 关键约束：**不动 Linux 与 macOS 既有行为**。`20260921191517-linux-appimage`（state=active）正在改 release pipeline，本次不触碰其改动点

---

## 任务

### Task-001：Windows `.cmd` 转发 shim 的渲染与幂等写入

**描述**：在 `desktop-cli-shell.ts` 中新增 win32 分支，为每个 launcher 生成引用绝对路径的 `.cmd` 转发 shim，写入判据为内容比对。现有 POSIX 分支必须零改动。codegraph 的 shim 由 `launcherPath`（指向 `codegraph.js`）推导同级 `node.exe`，且**不得**引用 `%~dp0`、**不得**等于上游 `codegraph.cmd` 的内容。

**关联需求**：`specs/desktop-windows-cli-shims-spec.md` §Windows 转发 shim 生成、§shim 内容比对式幂等更新、§macOS 行为保持不变。
→ Agent：读取该 spec 确认 shim 内容要求、幂等判据与 mac 回归约束；`design.md` 决策二给出「不复制」的三条理由与替代方案对比。

**前置依赖**：无

**工时估算**：0.46 人天
- 基础：0.35 人天（S）
- 缓冲：0.35 × 20% × 1.5 = 0.105 人天（技术风险-中：批处理转义与路径含特殊字符的处理无先例可抄）
- 总计：0.46 人天
→ Agent：缓冲计算规则见 `references/risk-classification.md`。

**涉及文件**：
- `dsh-plugin-desktop-beta/src/desktop-cli-shell.ts` — 修改，新增 win32 渲染分支与 `.cmd` 转义，导出符号保持不变
- `dsh-plugin-desktop-beta/tests/desktop-cli-shell.spec.ts` — 修改，新增 Windows describe 块

**验收标准**：
- **生成转发 shim 且不复制二进制**：当以 `launcherPath` 为 `<bundle>\bin\mnemon.exe` 调用时，`<homeDir>\bin\mnemon.cmd` 存在且内容含该绝对路径；当 `launcherPath` 为 `<bundle>\lib\dist\bin\codegraph.js` 时，`codegraph.cmd` 内容同时含 `<bundle>\node.exe` 与该 js 路径。验证方式：`yarn workspace dsh-plugin-desktop-beta vitest run tests/desktop-cli-shell.spec.ts` 通过，且用例断言内容**不**含 `%~dp0`
- **内容比对式幂等**：当以完全相同参数连续调用两次时，第二次返回 `changed === false`；当盘上已存在指向旧目录的 shim 时，以新 `launcherPath` 调用后内容被覆盖且 `changed === true`。验证方式：同一测试文件中三条用例（重复调用、路径变化、空文件被覆盖）通过
- **macOS 行为零回归**：当平台为 darwin 时，shim 仍是三行 POSIX 脚本、仍写 `.zshrc` marker 块、且不产生任何 `.cmd`。验证方式：同一测试文件中原有 mac 用例全部通过且断言数与改动前一致

**增量计划**：
- [x] **增量 1**：`.cmd` 渲染函数
  - 做什么：新增 win32 渲染分支，输出 `@echo off` + 绝对路径命令行；为 codegraph 从 `launcherPath` 推导 `node.exe` 与 js 路径
  - 交付：可被单测直接断言内容的渲染函数
  - 对应验收标准：生成转发 shim 且不复制二进制
  - 完成判定：`yarn workspace dsh-plugin-desktop-beta vitest run tests/desktop-cli-shell.spec.ts` 通过 && `yarn workspace dsh-plugin-desktop-beta typecheck` 无错误
- [x] **增量 2**：win32 的 shim 文件名与写入路径
  - 做什么：win32 下 shim 文件名为 `<name>.cmd`，仍落在 `<homeDir>\bin`；保持内容比对判据
  - 交付：win32 安装路径可用
  - 对应验收标准：内容比对式幂等
  - 完成判定：同一测试文件通过（含重复调用与路径变化用例）
- [x] **增量 3**：mac 回归确认
  - 做什么：运行整个测试文件，确认 POSIX 分支用例未受影响；按 `verify-desktop-variants.mjs` 的规则确认未引入 `src/` 差异（此时只改 beta，stable 尚待 Task-011 同步，属预期）
  - 交付：mac 无回归的结论
  - 对应验收标准：macOS 行为零回归
  - 完成判定：`yarn workspace dsh-plugin-desktop-beta vitest run tests/desktop-cli-shell.spec.ts` 全绿且 mac 用例数与改动前相同

**失败策略**：见全局约定。若批处理转义在测试中难以穷举，先固定「路径不含 `"` 与 `%`」这一前提并在 spec 中显式声明，**不得**因此放宽断言。

---

### Task-002：Windows PATH 注册表登记与撤销模块

**描述**：新增独立模块负责把 `<homeDir>\bin` 登记进 / 移出 `HKCU\Environment\Path`，保持 `REG_EXPAND_SZ` 值类型，改动后广播 `WM_SETTINGCHANGE`。注册表读写与 PowerShell 调用必须通过可注入的窄接口进行，使单测能在 macOS 上覆盖全部分支。

**关联需求**：`specs/desktop-windows-cli-shims-spec.md` §Windows PATH 登记走 ExpandString、§PATH 登记可撤销。
→ Agent：读取该 spec 确认 `REG_EXPAND_SZ` 保型要求、查重语义、广播参数与撤销的"其余条目不变"约束。

**前置依赖**：无（与 Task-001 无文件交集）

**工时估算**：0.44 人天
- 基础：0.3 人天（S）
- 缓冲：0.3 × 30% × 1.5 = 0.135 人天（依赖风险-中：依赖 PowerShell 与 .NET 注册表接口，本机无法真实执行，接口形态需一次成型）
- 总计：0.44 人天
→ Agent：缓冲计算规则见 `references/risk-classification.md`。

**涉及文件**：
- `dsh-plugin-desktop-beta/src/desktop-windows-path.ts` — 新增，PATH 读写的纯逻辑 + 可注入执行器
- `dsh-plugin-desktop-beta/tests/desktop-windows-path.spec.ts` — 新增，覆盖全部分支

**验收标准**：
- **登记保持值类型、查重、且不用被排除的手段**：当用户 PATH 为 `%USERPROFILE%\bin;C:\Tools` 且不含目标目录时，登记后写入的字符串末尾追加目标目录、`%USERPROFILE%` 仍为字面变量引用、值类型仍为 `EXPAND_STRING`；当 PATH 已含目标目录时执行登记，写入不发生；该模块产生的命令文本不出现 `setx`，也不经 `reg.exe` 读改写。验证方式：`yarn workspace dsh-plugin-desktop-beta vitest run tests/desktop-windows-path.spec.ts` 通过（注入的假执行器记录到的调用序列与值类型符合预期，且断言命令文本 `not.toContain('setx')`、`not.toContain('reg ')`）；`grep -rn "setx" dsh-plugin-desktop-beta/src/desktop-windows-path.ts` 无输出
- **撤销只移除自身条目**：当 PATH 含目标目录及若干其他条目时，撤销后目标条目消失且其余条目的内容与顺序逐字符不变；当 PATH 不含目标条目时执行撤销，不产生写入且不抛错。验证方式：同一测试文件中的两条撤销用例通过
- **失败不静默**：当注入的执行器返回非零退出码时，模块抛出带 `dsh-plugin-desktop:` 前缀的错误，而不是返回成功。验证方式：同一测试文件中的失败分支用例通过

**增量计划**：
- [x] **增量 1**：可注入执行器接口与假实现
  - 做什么：定义读 PATH / 写 PATH 的接口（含值类型与广播），实现 PowerShell 版本，测试注入记录型假实现
  - 交付：接口 + 真实实现 + 假实现
  - 对应验收标准：失败不静默
  - 完成判定：`yarn workspace dsh-plugin-desktop-beta vitest run tests/desktop-windows-path.spec.ts` 通过 && `yarn workspace dsh-plugin-desktop-beta typecheck` 无错误
- [x] **增量 2**：登记路径（查重 + 追加 + 备份语义 + 广播）
  - 做什么：实现登记逻辑，PATH 未变化时不写盘
  - 交付：可用的登记函数
  - 对应验收标准：登记保持值类型、查重、且不用被排除的手段
  - 完成判定：同一测试文件通过（含"已含目标目录"用例与命令文本否定断言）
- [x] **增量 3**：撤销路径
  - 做什么：实现撤销逻辑，只移除自身条目
  - 交付：可用的撤销函数
  - 对应验收标准：撤销只移除自身条目
  - 完成判定：同一测试文件全部通过

**失败策略**：见全局约定。若 PowerShell 的 .NET 注册表调用在目标系统上不可用（执行策略等），停下来报告用户——这是 `design.md` 决策四的替代方案对比中已知的主要短板，不得擅自改用 `setx`。

---

### Task-003：检查点 1 — shim 与 PATH 内核

**类型**：检查点
**触发条件**：Task-001、Task-002 完成

**验证项**（仅包含可自动验证项）：
- [x] 类型检查：`yarn workspace dsh-plugin-desktop-beta typecheck` 无错误
- [x] 测试：`yarn workspace dsh-plugin-desktop-beta vitest run tests/desktop-cli-shell.spec.ts tests/desktop-windows-path.spec.ts` 全部通过
- [x] 分支穷举：上述两个测试文件的用例数较改动前分别增加 ≥4 与 ≥6，覆盖「重复调用不写盘」「路径变化覆盖」「非法名被拒」「已含条目不重复写」「撤销不动其余条目」「执行器失败抛错」
- [x] 依赖变更：`git diff --stat dsh-plugin-desktop-beta/package.json` 为空（未引入新的第三方依赖）
- [x] 手段排除：`grep -rn "setx\|reg add\|reg query" dsh-plugin-desktop-beta/src/desktop-windows-path.ts dsh-plugin-desktop-beta/src/desktop-cli-shell.ts` 无输出

→ Agent：检查点作为 Task 类别参与统一编号，与开发任务按实施顺序交替排列。

**工时估算**：0.15 人天
- 基础：0.15 人天（XS）
- 缓冲：无（纯执行既有命令）
- 总计：0.15 人天

---

### Task-004：`installer.nsh` 的 PATH 目标收敛为 `.dsh\bin`

**描述**：把 `customInstall` 的两条分支（分别追加 `resources\codegraph\bin` 与 `resources\mnemon\bin`）合并为一条，追加 `$PROFILE\.dsh\bin`；`customUnInstall` 相应对称简化。保留既有的 HKCU-only、查重、`PathBackup`、`WriteRegExpandStr`、广播五条约定。两个变体的该文件必须逐字节相同。

**关联需求**：`specs/codegraph-cli-bundling-spec.md` §Windows 安装器写 PATH 的目标为 shim 目录；`specs/mnemon-cli-bundling-spec.md` §卸载时的 PATH 清理。
→ Agent：读取两份 spec 确认目标值、备份时机、"不登记安装目录"与计数断言。

**前置依赖**：无（仅改 `.nsh` 与测试，与 Task-001/002 无文件交集）

**工时估算**：0.30 人天
- 基础：0.25 人天（XS）
- 缓冲：0.25 × 20% × 1 = 0.05 人天（业务风险-低：改动是删减与替换，行为边界清楚）
- 总计：0.30 人天
→ Agent：缓冲计算规则见 `references/risk-classification.md`。

**涉及文件**：
- `dsh-plugin-desktop-beta/build/installer.nsh` — 修改，两条 PATH 分支合并为一条，目标改为 `$PROFILE\.dsh\bin`
- `dsh-plugin-desktop-beta/tests/installer-nsh.spec.ts` — 修改，计数断言由 4 改为 2，登记目标断言更新

**验收标准**：
- **登记目标为 shim 目录且写入次数收敛为两次**：当检查安装分支时，写入值为 `$PROFILE\.dsh\bin`，文件中不再出现 `resources\codegraph\bin` 作为 PATH 登记目标，且 `WriteRegExpandStr HKCU "Environment" "Path"` 恰好出现 2 次（安装一次、卸载一次）。验证方式：`yarn workspace dsh-plugin-desktop-beta vitest run tests/installer-nsh.spec.ts` 通过（含计数断言）；`grep -c 'WriteRegExpandStr HKCU "Environment" "Path"' dsh-plugin-desktop-beta/build/installer.nsh` 输出为 2
- **安全约定未被削弱**：当检查该文件时，不出现 `setx` 与 `WriteRegStr HKCU "Environment"`，且 `PathBackup` 仍走 `WriteRegExpandStr`、仍仅在首次写入。验证方式：同一测试文件中既有断言全部保留并通过
- **对运行中应用的处理不变**：当检查 `customCheckAppRunning` 时，`$R1 < 60`、`Sleep 500`、`KILL_PROCESS` 两类调用与 `--dsh-installer-quit` 链路仍在。验证方式：同一测试文件中 `Windows NSIS running-app handoff` describe 全部通过

**增量计划**：
- [x] **增量 1**：合并安装分支
  - 做什么：删除 mnemon 独立分支，保留一条追加 `$PROFILE\.dsh\bin` 的分支，简化 `PathBackup` 的"仅首次"判断（单写入点后不再需要 `$6` 检查）
  - 交付：新的 `customInstall`
  - 对应验收标准：登记目标为 shim 目录且写入次数收敛为两次
  - 完成判定：`yarn workspace dsh-plugin-desktop-beta vitest run tests/installer-nsh.spec.ts` 通过
- [x] **增量 2**：简化卸载分支
  - 做什么：删除 mnemon 卸载分支，保留一条对 `$PROFILE\.dsh\bin` 的末尾位置判断
  - 交付：新的 `customUnInstall`
  - 对应验收标准：登记目标为 shim 目录且写入次数收敛为两次
  - 完成判定：同一测试文件通过（含计数断言）
- [x] **增量 3**：测试断言同步与安全约定复核
  - 做什么：把计数断言从 4 改为 2、更新目标断言；确认 `setx` / `WriteRegStr` 的否定断言与 handoff describe 未动
  - 交付：更新后的测试文件
  - 对应验收标准：安全约定未被削弱、对运行中应用的处理不变
  - 完成判定：同一测试文件全绿

**失败策略**：见全局约定。若 `$PROFILE` 在某些环境未定义导致预填失效，先确认 `preInit`（`installer.nsh:15`）对同一变量的用法是否已有兜底，沿用其结果，不得自行另立方案。

---

### Task-005：便携版判定与启动时接入 Windows shim

**描述**：新增安装形态判定（查 `HKCU` 的卸载信息键与 `HKCU\Software\<PRODUCT_NAME>`），并在 `main.ts` 放开平台判断，使 Windows 也执行 shim 生成；同时把「是否需要弹出便携版提示」作为判定结果交给后续任务使用。判定逻辑必须可注入，以便在 macOS 上测试。

**关联需求**：`specs/desktop-windows-cli-shims-spec.md` §便携版首次启动一次性提示（判定部分）、§shim 生成失败不阻断启动。
→ Agent：读取该 spec 确认判定依据与"提示只出现一次"的状态位置；`design.md` 决策五给出为何不猜路径。

**前置依赖**：Task-003（检查点 1 通过后才动启动链路）

**工时估算**：0.39 人天
- 基础：0.3 人天（S）
- 缓冲：0.3 × 20% × 1.5 = 0.09 人天（技术风险-中：`main.ts` 启动链路 1800+ 行，插入点需避开既有的 runtime 发布与 `DSH_HOME` 赋值顺序）
- 总计：0.39 人天
→ Agent：缓冲计算规则见 `references/risk-classification.md`。

**涉及文件**：
- `dsh-plugin-desktop-beta/src/desktop-windows-install-kind.ts` — 新增，安装形态判定（查注册表键存在性），依赖注入
- `dsh-plugin-desktop-beta/src/main.ts` — 修改，`:742` 平台判断放开为 darwin + win32，并在 Windows 分支调用 shim 生成
- `dsh-plugin-desktop-beta/tests/desktop-windows-install-kind.spec.ts` — 新增

**验收标准**：
- **便携版判定查安装记录**：当注入的注册表读取显示卸载信息键与 `Software\<PRODUCT_NAME>` 均不存在时返回便携版；任一存在时返回安装版。验证方式：`yarn workspace dsh-plugin-desktop-beta vitest run tests/desktop-windows-install-kind.spec.ts` 通过
- **Windows 也生成 shim**：当宿主平台为 win32 且包内 CLI 发布成功时，`main.ts` 启动链路调用 `installDesktopCliShell`；发布失败或架构不匹配时只为成功者生成。验证方式：`yarn workspace dsh-plugin-desktop-beta vitest run tests/desktop-cli-shell.spec.ts` 通过且在 `main.ts` 中的调用点在 `git diff` 中可见；`yarn workspace dsh-plugin-desktop-beta typecheck` 无错误
- **失败不阻断启动**：当 shim 生成抛错时，异常被捕获并以错误日志记录，宿主继续启动。验证方式：`grep -n "CLI shell integration failed" dsh-plugin-desktop-beta/src/main.ts` 有输出，且该分支位于 try/catch 内（由 typecheck 与既有启动测试保证不被移除）

**增量计划**：
- [x] **增量 1**：安装形态判定模块
  - 做什么：定义可注入的注册表键存在性查询接口，实现判定函数
  - 交付：判定模块 + 全分支单测
  - 对应验收标准：便携版判定查安装记录
  - 完成判定：`yarn workspace dsh-plugin-desktop-beta vitest run tests/desktop-windows-install-kind.spec.ts` 通过
- [x] **增量 2**：`main.ts` 平台判断放开
  - 做什么：把 `process.platform === 'darwin'` 改为 darwin 或 win32；Windows 分支传入与 mac 相同的 launcher 集合（codegraph 传 `codegraph.js` 路径）
  - 交付：Windows 启动即生成 shim
  - 对应验收标准：Windows 也生成 shim
  - 完成判定：`yarn workspace dsh-plugin-desktop-beta typecheck` 无错误 && `yarn workspace dsh-plugin-desktop-beta vitest run tests/desktop-cli-shell.spec.ts` 通过
- [x] **增量 3**：异常处理与日志路径复核
  - 做什么：确认 Windows 分支复用既有 try/catch，日志前缀与 mac 一致
  - 交付：失败不阻断的行为
  - 对应验收标准：失败不阻断启动
  - 完成判定：`yarn workspace dsh-plugin-desktop-beta vitest run tests/safe-mode.spec.ts` 通过（启动链路相关既有测试未受影响）

**失败策略**：见全局约定。若 `main.ts` 的插入点与既有 generation 释放顺序冲突导致启动测试失败，优先保持 shim 生成为"尽力而为"的旁路，不得改动 runtime 发布与 `DSH_HOME` 的既有顺序。

---

### Task-006：检查点 2 — 安装器与启动接入

**类型**：检查点
**触发条件**：Task-004、Task-005 完成

**验证项**（仅包含可自动验证项）：
- [x] 类型检查：`yarn workspace dsh-plugin-desktop-beta typecheck` 无错误
- [x] 测试：`yarn workspace dsh-plugin-desktop-beta vitest run tests/installer-nsh.spec.ts tests/desktop-windows-install-kind.spec.ts tests/desktop-cli-shell.spec.ts tests/desktop-windows-path.spec.ts` 全部通过
- [x] 计数断言：`grep -c 'WriteRegExpandStr HKCU "Environment" "Path"' dsh-plugin-desktop-beta/build/installer.nsh` 输出为 2
- [x] 目标收敛（登记语句不含安装目录）：`grep -nE '(StrCpy \$0|WriteRegExpandStr HKCU "Environment" "Path")' dsh-plugin-desktop-beta/build/installer.nsh | grep 'resources'` 无输出
  - 注：`resources\codegraph\bin` 仍合法出现在 `DSH_CODEGRAPH_BIN` 定义为与 `FileExists` 存在性探测中（见 `installer.nsh:108,116`）；spec 约束的是它不得**作为 PATH 登记目标**，故本项只检查所有写入 `$0` 与 `Path` 的语句。更强的 `$INSTDIR` 唯一性断言由 `tests/installer-nsh.spec.ts:78` 承担。
- [x] 打包测试未回归：`yarn workspace dsh-plugin-desktop-beta vitest run tests/package.spec.ts` 通过

**工时估算**：0.15 人天
- 基础：0.15 人天（XS）
- 缓冲：无
- 总计：0.15 人天

---

### Task-007：设置 API 的契约与路由

**描述**：为「命令行工具」入口新增两个 POST 路由（登记/修复、撤销），请求体为空对象，响应含 `changed` 与当前登记状态。沿用 `desktop-settings-route.ts` 既有的 loopback 与 origin 校验、body 大小上限、统一错误响应。

**关联需求**：`specs/desktop-windows-cli-shims-spec.md` §设置中的可重复入口。
→ Agent：读取该 spec 确认"入口不限安装形态"与撤销语义；`design.md` §接口设计给出路由语义与响应字段。

**前置依赖**：Task-003（检查点 1 通过后动设置 API）

**工时估算**：0.36 人天
- 基础：0.3 人天（S）
- 缓冲：0.3 × 20% × 1 = 0.06 人天（业务风险-低：契约与既有路由同构，照抄校验逻辑）
- 总计：0.36 人天
→ Agent：缓冲计算规则见 `references/risk-classification.md`。

**涉及文件**：
- `dsh-plugin-desktop-beta/src/desktop-settings-contract.ts` — 修改，新增两个路径常量与请求/响应类型
- `dsh-plugin-desktop-beta/src/desktop-settings-route.ts` — 修改，新增两个 handler
- `dsh-plugin-desktop-beta/tests/desktop-settings-api.spec.ts` — 修改，补路由校验用例

**验收标准**：
- **契约完整**：当读取契约文件时，存在命令行工具登记与撤销两个路径常量及对应请求/响应类型。验证方式：`yarn workspace dsh-plugin-desktop-beta typecheck` 无错误
- **仅接受合法请求**：当请求来自非 loopback 来源、或 origin 不匹配、或 body 超过上限时，路由返回既有约定的错误响应且不执行任何注册表操作。验证方式：`yarn workspace dsh-plugin-desktop-beta vitest run tests/desktop-settings-api.spec.ts` 通过
- **响应区分是否发生变更**：当操作实际修改了 PATH 时响应 `changed: true`，未修改时 `changed: false`。验证方式：同一测试文件中的两条用例（注入假 PATH 读写）通过

**增量计划**：
- [x] **增量 1**：契约常量与类型
  - 做什么：新增路径常量与请求/响应类型，命名沿用 `DESKTOP_TERMINAL_OPEN_PATH` 风格
  - 交付：可编译的契约
  - 对应验收标准：契约完整
  - 完成判定：`yarn workspace dsh-plugin-desktop-beta typecheck` 无错误
- [x] **增量 2**：两个 handler 与校验复用
  - 做什么：实现 handler，复用既有的 loopback/origin/body-size 校验与 `finishJson`
  - 交付：可调用的路由
  - 对应验收标准：仅接受合法请求
  - 完成判定：`yarn workspace dsh-plugin-desktop-beta vitest run tests/desktop-settings-api.spec.ts` 通过
- [x] **增量 3**：变更状态反馈
  - 做什么：把底层操作的 `changed` 透出到响应
  - 交付：可供界面区分的响应
  - 对应验收标准：响应区分是否发生变更
  - 完成判定：同一测试文件全部通过

**失败策略**：见全局约定。若既有路由的校验逻辑无法直接复用（耦合了具体 handler），抽取公共前置函数而不是复制粘贴，避免校验漂移。

---

### Task-008：设置控制器方法与插件注册

**描述**：在 `desktop-settings-controller.ts` 中实现两个操作（生成 shim + 登记 PATH、撤销 PATH 条目），并在 `index.ts` 的路由注册表中接入 Task-007 的两个 handler。

**关联需求**：`specs/desktop-windows-cli-shims-spec.md` §设置中的可重复入口、§shim 生成失败不阻断启动。
→ Agent：读取该 spec 确认入口对安装版同样开放，以及失败时的反馈要求。

**前置依赖**：Task-007

**工时估算**：0.30 人天
- 基础：0.25 人天（XS）
- 缓冲：0.25 × 20% × 1 = 0.05 人天（业务风险-低：接线任务，逻辑已在 Task-001/002 完成）
- 总计：0.30 人天

**涉及文件**：
- `dsh-plugin-desktop-beta/src/desktop-settings-controller.ts` — 修改，新增两个方法与错误封装
- `dsh-plugin-desktop-beta/src/index.ts` — 修改，在 `settingsRoutes` 注册表（`:304-317`）新增两项
- `dsh-plugin-desktop-beta/src/desktop-cli-publication.ts` — 新增，`createDesktopCliPublisher` / `desktopCliLaunchers` 把 shim 生成与 PATH 读写合成一对可注入、可测试的操作
- `dsh-plugin-desktop-beta/src/desktop-cli-shell.ts` — 修改，导出 `desktopCliShimDirectory`，使 PATH 登记目标与 shim 落盘目录同源
- `dsh-plugin-desktop-beta/src/host-bootstrap.ts` — 修改，isolated Host 侧注入 `publishCli` / `revokeCli`，并新增 `userHomeDir` / `codegraphCliPathDir` / `mnemonCliPathDir` 三个入参
- `dsh-plugin-desktop-beta/src/main.ts` — 修改，in-process 回退侧注入同一对能力；launcher 路径经 `DesktopHostOptions` 作为数据传入 Host

**验收标准**：
- **操作可被路由触达**：当请求命中两个新路径时，控制器方法被调用且返回结构符合契约。验证方式：`yarn workspace dsh-plugin-desktop-beta vitest run tests/desktop-settings-api.spec.ts` 通过
- **入口不限安装形态**：当宿主为安装版时，控制器照常执行登记与撤销，不因形态被拒绝。验证方式：`yarn workspace dsh-plugin-desktop-beta vitest run tests/desktop-windows-install-kind.spec.ts tests/desktop-settings-api.spec.ts` 通过
- **失败有反馈**：当底层操作抛错时，路由返回错误响应而非静默成功。验证方式：路由测试中的失败分支用例通过

**增量计划**：
- [x] **增量 1**：控制器方法
  - 做什么：实现"修复/登记"与"撤销"两个方法，内部调用 shim 生成与 PATH 读写
  - 交付：控制器可用
  - 对应验收标准：操作可被路由触达
  - 完成判定：`yarn workspace dsh-plugin-desktop-beta typecheck` 无错误
- [x] **增量 2**：路由注册
  - 做什么：在 `settingsRoutes` 数组中新增两项
  - 交付：端到端可请求
  - 对应验收标准：入口不限安装形态
  - 完成判定：`yarn workspace dsh-plugin-desktop-beta vitest run tests/desktop-settings-api.spec.ts` 通过
- [x] **增量 3**：错误封装
  - 做什么：把底层错误包装成既有的 settings 错误响应形态
  - 交付：失败反馈
  - 对应验收标准：失败有反馈
  - 完成判定：同一测试文件中的失败分支用例通过

**失败策略**：见全局约定。若 `desktop-settings-controller.ts` 的构造依赖在测试中难以搭建，改为对控制器做窄接口注入，不引入测试专用的生产分支。

---

### Task-009：客户端设置入口

**描述**：在设置面板新增「命令行工具」入口，提供登记/修复与撤销两个动作，并显示执行结果。文案需覆盖两种状态（已登记/未登记）与两种结果（已更新/已是最新）。

**关联需求**：`specs/desktop-windows-cli-shims-spec.md` §设置中的可重复入口的三个 Scenario。
→ Agent：读取该 spec 确认动作与反馈要求；界面结构参照 `src/client/DesktopSettingsSection.tsx` 与 `src/client/DesktopTerminalSettingsAction.tsx`。

**前置依赖**：Task-007（需要契约类型与 API 客户端方法）

**工时估算**：0.48 人天
- 基础：0.4 人天（M）
- 缓冲：0.4 × 20% × 1 = 0.08 人天（业务风险-低：纯前端接线，交互模式可参照既有 Terminal action）
- 总计：0.48 人天
→ Agent：缓冲计算规则见 `references/risk-classification.md`。

**涉及文件**：
- `dsh-plugin-desktop-beta/src/client/desktop-settings-api.ts` — 修改，新增两个调用方法
- `dsh-plugin-desktop-beta/src/client/DesktopSettingsSection.tsx` — 修改，新增命令行工具区块
- `dsh-plugin-desktop-beta/src/client/desktop-settings-locales.ts` — 修改，新增文案
- `dsh-plugin-desktop-beta/tests/client-cli-settings.spec.ts` — 新增，覆盖两个动作的调用、四种结果反馈与文案完整性
- `dsh-plugin-desktop-beta/tsconfig.tests.json` / `tsconfig.tests.client.json` — 修改，把新客户端用例从 node 测试集移入 jsdom 客户端测试集

**验收标准**：
- **两个动作可触发**：当用户点击登记或撤销时，对应 API 被调用。验证方式：`yarn workspace dsh-plugin-desktop-beta typecheck`（含 `tsconfig.client.json`）无错误，且 `vitest run tests/client-cli-settings.spec.ts` 中注入的假 API 记录到调用（该仓库无 `--project` 划分，客户端用例靠 `tsconfig.tests.client.json` 白名单进入 jsdom 套件）
- **结果可见**：当 API 返回 `changed: true` 与 `changed: false` 时，界面分别展示"已更新"与"已是最新"两种反馈。验证方式：`vitest run tests/client-cli-settings.spec.ts` 中两条反馈用例通过
- **文案完整**：当检查 locale 文件时，新键在同一语言的多个 locale 中均存在。验证方式：既有的 locale 一致性测试通过

**增量计划**：
- [x] **增量 1**：API 客户端方法
  - 做什么：在 `desktop-settings-api.ts` 中新增两个 POST 方法
  - 交付：可调用方法
  - 对应验收标准：两个动作可触发
  - 完成判定：`yarn workspace dsh-plugin-desktop-beta typecheck` 无错误
- [x] **增量 2**：设置区块与反馈
  - 做什么：在设置面板新增区块，展示当前状态与执行结果
  - 交付：可见入口
  - 对应验收标准：结果可见
  - 完成判定：`yarn workspace dsh-plugin-desktop-beta vitest run tests/client-cli-settings.spec.ts` 通过 && `yarn workspace dsh-plugin-desktop-beta build` 无错误
- [x] **增量 3**：文案与多语言
  - 做什么：补齐新键的文案，覆盖两种状态与两种结果
  - 交付：完整文案
  - 对应验收标准：文案完整
  - 完成判定：`yarn workspace dsh-plugin-desktop-beta vitest run` 全部通过

**失败策略**：见全局约定。若客户端组件测试环境未就绪，退一步以 `typecheck`（含 `tsconfig.client.json`）与构建作为可自动验证的下限，并在检查点 3 中显式记录该测试缺口。

---

### Task-010：检查点 3 — 设置入口端到端

**类型**：检查点
**触发条件**：Task-007、Task-008、Task-009 完成

**验证项**（仅包含可自动验证项）：
- [ ] 类型检查：`yarn workspace dsh-plugin-desktop-beta typecheck` 无错误
- [ ] 构建：`yarn workspace dsh-plugin-desktop-beta build` 无错误
- [ ] 测试：`yarn workspace dsh-plugin-desktop-beta vitest run` 全部通过
- [ ] 路由注册：`grep -n "DESKTOP_.*CLI.*PATH\|命令行工具" dsh-plugin-desktop-beta/src/index.ts dsh-plugin-desktop-beta/src/desktop-settings-contract.ts` 有输出
- [ ] 客户端产物：`grep -rln "命令行工具" dsh-plugin-desktop-beta/dist/` 有输出（构建产物含新文案）

**工时估算**：0.15 人天
- 基础：0.15 人天（XS）
- 缓冲：无
- 总计：0.15 人天

---

### Task-011：同步共享改动到 stable 变体

**描述**：把 beta 侧对 `src/` 的改动同步到 `dsh-plugin-desktop/`，并跑通变体一致性校验与 stable 侧测试。`build/installer.nsh` 与 `tests/` 同样需要同步。

**关联需求**：根 `AGENTS.md:18`（beta 先行验证后同步 stable）、`scripts/verify-desktop-variants.mjs:10`。
→ Agent：读取 `AGENTS.md` 确认同步与校验要求。

**前置依赖**：Task-010（beta 端到端通过后才同步）

> **文件数豁免说明**：本任务涉及 18 个文件，超出「≤3 个文件」的一般约束。此处保留为单一任务而非硬拆，理由是它是**逐字节镜像**——每个文件的改动内容已由 Task-001 至 Task-009 确定并被测试锁定，本任务不产生任何新决策，风险来自遗漏而非复杂；硬拆成两个任务不会降低遗漏风险，反而会让 `check:desktop-variants` 这个唯一的硬门禁失去单一责任人。macOS 侧同类同步任务（`20260923094527-macos-universal-cli-bundle/tasks.md:330` 的 Task-009）同样按单任务处理。遗漏风险由「变体一致性校验通过」这条验收标准兜底——它是全量文件级比对，不依赖人工清单。

**工时估算**：0.44 人天
- 基础：0.3 人天（S）
- 缓冲：0.3 × 30% × 1.5 = 0.135 人天（依赖风险-中：涉及 5+ 文件的逐字节一致性，且有 `product-identity.ts` 这一声明例外需要绕开）
- 总计：0.44 人天

**涉及文件**：
- `dsh-plugin-desktop/src/desktop-cli-shell.ts` — 修改，同步
- `dsh-plugin-desktop/src/desktop-windows-path.ts` — 新增，同步
- `dsh-plugin-desktop/src/desktop-windows-install-kind.ts` — 新增，同步
- `dsh-plugin-desktop/src/main.ts` — 修改，同步
- `dsh-plugin-desktop/src/desktop-settings-contract.ts`、`desktop-settings-route.ts`、`desktop-settings-controller.ts`、`index.ts`、`src/client/*` — 修改，同步
- `dsh-plugin-desktop/build/installer.nsh`、`dsh-plugin-desktop/tests/` — 修改，同步

**验收标准**：
- **变体一致性校验通过**：当执行一致性校验时无 drift 报告。验证方式：`corepack yarn check:desktop-variants` 退出码 0
- **stable 侧测试通过**：当 stable 工作区运行相关测试时全部通过。验证方式：`yarn workspace dsh-plugin-desktop vitest run tests/desktop-cli-shell.spec.ts tests/desktop-windows-path.spec.ts tests/desktop-windows-install-kind.spec.ts tests/installer-nsh.spec.ts tests/desktop-settings-api.spec.ts` 退出码 0
- **installer.nsh 逐字节相同**：当比较两个变体的该文件时内容一致。验证方式：`diff dsh-plugin-desktop/build/installer.nsh dsh-plugin-desktop-beta/build/installer.nsh` 无输出
- **stable 侧类型检查通过**：验证方式：`yarn workspace dsh-plugin-desktop typecheck` 无错误

**增量计划**：
- [ ] **增量 1**：同步 `src/` 共享文件
  - 做什么：逐文件把 beta 的内容复制到 stable，跳过 `product-identity.ts`
  - 交付：stable 侧同构源码
  - 对应验收标准：变体一致性校验通过
  - 完成判定：`corepack yarn check:desktop-variants` 退出码 0
- [ ] **增量 2**：同步 `build/` 与 `tests/`
  - 做什么：同步 `installer.nsh` 与新增/修改的测试文件
  - 交付：stable 侧同构测试
  - 对应验收标准：installer.nsh 逐字节相同、stable 侧测试通过
  - 完成判定：`diff` 无输出且 stable 侧测试全绿
- [ ] **增量 3**：stable 侧类型检查与构建
  - 做什么：跑 stable 的类型检查与构建，确认无 beta 特有符号泄漏
  - 交付：stable 侧可构建
  - 对应验收标准：stable 侧类型检查通过
  - 完成判定：`yarn workspace dsh-plugin-desktop typecheck && yarn workspace dsh-plugin-desktop build`

**失败策略**：见全局约定。若一致性校验报告 drift，**不得**把文件加入 `allowedDifferences` 来放行，必须找出真实差异来源。

---

### Task-012：更新既有 CLI 打包文档

**描述**：更新 Windows 终端可用性说明：PATH 目标由安装目录改为 `.dsh\bin`，补齐便携版步骤（首次启动提示、设置入口、换目录后重跑），并说明旧版本残留条目的清理方式。

**关联需求**：`specs/mnemon-cli-bundling-spec.md` 与 `specs/codegraph-cli-bundling-spec.md` 中的 Windows 终端可用性要求；`design.md` §迁移策略的过渡方案。
→ Agent：读取这两份 spec 与 `design.md` 的迁移策略章节。

**前置依赖**：Task-011（文档须描述最终落地的行为）

**工时估算**：0.30 人天
- 基础：0.25 人天（XS）
- 缓冲：0.25 × 20% × 1 = 0.05 人天（业务风险-低：纯文档）
- 总计：0.30 人天

**涉及文件**：
- `docs/build-custom-client.zh.md` — 修改，`docs/build-custom-client.zh.md:330-370` 的 Windows 表格与说明、`:855` 附近的终端可用性对照
- `docs/bundle-codegraph-cli.zh.md` — 修改，Windows 章节的 PATH 目标
- `docs/bundle-mnemon-cli.zh.md` — 修改，同上
- `README.md` — 修改，便携版说明补一句终端命令的启用方式

**验收标准**：
- **Windows PATH 目标描述已更新**：当检索文档时，不再出现"把 `<安装目录>\resources\codegraph\bin` 追加到用户 PATH"这类描述，改为 `.dsh\bin`。验证方式：`grep -rn 'resources..codegraph..bin' docs/ README.md` 的剩余命中均不描述为 PATH 登记目标
- **便携版步骤完整**：当查阅文档时，含首次启动提示、设置入口、换解压目录后重跑三步，以及验证命令 `codegraph --version` 与 `mnemon --version`。验证方式：`grep -n '便携版' docs/build-custom-client.zh.md` 附近含上述三步
- **迁移说明存在**：当查阅文档时，说明升级后旧 PATH 条目的清理方式。验证方式：`grep -n 'PathBackup\|旧.*条目' docs/build-custom-client.zh.md` 有输出

**增量计划**：
- [ ] **增量 1**：`docs/build-custom-client.zh.md` 的 Windows 表格与说明
  - 做什么：更新 PATH 目标、补便携版三步、补迁移清理说明
  - 交付：更新后的主文档
  - 对应验收标准：Windows PATH 目标描述已更新、便携版步骤完整
  - 完成判定：`grep` 断言通过
- [ ] **增量 2**：两份 CLI 方案文档
  - 做什么：同步 Windows 章节的 PATH 目标与 shim 机制说明
  - 交付：两份文档更新
  - 对应验收标准：Windows PATH 目标描述已更新
  - 完成判定：`grep -rn 'resources..codegraph..bin' docs/` 无作为登记目标的描述
- [ ] **增量 3**：README 便携版说明与迁移说明
  - 做什么：README 补一句；补迁移清理段落
  - 交付：README 更新
  - 对应验收标准：迁移说明存在
  - 完成判定：`grep -n 'PathBackup\|旧.*条目' docs/build-custom-client.zh.md` 有输出

**失败策略**：见全局约定。若某处文档描述的机制已被本次变更取代但不属本次范围（如 Linux），保留原文并标注适用范围，不要删除。

---

### Task-013：最终检查点 — 全量门禁

**类型**：检查点
**触发条件**：Task-011、Task-012 完成

**验证项**（仅包含可自动验证项）：
- [ ] 变体一致性：`corepack yarn check:desktop-variants` 退出码 0
- [ ] 全量门禁：`corepack yarn check` 退出码 0
- [ ] 两变体 Windows 打包检查：`yarn workspace dsh-plugin-desktop-beta check:win-package` 与 `yarn workspace dsh-plugin-desktop check:win-package` 均退出码 0
- [ ] 计数与目标：`grep -c 'WriteRegExpandStr HKCU "Environment" "Path"' dsh-plugin-desktop/build/installer.nsh` 输出为 2
- [ ] 依赖变更：`git diff --stat dsh-plugin-desktop/package.json dsh-plugin-desktop-beta/package.json` 为空
- [ ] 任务完整性：Task-001 至 Task-012 的所有增量 checkbox 全勾

→ **人工验证清单（不构成本检查点的通过条件，但必须在发布前完成）**：`design.md` §测试策略列出的 7 项 Windows 真机验证（覆盖升级、换安装目录、便携版、换解压位置、多 profile 并行、中文路径、卸载）。本项需用户在 Windows 上执行，结果记入本 feature 的 `verify-report.md`。

**工时估算**：0.15 人天
- 基础：0.15 人天（XS）
- 缓冲：无
- 总计：0.15 人天

---

## 风险

| 风险 | 等级 | 应对 |
|------|------|------|
| `.cmd` 按 OEM 代码页解析，中文用户名或安装路径可能乱码 | 中 | 本机无法验证；列入发布前人工验证清单第 6 项。退路见 `design.md` 风险章节（`chcp` 前置或 `.ps1`，后者受执行策略限制） |
| PATH 写入破坏用户环境（`%VAR%` 被固化或其余条目丢失） | **高** | 这是本次唯一可能损伤用户环境的点。Task-002 强制 `REG_EXPAND_SZ` 保型 + 全分支单测；`design.md` 已把"出现 PATH 破坏立即回滚"写成回滚条件，优先级高于功能可用性 |
| 升级后旧版残留的两个 PATH 条目未被清理 | 中 | `design.md` 迁移策略已说明；Task-012 要求文档给出清理方式 |
| 注册表操作在 macOS 上无法真机验证 | 中 | 强制依赖注入 + 假实现单测；真机确认收敛到发布前人工清单 |
| 多 profile 并行时 `homeDir` 若随 profile 变化，shim 目录也会跟着变 | 中 | 列入人工验证清单第 5 项；若确认变化，需评估是否固定使用默认 home（`design.md` 风险章节已记录） |
| stable 同步时遗漏文件导致变体 drift | 低 | Task-011 以 `check:desktop-variants` 作为硬门禁，且明确禁止把差异加入白名单放行 |

---

## 实施顺序

### 阶段一：shim 与 PATH 内核

<!-- PARALLEL: Task-001, Task-002 -->

| 任务 | 耗时 | 前置依赖 | 执行方式 |
|------|------|----------|----------|
| Task-001：Windows `.cmd` 转发 shim 的渲染与幂等写入 | 0.46 人天 | 无 | **可并行**（只改 `desktop-cli-shell.ts` 与其测试，与 Task-002 无文件交集） |
| Task-002：Windows PATH 注册表登记与撤销模块 | 0.44 人天 | 无 | **可并行**（新增独立模块，不引用 Task-001 的任何符号） |
| Task-003：检查点 1 — shim 与 PATH 内核 | 0.15 人天 | Task-001、Task-002 | 串行 |

### 阶段二：安装器与启动接入

<!-- PARALLEL: Task-004, Task-005 -->

| 任务 | 耗时 | 前置依赖 | 执行方式 |
|------|------|----------|----------|
| Task-004：`installer.nsh` 的 PATH 目标收敛 | 0.30 人天 | 无 | **可并行**（只改 `.nsh` 与其测试，与阶段一及 Task-005 均无文件交集） |
| Task-005：便携版判定与启动时接入 Windows shim | 0.39 人天 | Task-003 | 串行（依赖阶段一的两个模块与检查点） |
| Task-006：检查点 2 — 安装器与启动接入 | 0.15 人天 | Task-004、Task-005 | 串行 |

### 阶段三：设置入口

<!-- PARALLEL: Task-008, Task-009 -->

| 任务 | 耗时 | 前置依赖 | 执行方式 |
|------|------|----------|----------|
| Task-007：设置 API 的契约与路由 | 0.36 人天 | Task-003 | 串行 |
| Task-008：设置控制器方法与插件注册 | 0.30 人天 | Task-007 | **可并行**（只改 `desktop-settings-controller.ts` 与 `index.ts`，与 `src/client/` 无文件交集） |
| Task-009：客户端设置入口 | 0.48 人天 | Task-007 | **可并行**（`src/client/` 与 Task-008 的两个文件无交集） |
| Task-010：检查点 3 — 设置入口端到端 | 0.15 人天 | Task-008、Task-009 | 串行 |

### 阶段四：同步与文档

| 任务 | 耗时 | 前置依赖 | 执行方式 |
|------|------|----------|----------|
| Task-011：同步共享改动到 stable 变体 | 0.44 人天 | Task-010 | 串行（必须先完成 beta 端到端验证） |
| Task-012：更新既有 CLI 打包文档 | 0.30 人天 | Task-011 | 串行（文档须描述最终落地行为） |
| Task-013：最终检查点 — 全量门禁 | 0.15 人天 | Task-011、Task-012 | 串行 |

**关键路径**：Task-001(0.46) → Task-003(0.15) → Task-007(0.36) → Task-009(0.48) → Task-010(0.15) → Task-011(0.44) → Task-012(0.30) → Task-013(0.15)
= 0.46 + 0.15 + 0.36 + 0.48 + 0.15 + 0.44 + 0.30 + 0.15 = **2.49 人天**

分叉说明：Task-005 链（Task-005 0.39 + Task-006 0.15 = 0.54）与 Task-007 链（0.36 + 0.48 = 0.84）都挂在 Task-003 之后，后者更长，因此 Task-004 与 Task-005 均在松弛时间内完成，不占关键路径。

**总工期**：**2.49 人天**（关键路径）；全量工时合计为 **4.07 人天**，其中 Task-002(0.44)、Task-004(0.30)、Task-005(0.39)、Task-006(0.15)、Task-008(0.30) 有并行松弛。

→ Agent：并行前确认：1）前置全部 done；2）文件无交集；3）可正常编译。
