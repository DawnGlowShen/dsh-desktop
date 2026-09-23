# 任务清单 — macOS Universal 产物内置 CLI

## 概述

让 macOS universal 安装包内置的 `codegraph` 与 `mnemon` 同时支持 arm64 与 x64 主机，修掉 Intel Mac 上不创建 `~/.dsh/bin` 的问题。做法是在打包前用 `lipo` 把两份 vendor 归档合成为单份 universal bundle，构建配置与运行时代码保持不变。

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

本仓库未接入覆盖率工具（`@vitest/coverage-v8` 与 `@vitest/coverage-istanbul` 均未安装于根目录或各工作区）。因此各任务的完成判定改为**穷举分支的行为断言**：新增模块的单测必须覆盖每个错误分支（缺失归档、SHA 不符、架构缺失、畸形 manifest），由 `node --test` 全量执行。待仓库引入覆盖率工具后另行补齐阈值断言。

### 变体同步约定

依据根 `AGENTS.md:18`：Desktop 共享改动**先在 `dsh-plugin-desktop-beta/` 落地验证**，再同步到 `dsh-plugin-desktop/`。注意 `scripts/prepare-codegraph.mjs` 与 `scripts/prepare-mnemon.mjs` 位于仓库根、两个变体**共用同一份**，其改动天然同时作用于两侧。

---

## 架构决策

- 技术栈：Node.js ESM 脚本（`^22.19.0` / `>=24.0.0`）+ 系统 `/usr/bin/lipo` + electron-builder + `@electron/universal@2.0.3`
- 架构模式：prepare 阶段 materialize 产物，electron-builder 静态拷贝
- 关键决策：**在 prepare 阶段 lipo 合成单份 universal bundle**，而不是让两个构建切片各拷一份。理由是 `@electron/universal` 对**所有非 Mach-O 文件**逐个比对 SHA，不符即抛 `Expected all non-binary files to have identical SHAs ...`（`dsh-plugin-desktop/node_modules/@electron/universal/dist/cjs/index.js:104-116`），而两架构包的 `package.json` 与 mnemon 的 `README.md` 内容确实不同；`x64ArchFiles` 只在两边 SHA **相同**时放行（`:129-136`），无法豁免差异。单份 universal 让两个切片读到同一份文件，字节相同在源头成立。
- 关键决策：**darwin 平台默认 target 改为 `darwin-universal`**，而不是在 10 处 `package.json` 调用点显式传参。改调用点需同改 20 处字符串（含 10 处测试断言 `dsh-plugin-desktop/tests/package.spec.ts:840-849` 及 beta 对应行），且两个变体各一份易漏。
- 关键约束：**不触碰 Linux 相关代码**。`EdanSpec/feature/20260921191517-linux-appimage`（state=active）也在改 `scripts/prepare-codegraph.mjs` 的 `TARGETS`，本次只新增 `darwin-universal` 条目与 darwin 默认推断，不改 `win32-*` 条目、不改 Linux 分支。

---

## 任务

### Task-001：补齐 darwin-x64 vendor 归档

**描述**：从上游 npm 取回两个 darwin-x64 归档放入 `vendor/`，使 `darwin-universal` target 有源可合。这是全部后续任务的前置：没有这两份归档，合成逻辑无从端到端验证。
**关联需求**：`proposal.md:13`（vendor 补入 darwin-x64 归档）。→ Agent：读取 `proposal.md` 确认归档来源与命名。
**前置依赖**：无

**工时估算**：0.26 人天
- 基础：0.2 人天（S）
- 缓冲：0.06 人天（依赖风险-低：0.2 × 30% × 1）
- 总计：0.26 人天
→ Agent：缓冲计算规则见 `references/risk-classification.md`。

**涉及文件**：
- `vendor/codegraph/colbymchenry-codegraph-darwin-x64-1.6.0.tgz` — 新增，CodeGraph darwin-x64 归档（约 56 MB）
- `vendor/mnemon/mnemon-darwin-x64-0.2.9.tgz` — 新增，Mnemon darwin-x64 归档（约 6.3 MB）

**验收标准**：
- **归档校验和匹配钉值**：当两份归档就位时，其 sha256 分别为 `0573a6322db1ff72d1b1a5f30f2e8893712c224423655d2b46e56842e7237627`（codegraph）与 `cbdc4053f889008d34c831888420132fcfe367578b120f660bbf90252c02eb9d`（mnemon）。验证方式：`shasum -a 256 vendor/codegraph/colbymchenry-codegraph-darwin-x64-1.6.0.tgz vendor/mnemon/mnemon-darwin-x64-0.2.9.tgz` 输出与上述值逐字一致
- **归档含预期入口**：当归档就位时，tar 清单含 `package/bin/codegraph`、`package/node`（codegraph）与 `package/bin/mnemon`（mnemon）。验证方式：`tar -tzf vendor/codegraph/colbymchenry-codegraph-darwin-x64-1.6.0.tgz | grep -cE '^(package/bin/codegraph|package/node)$'` 返回 2，且 `tar -tzf vendor/mnemon/mnemon-darwin-x64-0.2.9.tgz | grep -cE '^package/bin/mnemon$'` 返回 1（必须用 `-E` + `^...$` 锚定，因为基础 `grep` 的 `\|` 交替在 BSD grep 下不生效，会漏掉 `package/node`）
- **清单声明 darwin/x64 且许可证达标**：当解包读取 `package/package.json` 时，`os` 为 `["darwin"]`、`cpu` 为 `["x64"]`，许可证分别为 `MIT`（codegraph）与 `Apache-2.0`（mnemon）。验证方式：解包后 `node -e "const m=require('<dir>/package/package.json'); if(JSON.stringify(m.cpu)!=='[\"x64\"]'||m.os[0]!=='darwin')process.exit(1); console.log(m.license)"` 退出码 0

