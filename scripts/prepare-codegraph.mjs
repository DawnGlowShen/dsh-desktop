/**
 * Materialize the vendored CodeGraph CLI for the packaging host.
 *
 * `@colbymchenry/codegraph` ships its real artifact as a per-platform optional
 * dependency (`codegraph-<platform>-<arch>`) that bundles its own Node runtime.
 * This script unpacks the one matching the packaging host into
 * `dsh-plugin-desktop/build/codegraph/host`, which `build.extraResources` then
 * copies into the installer as `resources/codegraph`.
 *
 * The CLI deliberately does NOT become a Yarn dependency: a platform package
 * carrying `"cpu": ["arm64"]` can be skipped for the x64 slice of a macOS
 * universal build, which would make the two slices differ and break
 * `@electron/universal`. A static `extraResources` copy keeps both slices
 * byte-identical.
 *
 * macOS therefore ships ONE merged bundle: the `darwin-universal` target fuses
 * the darwin-arm64 and darwin-x64 archives with `lipo`, so the single copied
 * payload runs on both slices and its manifest declares both architectures.
 *
 * Usage:
 *   node scripts/prepare-codegraph.mjs                 # host platform and arch
 *   node scripts/prepare-codegraph.mjs --target win32-x64
 *   node scripts/prepare-codegraph.mjs --target darwin-arm64   # unmerged, for rollback
 *   node scripts/prepare-codegraph.mjs --check         # fail if not prepared
 */

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import { isMachO, mergeUniversalBundle, normalizeUniversalManifest } from './prepare-universal-bundle.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const vendorRoot = join(root, 'vendor', 'codegraph')

/** Distributable license for every CodeGraph artifact. */
const EXPECTED_LICENSE = 'MIT'

/** Platform package names always start with this, whichever architecture they carry. */
const PACKAGE_NAME_PREFIX = '@colbymchenry/codegraph-'

/**
 * Per-target package identity, archive prefix, pinned checksum, and required
 * entries.
 *
 * The checksum pins the vendored archive itself. Without it the only guards are
 * the archive's own `name` and `license` fields, so any rebuilt tarball that
 * declares the expected identity would be accepted silently.
 */
const TARGETS = {
  'darwin-arm64': {
    packageName: '@colbymchenry/codegraph-darwin-arm64',
    archive: /^colbymchenry-codegraph-darwin-arm64-.*\.tgz$/u,
    sha256: '3f501578d2360c58e56a348f1b1b0ee17d6b1fb3db9bb70d78443ed7754b2908',
    executables: ['bin/codegraph', 'node'],
  },
  'darwin-x64': {
    packageName: '@colbymchenry/codegraph-darwin-x64',
    archive: /^colbymchenry-codegraph-darwin-x64-.*\.tgz$/u,
    sha256: '0573a6322db1ff72d1b1a5f30f2e8893712c224423655d2b46e56842e7237627',
    executables: ['bin/codegraph', 'node'],
  },
  // Fuses the two darwin archives into one payload the universal installer can
  // copy into both slices unchanged. Its published name is not taken from here:
  // `prepareUniversal` writes `${PACKAGE_NAME_PREFIX}universal`.
  'darwin-universal': {
    sources: ['darwin-arm64', 'darwin-x64'],
    executables: ['bin/codegraph', 'node'],
  },
  'win32-x64': {
    packageName: '@colbymchenry/codegraph-win32-x64',
    archive: /^colbymchenry-codegraph-win32-x64-.*\.tgz$/u,
    sha256: '2c33189a7a358c5c953ec11d83a8f7353e8d4703c6b59b290399135b9b6591d5',
    executables: ['bin/codegraph.cmd', 'node.exe'],
  },
  'win32-arm64': {
    packageName: '@colbymchenry/codegraph-win32-arm64',
    archive: /^colbymchenry-codegraph-win32-arm64-.*\.tgz$/u,
    executables: ['bin/codegraph.cmd', 'node.exe'],
  },
}

