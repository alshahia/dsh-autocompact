/**
 * Model-directed memory: the pressure band, the bounded surface map, and
 * model-free drop planning.
 *
 * Three rules hold everywhere in this module.
 *
 * 1. **A drop is a replacement, never a deletion.** The session surface has no
 *    delete operation ({@link SurfaceOp} is \`append\` or \`replace\`), so dropping
 *    history replaces the selected span with one small tombstone that cites
 *    every shadowed node. Nothing leaves the log, and nothing leaves disk.
 * 2. **User messages are load-bearing.** With
 *    \`policy.protectUserMessages\` (the default), a span that contains user
 *    messages re-emits their text verbatim inside the tombstone, so the requests
 *    that started the work stay model-visible after the bulk is gone.
 * 3. **Only what the engine would itself compact is droppable.** The retained
 *    tail is the same \`selectCompactableRange\` cut the pressure path uses, so
 *    the model can never drop something the engine considers current.
 *
 * This module is pure: no filesystem, no context, no session mutation. The
 * runtime that owns state lives in \`src/runtime.ts\` and the durable transaction
 * in \`src/drop.ts\`.
 *
 * @module dsh-autocompact/memory
 */
import { SessionSeq } from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import type { TokenMeasurement } from '@deepseek-ai/dsh-token-meter'
import type { Message } from '@deepseek-ai/dsh-llm'
import { toolPairingBalancedAfter, toolPairingBalancedBefore } from '@deepseek-ai/dsh-compaction'
import type { MemoryDenominator, ResolvedHandoffConfig } from './types.ts'

/** How much of the memory budget is spent. \`unknown\` means no capacity could be resolved. */
export type MemoryBand = 'ok' | 'warn' | 'at-limit' | 'unknown'

/** Characters of one message preview kept in the surface map. */
export const PREVIEW_CHARS = 120
/** Characters of one protected user message kept verbatim in a tombstone. */
export const PROTECTED_TEXT_CHARS = 6000
/** Largest step number a selection may name, so a typo cannot loop forever. */
const MAX_SELECTED_STEPS = 512

/** The pressure picture the decide band reports. */
export interface BudgetPicture {
  readonly band: MemoryBand
  /** The measurement the band compared (\`surface\` or \`total\`, per the denominator). */
  readonly usedTokens: number
  readonly surfaceTokens: number
  readonly totalTokens: number
  /** Band budget in tokens, or null when no capacity could be resolved. */
  readonly budgetTokens: number | null
  readonly budgetSource: 'tokens' | 'ratio' | 'ratio+tokens' | 'unresolved'
  /** \`warnAt\` \u00d7 budget: the advisory line. */
  readonly warnTokens: number | null
  /** Tokens left before the band, or null when the budget is unresolved. */
  readonly headroomTokens: number | null
  readonly contextWindow: number | null
  readonly denominator: MemoryDenominator
  /** Tokens left before the whole routed request overflows, when the window is known. */
  readonly wallHeadroomTokens: number | null
}

/**
 * Resolve the decide band.
 *
 * The band compares the chosen denominator against a budget derived from the
 * routed model's context window (\`ratio\`) and/or an absolute token count. When
 * both are configured the smaller wins, mirroring the trigger's \`first\`
 * semantics: the band fires as soon as either limit is reached. An absolute
 * limit therefore keeps the feature usable on an adapter that declares no
 * context window, and the band reports \`unknown\` (rather than guessing) when
 * neither limit can be priced.
 */
