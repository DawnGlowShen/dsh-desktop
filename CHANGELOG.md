# 变更记录

本仓库是 [anywhere-labs/dsh-desktop](https://github.com/anywhere-labs/dsh-desktop) 的**个人定制版**。

**这里只记录本仓库相对上游的改动**；上游自身的变更请查阅上游仓库的提交历史。同步上游的方式见文末。

> 基线：`0a9433fafc`（上游 2.0.10）
> 本文档为中文；README 的双语校验（`README.i18n.yaml`）不覆盖本文件。

---

## [未发布] — 2026-09-18

### 新增

**改名做并存安装**

- 产品身份收敛到 `dsh-plugin-desktop/src/product-identity.ts`，成为唯一来源：
  | 项 | 值 |
  |---|---|
  | 产品名 | `DSH Desktop Evo` |
  | appId | `ai.deepseek.dsh.desktop.evo` |
  | Profile 名 | `desktop-evo` |

- 改名不只是换个 `.app` 文件名：userData 目录由 `DESKTOP_PRODUCT_NAME` 算出（`src/bin.ts`），
  而单实例锁 `app.requestSingleInstanceLock()` 又基于 userData。三者都改才能真正与官方版并存。

**默认插件离线预装（7 个）**

全新安装后新建的 Profile 直接启用以下插件，**首次启动零网络、零 pnpm install**：

| 插件 | 版本 | 许可证 | 来源 |
|------|------|--------|------|
| `@edan/edan-spec` | 1.0.0 | MIT | vendor tarball（未发布到 npm） |
| `@huanlin/dsh-plugin-better-sidebar-plugin-office` | 0.2.0 | **AGPL-3.0** | npm |
| `@hyzyn/dsh-codegraph` | 0.2.2 | MIT | npm |
| `@linxin666/dsh-client-ui-git-graph` | 0.3.22 | MIT | npm |
| `dsh-better-sidebar` | 0.19.1 | MIT | npm |
| `dsh-dream-skin` | 9.16.0 | MIT | npm |
| `dsh-session-manager` | 0.4.11 | MIT | npm |

相对上一版清单的调整：**移除** `@mars-sea/dsh-commandcode-provider` 与 `dsh-cost-meter`，
**新增** `@huanlin/dsh-plugin-better-sidebar-plugin-office`。

原理：让**安装包**（而非 Profile）拥有这些包，`dependencies` 保持为 `{}`，
启动时直接从安装目录解析。若把包名写进 Profile 的 `dependencies`，会触发 `pnpm install` 而需要联网，
离线预装就失去意义。

**构建产物的命名与发布**

- Windows 产物名改为 `DSH-Desktop-Evo-*`。原先的 `artifactName` 是写死的
  `DSH-Desktop-` 前缀，与产品名无关，和 beta 的 `DSH-Desktop-Beta-` 混在一起难以分辨

  这个前缀同时硬编码在 `verify-win-installer.ts`、`verify-win-portable.ts`、
  `build-windows-nsis-ab.ts` 三个脚本里——**改漏任何一处都会让 Windows 打包失败**
  （校验器找不到文件，报 exit 1），和之前「改名漏改校验脚本」是同一类问题。
  现统一由 `product-identity.ts` 的 `DESKTOP_ARTIFACT_STEM` 提供，
  `tests/package.spec.ts` 断言它与 `package.json` 保持一致。

- CI 不再打包 **beta** 变体（`desktop-windows` / `desktop-macos` 的 matrix 只留 stable）。
  beta 的源码仍由 `check` job 完整测试，`verify-desktop-variants` 也仍然约束两个变体
  的 `src/` 逐字节一致——这里省掉的只是重复的打包开销。

- macOS 的 DMG 现在也会**上传并发布**。此前 `desktop-macos` 没有上传步骤，
  而 `publish` 只依赖 `desktop-windows`，所以 DMG 打完就随 runner 销毁了。

  同时给 stable 补上 `mac.artifactName`，让 DMG 由 electron-builder 的默认名
  `DSH.Desktop.Evo-2.0.10-universal.dmg`（空格被替换成点号）变成与 Windows 一致的
  `DSH-Desktop-Evo-2.0.10-universal.dmg`。

- 发布的组织方式：**一个滚动入口 + 保留最近 2 个版本化 release**

  | tag | 作用 |
  |---|---|
  | `evo-latest` | 滚动更新，永远指向最新构建，给一个不变的下载地址 |
  | `evo-<版本>-<短SHA>` | 每次构建一个，如 `evo-2.0.10-2d64f7d1`，留存历史与**全部资产** |

  短 SHA 是必需的：包版本不会每次推送都变，两次构建不能同名。

  **资产只存在版本化 release 里。** 滚动入口与最新那个版本化 release 是同一次构建、
  同一批文件，两边都放就是白占一份。所以 `evo-latest` 不带资产，只在说明里给出指向
  当前构建文件的直链——点一下直接下载，比在资产列表里翻更快。

  | | 占用 |
  |---|---|
  | 滚动入口（无资产） | 0 |
  | 版本化 release × 2 | 约 2 GB |
  | **稳定态合计** | **约 2 GB** |

  滚动入口每次会**移动 tag**（否则 GitHub 自动生成的 Source code 快照会停在首次创建
  的提交上，此前实测指向了纯净的上游 `0a9433fafc`）、**删掉可能残留的旧资产**
  （从「带资产」改成「不带资产」时清一次），并**刷新标题与说明**——标题原本只在首次
  创建时写过一次，于是它长期写着「Windows 构建」，而资产里早就有 macOS 的 DMG。

  版本化 release 只保留最近 2 个，更早的连同 tag 一起删除——每个约 1 GB
  （Setup 211 MB + 便携版 382 MB + universal DMG 448 MB），不设上限仓库会持续膨胀。
  保留数量由 `KEEP` 环境变量控制。

  > Source code (zip/tar.gz) 是 GitHub 对每个 Release **自动附加**的，无法移除；
  > 能做的只是让它指向正确的提交（`gh release create --target`）。

  > **`cancel-in-progress: true` 意味着连续快推会互相取消。** 同一分支上新的推送会
  > 取消正在跑的旧 run。此前四个提交在十分钟内连着推，前三个的 publish 因此从未执行
  > ——发布逻辑看起来「失效」，实际是压根没跑，而当时已经准备好按错误结论去改一段
  > 正确的代码。改发布流程要一次推一个、等 CI 跑完再推下一个。

- 版本化 release 的名字带短 SHA，每次都是全新的，所以不存在 `--clobber` 只覆盖同名
  文件的问题。产物改名（`DSH-Desktop-` → `DSH-Desktop-Evo-`）曾让旧名字的文件留在
  滚动 release 上，看起来像当前版本；现在滚动入口不存资产，这个问题从根上消失。
  同时移除 `custom` 分支时代的遗留 release `custom-final`（幂等，删过一次即为无操作）。

**内置 dream-skin 默认外观**


`dsh-dream-skin` 的权威状态是 `$DSH_HOME/dream-skin.json`（宿主侧文件，因为 Electron
每次启动换随机端口导致 origin 变化、localStorage 会「失忆」）。插件的宿主侧**不提供**
配置这两个内置默认的途径，但 `readState()` 在**文件不存在时返回 `{}`**，浏览器侧才回落到
它自己的出厂外观。

于是做法是：把一份调好的状态作为**快照**随包分发（`build/dream-skin-default.json`），
应用首次启动时**仅当该文件不存在**才写入。只用插件自己的格式，不 patch 插件，
插件升级不受影响。

- 快照用**紧凑格式**（插件原样拷贝这份 JSON，缩进只会让文件白白变大），并剔除
  `wallpaper-history` —— 那是历史记录而不是设置，动辄几百 KB 到 1 MB。
- 生成是**一条命令**：`corepack yarn appearance:refresh`
  （`scripts/prepare-dream-skin-default.mjs`）。它读 `$DSH_HOME/dream-skin.json`、
  剔除历史记录、**一次写入 stable 与 beta 两处**，并回显各透明度值便于核对。

  > 此前这一步是文档里的一段手工 python，而且只写 stable 一个变体。后果是
  > **beta 的快照从未被提交**，而 electron-builder 对缺失的 `extraResources` 是
  > **静默跳过**的（codegraph 上踩过同一个坑），beta 包会悄悄少一份默认外观。

- **浏览器侧有它自己的一套出厂透明度**（输入框 `0.85`、弹窗 `0.94`、壁纸 `0.8`）。
  桌面版每次启动换端口、localStorage 按 origin 隔离因而每次都是空的，插件据此认为
  「首次运行」，会在**宿主状态到达之前**先应用这套出厂值，随后才被 `dream-skin.json`
  覆盖。最终值仍以快照为准；但想让某个值稳定生效，就要把它**明确写进快照**，
  不要依赖插件默认值。

- 两个变体的快照必须**逐字节一致**：`seedDesktopDreamSkin()` 原样拷贝快照内容，
  而 stable 与 beta 的安装包各自带一份。

> `~/.dsh/dream-skin.json` 与 `credentials.yaml` 一样位于 `DSH_HOME` 下，
> **跨应用变体共享**。同一台机器若同时装了官方版，两者会共用这份外观设置。

**⚠️ 许可证政策的两处放行（需要知悉）**


本 fork 相对上游放宽了 `verify-licenses.mjs` 的可再分发判定，两处都属于**有意决定**而非疏漏：

1. **`AGPL-3.0` 改为 notice-required**（不再拒绝）。
   AGPL 授予再分发权，只是附带条件（源码可得）。本仓库公开、依赖也从公开 npm 获取，义务已满足。
2. **`@univerjs-pro/*` 整个命名空间豁免**（27 个包）。
   这些包**没有任何许可证声明**，包内也无 LICENSE 文件；而同命名空间的 `@univerjs/*`
   73 个包中有 72 个声明 Apache-2.0，且存在专门的 `@univerjs-pro/license` 包，
   所以这个「零声明」看起来是刻意的，Univer Pro 属于其商业层。

   > **法律上，「没有许可证」不等于「可以自由使用」——默认是保留所有权利。**
   > 打包这些包并公开分发由本仓库作者自行决定并承担相应风险。
   > 若日后做商业分发，必须先向 Univer 确认 Pro 层的授权条款。

门禁会把这两类**分别打印出来**，不会静默通过：

```
verify-licenses: 921 production packages checked; 3 use notice-required licenses (AGPL-3.0, LGPL-3.0-or-later)
verify-licenses: 27 package(s) accepted without a license declaration (@univerjs-pro)
```

顺带修正：`licenseExpression` 现在会剥掉 SPDX 表达式里的括号，因此 `pako` 的
`(MIT AND Zlib)` 能与白名单里的 `MIT AND Zlib` 匹配（此前因括号导致误判）。

**内置 codegraph CLI**


`@hyzyn/dsh-codegraph` 依赖外部命令 `codegraph`，原本要用 `npm install -g @colbymchenry/codegraph`
安装——离线机器做不到。现在随安装包分发：

- 平台包**自带 Node 运行时**，所以离线机器**连 Node 都不用装**
- 应用内：把包内 `codegraph/bin` 前置到 Host 的 PATH，**不改任何配置文件**
- 用户终端（macOS）：写 `~/.dsh/bin/codegraph` shim 与 `~/.zshrc` 标记块
- 用户终端（Windows）：**NSIS 安装器**把 `<安装目录>\resources\codegraph\bin` 写进用户 PATH

两个平台的终端集成走不同路径，原因在安装方式：DMG 拖进 `/Applications` 就是全部流程，
没有钩子可用，只能首次启动写 shell profile；NSIS 安装器有钩子，所以 Windows 在安装时就写
`HKCU\Environment` 的 `Path`。此前 Windows 侧完全没有这一步——应用自己能用 codegraph，
用户自己开的终端不行。

`build/installer.nsh` 里新增的两个宏：

| 宏 | 行为 |
|---|---|
| `customInstall` | 确认 CLI 确实随包分发后追加到用户 PATH |
| `customUnInstall` | 条目仍在末尾时移除 |

- **只写 HKCU**：`perMachine: false`，写用户级不需要管理员权限，也不影响其他账号
- **写入前用 `${StrContains}` 查重**：升级安装会在同一目录上再跑一次，不查重就会不断追加
- **用 `WriteRegExpandStr`**：保持 `REG_EXPAND_SZ`，否则用户 PATH 里原有的 `%USERPROFILE%` 会被固化成字面路径
- **写完广播 `WM_SETTINGCHANGE`**：让之后启动的进程看到新值
- **卸载只在条目仍是最后一个时才移除**：用户调整过顺序就不动，宁可留一个指向已删目录的条目（Windows 会跳过），也不冒改坏 PATH 的风险

> 已经开着的终端需要重开：Windows 在进程启动时读取环境变量。
> 便携版 ZIP 做不到：electron-builder 对 portable 目标不注入自定义 include（`if (!this.isPortable)`），
> 而且便携版没有安装流程。

**开发工具**

- `scripts/preinstall-plugins.mjs` — `list` / `verify` / `add` / `remove`，一条命令同步两个变体的 4 个文件
- `scripts/prepare-codegraph.mjs` — 按主机解压 vendor 的平台包
- `scripts/build-env.ps1` — Windows 侧构建环境

### 变更

- `dsh-session-manager` 的声明从 `github:hkkz9522/dsh-session-manager` 换成 npm `0.4.11`，
  构建期不再需要 git 网络
- `@edan/edan-spec` 的声明从本机绝对路径 `file:/Users/...` 换成仓库内相对路径，
  否则安装包在别人机器上无法解析
- `dsh-plugin-desktop/package.json` 的 `build.appId` / `productName` / `nsis.shortcutName` 同步改名
- 测试里的硬编码 `'desktop'` / `'DSH Desktop'` 改为引用 `product-identity.ts` 的常量

### 修复

- **`profile-manager.ts` 的 `DEFAULT_PROFILE_NAME` 漏改** — 代码里有两条 Profile 创建路径，
  全新安装走的是 `profile-manager.ts` 那条。只改 `profile.ts` 会导致
  「用临时目录直测通过、真机全新安装一个插件都不预装」。两条路径现在都注入默认清单
- **`verify-licenses.mjs` 的 SPDX 双许可误判** — `dompurify` 的
  `(MPL-2.0 OR Apache-2.0)` 被字符串精确匹配判为不可再分发。
  已加入析取（OR）求值：任一分支在白名单即通过；`AND` 表达式仍严格匹配
- **`x64ArchFiles` 未声明导致 universal 打包失败** — `extraResources` 让两个切片
  拿到相同内容，`@electron/universal` 对「两切片相同但未声明的原生文件」会报错
- **Windows 校验脚本写死了应用名** — 改名时更新了 macOS 的 `verify-mac-smoke.ts`，
  却漏了 `verify-win-installer.ts` 与 `verify-win-portable.ts`。它们仍写死
  `'DSH Desktop.exe'`，而改名后产物名已经不同；校验器在
  electron-builder 之后运行，找不到文件就报错，`dist:win` 的
  「Build Windows installer」因此失败。beta 没暴露这个问题，只是因为它的字面量
  恰好和自己的产品名一致。四处与测试夹具现在都引用 `DESKTOP_PRODUCT_NAME`
- **`prepare-codegraph.mjs` 写死了工作区** — 路径硬编码为 `dsh-plugin-desktop`，
  而两个变体都从各自工作区调用它、`extraResources` 也各自相对于自己的目录。
  结果是 beta 的安装包**静默地没有 codegraph CLI**（源目录从未生成，
  electron-builder 不报错直接跳过）。改为按调用方目录解析并校验
- **`verify-licenses.mjs` 的 LICENSE 查找依赖文件系统大小写** — 用 `existsSync`
  精确探测 `LICENSE`，等于把答案交给文件系统：`khroma@2.1.0` 附带的许可证文件是
  小写 `license`，于是同一个 gate 在 macOS（APFS 不区分大小写）通过、在 Linux CI 失败。
  改为列出目录后自行按名字匹配

### 未完成 / 已知限制

| 项 | 状态 |
|---|---|
| Windows 终端 PATH | **未实施。** 需在 NSIS 安装钩子写 `HKCU\Environment`，只能在真实 Windows 主机上验证；盲写注册表 PATH 风险过高 |
| 只内置 arm64 | 通用 DMG 的 Intel 切片里也有这份包，但运行时检测到架构不匹配会**跳过**，不会发布跑不了的命令。要在 Intel 上可用需再 vendor `darwin-x64` |
| 上游同步 | **尚未同步。** 本地落后上游 39 个提交（2.0.10 → 2.0.13），详见文末 |
| 代码签名 | 未签名。包内 `node` 是 115 MB 的 Mach-O，若日后走签名路线需额外 entitlements（JIT 相关） |
| 排除的插件 | `@huanlin/dsh-plugin-better-sidebar-plugin-office` 为 **AGPL-3.0**，不在可再分发白名单内，未预装 |

### 验证

macOS 侧已在真机完成端到端验证：

```
DMG 体积          338 MB → 392 MB（+54 MB）
包内 CLI 独立运行  空 PATH ✓ / 真离线沙箱 ✓
终端可用          zsh -i -c 'codegraph --version' → 1.6.0
~/.zshrc          备份与原文件逐字节一致；重启幂等（标记数、备份数、文件哈希均不变）
新 Profile        10 个 bundle（base + web-app + 8 插件），全部从安装包解析
单测              stable 1379 passed / beta 1365 passed
门禁              typecheck / verify-desktop-variants（183 文件）/ licenses / closure / layout 全通过
```

Windows 侧通过 GitHub Actions 构建（`desktop-windows` job，两个变体各产出
`Setup.exe` 与便携版 ZIP），**尚未在真实 Windows 上验证**。

CI 全绿：`changes` / `check`（ubuntu）/ `upstream` / `desktop-windows` ×2。

---

## 与上游同步

本仓库采用「`master` 保持纯净 + `custom` 承载定制」的模型：

| 分支 | 内容 | 同步方式 |
|------|------|---------|
| `master` | **只放上游代码，不含任何本地改动** | 快进，随时 |
| `custom` | 全部定制（即上述改动） | 按需 rebase |

`master` 保持纯净是为了让同步永远是**零冲突快进**。一旦 master 上有了本地提交，
「随时同步上游」这件事就永久失去了。

```bash
# 同步上游（master 零风险）
git fetch upstream
git checkout master
git merge --ff-only upstream/master
git push origin master
```

定制分支按需 rebase：

```bash
git checkout custom
git rebase upstream/master
```

`custom` 按**文件归属**拆成 5 个提交，每个文件只属于一个提交，因此 rebase 时
每个文件的冲突只需解决一次；若上游原生实现了某一块，可以整块丢弃而不影响其它。

建议开启 `rerere` 让 git 记住冲突解法：

```bash
git config rerere.enabled true
```
