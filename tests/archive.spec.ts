import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Message } from '@deepseek-ai/dsh-llm'
import type { SummarizationInput } from '@deepseek-ai/dsh-compaction-basic/src/summarizer.ts'
import {
  ensureArchiveGitignore, nextArchiveName, renderConversation, renderPointerText, writeArchive,
} from '../src/archive.ts'

const created: string[] = []
function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'autocompact-'))
  created.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const at = (iso: string): Date => new Date(iso)

function write(root: string, sessionId: string, timestamp: Date, extra: Partial<Parameters<typeof writeArchive>[0]> = {}) {
  return writeArchive({
    root, sessionId, summary: 'SUM', conversation: 'CONV', timestamp,
    measuredTokens: 1234, routedModel: 'deepseek/deepseek-chat',
    ...extra,
  })
}

describe('writeArchive', () => {
  it('writes handoff.md and conversation.md and registers the index line', async () => {
    const root = join(tmp(), 'handoffs')
    const written = await write(root, 'conversation-4', at('2026-10-12T10:00:00'))
    expect(written.dirName).toBe('001-20261012-100000')
    expect(readFileSync(join(written.dirAbs, 'handoff.md'), 'utf8')).toBe('SUM\n')
    expect(readFileSync(join(written.dirAbs, 'conversation.md'), 'utf8')).toBe('CONV')
    const index = readFileSync(join(root, 'conversation-4', 'index.md'), 'utf8')
    expect(index).toContain('| 001-20261012-100000 |')
    expect(index).toContain('~1234 tokens')
    expect(index).toContain('deepseek/deepseek-chat')
    expect(index).toContain(at('2026-10-12T10:00:00').toISOString())
  })

  it('leaves no temp directory behind', async () => {
    const root = join(tmp(), 'handoffs')
    const written = await write(root, 'conversation-4', at('2026-10-12T10:00:00'))
    expect(readdirSync(join(root, 'conversation-4')).filter(n => n.includes('.tmp'))).toEqual([])
    expect(existsSync(join(written.dirAbs, 'handoff.md'))).toBe(true)
  })

  it('advances the ordinal and disambiguates a second archive in the same second', async () => {
    const root = join(tmp(), 'handoffs')
    const first = await write(root, 's', at('2026-10-12T10:00:00'))
    const second = await write(root, 's', at('2026-10-12T10:00:00'))
    const third = await write(root, 's', at('2026-10-12T10:00:00'))
    const later = await write(root, 's', at('2026-10-12T11:30:05'))
    expect(first.dirName).toBe('001-20261012-100000')
    expect(second.dirName).toBe('002-20261012-100000-a2')
    expect(third.dirName).toBe('003-20261012-100000-a3')
    expect(later.dirName).toBe('004-20261012-113005')
    // One index row per archive: header + separator rows are not data.
    expect(readFileSync(join(root, 's', 'index.md'), 'utf8').split('\n').filter(l => /^\| \d{4}-/.test(l)))
      .toHaveLength(4)
  })

  it('keeps two projects in two disjoint trees with their own numbering and index', async () => {
    const projectA = join(tmp(), 'a')
    const projectB = join(tmp(), 'b')
    const inA = await write(join(projectA, '.dsh', 'handoffs'), 's', at('2026-10-12T10:00:00'))
    const inB = await write(join(projectB, '.dsh', 'handoffs'), 's', at('2026-10-12T10:00:00'))
    // Independent ordinals: the second project starts at 001 again.
    expect(inA.dirName).toBe('001-20261012-100000')
    expect(inB.dirName).toBe('001-20261012-100000')
    expect(inA.dirAbs.startsWith(projectA)).toBe(true)
    expect(inB.dirAbs.startsWith(projectB)).toBe(true)
    expect(readdirSync(join(projectA, '.dsh', 'handoffs'))).toContain('s')
    expect(readdirSync(join(projectB, '.dsh', 'handoffs'))).toContain('s')
    // Neither tree is visible from the other.
    expect(readdirSync(join(projectA, '.dsh', 'handoffs', 's')).filter(n => /^\d{3}-/.test(n)))
      .toHaveLength(1)
    expect(readdirSync(join(projectB, '.dsh', 'handoffs', 's')).filter(n => /^\d{3}-/.test(n)))
      .toHaveLength(1)
  })
})