export function resolveBudget(
  budget: ResolvedHandoffConfig['memory']['budget'],
  measurement: TokenMeasurement,
  contextWindow: number | undefined,
): BudgetPicture {
  const usedTokens = budget.denominator === 'total' ? measurement.totalTokens : measurement.surfaceTokens
  const ratioBudget = contextWindow === undefined || contextWindow <= 0
    ? undefined
    : Math.max(1, Math.round(budget.ratio * contextWindow))
  const absolute = budget.tokens
  let budgetTokens: number | null
  let budgetSource: BudgetPicture['budgetSource']
  if (absolute !== undefined && ratioBudget !== undefined) {
    budgetTokens = Math.min(absolute, ratioBudget)
    budgetSource = 'ratio+tokens'
  } else if (absolute !== undefined) {
    budgetTokens = absolute
    budgetSource = 'tokens'
  } else if (ratioBudget !== undefined) {
    budgetTokens = ratioBudget
    budgetSource = 'ratio'
  } else {
    budgetTokens = null
    budgetSource = 'unresolved'
  }
  const warnTokens = budgetTokens === null ? null : Math.round(budgetTokens * budget.warnAt)
  const band: MemoryBand = budgetTokens === null
    ? 'unknown'
    : usedTokens >= budgetTokens
      ? 'at-limit'
      : warnTokens !== null && usedTokens >= warnTokens ? 'warn' : 'ok'
  return {
    band,
    usedTokens,
    surfaceTokens: measurement.surfaceTokens,
    totalTokens: measurement.totalTokens,
    budgetTokens,
    budgetSource,
    warnTokens,
    headroomTokens: budgetTokens === null ? null : budgetTokens - usedTokens,
    contextWindow: contextWindow ?? null,
    denominator: budget.denominator,
    wallHeadroomTokens: contextWindow === undefined ? null : contextWindow - measurement.totalTokens,
  }
}

/** The role of one surface node, in the harness's own vocabulary. */
export type MemoryRole = 'system' | 'developer' | 'user' | 'assistant' | 'tool' | 'unknown'

/** One surface node as the model sees it through \`inspect\`. */
export interface SurfaceEntry {
  readonly seq: SessionSeq
  /** Position on the current surface, head-first. */
  readonly index: number
  readonly role: MemoryRole
  /** Route-priced request tokens for this node. */
  readonly tokens: number
  /** Fixed-estimator tokens; the unit a replacement is priced in. */
  readonly heuristicTokens: number
  readonly preview: string
  /** Tool names an assistant message calls, when it calls any. */
  readonly toolNames: readonly string[]
  readonly turn: number | null
  readonly step: number | null
  /**
   * This node's step, identified as `turn.step`.
   *
   * The harness numbers steps *within* a turn, so a bare step number names a
   * different step in every turn: `1.1` and `2.1` are distinct, and a bare `1`
   * is read as turn 1 rather than as every turn's first step.
   */
  readonly key: string | null
  /** The user pinned this node; no drop may shadow it. */
  readonly pinned: boolean
  /** Inside the droppable head, before the retained tail. */
  readonly droppable: boolean
  /** A previous drop's replacement tombstone rather than ordinary history. */
  readonly tombstone: boolean
}

/** The surface map plus the facts a planner needs to trust it. */
export interface SurfaceMap {
  readonly entries: readonly SurfaceEntry[]
  /** The token meter agreed with the session surface node for node. */
  readonly aligned: boolean
  /** Last droppable surface node, or null when nothing is droppable. */
  readonly droppableEnd: SessionSeq | null
  /** Why the droppable head ends where it does. */
  readonly droppableReason: string
  /** Every step on the surface, in order, as `turn.step` keys. */
  readonly steps: readonly string[]
}

/** One \`step/start\` marker, used to attribute surface nodes to a step. */
export interface StepMarker {
  readonly seq: number
  readonly turn: number
  readonly step: number
}

/** Every step boundary in the session log, oldest first. */
export function stepMarkers(session: Session): StepMarker[] {
  const markers: StepMarker[] = []
  for (let seq = 0; seq < session.seq; seq += 1) {
    const event = session.eventAt(SessionSeq(seq))
    if (event?.type === 'step/start') markers.push({ seq, turn: event.data.turn, step: event.data.step })
  }
  return markers
}

/** One \`turn/start\` marker: the turn a surface node belongs to. */
export interface TurnStart {
  readonly seq: number
  readonly turn: number
}

