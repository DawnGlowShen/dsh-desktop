/**
 * Verify the offline CLI payload and publish the per-platform CLI manifest.
 *
 * ## The payload is the only input
 *
 * Every CLI tarball under `vendor/offline-install/` is committed, so this script never
 * builds anything: it checks that the artifacts named for each target are present and
 * well formed, then writes that target's manifest. A checkout produces a working
 * application with no network access and no inputs beyond the repository.
 *
 * The payload is shared by every Desktop package, so it is authored once at the
 * repository root rather than inside each: the package the script is invoked from
 * identifies the repository, and both packages therefore read and write the same files.
 *
 * ## Why the manifest is generated rather than hand-written
 *
 * The manifest lists each artifact's tarball name, version, and the executable the
 * installer must find inside it. All three are facts about the tarball, and a
 * hand-written copy would drift the moment a version is bumped — producing an install
 * that fails on a user's machine, after the application has shipped. Deriving them here
 * means a stale manifest is a build failure, not a support ticket.
 *
 * ## Bumping a CLI version
 *
 * Replace the tarballs for that CLI across all targets and re-run this script. The
 * artifact must unpack to `<command>/bin/<command>` (the installer strips that single
 * top-level directory), and the command name comes from the file name:
 * `<command>-<version>-<target>.tgz`.
 *
 * ## Platform targets
 *
 * A target is one (os, cpu) pair the application can be packaged for. macOS ships a
 * single universal application, so its target is `darwin-universal` and its tarballs
 * must run on both architectures — see the note in `CLI_TARGETS`.
 *
 * Usage:
 *   node scripts/prepare-offline-clis.mjs --target darwin-universal
 *   node scripts/prepare-offline-clis.mjs --all
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** Name of the directory holding the payload; the tarballs sit beside the plugins. */
export const PAYLOAD_DIRECTORY = 'offline-install'

/**
 * The payload directory shared by every Desktop package.
 *
 * One level above a Desktop package rather than inside it: every package ships the same
 * payload, and a copy per package is a copy that can silently fall out of date.
 *
 * @param desktopRoot - Desktop package root.
 * @returns Absolute path of the shared payload directory.
 */
export function payloadDirectory(desktopRoot) {
  return resolve(desktopRoot, '..', 'vendor', PAYLOAD_DIRECTORY)
}

/**
 * Every target the payload can be built for.
 *
 * `darwin-universal` is one target rather than two because the application is packaged
 * with `--universal`: `@electron/universal` compares every non-Mach-O file across the
 * two slices and fails on any difference, so both slices must read one artifact. The
 * darwin tarballs therefore carry both architectures and must be merged with `lipo`;
 * shipping `darwin-arm64` and `darwin-x64` separately would fail that comparison.
 */
export const CLI_TARGETS = ['darwin-universal', 'linux-x64', 'win32-x64']

/** Throwing rather than exiting: `process.exit` skips `finally`, leaving staged files behind. */
function fail(message) {
  throw new Error(message)
}

/** One CLI the payload ships, as read back from its artifacts. */
export function cliManifestName(target) {
  return `manifest.clis.${target}.json`
}

/** Name of an artifact, e.g. `codegraph-1.6.0-darwin-universal.tgz`. */
function artifactName(command, version, target) {
  return `${command}-${version}-${target}.tgz`
}

/**
 * Parse `<command>-<version>-<target>.tgz`.
 *
 * Neither hyphen is a usable separator on its own, because both sides can contain one:
 * `git-ai-1.7.5` has a hyphenated command and `dsh-git-ai-0.1.2-evo` a hyphenated
 * version. What does separate them is that a version always begins with a digit and a
 * command never does, so the split is made at the first `-<digit>` boundary. That is the
 * same rule npm's own tarball naming relies on. A target with a `-<digit>` inside it
 * would break the rule, which is why `CLI_TARGETS` is a fixed list.
 *
 * @returns The command and version, or undefined when the name is not an artifact.
 */
export function parseArtifactName(name, target) {
  if (!name.endsWith(`-${target}.tgz`)) return undefined
  const body = name.slice(0, -`-${target}.tgz`.length)
  const boundary = /-(?=\d)/u.exec(body)
  if (boundary === null || boundary.index === 0) return undefined
  const version = body.slice(boundary.index + 1)
  if (version === '') return undefined
  return { command: body.slice(0, boundary.index), version }
}