**增量计划**：
- [x] **增量 1**：取回 codegraph darwin-x64 归档
  - 做什么：`npm pack @colbymchenry/codegraph-darwin-x64@1.6.0` 取回并重命名为 `colbymchenry-codegraph-darwin-x64-1.6.0.tgz` 放入 `vendor/codegraph/`
  - 交付：`vendor/codegraph/colbymchenry-codegraph-darwin-x64-1.6.0.tgz`
  - 对应验收标准：归档校验和匹配钉值（codegraph 侧）、归档含预期入口（codegraph 侧）
  - 完成判定：`shasum -a 256 vendor/codegraph/colbymchenry-codegraph-darwin-x64-1.6.0.tgz` 输出 `0573a6322db1ff72d1b1a5f30f2e8893712c224423655d2b46e56842e7237627` && `tar -tzf vendor/codegraph/colbymchenry-codegraph-darwin-x64-1.6.0.tgz | grep -cE '^(package/bin/codegraph|package/node)$'` 返回 2
- [x] **增量 2**：取回 mnemon darwin-x64 归档
  - 做什么：`npm pack @mnemon-dev/mnemon@0.2.9-darwin-x64` 取回并重命名为 `mnemon-darwin-x64-0.2.9.tgz` 放入 `vendor/mnemon/`
  - 交付：`vendor/mnemon/mnemon-darwin-x64-0.2.9.tgz`
  - 对应验收标准：归档校验和匹配钉值（mnemon 侧）、归档含预期入口（mnemon 侧）
  - 完成判定：`shasum -a 256 vendor/mnemon/mnemon-darwin-x64-0.2.9.tgz` 输出 `cbdc4053f889008d34c831888420132fcfe367578b120f660bbf90252c02eb9d` && `tar -tzf vendor/mnemon/mnemon-darwin-x64-0.2.9.tgz | grep -cE '^package/bin/mnemon$'` 返回 1
- [x] **增量 3**：核对两份清单的架构与许可证声明
  - 做什么：解包两份归档到临时目录，断言 `cpu`/`os`/`license` 字段符合预期，作为后续 manifest 归一的输入基线
  - 交付：核对结论（记录 arm64 与 x64 侧清单字段差异，供 Task-002 的允许差异清单使用）
  - 对应验收标准：清单声明 darwin/x64 且许可证达标
  - 完成判定：对两份归档执行解包 + `node -e` 断言，退出码均为 0

**失败策略**：见 tasks.md 全局约定。

---

### Task-002：抽出 universal 合成逻辑为可测模块

**描述**：把「两棵树合并为 universal bundle」的通用逻辑抽成独立 ESM 模块并配 `node --test` 单测，使 `lipo`/`tar` 可注入，从而在不具备 macOS 工具链的环境下也能覆盖全部失败分支。两个 prepare 脚本随后复用它，避免同一段合并逻辑写两遍。
**关联需求**：`design.md` 测试策略「需要 Mock 的外部依赖：`lipo` 与 `tar` 调用需可注入（沿用现有 `spawnSync` 模式）」。→ Agent：读取 `design.md` 的「测试策略」小节确认注入边界。
**前置依赖**：无

**工时估算**：0.52 人天
- 基础：0.4 人天（S）
- 缓冲：0.12 人天（技术风险-中：0.4 × 20% × 1.5）
- 总计：0.52 人天
→ Agent：缓冲计算规则见 `references/risk-classification.md`。

**涉及文件**：
- `scripts/prepare-universal-bundle.mjs` — 新增，合并计划、差异检测、manifest 归一、架构校验
- `scripts/prepare-universal-bundle.test.mjs` — 新增，`node:test` 单测覆盖全部错误分支
- `package.json` — 修改，新增 `test:prepare-universal` 并接入 `check:layout`

**验收标准**：
- **PLAIN 文件差异被拦截**：当两棵临时树的非 Mach-O 文件 SHA 不同且不在允许清单内时，合并计划函数抛出错误并指明该文件的相对路径。验证方式：`node --test scripts/prepare-universal-bundle.test.mjs` 中「rejects differing plain files」用例通过
- **Mach-O 合并计划完整**：当两棵树各含 `node` 与 `lib/kernel/codegraph-kernel.node` 时，合并计划返回这 2 条相对路径；任一侧缺失对应文件时抛错。验证方式：同测试文件的「plans every Mach-O pair」与「rejects one-sided Mach-O」用例通过
- **manifest 归一为双架构**：当归一化输入的 `cpu` 为单架构时，输出的 `cpu` 同时含 `arm64` 与 `x64`，且 `os` 保持 `["darwin"]` 不变。验证方式：同测试文件的「normalizes cpu to both architectures」用例通过

**增量计划**：
- [x] **增量 1**：Mach-O 合并计划与差异检测
  - 做什么：实现 `planUniversalMerge(arm64Dir, x64Dir, { allowPlainDifferences, readMachO })`，遍历两棵树、按 Mach-O 魔数分类、比对 PLAIN 文件 SHA、返回待合并路径清单
  - 交付：`scripts/prepare-universal-bundle.mjs` 的合并计划函数 + 两个单测用例
  - 对应验收标准：PLAIN 文件差异被拦截、Mach-O 合并计划完整
  - 完成判定：`node --test scripts/prepare-universal-bundle.test.mjs` 通过且上述两用例在内
- [x] **增量 2**：manifest 归一
  - 做什么：实现 `normalizeUniversalManifest(manifest, { packageName, version, cpu })`，把 `cpu` 写为双架构，保留 `os` 与 `license`
  - 交付：归一函数 + 单测用例
  - 对应验收标准：manifest 归一为双架构
  - 完成判定：`node --test scripts/prepare-universal-bundle.test.mjs` 通过且「normalizes cpu to both architectures」用例在内
- [x] **增量 3**：注入式 lipo 执行与架构校验并接入根检查链
  - 做什么：实现 `mergeUniversalBundle({ arm64Dir, x64Dir, outputRoot, run })`，`run` 为注入的 `spawnSync` 边界；合并后调用 `lipo -archs` 校验双架构；在根 `package.json` 加 `test:prepare-universal` 并挂进 `check:layout`
  - 交付：可注入的合并入口 + 单测覆盖 `lipo` 非零退出的失败分支 + 根脚本接入
  - 对应验收标准：PLAIN 文件差异被拦截（借由合并入口的错误传播路径复核）
  - 完成判定：`node --test scripts/prepare-universal-bundle.test.mjs` 全部通过 && `corepack yarn check:layout` 通过

