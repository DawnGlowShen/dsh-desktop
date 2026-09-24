# 代码审查报告

| 字段 | 值 |
|------|-----|
| **审查范围** | `scripts/prepare-universal-bundle.mjs`（159→~190 行，新增）、`scripts/prepare-codegraph.mjs`、`scripts/prepare-mnemon.mjs`、`scripts/prepare-universal-bundle.test.mjs`（新增 278 行），以及两变体各 4 个文件：`scripts/mac-universal.ts`、`scripts/verify-mac-smoke.ts`、`scripts/verify-mac-release.ts`、`tests/mac-universal.spec.ts`、`tests/verify-mac-smoke.spec.ts`、`tests/verify-mac-release.spec.ts`、`src/desktop-runtime-environment.ts` |
| **变更类型** | 新功能（macOS 改为打包 universal 双架构 bundle，让 Intel Mac 也能生成 `~/.dsh/bin` 垫片）+ 评审后修复 |
| **变更规模** | 18 文件 / +825 −257（含评审修复）；全量 feature diff 另含 vendor 归档与文档 |
| **结论** | REQUEST_CHANGES（首轮）→ 全部 CRITICAL/IMPORTANT 已修复并实测验证 |

> 首轮审查由子代理 `37d3bb4d-c10e-4502-85f1-6736068c6256` 出具 **REQUEST_CHANGES（2 CRITICAL / 3 IMPORTANT / 7 SUGGESTION）**；
> 第二路子代理 `8d22384d-fd7c-40c3-a550-ef6da3841310` 审 smoke 校验层，出具 **APPROVE（0 CRITICAL / 2 IMPORTANT / 5 SUGGESTION）**。
> 本报告合并两路结论与修复后的实测证据。

---

## 问题摘要

| 级别 | 数量 | 说明 |
|------|------|------|
| CRITICAL | 2 | 必须修复才能合并 |
| IMPORTANT | 5 | 应该修复再合并 |
| SUGGESTION | 12 | 可以考虑 |

---

## CRITICAL Issues（必须修复）

### CRITICAL 1：暂存目录在失败路径上泄漏（278 MB）

- **位置**：`scripts/prepare-codegraph.mjs`、`scripts/prepare-mnemon.mjs` 的 `prepareUniversal`
- **机制**：清理依赖 `try/finally`，但所有校验失败都走 `fail()`，而 `fail()` 是 `process.exit(1)`。**Node 在调用 `process.exit()` 时不会执行 `finally` 块**，故解包到 `build/<tool>/.sources` 的 278 MB 暂存目录被留下。
- **实测复现**：`node -e "try{process.exit(3)}finally{fs.writeFileSync('/tmp/m','x')}"` → exit 3 且 marker 未生成。
- **修复**：`fail()` 改为 `throw new Error(message)`；顶层逻辑搬进 `function main()`，文件末尾统一 `try { main() } catch (error) { process.stderr.write(...); process.exit(1) }`。异常沿调用栈穿过 `finally`。
- **修复后实测**：构造 `/tmp/fakebin/tar`（`exit 1`）后运行 → exit 1、stderr `prepare-codegraph: tar exited with 1: fake tar: deliberate failure`，`build/codegraph/.sources` **不存在**，`host/` 完好。

### CRITICAL 2：残缺产物被判为「已准备」

- **位置**：`--check` 分支的复用判据
- **机制**：只探测 `target.executables[0]`。而 `mergeUniversalBundle` **先写明文文件、后写 Mach-O**，故 `lipo -create` 中断会留下「`bin/codegraph` 在、`node` 不在」的产物，`--check` 仍报 `is prepared`，默认运行也走 `reusing`。
- **实测复现**：真实 beta 产物上 `mv build/codegraph/host/node /tmp/node.bak` → `--check` exit **0**；默认运行打印 `reusing`，`host/node` 仍缺失。
- **修复**：新增 `missingExecutables(target, outputRoot)`（`target.executables.filter(e => !existsSync(join(outputRoot, e)))`），复用判据改为 `existing?.target === targetKey && sameChecksums(existing.archiveSha256, checksums) && missing.length === 0`。
- **修复后实测**：同样移除 `host/node` 后 `--check` → exit 1，`CodeGraph CLI for darwin-universal is not prepared (missing node); run node scripts/prepare-codegraph.mjs`；默认运行 exit 0 正确重建，`lipo -archs` = `x86_64 arm64`。

---

## IMPORTANT Issues（应该修复）

