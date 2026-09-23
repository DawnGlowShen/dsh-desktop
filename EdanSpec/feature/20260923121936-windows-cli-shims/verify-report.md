# 验证报告：20260923121936-windows-cli-shims

- **验证对象**：`189020607c..10f529f187`（12 个 commit，本 feature 自身；同范围内的 macOS universal 准备脚本属于另一 feature，已排除）
- **验证方式**：逐项核对 spec Scenario ↔ 实现/测试；对 tasks.md 的实测声明逐条抽查；门禁与测试命令实跑
- **验证环境**：macOS 宿主（未能执行任何 Windows 真机验证，见第五节）
- **验证日期**：2026-09-23

## 摘要

| 维度 | 状态 |
|------|------|
| 完整性 | 13/13 任务，checkbox 全勾（`grep -c '^- \[ \]' tasks.md` = **0**，`- [x]` = 48）；spec 场景共 **37** 项（12 Requirement：主 spec 8 + codegraph 2 + mnemon 2；Scenario 主 20 + codegraph 10 + mnemon 7），**✅ 34 / ⚠️ 3 / ❌ 0**（3 项待真机确认终端实跑，见第五节） |
| 正确性 | 本 feature 8 个测试文件 **166 passed**（0 failed）；typecheck 两变体 exit 0；`check:win-package` 两变体 exit 0；`check:desktop-variants` = 188 aligned |
| 一致性 | 遵循 design.md / proposal.md；proposal 的 Capabilities 与 Impact 路径全部落到实际文件；两变体逐字节镜像已核验 |

**特别说明**：本轮验证开始时发现 **spec 要求但任务书无人接手**的一项——「便携版首次启动一次性提示」在 Task-005 只产出判定函数、Task-006..013 无人接线，导致 `detectDesktopWindowsInstallKind` 一度是死代码。已补实现（commit `8d69c512fe`），并因此新增 `desktop-cli-prompt.ts` 与 17 个用例。**本报告验证的是补实现之后的最终状态。**

## 问题摘要

| 级别 | 数量 | 说明 |
|------|------|------|
| CRITICAL | 0 | — |
| IMPORTANT | 1 | 1 项设计的迁移措施只落实了「文档指引」这一半，「设置内一次性清理」未实现 |
| SUGGESTION | 2 | 均为可选改进 |

---

## 一、逐项核对：spec Scenario ↔ 实现/测试

### 1.1 `specs/desktop-windows-cli-shims-spec.md`（8 Requirement / 20 Scenario）

#### Requirement: Windows 转发 shim 生成

