/**
 * Configuration vocabulary for the autocompact plugin.
 *
 * These are the *document* shapes: what a user writes in a preset or an
 * override. The engine never reads them directly — it reads the live resolved
 * form (`ResolvedHandoffConfig`) produced by `src/config.ts`, which applies
 * defaults and clamp-and-warn-once normalization on every call.
 *
 * @module dsh-autocompact/types
 */
import type { ContextFormed } from '@deepseek-ai/dsh-llm'

declare module '@deepseek-ai/dsh-llm' {
  /**
   * This plugin's own message source.
   *
   * The harness has no shared catch-all "plugin" kind: every producer declares
   * its own in its own module, and consumers fall through unknown kinds. Both
   * messages this plugin contributes to a conversation carry it — the drop
   * tombstone (a `notice` of what was removed) and the pressure advisory the
   * model receives before the engine compacts on its own.
   */
  interface MessageSourceMap {
    'dsh-autocompact': { kind: 'dsh-autocompact' } & ContextFormed
  }
}

/** How a ratio limit and an absolute token limit combine when both are set. */
export type TriggerMode = 'first' | 'tokens'

/**
 * Which measurement the memory decide band compares against its budget.
 *
 * - `surface`: the conversation surface alone. This is what a drop can
 *   actually free, so it is the honest unit for a decide band.
 * - `total`: the whole next request, including the system prompt, tool
 *   schemas, and attachments. This is what the provider bills, and it is the
 *   unit in which a context window overflows.
 */
export type MemoryDenominator = 'surface' | 'total'

/**
 * The pressure band at which the model is invited to drop history it no longer
 * needs. The band is derived from the routed model's context window (a ratio)
 * and/or an absolute token count; an absolute count keeps the band usable on an
 * adapter that declares no window.
 */
export interface MemoryBudgetConfig {
  /** Fraction of the context window that is the decide band; (0, 1]. 0 means "unset" (inherit the 0.30 default). */
  ratio?: number
  /** Absolute decide-band budget in tokens; positive integer. 0 means "unset". */
  tokens?: number
  /** Which measurement is compared against the budget. Default "surface". */
  denominator?: MemoryDenominator
  /** Warn once the band is this fraction consumed; (0, 1]. Default 0.9. */
  warnAt?: number
}

/** Guard rails that keep a model-directed drop from costing more than it frees. */
export interface MemoryLimitsConfig {
  /** A drop must net at least this many tokens to be accepted. Default 2000. */
  minFreedTokens?: number
  /** Queued drop operations allowed per turn. Default 2. */
  maxOpsPerTurn?: number
  /** Token budget for one `inspect` step map. Default 1500. */
  mapTokens?: number
}

/** Protection and archive rules for the drop path. */
export interface MemoryPolicyConfig {
  /**
   * Never let a dropped span take a user message off the surface without its
   * text: every user message inside the span is re-emitted verbatim in the
   * replacement tombstone. Default true.
   */
  protectUserMessages?: boolean
  /** "block" (default) refuses a drop whose archive write failed; "proceed" warns and drops anyway. */
  archiveOnDrop?: 'block' | 'proceed'
  /** Token budget for one `recall` result. Default 1200. */
  recallMaxTokens?: number
}

/** The model-directed memory surface: budget, limits, and drop policy. */
export interface MemoryConfig {
  /** false removes the tool, the advisory nudge, and the deferred drop apply. Default true. */
  enabled?: boolean
  budget?: MemoryBudgetConfig
  limits?: MemoryLimitsConfig
  policy?: MemoryPolicyConfig
}

export interface TriggerConfig {
  /** Combination rule when both limits are set. Defaults to "first". */
  mode?: TriggerMode
  /** Fraction of the routed model context window; (0, 1]. 0 means "no ratio limit". */
  ratio?: number
  /** Absolute token count trigger; positive integer. 0 means "no token limit". */
  tokens?: number
}

export interface RetainConfig {
  /** Kept-verbatim tail as a fraction of the window. Mutually exclusive with tokens. */
  ratio?: number
  /** Kept-verbatim tail in tokens. Mutually exclusive with ratio. 0 means "unset". */
  tokens?: number
}

export interface ArchiveConfig {
  /**
   * Archive root, resolved against the directory of the project that owns the
   * session (not the harness process cwd). Default ".dsh/handoffs", so every
   * project keeps its own archives at <project>/.dsh/handoffs and two projects
   * never share or collide on archive names.
   */
  root?: string
  /**
   * Write a self-contained "<root>/.gitignore" containing "*" so archives never
   * appear in the project's git status. The project's own .gitignore is never
   * modified. Default true.
   */
  gitIgnore?: boolean
  /** "block" (default) aborts compaction when archiving fails; "proceed" warns and continues. */
  onFailure?: 'block' | 'proceed'
}

export interface SummarizationConfig {
  /** Summary provider; set together with model (pair rule like upstream). Empty inherits the routed model. */
  provider?: string
  /** Summary model; set together with provider. Empty inherits the routed model. */
  model?: string
  /** Provider generation cap. Default 8192. */
  maxTokens?: number
}

export interface RetriesConfig {
  /** Extra compaction attempts while pressure remains. Default 1. */
  compactionRetries?: number
  /** Overflow recovery retries. Default 1. */
  maxOverflowRetries?: number
}

/** Per-model override; an exact provider+model match, field-wise over the globals. */
export interface ModelPreset {
  /** Exact provider route to match. */
  provider: string
  /** Exact routed model id to match. */
  model: string
  trigger?: TriggerConfig
  retain?: RetainConfig
  summarization?: SummarizationConfig
  retries?: RetriesConfig
  /** true disables auto-compact for this model; manual compaction is unaffected. */
  disabled?: boolean
}

/** The user-facing document shape (what a preset file or an override holds). */
export interface HandoffConfig {
  trigger?: TriggerConfig
  retain?: RetainConfig
  archive?: ArchiveConfig
  summarization?: SummarizationConfig
  retries?: RetriesConfig
  /** false is the plugin master switch: no pressure compaction and no archiving. Manual and overflow paths still work. */
  enabled?: boolean
  /** Per-model presets; exact provider+model match, field-wise merge over globals. */
  models?: ModelPreset[]
  /** Model-directed memory management (inspect/plan/apply/pin/recall). */
  memory?: MemoryConfig
}

/**
 * The live resolved configuration the engine computes once per call.
 *
 * Every run reads it again, so an edit made in the Settings UI (or in the
 * profile patch) takes effect on the next step without reloading the plugin.
 */
export interface ResolvedHandoffConfig {
  trigger: { mode: TriggerMode; ratio?: number; tokens?: number }
  retain: { ratio?: number; tokens?: number }
  archive: { root: string; gitIgnore: boolean; onFailure: 'block' | 'proceed' }
  summarization: { provider: string; model: string; maxTokens: number }
  retries: { compactionRetries: number; maxOverflowRetries: number }
  enabled: boolean
  models: ModelPreset[]
  memory: {
    enabled: boolean
    /** `ratio` is always present: an unset pair inherits the 0.30 default. */
    budget: { ratio: number; tokens?: number; denominator: MemoryDenominator; warnAt: number }
    limits: { minFreedTokens: number; maxOpsPerTurn: number; mapTokens: number }
    policy: { protectUserMessages: boolean; archiveOnDrop: 'block' | 'proceed'; recallMaxTokens: number }
  }
}
