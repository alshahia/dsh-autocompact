/**
 * Live compaction progress board.
 *
 * The harness emits no client-visible compaction event in this version, so the
 * Web UI learns what is happening by polling the plugin's own HTTP status route
 * (`src/gui.ts`). This board is the single writer of that state: the engine
 * marks a session busy when it enters `summarize()` — which every compaction
 * path funnels through, automatic pressure, manual `/compact`, and
 * context-overflow recovery alike — and clears it in a `finally`.
 *
 * State is keyed per session so two concurrent sessions never overwrite each
 * other's indicator, and the recent-outcome list is bounded so a long-lived
 * process cannot grow it without limit.
 *
 * @module dsh-autocompact/status
 */

/** One compaction that is running right now. */
export interface RunningCompaction {
  sessionId: string
  /** Short human phase, e.g. "summarizing". */
  phase: string
  /** Optional detail for the tooltip/panel, e.g. the routed model. */
  detail?: string
  /** Epoch milliseconds when the phase was first recorded. */
  startedAt: number
}

/** One compaction that finished, newest first. */
export interface CompactionOutcome {
  sessionId: string
  /** Epoch milliseconds. */
  finishedAt: number
  ok: boolean
  /** Short detail, e.g. the archive pointer or the failure message. */
  detail?: string
}

/** The whole board as the status route serializes it. */
export interface StatusSnapshot {
  running: RunningCompaction[]
  recent: CompactionOutcome[]
}

/** How many finished compactions the board remembers. */
export const RECENT_LIMIT = 8

/**
 * Per-session progress memory for the GUI indicator.
 *
 * Every method is total: a malformed call marks or clears nothing rather than
 * throwing, because the indicator must never be able to break compaction.
 */
export class StatusBoard {
  private readonly running = new Map<string, RunningCompaction>()
  private readonly recent: CompactionOutcome[] = []

  /** Mark a session busy (idempotent: a second call updates the phase). */
  begin(sessionId: string, phase: string, detail?: string, now = Date.now()): void {
    if (sessionId.length === 0) return
    const current = this.running.get(sessionId)
    if (current !== undefined) {
      current.phase = phase
      if (detail !== undefined) current.detail = detail
      return
    }
    this.running.set(sessionId, {
      sessionId,
      phase,
      startedAt: now,
      ...(detail !== undefined ? { detail } : {}),
    })
  }

  /** Update the phase of a running compaction (starting one when absent). */
  phase(sessionId: string, phase: string, detail?: string, now = Date.now()): void {
    this.begin(sessionId, phase, detail, now)
  }

  /** Clear the running mark and remember the outcome. */
  finish(sessionId: string, ok: boolean, detail?: string, now = Date.now()): void {
    if (sessionId.length === 0) return
    this.running.delete(sessionId)
    this.recent.unshift({
      sessionId,
      finishedAt: now,
      ok,
      ...(detail !== undefined ? { detail } : {}),
    })
    while (this.recent.length > RECENT_LIMIT) this.recent.pop()
  }

  /** True while this session reports a running compaction. */
  isRunning(sessionId: string): boolean {
    return this.running.has(sessionId)
  }

  /** A defensive copy of the current board. */
  snapshot(): StatusSnapshot {
    return {
      running: [...this.running.values()].map(entry => ({ ...entry })),
      recent: this.recent.map(entry => ({ ...entry })),
    }
  }

  /** Drop all memory (tests and plugin disposal). */
  clear(): void {
    this.running.clear()
    this.recent.length = 0
  }
}
