/**
 * Live configuration surface for the autocompact engine.
 *
 * Every tunable group is one schemastery `.volatile()` node, so the Settings
 * service can rewrite that group in place while the plugin keeps running. The
 * plugin is NOT re-instantiated on a live edit, so the engine re-reads the
 * groups with `.get()` at the start of every operation (`LiveConfigReader`).
 *
 * Schemastery's rules that this schema obeys:
 * - a volatile node may not sit inside another volatile node, inside an array
 *   item, or inside a union/lazy member (`validateVolatileSchema` throws), so
 *   each group is volatile as a whole and `models` is marked volatile as a
 *   whole rather than item by item;
 * - a section's inner fields carry defaults, so a group is always a complete,
 *   concrete object as soon as it resolves;
 * - preset sections deliberately carry NO defaults, so an absent field stays
 *   absent and the preset inherits that field from the global group instead of
 *   silently overriding it with a default.
 *
 * Schemastery has no cross-field validator (there is no `.check()`), so the
 * field rules that a fail-fast loader used to enforce are applied here as
 * clamp-and-warn-once normalization: reading a live config never throws, which
 * is what makes a half-typed value in the Settings form harmless. Values that
 * cannot be repaired (a preset without provider+model) are dropped and
 * reported once.
 *
 * @module dsh-autocompact/config
 */
import z from '@deepseek-ai/schemastery'
import type { Volatile } from '@deepseek-ai/cordis'
import type {
  ArchiveConfig, HandoffConfig, ModelPreset, ResolvedHandoffConfig, RetainConfig,
  RetriesConfig, SummarizationConfig, TriggerConfig, TriggerMode,
} from './types.ts'

/** Token triggers and retention: 0 means "unset" (see `read`). */
const UPSTREAM_TRIGGER_RATIO = 0.8
const DEFAULT_MAX_TOKENS = 8192
const DEFAULT_ROOT = '.dsh/handoffs'

/** Reported once per distinct problem; cleared whenever the live values change. */
export type ConfigWarn = (message: string) => void

/** A live group as the runtime hands it to the plugin: a stable `.get()` reference. */
export type LiveGroup<T> = Volatile<T> | T

/** The row config the plugin receives, with every group wrapped for live edit. */
export interface HandoffVolatileConfig {
  readonly enabled: LiveGroup<boolean>
  readonly trigger: LiveGroup<{
    mode?: TriggerMode
    ratio?: number
    tokens?: number
  }>
  readonly retain: LiveGroup<{ ratio?: number; tokens?: number }>
  readonly archive: LiveGroup<{ root?: string; gitIgnore?: boolean; onFailure?: 'block' | 'proceed' }>
  readonly summarization: LiveGroup<{ provider?: string; model?: string; maxTokens?: number }>
  readonly retries: LiveGroup<{ compactionRetries?: number; maxOverflowRetries?: number }>
  readonly models: LiveGroup<readonly {
    provider?: string
    model?: string
    trigger?: { mode?: TriggerMode; ratio?: number; tokens?: number }
    retain?: { ratio?: number; tokens?: number }
    summarization?: { provider?: string; model?: string; maxTokens?: number }
    retries?: { compactionRetries?: number; maxOverflowRetries?: number }
    disabled?: boolean
  }[]>
}

/**
 * Global trigger limits; `0` means "unset" so the reader can tell an untouched
 * field from an explicit one. A schema default of `0.8` here would make every
 * configuration window-relative and force a context-window lookup even for a
 * pure absolute-token trigger, which adapters without a declared window cannot
 * answer.
 */
const triggerGroup = () => z.object({
  mode: z.union([z.const('first'), z.const('tokens')]).default('first'),
  ratio: z.number().min(0).max(1).default(0),
  tokens: z.number().step(1).min(0).default(0),
}).default({})

/** Global retention; `tokens` wins when both are set (reported once). 0 means "unset". */
const retainGroup = () => z.object({
  ratio: z.number().min(0).max(1).default(0),
  tokens: z.number().step(1).min(0).default(0),
}).default({})

/** Archive location; `root` is relative to the owning project's directory. */
const archiveGroup = () => z.object({
  root: z.string().default(DEFAULT_ROOT),
  gitIgnore: z.boolean().default(true),
  onFailure: z.union([z.const('block'), z.const('proceed')]).default('block'),
}).default({})

/** Summarization target; empty provider+model inherits the routed conversation target. */
const summarizationGroup = () => z.object({
  provider: z.string().default(''),
  model: z.string().default(''),
  maxTokens: z.number().step(1).min(1).default(DEFAULT_MAX_TOKENS),
}).default({})

