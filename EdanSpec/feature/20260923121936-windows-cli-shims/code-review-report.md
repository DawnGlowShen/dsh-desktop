# 代码审查报告：windows-cli-shims

| 字段 | 值 |
|------|-----|
| **审查范围** | `dsh-plugin-desktop-beta/src/desktop-cli-shell.ts`（408 行，新增 win32 分支）、`desktop-windows-path.ts`（新增）、`desktop-windows-install-kind.ts`（新增）、`desktop-cli-publication.ts`（157 行，新增）、`desktop-cli-prompt.ts`（新增）、`desktop-settings-{contract,controller,route}.ts`、`index.ts`、`src/client/{desktop-settings-api.ts,desktop-settings-locales.ts,DesktopSettingsSection.tsx}`、`main.ts`、`host-bootstrap.ts`、`build/installer.nsh`、`tests/` 8 个 spec |
| **审查基准** | `189020607c..10f529f187`（12 个 commit）。同范围内的 `scripts/prepare-*.mjs` / `scripts/prepare-universal-bundle*` 属于 **macOS universal feature**，已排除 |
| **变更类型** | 新功能：Windows 终端可直接使用 codegraph / mnemon（转发 shim + PATH 登记 + 设置入口 + 便携版一次性提示） |
| **变更规模** | `*/src` 30 files / 3018 insertions；全量 diff 95 files / 9110+ / 618- |
| **镜像关系** | beta 为原始改动，stable 为逐字节镜像（`check:desktop-variants` = 188 aligned）；本报告只引 beta 行号 |
| **结论** | APPROVE WITH COMMENTS |

> 门禁已由上游验证通过（`check:win-package` 两变体 exit 0、`verify-runtime-closure: 247 first-party nodes form a closed reachable runtime graph.`、`check:desktop-variants: 188 shared source files are aligned`、本 feature 8 文件 166 passed、两变体 typecheck exit 0）。本次为**静态增量审查 + 定点读码核对**，未独立重跑门禁。

---

## 问题摘要

| 级别 | 数量 | 说明 |
|------|------|------|
| CRITICAL | 0 | 必须修复才能合并 |
| IMPORTANT | 2 | 应该修复再合并 |
| SUGGESTION | 4 | 可以考虑 |

---

## CRITICAL Issues（必须修复）

共 0 个。

```
（无）
```

---

## IMPORTANT Issues（应该修复）

```
#: 1
位置：EdanSpec/feature/20260923121936-windows-cli-shims/design.md:150-152
维度：可维护性 / 正确性文档
问题描述：design.md 的表格写对了最终形态（`<bundleDir>\node.exe --liftoff-only --disable-warning=ExperimentalWarning <bundleDir>\lib\dist\bin\codegraph.js %*`），但紧接着的散文句称「渲染时取其 `dirname` 的上一级推导 `node.exe`」——这是错的。`codegraph.js` 位于 `<bundle>\lib\dist\bin\`，从它的 dirname 上溯到 bundle 根需要 3 层，不是 1 层。照该句实现会把 `node.exe` 指向 `<bundle>\lib\dist\node.exe`（不存在），shim 一执行就报「不是内部或外部命令」。
影响：本实现没有照该句实现，而是用 CODEGRAPH_SCRIPT_DIRECTORIES = ['bin','dist','lib'] 逐层校验回走（src/desktop-cli-shell.ts:68、:275-287），比 design 更严格：布局不符时 fail() 报出清晰错误，而不是静默拼出坏路径。因此**线上无缺陷**，但该句会误导后续读者或下一个实现者。
建议：把 design.md:152 那句改为「取其 dirname 并校验上溯 `bin\dist\lib` 三层后得到 bundle 根」，或直接删掉该句、只保留表格（表格已经准确）。
```