/**
 * Every turn boundary in the session log, oldest first.
 *
 * Step attribution runs through the turn, not through the nearest step marker:
 * the user message that opens a turn is appended *before* that turn's first
 * \`step/start\`, so a node belongs to the turn that contains it and to that
 * turn's first step when no step has started yet. Attributing by "the last step
 * marker before this node" would leave every request without a step and make a
 * drop take the answer while keeping the request.
 */
export function turnStarts(session: Session): TurnStart[] {
  const starts: TurnStart[] = []
  for (let seq = 0; seq < session.seq; seq += 1) {
    const event = session.eventAt(SessionSeq(seq))
    if (event?.type === 'turn/start') starts.push({ seq, turn: event.data.turn })
  }
  return starts
}

/** Collapse whitespace so a preview is one line. */
function collapse(text: string): string {
  return text.replace(/\s+/gu, ' ').trim()
}

/** The text blocks of one message, joined. */
function textOf(message: Message): string {
  const parts: string[] = []
  for (const block of message.content) {
    const type = (block as unknown as { type?: unknown }).type
    if (type !== 'text') continue
    const text = (block as unknown as { text?: unknown }).text
    if (typeof text === 'string' && text !== '') parts.push(text)
  }
  return parts.join(' ')
}

/** Tool names an assistant message calls, in order, de-duplicated. */
function toolNamesOf(message: Message): string[] {
  const names: string[] = []
  for (const block of message.content) {
    const source = block as unknown as { type?: unknown; name?: unknown }
    if (source.type !== 'tool-call') continue
    const name = typeof source.name === 'string' && source.name !== '' ? source.name : 'unknown'
    if (!names.includes(name)) names.push(name)
  }
  return names
}

function roleOf(message: Message): MemoryRole {
  switch (message.role) {
    case 'system': return 'system'
    case 'developer': return 'developer'
    case 'user': return 'user'
    case 'assistant': return 'assistant'
    case 'tool': return 'tool'
    default: return 'unknown'
  }
}

/** The full derived text of one surface node, for verbatim protection. */
export function fullTextOf(session: Session, seq: SessionSeq): string {
  const event = session.eventAt(seq)
  if (event === undefined) return ''
  const message = session.deriveEventMessage(event)
  return message === null ? '' : collapse(textOf(message))
}

/**
 * Build the bounded surface map.
 *
 * The token meter's node prices are used when its surface agrees with the
 * session's; on disagreement (a stale measurement) every entry is priced at
 * zero and \`aligned\` is false, which makes every plan refuse on the freedom
 * floor rather than under-report what a drop would free.
 */
export function buildMap(args: {
  readonly session: Session
  readonly measurement: TokenMeasurement
  readonly pins: ReadonlySet<number>
  readonly tombstones: ReadonlySet<number>
  readonly droppableEnd: SessionSeq | null
  readonly droppableReason: string
}): SurfaceMap {
  const surface = args.session.surface.nodes
  const priced = args.measurement.nodes
  const aligned = surface.length === priced.length
    && surface.every((seq, index) => seq === priced[index]?.seq)
  const starts = turnStarts(args.session)
  const markers = stepMarkers(args.session)
  const byTurn = new Map<number, StepMarker[]>()
  for (const marker of markers) {
    const own = byTurn.get(marker.turn)
    if (own === undefined) byTurn.set(marker.turn, [marker])
    else own.push(marker)
  }
  const droppableEndIndex = args.droppableEnd === null ? -1 : surface.indexOf(args.droppableEnd)
  const entries: SurfaceEntry[] = []
  const seen = new Set<string>()
  const steps: string[] = []
  for (let index = 0; index < surface.length; index += 1) {
    const seq = surface[index]!
    const event = args.session.eventAt(seq)
    const message = event === undefined ? null : args.session.deriveEventMessage(event)
    // Surface seqs are not necessarily ascending: a drop replaces an old span
    // with a fresh tombstone event whose seq is the highest in the log, and it
    // sits where the span used to be. So the containing turn is looked up per
    // node rather than followed with a forward cursor, which a node after the
    // tombstone would otherwise leave permanently behind.
    let low = 0
    let high = starts.length - 1
    let currentTurn: number | null = null
    while (low <= high) {
      const middle = (low + high) >> 1
      if (starts[middle]!.seq <= seq) {
        currentTurn = starts[middle]!.turn
        low = middle + 1
      } else {
        high = middle - 1
      }
    }
    let marker: StepMarker | null = null
    if (message !== null && currentTurn !== null) {
      const own = byTurn.get(currentTurn)
      if (own !== undefined) {
        marker = own[0]!
        for (const candidate of own) if (candidate.seq <= seq) marker = candidate
      }
    }
    const key = marker === null ? null : marker.turn + '.' + marker.step
    if (key !== null && !seen.has(key)) {
      seen.add(key)
      steps.push(key)
    }
    const node = aligned ? priced[index] : undefined
    entries.push({
      seq,
      index,
      role: message === null ? 'unknown' : roleOf(message),
      tokens: node?.tokens ?? 0,
      heuristicTokens: node?.heuristicTokens ?? 0,
      preview: message === null ? '' : collapse(textOf(message)).slice(0, PREVIEW_CHARS),
      toolNames: message === null ? [] : toolNamesOf(message),
      turn: marker?.turn ?? null,
      step: marker?.step ?? null,
      key,
      pinned: args.pins.has(seq),
      droppable: droppableEndIndex >= 0 && index <= droppableEndIndex,
      tombstone: args.tombstones.has(seq),
    })
  }
  return { entries, aligned, droppableEnd: args.droppableEnd, droppableReason: args.droppableReason, steps }
}

