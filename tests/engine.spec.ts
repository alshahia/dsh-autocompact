import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { LlmRuntime, createUserMessage, createMessage, LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import BasicCompactionEngine from '@deepseek-ai/dsh-compaction-basic'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { HandoffVolatileConfig } from '../src/config.ts'
import AutocompactEngine from '../src/index.ts'

const SIGNAL = new AbortController().signal
const MODEL = 'test-model'
const SESSION_ID = 'conversation-4'

class WindowAdapter extends LlmAdapter {
  constructor(private readonly contextWindow: number) {
    super()
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({
      provider,
      id: model,
      name: model,
      context: { contextWindow: this.contextWindow },
    })
  }

  override async * stream(): AsyncIterable<StreamChunk> {
    yield { type: 'text-delta', index: 0, text: 'checkpoint' }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

function createContext(window = 1000): Context {
  const ctx = new Context()
  void new LlmRuntime(ctx)
  void new SessionProjectionRegistry(ctx)
  void new TokenMeter(ctx)
  ctx.llm.registerAdapter([MODEL, 'actual', 'unlisted-provider'], new WindowAdapter(window))
  return ctx
}

function agent(session: Session): Agent {
  return { session, options: { provider: MODEL, model: MODEL } } as Agent
}

/** Closed two-message turns followed by one open turn (fork fixture). */
function conversation(turns = 4, text = 'fixture '.repeat(40).trim()): Session {
  const session = Session.create(SessionId('conversation-' + turns))
  for (let turn = 1; turn <= turns; turn += 1) {
    session.append('turn/start', { turn })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: text + ' user ' + turn }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    session.append('step/start', { turn, step: 1 })
    if (turn === 1) {
      session.append('request/header', {
        header: { config: { provider: MODEL, model: MODEL } },
        reason: 'initial',
      })
    }
    session.append('assistant/message', {
      stream: [],
      turn,
      step: 1,
      message: createMessage({
        role: 'assistant',
        content: [{ type: 'text', text: text + ' assistant ' + turn }],
        source: { kind: 'model', provider: MODEL, model: MODEL },
      }),
    }, { surfaceOp: 'append' })
    session.append('step/end', { turn, step: 1 })
    session.append('turn/end', { turn, reason: { kind: 'completed' } })
  }
  session.append('turn/start', { turn: turns + 1 })
  return session
}

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'autocompact-engine-'))
  dirs.push(dir)
  return dir
}

/**
 * Build an engine over a MUTABLE plain configuration. The live reader accepts a
 * plain object exactly like the loader's volatile references, so mutating it is
 * the same event as a settings-card edit — no file, no polling.
 */
function engine(archiveRoot: string, config: Record<string, unknown> = {}): {
  compact: AutocompactEngine
  live: HandoffVolatileConfig
} {
  const live = { archive: { root: archiveRoot }, ...config } as unknown as HandoffVolatileConfig
  return { compact: new AutocompactEngine(createContext(1000), live), live }
}

function headText(session: Session): string {
  const head = session.deriveMessages()[0]!
  return head.content.map(block => block.type === 'text' ? block.text : '').join('')
}

function archiveNames(root: string, sessionId: string): string[] {
  return existsSync(join(root, sessionId)) ? readdirSync(join(root, sessionId)) : []
}

