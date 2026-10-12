# `configEditor` hands out Loader nodes, not `{id, name}` rows (2026-10-12)

**Symptom.** `dsh-autocompact` was mounted, active, and reading its seeded config,
yet `GET /dsh-autocompact/status` reported
`capabilities.write: false` with
`reason: "no dsh-autocompact entry is present in this profile composition"` —
so the Web-UI tuner would have rendered a disabled Save.

## Root cause

`ctx.configEditor.entries()` and `configuration()` return **Loader `Entry`
objects**, not plain rows. In a Loader entry:

| Field | Value for this plugin | Meaning |
|---|---|---|
| `entry.id` | `include:dsh-autocompact` | tree id — unique across nested include trees |
| `entry.options.id` | `dsh-autocompact` | **profile patch id** — what patches address |
| `entry.options.name` | `dsh-autocompact` | package name |

`src/gui.ts`'s `findRow()` only compared the flat `entry.id` / `entry.name`, so it
never matched anything and the write path was reported as unavailable — even though
the row was plainly present.

Evidence:

- Live probe (2026-10-12 ≈13:26 local): `configEditor.entries()` returned 200+ rows
  whose own keys are `loader, ctx, fiber, moduleNamespace, parent, options, subgroup,
  subtree, _initTask, getOuterStack`; the plugin's row reported `id:
  "include:dsh-autocompact"` and no flat `name`. `configuration()` resolved without
  throwing and contained the same row.
- `packages/extensions/tool-cordis/src/config.ts:28-30` — `const { id, name } =
  entry.options; const listed = { id: entry.id, patchId: id, name }`, i.e. the live
  Config query's `patchId` **is** `options.id`. That query reported
  `{id: "include:dsh-autocompact", patchId: "dsh-autocompact", name: "dsh-autocompact",
  status: "schema"}`, which pins `options.id === "dsh-autocompact"`.
- Shipped callers match the same way, e.g.
  `entries().find(row => row.options.id === 'first')` in
  `packages/settings/settings/src/index.ts:382` and
  `packages/settings/settings/tests/editor-failures.spec.ts:19`.

## Fix

`findRow()` (`src/gui.ts`) now accepts both shapes:

```ts
const match = (entry: ConfigEditorEntry): boolean =>
  entry.id === 'dsh-autocompact'
  || entry.name === 'dsh-autocompact'
  || entry.options?.id === 'dsh-autocompact'
  || entry.options?.name === 'dsh-autocompact'
```

with `ConfigEditorEntry` extended by the optional nested `options` field. The flat
comparisons stay so the existing tests and older harness builds keep working.
`tests/gui.spec.ts` gained two locked-in cases: a `GET /status` that must report
`write: true` and a `POST /config` that must hand the **Loader node itself** to
`edit()` when the editor publishes the nested shape.

## Why the running harness still reported `write: false`

The harness imports a plugin's TypeScript module **once per process** at mount; it
does not re-import edited sources. The fix was verified by unit tests
(10 files / 114 tests, `tsc --noEmit` exit 0) and reaches the live process on the
next harness launch — see
[the install record](./2026-10-12-live-profile-install.md#restart-semantics-verified).

## Reusable rule

Never read `id`/`name` from a `configEditor` row as if it were a flat record. The
patch id is `entry.options.id`; the flat `entry.id` is the tree id
(`include:<patchId>`), and `entry.name` is usually absent.
