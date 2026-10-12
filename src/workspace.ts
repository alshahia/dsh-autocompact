/**
 * Resolution of the project directory that owns a session.
 *
 * Requirement: archives belong to the project that owns the session, not to the
 * harness process, so two projects can never share or collide on an archive
 * tree. The authority is `agent.session.header.cwd` — the absolute directory the
 * session was created in, immutable detached creation metadata that is not part
 * of the event log and needs no service or I/O to read.
 *
 * Why not the workspace registry: workspace membership is itself derived from
 * the canonical session cwd, so the registry would add a heavy `storageDomain`
 * dependency to reproduce a value already on the session. Why not the
 * `workingDirectory` service: its `get()` falls back to the launch directory
 * when a session has no recorded change, which silently reproduces the
 * cross-project bug this module exists to prevent.
 *
 * @module dsh-autocompact/workspace
 */
import { isAbsolute } from 'node:path'
import type { Agent } from '@deepseek-ai/dsh-agent'

/**
 * Pick the first usable absolute directory.
 * @param candidates - Ordered candidates; empty or relative values are skipped.
 * @param fallback - Directory used when no candidate is usable.
 * @returns An absolute directory path.
 */
export function pickProjectDir(candidates: readonly (string | undefined)[], fallback: string): string {
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate !== '' && isAbsolute(candidate)) return candidate
  }
  return fallback
}

/**
 * The directory the session was created in, when the session carries one.
 *
 * Read structurally rather than through a version-specific type so the plugin
 * keeps working when the harness moves the field or a headless session omits
 * it: an unusable value is simply undefined.
 * @param agent - Agent whose session is inspected.
 * @returns An absolute directory, or undefined when the session has none.
 */
export function sessionProjectDir(agent: Agent): string | undefined {
  try {
    const header = (agent.session as { header?: { cwd?: unknown } }).header
    const cwd = header?.cwd
    return typeof cwd === 'string' && cwd !== '' && isAbsolute(cwd) ? cwd : undefined
  } catch {
    return undefined
  }
}

/**
 * Resolve the project directory for one session.
 * @param agent - Agent whose session is inspected.
 * @param fallback - Directory used when the session records none (the harness
 *   launch directory, which is also what a session without a recorded cwd used).
 * @returns An absolute project directory.
 */
export function projectDirOf(agent: Agent, fallback: string): string {
  return pickProjectDir([sessionProjectDir(agent)], fallback)
}
