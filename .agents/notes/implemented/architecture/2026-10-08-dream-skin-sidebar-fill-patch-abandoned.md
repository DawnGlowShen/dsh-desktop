# dsh-dream-skin sidebar-fill 补丁移植失败并放弃

状态：**移植尝试失败，已放弃**。`dsh-dream-skin` 回退为官方未打补丁的 10.8.1。
[中文](2026-10-08-dream-skin-sidebar-fill-patch-abandoned.zh.md) | English

## 结论

`dsh-dream-skin` 从 9.16.0 升级到 10.8.1 时，本仓库曾把 9.16.0 上的 188 行本地补丁移植到 10.8.1 的 `lib/client.js`。**该移植破坏了客户端（渲染器）侧的插件加载**，实测报：

```
dsh-plugin-desktop: renderer boot failed (plugins: dsh-dream-skin): The client Loader did not provide an error message.
RendererStartupFailure: Renderer boot failed for 1 plugin(s)
    at start (.../Resources/app/lib/main.js:5324:49)
```

于是 `dsh-dream-skin` 升级到 10.8.1，但**不带任何补丁**。补丁所修的「侧边栏透明度滑块失效」问题**重新存在**。

升级本身仍然值得保留：10.8.1 的 peer 范围是 `>=0.1.0-rc.6 <0.3.0-0`，兼容 dsh `0.2.0-rc.2`；而 9.16.0 的 `^0.1.0-rc.6` 不含 0.2.x，会被运行时判定不兼容并禁用整个插件。**带补丁的 10.8.1 比不带补丁的 9.16.0 更糟**：前者连插件都加载不了。

## 补丁原本要修什么

桌面壳在 `.dshDesktopSidebarSurface` 元素上直接声明了 `--dsw-specific-sidebar-fill`。该声明的优先级高于插件经 `overrideTokens` 写入 `<body>` 的行内值，导致「侧边栏透明度」滑块**静默失效**（改动不生效、无报错）。原补丁用行内 `!important` 把级联赢回来。

## 补丁的形态（保留备查）

对 9.16.0 而言，补丁是 **3 处独立插入、188 行纯新增、0 删除**：

| # | 位置 | 行数 | 内容 |
|---|---|---|---|
| 1 | `resolveSidebar` 内 `return resolveBase(scheme, active);` 之后 | +177 | `#region DSH Desktop sidebar-fill handover` 主块，定义 `desktopSidebarSurface` / `writeDesktopSidebarFill` / `stopDesktopSidebarPoll` / `applyDesktopSidebarFill` / `clearDesktopSidebarFill` / `applyDesktopFill` / `clearDesktopFill` |
| 2 | `teardownWallpaper` 内 `wallpaperTokenOverrides = {};` 之后 | +2 | `clearDesktopSidebarFill(); clearDesktopFill();` |
| 3 | `applyCombinedTokenOverrides(ctx);` 之后 | +9 | `applyDesktopSidebarFill(...)` + `applyDesktopFill()` |

三处缺一不可：漏 #2 会在切走壁纸后留下填充残留；漏 #3 则整个补丁不生效。

在 10.8.1 中三处锚点均仍可定位（#2、#3 的锚点文本不唯一，须用「锚点 + 邻接上下文」联合定位）：

- #1 `return resolveBase(scheme, active);` 唯一命中，行 2391
- #2 `wallpaperTokenOverrides = {};` 命中 3 处，取 `teardownWallpaper` 内的行 2400
- #3 `wallpaperTokenOverrides = overrides;` 紧邻 `applyCombinedTokenOverrides(ctx);`，唯一命中行 6085-6086

从后往前插入后，`lib/client.js` 由 8125 行变为 8313 行，与官方 10.8.1 的差异恰为 **3 个差异块、+188 / -0**，结构化上完全符合预期。

## 为什么静态校验没能拦住它

当时的校验是：

1. `node --check` 通过 —— **但该文件是 ESM**（`package.json` 的 `type: "module"`），`node --check` 默认按 CJS 解析，证明力弱于表面。
2. `import()` 报 `ReferenceError: window is not defined` —— 用**未打补丁的官方原版**做对照，两边报错完全一致，于是归因为「浏览器端模块在裸 Node 的环境限制」。
3. 给 `window`/`document` 打桩后，两边同报 `TypeError: Cannot read properties of undefined (reading 'load')`，逐字一致。

**这三条全部成立，却全部无效。** 它们证明的是「在裸 Node 里，打补丁版与原版失败模式一致」，**没有证明**「在渲染器环境里能正常工作」。真正的执行环境是渲染器，而失败恰好发生在那里。把「裸 Node 下同样失败」当成「可以工作」，是这次判断错误的根源。

## 判定「是移植引入」的证据

对照实验，**唯一变量**是 `lib/client.js`：

| | 产物内 `dsh-dream-skin` | 启动结果 |
|---|---|---|
| 实验组 | 10.8.1 + 188 行移植 | `renderer boot failed (plugins: dsh-dream-skin)` |
| 对照组 | 10.8.1 官方原版（sha256 `a62a140660acfb45d3cbbf312f3e057ca8e1e5edf8513b7da6e78c9e18a38c51`） | **渲染器正常启动，无任何 dream-skin 报错** |

两次运行共用同一产物路径、同一身份改写、同一 `DSH_HOME` 隔离方式、同一 Node（v24.18.1）。对照组通过，实验组失败，因此**结论是移植引入，不是上游插件缺陷**。

对照组产物内 `dsh-dream-skin` 的补丁标记计数为 0，已核实确为官方原版。

## 根因（推断，未证实）

补丁新增的函数依赖 9.16.0 时代的内部结构（如 `desktopSidebarSurface`、`writeDesktopSidebarFill` 等）。10.8.1 的内部实现已变化，这些引用在**模块求值阶段**即抛错，导致客户端 Loader 拿不到可报告的信息 —— 与 `The client Loader did not provide an error message` 这句空错误相符。

**这是推断，不是结论。** 诊断包里 `startup.stage.failed` 事件的 `details` 为空 `{}`，渲染器侧没有留下堆栈。要落实需打开渲染器 DevTools 抓真实报错，本仓库未做。

## 当前状态

- `vendor/dream-skin/dsh-dream-skin-10.8.1.tgz` —— 官方原版，与 npm 发布字节一致
- 两个变体的 `dsh-dream-skin` 依赖均指向该文件
- 两变体实装版本均为 `10.8.1`，补丁标记均为 0

## 若日后要重新尝试

先解决验证方法，再动代码：移植后必须**在渲染器环境里实测插件能否加载**（隔离启动一次即可），而不能只依赖 `node --check` 与裸 Node 的 `import()`。

对照实验的正确形态是**替换 tarball 重建**，而不是在源码层面比对 —— 后者无法反映渲染器行为。
