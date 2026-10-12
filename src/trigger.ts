/**
 * Effective-threshold math for the extended triggers (spec §5): combination
 * modes, per-model presets, and the upstream-inherited 0.8 default.
 *
 * @module compaction-handoff/trigger
 */
import { TargetPressureConfigError } from '@deepseek-ai/dsh-compaction-basic/src/config.ts'
import type { ModelPreset, ResolvedHandoffConfig } from './types.ts'

/** Recursively freeze a JSON-shaped value so callers cannot mutate the resolved spec. */
function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value
  const record = value as Record<string, unknown>
  Object.freeze(record)
  for (const key of Object.keys(record)) deepFreeze(record[key])
  return value
}

/** Fully resolved pressure + retention budget for one routed model. */
export interface HandoffCompactSpec {
  readonly provider: string
  readonly model: string
  /** Absolute fire-at token count. */
  readonly thresholdTokens: number
  /** Verbatim recent-tail budget in tokens. */
  readonly retainTokens: number
  readonly compactionRetries: number
  readonly summarizationProvider: string
  readonly summarizationModel: string
  readonly maxTokens: number
  /** True when a disabled:true preset matched: never auto-fire. */
  readonly disabled: boolean
  /** Which configured limit produced the threshold (diagnostics). */
  readonly thresholdSource: 'default' | 'ratio' | 'tokens' | 'ratio+tokens'
  /** True when the resolved keep-tail was clamped to threshold-1 (it exceeded the fire-at level). */
  readonly retainClamped: boolean
}

/** Whether the resolved trigger math needs the model context window. */
export function needsWindowFor(config: ResolvedHandoffConfig, preset: ModelPreset | undefined): boolean {
  // A preset's trigger section replaces the global trigger wholesale (only the
  // mode stays inherited): "this model auto-compacts at N tokens" must not
  // keep ALSO firing at the global ratio (plan Task 4 test, spec §2 intent).
  const trigger = preset?.trigger ?? config.trigger
  const mode = trigger.mode ?? config.trigger.mode
  const ratio = preset?.trigger === undefined ? config.trigger.ratio : trigger.ratio
  const tokens = preset?.trigger === undefined ? config.trigger.tokens : trigger.tokens
  const retain = preset?.retain ?? config.retain
  return (ratio !== undefined && !(mode === 'tokens' && tokens !== undefined))
    || (ratio === undefined && tokens === undefined)
    || retain.ratio !== undefined
}

/** Resolve the effective spec for one routed model against its known window. */
export function resolveHandoffSpec(
  config: ResolvedHandoffConfig,
  preset: ModelPreset | undefined,
  contextWindow: number | undefined,
): HandoffCompactSpec {
  const provider = preset?.provider ?? 'unknown'
  const model = preset?.model ?? 'unknown'
  const targetKey = provider + '/' + model
  // Section-level trigger override: a preset trigger replaces the global
  // trigger (mode still inherits); without a preset the globals stand alone.
  const trigger = preset?.trigger ?? config.trigger
  const mode = trigger.mode ?? config.trigger.mode
  const ratio = preset?.trigger === undefined ? config.trigger.ratio : trigger.ratio
  const tokens = preset?.trigger === undefined ? config.trigger.tokens : trigger.tokens
  const retain = preset?.retain ?? config.retain

  if (needsWindowFor(config, preset)
    && (contextWindow === undefined || !Number.isInteger(contextWindow) || contextWindow <= 0)) {
    throw new TargetPressureConfigError(
      targetKey,
      'compaction-handoff: no context capacity for ' + targetKey
      + '; a ratio-based trigger or retention needs the model contextWindow on its adapter',
    )
  }

  const ratioThreshold = ratio === undefined || contextWindow === undefined
    ? Number.POSITIVE_INFINITY
    : Math.floor(contextWindow * ratio)
  let thresholdTokens: number
  let thresholdSource: HandoffCompactSpec['thresholdSource']
  if (ratio === undefined && tokens === undefined) {
    // Inherited upstream default (needsWindowFor already guaranteed a window).
    thresholdTokens = Math.floor(contextWindow! * 0.8)
    thresholdSource = 'default'
  } else if (mode === 'tokens' && tokens !== undefined) {
    thresholdTokens = tokens
    thresholdSource = ratio === undefined ? 'tokens' : 'ratio+tokens'
  } else if (ratio === undefined) {
    thresholdTokens = tokens!
    thresholdSource = 'tokens'
  } else if (tokens === undefined) {
    thresholdTokens = ratioThreshold
    thresholdSource = 'ratio'
  } else {
    thresholdTokens = Math.min(ratioThreshold, tokens)
    thresholdSource = 'ratio+tokens'
  }

  const configuredRetain = retain.tokens ?? Math.floor(contextWindow! * retain.ratio!)
  // Clamp instead of throwing (Decision A, 2026-09-12): a ratio-based retain
  // resolves against the model window, so a small absolute token trigger plus the
  // (window-relative) retain floor is contradictory only AT RESOLUTION time —
  // throwing here poisons every pre-step and the run loop swallows the error with
  // a warn-once, silently disabling auto-compact. Keeping threshold-1 tokens
  // honors the trigger exactly; the caller observes retainClamped and warns.
  let retainTokens = configuredRetain
  const retainClamped = configuredRetain >= thresholdTokens
  if (retainClamped) retainTokens = Math.max(thresholdTokens - 1, 0)

  const summarization = preset?.summarization ?? {}
  const retries = preset?.retries ?? {}
  return deepFreeze({
    provider,
    model,
    thresholdTokens,
    retainTokens,
    compactionRetries: retries.compactionRetries ?? config.retries.compactionRetries,
    summarizationProvider: summarization.provider ?? config.summarization.provider,
    summarizationModel: summarization.model ?? config.summarization.model,
    maxTokens: summarization.maxTokens ?? config.summarization.maxTokens,
    disabled: preset?.disabled ?? false,
    thresholdSource,
    retainClamped,
  })
}

/** Whether the measured token count has reached the effective threshold. */
export function wouldFire(spec: HandoffCompactSpec, measuredTokens: number): boolean {
  return !spec.disabled && measuredTokens >= spec.thresholdTokens
}
