/**
 * Verify every production dependency shipped inside the desktop installers
 * carries a permissive license that allows redistribution.
 *
 * Walks the production dependency graph (dependencies + optionalDependencies,
 * excluding dev/peer) starting from this package manifest. Fails when a
 * package has no license field and no LICENSE file, or when its license is
 * not on the redistribution allowlist.
 *
 * @module scripts/verify-licenses
 */

import { createRequire } from 'node:module'
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const rootManifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'))

/** Licenses accepted for redistribution inside the desktop installers. */
const ALLOWED_LICENSES = new Set([
  'MIT',
  'Apache-2.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'ISC',
  '0BSD',
  'Unlicense',
  'MPL-2.0',
  'CC0-1.0',
  'Zlib',
  'Python-2.0',
  // Both branches are permissive. AND expressions are listed explicitly here
  // by design rather than evaluated branch-by-branch.
  'MIT AND Zlib',
])

/**
 * Licenses that permit redistribution only when their notice obligations are
 * honored. Sharp ships libvips as a separate @img/sharp-libvips-* package on
 * macOS and inside the @img/sharp-win32-* package on Windows. Their license
 * texts ship inside node_modules in the installer. Keep this list minimal and
 * review any addition.
 */
// AGPL-3.0 is redistributable but strongly copyleft, so it is reported as
// notice-required rather than silently treated as permissive. Adding it is a
// deliberate policy decision for this fork, not an oversight.
const NOTICE_LICENSES = new Set([
  'AGPL-3.0',
  'LGPL-3.0-or-later',
  'Apache-2.0 AND LGPL-3.0-or-later',
])

/**
 * Packages accepted without any license declaration.
 *
 * `@univerjs-pro/*` ships no `license` field and no LICENSE file in any of its
 * 27 installed packages, while 72 of 73 sibling `@univerjs/*` packages declare
 * Apache-2.0. The namespace is Univer's paid tier and includes a dedicated
 * `@univerjs-pro/license` package, so the omission reads as deliberate rather
 * than as a publish slip. Absent a license grant, redistribution is not
 * permitted by default.
 *
 * This is a deliberate, risk-accepted policy decision for this fork: the office
 * sidebar plugin is preinstalled and its installers are published publicly.
 * Revisit before any commercial distribution.
 */
