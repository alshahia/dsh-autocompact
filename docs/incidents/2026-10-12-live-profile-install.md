# Live install into the `web` profile (2026-10-12)

**Status:** host half PASS · live config PASS · legacy suite retired PASS ·
client half PASS (registered in the live boot graph) · Web-UI tuning fixed in
source, and that fix needs one harness restart to load.

## What was done

Install of `dsh-autocompact` into the running harness' `web` profile
(`%USERPROFILE%\.dsh\profiles\web`), replacing the legacy `deepseek_plugins`
suite in one edit.

| Step | Artifact |
|---|---|
| Backup | `cordis.patch.yml.bak-20261012-1249` (next to the patch), plus `.bak-20261012-131800` |
| Delivery junction | `%USERPROFILE%\.dsh\profiles\web\node_modules\dsh-autocompact` → `D:\my_deepseek_harness\dsh-autocompact` |
| Patch edit | `compaction-handoff` + `compact-config-command` → `disabled: true`; one `insert` row `- id: dsh-autocompact` / `name: 'dsh-autocompact'` with the thresholds carried over from the legacy store |

The row names the **package**, not a `file://` URL. The client-modules registry reads
the mounted package's own `dsh.client` declaration from its `package.json`, and the
Loader's `internal.resolveSync` resolves the bare name to
`file:///D:/my_deepseek_harness/dsh-autocompact/src/index.ts` (probe evidence below),
from which `nearestPackage()` reaches that `package.json` by name.

Config seeded from the legacy `handoff-config.json`: `trigger.mode: first`,
`ratio 0.8`, `tokens 140000`, `retain.tokens 20000`, `archive.root .dsh/handoffs`,
`archive.onFailure block`, `summarization.maxTokens 8192`, `retries 1/1`.
The legacy `archive.gitExclude` key becomes `gitIgnore` (renamed in 0.x); its
value `true` was carried over.

## Evidence

- `plugin_manager list_plugins` (page 170-209, 2026-10-12 12:50 local):
  `{"entryId":"include:dsh-autocompact","moduleName":"dsh-autocompact","enabled":true,"fiberPhase":"active","patchId":"dsh-autocompact"}`
  and `total: 205` — two legacy rows removed, one added (was 206).
- `GET http://127.0.0.1:3080/dsh-autocompact/status` → `200`, body starts
  `{"plugin":"dsh-autocompact","enabled":true,...,"config":{"effective":{"trigger":{"mode":"first","ratio":0.8,"tokens":140000},"retain":{"tokens":20000},"archive":{"root":".dsh/handoffs","gitIgnore":true,"onFailure":"block"},...`
  → the engine half is mounted **and** reads the seeded config.
- `GET /dsh-autocompact/config` → `405 Method Not Allowed` (the route is
  `POST`-only by design).
- Two archives already exist under the project tree
  (`002-20261012-131433`, `001-20261012-125006`), so the archive path runs live.

## How the client half was proven live (read-only probe plugin)

The client half cannot be checked by fetching a URL (see the trap below) and the
index HTML is behind the GUI's signed cookie, so the probe was mounted **inside** the
running harness instead: `.live-test/probe-plugin/` (gitignored) is a host-only,
route-only package — a second package name, its own junction in the profile
`node_modules`, and one reversible `insert` row. A *new* package mounts live, which
is itself the proof that composition edits need no restart. Its route
(`GET /dsh-autocompact-probe/report`) reported the composition's own view, then the
row and the junction were removed again.

| Probe answer | Value (2026-10-12 ≈13:26 local) |
|---|---|
| `ctx.loader.internal.version` / `resolveSync` | `v1` / a function |
| `internal.resolveSync('dsh-autocompact', <profile baseUrl>)` | `file:///D:/my_deepseek_harness/dsh-autocompact/src/index.ts` |
| `clientModules.clientPath('dsh-autocompact')` | `D:\my_deepseek_harness\dsh-autocompact\client.js` |
| `clientModules.graph()` | 71 entries, 3 batches, and `dsh-autocompact` is one of them |
| `configEditor.entries()` / `configuration()` | Loader nodes; `include:dsh-autocompact` present; `configuration()` does not throw |