### IMPORTANT 1：产物身份只覆盖 x64 归档，arm64 被换不会被发现

- **位置**：marker 的 `archiveSha256`
- **机制**：universal 的明文文件取自 arm64 半，但身份只记 `sha256(sources.at(-1).archive)`（x64）。替换 arm64 tgz 后已构建的 bundle 仍被报为最新。
- **修复**：`archiveChecksums(sources)` → 以 targetKey 为键的对象；`sameChecksums` 做顺序无关比较。codegraph 补三个 sha256 钉值。
- **实测**：把 marker 中 `darwin-arm64` 改成 `deadbeef…` → `--check` exit 1，默认运行重建。

### IMPORTANT 2：两个空目录会「成功」合并成空 bundle

- **位置**：`planUniversalMerge`
- **机制**：先做双向集合包含校验，两个空集合互相包含，于是空 bundle 被写出并照样写 manifest 与 marker。
- **修复**：`arm64Files.length === 0` / `x64Files.length === 0` → `contains no files; the merge would produce an empty payload`；分类后 `machOFiles.length === 0` → `no runnable runtime`。

### IMPORTANT 3：`test:prepare-universal` 在 windows-latest 上必然失败

- **位置**：`scripts/prepare-universal-bundle.test.mjs` 的可执行位用例
- **机制**：断言 `statSync(...).mode & 0o777 === 0o755`，但 `check:layout`（`.github/workflows/ci.yml` 的 `upstream-command-windows` 作业）在 windows-latest 执行，POSIX 权限位不可表示。
- **修复**：该用例加 `{ skip: process.platform === 'win32' ? 'POSIX permission bits are not representable on Windows' : false }`。

### IMPORTANT 4（第二路）：`MACOS_UNIVERSAL_BUNDLED_CLI_ENTRIES` 无法表达「必须是 Mach-O」

- **位置**：`scripts/mac-universal.ts`、`scripts/verify-mac-smoke.ts`
- **机制**：`verify-mac-smoke.ts:162-163` 对每个条目无条件跑 `lipo -verify_arch`。`Resources/codegraph/bin/codegraph` 实为 1004 字节 POSIX `sh` 脚本，将来有人加此类条目，单测会过而真实 DMG 冒烟必失败。
- **修复**：常量加 `machO: boolean`，`if (!entry.machO) continue`。

### IMPORTANT 5（第二路）：fixture 与断言共用同一常量，删项则双绿

- **位置**：`tests/verify-mac-smoke.spec.ts:145-148`
- **机制**：fixture 建文件与断言都从 `MACOS_UNIVERSAL_BUNDLED_CLI_ENTRIES` 派生，删掉一个条目会同时少建文件、少断言，主用例仍绿。
- **修复**：在 `tests/mac-universal.spec.ts` 补字面量钉住用例 `expect(MACOS_UNIVERSAL_BUNDLED_CLI_ENTRIES).toEqual([...])`（照 `MACOS_UNIVERSAL_NATIVE_ENTRIES` 既有先例）。

---

## SUGGESTION Issues

| 编号 | 内容 | 处置 |
|------|------|------|
| 1 | 移除未使用的 `plan.fileCount` | 已修 |
| 2 | `assertExecutables` 不伪造 target 对象，改收 `{ executables, targetKey }` | 已修 |
| 3 | `isMachO` 整文件读入数百 MB 文件，改只读 4 字节 | 已修（`openSync`/`readSync`/`closeSync`） |
| 4 | mnemon 同一归档被 sha256 三次 | 已修（一次计算，`verify` 收 `archiveSha256` 参数） |
| 5 | codegraph 归一描述用 `String.replace(/darwin-x64/u,'darwin')` 拼装 | 已修（改固定文案） |
| 6 | `lipo` 失败未区分 signal；`spawnSync` 无 `maxBuffer` | 已修（`describeRunFailure` + `8 MiB`） |
| 7 | 合并后 README 仍自称 `Mnemon darwin-arm64`，与双架构 manifest 矛盾 | 已修（`prepare-mnemon.mjs` 覆写 README） |
| 8（第二路 SUG-1） | 缺「`executable:false` 在 0o644 下必须通过」反例 | 已修（新增用例，并断言真实产物确为 0644） |
| 9（第二路 SUG-1） | 缺「CLI 丢失某一切片必须被拒」反例 | 已修（注入 `run` 令 `lipo` 抛错） |
| 10（第二路 SUG-2） | `verify-mac-release.ts` 未校验内置 CLI 双架构，而它校验的是用户实际安装的签名 DMG | 已修（同一 `Contents` 相对路径循环，并同步 spec） |
| 11（第二路 SUG-4） | 断言 `mkdtempSync` 派生的随机绝对路径 | 已修（改稳定串 `'missing bundled CLI'`） |
| 12（第二路 SUG-5） | `bundleSupportsHost` 的 JSDoc 仍称 universal 只带单切片 | 已修 |

