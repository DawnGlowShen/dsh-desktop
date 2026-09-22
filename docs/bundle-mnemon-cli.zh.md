# 把 mnemon CLI 随 DSH Desktop 一起离线安装（方案 · macOS + Windows）

> **状态：macOS 与 Windows 的代码路径均已实施（2026-09-22）；Windows 注册表 PATH 的实际效果待原生 Windows 主机验证。**
>
> 目标读者：不熟悉构建流程的使用者。所有结论都标注了查证来源。
>
> 本文是 `docs/bundle-codegraph-cli.zh.md` 的姊妹篇。**先读那一篇**——两篇共用同一套
> 机制，本文只写差异，不重复解释共同部分。
>
> 实施结果与实际偏差见文末「实施记录」。

---

## 0. 结论速览

| 问题 | 结论 |
|------|------|
| 能离线预装吗？ | **能。** 平台包是**单个自包含的 Go 二进制**，连 Node 都不需要 |
| macOS DMG 会大多少？ | **约 +6 MB**（压缩比 0.396，实测见第 6 节） |
| Windows 安装包会大多少？ | **约 +5.5 MB** |
| 离线机器要先装什么吗？ | **什么都不用**，见 2.1 |
| macOS 的 PATH 怎么做？ | **首次启动写 `~/.zshrc`**（与 CodeGraph **共用同一个块**） |
| Windows 的 PATH 怎么做？ | **NSIS 安装时写注册表**（与 CodeGraph 各写一条） |
| 两平台机制一样吗？ | **不一样**，与 CodeGraph 的结论相同 |
| 和 CodeGraph 的最大差异？ | **单文件 Go 二进制 ↔ 内嵌 Node 的 JS 程序**，见第 2 节 |

> 体积结论：mnemon **不是** 体积问题（+6 MB），CodeGraph 才是（+54 MB）。
> 把两者放在一起看，本次新增的两个 CLI 里 mnemon 几乎不花钱。

---

## 1. 需求

1. 离线机器上**只装 DSH Desktop**，`dsh-mnemon` 插件的记忆功能可用
2. 同一台机器的 **Terminal** 里也能敲 `mnemon recall`、`mnemon remember` 等命令
3. 全程**完全离线**，机器上可能连 Node.js 都没有
4. **macOS 与 Windows 都要覆盖**
5. 内置版本要能被 `dsh-mnemon` 插件自动发现，**不改任何插件配置**

---

## 2. 查证到的事实

### 2.1 CLI 是单个自包含的 Go 二进制

两个平台归档解开后都只有 4 个文件：

```
package/LICENSE        11 KB
package/bin/mnemon     15,519,186 字节   （win32 为 bin/mnemon.exe，13,772,288 字节）
package/package.json   474 字节
package/README.md      170 字节
```

与 CodeGraph 的关键差异——**这里没有 `node`，也没有 `lib/`**：

| | CodeGraph | Mnemon |
|---|---|---|
| 形态 | `bin/codegraph`（shell 脚本）+ `lib/`（JS）+ **内嵌 node** | **单个 Mach-O / PE 可执行文件** |
| 解压体积 | 278 MB | **15 MB** |
| Node 依赖 | 自带一套 Node（115 MB） | **完全没有** |
| 动态库依赖 | 无（自带 node） | 仅系统库，见下 |
| `bin/` 里的名字 | `codegraph`（POSIX 是 shell 脚本，Win 是 `codegraph.cmd`） | `mnemon`（POSIX）/ **`mnemon.exe`**（Win，真实可执行文件） |

`otool -L` 显示它只链接系统库，没有第三方动态依赖：

```
/usr/lib/libSystem.B.dylib
/usr/lib/libresolv.9.dylib
/System/Library/Frameworks/CoreFoundation.framework/...
/System/Library/Frameworks/Security.framework/...
```

**推论**：这个 CLI 比 CodeGraph 更"离线友好"。CodeGraph 需要担心自带 Node 的可执行位与
Gatekeeper 隔离属性，mnemon 只需要担心它自己那一个文件。

### 2.2 它是 adhoc 签名的

```
Identifier=a.out
Format=Mach-O thin (arm64)
CodeDirectory ... flags=0x20002(adhoc,linker-signed)
Signature=adhoc
```

