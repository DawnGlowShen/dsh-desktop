# The dsh-dream-skin sidebar-fill patch failed to port and was abandoned

Status: **port attempt failed and was abandoned**. `dsh-dream-skin` was reverted to the official unpatched 10.8.1.
[中文](2026-10-08-dream-skin-sidebar-fill-patch-abandoned.zh.md) | English

## Conclusion

When upgrading `dsh-dream-skin` from 9.16.0 to 10.8.1, this repository ported the 188-line local patch from 9.16.0 into 10.8.1's `lib/client.js`. **That port broke client-side (renderer) plugin loading**, observed as:

```
dsh-plugin-desktop: renderer boot failed (plugins: dsh-dream-skin): The client Loader did not provide an error message.
RendererStartupFailure: Renderer boot failed for 1 plugin(s)
    at start (.../Resources/app/lib/main.js:5324:49)
```

So `dsh-dream-skin` is upgraded to 10.8.1, but **without any patch**. The "sidebar transparency slider stops working" problem the patch fixed is **back**.

The upgrade itself is still worth keeping: 10.8.1's peer range is `>=0.1.0-rc.6 <0.3.0-0`, which accepts dsh `0.2.0-rc.2`, whereas 9.16.0's `^0.1.0-rc.6` excludes 0.2.x and makes the runtime mark the whole plugin incompatible and disable it. **Patched 10.8.1 is worse than unpatched 9.16.0**: the former cannot load the plugin at all.

## What the patch was for

The desktop shell declares `--dsw-specific-sidebar-fill` directly on the `.dshDesktopSidebarSurface` element. That declaration outranks the inline value the plugin writes to `<body>` via `overrideTokens`, so the "sidebar transparency" slider **silently does nothing** (no effect, no error). The original patch wins the cascade back with inline `!important`.

## Shape of the patch (kept for reference)

Against 9.16.0 the patch is **3 separate insertions, 188 pure additions, 0 deletions**:

| # | Location | Lines | Content |
|---|---|---|---|
| 1 | After `return resolveBase(scheme, active);` inside `resolveSidebar` | +177 | The `#region DSH Desktop sidebar-fill handover` block, defining `desktopSidebarSurface` / `writeDesktopSidebarFill` / `stopDesktopSidebarPoll` / `applyDesktopSidebarFill` / `clearDesktopSidebarFill` / `applyDesktopFill` / `clearDesktopFill` |
| 2 | After `wallpaperTokenOverrides = {};` inside `teardownWallpaper` | +2 | `clearDesktopSidebarFill(); clearDesktopFill();` |
| 3 | After `applyCombinedTokenOverrides(ctx);` | +9 | `applyDesktopSidebarFill(...)` + `applyDesktopFill()` |

All three are required: omitting #2 leaves fill residue after switching wallpapers; omitting #3 makes the whole patch inert.

All three anchors are still locatable in 10.8.1 (#2 and #3 have non-unique anchor text and require joint "anchor + adjacent context" matching):

- #1 `return resolveBase(scheme, active);` unique, line 2391
- #2 `wallpaperTokenOverrides = {};` 3 hits, take line 2400 inside `teardownWallpaper`
- #3 `wallpaperTokenOverrides = overrides;` adjacent to `applyCombinedTokenOverrides(ctx);`, unique, lines 6085-6086

Inserting back-to-front took `lib/client.js` from 8125 to 8313 lines, with exactly **3 diff blocks, +188 / -0** against official 10.8.1 — structurally exactly as intended.

## Why static validation did not catch it

The validation performed at the time was:

1. `node --check` passed — **but this file is ESM** (`package.json` has `type: "module"`), and `node --check` parses as CJS by default, so it proved less than it appeared to.
2. `import()` failed with `ReferenceError: window is not defined` — controlled against the **unpatched official original**, which failed identically, so it was attributed to "a browser-side module's environment limitation in bare Node."
3. With `window`/`document` stubbed, both failed identically with `TypeError: Cannot read properties of undefined (reading 'load')`, byte for byte.

**All three held, and all three were useless.** They proved "in bare Node, patched and original fail the same way"; they did **not** prove "it works in a renderer." The real execution environment is the renderer, and that is exactly where it failed. Treating "also fails in bare Node" as "works" is the root of the misjudgment.

## Evidence that the port caused it

Control experiment where the **only variable** is `lib/client.js`:

| | `dsh-dream-skin` in the artifact | Boot result |
|---|---|---|
| Experimental | 10.8.1 + the 188-line port | `renderer boot failed (plugins: dsh-dream-skin)` |
| Control | 10.8.1 official original (sha256 `a62a140660acfb45d3cbbf312f3e057ca8e1e5edf8513b7da6e78c9e18a38c51`) | **Renderer booted normally, no dream-skin error at all** |

Both runs shared the same artifact path, the same identity override, the same `DSH_HOME` isolation, and the same Node (v24.18.1). The control passed and the experimental run failed, so **the conclusion is that the port introduced it, not an upstream plugin defect**.

The control artifact's `dsh-dream-skin` has a patch-marker count of 0, confirmed to be the official original.

## Root cause (inferred, not proven)

The patch's new functions depend on 9.16.0-era internals (such as `desktopSidebarSurface`, `writeDesktopSidebarFill`). 10.8.1's internals have changed, so those references throw during **module evaluation**, which is why the client Loader has nothing reportable — consistent with the empty `The client Loader did not provide an error message`.

**This is an inference, not a conclusion.** The diagnostic bundle's `startup.stage.failed` event carries empty `details: {}`; the renderer left no stack behind. Confirming it would require opening the renderer DevTools to capture the real error, which this repository did not do.

## Current state

- `vendor/dream-skin/dsh-dream-skin-10.8.1.tgz` — official original, byte-identical to the npm release
- Both variants' `dsh-dream-skin` dependency point at that file
- Both variants install `10.8.1`, patch-marker count 0

## If this is retried later

Fix the validation method before touching code: after porting, **actually load the plugin in a renderer environment** (one isolated launch suffices) rather than relying on `node --check` and a bare-Node `import()`.

The correct form of the control experiment is **swapping the tarball and rebuilding**, not comparing source text — the latter cannot reflect renderer behavior.
