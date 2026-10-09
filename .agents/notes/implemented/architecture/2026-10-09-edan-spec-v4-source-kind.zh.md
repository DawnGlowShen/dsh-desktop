# The @edan/edan-spec bundle used a retired v4 source kind

Status: **fixed**. `@edan/edan-spec` moved to 1.0.1 with a producer-owned source kind.

## Conclusion

`@edan/edan-spec` injected its bundled `AGENTS.md` under a bare `source.kind === 'plugin'`. Session format v4 refuses that value outright, so the bundle could not persist its baseline message.

`lib/index.js` now declares:

```js
const SOURCE = { kind: name }   // → { kind: '@edan/edan-spec' }
```

## Why `plugin` is refused

`session-format-v3-to-v4/src/message-sources.ts:9` treats the retired wrapper as indistinguishable from an undeclared producer — it refuses `'plugin'` in the same clause as a missing or empty `kind`:

```ts
if (!isSessionFormatJsonObject(value) || typeof value['kind'] !== 'string' || value['kind'].length === 0 || value['kind'] === 'plugin') {
  throw new SessionFormatError('format v4 message requires a producer-owned source kind')
}
```

`packages/llm/llm/src/message.ts:106` states the same rule in prose: "there is no shared catch-all `plugin` kind". Each producer names itself, which is what the merge-extensible `MessageSourceMap` idiom already does — `time-context`, `tmux-context`, `runtime-context`, `model-selection`, `compact-checkpoint`, `session-reference`, `session-title-llm`.

The plugin's original comment explains why it chose a bare `plugin`: it needed a kind distinct from `agent-instructions`, which reconciles only its own `source.kind` (`isWorkspaceContextSource`). **The requirement was "a distinct kind", not "a shared generic kind"** — the package name satisfies both. `agent-instructions` still ignores it, so the two baselines stay independent.

## No legacy sessions needed repair

`assertV4SourceRowAdmission` (`message-sources.ts:29-41`) re-refuses malformed rows already on disk, so I checked for damage. A full scan of `~/.dsh/sessions` found **0 of 143 session files containing `"kind":"plugin"`**.

The reason: the bundle never actually persisted the message. Every stored session is still `session.v3.jsonl.zstd`, so the v3→v4 path was never exercised on this machine. The defect would have surfaced on the first v4 write.

## Verified

Reproducing the v4 predicate directly:

```
旧 {kind:'plugin'}: ✗ 被拒 — format v4 message requires a producer-owned source kind
新 {kind:name}:     ✓ 通过
```

Gates: `verify-desktop-variants` 210 files aligned; `plugins:verify` 10 bundles consistent; both variants typecheck; stable 1903 tests pass, beta 1874 pass.

## The deployed App is a separate copy

Bundle resolution is two-anchor — "first from the dsh installation (the launcher's own package), then from the profile directory" (`dsh-app-boot/lib/types/profile.d.ts`). For `@edan/edan-spec` **both anchors miss**:

- `/Applications/DSH Desktop Evo.app/Contents/Resources/app/` — `node_modules/@edan/edan-spec` exists but is still 1.0.0, built Sep 24.
- `~/.dsh/profiles/desktop-evo/node_modules/` — the profile does not carry `@edan` at all; it only holds pnpm-installed `dsh-cost-meter` and `zod`.

The App bundle's `package.json` declares `"@edan/edan-spec": "file:../vendor/edan-spec/edan-edan-spec-1.0.0.tgz"`, but that tarball is **not shipped**: `vendor/` is absent from the `files` whitelist in `dsh-plugin-desktop/package.json:403`. The packaged dependency therefore points at a path that does not exist inside the App.

Repairing a running install means replacing the plugin inside the App bundle — that is a packaging action, not a source edit, and the App is signed and Fuse-protected.