**失败策略**：见 tasks.md 全局约定。

---

### Task-003：prepare-codegraph 接入 darwin-universal

**描述**：让 `scripts/prepare-codegraph.mjs` 接受 `--target darwin-universal`，用 Task-001 的两份归档经 Task-002 的模块合成 universal bundle；同时把 darwin 平台的默认 target 推断改为 `darwin-universal`。
**关联需求**：`specs/codegraph-cli-bundling-spec.md` 的「prepare-codegraph 支持 darwin-universal target」与「CodeGraph 归档校验和记录」两个 Requirement。→ Agent：读取该 spec 确认 scenario 与 `.prepared.json` 字段要求。
**前置依赖**：Task-001（需要两份归档）、Task-002（需要合并模块）

**工时估算**：0.52 人天
- 基础：0.4 人天（S）
- 缓冲：0.12 人天（技术风险-中：0.4 × 20% × 1.5）
- 总计：0.52 人天
→ Agent：缓冲计算规则见 `references/risk-classification.md`。

**涉及文件**：
- `scripts/prepare-codegraph.mjs` — 修改，新增 `darwin-universal` target、两归档解析、合并调用、manifest 归一、默认 target 推断

**验收标准**：
- **合成 universal bundle**：当执行 `node scripts/prepare-codegraph.mjs --desktop dsh-plugin-desktop-beta --target darwin-universal` 时，`build/codegraph/host` 中的 `node` 与 `lib/kernel/codegraph-kernel.node` 均为含 `x86_64` 与 `arm64` 的 universal binary，且 `package.json` 的 `cpu` 同时含两架构。验证方式：`lipo -archs dsh-plugin-desktop-beta/build/codegraph/host/node` 与 `lipo -archs .../lib/kernel/codegraph-kernel.node` 均同时输出 `x86_64` 与 `arm64`，且 `node -e` 断言 manifest `cpu` 长度为 2
- **缺少 darwin-x64 归档时失败**：当 `vendor/codegraph/` 中缺失 darwin-x64 归档时，脚本以非零退出码失败并输出指明缺失架构的英文信息。验证方式：临时移出该归档后执行同一命令，断言退出码非 0 且 stderr 含 `no vendored archive for darwin-x64`
- **darwin 默认推断为 universal**：当宿主平台为 darwin 且未传 `--target` 时解析为 `darwin-universal`；`--target win32-x64` 仍覆盖默认推断。验证方式：`node scripts/prepare-codegraph.mjs --desktop dsh-plugin-desktop-beta --check` 在 host 为 universal 产物时通过，且 `node scripts/prepare-codegraph.mjs --desktop dsh-plugin-desktop-beta --target win32-x64` 输出 `prepare-codegraph: prepared ... for win32-x64`

**增量计划**：
- [x] **增量 1**：`darwin-universal` target 定义与双归档解析
  - 做什么：在 `TARGETS` 新增 `darwin-universal` 条目（`sources: ['darwin-arm64','darwin-x64']`、`packageName`、`executables`），改造归档定位为可解析多份；保持 `win32-*` 条目与其分支原样不动
  - 交付：可解析出两份归档的 target 定义
  - 对应验收标准：缺少 darwin-x64 归档时失败
  - 完成判定：移出归档后 `node scripts/prepare-codegraph.mjs --desktop dsh-plugin-desktop-beta --target darwin-universal` 退出码非 0 且 stderr 含 `no vendored archive for darwin-x64`
- [x] **增量 2**：合并产出 universal bundle
  - 做什么：解包两份归档到临时目录，经 `mergeUniversalBundle()` 合并到 `outputRoot`，归一 manifest，`lipo -archs` 校验
  - 交付：`build/codegraph/host` 为 universal bundle
  - 对应验收标准：合成 universal bundle
  - 完成判定：`node scripts/prepare-codegraph.mjs --desktop dsh-plugin-desktop-beta --target darwin-universal` 退出码 0 && `lipo -archs dsh-plugin-desktop-beta/build/codegraph/host/node` 同时含 `x86_64` 与 `arm64`
- [x] **增量 3**：默认 target 推断改为 darwin-universal
  - 做什么：改 `parseTarget(argv)`，在未传 `--target` 时把 `darwin-*` 归一为 `darwin-universal`；`win32` 仍按 `${process.platform}-${process.arch}` 推断
  - 交付：平台默认推断逻辑
  - 对应验收标准：darwin 默认推断为 universal
  - 完成判定：不带 `--target` 执行后 `cat dsh-plugin-desktop-beta/build/codegraph/.prepared.json` 的 `target` 字段为 `darwin-universal` && `--target win32-x64` 命令输出含 `for win32-x64`

**失败策略**：见 tasks.md 全局约定。

---

### Task-004：prepare-mnemon 接入 darwin-universal 与 darwin-x64 钉值

**描述**：让 `scripts/prepare-mnemon.mjs` 新增带 sha256 钉值的 `darwin-x64` 条目与 `darwin-universal` target，并把 darwin 默认推断改为 `darwin-universal`。该脚本与 codegraph 不同：`TARGETS` 对每个 target 硬编码校验和，且架构信息编码在 `version` 而非 `name`。
**关联需求**：`specs/mnemon-cli-bundling-spec.md` 的「prepare-mnemon 支持 darwin-universal target」与「Mnemon 每目标 sha256 钉值」两个 Requirement。→ Agent：读取该 spec 确认钉值与字段断言要求。
**前置依赖**：Task-001（需要两份归档）、Task-002（需要合并模块）；与 Task-003 无文件交集，可并行

**工时估算**：0.52 人天
- 基础：0.4 人天（S）
- 缓冲：0.12 人天（技术风险-中：0.4 × 20% × 1.5）
- 总计：0.52 人天
→ Agent：缓冲计算规则见 `references/risk-classification.md`。

