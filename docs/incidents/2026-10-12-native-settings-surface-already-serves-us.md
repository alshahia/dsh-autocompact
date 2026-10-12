# The native settings surface already serves this plugin's Config

**Date:** 2026-10-12 · **Status:** knowledge recorded (migration deliberately not
started)

## Issue — a documentation claim built on an unchecked premise

README limitation 7 described the planned migration as "declare the fields
natively so Settings → Plugins renders (and localizes) the form", and asked
future work to "investigate how the shipping `configurable` tab renders an
*inserted* row". Both phrases assumed work on our side and an unverified
mechanism. When the option was explained in detail, reading the harness showed
the opposite: the declaration already exists, and the native surface does not
distinguish an inserted row from a pre-existing one.

## What the host actually does (0.2.1-alpha.2)

`packages/settings/settings/src/index.ts` — `class SettingsForms extends Service`,
service key `ctx.settings`:

- `describe()` walks `ctx.configEditor.configuration()`; for every entry whose
  fiber is ACTIVE, whose `fiber.runtime.Config` is a schemastery schema with
  `toJSON`, and whose `volatileForm()` projection is non-empty, it emits a
  `SettingsNamespaceView` with `ns = entry.options.id` (our row:
  `dsh-autocompact`), the projected `schema`, the resolved `value` (defaults →
  composition base → user layer), `base`, `user`, `revision`,
  `applies: 'live'` and `autoGenerate`.
- `volatileForm()` (`./schema.ts`) returns **only the volatile-declared
  subtree**. A plugin with no volatile Config gets no page at all.
- Write path: `update` (merge), `replace` (reset live fields to inherited, then
  set) and `mutate` (path ops; unsetting an array index removes the element;
  unsetting a field restores the inherited value). It refuses a stale writer
  (`expectedRevision` → `SettingsConflictError`), refuses every non-volatile
  path (`Config field "x" is not volatile`), strips non-volatile raw fields so
  ordinary config survives, and performs the write through the **same**
  `configEditor.edit` this plugin's own route already uses.
- `configure({ auto: false })` suppresses the auto-generated page per instance.
- Client side: `ctx.configForms` (`get` / `describe` / `whileServed`) and
  `ctx.settingsSchema` are client services; the Settings → Plugins section is
  owned by `ui-settings-plugins` and lists tabs from the live
  `settings.plugins.tab` slot (`configurable` order 0, `all` order 10); companion
  packages contribute hand-written cards into `plugins.item`, gated by
  `configForms.whileServed([ns], …)`.

## Why it lands on this plugin

Every tunable group in `src/config.ts:152-160` is already `.volatile()` —
including `models` as a whole array, precisely because a volatile node cannot
nest — which is exactly what `volatileForm()` needs. `applies: 'live'` is honest
for this entry because the engine re-reads the live groups at the **start of every
operation** (`refresh()`, `src/index.ts:165-186`), not because of a loader event:
`loader/volatile-update` has no published contract and no listener is installed
(record 7, authoritative on that mechanism). Storage does not move: native writes
land in the same profile-patch user layer, and `LiveConfigReader` still clamps and
warns on read regardless of who wrote the value.

The `capabilities.write: false` this plugin chased was **our own** `findRow` bug
(incident 10). The native service looks the row up as `row.options.id === ns` and
never had it.

## Consequence

The migration is mostly **deletion** — popover inputs, `mergeConfig`, `POST
/dsh-autocompact/config`, the form's strings — plus three decisions: label/i18n
sourcing (our copy lives in `locale/*.json`; generic forms label from the
schema), whether the dock pill keeps a quick-edit face or becomes a link, and
whether a bespoke page should suppress the auto page. Unverified: generic-form
rendering quality for the nested groups and the `models` array.

## Evidence

- Source read in `D:\deepseek-harness_2` on 2026-10-12; paths and line numbers
  repeated in README limitation 7.
- Corrected record: README limitation 7, commit `8c50f08`.
- Test suite still green after the doc-only change (no code touched).

## Reusable rule

Before hand-writing a configuration UI, ask the harness whether it already
renders your Config: a schemastery `Config` whose groups are **volatile** gets a
native, validated, revision-safe settings form for free. Bespoke UI is for what
the schema cannot express. And a documentation claim about platform behavior
needs a file/line source, or must be marked unverified in the same sentence.
