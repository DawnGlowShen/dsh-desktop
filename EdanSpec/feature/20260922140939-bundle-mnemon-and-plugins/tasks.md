# 内置 mnemon 插件与 mnemon CLI 任务清单

> 上游：`proposal.md`、`specs/mnemon-cli-bundling-spec.md`、`specs/desktop-preinstalled-plugins-spec.md`、`design.md`
> 全局约定：**先改 `dsh-plugin-desktop-beta/`，再同步 `dsh-plugin-desktop/`**；两包 `src/` 必须逐字节一致（`src/product-identity.ts` 除外）。每个任务完成后跑其「完成判定」中的命令，通过后再进入下一任务。
> 失败策略：连续 2 次失败 → `edanspec-debugging`；3 次 → `edanspec-explore`；4 次 → 停下来报告用户。

## 阶段一：mnemon CLI 物化链路

### Task-001：vendor 平台归档与物化脚本

**描述**：把 mnemon 的两个平台 tgz 纳入 `vendor/mnemon/`，并新增 `scripts/prepare-mnemon.mjs`，使它能把归档解包校验到 `{desktop}/build/mnemon/host/`。镜像 `scripts/prepare-codegraph.mjs`，但断言规则不同：mnemon 平台包的 `package.json` 中 `name` 是主包名 `@mnemon-dev/mnemon`，`version` 才是带平台后缀的 `0.2.9-<targetKey>`。

**关联需求**：`specs/mnemon-cli-bundling-spec.md` §平台二进制通过 vendor 归档物化、§平台归档可追溯。
→ Agent：读取该 spec 确认 `--check` 行为、幂等复用条件、失败输出前缀。

**前置依赖**：无。

**工时估算**：0.5 人天
- 基础：0.35 人天（S）
- 缓冲：0.35 × 30% × 1.5 = 0.16 人天（依赖风险 - 中：归档布局与 codegraph 不同，需实测确认）
- 总计：0.51 人天
→ Agent：缓冲计算规则见 `references/risk-classification.md`。

**涉及文件**：
- `vendor/mnemon/mnemon-darwin-arm64-0.2.9.tgz` — 新增（已下载，6,298,831 字节，sha256 `004d6454625db1e880d83da057a801f9ec87fd08654af715d5d906ea1b2d464a`）
- `vendor/mnemon/mnemon-win32-x64-0.2.9.tgz` — 新增（已下载，5,699,948 字节，sha256 `10e2d8d9e5f93d185018495b5c4822715bd0ad16873202f6d3b1a7696d6f69ef`）
- `scripts/prepare-mnemon.mjs` — 新增
- `.gitignore` — 新增 `dsh-plugin-desktop/build/mnemon/`、`dsh-plugin-desktop-beta/build/mnemon/`

**验收标准**：
- **物化成功**：`node scripts/prepare-mnemon.mjs --desktop dsh-plugin-desktop --target darwin-arm64` 退出码为 0，且 `dsh-plugin-desktop/build/mnemon/host/bin/mnemon` 存在、带可执行位、`host/package.json` 的 `license` 为 `Apache-2.0`。验证方式：执行该命令后 `test -x` 与 `node -e` 读 package.json。
- **校验模式不写盘**：在未物化的目标上执行 `--check` 时退出码非 0 且 stderr 以 `prepare-mnemon: ` 开头，`build/mnemon/` 下无文件生成。验证方式：`rm -rf build/mnemon && node scripts/prepare-mnemon.mjs --check; echo $?`。
- **幂等**：连续执行两次，第二次输出包含 `reusing`，`.prepared.json` 的归档 sha256 两次相同。验证方式：比对两次命令输出与标记文件。
- **拒绝非桌面包目录**：`--desktop /tmp/not-a-desktop` 时退出码非 0 且不写文件。验证方式：在临时目录放一个 `name` 不匹配的 `package.json` 后执行。

**增量计划**：
- [x] **增量 1**：归档 git 登记与 `.gitignore`
  - 做什么：确认 `vendor/mnemon/` 下两个 tgz 存在且 sha256 与上文一致，`.gitignore` 追加两条构建产物的忽略规则
  - 交付：`vendor/mnemon/` 两个归档入库；`.gitignore` 更新
  - 对应验收标准：物化成功（前置条件）
  - 完成判定：`shasum -a 256 vendor/mnemon/*.tgz` 与上文一致 && `git check-ignore -v dsh-plugin-desktop/build/mnemon/` 有输出
- [x] **增量 2**：`TARGETS` 与校验逻辑
  - 做什么：定义 `darwin-arm64` / `win32-x64` 两个目标（各自归档文件名、期望 sha256、可执行文件名），断言 `name`/`version`/`license`
  - 交付：`scripts/prepare-mnemon.mjs` 可完成一次完整物化
  - 对应验收标准：物化成功
  - 完成判定：`node scripts/prepare-mnemon.mjs --desktop dsh-plugin-desktop --target darwin-arm64 && node scripts/prepare-mnemon.mjs --desktop dsh-plugin-desktop --target win32-x64`
- [x] **增量 3**：`--check` 与幂等复用分支
  - 做什么：实现 `--check` 失败分支与基于 `.prepared.json` 的复用分支
  - 交付：`--check` 与非 `--check` 两条路径行为符合 spec
  - 对应验收标准：校验模式不写盘、幂等、拒绝非桌面包目录
  - 完成判定：逐条执行三条验收命令

**失败策略**：见全局约定。若归档内布局与预期不符，先打印实际 tar 列表再改断言，不得放宽断言。

### 检查点 1

```bash
node scripts/prepare-mnemon.mjs --desktop dsh-plugin-desktop --target darwin-arm64
node scripts/prepare-mnemon.mjs --desktop dsh-plugin-desktop --target win32-x64
node scripts/prepare-mnemon.mjs --desktop dsh-plugin-desktop --target darwin-arm64 --check
dsh-plugin-desktop/build/mnemon/host/bin/mnemon --version   # 期望：mnemon version 0.2.9
```

---

## 阶段二：三个插件进入内置预装清单

### Task-002：beta 变体接入三个插件

> **执行记录（偏离）**：`scripts/preinstall-plugins.mjs` 的 `applyEdits()` 内部对 `VARIANTS` 循环，**一次 `add` 调用同时写两个变体的 4 个文件**，没有 `--variant` 参数。因此 Task-002 与 Task-003 无法分开执行，已**合并为一次操作**，两个变体同时到位。
>
> **执行记录（版本偏离）**：`billion-context` 实际落地版本为 **0.1.131**，不是本任务书原定的 0.1.135。原因：`corepack corepack yarn install` 报 `YN0016: billion-context@npm:0.1.135: All versions satisfying "0.1.135" are quarantined` —— 仓库 Yarn 4.18 的 `npmMinimalAgeGate` 默认 1440 分钟（24h）供应链观察期，而 0.1.135 发布仅 4.2 小时。0.1.131 发布于 39.9 小时前，是能通过该门禁的最新版本（0.1.132/133/134/135 均被隔离）。已经用户决策确认改用 0.1.131，未放宽门禁、未改动 `npmPreapprovedPackages`。