上游没有做开发者签名，只有链接期的 adhoc 签名。这与 CodeGraph 自带 Node 的情况相同，
**当前未签名路线不受影响**；如果以后走公证路线，这个二进制也要一并处理。

### 2.3 Windows 上是 `.exe` 而不是 `.cmd` —— 这里踩了一个坑

CodeGraph 在 Windows 上发布的是 `bin/codegraph.cmd`（批处理 shim，因为它的入口是 JS）。
**Mnemon 发布的是真实的 `bin/mnemon.exe`。**

最初的实现把两者的启动器名都硬编码成 `${name}.cmd`：

```ts
// ❌ 错误：Windows 上永远找不到启动器
const launcher = join(pathDir, options.platform === 'win32' ? `${label}.cmd` : label)
```

这会让 Windows 上**永远抛「packaged mnemon launcher is missing」**，功能静默失效
（因为调用方只记日志、不阻断启动）。测试抓到了这个错误：

```
FAIL > publishes the Windows launcher with the platform delimiter
Error: dsh-plugin-desktop: packaged mnemon launcher is missing at .../bin/mnemon.cmd
```

修正是把 Windows 启动器名**交给调用方传入**，而不是从名字推：

```ts
installBundledCliRuntime('codegraph', 'codegraph.cmd', options)   // 批处理 shim
installBundledCliRuntime('mnemon',    'mnemon.exe',    options)   // 真实可执行文件
```

**这是本次实施中最值得记住的一条**：两个 CLI 的「可执行文件命名约定」不同，
泛化抽象时不能假设它们一致。

### 2.4 插件通过 PATH 发现 CLI —— 所以只需前置 PATH

`dsh-mnemon` 的 CLI 解析顺序（`dsh-mnemon-source-memory-spaces/lib/native-cli.js:85`
的 `findMnemonCommand()`）：

1. `config.cliPath`（插件配置）
2. 环境变量 `MNEMON_CLI_PATH`
3. **在 `PATH` 里查 `mnemon`**（Windows 上按 `.exe`、`.cmd` 两个后缀探测）
4. 若干常见路径兜底

第 3 步就是我们的切入点。**把包内 `bin` 目录前置到 Host 进程的 `PATH` 即可**，
不需要写任何插件配置、不需要改 `cliPath`、不需要设环境变量。

> **`.cmd` 那个后缀其实是幌子。** `native-cli.js:94-100` 虽然列出 `.exe` 与 `.cmd`
> 两个候选名，但对 `.cmd` 追加了一道守卫：
> `if (/\.cmd$/i.test(name) && mnemonNpmLauncher(path) === void 0) continue;`
> ——只有**被识别为 npm 安装的启动器**才接受 `.cmd`，自己手写的批处理 shim 会被跳过。
> 已用一次进程内验证确认（`isExecutable` 桩函数只为对应后缀返回 true）：
>
> ```js
> findMnemonCommand({}, { platform: 'win32', env: { Path: 'C:\\bundle\\bin' }, home: 'C:\\Users\\x',
>   isExecutable: p => /mnemon\.exe$/i.test(p) })   // -> C:\bundle\bin\mnemon.exe
> findMnemonCommand({}, { platform: 'win32', env: { Path: 'C:\\bundle\\bin' }, home: 'C:\\Users\\x',
>   isExecutable: p => /mnemon\.cmd$/i.test(p) })   // -> undefined
> ```
>
> 这从插件解析逻辑一侧**独立佐证了 §2.3 的结论**：Windows 上必须发布真实的
> `mnemon.exe`，照抄 CodeGraph 的 `.cmd` shim 会永久失效。

### 2.5 归档的 `name` 与 `version` 约定与 CodeGraph 相反

```
@mnemon-dev/mnemon   version 0.2.9-darwin-arm64   os:["darwin"]  cpu:["arm64"]
@mnemon-dev/mnemon   version 0.2.9-win32-x64      os:["win32"]   cpu:["x64"]
```

**平台写在 `version` 里，`name` 保持主包名**。CodeGraph 则相反
（`@colbymchenry/codegraph-darwin-arm64`，后缀在 `name`）。

`scripts/prepare-mnemon.mjs` 的注释里明确记录了这一点，并**两个字段都校验**：