**涉及文件**：
- `scripts/prepare-mnemon.mjs` — 修改，新增 `darwin-x64`（含 sha256 钉值）与 `darwin-universal` target、默认 target 推断

**验收标准**：
- **钉值不符时失败**：当 `vendor/mnemon/mnemon-darwin-x64-0.2.9.tgz` 内容与其钉值 `cbdc4053f889008d34c831888420132fcfe367578b120f660bbf90252c02eb9d` 不符时，脚本以非零退出码失败并输出实际与期望的 sha256。验证方式：向归档追加一个字节后执行 `--target darwin-x64`，断言退出码非 0 且 stderr 同时含实际与期望 sha256
- **合成 universal bundle**：当执行 `node scripts/prepare-mnemon.mjs --desktop dsh-plugin-desktop-beta --target darwin-universal` 时，`build/mnemon/host/bin/mnemon` 含 `x86_64` 与 `arm64` 两个架构、保持可执行权限，且 manifest `cpu` 同时含两架构。验证方式：`lipo -archs dsh-plugin-desktop-beta/build/mnemon/host/bin/mnemon` 同时含两架构 && `test -x .../bin/mnemon` 退出码 0
- **darwin 默认推断为 universal**：当宿主平台为 darwin 且未传 `--target` 时解析为 `darwin-universal`；Windows 主机仍为 `win32-x64`。验证方式：不带 `--target` 执行后 `.prepared.json` 的 `target` 为 `darwin-universal`；`node scripts/prepare-mnemon.mjs --desktop dsh-plugin-desktop-beta --target win32-x64` 输出含 `for win32-x64`

**增量计划**：
- [x] **增量 1**：新增 darwin-x64 条目与 sha256 钉值校验
  - 做什么：在 `TARGETS` 加 `darwin-x64`（`archive: /^mnemon-darwin-x64-.*\.tgz$/u`、`sha256: 'cbdc4053...'`、`executables: ['bin/mnemon']`）；把 sha256 校验抽出为可对多个源归档逐个执行的函数
  - 交付：带钉值的 darwin-x64 target + 校验函数
  - 对应验收标准：钉值不符时失败
  - 完成判定：篡改归档后 `node scripts/prepare-mnemon.mjs --desktop dsh-plugin-desktop-beta --target darwin-x64` 退出码非 0 且 stderr 含实际与期望 sha256
- [x] **增量 2**：darwin-universal target 合成
  - 做什么：新增 `darwin-universal` 条目（两个源归档、逐个校验钉值），解包两棵树经 `mergeUniversalBundle()` 合并到 `outputRoot`，归一 manifest（含 `version` 去掉架构后缀的处理），保持 `bin/mnemon` 的 0o755 权限
  - 交付：`build/mnemon/host` 为 universal bundle
  - 对应验收标准：合成 universal bundle
  - 完成判定：`node scripts/prepare-mnemon.mjs --desktop dsh-plugin-desktop-beta --target darwin-universal` 退出码 0 && `lipo -archs dsh-plugin-desktop-beta/build/mnemon/host/bin/mnemon` 同时含 `x86_64` 与 `arm64`
- [x] **增量 3**：默认 target 推断改为 darwin-universal
  - 做什么：改 `parseTarget(argv)`，darwin 未指定时归一为 `darwin-universal`，`win32` 保持按宿主推断
  - 交付：平台默认推断逻辑
  - 对应验收标准：darwin 默认推断为 universal
  - 完成判定：不带 `--target` 执行后 `.prepared.json` 的 `target` 为 `darwin-universal` && `--target win32-x64` 命令输出含 `for win32-x64`

**失败策略**：见 tasks.md 全局约定。

---

### Task-005：prepare 脚本端到端合成检查点

**类型**：检查点
**触发条件**：Task-001 至 Task-004 全部完成后触发

**验证项**（仅包含可自动验证项）：
- [x] 单测：`node --test scripts/prepare-universal-bundle.test.mjs` 全部通过
- [x] codegraph 合成：`node scripts/prepare-codegraph.mjs --desktop dsh-plugin-desktop-beta` 退出码 0
- [x] mnemon 合成：`node scripts/prepare-mnemon.mjs --desktop dsh-plugin-desktop-beta` 退出码 0
- [x] 三处 Mach-O 双架构：`lipo -archs dsh-plugin-desktop-beta/build/codegraph/host/node`、`lipo -archs dsh-plugin-desktop-beta/build/codegraph/host/lib/kernel/codegraph-kernel.node`、`lipo -archs dsh-plugin-desktop-beta/build/mnemon/host/bin/mnemon` 三者均同时含 `x86_64` 与 `arm64`
- [x] 两架构可执行：`dsh-plugin-desktop-beta/build/codegraph/host/bin/codegraph --version` 输出 `1.6.0` 且 `arch -x86_64 dsh-plugin-desktop-beta/build/codegraph/host/bin/codegraph --version` 同样输出 `1.6.0`
- [x] manifest 归一：`node -e` 断言两个 `build/*/host/package.json` 的 `cpu` 均含 `arm64` 与 `x64`
- [x] Windows 未回归：`node scripts/prepare-codegraph.mjs --desktop dsh-plugin-desktop-beta --target win32-x64` 与 `node scripts/prepare-mnemon.mjs --desktop dsh-plugin-desktop-beta --target win32-x64` 均退出码 0
- [x] 任务完整性：Task-001 至 Task-004 的增量 checkbox 全勾
- [x] 依赖变更：`git diff --stat package.json` 仅含新增的 `test:prepare-universal` 脚本，无新增第三方依赖

→ Agent：检查点作为 Task 类别参与统一编号，与开发任务按实施顺序交替排列。

---

### Task-006：beta 侧运行时判定测试补 universal 用例

