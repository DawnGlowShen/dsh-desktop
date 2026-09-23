# 安全审查报告：windows-cli-shims

- **feature**：`EdanSpec/feature/20260923121936-windows-cli-shims`
- **审查角色**：security-review 关卡审查员
- **审查基准**：`edanspec-security-review/references/security-checklist.md`（输入验证 / 数据保护 / 依赖安全 / OWASP Top 10）+ 本 feature 特有的「PATH 完整性」风险面
- **审查范围**：`dsh-plugin-desktop-beta/src/{desktop-cli-shell.ts, desktop-windows-path.ts, desktop-windows-install-kind.ts, desktop-cli-publication.ts, desktop-cli-prompt.ts, desktop-settings-{contract,controller,route}.ts, index.ts, main.ts, host-bootstrap.ts}`、`build/installer.nsh`、`src/client/*`
- **审查基准 commit**：`189020607c..10f529f187`（排除同范围的 macOS universal 准备脚本）
- **审查方式**：定点读码 + 字面搜索实测。未独立重跑门禁与测试（由 verify 关卡承担）。

---

## 0. 本 feature 的威胁模型

本 feature 是**首个会写用户 `PATH` 的代码**，因此安全性的首要目标不是「防攻击者」，而是**不损坏用户环境**。`design.md` 已把这条写成回滚条件：**「出现 PATH 破坏立即回滚，优先级高于功能可用性」**。审查据此把「PATH 保型」列为一等安全项，与传统的注入/提权并列。

信任边界：

```
[应用自身] --写--> [<homeDir>\.dsh\bin\*.cmd] --被引用--> [用户 PATH (HKCU\Environment\Path)]
     |                                                            ^
     +--PowerShell--> [HKCU] 注册表（只读探测 + 读写 Path）
```

不涉及的边界：无网络、无 IPC 新面（两个新路由挂在既有的同源回环校验之后）、无第三方输入、无提权（全程 HKCU，从不 HKLM）。

---

## 1. PATH 完整性（本 feature 的最高风险面）

### 1.1 是否保持 `REG_EXPAND_SZ` —— **成立**

系统上用两种实现会破坏 PATH，`design.md` 决策四明确点名并拒绝，本报告逐条验证其确实缺席：

| 被拒方案 | 破坏方式 | 实测 |
|---|---|---|
| `setx` | 展开 `%USERPROFILE%` 等引用后固化，且值超 1024 字符时**静默截断** | `grep -rn 'setx' */src/ */build/installer.nsh` → **无命中** |
| `reg.exe` 读改写 | 读出时展开 `REG_EXPAND_SZ`，写回只能写 `REG_SZ` ⇒ 值类型与内容双双永久化 | `grep -rn 'reg\.exe' */src/ */build/installer.nsh` → **无命中** |

实际实现走 .NET 注册表接口：

- **读**（`desktop-windows-path.ts:46-53 DESKTOP_WINDOWS_PATH_READ_SCRIPT`）：`GetValue('Path', $null, [RegistryValueOptions]::DoNotExpandEnvironmentNames)` —— 显式请求**不展开**，并用 `GetValueKind('Path')` 取出真实类型。测试 `tests/desktop-windows-path.spec.ts:218 reads PATH without expanding the variables it contains` 固定。
- **写**（`:62-68 DESKTOP_WINDOWS_PATH_WRITE_SCRIPT`）：`SetValue('Path', $value, [RegistryValueKind]::ExpandString)` —— 显式以 ExpandString 写回。测试 `:212 writes PATH as an expand-string through the .NET registry interface` 固定。
- **类型非静默强转**（`parseReadPayload`，`:275-295`）：只有 `ExpandString` / `String` 被识别，其他一律归为 `'Unknown'`，不悄悄降级为可写类型。

⇒ `%VAR%` 引用在所有路径上保持字面。测试 `:44 appends the shim directory and keeps %VAR% references literal` 端到端验证。

### 1.2 是否可能丢失用户 PATH 的其他条目 —— **不成立**

