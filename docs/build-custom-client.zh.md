# 从源码构建你自己的 DSH Desktop 客户端

面向第一次接触这个仓库的读者。按顺序做完，你能得到：

1. 一个能编译、能本地运行的 DSH Desktop 开发环境；
2. 一个 macOS 通用（Intel + Apple Silicon）DMG 安装包；
3. 一份「安装即预装指定插件」的离线预装能力。

Windows 的 `Setup.exe` 见第 5 章——**它无法在 macOS 上生成**，原因和两条可行路线都写在那里。

> 本文所有命令都在仓库根目录 `dsh-desktop/` 下执行。

---

## 1. 先理解这个仓库的四个包

| 目录 | 作用 | 你要不要改 |
|------|------|-----------|
| `deepseek-harness/` | 上游 DSH 源码，**Git 子模块，禁止修改** | ❌ |
| `dsh-plugin-desktop/` | 稳定版客户端：Electron 启动器、Host/Client 插件、打包脚本 | ✅ 主要改这里 |
| `dsh-plugin-desktop-beta/` | Beta 版客户端，与稳定版**源码必须逐字节一致**（仅 `src/product-identity.ts` 例外） | ✅ 改完稳定版要同步 |
| `dsh-community-market/` | 插件市场外壳 | 一般不动 |
| `vendor/dsh-runtime/0.1.5-rc.2/` | 预打包好的 DSH 运行时（265 个 `.tgz`） | ❌ 只读 |

**关键结论**：因为 `vendor/dsh-runtime/` 已经带了完整运行时，**构建安装包不需要初始化 `deepseek-harness/` 子模块**。只有跑完整的 `yarn check`（它含 `check:layout`，会去读 `deepseek-harness/package.json`）才需要。

---

## 2. 环境配置

### 2.1 必需版本

```bash
node -v          # 需要 ^22.19.0 或 >=24.0.0；CI 固定用 22.23.2
```

包管理器是 **Yarn 4.18.0**，由 Node 自带的 Corepack 提供，不需要单独 `npm i -g yarn`。

### 2.2 让所有缓存留在仓库内（推荐）

默认情况下 `corepack` / `yarn` / `electron` 都会往 `$HOME` 写缓存。把下面这些变量固定到仓库内的 `.build-cache/`，既干净、也避免各种权限问题：

```bash
mkdir -p .build-cache
cat > .build-cache/env.sh <<'EOF'
export COREPACK_HOME="$PWD/.build-cache/corepack"
export YARN_GLOBAL_FOLDER="$PWD/.build-cache/yarn-global"
export YARN_ENABLE_GLOBAL_CACHE=false
export YARN_NPM_REGISTRY_SERVER="https://registry.npmmirror.com"
export ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"
export ELECTRON_CACHE="$PWD/.build-cache/electron"
export ELECTRON_BUILDER_CACHE="$PWD/.build-cache/electron-builder"
export DSH_AA_SOURCE_REF="pinned"
EOF
```

之后每条命令前 `source .build-cache/env.sh`。逐项说明：

| 变量 | 为什么需要 |
|------|-----------|
| `COREPACK_HOME` | 不写 `~/.cache/node/corepack` |
| `YARN_GLOBAL_FOLDER` / `YARN_ENABLE_GLOBAL_CACHE` | Yarn 缓存与全局状态不写 `~/.yarn` |
| `YARN_NPM_REGISTRY_SERVER` | 国内用 npmmirror 镜像，安装快很多 |
| `ELECTRON_MIRROR` | Electron 二进制（约 100MB）默认从 GitHub 下载，国内常超时 |
| `ELECTRON_CACHE` / `ELECTRON_BUILDER_CACHE` | Electron 与打包工具缓存不写 `~/Library/Caches` |
| `DSH_AA_SOURCE_REF=pinned` | 让 `aa:prepare-release` 直接用仓库里已 pin 的 `vendor/agents-anywhere/*.tgz`，跳过对 GitHub 的 `git ls-remote` |

`.build-cache/` 已在 `.gitignore` 中，不会污染提交。

### 2.3 验证

```bash
source .build-cache/env.sh
corepack yarn --version      # 期望 4.18.0
```

### 2.4 （可选）初始化上游子模块

只有要跑完整 `yarn check` 时才需要：

```bash
git submodule update --init --recursive
```

国内网络如果拉不动，可以先跳过——第 4 章的 DMG 构建不依赖它。

---

## 3. 安装依赖 → 编译 → 本地运行

```bash
source .build-cache/env.sh

# 1) 安装（首次约 1~2 分钟，1147 个包）
corepack yarn install --immutable

# 2) 编译全部工作区（生成 dsh-plugin-desktop/lib 等产物）
corepack yarn build

# 3) 类型检查
corepack yarn typecheck
```

### 不启动图形界面的自检

```bash
node dsh-plugin-desktop/lib/bin.js --version   # 打印 2.0.10
node dsh-plugin-desktop/lib/bin.js --help
```

这套 headless 门禁很有用，出问题时能快速定位是构建还是运行期的毛病：

```bash
cd dsh-plugin-desktop
corepack yarn verify:closure    # 生产依赖闭包完整性
corepack yarn verify:licenses   # 许可证可再分发审计
corepack yarn verify:cli        # CLI 运行时
corepack yarn verify:loader     # Loader 启动
corepack yarn verify:profile    # Host Profile 启动（会真的挂载插件）
```

### 真正把应用跑起来

```bash
corepack yarn dev
```

`dev` = 先 build，再 `prepare:electron-native`，最后 `node lib/bin.js` 启动 Electron 窗口。第一次启动会创建 `~/.dsh/profiles/desktop/`。

---

## 4. 产出 macOS DMG

### 4.1 命令

```bash
source .build-cache/env.sh
corepack yarn workspace dsh-plugin-desktop dist:mac-smoke
```

这条命令做四件事：

1. 跑 `check:mac-package`：市场包构建 + 本包构建 + 全部 TS 编译面 + 相关单测 + `verify:closure`；
2. 准备 universal 运行时（`x86_64` + `arm64` 两套原生模块，靠 `.yarnrc.yml` 的 `supportedArchitectures` 保证）；
3. `electron-builder --mac dmg --universal`，**不签名、不公证**；
4. 挂载 DMG 并校验 plist、可执行位、双架构切片、`Contents/Resources/app/` 运行时条目。

### 4.2 产物

```
dsh-plugin-desktop/dist/mac-smoke/DSH Desktop-2.0.10-universal.dmg      # 约 269 MB
dsh-plugin-desktop/dist/mac-smoke/mac-universal/DSH Desktop.app         # 未打包的 .app，方便调试
```

验证双架构：

```bash
lipo -archs "dsh-plugin-desktop/dist/mac-smoke/mac-universal/DSH Desktop.app/Contents/MacOS/DSH Desktop"
# 期望：x86_64 arm64
```

### 4.3 本机安装测试

产物没有 Developer ID 签名，Gatekeeper 会拦。本机自测：

```bash
# 方式一：去掉隔离标记
xattr -dr com.apple.quarantine "/Applications/DSH Desktop.app"

# 方式二：右键 App → 打开（而不是双击）
```

### 4.4 要真正对外分发

需要 Apple 开发者账号（Developer ID Application 证书 + 公证凭据），改用：

```bash
corepack yarn workspace dsh-plugin-desktop dist:mac
```

它会先跑 `release-preflight.ts` 校验凭据，产物落在 `dist/mac-release/`。这一步本文不覆盖。

---

## 5. 产出 Windows Setup.exe

### 5.1 为什么不能在 macOS 上做

