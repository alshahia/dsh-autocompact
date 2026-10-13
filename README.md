# dsh-autocompact

Auto-compaction for the **DeepSeek Harness (DSH)** with live-tunable thresholds,
model-written handoff archives kept **inside the project that owns the session**,
and a Web-UI indicator that shows a compaction while it is running.

This is the standalone successor to the `compaction-handoff` + `web-compact-config`
pair in the legacy plugin suite (frozen at `_archive/deepseek_plugins/` in the
workspace): the same trigger/archive semantics, ported
to the 0.2.x plugin system (a bundle with a patch, a native volatile `Config`, a
`dsh.client` client bundle, and host-served GUI routes instead of a dead settings
bridge and a hand-edited JSON store).

- **Host half** — `src/index.ts`: `AutocompactEngine extends BasicCompactionEngine`,
  loaded as a TypeScript source (no build step).
- **Client half** — `client.js`: a hand-written CommonJS bundle for the Web UI.
- **Bundle** — `cordis.patch.yml`: disables the shipped `compaction-basic` row and
  inserts this package in its place, so it registers itself as `ctx.compaction`.

## Compatibility

| Item | Value |
|---|---|
| Target harness | DSH `0.2.1-alpha.2` (verified against `D:\deepseek-harness_2`) |
| Module format | ESM, strict TypeScript, `node >= 20` |
| Package kind | bundle (`dsh.bundle.patch`) **and** client module (`dsh.client`) |
| Build step | none for the host half (`exports["."] → ./src/index.ts`); `client.js` is committed as source |
| Settings model | native schemastery `Config` with `.volatile()` sections |

## What it does

- **Replaces the pressure policy.** The patch disables `compaction-basic` and mounts
  this engine on the same seam, so nothing else in the profile has to change.
- **Extended triggers** — a fraction of the routed model's context window, an
  absolute token count, or both, with per-model presets and a per-model off switch.
- **Archives every compaction** — the full verbatim condensed span plus the
  model-written summary, indexed, per project, per session.
- **Archive pointer** — a short paragraph naming both files is prepended to the
  compacted summary, so the model (and a future agent) knows where the raw material is.
