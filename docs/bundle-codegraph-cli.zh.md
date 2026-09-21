# 把 codegraph CLI 随 DSH Desktop 一起离线安装（方案 · macOS + Windows）

> **状态：macOS 部分已实施并验证通过（2026-09-18）；Windows 部分已实施——NSIS 安装器写用户 PATH，待原生 Windows 主机验证实际效果。**
>
> 目标读者：不熟悉构建流程的使用者。所有结论都标注了查证来源。
>
> 实施结果与实际偏差见文末「实施记录」。

---

## 0. 结论速览

| 问题 | 结论 |
|------|------|
| 能离线预装吗？ | **能。** 平台包自带 Node 运行时，离线机器**连 Node 都不用装** |
| macOS DMG 会大多少？ | **约 +55 ~ 89 MB**（338 MB → 约 **400 ~ 430 MB**） |
| Windows 安装包会大多少？ | **约 +51 ~ 82 MB** |
| 离线机器要先装 Node 吗？ | **不需要**，见 2.2 |
| macOS 的 PATH 怎么做？ | **首次启动写 `~/.zshrc`**（DMG 没有安装钩子，只能这样） |
| Windows 的 PATH 怎么做？ | **NSIS 安装时写注册表**（Windows 安装器**有**安装钩子，比 macOS 更正规） |
| 两平台机制一样吗？ | **不一样**，见第 3 节。这是本方案最容易搞错的地方 |
| **macOS 实测结果** | DMG **338 → 392 MB**（+54 MB），`codegraph init` 在新终端可用 |

---

## 1. 需求

1. 离线机器上**只装 DSH Desktop**，应用内的 codegraph 功能可用
2. 同一台机器的 **Terminal** 里也能敲 `codegraph init`、`codegraph sync` 等命令
3. 全程**完全离线**，机器上可能连 Node.js 都没有
4. **macOS 与 Windows 都要覆盖**

---

## 2. 查证到的事实

### 2.1 CLI 是「薄壳 + 平台二进制」

```
@colbymchenry/codegraph@1.6.0            (MIT)
  bin: { codegraph: "npm-shim.js" }      ← 只是个启动器
  optionalDependencies（按平台自动装一个）:
    @colbymchenry/codegraph-darwin-arm64   278 MB 解压 / 55 MB tgz
    @colbymchenry/codegraph-darwin-x64     292 MB 解压
    @colbymchenry/codegraph-win32-x64      261 MB 解压 / 51 MB tgz
    @colbymchenry/codegraph-win32-arm64    250 MB 解压
    @colbymchenry/codegraph-linux-{arm64,x64}
```

**两个平台的内容结构不一样：**

| | macOS (`darwin-arm64`) | Windows (`win32-x64`) |
|---|---|---|
| 自带运行时 | `node`（115 MB，Mach-O） | `node.exe` |
| 入口 | `bin/codegraph`（**`#!/bin/sh` 脚本**） | `bin/codegraph.cmd`（**批处理**） |
| 本体 | `lib/dist`（73 MB） | `lib/dist/bin/codegraph.js` |
| 其它 | `lib/node_modules` 56 MB、`lib/kernel` 34 MB | 同构 |

### 2.2 它自带 Node —— 这正是离线可行的关键

macOS 的 `bin/codegraph` 全部内容就是：

```sh
#!/bin/sh
...
DIR="$(cd "$(dirname "$SELF")/.." && pwd)"
CODEGRAPH_HOST_PPID="${CODEGRAPH_HOST_PPID:-$PPID}"
export CODEGRAPH_HOST_PPID
exec "$DIR/node" --liftoff-only --disable-warning=ExperimentalWarning \
     "$DIR/lib/dist/bin/codegraph.js" "$@"
```

它 **exec 自己目录里的 `node`**，不看系统的 Node。上游注释写明原因：需要 Node 24 的 `node:sqlite`。

> **结论**：离线机器**不需要预装 Node.js**。这也是为什么这 278 MB「压不掉」——它是个自包含运行时。

### 2.3 离线可用（不依赖网络）

`npm-shim.js` 的**正常路径是纯本地解析**：

```js
if (isWindows) {
  var nodeExe = require.resolve(pkg + '/node.exe');
  var entry = require.resolve(pkg + '/lib/dist/bin/codegraph.js');
  return { command: nodeExe, args: liftoff(entry) };
}
return { command: require.resolve(pkg + '/bin/codegraph'), args: process.argv.slice(2) };
```