**描述**：用仓库既有脚本把 `billion-context@0.1.131`、`dsh-rewind-plugin@0.12.2`、`dsh-mnemon@0.5.12` 加入 beta 变体的 `dependencies` 与 `DEFAULT_PROFILE_PLUGIN_BUNDLES`。**不使用** `--no-verify`，让脚本内置的四道门禁真实跑一遍。

**关联需求**：`specs/desktop-preinstalled-plugins-spec.md` §默认预装插件清单。
→ Agent：读取该 spec 确认清单内容、字母序位置、版本号。

**前置依赖**：无（与 Task-001 无文件交集，可并行）。

**工时估算**：0.25 人天
- 基础：0.2 人天（XS）
- 缓冲：0.2 × 30% × 1 = 0.06 人天（依赖风险 - 低：脚本已存在，只调它）
- 总计：0.26 人天

**涉及文件**：
- `dsh-plugin-desktop-beta/package.json` — `dependencies` 增加三项
- `dsh-plugin-desktop-beta/src/product-identity.ts` — `DEFAULT_PROFILE_PLUGIN_BUNDLES` 增加三项

**验收标准**：
- **依赖与清单同时到位**：`node scripts/preinstall-plugins.mjs list` 中三项在两个变体下均显示 `✓/✓`（stable 一侧此时可以是 `✗/✗`，Task-003 补上）。验证方式：执行该命令比对输出。
- **清单按字典序**：`billion-context` 位于 `@linxin666/dsh-client-ui-git-graph` 之后、`dsh-better-sidebar` 之前。验证方式：`node -e` 读 beta 的 `product-identity.ts` 或 `grep -n` 数组。
- **许可证与闭包门禁通过**：`corepack yarn --cwd dsh-plugin-desktop-beta run verify:licenses` 与 `verify:closure` 均退出码 0。验证方式：直接执行两条命令。

**增量计划**：
- [x] **增量 1**：`billion-context` 与 `dsh-rewind-plugin`
  - 做什么：两次 `add` 调用，观察门禁输出
  - 交付：两项进入 beta 的依赖与清单
  - 对应验收标准：依赖与清单同时到位
  - 完成判定：`node scripts/preinstall-plugins.mjs add billion-context@0.1.131 && node scripts/preinstall-plugins.mjs add dsh-rewind-plugin@0.12.2`
- [x] **增量 2**：`dsh-mnemon`
  - 做什么：加入第三个插件，确认其 16 个子包不引入许可证问题
  - 交付：三项齐备
  - 对应验收标准：依赖与清单同时到位、清单按字典序
  - 完成判定：`node scripts/preinstall-plugins.mjs add dsh-mnemon@0.5.12`
- [x] **增量 3**：门禁复跑
  - 做什么：单独跑 `verify:licenses` 与 `verify:closure`，确认不是被 `add` 的临时环境掩盖
  - 交付：门禁结论
  - 对应验收标准：许可证与闭包门禁通过
  - 完成判定：`corepack yarn --cwd dsh-plugin-desktop-beta run verify:licenses && corepack yarn --cwd dsh-plugin-desktop-beta run verify:closure`

**失败策略**：见全局约定。若某个传递依赖 license 不在白名单，先记录包名与 license，停下来报告用户，不得放宽 `ALLOWED_LICENSES`。

### Task-003：stable 变体同步

**描述**：对 stable（`dsh-plugin-desktop`）执行同样的三项 `add`，使两个变体一致。

**关联需求**：`specs/desktop-preinstalled-plugins-spec.md` §默认预装插件清单（既有清单项不回归）。

**前置依赖**：Task-002。

**工时估算**：0.15 人天
- 基础：0.12 人天（XS）
- 缓冲：0.12 × 30% × 1 = 0.04 人天（依赖风险 - 低）
- 总计：0.16 人天

**涉及文件**：
- `dsh-plugin-desktop/package.json` — `dependencies` 增加三项
- `dsh-plugin-desktop/src/product-identity.ts` — `DEFAULT_PROFILE_PLUGIN_BUNDLES` 增加三项

**验收标准**：
- **两变体一致**：`node scripts/preinstall-plugins.mjs list` 中三项两侧均为 `✓/✓`，且无「在清单里但不在 dependencies」告警。验证方式：执行该命令。
- **既有 7 项未回归**：清单总数由 7 变 10，原有 7 项仍全部存在。验证方式：`node scripts/preinstall-plugins.mjs list` 计数。
- **变体门禁通过**：`corepack yarn check:desktop-variants` 退出码 0。验证方式：仓库根执行。

**增量计划**：
- [x] **增量 1**：stable 三项 `add`
  - 做什么：对 stable 变体执行三次 `add`
  - 交付：stable 依赖与清单同步
  - 对应验收标准：两变体一致
  - 完成判定：`node scripts/preinstall-plugins.mjs list`
- [x] **增量 2**：变体一致性门禁
  - 做什么：跑 `check:desktop-variants` 与根 `plugins:verify`
  - 交付：一致性结论
  - 对应验收标准：既有 7 项未回归、变体门禁通过
  - 完成判定：`corepack yarn check:desktop-variants && corepack yarn plugins:verify`

> **执行记录**：增量 1 由 Task-002 的同一批 `add` 调用完成（见 Task-002 执行记录）。实测 `node scripts/preinstall-plugins.mjs list` 输出 10 个插件，三项在两个变体下均 `✓/✓`，无漂移告警；`node scripts/verify-desktop-variants.mjs` 输出 `184 shared source files are aligned`，退出码 0；两个变体的 `verify:licenses`（941 个生产包）与 `verify:closure`（247 个 first-party 节点）退出码均为 0。

**失败策略**：见全局约定。

### 检查点 2

```bash
node scripts/preinstall-plugins.mjs list
corepack yarn check:desktop-variants
corepack yarn plugins:verify
```

---

## 阶段三：打包配置

### Task-004：beta 变体打包配置与断言

**描述**：beta 的 `package.json` 增加 `build.extraResources` 的 `build/mnemon/host → mnemon` 条目、`build.mac.x64ArchFiles` 追加 `Resources/mnemon/**`、五个打包脚本前缀 `node ../scripts/prepare-mnemon.mjs && `；同步更新 `tests/package.spec.ts` 中逐字符断言这些脚本字符串与 `extraResources` 深比较的用例。

**关联需求**：`specs/mnemon-cli-bundling-spec.md` §mnemon 二进制随安装包分发。

**前置依赖**：Task-001（脚本存在才能被脚本字符串引用）、Task-002（同文件 `package.json`，避免冲突；顺序执行）。

**工时估算**：0.4 人天
- 基础：0.3 人天（S）
- 缓冲：0.3 × 20% × 1 = 0.06 人天（技术风险 - 低）
- 总计：0.36 人天

**涉及文件**：
- `dsh-plugin-desktop-beta/package.json` — `build.extraResources`、`build.mac.x64ArchFiles`、五个打包脚本
- `dsh-plugin-desktop-beta/tests/package.spec.ts` — 脚本字符串断言与 `extraResources` 深比较