- **登记**（`registerDesktopWindowsPath`，`:206-228`）：`readCurrentValue` 取回原值 → 逐条比对查重 → 只在末尾追加。空值不加前导 `;`，已以 `;` 结尾则不加第二个 `;`。**不重排、不规范、不裁剪任何既有条目**。
- **撤销**（`unregisterDesktopWindowsPath`，`:237-254`）：`current.split(';')` 后 `entries.filter(entry => !isSameEntry(entry, normalizedTarget))` 再 `kept.join(';')` —— 注释点明「Entries are split and rejoined rather than filtered, so a trailing or doubled separator elsewhere in the value survives exactly as the user had it」。**用户的怪异格式被原样保留**。
- **幂等即保护**：内容不变时**根本不写**（`:206-228` 的查重早退 + `main.ts` 的发布只在 `changed` 时广播）。这使得「每次启动都调用」与「安装器同时写」之间的竞争退化为 no-op，而不是互相覆盖。
- 测试：`:135 removes only its own entry and leaves the rest byte-identical`、`:156 removes the trailing entry without leaving a dangling separator`、`:148 removes a duplicate entry so a legacy double registration cannot survive`、`:164 is a no-op when the entry is absent`、`:175 is a no-op when the PATH value is absent entirely`。

### 1.3 NSIS 安装器是否同样保型 —— **成立**

- `installer.nsh:139` 与 `:166` 用的是 `WriteRegExpandStr`（不是 `WriteRegStr`），两处合计**恰好 2 次**（安装 1、卸载 1）；`grep -rn 'WriteRegStr.*Environment' */build/installer.nsh` → **无命中**。
- 安装时（`:127-143`）：`${if} $1 == ""` 包裹**全部**写操作，即「已存在则一个字都不写」。
- 卸载时（`:157-169`）：`StrLen $3 ";$PROFILE\${DSH_SHIM_DIR}"` → `StrCpy $4 "$0" $3 -$3` 取尾 → `${if} $4 == ";..."` 才移除。**只有条目仍在末尾时才动**，用户重排过 PATH 就完整保留其安排 —— 意图写在 `:149-156` 的注释里：「the cost of leaving a stale directory behind is that Windows skips a name that no longer resolves — never a mangled PATH」。

### 1.4 已知取舍（记录在案，非缺陷）

NSIS 的 `ReadRegStr` 对 `REG_EXPAND_SZ` **会自动展开** `%VAR%`（纯 NSIS 关不掉），因此用户 PATH 若原本写成 `%USERPROFILE%\...`，在**升级安装**时会被固化成字面路径。所有路径仍有效，只是失去可移植性。这是 `design.md` 已记录的取舍（决策四），本实现无法规避（除非弃用 NSIS 宏改用自定义插件），**接受**。

---

## 2. 命令注入

### 2.1 PowerShell 脚本中的用户数据 —— **不成立**

两个脚本模板都不含任何用户可控数据，全部经环境变量传入：

- `PATH_VALUE_ENVIRONMENT_VARIABLE = 'DSH_WINDOWS_PATH_VALUE'`（`:26`）：承载整个 PATH 新值，其中**必然**含用户名（如 `C:\Users\O'Brien\...`）。
- `KEY_ENVIRONMENT_VARIABLE = 'DSH_WINDOWS_REGISTRY_KEY'`（`:27`）：承载被探测的注册表键名，由产品名拼成，产品名不保证无引号或 `$`。

脚本里读的是 `$env:DSH_WINDOWS_PATH_VALUE`，**没有**字符串插值点。验证：

- `grep -n 'PRODUCT_NAME\|\${key}' src/desktop-windows-path.ts` → **无命中**（键名从不进入脚本文本）。
- 测试 `tests/desktop-windows-path.spec.ts:304 passes the key as data, never as script text` 用键名 `Software\O'Brien$Corp` 验证——`'` 会破坏单引号串、`$Corp` 会被当变量，正是插值写法的两颗雷。
- `createPowerShellWindowsKeyProbe`（`:109-123`）的返回解析**只接受字面 `'1'` / `'0'`**，其余一律 `fail()`，因此被污染的 stdout 无法被误读成「键存在」。这个「不把失败吞成 false」的纪律至关重要：若把「读不到」并成「不存在」，就会把已安装用户判成便携版并弹一个陈述假事实的提示。

