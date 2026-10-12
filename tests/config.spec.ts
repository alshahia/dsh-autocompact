import { describe, expect, it } from 'vitest'
import z from '@deepseek-ai/schemastery'
import { resolveConfig } from '@deepseek-ai/dsh-compaction-basic/src/config.ts'
import { LiveConfigReader, autocompactConfig, resolvePreset, toBasicConfig } from '../src/config.ts'
import type { HandoffVolatileConfig } from '../src/config.ts'

type Live = Record<string, { get(): unknown }>

/** Resolve a persisted settings document the way the loader does. */
function resolveDocument(doc: Record<string, unknown>): Live {
  const [resolved] = z.resolve(doc, autocompactConfig, {}) as unknown as [Live, unknown]
  return resolved
}

function read(raw: unknown, warn: (message: string) => void = () => {}) {
  return new LiveConfigReader(warn).read(raw as HandoffVolatileConfig)
}

describe('autocompactConfig', () => {
  it('resolves an empty document and exposes every section as a live reference', () => {
    // Volatility must be legal: Schema.resolve runs validateVolatileSchema first,
    // which throws when a volatile node sits in a blocked position (nested
    // volatile, array item, dict value). This test is that guard.
    const resolved = resolveDocument({})
    for (const key of ['enabled', 'trigger', 'retain', 'archive', 'summarization', 'retries', 'models']) {
      expect(typeof resolved[key]?.get, `${key} is live`).toBe('function')
    }
    expect(resolved.enabled!.get()).toBe(true)
    expect(resolved.trigger!.get()).toMatchObject({ mode: 'first', ratio: 0, tokens: 0 })
    expect(resolved.archive!.get()).toMatchObject({ root: '.dsh/handoffs', gitIgnore: true })
    expect(resolved.summarization!.get()).toMatchObject({ maxTokens: 8192 })
    expect(resolved.retries!.get()).toMatchObject({ compactionRetries: 1, maxOverflowRetries: 1 })
  })

  it('round-trips a partial user document and keeps untouched fields at their defaults', () => {
    const resolved = resolveDocument({ trigger: { tokens: 500 }, archive: { root: 'handoffs' } })
    expect(resolved.trigger!.get()).toMatchObject({ mode: 'first', tokens: 500, ratio: 0 })
    expect(resolved.archive!.get()).toMatchObject({ root: 'handoffs', gitIgnore: true })
    expect((resolved.models!.get() as unknown[]).length).toBe(0)
  })

  it('resolves per-model presets as array items of a volatile array', () => {
    const resolved = resolveDocument({ models: [{ provider: 'p', model: 'm', disabled: true }] })
    const presets = resolved.models!.get() as Array<Record<string, unknown>>
    expect(presets).toHaveLength(1)
    expect(presets[0]).toMatchObject({ provider: 'p', model: 'm', disabled: true })
  })
})