describe('AutocompactEngine', () => {
  it('is a BasicCompactionEngine subclass with the parent service contract', () => {
    expect(AutocompactEngine.prototype instanceof BasicCompactionEngine).toBe(true)
    expect(AutocompactEngine.inject).toEqual(BasicCompactionEngine.inject)
  })

  it('auto-fires at the absolute token threshold, archives, and puts the pointer in the checkpoint', async () => {
    const root = tempRoot()
    const { compact } = engine(root, { trigger: { tokens: 500 }, retain: { tokens: 100 } })
    const session = conversation(4)
    const result = await compact.compactIfNeeded(agent(session), 'pressure', SIGNAL)
    expect(result).not.toBeNull()

    const entries = archiveNames(root, SESSION_ID)
    expect(entries).toContain('index.md')
    const archiveDir = entries.find(name => /^\d{3}-/.test(name))
    expect(archiveDir).toBeDefined()
    expect(readdirSync(join(root, SESSION_ID, archiveDir!)).sort())
      .toEqual(['conversation.md', 'handoff.md'])
    const index = readFileSync(join(root, SESSION_ID, 'index.md'), 'utf8')
    expect(index).toContain(archiveDir!)
    expect(index).toContain(MODEL + '/' + MODEL)

    const text = headText(session)
    expect(text).toContain('<compacted-summary>')
    expect(text).toContain('**Handoff archive:**')
    expect(text).toContain('/conversation.md')
  })

  it('does not fire below the absolute threshold', async () => {
    const root = tempRoot()
    const { compact } = engine(root, { trigger: { tokens: 500 }, retain: { tokens: 100 } })
    const session = conversation(1)
    await expect(compact.compactIfNeeded(agent(session), 'pressure', SIGNAL)).resolves.toBeNull()
    expect(archiveNames(root, 'conversation-1')).toEqual([])
  })

  it('disabled preset never auto-fires', async () => {
    const root = tempRoot()
    const { compact } = engine(root, {
      trigger: { tokens: 500 }, retain: { tokens: 100 },
      models: [{ provider: MODEL, model: MODEL, disabled: true }],
    })
    const session = conversation(4)
    await expect(compact.compactIfNeeded(agent(session), 'pressure', SIGNAL)).resolves.toBeNull()
    expect(archiveNames(root, SESSION_ID)).toEqual([])
  })

  it('overflow trigger delegates to the parent unchanged', async () => {
    const root = tempRoot()
    const { compact } = engine(root, { trigger: { tokens: 500 }, retain: { tokens: 100 } })
    const parentSpy = vi.spyOn(BasicCompactionEngine.prototype, 'compactIfNeeded')
      .mockResolvedValue(null)
    try {
      const session = conversation(1)
      const sessionAgent = agent(session)
      await expect(compact.compactIfNeeded(sessionAgent, 'context-overflow', SIGNAL))
        .resolves.toBeNull()
      expect(parentSpy).toHaveBeenCalledTimes(1)
      expect(parentSpy).toHaveBeenCalledWith(sessionAgent, 'context-overflow', SIGNAL)
      expect(archiveNames(root, 'conversation-1')).toEqual([])
    } finally {
      parentSpy.mockRestore()
    }
  })

  it('archive failure under onFailure:block aborts compaction and leaves the surface unchanged', async () => {
    const root = tempRoot()
    const { compact } = engine(root, { trigger: { tokens: 500 }, retain: { tokens: 100 } })
    const session = conversation(4)
    // A plain file where the session archive directory must be created blocks the write.
    writeFileSync(join(root, SESSION_ID), 'blocked')
    const nodesBefore = session.surface.nodes.length
    const generationBefore = session.surface.replaceGeneration
    await expect(compact.compactIfNeeded(agent(session), 'pressure', SIGNAL)).rejects.toThrow()
    expect(session.surface.nodes.length).toBe(nodesBefore)
    expect(session.surface.replaceGeneration).toBe(generationBefore)
  })

  it('a live edit changes the next pressure check', async () => {
    const root = tempRoot()
    // The 4-turn fixture keeps the shadowed span well above the framed
    // checkpoint price (the shrink guard rejects tiny spans).
    const { compact, live } = engine(root, { trigger: { tokens: 6000 }, retain: { tokens: 50 } })
    const session = conversation(4)
    await expect(compact.compactIfNeeded(agent(session), 'pressure', SIGNAL)).resolves.toBeNull()

    // The same mutation a settings-card write performs on the live reference.
    ;(live as unknown as { trigger: { tokens: number } }).trigger.tokens = 500
    expect(compact.handoffConfig.trigger.tokens).toBe(500)

    await expect(compact.compactIfNeeded(agent(session), 'pressure', SIGNAL)).resolves.not.toBeNull()
    expect(archiveNames(root, SESSION_ID).length).toBeGreaterThan(0)
    expect(headText(session)).toContain('**Handoff archive:**')
  })

  it('enabled:false is the master switch: no pressure compaction, no archive', async () => {
    const root = tempRoot()
    const { compact } = engine(root, { trigger: { tokens: 500 }, retain: { tokens: 100 }, enabled: false })
    const session = conversation(4)
    await expect(compact.compactIfNeeded(agent(session), 'pressure', SIGNAL)).resolves.toBeNull()
    expect(archiveNames(root, SESSION_ID)).toEqual([])
  })

  it('enabled:false still delegates context-overflow to the parent (session safety)', async () => {
    const root = tempRoot()
    const { compact } = engine(root, { trigger: { tokens: 500 }, retain: { tokens: 100 }, enabled: false })
    const parentSpy = vi.spyOn(BasicCompactionEngine.prototype, 'compactIfNeeded')
      .mockResolvedValue(null)
    try {
      const session = conversation(1)
      const sessionAgent = agent(session)
      await expect(compact.compactIfNeeded(sessionAgent, 'context-overflow', SIGNAL))
        .resolves.toBeNull()
      expect(parentSpy).toHaveBeenCalledTimes(1)
      expect(parentSpy).toHaveBeenCalledWith(sessionAgent, 'context-overflow', SIGNAL)
    } finally {
      parentSpy.mockRestore()
    }
  })

  it('a live enabled:false disables auto-compact mid-flight; re-enabling restores it', async () => {
    const root = tempRoot()
    const { compact, live } = engine(root, { trigger: { tokens: 500 }, retain: { tokens: 100 } })
    const session = conversation(4)
    await expect(compact.compactIfNeeded(agent(session), 'pressure', SIGNAL)).resolves.not.toBeNull()

    ;(live as { enabled?: boolean }).enabled = false
    expect(compact.handoffConfig.enabled).toBe(false)
    await expect(compact.compactIfNeeded(agent(session), 'pressure', SIGNAL)).resolves.toBeNull()

    ;(live as { enabled?: boolean }).enabled = true
    expect(compact.handoffConfig.enabled).toBe(true)
    // Re-enable restores the trigger on a FRESH session: the earlier compaction
    // of `session` already pulled its measurement below any useful threshold.
    const session2 = conversation(4)
    await expect(compact.compactIfNeeded(agent(session2), 'pressure', SIGNAL)).resolves.not.toBeNull()
  })

  it('a window-relative retain above the resolved threshold clamps instead of poisoning (Decision A)', async () => {
    const root = tempRoot()
    // configured retain = 0.9 x 1000 = 900 >= trigger 500; clamped to 499.
    const { compact } = engine(root, { trigger: { tokens: 500 }, retain: { ratio: 0.9 } })
    expect(compact.handoffConfig.retain.ratio).toBe(0.9)
    const session = conversation(4)
    // Whatever the underlying guard decides about the now-small span, the config
    // poison must be gone: either it compacts, the shrink guard rejects this one
    // attempt (a per-attempt, content-driven error the run loop handles by
    // continuing the turn), or no range qualifies. What may NOT happen is the
    // old per-target feign-failure silent forever-off.
    const ordered = compact.compactIfNeeded(agent(session), 'pressure', SIGNAL)
    await expect(ordered.then(() => 'compactOrEmpty' as const, error => {
      if (!/summary is not smaller|no safe range|unable/i.test(String(error))) throw error
      return 'guardRejectedThisAttempt' as const
    })).resolves.toBeDefined()
    expect(compact.previewPressure(agent(session), 1000).retainClamped).toBe(true)
  })

  it('previews pressure against the project that owns the session', () => {
    const root = tempRoot()
    const { compact } = engine(root, { trigger: { tokens: 500 }, retain: { tokens: 100 } })
    const session = conversation(1)
    const preview = compact.previewPressure(agent(session), 1000)
    expect(preview.thresholdTokens).toBe(500)
    expect(typeof preview.thresholdSource).toBe('string')
    expect(preview.archiveRoot).toBe(root)
    expect(preview.projectDir).toBe(process.cwd())
    expect(preview.pluginEnabled).toBe(true)
    expect(preview.measuredTokens).toBeGreaterThan(0)
  })

  it('reports a project-scoped archive root from the session creation directory', () => {
    const root = tempRoot()
    const project = join(root, 'project')
    const { compact } = engine(root, { trigger: { tokens: 500 } })
    const session = conversation(1)
    const scoped = { session, options: {} } as unknown as Agent
    Object.defineProperty(session, 'header', { value: { cwd: project }, configurable: true })
    const preview = compact.previewPressure(scoped, 1000)
    expect(preview.projectDir).toBe(project)
    // The configured absolute root still wins over the project directory.
    expect(preview.archiveRoot).toBe(root)
  })
})
