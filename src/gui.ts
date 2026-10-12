/**
 * GUI bridge: the two HTTP routes the Web-UI client half talks to.
 *
 * Why HTTP routes and not a Cordis event or a keyed chat node:
 *  - this harness version exposes no client-side compaction event, and
 *  - `conversation.chat.node` has a fixed key table whose `compaction` key is
 *    already owned by the shipped UI (registering there would shadow it),
 * so the client half polls `GET /dsh-autocompact/status` once a second and
 * writes tuning changes with `POST /dsh-autocompact/config`.
 *
 * Both handlers are total and defensive: an absent web server, an absent config
 * editor, a malformed body, or a throwing engine turns into a JSON error
 * response (or a logged warning), never into a broken harness route.
 *
 * The tunnel path prefix is deliberately NOT `/plugins`: that prefix is owned by
 * the client-modules bundle route.
 *
 * @module dsh-autocompact/gui
 */
import type { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Agent } from '@deepseek-ai/dsh-agent'
import z from '@deepseek-ai/schemastery'
import { autocompactConfig } from './config.ts'
import type { HandoffVolatileConfig } from './config.ts'
import type { StatusBoard } from './status.ts'
import type { ResolvedHandoffConfig } from './types.ts'

/** Absolute pathname of the read route (never under `/plugins`). */
export const STATUS_ROUTE = '/dsh-autocompact/status'
/** Absolute pathname of the write route. */
export const CONFIG_ROUTE = '/dsh-autocompact/config'
/** Largest accepted config body. */
const MAX_BODY_BYTES = 64 * 1024
/** Top-level configuration keys a patch may carry. */
const CONFIG_KEYS = new Set([
  'enabled', 'trigger', 'retain', 'archive', 'summarization', 'retries', 'models',
])
/** Group keys merged one level deep; every other key is replaced wholesale. */
const GROUP_KEYS = new Set(['trigger', 'retain', 'archive', 'summarization', 'retries'])
/** Epoch-millisecond cap on how long a stale "running" mark may live (10 min). */
const STALE_RUNNING_MS = 600_000

/** Structural view of `ctx.webServer` (avoids importing a service we may not have). */
export interface WebServerLike {
  register(route: GuiRoute): () => void
}

/** Structural view of one web route. */
export interface GuiRoute {
  kind: 'exact'
  path: string
  handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
}

/** Structural view of `ctx.configEditor` (the loader-owned raw config path). */
interface ConfigEditorEntry {
  id?: unknown
  name?: unknown
}

interface ConfigEditorLike {
  entries(): ConfigEditorEntry[]
  configuration(): Array<{ entry: ConfigEditorEntry; override: Record<string, unknown> }>
  edit(
    entry: ConfigEditorEntry,
    change: (current: Record<string, unknown>, inherited: Record<string, unknown>) => Record<string, unknown>,
  ): Promise<void>
}

/** Structural view of `ctx.agents`. */
interface AgentsLike {
  get(id: string): Agent | undefined
  list(): Agent[]
}

/** What the GUI bridge needs from the engine (kept structural on purpose). */
export interface GuiEngine {
  /** Live progress board written by `summarize()`. */
  readonly status: StatusBoard
  /** The raw document the user wrote (as opposed to resolved defaults). */
  readonly rawConfig: HandoffVolatileConfig
  /** Live resolved configuration. */
  readonly handoffConfig: ResolvedHandoffConfig
  /** Per-session pressure picture; may reject and is caught by the route. */
  describeSession(agent: Agent, signal: AbortSignal): Promise<Record<string, unknown>>
}

/** Read one Cordis service without throwing when it is absent. */
function safeGet<T>(ctx: Context, name: string): T | undefined {
  try {
    return (ctx.get as (key: string) => unknown)(name) as T | undefined
  } catch {
    return undefined
  }
}

/** Write one JSON response unless the request lifecycle already ended. */
function send(res: ServerResponse, status: number, payload: unknown): void {
  try {
    if (res.writableEnded === true) return
    res.statusCode = status
    res.setHeader('content-type', 'application/json; charset=utf-8')
    res.setHeader('cache-control', 'no-store')
    res.end(JSON.stringify(payload))
  } catch {
    // A response that cannot be written (client gone) needs no recovery.
  }
}

/** Reject a state-changing request that a different origin sent. */
function crossOriginReason(req: IncomingMessage): string | undefined {
  const origin = req.headers.origin
  if (typeof origin !== 'string' || origin.length === 0) return undefined
  const host = req.headers.host
  if (typeof host !== 'string' || host.length === 0) return 'missing Host header'
  try {
    const parsed = new URL(origin)
    return parsed.host === host ? undefined : 'cross-origin request rejected'
  } catch {
    return 'invalid Origin header'
  }
}