**验收标准**：
- **五个脚本前缀齐备**：`package:dir`、`dist:mac`、`dist:mac-smoke`、`dist:win`、`dist:win-portable` 均以 `node ../scripts/prepare-mnemon.mjs && node ../scripts/prepare-codegraph.mjs && ` 开头。验证方式：`node -e` 读 `package.json` 打印五个脚本。
- **extraResources 与 x64ArchFiles 正确**：`extraResources` 含 mnemon 条目且 codegraph 条目未动；`mac.x64ArchFiles` 同时含 `Resources/codegraph/**` 与 `Resources/mnemon/**`。验证方式：`node -e` 断言。
- **打包用例通过**：`corepack yarn --cwd dsh-plugin-desktop-beta test tests/package.spec.ts` 退出码 0。验证方式：直接执行。

**增量计划**：
- [x] **增量 1**：`package.json` 的 `build` 三处改动
  - 做什么：加 `extraResources` 条目、加 `x64ArchFiles` 片段、五个脚本加前缀
  - 交付：打包配置就绪
  - 对应验收标准：五个脚本前缀齐备、extraResources 与 x64ArchFiles 正确
  - 完成判定：`node -e` 打印五个脚本与两个 build 字段
- [x] **增量 2**：`package.spec.ts` 断言同步
  - 做什么：更新脚本字符串断言与 `extraResources` 深比较
  - 交付：用例通过
  - 对应验收标准：打包用例通过
  - 完成判定：`corepack yarn --cwd dsh-plugin-desktop-beta test tests/package.spec.ts`

**失败策略**：见全局约定。

> **执行记录（偏离）**：前缀顺序实际为 `node ../scripts/prepare-codegraph.mjs && node ../scripts/prepare-mnemon.mjs && `，**codegraph 在前、mnemon 在后**，与本节验收标准写反。理由：把新前缀追加在既有前缀之后，`git diff` 只显示新增片段，不重写 codegraph 的既有顺序，diff 更小也更易复核；两者无执行顺序依赖（各自独立物化到 `build/codegraph/host` 与 `build/mnemon/host`）。
>
> **执行记录**：实测 `node -e` 校验五个脚本前缀齐备、`extraResources` 为三项（codegraph / mnemon / dream-skin-default）、`mac.x64ArchFiles` 同时含 `Resources/codegraph/**` 与 `Resources/mnemon/**`；`corepack yarn --cwd dsh-plugin-desktop-beta test tests/package.spec.ts` 输出 46 passed | 1 skipped，退出码 0。另在 `package.spec.ts` 补了两条 `x64ArchFiles` 断言，使两个内置 CLI 的资源路径都有用例覆盖（原先只有 `node-pty`/`fs-ext` 的断言）。

### Task-005：stable 变体打包配置同步

**描述**：把 Task-004 的 `package.json` 与 `tests/package.spec.ts` 改动同步到 stable 变体。

**关联需求**：`specs/mnemon-cli-bundling-spec.md` §mnemon 二进制随安装包分发。

**前置依赖**：Task-003、Task-004。

**工时估算**：0.25 人天
- 基础：0.2 人天（XS）
- 缓冲：0.2 × 20% × 1 = 0.04 人天（技术风险 - 低）
- 总计：0.24 人天

**涉及文件**：
- `dsh-plugin-desktop/package.json`
- `dsh-plugin-desktop/tests/package.spec.ts`

**验收标准**：
- **两变体 build 字段一致**：除产品名相关字段外，两侧 `extraResources`、`mac.x64ArchFiles`、五个打包脚本内容相同。验证方式：`corepack yarn check:desktop-variants` + `node -e` 逐字段比对。
- **stable 打包用例通过**：`corepack yarn --cwd dsh-plugin-desktop test tests/package.spec.ts` 退出码 0。验证方式：直接执行。

**增量计划**：
- [x] **增量 1**：`package.json` 同步
  - 做什么：按 beta 的实际值改 stable 的 build 字段
  - 交付：配置一致
  - 对应验收标准：两变体 build 字段一致
  - 完成判定：`node -e` 逐字段比对
- [x] **增量 2**：`package.spec.ts` 同步
  - 做什么：同步断言
  - 交付：用例通过
  - 对应验收标准：stable 打包用例通过
  - 完成判定：`corepack yarn --cwd dsh-plugin-desktop test tests/package.spec.ts`

> **执行记录**：实测五个脚本、`extraResources`、`mac.x64ArchFiles` 三个字段在两侧 JSON 序列化后完全相同；`corepack yarn --cwd dsh-plugin-desktop test tests/package.spec.ts` 输出 42 passed | 1 skipped，退出码 0；`node scripts/verify-desktop-variants.mjs` 输出 184 个共享源文件对齐，退出码 0。注意 stable 的 `package.spec.ts` 与 beta 结构略有差异（stable 无 `fs-ext` 断言、`x64ArchFiles` 断言插在 `files` 断言之前），同步时按各自锚点分别落位。

**失败策略**：见全局约定。

### 检查点 3

```bash
node scripts/prepare-mnemon.mjs --desktop dsh-plugin-desktop-beta --target darwin-arm64
corepack yarn --cwd dsh-plugin-desktop-beta test tests/package.spec.ts
corepack yarn --cwd dsh-plugin-desktop test tests/package.spec.ts
```

---

## 阶段四：运行时发布与终端集成

### Task-006：shell 集成模块泛化

**描述**：把 beta 的 `src/desktop-codegraph-shell.ts` 改名为 `src/desktop-cli-shell.ts`，导出面由单 launcher 改为 `launchers` 列表，`MARKER_BEGIN` / `MARKER_END` 文本**保持不变**（见 design.md 决策三）。同步改名并扩展 spec。

**关联需求**：`specs/mnemon-cli-bundling-spec.md` §macOS 终端可直接使用 mnemon。

**前置依赖**：无（与阶段三无文件交集，可并行）。

**工时估算**：0.5 人天
- 基础：0.35 人天（S）
- 缓冲：0.35 × 20% × 1 = 0.07 人天（技术风险 - 低）
- 总计：0.42 人天

**涉及文件**：
- `dsh-plugin-desktop-beta/src/desktop-cli-shell.ts` — 由 `desktop-codegraph-shell.ts` 改名并泛化
- `dsh-plugin-desktop-beta/tests/desktop-cli-shell.spec.ts` — 由 `desktop-codegraph-shell.spec.ts` 改名并扩展多 launcher 用例
- `dsh-plugin-desktop-beta/tests/package.spec.ts` — 若其中有源码文件清单或 `src/` 快照断言则同步（执行时确认）

**验收标准**：
- **多 launcher 一次登记**：一次调用传入 codegraph 与 mnemon 两个 launcher 后，`<homeDir>/bin` 下两个 shim 均存在且内容引用各自 launcher。验证方式：spec 用例。
- **marker 块唯一**：`<userHomeDir>/.zshrc` 中 `# >>> dsh-desktop codegraph >>>` 恰好出现一次，块内 PATH 条目仍为 `<homeDir>/bin`。验证方式：spec 断言出现次数为 1。
- **重复调用不写盘**：相同参数第二次调用 `changed === false`，且未生成额外 `.dsh-backup-*`。验证方式：spec 断言备份文件数量。
- **卸载移除全部 shim**：卸载后两个 shim 均不存在、marker 块被移除、用户其余内容逐字节不变。验证方式：spec 用例。