**第二路 SUG-3 未采纳**：`verify-packaged-runtime.ts` 的 `REQUIRED_MACOS_UNIVERSAL_ENTRIES` 未纳入内置 CLI，且其根为 `.../Contents/Resources/app` 而 CLI 路径相对 `Contents`，无法直接 map 追加。该文件校验的是**开发机未签名产物**，而 `verify-mac-release.ts` 已覆盖用户实际安装的签名 DMG（SUG-2），故本轮不引入跨基路径的拼接复杂度。

---

## 修复过程中自查发现的缺陷

新增的 `assertUniversalArchitectures` 最初对 `target.executables` **每一条**跑 `lipo -archs`，但 `bin/codegraph` 是 POSIX shell 脚本：

```
prepare-codegraph: bin/codegraph is not a universal binary; run node scripts/prepare-codegraph.mjs   (exit 1)
file .../host/bin/codegraph → POSIX shell script text executable, Unicode text, UTF-8 text
lipo -archs → lipo: not a mach-o '...'   (exit 1)
```

修复：`export function isMachO`，两脚本改为 `filter(c => existsSync(c.path) && isMachO(c.path))`，全被滤掉时 fail。修复后两脚本 `--check` 在干净产物上 exit 0。

另外，把 beta 改动同步 stable 时，我一度用 beta 版覆盖了 `dsh-plugin-desktop/tests/verify-mac-release.spec.ts`（该文件是唯一在两变体间合法不同的测试，产品名为 `'DSH Desktop'` / `'DSH Desktop-2.0.0-universal.dmg'`），把 stable 侧产品名改成了 beta 的。`verify-desktop-variants.mjs` 只扫 `src/`，**不会**捕获 `tests/` 下的这类漂移。已用 `git checkout HEAD --` 恢复并只保留新增断言，复核 stable 侧不再含任何 beta 标识。

---

## 验证证据

| 门禁 | 结果 |
|------|------|
| `node --test scripts/prepare-universal-bundle.test.mjs` | 14 / 14 pass |
| `check:desktop-variants` | exit 0，`184 shared source files are aligned` |
| `check:layout` | exit 0，含 `sync-vendored-runtime: stable/beta 265 packages from fb2c4b9e69 are verified` |
| stable `check:mac-package` | exit 0，`verify-runtime-closure: 247 first-party nodes form a closed reachable runtime graph.` |
| beta `check:mac-package` | exit 0，同上 |
| 两变体 `typecheck` | exit 0 |
| 两变体 `vitest run tests/{mac-universal,verify-mac-smoke,verify-mac-release}.spec.ts` | 各 17 passed (17) |
| linux 约束 | `git diff fd7f5921c2 -- scripts/ \| grep -c '^+.*linux'` = **0** |
| CRITICAL 1 实测 | 假 tar → exit 1，`.sources` 已清理 |
| CRITICAL 2 实测 | 移除 `host/node` → `--check` exit 1；默认运行正确重建 |
| IMPORTANT 1 实测 | 篡改 marker arm64 半 → `--check` exit 1 |
| 原语污染实测 | `--target __proto__` → exit 1，`({}).key` 为 undefined |
| 参数漏值实测 | `--desktop` / `--target` 漏值均 exit 1 并给出明确文案 |
| 单架构回滚实测 | `--target darwin-arm64` → exit 0，`lipo -archs` = `arm64`；其上跑 universal `--check` → exit 1 |
| Windows 目标实测 | `--target win32-x64` 两脚本 exit 0 |

---

## 结论

**APPROVE**。首轮 2 个 CRITICAL、5 个 IMPORTANT 与 12 个 SUGGESTION 中除第二路 SUG-3 外全部修复，且每一处修复都有实测证据（非仅静态推断）。剩余风险为打包产物的 ad-hoc 签名（`spctl` 拒绝），系仓库既有定位、非本次引入，Intel 用户需 `xattr -dr com.apple.quarantine` 或右键打开。
