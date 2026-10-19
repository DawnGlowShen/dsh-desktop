# 变更记录

本仓库是 [anywhere-labs/dsh-desktop](https://github.com/anywhere-labs/dsh-desktop) 的**个人定制版**。

**这里只记录本仓库相对上游的改动**；上游自身的变更请查阅上游仓库的提交历史。

> 基线：`47574b1a83`（上游 `2.0.17-beta.2`）
> 本文档为中文；README 的双语校验（`README.i18n.yaml`）不覆盖本文件。

定制方向是**离线预装**：全新安装的机器在零网络、零 `pnpm install` 的前提下
即可用上预置插件与命令行工具，并自动完成它们工作所需的配置。

---

## [未发布]

### 定制身份

本仓库以 `DSH Desktop Evo` 的身份发布，与上游官方版并存安装：

| 标识 | 值 |
|---|---|
| `productName` | `DSH Desktop Evo` |
| `appId` | `ai.deepseek.dsh.desktop.evo` |
| Profile | `desktop-evo` |
| 产物名 | `DSH-Desktop-Evo-<version>-...` |
| 版本号 | `<upstream>-evo.N` |

`desktopName` 保持 `dsh-desktop.desktop`，它绑定 Linux 桌面项与窗口 WM_CLASS。
已安装的 `DSH Desktop Evo` 覆盖升级，`~/.dsh/profiles/desktop-evo` 中的用户数据延续。

### 新增

**离线预装：插件与 CLI（三平台）**

安装包内置一份载荷（`vendor/offline-install/`），首次启动时把插件链接进
Profile、把 CLI 解包并暴露到 `~/.dsh/bin`。全过程不联网。

| 类别 | 内容 |
|---|---|
| 插件 | 11 个，见下表 |
| CLI | `codegraph` 1.6.0、`git-ai` 1.7.5、`mnemon` 0.2.9 |
| 依赖树 | 与插件声明匹配的 `node_modules`，单一 tar 分卷携带 |

| 插件 | 版本 | 来源 |
|------|------|------|
| `@edan/edan-spec` | 1.1.1 | vendor tarball |
| `@huanlin/dsh-plugin-better-sidebar-plugin-office` | 0.2.0 | npm |
| `@hyzyn/dsh-codegraph` | 0.6.6 | npm |
| `@linxin666/dsh-client-ui-git-graph` | 0.4.5 | npm |
| `billion-context` | 0.1.197 | npm |
| `dsh-better-sidebar` | 0.24.1 | npm |
| `dsh-dream-skin` | 10.8.1 | vendor tarball（官方原版，未打补丁） |
| `dsh-git-ai` | 0.1.2-evo | vendor tarball |
| `dsh-mnemon` | 0.5.24 | npm |
| `dsh-rewind-plugin` | 0.15.1 | npm |
| `dsh-session-manager` | 0.6.2 | npm |

适配要点：

- **载荷源在仓库级 `vendor/offline-install/`**，两个 Desktop 包读同一份，
  不再各自持有副本。目录缺失时**构建失败**而非静默生成空载荷——静默跳过
  会让「预装了什么」与清单不符，且要在用户机器上才发现。
- **自写的 tar 解析器必须跳过 PAX 头**（typeflag `x`/`g`/`L`/`K`）。macOS 的
  bsdtar 会为每个文件写一条 PAX 头；只认 `0`/`5` 会把用户手工打的 tarball
  全部拒掉，而换 tarball 正是这个功能的核心用途。npm 自己的 tarball 是 GNU
  模式无 PAX，所以单测测不出，必须拿真实 `tar czf` 产物跑端到端。
- **符号链接的 `..` 按 realpath 数**，不按书写路径数。`relative(dirname(link),
  target)` 在 real 父目录与书写父目录深度不同（macOS `/tmp` → `/private/tmp`）
  且目标无共同祖先时会少一层，解析到不存在的路径。
- **CLI shim 与归档成员名**：Windows 下解析出的成员名带回车会让打包失败；
  跨平台分卷的 CLI 载荷一度被误报为孤儿。

**离线预装：载荷配置写入**

装完插件与 CLI 并不总等于它们能工作。有一类载荷还需要写一份配置，缺了它会
**静默失效**——用户看到的是数字不对，而不是一个错误。本版新增统一的配置
写入机制，并落地两份配置：

| 配置 | 目标 | 不写的后果 |
|---|---|---|
| `git-ai` | `~/.gitconfig` 的 `[trace2]` 段 | 归因失效：每次 commit 都读回 `untracked` |
| `dream-skin` | `$DSH_HOME/dream-skin.json` | 全新安装打开是插件出厂外观，而非定制外观 |

机制要点：

- **配置是注册表条目，不是安装器里的分支**。加一份配置 = 加一个模块 +
  注册表登记一行，不改执行器、不改启动路径、不改设置动作。
- **每份配置自己声明幂等语义**。`converge`（每次收敛，用于本产品拥有、
  过期就会出问题的设置）与 `seed`（目标已存在则跳过，用于用户拥有的文件）
  的区别在于**文件归谁所有**，只有配置自己知道。两份配置给出的答案相反，
  而两个都对。
- **失败互相隔离**：一份配置失败只让它自己付出代价，其余照常执行，启动
  继续走到窗口，与既有的三个载荷安装阶段同一契约。
- **资源缺失报告为「跳过」而非「失败」**：未随包携带某资源的构建是正常
  构建，报成故障会让运维去找一个不存在的问题。
- **为何用代码而非载荷内的可执行脚本**：后者等于在已签名、已公证的应用内
  执行任意代码，而它的灵活性大体是虚的——打包后修改载荷文件会使签名失效，
  新增配置无论如何仍要重新打包。既然都要重新打包，受类型检查、审查与测试
  覆盖的模块更好。

`git-ai` 的移植带上了 `evo` 分支在其初版之后修掉的两个 Windows 缺陷
（命名管道拼写、gitconfig 值转义）；只取初版会在 Windows 上重新引入静默
归因失效。

**其他**

- **三平台发布**：`desktop-package` 工作流在打包后发布 Release，同一个 tag
  下提供可公开下载的 Windows 安装包、Linux deb 与 macOS DMG；
  只有版本号相对上次发布有变更时才打包，纯代码提交不会多出一次重复构建。
  三平台产物均未签名，release 说明里写明各自的放行方式。
  发布用构建改用压缩，Windows 安装包从 1.58 GB 降到约一半。
- **默认外观**：`build/dream-skin-default.json` 由
  `scripts/prepare-dream-skin-default.mjs` 从调好的状态文件生成，剔除
  `dsh-dream-skin:wallpaper-history`（壁纸尝试历史，非外观的一部分，
  实测约 118KB）。

### 撤销

**`git-ai` 的诊断开关不再存在**

上游定制线（`evo` 分支）曾有一个临时诊断开关 `DSH_DESKTOP_ENABLE_GIT_AI`，
语义是**反转默认**（只有精确等于 `1` 才启用），用于排查一个怀疑由 git-ai
引起的 Windows 二次启动失败。

本分支的移植**完全移除**该开关：常量、判定函数、文件头对它的说明、以及
测试中对应的整块用例一并删除，模块内不再有任何 `process.env` 判断。

需要停用 git-ai 时**注释掉注册表里的条目**即可。这个手段比环境变量更可见
（改动在代码里、code review 能看见），也不需要在一台事后无法检查的机器上
配置。

风险如实记录：**若 Windows 二次启动问题复现，git-ai 是首要怀疑对象。**

---

## 与上游同步

本仓库的做法与上游保持一致的拓扑（见 [owning Agent Note](.agents/notes/implemented/process/2026-08-15-pinned-upstream-and-isolated-yarn-workspace.md)）：

| 位置 | 内容 |
|------|------|
| `deepseek-harness/` | 上游子模块，**固定 pin，不改** |
| `dsh-plugin-desktop/`、`dsh-plugin-desktop-beta/` | 定制代码，两变体各自独立 |

定制的硬约束是**绝不修改子模块内的文件**。上游能力通过包装与组合接入，
因此同步上游 = 更新子模块 pin，而不是解决冲突。

两个 Desktop 变体共享同一份源码，差异以声明方式记录，由
`corepack yarn check:desktop-variants` 校验（当前 225 个共享源文件对齐）。
**先改 `-beta`，验证后再同步到 `dsh-plugin-desktop`**，并保留声明过的差异
——例如 `tests/package.spec.ts` 两变体本就不同（含各自的产品身份断言），
整体覆盖会破坏它。

```bash
corepack yarn check:desktop-variants   # 变体漂移检查
corepack yarn check                    # 完整门禁
```
