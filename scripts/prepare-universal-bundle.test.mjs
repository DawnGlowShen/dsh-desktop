import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import {
  mergeUniversalBundle,
  normalizeUniversalManifest,
  planUniversalMerge,
} from './prepare-universal-bundle.mjs'

/** Big-endian `MH_MAGIC_64`, i.e. a 64-bit Mach-O in host byte order. */
const MACHO_MAGIC_64 = Buffer.from([0xcf, 0xfa, 0xed, 0xfe])

/**
 * Materialize a pair of trees. `machO` entries get a Mach-O magic prefix so the
 * classifier sees them as binaries; every other entry is plain text.
 */
function makeTrees(spec) {
  const base = mkdtempSync(join(tmpdir(), 'prepare-universal-'))
  const trees = {}
  for (const arch of ['arm64', 'x64']) {
    const dir = join(base, arch)
    mkdirSync(dir, { recursive: true })
    for (const [relativePath, content] of Object.entries(spec)) {
      const value = arch === 'x64' ? (content.x64 ?? content.arm64) : content.arm64
      const target = join(dir, relativePath)
      mkdirSync(join(target, '..'), { recursive: true })
      writeFileSync(target, content.machO === true ? Buffer.concat([MACHO_MAGIC_64, Buffer.from(value)]) : value)
    }
    trees[arch] = dir
  }
  trees.dispose = () => rmSync(base, { recursive: true, force: true })
  return trees
}

/** A `run` double that records invocations, with a scriptable exit status. */
function runRecorder({ failure, archs = 'x86_64 arm64' } = {}) {
  const calls = []
  const run = (command, args) => {
    calls.push({ command, args: [...args] })
    if (failure !== undefined && failure(command, args) === true) {
      return { status: 1, stdout: '', stderr: 'boom' }
    }
    if (command === 'lipo' && args.includes('-archs')) {
      return { status: 0, stdout: archs, stderr: '' }
    }
    // Real `lipo -create` writes the fat binary; the double must too, because
    // the merge chmods and re-inspects the output afterwards.
    if (command === 'lipo' && args.includes('-create')) {
      writeFileSync(args[args.indexOf('-output') + 1], Buffer.concat([MACHO_MAGIC_64, Buffer.from('fat')]))
    }
    return { status: 0, stdout: '', stderr: '' }
  }
  return { calls, run }
}

test('plans every Mach-O pair and leaves plain files to the copy step', () => {
  const trees = makeTrees({
    'package.json': { arm64: '{"name":"a-darwin-arm64"}' },
    node: { arm64: 'arm', x64: 'x64', machO: true },
    'lib/kernel/codegraph-kernel.node': { arm64: 'karm', x64: 'kx64', machO: true },
    'bin/codegraph': { arm64: '#!/bin/sh\n' },
  })

  try {
    const plan = planUniversalMerge({ arm64Dir: trees.arm64, x64Dir: trees.x64 })
    assert.deepEqual(plan.machOFiles, ['lib/kernel/codegraph-kernel.node', 'node'])
    assert.deepEqual(plan.plainFiles, ['bin/codegraph', 'package.json'])
    assert.equal(plan.fileCount, 4)
  } finally {
    trees.dispose()
  }
})

test('rejects differing plain files', () => {
  const trees = makeTrees({
    'package.json': { arm64: '{"cpu":["arm64"]}', x64: '{"cpu":["x64"]}' },
  })

  try {
    assert.throws(
      () => planUniversalMerge({ arm64Dir: trees.arm64, x64Dir: trees.x64 }),
      /package\.json.*differs between the arm64 and x64 bundles/u,
    )
  } finally {
    trees.dispose()
  }
})

test('allows declared plain-file differences', () => {
  const trees = makeTrees({
    'package.json': { arm64: '{"cpu":["arm64"]}', x64: '{"cpu":["x64"]}' },
    'README.md': { arm64: '# mnemon darwin-arm64\n', x64: '# mnemon darwin-x64\n' },
  })

  try {
    const plan = planUniversalMerge({
      arm64Dir: trees.arm64,
      x64Dir: trees.x64,
      allowPlainDifferences: ['package.json', 'README.md'],
    })
    assert.deepEqual(plan.plainFiles, ['README.md', 'package.json'])
  } finally {
    trees.dispose()
  }
})