describe('archive git hygiene', () => {
  it('drops its own .gitignore at the archive root and never the project one', async () => {
    const project = tmp()
    const projectIgnore = join(project, '.gitignore')
    writeFileSync(projectIgnore, 'node_modules\n')
    const root = join(project, '.dsh', 'handoffs')
    await write(root, 's', at('2026-10-12T10:00:00'))
    const own = readFileSync(join(root, '.gitignore'), 'utf8')
    expect(own).toContain('written by dsh-autocompact')
    expect(own.trimEnd().endsWith('*')).toBe(true)
    expect(readFileSync(projectIgnore, 'utf8')).toBe('node_modules\n')
    expect(existsSync(join(project, '.git', 'info', 'exclude'))).toBe(false)
  })

  it('is idempotent and skips the file when gitIgnore is false', async () => {
    const root = join(tmp(), 'handoffs')
    expect(ensureArchiveGitignore(root)).toBe(true)
    const once = readFileSync(join(root, '.gitignore'), 'utf8')
    expect(ensureArchiveGitignore(root)).toBe(true)
    expect(readFileSync(join(root, '.gitignore'), 'utf8')).toBe(once)
    const other = join(tmp(), 'handoffs2')
    await write(other, 's', at('2026-10-12T10:00:00'), { gitIgnore: false })
    expect(existsSync(join(other, '.gitignore'))).toBe(false)
  })

  it('reports failure instead of throwing when the root cannot be created', () => {
    const blocker = join(tmp(), 'file')
    writeFileSync(blocker, 'not a directory')
    expect(ensureArchiveGitignore(join(blocker, 'nested'))).toBe(false)
  })
})

describe('nextArchiveName', () => {
  it('starts at 001 in an empty or missing directory', () => {
    expect(nextArchiveName(join(tmp(), 'missing'), at('2026-10-12T09:08:07'))).toBe('001-20261012-090807')
  })

  it('ignores foreign directory names', async () => {
    const root = join(tmp(), 'handoffs')
    await write(root, 's', at('2026-10-12T10:00:00'))
    writeFileSync(join(root, 's', 'notes.txt'), 'x')
    expect(nextArchiveName(join(root, 's'), at('2026-10-12T10:00:01'))).toBe('002-20261012-100001')
  })
})

describe('renderConversation', () => {
  const header = {
    sessionId: 'conversation-4',
    timestamp: at('2026-10-12T10:00:00'),
    routedModel: 'deepseek/deepseek-chat',
    measuredTokens: 1234,
  }
  const message = (role: string, content: unknown[]): Message =>
    ({ role, content } as unknown as Message)
  const input = (messages: Message[]): SummarizationInput => ({ messages })

  it('renders text, reasoning, tool calls, tool results and attachments readably', () => {
    const rendered = renderConversation(input([
      message('user', [{ type: 'text', text: 'hello' }]),
      message('assistant', [
        { type: 'reasoning', text: 'thinking hard' },
        { type: 'text', text: 'answer' },
        { type: 'tool-call', name: 'read', arguments: { path: 'a.ts' } },
      ]),
      message('tool', [{ type: 'text', text: 'file body' }]),
      message('user', [{ type: 'file', name: 'notes.md' }, { type: 'image' }]),
    ]), header)
    expect(rendered).toContain('# Conversation archive — conversation-4')
    expect(rendered).toContain('- measured tokens: 1234')
    expect(rendered).toContain('## user')
    expect(rendered).toContain('hello')
    expect(rendered).toContain('<reasoning>')
    expect(rendered).toContain('thinking hard')
    expect(rendered).toContain('```tool-call read')
    expect(rendered).toContain('"path": "a.ts"')
    expect(rendered).toContain('```tool-result')
    expect(rendered).toContain('file body')
    expect(rendered).toContain('[file attachment: notes.md]')
    expect(rendered).toContain('[image attachment]')
  })

  it('degrades an unknown or malformed block instead of throwing', () => {
    const rendered = renderConversation(input([
      message('assistant', [
        { type: 'reasoning', text: '   ' },
        { type: 'future-block', payload: { secret: 'binary' } },
        { type: 'text' },
        { type: 'tool-addition', tool: { id: 'shell' } },
        { type: 'tool-call', name: 'x', arguments: undefined },
      ]),
    ]), header)
    expect(rendered).toContain('[future-block block omitted]')
    expect(rendered).not.toContain('binary')
    expect(rendered).not.toContain('<reasoning>')
    expect(rendered).toContain('[tool-addition: shell]')
    expect(rendered).toContain('{}')
    expect(rendered.endsWith('\n')).toBe(true)
  })

  it('never emits raw binary payloads for image blocks', () => {
    const rendered = renderConversation(input([
      message('user', [{ type: 'image', data: 'BASE64SECRET' }]),
    ]), header)
    expect(rendered).toContain('[image attachment]')
    expect(rendered).not.toContain('BASE64SECRET')
  })
})

describe('renderPointerText', () => {
  it('names both archived files at the relative path it was given', () => {
    const pointer = renderPointerText('.dsh/handoffs/s/001-20261012-100000')
    expect(pointer).toContain('**Handoff archive:**')
    expect(pointer).toContain('`.dsh/handoffs/s/001-20261012-100000/conversation.md`')
    expect(pointer).toContain('`.dsh/handoffs/s/001-20261012-100000/handoff.md`')
  })
})
