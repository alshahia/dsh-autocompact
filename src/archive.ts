/**
 * Handoff archive writer: conversation.md + handoff.md under
 * `<root>/<sessionId>/<NNN>-<YYYYMMDD-HHmmss>[-a<k>]/`, written atomically
 * (temp dir → rename), plus an index.md register, the model-visible pointer
 * paragraph, and git hygiene.
 *
 * `<root>` belongs to one project (`<projectDir>/.dsh/handoffs` by default), so
 * archives of two projects never share a directory, an index, or an ordinal
 * sequence. Hygiene is self-contained: the writer drops its own `.gitignore`
 * containing `*` at the archive root and never edits the project's own
 * `.gitignore` or `.git/info/exclude`. The conversation is never deleted —
 * writes only.
 *
 * @module dsh-autocompact/archive
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { SummarizationInput } from '@deepseek-ai/dsh-compaction-basic/src/summarizer.ts'
import type { ContentBlock, Message } from '@deepseek-ai/dsh-llm'

export interface ArchiveHeader {
  sessionId: string
  timestamp: Date
  routedModel: string
  measuredTokens: number
}

export interface ArchiveWriteResult {
  /** Directory name under <root>/<sessionId>/, e.g. "001-20260910-120000". */
  dirName: string
  /** Absolute archive directory. */
  dirAbs: string
}

/** Render the full readable transcript of the condensed span. */
export function renderConversation(input: SummarizationInput, header: ArchiveHeader): string {
  const lines: string[] = [
    '# Conversation archive — ' + header.sessionId,
    '',
    '- timestamp: ' + header.timestamp.toISOString(),
    '- routed model: ' + header.routedModel,
    '- measured tokens: ' + header.measuredTokens,
    '- note: each compaction archives the span since the previous checkpoint; the session',
    '  index.md plus the chain of conversation.md files reconstructs the whole conversation.',
    '',
  ]
  for (const message of input.messages) lines.push(...renderMessage(message))
  return lines.join('\n') + '\n'
}

function renderMessage(message: Message): string[] {
  // A tool result is a first-class 'tool'-role message in 0.2.x; surface it
  // with a tool header and a fenced body.
  const isToolResult = message.role === 'tool'
  const lines = ['## ' + (isToolResult ? 'tool' : message.role), '']
  if (isToolResult) {
    lines.push('```tool-result', ...renderBlocks(message.content), '```', '')
  } else {
    for (const block of message.content) lines.push(...renderBlock(block))
  }
  lines.push('')
  return lines
}

/** A block field read without trusting the union members this build may lack. */
function field(block: ContentBlock, key: string): unknown {
  return (block as unknown as Record<string, unknown>)[key]
}

/**
 * Render one content block as text.
 *
 * The block vocabulary grows between releases, so this reads the discriminant
 * as a string and probes the fields it knows: an unknown or binary block
 * degrades to a labelled placeholder rather than a crash or binary payload.
 */
function renderBlock(block: ContentBlock): string[] {
  const type = String(field(block, 'type'))
  if (type === 'text') {
    const text = field(block, 'text')
    return [typeof text === 'string' ? text : '', '']
  }
  if (type === 'reasoning') {
    const text = field(block, 'text')
    return typeof text === 'string' && text.trim() !== ''
      ? ['<reasoning>', text, '</reasoning>', '']
      : []
  }
  if (type === 'tool-call') {
    return ['```tool-call ' + String(field(block, 'name') ?? 'unknown'), renderArguments(field(block, 'arguments')), '```', '']
  }
  if (type === 'tool-addition' || type === 'tool-removal') {
    return ['[' + type + ': ' + describeTool(field(block, 'tool')) + ']', '']
  }
  if (type === 'file') {
    return ['[file attachment: ' + describeFile(block) + ']', '']
  }
  if (type === 'image') return ['[image attachment]', '']
  return ['[' + type + ' block omitted]', '']
}

function renderArguments(value: unknown): string {
  if (typeof value === 'string') return value
  if (value === undefined) return '{}'
  try {
    return JSON.stringify(value, null, 2) ?? String(value)
  } catch {
    return String(value)
  }
}

/** Name a tool referenced by an addition/removal block, whatever it is keyed by. */
function describeTool(value: unknown): string {
  if (typeof value === 'string') return value
  if (typeof value === 'object' && value !== null) {
    const source = value as Record<string, unknown>
    for (const key of ['name', 'id', 'toolName']) {
      if (typeof source[key] === 'string' && source[key] !== '') return source[key] as string
    }
  }
  return 'unnamed'
}

/** Name a file block by whichever identifying field it carries. */
function describeFile(block: ContentBlock): string {
  for (const key of ['name', 'path', 'filename', 'mediaType', 'id']) {
    const value = field(block, key)
    if (typeof value === 'string' && value !== '') return value
  }
  return 'unnamed'
}