联网下载只是「镜像站没同步平台包」时的**自愈兜底**，而且可以关掉：

| 环境变量 | 作用 |
|----------|------|
| `CODEGRAPH_NO_DOWNLOAD=1` | 彻底禁止网络兜底（空气隔离环境建议加上） |
| `CODEGRAPH_INSTALL_DIR` | 兜底下载的缓存目录，默认 `~/.codegraph` |

> **结论**：只要平台包在本地，零网络可用。

### 2.4 插件的 `command` 不会被覆盖

`@hyzyn/dsh-codegraph` 会维护 `~/.dsh/cordis.patch.yml` 里托管 MCP 行，但源码注释明确：

```
// 复用 MCP 卡片区块里的行：只对齐 cwd，其余字段（含 disabled）保持用户配置。
```

它只改 `cwd` 和 `disabled`。**`command` 是用户自有字段，升级不会被冲掉。**

### 2.5 Windows 的 `.cmd` 陷阱 —— 插件已经自己处理了

上游 `npm-shim.js` 的注释：

```
Modern Node refuses to spawn the bundle's .cmd directly
(EINVAL, the CVE-2024-27980 hardening on Node 24)
```

而 `@hyzyn/dsh-codegraph` 的源码里已经专门解决了这件事：

```
Windows 上的 CLI 调用
npm / pnpm 全局安装的 CLI 在 Windows 上只有 `.cmd` / `.ps1` / 无扩展名的
shim，没有真正的 `.exe`（codegraph 就是如此）。而 `execFile` 默认
`shell: false`…… 于是 Windows 上每一次调用都固定失败成 `spawn codegraph ENOENT`。
解法是把命令行交给 `%COMSPEC% /d /s /c`，由 cmd.exe 按 PATHEXT 解析出 shim。
```

> **结论**：只要 `codegraph` 在 PATH 里，Windows 侧插件的调用**不用我们额外处理**。

### 2.6 仓库已有现成的机制

| 机制 | 位置 | 用途 |
|------|------|------|
| Host PATH 前置（可逆） | `src/desktop-runtime-environment.ts` | 已用于 pnpm；Windows 分支已有 `set "PATH=%DSH_RUNTIME_NODE_BIN%;%PATH%"` |
| 调用点 | `src/main.ts:679`（pnpm）、`src/main.ts:1313`（dsh） | 改 `process.env.PATH`，Host 子进程继承 |
| **NSIS 安装钩子** | `build/installer.nsh` + `package.json` 的 `"include": "installer.nsh"` | **已存在**，目前只用来处理升级时关旧进程 |

### 2.7 构建目标是 universal

`scripts/package-mac.ts:135` 传 `--universal`；`verify-mac-smoke.ts:117-118` 用 `lipo` 校验主可执行文件同时含 `x86_64` 与 `arm64`。

但逐个文件的原生校验用的是**显式白名单** `MACOS_UNIVERSAL_NATIVE_ENTRIES`（`scripts/mac-universal.ts:9`），里面是 sharp / koffi / ripgrep 等已知条目。**codegraph 不在其中，不会被 `lipo` 检查。**

Windows 侧：`win.target = [{ target: "nsis", arch: ["x64"] }]`，且 `scripts/package-win.ts` 有**「必须在原生 Windows 主机上构建」的硬断言**。

---

## 3. 两个平台的机制完全不同

> **这是本方案最关键的一节。**

| | **macOS（DMG）** | **Windows（NSIS）** |
|---|---|---|
| 分发形式 | `.dmg` 拖拽 | `Setup.exe` 安装向导 |
| **有安装钩子吗** | **没有** —— 拖拽就是拷贝，之外什么都不会发生 | **有** —— NSIS 支持 `customInstall` / `customUnInstall` |
| PATH 写在哪 | 用户的 **`~/.zshrc`** | **`HKCU\Environment`** 的 `PATH`（注册表） |
| 何时写 | **应用首次启动时** | **安装时**（卸载时移除） |
| 需要管理员权限吗 | 不需要 | 不需要（`perMachine: false`，用户级安装 → HKCU） |
| 生效时机 | 需**新开终端窗口** | 新开的进程即可见（广播 `WM_SETTINGCHANGE` 后） |
| 便携版怎么办 | 同 DMG（首次启动写） | `dist:win-portable` **没有安装器** → 退回首次启动写 |

