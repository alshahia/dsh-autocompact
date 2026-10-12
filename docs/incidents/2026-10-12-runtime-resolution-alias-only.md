# The package resolved only through test aliases, not at runtime

- **Date:** 2026-10-12
- **Area:** `node_modules` layout / runtime module resolution
- **Status:** FIXED (`scripts/link-node-modules.mjs`)

## Symptom

`tests/` and `tsc` were green (110 tests, exit 0), but loading the plugin the way
the harness loads it failed:

```
IMPORT_FAIL Cannot find package '@deepseek-ai/dsh-compaction-basic'
  imported from D:\my_deepseek_harness\dsh-autocompact\src\index.ts
```

## Root cause

Two different resolvers were being trusted as one:

- **Tests / typecheck** resolve `@deepseek-ai/*` through facades:
  `vitest.config.ts` builds aliases from the target checkout's
  `tsconfig.base.json`, and `tsconfig.json` carries 430 `paths` entries.
- **The harness** loads plugin sources with `tsx` (cwd = the checkout), where bare
  specifiers follow plain Node resolution — no `paths`, no vitest aliases.

The package's `node_modules` was a single junction to the checkout root
(`D:\deepseek-harness_2\node_modules`), which holds only a handful of
`@deepseek-ai/*` links (no `dsh-compaction-basic`, no `schemastery`). Every
specifier that existed only as an alias therefore had **no runtime target at all**.

## Fix

`scripts/link-node-modules.mjs` builds a real junction farm for this package: each
needed `@deepseek-ai/<name>` points at the target checkout's package directory
(`src`), plus `@types/node`, `vitest`, and `typescript` from the checkout's own
install. The chosen checkout is recorded in `scripts/.dsh-target.txt` (gitignored)
so `vitest.config.ts` reads the same tree.

Links are removed with `cmd /c rmdir <path>`, never `fs.rmSync(recursive)`: a
reparse point must not be traversed, because the worst case is deleting the
checkout's whole `node_modules`.

## Evidence

- Before: `IMPORT_FAIL Cannot find package '@deepseek-ai/dsh-compaction-basic'`.
- After: `IMPORT_OK keys=AutocompactEngine,default`.
- After the rebuild: `tsc -p tsconfig.json --noEmit` exit 0; `vitest` 10 files /
  110 tests PASS (12:39, 2026-10-12).
- The checkout was untouched: `.pnpm` and `@deepseek-ai/dsh-agent` still present.

## Caveats

- A farm of package directories has **no `node_modules/.bin`**: run the tools
  through their package entries (`node node_modules/vitest/vitest.mjs run`,
  `node node_modules/typescript/bin/tsc -p tsconfig.json --noEmit`).
- `tsconfig.json` still hardcodes its `paths` at `../../deepseek-harness_2/...`;
  moving the target checkout requires regenerating that file (the farm and the
  vitest facade follow `.dsh-target.txt`).
- The regression class is generic: every new `@deepseek-ai/*` import must be added
  to `WANTED` in the link script **and** re-checked with the one-line `tsx` import
  probe — the suite alone cannot see this failure mode.
