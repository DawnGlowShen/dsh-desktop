# 上游 AA profile smoke 的已知失败

状态：上游既有缺陷，本仓库不改动、不规避。
[English](2026-10-08-upstream-aa-profile-smoke-failure.md) | 中文

## 结论

`dsh-plugin-desktop` 与 `dsh-plugin-desktop-beta` 的 `scripts.check` 末尾都挂着 `yarn run verify:aa`。**这一项在本地稳定失败**，报：

```
Error: AA did not publish its native DSH home endpoint
    at file:///.../dsh-plugin-desktop/scripts/verify-profile-boot.mjs:435:38
```

这是**上游自带的既有缺陷**，不是本仓库的定制差异，也不是环境污染。本仓库的处理方式是：**保持现状，不改脚本语义、不在本地 `check` 里跳过它**，把该项记为已知失败。`yarn check` 跑到 `verify:aa` 之前的全部环节应当全绿。

## 证据

判定"上游既有"的依据有三条，相互独立：

第一，上游 `.github/workflows/ci.yml` 里有一个专门步骤叫 `Temporarily skip AA profile smoke in CI`，注释原文是 `# Remove this step after AA Host service activation is fixed.`。该步骤用一段内联 Node 脚本，在 CI 运行时把 ` && yarn run verify:aa` 从两个 workspace 的 `scripts.check` 里剥掉：

```js
const smoke = ' && yarn run verify:aa'
if (!manifest.scripts.check.includes(smoke)) throw new Error(`AA check not found in ${workspace}`)
manifest.scripts.check = manifest.scripts.check.replace(smoke, '')
```

上游注释的第三行说明了这个设计的边界：`Local checks and the standalone verify:aa command remain available.` 也就是说，上游**有意**只在 CI 里跳过，本地 `yarn check` 与独立的 `verify:aa` 命令照常执行并失败。这是上游自己承认问题未修，而不是我们发现的意外。

第二，`verify:aa` 与 `verify:profile` 的脚本定义和上游逐字节一致，重施过程中从未改动：

```json
"verify:profile": "node scripts/verify-profile-boot.mjs",
"verify:aa": "node ../scripts/prepare-agents-anywhere-runtime.mjs && DSH_VERIFY_AA=1 node scripts/verify-profile-boot.mjs"
```

第三，`aa:check` **通过**，输出 `Selected AA main at 7df5b31f3fe23d4be92ccd5ae5e0aeb6a3744c0e` 与 `AA release verified: all Desktop channels use 7df5b31f3fe23d4be92ccd5ae5e0aeb6a3744c0e`。它校验的是 AA 产物的哈希与 provenance；只有真正启动 bridge 的 smoke 失败。所以问题在运行时激活，不在产物。

失败的确定性也验证过：连续两次单独运行 `yarn verify:aa` 报同一错误；当时没有残留的 bridge 进程，也没有遗留的 `dsh-desktop-profile-*` 临时目录，排除了上一条 `yarn check` 的污染。

## 失败发生在哪一步

`dsh-plugin-desktop/scripts/verify-profile-boot.mjs:427-436` 的检查是递进的：

```js
if (ids.has('@agents-anywhere/dsh-bridge-next') !== aaEnabled) throw new Error('AA client graph does not match explicit selection')
if (aaEnabled && (!ctx.get('agentsAnywhereRuntime') || !ctx.get('agentsAnywhereOnboarding'))) {
  throw new Error('AA Host services did not activate in the actual Desktop profile')
}
if (aaEnabled) {
  const endpoint = join(home, 'agents-anywhere', 'bridge', 'endpoint.json')
  if (!existsSync(endpoint)) throw new Error('AA did not publish its native DSH home endpoint')
```

前两条**都通过了**——client graph 里有 AA 行，`agentsAnywhereRuntime` 与 `agentsAnywhereOnboarding` 两个 Host 服务也取到了。失败的是第三条的同步 `existsSync`：插件行加载了、Host 服务注册了，但 `RuntimeServer` 没把 `endpoint.json` 落盘。

AA 侧（`vendor/agents-anywhere/agents-anywhere-dsh-bridge-next-0.1.0-dev.0.desktop.*.tgz` 的 `package/lib/index.js`）的落盘链条是异步的：

```
Service.init()  →  restart()  →  server.start()  →  openWithLease()  →  acquireManagerLock()  →  open() 写出 endpoint.json
```

`openWithLease()` 会先在 `dirname(endpoint)` 上派生一个固定管理端口（`49152 + sha256(realpath(dirname)) 取前两字节 % 16384`）做 `exclusive` 监听来串行化多实例，拿到租约后才 `open()` 写 `{version:1, host, port, token, pid}`。

而 smoke 脚本在 `:251-252` 只做了：

```js
profileBoot.markReady()
await runtime.mountScheduled()
```

**没有等待上面这条异步链收敛**，紧接着就同步查 `existsSync(endpoint)`。时序上确实存在竞态窗口。这与上游注释里 "AA Host service activation is fixed" 的说法吻合。

## 为什么不在这里修

修法看起来很简单——在 `:252` 之后加一段轮询等 `endpoint.json` 出现即可。但本仓库明确不这么做，理由有两条。

其一，那会把一个上游问题变成我们的定制差异。`verify-profile-boot.mjs` 目前相对上游只有 profile 名常量化的改动；再叠一层时序修补，就意味着上游每次改进 AA 激活逻辑时都要重新对齐这处补丁。上游自己都没用"加个 await"解决，说明根因可能更深（涉及 Cordis 服务生命周期，而非单纯的等待）。

其二，上游已经给出了这个缺陷的处置口径：CI 跳过、本地保留。我们跟随上游口径，就不必在每次合并 upstream 时重新判断"这个失败还算不算已知"。

`verify:aa` 是独立命令，需要时随时可以单独运行。若将来上游修掉了它，CI 里那个 `Temporarily skip` 步骤会被删除，本记录随之作废。

## 复现

```
cd dsh-plugin-desktop && corepack yarn verify:aa
```

预期稳定输出 `AA did not publish its native DSH home endpoint`。要确认上游是否已修复，看 `.github/workflows/ci.yml` 里的 `Temporarily skip AA profile smoke in CI` 步骤是否还在。