```
#: 2
位置：dsh-plugin-desktop-beta/src/desktop-cli-prompt.ts:182 clearDesktopCliPromptState
维度：完整性
问题描述：clearDesktopCliPromptState 被导出但**无任何调用点**（`grep -rn 'clearDesktopCliPromptState' */src/` 只命中定义处与两变体自身）。用户在便携版首次启动点了「暂不」后，marker 永久为 declined，此后即使把便携目录搬到别处、或当初误点，也不会再被询问，且**设置面板没有「恢复提示」开关**。唯一出路是设置里的「登记/撤销」按钮（可行，但不等于「恢复那个提示」）。
影响：不是 spec 违约（spec 明确要求「点暂不后不再询问」），也不会导致功能不可用（设置入口始终在）。但一个导出的公开函数没有调用点，通常是「设计了但忘了接」的信号；若确实不打算提供 UI，则该函数应降为模块私有或删除，避免读者误以为已有恢复路径。
建议：二选一 —— ① 在设置面板 CLI 区块加「不再提示/恢复提示」开关并接上该函数；② 若不打算做，把该函数从 export 降级，或在文档中写明 marker 路径（`<userData>/cli-prompt/state.json`）以便手工删除。当前状态下建议至少补一行测试外的注释说明「目前仅供将来的恢复入口使用」。
```

---

## SUGGESTION（可选改进）

```
#: 1
位置：dsh-plugin-desktop-beta/src/desktop-cli-prompt.ts:220-229
维度：可观测性
问题描述：detectInstallKind 抛错时（注册表读不出来 / PowerShell 被策略禁用 / 注册表被锁），函数记一条日志后 return，用户侧完全静默。语义本身是对的——「读不到 ≠ 便携版」，宁可不问也不能把一个已安装的用户当便携版问（那是在陈述假事实），且测试 :222 已固定该行为。但在企业环境下，用户既看不到启动提示、也不知道设置里还有入口。
建议：可选地在设置面板的 CLI 区块常驻一行静态提示（「若终端里没有 codegraph/mnemon，可在此重新登记」），使这条出路不依赖启动提示是否出现过。这是纯增益，不改变任何判定逻辑。
```

```
#: 2
位置：dsh-plugin-desktop-beta/src/desktop-cli-shell.ts:199-209 writeFileAtomic
维度：健壮性
问题描述：临时文件名为 `${path}.dsh-${process.pid}-${Date.now().toString(36)}.tmp`（可预测），且写在目标文件同目录。该目录是 `<homeDir>\.dsh\bin`，属用户自有目录、非共享可写目录，正常情形下不跨越信任边界（与 bundle-mnemon feature 的 security-review 对同一函数给出的结论一致：S6，可预测但不跨信任边界）。另：writeFileSync 用 `{ mode }` 创建，但若临时文件已存在则不会收紧权限，随后 chmodSync(path, mode) 只作用于最终路径。
建议：非阻塞。若想彻底消除可预测性，可用 `mkdtemp` 或 `randomBytes(8)` 尾缀。当前不构成安全问题。
```

```
#: 3
位置：dsh-plugin-desktop-beta/src/desktop-windows-path.ts:62-68 DESKTOP_WINDOWS_PATH_WRITE_SCRIPT
维度：防御性
问题描述：写脚本从环境变量 DSH_WINDOWS_PATH_VALUE 取值，但**不校验新值的类型**——它无条件以 ExpandString 写回。这是对的（想保留 REG_EXPAND_SZ 就只能这么写），且读脚本已把实际 kind 解析出来（:46-56），parseReadPayload（:275-295）也把非 ExpandString/String 归为 'Unknown'。但当前**没有**任何调用方消费 kind 字段来决定是否继续写：即使发现用户 PATH 原本是 REG_SZ，也会被静默升格为 REG_EXPAND_SZ（内容不变，类型变了；对不含 % 的值两者语义等价）。
建议：非阻塞，但值得一个显式决定。REG_SZ → REG_EXPAND_SZ 的升格在 PATH 上是良性的（含 %VAR% 的值本就该是 ExpandString），但既然读脚本已经付代价取回了 kind，要么在 registry.write 前对 'Unknown' 类型拒绝写入并给出清晰错误，要么在注释里写明「kind 目前仅用于测试断言与诊断」。当前 `registry.write(value)` 的签名不带 kind，读回的 kind 事实上只被测试使用。
```