test('rejects one-sided Mach-O files', () => {
  const base = mkdtempSync(join(tmpdir(), 'prepare-universal-one-sided-'))
  try {
    mkdirSync(join(base, 'arm64'), { recursive: true })
    mkdirSync(join(base, 'x64'), { recursive: true })
    writeFileSync(join(base, 'arm64', 'node'), Buffer.concat([MACHO_MAGIC_64, Buffer.from('arm')]))
    assert.throws(
      () => planUniversalMerge({ arm64Dir: join(base, 'arm64'), x64Dir: join(base, 'x64') }),
      /node.*only exists in the arm64 bundle/u,
    )

    writeFileSync(join(base, 'x64', 'node'), Buffer.concat([MACHO_MAGIC_64, Buffer.from('x64')]))
    writeFileSync(join(base, 'x64', 'extra.dylib'), Buffer.concat([MACHO_MAGIC_64, Buffer.from('x')]))
    assert.throws(
      () => planUniversalMerge({ arm64Dir: join(base, 'arm64'), x64Dir: join(base, 'x64') }),
      /extra\.dylib.*only exists in the x64 bundle/u,
    )
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('rejects a file that is Mach-O in only one of the bundles', () => {
  const base = mkdtempSync(join(tmpdir(), 'prepare-universal-half-binary-'))
  try {
    mkdirSync(join(base, 'arm64'), { recursive: true })
    mkdirSync(join(base, 'x64'), { recursive: true })
    writeFileSync(join(base, 'arm64', 'node'), Buffer.concat([MACHO_MAGIC_64, Buffer.from('arm')]))
    writeFileSync(join(base, 'x64', 'node'), 'not-a-binary')
    assert.throws(
      () => planUniversalMerge({ arm64Dir: join(base, 'arm64'), x64Dir: join(base, 'x64') }),
      /node is a Mach-O file in only one of the two bundles/u,
    )
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('normalizes cpu to both architectures', () => {
  const normalized = normalizeUniversalManifest(
    {
      name: '@colbymchenry/codegraph-darwin-x64',
      version: '1.6.0',
      description: 'CodeGraph self-contained bundle for darwin-x64',
      os: ['darwin'],
      cpu: ['x64'],
      license: 'MIT',
      files: ['node', 'lib', 'bin'],
    },
    { name: '@colbymchenry/codegraph-universal', description: 'CodeGraph self-contained bundle for darwin' },
  )

  assert.deepEqual(normalized.cpu, ['arm64', 'x64'])
  assert.deepEqual(normalized.os, ['darwin'])
  assert.equal(normalized.license, 'MIT')
  assert.equal(normalized.name, '@colbymchenry/codegraph-universal')
  assert.equal(normalized.version, '1.6.0')
  assert.equal(normalized.description, 'CodeGraph self-contained bundle for darwin')
  assert.deepEqual(normalized.files, ['node', 'lib', 'bin'])
  // The input object is not mutated: the x64 bundle on disk is never rewritten in place.
  assert.deepEqual(JSON.parse(JSON.stringify(normalized)).cpu, ['arm64', 'x64'])
})

test('merges Mach-O pairs through lipo and verifies both architectures', () => {
  const trees = makeTrees({
    'package.json': { arm64: '{"name":"a-darwin-arm64"}', x64: '{"name":"a-darwin-x64"}' },
    node: { arm64: 'arm', x64: 'x64', machO: true },
    'bin/codegraph': { arm64: '#!/bin/sh\n' },
  })
  const outputRoot = join(trees.arm64, '..', 'host')
  const recorder = runRecorder()

  try {
    const result = mergeUniversalBundle({
      arm64Dir: trees.arm64,
      x64Dir: trees.x64,
      outputRoot,
      allowPlainDifferences: ['package.json'],
      run: recorder.run,
    })

    assert.deepEqual(result.machOFiles, ['node'])
    assert.deepEqual(
      recorder.calls.filter(call => call.command === 'lipo' && call.args.includes('-create')),
      [
        {
          command: 'lipo',
          args: ['-create', join(trees.arm64, 'node'), join(trees.x64, 'node'), '-output', join(outputRoot, 'node')],
        },
      ],
    )
    assert.deepEqual(
      recorder.calls.filter(call => call.args.includes('-archs')),
      [{ command: 'lipo', args: [join(outputRoot, 'node'), '-archs'] }],
    )
    // Plain files come from the arm64 side; the manifest is rewritten by the caller.
    assert.equal(readFileSync(join(outputRoot, 'bin', 'codegraph'), 'utf8'), '#!/bin/sh\n')
    assert.equal(readFileSync(join(outputRoot, 'package.json'), 'utf8'), '{"name":"a-darwin-arm64"}')
    // The fused binary is what `lipo -create` produced, not the arm64 input.
    assert.equal(readFileSync(join(outputRoot, 'node')).subarray(0, 4).toString('hex'), MACHO_MAGIC_64.toString('hex'))
  } finally {
    trees.dispose()
    rmSync(outputRoot, { recursive: true, force: true })
  }
})

test('preserves the executable bit of copied plain files', () => {
  const trees = makeTrees({ 'bin/mnemon': { arm64: '#!/bin/sh\n' } })
  const outputRoot = join(trees.arm64, '..', 'host')
  chmodSync(join(trees.arm64, 'bin', 'mnemon'), 0o755)

  try {
    mergeUniversalBundle({
      arm64Dir: trees.arm64,
      x64Dir: trees.x64,
      outputRoot,
      run: runRecorder().run,
    })
    assert.equal(statSync(join(outputRoot, 'bin', 'mnemon')).mode & 0o777, 0o755)
  } finally {
    trees.dispose()
    rmSync(outputRoot, { recursive: true, force: true })
  }
})

test('fails when lipo exits non-zero', () => {
  const trees = makeTrees({ node: { arm64: 'arm', x64: 'x64', machO: true } })
  const outputRoot = join(trees.arm64, '..', 'host')
  const recorder = runRecorder({
    failure: (command, args) => command === 'lipo' && args.includes('-create'),
  })

  try {
    assert.throws(
      () =>
        mergeUniversalBundle({
          arm64Dir: trees.arm64,
          x64Dir: trees.x64,
          outputRoot,
          run: recorder.run,
        }),
      /lipo -create failed/u,
    )
  } finally {
    trees.dispose()
    rmSync(outputRoot, { recursive: true, force: true })
  }
})

test('fails when the merged binary is missing one architecture', () => {
  const trees = makeTrees({ node: { arm64: 'arm', x64: 'x64', machO: true } })
  const outputRoot = join(trees.arm64, '..', 'host')

  try {
    assert.throws(
      () =>
        mergeUniversalBundle({
          arm64Dir: trees.arm64,
          x64Dir: trees.x64,
          outputRoot,
          run: runRecorder({ archs: 'arm64' }).run,
        }),
      /missing x86_64/u,
    )
  } finally {
    trees.dispose()
    rmSync(outputRoot, { recursive: true, force: true })
  }
})
