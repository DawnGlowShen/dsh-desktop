# Upstream AA profile smoke is a known failure

Status: pre-existing upstream defect; this repository neither patches nor works around it.
English | [中文](2026-10-08-upstream-aa-profile-smoke-failure.zh.md)

## Conclusion

Both `dsh-plugin-desktop` and `dsh-plugin-desktop-beta` end their `scripts.check` with `yarn run verify:aa`. **That step fails locally, deterministically:**

```
Error: AA did not publish its native DSH home endpoint
    at file:///.../dsh-plugin-desktop/scripts/verify-profile-boot.mjs:435:38
```

This is a **pre-existing upstream defect**, not a customization delta of this fork and not environmental contamination. This repository's position is to **leave it alone**: no script semantics are changed and the step is not skipped in the local `check`. Every stage before `verify:aa` is expected to be green.

## Evidence

Three independent lines establish that the defect is upstream's.

First, upstream `.github/workflows/ci.yml` carries a dedicated step named `Temporarily skip AA profile smoke in CI`, whose comment reads `# Remove this step after AA Host service activation is fixed.` The step uses an inline Node script to strip ` && yarn run verify:aa` out of both workspaces' `scripts.check` at CI runtime:

```js
const smoke = ' && yarn run verify:aa'
if (!manifest.scripts.check.includes(smoke)) throw new Error(`AA check not found in ${workspace}`)
manifest.scripts.check = manifest.scripts.check.replace(smoke, '')
```

Its third comment line states the boundary of that design: `Local checks and the standalone verify:aa command remain available.` Upstream therefore **deliberately** skips the step in CI only, while the local `yarn check` and the standalone `verify:aa` command keep running and keep failing. Upstream is on record that the problem is unfixed; we did not stumble onto something new.

Second, the `verify:aa` and `verify:profile` script definitions are byte-identical to upstream and were never touched during the replay:

```json
"verify:profile": "node scripts/verify-profile-boot.mjs",
"verify:aa": "node ../scripts/prepare-agents-anywhere-runtime.mjs && DSH_VERIFY_AA=1 node scripts/verify-profile-boot.mjs"
```

Third, `aa:check` **passes**, printing `Selected AA main at 7df5b31f3fe23d4be92ccd5ae5e0aeb6a3744c0e` and `AA release verified: all Desktop channels use 7df5b31f3fe23d4be92ccd5ae5e0aeb6a3744c0e`. It verifies AA artifact hashes and provenance; only the smoke that actually starts the bridge fails. The problem is runtime activation, not artifacts.

Determinism was checked as well: two consecutive standalone `yarn verify:aa` runs reported the same error, with no leftover bridge process and no stale `dsh-desktop-profile-*` temp directory at the time — ruling out contamination from the preceding `yarn check`.

## Where it fails

The checks in `dsh-plugin-desktop/scripts/verify-profile-boot.mjs:427-436` are sequential:

```js
if (ids.has('@agents-anywhere/dsh-bridge-next') !== aaEnabled) throw new Error('AA client graph does not match explicit selection')
if (aaEnabled && (!ctx.get('agentsAnywhereRuntime') || !ctx.get('agentsAnywhereOnboarding'))) {
  throw new Error('AA Host services did not activate in the actual Desktop profile')
}
if (aaEnabled) {
  const endpoint = join(home, 'agents-anywhere', 'bridge', 'endpoint.json')
  if (!existsSync(endpoint)) throw new Error('AA did not publish its native DSH home endpoint')
```

The first two **pass**: the client graph contains the AA row, and both the `agentsAnywhereRuntime` and `agentsAnywhereOnboarding` Host services resolve. The third, a synchronous `existsSync`, is what fails: the plugin row loaded and the Host services registered, but `RuntimeServer` never wrote `endpoint.json`.

On the AA side (`package/lib/index.js` inside `vendor/agents-anywhere/agents-anywhere-dsh-bridge-next-0.1.0-dev.0.desktop.*.tgz`) that write is behind an asynchronous chain:

```
Service.init()  →  restart()  →  server.start()  →  openWithLease()  →  acquireManagerLock()  →  open() writes endpoint.json
```

`openWithLease()` first derives a fixed manager port from `dirname(endpoint)` (`49152 + sha256(realpath(dirname)) first two bytes % 16384`) and takes an `exclusive` listen on it to serialize multiple instances; only after acquiring that lease does `open()` write `{version:1, host, port, token, pid}`.

The smoke script, however, only does this at `:251-252`:

```js
profileBoot.markReady()
await runtime.mountScheduled()
```

**It never waits for that asynchronous chain to settle**, then immediately performs a synchronous `existsSync(endpoint)`. There is a genuine race window, consistent with upstream's own phrasing that "AA Host service activation" is unfixed.

## Why it is not fixed here

The fix looks trivial — poll for `endpoint.json` after `:252` — but this repository deliberately declines it, for two reasons.

First, it would turn an upstream problem into a fork-local delta. `verify-profile-boot.mjs` currently differs from upstream only by the profile-name constantization; layering a timing patch on top means re-aligning that patch every time upstream reworks AA activation. Upstream itself did not reach for "just add an await", which suggests the root cause runs deeper (Cordis service lifecycle rather than a bare wait).

Second, upstream has already published the disposition for this defect: skip in CI, keep locally. Following upstream's stance means we never have to re-adjudicate "is this failure still known" on each upstream merge.

`verify:aa` is a standalone command and can be run on demand. If upstream fixes it, the `Temporarily skip` step disappears from CI and this record becomes obsolete.

## Reproducing

```
cd dsh-plugin-desktop && corepack yarn verify:aa
```

Expected: a stable `AA did not publish its native DSH home endpoint`. To check whether upstream has fixed it, look for the `Temporarily skip AA profile smoke in CI` step in `.github/workflows/ci.yml`.