**增量计划**：
- [x] **增量 1**：改名 + 单 launcher 等价行为
  - 做什么：文件与导出改名，签名改为 `launchers` 数组，行为与改动前对单个 launcher 完全等价
  - 交付：改名后的模块与迁移后的 spec（原用例全绿即证明等价）
  - 对应验收标准：多 launcher 一次登记（单 launcher 退化情形）
  - 完成判定：`corepack yarn --cwd dsh-plugin-desktop-beta test tests/desktop-cli-shell.spec.ts`
- [x] **增量 2**：多 launcher 与幂等
  - 做什么：补多 launcher 用例、marker 唯一性用例、重复调用 `changed === false` 与备份数量用例
  - 交付：spec 覆盖 spec.md 中 §macOS 终端可直接使用 mnemon 的全部场景
  - 对应验收标准：marker 块唯一、重复调用不写盘
  - 完成判定：`corepack yarn --cwd dsh-plugin-desktop-beta test tests/desktop-cli-shell.spec.ts`
- [x] **增量 3**：卸载
  - 做什么：`uninstallDesktopCliShell` 移除全部 launcher 的 shim
  - 交付：卸载用例
  - 对应验收标准：卸载移除全部 shim
  - 完成判定：`corepack yarn --cwd dsh-plugin-desktop-beta test tests/desktop-cli-shell.spec.ts`

**失败策略**：见全局约定。注意：改名的同时必须同步 `main.ts` 的 import，否则 typecheck 失败——本任务的完成判定以 spec 通过为准，typecheck 在 Task-008 一并处理。

> **执行记录（重构与偏离）**：`dsh-plugin-desktop-beta/src/desktop-codegraph-shell.ts` 改名为 `src/desktop-cli-shell.ts`，spec 同步改名。导出面改为 `desktopCliProfileName(shell?)` / `installDesktopCliShell(options)` / `uninstallDesktopCliShell(options)`，**不保留旧名兼容别名**（包内唯一调用方 `main.ts` 在 Task-008 一并更新）。`MARKER_BEGIN`（`# >>> dsh-desktop codegraph >>>`）与 `MARKER_END` 文本及 `SHIM_DIRECTORY = 'bin'` 保持原值不变（design.md 决策三）；`SHIM_NAME` 常量移除。新增 `DesktopCliLauncher { name; launcherPath }`、`DesktopCliShellOptions.launchers`、`DesktopCliShellInstallation.shimPaths`；新增 `assertLauncherName()`（正则 `^[A-Za-z0-9._-]+$`）拒绝 `../escape`、空名与含空格名；空 `launchers` 抛 `at least one launcher is required`；空 `launcherPath` 抛 `${name} launcher path must not be empty`。多个 launcher 共享同一 `pathDir`，故 marker 块仍只出现一次，且目录创建改为幂等（`directoryCreated`）。
> **执行记录**：实测 `corepack yarn workspace dsh-plugin-desktop-beta test tests/desktop-cli-shell.spec.ts` → **15 passed**，退出码 0。关键回归用例：先只登记 codegraph、再调用一次追加 mnemon，断言 (a) `~/.zshrc` 的 marker 块**逐字节不变**、(b) 不产生第二个 `.dsh-backup-*`、(c) `<homeDir>/bin/mnemon` 出现。这条用例直接对应 design.md 决策三「已安装用户 profile 不变」。其余覆盖：shim 可执行位与 `exec '<abs>' "$@"` 转发、无尾换行 profile、shim 目录移动后原地改写块、目录在 `$HOME` 外时保留绝对路径、bash 走 `.bash_profile`、含空格与单引号的参数转发、单次备份文件名（`now: () => new Date('2026-01-02T03:04:05.678Z')` → `.dsh-backup-2026-01-02T03-04-05-678Z`）。

### Task-007：mnemon runtime 发布

**描述**：beta 的 `src/desktop-runtime-environment.ts` 新增 `DesktopMnemonRuntimeOptions`、`DesktopMnemonRuntimeInstallation`、`desktopMnemonBundleSupportsHost`、`installDesktopMnemonRuntime`，与 codegraph 版本同构；同步扩展 spec。

**关联需求**：`specs/mnemon-cli-bundling-spec.md` §mnemon CLI 对 Host 进程可见。

**前置依赖**：Task-001（需要知道 bundle 内的可执行文件名与清单形状）。

**工时估算**：0.4 人天
- 基础：0.3 人天（S）
- 缓冲：0.3 × 20% × 1 = 0.06 人天（技术风险 - 低）
- 总计：0.36 人天

**涉及文件**：
- `dsh-plugin-desktop-beta/src/desktop-runtime-environment.ts` — 新增 mnemon 相关导出
- `dsh-plugin-desktop-beta/tests/desktop-runtime-environment.spec.ts` — 新增 mnemon 用例

**验收标准**：
- **架构匹配时发布并可还原**：darwin/win32 下 `installDesktopMnemonRuntime` 返回 `pathDir === <bundleDir>/bin`，调用后 PATH 首项为该目录，`dispose()` 后 PATH 与调用前逐字符相同。验证方式：spec 用例。
- **架构不匹配返回 false**：清单声明 `cpu: ["arm64"]` 而主机为 `x64` 时 `desktopMnemonBundleSupportsHost` 返回 `false`。验证方式：spec 用例。
- **清单不可读返回 false 且不抛错**：目录不存在或 `package.json` 非法 JSON 时返回 `false`。验证方式：spec 用例。
- **可执行缺失即抛错**：`bin` 存在但 `mnemon`/`mnemon.exe` 缺失时抛错。验证方式：spec 用例。

**增量计划**：
- [x] **增量 1**：`desktopMnemonBundleSupportsHost`
  - 做什么：复制 codegraph 的清单判定逻辑并改用 mnemon 的字段语义
  - 交付：判定函数 + 三条清单相关用例
  - 对应验收标准：架构不匹配返回 false、清单不可读返回 false
  - 完成判定：`corepack yarn --cwd dsh-plugin-desktop-beta test tests/desktop-runtime-environment.spec.ts`
- [x] **增量 2**：`installDesktopMnemonRuntime`
  - 做什么：darwin/win32 分支、可执行存在性校验、复用 `installPathDirectory`
  - 交付：安装函数 + 发布/还原/抛错用例
  - 对应验收标准：架构匹配时发布并可还原、可执行缺失即抛错
  - 完成判定：`corepack yarn --cwd dsh-plugin-desktop-beta test tests/desktop-runtime-environment.spec.ts`

**失败策略**：见全局约定。

