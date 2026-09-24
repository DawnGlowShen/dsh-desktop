# 安全审查报告

| 字段 | 值 |
|------|-----|
| **审查范围** | `scripts/prepare-codegraph.mjs`、`scripts/prepare-mnemon.mjs`、`scripts/prepare-universal-bundle.mjs`（本 feature 新增/重写的打包脚本，含归档解包、`chmod`、路径拼接、marker 身份判据） |
| **变更类型** | 新功能（macOS universal 双架构 bundle 的构建期脚本） |
| **变更规模** | 3 脚本 / 约 +750 −250 |
| **结论** | APPROVE（CRITICAL 0 / IMPORTANT 3 / SUGGESTION 3，IMPORTANT 全部已修复） |

> 由子代理 `6c3971b1-8d00-46a1-9457-3cdb3105debe` 出具结论，本报告记录其发现与修复后的实测证据。

---

## 问题摘要

| 级别 | 数量 | 说明 |
|------|------|------|
| CRITICAL | 0 | 必须修复才能合并 |
| IMPORTANT | 3 | 已全部修复 |
| SUGGESTION | 3 | 2 个已修，1 个经核实无需修改 |

---

## 风险不可达性论证（为何三项 IMPORTANT 均不构成 CRITICAL）

三项 IMPORTANT 都要求攻击者**已经能够写入 git 跟踪的 `vendor/`** 目录。在该前提下攻击者本来就能直接改写 `scripts/` 或已构建的 `build/*/host/`，因此这些缺陷不提升实际攻击面，不满足 CRITICAL 门槛。修复仍照做，因为它们把「构建产物被静默替换」从无防护变为有防护。

---

## IMPORTANT Issues

### I-1：归档解包无路径包含校验 + 符号链接逃逸

- **位置**：`scripts/prepare-codegraph.mjs:163-172`（`extract()`）、`:195`（`chmodSync`）；`scripts/prepare-mnemon.mjs:167-176`、`:208`
- **机制**：bsdtar 确实拒绝 `..`（exit 1）、绝对路径前导 `/` 被剥落到目标内，**但符号链接条目配合 `chmodSync` 可改写目标目录之外宿主机文件的权限**。实测：构造 `bin/codegraph -> /tmp/symtest/victim/target.txt` 后，victim 由 `-rw-------` 变为 `-rwxr-xr-x`。`statSync(...).isFile()` 会跟随符号链接，拦不住。
- **修复**：
  1. `extract()` 加 `--no-same-owner --no-same-permissions`；
  2. 新增 `assertContainedExtraction(destination)`：`realpathSync` 后递归 `readdirSync(..., {withFileTypes:true})`，`lstatSync` 见符号链接即 `fail('archive entry is a symbolic link: …')`；非常规文件亦 fail；`realpathSync(absolute)` 必须等于或前缀于 `destinationReal + sep`，否则 `archive entry escapes the extraction root`；
  3. `assertExecutables` 的 `statSync(path).isFile()` 改为 `lstatSync(path).isFile()`。

### I-2：`--target __proto__` 原型污染

- **位置**：`scripts/prepare-codegraph.mjs:283-287`、`scripts/prepare-mnemon.mjs:295-299`（修复前）
- **机制**：`TARGETS['__proto__']` 沿原型链返回 `Object.prototype`（非 `undefined`），绕过「未知 target」守卫，并在后续写入 `Object.prototype.key`。实测修复前 `({}).key === '__proto__'` 为 true，随后抛 `TypeError: Cannot read properties of undefined (reading 'test')`。
- **修复**：`Object.hasOwn(TARGETS, targetKey)`。
- **修复后实测**：`--target __proto__` → exit 1，`unsupported target __proto__; expected one of darwin-arm64, darwin-x64, darwin-universal, win32-x64, win32-arm64`；`({}).key` = **undefined**。

### I-3：CodeGraph 归档无 sha256 钉值

