# An inline dock panel pushed the composer up the page — float it above

**Date:** 2026-10-12 · **Version:** 0.3.2 · **Status:** fixed (client half; visual
check is a browser checkpoint)

## Symptom (user report, live `web` profile)

The **Auto-compact** pill rendered correctly beside the context ring, but clicking
it produced "very bad ux": the message box was pushed up, the bottom bar carrying
the context ring and the pill jumped to the middle of the page, and the message
history was pushed up or hidden.

## Root cause

`client.js` rendered the tuner as a **child of the dock row**:

```js
children.push(pill)
if (open) children.push(h(Panel, { key: 'panel', … }))   // ← in-flow sibling
return h('div', { className: 'dshac-row' }, children)
```

`conversation.composer.dock` is a list slot laid out by the resident composer
card, so the row is an in-flow flex item of the composer bar. A ~400 px panel
therefore became part of the bar's height: the bar grew upward, the ring/bar
moved to mid-page and everything above it was pushed. The panel was never a
popover — it was page content that happened to contain form fields.

## Why "just position it absolute inside the row" is not the fix

A floating panel must escape its ancestor **containing block** and **overflow
clip**. `transform`, `filter`, `backdrop-filter`, and `will-change` on any
ancestor make that ancestor the containing block for `position: fixed`
descendants, and `overflow: hidden` ancestors clip them. The composer subtree is
exactly such a place (the harness's own surface skin sets
`backdrop-filter: var(--dsw-menu-backdrop-filter)`). So the panel has to leave the
composer subtree entirely — a portal to `<body>` or the native top layer.

## What the harness itself does (the pattern to copy)

`StatsPills.tsx:195-231` (`DialogPill`, the context-ring siblings in the same
dock) keeps the trigger inline and renders the panel as
`createPortal(…, document.body)`, positioned by `useAnchoredPosition({ side:
'top', gap: 8, margin: 12 })` (`ui-chat/src/client/chat/stat-dialog.ts:40-47`),
dismissed by `useDismissOnOutsidePointer` plus a capture-phase `click` listener
and Escape, and skinned by `stat-dialog.module.css` (`position: fixed`, `z-index:
1100`, `--dsw-specific-menu`, `--dsw-elevation-prominent`).

A third-party bundle may not import the `@deepseek-ai/*` client packages
(README limitation 4), so the geometry/dismissal was reimplemented in the bundle
instead of importing `useAnchoredPosition`.

## Fix (v0.3.2)

- The pill is wrapped in a shrink-wrapping `.dshac-anchor` span; the tuner is
  rendered with `createPortal(panel, document.body)` when open, so it never
  rejoins the row's flow. If `react-dom` is unavailable the panel degrades to
  being rendered inline — still `position: fixed` from the stylesheet, so the
  composer is not pushed even then.
- `.dshac-panel` is `position: fixed; z-index: 1100`, right-aligned on the pill
  (`left = rect.right - width`), placed above it (`top = rect.top - 8 - height`),
  and clamped to a 12 px viewport margin. Height is capped
  (`max-height: min(70vh, 520px)`) with `overflow: auto` and
  `overscroll-behavior: contain`, so a tall tuner scrolls itself instead of
  covering the transcript.
- A hidden measure pass (`visibility: hidden; left: 0; top: 0`) places the panel
  from real dimensions in the same commit that opens it.
- Re-anchoring on scroll (capture phase), resize, and `ResizeObserver` on the
  panel **and the anchor and the row**. The row observer is the delta against the
  shipped hook: the progress strip appearing beside the pill *moves the pill*
  without any window resize or scroll, which would otherwise leave the panel
  behind mid-compaction.
- Dismissal: the pill's click toggles; `pointerdown` outside and capture-phase
  `click` outside close; Escape closes and returns focus to the pill; the panel
  takes focus on open and is `role="dialog"` with `aria-label`; the pill carries
  `aria-haspopup="dialog"` and `aria-expanded`. Non-modal by design — no focus
  trap, the transcript stays usable.
- The **in-progress indicator stays an inline row child** (it must remain visible
  while the tuner is closed); only the tuner floats.
- Skin switched to the harness surface tokens (`--dsw-specific-menu`,
  `--dsw-elevation-prominent`, `--dsw-radius-lg`, `--dsw-alias-label-*`,
  `--dsw-alias-border-l1`, `--dsw-alias-interactive-bg-hover`) with fallbacks,
  replacing the transparent `currentColor` box that read as foreign next to the
  ring's dialog.

## Correction to a test premise (same change)

`tests/client.spec.ts` asserted that the bundle requires **exactly `['react']`**,
justified as "the shell's module table only guarantees `react`". That premise was
wrong: `packages/client/web/src/platform.ts:8-14` (seeded by `seed.ts:28-38`)
freezes `react`, `react/jsx-runtime`, `react-dom`, `react-dom/client`,
`@deepseek-ai/cordis`, `dsh-client-store`, `dsh-client-ui-slots`,
`dsh-client-ui-primitives`, and `dsh-client-ui-dockkit`, and every fetched bundle
resolves its externals against exactly that set. The project's own guide agrees
(`docs/best-practices/creating-a-client-card-plugin.md:130-131`: "externals = the
platform module table: `react`, `react/jsx-runtime`, `react-dom`,
`react-dom/client`, …"). The assertion now expects `['react', 'react-dom']` and
carries the corrected rationale. `@deepseek-ai/*` client packages remain off
limits.

## Evidence

| Check | Result |
|---|---|
| `node --check client.js` | exit 0 |
| `node node_modules/vitest/vitest.mjs run` | 10 files / **120 tests** passed, exit 0 (13:43 local) |
| `node node_modules/typescript/bin/tsc -p tsconfig.json --noEmit` | exit 0 |
| Structural contract (7 new assertions) | portal target, no row child, fixed+z-index, height cap, clamp math, row/anchor observers, dismissal + Escape + a11y, indicator still inline |
| Browser placement/behaviour | **not machine-verified here** — this repo's vitest runs `environment: 'node'` and links no react/jsdom, so nothing can render the slot; jsdom also has no layout. Refresh the GUI to confirm. |

## Caveats

- The pixel placement was not machine-verified (see above). The user-visible
  acceptance test is: open the tuner and observe that the composer bar, the
  message box and the transcript do **not** move.
- `GET /dsh-autocompact/status` still reported `capabilities.write: false` with
  the pre-fix reason at 13:40 local — the host-side `findRow` fix (incident 10)
  is not in the running process yet, so **Save is dead until one harness
  restart**. The client half needs only a page refresh (bundles are fetched per
  page load, proven by the pill appearing without a restart).
- The routes are still not behind the GUI's own session gate (recorded in
  incident 11).

## Reusable rule

When a slot's owner lays out your entry in flow (a dock, a bar, a list), anything
you render inside that entry is page layout. A panel belongs to the **viewport**,
not to the row: portal it to `<body>`, place it from the trigger's rect, clamp it,
cap its height, and dismiss it on outside press and Escape. Copy the shipped
anchor dialog before inventing geometry — and watch the *anchor's ancestors'*
size changes, not just the window's.