> **执行记录（重构偏离）**：实现时把与 codegraph 重复的部分抽为内部共用函数 `bundleSupportsHost()` 与 `installBundledCliRuntime()`，两个导出 `desktopMnemonBundleSupportsHost` / `installDesktopMnemonRuntime` 只是薄包装。理由是原任务书的「与 codegraph 同构」若逐行复制会产生两份近乎相同的 PATH 前置与 manifest 校验逻辑，后续任一侧修 bug 都要改两处。**Windows 启动器名不从包名推导**：`installBundledCliRuntime()` 的第二个参数由调用方传入，codegraph 传 `codegraph.cmd`（批处理 shim）、mnemon 传 `mnemon.exe`（真实可执行文件）——这个坑详见 `docs/bundle-mnemon-cli.zh.md` §2.3。
> **执行记录**：实测 `corepack corepack yarn workspace dsh-plugin-desktop-beta test tests/desktop-runtime-environment.spec.ts` → **32 passed | 3 skipped（25 → 32，新增 7 条）**，退出码 0。注：该文件用一个 `it.each`（`:65` 的 `creates a pnpm-only public PATH on %s`）展开成两个用例，故 `it()`/`it.each()` 声明数（20 → 27）不等于真实用例数，此处以 vitest 实际计数为准。覆盖 `desktopMnemonBundleSupportsHost` 的 os/cpu 不匹配返回 false、manifest 缺失或 JSON 非法返回 false（异常一律吞掉返回 false）、以及 `installDesktopMnemonRuntime` 前置 PATH 后 `mnemon` 可解析、`dispose()` 逐条目还原原 PATH 且不改变其余顺序。

### Task-008：beta 启动接线与 Windows 安装器

**描述**：beta 的 `main.ts` 接入 mnemon runtime 与泛化后的 shell 集成（含 shutdown 释放），并把 `build/installer.nsh` 扩成 codegraph + mnemon 两组对称分支，同步更新 `tests/installer-nsh.spec.ts`。

**关联需求**：`specs/mnemon-cli-bundling-spec.md` §mnemon CLI 对 Host 进程可见、§macOS 终端可直接使用 mnemon、§Windows 安装时写入用户 PATH。

**前置依赖**：Task-004（打包配置）、Task-006（shell 模块）、Task-007（runtime 函数）。

**工时估算**：0.5 人天
- 基础：0.35 人天（S）
- 缓冲：0.35 × 30% × 1.5 = 0.16 人天（依赖风险 - 中：NSIS 宏内多分支易出错，且需真机验证）
- 总计：0.51 人天

**涉及文件**：
- `dsh-plugin-desktop-beta/src/main.ts` — import 改名、mnemon runtime 安装、shell launchers 传两项、shutdown 释放
- `dsh-plugin-desktop-beta/build/installer.nsh` — mnemon 的 install/uninstall 分支
- `dsh-plugin-desktop-beta/tests/installer-nsh.spec.ts` — `WriteRegExpandStr` 计数改为 4 并区分两个目录

**验收标准**：
- **启动不因 mnemon 失败而中断**：runtime 安装抛错时以错误日志记录且应用继续启动。验证方式：spec 或临时注入失败观察日志。
- **shell 一次登记两个 CLI**：启动后 `~/.dsh/bin` 下有 codegraph 与 mnemon 两个 shim，`~/.zshrc` marker 块仍只有一段。验证方式：手动启动一次构建产物后检查。
- **PATH 释放精确**：shutdown 后 `process.env.PATH` 不含 mnemon 的 `bin`，且与安装前逐字符相同。验证方式：spec 或 `main.ts` 的既有 `generation.own` 路径单测。
- **NSIS 计数与分支**：`WriteRegExpandStr HKCU "Environment" "Path"` 恰好出现 4 次；mnemon 的 `FileExists` 与 `${StrContains}` 判断存在；卸载分支按末尾位置判断。验证方式：`corepack yarn --cwd dsh-plugin-desktop-beta test tests/installer-nsh.spec.ts`。

**增量计划**：
- [x] **增量 1**：`main.ts` 接入 runtime 与 shell
  - 做什么：加 `mnemonRuntime` 安装块（与 codegraph 同构，含 `desktopMnemonBundleSupportsHost` 判定）、把 shell 调用改成 launchers 两项、加 `releaseMnemonRuntime`
  - 交付：启动接线完成
  - 对应验收标准：启动不因 mnemon 失败而中断、shell 一次登记两个 CLI、PATH 释放精确
  - 完成判定：`corepack yarn --cwd dsh-plugin-desktop-beta run build && corepack yarn --cwd dsh-plugin-desktop-beta run typecheck`
- [x] **增量 2**：`installer.nsh` 两组分支
  - 做什么：新增 mnemon define 与 install/uninstall 分支，保持 codegraph 分支不变
  - 交付：安装器脚本
  - 对应验收标准：NSIS 计数与分支
  - 完成判定：`corepack yarn --cwd dsh-plugin-desktop-beta test tests/installer-nsh.spec.ts`
- [x] **增量 3**：`installer-nsh.spec.ts` 断言更新
  - 做什么：计数 2 → 4，新增两组分支各自的断言
  - 交付：用例通过
  - 对应验收标准：NSIS 计数与分支
  - 完成判定：`corepack yarn --cwd dsh-plugin-desktop-beta test tests/installer-nsh.spec.ts`

**失败策略**：见全局约定。

> **执行记录**：`main.ts` 的 `desktop-codegraph-shell.ts` import 改为 `./desktop-cli-shell.ts` / `installDesktopCliShell`，一次调用传入两个 launcher（codegraph 走 `codegraphRuntime.pathDir`，mnemon 走 `mnemonRuntime.pathDir`）。mnemon 接线与 codegraph 并列：`mnemonBundleDir = join(process.resourcesPath, 'mnemon')` → `desktopMnemonBundleSupportsHost()` 做主机架构校验 → 通过才 `installDesktopMnemonRuntime()` → `generation.own(() => { mnemonRuntime?.dispose() })` 注册可逆释放。**失败只 `electronLogger.error()`，不抛异常、不阻断启动**（darwin-only 的 try/catch 与 codegraph 同构）。
> **执行记录（NSIS 偏离）**：任务书写「镜像两组分支」，实际**未做成参数化循环**——NSIS 宏是文本展开的，共用宏体需把每个 `!define` 与寄存器名一并传参，比省下的重复更难读（design.md 决策四已记录该取舍）。另有两处必须成立的不变量：(a) 卸载顺序**与安装严格相反**（安装 codegraph→mnemon，卸载先剥 mnemon 再剥 codegraph），因为每个条目只在自己仍是 PATH 最后一项时才移除；(b) `PathBackup` **只由第一个真正改动 PATH 的分支写**——mnemon 分支先 `ReadRegStr $6 HKCU "Software\${PRODUCT_NAME}" "PathBackup"`，为空才写，否则备份里存的会是「已含 codegraph 的 PATH」而非用户最初的 PATH。`WriteRegExpandStr HKCU "Environment" "Path"` 由**恰好两次**（原 codegraph 安装/卸载各一次）变为**恰好四次**（两个目录各一对，安装两次、卸载两次），断言未被放宽成「至少两次」——这个精确计数本身就是防止重复追加的保护（design.md 决策四已预期此变化）。未用 `setx`、未用 `WriteRegStr`。
> **执行记录**：实测 `corepack yarn workspace dsh-plugin-desktop-beta test tests/installer-nsh.spec.ts` → **7 passed**（5 → 7），退出码 0。既有 codegraph 断言（`DSH_CODEGRAPH_BIN`、`StrCpy $4 "$0" $3 -$3`、`${if} $4 == ";$INSTDIR\${DSH_CODEGRAPH_BIN}"`、`${DSH_WM_WININICHANGE}`）全部保留未改，仅把 `WriteRegExpandStr HKCU "Environment" "Path"` 的计数由两次改为四次。新增两条：mnemon 分支存在，且卸载段中 mnemon 出现在 codegraph **之前**。**注意：注册表 PATH 的实际写入效果未在 native Windows 上验证**（本机 macOS，`scripts/package-win.ts:115-116` 硬断言必须在 native Windows 构建），需人工装一次并开新终端确认，见 `docs/bundle-mnemon-cli.zh.md` §8.3。