/** One requested unit of history, before it is resolved against the surface. */
export interface StepSelector {
  /** The turn the selection names. */
  readonly turn: number
  /** Exact step inside that turn, when the selector named one. */
  readonly step?: number
  /** Last step of a within-turn step range. */
  readonly toStep?: number
  /** Last turn of a turn range. */
  readonly toTurn?: number
}

/** A parsed step selection. */
export interface ParsedSelection {
  readonly selectors: readonly StepSelector[]
  /** Parts that were not a step, a turn, or an ascending range. */
  readonly invalid: readonly string[]
}

/**
 * Parse a step selection.
 *
 * A step is named by its turn and its step number — `3.1` — because the harness
 * numbers steps *within* a turn: "step 1" is a different step in every turn.
 *
 * - `3` — every step of turn 3.
 * - `3.1` — turn 3, step 1.
 * - `1-3` — turns 1 through 3.
 * - `3.1-3.3` — steps 1 to 3 of turn 3.
 */
export function parseSelection(text: string): ParsedSelection {
  const selectors: StepSelector[] = []
  const invalid: string[] = []
  for (const rawPart of text.split(/[,;]+/u)) {
    const part = rawPart.trim()
    if (part === '') continue
    const range = /^(\d+)(?:\.(\d+))?\s*(?:-|\u2013|\.\.)\s*(\d+)(?:\.(\d+))?$/u.exec(part)
    if (range !== null) {
      const fromTurn = Number(range[1])
      const fromStep = range[2] === undefined ? undefined : Number(range[2])
      const toTurn = Number(range[3])
      const toStep = range[4] === undefined ? undefined : Number(range[4])
      if (fromTurn < 1 || toTurn < fromTurn) { invalid.push(part); continue }
      if (fromStep !== undefined && toStep !== undefined) {
        if (fromTurn !== toTurn || fromStep < 1 || toStep < fromStep) { invalid.push(part); continue }
        if (toStep - fromStep + 1 > MAX_SELECTED_STEPS) { invalid.push(part); continue }
        selectors.push({ turn: fromTurn, step: fromStep, toStep })
        continue
      }
      if (fromStep !== undefined || toStep !== undefined) { invalid.push(part); continue }
      if (toTurn - fromTurn + 1 > MAX_SELECTED_STEPS) { invalid.push(part); continue }
      selectors.push({ turn: fromTurn, toTurn })
      continue
    }
    const single = /^(\d+)(?:\.(\d+))?$/u.exec(part)
    if (single !== null) {
      const turn = Number(single[1])
      const step = single[2] === undefined ? undefined : Number(single[2])
      if (turn < 1 || (step !== undefined && step < 1)) { invalid.push(part); continue }
      selectors.push(step === undefined ? { turn } : { turn, step })
      continue
    }
    invalid.push(part)
  }
  return { selectors, invalid }
}

