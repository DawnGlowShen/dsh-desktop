#!/usr/bin/env node
/**
 * 管理「随安装包分发、并在新建 Profile 时自动预装」的默认插件清单。
 *
 * 名称必须同时出现在两个地方，缺一不可：
 *   1. 两个变体的 package.json dependencies  → 决定装不装进安装包
 *   2. 两个变体的 src/product-identity.ts 的 DEFAULT_PROFILE_PLUGIN_BUNDLES
 *                                            → 决定新建 Profile 里启不启用
 *
 * 两个变体（stable / beta）都要改，所以一次操作会动 4 个文件。
 *
 * 用法：
 *   node scripts/preinstall-plugins.mjs list
 *   node scripts/preinstall-plugins.mjs add dsh-foo@1.2.3
 *   node scripts/preinstall-plugins.mjs add --from-dir /path/to/local-plugin
 *   node scripts/preinstall-plugins.mjs remove dsh-foo
 *
 * 可选参数：
 *   --no-install   跳过 corepack yarn install
 *   --no-verify    跳过门禁（变体一致性 / 预装守卫测试 / 许可证）
 *   --yes          跳过体检失败的确认
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const VARIANTS = ['dsh-plugin-desktop', 'dsh-plugin-desktop-beta']
const ARRAY_HEADER = 'export const DEFAULT_PROFILE_PLUGIN_BUNDLES: readonly string[] = Object.freeze(['
const ARRAY_FOOTER = '])'
const VENDOR_DIR = 'vendor'

/** 可再分发许可证白名单，与 verify-licenses.mjs 保持一致。 */
const ALLOWED_LICENSES = new Set([
  'MIT', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', 'ISC',
  '0BSD', 'Unlicense', 'MPL-2.0', 'CC0-1.0', 'Zlib', 'Python-2.0',
])

// 被 `| head` 之类提前关闭管道时，Node 默认会抛 EPIPE 崩溃；静默退出即可。
process.stdout.on('error', error => {
  if (error.code === 'EPIPE') process.exit(0)
  throw error
})

function fail(message) {
  process.stderr.write(`\n✗ ${message}\n`)
  process.exit(1)
}

function info(message) {
  process.stdout.write(`${message}\n`)
}

function step(message) {
  process.stdout.write(`\n── ${message}\n`)
}

function run(command, args, options = {}) {
  execFileSync(command, args, { cwd: ROOT, stdio: 'inherit', ...options })
}

function yarn(args) {
  run('corepack', ['yarn', ...args])
}

function manifestPath(variant) {
  return join(ROOT, variant, 'package.json')
}

function identityPath(variant) {
  return join(ROOT, variant, 'src', 'product-identity.ts')
}

/**
 * 读取 JSON 并确认它是规范格式。
 * 若原文件不是 `JSON.stringify(data, null, 2)` 的形态，直接拒绝写入——
 * 否则一次「加一行依赖」会变成整个文件重新排版，污染 diff。
 */
function readCanonicalJson(path) {
  const text = readFileSync(path, 'utf8')
  const data = JSON.parse(text)
  if (`${JSON.stringify(data, null, 2)}\n` !== text) {
    fail(`${path} 不是规范 JSON 格式，拒绝改写（请先手工整理该文件的缩进）`)
  }
  return data
}

