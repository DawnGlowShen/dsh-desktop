/**
 * Materialize the vendored git-ai CLI for the packaging host.
 *
 * Unlike CodeGraph (a Node tree) and Mnemon (a Go binary inside a versioned
 * tarball), git-ai publishes **bare executables** as release assets, one per
 * platform and architecture:
 *
 *   git-ai-macos-arm64          git-ai-windows-x64.exe
 *   git-ai-macos-x64            git-ai-windows-arm64.exe
 *   git-ai-linux-x64            git-ai-linux-arm64
 *
 * This script stages the asset matching the packaging host into
 * `dsh-plugin-desktop/build/git-ai/host`, which `build.extraResources` then
 * copies into the installer as `resources/git-ai`. Like the other two CLIs it
 * deliberately does NOT become a Yarn dependency: a platform package carrying
 * `"cpu": ["arm64"]` can be skipped for the x64 slice of a macOS universal
 * build, which would make the two slices differ and break
 * `@electron/universal`. A static `extraResources` copy keeps both slices
 * byte-identical.
 *
 * macOS therefore ships ONE merged executable: `lipo -create` fuses the
 * `macos-arm64` and `macos-x64` assets, so the single staged payload runs on
 * both slices. The upstream signatures survive the merge — verified with
 * `codesign --verify` ("valid on disk") and both slices run under `arch -arm64`
 * and `arch -x86_64`.
 *
 * ## Bundle layout
 *
 * `publishDesktopGitAiRuntime` reuses `installBundledCliRuntime`, which requires
 * the launcher at `<bundleDir>/bin/<label>` and `bundleSupportsHost`, which
 * reads `<bundleDir>/package.json` and treats a **missing manifest as
 * unsupported**. Upstream ships neither, so this script synthesizes both:
 *
 *   build/git-ai/host/bin/git-ai     the executable
 *   build/git-ai/host/package.json   os/cpu manifest describing the payload
 *   build/git-ai/.prepared.json      idempotence marker (underscore-free dotfile)
 *
 * ## The executable name is load-bearing
 *
 * git-ai inspects `argv[0]` and falls back to behaving as a `git` proxy when
 * invoked under any other name: a copy called `arm` or `universal` reports
 * `git version 2.54.0` instead of its own `1.7.5`. That would turn every later
 * `--version` probe into a false positive while attributing nothing, so the
 * staged payload must always be named `git-ai` (or `git-ai.exe`).
 *
 * Usage:
 *   node scripts/prepare-git-ai.mjs                 # host platform and arch
 *   node scripts/prepare-git-ai.mjs --target win32-x64
 *   node scripts/prepare-git-ai.mjs --target darwin-arm64   # unmerged, for rollback
 *   node scripts/prepare-git-ai.mjs --check         # fail if not prepared
 */

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const vendorRoot = join(root, 'vendor', 'git-ai')

/**
 * Pinned upstream release.
 *
 * The assets are not fetched by this script: `vendor/git-ai/` carries them (and
 * the upstream `SHA256SUMS` they were verified against) so packaging works
 * offline and the exact bytes a release shipped stay in history. A version bump
 * means re-downloading both the assets and `SHA256SUMS`, then updating the
 * checksums below from that file.
 */
const VERSION = '1.7.5'

/** Executable name every payload must carry; see the module note above. */
const EXECUTABLE = 'git-ai'

/** Upstream repository, recorded in the synthesized manifest. */
const REPOSITORY = 'https://github.com/git-ai-project/git-ai'

/**
 * Per-target asset identity, pinned checksum, and staged file name.
 *
 * `publishedName` differs from the upstream asset name only on Windows, where
 * upstream appends `.exe` and we keep it so the installer ships a
 * double-clickable binary.
 */
