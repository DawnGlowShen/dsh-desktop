/**
 * Materialize the vendored Mnemon CLI for the packaging host.
 *
 * `@mnemon-dev/mnemon` publishes one self-contained Go binary per platform as a
 * version-suffixed package (`@mnemon-dev/mnemon@0.2.9-darwin-arm64`). This script
 * unpacks the one matching the packaging host into
 * `dsh-plugin-desktop/build/mnemon/host`, which `build.extraResources` then
 * copies into the installer as `resources/mnemon`.
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
 * Unlike CodeGraph, the archive carries no Node runtime: `bin/mnemon` is a
 * single static executable, so there is nothing to keep runnable alongside it.
 *
 * Usage:
 *   node scripts/prepare-mnemon.mjs                 # host platform and arch
 *   node scripts/prepare-mnemon.mjs --target win32-x64
 *   node scripts/prepare-mnemon.mjs --target darwin-arm64   # unmerged, for rollback
 *   node scripts/prepare-mnemon.mjs --check         # fail if not prepared
 */

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { mergeUniversalBundle, normalizeUniversalManifest } from './prepare-universal-bundle.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const vendorRoot = join(root, 'vendor', 'mnemon')

/**
 * Workspace receiving the materialized bundle.
 *
 * Both editions run this from their own workspace root (`node
 * ../scripts/prepare-mnemon.mjs`), and each declares its own
 * `build.extraResources` relative to that workspace. Resolving against the
 * caller's directory is therefore required: a fixed `dsh-plugin-desktop` path
 * would prepare the stable tree while the beta build reads its own, silently
 * shipping an edition without the CLI.
 */
