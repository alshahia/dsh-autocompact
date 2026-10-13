/**
 * dsh-autocompact — configurable auto-compact triggers (percentage and/or
 * absolute tokens), per-model presets, and a handoff archive written on every
 * compaction, stored inside the project that owns the session.
 *
 * It rides the existing engine seam by subclassing `BasicCompactionEngine`:
 * the pressure path of `compactIfNeeded` is replaced with the extended trigger
 * math, context-overflow recovery delegates to the parent unchanged, and
 * `summarize()` wraps the upstream summarizer with archiving plus pointer
 * injection. The parent's engine owns the replayed-region selection, the durable
 * surface mutation, and the overflow-retry listener, so this plugin never
 * re-implements them.
 *
 * Configuration is fully live: every tunable group is a volatile schema node
 * (`src/config.ts`), so the Settings service can rewrite one group while the
 * plugin keeps running. The engine re-reads the groups at the start of every
 * operation, which is why no restart and no reload is needed after an edit.
 *
 * @module dsh-autocompact
 */
import { resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import BasicCompactionEngine from '@deepseek-ai/dsh-compaction-basic'
import type { BasicCompactionConfig } from '@deepseek-ai/dsh-compaction-basic'
import { TargetPressureConfigError, resolveConfig } from '@deepseek-ai/dsh-compaction-basic/src/config.ts'
import { assertNoActiveCompaction, selectCompactableRange } from '@deepseek-ai/dsh-compaction-basic/src/region.ts'
import { summarizeWithLlm } from '@deepseek-ai/dsh-compaction-basic/src/summarizer.ts'
import type { SummarizationInput, SummaryResult } from '@deepseek-ai/dsh-compaction-basic/src/summarizer.ts'
import type { CompactionResult, CompactionTrigger } from '@deepseek-ai/dsh-compaction'
import type { LlmCallConfig } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session } from '@deepseek-ai/dsh-session'
import type { TokenMeasurement } from '@deepseek-ai/dsh-token-meter'
import type { ResolvedConfig } from '@deepseek-ai/dsh-compaction-basic/src/types.ts'
import { LiveConfigReader, autocompactConfig, resolvePreset, toBasicConfig } from './config.ts'
import type { HandoffVolatileConfig } from './config.ts'
import { installGuiBridge } from './gui.ts'
import { MemoryRuntime, installMemoryObserver } from './runtime.ts'
import { StatusBoard } from './status.ts'
import { summarizeWithArchive } from './summarize.ts'
import { installMemoryTool } from './tool.ts'
import { needsWindowFor, resolveHandoffSpec, wouldFire } from './trigger.ts'
import type { ResolvedHandoffConfig } from './types.ts'
import { projectDirOf } from './workspace.ts'

/** Re-implementation of the parent's module-private routed-target helper. */
function routedTarget(session: Session): Pick<LlmCallConfig, 'provider' | 'model'> | undefined {
  const config = session.requestHeader()?.config
  if (config === undefined || config.provider.length === 0 || config.model.length === 0) return undefined
  return { provider: config.provider, model: config.model }
}

/** One pressure preview, as reported by `previewPressure`. */
export interface PressurePreview {
  measuredTokens: number
  thresholdTokens: number
  thresholdSource: string
  disabled: boolean
  presetMatched: boolean
  wouldFire: boolean
  retainClamped: boolean
  pluginEnabled: boolean
  /** Absolute archive root this session would write into. */
  archiveRoot: string
  /** Project directory that owns this session. */
  projectDir: string
}

export class AutocompactEngine extends BasicCompactionEngine {
  static inject = ['llm', 'tokenMeter', 'sessions']

  /**
   * The live, GUI-tunable configuration. Every tunable group is volatile, so the
   * Settings service can rewrite one group while the plugin keeps running; the
   * engine reads the groups again at the start of every operation.
   *
   * The parent declares `Config: z<BasicCompactionConfig>` and schemastery has no
   * schema concatenation, so the two shapes cannot be composed and the static
   * side is pinned by a cast (schemastery's `Schema<T>.meta.default` is
   * contravariant, which otherwise makes the class static side incompatible with
   * the parent's, TS2417). The runtime schema is `autocompactConfig`; the parent
   * never reads it, because the constructor hands the parent a projected
   * `BasicCompactionConfig` instead.
   */
  static Config: z<BasicCompactionConfig> = autocompactConfig as unknown as z<BasicCompactionConfig>