/** A parsed seq list. */
export interface ParsedSeqs {
  readonly seqs: readonly number[]
  /** Parts that were not a seq or an ascending seq range. */
  readonly invalid: readonly string[]
}

/**
 * Parse \`"12, 15-18"\` into sorted unique surface seqs, for \`pin\`.
 *
 * Seqs are plain integers and are never steps: a bare number in a *step*
 * selection means a turn, so the two grammars are kept apart on purpose.
 */
export function parseSeqList(text: string): ParsedSeqs {
  const seqs = new Set<number>()
  const invalid: string[] = []
  for (const rawPart of text.split(/[,;]+/u)) {
    const part = rawPart.trim()
    if (part === '') continue
    const range = /^(\d+)\s*(?:-|\u2013|\.\.)\s*(\d+)$/u.exec(part)
    if (range !== null) {
      const from = Number(range[1])
      const to = Number(range[2])
      if (from < 1 || to < from || to - from + 1 > MAX_SELECTED_STEPS) { invalid.push(part); continue }
      for (let seq = from; seq <= to; seq += 1) seqs.add(seq)
      continue
    }
    const single = /^(\d+)$/u.exec(part)
    if (single !== null && Number(single[1]) >= 1) { seqs.add(Number(single[1])); continue }
    invalid.push(part)
  }
  return { seqs: [...seqs].sort((a, b) => a - b), invalid }
}

/**
 * Resolve selectors against the steps actually present on the surface.
 *
 * Resolution is deliberately not syntactic: `3` means "turn 3", and which steps
 * that covers depends on what the surface holds, so the answer follows the
 * conversation rather than a guess.
 */
export function resolveSelection(
  selectors: readonly StepSelector[],
  keys: readonly string[],
): { readonly keys: readonly string[]; readonly unknown: readonly string[] } {
  const units = keys.map(key => {
    const dot = key.indexOf('.')
    return { key, turn: Number(key.slice(0, dot)), step: Number(key.slice(dot + 1)) }
  })
  const chosen = new Set<string>()
  const unknown: string[] = []
  for (const selector of selectors) {
    if (selector.step !== undefined) {
      const to = selector.toStep ?? selector.step
      const matches = units.filter(unit => unit.turn === selector.turn && unit.step >= selector.step! && unit.step <= to)
      if (matches.length === 0) {
        unknown.push(selector.turn + '.' + selector.step + (selector.toStep === undefined ? '' : '-' + selector.turn + '.' + selector.toStep))
      }
      for (const match of matches) chosen.add(match.key)
      continue
    }
    const toTurn = selector.toTurn ?? selector.turn
    const matches = units.filter(unit => unit.turn >= selector.turn && unit.turn <= toTurn)
    if (matches.length === 0) unknown.push(selector.toTurn === undefined ? String(selector.turn) : selector.turn + '-' + selector.toTurn)
    for (const match of matches) chosen.add(match.key)
  }
  return { keys: keys.filter(key => chosen.has(key)), unknown }
}

/** One contiguous, balanced span of the surface a drop would replace. */
export interface DropSpan {
  readonly start: SessionSeq
  readonly end: SessionSeq
  readonly seqs: readonly SessionSeq[]
  readonly steps: readonly string[]
  readonly shadowedHeuristicTokens: number
  readonly shadowedRouteTokens: number
}

/** A validated drop plan: what would be replaced, what it frees, and why not. */
export interface DropPlan {
  readonly spans: readonly DropSpan[]
  readonly steps: readonly string[]
  readonly shadowedSeqs: readonly SessionSeq[]
  readonly shadowedHeuristicTokens: number
  readonly shadowedRouteTokens: number
  readonly tombstoneTokens: number
  /** Net tokens freed: shadowed heuristic price minus the tombstone's price. */
  readonly freedTokens: number
  readonly protectedText: readonly string[]
  readonly outline: readonly string[]
  readonly tombstone: string
  readonly blockers: readonly string[]
  readonly ok: boolean
}