**为什么 Windows 不该照抄 macOS 的做法**：Windows 的「shell 配置」是分家的——PowerShell 用 `$PROFILE`，cmd.exe 用注册表 PATH。只写 PowerShell profile 的话，cmd.exe 里依然找不到 `codegraph`。**写注册表 PATH 才是 Windows 的正解**，而且它正好有安装钩子可用。

---

## 4. 方案

分三层，互相独立。

### 4.1 第一层：把 CLI 放进安装包

用 electron-builder 的 `extraResources`，**不用** yarn 依赖。

**为什么不用 yarn 依赖**（像 edan-spec 那样）：

- 平台包声明了 `"cpu": ["arm64"]` / `["x64"]`。**macOS universal 构建的 x64 切片可能被 electron-builder 跳过它**，导致两个切片内容不一致，`@electron/universal` 合并时报「文件有差异但不是 Mach-O」而失败
- `extraResources` 是**静态拷贝**，两个切片拿到完全相同的内容 → 合并安全
- 也避免 261~278 MB 进入 yarn 依赖树和许可证审计

**来源放哪**：仿照 `vendor/edan-spec/` 的既有约定，把 tgz 放进 `vendor/codegraph/`，打包前解压。这个动作写成 `scripts/prepare-codegraph.mjs`，仿照现有的 `scripts/prepare-agents-anywhere-release.mjs`。

**关键简化**：因为 `package-win.ts` **要求原生 Windows 主机**，所以「构建主机 == 目标平台」恒成立。于是可以让 prepare 脚本按**当前主机**只准备一个平台，用单条 `extraResources`：

```jsonc
// dsh-plugin-desktop/package.json 的 build
{
  "extraResources": [
    { "from": "build/codegraph/host", "to": "codegraph" }
    // 落地：Contents/Resources/codegraph/   或   resources/codegraph/
  ]
}
```

prepare 脚本按 `process.platform` 选 `darwin-arm64` 或 `win32-x64` 解压到 `build/codegraph/host/`。

> 如果以后要跨平台构建，改用平台作用域配置（`mac.extraResources` / `win.extraResources`），并在落地路径里带上平台与架构。

### 4.2 第二层：让应用内部能用（不改任何 YAML）

新增 `installDesktopCodegraphRuntime()`，在 `src/main.ts` 里紧跟 pnpm 那个调用之后执行，把

- macOS：`<app>/Contents/Resources/codegraph/bin`
- Windows：`<app>/resources/codegraph/bin`

**前置**到 `process.env.PATH`，并设置 `CODEGRAPH_NO_DOWNLOAD=1`（杜绝离线环境下的无谓等待）。

一次解决所有消费者：

| 消费者 | 为什么自动生效 |
|--------|----------------|
| `@deepseek-ai/dsh-mcp-client` 的 MCP 行 | `command: codegraph` 靠 PATH 解析 |
| `@hyzyn/dsh-codegraph` 自己的 CLI 调用 | 默认值就是 `codegraph`；Windows 的 `.cmd` 问题它内部已解决（2.5） |
| 用户以后手写的任何 codegraph 配置 | 同样走 PATH |

保留 `dispose()` 以符合仓库「每个副作用都可逆」的既有约定。

> **替代方案**：只把 MCP 行的 `command` 改成绝对路径。也能用，但路径写死在 YAML 里，应用一升级/改名就失效，且覆盖不到插件自身的调用。**不推荐。**

### 4.3 macOS：首次启动写 `~/.zshrc`

**4.3.1 shim**

首次启动把下面这个脚本写到 `~/.dsh/bin/codegraph`（`0o755`）：

```sh
#!/bin/sh
# 由 DSH Desktop Evo 生成，请勿手工编辑。
# 应用升级或移动位置后会自动重写。
exec "/Applications/DSH Desktop Evo.app/Contents/Resources/codegraph/bin/codegraph" "$@"
```

放在 `~/.dsh/bin/` 的理由：应用自己的目录，**不与 Homebrew / MacPorts / nvm 抢位置**；和 `~/.dsh/` 下其它状态一致，卸载时好清理。