**描述**：在 beta 工作区的运行时环境测试中补充 universal manifest 的判定用例，锁定「`cpu` 含双架构时两架构都通过 `bundleSupportsHost()`」这一新契约。既有 arm64-only 清单在 x64 上被拒的用例**保留不动**（它仍描述真实守卫行为，也是本次变更的动因）。
**关联需求**：`specs/codegraph-cli-bundling-spec.md` 的「Intel Mac 上发布内置 CodeGraph CLI」与 `specs/mnemon-cli-bundling-spec.md` 的「Intel Mac 上发布内置 Mnemon CLI」两个 Scenario。→ Agent：读取两份 spec 确认断言对象与宿主参数。
**前置依赖**：无（纯测试补充，不依赖产物）

**工时估算**：0.36 人天
- 基础：0.3 人天（S）
- 缓冲：0.06 人天（业务风险-低：0.3 × 20% × 1）
- 总计：0.36 人天
→ Agent：缓冲计算规则见 `references/risk-classification.md`。

**涉及文件**：
- `dsh-plugin-desktop-beta/tests/desktop-runtime-environment.spec.ts` — 修改，在 `desktopCodegraphBundleSupportsHost` 与 `desktopMnemonBundleSupportsHost` 两个 describe 各加一个 universal manifest 用例

**验收标准**：
- **universal 清单在两架构均通过**：当清单 `cpu` 为 `["arm64","x64"]` 且 `os` 为 `["darwin"]` 时，`desktopCodegraphBundleSupportsHost(dir,'darwin','arm64')` 与 `(dir,'darwin','x64')` 均返回 true；mnemon 侧同构断言同样成立。验证方式：`yarn workspace dsh-plugin-desktop-beta vitest run tests/desktop-runtime-environment.spec.ts` 通过
- **既有单架构守卫未被削弱**：当清单 `cpu` 为 `["arm64"]` 时，x64 宿主仍被拒。验证方式：同一测试文件中原「matches the declared platform and architecture」用例仍通过
- **畸形与缺失清单仍被拒**：当 manifest 缺失或非 JSON 时两架构均返回 false。验证方式：同一测试文件中原「rejects a missing or malformed manifest」用例仍通过

**增量计划**：
- [ ] **增量 1**：补 universal manifest 用例
  - 做什么：在两个 `describe` 内各新增一个 `it`，构造 `{ os: ['darwin'], cpu: ['arm64','x64'] }` 的 bundle，断言 arm64 与 x64 两侧均为 true
  - 交付：新增测试用例
  - 对应验收标准：universal 清单在两架构均通过
  - 完成判定：`yarn workspace dsh-plugin-desktop-beta vitest run tests/desktop-runtime-environment.spec.ts` 通过且新用例在报告中出现
- [ ] **增量 2**：复核既有守卫用例
  - 做什么：运行整文件测试，确认单架构拒绝与畸形清单拒绝两条既有用例未因改动失效
  - 交付：回归确认结论
  - 对应验收标准：既有单架构守卫未被削弱、畸形与缺失清单仍被拒
  - 完成判定：`yarn workspace dsh-plugin-desktop-beta vitest run tests/desktop-runtime-environment.spec.ts` 全绿且用例数较改动前增加 2
- [ ] **增量 3**：类型检查
  - 做什么：对测试改动执行工作区 typecheck（测试文件纳入 `tsconfig.tests.json`）
  - 交付：类型检查通过
  - 对应验收标准：universal 清单在两架构均通过（借由可编译性确认用例真的被执行）
  - 完成判定：`yarn workspace dsh-plugin-desktop-beta typecheck` 无错误

**失败策略**：见 tasks.md 全局约定。

---

### Task-007：beta 侧 smoke 校验增加内置 CLI 双架构断言

**描述**：在 beta 工作区的 macOS smoke 校验中增加对 `Contents/Resources/codegraph/node`、`Contents/Resources/codegraph/lib/kernel/codegraph-kernel.node`、`Contents/Resources/mnemon/bin/mnemon` 的双架构断言，使「产物内置 CLI 确实是 universal」成为打包流水线的可自动验证条件，而不只依赖人工抽查。
**关联需求**：`design.md` 风险表「合并后二进制在某个架构下运行失败」的应对——「实现阶段仍需在 `check:mac-package` 中加双架构断言防回归」。→ Agent：读取 `design.md` 风险表确认断言对象。
**前置依赖**：Task-003、Task-004（需要 universal 产物存在才有意义）

**工时估算**：0.36 人天
- 基础：0.3 人天（S）
- 缓冲：0.06 人天（技术风险-低：0.3 × 20% × 1）
- 总计：0.36 人天
→ Agent：缓冲计算规则见 `references/risk-classification.md`。

**涉及文件**：
- `dsh-plugin-desktop-beta/scripts/mac-universal.ts` — 修改，新增 `MACOS_UNIVERSAL_BUNDLED_CLI_PATHS` 常量（内置 CLI 的 universal 校验清单）
- `dsh-plugin-desktop-beta/scripts/verify-mac-smoke.ts` — 修改，按该清单对内置 CLI 执行双架构校验
- `dsh-plugin-desktop-beta/tests/verify-mac-smoke.spec.ts` — 修改，fixture 构造内置 CLI 文件并断言 `lipo` 调用

**验收标准**：
- **内置 CLI 被校验为双架构**：当 smoke 校验运行时，它会对三个内置 CLI 文件各执行 `lipo <path> -verify_arch x86_64` 与 `-verify_arch arm64`。验证方式：`yarn workspace dsh-plugin-desktop-beta vitest run tests/verify-mac-smoke.spec.ts` 通过，且测试记录的命令调用列表含 `MACOS_UNIVERSAL_BUNDLED_CLI_PATHS` 中每个路径 × 两个架构共 6 次 `lipo` 调用
- **缺失内置 CLI 时校验失败**：当包内缺少 `Contents/Resources/codegraph/node` 时校验抛错并指明缺失路径。验证方式：同一测试文件中新增的负例断言 `expectSmokeFailure` 的详情含该路径
- **既有主可执行文件校验不变**：当 smoke 校验运行时，`Contents/MacOS/<productName>` 仍执行既有的双架构 `lipo` 校验。验证方式：同一测试文件中原有断言仍通过

