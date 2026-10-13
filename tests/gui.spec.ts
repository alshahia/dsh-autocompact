import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
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
    memory: {
      enabled: true,
      budget: { ratio: 0.3, denominator: 'surface', warnAt: 0.9 },
      limits: { minFreedTokens: 2000, maxOpsPerTurn: 2, mapTokens: 1500 },
      policy: { protectUserMessages: true, archiveOnDrop: 'block', recallMaxTokens: 1200 },
    },
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

  it('matches a real config-editor row, whose profile id lives in options', async () => {
    // Verified against the live profile on 2026-10-12: `configEditor` hands out
    // Loader entries, so the patch id is `options.id` while the flat `id` is the
    // tree id (`include:<patchId>`). Reading only the flat fields reported
    // `write: false` for a mounted, configurable plugin.
    const entry = { id: 'include:dsh-autocompact', options: { id: 'dsh-autocompact', name: 'dsh-autocompact' } }
    const editor = {
      entries: () => [entry],
      configuration: () => [{ entry, inherited: {}, override: { enabled: true } }],
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

  it('writes through a real Loader-node entry', async () => {
    const entry = { id: 'include:dsh-autocompact', options: { id: 'dsh-autocompact', name: 'dsh-autocompact' } }
    const seen: unknown[] = []
    const editor = {
      entries: () => [entry],
      configuration: () => [{ entry, inherited: {}, override: { enabled: true } }],
      edit: async (
        target: unknown,
        change: (current: Record<string, unknown>, inherited: Record<string, unknown>) => Record<string, unknown>,
      ) => { seen.push(target, change({ enabled: true }, {})) },
    }
    const { ctx } = fakeContext({ configEditor: editor })
    const route = routeFor(createGuiRoutes(fakeEngine(), ctx), CONFIG_ROUTE)
    const res = new FakeResponse()
    await route.handler(fakeRequest('POST', CONFIG_ROUTE, { enabled: false }), res as unknown as ServerResponse)
    expect(res.statusCode).toBe(200)
    expect(seen[0]).toBe(entry)
    expect(seen[1]).toEqual({ enabled: false })
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

  // The cold-boot defect (measured live 2026-10-13): the web server is provided
  // by the web-runtime boot fiber and is NOT reachable when this engine is
  // applied, so a one-shot `ctx.get('webServer')` registered nothing and the
  // client's polls answered 404 for the whole process life. The sanctioned form
  // is `ctx.inject(['webServer'], …)`, which activates a child scope when the
  // service actually appears.
  describe('optional webServer', () => {
    it('defers registration through ctx.inject instead of reading at apply time', () => {
      const registered: GuiRoute[] = []
      const calls: string[][] = []
      /** Base scope: no webServer yet, exactly like a cold start. */
      const { ctx } = fakeContext()
      ;(ctx as unknown as Record<string, unknown>).inject =
        (deps: string[], _callback: (scope: Context) => void) => { calls.push([...deps]) }

      // The base scope cannot see the server, yet the bridge reports that
      // registration is arranged — not that the capability is absent.
      expect(installGuiBridge(ctx, fakeEngine())).toBe(true)
      expect(calls).toEqual([['webServer']])
      expect(registered).toEqual([])
    })

    it('registers on the injected child scope when the service appears', () => {
      const registered: GuiRoute[] = []
      let deferred: ((scope: Context) => void) | undefined
      const webServer = {
        register: (route: GuiRoute) => {
          registered.push(route)
          return () => {}
        },
      }
      const { ctx, infos } = fakeContext()
      ;(ctx as unknown as Record<string, unknown>).inject =
        (_deps: string[], callback: (scope: Context) => void) => { deferred = callback }

      expect(installGuiBridge(ctx, fakeEngine())).toBe(true)
      expect(registered).toEqual([])

      const child = {
        logger: { info: () => {}, warn: () => {} },
        get: (name: string) => (name === 'webServer' ? webServer : undefined),
        effect: (callback: () => (() => void) | void) => callback(),
      } as unknown as Context
      deferred?.(child)
      expect(registered.map(route => route.path)).toEqual([STATUS_ROUTE, CONFIG_ROUTE])
      // The base scope alone never saw a server, so no capability absence is claimed.
      expect(infos.join('\n')).not.toMatch(/no web server/)
    })

    it('reports the absence only when the deferred scope has none either', () => {
      let deferred: ((scope: Context) => void) | undefined
      const { ctx, infos } = fakeContext()
      ;(ctx as unknown as Record<string, unknown>).inject =
        (_deps: string[], callback: (scope: Context) => void) => { deferred = callback }
      expect(installGuiBridge(ctx, fakeEngine())).toBe(true)
      const child = {
        logger: { info: () => {}, warn: () => {} },
        get: () => undefined,
        effect: (callback: () => (() => void) | void) => callback(),
      } as unknown as Context
      deferred?.(child)
      expect(infos.join('\n')).toMatch(/no web server/)
    })

    it('fails safe when ctx.inject itself throws', () => {
      const { ctx, warns } = fakeContext()
      ;(ctx as unknown as Record<string, unknown>).inject = () => { throw new Error('no fiber') }
      expect(installGuiBridge(ctx, fakeEngine())).toBe(false)
      expect(warns.join('\n')).toMatch(/could not arrange the GUI indicator/)
    })
  })

  // The fake-context tests above assert the shape of the fix; this group proves
  // the behavior against the REAL cordis registry, which is what the harness
  // runs. It reproduces the cold-boot order: the engine is applied while the web
  // server is not provided yet, and the routes must appear by themselves when
  // the provider fiber comes up. This is as close to the live 404 as a test can
  // get without restarting the harness that hosts the session.
  describe('real cordis registry', () => {
    it('registers the routes when the web server appears after apply', async () => {
      const registered: GuiRoute[] = []
      const root = new Context()
      // Precondition: nothing provides the service yet, and the base context
      // cannot reach it — the exact cold-boot state that produced the live 404.
      expect(root.get('webServer')).toBeUndefined()

      const applied = installGuiBridge(root, fakeEngine())
      expect(applied).toBe(true)
      expect(registered).toEqual([])

      // The web-runtime boot fiber provides it later.
      const provider = root.plugin((ctx) => {
        ctx.provide('webServer', {
          register: (route: GuiRoute) => {
            registered.push(route)
            return () => {}
          },
        })
      })
      await provider
      await new Promise(resolve => { setTimeout(resolve, 10) })

      expect(registered.map(route => route.path)).toEqual([STATUS_ROUTE, CONFIG_ROUTE])
    })

    it('re-runs the install when the web server is withdrawn and provided again', async () => {
      // `ctx.inject` unloads and re-runs on service changes, so a harness that
      // completes its boot order differently (or replaces the server) still ends
      // up with exactly one pair of routes rather than none.
      const registered: GuiRoute[] = []
      const root = new Context()
      installGuiBridge(root, fakeEngine())
      const disposers: Array<() => void> = []
      const provider = root.plugin((ctx) => {
        const dispose = ctx.provide('webServer', {
          register: (route: GuiRoute) => {
            registered.push(route)
            return () => {}
          },
        })
        disposers.push(() => { void dispose() })
      })
      await provider
      await new Promise(resolve => { setTimeout(resolve, 10) })
      expect(registered).toHaveLength(2)

      disposers.forEach(dispose => dispose())
      await new Promise(resolve => { setTimeout(resolve, 10) })
      expect(root.get('webServer')).toBeUndefined()

      const second = root.plugin((ctx) => {
        ctx.provide('webServer', {
          register: (route: GuiRoute) => {
            registered.push(route)
            return () => {}
          },
        })
      })
      await second
      await new Promise(resolve => { setTimeout(resolve, 10) })
      expect(registered.map(route => route.path)).toEqual([STATUS_ROUTE, CONFIG_ROUTE, STATUS_ROUTE, CONFIG_ROUTE])
    })
  })
})
