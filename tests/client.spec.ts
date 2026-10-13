import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const root = new URL('../', import.meta.url)
const client = readFileSync(new URL('client.js', root), 'utf8')
const pkg = JSON.parse(readFileSync(new URL('package.json', root), 'utf8')) as {
  exports: Record<string, string>
  files: string[]
  dsh: {
    bundle: { patch: string }
    client: { platform: string; immediately: boolean; inject: string[] }
  }
}

describe('client bundle contract', () => {
  it('parses as JavaScript', () => {
    expect(() => new Function(client)).not.toThrow()
  })

  it('registers through the module loader under the package name', () => {
    expect(client).toContain('window.__ModuleLoader__.load(')
    expect(client).toContain("id: 'dsh-autocompact'")
    expect(client).toContain('factory: function (require)')
    expect(client).toContain("require('react')")
  })

  it('requests only shell platform modules as externals', () => {
    // The shell freezes a module table at boot and resolves every bundle's
    // require against exactly that set: react, react/jsx-runtime, react-dom,
    // react-dom/client, @deepseek-ai/cordis, dsh-client-store,
    // dsh-client-ui-slots, dsh-client-ui-primitives, dsh-client-ui-dockkit
    // (packages/client/web/src/platform.ts -> seed.ts). This bundle needs
    // `react` for elements and hooks and `react-dom` for the portal that keeps
    // the tuner out of the composer's layout; any other name would mean a
    // build step is required (CORRECTED 2026-10-12: this test previously
    // asserted ['react'] alone, on the wrong premise that the table shares
    // nothing else).
    const requested = [...client.matchAll(/require\((['"])([^'"]+)\1\)/g)].map(match => match[2])
    expect(requested).toEqual(['react', 'react-dom'])
  })

  it('renders into the composer dock through the slots service', () => {
    expect(client).toContain("inject: ['slots']")
    expect(client).toContain("ctx.slots.inject('conversation.composer.dock'")
    expect(client).toContain("name: 'conversation.composer.dock'")
  })

  it('animates the in-progress indicator and respects reduced motion', () => {
    expect(client).toContain('@keyframes dshac-bounce')
    expect(client).toContain('prefers-reduced-motion')
    expect(client).toContain("role: 'status'")
  })

  it('polls both host routes without caching', () => {
    expect(client).toContain("'/dsh-autocompact/status'")
    expect(client).toContain("'/dsh-autocompact/config'")
    expect(client).toContain("cache: 'no-store'")
  })

  it('fails safe on every fetch path', () => {
    // A throwing component would blank the slot entry, so each promise chain
    // needs a catch.
    expect(client.match(/\.catch\(/g)?.length ?? 0).toBeGreaterThanOrEqual(2)
  })

  it('keeps the tuner reachable while idle', () => {
    // Regression (2026-10-12, live profile): the dock row used to `return null`
    // whenever no compaction was running and no recent one had finished. That
    // also removed the pill, which is the only way to open the panel, so the
    // tuner was unreachable exactly when the user wanted to configure it.
    expect(client).not.toContain('!showRecent && !open) return null')
    expect(client).toContain("className: idle ? 'dshac-row dshac-quiet' : 'dshac-row'")
    expect(client).toContain('.dshac-quiet .dshac-pill{opacity:.4}')
  })

  // The tuner is a floating surface, and these assertions are source-shape only:
  // this repo's vitest runs with `environment: 'node'` and links no react/jsdom,
  // so placement and dismissal cannot be rendered here. The structural contract
  // below is what a regression would break (verified in the browser instead).
  it('floats the tuner out of the dock row instead of pushing the composer', () => {
    // Regression (2026-10-12, live report): the panel was pushed as a sibling of
    // the pill INSIDE the dock row, so opening it stretched the composer bar and
    // shoved the message box and the transcript up the page.
    expect(client).toContain('createPortal')
    expect(client).toContain('createPortal(panel, document.body)')
    expect(client).not.toContain('children.push(h(Panel')
    expect(client).toContain("'.dshac-panel{position:fixed;z-index:1100;box-sizing:border-box;'")
  })

  it('paints the floating panel an opaque surface instead of the translucent menu fill', () => {
    // Regression (2026-10-12, live report "not very clear"): the panel used
    // ONLY --dsw-specific-menu, which is the shared MENU material and is
    // deliberately translucent (45-58% alpha; the 94% variant is macOS-only),
    // and unlike the shipped dialogs this panel carries no MenuSurface opaque
    // backing. Transcript and composer text therefore showed through it.
    // The contract: an opaque theme layer sits as the layer under the family
    // fill, and the menu blur token is applied on the panel itself.
    expect(client).toContain(
      "'background:var(--dsw-specific-menu,#1b1d22) var(--dsw-alias-bg-layer-1,#1b1d22);'",
    )
    expect(client).toContain("'backdrop-filter:var(--dsw-menu-backdrop-filter,none);'")
    expect(client).not.toMatch(/.dshac-panel\{[^']*background:var\(--dsw-specific-menu,[^)]*\);/)
  })

  it('caps the floating panel and scrolls it internally', () => {
    // An uncapped tuner clamps to the viewport margin and covers the transcript;
    // the cap keeps it a popover rather than a takeover.
    expect(client).toContain('max-height:min(70vh,520px);overflow:auto;overscroll-behavior:contain;')
  })

  it('places the panel above the pill and keeps it inside the viewport', () => {
    expect(client).toContain('var PANEL_GAP = 8')
    expect(client).toContain('var PANEL_MARGIN = 12')
    expect(client).toContain('var top = rect.top - PANEL_GAP - height')
    expect(client).toContain('window.innerWidth - width - PANEL_MARGIN')
  })

  it('re-tracks placement when the row, anchor, or panel changes size', () => {
    // The progress strip appearing beside the pill MOVES the pill without a
    // window resize or a scroll, so the row needs its own observer.
    expect(client).toContain('ResizeObserver')
    expect(client).toContain('watch(rowRef.current)')
    expect(client).toContain("window.addEventListener('scroll', place, true)")
  })

  it('closes on re-click, outside pointerdown, outside click, and Escape', () => {
    expect(client).toContain('setOpen(!open)')
    expect(client).toContain("document.addEventListener('pointerdown', closeOutside)")
    expect(client).toContain("document.addEventListener('click', closeOutside, true)")
    expect(client).toContain("if (event.key !== 'Escape') return")
    expect(client).toContain("'aria-haspopup': 'dialog'")
    expect(client).toContain("role: 'dialog'")
  })

  it('keeps the progress indicator in the dock row, not inside the panel', () => {
    // The indicator must stay visible while the tuner is closed, so it stays a
    // row child while only the tuner is portaled.
    expect(client).toContain('children.push(h(Indicator')
    expect(client).toContain("'aria-live': 'polite'")
  })
})

// User request 2026-10-13: the floating tuner must not assume the user already
// knows what compaction, a window fraction, or a retain budget means. These are
// source-shape assertions (this repo runs vitest on node with no DOM); the
// rendered result is verified in the browser.
describe('tuner explanations', () => {
  /** Extract the `key: 'value',` pairs of one locale block. */
  function localeEntries(locale: 'en' | 'zh'): Array<[string, string]> {
    const start = client.indexOf(locale + ': {')
    expect(start).toBeGreaterThan(-1)
    const rest = client.slice(start)
    const end = rest.indexOf('\n    },')
    const body = rest.slice(0, end === -1 ? rest.length : end)
    return [...body.matchAll(/^ {6}([A-Za-z]+): '((?:[^'\\]|\\.)*)',/gm)]
      .map(match => [match[1], match[2]] as [string, string])
  }

  it('states what compaction is and when an edit takes effect', () => {
    expect(client).toContain('className: \'dshac-intro\'')
    expect(client).toContain('className: \'dshac-foot\'')
    const intro = localeEntries('en').find(entry => entry[0] === 'intro')?.[1] ?? ''
    expect(intro.length).toBeGreaterThan(80)
    expect(intro).toMatch(/no restart/)
  })

  it('gives every tuner control its own help line, wired for screen readers', () => {
    // The field helper attaches the description; each call site must pass text.
    expect(client).toContain("'aria-describedby': helpId")
    expect(client).toContain("'aria-describedby': 'dshac-enabled-help'")
    for (const call of [
      "field('ratio', t.triggerRatio, 'number', t.helpRatio)",
      "field('tokens', t.triggerTokens, 'number', t.helpTokens)",
      "field('retainTokens', t.retainTokens, 'number', t.helpRetain)",
      "field('archiveRoot', t.archiveRoot, 'text', t.helpArchiveRoot)",
      "field('provider', t.provider, 'text', t.helpProvider)",
      "field('model', t.model, 'text', t.helpModel)",
    ]) expect(client).toContain(call)
    expect(client).toContain("h('p', { className: 'dshac-help' }, t.helpStatus)")
    expect(client).toContain("h('p', { className: 'dshac-help', id: 'dshac-enabled-help' }, t.helpEnabled)")
  })

  it('keeps both locales in step and every help string substantive', () => {
    const en = localeEntries('en')
    const zh = localeEntries('zh')
    expect(en.length).toBeGreaterThan(25)
    expect(en.map(entry => entry[0]).sort()).toEqual(zh.map(entry => entry[0]).sort())
    for (const locale of [en, zh]) {
      for (const [key, value] of locale) {
        if (!key.startsWith('help')) continue
        expect(value.length, key).toBeGreaterThan(20)
      }
    }
  })

  it('turns an unreachable host route into a legible state', () => {
    // Before: a 404 made `useStatus` return null, so the row rendered nothing,
    // the panel had no reason for being read-only, and the user saw a bare
    // "Read-only: ". Now the poll reports the failure, the pill says unknown,
    // and the panel explains the restart semantics of a host-code change.
    expect(client).toContain("__unreachable: true")
    expect(client).toContain("h('span', { className: 'dshac-dot', 'data-state': 'unknown' })")
    expect(client).toContain('.dshac-dot[data-state="unknown"]{background:#d29922}')
    expect(client).toContain("h('strong', null, t.routeDown + why)")
    expect(client).toContain('capabilities.reason || t.helpNoEditor')
    for (const [key, value] of localeEntries('en')) {
      if (key === 'helpRouteDown') expect(value).toMatch(/next harness start/)
    }
  })
})

describe('package wiring', () => {
  it('points the client export at the hand-written bundle', () => {
    expect(pkg.exports['./client']).toBe('./client.js')
    expect(pkg.files).toContain('client.js')
  })

  it('injects client bundle package names, not service keys', () => {
    // `uiConversation` is not a client service: service keys here would block
    // the client half from ever activating (see docs/incidents).
    expect(pkg.dsh.client.inject).toEqual(['@deepseek-ai/dsh-client-ui-conversation'])
    for (const entry of pkg.dsh.client.inject) expect(entry.startsWith('@deepseek-ai/')).toBe(true)
  })

  it('ships the bundle patch the loader composes', () => {
    expect(pkg.dsh.bundle.patch).toBe('./cordis.patch.yml')
  })

  it('exports ./package.json the way shipped client packages do', () => {
    // locatePkgJson (packages/client/modules/src/index.ts) can fall back to
    // createRequire(baseUrl).resolve('<name>/package.json'), and an exports map
    // without that subpath throws ERR_PACKAGE_PATH_NOT_EXPORTED there — a
    // negative client verdict that is cached until restart.
    expect(pkg.exports['./package.json']).toBe('./package.json')
  })
})

describe('cordis patch', () => {
  const patch = readFileSync(new URL('cordis.patch.yml', root), 'utf8')

  it('disables the base engine and inserts this plugin once', () => {
    expect(patch).toMatch(/override:/)
    expect(patch).toMatch(/id: compaction-basic/)
    expect(patch).toMatch(/disabled: true/)
    expect(patch.match(/id: dsh-autocompact/g)?.length).toBe(1)
  })
})
