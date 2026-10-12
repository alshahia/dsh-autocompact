# Mounting the bundle is a composition change with two traps

- **Date:** 2026-10-12
- **Area:** profile `cordis.patch.yml` / `dsh.bundle.patch`
- **Status:** VERIFIED boot-free (`--dump-config`); **superseded on the install
  question** — the live install was performed the same day and is recorded in
  `2026-10-12-live-profile-install.md` (host half, live config, legacy retirement
  and client-half registration all PASS there)

## Why this is an incident

This package replaces the profile's compaction engine without any profile code
changing: its bundle patch disables the shipped `compaction-basic` row and inserts
this package, which registers the same `ctx.compaction` service. Two traps make an
unverified edit here expensive.

### Trap 1 — two engines can both be mounted

The legacy setup mounts `compaction-handoff` (plus `compact-config-command`) from
`%DSH_HOME%\profiles\<profile>\cordis.patch.yml` by `file://` path. A bundle install
applies the bundle's patch but does **not** remove those rows, so the profile would
end up with both engines registering `ctx.compaction`. The engine row must be
disabled in the same edit that selects this bundle.

### Trap 2 — a bundle patch does not apply to a hand-written insert

Naming the package in an `insert:` row mounts the plugin but applies **no**
`dsh.bundle.patch`. `compaction-basic` is disabled in the live profile already; a
profile that still has it enabled must disable it explicitly.

## Blast radius (checked before touching the live profile)

`packages/core/agent-loop/src` never references `compaction`, and of the shipped
consumers only `command-compact` injects it (`export const inject = ['commands',
'compaction']`) — and that row is disabled in the live profile. A failed swap
therefore degrades to "no automatic compaction" (the exact symptom this port
fixes), not to a broken session; re-enabling the legacy row in one edit restores it.

## Verification recipe (no boot)

```powershell
# from the target checkout
node --import tsx/esm apps/cli/src/bin.ts --profile web `
  --patch 'D:/my_deepseek_harness/dsh-autocompact/.live-test/compose.patch.yml' `
  --dump-config
```

The overlay disables `compaction-handoff` + `compact-config-command` and inserts
`dsh-autocompact`. Result (2026-10-12): exit 0; both legacy rows `disabled: true`;
the new row present; `compaction-basic` still disabled.

## Caveats

- `--dump-config` is boot-free: it proves the composed tree, not activation. Module
  resolution is proven separately by the `tsx` import probe, and activation only by
  a real mount.
- The client half needs the row to name the **package** (`name: 'dsh-autocompact'`)
  resolved from the profile's `node_modules`; a `file:///...src/index.ts` row mounts
  the host half but leaves the client verdict unresolved — see
  [client inject package names](2026-10-12-client-inject-package-names.md).
- The profile's `patchReload: live` means an edit applies to the running harness
  immediately, so back the file up before editing and verify the row list after.