describe('LiveConfigReader', () => {
  it('applies the upstream 0.8 trigger default only when nothing was configured', () => {
    expect(read({}).trigger).toMatchObject({ mode: 'first', ratio: 0.8 })
    expect(read({ trigger: { mode: 'tokens' } }).trigger).toMatchObject({ mode: 'tokens', ratio: 0.8 })
  })

  it('leaves ratio unset when an absolute trigger is configured alone', () => {
    const config = read({ trigger: { mode: 'tokens', tokens: 200 } })
    expect(config.trigger.tokens).toBe(200)
    expect(config.trigger.ratio).toBeUndefined()
  })

  it('reads a live document exactly like a plain test object', () => {
    const fromPlain = read({ trigger: { tokens: 700 } }).trigger
    const fromLive = new LiveConfigReader(() => {}).read(resolveDocument({ trigger: { tokens: 700 } }) as unknown as HandoffVolatileConfig)
    expect(fromLive.trigger).toEqual(fromPlain)
  })

  it('defaults the archive section to project-local and self-ignoring', () => {
    expect(read({}).archive).toEqual({ root: '.dsh/handoffs', gitIgnore: true, onFailure: 'block' })
  })

  it('lets tokens win over a window ratio for retention, with one notice', () => {
    const warnings: string[] = []
    const config = read({ retain: { ratio: 0.5, tokens: 42 } }, m => warnings.push(m))
    expect(config.retain).toMatchObject({ tokens: 42 })
    expect(config.retain.ratio).toBeUndefined()
    expect(warnings.filter(w => w.includes('retain'))).toHaveLength(1)
  })

  it('drops a half-written summarization pair wholesale, with one notice', () => {
    const warnings: string[] = []
    const config = read({ summarization: { provider: 'only-provider' } }, m => warnings.push(m))
    expect(config.summarization).toEqual({ provider: '', model: '', maxTokens: 8192 })
    expect(warnings.filter(w => w.includes('summarization'))).toHaveLength(1)
  })

  it('drops presets that cannot match a target and keeps the first of a duplicate', () => {
    const warnings: string[] = []
    const config = read({
      models: [
        { provider: 'p' },
        { provider: 'p', model: 'm', trigger: { tokens: 10 } },
        { provider: 'p', model: 'm', trigger: { tokens: 99 } },
      ],
    }, m => warnings.push(m))
    expect(config.models).toHaveLength(1)
    expect(config.models[0]?.trigger).toMatchObject({ tokens: 10 })
    expect(warnings.length).toBeGreaterThanOrEqual(2)
  })

  it('reports each distinct problem once per resolved generation', () => {
    const warnings: string[] = []
    const reader = new LiveConfigReader(m => warnings.push(m))
    reader.read({ retain: { ratio: 0.5, tokens: 42 } } as HandoffVolatileConfig)
    reader.read({ retain: { ratio: 0.5, tokens: 42 } } as HandoffVolatileConfig)
    expect(warnings, warnings.join(' | ')).toHaveLength(1)
    // An edit that changes the resolved values re-arms the notice...
    reader.read({ retain: { ratio: 0.5, tokens: 43 } } as HandoffVolatileConfig)
    expect(warnings, warnings.join(' | ')).toHaveLength(2)
    // ...while an edit that normalization erases does not: the same conflict is
    // still present, so re-reporting it would only spam the log.
    reader.read({ retain: { ratio: 0.6, tokens: 43 } } as HandoffVolatileConfig)
    expect(warnings, warnings.join(' | ')).toHaveLength(2)
  })

  it('honors the master switch', () => {
    expect(read({ enabled: false }).enabled).toBe(false)
    expect(read({}).enabled).toBe(true)
  })

  it('never throws on hostile or half-edited values', () => {
    for (const raw of [
      undefined, null, {}, { trigger: { ratio: 'nope' } }, { retain: { tokens: -5 } },
      { models: 'nope' }, { models: [{ provider: 'p', model: 'm', trigger: { ratio: 99 } }] },
      { archive: { root: '' } }, { archive: { onFailure: 'nonsense' } }, { summarization: { maxTokens: 0 } },
    ]) {
      expect(() => read(raw), JSON.stringify(raw)).not.toThrow()
    }
  })
})

describe('toBasicConfig', () => {
  it('always enables the upstream automatic path and mirrors the trigger ratio', () => {
    const basic = toBasicConfig(read({}))
    expect(basic.auto).toBe(true)
    expect(basic.thresholdRatio).toBe(0.8)
    expect(basic.retainRatio).toBeUndefined()
    expect(basic.maxTokens).toBe(8192)
  })

  it('omits retainRatio whenever the parent would reject it', () => {
    expect(toBasicConfig(read({ retain: { tokens: 10 } })).retainRatio).toBeUndefined()
    expect(toBasicConfig(read({ trigger: { ratio: 0.9 }, retain: { ratio: 0.5 } })).retainRatio).toBe(0.5)
    // At or above the fire-at level: omitted, because the engine clamps instead.
    expect(toBasicConfig(read({ trigger: { ratio: 0.5 }, retain: { ratio: 0.5 } })).retainRatio).toBeUndefined()
  })

  it('carries only the preset fields that were configured', () => {
    const basic = toBasicConfig(read({
      models: [{ provider: 'p', model: 'm', trigger: { tokens: 10 }, summarization: { provider: 'x', model: 'y' } }],
    }))
    expect(basic.modelPolicies).toEqual([
      { provider: 'p', model: 'm', summarizationProvider: 'x', summarizationModel: 'y' },
    ])
  })

  it('projects into a configuration the upstream engine actually accepts', () => {
    // The parent validator is stricter than the live reader, and it must never be
    // handed something it rejects: a mid-edit document has to stay adoptable.
    for (const raw of [
      {}, { trigger: { tokens: 100 }, retain: { tokens: 100 } }, { trigger: { ratio: 0.99 }, retain: { ratio: 1 } },
      { trigger: { tokens: 1 }, retain: { ratio: 0.9 } }, { summarization: { maxTokens: 100000 } },
      { retries: { compactionRetries: 0, maxOverflowRetries: 0 } },
      { models: [{ provider: 'p', model: 'm', retain: { tokens: 5 } }] },
    ]) {
      const basic = toBasicConfig(read(raw))
      expect(() => resolveConfig(basic as never), JSON.stringify(raw)).not.toThrow()
    }
  })
})

describe('resolvePreset', () => {
  it('matches provider and model exactly and tolerates a missing target', () => {
    const config = read({ models: [{ provider: 'p', model: 'm' }, { provider: 'p', model: 'other' }] })
    expect(resolvePreset(config, { provider: 'p', model: 'm' })).toMatchObject({ model: 'm' })
    expect(resolvePreset(config, { provider: 'p', model: 'other' })).toMatchObject({ model: 'other' })
    expect(resolvePreset(config, undefined)).toBeUndefined()
    expect(resolvePreset(config, { provider: 'p', model: 'absent' })).toBeUndefined()
  })
})