```
#: 4
位置：dsh-plugin-desktop-beta/src/desktop-cli-publication.ts:126 createDesktopCliPublisher 的 POSIX 分支
维度：一致性
问题描述：createDesktopCliPublisher 在 platform !== 'win32' 时 fail(`${platform} has no registry-backed CLI PATH entry to publish`)。这是刻意的（POSIX 上 macOS/Linux 靠启动时写 shell profile，路由应返回诚实的失败而不是假的 no-op 成功），模块注释 :1-25 也写明了。但调用方 main.ts:784 用的是 `process.platform === 'win32' ? createDesktopCliPublisher({...}) : undefined`——即 POSIX 上**根本不会构造** publisher，于是这个 fail 分支在真实运行路径上不可达，只有测试会走到。
建议：非阻塞。这个「不可达的错误分支」是正当的防御（构造器不应信任调用方一定做了平台检查），保留即可。但如果想让读者不困惑，可把注释从「POSIX 上调用方不构造 publisher」改成更直白的「本函数在非 win32 上一律失败；调用方应自己先判平台，这个失败是兜底」。当前注释已接近这个意思。
```

---

## 做得好的地方

1. **幂等靠内容比较而非存在性**：`if (readTextIfPresent(shimPath) !== shim)`（`desktop-cli-shell.ts:343`）配 `writeFileAtomic`，使得「重复启动不写盘」「bundle 移动后自动覆盖」「空/陈旧 shim 不被跳过」三个场景由同一行代码同时满足，且三个场景各有独立测试（`tests/desktop-cli-shell.spec.ts:322`、`:335`、`:348`）。这比常见的 `existsSync` 早退写法正确得多。

2. **数据走环境变量而非脚本插值**：`desktop-windows-path.ts:26-27` 的两个环境变量（`DSH_WINDOWS_PATH_VALUE`、`DSH_WINDOWS_REGISTRY_KEY`）承载路径与键名，PowerShell 脚本文本里不含任何用户数据。测试 `:304 passes the key as data, never as script text` 用 `Software\O'Brien$Corp` 这种带引号和 `$` 的键名验证——这正是「把路径插进脚本」会炸掉的输入。同一纪律也用在 `install-kind` 的 probe 上。

3. **`%~dp0` 的刻意缺席**：`renderWindowsShim`（`:298-307`）内嵌绝对路径、每次启动重算，注释明确说明「为什么拷贝上游 `codegraph.cmd` 会立刻坏」——上游脚本用 `%~dp0` 解析自身位置，一旦被拷到 `.dsh\bin` 就会指向错误的包目录。测试 `:287` 同时断言不含 `%~dp0`/`%~dpn0` 且内容长度 < 400（量级上排除「拷贝了二进制」）。这是本 feature 最核心的设计判断，实现、注释、测试三者一致。

4. **`%` 转义**：`quoteBatchWord`（`:259-265`）先拒绝含 `"`/CR/LF/NUL 的值，再把 `%` 双写为 `%%`。在 `.cmd` 里 `%%` 才是字面 `%`，若用户名含 `%`（如 `C:\Users\%TEMP%`）会被 cmd 当变量展开。测试 `doubles percent signs so a literal path cannot expand as a variable` 覆盖。

5. **平台判断的分层正确**：`host-bootstrap.ts:207` 用注入的 `runtime.platform === 'win32'`（可测），`main.ts` 用 `process.platform`（main 进程本就无 runtime，属仓库既有惯例）。测试 `tests/desktop-windows-install-kind.spec.ts:91 asks only about registry keys, never about a path` 断言产物中 `not.toContain('PORTABLE_EXECUTABLE_DIR')`——没有掉进「猜解压路径」的陷阱。

6. **安装形态判定不猜路径**：`desktop-windows-install-kind.ts` 只读 `INSTALL_REGISTRY_KEY` / `UNINSTALL_REGISTRY_KEY` 两个注册表键（`:81 stops probing as soon as one record is found` 证明是短路探测），GUID 用 UUIDv5 从 appId 推导（`ELECTRON_BUILDER_UUID_NAMESPACE`），与 electron-builder 的 NSIS 行为对齐。不依赖 `PORTABLE_EXECUTABLE_DIR`，也不看目录形状。

7. **失败不阻断启动**：shim 生成段（`main.ts:763-777`）包在 try/catch 内只记日志；便携版提示段（`:1814`）用 `void runDesktopCliPortablePrompt({...}).catch(...)` **刻意不 await**，测试 `:196 never lets the prompt delay or break startup` 固定该形态。启动路径上不该有能阻塞或抛错的窗口。