### 2.2 `execFileSync` 的调用形态 —— **成立**

`runPowerShell`（`:261-274`）：

```ts
execFileSync(powerShellExecutable(), ['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-Command', script], { … })
```

参数数组调用，**不经 shell**，无 `shell: true`（`grep -rn 'shell: *true' */src/` → 无命中）。脚本本身是模块内常量，不含外部输入。

**关于 `-ExecutionPolicy Bypass`**：这放宽的是 PowerShell 的**脚本文件**执行策略，而这里执行的是 `-Command` 内联文本、且脚本来源是应用自身常量（非用户文件、非网络下载）。它不授予任何本进程原本没有的权限——进程已能以当前用户身份运行任意代码。加上 `-NoProfile`（不加载用户 profile，既避免用户配置干扰、也避免被 profile 注入）与 `-NonInteractive`（不会弹窗阻塞），这组参数是恰当的。另设 `timeout: 15_000` 防止卡死，`windowsHide: true` 防止闪窗。

### 2.3 `.cmd` 转发 shim 的内容 —— **成立**

`quoteBatchWord`（`desktop-cli-shell.ts:259-265`）：

```ts
if (/["\r\n\0]/u.test(value)) fail(`launcher path … must not contain quotes, NUL, or newlines`)
return `"${value.replaceAll('%', '%%')}"`
```

- 含 `"`/CR/LF/NUL 的值**直接拒绝**（无法安全引用，不尝试转义）——拒绝优于猜测。
- `%` 双写为 `%%`：cmd 在批处理文件里把 `%%` 当字面 `%`，因此用户名或路径中的 `%` 不会被展开成变量。测试 `doubles percent signs so a literal path cannot expand as a variable` 覆盖。
- 整体包在双引号里，路径含空格也能正确传递。

`assertLauncherName`（`:146-154`）拒绝 `.` 与 `..`（通过字符类但表示目录，`join(pathDir, '..')` 会写到 shim 目录之外）以及任何不匹配 `^[A-Za-z0-9._-]+$` 的名字；`assertValue`（`:133-144`）拒绝空值与含 NUL/换行的值。调用点在**任何写盘之前**（`:338`，launcher 循环顶部）。

### 2.4 能否经 launcher 名或路径向 shim 目录之外写入 —— **不成立**

`shimPath = join(pathDir, shimFileName(launcher, windows))`，其中 `pathDir = join(options.homeDir, SHIM_DIRECTORY)`（`SHIM_DIRECTORY = 'bin'`），`shimFileName` 只拼 `${name}${ext}`。名字已过 `assertLauncherName` 白名单，路径拼接无 `..` 成分。测试 `:374 rejects a launcher name that would escape the shim directory`、`:209 rejects an empty launcher set and a name that escapes the shim directory`。

---

## 3. 注册表作用域与提权

### 3.1 是否只动 HKCU —— **成立**

- 应用侧：`[Microsoft.Win32.Registry]::CurrentUser`（读脚本 `:48`、写脚本 `:66`、键探测 `:96`）。全文**无** `Registry::LocalMachine` / `HKLM`。
- 安装器侧：两处 `WriteRegExpandStr` 均为 `HKCU`（`:139`、`:166`），备份键亦为 `HKCU "Software\${PRODUCT_NAME}"`（`:131`）。**无** `SetShellVarContext all`、无 `HKLM` 写入。
- ⇒ **不需要管理员权限**，也不影响同机其他用户。

### 3.2 是否存在提权路径 —— **不成立**

被写入的 `.cmd` 位于 `<homeDir>\.dsh\bin`（HKCU 之外的用户自有目录）。该目录若可被低权限用户写入，则低权限用户可放同名 `.cmd` 覆盖 shim —— 但这要求攻击者**已经能写受害者自己的用户目录**，此时攻击者已拥有受害者的文件写入能力，无新增权限。**不构成提权**。

