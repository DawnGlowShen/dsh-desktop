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
 * Usage:
 *   node scripts/prepare-codegraph.mjs                 # host platform and arch
 *   node scripts/prepare-codegraph.mjs --target win32-x64
 *   node scripts/prepare-codegraph.mjs --check         # fail if not prepared
 */

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const vendorRoot = join(root, 'vendor', 'codegraph')

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
const buildRoot = join(desktopRoot, 'build', 'codegraph')
const outputRoot = join(buildRoot, 'host')
const markerPath = join(buildRoot, '.prepared.json')

/** Distributable license for every CodeGraph artifact. */
const EXPECTED_LICENSE = 'MIT'

/** Per-target package identity, archive prefix, and required entries. */
const TARGETS = {
  'darwin-arm64': {
    packageName: '@colbymchenry/codegraph-darwin-arm64',
    archive: /^colbymchenry-codegraph-darwin-arm64-.*\.tgz$/u,
    executables: ['bin/codegraph', 'node'],
  },
  'darwin-x64': {
    packageName: '@colbymchenry/codegraph-darwin-x64',
    archive: /^colbymchenry-codegraph-darwin-x64-.*\.tgz$/u,
    executables: ['bin/codegraph', 'node'],
  },
  'win32-x64': {
    packageName: '@colbymchenry/codegraph-win32-x64',
    archive: /^colbymchenry-codegraph-win32-x64-.*\.tgz$/u,
    executables: ['bin/codegraph.cmd', 'node.exe'],
  },
  'win32-arm64': {
    packageName: '@colbymchenry/codegraph-win32-arm64',
    archive: /^colbymchenry-codegraph-win32-arm64-.*\.tgz$/u,
    executables: ['bin/codegraph.cmd', 'node.exe'],
  },
}

function fail(message) {
  process.stderr.write(`prepare-codegraph: ${message}\n`)
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
    fail(`no vendored archive for ${target.target} in ${relativeToRoot(vendorRoot)}`)
  }
  if (matches.length > 1) {
    fail(`multiple vendored archives for ${target.target}: ${matches.join(', ')}`)
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
  if (manifest.name !== target.packageName) {
    fail(`archive declares ${String(manifest.name)}, expected ${target.packageName}`)
  }
  // extraResources bypasses verify-licenses, so the redistribution gate runs here.
  if (manifest.license !== EXPECTED_LICENSE) {
    fail(`${target.packageName} declares license ${String(manifest.license)}, expected ${EXPECTED_LICENSE}`)
  }

  for (const entry of target.executables) {
    const path = join(destination, entry)
    if (!existsSync(path)) fail(`extracted archive is missing ${entry}`)
    if (!statSync(path).isFile()) fail(`extracted archive entry is not a file: ${entry}`)
  }
  // The launcher execs its bundled runtime by relative path, so both must be runnable.
  if (!target.packageName.includes('win32')) {
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
    packageName: target.packageName,
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
const existing = readPrepared()

if (checkOnly) {
  if (existing === undefined || existing.archiveSha256 !== expectedSha256 || !existsSync(existing.entryPoint)) {
    fail(`CodeGraph CLI for ${targetKey} is not prepared; run node scripts/prepare-codegraph.mjs`)
  }
  process.stdout.write(`prepare-codegraph: ${existing.packageName}@${existing.version} is prepared\n`)
} else if (existing?.archiveSha256 === expectedSha256 && existsSync(outputRoot) && existsSync(join(outputRoot, target.executables[0]))) {
  process.stdout.write(`prepare-codegraph: reusing ${existing.packageName}@${existing.version} for ${targetKey}\n`)
} else {
  extract(archive, outputRoot)
  const prepared = verify(outputRoot, target, archive)
  writeFileSync(markerPath, `${JSON.stringify(prepared, null, 2)}\n`)
  process.stdout.write(`prepare-codegraph: prepared ${prepared.packageName}@${prepared.version} for ${targetKey}\n`)
}