`dsh-plugin-desktop/scripts/package-win.ts` 里有硬断言：

```
Windows <artifact> must be built on a native Windows host
Windows <artifact> requires x64 Node
```

同时 Electron Builder 需要 Windows 侧的 NSIS 工具链与 `node-pty` 的 win32 原生二进制。**没有跨编译通道。** WSL 也不行（WSL 是 Linux 主机，仍然被拒）。

### 5.2 拷贝什么、不拷贝什么

**这一节最容易搞错。** 仓库根 `package.json` 里有 **504 个 `file:` 依赖全部指向 `vendor/dsh-runtime/`**——少了 `vendor/`，Windows 上 `yarn install` 必然失败。

| 目录 | 大小 | 要拷吗 | 原因 |
|------|------|--------|------|
| 仓库源码 | 小 | ✅ | |
| **`vendor/`** | **约 119 MB** | **✅ 必须** | 504 个 `@deepseek-ai/dsh-*` 依赖都从这里解析 |
| `deepseek-harness/` | 大 | ❌ 不需要 | 它**不是 workspace**；`dist:win` 与 `check:win-package` 都不碰它（只有 `check:layout` 和 `upstream:*` 需要） |
| `node_modules/` | 很大 | ❌ **千万别拷** | 里面的原生模块是 macOS 二进制，Windows 上会加载失败 |
| `.build-cache/` | 很大 | ❌ | 缓存，Windows 上重建 |
| `*/dist/` | 大 | ❌ | 构建产物 |

> ⚠️ 目前这些改动**还没提交到 git**（`vendor/codegraph/`、`vendor/edan-spec/` 等都还是未跟踪状态）。所以**不要用 `git clone`**——直接拷工作目录。

**在 macOS 上打包传输**（假设 U 盘挂在 `/Volumes/USB`）：

```bash
rsync -a --delete \
  --exclude node_modules --exclude .build-cache --exclude dist \
  --exclude .git --exclude '*.log' \
  /Users/jimmy/Documents/AI/dsh-desktop/ /Volumes/USB/dsh-desktop/
```

**在 Windows 上从共享目录拷**（PowerShell）：

```powershell
robocopy "\\Mac\共享\dsh-desktop" "C:\src\dsh-desktop" /E `
  /XD node_modules .build-cache dist .git
```

拷完后确认两件事：

```powershell
Test-Path C:\src\dsh-desktop\vendor\dsh-runtime\0.1.5-rc.2   # True
Test-Path C:\src\dsh-desktop\vendor\codegraph                  # True
```

### 5.3 Windows 机器要装什么

| 需要 | 版本 | 说明 |
|------|------|------|
| **Node.js x64** | **22.19+ 或 24.x** | ⚠️ **必须是 x64**，即使机器是 Windows on ARM 也要装 x64 版。装 arm64 版会被断言拒绝 |
| 网络 | — | 首次构建时 Electron Builder 要下载 **NSIS 工具链与 winCodeSign**。构建机需要网络（**目标机器可以离线**，这是两回事） |
| Git for Windows | 任意 | 只在需要 clone/子模块时用；纯拷贝则不需要 |

**不需要**：Python、Visual Studio C++ Build Tools（`node-pty` 用的是自带的 Node-API 预编译二进制）。

装完先确认：

```powershell
node --version           # v22.23.2 或 v24.x
node -p process.arch     # x64   ← 不是 x64 就得换 Node
```

### 5.4 第一步：配置构建环境

仓库自带了 PowerShell 版环境脚本（把缓存固定在仓库内并指向国内镜像）：

```powershell
cd C:\src\dsh-desktop
. .\scripts\build-env.ps1
```

注意**开头是「点 + 空格」**（点源），否则变量只存在于子作用域，当前窗口拿不到。

脚本会打印 node 版本、arch 和 registry，用来当场确认。

### 5.5 第二步：安装依赖

```powershell
corepack yarn install --immutable
```

- 这里会从 `vendor/dsh-runtime/` 解出全部 `@deepseek-ai/dsh-*`，**不需要上游子模块**
- 如果报 `EPERM` 或想跳过 Corepack 的全局 shim，用 `corepack yarn` 而不是 `yarn`（避免动 Program Files）

### 5.6 第三步：预检

```powershell
corepack yarn workspace dsh-plugin-desktop check:win-package
```

它会跑：market 构建 → 桌面构建 → typecheck → 13 个 Windows 相关测试文件 → `verify:closure`。**这一步过了再打包**，否则打包中途失败更费时间。

### 5.7 第四步：生成 exe

```powershell
$env:DSH_PACKAGE_CHECK_ALREADY_RAN = '1'    # 预检刚跑过，跳过重复
corepack yarn dist:win                       # NSIS 安装器 Setup.exe
corepack yarn dist:win-portable              # 便携版 ZIP
```

（`DSH_PACKAGE_CHECK_ALREADY_RAN` 只影响「是否再跑一遍预检」，不改变产物。）

**产物**（在 `dsh-plugin-desktop\dist\`）：

| 文件 | 说明 |
|------|------|
| `DSH-Desktop-2.0.10-x64-Setup.exe` | NSIS 安装器，`perMachine: false` → 默认装到 `%USERPROFILE%\DSH Desktop Evo`（由 `build/installer.nsh` 的 `preInit` 设定，安装向导里仍可改） |
| `DSH-Desktop-2.0.10-x64-Portable.zip` | 便携版，解压即用 |

> 本地构建是**无签名**的，Windows 会显示「未知发布者」，SmartScreen 可能拦截。签名版是单独的发布门禁。

### 5.8 验证清单

装完之后按顺序验证：

```powershell
# ① codegraph CLI 是否打进安装包（这是本次新增的能力）
$app = "$env:USERPROFILE\DSH Desktop Evo"
Test-Path "$app\resources\codegraph\bin\codegraph.cmd"     # 期望 True
Test-Path "$app\resources\codegraph\node.exe"                # 期望 True

# ② 包内 CLI 能否独立运行（自带 Node，不需要系统 Node）
& "$app\resources\codegraph\bin\codegraph.cmd" --version    # 期望 1.6.0

# ③ 默认预装插件是否已写入新 Profile
$profile = Get-Content "$env:USERPROFILE\.dsh\profiles\desktop-evo\package.json" | ConvertFrom-Json
$profile.dsh.profile.bundles                                    # 期望 10 个（base + web-app + 8 插件）