**增量计划**：
- [ ] **增量 1**：新增内置 CLI 校验清单常量
  - 做什么：在 `mac-universal.ts` 加 `MACOS_UNIVERSAL_BUNDLED_CLI_PATHS`（`Resources/codegraph/node`、`Resources/codegraph/lib/kernel/codegraph-kernel.node`、`Resources/mnemon/bin/mnemon`），沿用该文件作为 universal 产物清单的唯一归属；**不扩充** `MACOS_UNIVERSAL_NATIVE_ENTRIES`（其条目相对 `Resources/app`，语义不同）
  - 交付：新增常量
  - 对应验收标准：内置 CLI 被校验为双架构
  - 完成判定：`yarn workspace dsh-plugin-desktop-beta typecheck` 无错误
- [ ] **增量 2**：在内置 CLI 路径上执行双架构校验
  - 做什么：在 `verify-mac-smoke.ts` 已有 `Contents/MacOS/<productName>` 校验之后，按清单逐个做存在性、非空、可执行性与 `lipo -verify_arch` 双架构校验，复用既有 `options.run` / `options.exists` / `options.stat` 注入边界
  - 交付：脚本内新增校验段落
  - 对应验收标准：内置 CLI 被校验为双架构、缺失内置 CLI 时校验失败
  - 完成判定：`yarn workspace dsh-plugin-desktop-beta vitest run tests/verify-mac-smoke.spec.ts` 通过
- [ ] **增量 3**：补测试：fixture 内置 CLI、调用列表与缺失路径负例
  - 做什么：在 spec 的 `fixture()` 中创建三个内置 CLI 文件；更新主用例的 `harness.calls` 期望，加入 6 次 `lipo` 调用；新增缺文件时 `expectSmokeFailure` 的负例
  - 交付：更新后的测试
  - 对应验收标准：内置 CLI 被校验为双架构、缺失内置 CLI 时校验失败、既有主可执行文件校验不变
  - 完成判定：`yarn workspace dsh-plugin-desktop-beta vitest run tests/verify-mac-smoke.spec.ts` 通过且新负例在内

**失败策略**：见 tasks.md 全局约定。

---

### Task-008：检查点 — beta 端到端打包验证

**类型**：检查点
**触发条件**：Task-006、Task-007 完成后触发

**验证项**（仅包含可自动验证项）：
- [ ] 单测：`yarn workspace dsh-plugin-desktop-beta vitest run tests/desktop-runtime-environment.spec.ts tests/verify-mac-smoke.spec.ts tests/package.spec.ts tests/mac-universal.spec.ts` 全部通过
- [ ] 类型检查：`yarn workspace dsh-plugin-desktop-beta typecheck` 无错误
- [ ] 打包检查：`yarn workspace dsh-plugin-desktop-beta check:mac-package` 退出码 0
- [ ] 端到端产物：`yarn workspace dsh-plugin-desktop-beta dist:mac-smoke` 退出码 0 并在 `dsh-plugin-desktop-beta/dist/mac-smoke/` 产出唯一 DMG
- [ ] smoke 校验：`node dsh-plugin-desktop-beta/scripts/verify-mac-smoke.ts dsh-plugin-desktop-beta/dist/mac-smoke` 退出码 0
- [ ] 任务完整性：Task-006、Task-007 的增量 checkbox 全勾
- [ ] 依赖变更：无未声明的新增第三方依赖

---

### Task-009：同步共享改动到 stable 变体

**描述**：把 beta 侧验证过的三处共享文件改动同步到 `dsh-plugin-desktop/`，并跑变体一致性检查。根 `scripts/prepare-*.mjs` 为两变体共用，无需同步。
**关联需求**：根 `AGENTS.md:18`（beta 先行验证后同步 stable）。→ Agent：读取 `AGENTS.md:18` 确认同步与校验要求。
**前置依赖**：Task-008（beta 端到端验证通过）

**工时估算**：0.26 人天
- 基础：0.2 人天（S）
- 缓冲：0.06 人天（业务风险-中：0.2 × 20% × 1.5）
- 总计：0.26 人天
→ Agent：缓冲计算规则见 `references/risk-classification.md`。

**涉及文件**：
- `dsh-plugin-desktop/tests/desktop-runtime-environment.spec.ts` — 修改，同步 Task-006 的用例
- `dsh-plugin-desktop/scripts/mac-universal.ts` — 修改，同步 Task-007 的清单常量
- `dsh-plugin-desktop/scripts/verify-mac-smoke.ts` — 修改，同步 Task-007 的校验段落
- `dsh-plugin-desktop/tests/verify-mac-smoke.spec.ts` — 修改，同步 Task-007 的测试断言

**验收标准**：
- **两个变体的共享文件逐字节一致**：当归档时，`dsh-plugin-desktop/tests/desktop-runtime-environment.spec.ts` 与 beta 同名文件内容相同，`scripts/mac-universal.ts`、`scripts/verify-mac-smoke.ts` 及其 spec 亦然。验证方式：`diff dsh-plugin-desktop/tests/desktop-runtime-environment.spec.ts dsh-plugin-desktop-beta/tests/desktop-runtime-environment.spec.ts`、`diff dsh-plugin-desktop/scripts/mac-universal.ts dsh-plugin-desktop-beta/scripts/mac-universal.ts`、`diff dsh-plugin-desktop/scripts/verify-mac-smoke.ts dsh-plugin-desktop-beta/scripts/verify-mac-smoke.ts`、`diff dsh-plugin-desktop/tests/verify-mac-smoke.spec.ts dsh-plugin-desktop-beta/tests/verify-mac-smoke.spec.ts` 四者退出码均为 0
- **变体一致性门禁通过**：当共享 `src/` 无未声明漂移时，`corepack yarn check:desktop-variants` 通过（本次不改 `src/`，用于确认未误伤）。验证方式：`corepack yarn check:desktop-variants` 退出码 0
- **stable 侧测试通过**：当 stable 工作区运行相关测试时全部通过。验证方式：`yarn workspace dsh-plugin-desktop vitest run tests/desktop-runtime-environment.spec.ts tests/verify-mac-smoke.spec.ts` 退出码 0