**This disproves the earlier "negative verdict cached at scan time" theory** (which
this document previously offered as the fallback explanation): the bare name resolves,
the package's `client.js` is the registered client artifact, and the entry is in the
live boot graph. Nothing about the client half is blocked inside the harness.

What remains is page freshness: a page's module faces are fixed when it loads, and a
client module cannot be replaced in place (`packages/client/modules/src/client/system.ts:130`
— "replacing bootstrap module … requires a page reload"). The dock slot query
answered by the user's open page still lists only the shipped `stats` occupant, i.e.
that page predates the entry joining the graph. A plain browser refresh (not a
harness restart) is the next check; if the pill is still absent after a refresh, the
remaining suspect is browser-side execution of `client.js`, and
`JSON.stringify(window.__DSH_BOOT__).match(/[^"]*autocompact[^"]*/g)` in the page
console separates "not in the payload" from "in the payload but not applied".

## Trap: `/plugins/<id>/client.js` is not a URL

Probing the client half by fetching `/plugins/dsh-autocompact/client.js` returns
`404` — and that 404 means **nothing**. The bundle route
(`packages/client/modules/src/index.ts`) matches only the exact keys the registry
published:

- combo resources: `/plugins/??<id>/client.js,<id>/client.js&rev=<comboRev>`
  (`comboUrl`), and
- package-local chunks matching `^client\.[A-Za-z0-9][A-Za-z0-9._-]*\.js$`
  (`CLIENT_CHUNK`) — `client.js` itself does **not** match.

Control: `GET /plugins/@deepseek-ai/dsh-client-ui-conversation/client.js` — a
shipped, definitely-mounted client package — returns `404` too, with and without
a `?rev=` query. There is no single-package URL to guess, and the combo URL's rev
is a hash over the whole batch, so an external probe cannot construct one.

Consequence: **never** use a `/plugins/<id>/client.js` fetch as an install check; it
produces a false negative for every plugin in the harness. Ask the host instead:
`clientModules.clientPath(id)` and `clientModules.graph()` answer the real question.

## Restart semantics (verified)

| Change | When it takes effect |
|---|---|
| Patch row added/removed, junction added/removed (composition) | **live** — verified by mounting and unmounting the probe package without restarting (`patchReload: live`) |
| Config values (any volatile group) | **live** — re-read at the start of each operation |
| `client.js` edit | next **page load**; bundles are read from disk, but a loaded page cannot swap a module face in place |
| Host TS source edit (`src/*.ts`, e.g. the `findRow` fix) | next **harness start** — the module is imported once per process; observed: after the fix, `/status` kept returning the pre-fix reason string |

So: installing this bundle, seeing it enabled, reading its config, and archiving to the
project need **no restart**. A restart is needed only to load changed host source, and
a page refresh is needed only for client-side changes.

## Security note (recorded, unresolved)

The plugin's own routes (`/dsh-autocompact/status`, `/dsh-autocompact/config`) are
registered on the raw web server and are **not** covered by the GUI's browser-auth
gate — the status route answered `200` and the config route `405` without the session
cookie, while `/` required it. Any local client that can reach the port can therefore
read the compaction state and `POST` a config change. Acceptable for a loopback-only
development GUI, but it is a deliberate gap, not an oversight, and it should be closed
(trust check or explicit opt-in) before this plugin is exposed beyond `127.0.0.1`.

## Caveats

- The host half, the live config, the archive path, and the client-half *registration*
  are verified by the evidence above. The client half's **visual** result is not yet
  verified from this session: it needs one page refresh in the user's browser.
- Reverting the install is one edit: restore
  `cordis.patch.yml.bak-20261012-1249` (and optionally remove the junction).
- The two legacy rows are *disabled*, not deleted: the patch keeps them so the
  old suite can be re-enabled, but only after disabling `dsh-autocompact` in the
  same edit — two engines must never register `ctx.compaction` at once.