/** Render the replacement tombstone for one drop. */
export function renderTombstone(input: {
  readonly spans: readonly DropSpan[]
  readonly protectedText: readonly string[]
  readonly outline: readonly string[]
  readonly pointer: string
}): string {
  const first = input.spans[0]
  const last = input.spans[input.spans.length - 1]
  const seqs = first === undefined || last === undefined
    ? ''
    : first.start === last.end ? 'seq ' + first.start : 'seqs ' + first.start + '\u2013' + last.end
  const lines: string[] = [
    '[dsh-autocompact] Dropped ' + input.outline.length + ' finished step(s) from the visible conversation ('
      + seqs + ') to make room.',
    '',
    'Outline of what was dropped:',
    ...input.outline.map(line => '  - ' + line),
  ]
  if (input.protectedText.length > 0) {
    lines.push('', 'Kept verbatim from the dropped span (user messages are never lost):')
    for (const text of input.protectedText) {
      const bounded = text.length > PROTECTED_TEXT_CHARS
        ? text.slice(0, PROTECTED_TEXT_CHARS) + '\u2026 [truncated here; the full text is in the archive]'
        : text
      lines.push('  - user: ' + bounded)
    }
  }
  lines.push(
    '',
    'Nothing was deleted: the full transcript of the dropped span is archived at',
    input.pointer,
    'Use the session_memory tool with action "recall" to search it without rereading the archive.',
  )
  return lines.join('\n')
}

/** One line per dropped step for the tombstone outline. */
function outlineOf(spans: readonly DropSpan[], entries: readonly SurfaceEntry[], steps: readonly string[]): string[] {
  const lines: string[] = []
  for (const step of steps) {
    const own = entries.filter(entry => entry.key === step)
      .filter(entry => spans.some(span => span.seqs.includes(entry.seq)))
    if (own.length === 0) continue
    const tokens = own.reduce((total, entry) => total + entry.heuristicTokens, 0)
    const roles: string[] = []
    for (const entry of own) {
      const label = entry.role === 'assistant' && entry.toolNames.length > 0
        ? 'assistant\u2192' + entry.toolNames.join('/')
        : entry.role
      if (roles[roles.length - 1] !== label) roles.push(label)
    }
    lines.push('step ' + step + ': ' + roles.join(', ') + ' (~' + tokens + ' tokens)')
  }
  return lines
}

/**
 * Plan a drop without touching the session.
 *
 * The requested steps are turned into surface positions, widened to the nearest
 * tool-pairing-balanced boundaries (so a plan can never split an assistant
 * tool-call from its result), checked against pins, the droppable head, and the
 * freedom floor, and priced against the tombstone that would replace them.
 * Every refusal is a blocker line: a plan with a blocker is never applied.
 *
 * Steps are dropped whole. A step that straddles the retained-tail boundary is
 * refused rather than half-removed, because half a step can leave the newest
 * turn's answer in place with the request that produced it gone.
 */
