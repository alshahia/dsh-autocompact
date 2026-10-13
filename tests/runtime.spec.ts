import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { LlmRuntime, createMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { MemoryRuntime, installMemoryObserver } from '../src/runtime.ts'
import type { ResolvedHandoffConfig } from '../src/types.ts'

const MODEL = 'test-model'
const SIGNAL = new AbortController().signal

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'autocompact-memory-'))
  dirs.push(dir)
  return dir
}

/** A resolved configuration with every default at its documented value. */
function config(overrides: Partial<ResolvedHandoffConfig> = {}): ResolvedHandoffConfig {
  return {
    trigger: { mode: 'first', ratio: 0.8 },
    retain: { tokens: 500 },
    archive: { root: '.dsh/handoffs', gitIgnore: false, onFailure: 'block' },
    summarization: { provider: '', model: '', maxTokens: 8192 },
    retries: { compactionRetries: 1, maxOverflowRetries: 1 },
    enabled: true,
    models: [],
    memory: {
      enabled: true,
      budget: { ratio: 0.3, tokens: 400, denominator: 'surface', warnAt: 0.9 },
      limits: { minFreedTokens: 50, maxOpsPerTurn: 2, mapTokens: 1500 },
      policy: { protectUserMessages: true, archiveOnDrop: 'block', recallMaxTokens: 1200 },
    },
    ...overrides,
  }
}

