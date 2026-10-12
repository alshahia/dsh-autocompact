/**
 * dsh-autocompact — Web-UI client half.
 *
 * Hand-written bundle: the harness serves this file as the package's `./client`
 * export and the web shell registers it through `window.__ModuleLoader__.load`.
 * There is no build step, so `require` only resolves the shell's externals
 * (`react`); everything else is plain browser API.
 *
 * It registers ONE visual object — a composer-dock strip that:
 *  - shows an animated "compacting…" indicator (phase + elapsed time) while a
 *    compaction runs, because this harness version emits no client-visible
 *    compaction event, and
 *  - opens an inline tuning panel that reads and writes the plugin's own HTTP
 *    routes (`GET /dsh-autocompact/status`, `POST /dsh-autocompact/config`).
 *
 * Every path is fail-safe: a missing route, a failed fetch, or a malformed
 * payload renders nothing extra instead of blanking the slot.
 */

(function () {
  'use strict'
  if (typeof window === 'undefined') return
  var loader = window.__ModuleLoader__
  if (!loader || typeof loader.load !== 'function') return

  var STATUS_PATH = '/dsh-autocompact/status'
  var CONFIG_PATH = '/dsh-autocompact/config'
  var BUSY_POLL_MS = 900
  var IDLE_POLL_MS = 3000
  var RECENT_MS = 9000
  var STYLE_ID = 'dsh-autocompact-style'

  var STRINGS = {
    en: {
      compacting: 'Compacting conversation',
      recent: 'Compacted',
      failed: 'Compaction failed',
      open: 'Auto-compact',
      title: 'Auto-compact',
      enabled: 'Enabled',
      triggerRatio: 'Trigger at window fraction (0.1–0.95, blank = unset)',
      triggerTokens: 'Trigger at absolute tokens (0 = unset)',
      retainTokens: 'Keep this many tokens verbatim',
      archiveRoot: 'Archive root (inside the project)',
      provider: 'Summary provider',
      model: 'Summary model',
      save: 'Save',
      close: 'Close',
      saving: 'Saving…',
      saved: 'Saved — applies on the next step',
      readOnly: 'Read-only: ',
      paste: 'Paste this into the dsh-autocompact entry of your profile patch:',
      measured: 'context',
      threshold: 'threshold',
      unset: 'unset',
      empty: 'no session data yet',
    },
    zh: {
      compacting: '正在压缩对话',
      recent: '已压缩',
      failed: '压缩失败',
      open: '自动压缩',
      title: '自动压缩',
      enabled: '启用',
      triggerRatio: '按窗口比例触发（0.1–0.95，留空表示未设置）',
      triggerTokens: '按绝对 token 触发（0 表示未设置）',
      retainTokens: '保留的原文 token 数',
      archiveRoot: '归档根目录（项目内）',
      provider: '摘要 provider',
      model: '摘要 model',
      save: '保存',
      close: '关闭',
      saving: '正在保存…',
      saved: '已保存 — 下一步生效',
      readOnly: '只读：',
      paste: '请将以下内容粘贴到配置 patch 的 dsh-autocompact 条目：',
      measured: '上下文',
      threshold: '阈值',
      unset: '未设置',
      empty: '暂无会话数据',
    },
  }

  function strings() {
    try {
      var language = (navigator && navigator.language) || 'en'
      return language.toLowerCase().indexOf('zh') === 0 ? STRINGS.zh : STRINGS.en
    } catch (error) {
      return STRINGS.en
    }
  }

  var CSS = [
    '.dshac-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap;',
    'font:inherit;font-size:12px;line-height:1.4;color:inherit;padding:2px 0;min-width:0}',
    '.dshac-pill{display:inline-flex;align-items:center;gap:6px;border:1px solid currentColor;',
    'border-radius:999px;background:transparent;color:inherit;font:inherit;font-size:11px;',
    'padding:2px 9px;cursor:pointer;opacity:.72}',
    '.dshac-pill:hover{opacity:1}',
    '.dshac-pill[aria-expanded="true"]{opacity:1}',
    '.dshac-quiet .dshac-pill{opacity:.4}',
    '.dshac-quiet:hover .dshac-pill{opacity:1}',
    '.dshac-dot{width:7px;height:7px;border-radius:50%;background:#3fb950;flex:none}',
    '.dshac-dot[data-on="false"]{background:#8b949e}',
    '.dshac-indicator{display:inline-flex;align-items:center;gap:8px;min-width:0}',
    '.dshac-label{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '.dshac-phase{opacity:.7;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:22ch}',
    '.dshac-dots{display:inline-flex;gap:3px;flex:none}',
    '.dshac-dots i{width:4px;height:4px;border-radius:50%;background:currentColor;',
    'animation:dshac-bounce 1.05s infinite ease-in-out}',
    '.dshac-dots i:nth-child(2){animation-delay:.15s}',
    '.dshac-dots i:nth-child(3){animation-delay:.3s}',
    '.dshac-bar{position:relative;overflow:hidden;height:2px;border-radius:2px;flex:1 1 90px;',
    'min-width:60px;background:color-mix(in srgb,currentColor 18%,transparent)}',
    '.dshac-bar span{position:absolute;top:0;bottom:0;width:40%;border-radius:2px;background:currentColor;',
    'animation:dshac-slide 1.4s infinite ease-in-out}',
    '.dshac-ok{color:#3fb950}',
    '.dshac-bad{color:#f85149}',
    '.dshac-panel{border:1px solid color-mix(in srgb,currentColor 25%,transparent);border-radius:10px;',
    'padding:10px 12px;display:grid;gap:8px;width:min(430px,100%);background:transparent}',
    '.dshac-panel h4{margin:0;font-size:12px;font-weight:600}',
    '.dshac-field{display:grid;gap:2px}',
    '.dshac-field label{font-size:11px;opacity:.75}',
    '.dshac-field input[type="text"],.dshac-field input[type="number"]{border:1px solid currentColor;',
    'border-radius:6px;background:transparent;color:inherit;font:inherit;font-size:12px;padding:3px 6px;width:100%}',
    '.dshac-check{display:flex;align-items:center;gap:6px}',
    '.dshac-actions{display:flex;align-items:center;gap:8px}',
    '.dshac-actions button{border:1px solid currentColor;border-radius:6px;background:transparent;color:inherit;',
    'font:inherit;font-size:11px;padding:3px 10px;cursor:pointer}',
    '.dshac-note{font-size:11px;opacity:.75}',
    '.dshac-note pre{margin:4px 0 0;white-space:pre-wrap;font-size:10.5px;opacity:.9}',
    '@keyframes dshac-bounce{0%,80%,100%{opacity:.25;transform:translateY(0)}40%{opacity:1;transform:translateY(-2px)}}',
    '@keyframes dshac-slide{0%{left:-40%}100%{left:100%}}',
    '@media (prefers-reduced-motion: reduce){.dshac-dots i,.dshac-bar span{animation:none}',
    '.dshac-dots i{opacity:.85}}',
  ].join('')

  function ensureStyle() {
    try {
      if (document.getElementById(STYLE_ID)) return
      var style = document.createElement('style')
      style.id = STYLE_ID
      style.textContent = CSS
      ;(document.head || document.documentElement).appendChild(style)
    } catch (error) {
      // Unstyled is better than broken.
    }
  }

  function formatElapsed(ms) {
    var seconds = Math.max(0, Math.round(ms / 1000))
    if (seconds < 60) return seconds + 's'
    var minutes = Math.floor(seconds / 60)
    return minutes + 'm ' + (seconds % 60) + 's'
  }

  // The literal loader call is the client-module contract the shell's
  // diagnostics look for; `loader` above only guards the early return.
  window.__ModuleLoader__.load({
    id: 'dsh-autocompact',
    factory: function (require) {
      var React = require('react')
      var h = React.createElement

      /** Poll the host status route; the interval relaxes while nothing runs. */
      function useStatus(sessionId) {
        var state = React.useState(null)
        var data = state[0]
        var setData = state[1]
        var delay = React.useRef(BUSY_POLL_MS)
        React.useEffect(function () {
          var alive = true
          var timer = null
          var load = function () {
            var url = STATUS_PATH
            if (typeof sessionId === 'string' && sessionId.length > 0) {
              url += '?session=' + encodeURIComponent(sessionId)
            }
            var request = null
            try {
              request = fetch(url, { cache: 'no-store', headers: { accept: 'application/json' } })
            } catch (error) {
              request = null
            }
            if (!request) {
              timer = setTimeout(load, IDLE_POLL_MS)
              return
            }
            request
              .then(function (response) { return response && response.ok ? response.json() : null })
              .then(function (payload) {
                if (alive && payload && typeof payload === 'object') {
                  setData(payload)
                  delay.current = payload.running ? BUSY_POLL_MS : IDLE_POLL_MS
                }
              })
              .catch(function () { /* offline or route absent: stay silent */ })
              .then(function () {
                if (alive) timer = setTimeout(load, delay.current || IDLE_POLL_MS)
              })
          }
          load()
          return function () {
            alive = false
            if (timer) clearTimeout(timer)
          }
        }, [sessionId])
        return data
      }

      /** A clock that ticks only while something is animating. */
      function useTicker(active) {
        var state = React.useState(Date.now())
        var now = state[0]
        var setNow = state[1]
        React.useEffect(function () {
          if (!active) return undefined
          var id = setInterval(function () { setNow(Date.now()) }, 500)
          return function () { clearInterval(id) }
        }, [active])
        return now
      }

      function Indicator(props) {
        var t = props.strings
        var running = props.running
        var now = props.now
        return h('span', { className: 'dshac-indicator', role: 'status', 'aria-live': 'polite' },
          h('span', { className: 'dshac-dots', 'aria-hidden': 'true' },
            h('i', null), h('i', null), h('i', null)),
          h('span', { className: 'dshac-label' }, t.compacting),
          running.phase
            ? h('span', { className: 'dshac-phase' }, running.phase + (running.detail ? ' · ' + running.detail : ''))
            : null,
          h('span', { className: 'dshac-phase' }, formatElapsed(now - (running.startedAt || now))),
          h('span', { className: 'dshac-bar', 'aria-hidden': 'true' }, h('span', null)),
        )
      }

      function statusLine(props) {
        var t = props.strings
        var data = props.data
        if (data.session && typeof data.session.measuredTokens === 'number') {
          var session = data.session
          var threshold = typeof session.thresholdTokens === 'number'
            ? session.thresholdTokens.toLocaleString()
            : t.unset
          return t.measured + ' ' + session.measuredTokens.toLocaleString() + ' / ' + t.threshold + ' ' + threshold
        }
        return t.empty
      }

      function initialForm(data) {
        var effective = data && data.config && data.config.effective ? data.config.effective : {}
        var trigger = effective.trigger || {}
        var retain = effective.retain || {}
        var archive = effective.archive || {}
        var summarization = effective.summarization || {}
        return {
          enabled: effective.enabled !== false,
          ratio: trigger.ratio === undefined || trigger.ratio === null ? '' : String(trigger.ratio),
          tokens: trigger.tokens === undefined || trigger.tokens === null ? '' : String(trigger.tokens),
          retainTokens: retain.tokens === undefined || retain.tokens === null ? '' : String(retain.tokens),
          archiveRoot: archive.root || '',
          provider: summarization.provider || '',
          model: summarization.model || '',
        }
      }

      function numberOrNull(value) {
        if (typeof value !== 'string' || value.trim().length === 0) return null
        var parsed = Number(value)
        return Number.isFinite(parsed) ? parsed : null
      }

      function buildPatch(form) {
        var patch = { enabled: form.enabled === true }
        var trigger = { tokens: numberOrNull(form.tokens) === null ? 0 : numberOrNull(form.tokens) }
        if (numberOrNull(form.ratio) !== null) trigger.ratio = numberOrNull(form.ratio)
        patch.trigger = trigger
        if (numberOrNull(form.retainTokens) !== null) patch.retain = { tokens: numberOrNull(form.retainTokens) }
        if (typeof form.archiveRoot === 'string' && form.archiveRoot.trim().length > 0) {
          patch.archive = { root: form.archiveRoot.trim() }
        }
        var summarization = {}
        if (typeof form.provider === 'string' && form.provider.trim().length > 0) {
          summarization.provider = form.provider.trim()
        }
        if (typeof form.model === 'string' && form.model.trim().length > 0) {
          summarization.model = form.model.trim()
        }
        if (Object.keys(summarization).length > 0) patch.summarization = summarization
        return patch
      }

      function Panel(props) {
        var t = props.strings
        var data = props.data || {}
        var formState = React.useState(function () { return initialForm(data) })
        var form = formState[0]
        var setForm = formState[1]
        var messageState = React.useState(null)
        var message = messageState[0]
        var setMessage = messageState[1]
        var capabilities = data.capabilities || {}
        var writable = capabilities.write === true

        var set = function (key) {
          return function (event) {
            var value = event && event.target
              ? (event.target.type === 'checkbox' ? event.target.checked : event.target.value)
              : ''
            setForm(function (previous) {
              var next = {}
              for (var existing in previous) if (Object.prototype.hasOwnProperty.call(previous, existing)) next[existing] = previous[existing]
              next[key] = value
              return next
            })
          }
        }

        var save = function () {
          setMessage({ kind: 'busy', text: t.saving })
          var request = null
          try {
            request = fetch(CONFIG_PATH, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(buildPatch(form)),
            })
          } catch (error) {
            request = null
          }
          if (!request) {
            setMessage({ kind: 'bad', text: t.failed })
            return
          }
          request
            .then(function (response) {
              return response.json().then(
                function (payload) { return { status: response.status, payload: payload } },
                function () { return { status: response.status, payload: {} } },
              )
            })
            .then(function (result) {
              if (result.payload && result.payload.ok === true) setMessage({ kind: 'ok', text: t.saved })
              else setMessage({ kind: 'bad', text: (result.payload && result.payload.reason) || ('HTTP ' + result.status) })
            })
            .catch(function (error) {
              setMessage({ kind: 'bad', text: String((error && error.message) || error) })
            })
        }

        var field = function (key, label, type) {
          return h('div', { className: 'dshac-field' },
            h('label', { htmlFor: 'dshac-' + key }, label),
            h('input', { id: 'dshac-' + key, type: type || 'text', value: form[key], onChange: set(key) }),
          )
        }

        return h('div', { className: 'dshac-panel' },
          h('h4', null, t.title),
          h('div', { className: 'dshac-note' }, statusLine({ strings: t, data: data })),
          h('div', { className: 'dshac-check' },
            h('input', { id: 'dshac-enabled', type: 'checkbox', checked: form.enabled === true, onChange: set('enabled') }),
            h('label', { htmlFor: 'dshac-enabled' }, t.enabled),
          ),
          field('ratio', t.triggerRatio, 'number'),
          field('tokens', t.triggerTokens, 'number'),
          field('retainTokens', t.retainTokens, 'number'),
          field('archiveRoot', t.archiveRoot, 'text'),
          field('provider', t.provider, 'text'),
          field('model', t.model, 'text'),
          h('div', { className: 'dshac-actions' },
            h('button', { type: 'button', onClick: save, disabled: !writable }, t.save),
            h('button', { type: 'button', onClick: props.onClose }, t.close),
            message
              ? h('span', { className: message.kind === 'bad' ? 'dshac-bad' : (message.kind === 'ok' ? 'dshac-ok' : 'dshac-note') },
                message.text)
              : null,
          ),
          writable ? null : h('div', { className: 'dshac-note' },
            t.readOnly + (capabilities.reason || ''),
            capabilities.snippet ? h('pre', null, capabilities.snippet) : null,
          ),
        )
      }

      function Dock(props) {
        ensureStyle()
        var t = strings()
        var sessionId = props && typeof props.sessionId === 'string' ? props.sessionId : undefined
        var data = useStatus(sessionId)
        var openState = React.useState(false)
        var open = openState[0]
        var setOpen = openState[1]
        var running = data && data.running && typeof data.running === 'object' ? data.running : null
        var now = useTicker(running !== null)
        var recent = data && Array.isArray(data.recent) && data.recent.length > 0 ? data.recent[0] : null
        var showRecent = running === null && recent !== null && Date.now() - recent.finishedAt < RECENT_MS
        var enabled = !data || data.enabled !== false

        var pill = h('button', {
          type: 'button',
          className: 'dshac-pill',
          onClick: function () { setOpen(!open) },
          'aria-expanded': open ? 'true' : 'false',
          title: t.title,
        },
          h('span', { className: 'dshac-dot', 'data-on': enabled ? 'true' : 'false' }),
          h('span', null, t.open),
        )

        var children = []
        if (running !== null) children.push(h(Indicator, { key: 'indicator', strings: t, running: running, now: now }))
        else if (showRecent) {
          children.push(h('span', {
            key: 'recent',
            className: recent.ok === false ? 'dshac-bad' : 'dshac-ok',
            role: 'status',
            'aria-live': 'polite',
          }, (recent.ok === false ? t.failed : t.recent) + (recent.detail ? ' · ' + recent.detail : '')))
        }
        children.push(pill)
        if (open) children.push(h(Panel, { key: 'panel', strings: t, data: data, onClose: function () { setOpen(false) } }))
        // The pill is the only way into the tuner, so the row must render even
        // while nothing is compressing. When idle it recedes (dshac-quiet)
        // instead of disappearing: returning null here left the panel
        // unreachable whenever no compaction was running or recently finished.
        var idle = running === null && !showRecent && !open
        return h('div', { className: idle ? 'dshac-row dshac-quiet' : 'dshac-row' }, children)
      }

      return {
        inject: ['slots'],
        apply: function (ctx) {
          try {
            ctx.slots.inject('conversation.composer.dock', function () {
              return ctx.slots.register({
                name: 'conversation.composer.dock',
                id: 'dsh-autocompact',
                order: 60,
              }, Dock)
            })
          } catch (error) {
            if (typeof console !== 'undefined' && console.warn) {
              console.warn('dsh-autocompact: could not register the composer indicator', error)
            }
          }
        },
      }
    },
  })
})()