> `bin/codegraph` 内部用 `dirname "$SELF"` 反推 `$DIR`，所以 shim 必须是**真实文件或能被正确解析的软链**。写脚本比软链更直观，也能带上注释。

**4.3.2 写 `~/.zshrc`（首次启动时）**

按 `$SHELL` 选目标文件，默认 zsh：

| `$SHELL` | 目标文件 | 说明 |
|----------|---------|------|
| `/bin/zsh` | `~/.zshrc` | macOS 默认（Catalina 起）。Terminal.app 开的是**交互式登录 shell**，会读它 |
| `/bin/bash` | `~/.bash_profile` | 登录 shell 读这个 |
| 其它 / 为空 | `~/.zshrc` | 保守回落 |

写入内容（带标记、幂等、可逆）：

```sh
# >>> dsh-desktop codegraph >>>
export PATH="$HOME/.dsh/bin:$PATH"
# <<< dsh-desktop codegraph <<<
```

**必须遵守的几条**（否则会毁用户配置）：

1. **先备份**：写之前把原文件复制成 `~/.zshrc.dsh-backup-<时间戳>`
2. **幂等**：标记块已存在就一个字节都不动（升级重跑安全）
3. **只在文件末尾追加**，不解析、不重排用户内容
4. **保留原权限**；文件不存在则新建（`0o644`）
5. **原子写**：写临时文件再 `rename`，避免中途失败留下半个文件
6. **可逆**：设置里给一个「移除 PATH 配置」的动作，按标记精确删除那三行
7. 提示用户**需要新开终端窗口**才生效

**不做的事**：不去猜用户的 oh-my-zsh / zinit / starship 配置，不调用 `source`，不改 `PATH` 以外的任何东西。

**4.3.3 命名：就叫 `codegraph`，不加后缀**

官方版**不内置** codegraph，所以 `~/.dsh/bin/codegraph` 这个名字不存在竞争，**不需要 `codegraph-custom` 之类的区分名**。

但有一个真实情况值得知道：本机已经通过 nvm 全局装过一份 codegraph（`/Users/jimmy/.nvm/versions/node/v22.23.2/bin/codegraph`，v1.6.0）。

因为我们的写法是 **prepend**：

```sh
export PATH="$HOME/.dsh/bin:$PATH"     # 注意是 :$PATH 在后
```

所以**内置版会优先命中**。带来的影响：

- 内置版版本随安装包走，可能与全局那份不同步
- 如果哪天想反过来（让全局那份优先），把这一行改成 append（`export PATH="$PATH:$HOME/.dsh/bin"`）即可
- 想确认当前调用的是哪一个：`which codegraph` 看路径，`codegraph --version` 看版本

这不会破坏任何东西，只是需要知道「到底哪个 codegraph 在被调用」。**无需在方案里做额外处理。**

### 4.4 Windows：NSIS 安装时写注册表

**4.4.1 安装时写 PATH（已实施）**

仓库已有 `build/installer.nsh` 且 `package.json` 里已配置 `"include": "installer.nsh"`，
新增的两个宏就放在这个文件里（两个变体各一份，逐字节相同；产品名走 electron-builder
的 `${PRODUCT_NAME}`，不硬编码）。要点：

```nsis
!macro customInstall
  ${if} ${FileExists} "$INSTDIR\resources\codegraph\bin\codegraph.cmd"
    ReadRegStr $0 HKCU "Environment" "Path"
    ${StrContains} $1 "resources\codegraph\bin" "$0"          ; 去重
    ${if} $1 == ""
      WriteRegExpandStr HKCU "Software\${PRODUCT_NAME}" "PathBackup" "$0"   ; 备份
      StrCpy $0 "$0;$INSTDIR\resources\codegraph\bin"          ; 追加到末尾
      WriteRegExpandStr HKCU "Environment" "Path" "$0"
      SendMessage 0xFFFF 0x001A 0 "STR:Environment" /TIMEOUT=5000   ; 广播
    ${endIf}
  ${endIf}
!macroend

!macro customUnInstall
  ; 条目仍在 PATH 末尾时才移除，否则原样不动
!macroend
```

**必须遵守的几条**（Windows 注册表 PATH 比 `.zshrc` 更危险）——逐条对照实际实现：

