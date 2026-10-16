/**
 * The offline payload's configuration stage: what a payload writes after it is installed.
 *
 * Installing a plugin or a CLI is not always enough for it to work. Two shipped payloads
 * prove the point, from opposite directions:
 *
 * - `git-ai` attributes edits from Git's Trace2 events, which Git only emits when
 *   `trace2.eventTarget` points at the daemon's socket. Without that key a checkpoint
 *   still succeeds, but every later commit reads back as `untracked` — the feature fails
 *   silently.
 * - `dsh-dream-skin` keeps its appearance in `$DSH_HOME/dream-skin.json` and falls back
 *   to its own factory look when that file is absent. Without a seeded file a fresh
 *   installation opens with the plugin's stock look rather than the prepared one.
 *
 * ## Why a registry rather than a branch per payload
 *
 * Adding a third configuration should not mean editing this file. A configuration is a
 * module that declares a name and a mode; the registry is the only place that knows which
 * ones exist. {@link applyPayloadConfigurations} therefore contains no payload-specific
 * condition at all.
 *
 * ## Why each configuration declares its own mode
 *
 * The two shipped configurations above answer "what if I run twice?" in opposite ways,
 * and both answers are right:
 *
 * - `converge` — {@link ConfigureMode} for a file this product owns. The gitconfig block
 *   is rewritten on every launch so Trace2 stays pointed at the live socket.
 * - `seed` — for a file the user owns. An existing `dream-skin.json` is the user's chosen
 *   appearance and is never touched.
 *
 * The difference is *who owns the file*, which only the configuration knows. So the mode
 * is declared here and honoured by the executor, never assumed by it.
 *
 * ## Failure semantics
 *
 * One configuration failing must cost only itself: a broken gitconfig writer cannot be
 * allowed to withhold the dream-skin seed, and neither may stop the application from
 * reaching a window. Every outcome is therefore reported rather than thrown, matching the
 * contract {@link installOfflineManifest} already gives its callers.
 *
 * ## Adding a configuration
 *
 * 1. Add a module, `offline-install-config-<name>.ts`, exporting a
 *    {@link PayloadConfiguration}: a `name`, a `mode`, and an `apply` that returns a
 *    {@link ConfigureOutcome}. Import `ConfigureContext` from this file; do not reach for
 *    `process.env` — everything a configuration needs is on the context, and a hidden
 *    environment dependency is invisible on the machine you cannot inspect.
 * 2. Pick the mode by asking who owns the target file, not by asking which is safer:
 *    `seed` when the user owns it and their edits must survive, `converge` when this
 *    product owns it and a stale value breaks something. If the target is a file the user
 *    may reasonably have changed by hand, it is `seed`.
 * 3. Register it in {@link PAYLOAD_CONFIGURATIONS}.
 * 4. Cover it with a test that includes a second run, proving the declared mode holds —
 *    a `seed` configuration that overwrites on the second run is the failure this whole
 *    mechanism exists to prevent.
 *
 * Nothing else changes: this executor, the install pipeline, the settings action and the
 * end-to-end spec all pick it up from the registry. If the configuration needs a packaged
 * file, add it to the `extraResources` list of each packaged platform — the snapshot has
 * to be a real file beside the application, not an asar member, because the plugin reads
 * it at mount.
 */


/** What a configuration did, in the terms the caller reports. */
export type ConfigureAction =
  /**
   * The target now holds what this configuration wanted it to hold, having been
   * changed by this run.
   */
  | 'configured'
  /** Already in the wanted state; this run changed nothing. */
  | 'current'
  /** Deliberately not applied: the target belongs to the user, or a resource is absent. */
  | 'skipped'
  /** The write was attempted and failed. */
  | 'failed'

/**
 * How a configuration behaves when its target already exists.
 *
 * Declared by the configuration because only it knows whether the target is a product
 * setting or a piece of the user's own data.
 */
