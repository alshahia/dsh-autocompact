import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Agent } from '@deepseek-ai/dsh-agent'
import {
  CONFIG_ROUTE,
  STATUS_ROUTE,
  configSnippet,
  createGuiRoutes,
  installGuiBridge,
  mergeConfig,
} from '../src/gui.ts'
import type { GuiEngine, GuiRoute } from '../src/gui.ts'
import type { HandoffVolatileConfig } from '../src/config.ts'
import { StatusBoard } from '../src/status.ts'
import type { ResolvedHandoffConfig } from '../src/types.ts'

/** A resolved configuration with every default at its documented value. */
function resolved(overrides: Partial<ResolvedHandoffConfig> = {}): ResolvedHandoffConfig {
  return {
    trigger: { mode: 'first', ratio: 0.8 },
    retain: {},
    archive: { root: '.dsh/handoffs', gitIgnore: true, onFailure: 'block' },
    summarization: { provider: '', model: '', maxTokens: 8192 },
    retries: { compactionRetries: 1, maxOverflowRetries: 1 },
    enabled: true,
    models: [],
    ...overrides,
  }
}

/** A structural Context stand-in with only what the bridge touches. */
function fakeContext(services: Record<string, unknown> = {}) {
  const infos: string[] = []
  const warns: string[] = []
  const disposers: Array<() => void> = []
  const ctx = {
    logger: {
      info: (message: string) => { infos.push(message) },
      warn: (message: string) => { warns.push(message) },
    },
    get: (name: string) => services[name],
    effect: (callback: () => (() => void) | void) => {
      const disposer = callback()
      if (typeof disposer === 'function') disposers.push(disposer)
      return () => { disposer?.() }
    },
  } as unknown as Context
  return { ctx, infos, warns, disposers }
}

class FakeResponse {
  statusCode = 0
  writableEnded = false
  readonly headers: Record<string, string> = {}
  body = ''

  setHeader(name: string, value: unknown): void {
    this.headers[name.toLowerCase()] = String(value)
  }

  end(chunk?: unknown): void {
    this.body = chunk === undefined ? '' : String(chunk)
    this.writableEnded = true
  }

  json<T = Record<string, any>>(): T {
    return JSON.parse(this.body) as T
  }
}

/** A request stand-in: the body is an async iterable, like IncomingMessage. */
function fakeRequest(
  method: string,
  url: string,
  body?: unknown,
  headers: Record<string, string> = {},
): IncomingMessage {
  const text = body === undefined ? '' : JSON.stringify(body)
  return {
    method,
    url,
    headers,
    async *[Symbol.asyncIterator]() {
      if (text.length > 0) yield Buffer.from(text)
    },
  } as unknown as IncomingMessage
}

function agentWith(id: string): Agent {
  return { session: { id } } as unknown as Agent
}

function fakeEngine(overrides: Partial<GuiEngine> = {}): GuiEngine {
  return {
    status: new StatusBoard(),
    rawConfig: {} as HandoffVolatileConfig,
    handoffConfig: resolved(),
    describeSession: async (agent: Agent) => ({ sessionId: String(agent.session.id), measuredTokens: 12 }),
    ...overrides,
  }
}

function routeFor(routes: GuiRoute[], path: string): GuiRoute {
  const found = routes.find(route => route.path === path)
  if (found === undefined) throw new Error('missing route ' + path)
  return found
}

describe('mergeConfig', () => {
  it('merges a group one level deep and leaves siblings alone', () => {
    const merged = mergeConfig(
      { enabled: true, trigger: { ratio: 0.8, tokens: 0 }, archive: { root: '.dsh/handoffs' } },
      { trigger: { tokens: 50_000 } },
    )
    expect(merged).toEqual({
      enabled: true,
      trigger: { ratio: 0.8, tokens: 50_000 },
      archive: { root: '.dsh/handoffs' },
    })
  })

  it('replaces arrays wholesale and deletes nulls', () => {
    const merged = mergeConfig(
      { models: [{ provider: 'p', model: 'm' }], archive: { root: 'a' } },
      { models: [], archive: null },
    )
    expect(merged).toEqual({ models: [] })
  })
})

describe('configSnippet', () => {
  it('renders a paste-ready override', () => {
    const snippet = configSnippet(resolved({ retain: { tokens: 40_000 } }))
    expect(snippet).toContain('enabled: true')
    expect(snippet).toContain('ratio: 0.8')
    expect(snippet).toContain('tokens: 40000')
    expect(snippet).toContain('root: .dsh/handoffs')
  })
})