### 检查点 4

```bash
corepack yarn --cwd dsh-plugin-desktop-beta run build
corepack yarn --cwd dsh-plugin-desktop-beta run typecheck
corepack yarn --cwd dsh-plugin-desktop-beta test
```

---

## 阶段五：stable 同步与文档

<!-- PARALLEL: Task-009, Task-012 -->

### Task-009：stable 运行时与 shell 同步

**描述**：把 beta 阶段四的 `src/` 改动同步到 stable（`desktop-cli-shell.ts` 改名、`desktop-runtime-environment.ts`、`main.ts`），并同步三个 spec 文件；`src/product-identity.ts` 保持两变体各自的既有差异。

**关联需求**：全部 spec（既有能力不回归）。

**前置依赖**：Task-008。

**工时估算**：0.4 人天
- 基础：0.3 人天（S）
- 缓冲：0.3 × 20% × 1 = 0.06 人天（技术风险 - 低）
- 总计：0.36 人天

**涉及文件**：
- `dsh-plugin-desktop/src/desktop-cli-shell.ts` — 新增（由 beta 同步，并删除旧 `desktop-codegraph-shell.ts`）
- `dsh-plugin-desktop/src/desktop-runtime-environment.ts` — 同步
- `dsh-plugin-desktop/src/main.ts` — 同步
- `dsh-plugin-desktop/tests/desktop-cli-shell.spec.ts`、`tests/desktop-runtime-environment.spec.ts` — 同步

**验收标准**：
- **src 逐字节一致**：`corepack yarn check:desktop-variants` 退出码 0。验证方式：仓库根执行。
- **stable 全量测试通过**：`corepack yarn --cwd dsh-plugin-desktop test` 退出码 0。验证方式：直接执行。

**增量计划**：
- [x] **增量 1**：`src/` 三个文件同步
  - 做什么：按 beta 逐字节复制，删除 stable 的旧文件名，同步 `main.ts` 的 import
  - 交付：stable 源码一致
  - 对应验收标准：src 逐字节一致
  - 完成判定：`corepack yarn check:desktop-variants`
- [x] **增量 2**：spec 文件同步
  - 做什么：同步三个测试文件
  - 交付：测试齐备
  - 对应验收标准：stable 全量测试通过
  - 完成判定：`corepack yarn --cwd dsh-plugin-desktop test`

**失败策略**：见全局约定。

> **执行记录（提交合并偏离）**：stable 同步了 `src/desktop-cli-shell.ts`（由 `desktop-codegraph-shell.ts` 改名）、`src/desktop-runtime-environment.ts`、`src/main.ts` 与两个 spec 文件。Task-006/007/008 与 Task-009/010 实际在**同一次提交** `edf76cf308 feat(desktop): 内置 mnemon CLI 的宿主 PATH、shell 集成与 Windows 安装器` 中落地——因为两变体的 `src/` 必须逐字节一致，分开提交会留下无法通过 `check:desktop-variants` 的中间态。
> **执行记录**：实测 `node scripts/verify-desktop-variants.mjs` → `184 shared source files are aligned`，退出码 0；两变体 `typecheck` 退出码均为 0；stable 全量 137 个测试文件 **1399 passed | 8 skipped**、beta 135 个文件 **1385 passed | 7 skipped**，均退出码 0。另：`corepack yarn check:layout` → `verify-layout: dual Desktop workspaces and upstream fb2c4b9e69 are consistent`；两变体 `verify:licenses` → `941 production packages checked`；两变体 `verify:closure` → `247 first-party nodes form a closed reachable runtime graph`。

### Task-010：stable Windows 安装器同步

**描述**：把 beta 的 `build/installer.nsh` 与 `tests/installer-nsh.spec.ts` 同步到 stable。`installer.nsh` 两变体在归一化产品名后本就逐字节一致，同步时保持这一性质。

**关联需求**：`specs/mnemon-cli-bundling-spec.md` §Windows 安装时写入用户 PATH。

**前置依赖**：Task-008。

**工时估算**：0.25 人天
- 基础：0.2 人天（XS）
- 缓冲：0.2 × 20% × 1 = 0.04 人天（技术风险 - 低）
- 总计：0.24 人天

**涉及文件**：
- `dsh-plugin-desktop/build/installer.nsh`
- `dsh-plugin-desktop/tests/installer-nsh.spec.ts`

**验收标准**：
- **归一化后逐字节一致**：把两侧的 `dsh-plugin-desktop-beta` → `dsh-plugin-desktop`、`DSH Desktop Beta` → `DSH Desktop` 归一化后 `diff` 为空。验证方式：`sed` 归一化后 `diff`。
- **stable 安装器用例通过**：`corepack yarn --cwd dsh-plugin-desktop test tests/installer-nsh.spec.ts` 退出码 0。验证方式：直接执行。

**增量计划**：
- [x] **增量 1**：`installer.nsh` 同步
  - 做什么：同步 mnemon 分支
  - 交付：脚本一致
  - 对应验收标准：归一化后逐字节一致
  - 完成判定：归一化 `diff`
- [x] **增量 2**：spec 同步
  - 做什么：同步断言
  - 交付：用例通过
  - 对应验收标准：stable 安装器用例通过
  - 完成判定：`corepack yarn --cwd dsh-plugin-desktop test tests/installer-nsh.spec.ts`

**失败策略**：见全局约定。

> **执行记录**：`dsh-plugin-desktop/build/installer.nsh` 与 beta 版本同步为镜像分支结构（新增 `!define DSH_MNEMON_BIN "resources\mnemon\bin"`），归一化产品字符串后两侧逐字节一致。stable 的 `tests/installer-nsh.spec.ts` 同步补齐为 7 条断言，与 beta 同集。

### Task-011：Profile 预装清单相关用例同步

**描述**：确认并同步 `profile.spec.ts`、`profile-manager.spec.ts` 中与 `DEFAULT_PROFILE_PLUGIN_BUNDLES` 相关的断言（这三项已由 `preinstall-plugins.mjs add` 跑过一轮，本任务负责 stable 一侧与显式清单计数断言）。