```js
const EXPECTED_PACKAGE_NAME = '@mnemon-dev/mnemon'
// 版本后缀必须与 target key 相同，否则视为拿到了不相干的归档
```

许可证是 **Apache-2.0**（CodeGraph 是 MIT），已通过 `ALLOWED_LICENSES` 白名单。

---

## 3. 两个平台的机制完全不同

与 `docs/bundle-codegraph-cli.zh.md` 第 3 节**完全相同**（macOS 走 shell 配置、
Windows 走注册表）。这里只写 mnemon 特有的两点：

| | **macOS（DMG）** | **Windows（NSIS）** |
|---|---|---|
| PATH 写在哪 | `~/.zshrc` 的标记块 | `HKCU\Environment` 的 `PATH` |
| 与 CodeGraph 的关系 | **共用同一个块**（同一个 `~/.dsh/bin`） | **各写一条**（两个目录） |
| shim 文件 | `~/.dsh/bin/mnemon` | **不需要**，`bin\mnemon.exe` 已在 PATH |

### 3.1 macOS：与 CodeGraph 共用同一个标记块

这是本次设计里最容易做错、也最值得强调的一点。

`~/.zshrc` 里已经有一段用户安装 CodeGraph 时写下的块：

```
# >>> dsh-desktop codegraph >>>
export PATH="$HOME/.dsh/bin:$PATH"
# <<< dsh-desktop codegraph <<<
```

**如果给 mnemon 加一个新块名**，用户升级后会得到**两个块、两行完全相同的 PATH 导出**，
并且还会多出一个多余的 `.dsh-backup-*`。因此：

> **标记块文本故意保持 `codegraph` 不变，不改名。**

理由：`~/.dsh/bin` 已经在这行 PATH 里，mnemon 的 shim 放进**同一个目录**即可生效。
于是**已安装用户的 `~/.zshrc` 逐字节不变**——不追加块、不改内容、不产生备份。

模块也据此从单启动器泛化为多启动器（`src/desktop-codegraph-shell.ts` →
`src/desktop-cli-shell.ts`），但共享一个 `pathDir`，所以仍然只有一个块：

```ts
installDesktopCliShell({
  homeDir, userHomeDir: app.getPath('home'),
  launchers: [
    { name: 'codegraph', launcherPath: join(codegraphRuntime.pathDir, 'codegraph') },
    { name: 'mnemon',    launcherPath: join(mnemonRuntime.pathDir, 'mnemon') },
  ],
  shell: process.env.SHELL,
})
```

shim 内容与 CodeGraph 同构，只是指向不同目标：

```sh
#!/bin/sh
# Generated by the DSH Desktop client. Do not edit: it is rewritten on launch.
exec '/Applications/DSH Desktop Evo.app/Contents/Resources/mnemon/bin/mnemon' "$@"
```

### 3.2 Windows：两个分支，镜像但独立

CodeGraph 与 mnemon 落在**两个不同目录**（`resources\codegraph\bin` 与
`resources\mnemon\bin`），所以 NSIS 里是**两个独立分支**，不是一个参数化循环。

**为什么不做成参数化的循环**：NSIS 宏是文本展开的，共用一段宏体就得把每个
`!define` 与寄存器名都传进去，比它省下的重复更难读。设计文档里的决策记录保留了这个取舍。

两个分支之间有两个必须成立的约束：

**① 安装顺序 = CodeGraph 先、Mnemon 后；卸载顺序必须严格相反。**

卸载时每条目**只在自己仍是 PATH 最后一项时才移除**（避免用户重排过 PATH 时改坏它）。
所以后追加的必须先剥离，前一个才可能轮到它成为最后一项：

```
安装：  ...;resources\codegraph\bin;resources\mnemon\bin
卸载：  先剥 mnemon → ...;resources\codegraph\bin
        再剥 codegraph → ...
```

**② `PathBackup` 只能由第一个真正改动 PATH 的分支写。**

CodeGraph 分支原本就会写备份（因为它去重在前、只在 PATH 真变时才写）。如果 mnemon
分支无条件再写一次，**备份里存的将是「已含 codegraph 的 PATH」而不是用户最初的 PATH**，
回滚就回不到原始状态。修正是第二个分支先读一次：

