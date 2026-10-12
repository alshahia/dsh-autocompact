/**
 * The summarize() override body: call the upstream summarizer unchanged, write
 * the archive into the project that owns the session, and prepend the pointer.
 * Extraction lives here so the engine stays thin and tests can inject a fake
 * summarizer.
 *
 * The archive root is resolved against `deps.projectDir` — the directory of the
 * project that owns the session, computed by the engine from the session's
 * creation cwd — never against the harness process cwd. Two projects therefore
 * write into two disjoint trees.
 *
 * @module dsh-autocompact/summarize
 */
import { relative, resolve, sep } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { summarizeWithLlm } from '@deepseek-ai/dsh-compaction-basic/src/summarizer.ts'
import type { SummarizationInput, SummaryResult } from '@deepseek-ai/dsh-compaction-basic/src/summarizer.ts'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { renderConversation, renderPointerText, writeArchive } from './archive.ts'
import type { ResolvedHandoffConfig } from './types.ts'

/** Reads the condensed span priced token count for the current agent (0 = unknown). */
export type SpanTokensReader = (agent: Agent) => number

export interface SummarizeDeps {
  ctx: Context
  config: ResolvedHandoffConfig
  /** Defaults to the upstream summarizeWithLlm; tests inject a fake. */
  summarizer: typeof summarizeWithLlm
  spanTokens: SpanTokensReader
  /** "provider/model" of the routed or fallback summarization target. */
  routedModel: string
  /** Absolute directory of the project that owns the session; the archive root. */
  projectDir: string
  /**
   * Called once with the project-relative archive pointer after a successful
   * write. The GUI status board uses it to report where a compaction landed;
   * a throwing callback never changes the archive result.
   */
  onArchived?: (pointer: string) => void
}

/** Summarize, archive the condensed span, and prepend the archive pointer. */
export async function summarizeWithArchive(
  deps: SummarizeDeps,
  input: SummarizationInput,
  agent: Agent,
  signal?: AbortSignal,
): Promise<SummaryResult> {
  const { config } = deps
  const result = await deps.summarizer(deps.ctx, {
    summarizationProvider: config.summarization.provider,
    summarizationModel: config.summarization.model,
    maxTokens: config.summarization.maxTokens,
  }, input, agent, signal)

  const measuredTokens = deps.spanTokens(agent)
  const summaryText = result.summary.map(block => block.type === 'text' ? block.text : '').join('\n')
  const sessionId = String(agent.session.id)
  const rootAbs = resolve(deps.projectDir, config.archive.root)
  try {
    const written = await writeArchive({
      root: rootAbs,
      sessionId,
      summary: summaryText,
      conversation: renderConversation(input, {
        sessionId,
        timestamp: new Date(),
        routedModel: deps.routedModel,
        measuredTokens,
      }),
      timestamp: new Date(),
      measuredTokens,
      routedModel: deps.routedModel,
      gitIgnore: config.archive.gitIgnore,
    })
    const pointerDir = pointerPath(written.dirAbs, deps.projectDir)
    deps.ctx.logger.info('dsh-autocompact: archived ' + pointerDir
      + ' (conversation.md + handoff.md, ~' + measuredTokens + ' tokens condensed)')
    try {
      deps.onArchived?.(pointerDir)
    } catch {
      // The GUI indicator is not allowed to influence the archive result.
    }
    return { ...result, summary: [{ type: 'text', text: renderPointerText(pointerDir) }, ...result.summary] }
  } catch (error: unknown) {
    if (config.archive.onFailure === 'proceed') {
      const message = error instanceof Error ? error.message : String(error)
      deps.ctx.logger.warn('dsh-autocompact: archive failed (proceeding without archive): ' + message)
      return result
    }
    throw error
  }
}

/** Project-relative path when the archive sits under the project, absolute otherwise. */
function pointerPath(dirAbs: string, projectDir: string): string {
  const rel = relative(projectDir, dirAbs)
  const insideProject = rel !== '' && !rel.startsWith('..')
  return insideProject ? rel.split(sep).join('/') : dirAbs
}