function conversation(turns: number, text = 'fixture '.repeat(200).trim()): Session {
  const session = Session.create(SessionId('runtime-' + turns))
  for (let turn = 1; turn <= turns; turn += 1) {
    session.append('turn/start', { turn })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: text + ' user ' + turn }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    session.append('step/start', { turn, step: 1 })
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

function agent(session: Session, inject?: (message: UserMessage) => void): Agent {
  return {
    session,
    options: { provider: MODEL, model: MODEL },
    ...(inject === undefined ? {} : { inject }),
  } as unknown as Agent
}

function textsOf(session: Session): string[] {
  return session.deriveMessages().map(message =>
    message.content.map(block => block.type === 'text' ? block.text : '').join(''))
}

/** The services the meter and the runtime need, exactly as the engine's own tests build them. */
function createContext(): Context {
  const ctx = new Context()
  void new LlmRuntime(ctx)
  void new SessionProjectionRegistry(ctx)
  void new TokenMeter(ctx)
  return ctx
}

function setup(root: string, overrides: Partial<ResolvedHandoffConfig> = {}): { runtime: MemoryRuntime; ctx: Context } {
  const ctx = createContext()
  const cfg = config({
    archive: { root, gitIgnore: false, onFailure: 'block' },
    ...overrides,
  })
  return { runtime: new MemoryRuntime({ ctx, config: () => cfg, fallbackDir: root }), ctx }
}

describe('MemoryRuntime.inspect', () => {
  it('reports the pressure picture and a bounded map without touching the session', async () => {
    const root = tempRoot()
    const { runtime } = setup(root)
    const session = conversation(4)
    const seq = session.seq
    const nodes = session.surface.nodes.length
    const text = await runtime.inspect(agent(session), 'summary')
    expect(text).toMatch(/pressure: (OK|WARN|AT-LIMIT|UNKNOWN)/)
    expect(text).toContain('request: ')
    expect(text).toContain('droppable head: ')
    expect(text).toContain('actions: ')
    expect(text).toContain('fixture')
    expect(session.seq).toBe(seq)
    expect(session.surface.nodes.length).toBe(nodes)
  })

  it('lists every node in the full detail mode', async () => {
    const root = tempRoot()
    const { runtime } = setup(root)
    const session = conversation(2)
    const text = await runtime.inspect(agent(session), 'full')
    expect(text).toContain('every surface node:')
    expect(text).toContain('seq ' + session.surface.nodes[0])
  })
})

describe('MemoryRuntime.plan and apply', () => {
  it('changes nothing on a dry run, then archives and queues on apply', async () => {
    const root = tempRoot()
    const { runtime } = setup(root)
    const session = conversation(4)
    const before = session.seq
    const dry = await runtime.plan(agent(session), '1-2', false)
    expect(dry).toContain('plan: drop steps 1.1, 2.1')
    expect(dry).toContain('dry run: nothing changed')
    expect(dry).toContain('protected: 2 user message(s)')
    expect(session.seq).toBe(before)

    const applied = await runtime.plan(agent(session), '1-2', true)
    expect(applied).toContain('queued: steps 1.1, 2.1')
    expect(applied).toContain('Nothing was deleted')
    // The tool call itself never mutates the surface; the archive is already durable.
    expect(session.seq).toBe(before)
    const entries = readdirSync(join(root, 'runtime-4'))
    expect(entries).toContain('index.md')
    const archiveDir = entries.find(name => /^\d{3}-/.test(name))!
    expect(readdirSync(join(root, 'runtime-4', archiveDir)).sort()).toEqual(['conversation.md', 'handoff.md'])

    runtime.flushAtBoundary(session, 4, 2)
    expect(session.surface.nodes.length).toBeLessThan(conversation(4).surface.nodes.length)
    const texts = textsOf(session)
    const tombstone = texts.find(text => text.startsWith('[dsh-autocompact] Dropped'))!
    expect(tombstone).toContain('Dropped 2 finished step(s)')
    expect(tombstone).toContain('user 1')
    expect(tombstone).toContain('user 2')
    expect(tombstone).toContain(archiveDir)
    expect(tombstone).toContain('Nothing was deleted')
    expect(session.snapshotEvents().some(event => event.type === 'compaction/prune')).toBe(true)

    // The receipt is visible to the next inspect, and the queue is gone.
    const after = await runtime.inspect(agent(session), 'summary')
    expect(after).toContain('last drop: dropped steps 1.1, 2.1')
    expect(after).not.toContain('queued: steps 1, 2')
  })

  it('refuses a drop its own planner rejects, with the reason', async () => {
    const root = tempRoot()
    const { runtime } = setup(root)
    const session = conversation(4)
    const unknown = await runtime.plan(agent(session), '99', true)
    expect(unknown).toContain('no such step: 99')
    const retained = await runtime.plan(agent(session), '4', true)
    expect(retained).toContain('not entirely inside the droppable head')
    const junk = await runtime.plan(agent(session), 'two', true)
    expect(junk).toContain('could not read')
    expect(session.surface.nodes.length).toBe(conversation(4).surface.nodes.length)
  })

  it('keeps a pinned node in place until it is unpinned', async () => {
    const root = tempRoot()
    const { runtime } = setup(root)
    const session = conversation(4)
    const first = Number(session.surface.nodes[0])
    const pinned = runtime.pin(agent(session), String(first), false)
    expect(pinned).toContain('pinned ' + first)
    const refused = await runtime.plan(agent(session), '1', true)
    expect(refused).toContain('is pinned')
    expect(runtime.pin(agent(session), String(first), true)).toContain('unpinned ' + first)
    expect(await runtime.plan(agent(session), '1', false)).toContain('plan: drop steps 1.1 (')
  })

  it('blocks the drop when the archive cannot be written and the policy says block', async () => {
    const root = tempRoot()
    const blocker = join(root, 'not-a-directory')
    writeFileSync(blocker, 'plain file')
    const { runtime } = setup(join(blocker, 'sub'))
    const session = conversation(4)
    const before = session.seq
    const refused = await runtime.plan(agent(session), '1-2', true)
    expect(refused).toContain('refused: the dropped span could not be archived')
    expect(refused).toContain('archiveOnDrop="block"')
    expect(session.seq).toBe(before)
    expect(await runtime.inspect(agent(session), 'summary')).not.toContain('queued:')
  })

  it('enforces the per-turn operation budget', async () => {
    const root = tempRoot()
    const { runtime } = setup(root, {
      memory: { ...config().memory, limits: { ...config().memory.limits, maxOpsPerTurn: 1 } },
    })
    const session = conversation(5)
    expect(await runtime.plan(agent(session), '1', true)).toContain('queued: steps 1.1')
    runtime.flushAtBoundary(session, 5, 2)
    const second = await runtime.plan(agent(session), '2', true)
    expect(second).toContain('refused: this turn already dropped history 1 time(s)')
  })

  it('discards a queued drop the surface no longer matches', async () => {
    const root = tempRoot()
    const { runtime } = setup(root)
    const session = conversation(4)
    expect(await runtime.plan(agent(session), '1', true)).toContain('queued: steps 1.1')
    const start = session.surface.nodes[0]!
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'a foreign compaction replaced this' }],
      source: { kind: 'user' },
    }), { surfaceOp: { op: 'replace', startSeq: start, endSeq: start }, sourceEventSeqs: [start] })
    const before = session.seq
    runtime.flushAtBoundary(session, 4, 2)
    expect(session.seq).toBe(before)
    expect(await runtime.inspect(agent(session), 'summary')).toContain('refused at the step boundary')
  })

  it('recalls text from a dropped span archive', async () => {
    const root = tempRoot()
    const { runtime } = setup(root)
    const session = conversation(4)
    await runtime.plan(agent(session), '1-2', true)
    runtime.flushAtBoundary(session, 4, 2)
    const recalled = runtime.recall(agent(session), 'user 2')
    expect(recalled).toContain('conversation.md')
    expect(recalled).toMatch(/hit\(s\)/)
    expect(recalled).toContain('user 2')
    expect(runtime.recall(agent(session), 'nothing-here-at-all')).toContain('no match')
  })
})