```nsis
ReadRegStr $6 HKCU "Software\${PRODUCT_NAME}" "PathBackup"
${if} $6 == ""
  WriteRegExpandStr HKCU "Software\${PRODUCT_NAME}" "PathBackup" "$0"
${endIf}
```

**必须遵守的 7 条与 CodeGraph 相同**（只动 HKCU、读改追加、写备份、不用 `setx`、
`REG_EXPAND_SZ`、卸载精确移除、不与既有 `Var` 冲突），逐条对照见
`docs/bundle-codegraph-cli.zh.md` 的 4.4.1。其中第 5 条（`ReadRegStr` 会展开
`%VAR%`）同样是「已知且已接受的取舍」。

### 3.3 便携版

与 CodeGraph 相同：`dist:win-portable` 没有安装器 → 不改 PATH，依赖第二层
（应用内已可用）。详见姊妹篇 4.4.2。

---

## 4. 方案

四层，与 CodeGraph 同构。**只写差异**。

### 4.1 第一层：把 CLI 放进安装包

`vendor/mnemon/` 放两个 tgz，`scripts/prepare-mnemon.mjs` 按主机解压到
`build/mnemon/host/`，再由 `build.extraResources` 静态拷贝：

```jsonc
{
  "extraResources": [
    { "from": "build/codegraph/host", "to": "codegraph" },
    { "from": "build/mnemon/host",    "to": "mnemon" },        // 本次新增
    { "from": "build/dream-skin-default.json", "to": "dream-skin-default.json" }
  ]
}
```

**为什么同样不用 yarn 依赖**：平台包声明了 `os` / `cpu`。macOS universal 构建里，
被 `cpu` 过滤掉的那个切片会拿不到包，两切片内容不一致，`@electron/universal` 合并失败。
**与 CodeGraph 是同一个原因**，见姊妹篇 4.1。

`prepare-mnemon.mjs` 相对 `prepare-codegraph.mjs` 的差异：

| 项 | CodeGraph | Mnemon |
|---|---|---|
| 期望许可证 | MIT | **Apache-2.0** |
| 期望包名 | `@colbymchenry/codegraph-<platform>` | **`@mnemon-dev/mnemon`**（无后缀） |
| 版本校验 | — | **版本后缀必须等于 target key** |
| 可执行位 | `chmod 0o755` | 同（仅 POSIX） |
| `--check` | 有一个已知 bug | **不复制该 bug**，见下 |

> **关于 `--check`**：`prepare-codegraph.mjs` 的 `--check` 分支用
> `existsSync(existing.entryPoint)` 判断，而 `entryPoint` 是**相对仓库根**的路径；
> 从 workspace 目录调用时会误报「未准备」。`prepare-mnemon.mjs` 改为拼接
> `join(outputRoot, target.executables[0])` 做探测，从仓库根或 workspace 都能正确判断。

打包脚本前置换成一个链条（codegraph 在前、mnemon 在后；两者无顺序依赖）：

```
node ../scripts/prepare-codegraph.mjs && node ../scripts/prepare-mnemon.mjs && electron-builder ...
```

### 4.2 第二层：让应用内部能用

`src/desktop-runtime-environment.ts` 新增两个导出。为了不复制 CodeGraph 的实现，
把公共部分抽成 `installBundledCliRuntime()` 与 `bundleSupportsHost()`：

```ts
export function desktopMnemonBundleSupportsHost(bundleDir, platform, arch): boolean
export function installDesktopMnemonRuntime(options): DesktopMnemonRuntimeInstallation
```

`src/main.ts` 的接线与 CodeGraph 并列：先做主机架构校验（`os`/`cpu` 不匹配就跳过，
而不是发布一个跑不起来的命令），再前置 PATH，并用 `generation.own()` 注册可逆释放：

```ts
const mnemonBundleDir = join(process.resourcesPath, 'mnemon')
const mnemonRuntime = desktopMnemonBundleSupportsHost(mnemonBundleDir, process.platform, process.arch)
  ? installDesktopMnemonRuntime({ platform: process.platform, bundleDir: mnemonBundleDir, environment: process.env })
  : undefined
const releaseMnemonRuntime = generation.own(() => { mnemonRuntime?.dispose() })
```

