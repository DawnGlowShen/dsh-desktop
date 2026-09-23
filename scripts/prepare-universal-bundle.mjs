/**
 * Merge an arm64 and an x64 CLI bundle into one universal (fat) bundle.
 *
 * The macOS installer is built with `--universal`, so `@electron/universal`
 * compares every non-Mach-O file across the two slices and fails on any SHA
 * mismatch. Copying one architecture's bundle into each slice therefore does
 * not work: the two upstream manifests differ (CodeGraph in `name`, Mnemon in
 * `version`, both in `cpu`). Merging once, before electron-builder runs, makes
 * both slices read the same bytes by construction.
 *
 * Plain files are taken from the arm64 side; the caller rewrites the manifest
 * afterwards so the bundle declares both architectures. Only Mach-O files are
 * fused with `lipo`.
 */

import { spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'

/** Byte-order independent Mach-O magics: 32/64-bit, thin and fat. */
const MACHO_MAGICS = [
  [0xfe, 0xed, 0xfa, 0xce],
  [0xfe, 0xed, 0xfa, 0xcf],
  [0xce, 0xfa, 0xed, 0xfe],
  [0xcf, 0xfa, 0xed, 0xfe],
  [0xca, 0xfe, 0xba, 0xbe],
  [0xbe, 0xba, 0xfe, 0xca],
]

/** Paths sorted for stable plans, regardless of readdir order. */
function listFiles(root) {
  const found = []
  const walk = directory => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const absolute = join(directory, entry.name)
      if (entry.isDirectory()) walk(absolute)
      else if (entry.isFile()) found.push(relative(root, absolute).split(sep).join('/'))
    }
  }
  walk(root)
  return found.sort()
}

function isMachO(path) {
  const handle = readFileSync(path)
  if (handle.length < 4) return false
  return MACHO_MAGICS.some(magic => magic.every((byte, index) => handle[index] === byte))
}

function fail(message) {
  throw new Error(message)
}

/**
 * Classify both trees and reject anything the merge cannot reconcile.
 *
 * Returns the relative paths to fuse (`machOFiles`) and to copy verbatim
 * (`plainFiles`). `allowPlainDifferences` lists paths permitted to differ
 * between the architectures — the manifests the caller rewrites, and Mnemon's
 * architecture-stamped `README.md`.
 */
export function planUniversalMerge({ arm64Dir, x64Dir, allowPlainDifferences = [] }) {
  const allowed = new Set(allowPlainDifferences)
  const arm64Files = listFiles(arm64Dir)
  const x64Files = listFiles(x64Dir)
  const x64Set = new Set(x64Files)
  const arm64Set = new Set(arm64Files)

  for (const file of arm64Files) {
    if (!x64Set.has(file)) fail(`${file} only exists in the arm64 bundle`)
  }
  for (const file of x64Files) {
    if (!arm64Set.has(file)) fail(`${file} only exists in the x64 bundle`)
  }

  const machOFiles = []
  const plainFiles = []
  for (const file of arm64Files) {
    const arm64Path = join(arm64Dir, file)
    const x64Path = join(x64Dir, file)
    const arm64IsBinary = isMachO(arm64Path)
    if (arm64IsBinary !== isMachO(x64Path)) {
      fail(`${file} is a Mach-O file in only one of the two bundles`)
    }
    if (arm64IsBinary) {
      machOFiles.push(file)
      continue
    }
    if (!allowed.has(file) && !readFileSync(arm64Path).equals(readFileSync(x64Path))) {
      fail(`${file} differs between the arm64 and x64 bundles; add it to allowPlainDifferences only if the merged manifest still declares both architectures`)
    }
    plainFiles.push(file)
  }

  return { machOFiles, plainFiles, fileCount: arm64Files.length }
}

/**
 * Rewrite a manifest so the bundle accepts either architecture.
 *
 * `override` replaces the architecture-stamped identity fields; everything
 * else (notably `license` and `os`) is preserved as-is.
 */
export function normalizeUniversalManifest(manifest, override = {}) {
  return { ...manifest, ...override, cpu: ['arm64', 'x64'] }
}

function defaultRun(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8' })
  if (result.error !== undefined) return { status: null, stdout: '', stderr: result.error.message }
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

/**
 * Fuse both trees into `outputRoot`.
 *
 * `run` is the process boundary (`lipo`), injectable so the failure branches are
 * testable off a macOS host. The caller is responsible for normalizing
 * `outputRoot/package.json` afterwards, because the arch-specific identity
 * fields differ per CLI (CodeGraph: `name`; Mnemon: `version`).
 */
export function mergeUniversalBundle({ arm64Dir, x64Dir, outputRoot, allowPlainDifferences = [], run = defaultRun }) {
  const plan = planUniversalMerge({ arm64Dir, x64Dir, allowPlainDifferences })

  rmSync(outputRoot, { recursive: true, force: true })
  mkdirSync(outputRoot, { recursive: true })

  for (const file of plan.plainFiles) {
    const source = join(arm64Dir, file)
    const target = join(outputRoot, file)
    mkdirSync(dirname(target), { recursive: true })
    copyFileSync(source, target)
    chmodSync(target, statSync(source).mode & 0o777)
  }

  for (const file of plan.machOFiles) {
    const source = join(arm64Dir, file)
    const target = join(outputRoot, file)
    mkdirSync(dirname(target), { recursive: true })
    const result = run('lipo', ['-create', source, join(x64Dir, file), '-output', target])
    if (result.status !== 0) {
      fail(`lipo -create failed for ${file}: ${result.stderr.trim() || `exit ${String(result.status)}`}`)
    }
    chmodSync(target, statSync(source).mode & 0o777)
  }

  for (const file of plan.machOFiles) {
    const target = join(outputRoot, file)
    const result = run('lipo', [target, '-archs'])
    if (result.status !== 0) {
      fail(`lipo -archs failed for ${file}: ${result.stderr.trim() || `exit ${String(result.status)}`}`)
    }
    const archs = result.stdout.trim().split(/\s+/u)
    if (!archs.includes('x86_64')) fail(`${file} is missing x86_64; merged architectures are ${archs.join(' ')}`)
    if (!archs.includes('arm64')) fail(`${file} is missing arm64; merged architectures are ${archs.join(' ')}`)
  }

  return { machOFiles: plan.machOFiles, plainFiles: plan.plainFiles }
}