const TARGETS = {
  'darwin-arm64': {
    asset: `git-ai-macos-arm64-${VERSION}`,
    // sha256 from the upstream SHA256SUMS published with v1.7.5.
    sha256: 'f1c0ce62ef17fc259e830463c4c3e186e404a2d98ec1b127e79d1bbd50e36ac2',
    publishedName: EXECUTABLE,
    os: 'darwin',
    cpu: ['arm64'],
  },
  'darwin-x64': {
    asset: `git-ai-macos-x64-${VERSION}`,
    sha256: '9c631c2a9a3faeafd0f18da5c654c773f56641a622b3c60fe67616b97f978cb6',
    publishedName: EXECUTABLE,
    os: 'darwin',
    cpu: ['x64'],
  },
  // Fuses the two darwin assets. The merged output has no upstream checksum of
  // its own, so `verify` re-checks the two inputs instead, and the manifest
  // declares both architectures so either slice accepts it.
  'darwin-universal': {
    sources: ['darwin-arm64', 'darwin-x64'],
    publishedName: EXECUTABLE,
    os: 'darwin',
    cpu: ['arm64', 'x64'],
  },
  'win32-x64': {
    asset: `git-ai-windows-x64-${VERSION}.exe`,
    sha256: '52e61e2d0830f6f9c0ef23ba658b68410df170c027d0d418f101c6a66ba32c4a',
    publishedName: 'git-ai.exe',
    os: 'win32',
    cpu: ['x64'],
  },
}

/**
 * Throwing rather than exiting: `process.exit` skips `finally` blocks, so a
 * staging directory would survive every validation failure. `main` owns the
 * exit code instead.
 */
function fail(message) {
  throw new Error(message)
}

function parseTarget(argv) {
  const index = argv.indexOf('--target')
  if (index !== -1) {
    const value = argv[index + 1]
    if (value === undefined) fail('--target requires a value such as darwin-universal')
    return value
  }
  // macOS ships a single universal app, so neither host architecture can be
  // prepared alone: the x64 slice would read an arm64-only payload and refuse
  // to publish the CLI (no `~/.dsh/bin`). Explicit --target still selects the
  // unmerged per-architecture binaries.
  return process.platform === 'darwin' ? 'darwin-universal' : `${process.platform}-${process.arch}`
}

/**
 * Workspace receiving the materialized binary.
 *
 * Both editions run this from their own workspace root (`node
 * ../scripts/prepare-git-ai.mjs`), and each declares its own
 * `build.extraResources` relative to that workspace. Resolving against the
 * caller's directory is therefore required: a fixed `dsh-plugin-desktop` path
 * would prepare the stable tree while the beta build reads its own, silently
 * shipping an edition without the CLI.
 */