export type ConfigureMode =
  /**
   * Bring the target to the wanted state on every run.
   *
   * For settings this product owns and a stale value would break. Rewriting is the point:
   * a socket path can move between launches, and a configuration that only ever wrote
   * once would leave Git pointing at a socket that no longer exists.
   */
  | 'converge'
  /**
   * Write only when the target is absent.
   *
   * For files the user owns. Once the user has expressed a preference, overwriting it on
   * the next launch would discard their choice — the seed exists to give a fresh
   * installation a starting point, not to keep enforcing one.
   */
  | 'seed'

/** One configuration's result. */
export interface ConfigureOutcome {
  /** Registry name of the configuration that produced this. */
  readonly name: string
  /** What it did. */
  readonly action: ConfigureAction
  /** Why it was skipped or failed; absent for the other actions. */
  readonly reason?: string
}

/** Everything a configuration may need from the running application. */
export interface ConfigureContext {
  /** DSH home, e.g. `~/.dsh`; the root every payload-owned path hangs off. */
  readonly homeDir: string
  /** User's home directory, for configuration that targets files outside the DSH home. */
  readonly userHomeDir: string
  /** Host platform, for configuration whose target format is platform-specific. */
  readonly platform: NodeJS.Platform
  /** Application resources directory, holding packaged configuration payloads. */
  readonly resourcesPath: string
  /** Diagnostic prefix for messages, e.g. `dsh-plugin-desktop`. */
  readonly binName: string
  /** Sink for the summary of each run. */
  readonly logger: ConfigureLogger
}

/**
 * Logger surface for this stage.
 *
 * `info` is optional because the desktop shell's stderr logger has no info channel, and
 * an absent one must not be a reason to skip a configuration.
 */
export interface ConfigureLogger {
  readonly info?: (message: string) => void
  readonly error: (message: string) => void
}

/** One configuration the payload ships. */
export interface PayloadConfiguration {
  /** Registry name; appears in every outcome this configuration produces. */
  readonly name: string
  /** What a second run should do, declared by the configuration itself. */
  readonly mode: ConfigureMode
  /**
   * Apply the configuration.
   *
   * May throw: the executor catches, records a failure and continues with the next
   * configuration. Returning `skipped` is for the deliberate cases — an absent packaged
   * resource, or a target the user owns — where nothing is wrong.
   *
   * @param context - Application facts the configuration may need.
   * @returns what this run did.
   */
  readonly apply: (context: ConfigureContext) => ConfigureOutcome
}

/**
 * Configurations applied to every installation, in the order they run.
 *
 * Payload order matters only for readability and for which failure a log reader sees
 * first; no configuration depends on another, and the executor runs them all regardless
 * of what an earlier one did.
 */
/**
 * The registry is empty here on purpose: each configuration lands in the commit that
 * also ships the resource or CLI it needs, so this file never imports a module a
 * narrower build does not carry.
 */
export const PAYLOAD_CONFIGURATIONS: readonly PayloadConfiguration[] = []

/**
 * Apply one configuration, turning any throw into a reported failure.
 *
 * The catch is not defensive padding: this runs before the window exists, and a
 * configuration that throws — a malformed packaged snapshot, a read-only home — has to
 * cost its own entry in the report rather than the launch.
 */
function applyOne(configuration: PayloadConfiguration, context: ConfigureContext): ConfigureOutcome {
  try {
    return configuration.apply(context)
  } catch (cause) {
    return {
      name: configuration.name,
      action: 'failed',
      reason: cause instanceof Error ? cause.message : String(cause),
    }
  }
}

/**
 * Apply every registered configuration.
 *
 * Outcomes come back in registration order and one entry per configuration, so a caller
 * can report the whole stage rather than only the parts that failed. A configuration that
 * throws is reported as `failed` and does not stop the others.
 *
 * @param context - Application facts handed to each configuration.
 * @param configurations - Registry to run; defaults to the shipped one, injectable so a
 *   test can exercise the executor without the real configurations touching a machine.
 * @returns one outcome per configuration, in order.
 */
export function applyPayloadConfigurations(
  context: ConfigureContext,
  configurations: readonly PayloadConfiguration[] = PAYLOAD_CONFIGURATIONS,
): ConfigureOutcome[] {
  return configurations.map(configuration => applyOne(configuration, context))
}
