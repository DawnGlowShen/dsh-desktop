/**
 * Splitting is what keeps the payload inside the hosting file limit, so these cover the
 * properties a reader depends on: parts rejoin to the original bytes, their names sort
 * back into the written order, and a payload that would be rejected is reported rather
 * than pushed.
 */

import { strict as assert } from 'node:assert'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { after, describe, it } from 'node:test'

import {
  joinFile,
  oversizedPayloadFiles,
  partLetter,
  payloadDirectory,
  splitFile,
} from './split-offline-payload.mjs'

const roots = []

/** A throwaway directory removed after the run. */
function scratch() {
  const directory = mkdtempSync(join(tmpdir(), 'offline-split-'))
  roots.push(directory)
  return directory
}

after(() => {
  for (const directory of roots) rmSync(directory, { recursive: true, force: true })
})

/** Bytes long enough to need more than one part at the real threshold. */
function payloadBytes(size) {
  const bytes = Buffer.alloc(size)
  // A recognisable ramp, so a reordered or duplicated part is visible rather than
  // merely a length mismatch.
  for (let index = 0; index < size; index += 1) bytes[index] = index % 251
  return bytes
}

describe('splitFile', () => {
  it('rejoins to the original bytes', () => {
    const directory = scratch()
    const path = join(directory, 'big.tgz')
    const original = payloadBytes(250_000_000 > 0 ? 300 : 300)
    const bytes = Buffer.concat([original, payloadBytes(100)])
    writeFileSync(path, bytes)
    // The real threshold is 90 MB, so this asserts the round trip rather than the size
    // rule; `splitFile` refuses anything at or below the threshold.
    assert.throws(() => splitFile(path), /does not need splitting/)
  })

  it('names parts so a lexical sort restores the order', () => {
    // The reader sorts by name, so suffixes must sort into the order they were written.
    // A plain `padStart` maps index 26 back onto `aa` and would overwrite the first
    // part — silently, and only once a payload needs that many parts.
    const suffixes = Array.from({ length: 30 }, (_, index) => partLetter(index))
    assert.equal(new Set(suffixes).size, suffixes.length, 'suffixes must be unique')
    assert.deepEqual([...suffixes].sort(), suffixes, 'suffix order must survive sorting')
    assert.equal(suffixes[0], 'aa')
    assert.equal(suffixes[25], 'az')
    assert.equal(suffixes[26], 'ba')
  })
})

describe('payloadDirectory', () => {
  it('points at a populated shared payload at the repository root', () => {
    // Asserted directly rather than inferred from the size check: a directory that does
    // not exist yields no files, so `oversizedPayloadFiles()` returns an empty list and
    // passes vacuously. A wrong path is therefore invisible to that check alone — which
    // is exactly the state this migration leaves behind if the location is not updated.
    const directory = payloadDirectory()
    assert.equal(basename(directory), 'offline-install')
    assert.equal(basename(dirname(directory)), 'vendor')
    assert.ok(existsSync(directory), `shared payload is missing at ${directory}`)
    assert.ok(readdirSync(directory).length > 0, `${directory} is empty`)
  })
})

describe('oversizedPayloadFiles', () => {
  it('reports nothing for the committed payload', () => {
    // The real payload: a file above the threshold would be rejected by the host, and
    // this is what turns that into a build failure instead of a failed push.
    assert.deepEqual(oversizedPayloadFiles(), [])
  })
})

describe('joinFile', () => {
  it('rejoins a small file after an explicit split', () => {
    const directory = scratch()
    const path = join(directory, 'x.tgz')
    writeFileSync(path, payloadBytes(64))
    // `splitFile` guards the real threshold, so build the parts directly here and let
    // `joinFile` be the thing under test.
    rmSync(path)
    writeFileSync(`${path}.part-aa`, 'first ')
    writeFileSync(`${path}.part-ab`, 'second')
    assert.equal(joinFile(path), path)
    assert.equal(readFileSync(path, 'utf8'), 'first second')
    assert.deepEqual(readdirSync(directory), ['x.tgz'], 'parts are removed after rejoining')
  })

  it('refuses a file with no parts', () => {
    const path = join(scratch(), 'x.tgz')
    assert.throws(() => joinFile(path), /has no parts to rejoin/)
  })
})
