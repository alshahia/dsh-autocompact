/**
 * The `session_memory` tool: the model's own lever on its context window.
 *
 * The tool is deliberately thin. It parses arguments, hands the work to
 * {@link MemoryRuntime}, and returns text — the runtime owns every decision and
 * every refusal message, and the drop itself lands later, at a step boundary.
 * That keeps one rule true: **a tool call never mutates the surface it was
 * called on**. It measures, plans, and archives; the replacement commits at the
 * next `step/start`, where the previous request is finished.
 *
 * The registry is read defensively. A composition without a tool service keeps
 * compacting and archiving exactly as before, and the engine logs once that the
 * model-directed lever is unavailable instead of failing to load.
 *
 * @module dsh-autocompact/tool
 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { MemoryRuntime } from './runtime.ts'

/** Structural view of the tool registry, so an absent service stays optional. */
interface ToolRegistryLike {
  register(definition: unknown): () => void
}

/** Look up a service without importing it. */
function service<T>(ctx: Context, name: string): T | undefined {
  try {
    const get = (ctx as unknown as { get?: (key: string) => unknown }).get
    if (typeof get !== 'function') return undefined
    return get.call(ctx, name) as T | undefined
  } catch {
    return undefined
  }
}

/** One line per action, used in the tool description and its own usage tail. */
const ACTIONS = ['inspect', 'plan', 'apply', 'pin', 'recall'] as const

/**
 * Define `session_memory`.
 *
 * Actions:
 * - `inspect` — the pressure band (used tokens against the memory budget), the
 *   request picture against the context window, and a bounded map of the
 *   conversation surface with one line per step.
 * - `plan` — a dry run for a step selection (steps are named `turn.step`, or a
 *   bare turn): what would be replaced, what would
 *   be freed, and every reason it would be refused.
 * - `apply` — archive the selected steps, then queue the replacement for the
 *   next step boundary.
 * - `pin` — protect surface seqs; no drop may shadow a pinned node.
 * - `recall` — search the archives of previously dropped spans without loading
 *   them into the context window.
 */
export function memoryToolDefinition(runtime: MemoryRuntime) {
  return defineTool({
    name: 'session_memory',
    description: 'Manage this session\'s context window. inspect reports the pressure band and a bounded map of the '
      + 'conversation surface; plan and apply drop finished steps (the dropped span is archived to disk first and '
      + 'replaced by one short tombstone, so nothing is deleted); pin protects surface seqs from every drop; recall '
      + 'searches the archives of what was dropped earlier. Applying a drop takes effect at the next step boundary.',
    parameters: {
      action: {
        type: 'string',
        required: true,
        enum: [...ACTIONS],
        description: 'inspect, plan, apply, pin, or recall.',
      },
      steps: {
        type: 'string',
        description: 'For plan/apply: the steps to drop, named as in the first column of inspect: "3.1" is one step,'
          + ' "3" is every step of turn 3, "1-3" is turns 1 to 3, and "3.1-3.3" is steps 1 to 3 of turn 3.',
      },
      seqs: {
        type: 'string',
        description: 'For pin: the surface seqs to pin or unpin, as "12", "12-14", or "12,13".',
      },
      off: {
        type: 'boolean',
        description: 'With pin: unpin the named seqs instead of pinning them.',
      },
      detail: {
        type: 'string',
        enum: ['summary', 'full'],
        description: 'With inspect: "full" lists every surface node instead of the bounded map.',
      },
      query: {
        type: 'string',
        description: 'For recall: literal text to find in this session\'s archives.',
      },
    },
    output: {
      schema: { type: 'string' },
      render: (_args: unknown, value: string) => [{ type: 'text' as const, text: value }],
    },
    isConcurrencySafe: () => false,
    timeoutMs: 60_000,
    async execute(args, exec) {
      const agent = exec.agent
      if (agent === undefined) {
        return 'session_memory needs a driving agent and this call has none; nothing was changed.'
      }
      switch (args.action) {
        case 'inspect': return runtime.inspect(agent, args.detail ?? 'summary')
        case 'plan': return runtime.plan(agent, args.steps ?? '', false)
        case 'apply': return runtime.plan(agent, args.steps ?? '', true)
        case 'pin': return runtime.pin(agent, args.seqs ?? '', args.off === true)
        case 'recall': return runtime.recall(agent, args.query ?? '')
        default:
          return 'unknown action "' + String(args.action) + '"; use one of ' + ACTIONS.join(', ') + '.'
      }
    },
  })
}

/**
 * Register `session_memory` when this composition has a tool registry.
 *
 * @returns true when the tool was registered.
 */
export function installMemoryTool(ctx: Context, runtime: MemoryRuntime): boolean {
  const registry = service<ToolRegistryLike>(ctx, 'tools')
  if (registry === undefined || typeof registry.register !== 'function') {
    ctx.logger.info('dsh-autocompact: no tool registry in this composition; the session_memory tool is off')
    return false
  }
  try {
    ctx.effect(() => {
      const dispose = registry.register(memoryToolDefinition(runtime))
      return () => {
        if (typeof dispose === 'function') dispose()
      }
    })
    return true
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    ctx.logger.warn('dsh-autocompact: could not register the session_memory tool (' + message + ')')
    return false
  }
}