/**
 * Every member of a tarball, as paths relative to its root.
 *
 * Carriage returns are stripped rather than left on the line ends: GNU tar on Windows
 * writes `\r\n`, so splitting on `\n` alone yields `bin/codegraph.cmd\r` — a name that
 * compares unequal to the `bin/codegraph.cmd` the archive really contains, making every
 * Windows entry point look missing.
 */
export function archiveMembers(path) {
  const listing = execFileSync('tar', ['tzf', path], { encoding: 'utf8' })
  return listing.split('\n').map(line => line.replace(/\r$/u, '')).filter(line => line !== '')
}

/** Suffix marking one part of an archive split across files. */
const PART_SUFFIX = '.part-'

/**
 * Materialize one artifact so it can be inspected.
 *
 * A split archive is rejoined into a temporary file, because `tar` needs a single file
 * and the parts are only a hosting workaround. The temporary file is removed by the
 * caller.
 *
 * @param directory - Payload directory.
 * @param name - Archive name as the manifest will write it.
 * @param parts - Part names belonging to that archive, in order.
 * @returns Path to read, and whether the caller must delete it.
 */
function materializeArtifact(directory, name, parts) {
  if (parts.length === 0) return { path: join(directory, name), temporary: false }
  const path = join(directory, `.${name}.joined-${String(process.pid)}`)
  writeFileSync(path, Buffer.concat(parts.map(part => readFileSync(join(directory, part)))))
  return { path, temporary: true }
}

/**
 * Assert one artifact is shaped the way the installer requires.
 *
 * The installer unpacks with its single top-level directory stripped, so the archive
 * must have exactly one top-level directory — named after the command — and the
 * executable must sit directly under it. An archive with a second top-level entry (a
 * macOS AppleDouble `._<command>` sibling, for instance) is not stripped at all, and
 * every CLI then fails to install with "the archive contains no bin/<command>".
 */
function verifyArtifact(archive, command, target) {
  const members = archiveMembers(archive)
  if (members.length === 0) fail(`${path} is empty`)

  const tops = new Set(members.map(name => name.split('/')[0]))
  if (tops.size !== 1 || !tops.has(command)) {
    fail(
      `${command} ${target} has top-level entries ${[...tops].join(', ')}, expected only ${command}. `
        + `The installer strips a single top-level directory, so more than one leaves the `
        + `command nested and uninstallable.`,
    )
  }
  // Windows archives carry a `.exe` or `.cmd` entry point; the others a bare name. The
  // installer is told which, and a mismatch fails on the user's machine at install time,
  // so the choice is made here by looking, not by assuming.
  const candidates = members.filter(name => name.startsWith(`${command}/bin/`))
  if (candidates.length === 0) {
    fail(`${command} ${target} has no ${command}/bin/ entry point`)
  }
  return candidates
}

/** The executable path the installer should look for inside one artifact. */
function executableFor(command, target, members) {
  const preference = target === 'win32-x64'
    ? [`${command}/bin/${command}.cmd`, `${command}/bin/${command}.exe`]
    : [`${command}/bin/${command}`]
  for (const candidate of preference) {
    if (members.includes(candidate)) return candidate.slice(`${command}/`.length)
  }
  fail(
    `${command} ${target} has none of ${preference.join(', ')}; `
      + `found ${members.filter(name => name.startsWith(`${command}/bin/`)).join(', ')}`,
  )
}

/**
 * Verify every artifact for one target and write its manifest.
 *
 * @param desktopRoot - Desktop package root holding the payload.
 * @param target - One of CLI_TARGETS.
 * @param log - Progress sink.
 * @returns The manifest that was written.
 */