**增量计划**：
- [ ] **增量 1**：同步测试与脚本
  - 做什么：把 Task-006、Task-007 在 beta 落地的四处改动复制到 stable 对应文件
  - 交付：stable 侧同构文件
  - 对应验收标准：两个变体的共享文件逐字节一致
  - 完成判定：四条 `diff` 命令退出码均为 0
- [ ] **增量 2**：跑变体一致性门禁
  - 做什么：执行仓库规定的变体检查，确认未引入未声明漂移
  - 交付：门禁通过记录
  - 对应验收标准：变体一致性门禁通过
  - 完成判定：`corepack yarn check:desktop-variants` 退出码 0
- [ ] **增量 3**：stable 侧测试与类型检查
  - 做什么：在 stable 工作区跑两个相关测试文件与 typecheck
  - 交付：stable 侧验证通过
  - 对应验收标准：stable 侧测试通过
  - 完成判定：`yarn workspace dsh-plugin-desktop vitest run tests/desktop-runtime-environment.spec.ts tests/verify-mac-smoke.spec.ts` 退出码 0 && `yarn workspace dsh-plugin-desktop typecheck` 无错误

**失败策略**：见 tasks.md 全局约定。

---

### Task-010：更新既有 CLI 打包文档

**描述**：更新两份 CLI 打包说明文档，把 vendor 清单、架构说明、体积表与构建命令从「仅 arm64」改为「universal」。这两份文档是当初记录「已知限制」的地方，不同步更新会让文档与实现对不上。
**关联需求**：`proposal.md:45`（更新 vendor 清单、体积表与 universal 构建说明）。→ Agent：读取 `proposal.md:45` 确认文档改动范围。
**前置依赖**：Task-005（需要实测体积数字）

**工时估算**：0.36 人天
- 基础：0.3 人天（S）
- 缓冲：0.06 人天（业务风险-低：0.3 × 20% × 1）
- 总计：0.36 人天
→ Agent：缓冲计算规则见 `references/risk-classification.md`。

**涉及文件**：
- `docs/bundle-codegraph-cli.zh.md` — 修改，vendor 清单、`x64ArchFiles` 说明、体积表与构建命令
- `docs/bundle-mnemon-cli.zh.md` — 修改，vendor 清单、sha256 钉值表与构建命令

**验收标准**：
- **vendor 清单含 darwin-x64**：当文档描述 vendor 目录时，两份文档的清单都列出 darwin-x64 归档及其作用。验证方式：`grep -c 'darwin-x64' docs/bundle-codegraph-cli.zh.md docs/bundle-mnemon-cli.zh.md` 两者均 ≥ 1
- **universal 合成机制被记录**：当文档描述 macOS 打包时，说明了 `darwin-universal` target 与 `lipo` 合成、以及两个切片共用同一份产物的原因。验证方式：两份文档均含 `darwin-universal` 且含 `lipo`
- **体积数字更新**：当文档描述 DMG 体积时，给出了本次变更后的实测值（codegraph 从 392 MB 起算 +158 MB 解压量、mnemon +16 MB）。验证方式：`grep -n '392' docs/bundle-codegraph-cli.zh.md` 命中处上下文含更新后的数字，且两份文档不含未更新的「仅 arm64」表述
- **架构门禁未因文档改动失效**：当归档时，仓库的布局与文档门禁通过。验证方式：`corepack yarn check:layout` 退出码 0

**增量计划**：
- [ ] **增量 1**：更新 CodeGraph 文档
  - 做什么：更新 `docs/bundle-codegraph-cli.zh.md` 的 vendor 清单、`x64ArchFiles` 说明、体积表与构建命令
  - 交付：更新后的 CodeGraph 文档
  - 对应验收标准：vendor 清单含 darwin-x64、universal 合成机制被记录
  - 完成判定：`grep -c 'darwin-x64' docs/bundle-codegraph-cli.zh.md` ≥ 1 && 该文档含 `darwin-universal` 与 `lipo`
- [ ] **增量 2**：更新 Mnemon 文档
  - 做什么：更新 `docs/bundle-mnemon-cli.zh.md` 的 vendor 清单、sha256 钉值表与构建命令
  - 交付：更新后的 Mnemon 文档
  - 对应验收标准：vendor 清单含 darwin-x64、universal 合成机制被记录
  - 完成判定：`grep -c 'darwin-x64' docs/bundle-mnemon-cli.zh.md` ≥ 1 && 该文档含 `darwin-universal` 与 `lipo`
- [ ] **增量 3**：核对体积数字与布局门禁
  - 做什么：以 Task-005 的实测体积复核文档数字，并确认两份 `docs/bundle-*.zh.md` 不在双语文档记录内（仓库通过 `git ls-files '*.i18n.yaml'` 登记双语对，这两份仅有 zh 版本、无 `.i18n.yaml`，故无 en 侧需同步）
  - 交付：体积数字更新 + 门禁通过
  - 对应验收标准：体积数字更新、架构门禁未因文档改动失效
  - 完成判定：`corepack yarn check:layout` 退出码 0

**失败策略**：见 tasks.md 全局约定。

---

### Task-011：最终检查点 — 全量门禁

**类型**：检查点
**触发条件**：Task-009、Task-010 完成后触发

