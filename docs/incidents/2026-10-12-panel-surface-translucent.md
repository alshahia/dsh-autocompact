# The floating tuner showed the transcript through it — give the panel an opaque surface

**Date:** 2026-10-12 · **Version:** 0.3.2 · **Status:** fixed (client half;
visual check is a browser checkpoint)

## Symptom (user report, live `web` profile)

Opening the **Auto-compact** tuner showed a panel that was "not very clear":
transcript text, the composer and the page background showed straight through
the surface, so the labels, field borders and headings read muddy and were hard
to scan. The damage was worst over long agent output, which is exactly what sits
under the pill.

## Root cause

`client.js` skinned the panel from exactly one fill token:

```css
.dshac-panel{ … background:var(--dsw-specific-menu,#1b1d22); … }
```

`--dsw-specific-menu` is the harness's **shared menu material**, not an opaque
surface. In the target checkout
(`packages/client/ui-theme/src/styles/design-platform.css`):

| Selector | Value |
|---|---|
| `body` (light theme) | `--dsw-menu-surface-fill: rgba(248, 249, 250, 0.58)`; `--dsw-specific-menu: var(--dsw-menu-surface-fill)` |
| `body[data-ds-dark-theme]` | `--dsw-menu-surface-fill: rgba(67, 69, 74, 0.45)` |
| `html[data-platform='darwin'] body` | `--dsw-specific-menu: rgba(248, 249, 250, 0.94)` |
| `html[data-platform='darwin'] body[data-ds-dark-theme]` | `--dsw-specific-menu: rgba(48, 49, 54, 0.94)` |

So on the user's Windows browser the panel resolved to **45% (dark) / 58%
(light) alpha** — the 94% variant is macOS-only. The shipped dialogs can afford
that translucent material because they are blurred: `stat-dialog.module.css`
and `ContextMeter.module.css` pair `background: var(--dsw-specific-menu)` with
`backdrop-filter: var(--dsw-menu-backdrop-filter)` while their `MenuSurface`
wrapper owns the blur, and `docs/web-styling.md` states the rule the panel broke:
*"Overlays without this backing use `--dsw-specific-menu`, whose theme-owned
macOS fill is 94% opaque to keep underlying text from bleeding through."* This
panel has no `MenuSurface` wrapper **and** had no `backdrop-filter`, so it was
translucent with nothing to hide what was underneath — the worst of both.

## Fix (client half, this change)

`client.js`, in the `.dshac-panel` rule: keep the theme family's fill, but stop
relying on it for opacity.

```css
background: var(--dsw-specific-menu, #1b1d22) var(--dsw-alias-bg-layer-1, #1b1d22);
backdrop-filter: var(--dsw-menu-backdrop-filter, none);
```

- **Two-layer background.** The last (bottom) layer is the opaque theme-raised
  token `--dsw-alias-bg-layer-1` (light: `rgb(255,255,255)`; dark:
  `rgb(35,35,36)`) and the translucent family fill paints on top of it as a tint.
  Result: deterministic full opacity, the theme's own color, and the light/dark
  switch for free — no literal color and no drift from the design system.
- **`backdrop-filter` added** with the same theme token the shipped panels use
  (`--dsw-menu-backdrop-filter: blur(40px) saturate(150%)`,
  `gradient-shadow-text.css`). With the background now opaque it is a polish
  layer (it softens the edge under the panel), not a correctness dependency, and
  `none` keeps it a no-op on a shell where the token is absent.
- The fallback stays `#1b1d22` for both layers, so a page with no theme tokens
  renders exactly the pre-change dark surface.

## Evidence

| Check | Result |
|---|---|
| `node --check client.js` | exit 0 |
| `node node_modules/vitest/vitest.mjs run` | **10 files / 121 tests** passed, exit 0 (14:55:26 local) |
| `node node_modules/typescript/bin/tsc -p tsconfig.json --noEmit` | exit 0 (14:55 local) |
| New regression assertion | `tests/client.spec.ts` → *"paints the floating panel an opaque surface instead of the translucent menu fill"* (2 `toContain` + 1 `not.toMatch` that rejects the old single-token declaration) |
| Theme values read from source | `design-platform.css:271-273, 389-391, 402-407`; `gradient-shadow-text.css:20`; `docs/web-styling.md:28`; `stat-dialog.module.css:23-24`; `ContextMeter.module.css:54-55` |
| Token chain resolved from the theme sources (temp script, exit 0) | light: base `--dsw-alias-bg-layer-1 → --dsw-static-neutral-bluish-00 = rgb(255,255,255)` (alpha 1) under `--dsw-specific-menu → --dsw-menu-surface-fill = rgba(248,249,250,0.58)`; dark: base `rgb(35,35,36)` (alpha 1) under `rgba(67,69,74,0.45)`; `--dsw-menu-backdrop-filter = blur(40px) saturate(150%)` in both. **Old declaration: 42% (light) / 55% (dark) of the backdrop showed through; now the bottom layer is opaque in both** |
| Visual result in the browser | **not machine-verified here** — vitest runs `environment: 'node'` with no react/jsdom and no layout, so nothing renders or computes style; the acceptance check is the user's own look after a page refresh |

## Caveats

- A `client.js` edit applies on the **next page load** — a loaded page cannot
  swap a module face in place (recorded in
  [live-profile-install](2026-10-12-live-profile-install.md)). No harness restart
  is involved.
- The panel is now fully opaque, so it no longer shows the "frosted glass" hint
  the shipped menus have. That is the deliberate trade for the readability the
  user asked for; if a slight translucency is ever wanted back, lower the alpha
  of a dedicated panel token rather than reverting to the bare menu fill.
- The fields inside still use a transparent background with
  `--dsw-alias-border-l1` hairlines. That is unchanged and reads better on the
  opaque surface, but only the user's eye can confirm it.

## Reusable rule

Two rules, both general to third-party client bundles on this target:

1. **`--dsw-specific-menu` is a menu *material*, not a panel background** — 45%
   dark / 58% light alpha, with a macOS-only 94% override. Using it alone outside
   a `MenuSurface` gives translucent, unreadable text on Windows. If you do not
   wrap in `MenuSurface`, paint an opaque theme layer
   (`--dsw-alias-bg-layer-*`) below the fill.
2. Read alpha-bearing tokens in the **theme source** before shipping a surface:
   a token whose name says "menu" can carry a transparency that only one
   platform overrides.
