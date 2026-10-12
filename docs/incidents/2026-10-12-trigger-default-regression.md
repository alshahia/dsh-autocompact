# A defaulted trigger ratio broke pure-token configurations

- **Date:** 2026-10-12
- **Area:** `src/config.ts` (`triggerGroup`), `src/trigger.ts` (`needsWindowFor`)
- **Status:** FIXED (`0` is the "unset" sentinel; `0.8` is applied only when nothing is configured)

## Symptom

The first volatile `Config` draft gave `trigger.ratio` a schema default of `0.8`,
mirroring the upstream engine's default. Every configuration then became
window-relative: a user who configured only an absolute token trigger still got a
context-window lookup for its routed model, and on an adapter that declares no
`contextWindow` the pressure path threw

```
TargetPressureConfigError: dsh-autocompact: no context capacity for <provider>/<model>;
configure contextWindow on that adapter model
```

so a perfectly valid absolute-token setup could not fire at all.

## Root cause

A schema default cannot distinguish **"the user never touched this field"** from
**"the user chose this value"**. With `ratio` always defined, `needsWindowFor`
(`src/trigger.ts:40-52`) correctly concluded "a ratio is in play" for every
configuration, and `resolveHandoffSpec` honestly demanded a window. The bug was in
the *input shape*, not the math.

## Fix

1. **`0` means unset.** `trigger.ratio` and `trigger.tokens` default to `0`
   (`src/config.ts:77-81`); the reader treats a non-positive or non-finite number as
   "not configured" (`positiveNumber`, `src/config.ts:176-178`). The same sentinel is
   used for `retain.ratio` / `retain.tokens`.
2. **The upstream default is applied at read time, only when both limits are unset**
   (`src/config.ts:341-346`, constant `UPSTREAM_TRIGGER_RATIO = 0.8`). The comment on
   `triggerGroup` records why the default cannot live in the schema.
3. **An absolute limit configured alone stays window-free**: `needsWindowFor` returns
   false for `mode: tokens` with a token limit, so no adapter lookup happens and no
   window is required.
4. **The same reasoning is enforced from the other side**: `tests/config.spec.ts:157-169`
   projects a hostile matrix of raw documents (including `{ trigger: { tokens: 1 }, retain: { ratio: 0.9 } }`
   and `{ trigger: { ratio: 0.99 }, retain: { ratio: 1 } }`) into `resolveConfig(...)` and
   asserts the parent validator never throws — the projection must stay adoptable
   while a form is half-edited.

## Evidence

- `tests/config.spec.ts:51-60` — nothing configured → `ratio: 0.8`; `mode: tokens`
  alone → `ratio: 0.8` (inherited); `{ mode: 'tokens', tokens: 200 }` → `ratio` is
  `undefined`.
- `tests/trigger.spec.ts:32-43` — "no limits configured: inherits the upstream 0.8
  default" and "an absolute limit configured alone stays window-free".
- `tests/trigger.spec.ts:65-71` — pure-token mode resolves without a window;
  ratio-based fields require one.
- PASS at the time of this fix: 72 tests / 7 files; the suite has since grown to
  10 files / 110 tests green (2026-10-12) — see the current state in `README.md`.

## Caveats

- `0` is therefore **not** a legal explicit ratio or retain value: `ratio: 0` reads as
  "unset" and falls back to the `0.8` window default. That is the deliberate trade-off
  — a zero-fraction trigger is meaningless, while "unset" must be expressible.
- A ratio-based configuration still requires the routed model to declare
  `context.contextWindow`; that is a real configuration error and is reported as one,
  once per target, by the run loop.
