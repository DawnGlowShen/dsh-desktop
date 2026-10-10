# 变更记录

本仓库是 [anywhere-labs/dsh-desktop](https://github.com/anywhere-labs/dsh-desktop) 的**个人定制版**。

**这里只记录本仓库相对上游的改动**；上游自身的变更请查阅上游仓库的提交历史。同步上游的方式见文末。

> 基线：`0a9433fafc`（上游 2.0.10）
> 本文档为中文；README 的双语校验（`README.i18n.yaml`）不覆盖本文件。

---

## [未发布] — 2026-10-09

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

**Linux 产物命名与维护者**

Linux 的产物名与维护者信息此前沿用上游的值，与 Windows/macOS 的 `DSH-Desktop-Evo-*`
不一致（beta 变体为 `DSH-Desktop-Beta-*`）。本次补齐：

| 配置项 | 原值 | 新值 |
|---|---|---|
| `build.linux.artifactName` | `DSH-Desktop-${version}-${arch}.${ext}` | `DSH-Desktop-Evo-${version}-${arch}.${ext}` |
| `build.linux.executableName` | `dsh-desktop` | `dsh-desktop-evo` |
| `build.linux.maintainer` | `DeepSeek <dsh-desktop@deepseek.com>` | `jimmy <shenh1986@163.com>` |
| `build.deb.packageName` | `dsh-desktop` | `dsh-desktop-evo` |

`packageName` 必须改在**顶层 `build.deb`**：electron-builder 的 `FpmTarget` 用
`deepAssign({}, platformSpecificBuildOptions, config[this.name])` 合并，`build.deb`
（目标级）排在 `build.linux`（平台级）之后，写在 `build.linux.deb` 会被顶层覆盖而静默失效。

Linux 是首次发布，不存在已装用户被拆成两个包的升级问题，故 `deb.packageName` 一并改名。
联动同步 `scripts/verify-linux-artifacts.ts`、其 spec 与 `tests/package.spec.ts` 的期望名。

**默认插件离线预装（10 个）**

全新安装后新建的 Profile 直接启用以下插件，**首次启动零网络、零 pnpm install**：

| 插件 | 版本 | 许可证 | 来源 |
|------|------|--------|------|
| `@edan/edan-spec` | 1.0.1 | MIT | vendor tarball（未发布到 npm） |
| `@huanlin/dsh-plugin-better-sidebar-plugin-office` | 0.2.0 | **AGPL-3.0** | npm |
| `@hyzyn/dsh-codegraph` | 0.6.6 | MIT | npm |
| `@linxin666/dsh-client-ui-git-graph` | 0.4.5 | MIT | npm |
| `billion-context` | 0.1.188 | MIT | npm |
| `dsh-better-sidebar` | 0.24.1 | MIT | npm |
| `dsh-dream-skin` | 10.8.1 | MIT | vendor tarball（官方原版，未打补丁） |
| `dsh-mnemon` | 0.5.24 | MIT | npm |
| `dsh-rewind-plugin` | 0.15.1 | MIT | npm |
| `dsh-session-manager` | 0.6.2 | MIT | npm |

清单调整：**移除** `@mars-sea/dsh-commandcode-provider` 与 `dsh-cost-meter`，
**新增** `@huanlin/dsh-plugin-better-sidebar-plugin-office`。

版本更新：上一代清单把 10 个预装插件全部锁在 `0.1.5-rc.1` 时代的版本，运行时升到
`0.2.0-rc.2` 后 peer 区间不再覆盖，运行时逐一禁用它们
（`dsh: disabling profile plugin row "<name>"`），预装插件形同虚设。本次更新
`dsh-better-sidebar` → `0.24.1`、`dsh-mnemon` → `0.5.24`、`dsh-rewind-plugin` →
`0.15.1`、`@hyzyn/dsh-codegraph` → `0.6.6`、`@linxin666/dsh-client-ui-git-graph` →
`0.4.5`、`billion-context` → `0.1.188`、`dsh-session-manager` → `0.6.2`。

`dsh-dream-skin` 的 peer 自 `9.29.0` 起放宽为 `>=0.1.0-rc.6 <0.3.0-0`，故取 `10.8.1`
（`9.16.0` 的 peer 为 `^0.1.0-rc.6`，不含 `0.2.x`，会被运行时整体禁用）。该版本随包
分发改为 vendor tarball，**采用官方原版、未携带本地补丁**。

原计划是把 9.16.0 上的 188 行「侧边栏填充交接」补丁移植到 10.8.1：桌面壳在
`.dshDesktopSidebarSurface` 上直接声明 `--dsw-specific-sidebar-fill`，优先级压过插件经
`overrideTokens` 推到 `<body>` 的行内值，导致「侧边栏透明度」滑块静默失效，补丁用 inline
`!important` 赢回级联。移植在源码层面完全符合预期（3 处插入、+188/-0），但**实测破坏了
客户端（渲染器）侧的插件加载**，报 `renderer boot failed (plugins: dsh-dream-skin):
The client Loader did not provide an error message`。

对照实验（唯一变量为 `lib/client.js`）确认是移植引入：官方未打补丁的 10.8.1 渲染器正常启动，
移植版失败。故放弃补丁，回退到官方原版；**「侧边栏透明度」滑块失效的问题重新存在**。
判定与证据见 `.agents/notes/implemented/architecture/2026-10-08-dream-skin-sidebar-fill-patch-abandoned.zh.md`。

注意升级本身仍应保留：9.16.0 的 peer 不含 `0.2.x`，会被运行时整体禁用；而带补丁的 10.8.1
连插件都加载不了，比不带补丁的 9.16.0 更糟。

`@edan/edan-spec@1.0.1` 未发布 npm、无新版可升，其 peer 仍锁 `^0.1.5-rc.2`。
它只用到两处 API 且均未变更（`createUserMessage` 仍由 `dsh-llm` 导出；skill provider
经 `ctx.plugin(skillFilesystem, ...)` 整体挂载，不绑定具名导出），故改用上游的
**精确版本豁免**机制：新建 Profile 时把豁免播种到该 Profile 的 `compatibility.json`，
使其正常加载而非被禁用。升级后不兼容插件由 2 个降为 1 个，且该 1 个已被豁免加载。

原理：让**安装包**（而非 Profile）拥有这些包，`dependencies` 保持为 `{}`，
启动时直接从安装目录解析。若把包名写进 Profile 的 `dependencies`，会触发 `pnpm install` 而需要联网，
离线预装就失去意义。

**构建产物的命名与发布**

- Windows 产物名改为 `DSH-Desktop-Evo-*`。此前的 `artifactName` 是写死的
  `DSH-Desktop-` 前缀，与产品名无关，和 beta 的 `DSH-Desktop-Beta-` 混在一起难以分辨

  这个前缀同时硬编码在 `verify-win-installer.ts`、`verify-win-portable.ts`、
  `build-windows-nsis-ab.ts` 三个脚本里——**改漏任何一处都会让 Windows 打包失败**
  （校验器找不到文件，报 exit 1）。现统一由 `product-identity.ts` 的
  `DESKTOP_ARTIFACT_STEM` 提供，`tests/package.spec.ts` 断言它与 `package.json` 保持一致。

- CI 不再打包 **beta** 变体（`desktop-windows` / `desktop-macos` 的 matrix 只留 stable）。
  beta 的源码仍由 `check` job 完整测试，`verify-desktop-variants` 也仍然约束两个变体
  的 `src/` 逐字节一致——这里省掉的只是重复的打包开销。

- macOS 的 DMG 现在也会**上传并发布**。此前 `desktop-macos` 没有上传步骤，
  而 `publish` 只依赖 `desktop-windows`，DMG 打完就随 runner 销毁了。

  同时给 stable 补上 `mac.artifactName`，让 DMG 与 Windows 一致地命名为
  `DSH-Desktop-Evo-<版本>-universal.dmg`（electron-builder 的默认名会写成
  `DSH.Desktop.Evo-<版本>-universal.dmg`，空格被替换成点号）。

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
  的提交上，而不是这次构建的提交）、**删掉可能残留的旧资产**、并**刷新标题与说明**
  ——标题只在首次创建时写过一次，不会自动更新。

  版本化 release 只保留最近 2 个，更早的连同 tag 一起删除——每个约 1 GB
  （Setup 211 MB + 便携版 382 MB + universal DMG 448 MB），不设上限仓库会持续膨胀。
  保留数量由 `KEEP` 环境变量控制。

  > Source code (zip/tar.gz) 是 GitHub 对每个 Release **自动附加**的，无法移除；
  > 能做的只是让它指向正确的提交（`gh release create --target`）。

  > **`cancel-in-progress: true` 意味着连续快推会互相取消。** 同一分支上新的推送会
  > 取消正在跑的旧 run，publish 可能因此从未执行。改发布流程要一次推一个、等 CI 跑完
  > 再推下一个。

- 版本化 release 的名字带短 SHA，每次都是全新的，所以不存在 `--clobber` 只覆盖同名
  文件的问题。滚动入口不存资产，避免旧名字的文件残留在上面被误认为当前版本。
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

  > `electron-builder` 对缺失的 `extraResources` 是**静默跳过**的：只写 stable
  > 一个变体时 beta 包会悄悄少一份默认外观，构建不会报错。两个变体必须都写到。

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
`(MIT AND Zlib)` 能与白名单里的 `MIT AND Zlib` 匹配（带括号时会被判为不匹配）。

**内置 codegraph CLI**


`@hyzyn/dsh-codegraph` 依赖外部命令 `codegraph`，单独安装需要
`npm install -g @colbymchenry/codegraph`——离线机器做不到。现在随安装包分发：

- 平台包**自带 Node 运行时**，所以离线机器**连 Node 都不用装**
- 应用内：把包内 `codegraph/bin` 前置到 Host 的 PATH，**不改任何配置文件**
- 用户终端（macOS / Linux）：写 `~/.dsh/bin/codegraph` shim 与 shell profile 标记块
- 用户终端（Windows）：**NSIS 安装器**把 `<安装目录>\resources\codegraph\bin` 写进用户 PATH

三平台的终端集成走不同路径，原因在安装方式：DMG 拖进 `/Applications`、AppImage 双击挂载
都只是运行一个文件，没有钩子可用，只能首次启动写 shell profile；NSIS 安装器有钩子，
所以 Windows 在安装时就写 `HKCU\Environment` 的 `Path`。Linux 的终端集成见下文
「Linux 终端里的 CLI 命令」。

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

**Linux 终端里的 CLI 命令**


`codegraph` / `mnemon` 的终端集成此前只在 macOS 与 Windows 生效：`main.ts` 的准入条件是
`process.platform === 'darwin' || process.platform === 'win32'`，`'linux'` 不在其中，所以
Linux 上既不生成 shim、也不写 shell profile。**应用内一切正常**——宿主进程及其派生的每个
工具都能解析到这两个命令，因为 `publishDesktopCodegraphRuntime()` 不判断平台，它把包内
`bin` 目录前置进 Electron 进程自己的 PATH，`@deepseek-ai/dsh-mcp-client` 与
`@hyzyn/dsh-codegraph` 依赖的正是这一点。缺的只是**用户自己开的终端**：那边读不到
Electron 进程的 PATH，于是命令"装了却找不到"。

本次把 `'linux'` 加进准入条件，与 macOS 共用同一条 shim + profile 路径：

- **shim 目录与标记块沿用既有机制**：`~/.dsh/bin` 下的 POSIX shim，加上 shell profile 里
  一对 `# >>> dsh-desktop codegraph >>>` / `# <<< dsh-desktop codegraph <<<` 标记块
- **profile 文件按平台选**：Linux 桌面终端是**交互式非登录** shell，只读 `.bashrc`；
  写 `.bash_profile` 会让 PATH 条目在用户真正打开的那个终端里**根本不生效**。
  故 `desktopCliProfileName()` 增加 `platform` 形参：zsh 一律 `.zshrc`，bash 及
  未知/未设 shell 在 Linux 上落到 `.bashrc`，在 macOS 上仍按原样落 `.bash_profile` / `.zshrc`

  > 生产调用点显式传入真实平台；缺省回退到 `process.platform` 只对生产有意义。
  > 测试里省略它会让断言跟着**宿主**走，在 macOS 上绿、在 Linux CI 上红——见「修复」一节。

- **AppImage 的挂载点每次都变**，shim 里写的是绝对路径，因此应用退出后 shim 即失效。
  但每次启动都会重写（仅当内容与目标不一致时才写），所以对用户始终有效。
  `.deb` 与 Windows 安装器不同，无法预知用户把 AppImage 放在哪里，不做安装期写入。

**`@edan/edan-spec` 升到 1.0.1（修复 v4 拒绝裸 `kind:'plugin'`）**


插件用 `const SOURCE = { kind: 'plugin', plugin: name }` 作为注入 AGENTS.md baseline 的
消息来源，而 **Session format v4 明确拒绝该值**：`dsh-session-format-v3-to-v4/src/message-sources.ts:9`
的 `source()` 把 `value['kind'] === 'plugin'` 与「无 kind / 空 kind」**并列判为非法**，抛
`format v4 message requires a producer-owned source kind`；同文件 `assertV4SourceRowAdmission()`
对已落盘的畸形行**再次拒绝**，因此旧会话同样受影响。

v4 的模型是「**kind 答"谁生产"，form 答"什么形态"**」——上游没有共享的 catch-all `plugin`
（`llm/src/message.ts:106` 注释），既有生产者一律以自有名作 kind（`time-context`、
`runtime-context`、`compact-checkpoint` 等）。`@edan/edan-spec` 不是官方插件，
`plugin` 对它没有意义，改用包名作 kind。

上游 `edan-spec-dsh-plugin` 已发 1.0.1。本仓库同步 vendor 快照与分发链路：

| 位置 | 改动 |
|---|---|
| `vendor/edan-spec/` | 快照更新为 `edan-edan-spec-1.0.1.tgz` |
| 两个变体的 `package.json` | 依赖指向 1.0.1 |
| 两个变体的 `profile.ts` | `BUNDLED_PLUGIN_VERSION_EXEMPTIONS` 键改为 `'@edan/edan-spec@1.0.1'` |
| `yarn.lock` | checksum 随 tarball 更新 |

豁免键**按精确插件版本记录**（`插件名@版本` → 目标 DSH 包名），所以改版本号时必须同步，
否则新建 Profile 不会再播种这条豁免，插件会因 peer 不符被运行时禁用。

**无需数据迁移**：全量扫描 `~/.dsh/sessions` 下 143 个会话，**0 个含畸形 `kind:'plugin'` 行**
——该 bundle 从未真正落盘成功，且现存会话全部仍是 `session.v3.jsonl.zstd`，v3→v4 迁移路径
在本机从未走过。判定与证据见 `.agents/notes/implemented/architecture/2026-10-09-edan-spec-v4-source-kind.zh.md`。

**开发工具**

- `scripts/preinstall-plugins.mjs` — `list` / `verify` / `add` / `remove`，一条命令同步两个变体的 4 个文件
- `scripts/prepare-codegraph.mjs` — 按主机解压 vendor 的平台包
- `scripts/prepare-mnemon.mjs` — 同上，用于 mnemon；新增 `linux-x64` 物化支持
- `scripts/build-env.ps1` — Windows 侧构建环境

### 变更

- `dsh-session-manager` 的声明改用 npm `0.4.11`，构建期不再需要 git 网络
- `@edan/edan-spec` 的声明改用仓库内相对路径，否则安装包在别人机器上无法解析
- `dsh-plugin-desktop/package.json` 的 `build.appId` / `productName` / `nsis.shortcutName` 同步改名
- 测试里的硬编码 `'desktop'` / `'DSH Desktop'` 改为引用 `product-identity.ts` 的常量

### 修复

- **`profile-manager.ts` 的 `DEFAULT_PROFILE_NAME` 未同步** — 代码里有两条 Profile 创建路径，
  全新安装走的是 `profile-manager.ts` 那条。只改 `profile.ts` 会导致
  「用临时目录直测通过、真机全新安装一个插件都不预装」。两条路径现在都注入默认清单
- **`verify-licenses.mjs` 的 SPDX 双许可误判** — `dompurify` 的
  `(MPL-2.0 OR Apache-2.0)` 被字符串精确匹配判为不可再分发。
  已加入析取（OR）求值：任一分支在白名单即通过；`AND` 表达式仍严格匹配
- **`x64ArchFiles` 未声明导致 universal 打包失败** — `extraResources` 让两个切片
  拿到相同内容，`@electron/universal` 对「两切片相同但未声明的原生文件」会报错
- **Windows 校验脚本写死了应用名** — `verify-win-installer.ts` 与 `verify-win-portable.ts`
  写死 `'DSH Desktop.exe'`，与改名后的产物不符；校验器在 electron-builder 之后运行，
  找不到文件就报错，`dist:win` 的「Build Windows installer」因此失败。
  `verify-mac-smoke.ts` 同步引用产品名。四处与测试夹具现在都引用 `DESKTOP_PRODUCT_NAME`
- **`prepare-codegraph.mjs` 写死了工作区** — 路径硬编码为 `dsh-plugin-desktop`，
  而两个变体都从各自工作区调用它、`extraResources` 也各自相对于自己的目录。
  文件名与调用方目录不一致时，源目录不会被生成，electron-builder 对缺失的
  `extraResources` **静默跳过**，安装包会少一份 codegraph CLI 而不报错。改为按调用方目录解析并校验
- **`verify-licenses.mjs` 的 LICENSE 查找依赖文件系统大小写** — 用 `existsSync`
  精确探测 `LICENSE`，等于把答案交给文件系统：`khroma@2.1.0` 附带的许可证文件是
  小写 `license`，于是同一个 gate 在 macOS（APFS 不区分大小写）通过、在 Linux CI 失败。
  改为列出目录后自行按名字匹配
- **`verify-sidebar-browser.mjs` 的看门狗拦不住僵死** — 该脚本把 45 秒超时装在
  `verify()` 内部、`await app.whenReady()` **之后**：Electron 在 Xvfb 下启动阶段僵死时
  这行从未执行，**看门狗根本不存在**。

  超时提到顶层（第一个 await 之前）后仍然拦不住：命令链是
  `xvfb-run → yarn → electron → Node`，`process.exit` 只能终止最后一跳；主进程僵死时
  **JS 事件循环一并停止，定时器回调永远不会执行**，看门狗跟着僵死。
  现改为由 **CI 层**兜底——这一步的 `run` 用 `timeout` 包住：

  ```yaml
  run: timeout 120 xvfb-run --auto-servernum yarn workspace dsh-desktop-next verify:sidebar-browser --no-sandbox
  ```

  `timeout` 是独立进程，不受被测进程僵死影响。120 秒的依据：`verify()` 函数体内所有
  等待最坏合计约 15 秒，健康运行只需几秒（同一次 run 中同样跑 Electron 的
  `verify:protocol` 只用 4 秒），8 倍余量足够，又不挤占 job 的 45 分钟预算。
  脚本内 90 秒看门狗保留，作为第一道优雅退出。

  新增 `scripts/verify-sidebar-browser-timeout.mjs`（`yarn check:sidebar-browser-timeout`，
  已接入 `check:layout`）：断言该步骤确实被包住，并实际验证 `timeout` 能结束一个僵死命令
  （退出码 124）、放行快命令。无需网络、Electron 或显示器；本机无 `timeout` 时跳过而非失败。
  去掉包裹时该门禁报错（实测 exit 1）
- **CI 的 job 级超时缺失** — `.github/workflows/ci.yml` 只有 `desktop-linux` 与
  `desktop-macos` 两处 `timeout-minutes: 60`，其余 5 个 job 落到 GitHub 的 **360 分钟**
  默认值。现为全部 7 个 job 设定上限：`changes` 15、`check` 45、`desktop-windows` /
  `desktop-linux` / `desktop-macos` 各 60、`upstream-command-windows` 30、`publish` 30
- **`desktop-cli-shell.spec.ts` 的断言跟着宿主平台走** — `desktopCliProfileName`
  的 `platform` 形参缺省经 `?? process.platform` 落到宿主平台，省略该参数的测试因此
  在 macOS 笔记本上断言 macOS 行为（绿）、在 `ubuntu-latest` 上断言 Linux 行为（红）。
  CI 上稳定复现：

  ```
  AssertionError: expected '.bashrc' to be '.bash_profile' // Object.is equality
   ❯ tests/desktop-cli-shell.spec.ts:58:48
  Error: ENOENT: no such file or directory, open '/tmp/dsh-cli-shell-*/user/.zshrc'
   ❯ tests/desktop-cli-shell.spec.ts:99:21
  Tests  10 failed | 1895 passed | 13 skipped (1918)
  ```

  修法是让**每个断言显式声明平台**：`cli()` 辅助函数固定注入 `platform: 'darwin'`，
  内联选项块同样补齐（含最后一个漏网的），使测试结果与宿主平台无关。

  > **教训：本地绿灯不能证明 CI 会绿。** 该缺陷在 macOS 上完全不可见。
  > 复现手法：临时 vitest 配置注入 `setupFiles` 把 `process.platform` 钉成 `linux`，
  > 即可在 macOS 上跑出 CI 的行为——**先验证伪装确实生效**（探针断言
  > `process.platform === 'linux'`），否则"绿"什么都证明不了。
  > 注意 `NODE_OPTIONS="--import=..."` 不行，会打断 vitest/rolldown 的原生绑定解析
  > （`Cannot find module './rolldown-binding.wasi.cjs'`）。

### 未完成 / 已知限制

| 项 | 状态 |
|---|---|
| Windows 终端 PATH | **未实施。** 需在 NSIS 安装钩子写 `HKCU\Environment`，只能在真实 Windows 主机上验证；盲写注册表 PATH 风险过高 |
| 只内置 arm64 | 通用 DMG 的 Intel 切片里也有这份包，但运行时检测到架构不匹配会**跳过**，不会发布跑不了的命令。要在 Intel 上可用需再 vendor `darwin-x64` |
| 上游同步 | **尚未同步。** 本地落后上游 39 个提交（2.0.10 → 2.0.13），详见文末 |
| 代码签名 | 未签名。包内 `node` 是 115 MB 的 Mach-O，若日后走签名路线需额外 entitlements（JIT 相关） |
| 排除的插件 | `@huanlin/dsh-plugin-better-sidebar-plugin-office` 为 **AGPL-3.0**，不在可再分发白名单内，未预装 |
| Linux 产物 | **AppImage 挂载点每次变化**，shim 指向的绝对路径在应用退出后失效（下次启动会重写）。`.deb` 安装路径固定，不受影响 |
| `check` job | 第 15 步 `verify:sidebar-browser` 在 Xvfb 下可能僵死。脚本内看门狗对僵死无效（见「修复」），现由 CI 层 `timeout 120` 兜底 |

### 验证

macOS 真机端到端验证：

```
包内 CLI 独立运行  空 PATH ✓ / 真离线沙箱 ✓
终端可用          zsh -i -c 'codegraph --version' → 1.6.0
~/.zshrc          备份与原文件逐字节一致；重启幂等（标记数、备份数、文件哈希均不变）
新 Profile        10 个 bundle（base + web-app + 8 插件），全部从安装包解析
```

本地门禁与测试：

```
单测              stable 1906 passed / 12 skipped（1918）
                  beta   1877 passed / 10 skipped（1887）
门禁              typecheck（两变体）/ verify-desktop-variants（210 文件）/
                  plugins:verify（10 个预装插件）/ licenses / closure / layout 全通过
edan-spec v4      v4 校验谓语复现：{kind:'plugin'} 被拒 / {kind:'@edan/edan-spec'} 通过
                  三处 lib/index.js（vendor tarball / 源目录打包 / 两变体 node_modules）逐字节一致
旧会话扫描        ~/.dsh/sessions 下 143 个会话，0 个含 "kind":"plugin"
Linux 测试        以 linux 伪装宿主跑 desktop-cli-shell.spec.ts：29 passed
超时门禁          僵死命令以 124 结束（实测 2.7 秒）；去掉 CI 层包裹时该门禁 exit 1
```

CI（run `37923686283`，SHA `ac850bf5`）：`changes` / `desktop-windows` / `desktop-linux` /
`desktop-macos` / `upstream-command-windows` / `publish` 全部成功，Release
`evo-2.0.17-evo.3-ac850bf5` 已发布（Latest），5 个产物：universal DMG、x64 Setup.exe、
x64 Portable.zip、x86_64 AppImage、amd64 .deb。**`check` 为 `cancelled`** —— 第 10 步
`yarn check`（含上述全部单测）**通过**，随后第 15 步 `verify:sidebar-browser` 僵死，
被 job 级 45 分钟超时终止。该步骤现由 CI 层 `timeout 120` 兜底，尚未经 CI 实测。

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