| # | 要求 | 实现 |
|---|------|------|
| 1 | 只动 `HKCU\Environment` 的 `PATH`，绝不碰 `HKLM` | ✅ 两处写入都是 `HKCU` |
| 2 | 读出来再写，检查是否已包含，只做追加 | ✅ `ReadRegStr` + `${StrContains}` |
| 3 | 备份原值，便于恢复 | ✅ 写 `HKCU\Software\${PRODUCT_NAME}\PathBackup`，且因去重在前、只在真正改动 PATH 时写一次 |
| 4 | 不要用 `setx` | ✅ 没用；测试里有一条断言专门禁止它出现 |
| 5 | 不要展开 `%VAR%`：用 `REG_EXPAND_SZ` 读写 | ⚠️ **只做到一半**，见下 |
| 6 | 卸载时精确移除，其余原样保留 | ✅ 但比「精确」更保守：只在条目仍是最后一个时才动 |
| 7 | 注意与 electron-builder 已有的 `Var` 声明冲突 | ✅ 只用 `$0`–`$5` 内建寄存器，没有新增 `Var` |

> **第 5 条为什么只做到一半。** 写入用 `WriteRegExpandStr`，`PATH` 保持
> `REG_EXPAND_SZ`，类型是对的。但 NSIS 的 **`ReadRegStr` 对 `REG_EXPAND_SZ` 会自动
> 展开 `%VAR%`**，纯 NSIS 关不掉（要读原始值只能用 `System::Call` 直接调
> `RegQueryValueEx`，复杂度和出错面都高得多，换来的只是保留写法）。
>
> **后果**：用户 `PATH` 里原本写成 `%USERPROFILE%\...` 的条目会变成 `C:\Users\xxx\...`。
> **所有路径仍然有效，功能完全不变**，只是变量写法被固化。这是已知且已接受的取舍。

**去重是必需的**：升级安装会在同一目录上再跑一遍 `customInstall`，不查重就会每升级
追加一条。

**卸载为什么只处理"末尾"**：安装时是追加到末尾的。用户如果自己重排过 `PATH` 就什么都
不做——宁可留下一个指向已删目录的条目（Windows 查找时会跳过），也不冒改坏 `PATH` 的风险。

**4.4.2 便携版**

`dist:win-portable` 没有安装器 → 退回**首次启动写**。但 Windows 没有 `.zshrc` 这种统一入口，写 `$PROFILE` 只覆盖 PowerShell。务实做法：便携版**不改 PATH**，只在文档里给出一次性的 `setx` 或临时 `set PATH=...` 说明，并依赖第二层（应用内已可用）。

**4.4.3 应用内的 shim 不需要**

第二层已经把 `resources\codegraph\bin` 前置到 Host 的 PATH，而 `bin\codegraph.cmd` 就在那里。插件通过 `cmd.exe` 解析 `.cmd`，可直接命中。**不需要额外写 shim 文件。**

---

## 5. 改动清单

| # | 文件 | 改什么 | 平台 | 必须吗 |
|---|------|--------|------|--------|
| 1 | `vendor/codegraph/*.tgz` | 新增（mac 55 MB + win 51 MB） | 两者 | ✅ |
| 2 | `.gitignore` | 忽略 `dsh-plugin-desktop/build/codegraph/` | 两者 | ✅ |
| 3 | `scripts/prepare-codegraph.mjs` | 新增：按主机解压 + 断言 MIT + `chmod 0o755`（POSIX） | 两者 | ✅ |
| 4 | `dsh-plugin-desktop/package.json` 的 `build` | 加 `extraResources` | 两者 | ✅ |
| 5 | `dsh-plugin-desktop/package.json` 的 `scripts` | `dist:mac-smoke` / `dist:win` 前置 prepare | 两者 | ✅ |
| 6 | `src/desktop-runtime-environment.ts` | 新增 `installDesktopCodegraphRuntime()` | 两者 | ✅ |
| 7 | `src/main.ts` | 调用它（约 679 行附近） | 两者 | ✅ |
| 8 | `src/desktop-codegraph-shell.ts`（新建） | macOS：写 shim + 幂等写 `~/.zshrc`（含备份/原子写/可逆） | mac | ✅ |
| 9 | `dsh-plugin-desktop/build/installer.nsh` | 加 `customInstall` / `customUnInstall` | win | ✅ |
| 10 | `dsh-plugin-desktop-beta/` | 同步 6/7/8（`src/` 需逐字节一致） | 两者 | ✅ |
| 11 | `docs/build-custom-client.zh.md` | 加一节 | 两者 | 建议 |