function writeCanonicalJson(path, data) {
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`)
}

function sortedKeys(object) {
  return Object.fromEntries(Object.entries(object).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0))
}

/** 从 product-identity.ts 里读出当前的默认预装清单。 */
function readBundleList(variant) {
  const lines = readFileSync(identityPath(variant), 'utf8').split('\n')
  const start = lines.indexOf(ARRAY_HEADER)
  if (start === -1) fail(`${identityPath(variant)} 里找不到 ${ARRAY_HEADER}`)
  const names = []
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index].trim()
    if (line === ARRAY_FOOTER) return names
    const match = /^'([^']+)',$/u.exec(line)
    if (match === null) fail(`${identityPath(variant)} 第 ${String(index + 1)} 行不是预期的清单项：${line}`)
    names.push(match[1])
  }
  return fail(`${identityPath(variant)} 的清单数组没有结束标记`)
}

/** 按字母序写回清单，保证两个变体格式一致。 */
function writeBundleList(variant, names) {
  const lines = readFileSync(identityPath(variant), 'utf8').split('\n')
  const start = lines.indexOf(ARRAY_HEADER)
  let end = -1
  for (let index = start + 1; index < lines.length; index += 1) {
    if (lines[index].trim() === ARRAY_FOOTER) { end = index; break }
  }
  if (end === -1) fail(`${identityPath(variant)} 的清单数组没有结束标记`)
  const body = [...names].sort().map(name => `  '${name}',`)
  writeFileSync(
    identityPath(variant),
    [...lines.slice(0, start + 1), ...body, ...lines.slice(end)].join('\n'),
  )
}

/** 汇总两个变体的当前状态，用于 list 与一致性检查。 */
function currentState() {
  const names = new Set()
  const perVariant = new Map()
  for (const variant of VARIANTS) {
    const manifest = readCanonicalJson(manifestPath(variant))
    const bundles = readBundleList(variant)
    perVariant.set(variant, {
      dependency: manifest.dependencies ?? {},
      bundles,
      installed: name => existsSync(join(ROOT, variant, 'node_modules', ...name.split('/'), 'package.json')),
    })
    for (const name of bundles) names.add(name)
  }
  return { names: [...names].sort(), perVariant }
}

function splitSpec(spec) {
  const at = spec.lastIndexOf('@')
  if (at <= 0) return { name: spec, version: undefined }
  return { name: spec.slice(0, at), version: spec.slice(at + 1) }
}

/** 查 npm 元数据，返回体检结论。离线或 404 时抛错由调用方处理。 */
function inspectOnNpm(name) {
  const raw = execFileSync('npm', ['view', name, 'version', 'license', 'dsh', 'peerDependencies', '--json'], {
    cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  })
  const data = JSON.parse(raw)
  return {
    version: typeof data.version === 'string' ? data.version : undefined,
    license: typeof data.license === 'string' ? data.license : undefined,
    hasBundle: data.dsh?.bundle?.patch !== undefined,
    peers: Object.keys(data.peerDependencies ?? {}),
  }
}

/** 体检结果里的致命问题。 */
function licenseAllowed(license) {
  if (license === undefined) return false
  // 双许可 `A OR B`：任一分支在白名单即通过，与 verify-licenses.mjs 的析取求值一致。
  if (license.includes(' OR ')) {
    return license.replace(/[()]/gu, '').split(' OR ').some(branch => ALLOWED_LICENSES.has(branch.trim()))
  }
  return ALLOWED_LICENSES.has(license)
}

/**
 * 体检。只有「许可证不可再分发」和「没有 dsh.bundle.patch」是致命的——
 * 前者会让打包门禁失败，后者会让应用启动直接 throw。
 *
 * 缺失的 peer 依赖只作为提示：DSH 里存在未加域的 `cordis` 这类已知别名
 * （实际由 @deepseek-ai/cordis 提供），据此阻断会误伤合法插件。
 */
function preflight({ license, hasBundle, peers }) {
  const problems = []
  const warnings = []
  if (license === undefined) problems.push('拿不到 license 字段，无法确认可再分发')
  else if (!licenseAllowed(license)) problems.push(`license "${String(license)}" 不在可再分发白名单内`)
  if (!hasBundle) problems.push('没有声明 dsh.bundle.patch —— 缺了它应用启动会直接 throw')
  for (const peer of peers) {
    const found = existsSync(join(ROOT, 'dsh-plugin-desktop', 'node_modules', ...peer.split('/'), 'package.json'))
    if (found) continue
    const scoped = existsSync(join(ROOT, 'dsh-plugin-desktop', 'node_modules', '@deepseek-ai', ...peer.split('/'), 'package.json'))
    warnings.push(scoped
      ? `peer 依赖 ${peer} 由 @deepseek-ai/${peer} 提供，属于 DSH 的已知别名`
      : `peer 依赖 ${peer} 不在应用里，运行期功能可能异常`)
  }
  return { problems, warnings }
}

function applyEdits({ name, spec }, mode) {
  step(`${mode === 'add' ? '添加' : '移除'} ${name}（4 个文件）`)
  for (const variant of VARIANTS) {
    const manifest = readCanonicalJson(manifestPath(variant))
    const dependencies = { ...(manifest.dependencies ?? {}) }
    if (mode === 'add') dependencies[name] = spec
    else delete dependencies[name]
    manifest.dependencies = sortedKeys(dependencies)
    writeCanonicalJson(manifestPath(variant), manifest)

    const bundles = readBundleList(variant).filter(candidate => candidate !== name)
    if (mode === 'add') bundles.push(name)
    writeBundleList(variant, bundles)
    info(`  ✓ ${variant}`)
  }
}

function installDependencies() {
  step('更新锁文件（corepack yarn install）')
  yarn(['install'])
}

function verifyGates(name) {
  step('门禁')
  run('node', ['scripts/verify-desktop-variants.mjs'])
  run('corepack', ['yarn', 'workspace', 'dsh-plugin-desktop', 'test', 'tests/profile.spec.ts'])
  run('corepack', ['yarn', 'workspace', 'dsh-plugin-desktop', 'verify:licenses'])
  run('corepack', ['yarn', 'workspace', 'dsh-plugin-desktop', 'verify:closure'])
  step('下一步')
  info(`  1) 确认它真的进了安装包：`)
  info(`     ls -ld dsh-plugin-desktop/node_modules/${name}    # 必须是 drwxr-xr-x，不能是软链`)
  info('  2) 重新构建并打包：')
  info('     corepack yarn build && corepack yarn workspace dsh-plugin-desktop dist:mac-smoke')
  info('  3) 用全新 DSH_HOME 启动，确认新 Profile 里出现它（见文档 6.2.1）')
}