export function prepareOfflineClis(desktopRoot, target, log = () => {}) {
  if (!CLI_TARGETS.includes(target)) {
    fail(`unknown target ${target}; known targets are ${CLI_TARGETS.join(', ')}`)
  }
  const directory = payloadDirectory(desktopRoot)
  if (!existsSync(directory)) fail(`no payload directory at ${directory}`)

  const clis = []
  // Grouped by archive name so a split artifact is one entry, not one per part: the
  // manifest names the archive, and the installer rejoins the parts itself.
  const archives = new Map()
  for (const name of readdirSync(directory).sort()) {
    const at = name.indexOf(PART_SUFFIX)
    const archive = at === -1 ? name : name.slice(0, at)
    const entry = archives.get(archive) ?? { parts: [] }
    if (at === -1) entry.whole = true
    else entry.parts.push(name)
    archives.set(archive, entry)
  }

  for (const [name, entry] of [...archives].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const parsed = parseArtifactName(name, target)
    if (parsed === undefined) continue
    if (entry.whole === true && entry.parts.length > 0) {
      fail(`${name} is present both whole and in ${String(entry.parts.length)} part(s); ship one or the other`)
    }
    const { path, temporary } = materializeArtifact(directory, name, entry.parts)
    try {
      const members = verifyArtifact(path, parsed.command, target)
      const executable = executableFor(parsed.command, target, members)
      clis.push({ name: parsed.command, version: parsed.version, tarball: name, executable })
    } finally {
      if (temporary) rmSync(path, { force: true })
    }
  }

  if (clis.length === 0) {
    fail(
      `no CLI artifacts for ${target} in ${directory}. `
        + `Expected files named <command>-<version>-${target}.tgz.`,
    )
  }
  // Two artifacts for one command means two versions, and which one installs would be
  // decided by directory order. Refused rather than picked: the stale one is the bug.
  const commands = clis.map(entry => entry.name)
  const duplicate = commands.find((name, index) => commands.indexOf(name) !== index)
  if (duplicate !== undefined) {
    fail(`${duplicate} has more than one artifact for ${target}: ${clis.filter(entry => entry.name === duplicate).map(entry => entry.tarball).join(', ')}`)
  }

  const manifest = { version: 1, target, clis }
  const manifestPath = join(directory, cliManifestName(target))
  mkdirSync(directory, { recursive: true })
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  log(`offline cli: ${target} verified ${String(clis.length)} CLI(s): ${commands.join(', ')}`)
  return manifest
}

/**
 * Read one target's published manifest.
 *
 * @param desktopRoot - Desktop package root.
 * @param target - Target to read.
 * @returns The parsed manifest, or undefined when that target was never prepared.
 */
export function readPreparedClis(desktopRoot, target) {
  const manifestPath = join(payloadDirectory(desktopRoot), cliManifestName(target))
  if (!existsSync(manifestPath)) return undefined
  return JSON.parse(readFileSync(manifestPath, 'utf8'))
}

/**
 * Whether one target's manifest is present.
 *
 * A manifest is proof of verification: it is only ever written after every artifact it
 * names was checked, so its presence means the payload is usable as-is.
 */
export function offlineClisReady(desktopRoot, target) {
  return existsSync(join(payloadDirectory(desktopRoot), cliManifestName(target)))
}

/** Parse `--target` / `--all`, defaulting to the packaging host. */
export function parseTargets(argv) {
  if (argv.includes('--all')) return CLI_TARGETS
  const index = argv.indexOf('--target')
  if (index !== -1) {
    const value = argv[index + 1]
    if (value === undefined) fail('--target requires a value such as darwin-universal')
    return [value]
  }
  // A macOS host packages a universal application, so neither architecture alone is a
  // usable target there; the other hosts map directly.
  if (process.platform === 'darwin') return ['darwin-universal']
  return [`${process.platform}-${process.arch}`]
}

/** Resolve the desktop workspace this run writes into. */
function resolveDesktopRoot(argv) {
  const declared = argv.indexOf('--desktop')
  if (declared !== -1 && argv[declared + 1] === undefined) fail('--desktop requires a workspace directory')
  const candidate = declared === -1 ? process.cwd() : resolve(argv[declared + 1])
  const manifestPath = join(candidate, 'package.json')
  if (!existsSync(manifestPath)) fail('run this from a desktop workspace, or pass --desktop <workspace directory>')
  const name = JSON.parse(readFileSync(manifestPath, 'utf8')).name
  if (name !== 'dsh-plugin-desktop' && name !== 'dsh-plugin-desktop-beta') {
    fail(`${candidate} is not a desktop workspace (package name is ${String(name)})`)
  }
  return candidate
}

function main() {
  const argv = process.argv.slice(2)
  const desktopRoot = resolveDesktopRoot(argv)
  for (const target of parseTargets(argv)) {
    prepareOfflineClis(desktopRoot, target, message => { process.stdout.write(`${message}\n`) })
  }
}

/** Only run when invoked directly, so tests can import the functions. */
const invoked = process.argv[1]
if (invoked !== undefined && resolve(invoked) === fileURLToPath(import.meta.url)) {
  try {
    main()
  } catch (error) {
    process.stderr.write(`prepare-offline-clis: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
}
