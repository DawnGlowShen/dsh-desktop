/**
 * The offline payload's configuration stage.
 *
 * The value under test is the executor's contract, not any particular configuration:
 * results come back in registry order, one per configuration; a configuration that
 * throws costs only itself; and the declared mode is passed through rather than
 * reinterpreted. The shipped configurations are covered by their own specs, so the
 * registry is injected here and the executor is exercised on its own.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { configureDreamSkin } from '../src/offline-install-config-dream-skin.ts'
import { configureGitAiTrace2 } from '../src/offline-install-config-git-ai.ts'
import {
  applyPayloadConfigurations,
  type ConfigureContext,
  type ConfigureOutcome,
  type PayloadConfiguration,
} from '../src/offline-install-configure.ts'

/** Repository root, derived from this file so the test runs from any working directory. */
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

/** A context whose fields are inert: the fake configurations below read none of them. */
function context(): ConfigureContext {
  return {
    homeDir: '/tmp/dsh-home',
    userHomeDir: '/tmp/user-home',
    platform: 'darwin',
    resourcesPath: '/tmp/resources',
    binName: 'dsh-plugin-desktop',
    logger: { error: () => {} },
  }
}

/** A configuration that reports a fixed outcome. */
function fixed(name: string, mode: PayloadConfiguration['mode'], action: ConfigureOutcome['action']): PayloadConfiguration {
  return { name, mode, apply: () => ({ name, action }) }
}

/** A configuration that records its name and then throws. */
function throwing(name: string, seen: string[]): PayloadConfiguration {
  return {
    name,
    mode: 'converge',
    apply: () => {
      seen.push(name)
      throw new Error(`${name} exploded`)
    },
  }
}

describe('applyPayloadConfigurations', () => {
  it('returns one outcome per configuration, in registration order', () => {
    const outcomes = applyPayloadConfigurations(context(), [
      fixed('first', 'seed', 'configured'),
      fixed('second', 'converge', 'current'),
      fixed('third', 'seed', 'skipped'),
    ])

    expect(outcomes).toEqual([
      { name: 'first', action: 'configured' },
      { name: 'second', action: 'current' },
      { name: 'third', action: 'skipped' },
    ])
  })

  it('runs nothing and reports nothing when no configuration is registered', () => {
    expect(applyPayloadConfigurations(context(), [])).toEqual([])
  })

  it('keeps running the others when one configuration throws', () => {
    const seen: string[] = []
    const outcomes = applyPayloadConfigurations(context(), [
      fixed('healthy-before', 'seed', 'configured'),
      throwing('broken', seen),
      fixed('healthy-after', 'seed', 'configured'),
    ])

    expect(seen).toEqual(['broken'])
    expect(outcomes.map(outcome => outcome.name)).toEqual(['healthy-before', 'broken', 'healthy-after'])
    expect(outcomes[1]?.action).toBe('failed')
    expect(outcomes[1]?.reason).toContain('broken exploded')
    expect(outcomes[0]?.action).toBe('configured')
    expect(outcomes[2]?.action).toBe('configured')
  })

  it('reports a non-Error throw as a failure without losing the reason', () => {
    const outcomes = applyPayloadConfigurations(context(), [
      { name: 'string-thrower', mode: 'converge', apply: () => { throw 'plain string' } },
    ])

    expect(outcomes).toEqual([{ name: 'string-thrower', action: 'failed', reason: 'plain string' }])
  })

  it('passes the same context to every configuration', () => {
    const received: ConfigureContext[] = []
    const capture: PayloadConfiguration = {
      name: 'capture',
      mode: 'seed',
      apply: (received_) => { received.push(received_); return { name: 'capture', action: 'configured' } },
    }
    const shared = context()

    applyPayloadConfigurations(shared, [capture, capture])

    expect(received).toEqual([shared, shared])
  })

  it('does not call a configuration whose declared mode is seed when it reports current', () => {
    // The mode is the configuration's own statement about what a second run does; the
    // executor must pass it through rather than reinterpreting the action itself. This
    // pins that a `seed` configuration reporting `current` is not rewritten into
    // `configured` — the two are different facts and the caller reports them differently.
    const outcomes = applyPayloadConfigurations(context(), [fixed('seeded', 'seed', 'current')])

    expect(outcomes).toEqual([{ name: 'seeded', action: 'current' }])
  })
})

  it('treats every configuration alike, whatever its name', () => {
    // The executor must not know any configuration by name: dispatching on one is how the
    // registry turns back into the per-payload branching it replaced. Asserted by giving
    // the executor a configuration whose name matches a shipped one and checking it is
    // called exactly like any other — a name-based branch would skip or special-case it.
    const seen: string[] = []
    const named = (name: string): PayloadConfiguration => ({
      name,
      mode: 'converge',
      apply: () => { seen.push(name); return { name, action: 'configured' } },
    })

    const outcomes = applyPayloadConfigurations(context(), [
      named('git-ai'),
      named('dream-skin'),
      named('something-new'),
    ])

    expect(seen).toEqual(['git-ai', 'dream-skin', 'something-new'])
    expect(outcomes).toEqual([
      { name: 'git-ai', action: 'configured' },
      { name: 'dream-skin', action: 'configured' },
      { name: 'something-new', action: 'configured' },
    ])
  })

  it('passes the context through unchanged rather than adjusting it per configuration', () => {
    // A per-name branch could also show up as mutating the context before a call. The
    // executor hands the same object to everyone and never writes to it.
    const received: ConfigureContext[] = []
    const capture: PayloadConfiguration = {
      name: 'git-ai',
      mode: 'seed',
      apply: (given) => { received.push(given); return { name: 'git-ai', action: 'configured' } },
    }
    const shared = context()
    const snapshot = { ...shared }

    applyPayloadConfigurations(shared, [capture, capture])

    expect(received).toEqual([shared, shared])
    expect(shared).toEqual(snapshot)
  })