function resolveDesktopRoot(argv) {
  const declared = argv.indexOf('--desktop')
  if (declared !== -1 && argv[declared + 1] === undefined) {
    fail('--desktop requires a workspace directory')
  }
  const candidate = declared === -1 ? process.cwd() : resolve(argv[declared + 1])
  const manifestPath = join(candidate, 'package.json')
  if (!existsSync(manifestPath)) {
    fail('run this from a desktop workspace, or pass --desktop <workspace directory>')
  }
  const name = JSON.parse(readFileSync(manifestPath, 'utf8')).name
  if (name !== 'dsh-plugin-desktop' && name !== 'dsh-plugin-desktop-beta') {
    fail(`${candidate} is not a desktop workspace (package name is ${String(name)})`)
  }
  return candidate
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function relativeToRoot(path) {
  return path.startsWith(root) ? path.slice(root.length + 1) : path
}

/** Resolve the vendored asset for one architecture target key. */
function locateAsset(targetKey) {
  const { asset } = TARGETS[targetKey]
  const path = join(vendorRoot, asset)
  if (!existsSync(path)) {
    fail(`vendored asset is missing: ${relativeToRoot(path)} (expected the git-ai ${VERSION} release download)`)
  }
  return path
}

/** Checksum and verify one input asset, keyed by target. */
function verifyAsset(targetKey, path) {
  const actual = sha256(path)
  const { sha256: expected } = TARGETS[targetKey]
  if (actual !== expected) {
    fail(`${relativeToRoot(path)} has sha256 ${actual}, expected ${expected}`)
  }
  return actual
}

/**
 * Re-check the pinned inputs behind a staged payload.
 *
 * A universal binary has no upstream checksum of its own, so the only way to
 * know the merged file still corresponds to the pinned release is to re-hash
 * both halves on every run.
 */
function verifyInputs(sources) {
  return Object.fromEntries(sources.map(targetKey => [targetKey, verifyAsset(targetKey, locateAsset(targetKey))]))
}

function readPrepared(markerPath) {
  if (!existsSync(markerPath)) return undefined
  try {
    return JSON.parse(readFileSync(markerPath, 'utf8'))
  } catch {
    return undefined
  }
}

/** Order-independent comparison, so a reordered marker still matches. */
function sameChecksums(left, right) {
  if (left === undefined || right === undefined) return false
  const leftKeys = Object.keys(left)
  if (leftKeys.length !== Object.keys(right).length) return false
  return leftKeys.every(key => left[key] === right[key])
}

/**
 * Synthesize the bundle manifest `bundleSupportsHost` reads.
 *
 * A missing manifest reads as "unsupported", which would silently skip git-ai
 * on every host, so the staged bundle must declare its own platform and
 * architecture. The universal payload lists both so either slice accepts it.
 */
function bundleManifest(target) {
  return `${JSON.stringify({
    name: 'git-ai',
    version: VERSION,
    description: `git-ai native binary for ${target.os}`,
    os: [target.os],
    cpu: target.cpu,
    files: ['bin'],
    repository: { type: 'git', url: `git+${REPOSITORY}.git` },
    homepage: REPOSITORY,
  }, null, 2)}\n`
}

/**
 * `lipo` writes the merged Mach-O; the caller chmods afterwards.
 *
 * `run` is injectable so the failure branches are testable off a macOS host.
 */
function mergeUniversal(arm64Path, x64Path, outputPath, run = defaultRun) {
  mkdirSync(dirname(outputPath), { recursive: true })
  const result = run('lipo', ['-create', arm64Path, x64Path, '-output', outputPath])
  if (result.status !== 0) {
    fail(`lipo -create failed: ${result.stderr.trim() || describeRunFailure(result, 'failed to start lipo')}`)
  }
}

function describeRunFailure(result, fallback) {
  if (result.signal !== undefined && result.signal !== null) return `killed by ${String(result.signal)}`
  if (result.status !== null) return `exit ${String(result.status)}`
  return fallback
}

function defaultRun(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 })
  if (result.error !== undefined) {
    return { status: null, signal: null, stdout: '', stderr: result.error.message }
  }
  return { status: result.status, signal: result.signal, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

/** The merged payload must advertise exactly the two macOS architectures. */
function assertUniversalArchitectures(outputPath, run = defaultRun) {
  const result = run('lipo', [outputPath, '-archs'])
  if (result.status !== 0) {
    fail(`lipo -archs failed: ${result.stderr.trim() || describeRunFailure(result, 'failed to start lipo')}`)
  }
  const archs = result.stdout.trim().split(/\s+/u).sort()
  const expected = ['arm64', 'x86_64']
  if (archs.join(' ') !== expected.join(' ')) {
    fail(`${relativeToRoot(outputPath)} declares architectures [${archs.join(', ')}], expected [${expected.join(', ')}]`)
  }
}

/**
 * Assert the payload is the executable git-ai expects to be called as, at the
 * path `installBundledCliRuntime` looks for.
 *
 * The name check is load-bearing, not cosmetic: git-ai switches to `git`-proxy
 * behaviour when `argv[0]` is anything else, so a wrongly named copy passes
 * every later smoke test while attributing nothing.
 */
function assertExecutable(outputRoot, target) {
  if (target.publishedName !== EXECUTABLE && target.publishedName !== `${EXECUTABLE}.exe`) {
    fail(`git-ai must be staged as ${EXECUTABLE} (or ${EXECUTABLE}.exe), not ${target.publishedName}`)
  }
  const path = launcherPath(outputRoot, target)
  if (!existsSync(path)) fail(`staged launcher is missing ${relativeToRoot(path)}`)
  if (!statSync(path).isFile()) fail(`staged launcher is not a file: ${relativeToRoot(path)}`)
}

/**
 * `installBundledCliRuntime` resolves the launcher at `<bundleDir>/bin/<name>`,
 * on Windows via the dedicated `windowsLauncher` argument.
 */
function launcherPath(outputRoot, target) {
  return join(outputRoot, 'bin', target.publishedName)
}

/** Mark the payload executable on the hosts that run it directly. */
function makeRunnable(outputRoot, target) {
  if (!target.os.startsWith('darwin') && target.os !== 'linux') return
  const path = launcherPath(outputRoot, target)
  chmodSync(path, 0o755)
  if ((statSync(path).mode & 0o111) === 0) {
    fail(`${target.publishedName} is not executable after preparation`)
  }
}

/** Write the manifest and the idempotence marker, in that order. */
function writeBundleMetadata(target, outputRoot, markerPath, checksums) {
  writeFileSync(join(outputRoot, 'package.json'), bundleManifest(target))
  writeFileSync(markerPath, `${JSON.stringify({
    target: target.key,
    version: VERSION,
    executable: relativeToRoot(launcherPath(outputRoot, target)),
    archiveSha256: checksums,
  }, null, 2)}\n`)
}

/**
 * Fuse the darwin assets into one dual-architecture executable.
 *
 * Every check runs before the marker is written, so a marker always describes a
 * payload that passed verification.
 */
function prepareUniversal(target, sources, { outputRoot, markerPath, run }) {
  const checksums = verifyInputs(sources)

  rmSync(outputRoot, { recursive: true, force: true })
  mkdirSync(join(outputRoot, 'bin'), { recursive: true })
  mergeUniversal(locateAsset('darwin-arm64'), locateAsset('darwin-x64'), launcherPath(outputRoot, target), run)
  assertUniversalArchitectures(launcherPath(outputRoot, target), run)
  makeRunnable(outputRoot, target)
  assertExecutable(outputRoot, target)
  writeBundleMetadata(target, outputRoot, markerPath, checksums)
  process.stdout.write(`prepare-git-ai: prepared git-ai ${VERSION} for darwin-universal\n`)
}

function preparePlain(target, assetPath, { outputRoot, markerPath }) {
  const checksum = verifyAsset(target.key, assetPath)
  rmSync(outputRoot, { recursive: true, force: true })
  mkdirSync(join(outputRoot, 'bin'), { recursive: true })
  copyFileSync(assetPath, launcherPath(outputRoot, target))
  makeRunnable(outputRoot, target)
  assertExecutable(outputRoot, target)
  writeBundleMetadata(target, outputRoot, markerPath, { [target.key]: checksum })
  process.stdout.write(`prepare-git-ai: prepared git-ai ${VERSION} for ${target.key}\n`)
}

function isStaged(outputRoot, target) {
  return existsSync(launcherPath(outputRoot, target)) && existsSync(join(outputRoot, 'package.json'))
}

function main(argv = process.argv.slice(2)) {
  const targetKey = parseTarget(argv)
  const declared = TARGETS[targetKey]
  if (declared === undefined) {
    fail(`unknown target ${targetKey}; known targets are ${Object.keys(TARGETS).join(', ')}`)
  }
  const target = { ...declared, key: targetKey }

  const desktopRoot = resolveDesktopRoot(argv)
  const buildRoot = join(desktopRoot, 'build', 'git-ai')
  const outputRoot = join(buildRoot, 'host')
  const markerPath = join(buildRoot, '.prepared.json')

  const existing = readPrepared(markerPath)
  const reusable = existing?.target === targetKey && existing?.version === VERSION
  const sources = target.sources ?? [targetKey]

  // `--check` proves the packaging inputs are in place without writing anything,
  // so a release job can assert "prepared" as a gate rather than a side effect.
  if (argv.includes('--check')) {
    if (!reusable || !isStaged(outputRoot, target)) {
      fail(`${targetKey} is not prepared; run node scripts/prepare-git-ai.mjs --target ${targetKey}`)
    }
    verifyInputs(sources)
    process.stdout.write(`prepare-git-ai: git-ai ${VERSION} is prepared for ${targetKey}\n`)
    return
  }

  if (reusable && isStaged(outputRoot, target)) {
    const checksums = verifyInputs(sources)
    if (sameChecksums(existing.archiveSha256, checksums)) {
      process.stdout.write(`prepare-git-ai: reusing git-ai ${VERSION} for ${targetKey}\n`)
      return
    }
  }

  if (target.sources !== undefined) {
    prepareUniversal(target, sources, { outputRoot, markerPath, run: defaultRun })
    return
  }

  preparePlain(target, locateAsset(targetKey), { outputRoot, markerPath })
}

// Guarded so importing this module (the unit tests do) never runs the CLI:
// `resolveDesktopRoot` reads the caller's `package.json` and `main` writes into a
// workspace, neither of which an import should trigger.
if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    main()
  } catch (error) {
    process.stderr.write(`prepare-git-ai: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exit(1)
  }
}

export { EXECUTABLE, TARGETS, VERSION, bundleManifest, main, parseTarget, resolveDesktopRoot, sameChecksums }