export function planDrop(args: {
  readonly session: Session
  readonly map: SurfaceMap
  readonly selectors: readonly StepSelector[]
  readonly config: ResolvedHandoffConfig['memory']
  readonly priceText: (text: string) => number
  readonly pointer: string
}): DropPlan {
  const { session, map, config } = args
  const blockers: string[] = []
  const entries = map.entries
  if (!map.aligned) blockers.push('the token meter is out of date for this surface; retry after the next step')
  if (args.selectors.length === 0) blockers.push('no steps were selected')
  const resolution = resolveSelection(args.selectors, map.steps)
  if (resolution.unknown.length > 0) {
    blockers.push('no such step: ' + resolution.unknown.join(', ')
      + ' (name a step as turn.step, or a bare turn for all of its steps)')
  }
  const partial = resolution.keys.filter(key => {
    const own = entries.filter(entry => entry.key === key)
    return own.length > 0 && own.some(entry => !entry.droppable)
  })
  if (partial.length > 0) {
    blockers.push('step ' + partial.join(', ') + ' is not entirely inside the droppable head (' + map.droppableReason
      + '); a drop never splits a step, so select an earlier, finished one')
  }

  const chosen = new Set(resolution.keys)
  const selected = entries.filter(entry => entry.key !== null && chosen.has(entry.key) && entry.droppable)
  let span: DropSpan | null = null
  if (selected.length > 0) {
    let startIdx = selected[0]!.index
    let endIdx = selected[selected.length - 1]!.index
    let lastDroppable = -1
    for (const entry of entries) if (entry.droppable) lastDroppable = entry.index
    while (startIdx > 0 && !toolPairingBalancedBefore(session, entries[startIdx]!.seq)) startIdx -= 1
    while (endIdx < lastDroppable && !toolPairingBalancedAfter(session, entries[endIdx]!.seq)) endIdx += 1
    if (!toolPairingBalancedBefore(session, entries[startIdx]!.seq)
      || !toolPairingBalancedAfter(session, entries[endIdx]!.seq)) {
      blockers.push('the selected steps cannot be cut on a tool-call/result boundary inside the droppable head')
    } else {
      const seqs = entries.slice(startIdx, endIdx + 1).map(entry => entry.seq)
      const pinned = entries.slice(startIdx, endIdx + 1).filter(entry => entry.pinned)
      if (pinned.length > 0) {
        blockers.push('seq ' + pinned.map(entry => entry.seq).join(', ') + ' is pinned; unpin it first')
      }
      const inside = entries.slice(startIdx, endIdx + 1)
      span = {
        start: seqs[0]!,
        end: seqs[seqs.length - 1]!,
        seqs,
        steps: [...new Set(inside.map(entry => entry.key).filter((key): key is string => key !== null))],
        shadowedHeuristicTokens: inside.reduce((total, entry) => total + entry.heuristicTokens, 0),
        shadowedRouteTokens: inside.reduce((total, entry) => total + entry.tokens, 0),
      }
    }
  }
  const spans = span === null ? [] : [span]
  const shadowedSeqs = span?.seqs ?? []
  const protectedText = config.policy.protectUserMessages
    ? (span === null ? [] : span.seqs
      .map(seq => entries.find(entry => entry.seq === seq))
      .filter((entry): entry is SurfaceEntry => entry !== undefined && entry.role === 'user' && !entry.tombstone)
      .map(entry => fullTextOf(session, entry.seq))
      .filter(text => text !== ''))
    : []
  const outline = outlineOf(spans, entries, span?.steps ?? [])
  const tombstone = renderTombstone({ spans, protectedText, outline, pointer: args.pointer })
  const shadowedHeuristicTokens = span?.shadowedHeuristicTokens ?? 0
  const shadowedRouteTokens = span?.shadowedRouteTokens ?? 0
  const tombstoneTokens = args.priceText(tombstone)
  const freedTokens = shadowedHeuristicTokens - tombstoneTokens
  if (span !== null && freedTokens < config.limits.minFreedTokens) {
    blockers.push('this drop would free about ' + freedTokens + ' tokens, below the '
      + config.limits.minFreedTokens + '-token floor; select more finished steps')
  }
  return {
    spans,
    steps: span?.steps ?? [],
    shadowedSeqs,
    shadowedHeuristicTokens,
    shadowedRouteTokens,
    tombstoneTokens,
    freedTokens,
    protectedText,
    outline,
    tombstone,
    blockers,
    ok: blockers.length === 0 && span !== null,
  }
}

/**
 * The retained tail in tokens.
 *
 * The plugin's own \`retain\` setting decides, exactly as the pressure path
 * does. When it cannot be priced (a ratio without a resolvable window, or an
 * unset retention), the tail is a quarter of the memory budget with a 2000-token
 * floor, and 4000 tokens when even the budget is unknown: a fixed, documented
 * guard rail rather than a silent coupling to the trigger.
 */