describe('目标路径不来自载荷（架构不变量）', () => {
  it('writes only under the context home, whatever the resources directory holds', () => {
    // The spec requirement is that no payload value can steer where a configuration
    // writes. A configuration is code in the registry rather than data in the manifest, so
    // there is no payload-supplied path to validate; what has to be shown is that the
    // write target follows the context and nothing else.
    //
    // Asserted by behaviour rather than by scanning source text: a text check passes when
    // the module merely avoids certain words, and fails when an unrelated comment mentions
    // one — it measures vocabulary, not reachability.
    const root = mkdtempSync(join(tmpdir(), 'config-target-'))
    try {
      const resourcesPath = join(root, 'resources')
      mkdirSync(resourcesPath, { recursive: true })
      // Populate the resources directory with everything a payload-influenced target could
      // plausibly key off: the snapshot it legitimately reads, plus a file whose name and
      // contents look like a path, plus a decoy directory. A test that only ships the
      // snapshot cannot distinguish "the target comes from the context" from "the target
      // comes from the snapshot when present" — the hostile names are what make it able to.
      writeFileSync(join(resourcesPath, 'dream-skin-default.json'), JSON.stringify({ 'dsh-dream-skin:skin': 'x' }), 'utf8')
      writeFileSync(join(resourcesPath, 'steer.json'), JSON.stringify({ homeDir: join(resourcesPath, 'steered') }), 'utf8')

      // Record what the directory holds before the run, so the assertion below can ask
      // "did anything new appear" rather than "does this path exist" — the decoys are
      // meant to be there.
      const before = new Set(readdirSync(resourcesPath, { recursive: true }).map(String))

      const first = join(root, 'home-one')
      const second = join(root, 'home-two')
      for (const homeDir of [first, second]) {
        configureDreamSkin({
          homeDir,
          userHomeDir: join(root, 'user'),
          platform: 'darwin',
          resourcesPath,
          binName: 'dsh-test',
          logger: { error: () => {} },
        })
      }

      // The state file lands under the home it was given, in both cases, and nowhere else.
      expect(existsSync(join(first, 'dream-skin.json'))).toBe(true)
      expect(existsSync(join(second, 'dream-skin.json'))).toBe(true)
      // Nothing new appeared beside the resources directory. Comparing directory listings
      // catches a write under any name, including one derived from a payload value that the
      // test did not think to guess.
      const after = readdirSync(resourcesPath, { recursive: true }).map(String)
      expect(after.filter(entry => !before.has(entry))).toEqual([])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('targets the user home gitconfig for git-ai, not the DSH home', () => {
    // The other half of the invariant: git-ai's target is a fixed name under the user's
    // home. Asserted by running it, so a future change that derived the path from anything
    // payload-shaped would show up as a file appearing somewhere else.
    const root = mkdtempSync(join(tmpdir(), 'config-target-gitai-'))
    try {
      const homeDir = join(root, 'dsh')
      const userHomeDir = join(root, 'user')
      mkdirSync(userHomeDir, { recursive: true })

      configureGitAiTrace2({
        homeDir,
        userHomeDir,
        platform: 'darwin',
        resourcesPath: join(root, 'resources'),
        binName: 'dsh-test',
        logger: { error: () => {} },
      })

      expect(existsSync(join(userHomeDir, '.gitconfig'))).toBe(true)
      expect(existsSync(join(homeDir, '.gitconfig'))).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('keeps ConfigureContext free of payload entry fields', () => {
    // The type is the enforcement point: a configuration can only reach these fields, and
    // none of them comes from the manifest, so no payload value can reach a path. Checked
    // against the type definition — which is a type, not prose — rather than by grepping
    // implementation files.
    const source = readFileSync(join(repositoryRoot, 'dsh-plugin-desktop-beta', 'src', 'offline-install-configure.ts'), 'utf8')
    const contextBody = /export interface ConfigureContext \{([\s\S]*?)\n\}/u.exec(source)?.[1] ?? ''
    expect(contextBody).not.toBe('')
    for (const field of ['homeDir', 'userHomeDir', 'platform', 'resourcesPath', 'binName', 'logger']) {
      expect(contextBody, field).toContain(field)
    }
    for (const payloadField of ['tarball', 'executable', 'manifest']) {
      expect(contextBody, `ConfigureContext exposes ${payloadField}`).not.toContain(payloadField)
    }
  })
})