  /** Live progress board the GUI status route reads. */
  readonly status = new StatusBoard()

  private readonly raw: HandoffVolatileConfig
  private readonly reader: LiveConfigReader
  /** Live values, re-read per operation; see `refresh()`. */
  private live: ResolvedHandoffConfig
  private readonly fallbackDir: string
  /** Warn-once keys for retain clamps: target@threshold:retain. */
  private readonly clampedRetainWarned = new Set<string>()
  /**
   * Model-directed memory: the session_memory tool, the pins it honors, and the
   * queued drop that lands at the next step boundary.
   *
   * The runtime owns no service the engine does not already inject, so the
   * engine's `inject` list is unchanged: an absent tool registry or web server
   * only disables the corresponding lever.
   */
  readonly memory: MemoryRuntime

  constructor(ctx: Context, config: HandoffVolatileConfig = {} as HandoffVolatileConfig) {
    const reader = new LiveConfigReader(message => ctx.logger.warn(message))
    const live = reader.read(config)
    // The parent validates and freezes its own projection; it never sees the
    // volatile groups, only the plain values derived from them.
    super(ctx, toBasicConfig(live) as BasicCompactionConfig)
    this.raw = config
    this.reader = reader
    this.live = live
    this.fallbackDir = process.cwd()
    this.memory = new MemoryRuntime({ ctx, config: () => this.refresh(), fallbackDir: this.fallbackDir })
    // Each seam is optional: a composition without a tool registry, without a
    // web server, or without a config editor keeps compacting and archiving.
    installMemoryTool(ctx, this.memory)
    installMemoryObserver(ctx, this.memory)
    installGuiBridge(ctx, this)
  }

  /** The raw configuration document the user wrote, as the GUI reports it. */
  get rawConfig(): HandoffVolatileConfig {
    return this.raw
  }

  /**
   * Per-session pressure picture for the GUI status route.
   *
   * Unlike `previewPressure` this resolves a context window when a ratio is in
   * play, and it never throws for an unresolvable window: a missing capacity is
   * reported as an absent threshold instead of a hard error.
   */
  async describeSession(agent: Agent, signal: AbortSignal): Promise<Record<string, unknown>> {
    const config = this.refresh()
    const sessionId = String(agent.session.id)
    const measuredTokens = this.ctx.tokenMeter.measure(agent.session).totalTokens
    const projectDir = projectDirOf(agent, this.fallbackDir)
    const archiveRoot = resolveProjectArchiveRoot(projectDir, config.archive.root)
    const target = routedTarget(agent.session)
    const base = { sessionId, measuredTokens, projectDir, archiveRoot, target: null as string | null }
    if (target === undefined) {
      return {
        ...base, thresholdTokens: null, thresholdSource: 'unrouted', disabled: false,
        presetMatched: false, wouldFire: false, retainClamped: false,
      }
    }
    const preset = resolvePreset(config, target)
    let contextWindow: number | undefined
    if (needsWindowFor(config, preset)) {
      try {
        contextWindow = (await this.ctx.llm.resolveModelInfo(target.provider, target.model, signal)).context?.contextWindow
      } catch {
        contextWindow = undefined
      }
    }
    const spec = resolveHandoffSpec(config, preset, contextWindow)
    return {
      ...base,
      target: target.provider + '/' + target.model,
      thresholdTokens: Number.isFinite(spec.thresholdTokens) ? spec.thresholdTokens : null,
      thresholdSource: spec.thresholdSource,
      disabled: spec.disabled,
      presetMatched: preset !== undefined,
      wouldFire: wouldFire(spec, measuredTokens),
      retainClamped: spec.retainClamped,
    }
  }

  /** The live resolved configuration, re-read on every access. */
  get handoffConfig(): ResolvedHandoffConfig {
    return this.refresh()
  }

