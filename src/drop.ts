/**
 * The durable half of a memory drop: archive the span, commit the replacement,
 * and read an archive back.
 *
 * Order is not negotiable.
 *
 *  1. **Archive first, while the tool call still owns the turn.** A failed write
 *     can refuse the drop before anything reaches the session log, which is what
 *     \`policy.archiveOnDrop: 'block'\` promises.
 *  2. **Commit synchronously at a step boundary.** The surface replacement is a
 *     short sequence of appends with no await between them, so it can run from a
 *     \`session/event\` listener on \`step/start\` — the one point where the previous
 *     request is finished and the next one has not been built. Mutating the
 *     surface earlier would corrupt the in-flight request, and mutating it from
 *     \`runMaintenance\` is impossible while a turn drives the agent.
 *  3. **Re-validate immediately before committing.** A plan is made in one step
 *     and applied at the next boundary; between the two, the pressure engine may
 *     have replaced part of the surface. {@link spanIsCommittable} refuses a plan
 *     whose nodes are no longer the present, contiguous, balanced span it was
 *     built from.
 *
 * The replacement is one \`user/message\` tombstone citing every shadowed node,
 * preceded by the \`compaction/prune\` metering event the shadow-price protocol
 * requires (\`compaction/start\` … \`compaction/end\` around it, like any other
 * surface replacement).
 *
 * @module dsh-autocompact/drop
 */
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { CompactionId } from '@deepseek-ai/dsh-compaction'
import { toolPairingBalancedAfter, toolPairingBalancedBefore } from '@deepseek-ai/dsh-compaction'
import { assertNoActiveCompaction } from '@deepseek-ai/dsh-compaction-basic/src/region.ts'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, Message } from '@deepseek-ai/dsh-llm'
import type { Session, SessionSeq } from '@deepseek-ai/dsh-session'
import type { SummarizationInput } from '@deepseek-ai/dsh-compaction-basic/src/summarizer.ts'
import { renderConversation, writeArchive } from './archive.ts'
import type { ArchiveHeader } from './archive.ts'
import type { DropPlan } from './memory.ts'

/** Largest archive file a recall pass reads whole (2 MiB). */
const RECALL_MAX_FILE_BYTES = 2 * 1024 * 1024
/** Newest archive directories a recall pass scans. */
const RECALL_MAX_DIRS = 40

/** One written drop archive. */
export interface DropArchive {
  /** Absolute archive directory. */
  readonly dirAbs: string
  /** Directory name under \`<root>/<sessionId>/\`, e.g. \`003-20261013-084500\`. */
  readonly dirName: string
}

/** The replayed span, in surface order, as the archive writer wants it. */
function spanInput(session: Session, plan: DropPlan): SummarizationInput {
  const messages: Message[] = []
  for (const seq of plan.shadowedSeqs) {
    const event = session.eventAt(seq)
    if (event === undefined) continue
    const message = session.deriveEventMessage(event)
    if (message !== null) messages.push(message)
  }
  const header = session.requestHeader()
  return {
    ...(header?.tools === undefined ? {} : { tools: header.tools }),
    messages,
  }
}

/** The handoff.md body for a dropped span. */
function renderDropHandoff(plan: DropPlan, header: ArchiveHeader): string {
  const lines: string[] = [
    '# Dropped span — ' + header.sessionId,
    '',
    '- dropped at: ' + header.timestamp.toISOString(),
    '- routed model: ' + header.routedModel,
    '- steps: ' + plan.steps.join(', '),
    '- seqs: ' + (plan.shadowedSeqs[0] ?? '?') + '\u2013' + (plan.shadowedSeqs[plan.shadowedSeqs.length - 1] ?? '?'),
    '- shadowed: ~' + plan.shadowedRouteTokens + ' route tokens (' + plan.shadowedHeuristicTokens + ' heuristic)',
    '- replacement tombstone: ~' + plan.tombstoneTokens + ' tokens; net freed ~' + plan.freedTokens,
    '',
    'This span was removed from the model-visible conversation by the session_memory',
    'tool at the model\'s request — not by a summarizing compaction, so there is no',
    'written handoff summary. conversation.md is the verbatim transcript of exactly',
    'these steps, and it is the recall target for anything dropped here.',
    '',
    '## Outline',
  ]
  for (const line of plan.outline) lines.push('- ' + line)
  if (plan.protectedText.length > 0) {
    lines.push('', '## User messages kept verbatim in the tombstone')
    for (const text of plan.protectedText) lines.push('', text)
  }
  lines.push('')
  return lines.join('\n')
}