### 3.3 目录与文件权限 —— **恰当**

`installDesktopCliShell`（`:326-371`）：`mkdirSync(pathDir, { recursive: true, mode: PRIVATE_DIRECTORY_MODE })`、`writeFileAtomic(shimPath, shim, EXECUTABLE_FILE_MODE)`。提示状态的 marker 用 `PROMPT_DIRECTORY_MODE = 0o700` / `PROMPT_FILE_MODE = 0o600`（`desktop-cli-prompt.ts:35-36`）。均不宽于必要。

### 3.4 键探测是否只读 —— **成立**

`DESKTOP_WINDOWS_KEY_EXISTS_SCRIPT`（`:92-96`）只做 `OpenSubKey($path)`（无写权限重载）后输出 `'0'`/`'1'`，从不写。`detectDesktopWindowsInstallKind` 短路探测（测试 `:81 stops probing as soon as one record is found`），最多两次只读调用。

---

## 4. 文件系统与用户数据

### 4.1 写 `~/.zshrc` 的行为在 Windows 上是否被跳过 —— **成立**

`installDesktopCliShell` 在 `if (windows) return`（`:355`）**早于**任何 profile 读写，因此 Windows 路径**不可能**创建或修改用户主目录下的 dotfile。测试 `tests/desktop-cli-shell.spec.ts:311 writes no shell profile at all on Windows` 固定该性质。这是本 feature 最需要防的「误伤 mac 逻辑」回归，实现与测试都到位。

### 4.2 `uninstallDesktopCliShell` 是否可能删到用户内容 —— **不成立**

`:384-418`：删除对象只有 `join(pathDir, shimFileName(launcher, windows))`，且前置 `existsSync` + `rmSync(shimPath, { force: true })`（**不传 `recursive`**，因此即使路径意外指向目录也只会失败，不会递归删除）。profile 的标记块删除要求 `start !== -1 && end > start` 同时成立。Windows 分支同样在 profile 处理之前 `return`。

### 4.3 `writeFileAtomic` 的临时文件 —— **可预测，但不跨越信任边界（SUGGESTION）**

`desktop-cli-shell.ts:199-209`：

```ts
const temporary = `${path}.dsh-${String(process.pid)}-${Date.now().toString(36)}.tmp`
```

临时名可预测（含 pid 与毫秒时间戳），但位于 `<homeDir>\.dsh\bin` —— 用户自有、非共享可写目录。要利用它需先能写该目录，此时已等同拥有受害者权限。**不构成安全问题**。并行调用也因 pid+时间戳组合而实际不冲突。若要彻底消除可预测性，可用 `randomBytes(8)` 尾缀（非阻塞建议）。

### 4.4 提示状态 marker 的解析 —— **稳健**

`readDesktopCliPromptState`（`desktop-cli-prompt.ts:124-137`）：

- 读失败（缺失/无权限）→ `undefined`。
- 超长（`> MAX_PROMPT_BYTES = 4 * 1024`）→ `undefined`，**先于 JSON.parse**，避免用超大输入撑爆解析器。
- 解析/校验失败 → `undefined`（`catch` 包住 `parsePromptState`）。
- 坏 marker 一律视为「未询问」：注释写明「asking one extra time is a smaller harm than never offering a portable user a way to their terminal」——**宁可多问一次，不可永远不问**。这是正确的失败方向（提示是幂等的、可撤销的；而错过的提示会让用户以为功能不存在）。
- `desktopCliPromptStatePath`（`:89-94`）校验 `userDataDir` 非空且无 NUL，并 `join` 固定子路径，无穿越。
- 状态写应用数据目录（`<userData>/cli-prompt/state.json`）而非注册表 —— 使其成为「应用级偏好」而非「机器级事实」，第二个用户或第二个 profile 不会误读。测试 `:110`、`:124`、`:128`、`:255 keeps the wording out of the state file`（断言状态文件不含 UI 文案）。

---

## 5. 网络与 IPC 面

### 5.1 两个新路由是否挂在既有的同源回环校验之后 —— **成立**

