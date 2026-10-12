import { execFileSync } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Build this package's node_modules junction farm against a DSH checkout.
 *
 * Why this exists: the plugin is source-loaded by the running harness through
 * `tsx`, and tsx resolves bare specifiers with plain Node rules — it does NOT
 * use tsconfig `paths` and it does NOT see this repo's vitest alias facade.
 * The package therefore needs real `node_modules/@deepseek-ai/<name>` junctions
 * pointing at the checkout's `src/` trees, exactly as the harness resolves its
 * own workspace packages. Tests pass without this (vitest aliases + tsc paths),
 * so an alias-only resolution bug stays invisible until the plugin is mounted.
 *
 * Target choice: --target argument, then DSH_TARGET, then the running harness
 * checkout, then a sibling fork. The choice is recorded in
 * scripts/.dsh-target.txt (gitignored) so vitest.config.ts reads the SAME tree.
 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const NM = join(ROOT, 'node_modules')
const SCOPE = join(NM, '@deepseek-ai')

function candidatePaths() {
  const argIndex = process.argv.indexOf('--target')
  const fromArg = argIndex === -1 ? undefined : process.argv[argIndex + 1]
  return [
    fromArg,
    process.env.DSH_TARGET,
    'D:/deepseek-harness_2',
    resolve(ROOT, '..', 'deepseek-harness_2'),
  ].filter(Boolean).map(p => resolve(p))
}
function isDshCheckout(p) {
  return existsSync(join(p, 'package.json'))
    && existsSync(join(p, 'packages', 'compaction', 'compaction-basic', 'src', 'index.ts'))
}
const FORK = candidatePaths().find(isDshCheckout)
if (FORK === undefined) {
  throw new Error('no DSH checkout found (pass --target <path> or set DSH_TARGET)')
}
mkdirSync(join(ROOT, 'scripts'), { recursive: true })
writeFileSync(join(ROOT, 'scripts', '.dsh-target.txt'), FORK + '\n')
console.log('target checkout: ' + FORK)

/** Map @deepseek-ai package names to checkout-relative dirs by scanning manifests. */
function scanWorkspacePackages() {
  const found = new Map()
  const visit = (rel) => {
    const dir = join(FORK, rel)
    if (!existsSync(dir)) return
    let entries
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === 'lib') continue
      const childRel = rel === '' ? entry.name : rel + '/' + entry.name
      const manifest = join(dir, entry.name, 'package.json')
      if (existsSync(manifest)) {
        try {
          const name = JSON.parse(readFileSync(manifest, 'utf8')).name
          if (typeof name === 'string' && name.startsWith('@deepseek-ai/') && !found.has(name)) {
            found.set(name, childRel)
          }
        } catch { /* unreadable manifest: skip */ }
      }
      visit(childRel)
    }
  }
  visit('packages')
  visit('vendor')
  return found
}
const packageDirs = scanWorkspacePackages()

/**
 * Junction set this package resolves at runtime or typecheck time.
 * `required` entries abort the build when the target checkout lacks them;
 * optional entries only print a skip so the farm stays buildable across
 * checkout versions (0.2.x renames/removes client and settings packages).
 */
const WANTED = [
  ['cordis', true], ['schemastery', true],
  ['dsh-compaction', true], ['dsh-compaction-basic', true],
  ['cordis-plugin-include', false], ['cordis-plugin-loader', false], ['cosmokit', false],
  ['dsh-llm', false], ['dsh-session', false], ['dsh-token-meter', false], ['dsh-agent', false],
  ['dsh-agent-loop', false], ['dsh-util-values', false], ['dsh-session-projection', false],
  ['dsh-config-editor', false], ['dsh-settings', false], ['dsh-commands', false],
  ['dsh-workspace', false],
]

/** npm dependencies resolved through the target checkout's own install. */
const NPM_DEPS = [
  { name: '@types/node', from: '', required: true },
]

/** Root dev tools used directly from this package. */
const ROOT_TOOLS = ['vitest', 'typescript']

function lstatSyncSafe(p) {
  try { return lstatSync(p) } catch { return undefined }
}
/**
 * Remove a link WITHOUT ever following it. `fs.rmSync(recursive)` on a
 * directory junction is not obviously target-safe, and the worst case here is
 * deleting the whole checkout node_modules; `cmd /c rmdir` removes the reparse
 * point only. Real directories are still removed recursively.
 */
function removeLink(dest) {
  const st = lstatSyncSafe(dest)
  if (st === undefined) return
  if (st.isSymbolicLink()) {
    execFileSync('cmd', ['/c', 'rmdir', dest], { stdio: 'ignore' })
    return
  }
  rmSync(dest, { recursive: true, force: true })
}
function linkScoped(name, target) {
  const dest = join(SCOPE, name)
  removeLink(dest)
  symlinkSync(target, dest, 'junction')
  console.log('@deepseek-ai/' + name + ' -> ' + target)
}
function linkRoot(name, target) {
  const dest = join(NM, name)
  mkdirSync(dirname(dest), { recursive: true })
  removeLink(dest)
  symlinkSync(target, dest, 'junction')
  console.log(name + ' -> ' + target)
}

// A stale single-junction node_modules (an early layout where the whole
// directory pointed at the checkout root) is replaced wholesale.
const nmStat = lstatSyncSafe(NM)
if (nmStat !== undefined && nmStat.isSymbolicLink()) removeLink(NM)
mkdirSync(SCOPE, { recursive: true })

for (const [name, required] of WANTED) {
  const rel = packageDirs.get('@deepseek-ai/' + name)
  if (rel === undefined) {
    if (required) throw new Error('required target package missing: @deepseek-ai/' + name)
    console.log('@deepseek-ai/' + name + ' -> (absent in target; skipped)')
    continue
  }
  linkScoped(name, join(FORK, rel))
}

function resolvePkg(name, cwd) {
  // Some packages do not export './package.json'; fall back to the main entry
  // and walk up to the package root.
  const probe = 'const p = (() => { try { return require.resolve(' + JSON.stringify(name + '/package.json') + ') } catch { return require.resolve(' + JSON.stringify(name) + ') } })(); console.log(p)'
  const entry = execFileSync('node', ['-e', probe], { cwd, encoding: 'utf8' }).trim()
  let dir = dirname(entry)
  while (dir !== dirname(dir) && !existsSync(join(dir, 'package.json'))) dir = dirname(dir)
  if (!existsSync(join(dir, 'package.json'))) throw new Error('cannot locate package root for ' + name)
  return dir
}
for (const { name, from, required } of NPM_DEPS) {
  const consumer = join(FORK, from)
  if (!existsSync(consumer) && from !== '') { console.log(name + ' -> (consumer absent; skipped)'); continue }
  try {
    linkRoot(name, resolvePkg(name, consumer))
  } catch (error) {
    if (required) throw error
    console.log(name + ' -> (absent in target; skipped)')
  }
}
for (const name of ROOT_TOOLS) linkRoot(name, resolvePkg(name, FORK))
console.log('link complete')