- **位置**：`scripts/prepare-codegraph.mjs:123-124`（`sha256()`）、`:268`、`:290`（修复前）
- **机制**：`expectedSha256 = sha256(sources.at(-1).archive)` —— 期望值与被校验对象**同源**，任何归档都能通过；唯一守卫是归档自述的 `name`/`license`。对照 `prepare-mnemon.mjs:87,92,103` 三个 target 均有钉值。
- **修复**：照 mnemon 形状补三个钉值——`darwin-arm64` = `3f501578d2360c58e56a348f1b1b0ee17d6b1fb3db9bb70d78443ed7754b2908`、`darwin-x64` = `0573a6322db1ff72d1b1a5f30f2e8893712c224423655d2b46e56842e7237627`、`win32-x64` = `2c33189a7a358c5c953ec11d83a8f7353e8d4703c6b59b290399135b9b6591d5`（后者与 `docs/bundle-codegraph-cli.zh.md:612` 记录一致）。校验失败文案：`… has sha256 <actual>, expected <declared> — the vendored archive changed`。

---

## SUGGESTION Issues

### S-1：`lipo -archs` 空 stdout 被误报（已修）

`split(/\s+/)` 会把空 stdout 变成 `['']`，把工具异常误报为 `missing x86_64`。已加 `filter(arch => arch !== '')` 与 `archs.length === 0` 的专门报错。经核实 `defaultRun` 的 `result.error` 处理本身正确（返回 `status: null`，两处 `status !== 0` 均能捕获）。

### S-2：`.node` 标 `executable: false` 仍做双架构验证（无需修改）

经核实这是**正确且必要**的：`lipo -verify_arch` 能挡住瘦架构，正是本 feature 要防的回退。

### S-3：`--desktop` 漏值静默回退到 cwd（已修）

`?? ''` 使 `resolve('') === cwd`，与 `--target` 缺值即失败不一致。已改为显式 `fail`。

- **修复后实测**：`--desktop --target darwin-universal` → exit 1，`run this from a desktop workspace, or pass --desktop <workspace directory>`；`--target darwin-universal --desktop` → exit 1，`--desktop requires a workspace directory`；`--target` → exit 1，`--target requires a value such as darwin-universal`。

---

## 横向检查

| 检查项 | 结果 |
|--------|------|
| 机密管理 | 全量 diff 正则扫描 **0 命中**；CI `desktop-macos` job 不引用任何 `secrets.*` |
| 依赖安全 | **未新增任何第三方依赖**（含传递依赖）；`@electron/universal` 2.0.3 为既有依赖 |
| 外部命令调用 | `tar` / `lipo` 均经 `spawnSync(command, args)` 数组传参，无 shell 字符串拼接，无注入面 |
| 路径遍历 | 除 I-1 修复外，`relativeToRoot` 仅用于日志；输出路径由 `desktopRoot` + 固定子路径拼成 |
| 归档来源 | 三个工具归档全部 git 跟踪于 `vendor/`，并已有 sha256 钉值（I-3 修复后覆盖 codegraph） |

---

## 验证证据（修复后实测）

| 场景 | 结果 |
|------|------|
| `--target __proto__` | exit 1；`({}).key` = undefined |
| `--desktop` 漏值（前置与末尾两种） | exit 1，文案明确 |
| `--target` 漏值 | exit 1，文案明确 |
| 不支持 target（`darwin-mips`） | exit 1 |
| 假 `tar` 注入（`PATH` 前置） | exit 1，`.sources` 已清理，`host/` 未损 |
| 篡改 marker 单半 sha256 | `--check` exit 1，默认运行重建 |
| 单架构产物上跑 universal `--check` | exit 1（身份判据生效） |
| 两变体 `typecheck` / 相关 vitest | 全 exit 0 |

---

## 结论

**APPROVE**。三个 IMPORTANT 全部修复且均有实测证据；剩余三项 SUGGESTION 中两项已修、一项经核实本就不需改。无 CRITICAL。打包产物的 ad-hoc 签名（`spctl -a -vvv -t install` 拒绝、DMG 未签名）为仓库既有定位，不由本 feature 引入，也不在本次审查范围内。