8. **路由严格复用既有 5 行前置**：`desktop-settings-route.ts:501` / `:524` 与既有 10 个 handler 完全同构（405 → 同源回环校验 → 403 → `parsePostBody` → `isEmptyRequest` → 400），没有为两个新路由发明第二套约定。`tests/desktop-settings-api.spec.ts:807`（7 例）+ `:913`（2 例）覆盖含 400/403/405/415/500。

9. **撤销保留 shim 文件**：`revoke()` 只 `unregisterDesktopWindowsPath`，不删 `.cmd`；卸载器同样保留（`installer.nsh:154-156` 注释说明该目录属用户数据、且另一版本可能共用）。这是正确的所有权边界——撤销「登记」不等于删除「文件」。

---

## 验证记录

| 项目 | 命令 | 结果 |
|------|------|------|
| 本 feature 测试 | `corepack yarn vitest run <8 files>`（beta） | **166 passed (8 files)**：shell 26 / path 29 / install-kind 20 / publication 10 / prompt 17 / settings-api 49 / client-cli 7 / installer-nsh 8 |
| 两变体镜像 | `corepack yarn check:desktop-variants` | `188 shared source files are aligned; both editions use isolated Host and chrome` |
| Windows 打包门禁 | `yarn workspace dsh-plugin-desktop{,-beta} check:win-package` | 两变体 exit 0；`verify-runtime-closure: 247 first-party nodes form a closed reachable runtime graph.` |
| 全量门禁 | `corepack yarn check` | exit 1，但**唯一**失败是 `tests/host-process-integration.spec.ts` 的 2 个既有基线用例（`EPERM: … ~/.dsh/.credentials.yaml.lock`，本 feature 开始前已用 `git stash` 在基线复现）。`Test Files 1 failed \| 141 passed (142)`、`Tests 2 failed \| 1517 passed \| 8 skipped (1527)` |
| NSIS PATH 写入次数 | `grep -c 'WriteRegExpandStr HKCU "Environment" "Path"' */build/installer.nsh` | 两变体均 = **2**（安装 1 次 + 卸载 1 次） |
| 禁用手段缺席 | `grep -rn 'setx\|reg\.exe' */src/ */build/installer.nsh`；`grep -rn 'shell: *true' */src/`；`grep -rn 'PORTABLE_EXECUTABLE_DIR' */src/` | **全部无命中** |
| 旧登记目标已废弃 | `grep -n 'resources.*bin' */build/installer.nsh` | 仅 `:108` 的 `DSH_CODEGRAPH_BIN` define，只用于 `:116` 的 `FileExists` 判断，从不进入 `StrCpy`/`WriteRegExpandStr` |
| 平台判定不读环境 | `grep -n 'installKind\|InstallKind' desktop-cli-publication.ts desktop-settings-controller.ts desktop-settings-route.ts` | **无命中**（登记路径完全不感知安装形态） |

---

## 审查说明

- 本报告为**静态审查**：读码 + 定点 grep + 复用上游已跑的门禁结果，未独立重跑 `yarn check`（上游刚跑过，且耗时较长）。
- 行号均为 **beta 变体**（`dsh-plugin-desktop-beta/`）实测值。stable 变体除产品名外逐字节相同。
- 审查范围明确排除了同 commit 范围内的 macOS universal 准备脚本（`scripts/prepare-*.mjs`、`scripts/prepare-universal-bundle*`），它们属于另一个 feature。
- 未发现 CRITICAL。2 条 IMPORTANT 中，**#1 是文档错误而非代码缺陷**（实现比文档更严格），**#2 是一个导出函数无调用点**，二者都不影响本 feature 的正确性或 spec 履约，故整体结论为 APPROVE WITH COMMENTS 而非 REQUEST CHANGES。
- 已知基线问题（非本 feature 引入）：`tests/host-process-integration.spec.ts` 的 EPERM 失败，源于本机 `~/.dsh/.credentials.yaml.lock` 权限与 `dsh-client-connection` 加载器，与本 feature 无关。

结论：**APPROVE WITH COMMENTS**