**失败只记日志、绝不阻断启动**——与 CodeGraph 相同。

### 4.3 第三层：macOS 首次启动写 `~/.zshrc`

见 3.1。核心是**共用 CodeGraph 已有的块与目录**。

### 4.4 第四层：Windows NSIS 安装时写注册表

见 3.2。核心是**镜像分支 + 反序卸载 + 备份只写一次**。

---

## 5. 改动清单

| # | 文件 | 改什么 | 平台 | 必须吗 |
|---|------|--------|------|--------|
| 1 | `vendor/mnemon/*.tgz` | 新增（mac 6.0 MB + win 5.4 MB） | 两者 | ✅ |
| 2 | `.gitignore` | 忽略 `dsh-plugin-desktop{,-beta}/build/mnemon/` | 两者 | ✅ |
| 3 | `scripts/prepare-mnemon.mjs` | 新增：解压 + 断言 Apache-2.0 + `chmod 0o755` | 两者 | ✅ |
| 4 | `*/package.json` 的 `build` | `extraResources` 加一项、`mac.x64ArchFiles` 加 `Resources/mnemon/**` | 两者 | ✅ |
| 5 | `*/package.json` 的 `scripts` | 5 个打包脚本前置 prepare | 两者 | ✅ |
| 6 | `src/desktop-cli-shell.ts` | 由 `desktop-codegraph-shell.ts` 泛化为多启动器 | mac | ✅ |
| 7 | `src/desktop-runtime-environment.ts` | 新增 `installDesktopMnemonRuntime()` 等 | 两者 | ✅ |
| 8 | `src/main.ts` | 调用上述两者 | 两者 | ✅ |
| 9 | `build/installer.nsh` | 加 mnemon 的 `customInstall` / `customUnInstall` 分支 | win | ✅ |
| 10 | `*/package.json` 的 `dependencies` | `billion-context` / `dsh-mnemon` / `dsh-rewind-plugin` | 两者 | ✅ |
| 11 | `src/product-identity.ts` | `DEFAULT_PROFILE_PLUGIN_BUNDLES` 加三个名字 | 两者 | ✅ |
| 12 | `tests/*.spec.ts` | package / installer-nsh / cli-shell / runtime-environment / profile | 两者 | ✅ |

> **两个变体的 `src/` 必须逐字节一致**，改完要跑 `node scripts/verify-desktop-variants.mjs`。
> **NSIS 脚本建议先手工测试**：在一台可丢弃的 Windows 机器或干净用户账户上验证 PATH 前后一致。

---

## 6. 体积

| 项目 | macOS | Windows |
|------|-------|---------|
| 平台包解压 | **15 MB** | **13 MB** |
| 平台包 tgz | **6.0 MB**（6,298,831 字节） | **5.4 MB**（5,699,948 字节） |
| 安装包预估增量 | 约 **+2 ~ 6 MB** | 约 **+2 ~ 5.5 MB** |
| 对比：CodeGraph | +54 MB（DMG 实测） | +51 MB（tgz） |

**压缩比是实测的**，不是沿用 CodeGraph 的 0.322：

```
gzip -9 -c build/mnemon/host/bin/mnemon | wc -c   →  6,153,199 字节
压缩比 = 6,153,199 / 15,519,186 = 0.396
```

与归档里的 6,298,831 字节（含 package.json / LICENSE / README + tar 开销）吻合。

> **注意**：mnemon 的压缩比 0.396 **高于** CodeGraph 的 0.322。Go 静态二进制的
> 可压缩性不如 JS 文本，所以不能直接把 CodeGraph 的比值搬过来用。

**结论：mnemon 的 6 MB 相对于 CodeGraph 的 54 MB 可以忽略。** 两者合计仍是
CodeGraph 主导。

---

## 7. 风险与坑

**与 CodeGraph 共有的风险**（解压丢可执行位、universal 合并、写坏 `~/.zshrc`、
写坏注册表 PATH、Gatekeeper 隔离属性、应用移动位置、便携版无安装器、上游版本不匹配）
见姊妹篇第 7 节，此处不重复。mnemon 特有的：