function resolveDesktopRoot() {
  const declared = process.argv.indexOf('--desktop')
  const candidate = declared === -1 ? process.cwd() : resolve(process.argv[declared + 1] ?? '')
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

const desktopRoot = resolveDesktopRoot()
const buildRoot = join(desktopRoot, 'build', 'mnemon')
const outputRoot = join(buildRoot, 'host')
const markerPath = join(buildRoot, '.prepared.json')

/** Distributable license for every Mnemon artifact. */
const EXPECTED_LICENSE = 'Apache-2.0'

/**
 * Upstream package name inside every platform archive.
 *
 * The platform archives reuse the main package name and encode the platform in
 * the version instead (`0.2.9-darwin-arm64`), unlike CodeGraph whose platform
 * packages are suffixed in `name`. Asserting the wrong field would accept an
 * unrelated archive, so both are checked against the target key.
 */
const EXPECTED_PACKAGE_NAME = '@mnemon-dev/mnemon'

/** Per-target archive identity, pinned checksum, and required entry. */
const TARGETS = {
  'darwin-arm64': {
    archive: /^mnemon-darwin-arm64-.*\.tgz$/u,
    sha256: '004d6454625db1e880d83da057a801f9ec87fd08654af715d5d906ea1b2d464a',
    executables: ['bin/mnemon'],
  },
  'darwin-x64': {
    archive: /^mnemon-darwin-x64-.*\.tgz$/u,
    sha256: 'cbdc4053f889008d34c831888420132fcfe367578b120f660bbf90252c02eb9d',
    executables: ['bin/mnemon'],
  },
  // Fuses the two darwin archives into one payload the universal installer can
  // copy into both slices unchanged.
  'darwin-universal': {
    sources: ['darwin-arm64', 'darwin-x64'],
    executables: ['bin/mnemon'],
  },
  'win32-x64': {
    archive: /^mnemon-win32-x64-.*\.tgz$/u,
    sha256: '10e2d8d9e5f93d185018495b5c4822715bd0ad16873202f6d3b1a7696d6f69ef',
    executables: ['bin/mnemon.exe'],
  },
}

function fail(message) {
  process.stderr.write(`prepare-mnemon: ${message}\n`)
  process.exit(1)
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

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
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

function relativeToRoot(path) {
  return path.startsWith(root) ? path.slice(root.length + 1) : path
}

function readPrepared() {
  if (!existsSync(markerPath)) return undefined
  try {
    return JSON.parse(readFileSync(markerPath, 'utf8'))
  } catch {
    return undefined
  }
}

function extract(archive, destination) {
  rmSync(destination, { recursive: true, force: true })
  mkdirSync(destination, { recursive: true })
  // `tar` is bsdtar on macOS and on Windows 10 1803+; both accept --strip-components.
  const result = spawnSync('tar', ['-xzf', archive, '-C', destination, '--strip-components=1'], {
    encoding: 'utf8',
  })
  if (result.error !== undefined) fail(`tar failed to start: ${result.error.message}`)
  if (result.status !== 0) fail(`tar exited with ${String(result.status)}: ${result.stderr.trim()}`)
}

function readManifest(destination) {
  const manifestPath = join(destination, 'package.json')
  if (!existsSync(manifestPath)) fail(`extracted archive has no package.json`)
  return JSON.parse(readFileSync(manifestPath, 'utf8'))
}

/** extraResources bypasses verify-licenses, so the redistribution gate runs here. */
function assertLicense(manifest) {
  if (manifest.license !== EXPECTED_LICENSE) {
    fail(`${EXPECTED_PACKAGE_NAME} declares license ${String(manifest.license)}, expected ${EXPECTED_LICENSE}`)
  }
}

/** The platform is encoded in the version, not in the package name. */
function assertPlatformVersion(manifest, targetKey) {
  const version = /-.*$/u.test(manifest.version ?? '') ? manifest.version : undefined
  const suffix = typeof version === 'string' ? version.slice(version.indexOf('-') + 1) : ''
  if (suffix !== targetKey) {
    fail(`archive declares version ${String(manifest.version)}, expected a ${targetKey} build`)
  }
}

function assertExecutable(destination, target) {
  for (const entry of target.executables) {
    const path = join(destination, entry)
    if (!existsSync(path)) fail(`extracted archive is missing ${entry}`)
    if (!statSync(path).isFile()) fail(`extracted archive entry is not a file: ${entry}`)
  }
  // The binary is executed directly, so it must carry the executable bit.
  if (target.key.startsWith('darwin')) {
    for (const entry of target.executables) chmodSync(join(destination, entry), 0o755)
    for (const entry of target.executables) {
      if ((statSync(join(destination, entry)).mode & 0o111) === 0) {
        fail(`${entry} is not executable after extraction`)
      }
    }
  }
}

function verify(destination, target, archive) {
  const manifest = readManifest(destination)
  if (manifest.name !== EXPECTED_PACKAGE_NAME) {
    fail(`archive declares ${String(manifest.name)}, expected ${EXPECTED_PACKAGE_NAME}`)
  }
  assertPlatformVersion(manifest, target.key)
  assertLicense(manifest)
  assertExecutable(destination, target)

  const entryPoint = join(destination, target.executables[0])
  return {
    target: target.key,
    packageName: EXPECTED_PACKAGE_NAME,
    version: manifest.version,
    archive: relativeToRoot(archive),
    archiveSha256: sha256(archive),
    entryPoint: relativeToRoot(entryPoint),
  }
}

/**
 * Fuse the darwin archives, then record the x64 archive's checksum so `--check`
 * and the reuse branch keep working off a single value.
 */
function prepareUniversal(target, sources) {
  const staging = join(buildRoot, '.sources')
  try {
    const manifests = {}
    for (const source of sources) {
      const destination = join(staging, source.targetKey)
      extract(source.archive, destination)
      const manifest = readManifest(destination)
      if (manifest.name !== EXPECTED_PACKAGE_NAME) {
        fail(`${source.targetKey} archive declares ${String(manifest.name)}, expected ${EXPECTED_PACKAGE_NAME}`)
      }
      assertPlatformVersion(manifest, source.targetKey)
      assertLicense(manifest)
      assertExecutable(destination, { ...target, key: source.targetKey })
      manifests[source.targetKey] = manifest
    }

    mergeUniversalBundle({
      arm64Dir: join(staging, 'darwin-arm64'),
      x64Dir: join(staging, 'darwin-x64'),
      outputRoot,
      // The two upstream manifests differ in version, description, and cpu. The
      // rewrite below replaces version and cpu; both slices read the same file,
      // so the mismatch never reaches @electron/universal.
      allowPlainDifferences: ['package.json', 'README.md'],
    })

    const x64Version = manifests['darwin-x64'].version
    const normalized = normalizeUniversalManifest(manifests['darwin-x64'], {
      version: x64Version.replace(/-darwin-x64$/u, '-darwin'),
      description: (manifests['darwin-x64'].description ?? '').replace(/darwin\/x64/u, 'darwin'),
    })
    writeFileSync(join(outputRoot, 'package.json'), `${JSON.stringify(normalized, null, 2)}\n`)

    const prepared = {
      target: target.key,
      packageName: EXPECTED_PACKAGE_NAME,
      version: x64Version,
      archive: relativeToRoot(sources[1].archive),
      archiveSha256: sha256(sources[1].archive),
      entryPoint: relativeToRoot(join(outputRoot, target.executables[0])),
    }
    writeFileSync(markerPath, `${JSON.stringify(prepared, null, 2)}\n`)
    process.stdout.write(
      `prepare-mnemon: prepared ${EXPECTED_PACKAGE_NAME}@${String(x64Version)} for ${target.key}\n`,
    )
  } finally {
    rmSync(staging, { recursive: true, force: true })
  }
}

const argv = process.argv.slice(2)
const checkOnly = argv.includes('--check')
const targetKey = parseTarget(argv)
const target = TARGETS[targetKey]
if (target === undefined) {
  fail(`unsupported target ${targetKey}; expected one of ${Object.keys(TARGETS).join(', ')}`)
}
target.key = targetKey

const sources = locateArchives(target)
for (const source of sources) {
  if (target.sources === undefined) {
    const actual = sha256(source.archive)
    if (actual !== target.sha256) {
      fail(
        `${relativeToRoot(source.archive)} has sha256 ${actual}, `
          + `expected ${target.sha256} — the vendored archive changed`,
      )
    }
  } else if (TARGETS[source.targetKey].sha256 !== sha256(source.archive)) {
    // Both halves are pinned individually; the pin catches a swapped archive
    // even though the universal marker can only record one checksum.
    fail(
      `${relativeToRoot(source.archive)} has sha256 ${sha256(source.archive)}, `
        + `expected ${TARGETS[source.targetKey].sha256} — the vendored archive changed`,
    )
  }
}
const expectedSha256 = sha256(sources[sources.length - 1].archive)
const existing = readPrepared()

if (checkOnly) {
  // `existing.entryPoint` is stored relative to the repository root for
  // readability, so it cannot be probed against an arbitrary working directory.
  // Probe the location this run resolved instead.
  const preparedEntryPoint = join(outputRoot, target.executables[0])
  // The target is part of the identity: the universal bundle and the darwin-x64
  // bundle share the x64 archive checksum, so a checksum match alone cannot tell
  // a two-architecture payload from a single-architecture one.
  if (existing === undefined || existing.target !== targetKey
    || existing.archiveSha256 !== expectedSha256 || !existsSync(preparedEntryPoint)) {
    fail(`Mnemon CLI for ${targetKey} is not prepared; run node scripts/prepare-mnemon.mjs`)
  }
  process.stdout.write(`prepare-mnemon: ${existing.packageName}@${existing.version} is prepared\n`)
} else if (
  existing?.target === targetKey
  && existing.archiveSha256 === expectedSha256
  && existsSync(outputRoot)
  && existsSync(join(outputRoot, target.executables[0]))
) {
  process.stdout.write(`prepare-mnemon: reusing ${existing.packageName}@${existing.version} for ${targetKey}\n`)
} else if (target.sources !== undefined) {
  prepareUniversal(target, sources)
} else {
  extract(sources[0].archive, outputRoot)
  const prepared = verify(outputRoot, target, sources[0].archive)
  writeFileSync(markerPath, `${JSON.stringify(prepared, null, 2)}\n`)
  process.stdout.write(`prepare-mnemon: prepared ${prepared.packageName}@${prepared.version} for ${targetKey}\n`)
}
