# Shortest path to a working DSH plugin

**Target:** DeepSeek Harness `0.2.1-alpha.2`, `web` profile, Windows, source-loaded
plugins. Distilled from the 14 incident records in this repo plus the workspace
guides (now `dsh-plugin-playbook/guides/`; the originals are archived at
`_archive/deepseek_plugins/docs/best-practices/`). Read this to get a plugin
running with the fewest round trips; read the incident records when something
looks impossible.

The one habit that saves the most time: **before writing anything, find the
shipped implementation of the same thing and copy its shape.** Every trap below
was learned by not doing that.

## 0. Pick the shape (30 seconds)

| You need | Shape | You write | First proof |
|---|---|---|---|
| Host behavior (engine, hook, watcher) | Source plugin | `src/index.ts` (`name` · `Config` · `inject` · `apply`) | suite + `--dump-config` |
| A config form for it | **Nothing extra** | volatile `Config` groups only | live Settings page |
| A chat command | Source plugin | command registration (see `compact-config-command`) | suite + a live message |
| Live progress in the Web UI | Host HTTP routes + client bundle | `src/gui.ts` + `client.js` | structural tests + user refresh |
| A UI surface inside an existing slot | Client card | bundle + one slot registration | shipped-occupant comparison |

Deciding this first prevents the most common waste: hand-writing a settings form
the harness would have rendered for free (see §5).

## 1. Minimum file set

```
<plugin>/
  package.json          source form; add the `dsh` block only for a client half
  src/index.ts          name · Config · inject · apply
  src/config.ts         schemastery Config — volatile groups are live-editable
  src/types.ts          plain shapes
  src/gui.ts            optional: HTTP routes for the Web UI
  tests/*.spec.ts       pure logic; source-shape tests for the bundle
  client.js             optional: hand-written bundle, no build step
  cordis.patch.yml      bundle patch: what to disable + the insert row
  locale/{en,zh}.json   optional: page/manager copy
```

No root `package.json`, no lockfile, no installs. Dependencies resolve through
the workspace's `node_modules` junction farm, re-pointed only with
`node scripts/link-node-modules.mjs`.

## 2. The order that wastes the fewest round trips

1. `package.json` — source form: `main`/`exports` → `src/*.ts`. No build step.
2. `src/config.ts` — schemastery `Config`, one `.volatile()` node per live group.
   A volatile node **cannot nest** inside another volatile node or inside an
   array element; mark the enclosing object or the whole array volatile instead.
3. `src/index.ts` — `name`, `Config`, `inject`, `apply`. Read config through one
   reader and re-read volatile groups at the start of every operation, so a live
   edit takes effect on the next step.
4. Tests for pure logic (normalization, thresholds, clamping). Run the suite.
5. `tsc -p tsconfig.json --noEmit`.
6. Compose a patch row. Use the **package name** when there is a client half;
   `file:///D:/…/src/index.ts` is fine for host-only. Disable any base plugin you
   replace (`- id: <base-id>` + `disabled: true`).
7. Composition check **without booting**: `--dump-config` from the target
   checkout. Expect exit 0, your row present, displaced rows disabled.
8. Live install: junction `…/profiles/<profile>/node_modules/<pkg>` → your
   package directory, plus the patch row. Never copy files through the junction.
9. Client half (optional): `dsh.client` block, `./client` export, bundle, and
   exactly one slot registration, wrapped fail-safe.
10. Structural tests → **user visual checkpoint** → commit → push.

## 3. Skeleton — host half

```ts
// src/index.ts
import z from '@deepseek-ai/schemastery'
import type { Context } from '@deepseek-ai/cordis'

export const name = 'my-plugin'
export const inject = ['<service-you-need>']        // omit when you need none

export const Config = z.object({
  enabled: z.boolean().default(true).volatile(),
  trigger: z.object({
    mode: z.union([z.const('ratio'), z.const('tokens')]).default('ratio'),
    ratio: z.number().min(0.1).max(0.95).default(0.8),
    tokens: z.number().min(0).default(0),
  }).volatile(),                                     // one volatile node per group
})

export function apply(ctx: Context, config: z.infer<typeof Config>): void {
  ctx.effect(() => {
    // subscribe / register; return the disposer
    return () => { /* dispose */ }
  })
}
```

