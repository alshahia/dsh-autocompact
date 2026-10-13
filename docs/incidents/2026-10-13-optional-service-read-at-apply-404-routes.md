# The web server was read once, at apply time: both routes were never registered

**Date:** 2026-10-13 · **Version:** 0.4.0 · **Status:** fixed (unit-verified against the real cordis registry; the live route needs one harness start)

The user reported that the GUI showed **no compaction animation** even though
compaction was running, and that the floating tuner opened with a bare
`Read-only: ` and no context numbers. The plugin was mounted, `enabled`, and
listed as an active client occupant — every visible signal said "installed". The
two host routes simply did not exist in that process.

## Symptom and live probe

Read-only probes against the running `web` profile (`127.0.0.1:3080`), same
process, same minute:

| Request | Result | Reading |
|---|---|---|
| `GET /` | `401` | the SPA/auth route table matches; the server is answering |
| `GET /dsh-open-in-app/apps` | `401` | a **shipped** plugin route exists and is gated (auth), not missing |
| `GET /dsh-autocompact/status` | `404` | no route registered under this path |
| `GET /dsh-vision-bridge/inbox` | `404` | the sibling plugin has the same defect (its own record) |
| `GET /dsh-autocompact/nope` | `404` | control: an unknown path also 404s |

`404` on `/dsh-*` means *the route was never registered*, not "the plugin needs
auth" — an existing plugin route answers `401`. The client half then behaved
exactly as written: `useStatus` returned `null` on a non-OK response, so
`running === null` (no indicator), no `recent` chip, `capabilities = {}` (Save
disabled) and a read-only line with an empty reason.

## Root cause

`webServer` is **not** provided by this plugin and not provided by its own boot
entry. It comes from the separate `web-runtime`/`webserver` startup entries
(`packages/boot/app-boot/src/index.ts:748-757` lists them in
`requiredStartupEntryIds`), so on a **cold boot** the service is not reachable
yet when `AutocompactEngine`'s constructor calls `installGuiBridge(ctx, this)`
(`src/index.ts:121-123`).

The old bridge did a **one-shot** optional read and gave up:

```ts
const server = safeGet<WebServerLike>(ctx, 'webServer')
if (server === undefined || typeof server.register !== 'function') {
  ctx.logger.info('dsh-autocompact: no web server in this composition; …')
  return false                       // no retry, ever
}
```

At cold-boot apply time `safeGet` yielded `undefined`, the bridge returned
`false`, and nothing ever revisited the decision. The engine itself was
unaffected — compaction, summarization and archiving all kept working — which is
why nothing looked broken.

**Why this looked verified on 2026-10-12.** Record 11 measured
`GET /dsh-autocompact/status → 200` right after the plugin row was mounted into
the *already running* harness. That was a **warm re-apply**: the process was up,
the web server existed, and the one-shot read succeeded. The 07:51 restart on
2026-10-13 re-ran `apply()` earlier in the boot order, and the same code
registered nothing. A patch-reload measurement is not a cold-boot measurement.

## Fix

