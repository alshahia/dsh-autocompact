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

/** How a ratio limit and an absolute token limit combine when both are set. */
export type TriggerMode = 'first' | 'tokens'

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
}
