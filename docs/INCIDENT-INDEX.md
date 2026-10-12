# Incident index

Answering "did we already hit this?" for the auto-compact handoff engine from one page.
Built from `docs/incidents/*.md` (14 records, every one dated 2026-10-12), `README.md`
and `docs/RETRO.md`. Everything below is transcribed from those files; `not recorded`
means the record does not state that field. Dates and filenames are as they appear in
the records.

**How to read the numbers.** Test and file counts quoted below are **as of the record
that states them**, not a current baseline: 7 files / 72 tests at record 1, 10 files /
110 at records 8-9, 114 at record 10, and 10 files / **120 tests** green at records
12-13, which is the current baseline (13:57 local, 2026-10-12). Line numbers are as of
the same moment; `src/config.ts:152-160` is the whole `Config` object literal.

## Cross-references

- `../README.md` sections that carry overlapping content:
  ["Incident records"](../README.md) (its numbered list 1-14 is the row order here),
  ["Known limitations"](../README.md) (item 8 records the unauthenticated-route gap),
  ["Restart, reload, and hot application"](../README.md) (restates the table in record 11),
  ["Web UI"](../README.md), ["Archives"](../README.md), ["Development"](../README.md),
  ["Trigger math"](../README.md) (record 5) and ["Retention clamping"](../README.md).
- `incidents/` — the 14 records tabled below. Other `docs/` files: `RETRO.md` (process
  reflection whose "Open risks handed over" table restates several items in
  "Open or deferred") and `PLUGIN-GUIDE.md` (the trap list distilled from these records).
