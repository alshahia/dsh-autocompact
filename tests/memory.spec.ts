import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { LlmRuntime } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import type { TokenMeasurement } from '@deepseek-ai/dsh-token-meter'
import { selectCompactableRange } from '@deepseek-ai/dsh-compaction-basic/src/region.ts'
import { spanIsCommittable } from '../src/drop.ts'
import {
  buildMap,
  parseSeqList,
  parseSelection,
  planDrop,
  renderTombstone,
  resolveBudget,
  resolveSelection,
  retainTokensFor,
  stepMarkers,
} from '../src/memory.ts'
import type { ResolvedHandoffConfig } from '../src/types.ts'

const MODEL = 'test-model'

/** The services the meter needs, exactly as the engine's own tests build them. */
function createContext(): Context {
  const ctx = new Context()
  void new LlmRuntime(ctx)
  void new SessionProjectionRegistry(ctx)
  void new TokenMeter(ctx)
  return ctx
}

/** A resolved configuration with every default at its documented value. */
function config(overrides: Partial<ResolvedHandoffConfig> = {}): ResolvedHandoffConfig {
  return {
    trigger: { mode: 'first', ratio: 0.8 },
    retain: { tokens: 500 },
    archive: { root: '.dsh/handoffs', gitIgnore: true, onFailure: 'block' },
    summarization: { provider: '', model: '', maxTokens: 8192 },
    retries: { compactionRetries: 1, maxOverflowRetries: 1 },
    enabled: true,
    models: [],
    memory: {
      enabled: true,
      budget: { ratio: 0.3, denominator: 'surface', warnAt: 0.9 },
      limits: { minFreedTokens: 50, maxOpsPerTurn: 2, mapTokens: 1500 },
      policy: { protectUserMessages: true, archiveOnDrop: 'block', recallMaxTokens: 1200 },
    },
    ...overrides,
  }
}

/** A measurement stub for the pure budget arithmetic. */
function measured(surfaceTokens: number, totalTokens = surfaceTokens): TokenMeasurement {
  return { surfaceTokens, totalTokens, nodes: [] } as unknown as TokenMeasurement
}