/** Retry budgets; 0 is a meaningful value for both. */
const retriesGroup = () => z.object({
  compactionRetries: z.number().step(1).min(0).default(1),
  maxOverflowRetries: z.number().step(1).min(0).default(1),
}).default({})

/**
 * Preset sections: identical fields, no defaults. An absent field must stay
 * absent so the preset inherits the global group rather than overriding it.
 */
const presetTriggerGroup = () => z.object({
  mode: z.union([z.const('first'), z.const('tokens')]),
  ratio: z.number().min(0).max(1),
  tokens: z.number().step(1).min(0),
})

const presetRetainGroup = () => z.object({
  ratio: z.number().min(0).max(1),
  tokens: z.number().step(1).min(0),
})

const presetSummarizationGroup = () => z.object({
  provider: z.string(),
  model: z.string(),
  maxTokens: z.number().step(1).min(1),
})

const presetRetriesGroup = () => z.object({
  compactionRetries: z.number().step(1).min(0),
  maxOverflowRetries: z.number().step(1).min(0),
})

/** One exact provider/model override over the global groups. */
const presetGroup = () => z.object({
  provider: z.string().default(''),
  model: z.string().default(''),
  trigger: presetTriggerGroup(),
  retain: presetRetainGroup(),
  summarization: presetSummarizationGroup(),
  retries: presetRetriesGroup(),
  disabled: z.boolean().default(false),
})

/**
 * The plugin's `Config`. Groups are volatile (live-editable); the `models`
 * array is volatile as a whole because a volatile node may not live inside an
 * array item. The engine always registers the automatic pressure seam and gates
 * it on `enabled`, so one switch governs auto-compaction.
 */
export const autocompactConfig = z.object({
  enabled: z.boolean().default(true).volatile(),
  trigger: triggerGroup().volatile(),
  retain: retainGroup().volatile(),
  archive: archiveGroup().volatile(),
  summarization: summarizationGroup().volatile(),
  retries: retriesGroup().volatile(),
  models: z.array(presetGroup()).default([]).volatile(),
})

/** Whether a value is one of schemastery's live references. */
function isLiveGroup<T>(value: unknown): value is Volatile<T> {
  return typeof value === 'object' && value !== null
    && typeof (value as { get?: unknown }).get === 'function'
}

/** Read one group, accepting both a live reference and a plain value (tests). */
function readGroup<T>(value: LiveGroup<T> | undefined): T | undefined {
  if (value === undefined || value === null) return undefined
  if (isLiveGroup<T>(value)) return value.get() as T
  return value
}

/** A finite number, or undefined. 0 reads as "unset" for trigger limits. */
function positiveNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined
}

/** A non-negative integer, or undefined; 0 stays meaningful. */
function nonNegativeInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined
}

/** A trimmed non-empty string, or undefined. */
function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

function mode(value: unknown): TriggerMode | undefined {
  return value === 'first' || value === 'tokens' ? value : undefined
}

/** Normalize one trigger section; 0/absent fields read as "not set". */
function normalizeTrigger(raw: unknown): TriggerConfig | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const source = raw as { mode?: unknown; ratio?: unknown; tokens?: unknown }
  const limitMode = mode(source.mode)
  const ratio = positiveNumber(source.ratio)
  const tokens = positiveNumber(source.tokens)
  if (limitMode === undefined && ratio === undefined && tokens === undefined) return undefined
  return {
    ...(limitMode === undefined ? {} : { mode: limitMode }),
    ...(ratio === undefined ? {} : { ratio }),
    ...(tokens === undefined ? {} : { tokens }),
  }
}

/**
 * Normalize one retention section; `tokens` wins over `ratio` and the conflict
 * is reported once, because a kept tail expressed twice is ambiguous but not
 * fatal.
 */
function normalizeRetain(raw: unknown, warn: ConfigWarn, scope: string): RetainConfig | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const source = raw as { ratio?: unknown; tokens?: unknown }
  const tokens = positiveNumber(source.tokens)
  let ratio = positiveNumber(source.ratio)
  if (tokens !== undefined && ratio !== undefined) {
    warn(scope + ': retain.ratio and retain.tokens are both set; using retain.tokens and ignoring retain.ratio')
    ratio = undefined
  }
  if (tokens === undefined && ratio === undefined) return undefined
  return { ...(tokens === undefined ? {} : { tokens }), ...(ratio === undefined ? {} : { ratio }) }
}

/** Normalize one summarization section, enforcing the provider+model pair rule. */
function normalizeSummarization(raw: unknown, warn: ConfigWarn, scope: string): SummarizationConfig | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const source = raw as { provider?: unknown; model?: unknown; maxTokens?: unknown }
  let provider = text(source.provider)
  let model = text(source.model)
  if ((provider === undefined) !== (model === undefined)) {
    warn(scope + ': summarization provider and model must be set together; ignoring the incomplete override')
    provider = undefined
    model = undefined
  }
  const maxTokens = positiveNumber(source.maxTokens)
  if (provider === undefined && model === undefined && maxTokens === undefined) return undefined
  return {
    ...(provider === undefined ? {} : { provider }),
    ...(model === undefined ? {} : { model }),
    ...(maxTokens === undefined ? {} : { maxTokens: Math.floor(maxTokens) }),
  }
}