describe('GET ' + STATUS_ROUTE, () => {
  it('reports an idle host without sessions', async () => {
    const { ctx } = fakeContext()
    const status = routeFor(createGuiRoutes(fakeEngine(), ctx), STATUS_ROUTE)
    const res = new FakeResponse()
    await status.handler(fakeRequest('GET', STATUS_ROUTE), res as unknown as ServerResponse)
    expect(res.statusCode).toBe(200)
    expect(res.headers['cache-control']).toBe('no-store')
    const payload = res.json()
    expect(payload.running).toBeNull()
    expect(payload.session).toBeNull()
    expect(payload.capabilities.write).toBe(false)
    expect(payload.capabilities.reason).toMatch(/config editor/)
  })

  it('reports the running compaction with an elapsed time', async () => {
    const status = new StatusBoard()
    status.begin('s1', 'summarizing', 'p/m', Date.now())
    const { ctx } = fakeContext({ agents: { get: (id: string) => (id === 's1' ? agentWith('s1') : undefined), list: () => [agentWith('s1')] } })
    const route = routeFor(createGuiRoutes(fakeEngine({ status }), ctx), STATUS_ROUTE)
    const res = new FakeResponse()
    await route.handler(fakeRequest('GET', STATUS_ROUTE + '?session=s1'), res as unknown as ServerResponse)
    const payload = res.json()
    expect(payload.running).toMatchObject({ sessionId: 's1', phase: 'summarizing', detail: 'p/m' })
    expect(typeof payload.running.elapsedMs).toBe('number')
    expect(payload.session).toMatchObject({ sessionId: 's1', measuredTokens: 12 })
  })

  it('falls back to a single live agent when no session is named', async () => {
    const { ctx } = fakeContext({ agents: { get: () => undefined, list: () => [agentWith('only')] } })
    const route = routeFor(createGuiRoutes(fakeEngine(), ctx), STATUS_ROUTE)
    const res = new FakeResponse()
    await route.handler(fakeRequest('GET', STATUS_ROUTE), res as unknown as ServerResponse)
    expect(res.json().session).toMatchObject({ sessionId: 'only' })
  })

  it('survives a throwing describeSession', async () => {
    const { ctx } = fakeContext({ agents: { get: () => agentWith('s1'), list: () => [agentWith('s1')] } })
    const engine = fakeEngine({
      describeSession: async () => { throw new Error('no capacity') },
    })
    const route = routeFor(createGuiRoutes(engine, ctx), STATUS_ROUTE)
    const res = new FakeResponse()
    await route.handler(fakeRequest('GET', STATUS_ROUTE + '?session=s1'), res as unknown as ServerResponse)
    expect(res.statusCode).toBe(200)
    expect(res.json().session.error).toBe('no capacity')
  })

  it('rejects a non-GET method', async () => {
    const { ctx } = fakeContext()
    const route = routeFor(createGuiRoutes(fakeEngine(), ctx), STATUS_ROUTE)
    const res = new FakeResponse()
    await route.handler(fakeRequest('DELETE', STATUS_ROUTE), res as unknown as ServerResponse)
    expect(res.statusCode).toBe(405)
  })

  it('reports write capability when a matching config entry exists', async () => {
    const entry = { id: 'dsh-autocompact', name: 'dsh-autocompact' }
    const editor = {
      entries: () => [entry],
      configuration: () => [{ entry, override: { enabled: true } }],
      edit: async () => {},
    }
    const { ctx } = fakeContext({ configEditor: editor })
    const route = routeFor(createGuiRoutes(fakeEngine(), ctx), STATUS_ROUTE)
    const res = new FakeResponse()
    await route.handler(fakeRequest('GET', STATUS_ROUTE), res as unknown as ServerResponse)
    expect(res.json().capabilities.write).toBe(true)
  })
})

