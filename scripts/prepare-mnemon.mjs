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
 * Unlike CodeGraph, the archive carries no Node runtime: `bin/mnemon` is a
 * single static executable, so there is nothing to keep runnable alongside it.
 *
 * Usage:
 *   node scripts/prepare-mnemon.mjs                 # host platform and arch
 *   node scripts/prepare-mnemon.mjs --target win32-x64
 *   node scripts/prepare-mnemon.mjs --check         # fail if not prepared
 */

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

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
  if (index === -1) return `${process.platform}-${process.arch}`
  const value = argv[index + 1]
  if (value === undefined) fail('--target requires a value such as darwin-arm64')
  return value
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function locateArchive(target) {
  if (!existsSync(vendorRoot)) {
    fail(`vendored directory is missing: ${relativeToRoot(vendorRoot)}`)
  }
  const matches = readdirSync(vendorRoot).filter(name => target.archive.test(name)).sort()
  if (matches.length === 0) {
    fail(`no vendored archive for ${target.key} in ${relativeToRoot(vendorRoot)}`)
  }
  if (matches.length > 1) {
    fail(`multiple vendored archives for ${target.key}: ${matches.join(', ')}`)
  }
  return join(vendorRoot, matches[0])
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

function verify(destination, target, archive) {
  const manifestPath = join(destination, 'package.json')
  if (!existsSync(manifestPath)) fail(`extracted archive has no package.json`)

  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  if (manifest.name !== EXPECTED_PACKAGE_NAME) {
    fail(`archive declares ${String(manifest.name)}, expected ${EXPECTED_PACKAGE_NAME}`)
  }
  // The platform is encoded in the version, not in the package name.
  const expectedVersion = /-.*$/u.test(manifest.version ?? '') ? manifest.version : undefined
  const suffix = typeof expectedVersion === 'string' ? expectedVersion.slice(expectedVersion.indexOf('-') + 1) : ''
  if (suffix !== target.key) {
    fail(`archive declares version ${String(manifest.version)}, expected a ${target.key} build`)
  }
  // extraResources bypasses verify-licenses, so the redistribution gate runs here.
  if (manifest.license !== EXPECTED_LICENSE) {
    fail(`${EXPECTED_PACKAGE_NAME} declares license ${String(manifest.license)}, expected ${EXPECTED_LICENSE}`)
  }

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

const argv = process.argv.slice(2)
const checkOnly = argv.includes('--check')
const targetKey = parseTarget(argv)
const target = TARGETS[targetKey]
if (target === undefined) {
  fail(`unsupported target ${targetKey}; expected one of ${Object.keys(TARGETS).join(', ')}`)
}
target.key = targetKey

const archive = locateArchive(target)
const expectedSha256 = sha256(archive)
if (expectedSha256 !== target.sha256) {
  fail(
    `${relativeToRoot(archive)} has sha256 ${expectedSha256}, `
      + `expected ${target.sha256} — the vendored archive changed`,
  )
}
const existing = readPrepared()

if (checkOnly) {
  // `existing.entryPoint` is stored relative to the repository root for
  // readability, so it cannot be probed against an arbitrary working directory.
  // Probe the location this run resolved instead.
  const preparedEntryPoint = join(outputRoot, target.executables[0])
  if (existing === undefined || existing.archiveSha256 !== expectedSha256 || !existsSync(preparedEntryPoint)) {
    fail(`Mnemon CLI for ${targetKey} is not prepared; run node scripts/prepare-mnemon.mjs`)
  }
  process.stdout.write(`prepare-mnemon: ${existing.packageName}@${existing.version} is prepared\n`)
} else if (existing?.archiveSha256 === expectedSha256 && existsSync(outputRoot) && existsSync(join(outputRoot, target.executables[0]))) {
  process.stdout.write(`prepare-mnemon: reusing ${existing.packageName}@${existing.version} for ${targetKey}\n`)
} else {
  extract(archive, outputRoot)
  const prepared = verify(outputRoot, target, archive)
  writeFileSync(markerPath, `${JSON.stringify(prepared, null, 2)}\n`)
  process.stdout.write(`prepare-mnemon: prepared ${prepared.packageName}@${prepared.version} for ${targetKey}\n`)
}