/** Read a bounded JSON request body. */
async function readJsonBody(req: IncomingMessage):
Promise<{ text: string } | { error: string }> {
  const chunks: Buffer[] = []
  let size = 0
  try {
    for await (const chunk of req as AsyncIterable<Uint8Array>) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      size += buffer.byteLength
      if (size > MAX_BODY_BYTES) return { error: 'request body too large' }
      chunks.push(buffer)
    }
  } catch (error: unknown) {
    return { error: 'could not read request body: ' + messageOf(error) }
  }
  return { text: Buffer.concat(chunks).toString('utf8') }
}

/** Error-to-text without trusting the thrown value. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** One-level deep merge used for both validation and the persisted write. */
export function mergeConfig(
  current: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...current }
  for (const [key, value] of Object.entries(patch)) {
    const previous = next[key]
    if (GROUP_KEYS.has(key) && isRecord(previous) && isRecord(value)) {
      const group: Record<string, unknown> = { ...previous }
      for (const [inner, innerValue] of Object.entries(value)) {
        if (innerValue === null) delete group[inner]
        else group[inner] = innerValue
      }
      next[key] = group
      continue
    }
    if (value === null) delete next[key]
    else next[key] = value
  }
  return next
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Locate this plugin's own loader entry, tolerating either id or name. */
function findRow(editor: ConfigEditorLike): { entry: ConfigEditorEntry; override: Record<string, unknown> } | undefined {
  let rows: Array<{ entry: ConfigEditorEntry; override: Record<string, unknown> }> = []
  try {
    rows = editor.configuration()
  } catch {
    rows = []
  }
  const match = (entry: ConfigEditorEntry): boolean =>
    entry.id === 'dsh-autocompact' || entry.name === 'dsh-autocompact'
  const found = rows.find(row => match(row.entry))
  if (found !== undefined) return found
  try {
    const entry = editor.entries().find(match)
    return entry === undefined ? undefined : { entry, override: {} }
  } catch {
    return undefined
  }
}

/** A paste-ready YAML override for the profile patch. */
export function configSnippet(config: ResolvedHandoffConfig): string {
  const lines = [
    'config:',
    '  enabled: ' + String(config.enabled),
    '  trigger:',
    '    ratio: ' + String(config.trigger.ratio ?? 0),
    '    tokens: ' + String(config.trigger.tokens ?? 0),
    '  retain:',
    ...(config.retain.tokens !== undefined ? ['    tokens: ' + String(config.retain.tokens)] : []),
    ...(config.retain.tokens === undefined && config.retain.ratio !== undefined
      ? ['    ratio: ' + String(config.retain.ratio)] : []),
    '  archive:',
    '    root: ' + config.archive.root,
    '  summarization:',
    ...(config.summarization.provider.length > 0 ? ['    provider: ' + config.summarization.provider] : []),
    ...(config.summarization.model.length > 0 ? ['    model: ' + config.summarization.model] : []),
  ]
  return lines.join('\n')
}