/**
 * Throwing rather than exiting: `process.exit` skips `finally` blocks, so the
 * staging directory in `prepareUniversal` would survive every validation
 * failure (hundreds of megabytes). `main` owns the exit code instead.
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
  // unmerged per-architecture bundles.
  return process.platform === 'darwin' ? 'darwin-universal' : `${process.platform}-${process.arch}`
}

/**
 * Workspace receiving the materialized bundle.
 *
 * Both editions run this from their own workspace root (`node
 * ../scripts/prepare-codegraph.mjs`), and each declares its own
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

/** Resolve the single archive belonging to one architecture target key. */
function locateArchive(targetKey) {
  if (!existsSync(vendorRoot)) {
    fail(`vendored directory is missing: ${relativeToRoot(vendorRoot)}`)
  }
  const { archive } = TARGETS[targetKey]
  const matches = readdirSync(vendorRoot).filter(name => archive.test(name)).sort()
  if (matches.length === 0) {
    fail(`no vendored archive for ${targetKey} in ${relativeToRoot(vendorRoot)}`)
  }
  if (matches.length > 1) {
    fail(`multiple vendored archives for ${targetKey}: ${matches.join(', ')}`)
  }
  return join(vendorRoot, matches[0])
}

/** Resolve the archives a target needs, in declaration order. */
function locateArchives(target) {
  return target.sources === undefined
    ? [{ targetKey: target.key, archive: locateArchive(target.key) }]
    : target.sources.map(targetKey => ({ targetKey, archive: locateArchive(targetKey) }))
}

/**
 * Checksum every input archive, keyed by target.
 *
 * A universal payload takes its plain files from the arm64 half, so pinning the
 * x64 checksum alone would let a replaced arm64 archive keep an already-built
 * bundle in place while reporting it as current.
 */
function archiveChecksums(sources) {
  return Object.fromEntries(sources.map(source => [source.targetKey, sha256(source.archive)]))
}

/** Order-independent comparison, so a reordered marker still matches. */
function sameChecksums(left, right) {
  if (left === undefined || right === undefined) return false
  const leftKeys = Object.keys(left)
  if (leftKeys.length !== Object.keys(right).length) return false
  return leftKeys.every(key => left[key] === right[key])
}

function readPrepared(markerPath) {
  if (!existsSync(markerPath)) return undefined
  try {
    return JSON.parse(readFileSync(markerPath, 'utf8'))
  } catch {
    return undefined
  }
}

/**
 * Reject anything the archive could have placed outside its own extraction
 * root.
 *
 * `tar` already refuses `..` entries, but a symlink entry pointing at a host
 * path would survive extraction and make the later `chmodSync` rewrite the
 * permissions of a file outside the destination.
 */
function assertContainedExtraction(destination) {
  const destinationReal = realpathSync(destination)
  const walk = directory => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name)
      const stats = lstatSync(absolute)
      if (stats.isSymbolicLink()) {
        fail(`archive entry is a symbolic link: ${relative(destination, absolute)}`)
      }
      if (stats.isDirectory()) {
        walk(absolute)
        continue
      }
      if (!stats.isFile()) fail(`archive entry is not a regular file: ${relative(destination, absolute)}`)
      const real = realpathSync(absolute)
      if (real !== destinationReal && !real.startsWith(destinationReal + sep)) {
        fail(`archive entry escapes the extraction root: ${relative(destination, absolute)}`)
      }
    }
  }
  walk(destinationReal)
}

function extract(archive, destination) {
  rmSync(destination, { recursive: true, force: true })
  mkdirSync(destination, { recursive: true })
  // `tar` is bsdtar on macOS and on Windows 10 1803+; both accept
  // --strip-components and the two ownership/permission flags below.
  const result = spawnSync(
    'tar',
    ['-xzf', archive, '-C', destination, '--strip-components=1', '--no-same-owner', '--no-same-permissions'],
    { encoding: 'utf8' },
  )
  if (result.error !== undefined) fail(`tar failed to start: ${result.error.message}`)
  if (result.status !== 0) fail(`tar exited with ${String(result.status)}: ${result.stderr.trim()}`)
  assertContainedExtraction(destination)
}

function readManifest(destination) {
  const manifestPath = join(destination, 'package.json')
  if (!existsSync(manifestPath)) fail(`extracted archive has no package.json`)
  return JSON.parse(readFileSync(manifestPath, 'utf8'))
}

/** extraResources bypasses verify-licenses, so the redistribution gate runs here. */
function assertLicense(manifest, label) {
  if (manifest.license !== EXPECTED_LICENSE) {
    fail(`${label} declares license ${String(manifest.license)}, expected ${EXPECTED_LICENSE}`)
  }
}

