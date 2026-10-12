# Schemastery volatility is a containment rule, not a per-field flag

- **Date:** 2026-10-12
- **Area:** `src/config.ts`, the 0.2.x settings/loader model
- **Status:** FIXED (design constraint encoded in the schema and guarded by a test)

## Symptom

Porting the old `handoff-config.json` schema to a native volatile `Config` looked
like a mechanical translation: mark every field the user may edit `.volatile()`.
That fails at resolve time:

```
Error: <path>: volatile fields require a fixed object path without an enclosing volatile field
```

…and, separately, the old fail-fast validator (`retain.tokens < trigger.tokens`,
"provider and model set together", unknown keys) has no equivalent: schemastery has
no cross-field `.check()`.

## Root cause

Volatility is a **containment** rule. A volatile node is only legal at a fixed
object path whose ancestors are all non-volatile. Blocked positions (verified in
the target checkout):

| Blocked position | Source |
|---|---|
| array item | `packages/boot/app-boot/tests/schemastery-json-schema.spec.ts:390` |
| dict value | `…/schemastery-json-schema.spec.ts:391` |
| union member | `…/schemastery-json-schema.spec.ts:392` |
| tuple member | `…/schemastery-json-schema.spec.ts:393` |
| nested inside a volatile node | `…/schemastery-json-schema.spec.ts:394` |
| inside a `z.lazy()` | `…/schemastery-json-schema.spec.ts:395-396` |

The projector throws the quoted message at
`packages/boot/app-boot/src/config-schema/projector.ts:133`; the settings service
derives its editable form the same way (`volatileForm`,
`packages/settings/settings/src/schema.ts:37`) and refuses a plugin with no volatile
field at all (`packages/settings/settings/src/index.ts:386`,
`Plugin entry "<ns>" has no volatile fields`). Editing a non-volatile field is
rejected at runtime too (`Config field "<path>" is not volatile`).

## Fix

1. **One volatile node per section, never per field.** `enabled`, `trigger`,
   `retain`, `archive`, `summarization`, `retries`, and `models` are each marked
   volatile as a whole (`src/config.ts:152-160`). `models` is one volatile *array*;
   the items are ordinary objects, because a volatile node cannot live inside an
   array item.
2. **Preset sections carry no defaults.** `presetTriggerGroup()` and friends
   (`src/config.ts:113-133`) declare the same fields without `.default(...)`, so an
   absent field stays absent and the preset inherits the global group instead of
   silently overriding it with a default.
3. **Field rules become clamp-and-warn-once at read time.** `LiveConfigReader`
   (`src/config.ts:306-393`) applies the pair rule (provider+model together), the
   retain conflict rule (tokens wins), preset pruning and duplicate dropping, and
   never throws — the old fail-fast validator's guarantees are kept where they
   matter (the resolved values) without making a half-typed form fatal.
4. **The volatility rule is a test, not a comment.** `tests/config.spec.ts:20-33`
   resolves an empty document through `z.resolve(...)` — the same call the loader
   makes — and asserts every section exposes `.get()`. A volatile node in a blocked
   position makes `Schema.resolve` throw, so that test *is* the containment guard.

## Evidence

- `D:\my_deepseek_harness\dsh-autocompact\tests\config.spec.ts` — PASS (the suite was
  72 tests / 7 files when this fix landed; it has since grown, see `README.md`).
- `packages/boot/app-boot/tests/schemastery-json-schema.spec.ts:379-398` in the
  target checkout lists exactly which positions are rejected.
- `packages/settings/settings/tests/configuration.spec.ts:30,89,131-148` shows the
  runtime rejections for non-volatile edits and volatile-only schemas.

## Caveats

- A volatile section is **replaced as a whole** by the settings service: field-level
  staging happens in the settings form model, not in the schema.
- Because there is no cross-field validator, an invalid *combination* is accepted by
  the schema and repaired (or dropped) by the reader. The reader's notices are
  per-generation, so a half-typed value produces one line, not a stream.
