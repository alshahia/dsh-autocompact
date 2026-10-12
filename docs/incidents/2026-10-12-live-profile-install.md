# Live install into the `web` profile (2026-10-12)

**Status:** host half PASS · live config PASS · legacy suite retired PASS · client
half SKIPPED (needs the authenticated GUI page — user checkpoint).

## What was done

Install of `dsh-autocompact` into the running harness' `web` profile
(`%USERPROFILE%\.dsh\profiles\web`), replacing the legacy `deepseek_plugins`
suite in one edit.

| Step | Artifact |
|---|---|
| Backup | `cordis.patch.yml.bak-20261012-1249` (next to the patch) |
| Delivery junction | `%USERPROFILE%\.dsh\profiles\web\node_modules\dsh-autocompact` → `D:\my_deepseek_harness\dsh-autocompact` |
| Patch edit | `compaction-handoff` + `compact-config-command` → `disabled: true`; one `insert` row `- id: dsh-autocompact` / `name: 'dsh-autocompact'` with the thresholds carried over from the legacy store |

The row names the **package**, not a `file://` URL. That is deliberate and
load-bearing: the client-modules registry reads the mounted package's own
`dsh.client` declaration from its `package.json`, which only a name-resolved row
can provide (`client-modules` `resolveMeta` → `locatePkgJson`, `index.ts:823-906`).

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

## Trap: `/plugins/<id>/client.js` is not a URL

Probing the client half by fetching `/plugins/dsh-autocompact/client.js` returns
`404` — and that 404 means **nothing**. The bundle route
(`packages/client/modules/src/index.ts:1128-1149`) matches only the exact keys
the registry published:

- combo resources: `/plugins/??<id>/client.js,<id>/client.js&rev=<comboRev>`
  (`comboUrl`, `index.ts:234`), and
- package-local chunks matching `^client\.[A-Za-z0-9][A-Za-z0-9._-]*\.js$`
  (`CLIENT_CHUNK`, `index.ts:192`) — `client.js` itself does **not** match.

Control: `GET /plugins/@deepseek-ai/dsh-client-ui-conversation/client.js` — a
shipped, definitely-mounted client package — returns `404` too, with and without
a `?rev=` query. There is no single-package URL to guess, and the combo URL's rev
is a hash over the whole batch, so an external probe cannot construct one.

Consequence: **never** use a `/plugins/<id>/client.js` fetch as an install
check; it produces a false negative for every plugin in the harness.

## How the client half can be verified

`webserver` renders the index fresh per response and re-reads the live graph at
that moment: `collectIndexInjections()` emits `webserver/index-inject`
per call and `bootInjections(this.composed)` pushes the *current* module graph
(`packages/host/webserver/src/index.ts:534-554`,
`packages/client/modules/src/index.ts:654-656`). The graph itself is updated
incrementally on every fiber arrival (`internal/plugin` → dirty set → flush).
So a browser page refresh is a valid activation check.

Two routes are closed to an out-of-session probe:

- The index HTML is behind the GUI's per-activation signed cookie
  (`packages/client/connection/src/browser-auth.ts:300-323`), so the boot
  manifest cannot be read externally.
- `/plugins/events` is not usable from outside the browser session: a plain
  `GET` never answers and a WebSocket connect closes with `1006`
  (`.live-test/hmr-probe.mjs`, 2026-10-12).

The remaining check is therefore the user's: refresh the GUI and look for the
Autocompact panel in the composer dock (and the in-progress indicator once a
compaction starts).

## If the panel is absent after a refresh

1. The page must be a **fresh load** (no client hot-reload path is active).
2. If it is still absent, the likely cause is a *negative package verdict
   cached at scan time*: `client-modules` caches "not a client package" per
   `(specifier, baseUrl)` and keeps it **until restart**
   (`index.ts:601-603`, `resolveMeta` caches `null` at `index.ts:831/842`).
   A harness restart re-runs the activation scan with the junction in place.
   The host half and the config surface are unaffected either way.

## Security note (recorded, unresolved)

The plugin's own routes (`/dsh-autocompact/status`, `/dsh-autocompact/config`)
are registered on the raw web server and are **not** covered by the GUI's
browser-auth gate — the status route answered `200` and the config route `405`
in this session, i.e. without the session cookie, while `/` required it. Any
local client that can reach the port can therefore read the compaction state and
`POST` a config change. Acceptable for a loopback-only development GUI, but it
is a deliberate gap, not an oversight, and it should be closed (trust check or
explicit opt-in) before this plugin is exposed beyond `127.0.0.1`.

## Caveats

- The host half, the config bridge, and the retirement of the legacy rows are
  verified by the evidence above. The client half is **not** verified from this
  session; it needs the authenticated page.
- Reverting the install is one edit: restore
  `cordis.patch.yml.bak-20261012-1249` (and optionally remove the junction).
- The two legacy rows are *disabled*, not deleted: the patch keeps them so the
  old suite can be re-enabled, but only after disabling `dsh-autocompact` in the
  same edit — two engines must never register `ctx.compaction` at once.