Extending a base-service plugin (our case) instead uses a Service class with
`static Config` and `super(ctx, projected)` — see `src/index.ts`. `Config` must
stay schemastery with `toJSON()`: the native settings surface reads exactly that.

## 4. Skeleton — client half (hand-written bundle)

```js
// client.js — the exact loader/factory contract the shell diagnostics look for
;(function () {
  'use strict'
  if (typeof window === 'undefined') return
  var loader = window.__ModuleLoader__
  if (!loader || typeof loader.load !== 'function') return

  window.__ModuleLoader__.load({
    id: 'my-plugin',                                 // must equal the package name
    factory: function (require) {
      var React = require('react')                   // platform table only
      var ReactDOM = require('react-dom')            // also platform; guard before use

      function Dock() { /* render; fail-safe: render nothing on error */ }

      return {
        inject: ['slots'],                           // EVERY ctx key you touch
        apply: function (ctx) {
          try {
            ctx.slots.inject('<slot.name>', function () {
              return ctx.slots.register({ name: '<slot.name>', id: 'my-plugin', order: 60 }, Dock)
            })
          } catch (error) {
            if (typeof console !== 'undefined' && console.warn) {
              console.warn('my-plugin: slot registration failed', error)
            }
          }
        },
      }
    },
  })
})()
```

`package.json` for a client half (verified working shape):

```json
"exports": { ".": "./src/index.ts", "./package.json": "./package.json",
             "./client": "./client.js", "./locale/*.json": "./locale/*.json" },
"dsh": {
  "bundle": { "patch": "./cordis.patch.yml" },
  "client": { "platform": "web", "immediately": true,
              "inject": ["@deepseek-ai/dsh-client-ui-conversation"] }
}
```

`dsh.client.inject` lists **package names**; the bundle's `inject` array lists
**ctx service keys**. Both are required, and they are not the same list.

## 5. Config UI: you probably need to write zero UI code

A schemastery `Config` whose groups are **volatile** already gets a native,
validated, revision-safe settings page:

- Host: `ctx.settings.describe()` projects each active entry's volatile subtree
  (`volatileForm`) into a form keyed by the entry id; the write path
  (`update` / `replace` / `mutate`) refuses non-volatile paths, refuses stale
  writers (`expectedRevision`), restores inherited values on unset, and writes
  through the same `configEditor.edit` your own routes would use.
- Client: `ctx.configForms` (`get` / `describe` / `whileServed`) and
  `ctx.settingsSchema`; the Plugins settings page lists tabs from the live
  `settings.plugins.tab` slot (`configurable`, `all`). Bespoke cards go into the
  `plugins.item` slot gated by `configForms.whileServed([ns], …)`.
- Suppress the generated page per instance with `configure({ auto: false })`.

Hand-roll a form only for what the schema cannot express, and then mirror the
shipped occupant. See `docs/incidents/2026-10-12-native-settings-surface-already-serves-us.md`.

## 6. Live semantics — what takes effect when

| Change | Takes effect |
|---|---|
| Composition / patch-row edit | Immediately (recomposed), but a bad row can prevent boot — validate first |
| Config values (volatile groups) | Immediately, on the next step |
| `client.js` (or any client bundle) | Next **page load** of the Web GUI |
| Host `src/*.ts` | One **harness restart** (modules are imported once per process) |
| An optional service another boot entry provides (`webServer`) | Whenever that provider comes up — `ctx.inject([name], …)` re-runs your registration then |

A page refresh is not a restart, and a restart is user-performed: the running
harness may host the current agent session. Never kill or replace it.

## 7. Verification ladder (cheap → expensive)

1. `node --check <bundle>.js` — syntax only.
2. Unit suite — pure logic. In this repo: `node node_modules/vitest/vitest.mjs run`.
   In the workspace: the **target checkout's** `vitest.CMD`, from the workspace root.
3. `tsc -p tsconfig.json --noEmit`.
4. `--dump-config` — wiring, without booting.
5. Read-only live probe — for anything the first four cannot see. The cheapest
   useful probe is a throwaway package name + a profile junction + one
   reversible patch row with its own route that prints loader internals
   (`clientModules.clientPath`, the client graph, `configEditor` row shapes).
   Remove the row and the junction, then verify the route 404s.