| # | Scenario | 结论 | 证据 |
|---|----------|------|------|
| 1 | 生成 mnemon shim | ✅ 通过 | `desktop-cli-shell.ts:310 shimFileName` → `mnemon.cmd`；`:298 renderWindowsShim` 非 `.js` 目标走 `quoteBatchWord(launcherPath)`；测试 `tests/desktop-cli-shell.spec.ts:264`（断言 `@echo off\r\n` 开头、` %*\r\n` 结尾）；`:229` describe 的 `windowsShim()` fixture 用 `win32` 语义渲染 |
| 2 | 生成 codegraph shim | ✅ 通过 | `desktop-cli-shell.ts:298-307`：以 `NODE_SCRIPT_EXTENSION` 判定后拼 `win32.join(windowsBundleRoot(launcherPath), WINDOWS_NODE_EXECUTABLE)` + `CODEGRAPH_NODE_ARGUMENTS` + `quoteBatchWord(launcherPath)`；`windowsBundleRoot`（`:275-287`）按 `CODEGRAPH_SCRIPT_DIRECTORIES`（`:68` = `['bin','dist','lib']`）逐层校验回走；测试 `desktop-cli-shell.spec.ts:264` 断言含 `${BUNDLE}\node.exe`、`${BUNDLE}\lib\dist\bin\codegraph.js`、`--liftoff-only`、`--disable-warning=ExperimentalWarning`；`:287 never references %~dp0 and is not a copy of the upstream shim`；`:300 rejects a CodeGraph path that is not in the packaged layout` |
| 3 | 拒绝会逃逸的裸命令名 | ✅ 通过 | `desktop-cli-shell.ts:146-154 assertLauncherName` 拒绝含 `/\` 或 `..` 的名字；`:338` 在**任何写盘之前**逐个断言（`installDesktopCliShell` 的 launcher 循环顶部）；测试 `:374 rejects a launcher name that would escape the shim directory`、`:209 rejects an empty launcher set and a name that escapes the shim directory` |

#### Requirement: shim 内容比对式幂等更新

| # | Scenario | 结论 | 证据 |
|---|----------|------|------|
| 4 | 重复调用不写盘 | ✅ 通过 | `desktop-cli-shell.ts:343` `if (readTextIfPresent(shimPath) !== shim)` —— 判据是内容而非 `existsSync`；测试 `:322 is idempotent on content rather than on existence`、`:111 is idempotent and only backs up when the profile actually changes` |
| 5 | 路径变化时覆盖旧 shim | ✅ 通过 | 同一 `:342` 比较即可覆盖；测试 `:335 rewrites a shim that points at a previous bundle location`、`:164 rewrites the block in place when the shim directory moves` |
| 6 | 已存在的 shim 不会被跳过 | ✅ 通过 | `readTextIfPresent`（`:211`）对空文件返回 `''`，与任何合法 shim 都不等 ⇒ 走写入分支；测试 `:348 overwrites an empty or stale shim instead of skipping it` |

#### Requirement: Windows PATH 登记走 ExpandString

| # | Scenario | 结论 | 证据 |
|---|----------|------|------|
| 7 | 保留原有变量引用 | ✅ 通过 | `desktop-windows-path.ts:62 DESKTOP_WINDOWS_PATH_WRITE_SCRIPT` 走 .NET `SetValue(..., RegistryValueKind.ExpandString)`；值经 `PATH_VALUE_ENVIRONMENT_VARIABLE` 环境变量传入，不做字符串插值；测试 `tests/desktop-windows-path.spec.ts:44 appends the shim directory and keeps %VAR% references literal`、`:212 writes PATH as an expand-string through the .NET registry interface`、`:218 reads PATH without expanding the variables it contains` |
| 8 | 查重后不重复追加 | ✅ 通过 | `:206 registerDesktopWindowsPath` 用 `isSameEntry`（大小写不敏感 + 容忍尾部分隔符）比对，命中即返回 `{changed:false, registered:true}`；测试 `:76 writes nothing when the entry is already present`、`:87 treats an existing entry as present regardless of case or trailing separator` |
| 9 | 登记后广播变更 | ✅ 通过 | `:76 DESKTOP_WINDOWS_PATH_BROADCAST_SCRIPT` = `SendMessage 0xFFFF 0x001A "STR:Environment" /TIMEOUT=5000`，仅在 `changed` 为真时调用；测试 `:101 broadcasts once after a real change`、`:225 broadcasts WM_SETTINGCHANGE with lParam Environment` |

#### Requirement: PATH 登记可撤销

| # | Scenario | 结论 | 证据 |
|---|----------|------|------|
| 10 | 移除自身条目 | ✅ 通过 | `:237 unregisterDesktopWindowsPath` 只移除匹配项；测试 `:135 removes only its own entry and leaves the rest byte-identical`、`:156 removes the trailing entry without leaving a dangling separator`、`:148 removes a duplicate entry so a legacy double registration cannot survive` |
| 11 | 未登记时撤销无副作用 | ✅ 通过 | `:237` 缺失返回 `{changed:false, registered:false}`；测试 `:164 is a no-op when the entry is absent`、`:175 is a no-op when the PATH value is absent entirely`、`tests/desktop-cli-publication.spec.ts:220 reports an already-absent entry as unchanged` |

#### Requirement: 便携版首次启动一次性提示（**补实现**）

| # | Scenario | 结论 | 证据 |
|---|----------|------|------|
| 12 | 无安装记录时提示 | ✅ 通过 | `desktop-cli-prompt.ts:146 desktopCliPromptRequired` 要求 `platform==='win32' && installKind==='portable' && !safeMode && state===undefined`；`desktop-windows-install-kind.ts` 的判定只读两个注册表键（`INSTALL_REGISTRY_KEY` / `UNINSTALL_REGISTRY_KEY`），不读路径；测试 `tests/desktop-cli-prompt.spec.ts:74 asks a portable Windows copy that has not been asked`、`tests/desktop-windows-install-kind.spec.ts:51 reports a portable edition when no installation record exists`、`:91 asks only about registry keys, never about a path` |
| 13 | 有安装记录时不提示 | ✅ 通过 | 同上判定；测试 `desktop-cli-prompt.spec.ts:83 stays silent when an installation record exists`、`:203 never asks an installed copy and leaves no marker behind`（同时断言**不留 marker**）、`desktop-windows-install-kind.spec.ts:67/:75`（卸载记录单独、产品状态键单独都能判定为已安装）、`:81 stops probing as soon as one record is found` |
| 14 | 提示只出现一次（状态写应用数据目录） | ✅ 通过 | `desktop-cli-prompt.ts:89 desktopCliPromptStatePath` = `<userDataDir>/cli-prompt/state.json`（**非注册表**）；`:273` 接受与拒绝都经 `recordDesktopCliPromptOutcome` 落盘；测试 `desktop-cli-prompt.spec.ts:110 round-trips an accepted answer under the user-data directory`、`:184 does not ask a second time`、`:124 treats a missing marker as unanswered`、`:128 treats unreadable and malformed markers as unanswered`、`:255 keeps the wording out of the state file` |

#### Requirement: 设置中的可重复入口

| # | Scenario | 结论 | 证据 |
|---|----------|------|------|
| 15 | 从设置重新登记 | ✅ 通过 | 路由 `desktop-settings-route.ts:501 handleDesktopCliPublishRequest` → 控制器 `publishCli()` → `desktop-cli-publication.ts` 的 `publish()`（先 `installDesktopCliShell` 再 `registerDesktopWindowsPath`，返回 `{changed, registered}`）；客户端 `DesktopSettingsSection.tsx` 的 `runCli` 与 `cliFeedback` 反馈行（`DesktopSettingsSection.tsx:841`，`role="status"`）；测试 `tests/client-cli-settings.spec.ts:73 registers on click and reports the changed result`、`:85 reports the unchanged result as already up to date`、`tests/desktop-cli-publication.spec.ts:134`、`:151 is a no-op on the second publish`、`:164 follows the bundle when it moves` |
| 16 | 从设置撤销登记 | ✅ 通过 | `:524 handleDesktopCliRevokeRequest` → `revokeCli()` → `revoke()` 只调 `unregisterDesktopWindowsPath`（**保留 shim 文件**）；客户端有二次确认对话框（`DesktopSettingsSection.tsx:866`，`role="alertdialog"`）；测试 `client-cli-settings.spec.ts:95 revokes only after the confirmation dialog is accepted`、`:110 keeps the registration untouched when the revoke dialog is cancelled`、`desktop-cli-publication.spec.ts:195 revokes only this installation entry and keeps the shim files` |
| 17 | 入口不限安装形态 | ✅ 通过 | `grep -n 'installKind\|InstallKind' desktop-cli-publication.ts desktop-settings-controller.ts desktop-settings-route.ts` → **无任何命中**，即登记路径完全不感知安装形态；`publisher` 只在 `platform === 'win32'` 时构造（`main.ts:784`），与「是否便携版」无关 |

#### Requirement: shim 生成失败不阻断启动

| # | Scenario | 结论 | 证据 |
|---|----------|------|------|
| 18 | 生成失败时继续启动 | ✅ 通过 | `main.ts:763-777`：`installDesktopCliShell(...)` 包在 `try/catch` 内，catch 只 `electronLogger.error(\`${BIN_NAME}: CLI shell integration failed: \`)`；便携版提示同样 `void runDesktopCliPortablePrompt({...}).catch(...)`（`:1814`、`main.ts` 尾部），**刻意不 await**；测试 `tests/desktop-windows-install-kind.spec.ts:157 keeps the failure contained in the existing try/catch`、`:196 never lets the prompt delay or break startup` |
| 19 | 单个 launcher 不可用时跳过 | ✅ 通过 | `desktop-cli-publication.ts:60 desktopCliLaunchers` 仅当对应 `pathDir !== undefined` 才 push；`main.ts:756-761` 传的是 `codegraphRuntime?.pathDir` / `mnemonRuntime?.pathDir`（架构不匹配时为 `undefined`）；测试 `desktop-cli-publication.spec.ts:110 omits a CLI whose bundle was never published`、`:184 refuses to advertise a shim directory when nothing was published` |

#### Requirement: macOS 行为保持不变

| # | Scenario | 结论 | 证据 |
|---|----------|------|------|
| 20 | mac 产物不变 | ✅ 通过 | `desktop-cli-shell.ts:355` windows 分支在写 profile **之前**就 `return`，Windows 路径完全不碰 dotfile；`git diff 189020607c..HEAD -- dsh-plugin-desktop-beta/src/desktop-cli-shell.ts` 中 `exec ` / `zshrc` / `MARKER` 相关行**无任何增删**；测试 `:389 leaves macOS artifacts untouched when the platform is darwin`、`:311 writes no shell profile at all on Windows`、`:429 removes every shim and the block while leaving the rest byte-identical`；两变体 `package.json` 的 `git diff --stat` 为**空** |

### 1.2 `specs/codegraph-cli-bundling-spec.md`（2 MODIFIED Requirement / 10 Scenario）

| # | Scenario | 结论 | 证据 |
|---|----------|------|------|
| 21 | 生成 codegraph shim | ✅ 通过 | 同 #2；另 `main.ts:756` 的门控含 `'win32'`，即 Windows 也执行 shell 集成；`grep` 确认登记目标只有 `DSH_SHIM_DIR`，PATH 中不出现安装目录 |
| 22 | 便携版终端可用 | ⚠️ 代码就绪、**未真机验证** | 便携版登记路径与安装版完全同一条代码（见 #17）；`.cmd` 转发内容已由单测固定。最终「新开终端执行 `codegraph --version` 输出 1.6.0」需 Windows 真机（第五节第 3 项） |
| 23 | 安装版终端可用（回归） | ⚠️ 同上 | 安装器写 PATH 的逻辑由 `installer-nsh.spec.ts:41` 静态断言覆盖；真机见第五节第 1 项 |
| 24 | 升级后 shim 自动指向新位置 | ✅ 通过（逻辑层面） | 幂等靠内容比较 ⇒ 每次启动以当前 `pathDir` 重算并覆盖（`desktop-cli-shell.ts:343`）；测试 `:335`、`desktop-cli-publication.spec.ts:164` |
| 25 | 不复制上游 codegraph.cmd | ✅ 通过 | `desktop-cli-shell.ts:298` 是渲染而非拷贝；测试 `:287 never references %~dp0 and is not a copy of the upstream shim`（断言不含 `%~dp0`/`%~dpn0` 且 `length < 400`，即字节量级排除拷贝）；`:264` 断言内容首尾形态 |
| 26 | 安装时登记 shim 目录 | ✅ 通过 | `installer.nsh:116-144`：`FileExists` 守卫 → `StrContains` 查重 → 空则 `WriteRegExpandStr … "PathBackup"` → `StrCpy` 追加 `$PROFILE\.dsh\bin` → `WriteRegExpandStr HKCU "Environment" "Path"` → `SendMessage`；测试 `installer-nsh.spec.ts:41` 段落断言 `StrCpy $0 "$PROFILE\${DSH_SHIM_DIR}"`、`StrCpy $0 "$0;$PROFILE\${DSH_SHIM_DIR}"`、`WriteRegExpandStr HKCU "Software\${PRODUCT_NAME}" "PathBackup"`、`${DSH_HWND_BROADCAST} ${DSH_WM_WININICHANGE}` |
| 27 | 已登记时不重复追加 | ✅ 通过 | `installer.nsh:126` `${StrContains} $1 "${DSH_SHIM_DIR}" "$0"` + `:127 ${if} $1 == ""` 包裹全部写操作；测试同上段落 |
| 28 | 卸载时移除自身条目 | ✅ 通过 | `installer.nsh:157-169`：`ReadRegStr`（`:157`）→ `StrLen $3 ";"`（`:159`）→ `StrCpy $4 "$0" $3 -$3`（`:162`）取尾部 → `${if} $4 == ";$PROFILE\${DSH_SHIM_DIR}"`（`:163`）确认仍在末尾才 `WriteRegExpandStr`（`:166`）移除 + `SendMessage`（`:167`）；注释（`:149-156`）明确「用户重排 PATH 则保留其安排」 |
| 29 | 不再登记安装目录且 `WriteRegExpandStr … "Path"` 恰好两次 | ✅ 通过 | 两变体 `grep -c` 均 = **2**，`installer-nsh.spec.ts:50` `expect(writes).toHaveLength(2)`；`installer.nsh:108` 的 `DSH_CODEGRAPH_BIN` 只出现在 `FileExists` 判断中（`:116`），从不进入 `StrCpy`/`WriteRegExpandStr`；`grep` 交叉确认无 `resources\...\bin` 写 PATH 的行 |
| 30 | 两个变体一致 | ✅ 通过 | `dsh-plugin-desktop/build/installer.nsh` 与 beta 版逐字节相同（该文件不含变体名，`diff` 无输出） |

### 1.3 `specs/mnemon-cli-bundling-spec.md`（2 MODIFIED Requirement / 7 Scenario）

| # | Scenario | 结论 | 证据 |
|---|----------|------|------|
| 31 | 生成 mnemon shim 且无 mnemon.exe 副本 | ✅ 通过 | `desktop-cli-shell.ts:310` 生成 `mnemon.cmd`；`renderWindowsShim` 对非 `.js` 目标只写一行 `quoteBatchWord(launcherPath)`；模块只经 `writeFileAtomic` 写 `shimFileName` 这一个路径，**无任何复制二进制或遍历上游包的分支**；测试 `:264` 断言 `mnemon` 内容含 `${BUNDLE}\mnemon\bin\mnemon.exe`、`^@echo off\r\n`、`endsWith(' %*\r\n')`；`shimPaths` 恰为 `[codegraph, mnemon]` 两项，无 `mnemon.exe` |
| 32 | 升级后 shim 指向新二进制 | ✅ 通过（逻辑层面） | 同 #24：`mnemonPathDir` 每次由 `mnemonRuntime?.pathDir` 重新解析，内容变化即覆盖；真机见第五节第 1 项 |
| 33 | 便携版终端可用 | ⚠️ 未真机验证 | 同 #22；`mnemon.exe` 在本机已物化（`dsh-plugin-desktop-beta/build/mnemon/host/bin/mnemon`，darwin-arm64），win32 目标未物化（与 bundle-mnemon feature 同一已知项） |
| 34 | 与 codegraph 共用同一目录与同一条 PATH 条目 | ✅ 通过 | 两个 launcher 共用 `join(options.homeDir, SHIM_DIRECTORY)`（`desktop-cli-shell.ts:332`），一次 `installDesktopCliShell` 调用生成两者、一张 PATH 条目；`registerDesktopWindowsPath` 每次只登记该一个目录且带查重；测试 `desktop-cli-shell.spec.ts:73`（不论多少 launcher 只加一个标记块）、`desktop-cli-publication.spec.ts:134 generates the shims and registers their directory in one publish` |
| 35 | 卸载移除 PATH 条目 | ✅ 通过 | `installer.nsh:148-170 customUnInstall`：仅当条目仍在末尾（`StrLen $3`（`:159`）→ `StrCpy $4 "$0" $3 -$3`（`:162`）→ `${if} $4 == ";..."`（`:163`））才移除（`:166`）+ 广播（`:167`）；测试 `installer-nsh.spec.ts:38` 段落断言 |
| 36 | 卸载不动用户数据目录 | ✅ 通过 | 卸载器**只**写 `HKCU "Environment" "Path"`（`:166`）与（安装时）`HKCU "Software\${PRODUCT_NAME}" "PathBackup"`（`:131`），全文无 `RMDir`/`Delete`/`FileDelete` 触及 `<homeDir>\.dsh\bin`；`:154-156` 的注释明确「shim 文件留在 `<home dir>\.dsh\bin`，该目录属于用户数据，且另一版本可能正在使用同一目录」 |
| 37 | 条目已被移到别处时保留 | ✅ 通过 | 同 #35 的末尾判断；测试 `installer-nsh.spec.ts:41` 段落断言尾部比较 |

### 1.4 补充核对项

| # | 项 | 结论 | 证据 |
|---|----|------|------|
| 38 | `WriteRegExpandStr HKCU "Environment" "Path"` 恰好 2 次 | ✅ 通过 | 两变体 `grep -c` 均 = **2**；`installer-nsh.spec.ts:50` `expect(writes).toHaveLength(2)` |
| 39 | 不再以 `resources\codegraph\bin` 为登记目标 | ✅ 通过 | `installer.nsh:108` 的该 define **仅用于 `FileExists` 判断**（`:116`），从不进入 `StrCpy`/`WriteRegExpandStr`；`grep` 交叉确认无 `resources\...\bin` 写 PATH 的行 |
| 40 | 两变体 `installer.nsh` 一致 | ✅ 通过 | 逐字节 diff 为空（该文件不含变体名，`diff -q` 在 macOS 上不可用，改用 `diff` 无输出判定） |
| 41 | 两个新路由复用 5 行前置 | ✅ 通过 | `desktop-settings-route.ts:501` 与 `:524` 均含 `405` → `isSameOriginLoopbackRequest(req, expectedOrigin, true)` → `403` → `parsePostBody` → `isEmptyRequest` → 400；`tests/desktop-settings-api.spec.ts:807`（7 例）+ `:913`（2 例）共 **9 个用例**，断言覆盖 403/405/415/400/500 |
| 42 | 两变体源码逐字节镜像 | ✅ 通过 | 对 19 个相关文件做 `sed` 归一化后 `diff`，**全部无差异**；`corepack yarn check:desktop-variants` → `188 shared source files are aligned` |

**统计**：37 个 spec Scenario（#1–#37）→ **✅ 通过 34**、**⚠️ 需真机确认 3**（#22/#23/#33）、**❌ 不成立 0**。34 项通过中 2 项（#24/#32「升级后 shim 自动指向新位置/新二进制」）为逻辑层面通过；另设 5 个补充核对项（#38–#42）全部通过。

---

## 二、对「已声明的实测结果」逐条抽查

| 声明 | 结论 |
|------|------|
| 13 个任务全部完成 | ✅ `grep -c '^### Task-' tasks.md` = 13；`grep -c '^- \[ \]' tasks.md` = **0**，`- [x]` = 48 |
| 本 feature 测试全绿 | ✅ 实跑 8 个文件：`desktop-cli-shell.spec.ts` 26 + `desktop-windows-path.spec.ts` 29 + `desktop-windows-install-kind.spec.ts` 20 + `desktop-cli-publication.spec.ts` 10 + `desktop-cli-prompt.spec.ts` 17 + `desktop-settings-api.spec.ts` 49 + `client-cli-settings.spec.ts` 7 + `installer-nsh.spec.ts` 8 = **166 passed (8 files)** |
| Task-013 声明「除 2 个既有基线失败外全部通过」 | ✅ 复核成立。`corepack yarn check` 实测 `Test Files 1 failed \| 141 passed (142)`、`Tests 2 failed \| 1517 passed \| 8 skipped (1527)`；2 个失败均在 `tests/host-process-integration.spec.ts`，错误为 `EPERM: operation not permitted, open '/Users/jimmy/.dsh/.credentials.yaml.lock'`。本机 `~/.dsh/.credentials.yaml` 为 `-rw------- jimmy staff 478 Sep 15 15:07`、`~/.dsh` 为 `drwx------`，属环境问题；本 feature 开始前即以 `git stash` 在基线复现。**tasks.md 未伪报绿色**，该行如实写明。 |
| `check:win-package` 两变体通过 | ✅ 实跑均 exit 0，尾部 `verify-runtime-closure: 247 first-party nodes form a closed reachable runtime graph.` |
| `check:desktop-variants` = 一致 | ✅ `verify-desktop-variants: 188 shared source files are aligned; both editions use isolated Host and chrome` |
| 两变体 `package.json` 未被本 feature 改动 | ✅ `git diff --stat 189020607c..HEAD -- */package.json` 为空 |
| 禁用手段确实未出现 | ✅ `grep -rn 'setx\|reg\.exe' */src/ */build/installer.nsh` → 无命中；`grep -rn 'WriteRegStr.*Environment' */build/installer.nsh` → 无命中；`grep -rn 'shell: *true' */src/` → 无命中；`grep -rn 'PORTABLE_EXECUTABLE_DIR' */src/` → 无命中 |
| 注册表数据不插入 PowerShell 脚本文本 | ✅ `desktop-windows-path.ts:26-27` 两个环境变量（`DSH_WINDOWS_PATH_VALUE`、`DSH_WINDOWS_REGISTRY_KEY`）承载全部数据；`grep -n 'PRODUCT_NAME\|\${key}' desktop-windows-path.ts` → 无命中；测试 `desktop-windows-path.spec.ts:304 passes the key as data, never as script text`（键名用 `Software\O'Brien$Corp` 验证） |

**未见任何「实测声明与实际不符」的项。**

---

## 三、交付物清单 vs proposal

- **Capabilities**：`desktop-windows-cli-shims` → `specs/desktop-windows-cli-shims-spec.md`（149 行 / 8 Requirement）；`codegraph-cli-bundling` → `specs/codegraph-cli-bundling-spec.md`（73 行 / 2 MODIFIED）；`mnemon-cli-bundling` → `specs/mnemon-cli-bundling-spec.md`（56 行 / 2 MODIFIED）。三者齐备。
- **Impact 路径逐条落地**：`desktop-cli-shell.ts`（win32 分支）✅、`desktop-windows-path.ts`（新增）✅、`desktop-windows-install-kind.ts`（新增）✅、`desktop-cli-publication.ts`（新增）✅、`desktop-cli-prompt.ts`（**补实现新增**）✅、`desktop-settings-{contract,controller,route}.ts` ✅、`index.ts` 两个路由注册 ✅、`src/client/{desktop-settings-api.ts,desktop-settings-locales.ts,DesktopSettingsSection.tsx}` ✅、`main.ts` 接线 ✅、`host-bootstrap.ts` ✅、`build/installer.nsh` ✅、`tests/` 10 个相关 spec ✅、文档 5 个文件 ✅。
- **「不在本次范围」未被越界**：未改 `package.json`（验证项之一）；未改 macOS 的 POSIX shim 渲染、`.zshrc` marker 块或 `desktop-uninstall` 逻辑；未引入 Linux 改动。
- **`tasks.md` 与现状无矛盾**：唯一「范围变更」是补实现便携版提示，已在 `8d69c512fe` 记录并同步文档。

---

## 四、与 design.md 的偏差

| 偏差 | 性质 | 说明 |
|------|------|------|
| `design.md:152` 称渲染 codegraph shim 时「取其 `dirname` 的上一级推导 `node.exe`」 | **文档事实错误（已接受）** | 实际 `node.exe` 在 bundle 根，`codegraph.js` 在 `<bundle>\lib\dist\bin\`，从入口脚本的 dirname 需**上溯 3 层**才到 bundle 根（design.md:150-151 的表格本身写对了最终形态）。实现用 `CODEGRAPH_SCRIPT_DIRECTORIES=['bin','dist','lib']` 逐层校验回走（`desktop-cli-shell.ts:275-287 windowsBundleRoot`），比 design 描述更严格、且对布局变化会显式报错而非静默拼错。**实现正确，design 该句错误**，建议后续修正。 |
| `design.md:196` 迁移策略承诺「在设置入口的反馈中提示检测到旧条目，并提供一次性清理」**或**「在文档中给出手工删除指引」 | **二选一，已满足** | 采用后者：`docs/build-custom-client.zh.md:387 #### 从旧版本升级：清理残留条目` 给出 `PathBackup` 对照恢复与手工删除两条路径，并警示「不要用 `setx`」。**未**实现设置内自动检测 ⇒ 见 IMPORTANT-1。 |
| `design.md` 的时序图把便携版提示画在「生成 shim」之后 | 一致 | `main.ts` 的提示段（`:1814`）确实在 shim 段（`:756`）之后，且复用同一个 `cliPublisher` |

---

## 五、未能在本机验证的项（**必须在发布前于 Windows 真机完成**）

本机为 macOS，以下 7 项按 `tasks.md:544` 的要求需用户在 Windows 上执行，结果应回填本节：

| # | 验证项 | 为什么本机无法验证 | 相关的 spec Scenario |
|---|--------|-------------------|---------------------|
| 1 | 覆盖升级（上一版 → 本版） | 需要 NSIS 安装器与真实注册表 | #23、#24、#32 |
| 2 | 更换安装目录后重装 | 同上 | #24 |
| 3 | 便携版 ZIP 首次启动弹提示 | 需要 win32 `app.getPath` 与真实注册表探测 | #12、#13、#14、#22、#33 |
| 4 | 移动便携版解压目录后重启 | 需要真实文件系统与注册表 | #5、#24、#32 |
| 5 | 多 profile 并行启动 | 需确认切换 profile 时 `homeDir` 是否变化（design.md 风险章节） | #34 |
| 6 | 中文用户名或中文路径 | `.cmd` 按 OEM 代码页解析，macOS 上无法复现 | #1、#2（风险表列为「中」） |
| 7 | 卸载后 PATH 清理 | 需要真实卸载器 | #35、#36、#37 |

**注**：#6 的退路已写入 `design.md` 风险章节（`chcp` 前置或改 `.ps1`），本轮未预置。

---

## CRITICAL（必须解决，否则不能归档）

无。

## IMPORTANT（应该解决）

- **`design.md:196` 的「设置入口检测到旧条目并提供一次性清理」只落实了文档那一半** —— 验证时 `grep -rn 'resources.*codegraph.*bin\|旧条目' dsh-plugin-desktop-beta/src/` 无任何命中，即应用**不会**检测用户 PATH 中残留的旧版 `resources\codegraph\bin` / `resources\mnemon\bin` 条目，也不会提示清理。design 的原句是「在设置入口的反馈中提示检测到旧条目，并提供一次性清理；**或**在文档中给出手工删除指引」，属**二选一**，文档路径（`docs/build-custom-client.zh.md:387`）已完成，因此**不构成 spec 违约**；但已装旧版的用户会长期留着两条无效条目，PATH 只增不减。
  - 严重度说明：旧条目指向的目录在升级后仍会被新版本填入 `resources\`，因此不会立即报错，表现仅为「两套条目指向同一份命令」，不影响可用性，故定为 IMPORTANT 而非 CRITICAL。
  - → 建议：如时间允许，在 `publish()` 的反馈中加入对 `resources\{codegraph,mnemon}\bin` 的检测，命中时在设置面板给一条「发现旧版本残留条目」提示 + 一键清理按钮；否则至少把这条明确写进 `design.md` 的「已在本次交付」与 `docs/` 的已知限制，避免后续读者以为设置里已能自动清理。

## SUGGESTION（可选改进）

- **`desktop-cli-prompt.ts` 的状态文件没有「已过期」机制** —— `readDesktopCliPromptState`（`:124`）只校验版本与字段形态，一旦写入 `declined`，用户此后即使把便携版目录搬到别处也不会再被询问（设计如此：「点暂不就不会再问」，见 `docs/build-custom-client.zh.md:366`）。对搬移目录的用户，唯一出路是设置面板——这与 spec「设置中的可重复入口」一致，行为正确。但若用户先点了「暂不」、之后又想恢复提示，没有 UI 可清除该 marker（仅有导出的 `clearDesktopCliPromptState`，`desktop-cli-prompt.ts:182`，无调用点）。
  - → 建议：在设置面板的 CLI 区块加一个「不再提示/恢复提示」的开关，或至少在文档里写明 marker 路径以便手工删除。当前不影响正确性。

- **`runDesktopCliPortablePrompt` 在 `detectInstallKind` 抛错时静默返回** —— `desktop-cli-prompt.ts:220-229` 的语义是「注册表读不出来 ⇒ 不提示并记日志」。这是**正确的**（读不到 ≠ 便携版），且测试 `desktop-cli-prompt.spec.ts:222 declines silently when the registry cannot be read` 已固定。但用户在 PowerShell 被策略禁用、注册表被锁的企业环境下会**完全不知道**设置里还有入口。
  - → 建议：可选地在设置面板的 CLI 区块常驻一行「若命令未生效，可在此重新登记」的静态提示，使这条出路不依赖启动提示是否出现。当前不影响正确性。

## 结论

- CRITICAL 0 条，IMPORTANT 1 条，SUGGESTION 2 条；37 个 spec Scenario 中 **✅ 34 / ⚠️ 3 / ❌ 0**，3 项待确认的均为终端实跑（#22/#23/#33），集中在第五节 7 项 Windows 真机验证。
- 本 feature 的自动化门禁全绿（8 文件 166 passed；两变体 typecheck/build 均 exit 0；188 shared source files aligned）；`corepack yarn check` 的唯一失败是本 feature 开始前即存在的环境问题（`~/.dsh/.credentials.yaml.lock` 的 EPERM），已在 `tasks.md` 与本节如实记录，未伪报。
- 验证过程中发现并**当场修复**了任务书的一个真实缺口（便携版一次性提示无接线、判定模块成死代码），补齐后 spec 的该 Requirement 三个 Scenario 全部有实现与测试。
- 无 CRITICAL；1 个 IMPORTANT 为设计承诺的「另一条可选路径」未采纳，不影响 spec 履约，建议归档前明确记录或补齐。

结论：APPROVE