> **两个变体的 `src/` 必须逐字节一致**，改完要跑 `node scripts/verify-desktop-variants.mjs`。
> **NSIS 脚本建议先手工测试**：在一台可丢弃的 Windows 机器或干净用户账户上验证 PATH 前后一致。

---

## 6. 体积

| 项目 | macOS | Windows |
|------|-------|---------|
| 平台包解压 | 278 MB | 261 MB |
| 平台包 tgz | **55 MB** | **51 MB** |
| 安装包预估增量 | 约 +55 ~ 89 MB | 约 +51 ~ 82 MB |

macOS 的推算依据：当前 app 解压 1051 MB → DMG 338 MB，压缩比 **0.322**。

> ⚠️ **修正记录**：我最初按「解压体积」估成 627 MB，那是错的——DMG 是压缩镜像。实测压缩比后，真实增量约 **55 ~ 89 MB**。

`vendor/` 里的两个 tgz 会进 git 仓库（和 `vendor/dsh-runtime/` 的 265 个 tgz 同样性质）。

**macOS 实测**：338 MB → **392 MB**（**+54 MB**，落在估算区间低端）。

---

## 7. 风险与坑

| 风险 | 平台 | 后果 | 处理 |
|------|------|------|------|
| **解压后丢可执行位** | mac | Terminal 报 `Permission denied`，应用内报 `spawn ENOENT` | prepare 脚本里显式 `chmod 0o755`；`afterPack` 钩子再校验（已有 `afterPack: ./scripts/verify-packaged-runtime.ts`） |
| **universal 合并被拒** ✅ 已解决 | mac | 构建直接失败：`Detected file "Contents/Resources/codegraph/lib/kernel/codegraph-kernel.node" that's the same in both x64 and arm64 builds and not covered by the x64ArchFiles rule` | 用 `extraResources` 静态拷贝保证两切片内容相同（这也是 4.1 不用 yarn 依赖的原因），并把它加进 `build.mac.x64ArchFiles` |
| **写坏用户的 `~/.zshrc`** | mac | 用户的 shell 起不来 | 4.3.2 的 7 条；**先备份 + 原子写 + 幂等** |
| **写坏用户的注册表 PATH** | win | 系统命令全找不到，**影响面比 mac 大得多** | 4.4.1 的 7 条；**先备份 + 只追加 + 绝不用 setx + 只动 HKCU** |
| **Gatekeeper 隔离属性** | mac | 未签名的 `node` 被执行时被系统杀掉 | 已需 `xattr -dr com.apple.quarantine`，该命令**递归**覆盖包内所有文件 |
| **以后做签名 / 公证** | mac | 包内 `node`（115 MB Mach-O）需被签名；自带 Node 可能触发 hardened runtime 的 JIT 限制 | **最大的长期风险。** 走 `dist:mac` 签名路线需加 `entitlements`（`com.apple.security.cs.allow-jit`、`allow-unsigned-executable-memory`）并逐一验证。**当前未签名路线不受影响** |
| **应用移动位置** | mac | shim 里的绝对路径失效 | 每次启动重写 shim；`~/.zshrc` 那行指向稳定的 `~/.dsh/bin`，不受影响 |
| **便携版没有安装器** | win | `codegraph` 不在 PATH | 见 4.4.2；应用内仍可用 |
| **上游版本不匹配** | 两者 | 启动失败 | 平台包与 `@colbymchenry/codegraph` 必须**严格同版本**，升级时一起换 |
| **用户已有全局 codegraph**（nvm / Homebrew） | mac | 内置版会优先命中（因为 prepend），版本可能与全局那份不同 | **属预期行为，不是问题**（官方版不内置，无命名冲突）；想反过来就把 PATH 那行改成 append |
| **NSIS 宏名冲突** | win | 构建失败 | `installer.nsh` 已有 `Var pid`，新宏避免重名 |

---

## 8. 验证方法

### 8.1 macOS

