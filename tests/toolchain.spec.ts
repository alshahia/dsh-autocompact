import { describe, expect, it } from 'vitest'
import { BasicCompactionEngine } from '@deepseek-ai/dsh-compaction-basic'
import { CompactionEngine } from '@deepseek-ai/dsh-compaction'
import { selectCompactableRange } from '@deepseek-ai/dsh-compaction-basic/src/region.ts'
import { summarizeWithLlm } from '@deepseek-ai/dsh-compaction-basic/src/summarizer.ts'
import { TargetPressureConfigError } from '@deepseek-ai/dsh-compaction-basic/src/config.ts'

describe('fork module resolution', () => {
  it('loads the compaction backend through junctions and tsconfig paths', () => {
    expect(typeof BasicCompactionEngine).toBe('function')
    expect(BasicCompactionEngine.prototype instanceof CompactionEngine).toBe(true)
    expect(typeof selectCompactableRange).toBe('function')
    expect(typeof summarizeWithLlm).toBe('function')
    expect(TargetPressureConfigError.name).toBe('TargetPressureConfigError')
  })
})