`desktop-settings-route.ts:501 handleDesktopCliPublishRequest` 与 `:524 handleDesktopCliRevokeRequest` 与既有 10 个 handler **完全同构**：

1. 非 POST ⇒ `405 method not allowed`
2. `isSameOriginLoopbackRequest(req, expectedOrigin, true)` 失败 ⇒ `403 forbidden`
3. `parsePostBody` 失败 ⇒ `400`
4. `isEmptyRequest` ⇒ `400 'invalid CLI publication request'` / `'invalid CLI revocation request'`
5. catch ⇒ `reportError('publish CLI commands'|'revoke CLI commands', cause)` + `500 'CLI commands could not be published'` / `'CLI registration could not be removed'`

**没有为这两个新路由发明第二套约定**，也没有放宽既有校验。测试 `tests/desktop-settings-api.spec.ts:807`（7 例）+ `:913`（2 例）覆盖状态码 400/403/405/415/500。

### 5.2 能力缺席时是否返回诚实失败 —— **成立**

`createDesktopCliPublisher` 在 `platform !== 'win32'` 时 `fail(\`${platform} has no registry-backed CLI PATH entry to publish\`)`（`desktop-cli-publication.ts:126-150`）；控制器在无能力时 `throw new Error('dsh-plugin-desktop: CLI publication is unavailable')`（`desktop-settings-controller.ts:234`）/ `'… CLI revocation is unavailable'`（`:244`）。⇒ POSIX 上路由返回**真失败**，而不是伪装的 no-op 成功。这正是 `design.md` 的要求（诚实失败优于假成功）。

### 5.3 客户端产物是否含敏感数据 —— **不成立**

`src/client/*` 只含路由常量、类型、中英双语文案（`desktop-settings-locales.ts` 的 16 个 `cli*` 键 × 2 语言）。无路径、无用户名、无凭据。

---

## 6. 依赖与供应链

- 本 feature **未新增任何依赖**（两变体 `package.json` 的 `git diff --stat 189020607c..HEAD` 为**空**）。
- 未新增二进制拷贝：Windows shim 是**渲染**（`renderWindowsShim`，`:298-307`）而非复制。`mnemon` 条目无 `mnemon.exe` 副本（测试 `:264` 断言 `shimPaths` 恰为两项、无 `.exe`），`codegraph` 条目也无上游 `bin\codegraph.cmd` 副本（测试 `:287` 断言不含 `%~dp0` 且 `length < 400`）。
  - 这一点的安全意义：**拷贝上游 `.cmd` 会把 shim 绑死在包目录**（上游用 `%~dp0` 解析自身位置），包一移动就坏——但从安全角度更重要的是，渲染方案使 shim 内容完全由本应用决定、不含上游脚本的任意内容。
- 未引入 `mklink /J`（设计明确拒绝）——避免创建可被绕过的联接点。

---

## 7. 已核验为安全的做法（**成立**）

以下各项经读码与实测确认，无缺陷：

