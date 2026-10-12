# Warn-once reported every notice twice

- **Date:** 2026-10-12
- **Area:** `src/config.ts` → `LiveConfigReader.read`
- **Status:** FIXED (silent probe pass)

## Symptom

Every clamp/drop notice ("retain.tokens wins", "a preset needs both provider and
model", the summarization pair rule) was logged **twice** for one configuration
generation. The stated contract — one notice per distinct problem per resolved
generation — was not met, and the duplicate arrived on every read, so a long
session produced a steady doubled stream of warnings.

## Root cause

Change detection and notice emission ran in the same pass:

```
resolve(raw, warn)  →  emits notices (fills `warned`)
signature = JSON.stringify(result)
if (signature !== this.signature) { this.signature = signature; this.warned.clear() }
```

On the first read of each new generation the signature is new, so the memory the
pass had just filled was cleared immediately — and the *next* read re-emitted the
same notices. The bookkeeping order, not the warning logic, was wrong.

## Fix

Make the decision pass **silent** and only the reporting pass noisy
(`src/config.ts:325-333`):

1. `resolve(raw, NOOP)` — normalize with notices discarded; this can never mutate
   the warn-once memory.
2. Compare `JSON.stringify(probe)` with the remembered signature; clear the memory
   only when the *resolved* values actually changed.
3. `resolve(raw, this.notice)` — the reporting pass, deduplicated by message.

## Evidence

- `tests/config.spec.ts:101-114` is the regression test:
  - two reads of the same value → **1** warning;
  - an edit that changes the resolved values → **2**;
  - an edit that normalization erases (same conflict, different ignored ratio) → still **2**.
- PASS after the change: 72 tests / 7 files at that time; the suite has since grown to
  10 files / 110 tests green (2026-10-12) — see the current state in `README.md`.

## Caveats

- The generation identity is the JSON of the **resolved** config, not the raw
  document. An edit that provably resolves to the same values is deliberately quiet;
  that is what stops a user dragging a slider from re-logging an unchanged conflict.
- `JSON.stringify` of the resolved config is cheap (a handful of small sections) and
  is computed once per read, i.e. at most a few times per step.