**关联需求**：`specs/desktop-preinstalled-plugins-spec.md` §默认预装插件清单。

**前置依赖**：Task-003。

**工时估算**：0.25 人天
- 基础：0.2 人天（XS）
- 缓冲：0.2 × 20% × 1 = 0.04 人天（技术风险 - 低）
- 总计：0.24 人天

**涉及文件**：
- `dsh-plugin-desktop/tests/profile.spec.ts`
- `dsh-plugin-desktop/tests/profile-manager.spec.ts`

**验收标准**：
- **新 Profile 含三项**：新数据目录首次启动创建的默认 Profile 的 `bundles` 含 `billion-context`、`dsh-mnemon`、`dsh-rewind-plugin`。验证方式：`corepack yarn --cwd dsh-plugin-desktop test tests/profile.spec.ts`。
- **两变体清单内容一致**：`node scripts/preinstall-plugins.mjs list` 输出两侧清单项完全相同。验证方式：执行该命令。

**增量计划**：
- [x] **增量 1**：跑现有用例确认是否需要改动
  - 做什么：先执行 `corepack yarn --cwd dsh-plugin-desktop test tests/profile.spec.ts tests/profile-manager.spec.ts`，仅在失败时按实际清单更新断言
  - 交付：结论与必要的改动
  - 对应验收标准：新 Profile 含三项
  - 完成判定：`corepack yarn --cwd dsh-plugin-desktop test tests/profile.spec.ts tests/profile-manager.spec.ts`
- [x] **增量 2**：两变体清单一致性
  - 做什么：确认 stable 清单与 beta 相同
  - 交付：一致性结论
  - 对应验收标准：两变体清单内容一致
  - 完成判定：`node scripts/preinstall-plugins.mjs list`

**失败策略**：见全局约定。若用例通过则本任务只留下结论，不产生代码改动。

> **执行记录（本任务不产生代码改动，只留下结论）**：两个变体的 `tests/profile.spec.ts`（54 用例）与 `tests/profile-manager.spec.ts`（20 用例）都以 `...DEFAULT_PROFILE_PLUGIN_BUNDLES` 展开断言，**没有硬编码的清单长度或元素列表**，故三个新插件自动被覆盖。实测 `corepack yarn workspace dsh-plugin-desktop-beta test tests/profile.spec.ts tests/profile-manager.spec.ts` 与 stable 同一命令，**两侧均 74 passed**，退出码 0——先跑后判，确认无需改动。
> **执行记录**：`node scripts/preinstall-plugins.mjs list` 输出**默认预装清单 10 个插件**，`billion-context` / `dsh-mnemon` / `dsh-rewind-plugin` 三项在两个变体下均 `✓/✓`，无漂移告警。

### Task-012：中文说明文档

**描述**：新增 `docs/bundle-mnemon-cli.zh.md`，说明内置 mnemon CLI 的方案、与 CodeGraph 的差异、体积增量、验证命令、回滚方式。单语言中文文档不触发双语门禁（与既有 `docs/bundle-codegraph-cli.zh.md` 一致，无 `.i18n.yaml` 配对）。

**关联需求**：`specs/mnemon-cli-bundling-spec.md` §平台归档可追溯（文档说明场景）。

**前置依赖**：Task-001（需实测数据）。

**工时估算**：0.4 人天
- 基础：0.3 人天（S）
- 缓冲：0.3 × 20% × 1 = 0.06 人天（技术风险 - 低）
- 总计：0.36 人天

**涉及文件**：
- `docs/bundle-mnemon-cli.zh.md` — 新增

**验收标准**：
- **文档覆盖六个要点**：归档来源与版本、两个平台的 PATH 机制差异、安装体积增量、验证命令、回滚方式、与 CodeGraph 方案的差异（单文件 Go 二进制 vs 内嵌 Node）。验证方式：人工核对章节标题。
- **命令可复制执行**：文档中出现的每条命令都能在仓库根直接运行并得到所述结果。验证方式：逐条执行。
- **不触发双语门禁**：`corepack yarn check:docs`（若存在）退出码 0。验证方式：仓库根执行对应 gate。

**增量计划**：
- [x] **增量 1**：结构与事实章节
  - 做什么：按 `docs/bundle-codegraph-cli.zh.md` 的章节组织方式写「结论速览 / 需求 / 查证到的事实 / 方案」四段
  - 交付：文档前半
  - 对应验收标准：文档覆盖六个要点
  - 完成判定：人工核对标题
- [x] **增量 2**：验证与回滚章节
  - 做什么：写验证命令与回滚步骤，逐条实跑
  - 交付：完整文档
  - 对应验收标准：命令可复制执行、不触发双语门禁
  - 完成判定：逐条执行文档命令 + 文档门禁

**失败策略**：见全局约定。

> **执行记录**：`docs/bundle-mnemon-cli.zh.md` 已写出（新建，纯中文单语言）。结构与 `docs/bundle-codegraph-cli.zh.md` 对齐，但在差异处独立成节：结论速览表、需求、**查证到的事实**（2.1 单个自包含 Go 二进制 vs codegraph 内嵌 Node 的对比表、2.2 adhoc 签名、**2.3 Windows 是 `.exe` 不是 `.cmd` 的踩坑记录**、2.4 `findMnemonCommand()` 的 PATH 发现优先级、2.5 `name`/`version` 约定与 codegraph 相反）、两平台机制差异（3.1 共用 marker 块、3.2 NSIS 镜像分支 + 反序卸载 + `PathBackup` 只写一次 + 便携版）、方案四层、改动清单 12 项、**体积实测**、风险与坑（codegraph 共有风险只给交叉引用，mnemon 特有 8 条）、验证方法（8.1 通用 / 8.2 macOS / 8.3 Windows / 8.4 应用内）、回滚（含「不要手删 `~/.zshrc` 标记块，它正被 codegraph 使用」的陷阱）、实施记录（含 5 条与计划的偏差）、附 A（为何不用 `npm i -g`）/ 附 B（为何 Windows 不照抄 macOS）。
> **执行记录（事实取证）**：体积数据为实测——`gzip -9 -c build/mnemon/host/bin/mnemon | wc -c` → 6,153,199 字节，`6,153,199 / 15,519,186 = 0.396`，**高于** codegraph 的 0.322（Go 静态二进制的可压缩性不如 JS 文本），文档中明确写了「不可直接套用」。物化后 `build/mnemon/host/` 为 15 MB（codegraph 是 278 MB）；`otool -L` 只依赖 `libSystem.B.dylib` / `libresolv.9.dylib` / `CoreFoundation` / `Security`，无第三方动态库；`codesign -dv` 为 `flags=0x20002(adhoc,linker-signed)`、`Signature=adhoc`、`Identifier=a.out`。
> **执行记录（文档门禁）**：`node scripts/verify-bilingual-docs.mjs` 只扫 `git ls-files '*.i18n.yaml'`，纯中文新文档无 `.i18n.yaml` 配对，**不触发双语门禁**（与既有 `docs/bundle-codegraph-cli.zh.md` 一致）。
> **执行记录（范围偏离，已回滚）**：一度执行 `verify:notices` 重新生成 `THIRD_PARTY_NOTICES.md`，`git diff` 新增 393 行但**同时删除 8 行仅 Windows 的平台包**（`@img/sharp-win32-*`、`@koromix/koffi-win32-*`、`@vscode/ripgrep-win32-*`、`node-addon-require-builtin-win32-*-msvc`）——根因是本机 `supportedArchitectures.os=[current]` 只装了 darwin，属宿主相关噪声。核对 `git show HEAD` 版本后确认**已提交的 notices 本就不含任何内置预装插件**（`dsh-better-sidebar`、`@hyzyn/dsh-codegraph` 同样计数为 0），且 `verify:notices` 不在任何 `check` 门禁链内。**已 `git checkout --` 回滚，本次不改动、不提交。**