/** Normalize one retry section; 0 stays a valid budget. */
function normalizeRetries(raw: unknown): RetriesConfig | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const source = raw as { compactionRetries?: unknown; maxOverflowRetries?: unknown }
  const compactionRetries = nonNegativeInteger(source.compactionRetries)
  const maxOverflowRetries = nonNegativeInteger(source.maxOverflowRetries)
  if (compactionRetries === undefined && maxOverflowRetries === undefined) return undefined
  return {
    ...(compactionRetries === undefined ? {} : { compactionRetries }),
    ...(maxOverflowRetries === undefined ? {} : { maxOverflowRetries }),
  }
}

/** Normalize the preset list: drop unusable and duplicate entries, once each. */
function normalizePresets(raw: unknown, warn: ConfigWarn): ModelPreset[] {
  if (!Array.isArray(raw)) return []
  const presets: ModelPreset[] = []
  const seen = new Set<string>()
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue
    const source = entry as Record<string, unknown>
    const provider = text(source.provider)
    const model = text(source.model)
    if (provider === undefined || model === undefined) {
      warn('models: a preset needs both provider and model; dropping the incomplete preset')
      continue
    }
    const key = provider + '/' + model
    if (seen.has(key)) {
      warn('models: duplicate preset for ' + key + '; keeping the first')
      continue
    }
    seen.add(key)
    const scope = 'models[' + key + ']'
    const trigger = normalizeTrigger(source.trigger)
    const retain = normalizeRetain(source.retain, warn, scope)
    const summarization = normalizeSummarization(source.summarization, warn, scope)
    const retries = normalizeRetries(source.retries)
    presets.push({
      provider,
      model,
      ...(trigger === undefined ? {} : { trigger }),
      ...(retain === undefined ? {} : { retain }),
      ...(summarization === undefined ? {} : { summarization }),
      ...(retries === undefined ? {} : { retries }),
      ...(source.disabled === true ? { disabled: true } : {}),
    })
  }
  return presets
}

/** Discards notices during the silent probe pass. */
const NOOP: ConfigWarn = () => {}

/**
 * Reads the live configuration and normalizes it into the engine's resolved
 * form. One instance per plugin, so the warn-once memory belongs to the plugin
 * instance and is reset whenever the live values change.
 */
export class LiveConfigReader {
  private signature = ''
  private readonly warned = new Set<string>()

  /** @param warn - Sink for clamp/drop notices; normally the plugin logger. */
  constructor(private readonly warn: ConfigWarn) {}

  /**
   * Resolve the current configuration, reporting each distinct problem once per
   * value generation.
   *
   * The first pass decides silently whether the values changed; only the second
   * pass may warn. Deciding in the same pass would let the change detection
   * clear the notice memory it had just filled, which reported every notice
   * twice (caught by the reader's own test).
   *
   * @param raw - The volatile row config (or a plain object in tests).
   * @returns The resolved configuration, never a throw.
   */
  read(raw: HandoffVolatileConfig | HandoffConfig | undefined): ResolvedHandoffConfig {
    const probe = this.resolve(raw, NOOP)
    const signature = JSON.stringify(probe)
    if (signature !== this.signature) {
      this.signature = signature
      this.warned.clear()
    }
    return this.resolve(raw, this.notice)
  }