describe('MemoryRuntime.advisory', () => {
  it('nudges the model once per pressure episode and only when a drop is possible', async () => {
    const root = tempRoot()
    const { runtime, ctx } = setup(root)
    const session = conversation(4)
    const injected: UserMessage[] = []
    const target = agent(session, message => injected.push(message))
    const measurement = ctx.tokenMeter.measure(session)

    await runtime.advisory(target, SIGNAL, measurement)
    expect(injected).toHaveLength(1)
    const text = injected[0]!.content.map(block => block.type === 'text' ? block.text : '').join('')
    expect(text).toContain('[dsh-autocompact] Context pressure:')
    expect(text).toContain('session_memory')
    await runtime.advisory(target, SIGNAL, measurement)
    expect(injected).toHaveLength(1)
  })

  it('stays silent while pressure is low', async () => {
    const root = tempRoot()
    const { runtime, ctx } = setup(root, {
      memory: { ...config().memory, budget: { ...config().memory.budget, tokens: 100_000 } },
    })
    const session = conversation(4)
    const injected: UserMessage[] = []
    await runtime.advisory(agent(session, message => injected.push(message)), SIGNAL, ctx.tokenMeter.measure(session))
    expect(injected).toHaveLength(0)
  })

  it('stays silent when nothing is droppable', async () => {
    const root = tempRoot()
    const { runtime, ctx } = setup(root, { retain: { tokens: 100_000 } })
    const session = conversation(4)
    const injected: UserMessage[] = []
    await runtime.advisory(agent(session, message => injected.push(message)), SIGNAL, ctx.tokenMeter.measure(session))
    expect(injected).toHaveLength(0)
  })
})

describe('installMemoryObserver', () => {
  it('lands a queued drop synchronously on the next step/start', async () => {
    const root = tempRoot()
    const ctx = createContext()
    const meter = ctx.tokenMeter
    const cfg = config({ archive: { root, gitIgnore: false, onFailure: 'block' } })
    const runtime = new MemoryRuntime({ ctx, config: () => cfg, fallbackDir: root })
    const listeners: Array<(session: Session, event: unknown) => void> = []
    const logging = {
      logger: { info: () => {}, warn: () => {} },
      tokenMeter: meter,
      llm: { resolveModelInfo: () => Promise.reject(new Error('no adapter')) },
      effect: (fn: () => () => void) => { fn() },
      on: (_name: string, listener: (session: Session, event: unknown) => void) => {
        listeners.push(listener)
        return () => {}
      },
    }
    installMemoryObserver(logging as unknown as Context, runtime)
    expect(listeners).toHaveLength(1)

    const session = conversation(3)
    expect(await runtime.plan(agent(session), '1', true)).toContain('queued: steps 1.1')
    const before = session.surface.nodes.length
    for (const listener of listeners) {
      listener(session, { type: 'step/end', data: { turn: 3, step: 1 } })
      listener(session, { type: 'step/start', data: { turn: 3, step: 2 } })
    }
    expect(session.surface.nodes.length).toBe(before - 1)
    expect(textsOf(session).some(text => text.startsWith('[dsh-autocompact] Dropped'))).toBe(true)
    // A landed queue is drained: a second boundary does nothing.
    const landed = session.seq
    for (const listener of listeners) listener(session, { type: 'step/start', data: { turn: 3, step: 3 } })
    expect(session.seq).toBe(landed)
  })
})
