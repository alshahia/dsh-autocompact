import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Message } from '@deepseek-ai/dsh-llm'
import type { SummarizationInput, summarizeWithLlm } from '@deepseek-ai/dsh-compaction-basic/src/summarizer.ts'
import { LiveConfigReader } from '../src/config.ts'
import type { HandoffVolatileConfig } from '../src/config.ts'
import { summarizeWithArchive } from '../src/summarize.ts'
import type { SummarizeDeps } from '../src/summarize.ts'

const created: string[] = []
function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'autocompact-'))
  created.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const config = (raw: unknown = {}) => new LiveConfigReader(() => {}).read(raw as HandoffVolatileConfig)

function logs(): { info: string[]; warn: string[] } {
  return { info: [], warn: [] }
}

function ctxOf(sink: { info: string[]; warn: string[] }): Context {
  return {
    logger: {
      info: (message: string) => sink.info.push(message),
      warn: (message: string) => sink.warn.push(message),
    },
  } as unknown as Context
}

function agentOf(projectDir: string): Agent {
  return { session: { id: 'conversation-4', header: { cwd: projectDir } } } as unknown as Agent
}

const INPUT: SummarizationInput = {
  messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] } as unknown as Message],
}

/** A summarizer that never calls the model; returns two blocks in order. */
function fakeSummarizer(): typeof summarizeWithLlm {
  return (async () => ({
    summary: [{ type: 'text', text: 'FIRST' }, { type: 'text', text: 'SECOND' }],
    provider: 'deepseek',
    model: 'deepseek-chat',
  })) as unknown as typeof summarizeWithLlm
}

function deps(projectDir: string, raw: unknown = {}, sink = logs(), spanTokens = 42): SummarizeDeps {
  return {
    ctx: ctxOf(sink),
    config: config(raw),
    summarizer: fakeSummarizer(),
    spanTokens: () => spanTokens,
    routedModel: 'deepseek/deepseek-chat',
    projectDir,
  }
}

function archiveDirs(projectDir: string): string[] {
  const sessionDir = join(projectDir, '.dsh', 'handoffs', 'conversation-4')
  return existsSync(sessionDir) ? readdirSync(sessionDir).filter(n => /^\d{3}-/.test(n)) : []
}

describe('summarizeWithArchive', () => {
  it('archives into the project that owns the session and points at it relatively', async () => {
    const project = tmp()
    const sink = logs()
    const result = await summarizeWithArchive(deps(project, {}, sink), INPUT, agentOf(project))
    const dirs = archiveDirs(project)
    expect(dirs).toHaveLength(1)
    expect(result.summary[0]).toEqual({
      type: 'text',
      text: expect.stringContaining('.dsh/handoffs/conversation-4/' + dirs[0] + '/conversation.md'),
    })
    expect(result.summary.slice(1)).toEqual([
      { type: 'text', text: 'FIRST' }, { type: 'text', text: 'SECOND' },
    ])
    const handoff = readFileSync(join(project, '.dsh', 'handoffs', 'conversation-4', dirs[0]!, 'handoff.md'), 'utf8')
    expect(handoff).toBe('FIRST\nSECOND\n')
    expect(readFileSync(join(project, '.dsh', 'handoffs', 'conversation-4', 'index.md'), 'utf8'))
      .toContain('~42 tokens')
    expect(sink.info.join('\n')).toContain('~42 tokens condensed')
    expect(sink.warn).toEqual([])
  })

  it('never writes into another project', async () => {
    const mine = tmp()
    const other = tmp()
    await summarizeWithArchive(deps(mine), INPUT, agentOf(mine))
    expect(archiveDirs(mine)).toHaveLength(1)
    expect(existsSync(join(other, '.dsh'))).toBe(false)
  })

  it('points at an absolute directory when the archive root leaves the project', async () => {
    const outside = join(tmp(), 'elsewhere')
    const project = tmp()
    const result = await summarizeWithArchive(deps(project, { archive: { root: outside } }), INPUT, agentOf(project))
    const archived = readdirSync(join(outside, 'conversation-4')).filter(n => /^\d{3}-/.test(n))
    expect(archived).toHaveLength(1)
    expect((result.summary[0] as { text: string }).text).toContain(outside)
    expect(existsSync(join(project, '.dsh'))).toBe(false)
  })

  it('propagates an archive failure by default so compaction cannot silently lose the span', async () => {
    const blocker = join(tmp(), 'file')
    writeFileSync(blocker, 'not a directory')
    await expect(summarizeWithArchive(deps(tmp(), { archive: { root: join(blocker, 'nested') } }), INPUT, agentOf(tmp())))
      .rejects.toThrow()
  })

  it('proceeds without an archive and without a pointer when onFailure is proceed', async () => {
    const blocker = join(tmp(), 'file')
    writeFileSync(blocker, 'not a directory')
    const sink = logs()
    const result = await summarizeWithArchive(
      deps(tmp(), { archive: { root: join(blocker, 'nested'), onFailure: 'proceed' } }, sink),
      INPUT,
      agentOf(tmp()),
    )
    expect(result.summary).toEqual([{ type: 'text', text: 'FIRST' }, { type: 'text', text: 'SECOND' }])
    expect(sink.warn.join('\n')).toContain('proceeding without archive')
  })

  it('honors gitIgnore=false from the live configuration', async () => {
    const project = tmp()
    await summarizeWithArchive(deps(project, { archive: { gitIgnore: false } }), INPUT, agentOf(project))
    expect(existsSync(join(project, '.dsh', 'handoffs', '.gitignore'))).toBe(false)
  })
})