| 风险 | 平台 | 后果 | 处理 |
|------|------|------|------|
| **Windows 上误用 `.cmd` 后缀** ✅ 已解决 | win | 永远找不到启动器，功能静默失效（只记日志） | 启动器名由调用方传入；测试里有一条真实断言 `mnemon.exe` |
| **给 `~/.zshrc` 追加第二个 PATH 块** ✅ 已解决 | mac | 用户 profile 多出一段重复内容 + 多余备份 | 标记块文本保持 `codegraph`、共用 `~/.dsh/bin`；测试断言「先构图再加 mnemon 后块逐字节不变」 |
| **`PathBackup` 被第二个分支覆盖** ✅ 已解决 | win | 备份存的是已改过的 PATH，回滚回不到原始状态 | 第二个分支先 `ReadRegStr` 确认备份为空才写 |
| **卸载顺序写反** ✅ 已解决 | win | 两个条目都留在 PATH 里 | 反序剥离；测试断言「卸载分支里 mnemon 出现在 codegraph 之前」 |
| **平台包 `name`/`version` 约定与 CodeGraph 相反** | 两者 | 校验错字段会接受不相干的归档 | `prepare-mnemon.mjs` 两个字段都校验 |
| **许可证是 Apache-2.0 而非 MIT** | 两者 | 若沿用 CodeGraph 的断言会直接失败 | 常量改为 `Apache-2.0`；它在 `ALLOWED_LICENSES` 里 |
| **`--check` 的相对路径 bug 被复制** ✅ 已避免 | 两者 | CI 里误报「未准备」 | 用绝对路径探测入口 |
| **用户已装全局 mnemon**（npm / brew） | mac | 内置版会优先命中（prepend），版本可能与全局那份不同 | **属预期行为**；想反过来就把 PATH 那行改成 append |

---

## 8. 验证方法

### 8.1 两平台通用（本地可跑）

```bash
# ① 归档可追溯：sha256 与脚本里 pin 的值一致
node scripts/prepare-mnemon.mjs --desktop dsh-plugin-desktop --target darwin-arm64 --check

# ② 幂等：连跑两次，第二次输出「reusing」
node scripts/prepare-mnemon.mjs --desktop dsh-plugin-desktop --target darwin-arm64
node scripts/prepare-mnemon.mjs --desktop dsh-plugin-desktop --target darwin-arm64

# ③ 归档内容与许可证
tar -tzf vendor/mnemon/mnemon-darwin-arm64-0.2.9.tgz
#   package/LICENSE  package/bin/mnemon  package/package.json  package/README.md

# ④ 两个内置 CLI 都进了 extraResources，且 universal 声明齐备
node -e "
const b=require('./dsh-plugin-desktop/package.json').build;
console.log(b.extraResources.map(e=>e.to).join(', '));
console.log(b.mac.x64ArchFiles.includes('Resources/codegraph/**'),
            b.mac.x64ArchFiles.includes('Resources/mnemon/**'));
"

# ⑤ 两个变体的打包配置与源文件一致
corepack yarn check:desktop-variants    # → 184 shared source files are aligned
corepack yarn check:layout
```

### 8.2 macOS

```bash
# ① 包内二进制能独立跑，且真的不需要 Node（清空 PATH）
env -i ./dsh-plugin-desktop/build/mnemon/host/bin/mnemon --version
#   → mnemon version 0.2.9

# ② 动态依赖只有系统库
otool -L dsh-plugin-desktop/build/mnemon/host/bin/mnemon

# ③ 首次启动后，shim 出现且与 codegraph 共用一个目录
ls -l ~/.dsh/bin
#   codegraph
#   mnemon                     ← 新增

# ④ 标记块只有一个，且内容未变（关键回归）
grep -c 'dsh-desktop codegraph' ~/.zshrc     # → 2（一开一闭，仍是原来的那一个块）

# ⑤ 新开终端窗口
zsh -i -c 'which mnemon && mnemon --version'
#   /Users/jimmy/.dsh/bin/mnemon
#   mnemon version 0.2.9
```

### 8.3 Windows（在原生 Windows 主机上）