function conversation(turns: number, text = 'fixture '.repeat(200).trim()): Session {
  const session = Session.create(SessionId('memory-' + turns))
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

const price = (text: string): number => Math.ceil(text.length / 4)

/** The map a test plans against: a 100-token retained tail. */
function mapped(session: Session, context: Context, pins: ReadonlySet<number> = new Set()) {
  const measurement = context.tokenMeter.measure(session)
  const cut = selectCompactableRange(session, measurement, 500)
  return buildMap({
    session,
    measurement,
    pins,
    tombstones: new Set(),
    droppableEnd: cut === null ? null : cut.end,
    droppableReason: 'a 500-token retained tail',
  })
}

describe('resolveBudget', () => {
  it('bands on the chosen denominator against a ratio of the context window', () => {
    const budget = config().memory.budget
    expect(resolveBudget(budget, measured(400), 2000).band).toBe('ok')
    expect(resolveBudget(budget, measured(540), 2000)).toMatchObject({
      band: 'warn', budgetTokens: 600, warnTokens: 540, headroomTokens: 60, budgetSource: 'ratio',
    })
    expect(resolveBudget(budget, measured(599), 2000).band).toBe('warn')
    expect(resolveBudget(budget, measured(600), 2000).band).toBe('at-limit')
  })

  it('uses an absolute budget when no context window can be resolved', () => {
    const budget = { ...config().memory.budget, tokens: 500 }
    expect(resolveBudget(budget, measured(100), undefined)).toMatchObject({
      band: 'ok', budgetTokens: 500, budgetSource: 'tokens', contextWindow: null, wallHeadroomTokens: null,
    })
    expect(resolveBudget(budget, measured(500), undefined).band).toBe('at-limit')
  })

  it('takes the smaller of a ratio and an absolute budget, so either limit fires first', () => {
    const budget = { ...config().memory.budget, tokens: 400 }
    expect(resolveBudget(budget, measured(100), 2000)).toMatchObject({ budgetTokens: 400, budgetSource: 'ratio+tokens' })
    expect(resolveBudget(budget, measured(450), 1000)).toMatchObject({ budgetTokens: 300, budgetSource: 'ratio+tokens' })
  })

  it('reports an unknown band rather than guessing when neither limit resolves', () => {
    expect(resolveBudget(config().memory.budget, measured(900), undefined)).toMatchObject({
      band: 'unknown', budgetTokens: null, warnTokens: null, headroomTokens: null,
    })
  })

  it('compares the total request when the denominator is total, and prices the wall separately', () => {
    const budget = { ...config().memory.budget, denominator: 'total' as const }
    const picture = resolveBudget(budget, measured(100, 280), 1000)
    expect(picture).toMatchObject({ band: 'warn', usedTokens: 280, surfaceTokens: 100, wallHeadroomTokens: 720 })
    expect(resolveBudget(budget, measured(100, 700), 1000)).toMatchObject({ band: 'at-limit', usedTokens: 700 })
  })
})

describe('retainTokensFor', () => {
  it('prefers the configured absolute tail, then its ratio, then a documented fallback', () => {
    expect(retainTokensFor(config(), 8000, 2400)).toBe(500)
    expect(retainTokensFor(config({ retain: { ratio: 0.25 } }), 8000, 2400)).toBe(2000)
    expect(retainTokensFor(config({ retain: {} }), 8000, 10_000)).toBe(2500)
    expect(retainTokensFor(config({ retain: {} }), 8000, 4000)).toBe(2000)
    expect(retainTokensFor(config({ retain: {} }), undefined, null)).toBe(4000)
  })
})

describe('parseSelection', () => {
  it('reads turns, turn.step, and ascending ranges', () => {
    expect(parseSelection('3').selectors).toEqual([{ turn: 3 }])
    expect(parseSelection('3.1').selectors).toEqual([{ turn: 3, step: 1 }])
    expect(parseSelection('1-3').selectors).toEqual([{ turn: 1, toTurn: 3 }])
    expect(parseSelection('3.1-3.3').selectors).toEqual([{ turn: 3, step: 1, toStep: 3 }])
    expect(parseSelection('2, 4.1, 5-6').selectors).toEqual([
      { turn: 2 }, { turn: 4, step: 1 }, { turn: 5, toTurn: 6 },
    ])
    expect(parseSelection('').selectors).toEqual([])
  })

  it('reports what it could not read instead of guessing', () => {
    expect(parseSelection('2,x,0,9-3').invalid).toEqual(['x', '0', '9-3'])
    expect(parseSelection('1-900').invalid).toEqual(['1-900'])
    expect(parseSelection('1.1-1.999').invalid).toEqual(['1.1-1.999'])
    expect(parseSelection('1.1-3.2').invalid).toEqual(['1.1-3.2'])
    expect(parseSelection('2,x').selectors).toEqual([{ turn: 2 }])
  })

  it('keeps surface seqs a separate grammar from steps', () => {
    expect(parseSeqList('12, 15-18').seqs).toEqual([12, 15, 16, 17, 18])
    expect(parseSeqList('12.3').invalid).toEqual(['12.3'])
    expect(parseSeqList('15-12').invalid).toEqual(['15-12'])
  })
})

describe('resolveSelection', () => {
  it('resolves bare turns and step ranges against the steps the surface holds', () => {
    const keys = ['1.1', '1.2', '2.1', '2.2', '3.1']
    expect(resolveSelection(parseSelection('2').selectors, keys).keys).toEqual(['2.1', '2.2'])
    expect(resolveSelection(parseSelection('2.2').selectors, keys).keys).toEqual(['2.2'])
    expect(resolveSelection(parseSelection('1-2').selectors, keys).keys).toEqual(['1.1', '1.2', '2.1', '2.2'])
    expect(resolveSelection(parseSelection('1.1-1.2').selectors, keys).keys).toEqual(['1.1', '1.2'])
    expect(resolveSelection(parseSelection('9').selectors, keys)).toMatchObject({ keys: [], unknown: ['9'] })
    expect(resolveSelection(parseSelection('2.9').selectors, keys)).toMatchObject({ keys: [], unknown: ['2.9'] })
  })
})

describe('the surface map and drop planning', () => {
  it('keys every node by turn.step and marks the droppable head from the retained tail', () => {
    const ctx = createContext()
    const session = conversation(4)
    const map = mapped(session, ctx)
    expect(map.aligned).toBe(true)
    expect(map.steps).toEqual(['1.1', '2.1', '3.1', '4.1'])
    expect(stepMarkers(session).map(marker => marker.turn)).toEqual([1, 2, 3, 4])
    expect(map.entries[0]).toMatchObject({ role: 'user', turn: 1, step: 1, key: '1.1', droppable: true, pinned: false })
    expect(map.entries[map.entries.length - 1]!.droppable).toBe(false)
    // The preview is the first 120 characters of the node's text.
    expect(map.entries[0]!.preview.startsWith('fixture')).toBe(true)
  })

  it('plans a drop that is balanced, priced against its tombstone, and refused when empty', () => {
    const ctx = createContext()
    const session = conversation(4)
    const map = mapped(session, ctx)
    const plan = planDrop({
      session, map, selectors: parseSelection('1-2').selectors,
      config: config().memory, priceText: price, pointer: '/archive/session/<next>/',
    })
    expect(plan.ok).toBe(true)
    expect(plan.steps).toEqual(['1.1', '2.1'])
    expect(plan.shadowedSeqs.length).toBe(4)
    expect(plan.tombstone).toContain('[dsh-autocompact] Dropped 2 finished step(s)')
    expect(plan.tombstone).toContain('/archive/session/<next>/')
    expect(plan.tombstone).toContain('user 1')
    expect(plan.tombstone).toContain('user 2')
    expect(plan.tombstone).toContain('recall')
    expect(plan.freedTokens).toBe(plan.shadowedHeuristicTokens - plan.tombstoneTokens)
    expect(plan.freedTokens).toBeGreaterThan(config().memory.limits.minFreedTokens)
    expect(plan.blockers).toEqual([])

    const empty = planDrop({ session, map, selectors: [], config: config().memory, priceText: price, pointer: '/a/' })
    expect(empty.ok).toBe(false)
    expect(empty.blockers.join(' ')).toContain('no steps were selected')
  })

  it('refuses unknown steps, steps that straddle the tail, pinned seqs, and a worthless drop', () => {
    const ctx = createContext()
    const session = conversation(4)
    const map = mapped(session, ctx)
    const base = { session, map, config: config().memory, priceText: price, pointer: '/a/' }

    const unknown = planDrop({ ...base, selectors: parseSelection('99').selectors })
    expect(unknown.ok).toBe(false)
    expect(unknown.blockers.join(' ')).toContain('no such step: 99')

    const unknownStep = planDrop({ ...base, selectors: parseSelection('1.7').selectors })
    expect(unknownStep.ok).toBe(false)
    expect(unknownStep.blockers.join(' ')).toContain('no such step: 1.7')

    // Turn 4 straddles the retained tail, so it is refused rather than halved.
    const retained = planDrop({ ...base, selectors: parseSelection('4').selectors })
    expect(retained.ok).toBe(false)
    expect(retained.blockers.join(' ')).toContain('not entirely inside the droppable head')

    const pinnedSeq = map.entries[0]!.seq
    const pinned = planDrop({
      ...base,
      selectors: parseSelection('1').selectors,
      map: mapped(session, ctx, new Set([Number(pinnedSeq)])),
    })
    expect(pinned.ok).toBe(false)
    expect(pinned.blockers.join(' ')).toContain('is pinned')

    const expensive = planDrop({
      ...base,
      selectors: parseSelection('1').selectors,
      config: { ...config().memory, limits: { ...config().memory.limits, minFreedTokens: 1_000_000 } },
    })
    expect(expensive.ok).toBe(false)
    expect(expensive.blockers.join(' ')).toContain('below the 1000000-token floor')
  })

  it('never returns a span that is not a balanced cut, and keeps user text verbatim by default', () => {
    const ctx = createContext()
    const session = conversation(3)
    const map = mapped(session, ctx)
    const plan = planDrop({
      session, map, selectors: parseSelection('1').selectors,
      config: config().memory, priceText: price, pointer: '/a/',
    })
    expect(plan.ok).toBe(true)
    expect(spanIsCommittable(session, plan)).toBeNull()
    expect(plan.protectedText.length).toBe(1)
    expect(plan.tombstone).toContain('Kept verbatim from the dropped span')
    expect(plan.tombstone).toContain('fixture')
  })

  it('protects nothing when the policy turns protection off', () => {
    const ctx = createContext()
    const session = conversation(3)
    const map = mapped(session, ctx)
    const memory = { ...config().memory, policy: { ...config().memory.policy, protectUserMessages: false } }
    const plan = planDrop({ session, map, selectors: parseSelection('1').selectors, config: memory, priceText: price, pointer: '/a/' })
    expect(plan.ok).toBe(true)
    expect(plan.protectedText).toEqual([])
    expect(plan.tombstone).not.toContain('Kept verbatim')
  })

  it('detects a span that changed after it was planned', () => {
    const ctx = createContext()
    const session = conversation(3)
    const plan = planDrop({
      session, map: mapped(session, ctx), selectors: parseSelection('1').selectors,
      config: config().memory, priceText: price, pointer: '/a/',
    })
    const start = plan.shadowedSeqs[0]!
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'replaced by a foreign compaction' }],
      source: { kind: 'user' },
    }), { surfaceOp: { op: 'replace', startSeq: start, endSeq: start }, sourceEventSeqs: [start] })
    expect(spanIsCommittable(session, plan)).toMatch(/no longer on the surface|span changed after it was planned/)
  })

  it('refuses a plan whose surface no longer matches the measurement', () => {
    const ctx = createContext()
    const session = conversation(3)
    const full = ctx.tokenMeter.measure(session)
    const stale = { ...full, nodes: full.nodes.slice(0, 2) } as TokenMeasurement
    const map = buildMap({
      session, measurement: stale, pins: new Set(), tombstones: new Set(),
      droppableEnd: full.nodes[0]!.seq, droppableReason: 'a 500-token retained tail',
    })
    expect(map.aligned).toBe(false)
    const plan = planDrop({
      session, map, selectors: parseSelection('1').selectors,
      config: config().memory, priceText: price, pointer: '/a/',
    })
    expect(plan.ok).toBe(false)
    expect(plan.blockers.join(' ')).toContain('token meter is out of date')
  })
})

describe('renderTombstone', () => {
  it('states what was dropped, where it went, and that nothing was deleted', () => {
    const text = renderTombstone({
      spans: [{ start: 3 as never, end: 9 as never, seqs: [], steps: ['1.1'], shadowedHeuristicTokens: 0, shadowedRouteTokens: 0 }],
      protectedText: ['the original request'],
      outline: ['step 1.1: user, assistant (~120 tokens)'],
      pointer: '/p/session/001-20261013-090000/',
    })
    expect(text).toContain('seqs 3\u20139')
    expect(text).toContain('step 1.1: user, assistant (~120 tokens)')
    expect(text).toContain('the original request')
    expect(text).toContain('/p/session/001-20261013-090000/')
    expect(text).toContain('Nothing was deleted')
  })
})