/**
 * Write the dropped span to the project archive under its session directory.
 * Throws on filesystem failure; the caller decides whether that blocks the drop.
 */
export async function archiveDrop(args: {
  readonly session: Session
  readonly plan: DropPlan
  readonly root: string
  readonly sessionId: string
  readonly timestamp: Date
  readonly routedModel: string
  readonly gitIgnore: boolean
}): Promise<DropArchive> {
  const header: ArchiveHeader = {
    sessionId: args.sessionId,
    timestamp: args.timestamp,
    routedModel: args.routedModel,
    measuredTokens: args.plan.shadowedRouteTokens,
  }
  const result = await writeArchive({
    root: args.root,
    sessionId: args.sessionId,
    summary: renderDropHandoff(args.plan, header),
    conversation: renderConversation(spanInput(args.session, args.plan), header),
    timestamp: args.timestamp,
    measuredTokens: args.plan.shadowedRouteTokens,
    routedModel: args.routedModel,
    gitIgnore: args.gitIgnore,
  })
  return { dirAbs: result.dirAbs, dirName: result.dirName }
}

/** The committed drop, as the receipt and the status board report it. */
export interface DropCommit {
  readonly compactionId: CompactionId
  readonly startSeq: SessionSeq
  readonly pruneSeq: SessionSeq
  readonly tombstoneSeq: SessionSeq
  readonly endSeq: SessionSeq
  readonly shadowedSeqs: readonly SessionSeq[]
  readonly shadowedHeuristicTokens: number
  readonly tombstoneTokens: number
  readonly freedTokens: number
  readonly turn: number | null
}

/**
 * Whether a planned span is still the present, contiguous, balanced span it was
 * planned from. Returns the reason it is not, or null when it may commit.
 */
export function spanIsCommittable(session: Session, plan: DropPlan): string | null {
  const first = plan.spans[0]
  const last = plan.spans[plan.spans.length - 1]
  if (first === undefined || last === undefined) return 'the plan has no span'
  const nodes = session.surface.nodes
  const startIdx = nodes.indexOf(first.start)
  const endIdx = nodes.indexOf(last.end)
  if (startIdx === -1) return 'the span start (seq ' + first.start + ') is no longer on the surface'
  if (endIdx === -1) return 'the span end (seq ' + last.end + ') is no longer on the surface'
  if (startIdx > endIdx) return 'the span is inverted'
  const current = nodes.slice(startIdx, endIdx + 1)
  if (current.length !== plan.shadowedSeqs.length) return 'the span changed after it was planned'
  for (let index = 0; index < current.length; index += 1) {
    if (current[index] !== plan.shadowedSeqs[index]) return 'the span changed after it was planned'
  }
  if (!toolPairingBalancedBefore(session, first.start)) return 'the span start is no longer a balanced boundary'
  if (!toolPairingBalancedAfter(session, last.end)) return 'the span end is no longer a balanced boundary'
  return null
}

/**
 * Commit one drop's surface replacement. Synchronous by design: it is safe to
 * call from a session-event listener because it awaits nothing.
 *
 * @throws when a compaction already holds the session lock, which the caller
 *   turns into a refusal rather than a broken turn.
 */
