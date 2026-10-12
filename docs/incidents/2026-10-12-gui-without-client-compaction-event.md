# No client compaction event: the indicator polls a host route

- **Date:** 2026-10-12
- **Area:** `src/status.ts`, `src/gui.ts`, `client.js`
- **Status:** FIXED for the host half (routes + status board); the client bundle is the
  only consumer and is documented as polling

## Symptom

The Web UI was supposed to show a live "compacting…" state. Two obvious client-side
routes are closed in this harness version:

1. There is no client-visible **compaction in progress** signal — the client's chat
   contract models a *finished* compaction only: `CompactionSummaryNode`
   (`packages/client/ui-chat/src/client/contract/chat-nodes.ts:50-53`,
   `contract/slots.ts:255`).
2. The chat row slot cannot gain a new phase row. `conversation.chat.node` is a
   **keyed** slot keyed by the `ChatNodeKind` union:

   > Final Chat node renderer, keyed by `ChatNodeKind`. … Reusing a key replaces that
   > node renderer; a kind with no occupant renders no row.
   > — `packages/client/ui-chat/src/client/contract/slots.ts:372-384`

   The shipped UI already owns the compaction keys: `manual-compaction` and
   `compaction` are registered by
   `packages/client/ui-chat/src/client/chat/register-node-renderers.ts:63-66`. A
   third-party registration at the same key **and** the same priority throws:

   > `… at priority N (registered by …) — register at a different priority to shadow it (lowest renders)`
   > — `packages/client/ui-slots/src/index.ts:1211-1214`

   So a row can only *shadow shipped UI*, which is not a place for a transient
   indicator and would be hostile to the shipped renderer.

## Fix

Serve the phase from the host and let the thin client render it.

1. **`src/status.ts`** — `StatusBoard`, the single writer of that state. The engine
   marks a session busy when it enters `summarize()` (every compaction path funnels
   through it: automatic pressure, manual `/compact`, context-overflow recovery) and
   clears it in a `finally`. State is keyed per session; the finished-outcome list is
   bounded (`RECENT_LIMIT = 8`). Every method is total: a malformed call marks or
   clears nothing rather than throwing, because the indicator must never be able to
   break compaction.
2. **`src/gui.ts`** — two routes on the composition's web server:
   - `GET /dsh-autocompact/status` → `{ plugin, enabled, running, recent, session, config, capabilities }`,
     where `running` carries `{ sessionId, phase, detail, startedAt, elapsedMs }` and a
     running mark older than 10 minutes (`STALE_RUNNING_MS`) is ignored.
   - `POST /dsh-autocompact/config` → partial, schema-validated config write.
   Both handlers are total and defensive; the route prefix is deliberately **not**
   `/plugins`, which the client-modules bundle route owns
   (`src/gui.ts:15-16`).
3. **`client.js`** — one `conversation.composer.dock` visual polling the status route
   adaptively (900 ms while a compaction runs, 3 s while idle); if anything is missing
   or throws, it renders nothing.

## Evidence

- `src/status.ts`, `src/gui.ts` in this package (routes exported as
  `STATUS_ROUTE` / `CONFIG_ROUTE`; `createGuiRoutes` exported so tests can drive the
  handlers directly).
- Slot contract and shadowing message quoted above, read from the target checkout
  (`D:\deepseek-harness_2`).
- `installGuiBridge` logs and returns `false` when the composition has no web server,
  so a headless profile loses only the indicator.

## Caveats

- Polling costs up to ~one cheap HTTP request per second per open page while a
  compaction runs (one per 3 s otherwise), and the indicator lags the real phase by up
  to one interval.
- The board is in-memory: a harness restart loses the "recent" list (the archives on
  disk remain the durable record).
- Because the fix is a host route, it is front-end agnostic but **front-end
  specific**: a different UI would need its own consumer of the same JSON.