function flagValue(args, flag) {
  const index = args.indexOf(flag)
  return index === -1 ? undefined : args[index + 1]
}

function hasFlag(args, flag) {
  return args.includes(flag)
}

function commandList() {
  const { names, perVariant } = currentState()
  if (names.length === 0) return info('（默认预装清单为空）')
  info(`默认预装清单：${String(names.length)} 个插件\n`)
  const labels = ['stable', 'beta']
  info(`  ${'插件'.padEnd(40)} ${labels.map(label => `${label}(依赖/清单)`.padEnd(16)).join('')} 已安装`)
  for (const name of names) {
    const cells = VARIANTS.map(variant => {
      const state = perVariant.get(variant)
      const inDeps = state.dependency[name] !== undefined
      const inBundles = state.bundles.includes(name)
      return `${inDeps ? '✓' : '✗'}/${inBundles ? '✓' : '✗'}`.padEnd(16)
    })
    const installed = VARIANTS.every(variant => perVariant.get(variant).installed(name)) ? '✓' : '✗'
    info(`  ${name.padEnd(40)} ${cells.join('')} ${installed}`)
  }
  const drifted = []
  for (const variant of VARIANTS) {
    const state = perVariant.get(variant)
    for (const name of state.bundles) {
      if (state.dependency[name] === undefined) drifted.push(`${variant}: ${name} 在清单里但不在 dependencies`)
    }
  }
  info('\n  deps = 出现在 package.json dependencies；清单 = 出现在 DEFAULT_PROFILE_PLUGIN_BUNDLES')
  info('  只检查「清单里的名字必须是直接依赖」这一个方向——dependencies 里还有应用的普通依赖，不属于预装插件')
  if (drifted.length > 0) {
    info('\n⚠ 发现不一致：')
    for (const item of drifted) info(`  - ${item}`)
  }
}

function resolveSpec(args) {
  const fromDir = flagValue(args, '--from-dir')
  if (fromDir === undefined) {
    const positional = args.find(argument => !argument.startsWith('--'))
    if (positional === undefined) fail('缺少插件名，例如：node scripts/preinstall-plugins.mjs add dsh-foo@1.2.3')
    return positional
  }
  if (!existsSync(fromDir) || !statSync(fromDir).isDirectory()) fail(`--from-dir 不是目录：${fromDir}`)
  return `local:${resolve(fromDir)}`
}

