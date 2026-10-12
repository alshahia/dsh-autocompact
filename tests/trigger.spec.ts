import { describe, expect, it } from 'vitest'
import { TargetPressureConfigError } from '@deepseek-ai/dsh-compaction-basic/src/config.ts'
import { LiveConfigReader, resolvePreset } from '../src/config.ts'
import type { HandoffVolatileConfig } from '../src/config.ts'
import { resolveHandoffSpec, wouldFire } from '../src/trigger.ts'

/** Read a document-shaped config exactly as the engine does at call time. */
function read(raw: unknown) {
  return new LiveConfigReader(() => {}).read(raw as HandoffVolatileConfig)
}

describe('resolveHandoffSpec', () => {
  it('mode first: min(ratio threshold, tokens)', () => {
    const c = read({ trigger: { mode: 'first', ratio: 0.5, tokens: 300 }, retain: { tokens: 10 } })
    const spec = resolveHandoffSpec(c, undefined, 1000)
    expect(spec.thresholdTokens).toBe(300) // min(500, 300)
    expect(spec.retainTokens).toBe(10)
  })

  it('mode tokens: absolute wins when set; ratio is the fallback', () => {
    const c = read({ trigger: { mode: 'tokens', ratio: 0.5, tokens: 300 }, retain: { tokens: 10 } })
    expect(resolveHandoffSpec(c, undefined, 1000).thresholdTokens).toBe(300)
    const c2 = read({ trigger: { mode: 'tokens', ratio: 0.5 }, retain: { tokens: 10 } })
    expect(resolveHandoffSpec(c2, undefined, 1000).thresholdTokens).toBe(500)
  })

  it('ratio only; default mode is first', () => {
    const c = read({ trigger: { ratio: 0.8 }, retain: { tokens: 10 } })
    expect(resolveHandoffSpec(c, undefined, 1000).thresholdTokens).toBe(800)
  })

  it('no limits configured: inherits the upstream 0.8 default', () => {
    const c = read({})
    expect(resolveHandoffSpec(c, undefined, 1000).thresholdTokens).toBe(800)
  })

  it('an absolute limit configured alone stays window-free', () => {
    // The schema default for ratio must not silently make this window-relative:
    // an adapter that declares no context window still has to fire.
    const c = read({ trigger: { mode: 'tokens', tokens: 200 }, retain: { tokens: 10 } })
    expect(c.trigger.ratio).toBeUndefined()
    expect(resolveHandoffSpec(c, undefined, undefined).thresholdTokens).toBe(200)
  })

  it('per-model preset overrides field-wise over globals', () => {
    const c = read({
      trigger: { mode: 'first', ratio: 0.8, tokens: 100 },
      models: [{ provider: 'deepseek', model: 'deepseek-chat', trigger: { tokens: 200000 } }],
    })
    const preset = resolvePreset(c, { provider: 'deepseek', model: 'deepseek-chat' })
    const spec = resolveHandoffSpec(c, preset, 1000)
    expect(spec.thresholdTokens).toBe(200000) // preset tokens wins over the global pair; mode still first
  })

  it('disabled preset reports disabled and wouldFire=false', () => {
    const c = read({
      trigger: { tokens: 10 },
      models: [{ provider: 'p', model: 'm', disabled: true }],
    })
    const spec = resolveHandoffSpec(c, resolvePreset(c, { provider: 'p', model: 'm' }), 1000)
    expect(spec.disabled).toBe(true)
    expect(wouldFire(spec, 1000)).toBe(false)
  })

  it('pure-tokens mode works without a window; ratio-based fields require one', () => {
    const c = read({ trigger: { mode: 'tokens', tokens: 200 }, retain: { tokens: 10 } })
    expect(resolveHandoffSpec(c, undefined, undefined).thresholdTokens).toBe(200)
    const c2 = read({ trigger: { ratio: 0.8 } })
    expect(() => resolveHandoffSpec(c2, undefined, undefined)).toThrow(TargetPressureConfigError)
  })

  it('a window-relative retain exceeding the resolved threshold is clamped to threshold-1 (Decision A)', () => {
    // ratio-retain is window-relative, so load-time cannot reject; resolve clamps.
    const c = read({ trigger: { tokens: 100 }, retain: { ratio: 0.9 } })
    const spec = resolveHandoffSpec(c, undefined, 1000)
    expect(spec.thresholdTokens).toBe(100)
    expect(spec.retainClamped).toBe(true)
    expect(spec.retainTokens).toBe(99) // Math.max(threshold - 1, 0)
    expect(wouldFire(spec, 150)).toBe(true)
  })

  it('an absolute retain at or above the absolute trigger is clamped instead of rejected', () => {
    // Live editing must never throw, so the old fail-fast load-time rejection is
    // now a clamp: the engine keeps at least one token of tail.
    const c = read({ trigger: { tokens: 100 }, retain: { tokens: 100 } })
    const spec = resolveHandoffSpec(c, undefined, undefined)
    expect(spec.retainClamped).toBe(true)
    expect(spec.retainTokens).toBe(99)
  })

  it('an in-bound retain is reported unclamped', () => {
    const c = read({ trigger: { tokens: 100 }, retain: { tokens: 10 } })
    const spec = resolveHandoffSpec(c, undefined, undefined)
    expect(spec.retainClamped).toBe(false)
    expect(spec.retainTokens).toBe(10)
  })
})

describe('wouldFire', () => {
  it('fires only at or above the threshold', () => {
    const c = read({ trigger: { tokens: 100 } })
    const spec = resolveHandoffSpec(c, undefined, undefined)
    expect(wouldFire(spec, 99)).toBe(false)
    expect(wouldFire(spec, 100)).toBe(true)
  })
})
