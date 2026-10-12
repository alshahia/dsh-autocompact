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

  it('requests no other package as an external', () => {
    // The shell's module table only guarantees `react`; a `require` of another
    // package name is the fail-fast signal that a build step would be needed.
    const requested = [...client.matchAll(/require\((['"])([^'"]+)\1\)/g)].map(match => match[2])
    expect(requested).toEqual(['react'])
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