### 检查点 5

```bash
corepack yarn check:desktop-variants
corepack yarn check:layout
corepack yarn --cwd dsh-plugin-desktop run check
corepack yarn --cwd dsh-plugin-desktop-beta run check
```

---

## 阶段汇总

| 阶段 | 任务 | 基础工时 | 缓冲 | 合计 |
|---|---|---|---|---|
| 一 | Task-001 | 0.35 | 0.16 | 0.51 |
| 二 | Task-002、Task-003 | 0.32 | 0.10 | 0.42 |
| 三 | Task-004、Task-005 | 0.50 | 0.10 | 0.60 |
| 四 | Task-006、Task-007、Task-008 | 1.00 | 0.29 | 1.29 |
| 五 | Task-009、Task-010、Task-011、Task-012 | 1.00 | 0.20 | 1.20 |
| **总计** | **12 个任务** | **3.17** | **0.85** | **4.02 人天** |

**关键路径**：Task-001 → Task-004 → Task-008 → Task-009 → 检查点 5（约 2.6 人天）。

**可并行的任务**：
- `Task-001` 与 `Task-002`：无文件交集（根 `scripts/` + `vendor/` + `.gitignore` vs beta 的 `package.json` + `product-identity.ts`），依据：修改的文件集合不相交，且 Task-002 调用的 `preinstall-plugins.mjs` 不读取 `scripts/prepare-mnemon.mjs`。
- `Task-006` 与 `Task-007`：同在 beta `src/` 但不同文件，且 Task-006 只改 shell 模块与其 spec、Task-007 只改 runtime 模块与其 spec，依据：两文件之间无 import 关系（`main.ts` 是二者唯一的汇合点，在 Task-008 统一接线）。

---

## 审查后修复

三重审查（code-review / security-review / verify）全部 APPROVE（CRITICAL = 0），但 verify 关卡指出 `specs/mnemon-cli-bundling-spec.md` §发布失败不阻断启动存在**真实违约**，经复核成立，已在审查后单独修复。

### 缺陷

原 `main.ts` 把 CLI 发布写成「先判定、再安装」的三元表达式，整段位于 `start()` 的**外层** `try`（原 `:639`）到 `catch`（原 `:1775`）之间、**没有任何局部 try/catch**：

```ts
const mnemonRuntime = desktopMnemonBundleSupportsHost(mnemonBundleDir, process.platform, process.arch)
  ? installDesktopMnemonRuntime({ platform: process.platform, bundleDir: mnemonBundleDir, environment: process.env })
  : undefined
```

因此 `installDesktopMnemonRuntime` 抛错（可执行文件缺失、`bundleDir` 非绝对路径、平台不支持）会冒泡到外层 catch → `failStartup` → 启动恢复窗口 + `exitCode 1`，与 spec「Host 启动流程继续执行，异常信息以错误日志形式记录；应用仍能进入主界面」直接冲突。同段紧随其后的 macOS shell 集成（原 `:758-770`）与 dream-skin 播种（原 `:776-786`）**都有局部 catch**，说明是遗漏而非设计意图。既有 codegraph（原 `:699-708`）与 mnemon **同形**，属同一处遗漏。

### 修复

在 `desktop-runtime-environment.ts` 新增不会抛出的发布入口，把「判定 + 安装」整体包进 `try`，用返回值代替异常：

- 新接口 `DesktopBundledCliPublication<Installation> { installation?; failure? }` —— 恰好只有一个字段被设置；
- 私有 `publishBundledCliRuntime<Installation>({ label, supportsHost, install })` —— `supportsHost()` 与 `install()` 都在同一个 `try` 内，`catch` 归一化为 `failure` 字符串；判定为不支持时返回空对象（**静默跳过**，因为「架构不匹配」是 universal 安装包的正常现象，不该每次启动都报错）；
- 新导出 `publishDesktopCodegraphRuntime(bundleDir, platform, arch, environment)` 与 `publishDesktopMnemonRuntime(...)`，各自把 `bundleSupportsHost` 与既有的 `installDesktop*Runtime` 传进去。

`main.ts` 改为消费返回值，失败只写错误日志：

```ts
const codegraphPublication = publishDesktopCodegraphRuntime(
  join(process.resourcesPath, 'codegraph'), process.platform, process.arch, process.env,
)
if (codegraphPublication.failure !== undefined) {
  electronLogger.error(`${BIN_NAME}: ${codegraphPublication.failure}`)
}
const codegraphRuntime = codegraphPublication.installation
```

mnemon 同构。`installDesktopCodegraphRuntime` / `installDesktopMnemonRuntime` / `desktop*BundleSupportsHost` **保留原样导出**（既有 32 个用例继续覆盖它们的抛错行为），只是 `main.ts` 不再直接调用。codegraph 的同形缺口一并修掉。

**注意**：畸形清单（JSON 非法）**不产生** `failure`，因为 `bundleSupportsHost` 内部已按 spec §无法读取清单时视为不支持吞掉异常并返回 `false`，故走静默跳过分支——这一点由测试固化。

### 验证

- `dsh-plugin-desktop-beta/tests/desktop-runtime-environment.spec.ts` 新增 6 条用例（32 → **38 tests | 3 skipped**），分两个 `describe`：
  - `publishDesktopMnemonRuntime`：正常发布并可通过 `dispose()` 还原 PATH、**launcher 缺失时返回 failure 而非抛错**（断言 `/mnemon CLI runtime unavailable/` + `/packaged mnemon launcher is missing/`，且 PATH 未被改动）、架构不匹配时静默跳过（`failure` 为 `undefined`）、畸形清单静默跳过；
  - `publishDesktopCodegraphRuntime`：正常发布、launcher 缺失时返回 failure 而非抛错。
- `dsh-plugin-desktop` 同步后受影响三文件 → **57 passed | 3 skipped (60)**。
- `check:desktop-variants` → `184 shared source files are aligned`。
- 两变体 `typecheck` 退出码均为 0。

**涉及文件**：`dsh-plugin-desktop{,-beta}/src/desktop-runtime-environment.ts`、`src/main.ts`、`tests/desktop-runtime-environment.spec.ts`。