export function retainTokensFor(config: ResolvedHandoffConfig, contextWindow: number | undefined, budgetTokens: number | null): number {
  if (config.retain.tokens !== undefined) return config.retain.tokens
  if (config.retain.ratio !== undefined && contextWindow !== undefined && contextWindow > 0) {
    return Math.max(1, Math.round(config.retain.ratio * contextWindow))
  }
  if (budgetTokens === null) return 4000
  return Math.max(2000, Math.round(budgetTokens * 0.25))
}

/** Render the surface map within a token budget. */
export function renderMap(input: {
  readonly map: SurfaceMap
  readonly picture: BudgetPicture
  readonly pins: ReadonlySet<number>
  readonly mapTokens: number
  readonly lastDrop: string | undefined
}): string {
  const { map, picture } = input
  const lines: string[] = [
    'pressure: ' + picture.band.toUpperCase()
      + ' | used ' + picture.usedTokens + ' (' + picture.denominator + ')'
      + ' of ' + (picture.budgetTokens === null ? 'unknown budget' : picture.budgetTokens + ' budget (' + picture.budgetSource + ')')
      + (picture.headroomTokens === null ? '' : ' | ' + picture.headroomTokens + ' left')
      + (picture.warnTokens === null ? '' : ' | advisory at ' + picture.warnTokens),
    'request: ' + picture.totalTokens + ' total tokens'
      + (picture.contextWindow === null ? '' : ' of ' + picture.contextWindow + ' window')
      + (picture.wallHeadroomTokens === null ? '' : ' | ' + picture.wallHeadroomTokens + ' before overflow'),
    'droppable head: ' + (map.droppableEnd === null ? 'nothing' : 'up to seq ' + map.droppableEnd) + ' (' + map.droppableReason + ')',
  ]
  if (input.lastDrop !== undefined) lines.push('last drop: ' + input.lastDrop)
  lines.push('', 'steps (turn.step  seq  shape  tokens  preview):')
  const dropped: string[] = []
  let budget = input.mapTokens - Math.ceil(lines.join('\n').length / 4)
  for (const step of map.steps) {
    const own = map.entries.filter(entry => entry.key === step)
    if (own.length === 0) continue
    const tokens = own.reduce((total, entry) => total + entry.tokens, 0)
    const first = own[0]!
    const last = own[own.length - 1]!
    const pinned = own.some(entry => entry.pinned) ? ' [pinned]' : ''
    const flag = !own.some(entry => entry.droppable) ? ' [retained]' : ''
    const shape = own.map(entry => entry.role === 'assistant' && entry.toolNames.length > 0
      ? 'assistant\u2192' + entry.toolNames.join('/')
      : entry.role).join('+')
    const preview = own.map(entry => entry.preview).filter(text => text !== '').join(' \u22ef ')
    const line = '  ' + step + '  ' + (first.seq === last.seq ? String(first.seq) : first.seq + '-' + last.seq)
      + '  ' + shape + pinned + flag + '  ~' + tokens + '  ' + preview.slice(0, PREVIEW_CHARS)
    const cost = Math.ceil(line.length / 4)
    if (cost > budget) { dropped.push(step); continue }
    budget -= cost
    lines.push(line)
  }
  if (dropped.length > 0) lines.push('  (' + dropped.length + ' more step(s) omitted for length: ' + dropped.join(', ') + ')')
  // A node outside every step — the replacement tombstone itself, or a message
  // appended before the first step — is shown, never selected: no step names it.
  const stray = map.entries.filter(entry => entry.key === null)
  if (stray.length > 0) {
    const shown = stray.slice(0, 12)
    lines.push('  (not in a step)  ' + shown.map(entry => entry.seq + (entry.tombstone ? '*' : '')).join(',')
      + (stray.length > shown.length ? ',…' : '') + '  ' + shown.map(entry => entry.role).join('+'))
  }
  return lines.join('\n')
}