- Record-to-record links: 9 → 6 (client inject), 10 → 11 (restart semantics),
  12 → 10 (findRow fix), 12 → 11 (unauthenticated routes), 13 → 12 (same change),
  14 → 10 (findRow was this plugin's own bug).

## Incident table

| Record (`docs/incidents/`) | Date | Issue (one line) | Root cause (one clause) | Fix / verdict | Status |
|---|---|---|---|---|---|
| [2026-10-12-schemastery-volatile-containment.md](incidents/2026-10-12-schemastery-volatile-containment.md) | 2026-10-12 | Marking every editable field `.volatile()` fails at resolve time, and the old cross-field fail-fast validator has no schemastery equivalent | Volatility is a containment rule (legal only at a fixed object path whose ancestors are non-volatile), and schemastery has no cross-field `.check()` | One volatile node per section (`models` as one volatile array), preset sections carry no defaults, field rules become clamp-and-warn-once at read time; guarded by a `z.resolve` test | FIXED (design constraint encoded in the schema and guarded by a test) |
| [2026-10-12-warn-once-probe-pass.md](incidents/2026-10-12-warn-once-probe-pass.md) | 2026-10-12 | Every clamp/drop notice was logged twice for one configuration generation, against the stated one-notice-per-problem contract | Change detection and notice emission ran in the same pass, so the first read of a new generation cleared the warn-once memory it had just filled | Silent probe pass `resolve(raw, NOOP)` + signature compare, then a separate deduplicated reporting pass | FIXED (silent probe pass) |
| [2026-10-12-archive-root-project-scope.md](incidents/2026-10-12-archive-root-project-scope.md) | 2026-10-12 | Every archive landed in one process-cwd tree, so sessions of different projects shared one root, one index and one ordinal sequence | The archive root was derived from the harness process cwd instead of the session's own creation directory | Read `agent.session.header.cwd` structurally (accept only a non-empty absolute path), fall back to a construction-time `process.cwd()`; root is `resolve(projectDir, archive.root)` and the pointer is project-relative inside the project | FIXED (session creation cwd is the authority) |
| [2026-10-12-gui-without-client-compaction-event.md](incidents/2026-10-12-gui-without-client-compaction-event.md) | 2026-10-12 | The Web UI could not show a live "compacting…" state: no client-visible in-progress signal, and the chat row slot is keyed | This harness version models only a finished compaction on the client, and `conversation.chat.node` keys are already owned by the shipped UI | Serve the phase from the host (`StatusBoard` plus `GET /dsh-autocompact/status` and `POST /dsh-autocompact/config`) and let one thin composer-dock visual poll adaptively (900 ms running / 3 s idle) | FIXED for the host half (routes + status board); the client bundle is the only consumer and is documented as polling |
| [2026-10-12-trigger-default-regression.md](incidents/2026-10-12-trigger-default-regression.md) | 2026-10-12 | A schema default of `0.8` on `trigger.ratio` made every configuration window-relative, so a pure absolute-token setup threw `TargetPressureConfigError` on an adapter with no `contextWindow` | A schema default cannot distinguish "the user never touched this field" from "the user chose this value" | `0` is the unset sentinel; the upstream `0.8` is applied at read time only when both limits are unset; `needsWindowFor` returns false for `mode: tokens` with a token limit | FIXED (`0` is the "unset" sentinel; `0.8` is applied only when nothing is configured) |
| [2026-10-12-client-inject-package-names.md](incidents/2026-10-12-client-inject-package-names.md) | 2026-10-12 | `dsh.client.inject` named four Cordis service keys, none of which is a client graph row, and the mistake failed silently | Two inject vocabularies sit next to each other: package names in the client manifest, Cordis service keys in a plugin module | Declare the owning bundle `@deepseek-ai/dsh-client-ui-conversation`; keep the service dependency in `slots.inject`, since manifest edges are informational and never sequence `apply()` | FIXED — the declaration now names the owning client bundle |
| [2026-10-12-loader-volatile-update-not-typed.md](incidents/2026-10-12-loader-volatile-update-not-typed.md) | 2026-10-12 | The planned `loader/volatile-update` listener had no published contract to rely on | In the target checkout the name appears only as a consumer, never in an `Events` map, so it is an internal loader signal with unpublished payload and ordering | Drop the listener; `refresh()` re-reads the live groups at the start of every operation | FIXED (re-read the live groups per operation; no listener) |
| [2026-10-12-runtime-resolution-alias-only.md](incidents/2026-10-12-runtime-resolution-alias-only.md) | 2026-10-12 | `tests/` and `tsc` were green but the harness could not load the plugin: `IMPORT_FAIL Cannot find package '@deepseek-ai/dsh-compaction-basic'` | Tests resolve `@deepseek-ai/*` through aliases while the harness uses plain Node resolution, and `node_modules` was a single junction holding only a handful of links | `scripts/link-node-modules.mjs` builds a junction farm into the target checkout's `src`; links removed with `cmd /c rmdir`, target recorded in `scripts/.dsh-target.txt` | FIXED (`scripts/link-node-modules.mjs`) |
| [2026-10-12-bundle-mount-composition-traps.md](incidents/2026-10-12-bundle-mount-composition-traps.md) | 2026-10-12 | Mounting the bundle is a composition change with two traps: two engines can both register `ctx.compaction`, and an `insert` row applies no bundle patch | A bundle install applies the bundle patch but does not remove pre-existing legacy rows, and naming the package in an `insert:` row mounts the plugin without its patch | Disable the replaced row in the same edit that selects the bundle, and disable `compaction-basic` explicitly in a hand-written profile; verified boot-free with `--dump-config` | VERIFIED boot-free (`--dump-config`); the install question is superseded by record 11 (live install performed the same day) |
| [2026-10-12-config-editor-entries-are-loader-nodes.md](incidents/2026-10-12-config-editor-entries-are-loader-nodes.md) | 2026-10-12 | A mounted, active plugin reported `capabilities.write: false` with `reason: "no dsh-autocompact entry is present in this profile composition"`, so the tuner would render a disabled Save (also mentioned in [live-profile-install](incidents/2026-10-12-live-profile-install.md) and [panel-floats-above-composer](incidents/2026-10-12-panel-floats-above-composer.md)) | `configEditor.entries()` / `configuration()` return Loader `Entry` objects, but `findRow()` compared only flat `entry.id` / `entry.name` | `findRow()` accepts both the flat shape and the nested `entry.options.id` / `entry.options.name`; two cases locked in by `tests/gui.spec.ts` | not recorded as a `Status:` field; the record states unit verification and that the fix reaches the live process on the next harness launch |
| [2026-10-12-live-profile-install.md](incidents/2026-10-12-live-profile-install.md) | 2026-10-12 | Live install of the bundle into the running `web` profile, replacing the legacy `deepseek_plugins` suite in one edit, needed a record of what took effect | not recorded (the record documents an install, not a defect) | Backup, delivery junction and one `insert` row naming the package; host half, seeded config, live archive path and client-half registration all verified; reverting is one edit | host half PASS · live config PASS · legacy suite retired PASS · client half PASS (registered in the live boot graph) · Web-UI tuning fixed in source, and that fix needs one harness restart to load |
| [2026-10-12-panel-floats-above-composer.md](incidents/2026-10-12-panel-floats-above-composer.md) | 2026-10-12 | Clicking the **Auto-compact** pill pushed the message box and the bottom bar up the page | The tuner was rendered as an in-flow child of the dock row, so a ~400 px panel became part of the composer bar's height | Portal the panel to `<body>`, place it fixed above the pill from the trigger rect, clamp to a 12 px margin, cap height with its own scroll, re-anchor on scroll/resize/`ResizeObserver`, dismiss on outside press and Escape; the in-progress indicator stays inline | fixed (client half; visual check is a browser checkpoint) |
| [2026-10-12-externals-list-test-premise.md](incidents/2026-10-12-externals-list-test-premise.md) | 2026-10-12 | `tests/client.spec.ts` pinned `client.js` externals to exactly `['react']` from an unverified comment, which would have rejected `react-dom` (the same change is also recorded in [panel-floats-above-composer](incidents/2026-10-12-panel-floats-above-composer.md)) | The platform rule was inferred from what the bundle happened to import and written down as law instead of being checked against the frozen `PLATFORM_MODULES` table | Require `react` and `react-dom` with a guarded inline fallback; the test was renamed to `'requests only shell platform modules as externals'` and asserts `['react', 'react-dom']` | fixed |
| [2026-10-12-native-settings-surface-already-serves-us.md](incidents/2026-10-12-native-settings-surface-already-serves-us.md) | 2026-10-12 | README limitation 7 described the tuning migration as work on our side plus an unverified mechanism, when the native settings surface already renders this plugin's volatile Config | The documentation claim rested on an unchecked premise (the settings-service source was never read) | Knowledge recorded: `describe()` → `volatileForm()` already projects every active volatile Config and the native write path is the same `configEditor.edit` this plugin uses, so the migration is mostly deletion | knowledge recorded (migration deliberately not started) |

## What each record is authoritative for

1. **schemastery-volatile-containment** — Volatility is a containment rule: one volatile node per section at a fixed path, never per field and never inside an array item, dict value, union, tuple, `z.lazy()`, or another volatile node.
2. **warn-once-probe-pass** — Keep the decision pass silent and the reporting pass noisy; generation identity is the *resolved* config, not the raw document.
3. **archive-root-project-scope** — The authority for a project-scoped path is the session's own detached creation metadata (`agent.session.header.cwd`), never the process cwd or a service that falls back to it.
4. **gui-without-client-compaction-event** — When the client contract has no in-progress signal, serve the phase from a host route and poll, rather than shadowing a shipped keyed slot.
5. **trigger-default-regression** — "Unset" must be expressible in the schema; a default that cannot be told apart from a user choice silently changes the meaning of every configuration.
6. **client-inject-package-names** — `dsh.client.inject` holds client bundle package names (graph rows), not Cordis service keys, and it never sequences activation; ordering comes from `slots.inject`.
7. **loader-volatile-update-not-typed** — Read live config at decision time instead of listening to an undocumented loader event; such a listener may later be a fast path but never the correctness mechanism.
8. **runtime-resolution-alias-only** — Test/typecheck resolution is not runtime resolution: every new `@deepseek-ai/*` import must be added to the link script's `WANTED` list and re-checked with a one-line `tsx` import probe.
9. **bundle-mount-composition-traps** — A composition change must disable the row it replaces in the same edit; `--dump-config` proves the composed tree, not activation.
10. **config-editor-entries-are-loader-nodes** — Never read `id`/`name` from a `configEditor` row as a flat record: the patch id is `entry.options.id`, the flat `entry.id` is the tree id (`include:<patchId>`), and `entry.name` is usually absent.
11. **live-profile-install** — Restart/page-load semantics in one place, and never use a `/plugins/<id>/client.js` fetch as an install check (it 404s for every package, including shipped ones).
12. **panel-floats-above-composer** — When a slot owner lays your entry out in flow, everything rendered inside that entry is page layout; a panel belongs to the viewport and must watch the *anchor's ancestors'* size changes, not just the window's.
13. **externals-list-test-premise** — Never pin a platform capability inside a test comment; assert against the frozen table (`PLATFORM_MODULES`) or the guide, because "illegal import" and "allowed but never declared" look identical from inside a bundle.
14. **native-settings-surface-already-serves-us** — Before hand-writing a configuration UI, ask whether the harness already renders your Config: a schemastery `Config` whose groups are volatile gets a native, validated, revision-safe form for free, and a doc claim about platform behavior needs a file/line source or an "unverified" marker in the same sentence.

## Verification matrix

Cells say only what the records state; `not recorded` means the record names no check in that channel.

| Record | Unit tests | Typecheck | Live HTTP route | Live GUI | User checkpoint |
|---|---|---|---|---|---|
| 1 schemastery | `tests/config.spec.ts:20-33` resolve guard (72 tests / 7 files at fix time) | not recorded | not recorded | not recorded | not recorded |
| 2 warn-once | `tests/config.spec.ts:101-114` regression test (1 / 2 / still-2 warnings) | not recorded | not recorded | not recorded | not recorded |
| 3 archive-root | `tests/workspace.spec.ts` (9 tests), `tests/summarize.spec.ts:94`, `tests/archive.spec.ts:67`, `tests/engine.spec.ts:277-302` | not recorded | not recorded | not recorded | not recorded |
| 4 gui-without | `createGuiRoutes` exported so tests drive the handlers directly (no spec named) | not recorded | not recorded | indicator documented as polling; no visual check recorded | not recorded |
| 5 trigger-default | `tests/config.spec.ts:51-60` and `157-169`; `tests/trigger.spec.ts:32-43`, `65-71` | not recorded | not recorded | not recorded | not recorded |
| 6 client-inject | not recorded | not recorded | not recorded | not recorded | not recorded |
| 7 loader-volatile-update | `tests/engine.spec.ts:198-256` (live edit; `enabled: false` mid-flight) | not recorded | not recorded | not recorded | not recorded |
| 8 runtime-resolution | `vitest` 10 files / 110 tests PASS (12:39, 2026-10-12) | `tsc -p tsconfig.json --noEmit` exit 0 | `tsx` import probe → `IMPORT_OK keys=AutocompactEngine,default` | not recorded | not recorded |
| 9 bundle-mount | not recorded | not recorded | not recorded | not recorded | superseded — the install was performed (record 11) |
| 10 config-editor | `tests/gui.spec.ts` two locked-in cases (`GET /status` → `write: true`; `POST /config` → hands the Loader node to `edit()`), 10 files / 114 tests | `tsc --noEmit` exit 0 | live probe: `configEditor.entries()` 200+ rows; `/status` reported `write: false` before the fix | not recorded | one harness launch needed to load the fix |
| 11 live-profile-install | not recorded | not recorded | `plugin_manager list_plugins` (page 170-209); `GET /dsh-autocompact/status` → 200 with seeded config; `GET /dsh-autocompact/config` → 405 (POST-only by design) | client half in the live boot graph (71 entries, 3 batches); the user's open page still listed only the shipped `stats` occupant | a plain browser refresh is the stated next check |
| 12 panel-floats | `node --check client.js` exit 0; `vitest` 10 files / **120 tests** exit 0 (13:43 local); 7 structural assertions; `tests/client.spec.ts` premise corrected to `['react', 'react-dom']` | `tsc -p tsconfig.json --noEmit` exit 0 | not recorded | browser placement/behaviour **not machine-verified** (node environment, no react/jsdom, no layout) | refresh the GUI: composer bar, message box and transcript must not move |
| 13 externals-list | `vitest` 10 files / 120 tests pass; the renamed externals test asserts `['react', 'react-dom']` | not recorded | not recorded | not recorded | not recorded |
| 14 native-settings | suite green after the doc-only change, no numbers stated (no code touched) | not recorded | not recorded | not recorded | not recorded |

Evidence the records state outside those five channels: target-checkout source reading
(records 1, 4, 6, 7, 9, 12, 13, 14), the boot-free `--dump-config` composition check and
the `/dsh-autocompact-probe/report` probe package (records 9, 11), the fact that two
archives already exist under the project tree (record 11), and the workspace guide's
externals row plus README limitation 7 at commit `8c50f08` (records 13, 14).

## Live application semantics

Only the effect statements the records make.

| Change | When it takes effect | Record |
|---|---|---|
| Patch row added/removed, junction added/removed (composition) | live — `patchReload: live`; verified by mounting and unmounting a probe package without restarting; a profile edit applies to the running harness immediately | 11, 9 |
| Config values (any volatile group) | live — re-read at the start of each operation | 11 |
| `client.js` edit | next page load — bundles are read from disk, but a loaded page cannot swap a module face in place | 11, 12 |
| Host TS source edit (`src/*.ts`, e.g. the `findRow` fix) | next harness start — the module is imported once per process; `/status` kept returning the pre-fix reason string after the fix | 11, 10, 12 |
| `StatusBoard` "recent" list | in-memory — a harness restart loses it; the archives on disk remain the durable record | 4 |
| Native settings write (`ctx.settings` `update` / `replace` / `mutate`) | lands in the same profile-patch user layer; `applies: 'live'` is stated as honest for this entry | 14 |

**Resolved 2026-10-12 after this index was first built.** Record 14 claimed "the
engine already re-reads volatile groups on `loader/volatile-update`", while record 7
states there is no such listener and that the engine re-reads at the start of every
operation. Reading `src/index.ts:165-186` settles it: `refresh()` re-reads the live
groups per operation, and its doc comment records that a live edit "needs no
`loader/volatile-update` listener" — **record 7 is authoritative** and record 14's
sentence was corrected to match. Two adjacent corrections came out of the same pass:
`README.md` said the status route's `recent` list holds up to 3 finished compactions
while `src/status.ts:46` sets `RECENT_LIMIT = 8`, and record 9's "the live install is
a user decision" was marked superseded by record 11.

## Open or deferred

- **Plugin routes are not behind the GUI's browser-auth gate** — `/dsh-autocompact/status` answered `200` and `/dsh-autocompact/config` `405` without the session cookie while `/` required it; recorded as a deliberate gap that should be closed (trust check or explicit opt-in) before exposure beyond `127.0.0.1`. Mentioned in [live-profile-install](incidents/2026-10-12-live-profile-install.md) (primary), [panel-floats-above-composer](incidents/2026-10-12-panel-floats-above-composer.md) and [`RETRO.md`](RETRO.md) (re-verified `200`, no cookie; listed as an open risk).
- **Web-UI Save is dead in the running process until one harness restart** — `/status` still reported `capabilities.write: false` with the pre-fix reason at 13:40 local, and [`RETRO.md`](RETRO.md) re-verified `write=false` with the same reason at ~13:55. Mentioned in [panel-floats-above-composer](incidents/2026-10-12-panel-floats-above-composer.md), [config-editor-entries-are-loader-nodes](incidents/2026-10-12-config-editor-entries-are-loader-nodes.md) and [`RETRO.md`](RETRO.md).
- **Client-half visual result not yet verified** — the record states it needs one page refresh in the user's browser; the pixel placement is not machine-verified, so acceptance is the user observing that the composer bar, message box and transcript do not move. Mentioned in [live-profile-install](incidents/2026-10-12-live-profile-install.md), [panel-floats-above-composer](incidents/2026-10-12-panel-floats-above-composer.md) and [`RETRO.md`](RETRO.md).
- **Native settings migration — recorded, not started** — drop the popover inputs, `mergeConfig`, `POST /dsh-autocompact/config` and the form's strings, keep the dock pill as status plus a link; unverified are the generic-form rendering quality of the nested groups and the `models` array and the label/i18n source. Recorded in [native-settings-surface-already-serves-us](incidents/2026-10-12-native-settings-surface-already-serves-us.md) and `../README.md`, "Known limitations" item 7 (2026-10-12).
- **`/compact-config` port — deferred, stated as NEEDS_USER_DECISION** — the old chat command is not ported. Recorded in [`RETRO.md`](RETRO.md) (open risks) and `../README.md`, "Known limitations" item 3.

Accepted limitations that are not open work (all in `../README.md`, "Known limitations",
except the last, which is a caveat of the linked record and README's configuration
reference): no completion headroom reserved; poll-based GUI and Web-UI-only indicator;
third-party client bundles may not import Harness Client packages; one compaction engine
per profile; a session with no recorded creation cwd shares a tree and falls back to the
harness launch directory; `ratio: 0` / `retain: 0` read as unset
([trigger-default-regression](incidents/2026-10-12-trigger-default-regression.md)).
