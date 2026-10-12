import { describe, expect, it } from 'vitest'
import { RECENT_LIMIT, StatusBoard } from '../src/status.ts'

describe('StatusBoard', () => {
  it('marks one session busy and clears it on finish', () => {
    const board = new StatusBoard()
    board.begin('a', 'summarizing', 'p/m', 1_000)
    expect(board.isRunning('a')).toBe(true)
    const running = board.snapshot().running
    expect(running).toHaveLength(1)
    expect(running[0]).toMatchObject({ sessionId: 'a', phase: 'summarizing', detail: 'p/m', startedAt: 1_000 })

    board.finish('a', true, 'archived', 2_000)
    expect(board.isRunning('a')).toBe(false)
    const snapshot = board.snapshot()
    expect(snapshot.running).toEqual([])
    expect(snapshot.recent).toEqual([{ sessionId: 'a', finishedAt: 2_000, ok: true, detail: 'archived' }])
  })

  it('keeps sessions independent', () => {
    const board = new StatusBoard()
    board.begin('a', 'summarizing', undefined, 1)
    board.begin('b', 'range', undefined, 2)
    board.finish('a', true, undefined, 3)
    expect(board.isRunning('a')).toBe(false)
    expect(board.isRunning('b')).toBe(true)
    expect(board.snapshot().running.map(entry => entry.sessionId)).toEqual(['b'])
  })

  it('updates the phase of a running compaction in place', () => {
    const board = new StatusBoard()
    board.begin('a', 'summarizing', 'p/m', 1_000)
    board.phase('a', 'writing archive', 'docs/1', 1_500)
    const running = board.snapshot().running
    expect(running).toHaveLength(1)
    expect(running[0]).toMatchObject({ phase: 'writing archive', detail: 'docs/1', startedAt: 1_000 })
  })

  it('starts a compaction when a phase arrives for an unknown session', () => {
    const board = new StatusBoard()
    board.phase('a', 'range', undefined, 5)
    expect(board.snapshot().running[0]).toMatchObject({ sessionId: 'a', phase: 'range', startedAt: 5 })
  })

  it('bounds the recent-outcome list', () => {
    const board = new StatusBoard()
    for (let index = 0; index < RECENT_LIMIT + 4; index += 1) {
      board.begin('s' + index, 'summarizing', undefined, index)
      board.finish('s' + index, true, undefined, index)
    }
    const recent = board.snapshot().recent
    expect(recent).toHaveLength(RECENT_LIMIT)
    // Newest first.
    expect(recent[0]?.sessionId).toBe('s' + (RECENT_LIMIT + 3))
  })

  it('ignores malformed entries instead of throwing', () => {
    const board = new StatusBoard()
    board.begin('', 'summarizing')
    board.finish('', true)
    expect(board.snapshot()).toEqual({ running: [], recent: [] })
  })

  it('hands out copies, so a caller cannot mutate the board', () => {
    const board = new StatusBoard()
    board.begin('a', 'summarizing', undefined, 1)
    const snapshot = board.snapshot()
    snapshot.running[0].phase = 'tampered'
    snapshot.recent.push({ sessionId: 'x', finishedAt: 0, ok: false })
    expect(board.snapshot().running[0]?.phase).toBe('summarizing')
    expect(board.snapshot().recent).toEqual([])
  })

  it('clears everything', () => {
    const board = new StatusBoard()
    board.begin('a', 'summarizing', undefined, 1)
    board.finish('b', false, 'boom', 2)
    board.clear()
    expect(board.snapshot()).toEqual({ running: [], recent: [] })
  })
})
