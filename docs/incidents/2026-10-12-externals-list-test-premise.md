# A test pinned the bundle's externals to a list that was never the rule

**Date:** 2026-10-12 · **Version:** 0.3.2 · **Status:** fixed

## Symptom

`tests/client.spec.ts` asserted that `client.js` requires exactly `['react']`,
justified by a comment claiming "the shell's module table only guarantees
`react`". Turning the tuner into a real popover required `react-dom`
(`createPortal`), which that assertion would have rejected — the fix depended on
disproving the test first.

## Root cause

The claim was never checked against the shell. It was inferred from the fact
that the bundle had only needed `react` so far, and then written down as a
platform rule. The actual rule is a frozen set:

- `packages/client/web/src/platform.ts` (`PLATFORM_MODULES`, seeded by
  `seed.ts`) freezes `react`, `react/jsx-runtime`, `react-dom`,
  `react-dom/client`, `@deepseek-ai/cordis`, `@deepseek-ai/dsh-client-store`,
  `@deepseek-ai/dsh-client-ui-slots`, `@deepseek-ai/dsh-client-ui-primitives`,
  `@deepseek-ai/dsh-client-ui-dockkit`. Every fetched bundle's `require`
  resolves against exactly that set.
- This workspace's own guide already said so:
  `docs/best-practices/creating-a-client-card-plugin.md` — "externals = the
  platform module table: `react`, `react/jsx-runtime`, `react-dom`,
  `react-dom/client`, …".

So the documentation was right and the test comment was wrong: a
"test as source of truth" failure, not a harness change.

## Fix

- The bundle now requires `react` and `react-dom`, guarded: if `react-dom` is
  missing the panel degrades to inline rendering instead of crashing.
- The test was renamed to `'requests only shell platform modules as externals'`
  and asserts `['react', 'react-dom']`, with the corrected rationale in a
  comment.
- The forbidden direction is unchanged and still machine-enforced by the purity
  gate: third-party bundles may not value-import `@deepseek-ai/*` client
  packages. Only platform-table entries are externals, and `react-dom` is one.

## Evidence

- Platform module table read in the 0.2.1-alpha.2 checkout
  (`platform.ts`, `seed.ts`).
- The workspace guide's externals row (same list, including `react-dom`).
- `node node_modules/vitest/vitest.mjs run` → 10 files / 120 tests pass.

## Reusable rule

Never pin a platform capability inside a test comment. Assert against the frozen
table (`PLATFORM_MODULES`) or the guide. When a needed external looks missing,
check the table before concluding it is forbidden — "illegal import" and
"allowed but never declared" look identical from inside a bundle.