# ④ 应用内 codegraph 是否可用
#    打开应用 → 设置 → 插件 → Codegraph 卡片，应显示索引状态而不是「命令不可用」
```

**macOS 侧已通过的项**（5.8 的 ①②③）在 Windows 上预期同样通过，但**未经验证**——这正是这次要测的。

### 5.9 Windows 终端里用 codegraph

两个平台**登记进 PATH 的目录是同一个相对位置**（相对各自的数据目录），只是写法不同：

| 能力 | macOS | Windows |
|------|-------|---------|
| CLI 打进安装包 | ✅ 已验证 | ✅ 已验证（`resources\codegraph\bin\codegraph.cmd`、`resources\mnemon\bin\mnemon.exe`） |
| **应用内**可用（MCP + 插件调用） | ✅ 已验证 | ✅ 已验证 |
| **终端里**可用（`codegraph --version`） | ✅ 首次启动写 `~/.zshrc` | ✅ **安装时写用户 PATH**，指向 `%USERPROFILE%\.dsh\bin` |
| 登记的是哪个目录 | `~/.dsh/bin`（放 shim） | `%USERPROFILE%\.dsh\bin`（放 shim） |
| 便携版怎么办 | 与 DMG 相同（首次启动写） | **首次启动弹一次提示**，也随时可以「设置 → 命令行工具 → 登记」（见下） |
| 插件在 Windows 上解析 `.cmd` | — | ✅ 上游已自行处理（见下） |

**两个平台的做法不同，原因在安装方式**：macOS 的 DMG 没有安装钩子，拖进 `/Applications` 就是全部流程，所以只能首次启动写 `~/.zshrc`；而 NSIS 安装器**有**钩子，所以 Windows 在**安装时**就写好 PATH。

**PATH 里放的是 `.dsh\bin`，不是安装目录。** 安装目录（尤其便携版解压目录）会变：换盘、改名、重新解压都会让写死进去的路径失效。`.dsh\bin` 属于用户数据目录，位置稳定；里面放的是**转发 shim**（`mnemon.cmd`、`codegraph.cmd`），每次启动都会重新写成指向当前安装位置的绝对路径，所以升级、搬目录之后 shim 自动跟随，不用改 PATH。

实现分三处：

| 位置 | 行为 |
|------|------|
| `build/installer.nsh` 的 `customInstall` | 确认 CLI 确实随包分发后，把 `$PROFILE\.dsh\bin` 追加到用户 PATH |
| `build/installer.nsh` 的 `customUnInstall` | 条目仍在末尾时移除（shim 文件保留） |
| 启动时的便携版提示 | 便携版首次启动弹一次，点「登记」即登记；结果记在应用数据目录 |
| 应用的设置入口 | 生成/刷新 shim 并登记 PATH；可重复执行，也可撤销 |

设计上的几个取舍：

- **只写 HKCU，不写 HKLM**。安装器是 `perMachine: false`，写用户级既不需要管理员权限，也不影响同一台机器上的其他账号。
- **写入前先查重**。升级安装会在同一目录上再跑一次 `customInstall`，不查重就会不断追加。
- **保持 `REG_EXPAND_SZ`**（用 `WriteRegExpandStr` 而不是 `WriteRegStr`）。写成普通字符串会把用户 PATH 里原有的 `%USERPROFILE%` 之类固化成字面路径。
- **写完广播 `WM_SETTINGCHANGE`**，让之后启动的进程看到新值。
- **卸载只在条目仍是最后一个时才移除**。用户如果自己调整过顺序就不动——宁可留下一个指向已删目录的条目（Windows 查找时会直接跳过），也不冒改坏 PATH 的风险。
- **卸载不移除 shim 文件**。`%USERPROFILE%\.dsh\bin` 属于用户数据，另一个变体可能也在用；运行时删掉它等于替用户丢数据。

> **已经开着的终端需要重开。** Windows 在进程启动时读取环境变量，安装器改不了已经在跑的进程。

#### 便携版的三步

便携版 ZIP **没有安装器**——electron-builder 对 portable 目标不注入自定义 include（源码里包着 `if (!this.isPortable)`），所以 PATH 不会自动写好。用设置入口登记即可，录入的是同一个 `.dsh\bin`：

1. **解压并首次运行。** 便携版启动时会先在 `%USERPROFILE%\.dsh\bin` 生成 `mnemon.cmd` / `codegraph.cmd` 两个转发 shim（内容指向当前解压目录），然后**弹一次**询问要不要把这个目录登记进 PATH。点「登记」就完成；点「暂不」或直接关掉也不会再问第二次。
2. **之后随时可以走「设置 → 命令行工具 → 登记命令行工具」。** 无论第 1 步你选了什么，这个入口都在。它可以**重复执行**：搬了目录、换了盘、升级之后，再点一次就会把 shim 重写成新的路径。反馈会告诉你这次是「已更新」还是「已是最新」。
3. **换解压目录后重跑第 2 步**，然后开一个**新终端**验证。

只有便携版会弹这个提示：安装版在安装时就已经写好 PATH，再问一次是在陈述假事实。判定依据是注册表里有没有这个产品的安装记录（`HKCU\Software\<GUID>` 与卸载项），**不猜路径**。提示是否出现过记在应用数据目录下的 `cli-prompt\state.json`，不写注册表——便携版本就不该留注册表痕迹。

> 如果注册表读不出来（PowerShell 被拦、权限异常），应用会**不提示**并记一条日志。读不到安装记录不等于「这是便携版」，对已登记的用户弹提示是在说假话。

撤销用同一个区块的「撤销登记」按钮：它只移除 DSH 自己写进去的那一条 PATH 条目，保留 shim 文件。便携版没有卸载器，所以这个按钮是唯一的下车方式。

安装版同样可以用这个入口——升级、手动挪过安装目录之后，它比重新跑一遍安装器更快。

#### 验证

```powershell
# 开一个「新的」终端
codegraph --version                                   # 期望输出版本号
mnemon --version                                      # 期望输出版本号
$env:Path -split ';' | Select-String 'codegraph'      # 期望看到 .dsh\bin
```

#### 从旧版本升级：清理残留条目

旧版本的安装器登记的是**安装目录下的** `resources\codegraph\bin` 和 `resources\mnemon\bin`，这两个条目不会被新版本自动清掉。它们不是致命的（指向已删目录的条目 Windows 会直接跳过），但会让 PATH 越来越长。

清理方式：安装时原值备份在 `HKCU\Software\<产品名>\PathBackup`，可以对照它手工恢复；或者直接在「系统属性 → 环境变量」里删掉那两条。**不要用 `setx` 改 PATH**——它会把 `%VAR%` 展开成字面路径，还可能在超过 1024 字符时静默截断。

**Windows 不需要写 `codegraph.cmd` shim**：第二层已经把 `resources\codegraph\bin` 前置到 Host 的 PATH，而 `@hyzyn/dsh-codegraph` 源码里已经专门处理了 Windows 的 `.cmd`：

```
npm / pnpm 全局安装的 CLI 在 Windows 上只有 `.cmd` / `.ps1` shim……
Node 又因 CVE-2024-27980 加固拒绝在无 shell 时执行 `.cmd`
解法是把命令行交给 `%COMSPEC% /d /s /c`，由 cmd.exe 按 PATHEXT 解析出 shim。
```

所以 Windows 侧应用内**只要 `codegraph` 在 PATH 里就行**，插件自己会解析。

### 5.10 常见错误

| 现象 | 原因 | 处理 |
|------|------|------|
| `Windows installer must be built on a native Windows host` | 在 macOS/WSL 上跑 | 必须原生 Windows |
| `requires x64 Node` | 装了 arm64 版 Node | 改装 x64 版 |
| `requires Node 22.19+ or Node 24.x` | Node 版本过低 | 升级 |
| `yarn install` 报找不到 `@deepseek-ai/dsh-*` | **没拷 `vendor/`** | 见 5.2，这是最常见的问题 |
| 原生模块加载失败（`invalid ELF/Mach-O`） | 拷了 macOS 的 `node_modules` | 删掉重装 |
| 下载 NSIS / winCodeSign 超时 | 走的 GitHub | 用 `scripts\build-env.ps1`（已指向国内镜像） |
| `node-pty` 编译失败 | 误装了 C++ 工具链反而冲突 | 不需要 VS；`npmRebuild=false` 已是默认 |

### 5.11 路线 A：借用仓库自带的 CI（不用买 Windows 机器）

`.github/workflows/ci.yml` 里的 `desktop-windows` job 就在 `windows-latest` 上跑：

```yaml
- run: yarn workspace dsh-plugin-desktop check:win-package
- run: yarn workspace dsh-plugin-desktop dist:win          # NSIS 安装器
- run: yarn workspace dsh-plugin-desktop dist:win-portable # 便携版 ZIP
```

但它**目前没有上传产物**（全文件搜不到 `actions/upload-artifact`）。所以要拿到 exe，需要给这个 job 追加一个上传步骤，例如：

```yaml
      - uses: actions/upload-artifact@v4
        with:
          name: dsh-desktop-windows
          path: dsh-plugin-desktop/dist/*.exe
```

CI 支持 `workflow_dispatch`（手动触发），且手动触发时 `product=true`，打包 job 一定会跑。改 CI 属于发布流程变更，动手前请自行确认。

> ⚠️ CI 走的是 `git checkout` + `submodules: recursive`，因此**只会拿到已提交的内容**。`vendor/codegraph/` 等未提交的目录不会出现，`prepare-codegraph.mjs` 会因找不到 tgz 而失败。走 CI 前必须先提交。

## 6. 默认插件离线预装

### 6.1 原理（先看懂再改）

DSH 的每一个「Profile」（`~/.dsh/profiles/<名字>/`）就是一组插件清单：

```jsonc
// ~/.dsh/profiles/desktop/package.json
{
  "dependencies": { },                    // Profile 自己装的包
  "dsh": {
    "profile": {
      "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "..."],
      "patchReload": "live"
    }
  }
}
```

新建 Profile 的代码在 `dsh-plugin-desktop/src/profile.ts` 的 `ensureDesktopProfile()`。启动时每个 `bundles` 条目都走一次**安装包/Profile 双层解析**（`src/package-overlay.ts`）：

> 先在**安装目录**（`DSH Desktop.app/Contents/Resources/app/package.json`）找，找不到再找 Profile；两边都有时**安装目录优先**，除非 Profile 的版本严格更高。

因为打包配置是 `asar: false`，安装目录的 `node_modules` 是完整依赖树。所以只要：

1. 把插件写进 `dsh-plugin-desktop/package.json` 的 `dependencies` → Electron Builder 会把它打进安装包；
2. 把插件名字写进新建 Profile 的 `bundles` → 启动时直接从安装目录解析。

**首次运行零网络、零 pnpm install。** 这就是「离线预装」。

### 6.2 默认清单在哪里

清单，以及「这个应用的 Profile 叫什么」，都放在 `dsh-plugin-desktop/src/product-identity.ts`——**这是全仓库唯一允许稳定版和 Beta 版不同的源文件**，凡是「两个变体必须各有一套」的产品级常量都归它管：

```ts
export const DESKTOP_RELEASE_IDENTITIES = Object.freeze({
  stable: Object.freeze({
    releaseChannel: 'stable' as const,
    packageName: 'dsh-plugin-desktop',
    productName: 'DSH Desktop Evo',
    appId: 'ai.deepseek.dsh.desktop.evo',
    profileName: 'desktop-evo',        // ← Profile 名在这里
  }),
  // ...
})

export const DESKTOP_PROFILE_NAME = DESKTOP_PRODUCT_IDENTITY.profileName

export const DEFAULT_PROFILE_PLUGIN_BUNDLES: readonly string[] = Object.freeze([
  '@hyzyn/dsh-codegraph',
  '@linxin666/dsh-client-ui-git-graph',
  '@mars-sea/dsh-commandcode-provider',
  'dsh-better-sidebar',
  'dsh-cost-meter',
  'dsh-dream-skin',
  'dsh-session-manager',
])
```

> **为什么不能写在 `profile.ts` 里**：`profile.ts` 在两个变体之间必须**逐字节相同**（`verify-desktop-variants` 会拦），而 Profile 名需要按变体不同。放进 `product-identity.ts` 既满足变体隔离，又让 `profile.ts` 和 `profile-manager.ts` 都能干净引用它。

### 6.2.1 有两条创建路径，两条都要注入（最容易漏的地方）

**这是实现这个功能最大的坑。** 代码里有两处会创建 Profile：

| 路径 | 触发场景 | 代码位置 |
|------|---------|---------|
| **A** | 启动时发现没有任何 Profile，自动物化默认 Profile | `profile-manager.ts` → `beginDesktopProfileStartup()` → `materializeDefaultDesktopProfile()` → `createDesktopWebProfile()` |
| B | 兜底修复 / `ensureDesktopProfile()` | `profile.ts` → `ensureDesktopProfile()` |
| C | 用户在界面上手动新建 Profile | `createFreshDesktopProfile()` → `createDesktopWebProfile()` |

**全新安装真正走的是 A。** 只改 B（名字最像，最容易改到）的话，用临时目录直测会「通过」，但真机全新安装**一个插件都不会预装**。B 和 C 都收敛到 `createDesktopWebProfile()`：

```ts
initProfile(staging, [...template.bundles, ...DEFAULT_PROFILE_PLUGIN_BUNDLES], template.patchReload)
```

**验证必须走真实启动路径**，不能只测 `ensureDesktopProfile`：

```bash
node --input-type=module -e "
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beginDesktopProfileStartup } from './dsh-plugin-desktop/lib/profile-manager.js'
const root = mkdtempSync(join(tmpdir(), 'fresh-'))
const home = join(root, 'dsh-home')
const startup = beginDesktopProfileStartup(join(root, 'u', 'state.json'), home)
const m = JSON.parse(readFileSync(join(home, 'profiles', startup.profileName, 'package.json'), 'utf8'))
console.log(startup.profileName, '|', m.dsh.profile.bundles.length, '个 bundle')
rmSync(root, { recursive: true, force: true })
"
# 期望：desktop-evo | 10 个 bundle（base + web-app + 8 个插件）
```

**为什么只在创建时注入**：需求就是「安装的时候集成」。如果每次启动都注入，用户手动删掉的插件会被"复活"，也会破坏仓库既有的修复契约测试。代价是：**客户端升级后，已存在的 Profile 不会自动获得新增默认插件**——需要用户在「设置 → 插件」里手动启用，或删掉 `~/.dsh/profiles/<profileName>` 重建。

### 6.2.2 预装一个「没有发布到 npm」的插件（vendor 方式）

如果插件只在本地源码目录（例如 `@edan/edan-spec` 是 `file:/Users/jimmy/Documents/AI/edan-spec-dsh-plugin` 这种**绝对路径**），它不能直接进安装包——别人拿到 DMG 那个路径根本不存在。做法是**把它 vendor 进仓库**，改成本仓库内的相对 tarball 引用。

仓库里已有同样的先例：`@agents-anywhere/dsh-bridge-next` 就是 `file:../vendor/agents-anywhere/<name>.tgz`。

```bash
# ① 打包成 tgz 放进 vendor/
mkdir -p vendor/edan-spec
cd /path/to/edan-spec-dsh-plugin
npm pack --pack-destination /path/to/dsh-desktop/vendor/edan-spec
#   → edan-edan-spec-1.0.0.tgz
tar -tzf /path/to/dsh-desktop/vendor/edan-spec/edan-edan-spec-1.0.0.tgz | grep -E 'cordis.patch.yml|lib/'
#   必须看到 cordis.patch.yml 和 lib/，否则插件加载不起来

# ② 两个变体的 package.json 都加依赖（注意是相对 vendor 的路径）
#    "@edan/edan-spec": "file:../vendor/edan-spec/edan-edan-spec-1.0.0.tgz"

# ③ 两个变体的 product-identity.ts 都加进 DEFAULT_PROFILE_PLUGIN_BUNDLES
# ④ 更新锁文件并确认解包成实体目录（不能是符号链接，否则打不进安装包）
corepack yarn install
ls -ld dsh-plugin-desktop/node_modules/@edan/edan-spec     # 必须是 drwxr-xr-x，不是 lrwxr-xr-x
```

**⚠️ vendor 的代价**：这是一份**快照**。以后改了 `edan-spec-dsh-plugin` 的源码，必须重新 `npm pack` 并提交新 tgz，安装包才会带上新版本（可以用 `1.0.0` → `1.0.1` 这种版本号区分，文件名带版本号便于留痕）。

`npm pack` 只会打包插件 `package.json` 里 `files` 字段列出的内容，所以不用担心带进无关文件。

### 6.3 增删一个默认插件（用脚本）

仓库自带 `scripts/preinstall-plugins.mjs`，把「体检 → 改 4 个文件 → 装依赖 → 跑门禁」合成一条命令：

```bash
source .build-cache/env.sh          # 每条命令前都要

corepack yarn plugins:list          # 看当前清单与一致性
corepack yarn plugins:verify        # 只检查：4 处是否一致、是否装好、有没有软链

corepack yarn plugins:add dsh-foo@1.2.3
corepack yarn plugins:remove dsh-foo
```

**`add` 会先体检**：查 npm 上的 `version` / `license` / `dsh.bundle` / `peerDependencies`。只有两项会**阻断**——「许可证不可再分发」和「没有 `dsh.bundle.patch`」，因为它们分别会让打包门禁失败、让应用启动直接 throw。缺失的 peer 只作提示：DSH 里 `cordis` 这类未加域的名字实际由 `@deepseek-ai/cordis` 提供，据此阻断会误伤合法插件。

**本地未发布的插件**（就像 `@edan/edan-spec`）用 `--from-dir`，脚本会自动 `npm pack` 进 `vendor/` 并写入相对路径依赖：

```bash
corepack yarn plugins:add --from-dir /Users/jimmy/Documents/AI/edan-spec-dsh-plugin
```

| 参数 | 作用 |
|------|------|
| `--from-dir <目录>` | 本地源码目录：自动 vendor，并写成 `file:../vendor/<名字>/<包>-<版本>.tgz` |
| `--no-install` | 跳过 `corepack yarn install` |
| `--no-verify` | 跳过关禁（还要连着改好几样时更快） |
| `--yes` | 体检有问题也照加 |

脚本会按字母序改写 4 个文件，并**拒绝改写非规范格式的 `package.json`**——避免「加一行依赖」变成整个文件重新排版、污染 diff。

`add` 成功后脚本会打印接下来要做的三步（确认实体目录 → 重新打包 → 用全新 `DSH_HOME` 验证新 Profile）。

### 6.4 手动增删（脚本不适用时）

#### 第 0 步：先给候选插件「体检」

**别急着改文件。** 不满足条件的插件会让应用直接起不来，必须提前查这三项：

```bash
source .build-cache/env.sh
PKG="dsh-foo"          # 换成你要加的包名

# ① 许可证是否可再分发
npm view "$PKG" version license

# ② 是否声明了 dsh.bundle.patch —— 这是硬要求，没有它应用启动会 throw
npm view "$PKG" dsh --json

# ③ 已有的 peer 依赖是否都在应用里
npm view "$PKG" peerDependencies --json
```

| 检查项 | 合格标准 | 不合格的后果 |
|--------|---------|-------------|
| `license` | 在 `verify-licenses.mjs` 白名单内（MIT / Apache-2.0 / BSD / ISC / MPL-2.0 …） | 打包门禁直接红 |
| `dsh.bundle.patch` | 有值，例如 `"./cordis.patch.yml"` | `profile.ts` 解析时 throw，**应用起不来** |
| `peerDependencies` | 每个都在 `dsh-plugin-desktop/node_modules/` 里能找到 | 运行期功能异常 |

#### 第 1 步：改 4 个文件

因为要维护 **stable + beta 两个变体**，所以每个变体各改 2 处，一共 4 处：

| # | 文件 | 改什么 |
|---|------|--------|
| 1 | `dsh-plugin-desktop/package.json` | `dependencies` 加 `"dsh-foo": "1.2.3"`（**按字母序插入**） |
| 2 | `dsh-plugin-desktop-beta/package.json` | 同上 |
| 3 | `dsh-plugin-desktop/src/product-identity.ts` | `DEFAULT_PROFILE_PLUGIN_BUNDLES` 数组加 `'dsh-foo'` |
| 4 | `dsh-plugin-desktop-beta/src/product-identity.ts` | 同上 |

> 为什么是「每变体 2 处」：`package.json` 决定**装不装进安装包**，`DEFAULT_PROFILE_PLUGIN_BUNDLES` 决定**新 Profile 里启不启用**。两者缺一，效果就是「包在里面但没启用」或「名字登记了但包里没有」。

#### 第 2 步：更新锁文件并确认解包形态

```bash
corepack yarn install
# 必须解成实体目录，符号链接会被 electron-builder 丢掉
ls -ld dsh-plugin-desktop/node_modules/dsh-foo        # 期望 drwxr-xr-x，不是 lrwxr-xr-x
```

#### 第 3 步：跑门禁

```bash
node scripts/verify-desktop-variants.mjs                                       # 两变体是否仍对齐
corepack yarn workspace dsh-plugin-desktop test                                # 含「常量必须是直接依赖」的守卫测试
cd dsh-plugin-desktop && corepack yarn verify:licenses && corepack yarn verify:closure && cd ..
```

#### 第 4 步：验证真的进包了

```bash
corepack yarn build
corepack yarn workspace dsh-plugin-desktop dist:mac-smoke
APP="dsh-plugin-desktop/dist/mac-smoke/mac-universal/DSH Desktop Evo.app"
ls "$APP/Contents/Resources/app/node_modules/dsh-foo/package.json"    # 必须在安装包里

# 真实启动路径会不会预装它（这一步最容易漏，见 6.2.1）
node --input-type=module -e "
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beginDesktopProfileStartup } from './dsh-plugin-desktop/lib/profile-manager.js'
const root = mkdtempSync(join(tmpdir(), 'fresh-'))
const home = join(root, 'dsh-home')
const s = beginDesktopProfileStartup(join(root, 'u', 'state.json'), home)
const m = JSON.parse(readFileSync(join(home, 'profiles', s.profileName, 'package.json'), 'utf8'))
console.log(s.profileName, '|', m.dsh.profile.bundles.length, '个 bundle')
console.log(m.dsh.profile.bundles.includes('dsh-foo') ? '✓ 已预装' : '✗ 没进去')
rmSync(root, { recursive: true, force: true })
"
```

#### 删除一个插件

把上面反过来做一遍即可：4 个文件各删一行 → `corepack yarn install` → 跑门禁。

**注意**：删除只影响**将来新建的** Profile。已经存在的 Profile 里那一行 `bundles` 不会被动（这是刻意设计，见 6.2.1）。要让现有用户生效，得在「设置 → 插件」里禁用，或删掉 `~/.dsh/profiles/<profileName>` 重建。

#### 什么时候才需要手动改

脚本覆盖不了的情况：要在 `DEFAULT_PROFILE_PLUGIN_BUNDLES` 里做**非字母序**的刻意排列、要同时改多份清单、或者脚本本身要改。其余时候用 6.3 的命令即可。

### 6.5 这次的预装清单与例外

**已预装（8 个）**

| 插件 | 版本 | 许可证 | 来源 |
|------|------|--------|------|
| `@edan/edan-spec` | 1.0.0 | MIT | **vendor tarball**（未发布到 npm，见 6.2.2） |
| `@hyzyn/dsh-codegraph` | 0.2.2 | MIT | npm |
| `@linxin666/dsh-client-ui-git-graph` | 0.3.22 | MIT | npm |
| `@mars-sea/dsh-commandcode-provider` | 0.11.1 | MIT | npm |
| `dsh-better-sidebar` | 0.19.1 | MIT | npm |
| `dsh-cost-meter` | 1.7.25 | MIT | npm |
| `dsh-dream-skin` | 9.16.0 | MIT | npm |
| `dsh-session-manager` | 0.4.11 | MIT | npm（原清单写的是 `github:` 形式，已换成 npm 版本，构建期不再需要 git 网络） |

**唯一排除的**

| 插件 | 原因 | 处理 |
|------|------|------|
| `@huanlin/dsh-plugin-better-sidebar-plugin-office@0.2.0` | 许可证是 **AGPL-3.0**，不在 `verify-licenses.mjs` 的可再分发白名单里 | **未预装**。自己用可以在插件市场单独安装；要打进安装包分发需先确认合规 |

另外 `dompurify@3.4.15`（`dsh-better-sidebar` 的传递依赖）许可证是双许可表达式 `(MPL-2.0 OR Apache-2.0)`。原审计脚本只做字符串精确匹配，会误判为「不在白名单」。已给 `scripts/verify-licenses.mjs` 增加 SPDX **析取（OR）** 求值：任一分支在白名单即通过；`AND` 表达式仍按原逻辑严格匹配。

### 6.6 预装插件在哪里管理（市场里为什么显示「未安装」）

**这是设计后果，不是 bug。**

插件市场判断「已安装」的逻辑在 `dsh-community-market/src/install/service.ts` 的 `directProfilePluginVersion()`：它同时要求包名出现在 **Profile 的 `dependencies`** 里**和** `bundles` 里。

```ts
const version = profileDependency(manifest, packageName)   // ← Profile 的 dependencies
if (version === undefined || !profileBundles(manifest).includes(packageName)) {
  throw new MarketInstallError('conflict', 'This plugin is no longer a direct dependency of the active Profile.')
}
```

而离线预装刻意让**安装包**而不是 Profile 拥有这些包，所以新建 Profile 是 `dependencies: {}`。市场因此认为它们「不是这个 Profile 直接装的」，自然不给「已安装 / 卸载」入口。

**为什么不干脆把名字也写进 Profile 的 `dependencies`？** 因为那会触发 `profileDependencyMigrationRequired()` → 首次启动执行 `pnpm install` → **需要联网**，直接毁掉离线预装的意义。

**正确的管理入口是「设置 → 插件」**，不是市场：

| | 市场 | 设置 → 插件 |
|---|---|---|
| 作用 | 从 registry **安装新**插件 | 管理当前 Profile 的**直接 bundle** |
| 预装插件可见 | ❌ 显示未安装 | ✅ 列出 |
| 能否禁用 | — | ✅ 可以（`desktopPluginBundleMutable` 只把 base/web-app/market/启动器本身列为不可变） |
| 能否卸载 | — | ❌ 不可卸载（它们属于安装包，不是 Profile 自己装的） |

一句话：**市场是「装新的」，设置 → 插件是「管现有的」。**

### 6.7 验收

**第一步：确认插件已经被打进安装包。**

```bash
APP="dsh-plugin-desktop/dist/mac-smoke/mac-universal/DSH Desktop.app"
ls "$APP/Contents/Resources/app/node_modules/@hyzyn/dsh-codegraph/package.json"   # 应存在
ls "$APP/Contents/Resources/app/node_modules/dsh-better-sidebar/package.json"     # 应存在
```

**第二步：headless 验证「新建 Profile 会自动预置，且全部从安装目录解析」。**

```bash
node --input-type=module -e "
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensureDesktopProfile, prepareDesktopProfile } from './dsh-plugin-desktop/lib/profile.js'
const home = mkdtempSync(join(tmpdir(), 'fresh-'))
ensureDesktopProfile(home)
console.log(readFileSync(join(home, 'profiles', 'desktop', 'package.json'), 'utf8'))
for (const layer of prepareDesktopProfile(undefined, home, 'darwin').profile.layers) {
  console.log('resolved:', layer.packageName, '<-', layer.packageDir)
}
"
```

判定标准：

1. 打印出的 `dsh.profile.bundles` 含全部默认插件名；
2. `dependencies` 仍是 `{}` —— 说明没有走联网安装；
3. 每行 `resolved:` 的路径都指向 `dsh-plugin-desktop/node_modules/...`，**不是**临时 home 下的 profile。

**第三步（最终确认）：关掉 Wi-Fi，启动真实应用。**

新 Profile 首次启动应当照常进入界面，并且「设置 → 插件」里能看到这些插件——它们的状态是「可禁用、不可卸载」，因为它们属于安装包而不是 Profile 自己装的。

---

## 7. 改名：让自定义客户端与原版并存

如果你想在本机同时保留官方版和你的定制版，**必须改名**——而且只把 `.app` 拖成别的名字是**没用的**。

### 7.1 为什么光改文件名不行

三处身份都绑在 `product-identity.ts` 上：

| 绑定关系 | 代码位置 | 只改文件名的后果 |
|---------|---------|----------------|
| userData 目录 = `~/Library/Application Support/<productName>` | `src/bin.ts:60-64`，用 `DESKTOP_PRODUCT_NAME` **显式**算出 | 两个应用共用同一份设置目录 |
| 单实例锁 = 基于 userData 路径 | `src/main.ts:384` 的 `requestSingleInstanceLock()` | 打开定制版会直接聚焦回官方版的窗口，**等于没装上** |
| Profile 目录 = `~/.dsh/profiles/<profileName>` | `product-identity.ts` → `DESKTOP_PROFILE_NAME` | 两个应用共用同一套启用插件 |

### 7.2 最小改动清单

以「`DSH Desktop Evo` / `ai.deepseek.dsh.desktop.evo` / profile `desktop-evo`」为例：

```ts
// dsh-plugin-desktop/src/product-identity.ts（两个变体各一份，此文件允许不同）
stable: Object.freeze({
  releaseChannel: 'stable' as const,
  packageName: 'dsh-plugin-desktop',
  productName: 'DSH Desktop Evo',          // ① 改名
  appId: 'ai.deepseek.dsh.desktop.evo',    // ② 换 bundle id
  profileName: 'desktop-evo',              // ③ 换 Profile 名
}),
```

```jsonc
// dsh-plugin-desktop/package.json 的 build
{
  "appId": "ai.deepseek.dsh.desktop.evo",
  "productName": "DSH Desktop Evo",
  "nsis": { "shortcutName": "DSH Desktop Evo" }
}
```

另外两处会被门禁卡住，必须一起改：

- `dsh-plugin-desktop/scripts/verify-mac-smoke.ts` → `defaultOptions()` 的 `productName`（它靠这个名字去找 `.app`）
- 测试里的硬编码：`bin.spec.ts`、`package.spec.ts`、`plugin.spec.ts`、`profile.spec.ts`、`desktop-plugins.spec.ts`、`profile-manager.spec.ts`、`desktop-data-directory.spec.ts`

> **正确做法是把测试改成引用常量**（`DESKTOP_PRODUCT_NAME` / `DESKTOP_PROFILE_NAME` / `DESKTOP_APP_ID`），而不是替换字面量——否则下次改名又要重来一遍。

改完必跑：

```bash
source .build-cache/env.sh
corepack yarn build && corepack yarn typecheck
corepack yarn workspace dsh-plugin-desktop test
corepack yarn workspace dsh-plugin-desktop-beta test
node scripts/verify-desktop-variants.mjs     # 两个变体必须仍然对齐
```

### 7.3 会变什么、不会变什么

| 项目 | 是否变化 | 说明 |
|------|---------|------|
| `.app` 名称、bundle id | ✅ 变 | 与官方版彻底隔离 |
| userData 目录 | ✅ 变 | 全新目录 → 会重走一次首次设置向导 |
| Profile 目录 | ✅ 变 | 首次启动自动创建并预装默认插件 |
| `~/.dsh/.credentials.yaml` | ❌ 不变 | API key 仍共用，**不用重新登录** |
| `~/.dsh/sessions` / `storages` | ❌ 不变 | 会话历史、cost-meter 账本仍共用 |
| Web 端口 | ❌ 默认都从 43120 起 | 有 `DESKTOP_WEB_PORT_RETRY_LIMIT = 32`，第二个实例会自动退让到 43121+，可以同时运行 |
| UI 文案里的 "DSH Desktop" | ❌ 不变 | 这些是源码字面量（约 32 个文件），属于品牌化，另做 |

### 7.4 安装并验证

```bash
DMG="dsh-plugin-desktop/dist/mac-smoke/DSH Desktop Evo-2.0.10-universal.dmg"
hdiutil attach "$DMG" -nobrowse -quiet
cp -R "/Volumes/DSH Desktop Evo 2.0.10-universal/DSH Desktop Evo.app" /Applications/
hdiutil detach "/Volumes/DSH Desktop Evo 2.0.10-universal" -quiet
xattr -dr com.apple.quarantine "/Applications/DSH Desktop Evo.app"
open -a "/Applications/DSH Desktop Evo.app"
```

判定标准：

```bash
# 1) 两个应用并存，官方版没被动过
ls -d /Applications/DSH*.app

# 2) 新应用有自己的 userData
ls -d ~/Library/Application\ Support/DSH\ Desktop*

# 3) 新应用创建了自己的 Profile 并预装了插件
cat ~/.dsh/profiles/desktop-evo/package.json
#    → dsh.profile.bundles 含 8 个插件，dependencies 为 {}
```

**首次启动会显示设置向导、Web 服务还没监听——这是正常的**：`desktopSetupWizardRequired()` 在向导状态缺失时返回 `true`，新 userData 必然缺失。走完向导后 Web 界面才会起来。

## 8. 内置 codegraph CLI（应用内 + 终端都能用）

`@hyzyn/dsh-codegraph` 依赖一个**外部命令行工具** `codegraph`，通常靠 `npm install -g @colbymchenry/codegraph` 安装。离线机器没有网络，装不了——所以改成随安装包内置。

**已完成（macOS）。** 详细原理、Windows 方案与实施记录见 `docs/bundle-codegraph-cli.zh.md`。

### 8.1 一句话原理

上游把真货做成**按平台分发的可选依赖**（`@colbymchenry/codegraph-darwin-arm64`，278 MB 解压 / 55 MB tgz），**自带 Node 运行时**——所以离线机器**连 Node 都不用装**。

### 8.2 三条链路

| 链路 | 做法 | 生效范围 |
|------|------|---------|
| 进安装包 | `build.extraResources` → `Contents/Resources/codegraph/` | — |
| 应用内可用 | `installDesktopCodegraphRuntime()` 把 `.../codegraph/bin` **前置**到 Host 的 PATH | MCP 行、插件自身的 CLI 调用，**不改任何 YAML** |
| 终端可用 | `~/.dsh/bin/codegraph` shim + `~/.zshrc` 里一行 PATH | 你自己开的终端 |
| 终端可用（Windows） | `%USERPROFILE%\.dsh\bin` 里的 `.cmd` 转发 shim + 注册表 PATH | 你自己开的终端 |

### 8.3 为什么不用改配置文件

`@hyzyn/dsh-codegraph` 只改写托管 MCP 行的 `cwd`，**`command` 字段是用户自有的**。所以让 `command: codegraph` 继续靠 PATH 解析即可，不需要把它改成绝对路径。

### 8.4 增删 / 换版本

```bash
# 换版本：重新 vendor + 改文件名里的版本号
source .build-cache/env.sh
npm pack @colbymchenry/codegraph-darwin-arm64@<新版本> --pack-destination vendor/codegraph
rm vendor/codegraph/colbymchenry-codegraph-darwin-arm64-<旧版本>.tgz
node scripts/prepare-codegraph.mjs        # 会因 tgz 变了而重新解压
```

`prepare-codegraph.mjs` 用 tgz 的 sha256 做幂等判断，所以换了 tgz 会自动重解压。

### 8.5 卸载 shell 集成

应用会写两样东西，都可以手工撤销：

```bash
rm ~/.dsh/bin/codegraph
# 再删掉 ~/.zshrc 里这三行（带标记）
#   # >>> dsh-desktop codegraph >>>
#   export PATH="$HOME/.dsh/bin:$PATH"
#   # <<< dsh-desktop codegraph <<<
```

改动前应用会自动备份成 `~/.zshrc.dsh-backup-<时间戳>`。

### 8.6 已知限制

| 限制 | 说明 |
|------|------|
| 只内置了 **arm64** | 通用 DMG 的 Intel 切片里也有这份包，但运行时**检测到架构不匹配会跳过**（不会发布一个跑不了的命令）。要在 Intel 上可用需再 vendor `darwin-x64` |
| Windows 未完成 | tgz 已 vendor、prepare 脚本已支持，但 NSIS 写注册表 PATH 的部分需要原生 Windows 主机验证 |
| 未签名 | 包内 `node` 是 115 MB 的 Mach-O。以后若走 `dist:mac` 签名路线，需要额外 entitlements（JIT 相关） |

## 9. 更换默认外观（dream-skin）

新机器首次打开时看到的皮肤和壁纸，来自随包分发的一份**状态快照**。

### 9.1 原理

`dsh-dream-skin` 把权威状态放在 `$DSH_HOME/dream-skin.json`（宿主侧文件）。
它的宿主侧读不到该文件时返回 `{}`，浏览器侧才回落到插件自带的出厂外观（星云皮肤）。

所以：**让这个文件在首次运行时就已经存在**，新用户看到的就是你要的样子。

应用启动时（Host 起来之前）执行 `seedDesktopDreamSkin()`：
**仅当 `~/.dsh/dream-skin.json` 不存在**才从随包的快照写入，已存在则完全不动。

### 9.2 换成你自己的图片

1. 在应用里把皮肤、壁纸、透明度都调成想要的样子
2. 确认落盘：
   ```bash
   ls -l ~/.dsh/dream-skin.json
   ```
3. 生成新快照并同步到两个变体：
   ```bash
   corepack yarn appearance:refresh
   ```
   它读 `$DSH_HOME/dream-skin.json`（默认 `~/.dsh/dream-skin.json`），排除
   `wallpaper-history`，把结果写入 stable 和 beta 两个 `build/dream-skin-default.json`，
   并回显各透明度值便于核对。用别的文件加 `--from <path>`。
4. 重新打包并**在全新机器上验证**（本地 `~/.dsh/dream-skin.json` 已存在，会走「保留用户值」分支，验不出来）

> 两个变体的快照必须**逐字节一致**：`seedDesktopDreamSkin()` 原样拷贝快照内容，而
> stable 与 beta 的安装包各自带一份，所以脚本一次性写两处。

### 9.3 首次启动的出厂播种（透明度「看着不对」的来源）

插件的浏览器侧有它**自己的一套出厂外观**，而且**在宿主状态到达之前**就会应用：

| 键 | 插件出厂默认 | 对应界面 |
|---|---|---|
| `composer-opacity` | `0.85` | 输入框 |
| `modal-opacity` | `0.94` | 弹窗与选项卡 |
| `wallpaper-opacity` | `0.8` | 壁纸 |

原因是 localStorage 按 **origin** 隔离，而桌面版**每次启动都换随机端口**（`port: 0`），
所以每次启动 localStorage 都是空的。插件据此认为「首次运行」，先把出厂值写上，之后
宿主状态（`dream-skin.json`）到达再覆盖它。

插件把这批出厂值标记为**临时**（`factorySealed`），durable 的宿主值会胜出，因此
**最终值以快照为准**；但在状态到达之前会短暂显示出厂透明度。快照里**没有**、
而插件出厂默认里**有**的键最容易被察觉。

**结论**：想让某个外观值稳定生效，就把它**明确写进快照**，不要依赖插件默认值。
如果你观察到的是「启动一段时间后仍然不对」，那属于另一个问题，不能靠这份快照解释，
需要单独定位。

### 9.4 注意

- 快照是**纯数据**，不含代码；用插件自己的扁平键值格式（键名带 `dsh-dream-skin:` 前缀）
- 文件权限 `0o600`，与插件自身的写入一致（里面是你自己的壁纸图片）
- `~/.dsh/dream-skin.json` **跨应用变体共享**，同机的官方版会共用这份外观

---

## 10. 常见错误速查


| 现象 | 原因 | 处理 |
|------|------|------|
| `EPERM: mkdir '~/.cache/node/corepack'` | Corepack 要写用户目录 | 设置 `COREPACK_HOME`（见 2.2） |
| `EPERM: mkdir '~/.yarn'` | Yarn 全局目录 | 设置 `YARN_GLOBAL_FOLDER` |
| `EPERM: mkdir '~/Library/Caches/electron'` | Electron 下载缓存 | 设置 `ELECTRON_CACHE` |
| Electron 下载极慢/超时 | 默认走 GitHub | 设置 `ELECTRON_MIRROR` |
| `verify-layout: cannot read deepseek-harness/package.json` | 子模块未初始化 | `git submodule update --init --recursive`，或只跑 `dist:mac-smoke`（它不含 `check:layout`） |
| `aa:prepare-release` 卡住 | 默认对 GitHub 发 `git ls-remote` | 设置 `DSH_AA_SOURCE_REF=pinned` |
| `Windows ... must be built on a native Windows host` | 在 macOS 上跑 `dist:win` | 见第 5 章 |
| `verify-desktop-variants` 报源文件漂移 | 只改了 stable 的 `src/` | 把改动同步到 `dsh-plugin-desktop-beta/src/` |
| `verify-licenses` 报某包不在白名单 | 该依赖许可证不可再分发 | 换版本、剔除该插件，或（若为 `A OR B` 双许可）走析取求值 |
| `packaged runtime ... is missing required physical entries: lib/.DS_Store` | Finder 在源码目录里留下了 `.DS_Store`，而 electron-builder 会过滤掉它，导致校验清单对不上 | `find dsh-plugin-desktop dsh-plugin-desktop-beta dsh-community-market -name .DS_Store -not -path "*/node_modules/*" -not -path "*/dist/*" -delete` |
| 应用启动后少了某个预装插件 | ① 不是新建的 Profile；② 或只改了一条创建路径 | 见 6.2.1；删掉 `~/.dsh/profiles/<profileName>` 重建 |
| 装了定制版但打开的是官方版窗口 | 只改了 `.app` 文件名，userData/单实例锁没变 | 见第 7 章 |
| 构建报 `not covered by the x64ArchFiles rule` | 新增的原生文件在两个切片里相同但未声明 | 加进 `build.mac.x64ArchFiles`（见 8 章与 `docs/bundle-codegraph-cli.zh.md`） |
| 终端里 `codegraph` 指向 nvm/Homebrew 那份 | PATH 是 prepend，但可能有多份 | `which codegraph` 确认；想反过来就把 `~/.zshrc` 那行改成 append |

---

## 11. 一页命令速查

```bash
source .build-cache/env.sh                     # 每条命令前都要

corepack yarn install --immutable              # 安装
corepack yarn build                            # 编译
corepack yarn typecheck                        # 类型检查
corepack yarn dev                              # 本地运行
corepack yarn test                             # 全部单测

corepack yarn plugins:list                     # 查看预装插件清单与一致性
corepack yarn plugins:add dsh-foo@1.2.3        # 加入预装（体检 + 改 4 处 + 门禁）
corepack yarn plugins:add --from-dir /path/to/local-plugin   # 本地未发布的插件
corepack yarn plugins:remove dsh-foo           # 移出预装

corepack yarn workspace dsh-plugin-desktop dist:mac-smoke   # macOS DMG（未签名）
corepack yarn workspace dsh-plugin-desktop dist:mac         # macOS DMG（需证书+公证）
node scripts/verify-desktop-variants.mjs                    # 双变体一致性
```

---

## 12. 关键文件地图

| 文件 | 作用 |
|------|------|
| `dsh-plugin-desktop/src/product-identity.ts` | **产品名 / appId / Profile 名 / 默认插件清单**。双变体唯一允许不同的源文件，所有「两个变体必须各有一套」的常量都放这里 |
| `dsh-plugin-desktop/src/profile-manager.ts` | **真实启动时的 Profile 选择与创建**（`beginDesktopProfileStartup`、`createDesktopWebProfile`）。默认插件必须在这里也注入 |
| `dsh-plugin-desktop/src/profile.ts` | Profile 修复/兜底创建、启动 patch 组合；`DESKTOP_PROFILE_NAME` 与 `DEFAULT_PROFILE_PLUGIN_BUNDLES` 从 `product-identity.ts` 转出 |
| `dsh-plugin-desktop/src/package-overlay.ts` | 安装目录 vs Profile 的包解析与选择规则（离线预装的机制基础） |
| `dsh-plugin-desktop/src/desktop-plugins.ts` | 「设置 → 插件」的清单与禁用状态 |
| `dsh-plugin-desktop/src/setup-wizard-state.ts` | 首次设置向导触发条件；全新 userData 必然触发 |
| `dsh-plugin-desktop/src/bin.ts` | 用 `DESKTOP_PRODUCT_NAME` 算出 userData 目录（改名时必须一起改） |
| `dsh-plugin-desktop/package.json` 的 `build` | Electron Builder 配置（appId、productName、目标平台、图标、NSIS） |
| `dsh-plugin-desktop/scripts/package-mac.ts` | macOS smoke 打包入口 |
| `dsh-plugin-desktop/scripts/verify-mac-smoke.ts` | 挂载 DMG 校验 plist/可执行位/双架构；**默认应用名写死在这里** |
| `dsh-plugin-desktop/scripts/package-win.ts` | Windows 打包入口（含 win32 硬断言） |
| `dsh-plugin-desktop/scripts/verify-licenses.mjs` | 可再分发许可证审计（含 SPDX 析取求值） |
| `dsh-plugin-desktop/scripts/verify-profile-boot.mjs` | Profile/Host 启动 smoke（会真的挂载插件） |
| `scripts/verify-desktop-variants.mjs` | 双变体源码一致性门禁 |
| `scripts/prepare-codegraph.mjs` | 把 vendor 的 CodeGraph 平台包解压到 `build/codegraph/host`，供 `extraResources` 使用 |
| `dsh-plugin-desktop/src/desktop-codegraph-shell.ts` | macOS：写 `~/.dsh/bin/codegraph` shim 与 `~/.zshrc` 标记块（幂等/备份/可逆） |
| `scripts/preinstall-plugins.mjs` | **增删默认预装插件**：list / verify / add / remove，自动同步两个变体的 4 个文件 |
| `.github/workflows/ci.yml` | 三平台 CI（含 Windows 打包，但没有产物上传） |
