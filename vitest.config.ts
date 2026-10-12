import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { defineConfig } from 'vitest/config'

const ROOT = dirname(fileURLToPath(import.meta.url))

// The target DSH checkout is chosen by DSH_TARGET, then by a recorded
// scripts/.dsh-target.txt, then by the conventional machine-local location.
// Reading one record here keeps the vitest alias facade and the runtime module
// resolution pointing at the SAME tree.
function resolveTarget(): string {
  const record = resolve(ROOT, 'scripts', '.dsh-target.txt')
  if (existsSync(record)) {
    const recorded = readFileSync(record, 'utf8').trim()
    if (recorded !== '' && existsSync(recorded)) return recorded
  }
  const candidates = [
    process.env.DSH_TARGET,
    'D:/deepseek-harness_2',
    resolve(ROOT, '..', 'deepseek-harness_2'),
  ].filter((p): p is string => typeof p === 'string' && p !== '')
  const found = candidates.map(p => resolve(p)).find(p =>
    existsSync(resolve(p, 'package.json'))
    && existsSync(resolve(p, 'packages', 'compaction', 'compaction-basic', 'src', 'index.ts')))
  if (found === undefined) throw new Error('no DSH checkout target found; set DSH_TARGET to your DSH checkout')
  return found
}
const FORK = resolveTarget()

// The target checkout's tsconfig.base.json is its documented resolution facade
// (header comment there): exact paths for every repo-local bare specifier, no
// include (match-all). Its lib/ builds would create a second module-singleton
// copy beside src, so — like the harness runtime (tsx over the same paths) —
// vitest must resolve everything to fresh src. vite-tsconfig-paths cannot do
// that here: it scopes a project's paths to files inside the project directory
// (our workspace sits outside the checkout), and subpath imports then fell
// through to the junction exports under node_modules and were externalized
// raw (SyntaxError on TS sources). These explicit aliases carry the same
// mapping to every importer instead, generated from whichever checkout is the
// current target.

// The base file's only comments are whole-line // comments (no string value
// spans lines), so stripping those lines yields valid JSON.
const base = JSON.parse(
  readFileSync(resolve(FORK, 'tsconfig.base.json'), 'utf8').replace(/^\s*\/\/.*$/gm, ''),
)
const paths = base.compilerOptions.paths as Record<string, string[]>

// Fork workspace packages this workspace can reach (same set as
// scripts/link-node-modules.mjs). Subpath aliases need each package's src dir.
const WORKSPACE_PACKAGES = [
  'cordis', 'cordis-plugin-include', 'cordis-plugin-loader', 'schemastery', 'cosmokit',
  'dsh-compaction', 'dsh-compaction-basic', 'dsh-compaction-tool-result-pruner',
  'dsh-llm', 'dsh-session', 'dsh-token-meter', 'dsh-agent', 'dsh-commands',
  'dsh-settings', 'dsh-settings-file', 'dsh-session-projection', 'dsh-util-values', 'dsh-client-ui-slots', 'dsh-client-ui-settings',
  'dsh-client-ui-settings-plugins', 'dsh-client-store', 'dsh-client-locale',
  'dsh-client-ui-renderer', 'dsh-workspace',
]

const aliases: { find: string, replacement: string }[] = []

// 1) '/src/*' subpath imports -> the package's src dir (exports-mapped TS
//    sources; the base facade has no patterns for them). Must precede the
//    bare-package keys below.
for (const name of WORKSPACE_PACKAGES) {
  const exact = paths['@deepseek-ai/' + name]
  if (!exact || exact.length === 0) continue
  const target = resolve(FORK, exact[0])
  const srcDir = /\.ts$/.test(target) ? dirname(target) : target
  aliases.push({ find: '@deepseek-ai/' + name + '/src/', replacement: srcDir + '/' })
}

// 1b) Some base facades lack bare keys for a few packages (e.g. the RUN
// checkout's paths carry only 'dsh-settings/types'), which would leave those
// imports on their junction's lib build and violate the everything-to-src
// rule. A checkout-relative fallback restores the bare + '/src/*' aliases;
// the same layout exists on both checkouts.
const FALLBACK_SRC_DIRS: Record<string, string> = {
  'dsh-settings': 'packages/settings/settings/src',
  'dsh-settings-file': 'packages/settings/settings-file/src',
}
const fallbackAliases: { find: string, replacement: string }[] = []
for (const [name, rel] of Object.entries(FALLBACK_SRC_DIRS)) {
  if (paths['@deepseek-ai/' + name]) continue
  const dir = resolve(FORK, rel)
  fallbackAliases.push({ find: '@deepseek-ai/' + name + '/src/', replacement: dir + '/' })
  fallbackAliases.push({ find: '@deepseek-ai/' + name, replacement: dir })
}

// 2) Exact keys — base facade plus the fallback above — longest-first so a
// specific subpath key wins over its bare package prefix (a bare alias also
// prefix-matches subpaths, so ordering carries the precedence).
const exactAliases = [
  ...Object.keys(paths)
    .filter(k => !k.includes('*') && Array.isArray(paths[k]) && paths[k].length > 0)
    .map(k => ({ find: k, replacement: resolve(FORK, paths[k][0]!) })),
  ...fallbackAliases,
].sort((a, b) => b.find.length - a.find.length)
aliases.push(...exactAliases)

// Standard (stage-3) decorators appear in some target-checkout sources (the
// dev fork's dsh-llm) and esbuild passes them through untransformed, which
// crashes the module runner with a raw SyntaxError. This is the target
// checkouts' own vitest.shared.ts standardDecoratorPlugin, inlined so the
// config stays independent of any one checkout's tree (typescript resolves
// through the workspace junction). On checkouts without decorators it is a
// regex-guarded no-op.
const decoratorSyntax = /^\s*@[A-Za-z_$][\w$]*/m
function standardDecoratorPlugin() {
  return {
    name: 'dsh-standard-decorators',
    enforce: 'pre' as const,
    transform(code: string, id: string) {
      const file = id.split('?', 1)[0]!
      if (!/\.[cm]?tsx?$/.test(file) || !decoratorSyntax.test(code)) return
      const result = ts.transpileModule(code, {
        fileName: file,
        compilerOptions: {
          target: ts.ScriptTarget.ES2024,
          module: ts.ModuleKind.ESNext,
          jsx: file.endsWith('x') ? ts.JsxEmit.ReactJSX : undefined,
          sourceMap: true,
        },
      })
      return {
        code: result.outputText
          .replace(
            /^(\s*)(__esDecorate\()/gmu,
            '$1/* v8 ignore next -- compiler-synthetic decorator accessors have no source behavior */ $2',
          )
          .replace(/\n?\/\/# sourceMappingURL=.*$/u, '\n'),
        map: result.sourceMapText,
      }
    },
  }
}

export default defineConfig({
  plugins: [standardDecoratorPlugin()],
  resolve: { alias: aliases },
  test: {
    environment: 'node',
    include: ['tests/**/*.spec.ts'],
  },
})