  /** Normalize one live value into the resolved form, warning through `warn`. */
  private resolve(raw: HandoffVolatileConfig | HandoffConfig | undefined, warn: ConfigWarn): ResolvedHandoffConfig {
    const source = (raw ?? {}) as HandoffVolatileConfig
    const enabled = readGroup(source.enabled) !== false
    const triggerRaw = readGroup(source.trigger) ?? {}
    const globalTrigger = normalizeTrigger(triggerRaw) ?? {}
    // Both limits unset means "never configured", which keeps the upstream 0.8
    // window-fraction default. An absolute limit configured alone stays
    // window-free, so an adapter that declares no context window can still fire.
    if (globalTrigger.ratio === undefined && globalTrigger.tokens === undefined) {
      globalTrigger.ratio = UPSTREAM_TRIGGER_RATIO
    }
    const globalRetain = normalizeRetain(readGroup(source.retain) ?? {}, warn, 'retain') ?? {}
    const archiveRaw = readGroup(source.archive) ?? {}
    const summarizationRaw = readGroup(source.summarization) ?? {}
    const retriesRaw = readGroup(source.retries) ?? {}
    const presets = normalizePresets(readGroup(source.models) ?? [], warn)

    const provider = text(summarizationRaw.provider)
    const model = text(summarizationRaw.model)
    if ((provider === undefined) !== (model === undefined)) {
      warn('summarization: provider and model must be set together; inheriting the routed model')
    }
    const summarizationProvider = provider !== undefined && model !== undefined ? provider : ''
    const summarizationModel = provider !== undefined && model !== undefined ? model : ''
    const maxTokens = positiveNumber(summarizationRaw.maxTokens)

    const resolved: ResolvedHandoffConfig = {
      trigger: { mode: globalTrigger.mode ?? 'first', ...(globalTrigger.ratio === undefined ? {} : { ratio: globalTrigger.ratio }), ...(globalTrigger.tokens === undefined ? {} : { tokens: globalTrigger.tokens }) },
      retain: { ...(globalRetain.ratio === undefined ? {} : { ratio: globalRetain.ratio }), ...(globalRetain.tokens === undefined ? {} : { tokens: globalRetain.tokens }) },
      archive: {
        root: text(archiveRaw.root) ?? DEFAULT_ROOT,
        gitIgnore: archiveRaw.gitIgnore !== false,
        onFailure: archiveRaw.onFailure === 'proceed' ? 'proceed' : 'block',
      },
      summarization: {
        provider: summarizationProvider,
        model: summarizationModel,
        maxTokens: maxTokens === undefined ? DEFAULT_MAX_TOKENS : Math.floor(maxTokens),
      },
      retries: {
        compactionRetries: nonNegativeInteger(retriesRaw.compactionRetries) ?? 1,
        maxOverflowRetries: nonNegativeInteger(retriesRaw.maxOverflowRetries) ?? 1,
      },
      enabled,
      models: presets,
    }

    return resolved
  }

  /** Report one distinct problem per live value generation. */
  private readonly notice: ConfigWarn = (message) => {
    const line = 'autocompact config: ' + message
    if (this.warned.has(line)) return
    this.warned.add(line)
    this.warn(line)
  }
}

/** Find the exact provider+model preset, if any. A missing route matches nothing. */
export function resolvePreset(
  config: ResolvedHandoffConfig,
  target: { provider?: string; model?: string } | undefined,
): ModelPreset | undefined {
  return config.models.find(preset => preset.provider === target?.provider && preset.model === target?.model)
}

/** Drop undefined keys so the parent's strict `resolveConfig` sees only real values. */
function defined(record: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined))
}

/**
 * Project the live config onto the shape the parent engine validates.
 *
 * `auto` is always true: the automatic seam stays registered and the engine
 * gates it on `enabled`, so one switch governs auto-compaction. `retainRatio`
 * is omitted unless it is strictly below the trigger ratio, because the parent
 * rejects a retention level at or above the fire-at level; the engine clamps
 * the effective value instead of failing.
 */
export function toBasicConfig(resolved: ResolvedHandoffConfig): Record<string, unknown> {
  const retainRatio = resolved.retain.ratio !== undefined
    && resolved.trigger.ratio !== undefined
    && resolved.retain.ratio < resolved.trigger.ratio
    ? resolved.retain.ratio
    : undefined
  return defined({
    thresholdRatio: resolved.trigger.ratio,
    retainRatio,
    retainTokens: resolved.retain.tokens,
    summarizationProvider: resolved.summarization.provider,
    summarizationModel: resolved.summarization.model,
    maxTokens: resolved.summarization.maxTokens,
    compactionRetries: resolved.retries.compactionRetries,
    maxOverflowRetries: resolved.retries.maxOverflowRetries,
    modelPolicies: resolved.models.map(model => defined({
      provider: model.provider,
      model: model.model,
      thresholdRatio: model.trigger?.ratio,
      retainRatio: model.retain?.ratio !== undefined
        && model.trigger?.ratio !== undefined
        && model.retain.ratio < model.trigger.ratio
        ? model.retain.ratio
        : undefined,
      retainTokens: model.retain?.tokens,
      summarizationProvider: model.summarization?.provider,
      summarizationModel: model.summarization?.model,
      maxTokens: model.summarization?.maxTokens,
      compactionRetries: model.retries?.compactionRetries,
      maxOverflowRetries: model.retries?.maxOverflowRetries,
    })),
    auto: true,
  })
}

/** The archive group in document form, for diagnostics and the settings card. */
export function archiveConfigOf(resolved: ResolvedHandoffConfig): Required<ArchiveConfig> {
  return { root: resolved.archive.root, gitIgnore: resolved.archive.gitIgnore, onFailure: resolved.archive.onFailure }
}