/** Build the two route handlers (exported so tests can drive them directly). */
export function createGuiRoutes(engine: GuiEngine, ctx: Context): GuiRoute[] {
  const statusHandler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    try {
      if (req.method !== undefined && req.method !== 'GET' && req.method !== 'HEAD') {
        send(res, 405, { ok: false, reason: 'method not allowed' })
        return
      }
      const url = new URL(req.url ?? STATUS_ROUTE, 'http://localhost')
      const requested = url.searchParams.get('session')
      const agents = safeGet<AgentsLike>(ctx, 'agents')
      const live = safeAgents(agents)
      const sessionId = requested !== null && requested.length > 0 ? requested : undefined
      const agent = (sessionId !== undefined ? agents?.get(sessionId) : undefined)
        ?? (live.length === 1 ? live[0] : undefined)

      const config = engine.handoffConfig
      const snapshot = engine.status.snapshot()
      const now = Date.now()
      const own = agent === undefined ? undefined : String(agent.session.id)
      const candidates = snapshot.running.filter(entry => now - entry.startedAt < STALE_RUNNING_MS)
      const running = (own === undefined ? undefined : candidates.find(entry => entry.sessionId === own))
        ?? (own === undefined ? candidates[0] : undefined)
      const editor = safeGet<ConfigEditorLike>(ctx, 'configEditor')
      const row = editor === undefined ? undefined : findRow(editor)
      const writable = editor !== undefined && row !== undefined

      let session: Record<string, unknown> | null = null
      if (agent !== undefined) {
        try {
          session = await engine.describeSession(agent, new AbortController().signal)
        } catch (error: unknown) {
          session = { sessionId: own ?? 'unknown', error: messageOf(error) }
        }
      }

      send(res, 200, {
        plugin: 'dsh-autocompact',
        enabled: config.enabled,
        running: running === undefined ? null : { ...running, elapsedMs: now - running.startedAt },
        recent: snapshot.recent.slice(0, 3),
        session,
        config: { effective: config, raw: engine.rawConfig },
        capabilities: {
          write: writable,
          ...(writable ? {} : {
            reason: editor === undefined
              ? 'this composition has no config editor; edit the profile patch instead'
              : 'no dsh-autocompact entry is present in this profile composition',
          }),
          snippet: configSnippet(config),
        },
      })
    } catch (error: unknown) {
      send(res, 500, { ok: false, reason: messageOf(error) })
    }
  }

  const configHandler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    try {
      if (req.method !== 'POST') {
        send(res, 405, { ok: false, reason: 'method not allowed' })
        return
      }
      const originReason = crossOriginReason(req)
      if (originReason !== undefined) {
        send(res, 403, { ok: false, reason: originReason })
        return
      }
      const body = await readJsonBody(req)
      if ('error' in body) {
        send(res, 400, { ok: false, reason: body.error })
        return
      }
      let parsed: unknown
      try {
        parsed = JSON.parse(body.text)
      } catch {
        send(res, 400, { ok: false, reason: 'body must be JSON' })
        return
      }
      if (!isRecord(parsed)) {
        send(res, 400, { ok: false, reason: 'body must be a JSON object' })
        return
      }
      const unknown = Object.keys(parsed).filter(key => !CONFIG_KEYS.has(key))
      if (unknown.length > 0) {
        send(res, 400, { ok: false, reason: 'unknown configuration keys: ' + unknown.join(', ') })
        return
      }
      const editor = safeGet<ConfigEditorLike>(ctx, 'configEditor')
      if (editor === undefined) {
        send(res, 409, {
          ok: false,
          write: false,
          reason: 'this composition has no config editor; add the values to the dsh-autocompact entry of the profile patch',
        })
        return
      }
      const row = findRow(editor)
      if (row === undefined) {
        send(res, 409, {
          ok: false,
          write: false,
          reason: 'no dsh-autocompact entry is present in this profile composition',
        })
        return
      }
      try {
        z.resolve(mergeConfig(row.override, parsed), autocompactConfig, {})
      } catch (error: unknown) {
        send(res, 400, { ok: false, reason: 'invalid configuration: ' + messageOf(error) })
        return
      }
      try {
        await editor.edit(row.entry, current => mergeConfig(current, parsed))
      } catch (error: unknown) {
        send(res, 500, { ok: false, reason: 'could not persist the configuration: ' + messageOf(error) })
        return
      }
      send(res, 200, { ok: true, config: engine.handoffConfig })
    } catch (error: unknown) {
      send(res, 500, { ok: false, reason: messageOf(error) })
    }
  }

  return [
    { kind: 'exact', path: STATUS_ROUTE, handler: statusHandler },
    { kind: 'exact', path: CONFIG_ROUTE, handler: configHandler },
  ]
}

/** `agents.list()` never takes the route down. */
function safeAgents(agents: AgentsLike | undefined): Agent[] {
  if (agents === undefined) return []
  try {
    return agents.list()
  } catch {
    return []
  }
}

/**
 * Register the GUI routes on this composition's web server.
 *
 * Returns false (having logged why) when the composition has no web server: the
 * plugin keeps compacting and archiving, only the indicator is unavailable.
 */
export function installGuiBridge(ctx: Context, engine: GuiEngine): boolean {
  const server = safeGet<WebServerLike>(ctx, 'webServer')
  if (server === undefined || typeof server.register !== 'function') {
    ctx.logger.info('dsh-autocompact: no web server in this composition; the GUI indicator is off')
    return false
  }
  try {
    ctx.effect(() => {
      const disposers: Array<() => void> = []
      for (const route of createGuiRoutes(engine, ctx)) {
        try {
          disposers.push(server.register(route))
        } catch (error: unknown) {
          ctx.logger.warn('dsh-autocompact: could not register ' + route.path + ' ('
            + messageOf(error) + '); the GUI indicator is partly unavailable')
        }
      }
      return () => {
        for (const dispose of disposers) {
          try {
            dispose()
          } catch {
            // Disposal of an already-removed route is not an error here.
          }
        }
      }
    })
    return true
  } catch (error: unknown) {
    ctx.logger.warn('dsh-autocompact: could not install the GUI bridge (' + messageOf(error) + ')')
    return false
  }
}
