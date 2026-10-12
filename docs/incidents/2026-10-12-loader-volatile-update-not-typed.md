# `loader/volatile-update` is not a typed event to build on

- **Date:** 2026-10-12
- **Area:** `src/index.ts` (`refresh()`), `src/config.ts` (`LiveConfigReader`)
- **Status:** FIXED (re-read the live groups per operation; no listener)

## Symptom

After the move to a native volatile `Config`, the natural port of the old settings
bridge was to keep a listener that invalidates cached configuration when the loader
applies an in-place config update:

```ts
ctx.on('loader/volatile-update', () => { this.cached = this.reader.read(this.raw) })
```

Looking for the event's contract before relying on it turned up no declaration, which
raised the question of whether the plugin should use it at all.

## Root cause / finding

In the target checkout (`D:\deepseek-harness_2`) the name appears **only as a
consumer**, never inside an `Events` map:

| Kind | Location |
|---|---|
| consumer | `packages/llm/llm-deepseek/src/host.ts:57` |
| consumer | `packages/llm/llm-pi-ai/src/index.ts:310` |
| consumer | `packages/experimental/speech-to-text/src/index.ts:50` |
| consumer | `packages/client/product-analytics/src/index.ts:37` |
| test emitter | `packages/client/product-analytics/tests/collection.host.spec.ts:139` |

A grep for the name across `packages/**/*.ts` finds no `interface Events` member for
it, so it is an internal loader signal that shipped packages use opportunistically to
invalidate their own caches — not a documented contract a third-party plugin should
hang behaviour on. Its payload/ordering guarantees are not published, and it fires for
*any* volatile update, not specifically for this plugin's row.

## Fix

Drop the listener. The engine reads the live groups at the start of every operation:

- `LiveConfigReader.read(raw)` normalizes all seven sections (one `.get()` per group)
  into a fresh resolved config (`src/config.ts:325-333`);
- `AutocompactEngine.refresh()` calls it at the top of `compactIfNeeded`,
  `summarize`, and `previewPressure`, then re-projects the parent's config
  (`src/index.ts:165-186`);
- when the parent validator rejects a mid-edit projection, the engine logs one warning
  and the base engine's overflow policy keeps its previous values while the trigger
  math follows the edit.

Reading at decision time is strictly stronger than invalidation: there is no window in
which a stale cache can be used, no ordering assumption about a loader event, and one
code path covers edits from the settings form, the GUI panel, and a
`configEditor.edit()` write alike.

## Evidence

- Consumer/emitter inventory above, read from the target checkout at
  `D:\deepseek-harness_2`.
- `src/index.ts:165-186` — the doc comment records the decision ("so a live edit needs
  no `loader/volatile-update` listener").
- `tests/engine.spec.ts:198-256` — a live configuration edit changes the next pressure
  check; `enabled: false` applied mid-flight disables auto-compact and re-enabling
  restores it, with no reload and no event plumbing.

## Caveats

- Each operation pays one `.get()` plus normalization per section (a handful of small
  objects) and one `JSON.stringify` for the warn-once generation check. Measured cost
  is negligible beside the token metering that follows it, but it is not zero.
- If the loader ever publishes `loader/volatile-update` as a typed event, a listener
  could become a useful *fast path* — but it must stay an optimization, never the
  correctness mechanism.