  /**
   * Re-read the volatile groups and re-project them onto the parent's config.
   * Never throws: reading a half-edited form is a supported state, and the
   * trigger math clamps what the parent's stricter validator would reject.
   *
   * Every path that reaches the parent's own `config` field runs through this
   * first — `compactIfNeeded` before it delegates or decides, and `summarize`
   * before the manual compaction path uses it — so a live edit needs no
   * `loader/volatile-update` listener.
   */
  private refresh(): ResolvedHandoffConfig {
    const live = this.reader.read(this.raw)
    this.live = live
    try {
      (this as unknown as { config: ResolvedConfig }).config = resolveConfig(toBasicConfig(live))
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error)
      this.ctx.logger.warn('dsh-autocompact: the base engine cannot use this configuration ('
        + message + '); its overflow policy keeps the previous values while the trigger math follows the edit')
    }
    return live
  }

  /** Pressure preview for the settings card, tests, and diagnostics (always current). */
  previewPressure(agent: Agent, contextWindow?: number): PressurePreview {
    const config = this.refresh()
    const target = routedTarget(agent.session)
    const measured = this.ctx.tokenMeter.measure(agent.session).totalTokens
    const projectDir = projectDirOf(agent, this.fallbackDir)
    const archiveRoot = resolveProjectArchiveRoot(projectDir, config.archive.root)
    if (target === undefined) {
      return {
        measuredTokens: measured, thresholdTokens: Number.POSITIVE_INFINITY,
        thresholdSource: 'unrouted', disabled: false, presetMatched: false, wouldFire: false,
        retainClamped: false, pluginEnabled: config.enabled, archiveRoot, projectDir,
      }
    }
    const preset = resolvePreset(config, target)
    const spec = resolveHandoffSpec(config, preset, contextWindow)
    return {
      measuredTokens: measured,
      thresholdTokens: spec.thresholdTokens,
      thresholdSource: spec.thresholdSource,
      disabled: spec.disabled,
      presetMatched: preset !== undefined,
      wouldFire: wouldFire(spec, measured),
      retainClamped: spec.retainClamped,
      pluginEnabled: config.enabled,
      archiveRoot,
      projectDir,
    }
  }

  override async compactIfNeeded(
    agent: Agent,
    trigger: CompactionTrigger,
    signal: AbortSignal,
  ): Promise<CompactionResult | null> {
    // Configuration can change between steps, so every decision reads it now.
    const config = this.refresh()
    // Overflow recovery is the session-safety path: it keeps the parent's
    // semantics (ignore the threshold, force one balanced reduction).
    if (trigger === 'context-overflow') return super.compactIfNeeded(agent, trigger, signal)
    // Master switch: disabled means no pressure compaction and no archive.
    if (!config.enabled) return null
    const target = routedTarget(agent.session)
    if (target === undefined) return null
    const preset = resolvePreset(config, target)
    if (preset?.disabled === true) return null

    // Offer the model the choice before the engine makes it: this nudge rides
    // the same per-step seam, but deliberately below the compaction threshold,
    // so a model-directed drop can free room the engine would otherwise take.
    await this.memory.advisory(agent, signal, this.ctx.tokenMeter.measure(agent.session))

    const meter = this.ctx.tokenMeter
    let measurement: TokenMeasurement = meter.measure(agent.session)
    const prune = this.ctx.get('toolResultPruner')

    // Resolve capacity only when a ratio-based field is in play.
    const windowed = needsWindowFor(config, preset)
    let contextWindow: number | undefined
    if (windowed) {
      const context = (await this.ctx.llm.resolveModelInfo(target.provider, target.model, signal)).context
      assertNoActiveCompaction(agent.session, 'automatic pressure compaction')
      if (context === undefined) {
        throw new TargetPressureConfigError(
          target.provider + '/' + target.model,
          'dsh-autocompact: no context capacity for ' + target.provider + '/' + target.model
          + '; configure contextWindow on that adapter model',
        )
      }
      contextWindow = context.contextWindow
    } else {
      assertNoActiveCompaction(agent.session, 'automatic pressure compaction')
    }
    const spec = resolveHandoffSpec(config, preset, contextWindow)
    if (spec.retainClamped) {
      const key = target.provider + '/' + target.model + '@' + spec.thresholdTokens + ':' + spec.retainTokens
      if (!this.clampedRetainWarned.has(key)) {
        this.clampedRetainWarned.add(key)
        this.ctx.logger.warn(
          'dsh-autocompact: retain exceeds the trigger for ' + target.provider + '/' + target.model
          + '; clamped the kept tail to ' + spec.retainTokens + ' of ' + spec.thresholdTokens + ' trigger tokens'
          + ' (lower retain.ratio/tokens for the full budget)',
        )
      }
    }
    if (measurement.totalTokens < spec.thresholdTokens) return null

    // Once pressure qualifies, land the model-free pass before choosing a
    // summary range, then remeasure (mirrors the parent).
    if (prune !== undefined) {
      prune.pruneSession(agent.session)
      measurement = meter.measure(agent.session)
    }
    if (measurement.totalTokens < spec.thresholdTokens) return null

    let result: CompactionResult | null = null
    for (let attempt = 0; attempt <= spec.compactionRetries; attempt += 1) {
      const range = selectCompactableRange(agent.session, measurement, spec.retainTokens)
      if (range === null) {
        if (result === null) return null
        break
      }
      result = await this.compactRegion(range.start, range.end, agent, signal)
      // The parent throws when the measurement is stale; re-measure explicitly
      // so every attempt selects from a fresh surface.
      measurement = meter.measure(agent.session)
      if (measurement.totalTokens < spec.thresholdTokens) return result
    }

    throw new Error(
      'dsh-autocompact: compaction still above threshold after ' + (spec.compactionRetries + 1)
      + ' compaction attempts (' + measurement.totalTokens + ' estimated tokens >= threshold '
      + spec.thresholdTokens + ')',
    )
  }

  protected override async summarize(
    input: SummarizationInput,
    agent: Agent,
    signal?: AbortSignal,
  ): Promise<SummaryResult> {
    const config = this.refresh()
    if (!config.enabled) return super.summarize(input, agent, signal)
    const routed = routedTarget(agent.session)
    const target = routed
      ?? (agent.options.provider !== undefined && agent.options.provider.length > 0
        && agent.options.model !== undefined && agent.options.model.length > 0
        ? { provider: agent.options.provider, model: agent.options.model }
        : undefined)
    const model = target === undefined ? 'unknown' : target.provider + '/' + target.model
    // Every compaction path funnels through here (automatic pressure, manual
    // `/compact`, and overflow recovery), so this is the one place the GUI
    // indicator learns that work started and finished.
    const sessionId = String(agent.session.id)
    this.status.begin(sessionId, 'summarizing', model + ' · ' + input.messages.length + ' messages')
    let archived: string | undefined
    try {
      const result = await summarizeWithArchive({
        ctx: this.ctx,
        config,
        summarizer: summarizeWithLlm,
        spanTokens: () => this.spanTokensOf(input),
        routedModel: model,
        projectDir: projectDirOf(agent, this.fallbackDir),
        onArchived: (pointer: string) => {
          archived = pointer
          this.status.phase(sessionId, 'writing archive', pointer)
        },
      }, input, agent, signal)
      this.status.finish(sessionId, true, archived === undefined ? 'archived' : 'archived to ' + archived)
      return result
    } catch (error: unknown) {
      this.status.finish(sessionId, false, error instanceof Error ? error.message : String(error))
      throw error
    }
  }

  /**
   * Price the condensed span for the archive header.
   *
   * The span is priced from the replayed input itself, so the value is available
   * on every path that summarizes (automatic pressure and manual compaction
   * alike) without remembering a range or hooking `compactNow`.
   */
  private spanTokensOf(input: SummarizationInput): number {
    try {
      let total = 0
      for (const message of input.messages) total += this.ctx.tokenMeter.estimateMessage(message)
      return total
    } catch {
      return estimateTokens(input)
    }
  }
}

/** Absolute archive root for one project and one configured root. */
function resolveProjectArchiveRoot(projectDir: string, root: string): string {
  return resolve(projectDir, root)
}

/**
 * Character-heuristic fallback used only when the token meter cannot price a
 * message; the meter's own estimator is preferred everywhere else.
 */
function estimateTokens(input: SummarizationInput): number {
  let chars = 0
  for (const message of input.messages) {
    for (const block of message.content) {
      if (block.type === 'text') chars += block.text.length
    }
  }
  return Math.ceil(chars / 4)
}

export default AutocompactEngine