export function commitDrop(args: {
  readonly session: Session
  readonly plan: DropPlan
  readonly tombstone: string
  readonly turn: number | null
}): DropCommit {
  const { session, plan } = args
  const first = plan.spans[0]
  const last = plan.spans[plan.spans.length - 1]
  if (first === undefined || last === undefined) throw new Error('session_memory: the plan has no span to commit')
  assertNoActiveCompaction(session, 'session_memory drop')
  const compactionId = CompactionId(randomUUID())
  const lifecycle = { compactionId, turn: args.turn }
  const startEvent = session.append('compaction/start', lifecycle)
  const pruneEvent = session.append('compaction/prune', {
    shadowedRange: { start: first.start, end: last.end },
    shadowedSeqs: [...plan.shadowedSeqs],
    shadowedTokenCount: plan.shadowedHeuristicTokens,
  })
  const content: ContentBlock[] = [{ type: 'text', text: args.tombstone }]
  const tombstoneEvent = session.append('user/message', createUserMessage({
    content,
    source: { kind: 'user' },
  }), {
    surfaceOp: { op: 'replace', startSeq: first.start, endSeq: last.end },
    sourceEventSeqs: [startEvent.seq, pruneEvent.seq, ...plan.shadowedSeqs],
  })
  const endEvent = session.append('compaction/end', lifecycle)
  return {
    compactionId,
    startSeq: startEvent.seq,
    pruneSeq: pruneEvent.seq,
    tombstoneSeq: tombstoneEvent.seq,
    endSeq: endEvent.seq,
    shadowedSeqs: [...plan.shadowedSeqs],
    shadowedHeuristicTokens: plan.shadowedHeuristicTokens,
    tombstoneTokens: plan.tombstoneTokens,
    freedTokens: plan.freedTokens,
    turn: args.turn,
  }
}

/** One recall hit inside an archived file. */
export interface RecallHit {
  /** Archive-relative path, e.g. \`001-20261012-150000/conversation.md\`. */
  readonly path: string
  readonly line: number
  readonly text: string
}

/** A bounded recall result. */
export interface RecallResult {
  readonly hits: readonly RecallHit[]
  readonly scanned: readonly string[]
  readonly truncated: boolean
}

/** Newest-first archive directories under one session directory. */
function archiveDirs(sessionDir: string): string[] {
  if (!existsSync(sessionDir)) return []
  try {
    return readdirSync(sessionDir)
      .filter(name => /^\d{3}-/.test(name))
      .sort()
      .reverse()
      .slice(0, RECALL_MAX_DIRS)
  } catch {
    return []
  }
}

/**
 * Search this session's archives for a literal, case-insensitive query.
 *
 * Bounded on every axis — the newest {@link RECALL_MAX_DIRS} archives, files up
 * to {@link RECALL_MAX_FILE_BYTES}, one context line either side of a hit, and a
 * token budget — because recall exists to avoid re-reading a whole archive into
 * the context window. Never throws.
 */
export function recallArchive(args: {
  readonly root: string
  readonly sessionId: string
  readonly query: string
  readonly maxTokens: number
  readonly maxHits?: number
  readonly contextLines?: number
}): RecallResult {
  const needle = args.query.trim().toLowerCase()
  const hits: RecallHit[] = []
  const scanned: string[] = []
  if (needle === '') return { hits, scanned, truncated: false }
  const sessionDir = join(args.root, args.sessionId)
  const contextLines = Math.max(0, Math.min(args.contextLines ?? 1, 4))
  const maxHits = Math.max(1, Math.min(args.maxHits ?? 12, 40))
  let budget = Math.max(200, args.maxTokens)
  let truncated = false
  for (const dir of archiveDirs(sessionDir)) {
    for (const file of ['conversation.md', 'handoff.md']) {
      const abs = join(sessionDir, dir, file)
      if (!existsSync(abs)) continue
      try {
        if (statSync(abs).size > RECALL_MAX_FILE_BYTES) { truncated = true; continue }
        const text = readFileSync(abs, 'utf8')
        if (!text.toLowerCase().includes(needle)) continue
        const lines = text.split(/\r?\n/u)
        scanned.push(relative(sessionDir, abs).replaceAll('\\', '/'))
        for (let index = 0; index < lines.length; index += 1) {
          if (!lines[index]!.toLowerCase().includes(needle)) continue
          const from = Math.max(0, index - contextLines)
          const to = Math.min(lines.length - 1, index + contextLines)
          const snippet = lines.slice(from, to + 1).join('\n')
          const cost = Math.ceil(snippet.length / 4)
          if (cost > budget) { truncated = true; continue }
          budget -= cost
          hits.push({ path: relative(sessionDir, abs).replaceAll('\\', '/'), line: index + 1, text: snippet })
          if (hits.length >= maxHits) { truncated = true; break }
        }
      } catch {
        truncated = true
      }
      if (hits.length >= maxHits) break
    }
    if (hits.length >= maxHits) break
  }
  return { hits, scanned, truncated }
}