```powershell
# ① 包内二进制
& "$env:LOCALAPPDATA\Programs\DSH Desktop Beta\resources\mnemon\bin\mnemon.exe" --version
#   → mnemon version 0.2.9

# ② 安装后 PATH 已写入（新开窗口，让 WM_SETTINGCHANGE 生效）
$env:Path -split ';' | Select-String mnemon

# ③ cmd.exe 里也能用（证明写的是注册表而不是只写 PowerShell profile）
cmd /c "where mnemon"

# ④ 两条目都在，且顺序为 codegraph 在前、mnemon 在后
(Get-ItemProperty HKCU:\Environment).Path

# ⑤ 备份里存的是**最初**的 PATH，不含我们追加的任何一条
(Get-ItemProperty 'HKCU:\Software\DSH Desktop Beta').PathBackup

# ⑥ 卸载后 PATH 恢复，两条都消失，其余条目与安装前逐条一致
```

> **注册表的实际效果待原生 Windows 主机验证。** 本机是 macOS，`package-win.ts` 又有
> 「必须在原生 Windows 主机上构建」的硬断言，所以本地能验证的只有
> `tests/installer-nsh.spec.ts` 的脚本结构断言。**PATH 是否真的写进去，需要人工装一次
> 并开新终端确认。**

### 8.4 应用内（不需要终端）

打开 DSH Desktop，进入 mnemon 插件面板，确认「CLI 版本 / 可执行文件路径」显示的是
包内路径（`.../Resources/mnemon/bin/mnemon`），而不是空白或「未找到 CLI」。
这条走的是 2.4 描述的 PATH 发现路径，**不需要任何插件配置**。

---

## 9. 回滚

与 CodeGraph 同构，且**互不影响**——只回滚 mnemon 不需要动 CodeGraph：

| 层次 | 回滚动作 |
|---|---|
| 打包 | `package.json` 去掉 `extraResources` 里 mnemon 那项、`x64ArchFiles` 去掉 `Resources/mnemon/**`、脚本去掉 prepare 前缀 |
| prepare | 删 `scripts/prepare-mnemon.mjs`、删 `vendor/mnemon/`、`.gitignore` 去掉两行 |
| 运行时 | `main.ts` 去掉 mnemon 的 install/release 接线 |
| macOS shell | shim 文件由 `installDesktopCliShell()` 每次启动重写；卸载时不主动删（与 codegraph 同为持久产物）。**不要手工删 `~/.zshrc` 的块**——它正被 codegraph 使用 |
| Windows PATH | **不要手改注册表**。正确做法：在干净的 Windows 机器上装一次带 mnemon 的版本、再卸载，观察 PATH 是否恢复。若需手工修复，用 `HKCU\Software\${PRODUCT_NAME}\PathBackup` 的值还原 |

> **macOS 回滚的一个陷阱**：因为 mnemon 与 codegraph **共用**那个标记块，
> 删掉块会让 codegraph 也失效。如果只想让 mnemon 消失，删 `~/.dsh/bin/mnemon`
> 这一个 shim 文件即可（下次启动会因应用内 PATH 前置仍然工作，但终端里不再解析）。

---

## 10. 实施记录

### 已完成

| 步骤 | 结果 |
|------|------|
| vendor 两个平台 tgz | `vendor/mnemon/`，mac 6.0 MB + win 5.4 MB，sha256 已 pin |
| `scripts/prepare-mnemon.mjs` | 解压、断言 Apache-2.0、名字/版本后缀双校验、`chmod 0o755`、幂等；`--check` 修掉了 CodeGraph 版本的相对路径 bug |
| `.gitignore` | 忽略 `dsh-plugin-desktop{,-beta}/build/mnemon/` |
| `package.json` | `extraResources` + `mac.x64ArchFiles` + 5 个打包脚本前置 prepare |
| `desktop-cli-shell.ts` | 由 `desktop-codegraph-shell.ts` 泛化为多启动器；**标记块文本与目录名保持不变** |
| `installDesktopMnemonRuntime()` | 与 CodeGraph 共享 `installBundledCliRuntime()` |
| `desktopMnemonBundleSupportsHost()` | 与 CodeGraph 共享 `bundleSupportsHost()` |
| `main.ts` 接线 | Host PATH 前置 + shell 集成；失败不阻断启动 |
| `installer.nsh` | 镜像的 mnemon 分支，反序卸载，备份只写一次 |
| stable 同步 | 184 个共享源文件对齐 |
| 测试 | 新增/改写：shell 15、runtime 27、installer-nsh 7；**stable 1399 通过 / beta 1385 通过** |
| 三个内置插件 | `billion-context` `dsh-mnemon` `dsh-rewind-plugin` 进 dependencies + `DEFAULT_PROFILE_PLUGIN_BUNDLES` |