6. **User visual checkpoint** — layout, animation, live behaviour. Not
   agent-verifiable. Say so explicitly instead of implying you checked.

Never as part of verification: `pnpm install` in a junction-farm workspace,
killing/restarting the running harness, starting a replacement server.

## 8. Traps that cost us real time

1. **Volatility is a containment rule, not a per-field flag** — a volatile node
   cannot sit inside another volatile node or an array element.
2. **`loader/volatile-update` is not a typed event** — do not build on its
   payload; poll or re-read your own config instead.
3. **`dsh.client.inject` takes package names, not ctx service keys** — mixing
   them silently breaks the client half.
4. **Undeclared `ctx.<key>` reads blank the whole slot entry at runtime** — list
   every key the client module touches in the bundle's `inject`.
5. **A client card's patch-row `name` must be the package name** — a `file://`
   URL there silently drops the client bundle.
6. **The bundle's externals are the frozen platform table** (`react`,
   `react/jsx-runtime`, `react-dom`, `react-dom/client`, a few `@deepseek-ai`
   client packages); `@deepseek-ai/*` **value** imports are forbidden — hand-roll
   markup and CSS under your own prefix with `--dsw-alias-*` tokens.
7. **`position:fixed`/`absolute` inside the composer is trapped** by
   `backdrop-filter`/`transform` containing blocks and clipped by overflow.
   Portal to `document.body`, clamp to the viewport, cap the height with internal
   scroll, and re-anchor on changes of the panel, the trigger **and its row**.
8. **Outside-dismissal needs both `pointerdown` and a capture-phase `click`**
   (keyboard activation fires `click` without `pointerdown`), plus Escape that
   returns focus to the trigger.
9. **`configEditor` hands out Loader nodes** — the patch id lives in
   `options.id`, `entry.id` is `include:<id>`.
10. **Archives must be project-scoped** (`header.cwd`), or every project's
    compactions land in the harness's own directory.
11. **Routes registered on `ctx.webServer` are not behind the GUI session gate** —
    they answer without a cookie. Treat them as local-only, say so in the README,
    and prefer deleting a write route over exposing one.
12. **Resolution that works only through test aliases fails at runtime** — import
    the way the target checkout resolves, and keep a runtime-path check.
13. **Adding a default can break explicit configurations** — a defaulted trigger
    ratio broke pure-token configs. Test the other mode when you add a default.
14. **Warn-once bookkeeping keyed on the wrong identity reports twice** — key it
    on the thing that changed, not on the call site.
15. **A service another boot entry provides does not exist yet when your plugin
    applies** — `webServer` comes from the `web-runtime`/`webserver` startup
    entries, so `ctx.get('webServer')` at apply time reads "absent" on a cold
    start and anything it guards silently never happens while the plugin keeps
    working. Consume optional services with `ctx.inject([name], scope => …)` and
    register on the injected scope. Probe a route with a control: `401` means it
    exists (auth-gated), `404` on `/dsh-*` means it was never registered.
16. **A `200` measured right after a patch reload is a warm-apply measurement** —
    the process was already up, so eager reads succeed there and fail at the next
    cold start. Re-verify boot-order-dependent wiring after a restart before
    writing it down as verified.
17. **A UI that assumes knowledge is a defect** — the tuner shipped with terse
    labels, an empty `Read-only: ` and no state at all when its route was
    missing. Every control needs one plain-language line, the panel needs to say
    what it does and when a change applies, and an unreachable host must render a
    legible explanation rather than nothing.

Records: [`docs/incidents/`](incidents/) — issue, root cause, fix, evidence, for
each of the above. Index: [`docs/INCIDENT-INDEX.md`](INCIDENT-INDEX.md).

## 9. Done means honest labels

Every claim carries its evidence class — code read, unit test, typecheck,
composition check, live probe, or **user checkpoint** — and one of PASS / FAIL /
SKIPPED / BLOCKED / NEEDS_USER_DECISION. A UI change that no agent has seen
rendered is "structurally verified, visual check pending", never "fixed". This is
the failure the whole document exists to prevent; see [`docs/RETRO.md`](RETRO.md).