Consume the optional service through the sanctioned deferred form, so
registration happens when the service actually appears (mirroring the fix that
was measured in `dsh-vision-bridge` — `src/gui.ts` there, and its I-4 record
`docs/incidents/2026-10-13-optional-service-read-404-panel.md`, whose caveat 4
names this plugin's own 404):

```ts
const inject = (ctx as unknown as { inject?: (deps: string[], cb: (scope: Context) => void) => unknown }).inject
if (typeof inject === 'function') {
  inject.call(ctx, ['webServer'], (scope: Context) => { install(scope) })
  return true
}
return install(ctx)          // structural contexts (tests, hand-built hosts)
```

The library states the contract: `ctx.inject(deps, callback)` is

> Shorthand for `ctx.plugin({ inject, apply: callback })`: the callback is
> **unloaded and re-run whenever a required service changes**.

(`vendor/cordis/lib/types/registry.d.ts:104-111`.) Registration is scoped to the
injected child context (`scope.effect`), so it is disposed and re-created with
the service rather than leaking a route.

Two supporting changes in the same fix:

- `safeGet` now tries `ctx.get(name)` first and keeps the bare property read only
  as a wrapped fallback. Swallowing the inject-throw was what made "not injected"
  indistinguishable from "not provided"; absence is now read from `ctx.get`.
- When `inject` itself is unavailable or throws, the bridge warns and returns
  `false` (`the compaction engine is unaffected`) instead of failing silently.

## Evidence

| Check | Result |
|---|---|
| `GET /dsh-autocompact/status` on the live process | `404` before the fix; **not re-measured after** — a host `src/*.ts` edit reaches the running process only on the next harness start (see caveats) |
| Control probes in the same process | `/` `401`, `/dsh-open-in-app/apps` `401`, `/dsh-autocompact/status` `404`, `/dsh-autocompact/nope` `404` |
| New tests against the **real** cordis registry (`tests/gui.spec.ts`) | 2 tests: routes appear when a provider fiber provides `webServer` *after* apply; and registration is re-created when the service is withdrawn and provided again |
| New tests against the structural fake context | 4 tests: deferral is arranged through `ctx.inject(['webServer'], …)` with no apply-time read; the child scope registers both routes; absence is reported only from the deferred scope; a throwing `inject` fails safe |
| Regression power (FAIL-before / PASS-after) | with the pre-fix `src/gui.ts` restored, the same spec is **6 failed / 21 passed**; with the fix, **27 passed** — the 21 pre-existing assertions pass in both states |
| `tsc -p tsconfig.json --noEmit` | exit 0 (11:00 local) |
| `node node_modules/vitest/vitest.mjs run` | **12 files / 168 tests** passed, exit 0 (11:00 local; 158 → 168: `tests/gui.spec.ts` 21 → 27, `tests/client.spec.ts` 20 → 24) |
| `--dump-config` (workdir `D:\deepseek-harness_2`) | exit 0, composed tree contains the `id: dsh-autocompact` row |

The real-registry test reproduces the cold-boot order in-process: the base
context cannot reach `webServer`, the install is applied, and the routes appear
only when a provider fiber comes up. That is the closest a test can get to the
live 404 without restarting the harness that hosts the session.

## Second half of the same user report: the panel explains itself

The tuner previously showed a row of terse labels, an empty `Read-only: `, and
nothing at all when the route was missing. `client.js` now:

- opens with what compaction **is** and that settings apply on the next step
  without a restart (`dshac-intro`), and closes with what Save writes and the
  live-settings-versus-code distinction (`dshac-foot`);
- gives **every** control its own plain-language line (`dshac-help`), wired to the
  input with `aria-describedby`: enabled, trigger ratio, trigger tokens, retain
  tokens, archive root, summary provider, summary model, plus the status numbers;
- turns a missing route into a legible state instead of an empty one: the poll
  records `__unreachable` (with the HTTP status), the pill's dot becomes amber
  ("unknown", distinct from the grey "switched off"), and the panel shows a
  titled banner explaining that the browser could not read the host route, that
  host-code changes land at the next harness start, and what to check;
- fills the read-only line with a concrete fallback sentence when the host
  supplies no reason, instead of ending at `Read-only: `;
- carries both locales (`en`, `zh`) with matching key sets.

## Caveats

- **The live route is not re-verified.** Fixing it in the running process would
  require restarting the harness that hosts this session (forbidden), or a
  deliberate disable→enable of the plugin row — and a re-apply runs the *cached*
  module, so it would restore the routes only by accident of warm timing, not
  because the new code loaded. Acceptance for the live route is this: after the
  next harness start, `GET /dsh-autocompact/status` answers `200` and the dock
  indicator animates. This is a user checkpoint.
- The real-registry test asserts **route registration**, not an HTTP `200`; the
  route handlers themselves are covered separately by the existing
  `createGuiRoutes` tests.
- The `client.js` changes are **source-shape verified only** (this repo runs
  vitest on `node`, with no react/jsdom and no layout). The rendered help text,
  the amber dot and the banner need one page refresh in a browser.
- Pins/routes remain per process: nothing here changes the restart semantics
  table in `README.md`.

## Reusable rules

1. **A service provided by another boot entry is never read once at apply time.**
   `ctx.inject([name], …)` is the contract for "install when this becomes
   available"; a one-shot `ctx.get` at apply time silently makes the feature
   depend on process boot order. Optional services are exactly the ones this hits,
   because the plugin still works without them.
2. **"The plugin is active" and "its routes exist" are different claims.** Verify
   a route with a control: an existing plugin route answers `401` (auth) where a
   missing one answers `404`. A `404` on `/dsh-*` is never an auth result.
3. **A "live" measurement taken right after a patch reload is a warm-apply
   measurement.** Warm re-apply satisfies eager `ctx.get` reads that a cold boot
   cannot; re-verify boot-order-dependent wiring after a restart before recording
   it as verified.
4. **Read `ctx.get(name)` as absence, never the swallowed property throw.** The
   bare property read of a non-injected service throws by design; catching that
   throw and reporting "not provided" is how an absent-route bug hides behind a
   healthy-looking log line.