function assertExecutables(destination, { executables, targetKey }) {
  for (const entry of executables) {
    const path = join(destination, entry)
    // `lstatSync`: a symlink here would redirect the chmod below outside the
    // destination. `assertContainedExtraction` already rejected links, and this
    // keeps the guarantee local to the function that changes permissions.
    if (!existsSync(path)) fail(`extracted archive is missing ${entry}`)
    if (!lstatSync(path).isFile()) fail(`extracted archive entry is not a file: ${entry}`)
  }
  // The launcher execs its bundled runtime by relative path, so both must be runnable.
  if (targetKey.startsWith('darwin')) {
    for (const entry of executables) chmodSync(join(destination, entry), 0o755)
    for (const entry of executables) {
      if ((statSync(join(destination, entry)).mode & 0o111) === 0) {
        fail(`${entry} is not executable after extraction`)
      }
    }
  }
}

/** Executables the payload is supposed to contain but does not. */
function missingExecutables(target, outputRoot) {
  return target.executables.filter(entry => !existsSync(join(outputRoot, entry)))
}

function verify(destination, target, archive, archiveSha256) {
  const manifest = readManifest(destination)
  if (manifest.name !== target.packageName) {
    fail(`archive declares ${String(manifest.name)}, expected ${target.packageName}`)
  }
  assertLicense(manifest, target.packageName)
  assertExecutables(destination, { executables: target.executables, targetKey: target.key })

  return {
    target: target.key,
    packageName: target.packageName,
    version: manifest.version,
    archive: relativeToRoot(archive),
    archiveSha256: { [target.key]: archiveSha256 },
    entryPoint: relativeToRoot(join(destination, target.executables[0])),
  }
}

/**
 * Fuse the darwin archives into one dual-architecture payload.
 *
 * The merged names and the shipped files come from these two archives and
 * nowhere else, so the caller writes the merged manifest and the marker after
 * every check has passed.
 */
function prepareUniversal(target, sources, { buildRoot, outputRoot, markerPath }) {
  const staging = join(buildRoot, '.sources')
  try {
    const manifests = {}
    for (const source of sources) {
      const destination = join(staging, source.targetKey)
      extract(source.archive, destination)
      const manifest = readManifest(destination)
      // Both halves must still be redistributable under the same license.
      assertLicense(manifest, `${source.targetKey} archive`)
      assertExecutables(destination, { executables: target.executables, targetKey: source.targetKey })
      manifests[source.targetKey] = manifest
    }
    for (const key of Object.keys(manifests)) {
      const manifest = manifests[key]
      if (typeof manifest.name !== 'string' || !manifest.name.startsWith(PACKAGE_NAME_PREFIX)) {
        fail(`${key} archive declares ${String(manifest.name)}, expected a ${PACKAGE_NAME_PREFIX}* package`)
      }
    }

    mergeUniversalBundle({
      arm64Dir: join(staging, 'darwin-arm64'),
      x64Dir: join(staging, 'darwin-x64'),
      outputRoot,
      // The two upstream manifests differ in name, description, and cpu. The
      // rewrite below replaces every differing field, and both slices read the
      // same file, so the mismatch never reaches @electron/universal.
      allowPlainDifferences: ['package.json'],
    })

    const x64Version = manifests['darwin-x64'].version
    const normalized = normalizeUniversalManifest(manifests['darwin-x64'], {
      name: `${PACKAGE_NAME_PREFIX}universal`,
      // Fixed rather than patched out of the upstream sentence: a wording change
      // upstream would otherwise leave a `-x64` suffix behind in the payload.
      description: 'CodeGraph self-contained bundle for darwin',
    })
    writeFileSync(join(outputRoot, 'package.json'), `${JSON.stringify(normalized, null, 2)}\n`)

    const prepared = {
      target: target.key,
      packageName: normalized.name,
      version: x64Version,
      archive: relativeToRoot(sources[sources.length - 1].archive),
      archiveSha256: archiveChecksums(sources),
      entryPoint: relativeToRoot(join(outputRoot, target.executables[0])),
    }
    writeFileSync(markerPath, `${JSON.stringify(prepared, null, 2)}\n`)
    process.stdout.write(
      `prepare-codegraph: prepared ${String(normalized.name)}@${String(x64Version)} for ${target.key}\n`,
    )
  } finally {
    rmSync(staging, { recursive: true, force: true })
  }
}