function renderBlocks(blocks: readonly ContentBlock[]): string[] {
  return blocks.flatMap(block => renderBlock(block))
}

/** The pointer paragraph prepended to the summary. */
export function renderPointerText(archiveDir: string): string {
  return '**Handoff archive:** the full verbatim transcript of the condensed span and this handoff are saved '
    + 'at `' + archiveDir + '/conversation.md` and `' + archiveDir + '/handoff.md`. '
    + 'If any detail you need is not captured below, read those files before proceeding.'
}

/** Next archive dir name: ordinal continues; -a<k> disambiguates same-second archives. */
export function nextArchiveName(sessionDir: string, timestamp: Date): string {
  const stamp = formatStamp(timestamp)
  let max = 0
  let sameSecond = 0
  if (existsSync(sessionDir)) {
    for (const name of readdirSync(sessionDir)) {
      const match = /^(\d{3})-(\d{8}-\d{6})(?:-a(\d+))?$/.exec(name)
      if (match === null) continue
      max = Math.max(max, Number.parseInt(match[1]!, 10))
      if (match[2] === stamp) sameSecond = Math.max(sameSecond, Number.parseInt(match[3] ?? '1', 10))
    }
  }
  const base = String(max + 1).padStart(3, '0') + '-' + stamp
  return sameSecond === 0 ? base : base + '-a' + (sameSecond + 1)
}

function formatStamp(timestamp: Date): string {
  const pad = (n: number, w = 2): string => String(n).padStart(w, '0')
  return pad(timestamp.getFullYear(), 4) + pad(timestamp.getMonth() + 1) + pad(timestamp.getDate())
    + '-' + pad(timestamp.getHours()) + pad(timestamp.getMinutes()) + pad(timestamp.getSeconds())
}

/**
 * Write one archive atomically and append the index line. Throws on fs failure.
 * @param options.gitIgnore - When true (default), first drop the self-contained
 *   `.gitignore` at the archive root so the archive never shows in git status.
 */
export async function writeArchive(options: {
  root: string
  sessionId: string
  summary: string
  conversation: string
  timestamp: Date
  measuredTokens: number
  routedModel: string
  gitIgnore?: boolean
}): Promise<ArchiveWriteResult> {
  if (options.gitIgnore !== false) ensureArchiveGitignore(options.root)
  const sessionDir = join(options.root, options.sessionId)
  const dirName = nextArchiveName(sessionDir, options.timestamp)
  const finalDir = join(sessionDir, dirName)
  const tempDir = join(sessionDir, '.' + dirName + '.tmp')
  mkdirSync(tempDir, { recursive: true })
  writeFileSync(join(tempDir, 'handoff.md'), options.summary.trim() + '\n')
  writeFileSync(join(tempDir, 'conversation.md'), options.conversation)
  renameSync(tempDir, finalDir)
  appendIndexLine(sessionDir, {
    timestamp: options.timestamp, dirName,
    measuredTokens: options.measuredTokens, routedModel: options.routedModel,
  })
  return { dirName, dirAbs: finalDir }
}

function appendIndexLine(
  sessionDir: string,
  line: { timestamp: Date; dirName: string; measuredTokens: number; routedModel: string },
): void {
  mkdirSync(sessionDir, { recursive: true })
  const index = join(sessionDir, 'index.md')
  if (!existsSync(index)) {
    writeFileSync(index, '# Handoff archive index\n\n| timestamp | directory | condensed | model |\n|---|---|---|---|\n')
  }
  const appended = '| ' + line.timestamp.toISOString() + ' | ' + line.dirName
    + ' | ~' + line.measuredTokens + ' tokens | ' + line.routedModel + ' |\n'
  writeFileSync(index, readFileSync(index, 'utf8') + appended)
}

/** The marker line written into the archive root's own .gitignore. */
const GITIGNORE_MARKER = '# written by dsh-autocompact: archives are local history, never committed'

/**
 * Ensure the archive root ignores itself for git, without touching anything the
 * user owns: a `*` pattern in `<root>/.gitignore` hides the whole archive tree
 * from `git status`, and the project's own .gitignore and .git/info/exclude are
 * left untouched. Idempotent; never throws.
 * @param root - Absolute archive root.
 * @returns true when the file is in place.
 */
export function ensureArchiveGitignore(root: string): boolean {
  try {
    const file = join(root, '.gitignore')
    if (existsSync(file)) return true
    mkdirSync(root, { recursive: true })
    writeFileSync(file, GITIGNORE_MARKER + '\n*\n')
    return true
  } catch {
    return false
  }
}
