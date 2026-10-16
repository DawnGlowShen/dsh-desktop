# Agent Note: Offline payloads write configuration through a registry

English | [中文](2026-10-15-offline-payload-configuration.zh.md)

## Problem

The offline installer puts plugins into a Profile and CLIs on the user's `PATH`, but installing a payload is not always enough for it to work. Two shipped payloads fail silently without a further write:

- `git-ai` attributes edits from Git's Trace2 events, which Git only emits when `trace2.eventTarget` points at the daemon's socket. Without that key a checkpoint still succeeds and every later commit reads back as `untracked` — the user sees wrong numbers, not an error.
- `dsh-dream-skin` keeps its appearance in `$DSH_HOME/dream-skin.json` and falls back to its own factory look when that file is absent. The plugin deliberately exposes no configuration for its built-ins, so without a seeded file a fresh installation opens with the plugin's stock look rather than the prepared one.

Before this change each payload's configuration was a separate hard-coded block in `main.ts`, each with its own path assembly and its own `try`/`catch`. A third configuration meant editing that file again.

## Decision

Configuration is a registry entry, not a branch in the installer.

`offline-install-configure.ts` holds a `Map`-shaped list of `PayloadConfiguration` values. Each declares a `name`, a `mode`, and an `apply` returning a `ConfigureOutcome`. `applyPayloadConfigurations` runs them all, catches each independently, and returns one outcome per entry. It contains no payload-specific condition.

The stage sits beside the three existing install stages in `installOfflineManifest`, ordered last and independent of them. It runs whether or not any tarball succeeded: a configuration states what the machine needs, not what the payload provides. Ordering it last also lets a configuration read a payload that has already been unpacked, which the reverse order could not.

Both the launch path and the settings page's restore action reach this through the same `runOfflineInstall` call, so the two cannot disagree about what has been applied.

### Each configuration declares its own mode

The two shipped configurations answer "what if I run twice?" in opposite ways, and both answers are right:

| | `git-ai` | `dream-skin` |
|---|---|---|
| Target | `~/.gitconfig` | `$DSH_HOME/dream-skin.json` |
| Owner | this product | the user |
| Mode | `converge` | `seed` |
| A second run | rewrites the block | does nothing |

`converge` is for a setting the product owns where a stale value would break: a home directory restored from a backup moves the daemon socket, and a configuration that wrote once and never again would leave Git pointing at a socket that no longer exists. `seed` is for a file the user owns: `dsh-dream-skin` rewrites `dream-skin.json` on every preference change, so by the next launch its contents are the user's choice, and overwriting would silently undo their work.

Only the configuration knows which kind of file it targets, so the mode is declared there and honoured by the executor — never assumed by it.

### Failure semantics

One configuration failing costs only itself. Each `apply` is wrapped so a throw becomes a `failed` outcome carrying the reason; the remaining configurations still run, and the launch continues to a window. This matches the best-effort contract the three install stages already gave their callers.

A missing packaged resource is reported as `skipped`, not `failed`: a build that ships no prepared appearance is a normal build. Only `failed` produces an error-level log line, because reporting a deliberate skip as a fault sends an operator looking for a problem that is not there.

### Why code rather than a script in the payload

A configuration could instead be a `.mjs` file shipped in the payload and `import()`ed at runtime, which would let a new configuration be added by dropping in a file. This was rejected: it executes arbitrary code inside a signed, notarised application, and its flexibility is largely illusory because editing a payload file after packaging invalidates the signature — a new configuration still needs a rebuild either way. Since a rebuild is required regardless, a module under type checking, review, and test is strictly better.

## Verification

Executor tests cover registration order, one outcome per entry, isolation of a throwing configuration, non-`Error` throws, and that the declared mode is passed through rather than reinterpreted.

The two configurations are covered by their own specs: `offline-install-config-git-ai.spec.ts` carries 35 cases ported from the evo branch plus 8 pinning the integration points, and `offline-install-config-dream-skin.spec.ts` carries 6 plus 5.

`offline-install-end-to-end.spec.ts` is the only place that answers whether a real installation puts a real file where the plugin will look for it. It runs against the payload in `vendor/offline-install` rather than a synthetic one, in a temporary home, and asserts that a real `~/.gitconfig` receives the Trace2 block, that a second run reports every configuration as unchanged, and that a user-edited `dream-skin.json` survives a restore.

The git-ai port was checked for the two Windows bugs fixed on the evo branch after its initial commit — the named-pipe spelling and gitconfig value escaping — because porting the first version alone would reintroduce silent attribution failure on Windows.

## Alternatives considered

**A per-payload branch in the installer.** The state before this change. Rejected because adding a configuration meant editing the installer, the launch path, and the settings action.

**Binding configurations to manifest entries.** A `configure` field on a CLI or plugin entry, naming the configuration to run. Rejected because applicability does not follow from whether the payload was installed this run: a user may have installed `dsh-dream-skin` themselves, and the seed is still wanted. It would also make the configuration a passenger of the payload's failure, so a broken tarball would withhold an unrelated setting.

**A generic seed-file writer.** One function taking `{target, source, mode}`, with both configurations reduced to registry rows. Rejected at this scale: `dream-skin` is 72 lines carrying judgments specific to it — parse the snapshot before writing so a corrupt one fails here rather than leaving the plugin with a file it discards, `0o600` because the state holds wallpaper data URLs, and a direct-write fallback where a Windows rename fails. Abstracting needs a second seeder to show which parts generalise; there is only one.

**Environment variables instead of the global gitconfig.** `GIT_CONFIG_COUNT`/`GIT_CONFIG_KEY_n`/`GIT_CONFIG_VALUE_n` would cover every process the product launches, but a user typing `git commit` in their own terminal bypasses them and loses attribution. The global file covers both, at the cost of editing a file the user owns — which is why the previous value is commented out rather than deleted, and reported in the outcome.
