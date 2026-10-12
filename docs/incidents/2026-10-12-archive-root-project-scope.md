# Archives must belong to the project, not to the harness process

- **Date:** 2026-10-12
- **Area:** `src/workspace.ts`, `src/summarize.ts`, `src/index.ts`
- **Status:** FIXED (session creation cwd is the authority)

## Symptom

Every archive landed in one tree — `<process cwd>/.dsh/handoffs/<sessionId>/…` — so
sessions of different projects shared an archive root: one `index.md` per session id,
one ordinal sequence, and no way to tell from the path which project a handoff
belonged to. With a harness booted from one directory and used against several
projects, "read the archive of this project" was impossible.

## Root cause

Two plausible sources are wrong for this purpose:

1. **`ctx.workingDirectory.get()`** falls back to the **launch directory** for a
   session that records no directory change. That silently reproduces the
   cross-project bug rather than detecting it.
2. **The workspace registry** derives membership from the canonical session cwd in
   the first place, so using it would add a heavy `storageDomain` dependency to
   recompute a value the session already carries.

The correct authority is the session's own creation metadata:
`agent.session.header.cwd` — the absolute directory the session was created in. It is
immutable detached creation metadata, is not part of the event log, and needs no
service or I/O to read.

## Fix

- `src/workspace.ts` reads `header.cwd` **structurally** (`agent.session as { header?: { cwd?: unknown } }`)
  inside a `try`, accepts it only when it is a non-empty absolute path, and otherwise
  returns `undefined` — so a headless session or a future field move degrades instead
  of throwing.
- `projectDirOf(agent, fallback)` picks the first usable absolute candidate and falls
  back to `process.cwd()`, captured **once** in the engine constructor
  (`src/index.ts:106`) so the fallback itself cannot drift mid-session.
- The archive root is `resolve(projectDir, config.archive.root)`
  (`src/index.ts:359-361`, `src/summarize.ts:60`), and the pointer is
  project-relative (forward-slashed) when the archive sits inside the project,
  absolute otherwise (`src/summarize.ts:97-101`).
- The same `projectDir` feeds `previewPressure`, so the GUI preview and the write
  path can never disagree about where the archive goes.

## Evidence

- `tests/workspace.spec.ts` — 9 tests: first absolute candidate, empty/relative
  skipped, fallback, header read, hostile header, session dir preferred over launch
  dir, two projects disjoint.
- `tests/summarize.spec.ts:94` — *never writes into another project*;
  `tests/archive.spec.ts:67` — *keeps two projects in two disjoint trees with their
  own numbering and index*.
- `tests/engine.spec.ts:277-302` — the preview reports the project-scoped archive
  root derived from the session creation directory.

## Caveats

- A session that records **no** creation cwd (e.g. a headless run) still falls back
  to the harness launch directory; two such sessions then share one tree. That is the
  documented limitation, chosen over silently inventing a per-process root.
- The fallback is the process directory at **construction** time, not at call time.