```bash
APP="dsh-plugin-desktop/dist/mac-smoke/mac-universal/DSH Desktop Evo.app"

# ① 平台包进了安装包，且可执行位正确
test -x "$APP/Contents/Resources/codegraph/bin/codegraph" && echo "可执行位 ✓"

# ② 包内 CLI 能独立跑
"$APP/Contents/Resources/codegraph/bin/codegraph" --version    # → 1.6.0

# ③ 证明不依赖系统 Node（清空 PATH）
env -i HOME="$HOME" PATH=/usr/bin:/bin \
  "$APP/Contents/Resources/codegraph/bin/codegraph" --version

# ④ 真实离线（沙箱只放行 loopback）
cat > /tmp/nonet.sb <<'SB'
(version 1)
(allow default)
(deny network*)
(allow network* (local ip "localhost:*"))
SB
sandbox-exec -f /tmp/nonet.sb "$APP/Contents/Resources/codegraph/bin/codegraph" --version

# ⑤ 首次启动后检查 ~/.zshrc 被正确追加（且只追加一次）
grep -A 2 ">>> dsh-desktop codegraph >>>" ~/.zshrc
# 重跑一次应用，确认没有重复块

# ⑥ 新开终端窗口
which codegraph && codegraph --version
```

### 8.2 Windows（在原生 Windows 主机上）

```powershell
# ① 平台包进了安装包
Test-Path "$env:USERPROFILE\DSH Desktop Evo\resources\codegraph\bin\codegraph.cmd"

# ② 包内 CLI 能独立跑
& "$env:USERPROFILE\DSH Desktop Evo\resources\codegraph\bin\codegraph.cmd" --version

# ③ 安装后 PATH 已写入（新开窗口）
[Environment]::GetEnvironmentVariable('PATH','User') -split ';' | Select-String codegraph

# ④ cmd.exe 里也能用（证明写注册表而非只写 PowerShell profile）
cmd /c "where codegraph"

# ⑤ PATH 没有被破坏：对比安装前后的用户 PATH 条目数
#    安装器应在 HKCU\Software\DSH Desktop Evo\PathBackup 留有备份

# ⑥ 卸载后 PATH 恢复
```

### 8.3 两平台共同回归

```bash
source .build-cache/env.sh
corepack yarn workspace dsh-plugin-desktop dist:mac-smoke   # 含 lipo 与打包校验
node scripts/verify-desktop-variants.mjs
corepack yarn workspace dsh-plugin-desktop test
corepack yarn workspace dsh-plugin-desktop verify:licenses
corepack yarn workspace dsh-plugin-desktop verify:closure
```

> **许可证注意**：两个平台包都是 **MIT**，不在白名单问题之列。但因为它走 `extraResources` 而非 yarn 依赖，`verify:licenses` **不会检查它**——需要在 `prepare-codegraph.mjs` 里自己断言一次。

---

## 9. 回滚

| 层 | macOS | Windows |
|----|-------|---------|
| 第一层 | 删 `extraResources` 与 `vendor/codegraph/`，重新打包 | 同 |
| 第二层 | 移除 `main.ts` 里的调用 | 同 |
| 第三层 | 删 `~/.dsh/bin/codegraph`；删 `~/.zshrc` 三行标记块（或用设置里的移除项） | NSIS 卸载时自动移除；手工恢复用注册表备份 |
| 应用内已有配置 | **无需改动** | 同 |

---

## 10. 实施记录

### 已完成（macOS）

| 步骤 | 结果 |
|------|------|
| vendor 两个平台 tgz | `vendor/codegraph/`，mac 55 MB + win 51 MB |
| `scripts/prepare-codegraph.mjs` | 按主机解压、断言 MIT、`chmod 0o755`、校验入口存在；幂等（比对 tgz sha256） |
| `.gitignore` | 忽略 `dsh-plugin-desktop{,-beta}/build/codegraph/` |
| `package.json` | `build.extraResources` + 5 个打包脚本前置 prepare |
| `installDesktopCodegraphRuntime()` | `src/desktop-runtime-environment.ts`，复用既有 `installPathDirectory`，可逆 |
| `desktopCodegraphBundleSupportsHost()` | 读平台包自带 `package.json` 的 `os`/`cpu`，架构不匹配时跳过而不是发布坏命令 |
| `src/desktop-codegraph-shell.ts` | shim + `~/.zshrc` 幂等写入（备份/原子写/可逆），含 `uninstallDesktopCodegraphShell()` |
| `main.ts` 接线 | Host PATH 前置 + 首次启动写 shell 集成（失败不阻断启动） |
| beta 同步 | 183 个共享源文件对齐 |
| 测试 | 新增 20 个（shell 13 + runtime 7）；stable 1379 / beta 1365 全绿 |
| DMG | **338 → 392 MB**，smoke 校验通过 |

