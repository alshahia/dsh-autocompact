import { describe, expect, it } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { pickProjectDir, projectDirOf, sessionProjectDir } from '../src/workspace.ts'

/** A structural stand-in for a session-carrying agent. */
function fakeAgent(header: unknown, throwOnHeader = false): Agent {
  return {
    session: throwOnHeader
      ? Object.defineProperty({}, 'header', { get() { throw new Error('detached') } })
      : { header },
  } as unknown as Agent
}

describe('pickProjectDir', () => {
  it('takes the first absolute candidate', () => {
    expect(pickProjectDir(['D:\\a', 'D:\\b'], 'D:\\fallback')).toBe('D:\\a')
  })

  it('skips empty and relative candidates', () => {
    expect(pickProjectDir(['', 'relative\\path', 'D:\\real'], 'D:\\fallback')).toBe('D:\\real')
  })

  it('falls back when nothing is usable', () => {
    expect(pickProjectDir([undefined, ''], 'D:\\fallback')).toBe('D:\\fallback')
    expect(pickProjectDir([], 'D:\\fallback')).toBe('D:\\fallback')
  })
})

describe('sessionProjectDir', () => {
  it('reads an absolute creation directory from the session header', () => {
    expect(sessionProjectDir(fakeAgent({ cwd: 'D:\\projects\\one' }))).toBe('D:\\projects\\one')
  })

  it('ignores a missing, empty, or relative header cwd', () => {
    expect(sessionProjectDir(fakeAgent(undefined))).toBeUndefined()
    expect(sessionProjectDir(fakeAgent({}))).toBeUndefined()
    expect(sessionProjectDir(fakeAgent({ cwd: '' }))).toBeUndefined()
    expect(sessionProjectDir(fakeAgent({ cwd: 'relative' }))).toBeUndefined()
  })

  it('survives a session whose header cannot be read', () => {
    expect(sessionProjectDir(fakeAgent(undefined, true))).toBeUndefined()
  })
})

describe('projectDirOf', () => {
  it('prefers the session creation directory over the launch directory', () => {
    expect(projectDirOf(fakeAgent({ cwd: 'D:\\projects\\two' }), 'D:\\launch')).toBe('D:\\projects\\two')
  })

  it('uses the launch directory for a session that records none', () => {
    // This is the headless/SDK case: the same fallback the harness itself uses.
    expect(projectDirOf(fakeAgent(undefined), 'D:\\launch')).toBe('D:\\launch')
  })

  it('keeps two sessions of two projects in disjoint directories', () => {
    const one = projectDirOf(fakeAgent({ cwd: 'D:\\projects\\one' }), 'D:\\launch')
    const two = projectDirOf(fakeAgent({ cwd: 'D:\\projects\\two' }), 'D:\\launch')
    expect(one).not.toBe(two)
  })
})