### 门禁实测

```
corepack yarn check:layout              → verify-layout: dual Desktop workspaces ... consistent
corepack yarn check:desktop-variants    → 184 shared source files are aligned
node scripts/preinstall-plugins.mjs list → 默认预装清单：10 个插件，三项两变体均 ✓/✓
verify:licenses                          → 941 production packages checked
verify:closure                           → 247 first-party nodes form a closed reachable runtime graph
typecheck（两变体）                       → exit 0
```

### 与计划的偏差

| 计划 | 实际 | 原因 |
|------|------|------|
| Task-002 与 Task-003 分开执行（beta 先、stable 后） | **合并为一次操作** | `preinstall-plugins.mjs` 的 `applyEdits()` 内部就循环 `VARIANTS`，一次 `add` 调用同时写两个变体的 4 个文件，没有 `--variant` 参数 |
| `billion-context` 用 0.1.135 | **改用 0.1.131** | `corepack yarn install` 报 `YN0016: ... All versions satisfying "0.1.135" are quarantined`——Yarn 4.18 的 `npmMinimalAgeGate` 默认 1440 分钟（24h）供应链观察期，0.1.135 只发布 4.2 小时。0.1.131（39.9 小时）是能通过门禁的最新版本。**已用户决策确认**，未放宽门禁 |
| 打包脚本前缀 mnemon 在前、codegraph 在后 | **codegraph 在前** | 追加在既有前缀之后，`git diff` 只显示新增片段，不重写 CodeGraph 既有顺序，更易复核；两者无顺序依赖 |
| 用 `${label}.cmd` 统一推导 Windows 启动器 | **改为调用方传入** | 见 2.3，mnemon 是 `.exe` 而非 `.cmd`；测试抓到了这个真实缺陷 |
| 顺带重新生成 `THIRD_PARTY_NOTICES.md` | **未纳入本次改动** | 该文件是可选产物（`verify:notices` 不在 `check` 门禁里），且**当前已提交的版本本就不含任何内置插件**（`dsh-better-sidebar`、`@hyzyn/dsh-codegraph` 同样不在列表里）。本机 `supportedArchitectures.os=[current]` 会让重新生成**删掉 8 行仅 Windows 的平台包**，属宿主相关的噪声，与本次任务无关。已回滚 |

### 两个值得记住的细节

**① 不要假设两个 CLI 的可执行文件命名一致。** 见 2.3。这是本次唯一的真实缺陷，
而且是**测试**发现的，不是代码审查——只因为照着 CodeGraph 的用例补了一条 Windows 用例。

**② 泛化抽象时要保护「已安装用户的既有状态」。** 见 3.1。把 `codegraph` 的块名
「顺手改得更通用」是个很自然的冲动，但代价是每个老用户升级后 profile 里多出一个块、
一个备份，以及一行重复的 PATH 导出。**共用目录 + 保持块名**让这次变更对老用户完全透明。

---

## 附 A：为什么不用 `npm i -g @mnemon-dev/mnemon`

与 CodeGraph 的理由相同，见姊妹篇附 A。补充 mnemon 特有的一点：`mnemon` CLI 有
`update` 子命令（`mnemon update`，更新 npm 管理的 CLI）。如果用户此前用 npm 全局装过，
内置版会因为 PATH prepend 而优先命中，`mnemon update` 会去更新**全局那份**而不是内置那份，
造成版本困惑。这是已知且已接受的取舍；插件面板显示的「可执行文件路径」可以帮助用户确认
当前命中哪一份。

---

## 附 B：为什么 Windows 不照抄 macOS 写 shell 配置

与 CodeGraph 相同，见姊妹篇附 B。核心：Windows 的「shell 配置」是分家的——PowerShell
用 `$PROFILE`，cmd.exe 用注册表 PATH。只写 PowerShell profile 的话，cmd.exe 里依然找不到
`mnemon`。**写注册表 PATH 才是 Windows 的正解**，而且 NSIS 正好有安装钩子可用。