**真实安装验证**（清空 userData 与 `~/.dsh/bin` 后从 DMG 装）：

```
① ~/.dsh/bin/codegraph           -rwxr-xr-x，指向包内 launcher
② ~/.zshrc 标记块                已写入，且在末尾
③ zsh -i -c 'which codegraph'    /Users/jimmy/.dsh/bin/codegraph → 1.6.0
④ 备份                           ~/.zshrc.dsh-backup-<时间戳>，与原文件逐字节一致
⑤ 行数                           63 → 67（原 63 + 空行 + 3 行块）
⑥ 重启幂等                       标记数不变、备份数不变、~/.zshrc 逐字节未变
⑦ 包内 CLI 独立运行              空 PATH ✓、真离线沙箱 ✓
```

### Windows 实施状态

| 步骤 | 状态 |
|------|------|
| vendor `codegraph-win32-x64` | ✅ 已放好 |
| prepare 脚本 win32 分支 | ✅ 已支持 |
| `extraResources` | ✅ 落地为 `resources\codegraph\bin\codegraph.cmd` |
| NSIS `customInstall` / `customUnInstall` | ✅ 已实施（见 4.4.1） |
| 便携版策略 | ⛔ 不做（见 4.4.2），应用内仍可用 |

> **注册表的实际效果待原生 Windows 主机验证。** 本机是 macOS，`package-win.ts` 又有
> 「必须在原生 Windows 主机上构建」的硬断言，所以本地能验证的只有两层：扩展后的
> `tests/installer-nsh.spec.ts` 断言脚本结构，以及 `StrCpy` / `SendMessage` /
> `WriteRegExpandStr` 的用法逐条对照 NSIS 官方文档核对。nsi 的实际编译由 CI 的
> `windows-latest` 完成；**PATH 是否真的写进去，需要人工装一次并开新终端确认**。

### 与计划的偏差

| 计划 | 实际 | 原因 |
|------|------|------|
| 预估 DMG +55~89 MB | **+54 MB** | 落在估算区间低端 |
| 预设失败模式：两切片内容不一致导致合并失败 | **实际是 `x64ArchFiles` 未声明** | `@electron/universal` 对「两切片相同但未被声明的原生文件」报错，需在 `build.mac.x64ArchFiles` 里加上 `Resources/codegraph/**`。**这是实施中唯一卡住构建的问题** |
| 计划设置 `CODEGRAPH_NO_DOWNLOAD=1` | **不需要** | 我们直接指向平台包的 `bin/codegraph`，**完全绕开了 `npm-shim.js`**，而下载兜底逻辑只在 shim 里 |
| 计划让用户「显式选择是否加 PATH」 | 按用户后续要求改为**首次启动自动写** | 用户明确要求「首次启动的时候，写 .zshrc」 |
| 计划给设置里的「移除 PATH」加 UI | 只实现了 `uninstallDesktopCodegraphShell()` 函数 | UI 开关属于品牌化/设置面板范畴，未做 |

### 一个实施中发现的细节

`pathEntryFragment()` 生成的 PATH 行必须**整体加一对双引号**。最初的实现产出
`export PATH="$HOME/.dsh/bin":$PATH`（引号只包住前半段），虽然 shell 能跑，但与
绝对路径分支的 `'/abs':$PATH` 不一致、可读性差。已改为统一形式：

```sh
export PATH="$HOME/.dsh/bin:$PATH"
export PATH="/abs/path/bin:$PATH"
```

## 附 A：为什么不用「先让用户装 Node，再 npm i -g」

因为离线机器**没有网络**，`npm install -g` 必然失败。而平台包自带 Node 运行时正好绕开这个死结——这是这 278 MB 值得花的唯一理由。

## 附 B：为什么 Windows 不照抄 macOS 写 shell 配置

Windows 的 shell 配置是分家的：PowerShell 读 `$PROFILE`，cmd.exe 读注册表 PATH。只写前者的话 `cmd` 里找不到命令。而 Windows 的安装器**有**钩子可用，写注册表才是正解。macOS 因为 DMG 没钩子，才被迫退回首次启动写 `.zshrc`。