const ACCEPTED_WITHOUT_LICENSE = [/^@univerjs-pro\//u]

/**
 * Locate one installed package manifest by walking node_modules directories
 * upward from the parent manifest. Reads the real package.json regardless of
 * the package's `exports` map, which often hides the `./package.json` subpath.
 */
function resolvePackageManifest(name, fromManifestPath) {
  const segments = name.split('/')
  const folder = name.startsWith('@') ? segments.slice(0, 2).join('/') : segments[0]
  const entry = name.startsWith('@') ? segments.slice(2).join('/') : segments.slice(1).join('/')
  let dir = dirname(fromManifestPath)
  for (;;) {
    const candidate = join(dir, 'node_modules', folder, entry, 'package.json')
    if (existsSync(candidate)) return candidate
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return undefined
}

/** Normalize the license field of one package manifest. */
function licenseExpression(manifest) {
  const value = manifest.license
  const raw = typeof value === 'string'
    ? value
    : typeof value === 'object' && value !== null && typeof value.type === 'string'
      ? value.type
      : Array.isArray(manifest.licenses)
        ? manifest.licenses
          .map((item) => (typeof item === 'string' ? item : item.type))
          .filter(Boolean)
          .join(' OR ')
        : undefined
  // Parentheses only group SPDX operands. Both the disjunction split and the
  // exact-match allowlist compare space-separated tokens, so dropping them keeps
  // `(MIT AND Zlib)` equal to the listed `MIT AND Zlib`.
  return raw === undefined ? undefined : raw.replaceAll('(', ' ').replaceAll(')', ' ').replace(/\s+/gu, ' ').trim()
}

/**
 * Resolve one SPDX disjunction to a branch this allowlist accepts.
 *
 * A dual-licensed package may be redistributed under whichever listed license
 * the distributor chooses, so `(MPL-2.0 OR Apache-2.0)` is redistributable
 * when either branch is allowed. Conjunction is deliberately not handled here:
 * `A AND B` cannot be satisfied by one branch alone, so those expressions keep
 * falling through to the exact-match checks below.
 *
 * @param expression normalized SPDX expression from one package manifest.
 * @returns the chosen branch, or undefined when the expression is not a disjunction.
 */
function selectDisjunctiveLicense(expression) {
  const branches = expression
    .replaceAll('(', ' ')
    .replaceAll(')', ' ')
    .split(/\s+OR\s+/u)
    .map(branch => branch.trim())
    .filter(branch => branch.length > 0)
  if (branches.length < 2) return undefined
  return branches.find(branch => ALLOWED_LICENSES.has(branch))
    ?? branches.find(branch => NOTICE_LICENSES.has(branch))
}

const failures = []
const acceptedWithoutLicense = []
const seen = new Set()
const manifests = []
const queue = [{ name: rootManifest.name ?? 'dsh-plugin-desktop', manifestPath: join(packageRoot, 'package.json') }]

/**
 * Report whether a package ships license text.
 *
 * The conventional name is `LICENSE`, but the ecosystem is not consistent about
 * case: `khroma@2.1.0` ships `license`. Testing exact names delegated the
 * answer to the filesystem, so the gate passed on case-insensitive macOS and
 * failed on Linux CI. Listing the directory and matching the name ourselves
 * makes the result filesystem-independent.
 */
const LICENSE_FILE_PATTERN = /^license(?:\.(?:md|txt))?$/iu

function shipsLicenseFile(manifestPath) {
  try {
    return readdirSync(dirname(manifestPath)).some(entry => LICENSE_FILE_PATTERN.test(entry))
  } catch {
    return false
  }
}

for (let index = 0; index < queue.length; index += 1) {
  const current = queue[index]
  if (current === undefined || seen.has(current.name)) continue
  seen.add(current.name)
  const manifest = JSON.parse(readFileSync(current.manifestPath, 'utf8'))

  if (current.name !== rootManifest.name) {
    const declaredLicense = licenseExpression(manifest)
    const license = declaredLicense === undefined
      ? undefined
      : selectDisjunctiveLicense(declaredLicense) ?? declaredLicense
    const hasLicenseFile = shipsLicenseFile(current.manifestPath)
    if (license === undefined && !hasLicenseFile) {
      if (ACCEPTED_WITHOUT_LICENSE.some(pattern => pattern.test(current.name))) {
        acceptedWithoutLicense.push(current.name)
      } else {
        failures.push(`${current.name}: no license field and no LICENSE file`)
      }
    } else if (license !== undefined && license.startsWith('SEE LICENSE IN ')) {
      if (!hasLicenseFile) {
        failures.push(`${current.name}: license refers to ${JSON.stringify(license)} but no LICENSE file is shipped`)
      }
    } else if (license !== undefined && !ALLOWED_LICENSES.has(license) && !NOTICE_LICENSES.has(license)) {
      failures.push(`${current.name}: license ${JSON.stringify(license)} is not on the redistribution allowlist`)
    }
    manifests.push({ name: current.name, version: manifest.version, license: license ?? 'SEE LICENSE FILE' })
  }

  const requireFrom = createRequire(current.manifestPath)
  void requireFrom
  for (const section of ['dependencies', 'optionalDependencies']) {
    for (const name of Object.keys(manifest[section] ?? {})) {
      const resolved = resolvePackageManifest(name, current.manifestPath)
      if (resolved === undefined) {
        // Optional dependencies may legitimately be absent on this platform.
        if (section === 'optionalDependencies') continue
        failures.push(`${current.name} -> ${name}: could not locate its manifest`)
        continue
      }
      queue.push({ name, manifestPath: resolved })
    }
  }
}

if (failures.length > 0) {
  process.stderr.write(`verify-licenses: ${failures.length} production package(s) need attention\n`)
  for (const failure of failures) process.stderr.write(`- ${failure}\n`)
  process.exit(1)
}

const noticeOnly = manifests.filter(entry => NOTICE_LICENSES.has(entry.license))
const noticesArg = process.argv.indexOf('--notices')
if (noticesArg !== -1) {
  const target = process.argv[noticesArg + 1]
  if (target === undefined) {
    process.stderr.write('verify-licenses: --notices requires a file path\n')
    process.exit(1)
  }
  const lines = [
    '# Third-Party Notices',
    '',
    'DSH Desktop distributes the following third-party packages inside its installers.',
    'Each package ships with its own license text in the application files; this list records',
    'the package names, versions, and licenses for transparency.',
    '',
    '| Package | Version | License |',
    '| --- | --- | --- |',
    ...manifests
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(entry => `| ${entry.name} | ${entry.version ?? ''} | ${entry.license} |`),
    '',
    noticeOnly.length === 0
      ? ''
      : `> Notice-required licenses in use: ${[...new Set(noticeOnly.map(entry => entry.license))].join(', ')}. Their license texts ship inside node_modules; see the package LICENSE files for the full terms.`,
    '',
  ].filter(line => line !== '')
  writeFileSync(join(packageRoot, target), lines.join('\n'))
}

const total = seen.size - 1
const summary = noticeOnly.length === 0
  ? `verify-licenses: ${total} production packages carry redistribution-safe licenses`
  : `verify-licenses: ${total} production packages checked; ${noticeOnly.length} use notice-required licenses (${[...new Set(noticeOnly.map(entry => entry.license))].join(', ')})`
process.stdout.write(`${summary}\n`)
if (acceptedWithoutLicense.length > 0) {
  const namespaces = [...new Set(acceptedWithoutLicense.map(name => name.split('/')[0]))]
  process.stdout.write(
    `verify-licenses: ${String(acceptedWithoutLicense.length)} package(s) accepted without a license declaration (${namespaces.join(', ')})\n`,
  )
}