**验证项**（仅包含可自动验证项）：
- [ ] 架构门禁：`corepack yarn check:layout` 退出码 0
- [ ] 变体一致：`corepack yarn check:desktop-variants` 退出码 0
- [ ] prepare 单测：`node --test scripts/prepare-universal-bundle.test.mjs` 全部通过
- [ ] 双变体 mac 打包检查：`yarn workspace dsh-plugin-desktop check:mac-package` 与 `yarn workspace dsh-plugin-desktop-beta check:mac-package` 均退出码 0
- [ ] stable 端到端：`yarn workspace dsh-plugin-desktop dist:mac-smoke` 退出码 0 && `node dsh-plugin-desktop/scripts/verify-mac-smoke.ts dsh-plugin-desktop/dist/mac-smoke` 退出码 0
- [ ] Windows 未回归：`node scripts/prepare-codegraph.mjs --desktop dsh-plugin-desktop --target win32-x64` 与 `node scripts/prepare-mnemon.mjs --desktop dsh-plugin-desktop --target win32-x64` 均退出码 0
- [ ] Linux 未触碰：`git diff --stat scripts/prepare-codegraph.mjs scripts/prepare-mnemon.mjs` 显示两个脚本的改动中不含 `linux` 字样新增行；`git diff scripts/ | grep -c '^+.*linux'` 返回 0
- [ ] 任务完整性：Task-001 至 Task-010 的增量 checkbox 全勾
- [ ] 依赖变更：无未声明的新增第三方依赖

---

## 风险

| 风险 | 等级 | 应对 |
|------|------|------|
| 两份归档的 PLAIN 文件差异超出预期清单（已知为 codegraph 与 mnemon 的 `package.json`、mnemon 的 `README.md`） | 中 | Task-002 的差异检测在超预期差异时**硬失败并打印相对路径**，不静默继续；保留白名单仅在锚定路径上生效 |
| `lipo` 合并破坏代码签名 | 低 | 已实测合并后 `codesign --verify --strict --arch x86_64` 与 `--arch arm64` 均通过（保留 TeamIdentifier `H7739G8FX`）；当前为未签名 DMG 路线，`resetAdHocDarwinSignature: true` |
| `prepare-codegraph.mjs:147` 的 `manifest.name !== target.packageName` 断言会拒绝归一后的 universal manifest | 中 | Task-003 对新 target 放宽为「name 前缀正确 + `cpu` 含双架构 + license 匹配」，**不放松** license 校验（`MIT` / `Apache-2.0` 仍强制） |
| 与 `20260921191517-linux-appimage` 同时改 `scripts/prepare-codegraph.mjs` 的 `TARGETS` 产生冲突 | 中 | 本次只新增 `darwin-universal` 条目与 darwin 默认推断；`win32-*` 与 Linux 分支不动。Task-011 用 `git diff` 断言无新增 linux 相关行 |
| DMG 体积超出 +60 MB 预算过多 | 低 | 按实测压缩比 0.322 推算 +56 MB；Task-008/Task-011 实测 DMG 大小复核，显著超出则回到决策一的备选方案二 |
| `check:mac-package` 在 CI 的 `macos-latest`（arm64 runner）上通过，但 Intel 真机行为仍不同 | 中 | Task-005 检查点显式用 `arch -x86_64` 执行两个 CLI 的 `--version`，Task-007 把双架构断言固化进流水线 |
| `verify-mac-smoke.ts` 与 spec 在 stable/beta 之间逐字节相同，手工同步易漏 | 低 | Task-009 用四条 `diff` 命令作为验收标准，而不是靠人工比对 |

---

## 实施顺序

### 阶段一：依赖与合成逻辑

<!-- PARALLEL: Task-001, Task-002 -->

| 任务 | 耗时 | 前置依赖 | 执行方式 |
|------|------|----------|----------|
| Task-001：补齐 darwin-x64 vendor 归档 | 0.26 人天 | 无 | **可并行**（只新增 `vendor/` 下两个二进制归档，与 Task-002 的 `scripts/` 新文件无交集，无共享状态） |
| Task-002：抽出 universal 合成逻辑为可测模块 | 0.52 人天 | 无 | **可并行**（只新增 `scripts/prepare-universal-bundle*.mjs` 并改根 `package.json` 脚本段，不读 vendor 归档，单测用临时目录构造成立） |

### 阶段二：两个 prepare 脚本改造

<!-- PARALLEL: Task-003, Task-004 -->

| 任务 | 耗时 | 前置依赖 | 执行方式 |
|------|------|----------|----------|
| Task-003：prepare-codegraph 接入 darwin-universal | 0.52 人天 | Task-001、Task-002 | **可并行**（只改 `scripts/prepare-codegraph.mjs`，与 Task-004 的 `scripts/prepare-mnemon.mjs` 无文件交集） |
| Task-004：prepare-mnemon 接入 darwin-universal 与 darwin-x64 钉值 | 0.52 人天 | Task-001、Task-002 | **可并行**（同上，两个脚本各自独立，均只依赖 Task-002 的共享模块） |
| Task-005：prepare 脚本端到端合成检查点 | — | Task-001~004 | 串行（检查点必须等两侧改造都落地才能验证三处 Mach-O） |

### 阶段三：beta 变体运行时与打包校验

| 任务 | 耗时 | 前置依赖 | 执行方式 |
|------|------|----------|----------|
| Task-006：beta 侧运行时判定测试补 universal 用例 | 0.36 人天 | 无 | 串行 |
| Task-007：beta 侧 smoke 校验增加内置 CLI 双架构断言 | 0.36 人天 | Task-003、Task-004 | 串行 |
| Task-008：beta 端到端打包验证检查点 | — | Task-006、Task-007 | 串行 |

### 阶段四：同步 stable 与文档

| 任务 | 耗时 | 前置依赖 | 执行方式 |
|------|------|----------|----------|
| Task-009：同步共享改动到 stable 变体 | 0.26 人天 | Task-008 | 串行（必须先完成 beta 端到端验证） |
| Task-010：更新既有 CLI 打包文档 | 0.36 人天 | Task-005 | 串行 |
| Task-011：最终检查点 — 全量门禁 | — | Task-009、Task-010 | 串行 |

**关键路径**：Task-002（0.52）→ Task-004（0.52）→ Task-007（0.36）→ Task-008（—）→ Task-009（0.26）→ Task-011（—），即 0.52 + 0.52 + 0.36 + 0.26 = **1.66 人天**。Task-001、Task-003、Task-006 在阶段内可与关键路径并行推进，不延长总工期；Task-010 依赖 Task-005 而非关键路径末端，其 0.36 人天被 Task-007~Task-009 的 0.62 人天覆盖，同样不延长总工期。

**总工期**：**1.66 人天**（关键路径之和）