- **Context-pressure memory (`session_memory`)** — the model can ask what is taking up
  room, drop finished steps from the visible conversation, pin what must stay, and recall
  a dropped span's verbatim text from its archive. Every drop is archived **before** the
  surface is touched, user messages survive verbatim, and a drop happens at a step
  boundary so the in-flight request is never edited. See
  [Session memory](#session-memory).
- **Fully live configuration** — every tunable group is a schemastery `.volatile()`
  section; the engine re-reads them at the start of every operation, so an edit
  applies to the next operation with **no restart and no reload**. (Editing the
  plugin's *source* is different — see
  [Restart, reload, and hot application](#restart-reload-and-hot-application).)
- **Visible in the Web UI** — a composer-dock indicator with elapsed time and phase,
  plus an inline tuning panel that writes changes back through the harness.

## Install

Preferred: let the harness install and select the bundle.

```
plugin_manager  action: install_bundle  target: D:\my_deepseek_harness\dsh-autocompact
```

`install_bundle` accepts a local directory, a git URL, a tarball, or a package name.
A package is a **bundle** exactly when its `package.json` declares `dsh.bundle.patch`;
this one does, so the install also selects the bundle layer in the profile
(`dsh.profile.bundles`). Installing into a live profile applies immediately;
a startup profile needs a restart.

> **Before the first install, back up the profile patch** at
> `%DSH_HOME%\profiles\<profile>\cordis.patch.yml`, and make sure only one
> compaction engine is mounted. The legacy setup mounts `compaction-handoff` (and
> `compact-config-command`) by `file://` path; leaving those enabled while this
> bundle is active means **two engines both registering `ctx.compaction`**.

Hand-authored alternative — append to the profile patch:

```yaml
- override:
    - id: compaction-basic
      disabled: true
- insert:
    - id: dsh-autocompact
      name: 'dsh-autocompact'
      config:
        enabled: true
        trigger:
          mode: first        # 'first' | 'tokens'
          ratio: 0.8         # 0 = unset; fraction of the context window
          tokens: 0          # 0 = unset; absolute token count
        retain:
          tokens: 60000      # kept-verbatim tail; tokens wins over ratio
        archive:
          root: '.dsh/handoffs'
          gitIgnore: true
          onFailure: block
        summarization:
          provider: ''       # empty pair = inherit the routed conversation model
          model: ''
          maxTokens: 8192
        retries:
          compactionRetries: 1
          maxOverflowRetries: 1
        memory:
          enabled: true
          budget:
            ratio: 0.3         # decide band as a fraction of the measured surface
            denominator: surface  # 'surface' (default) | 'total'
            warnAt: 0.9        # soft-nudge at this fraction of the budget
          limits:
            minFreedTokens: 2000
            maxOpsPerTurn: 2
            mapTokens: 1500
          policy:
            protectUserMessages: true
            archiveOnDrop: block   # 'block' (default) | 'proceed'
            recallMaxTokens: 1200
        models:
          - provider: opencode-go
            model: deepseek-v4.1-flash
            trigger: { tokens: 120000 }
```

Both writers end up in the same place: the values live in the plugin's own config
namespace, and the GUI panel persists edits through the harness config-editor path.

## Restart, reload, and hot application

Install and configuration are live; **code** is not. Verified on 0.2.1-alpha.2
(2026-10-12):

| Change | When it takes effect |
|---|---|
| Install/remove the bundle row or its delivery junction (a composition change) | **live** — the profile reloads its patch; a newly mounted package is imported immediately |
| Any config value (every group is volatile) | **live** — re-read at the start of each operation |
| `client.js` edit | next **page load** — bundles are served from disk, but a loaded page cannot swap a module face in place |
| Host source edit (`src/*.ts`) | next **harness start** — the module is imported once per process |
| The web server becoming available (it belongs to the `web-runtime` boot entry) | whenever that provider comes up — the bridge uses `ctx.inject(['webServer'], …)`, so route registration does not depend on being reachable at apply time ([incident 17](docs/incidents/2026-10-13-optional-service-read-at-apply-404-routes.md)) |

So a source change costs one restart, a client change costs one browser refresh, and
neither is needed to *use* an already-installed bundle. The measurements behind this
table are in
[the live-install record](docs/incidents/2026-10-12-live-profile-install.md#restart-semantics-verified).

## Configuration reference

Every section below is one volatile group. Defaults are what the engine resolves
when the field is absent; `0` in a limit field means **unset**, not zero.

| Section | Field | Default | Meaning |
|---|---|---|---|
| `enabled` | — | `true` | Master switch. `false`: no automatic pressure compaction **and** no archiving. Manual `/compact` and context-overflow recovery still work. |
| `trigger` | `mode` | `'first'` | How `ratio` and `tokens` combine when both are set: `first` = fire at the earlier of the two, `tokens` = the absolute limit wins. |
| | `ratio` | `0` (unset) | Fraction of the context window; `floor(window × ratio)`. Requires the routed model to declare `context.contextWindow`. |
| | `tokens` | `0` (unset) | Absolute token count. Works with no context window at all. |
| `retain` | `ratio` | `0` (unset) | Kept-verbatim tail as a fraction of the window. |
| | `tokens` | `0` (unset) | Kept-verbatim tail in tokens. **Wins over `ratio`** when both are set (one warning). |
| `archive` | `root` | `'.dsh/handoffs'` | Archive root, resolved against the **project directory** of the session (never the harness process cwd). |
| | `gitIgnore` | `true` | Write `<root>/.gitignore` containing `*` once, so archives never show in `git status`. The project's own `.gitignore` is never touched. |
| | `onFailure` | `'block'` | `block`: propagate the write failure, so compaction cannot silently lose the span. `proceed`: warn, skip archive and pointer. |
| `summarization` | `provider` / `model` | `''` / `''` | Empty pair = inherit the routed conversation model. Set them **together**; a half-filled pair is dropped with a warning. |
| | `maxTokens` | `8192` | Provider generation cap for the summary. |
| `retries` | `compactionRetries` | `1` | Extra compaction attempts while pressure remains above the threshold. |
| | `maxOverflowRetries` | `1` | Overflow-recovery retries (delegated to the base engine). |
| `memory` | `enabled` | `true` | Master switch for the memory tool, the nudge and the step-boundary drop. `false`: `inspect`/`plan` still report, `apply` refuses. |
| | `budget.ratio` | `0.3` | The **decide band**: `surfaceTokens` (the measured request size of the current surface) over `budget.tokens`, else this fraction of the context window. At or above it, the step-boundary nudge fires. |
| | `budget.tokens` | unset | Absolute decide budget. **Wins over `ratio`** when both are set. |
| | `budget.denominator` | `'surface'` | What the band measures: the surface only, or `'total'` (the whole routed request, including the system prompt and tools). |
| | `budget.warnAt` | `0.9` | Fraction of the budget at which the engine may append one soft nudge per episode (never more than one). Clamped to `1`. |
| | `limits.minFreedTokens` | `2000` | A planned drop that frees less than this (net of the tombstone it adds) is refused, so memory never churns for nothing. |
| | `limits.maxOpsPerTurn` | `2` | How many drops one turn may commit. Clamped to 1-8. |
| | `limits.mapTokens` | `1500` | Rough budget for the `inspect` step map text. Clamped to 200-8000. |
| | `policy.protectUserMessages` | `true` | Every user message inside a dropped span is re-emitted verbatim in the tombstone (per-message cap ~6000 chars, then a truncation marker). `false` drops that guarantee. |
| | `policy.archiveOnDrop` | `'block'` | `block`: a drop whose archive write fails is refused and the history stays. `proceed`: warn and drop anyway. |
| | `policy.recallMaxTokens` | `1200` | Text budget for one `recall` result. Clamped to 200-8000. |
| `models[]` | `provider`, `model` | required | Exact route to match. A preset missing either field is dropped with a warning. |
| | `trigger`, `retain`, `summarization`, `retries` | inherit | Field-wise override of the global groups. A preset `trigger` **replaces** the global trigger wholesale (`mode` still inherits). |
| | `disabled` | `false` | `true`: never auto-fire for this model. Manual and overflow compaction are unaffected. |

### Trigger math

Let `window` be the routed model's context window.

1. `mode: tokens` and `tokens` set → `tokens` (the ratio is only a fallback and the
   window is **not required**).
2. `ratio` only → `floor(window × ratio)`.
3. Both set, `mode: first` → `min(floor(window × ratio), tokens)`.
4. Both unset → `floor(window × 0.8)`: the upstream default, applied only when
   nothing at all was configured.

A window-relative field (`ratio`, or a ratio-based `retain`) needs a real
`contextWindow`; when the adapter declares none, the engine raises
`TargetPressureConfigError` for that route instead of guessing.

### Retention clamping

The kept tail is `retain.tokens`, else `floor(window × retain.ratio)`. If the
resolved tail is **at or above** the fire-at threshold, it is clamped to
`threshold - 1` and a single warning per `target@threshold:retain` is logged.
Clamping (rather than throwing) is deliberate: a throw here used to poison every
pre-step and silently disable auto-compaction. The parent engine receives
`retainRatio` only when it is strictly below the trigger ratio.

### Live editing

The engine re-reads every volatile group at the start of `compactIfNeeded`,
`summarize`, and the pressure preview. A half-typed value in a form is therefore a
harmless state: unreadable values are clamped or dropped with **one notice per
distinct problem per resolved generation**, and reading a live config never throws.
If the base engine cannot accept a mid-edit projection, it keeps its previous
values while the trigger math follows the edit, and logs one warning.

## Archives

```
<projectDir>/.dsh/handoffs/                 # archive.root — one tree per project
├── .gitignore                              # "*", written once (idempotent)
└── <sessionId>/                            # one directory per session id
    ├── index.md                            # | timestamp | directory | condensed | model |
    ├── 001-20261012-120000/
    │   ├── handoff.md                      # the model-written summary
    │   └── conversation.md                 # full verbatim condensed span
    └── 001-20261012-120000-a2/             # same-second collision disambiguated
```

- **Project-scoped.** The root is resolved against `agent.session.header.cwd` — the
  absolute directory the session was created in — falling back to the harness launch
  directory for a session that records none. Two projects never share an index or an
  ordinal sequence.
- **Atomic.** Each archive is written into `.<name>.tmp` and then renamed into place,
  so a partial archive can never be observed.
- **Never deletes.** Archives are append-only; `conversation.md` is the raw span each
  compaction condensed, and the chain of them plus `index.md` reconstructs the session.
- **Pointer.** `summarize()` prepends a paragraph naming both files at the
  project-relative path (absolute when the archive root leaves the project).

## Session memory

Automatic compaction fires when the *request* gets large. Session memory is the
complementary manual path: it lets the model decide that some **finished** work no longer
needs to sit on the visible surface, and pay for that space back with one tombstone —
after the raw text has been archived to disk. It is a tool, not a trigger: nothing drops
unless the model (or the user, through the model) asks for it.

The tool is `session_memory` with five actions:

| Action | Arguments | What it does |
|---|---|---|
| `inspect` | — | Prints the **step map**: one row per step on the surface (`turn.step`, seq range, shape, ~tokens, preview, `[pinned]`/`[retained]`), the resolved budget picture, and the current band. Read-only. |
| `plan` | `steps` | Resolves a selection, checks every guard, and returns what *would* happen. With `apply: true` it also archives the span and **queues** the drop. |
| `apply` | `steps` | Same as `plan` with `apply: true`; refuses when the queued-drop limit for this turn is reached. |
| `pin` / `unpin` | `seqs` | Marks surface seqs (or ranges, e.g. `12-18`) as undroppable. Pins are also what protects a fact the model will need later. |
| `recall` | `query` | Searches the archives of this session and returns the matching verbatim text (bounded by `recallMaxTokens`). |

```
inspect  → step map + budget
plan 3.1-3.4        → dry run: tokens, tombstone cost, net freed
apply 1-3           → archive, then queue a step-boundary drop
```

**Naming a step.** The first column of `inspect` is the only accepted spelling:
`"3.1"` is turn 3, step 1; `"3"` is every step of turn 3; `"1-3"` is turns 1 to 3;
`"3.1-3.3"` is steps 1 to 3 of turn 3. A bare turn expands to whatever steps it holds.
In the harness a step counter restarts inside each turn (`agent.ts:396`), so a bare step
number would name a different step in every turn — hence the `turn.step` key
([incident 16](docs/incidents/2026-10-13-session-memory-step-attribution.md)).

**Why `apply` is deferred.** A tool call runs *inside* a turn, and the harness only lets
the surface be rewritten at an idle maintenance point. So `apply` does the expensive,
safe half immediately — it writes the archive and prices the exact tombstone — and queues
the surface replacement for the next `step/start` event. Nothing is deleted at the moment
the tool returns; the reply says `queued`, and the drop lands at the next step boundary.

**What a drop guarantees.**

- **Archived first, then dropped.** The span's full verbatim text and a handoff summary go
  to the session's archive tree before the surface changes. `archiveOnDrop: 'block'`
  means a failed write refuses the whole drop rather than losing text.
- **User messages are never lost.** Every `user/message` inside the dropped span is
  re-emitted verbatim in the tombstone (capped per message, with a truncation marker when
  the cap bites). A drop that would not free real space is refused by
  `limits.minFreedTokens`, because the tombstone itself is priced in.
- **Whole steps only.** A step that is only partly below the retained-tail boundary is
  refused instead of half-removed, and a tool-call/tool-result pair is always taken
  together — a drop can never leave an orphaned call or result on the surface.
- **Pins are absolute.** A selection that touches a pinned seq is refused until it is
  unpinned.
- **The latest turn stays.** The kept-verbatim retained tail is not droppable, so the
  current request and its answer are never in a planned span.

Pins live in memory for the process lifetime (they are not persisted), and the
`memory` group has no editor in the dock panel yet — edit it in the config document or
the native settings form (see [Known limitations](#known-limitations)).

## Web UI

### Host routes

Registered on the composition's web server (skipped, with a log line, when the
composition has none — compaction and archiving keep working).

| Route | Behaviour |
|---|---|
| `GET /dsh-autocompact/status` | `{ plugin, enabled, running, recent, session, config: { effective, raw }, capabilities }`. `running` is `{ sessionId, phase, detail, startedAt, elapsedMs }` or `null`; `recent` holds up to 8 finished compactions (`RECENT_LIMIT`, `src/status.ts:46`); `session` is the pressure preview for `?session=<id>` (or the only live session); `capabilities.write` says whether tuning can be persisted, with a paste-ready `snippet` fallback. |
| `POST /dsh-autocompact/config` | Partial JSON patch, merged one level deep inside a group section (`null` removes a key). Rejects unknown keys (400), a body over 64 KiB (400), a config the schema cannot resolve (400), and a cross-origin request (403). `409` when the composition has no config editor or no row to write, with the reason. |

The prefix is deliberately **not** `/plugins`: that prefix is owned by the
client-modules bundle route.

Registration is **deferred**, not attempted at apply time: `webServer` is
provided by the separate web-runtime boot entry, which is not reachable yet when
this plugin is applied during a cold start, so `installGuiBridge` arranges
registration with `ctx.inject(['webServer'], …)` and registers on the injected
child scope. A one-shot optional read at apply time silently left both routes
unregistered for the whole process lifetime — the plugin kept compacting while
the GUI showed nothing, and the client's status poll answered `404` — see
[incident 17](docs/incidents/2026-10-13-optional-service-read-at-apply-404-routes.md).
A `404` on `/dsh-autocompact/*` means "never registered"; an existing plugin
route answers `401` (auth), which is how to tell the two apart.

### Client indicator

`client.js` is a hand-written CommonJS bundle loaded through the shell's module
loader (`window.__ModuleLoader__`) that registers **one** composer-dock visual:

- an animated **“compacting…”** indicator with an elapsed timer and the current phase,
  plus a short success/failure chip after a compaction finishes;
- an **Auto-compact** button opening a **floating** tuning panel (enable toggle,
  trigger ratio/tokens — blank means unset — retain tokens, archive root, summary
  provider/model) that writes back with `POST /dsh-autocompact/config` and confirms
  “applies on the next step”. The panel is portaled to `<body>` and fixed above the
  pill, clamped to a 12 px viewport margin and capped in height with its own scroll,
  so opening it never moves the composer, the message box or the transcript; it
  closes on a re-click, on an outside press, on Escape (which returns focus to the
  pill) and re-anchors when the row, the pill or the panel changes size. The
  panel is **opaque**: the shared `--dsw-specific-menu` material is only 45–58%
  opaque outside macOS, so the panel layers it over `--dsw-alias-bg-layer-1`
  (and adds the menu `backdrop-filter`) instead of showing the transcript
  through its own surface — see
  [incident 15](docs/incidents/2026-10-12-panel-surface-translucent.md);
- **adaptive polling** of `GET /dsh-autocompact/status`: ~900 ms while a compaction is
  running, ~3 s while idle;
- **explains itself.** The floating panel is not a bare form: it opens with what
  compaction is and when an edit takes effect (next step, no restart), gives every
  control its own plain-language help line (enabled, trigger ratio, trigger tokens,
  retain tokens, archive root, summary provider, summary model, and the status
  numbers), and closes with what Save writes and the live-settings-versus-code
  distinction. Each help line is wired to its input with `aria-describedby`, and
  both locales are kept in step. When the host route cannot be read at all, the
  state is legible instead of empty: the poll records the failure, the pill's dot
  turns amber for "unknown" (distinct from grey "switched off"), and the panel
  shows a banner naming the cause — including that a host-code change reaches the
  running harness only at its next start — rather than ending at `Read-only: `;
- fail-safe: if anything is missing or throws, it renders nothing and the chat is
  never disturbed. It registers exactly one `conversation.composer.dock` visual and
  takes `react` and `react-dom` (for the portal) from the shell's platform module
  table; there is no build step for it either.

Why polling: this harness version exposes no client-side compaction event, and the
`conversation.chat.node` slot is keyed by a fixed node-kind table whose compaction
keys are already owned by the shipped UI — see
[incident 4](docs/incidents/2026-10-12-gui-without-client-compaction-event.md).

## Development

```powershell
cd D:\my_deepseek_harness\dsh-autocompact

# once (and again after switching checkouts): build the node_modules junction farm
node scripts\link-node-modules.mjs --target D:\deepseek-harness_2

# tests (12 spec files: config, trigger, archive, summarize, workspace, engine,
#        status, gui, client, toolchain, memory, runtime)
node node_modules\vitest\vitest.mjs run

# typecheck
node node_modules\typescript\bin\tsc -p tsconfig.json --noEmit
```

- Verified on the 0.2.1-alpha.2 target (2026-10-13): **PASS** — 12 files / 168 tests;
  `tsc -p tsconfig.json --noEmit` exit 0. (The memory suites are the newest feature
  work: 18 + 13 tests; `tests/config.spec.ts` grew to 24 for the `memory` group;
  `tests/gui.spec.ts` is 27, including two tests that drive the **real** cordis
  registry to prove deferred `webServer` registration — incident 17.)
- Invoke the tools through their **junctioned package entries** as above: this
  `node_modules` is a farm of package directories only, so there is no
  `node_modules\.bin` shim directory to call.

- `node_modules` here is a **symbolic-link farm** into a DSH checkout, not a normal
  install. Never run `pnpm install` / `npm install` in this package; rebuild or
  re-point the farm with `node scripts\link-node-modules.mjs [--target <checkout>]`
  instead. The farm is what gives the harness's `tsx` loader a runtime target for
  every `@deepseek-ai/*` specifier — the test aliases do not apply at runtime
  ([incident 8](docs/incidents/2026-10-12-runtime-resolution-alias-only.md)).
- `vitest.config.ts` picks the target checkout from `DSH_TARGET`, then
  `scripts/.dsh-target.txt`, then the conventional `D:/deepseek-harness_2`, and
  generates the alias facade from that checkout's `tsconfig.base.json`
  (`vite-tsconfig-paths` cannot do this because this package sits outside the
  checkout).
- All `@deepseek-ai/*` imports resolve to the target checkout's **`src/`**, never to
  its `lib/` output: mixing the two creates a second copy of a class and breaks
  `instanceof` identity (`tests/toolchain.spec.ts` is the guard).
- After installing the bundle into a profile, validate the composition from the
  target checkout with `--dump-config` before booting it.

### Layout

| Path | Role |
|---|---|
| `src/index.ts` | `AutocompactEngine`: the pressure path, summary wrapping, pressure preview. |
| `src/config.ts` | The volatile `Config`, `LiveConfigReader` (clamp-and-warn-once), projection to the parent config. |
| `src/trigger.ts` | Effective-threshold math: modes, presets, the inherited `0.8` default, retain clamping. |
| `src/summarize.ts` | `summarize()` override body: call the upstream summarizer, archive, prepend the pointer. |
| `src/archive.ts` | Atomic archive writer, `conversation.md` renderer, `index.md`, `.gitignore`. |
| `src/workspace.ts` | Project directory of a session (`header.cwd` → fallback). |
| `src/status.ts` | Live progress board (running compaction per session, bounded recent outcomes). |
| `src/gui.ts` | The two HTTP routes and the config-editor write path. |
| `src/memory.ts` | Pure surface model: step map, selection grammar, budget bands, drop planning and tombstone rendering. |
| `src/drop.ts` | Drop side effects: archive-then-replace commit, span re-validation, recall. |
| `src/runtime.ts` | `MemoryRuntime`: the tool's operations, the queued drop, the step-boundary flush, the pressure nudge. |
| `src/tool.ts` | The `session_memory` tool definition. |
| `src/types.ts` | Document shapes and the resolved form. |
| `client.js` | Web-UI indicator and tuning panel. |
| `cordis.patch.yml` | The bundle patch (disable `compaction-basic`, insert this package). |
| `locale/{en,zh}.json` | `meta.title` / `meta.description` for the plugin manager and page chrome. |
| `scripts/link-node-modules.mjs` | Builds/re-points the `node_modules` junction farm against a DSH checkout. |

## Known limitations

1. **No completion headroom is reserved.** The upstream `headroomTokens` (65536)
   capacity math is deliberately *not* applied to the automatic trigger, so the
   engine fires at exactly the configured threshold. A ratio close to `1.0` can
   leave too little room for the summarization call itself; keep a margin.
2. **Poll-based GUI.** The indicator notices a running compaction within ~900 ms and a
   finished one within ~3 s (the idle cadence), and it exists only in the Web UI — a
   headless composition has no routes and no indicator.
3. **No `/compact-config` chat command.** The dock panel and the native config
   surface are the tuning surfaces; the old command is not ported.
4. **Third-party client bundles may not import Harness Client packages.** Even though
   the platform module table exposes `@deepseek-ai/dsh-client-ui-primitives` and
   friends, the plugin rules forbid it: `client.js` carries its own markup and CSS
   under a plugin prefix and uses only `--dsw-alias-*` theme tokens.
5. **One compaction engine per profile.** Mounting this bundle next to
   `compaction-handoff` registers `ctx.compaction` twice.
6. **A session with no recorded creation cwd** falls back to the harness launch
   directory, so two such sessions share one archive tree.
7. **Tuning is still a bespoke panel (planned migration).** The dock popover
   duplicates a surface the harness already owns for this plugin. The host
   settings service projects every *active* entry's **volatile** Config schema
   into a form (`packages/settings/settings/src/index.ts` — `describe()` →
   `volatileForm()`), and every tunable group here is already volatile
   (`src/config.ts:152-160`, `models` as a whole array because volatile nodes
   cannot nest). The native write path is the same one this plugin's own route
   uses (`configEditor.edit`), with `expectedRevision` conflict refusal, an
   explicit `isVolatilePath` gate, and unset-restores-inherited semantics — so
   Settings → Plugins (the `configurable` tab live in `settings.plugins.tab`)
   is expected to render these fields already. Migration is therefore mostly
   **deletion**: drop the popover's inputs and `POST /dsh-autocompact/config`,
   keep the dock pill as status plus a link, and decide label/i18n sourcing
   (schema text vs `locale/*.json`) and whether to suppress the auto page with
   the settings service's `configure({ auto: false })`.
   **Unverified:** rendering quality of the nested groups and the `models`
   array in the generic form, and where its labels come from. Recorded
   2026-10-12 by user decision; not started.
8. **The two HTTP routes are not behind the GUI's session gate.** They are
   registered directly on the composition's web server, so
   `GET /dsh-autocompact/status` — and the `POST /dsh-autocompact/config` write —
   answer with no session cookie (re-verified 2026-10-12: `200`, no cookie).
   Treat them as local/loopback surfaces only and do not expose the port. The
   planned native-settings migration (limitation 7) deletes the write route and
   removes half of this exposure.

9. **Session memory needs a restart to load, its pins are per process, and it has no
   dock editor.** It is host code (`src/*.ts`), so it applies on the next harness start.
   Pins live in `MemoryRuntime` for the process lifetime and are gone after a restart.
   A drop is permanent on the surface — `recall` returns the archived text but does not
   re-insert it, so a span the model still needs must be pinned *before* it is dropped.
   The `memory` group is editable in the config document (and therefore in the native
   settings form), but the dock panel renders no memory section yet.

## Incident records

Every real issue found while porting is recorded with its root cause, fix and
evidence under [`docs/incidents/`](docs/incidents/):

1. [Schemastery volatility is a containment rule](docs/incidents/2026-10-12-schemastery-volatile-containment.md)
2. [Warn-once reported every notice twice](docs/incidents/2026-10-12-warn-once-probe-pass.md)
3. [Archives must belong to the project, not the process](docs/incidents/2026-10-12-archive-root-project-scope.md)
4. [No client compaction event: poll a host route instead](docs/incidents/2026-10-12-gui-without-client-compaction-event.md)
5. [A defaulted trigger ratio broke pure-token configs](docs/incidents/2026-10-12-trigger-default-regression.md)
6. [`dsh.client.inject` lists package names, not service keys](docs/incidents/2026-10-12-client-inject-package-names.md)
7. [`loader/volatile-update` is not a typed event to build on](docs/incidents/2026-10-12-loader-volatile-update-not-typed.md)
8. [The package resolved only through test aliases, not at runtime](docs/incidents/2026-10-12-runtime-resolution-alias-only.md)
9. [Mounting the bundle is a composition change with two traps](docs/incidents/2026-10-12-bundle-mount-composition-traps.md)
10. [`configEditor` rows are Loader nodes, not `{id, name}` records](docs/incidents/2026-10-12-config-editor-entries-are-loader-nodes.md)
11. [Live install into the running `web` profile (and what needs a restart)](docs/incidents/2026-10-12-live-profile-install.md)
12. [An inline dock panel pushed the composer up the page](docs/incidents/2026-10-12-panel-floats-above-composer.md)
13. [A test pinned the bundle's externals to a list that was never the rule](docs/incidents/2026-10-12-externals-list-test-premise.md)
14. [The native settings surface already serves this plugin's Config](docs/incidents/2026-10-12-native-settings-surface-already-serves-us.md)
15. [The floating tuner was translucent — its surface read muddy](docs/incidents/2026-10-12-panel-surface-translucent.md)
16. [A step is not a number: step identity, and the non-ascending surface](docs/incidents/2026-10-13-session-memory-step-attribution.md)
17. [The web server was read once, at apply time: both routes were never registered](docs/incidents/2026-10-13-optional-service-read-at-apply-404-routes.md)

Also in `docs/`:

- [INCIDENT-INDEX.md](docs/INCIDENT-INDEX.md) — one-page catalog: issue, root
  cause, fix, status, evidence class.
- [RETRO.md](docs/RETRO.md) — the process failures behind these records and the
  rules they produced.
- [PLUGIN-GUIDE.md](docs/PLUGIN-GUIDE.md) — the shortest path to a working
  plugin on this target, with the trap list.

## License

MIT — see [LICENSE](LICENSE).
