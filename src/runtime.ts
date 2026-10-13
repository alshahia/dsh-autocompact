/**
 * The stateful half of model-directed memory: per-session pins, the queued drop,
 * the pressure advisory, and the boundary flush that lands a queued drop.
 *
 * Three seams define the lifecycle.
 *
 * - **The tool call** ({@link MemoryRuntime.plan}) does everything asynchronous —
 *   measure, plan, and write the archive — while the turn is being driven. That
 *   is the only point where an `await` is legal for this feature.
 * - **The per-step pressure seam** ({@link MemoryRuntime.advisory}) tells the
 *   model that room is running out, below the engine's own compaction threshold,
 *   so a drop is a choice rather than a post-mortem.
 * - **`step/start`** ({@link MemoryRuntime.flushAtBoundary}) is where the queued
 *   replacement actually lands: the previous request is finished, the next one
 *   has not been built, and the whole mutation is synchronous, so nothing the
 *   loop is holding can go stale underneath it.
 *
 * Every public method is total: it returns a message a model can act on rather
 * than throwing, because a memory-management tool that breaks a turn is worse
 * than one that refuses.
 *
 * @module dsh-autocompact/runtime
 */
import { resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { boundContextSummary, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Session, SessionSeq } from '@deepseek-ai/dsh-session'
import type { TokenMeasurement } from '@deepseek-ai/dsh-token-meter'
import { selectCompactableRange } from '@deepseek-ai/dsh-compaction-basic/src/region.ts'
import type { LlmCallConfig } from '@deepseek-ai/dsh-llm'
import { buildMap, parseSelection, parseSeqList, planDrop, renderMap, renderTombstone, resolveBudget, retainTokensFor, stepMarkers } from './memory.ts'
import type { BudgetPicture, DropPlan, SurfaceMap } from './memory.ts'
import { archiveDrop, commitDrop, recallArchive, spanIsCommittable } from './drop.ts'
import { projectDirOf } from './workspace.ts'
import type { ResolvedHandoffConfig } from './types.ts'

/** What the runtime needs from the engine that owns it. */
export interface MemoryDeps {
  readonly ctx: Context
  /** The live resolved configuration; re-read on every call. */
  readonly config: () => ResolvedHandoffConfig
  /** Working directory used when the session has no project of its own. */
  readonly fallbackDir: string
}

/** A drop that has been archived and is waiting for the next step boundary. */
export interface PendingDrop {
  readonly plan: DropPlan
  readonly tombstone: string
  readonly tombstoneTokens: number
  readonly freedTokens: number
  readonly archiveDir: string
  readonly steps: readonly string[]
}

/** Per-session memory state. Pins and tombstones are seq sets, not projections. */
export interface MemorySessionState {
  /** Turn the per-turn operation budget counts against. */
  turn: number | null
  opsThisTurn: number
  readonly pins: Set<number>
  readonly tombstones: Set<number>
  pending: PendingDrop | null
  /** The advisory was delivered for the current pressure episode. */
  nudged: boolean
  lastDrop: string | undefined
  window: number | undefined
  windowRoute: string | undefined
  windowFailureTurn: number | null
}

/** The routed provider/model of a session, when it has one. */
function routedTarget(session: Session): Pick<LlmCallConfig, 'provider' | 'model'> | undefined {
  const config = session.requestHeader()?.config
  if (config === undefined || config.provider.length === 0 || config.model.length === 0) return undefined
  return { provider: config.provider, model: config.model }
}

/** This plugin's message source, as a bounded `notice`. */
function memorySource(summary: string): { kind: 'dsh-autocompact'; form: 'notice'; summary: string } {
  return { kind: 'dsh-autocompact', form: 'notice', summary: boundContextSummary(summary) }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export class MemoryRuntime {
  private readonly states = new Map<string, MemorySessionState>()

  constructor(private readonly deps: MemoryDeps) {}

  /** The live state for one session, created on first use. */
  state(session: Session): MemorySessionState {
    const key = String(session.id)
    let state = this.states.get(key)
    if (state === undefined) {
      state = {
        turn: null,
        opsThisTurn: 0,
        pins: new Set<number>(),
        tombstones: new Set<number>(),
        pending: null,
        nudged: false,
        lastDrop: undefined,
        window: undefined,
        windowRoute: undefined,
        windowFailureTurn: null,
      }
      this.states.set(key, state)
    }
    return state
  }

  /** Price a would-be message the way the surface is priced. */
  private readonly priceText = (text: string): number => {
    try {
      const message = createUserMessage({ content: [{ type: 'text', text }], source: memorySource('price probe') })
      return this.deps.ctx.tokenMeter.estimateMessage(message)
    } catch {
      return Math.ceil(text.length / 4)
    }
  }

  /**
   * The routed context window, cached per route.
   *
   * A successful resolution is remembered for the session. A failure is
   * remembered only for the current turn, so one aborted lookup cannot mute the
   * advisory (or the decide band) for the rest of the session.
   */
  private async windowFor(agent: Agent, state: MemorySessionState, signal: AbortSignal | undefined): Promise<number | undefined> {
    const target = routedTarget(agent.session)
    const key = target === undefined ? 'unrouted' : target.provider + '/' + target.model
    if (state.windowRoute === key && (state.window !== undefined || state.windowFailureTurn === state.turn)) return state.window
    state.windowRoute = key
    state.window = undefined
    state.windowFailureTurn = null
    if (target === undefined) return undefined
    try {
      state.window = (await this.deps.ctx.llm.resolveModelInfo(target.provider, target.model, signal)).context?.contextWindow
    } catch (error: unknown) {
      state.windowFailureTurn = state.turn
      this.deps.ctx.logger.warn('dsh-autocompact: could not resolve the context window for '
        + target.provider + '/' + target.model + ' (' + messageOf(error) + '); memory drops use absolute budgets only')
      return undefined
    }
    if (state.window === undefined) state.windowFailureTurn = state.turn
    return state.window
  }

  /** The archive root and session key for one agent. */
  private archiveTarget(agent: Agent, config: ResolvedHandoffConfig): { root: string; sessionId: string } {
    const projectDir = projectDirOf(agent, this.deps.fallbackDir)
    return { root: resolve(projectDir, config.archive.root), sessionId: String(agent.session.id) }
  }

  /** The decide band, the droppable head, and the surface map for one moment. */
  private pictureFor(args: {
    readonly session: Session
    readonly measurement: TokenMeasurement
    readonly config: ResolvedHandoffConfig
    readonly state: MemorySessionState
    readonly window: number | undefined
  }): { map: SurfaceMap; picture: BudgetPicture; retainTokens: number } {
    const picture = resolveBudget(args.config.memory.budget, args.measurement, args.window)
    const retainTokens = retainTokensFor(args.config, args.window, picture.budgetTokens)
    let droppableEnd: SessionSeq | null = null
    let droppableReason = 'the whole surface fits inside the ' + retainTokens + '-token retained tail'
    try {
      const range = selectCompactableRange(args.session, args.measurement, retainTokens)
      if (range !== null) {
        droppableEnd = range.end
        droppableReason = 'a ' + retainTokens + '-token retained tail'
      }
    } catch (error: unknown) {
      droppableReason = 'the token meter could not select a range (' + messageOf(error) + ')'
    }
    const map = buildMap({
      session: args.session,
      measurement: args.measurement,
      pins: args.state.pins,
      tombstones: args.state.tombstones,
      droppableEnd,
      droppableReason,
    })
    return { map, picture, retainTokens }
  }

  /** The turn the session is in, from its own step markers. */
  private turnOf(session: Session): number | null {
    const markers = stepMarkers(session)
    return markers[markers.length - 1]?.turn ?? null
  }

  /** `inspect`: the pressure picture and the bounded surface map. */
  async inspect(agent: Agent, detail: string): Promise<string> {
    const config = this.deps.config()
    const state = this.state(agent.session)
    const measurement = this.deps.ctx.tokenMeter.measure(agent.session)
    const window = await this.windowFor(agent, state, undefined)
    const { map, picture } = this.pictureFor({ session: agent.session, measurement, config, state, window })
    const text = renderMap({
      map,
      picture,
      pins: state.pins,
      mapTokens: config.memory.limits.mapTokens,
      lastDrop: state.lastDrop,
    })
    const extra: string[] = []
    if (!config.memory.enabled) extra.push('note: session memory is off in this profile (memory.enabled=false); nothing will be dropped')
    if (state.pending !== null) extra.push('queued: steps ' + state.pending.steps.join(', ') + ' are dropped at the next step boundary')
    if (state.pins.size > 0) extra.push('pins: ' + [...state.pins].sort((a, b) => a - b).join(', '))
    if (detail === 'full') {
      extra.push('', 'every surface node:')
      for (const entry of map.entries) {
        extra.push('  seq ' + entry.seq + '  ' + entry.role + (entry.pinned ? ' [pinned]' : '')
          + (entry.droppable ? '' : ' [retained]') + '  ~' + entry.tokens + '  ' + entry.preview)
      }
    }
    extra.push('', 'actions: {"action":"inspect"} | {"action":"plan","steps":"3-5"} | {"action":"apply","steps":"3-5"}'
      + ' | {"action":"pin","seqs":"12,13"} | {"action":"recall","query":"text"}')
    return [text, ...extra].join('\n')
  }

  /**
   * `plan` (dry run) and `apply`.
   *
   * `apply` archives the span while the tool call owns the turn, then queues the
   * replacement. The queue is landed by {@link flushAtBoundary} at the next
   * `step/start`; the tool never mutates the surface itself.
   */
  async plan(agent: Agent, stepsText: string, apply: boolean): Promise<string> {
    const config = this.deps.config()
    const session = agent.session
    const state = this.state(session)
    if (!config.memory.enabled) {
      return 'refused: session memory is off in this profile (memory.enabled=false)'
    }
    const { selectors, invalid } = parseSelection(stepsText)
    if (invalid.length > 0) {
      return 'refused: could not read "' + stepsText + '" (unreadable: ' + invalid.join(', ') + ');'
        + ' write steps as "3" (a turn), "3.1" (one step), or "1-3" (turns 1 to 3)'
    }
    if (selectors.length === 0) return 'refused: no steps were selected; call inspect first'
    let plan: DropPlan
    let picture: BudgetPicture
    try {
      const measurement = this.deps.ctx.tokenMeter.measure(session)
      const window = await this.windowFor(agent, state, undefined)
      const drawn = this.pictureFor({ session, measurement, config, state, window })
      const map = drawn.map
      picture = drawn.picture
      const target = this.archiveTarget(agent, config)
      const placeholder = resolve(target.root, target.sessionId) + '/<next-archive>/'
      plan = planDrop({ session, map, selectors, config: config.memory, priceText: this.priceText, pointer: placeholder })
    } catch (error: unknown) {
      return 'refused: could not plan against this surface (' + messageOf(error) + ')'
    }
    const border = plan.steps.length > 0 ? plan.steps.join(', ') : stepsText.trim()
    const lines = [
      'plan: drop steps ' + border + ' (' + plan.shadowedSeqs.length + ' surface node(s), ~' + plan.shadowedRouteTokens
        + ' request tokens) -> one ~' + plan.tombstoneTokens + '-token tombstone; net freed ~' + plan.freedTokens
        + ' tokens (pressure ' + picture.band + ')',
      ...plan.outline.map(line => '  - ' + line),
    ]
    if (plan.protectedText.length > 0) {
      lines.push('  protected: ' + plan.protectedText.length + ' user message(s) are re-emitted verbatim in the tombstone')
    }
    if (!plan.ok) {
      lines.push('refused:', ...plan.blockers.map(blocker => '  - ' + blocker))
      return lines.join('\n')
    }
    if (!apply) {
      lines.push('dry run: nothing changed. Apply with {"action":"apply","steps":"' + plan.steps.join(',') + '"}')
      return lines.join('\n')
    }
    if (state.pending !== null) {
      return 'refused: steps ' + state.pending.steps.join(', ') + ' are already queued for the next step boundary'
    }
    const turn = this.turnOf(session)
    if (state.turn !== turn) {
      state.turn = turn
      state.opsThisTurn = 0
    }
    if (state.opsThisTurn >= config.memory.limits.maxOpsPerTurn) {
      return 'refused: this turn already dropped history ' + state.opsThisTurn + ' time(s), the configured limit;'
        + ' drop more in a later turn or raise memory.limits.maxOpsPerTurn'
    }
    const target = this.archiveTarget(agent, config)
    const routed = routedTarget(session)
    const routedModel = routed === undefined ? 'unknown' : routed.provider + '/' + routed.model
    let archiveDir: string
    let archiveFailed: string | undefined
    try {
      const written = await archiveDrop({
        session,
        plan,
        root: target.root,
        sessionId: target.sessionId,
        timestamp: new Date(),
        routedModel,
        gitIgnore: config.archive.gitIgnore,
      })
      archiveDir = written.dirAbs
    } catch (error: unknown) {
      archiveFailed = messageOf(error)
      if (config.memory.policy.archiveOnDrop === 'block') {
        return 'refused: the dropped span could not be archived (' + archiveFailed + ');'
          + ' memory.policy.archiveOnDrop="block" keeps the history in place'
      }
      this.deps.ctx.logger.warn('dsh-autocompact: dropping history without an archive: ' + archiveFailed)
      archiveDir = '(archive write failed: ' + archiveFailed + ')'
    }
    const pointer = archiveFailed === undefined ? archiveDir : '(archive unavailable)'
    const tombstone = renderTombstone({
      spans: plan.spans,
      protectedText: plan.protectedText,
      outline: plan.outline,
      pointer,
    })
    const tombstoneTokens = this.priceText(tombstone)
    const freedTokens = plan.shadowedHeuristicTokens - tombstoneTokens
    if (freedTokens < config.memory.limits.minFreedTokens) {
      return 'refused after archiving (' + archiveDir + '): the exact tombstone leaves ~' + freedTokens
        + ' tokens freed, below the ' + config.memory.limits.minFreedTokens + '-token floor; select more finished steps'
    }
    state.pending = { plan, tombstone, tombstoneTokens, freedTokens, archiveDir, steps: plan.steps }
    return 'queued: steps ' + plan.steps.join(', ') + ' (' + plan.shadowedSeqs.length + ' surface node(s)) are replaced by one'
      + ' ~' + tombstoneTokens + '-token tombstone at the next step boundary; net freed ~' + freedTokens + ' tokens.'
      + ' Archived at ' + archiveDir + '. Nothing was deleted.'
  }

  /** `pin` / unpin: protect surface seqs from every future drop. */
  pin(agent: Agent, seqsText: string, off: boolean): string {
    const session = agent.session
    const state = this.state(session)
    const { seqs, invalid } = parseSeqList(seqsText)
    if (invalid.length > 0) return 'refused: could not read seqs "' + seqsText + '" (unreadable: ' + invalid.join(', ') + ')'
    if (seqs.length === 0) return 'refused: no seqs were selected'
    const present = new Set(session.surface.nodes.map(seq => Number(seq)))
    const missing = seqs.filter(seq => !present.has(seq))
    for (const seq of seqs) {
      if (!present.has(seq)) continue
      if (off) state.pins.delete(seq)
      else state.pins.add(seq)
    }
    const updated = seqs.filter(seq => present.has(seq))
    const lines = [
      (off ? 'unpinned ' : 'pinned ') + (updated.length === 0 ? 'nothing' : updated.join(', '))
        + (missing.length === 0 ? '' : '; not on the surface: ' + missing.join(', ')),
      'pins: ' + (state.pins.size === 0 ? 'none' : [...state.pins].sort((a, b) => a - b).join(', ')),
      'A pinned node is never inside a drop, and the nearest balanced boundary around it is kept with it.'
        + ' Pins live for as long as this plugin instance does, not across a harness restart.',
    ]
    return lines.join('\n')
  }

  /** `recall`: search this session's archives without re-reading them into context. */
  recall(agent: Agent, query: string): string {
    const config = this.deps.config()
    const target = this.archiveTarget(agent, config)
    const trimmed = query.trim()
    if (trimmed === '') return 'refused: recall needs a query'
    const result = recallArchive({
      root: target.root,
      sessionId: target.sessionId,
      query: trimmed,
      maxTokens: config.memory.policy.recallMaxTokens,
    })
    const dir = resolve(target.root, target.sessionId)
    if (result.hits.length === 0) {
      return 'recall "' + trimmed + '": no match in ' + result.scanned.length + ' archive file(s) under ' + dir
        + (result.truncated ? ' (the search hit its budget)' : '')
    }
    const files = new Set(result.hits.map(hit => hit.path))
    const lines = ['recall "' + trimmed + '": ' + result.hits.length + ' hit(s) in ' + files.size + ' file(s) under ' + dir]
    for (const hit of result.hits) {
      lines.push('  - ' + hit.path + ':' + hit.line)
      for (const line of hit.text.split('\n')) lines.push('    ' + line)
    }
    if (result.truncated) lines.push('  (more may exist; narrow the query)')
    return lines.join('\n')
  }

  /**
   * Land a queued drop at a `step/start` boundary.
   *
   * Synchronous and total: this runs inside the session's own event dispatch, so
   * it must not await, and it must not throw into the loop. A plan that no longer
   * matches the surface — the engine compacted it, the user edited the
   * conversation — is discarded with a warning rather than forced.
   */
  flushAtBoundary(session: Session, turn: number, step: number): void {
    const state = this.states.get(String(session.id))
    if (state === undefined || state.pending === null) return
    const pending = state.pending
    if (state.turn !== turn) {
      state.turn = turn
      state.opsThisTurn = 0
    }
    try {
      const problem = spanIsCommittable(session, pending.plan)
      if (problem !== null) {
        state.pending = null
        state.lastDrop = 'refused at the step boundary: ' + problem
        this.deps.ctx.logger.warn('dsh-autocompact: the queued memory drop was refused at the step boundary: ' + problem)
        return
      }
      const commit = commitDrop({ session, plan: pending.plan, tombstone: pending.tombstone, turn })
      state.tombstones.add(commit.tombstoneSeq)
      state.opsThisTurn += 1
      state.nudged = false
      state.pending = null
      state.lastDrop = 'dropped steps ' + pending.steps.join(', ') + ' at step ' + step + '; freed ~' + commit.freedTokens
        + ' tokens; archived at ' + pending.archiveDir
      this.deps.ctx.logger.info('dsh-autocompact: ' + state.lastDrop)
    } catch (error: unknown) {
      state.pending = null
      state.lastDrop = 'failed at the step boundary: ' + messageOf(error)
      this.deps.ctx.logger.warn('dsh-autocompact: the queued memory drop failed at the step boundary: ' + messageOf(error))
    }
  }

  /**
   * The advisory nudge, offered once per pressure episode.
   *
   * It rides the engine's per-step pressure seam, which is also how it can fire
   * *below* the compaction threshold: by the time the engine's own trigger fires,
   * the choice has already been made for the model. Silent when nothing is
   * droppable, so the model is never told to do something impossible.
   */
  async advisory(agent: Agent, signal: AbortSignal, measurement: TokenMeasurement): Promise<void> {
    try {
      const config = this.deps.config()
      if (!config.memory.enabled) return
      const state = this.state(agent.session)
      if (state.pending !== null) return
      const window = await this.windowFor(agent, state, signal)
      const picture = resolveBudget(config.memory.budget, measurement, window)
      if (picture.band !== 'warn' && picture.band !== 'at-limit') {
        state.nudged = false
        return
      }
      if (state.nudged) return
      let droppable = false
      try {
        droppable = selectCompactableRange(agent.session, measurement, retainTokensFor(config, window, picture.budgetTokens)) !== null
      } catch {
        droppable = false
      }
      if (!droppable) {
        state.nudged = true
        return
      }
      state.nudged = true
      const percent = picture.budgetTokens === null ? null : Math.round((picture.usedTokens / picture.budgetTokens) * 100)
      const text = '[dsh-autocompact] Context pressure: ' + picture.usedTokens + ' of ' + picture.budgetTokens
        + ' budget tokens' + (percent === null ? '' : ' (' + percent + '%)') + ', '
        + (picture.headroomTokens ?? 0) + ' left. If some finished steps are no longer needed, call session_memory with'
        + ' {"action":"inspect"} and then {"action":"plan","steps":"a-b"}: applying a drop archives those steps and frees room now.'
        + ' Otherwise the engine compacts the oldest steps on its own when the trigger fires.'
      agent.inject(createUserMessage({ content: [{ type: 'text', text }], source: memorySource('context pressure advisory') }))
    } catch (error: unknown) {
      this.deps.ctx.logger.warn('dsh-autocompact: could not deliver the memory advisory (' + messageOf(error) + ')')
    }
  }
}

/**
 * Watch the session log for step boundaries and land queued drops.
 *
 * `session/event` listeners run synchronously inside `append`, which is exactly
 * what makes a surface replacement safe here: `step/start` is appended before
 * the loop assembles the next request, so the replacement is part of that
 * request's surface and nothing the loop holds has been invalidated.
 */
export function installMemoryObserver(ctx: Context, runtime: MemoryRuntime): void {
  try {
    ctx.effect(() => {
      const dispose = ctx.on('session/event', (session, event) => {
        if (event.type !== 'step/start') return
        try {
          runtime.flushAtBoundary(session, event.data.turn, event.data.step)
        } catch (error: unknown) {
          ctx.logger.warn('dsh-autocompact: the memory drop observer failed (' + messageOf(error) + ')')
        }
      })
      return () => {
        if (typeof dispose === 'function') dispose()
      }
    })
  } catch (error: unknown) {
    ctx.logger.warn('dsh-autocompact: could not install the memory drop observer (' + messageOf(error) + ')')
  }
}
