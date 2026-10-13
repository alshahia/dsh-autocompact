# A step is not a number: step identity, and the surface order a drop leaves behind

**Date:** 2026-10-13 · **Version:** 0.4.0 · **Status:** fixed (unit-verified; no live session yet)

Both issues below were found by the first tests written for the new **session memory**
feature (`src/memory.ts`, `src/drop.ts`, `src/runtime.ts`, `src/tool.ts`): a model-facing
tool that drops finished steps from the visible conversation, replacing them with one
tombstone after archiving the dropped span to disk. Planning a drop needs two things the
first cut got wrong — a way to *name* a step unambiguously, and a way to attribute every
surface node to one.

## Issue 1 — `step` is numbered *within* a turn

**Symptom.** `inspect` and the plan outline printed a single entry per step number:

```
plan: drop steps 1 (5 surface node(s), ~453 request tokens) -> one ~309-token tombstone
  - step 1: assistant, user, assistant, user, assistant (~453 tokens)
```

Five nodes from **four different turns** were one step, so `plan 1` selected nodes the
user never asked about, and the "step 2" of turn 1 and of turn 3 were the same number.

**Root cause.** The harness numbers steps inside a turn. In
`packages/core/agent-loop/src/agent.ts`:

| Line | Code | Meaning |
|---|---|---|
| 305 | `const turn = phase.turn + 1` | the turn counter is monotonic for the session |
| 317 | `const step = phase.step + 1` | the step counter is the *phase's*, not the session's |
| 396 | `phase.step = 0` | reset at the end of each turn |

So "step 1" names a different step in every turn, and a bare step number is not a
session-unique identity. The first cut keyed the surface map by `step` alone.

**Fix.** A step is identified as `turn.step` everywhere: the map's first column, the
tombstone outline, and the tool's `steps` argument (`"3.1"` = turn 3, step 1; `"3"` =
every step of turn 3; `"1-3"` = turns 1 to 3; `"3.1-3.3"` = steps 1 to 3 of turn 3).
Selection is resolved against the steps that are actually on the surface
(`resolveSelection`), so a bare turn expands to whatever steps it holds, and an
unmatched key is reported as `no such step` rather than silently selecting nothing.

Dropping is **whole-step**: a step that straddles the retained-tail boundary is refused
rather than half-removed. Without that rule, dropping the part of the newest turn that
happens to be below the tail boundary would remove the current request and leave the
answer that came from it.

## Issue 2 — the opening user message, and a surface that is no longer ascending

**Symptom A.** The user message that opens a turn precedes that turn's first
`step/start`, so attributing a node to "the last step marker before it" left the request
with no step at all (`key: null`). A drop then selected only the assistant answer.

**Symptom B.** After one drop landed, *every* node lost its step, `inspect` printed no
step rows at all, and a following `plan 2` refused with `no such step: 2`. A probe
printed the state right after the drop:

```
SURFACE AFTER: 33,7,9,13,15,19,21,25,27          seq= 35
STEP MARKERS: [{2,1.1},{8,2.1},{14,3.1},{20,4.1},{26,5.1}]
TURN STARTS:  [{0,t1},{6,t2},{12,t3},{18,t4},{24,t5},{30,t6}]
MAP steps: []   MAP entries: 33/user/null 7/user/null 9/assistant/null …
```

The markers were all present, yet no node was attributed. The tombstone event (seq 33)
is **the highest seq in the log**, and a `replace` puts it where the removed span used
to be — so the surface is `33, 7, 9, 13, …`: the first node is not the oldest.

**Root cause.** Attribution walked the turn starts with a single forward cursor
(`turnIndex`). The first node (seq 33) advanced that cursor past every turn at once, and
no later node could ever move it back — every subsequent node was attributed to turn 6,
which has no steps, so every key was `null`. The same cursor shape was inherited from
the step-marker walk, so both were wrong in the same way.

**Fix.** Attribute through `turn/start` containment, and look the containing turn up
with a binary search per node (order-independent, no cursor). Within that turn, the last
`step/start` at or before the node owns it, except that nodes before the turn's first
`step/start` belong to that turn's first step — which is what makes the opening request
part of the step it caused. `renderMap` also lists nodes outside every step
(`(not in a step)`) so the tombstone is visible in the map instead of absent from it.

## Evidence

| Check | Result |
|---|---|
| `node node_modules/vitest/vitest.mjs run` | **12 files / 158 tests** passed, exit 0 (09:05 local) |
| `node node_modules/typescript/bin/tsc -p tsconfig.json --noEmit` | exit 0 |
| New suites | `tests/memory.spec.ts` 18 tests (budget bands, selection grammar, resolution, map, planning, guards, tombstone), `tests/runtime.spec.ts` 13 tests (inspect → plan → apply → boundary flush, archive on disk, protection, pins, archive-failure block, per-turn budget, stale plan, recall, advisory, observer wiring) |
| Extended suite | `tests/config.spec.ts` 18 → 24 tests (memory defaults, clamps, exact-value fields, warn-once, hostile documents) |
| Step semantics read from source | `packages/core/agent-loop/src/agent.ts:305-332, 396` |
| Probe that isolated Issue 2 | temporary `tests/zz-probe.spec.ts` (deleted after use) |

## Caveats

- The fix is **unit-verified only**. Host `src/*.ts` edits load on the next harness
  start, and no live session has exercised the tool yet.
- The test fixture builds its session log by hand; the harness's own log shape was read
  from `agent.ts`, not observed live. A real tool-loop turn (multiple steps in one turn)
  is covered by the grammar and the resolver, but not by a live run.
- "User messages are protected" is text-level: a dropped span's user messages are
  re-emitted verbatim in the tombstone (capped per message). The tombstone itself is a
  `user/message`, so the check excludes tombstone seqs, and `freedTokens` counts the
  tombstone so a drop that frees nothing is refused by `minFreedTokens`.

## Reusable rules

1. **In DSH, a step is `turn.step`.** `step` restarts every turn
   (`agent.ts:317`, reset at `:396`); any identifier, log line, or filter that keys on
   the bare number silently merges steps across the whole conversation.
2. **A session surface that a `replace` touched is not seq-ascending.** The replacement
   event carries a new, higher seq and sits at the position of the span it replaced, so
   the surface order and the seq order disagree from that point on. Never walk a session
   log's surface with a monotonic cursor; look each node up independently.
3. **Attribute by containment, not by proximity.** The event that *causes* a step (the
   user message) is appended before the step's own start marker, so "the nearest marker
   behind the node" gets the most important node in every turn wrong.