/** 把本地源码目录 npm pack 进 vendor/，返回可写的 file: 依赖说明。 */
function vendorLocalDirectory(directory) {
  const source = readCanonicalJson(join(directory, 'package.json'))
  const name = source.name
  const version = source.version
  if (typeof name !== 'string' || typeof version !== 'string') {
    fail(`${directory}/package.json 缺少 name 或 version`)
  }
  const folder = name.replace(/^@/u, '').replace(/\//gu, '-')
  const target = join(ROOT, VENDOR_DIR, folder)
  mkdirSync(target, { recursive: true })
  step(`vendor ${name}@${version} → ${VENDOR_DIR}/${folder}/`)
  if (typeof source.license !== 'string' || !licenseAllowed(source.license)) {
    info(`  ⚠ license 为 ${String(source.license)}，不在可再分发白名单内，打包门禁会失败`)
  }
  if (source.dsh?.bundle?.patch === undefined) {
    info('  ⚠ 没有声明 dsh.bundle.patch，应用启动会直接 throw')
  }
  run('npm', ['pack', '--pack-destination', target], { cwd: directory, stdio: 'inherit' })
  const tarball = `${(name.startsWith('@') ? name.slice(1) : name).replace(/\//gu, '-')}-${version}.tgz`
  if (!existsSync(join(target, tarball))) fail(`npm pack 没有产出 ${tarball}`)
  info(`  ✓ ${VENDOR_DIR}/${folder}/${tarball}`)
  return { name, spec: `file:../${VENDOR_DIR}/${folder}/${tarball}` }
}

function commandAdd(args) {
  const raw = resolveSpec(args)
  const skipInstall = hasFlag(args, '--no-install')
  const skipVerify = hasFlag(args, '--no-verify')

  let name
  let spec
  let license
  let hasBundle = true
  let peers = []

  if (raw.startsWith('local:')) {
    const vendored = vendorLocalDirectory(raw.slice('local:'.length))
    name = vendored.name
    spec = vendored.spec
    license = readCanonicalJson(join(raw.slice('local:'.length), 'package.json')).license
    hasBundle = readCanonicalJson(join(raw.slice('local:'.length), 'package.json')).dsh?.bundle?.patch !== undefined
  } else {
    const split = splitSpec(raw)
    name = split.name
    step(`体检 ${name}`)
    let metadata
    try {
      metadata = inspectOnNpm(name)
    } catch {
      fail(`npm 上查不到 ${name}。若它是本地插件，请用：add --from-dir <目录>`)
    }
    license = metadata.license
    hasBundle = metadata.hasBundle
    peers = metadata.peers
    spec = split.version ?? metadata.version
    if (spec === undefined) fail(`${name} 没有可用的版本号，请显式写成 ${name}@x.y.z`)
    info(`  版本        : ${spec}`)
    info(`  许可证      : ${String(license)}${licenseAllowed(license) ? '  ✓' : '  ✗'}`)
    info(`  dsh.bundle  : ${hasBundle ? '已声明  ✓' : '未声明  ✗'}`)
    info(`  peer 依赖   : ${peers.length === 0 ? '无' : peers.join(', ')}`)
  }

  const { problems, warnings } = preflight({ license, hasBundle, peers })

  for (const warning of warnings) info(`  · ${warning}`)
  if (problems.length > 0) {
    info('')
    for (const problem of problems) info(`  ✗ ${problem}`)
    if (!hasFlag(args, '--yes')) {
      fail('体检未通过。确认要加就重跑并加 --yes')
    }
    info('\n  已用 --yes 忽略上述问题，继续。')
  }

  const existing = currentState().names.includes(name)
  if (existing) info(`\n  注意：${name} 已在清单里，将更新版本声明。`)

  applyEdits({ name, spec }, 'add')
  if (!skipInstall) installDependencies()
  if (!skipVerify) verifyGates(name)
  else info('\n  已跳过门禁（--no-verify）')
  info(`\n✓ ${name} 已加入默认预装清单。`)
}

function commandRemove(args) {
  const name = args.find(argument => !argument.startsWith('--'))
  if (name === undefined) fail('缺少插件名，例如：node scripts/preinstall-plugins.mjs remove dsh-foo')
  if (!currentState().names.includes(name)) fail(`${name} 不在默认预装清单里`)

  applyEdits({ name }, 'remove')
  const vendorFolder = join(ROOT, VENDOR_DIR, name.replace(/^@/u, '').replace(/\//gu, '-'))
  if (existsSync(vendorFolder)) {
    info(`\n  vendor 目录 ${VENDOR_DIR}/${basename(vendorFolder)} 已不再被引用，可以手工删除`)
  }
  if (!hasFlag(args, '--no-install')) installDependencies()
  if (!hasFlag(args, '--no-verify')) {
    step('门禁')
    run('node', ['scripts/verify-desktop-variants.mjs'])
    run('corepack', ['yarn', 'workspace', 'dsh-plugin-desktop', 'test', 'tests/profile.spec.ts'])
  } else info('\n  已跳过门禁（--no-verify）')
  info(`\n✓ ${name} 已从默认预装清单移除。`)
  info('  已存在的 Profile 不受影响——删除只作用于将来新建的 Profile。')
}

function commandVerify() {
  const { perVariant, names } = currentState()
  const problems = []
  for (const variant of VARIANTS) {
    const state = perVariant.get(variant)
    for (const name of names) {
      if (state.dependency[name] === undefined) problems.push(`${variant}: ${name} 不在 dependencies 里`)
      if (!state.bundles.includes(name)) problems.push(`${variant}: ${name} 不在 DEFAULT_PROFILE_PLUGIN_BUNDLES 里`)
      if (!state.installed(name)) problems.push(`${variant}: ${name} 没有安装到 node_modules`)
      const target = join(ROOT, variant, 'node_modules', ...name.split('/'))
      if (existsSync(target) && statSync(target).isSymbolicLink()) {
        problems.push(`${variant}: ${name} 是符号链接，electron-builder 不会打包它`)
      }
    }
  }
  if (problems.length === 0) return info(`✓ ${String(names.length)} 个默认预装插件在两个变体里都一致且已安装`)
  for (const problem of problems) info(`  ✗ ${problem}`)
  process.exit(1)
}

const [command, ...rest] = process.argv.slice(2)
switch (command) {
  case 'list': commandList(); break
  case 'verify': commandVerify(); break
  case 'add': commandAdd(rest); break
  case 'remove': commandRemove(rest); break
  default:
    info(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 26).map(line => line.replace(/^ \* ?/u, '')).join('\n'))
    info('\n可用子命令：list | verify | add | remove')
    if (command !== undefined && command !== 'help' && command !== '--help') process.exit(1)
}
