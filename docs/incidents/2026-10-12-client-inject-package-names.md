# `dsh.client.inject` lists package names, not Cordis service keys

- **Date:** 2026-10-12
- **Area:** `package.json` → `dsh.client.inject`
- **Status:** FIXED — the declaration now names the owning client bundle
  (`"inject": ["@deepseek-ai/dsh-client-ui-conversation"]`, `package.json:33-35`)

## Symptom

The `dsh.client` declaration was first authored with Cordis **service** names,
mirroring the `export const inject = [...]` list of a client plugin module:

```json
"dsh.client": {
  "platform": "web",
  "immediately": true,
  "inject": ["slots", "uiConversation", "locale", "sessions"]
}
```

None of those strings is a client graph row, so the declaration named four owners
that do not exist. Nothing failed loudly at boot: the field is only validated as a
string array, so the mistake was silent.

## Root cause

Two different `inject` vocabularies live next to each other:

| Where | What it holds | Verified in |
|---|---|---|
| `package.json` → `dsh.client.inject` | **client bundle package names** (graph rows) | `packages/client/modules/src/client/manifest.ts:44-68` |
| a client plugin module's `export const inject = [...]` | **Cordis service keys** | `packages/client/ui-workspace/src/client/index.ts:88-97` |

The manifest is explicit:

> Entry name == package name.
> … Package-name dependency edges used for factory arrival and plugin composition.
> — `packages/client/modules/src/client/manifest.ts:53,62`

and the module system consumes those names as row ids when it retains graph records
before eviction (`packages/client/modules/src/client/system.ts:447-458`). A service
key such as `uiConversation` is not a row id, so nothing is retained or prefetched by
that edge.

What the edges do **not** do is sequence `apply()`. The shipped `ui-workspace` plugin
documents this directly:

> The target slots are declared by the ui-sidebar / ui-conversation applies, whose
> activation order relative to this one is NOT constrained: `dsh.client.inject` edges
> are informational (loading/prefetch metadata, never apply sequencing) … `apply`
> therefore depends on each slot declaration through `slots.inject()` instead of
> assuming order.
> — `packages/client/ui-workspace/src/client/index.ts:88-95`

## Fix

1. **Name real rows.** The manifest now declares the bundle that owns the slot the
   visual registers into:

   ```json
   "client": {
     "platform": "web",
     "immediately": true,
     "inject": ["@deepseek-ai/dsh-client-ui-conversation"]
   }
   ```

   This matches the registration in `client.js`: `ctx.slots.inject('conversation.composer.dock', …)`,
   a slot owned by the conversation UI bundle.
2. **Keep the Cordis service dependency where it belongs.** `client.js` depends on the
   slot owner through `ctx.slots.inject(ownerKey, () => ctx.slots.register(...))` and
   never assumes activation order — `slots.inject` is the waitable seam; the manifest
   edge is only loading metadata.

## Evidence

- `package.json:30-36` — the fixed `dsh.client` block.
- `client.js:431-440` — the registration through `slot.inject('conversation.composer.dock', …)`
  with a `console.warn` fallback if registration throws.
- `packages/client/modules/src/client/manifest.ts:44-68,153-179` — the declaration's
  contract (`inject` is a package-name array) and the fact that only string-ness is
  validated, which is why a service key slips through silently.
- `packages/client/ui-workspace/src/client/index.ts:88-97` — the two vocabularies side
  by side, plus the "informational, never apply sequencing" rule.

## Caveats

- Because the edges are prefetch/retention metadata rather than activation ordering,
  the original damage was a **wrong declaration** rather than a broken boot: the
  visual works as long as registration goes through `slots.inject`. It was still worth
  fixing — the old list claimed four owners that were never involved, and the new list
  actually gets this row's factory prefetched alongside its host UI.
- `dsh.client.inject` remains informational for *ordering*; do not reintroduce an
  ordering assumption just because the names are now real.