describe('POST ' + CONFIG_ROUTE, () => {
  function editorFixture() {
    const entry = { id: 'dsh-autocompact', name: 'dsh-autocompact' }
    const writes: Array<Record<string, unknown>> = []
    const editor = {
      entries: () => [entry],
      configuration: () => [{ entry, override: { enabled: true, trigger: { ratio: 0.8 } } }],
      edit: async (
        _entry: unknown,
        change: (current: Record<string, unknown>, inherited: Record<string, unknown>) => Record<string, unknown>,
      ) => { writes.push(change({ enabled: true, trigger: { ratio: 0.8 } }, {})) },
    }
    return { editor, writes }
  }

  it('rejects a GET', async () => {
    const { ctx } = fakeContext()
    const route = routeFor(createGuiRoutes(fakeEngine(), ctx), CONFIG_ROUTE)
    const res = new FakeResponse()
    await route.handler(fakeRequest('GET', CONFIG_ROUTE), res as unknown as ServerResponse)
    expect(res.statusCode).toBe(405)
  })

  it('rejects a cross-origin write', async () => {
    const { editor } = editorFixture()
    const { ctx } = fakeContext({ configEditor: editor })
    const route = routeFor(createGuiRoutes(fakeEngine(), ctx), CONFIG_ROUTE)
    const res = new FakeResponse()
    await route.handler(
      fakeRequest('POST', CONFIG_ROUTE, { enabled: false }, { origin: 'http://evil.example', host: '127.0.0.1:3080' }),
      res as unknown as ServerResponse,
    )
    expect(res.statusCode).toBe(403)
  })

  it('accepts a same-origin write and merges it into the entry', async () => {
    const { editor, writes } = editorFixture()
    const { ctx } = fakeContext({ configEditor: editor })
    const route = routeFor(createGuiRoutes(fakeEngine(), ctx), CONFIG_ROUTE)
    const res = new FakeResponse()
    await route.handler(
      fakeRequest('POST', CONFIG_ROUTE, { trigger: { tokens: 50_000 } },
        { origin: 'http://127.0.0.1:3080', host: '127.0.0.1:3080' }),
      res as unknown as ServerResponse,
    )
    expect(res.statusCode).toBe(200)
    expect(res.json().ok).toBe(true)
    expect(writes).toHaveLength(1)
    expect(writes[0]).toEqual({ enabled: true, trigger: { ratio: 0.8, tokens: 50_000 } })
  })

  it('rejects unknown top-level keys', async () => {
    const { editor } = editorFixture()
    const { ctx } = fakeContext({ configEditor: editor })
    const route = routeFor(createGuiRoutes(fakeEngine(), ctx), CONFIG_ROUTE)
    const res = new FakeResponse()
    await route.handler(
      fakeRequest('POST', CONFIG_ROUTE, { nonsense: 1 }), res as unknown as ServerResponse)
    expect(res.statusCode).toBe(400)
    expect(res.json().reason).toMatch(/unknown configuration keys/)
  })

  it('rejects a value the plugin schema refuses', async () => {
    const { editor, writes } = editorFixture()
    const { ctx } = fakeContext({ configEditor: editor })
    const route = routeFor(createGuiRoutes(fakeEngine(), ctx), CONFIG_ROUTE)
    const res = new FakeResponse()
    await route.handler(
      fakeRequest('POST', CONFIG_ROUTE, { models: 'not-an-array' }), res as unknown as ServerResponse)
    expect(res.statusCode).toBe(400)
    expect(res.json().reason).toMatch(/invalid configuration/)
    expect(writes).toHaveLength(0)
  })

  it('rejects a non-JSON body', async () => {
    const { ctx } = fakeContext()
    const route = routeFor(createGuiRoutes(fakeEngine(), ctx), CONFIG_ROUTE)
    const res = new FakeResponse()
    await route.handler(
      fakeRequest('POST', CONFIG_ROUTE, 'nope'), res as unknown as ServerResponse)
    expect(res.statusCode).toBe(400)
  })

  it('reports a read-only composition when no editor or entry exists', async () => {
    const { ctx } = fakeContext()
    const route = routeFor(createGuiRoutes(fakeEngine(), ctx), CONFIG_ROUTE)
    const res = new FakeResponse()
    await route.handler(
      fakeRequest('POST', CONFIG_ROUTE, { enabled: true }), res as unknown as ServerResponse)
    expect(res.statusCode).toBe(409)
    expect(res.json().write).toBe(false)
  })
})

describe('installGuiBridge', () => {
  it('is a no-op without a web server', () => {
    const { ctx, infos } = fakeContext()
    expect(installGuiBridge(ctx, fakeEngine())).toBe(false)
    expect(infos.join('\n')).toMatch(/no web server/)
  })

  it('registers both routes and removes them on disposal', () => {
    const registered: GuiRoute[] = []
    const removed: string[] = []
    const webServer = {
      register: (route: GuiRoute) => {
        registered.push(route)
        return () => { removed.push(route.path) }
      },
    }
    const { ctx, disposers } = fakeContext({ webServer })
    expect(installGuiBridge(ctx, fakeEngine())).toBe(true)
    expect(registered.map(route => route.path)).toEqual([STATUS_ROUTE, CONFIG_ROUTE])
    for (const disposer of disposers) disposer()
    expect(removed).toEqual([STATUS_ROUTE, CONFIG_ROUTE])
  })

  it('keeps the surviving route when one registration throws', () => {
    const webServer = {
      register: (route: GuiRoute) => {
        if (route.path === STATUS_ROUTE) throw new Error('already taken')
        return () => {}
      },
    }
    const { ctx, warns } = fakeContext({ webServer })
    expect(installGuiBridge(ctx, fakeEngine())).toBe(true)
    expect(warns.join('\n')).toMatch(/could not register .*status/)
  })
})