/** Confirm the merged payload really carries both slices, not just a manifest claim. */
function assertUniversalArchitectures(target, outputRoot) {
  // `bin/codegraph` is a POSIX shell script, so only the entries that are
  // actually Mach-O can be handed to `lipo`; it exits 1 on a text file.
  const binaries = target.executables
    .map(entry => ({ entry, path: join(outputRoot, entry) }))
    .filter(candidate => existsSync(candidate.path) && isMachO(candidate.path))
  if (binaries.length === 0) {
    fail(`none of ${target.executables.join(', ')} is a Mach-O binary; run node scripts/prepare-codegraph.mjs`)
  }
  for (const { entry, path } of binaries) {
    const result = spawnSync('lipo', [path, '-archs'], { encoding: 'utf8' })
    if (result.error !== undefined) fail(`lipo failed to start: ${result.error.message}`)
    const archs = result.stdout.trim().split(/\s+/u).filter(arch => arch !== '')
    if (result.status !== 0 || !archs.includes('x86_64') || !archs.includes('arm64')) {
      fail(`${entry} is not a universal binary; run node scripts/prepare-codegraph.mjs`)
    }
  }
}

function main() {
  const argv = process.argv.slice(2)
  const checkOnly = argv.includes('--check')
  const targetKey = parseTarget(argv)
  // `Object.hasOwn` rather than an `undefined` check: `TARGETS['__proto__']`
  // resolves through the prototype chain to `Object.prototype`, which is not
  // `undefined`, so a bare undefined test would accept it and then write a `key`
  // field onto `Object.prototype`.
  const target = Object.hasOwn(TARGETS, targetKey) ? TARGETS[targetKey] : undefined
  if (target === undefined) {
    fail(`unsupported target ${targetKey}; expected one of ${Object.keys(TARGETS).join(', ')}`)
  }
  target.key = targetKey

  const desktopRoot = resolveDesktopRoot(argv)
  const buildRoot = join(desktopRoot, 'build', 'codegraph')
  const outputRoot = join(buildRoot, 'host')
  const markerPath = join(buildRoot, '.prepared.json')

  const sources = locateArchives(target)
  // Hash each archive once: the pin check and the marker identity need the same
  // value, and these archives are tens of megabytes.
  const checksums = archiveChecksums(sources)
  for (const source of sources) {
    const declared = TARGETS[source.targetKey].sha256
    if (declared === undefined) continue
    const actual = checksums[source.targetKey]
    if (actual !== declared) {
      fail(`${relativeToRoot(source.archive)} has sha256 ${actual}, expected ${declared} — the vendored archive changed`)
    }
  }
  const existing = readPrepared(markerPath)
  const missing = missingExecutables(target, outputRoot)
  // The target is part of the identity: the universal bundle and the darwin-x64
  // bundle share the x64 archive checksum, so a checksum match alone cannot tell
  // a two-architecture payload from a single-architecture one. Every executable
  // is probed, because the merge writes the plain launcher before the `lipo`
  // runtime it wraps, so a half-finished merge still has `bin/codegraph`.
  const reusable = existing?.target === targetKey
    && sameChecksums(existing.archiveSha256, checksums)
    && missing.length === 0

  if (checkOnly) {
    if (!reusable) {
      fail(
        `CodeGraph CLI for ${targetKey} is not prepared`
          + `${missing.length > 0 ? ` (missing ${missing.join(', ')})` : ''}; run node scripts/prepare-codegraph.mjs`,
      )
    }
    if (target.sources !== undefined) assertUniversalArchitectures(target, outputRoot)
    process.stdout.write(`prepare-codegraph: ${String(existing.packageName)}@${String(existing.version)} is prepared\n`)
    return
  }

  if (reusable) {
    process.stdout.write(
      `prepare-codegraph: reusing ${String(existing.packageName)}@${String(existing.version)} for ${targetKey}\n`,
    )
    return
  }

  if (target.sources !== undefined) {
    prepareUniversal(target, sources, { buildRoot, outputRoot, markerPath })
    return
  }

  extract(sources[0].archive, outputRoot)
  const prepared = verify(outputRoot, target, sources[0].archive, checksums[targetKey])
  writeFileSync(markerPath, `${JSON.stringify(prepared, null, 2)}\n`)
  process.stdout.write(`prepare-codegraph: prepared ${prepared.packageName}@${prepared.version} for ${targetKey}\n`)
}

try {
  main()
} catch (error) {
  process.stderr.write(`prepare-codegraph: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exit(1)
}
