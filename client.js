/**
 * dsh-autocompact — Web-UI client half.
 *
 * Hand-written bundle: the harness serves this file as the package's `./client`
 * export and the web shell registers it through `window.__ModuleLoader__.load`.
 * There is no build step, so `require` only resolves the shell's platform
 * externals (`react`, `react-dom`, both in the frozen module table); everything
 * else is plain browser API.
 *
 * It registers ONE visual object — a composer-dock strip that:
 *  - shows an animated "compacting…" indicator (phase + elapsed time) while a
 *    compaction runs, because this harness version emits no client-visible
 *    compaction event, and
 *  - opens a floating tuning panel — portaled to `document.body` and fixed above
 *    the pill, so opening it never reflows the composer — that reads and writes
 *    the plugin's own HTTP routes (`GET /dsh-autocompact/status`,
 *    `POST /dsh-autocompact/config`).
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
      intro: 'When a session grows past its limit, the harness replaces older turns with a model-written summary — that is compaction. This plugin decides WHEN that happens and keeps a copy of everything it condensed. Edits apply to the next step; no restart.',
      enabled: 'Enabled',
      triggerRatio: 'Trigger at window fraction',
      triggerTokens: 'Trigger at absolute tokens',
      retainTokens: 'Keep this many tokens verbatim',
      archiveRoot: 'Archive root (inside the project)',
      provider: 'Summary provider',
      model: 'Summary model',
      helpEnabled: 'Off = no automatic compaction and no archives. A manual /compact and overflow recovery still work.',
      helpRatio: 'Fire when the measured request reaches this fraction of the routed model\'s context window (0.1–0.95). Needs a model that publishes a window. Blank keeps the current value; 0 removes the ratio.',
      helpTokens: 'Fire at this many tokens, whatever the window is. 0 or blank removes the absolute limit. With both set, the earlier one fires first.',
      helpRetain: 'How much of the newest conversation stays verbatim above the summary. Larger = more recent detail kept; smaller = more room freed. Keep it below the trigger, or it is clamped.',
      helpArchiveRoot: 'Folder for the summary and the full condensed text (handoff.md, conversation.md), one per session, resolved inside the project directory — not the harness folder.',
      helpProvider: 'Provider that writes the summary. Fill provider AND model, or leave both blank to reuse the session\'s own model. A half-filled pair is dropped with a warning.',
      helpModel: 'Model that writes the summary. Fill provider AND model, or leave both blank to reuse the session\'s own model.',
      helpStatus: 'First number: size of the routed request as this plugin measures it. Second: the threshold it will fire at. Both are estimates from the session\'s token meter.',
      helpSave: 'Save writes the values into your profile patch through the harness config editor and validates them against the plugin schema. Changes to these settings are live; changes to plugin CODE need a harness restart.',
      helpEmpty: 'No session is attached to this page yet, so there is nothing to measure. The context and threshold numbers appear once a session is active.',
      helpNoEditor: 'This composition exposes no config editor for the plugin, so nothing can be saved from here. Add the values to the dsh-autocompact entry of the profile patch instead — the snippet below is paste-ready.',
      routeDown: 'Host status route not reachable',
      helpRouteDown: 'The browser could not read /dsh-autocompact/status, so there is no live state or context number here and saving is unavailable. The plugin runs inside the harness: if its source changed, this only takes effect at the next harness start. A persistent 404 usually means the route was never registered by this process — check that the dsh-autocompact row and its node_modules junction are present in the profile.',
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
      intro: '会话超出上限时，harness 会用模型生成的摘要替换较早的对话轮次——这就是压缩。本插件决定何时触发压缩，并保存被压缩内容的完整副本。修改在下一个步骤生效，无需重启。',
      enabled: '启用',
      triggerRatio: '按窗口比例触发',
      triggerTokens: '按绝对 token 触发',
      retainTokens: '保留的原文 token 数',
      archiveRoot: '归档根目录（项目内）',
      provider: '摘要 provider',
      model: '摘要 model',
      helpEnabled: '关闭 = 不再自动压缩，也不再归档；手动 /compact 与上下文溢出恢复仍然有效。',
      helpRatio: '当请求大小达到所用模型上下文窗口的这一比例时触发（0.1–0.95）。需要模型声明上下文窗口。留空保持当前值；0 表示取消比例触发。',
      helpTokens: '按绝对 token 数触发，与窗口无关。0 或留空表示取消绝对限制。两者都设置时，先到者触发。',
      helpRetain: '摘要之上保留多少最新对话原文。越大保留越多近期细节，越小释放越多空间。需低于触发阈值，否则会被自动收敛。',
      helpArchiveRoot: '摘要与完整压缩原文（handoff.md、conversation.md）的存放目录，每个会话一个文件夹，相对于项目目录解析，而不是 harness 目录。',
      helpProvider: '写摘要所用的 provider。provider 与 model 必须同时填写，或都留空以复用会话自身的模型；只填一个会被丢弃并给出警告。',
      helpModel: '写摘要所用的 model。provider 与 model 必须同时填写，或都留空以复用会话自身的模型。',
      helpStatus: '第一个数字：本插件测得的当前请求大小。第二个：触发阈值。两者都是基于会话 token 计量器的估算值。',
      helpSave: '保存会通过 harness 配置编辑器写入你的 profile patch，并按插件 schema 校验。这些设置是实时生效的；插件代码的改动需要重启 harness。',
      helpEmpty: '当前页面尚未关联会话，暂无可测量的内容。会话开始后会显示上下文与阈值数字。',
      helpNoEditor: '该组合没有为插件提供配置编辑器，无法在此保存。请把下面的内容粘贴到 profile patch 的 dsh-autocompact 条目中。',
      routeDown: '无法访问宿主状态路由',
      helpRouteDown: '浏览器无法读取 /dsh-autocompact/status，因此这里没有实时状态与上下文数字，也无法保存。插件运行在 harness 内部：源码改动只有在下次启动 harness 后才生效。若持续返回 404，通常表示本次进程从未注册该路由——请检查 profile 中是否存在 dsh-autocompact 行及其 node_modules 联接。',
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
    '.dshac-dot[data-state="unknown"]{background:#d29922}',
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
    '.dshac-anchor{display:inline-flex;min-width:0}',
    // The tuner is a FLOATING surface, never a row child: as an in-flow child
    // of this dock row it stretched the composer bar, which shoved the message
    // box and the transcript up the page (live report 2026-10-12). Fixed +
    // portaled to <body> keeps it out of the composer's layout, out of every
    // containing block and overflow clip, and above the app's own layers; the
    // harness tokens make it read as the same surface family as the context
    // ring's dialog (ui-chat stat-dialog.module.css).
    //
    // SURFACE FILL (live report 2026-10-12, "not very clear"): the family's
    // fill token, --dsw-specific-menu, is the shared MENU material and is
    // deliberately translucent (45-58% alpha; the 94% variant applies only to
    // macOS). Unlike the shipped dialogs, this panel has no MenuSurface opaque
    // backing, so transcript and composer text showed straight through it and
    // the labels read muddy. The panel now layers that translucent family fill
    // OVER an opaque raised-layer token, so it keeps the theme's color and
    // light/dark switch while staying opaque; the harness menu blur token is
    // applied too (a no-op wherever the theme leaves it unset).
    '.dshac-panel{position:fixed;z-index:1100;box-sizing:border-box;',
    'width:min(430px,calc(100vw - 24px));max-height:min(70vh,520px);overflow:auto;overscroll-behavior:contain;',
    'padding:14px 16px;display:grid;gap:10px;border:0;border-radius:var(--dsw-radius-lg,10px);',
    'background:var(--dsw-specific-menu,#1b1d22) var(--dsw-alias-bg-layer-1,#1b1d22);',
    'backdrop-filter:var(--dsw-menu-backdrop-filter,none);',
    '--dsw-elevation-stroke-color:var(--dsw-alias-border-l1);',
    'box-shadow:var(--dsw-elevation-prominent,0 12px 32px rgba(0,0,0,.45));',
    'color:var(--dsw-alias-label-secondary,inherit);font-size:12px;line-height:18px}',
    '.dshac-panel h4{margin:0;font-size:12px;font-weight:600;color:var(--dsw-alias-label-primary,inherit)}',
    '.dshac-field{display:grid;gap:2px}',
    '.dshac-field label{font-size:11px;opacity:.75}',
    '.dshac-field input[type="text"],.dshac-field input[type="number"]{border:1px solid var(--dsw-alias-border-l1,currentColor);',
    'border-radius:6px;background:transparent;color:inherit;font:inherit;font-size:12px;padding:3px 6px;width:100%}',
    '.dshac-check{display:flex;align-items:center;gap:6px}',
    '.dshac-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
    '.dshac-actions button{border:1px solid var(--dsw-alias-border-l1,currentColor);border-radius:6px;background:transparent;',
    'color:inherit;font:inherit;font-size:11px;padding:3px 10px;cursor:pointer}',
    '.dshac-actions button:hover{background:var(--dsw-alias-interactive-bg-hover,transparent)}',
    '.dshac-note{font-size:11px;opacity:.75}',
    '.dshac-note pre{margin:4px 0 0;white-space:pre-wrap;font-size:10.5px;opacity:.9;max-height:160px;overflow:auto}',
    // The tuner explains itself (user request 2026-10-13: "do not assume the
    // user knows everything"). Every field carries one line of plain-language
    // help; the intro says what compaction is and when a change takes effect,
    // and the footer separates live settings from code changes. The help text
    // is visually subordinate (smaller, receded) so it never competes with the
    // controls, and stays readable because the panel surface is opaque.
    '.dshac-intro{margin:0;font-size:11px;line-height:1.45;opacity:.8}',
    '.dshac-help{margin:0;font-size:10.5px;line-height:1.4;opacity:.6}',
    '.dshac-foot{margin:0;font-size:10px;line-height:1.4;opacity:.5}',
    '.dshac-banner{display:grid;gap:4px;padding:6px 8px;border-radius:6px;',
    'border:1px solid color-mix(in srgb,currentColor 25%,transparent);font-size:11px}',
    '.dshac-banner strong{font-weight:600}',
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
      // `react-dom` is a shell platform module exactly like `react` (the frozen
      // module table in packages/client/web/src/platform.ts, seeded by seed.ts):
      // shipped client bundles resolve it through the same require, and the
      // context ring's own trigger-anchored dialog uses createPortal for the
      // same reason this panel does.
      var ReactDOM = require('react-dom')
      var createPortal = ReactDOM && ReactDOM.createPortal
      var h = React.createElement

      /** Distance kept between the pill and the panel floating above it. */
      var PANEL_GAP = 8
      /** Distance kept between the panel and each viewport edge. */
      var PANEL_MARGIN = 12
      /**
       * Unplaced portal style: hidden but laid out, so the first placement pass
       * measures real panel dimensions instead of a zero-height guess (the
       * harness's own `MEASURE_STYLE`).
       */
      var MEASURE_STYLE = { visibility: 'hidden', left: 0, top: 0 }

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
              .then(function (response) {
                if (response && response.ok) return response.json().then(function (payload) { return { payload: payload } })
                // A 404 here is not "no data yet": it means this harness process
                // never registered the route (see src/gui.ts). Reporting that
                // distinctly is what turns a silently empty indicator into a
                // legible state for the user.
                return { failure: 'HTTP ' + ((response && response.status) || 'error') }
              })
              .then(function (result) {
                if (!alive) return
                if (result.payload && typeof result.payload === 'object') {
                  setData(result.payload)
                  delay.current = result.payload.running ? BUSY_POLL_MS : IDLE_POLL_MS
                  return
                }
                setData({ plugin: 'dsh-autocompact', __unreachable: true, __why: result.failure })
                delay.current = IDLE_POLL_MS
              })
              .catch(function () {
                if (alive) setData({ plugin: 'dsh-autocompact', __unreachable: true, __why: 'offline' })
              })
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

      /**
       * Fixed-position placement above the anchor, clamped inside the viewport.
       *
       * Mirrors the harness's own trigger-anchored dialog seat (ui-primitives
       * `useAnchoredPosition`, consumed by ui-chat's `useStatDialog`) with one
       * addition: the ROW is observed too. This row grows and shrinks while a
       * compaction runs — the progress strip appears beside the pill — which
       * moves the pill without a window resize or a scroll, and an anchor-only
       * watch would leave the panel behind.
       */
      function usePanelPosition(open, anchorRef, panelRef, rowRef) {
        var state = React.useState(null)
        var position = state[0]
        var setPosition = state[1]
        React.useLayoutEffect(function () {
          if (!open) {
            setPosition(null)
            return undefined
          }
          var place = function () {
            var anchor = anchorRef.current
            var panel = panelRef.current
            if (!anchor || !panel || typeof anchor.getBoundingClientRect !== 'function') return
            var rect = anchor.getBoundingClientRect()
            var width = panel.offsetWidth || 0
            var height = panel.offsetHeight || 0
            // Right-aligned on the pill (it sits at the composer's right edge,
            // beside the context ring), then clamped so a narrow window cannot
            // push the panel off-screen.
            var left = rect.right - width
            var top = rect.top - PANEL_GAP - height
            if (width > 0) left = Math.min(Math.max(left, PANEL_MARGIN), window.innerWidth - width - PANEL_MARGIN)
            if (height > 0) top = Math.min(Math.max(top, PANEL_MARGIN), window.innerHeight - height - PANEL_MARGIN)
            setPosition({ left: left, top: top })
          }
          place()
          // Capture phase: nested scrollers (the transcript) count too.
          window.addEventListener('scroll', place, true)
          window.addEventListener('resize', place)
          var observers = []
          if (typeof ResizeObserver !== 'undefined') {
            var watch = function (element) {
              if (!element) return
              var observer = new ResizeObserver(place)
              observer.observe(element)
              observers.push(observer)
            }
            watch(anchorRef.current)
            watch(panelRef.current)
            watch(rowRef.current)
          }
          return function () {
            window.removeEventListener('scroll', place, true)
            window.removeEventListener('resize', place)
            for (var index = 0; index < observers.length; index += 1) observers[index].disconnect()
          }
        }, [open, anchorRef, panelRef, rowRef])
        return position
      }

      /**
       * Popover dismissal: the pill's own click toggles the panel, a pointerdown
       * or click outside closes it, Escape closes it and hands focus back to the
       * pill. The click listener is a capture listener because keyboard
       * activation of a sibling control fires click without pointerdown; the
       * opening click cannot self-close because these listeners attach only
       * after it completed.
       */
      function useDismiss(open, setOpen, anchorRef, panelRef, triggerRef) {
        React.useEffect(function () {
          if (!open) return undefined
          var inside = function (target) {
            if (!(target instanceof Node)) return false
            var anchor = anchorRef.current
            var panel = panelRef.current
            return (anchor && anchor.contains(target)) === true
              || (panel && panel.contains(target)) === true
          }
          var closeOutside = function (event) {
            if (!inside(event.target)) setOpen(false)
          }
          var onKeyDown = function (event) {
            if (event.key !== 'Escape') return
            setOpen(false)
            var trigger = triggerRef.current
            if (trigger && typeof trigger.focus === 'function') {
              try { trigger.focus({ preventScroll: true }) } catch (error) { /* focus is a nicety */ }
            }
          }
          document.addEventListener('pointerdown', closeOutside)
          document.addEventListener('click', closeOutside, true)
          document.addEventListener('keydown', onKeyDown)
          return function () {
            document.removeEventListener('pointerdown', closeOutside)
            document.removeEventListener('click', closeOutside, true)
            document.removeEventListener('keydown', onKeyDown)
          }
        }, [open, setOpen, anchorRef, panelRef, triggerRef])
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

        // User request 2026-10-13: the tuner must not assume the user knows what
        // any of this means. Every control carries one plain-language line
        // (`dshac-help`), the panel opens with what compaction IS and when a
        // change takes effect, and the footer separates live settings from code
        // changes. Help text is wired to its input through aria-describedby, so
        // it reaches a screen reader as a description rather than as stray text.
        var field = function (key, label, type, help) {
          var helpId = 'dshac-' + key + '-help'
          return h('div', { className: 'dshac-field' },
            h('label', { htmlFor: 'dshac-' + key }, label),
            h('input', {
              id: 'dshac-' + key,
              type: type || 'text',
              value: form[key],
              onChange: set(key),
              'aria-describedby': helpId,
            }),
            help ? h('p', { className: 'dshac-help', id: helpId }, help) : null,
          )
        }

        var unreachable = data.__unreachable === true
        var why = typeof data.__why === 'string' && data.__why.length > 0 ? ' (' + data.__why + ')' : ''

        // Focus the surface on open so the keyboard reaches its fields and so
        // Escape and wheel-scrolling behave before the first Tab; closing hands
        // focus back to the pill. Non-modal on purpose: no focus trap, the
        // transcript underneath stays usable.
        React.useEffect(function () {
          var panel = props.panelRef && props.panelRef.current
          if (!panel || typeof panel.focus !== 'function') return
          try { panel.focus({ preventScroll: true }) } catch (error) { /* focus is a nicety */ }
        }, [])

        return h('div', {
          ref: props.panelRef,
          className: 'dshac-panel',
          role: 'dialog',
          'aria-label': t.title,
          tabIndex: -1,
          style: props.pos
            ? { left: props.pos.left + 'px', top: props.pos.top + 'px' }
            : MEASURE_STYLE,
        },
          h('h4', null, t.title),
          h('p', { className: 'dshac-intro' }, t.intro),
          unreachable
            ? h('div', { className: 'dshac-banner dshac-bad' },
              h('strong', null, t.routeDown + why),
              h('p', { className: 'dshac-help' }, t.helpRouteDown),
            )
            : h('div', null,
              h('div', { className: 'dshac-note' }, statusLine({ strings: t, data: data })),
              h('p', { className: 'dshac-help' }, t.helpStatus),
            ),
          h('div', { className: 'dshac-field' },
            h('div', { className: 'dshac-check' },
              h('input', {
                id: 'dshac-enabled',
                type: 'checkbox',
                checked: form.enabled === true,
                onChange: set('enabled'),
                'aria-describedby': 'dshac-enabled-help',
              }),
              h('label', { htmlFor: 'dshac-enabled' }, t.enabled),
            ),
            h('p', { className: 'dshac-help', id: 'dshac-enabled-help' }, t.helpEnabled),
          ),
          field('ratio', t.triggerRatio, 'number', t.helpRatio),
          field('tokens', t.triggerTokens, 'number', t.helpTokens),
          field('retainTokens', t.retainTokens, 'number', t.helpRetain),
          field('archiveRoot', t.archiveRoot, 'text', t.helpArchiveRoot),
          field('provider', t.provider, 'text', t.helpProvider),
          field('model', t.model, 'text', t.helpModel),
          h('div', { className: 'dshac-actions' },
            h('button', { type: 'button', onClick: save, disabled: !writable }, t.save),
            h('button', { type: 'button', onClick: props.onClose }, t.close),
            message
              ? h('span', { className: message.kind === 'bad' ? 'dshac-bad' : (message.kind === 'ok' ? 'dshac-ok' : 'dshac-note') },
                message.text)
              : null,
          ),
          writable ? null : h('div', { className: 'dshac-note' },
            // An empty reason is what made the read-only state unreadable; the
            // fallback explains the concrete next action instead of "Read-only: ".
            t.readOnly + (capabilities.reason || t.helpNoEditor),
            capabilities.snippet ? h('pre', null, capabilities.snippet) : null,
          ),
          h('p', { className: 'dshac-foot' }, t.helpSave),
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
        var anchorRef = React.useRef(null)
        var pillRef = React.useRef(null)
        var panelRef = React.useRef(null)
        var rowRef = React.useRef(null)
        // Placement and dismissal mirror the harness's own trigger-anchored
        // dialog; the row ref is ours because the progress strip appearing
        // beside the pill moves it without a window resize.
        var position = usePanelPosition(open, anchorRef, panelRef, rowRef)
        useDismiss(open, setOpen, anchorRef, panelRef, pillRef)
        var running = data && data.running && typeof data.running === 'object' ? data.running : null
        var now = useTicker(running !== null)
        var recent = data && Array.isArray(data.recent) && data.recent.length > 0 ? data.recent[0] : null
        var showRecent = running === null && recent !== null && Date.now() - recent.finishedAt < RECENT_MS
        var enabled = !data || data.enabled !== false
        // The host route answering 404/offline is a distinct state from
        // "disabled": the plugin may be perfectly enabled while this process
        // never registered its route. Amber + a titled pill says "unknown"
        // instead of quietly reusing the grey that means "switched off".
        var unreachable = data !== null && data.__unreachable === true

        // The anchor shrink-wraps the pill so placement measures the pill
        // itself; anchoring to the row would let the progress strip widen and
        // re-center the floating panel while a compaction runs.
        var pill = h('span', { className: 'dshac-anchor', ref: anchorRef },
          h('button', {
            type: 'button',
            ref: pillRef,
            className: 'dshac-pill',
            onClick: function () { setOpen(!open) },
            'aria-haspopup': 'dialog',
            'aria-expanded': open ? 'true' : 'false',
            title: unreachable ? t.routeDown : t.title,
          },
            unreachable
              ? h('span', { className: 'dshac-dot', 'data-state': 'unknown' })
              : h('span', { className: 'dshac-dot', 'data-on': enabled ? 'true' : 'false' }),
            h('span', null, t.open),
          ),
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
        // The pill is the only way into the tuner, so the row must render even
        // while nothing is compressing. When idle it recedes (dshac-quiet)
        // instead of disappearing: returning null here left the panel
        // unreachable whenever no compaction was running or recently finished.
        var idle = running === null && !showRecent && !open
        var row = h('div', {
          ref: rowRef,
          className: idle ? 'dshac-row dshac-quiet' : 'dshac-row',
        }, children)
        if (!open) return row
        // Portaled to <body>. Outside the composer's layout flow (so the bar
        // cannot be pushed), outside its containing blocks and overflow clips
        // (a `position: fixed` element inside a backdrop-filtered ancestor is
        // still trapped by it), and above the app's layers via z-index 1100.
        // Without createPortal the panel degrades to rendering here — still
        // position:fixed from the stylesheet, so it never rejoins the row's
        // flow even on a shell that does not share react-dom.
        var panel = h(Panel, {
          strings: t,
          data: data,
          pos: position,
          panelRef: panelRef,
          onClose: function () { setOpen(false) },
        })
        return h(React.Fragment, null, row, createPortal ? createPortal(panel, document.body) : panel)
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