| # | 做法 | 位置 |
|---|------|------|
| 1 | PATH 读写均保 `REG_EXPAND_SZ` | `desktop-windows-path.ts:46-68` |
| 2 | **未**使用 `setx` | 全仓库 grep 无命中 |
| 3 | **未**使用 `reg.exe` 读改写 | 全仓库 grep 无命中 |
| 4 | 用户数据全走环境变量，不插入脚本文本 | `:26-27`、测试 `:304` |
| 5 | `execFileSync` 参数数组调用，无 `shell: true` | `:261-274`、grep 无命中 |
| 6 | 键探测只接受字面 `'1'`/`'0'`，失败不吞 | `:109-124` |
| 7 | 全程 HKCU，无 HKLM，不需管理员 | `:48/:66/:96` + `installer.nsh:139/:166` |
| 8 | 安装器恰好 2 处 `WriteRegExpandStr`，均在 HKCU | `installer.nsh`，`grep -c` = 2 |
| 9 | 撤销只删自己的条目，reshape 用户其余分隔符 | `:237-254`、测试 `:135`/`:156` |
| 10 | 卸载仅在条目仍为末尾时移除，保留 shim 文件 | `installer.nsh:157-169`、`:154-156` 注释 |
| 11 | Windows 路径绝不触碰 dotfile | `:355`、测试 `:311` |
| 12 | 卸载不 `recursive`、不触及用户数据目录 | `:391-395` |
| 13 | `.cmd` 路径拒绝含引号/换行的值，`%` 双写 | `:259-265` |
| 14 | launcher 名白名单 + 显式拒绝 `.`/`..` | `:146-154` |
| 15 | 提示 marker 坏内容一律视为「未询问」，超长先截 | `desktop-cli-prompt.ts:124-137` |
| 16 | marker 写应用数据目录（0o600/0o700），非注册表 | `:35-36`、`:89-94` |
| 17 | 便携版判定只读注册表，**不猜路径**、不用 `PORTABLE_EXECUTABLE_DIR` | 全仓库 grep 无命中 |
| 18 | 两个新路由复用既有 5 行同源回环前置 | `desktop-settings-route.ts:501`/`:524` |
| 19 | 非 Windows 上发布能力返回诚实失败，非假成功 | `desktop-cli-publication.ts:126-150` |
| 20 | 未新增依赖，未拷贝二进制或上游脚本 | `package.json` diff 为空 |
| 21 | 失败不阻断启动（shim 段 try/catch；提示段 void 不 await） | `main.ts:763-777`、`:1814` |

---

## 分级结论

### CRITICAL：0 条

本 feature 未发现可导致用户环境损坏、权限提升、命令注入或数据泄露的缺陷。PATH 写入是本 feature 唯一可能损伤用户环境的点，其保型、查重、幂等、撤销对称性均有实现与测试双重保障，且未使用两种已知会破坏 PATH 的方案。

### IMPORTANT：0 条

### SUGGESTION：3 条

```
S1. writeFileAtomic 的临时文件名可预测（desktop-cli-shell.ts:199-209）——不跨越信任边界（目录属用户自有），
    非阻塞。若想彻底消除可预测性可用 randomBytes(8) 尾缀。
S2. 读脚本取回的 Path 类型（kind）目前只被测试消费，registry.write(value) 不接收 kind
    （desktop-windows-path.ts:46-53 读出 + :62-70 写入）。REG_SZ → REG_EXPAND_SZ 的升格在 PATH 上是良性的
    （含 %VAR% 的值本就该是 ExpandString），但既然已付代价读回类型，要么在 'Unknown' 时拒绝写入，
    要么在注释里写明 kind 仅供诊断与测试使用。非阻塞。
S3. -ExecutionPolicy Bypass（:255-275）放宽了脚本文件执行策略，此处执行的是应用自身常量的 -Command 内联文本、
    非用户文件/非下载内容，不授予额外权限，且配 -NoProfile/-NonInteractive/15s 超时，属恰当用法。
    仅作为「已注意到并接受」记录在案。
```

### 需要真机复核的项（不计入本报告结论）

以下属**功能正确性**而非安全性，但安全审查在此一并标注以便发布前覆盖（与 `verify-report.md` 第五节一致）：覆盖升级后的 PATH 形态、卸载后的 PATH 清理、中文用户名/路径的 `.cmd` 解析。安全性上这三项的风险是「PATH 内容异常」或「命令无法解析」，均有回滚路径（`HKCU\Software\<产品名>\PathBackup` + 撤销条目 + 删除 `.cmd`）。

---

## 审查说明

- 本报告为**静态安全审查**：读码 + 字面搜索实测，未独立重跑门禁与测试。
- 行号均为 **beta 变体**（`dsh-plugin-desktop-beta/`）实测值；stable 为逐字节镜像。
- 明确排除了同 commit 范围内的 macOS universal 准备脚本（另一 feature）。
- 已知基线问题（非本 feature 引入）：`tests/host-process-integration.spec.ts` 的 2 个 EPERM 失败与 `~/.dsh/.credentials.yaml.lock` 权限有关，与安全性判定无关。

结论：**APPROVE**
