/**
 * Browser half of `dsh-plugin-dir-sync`.
 *
 * Two surfaces, both contributed through slots so the shell stays untouched:
 *  - `plugins.row.config` — the bundle's configuration page: up to 30
 *    source/target/cron rule pairs, each with its own on/off switch.
 *  - `sidebar.footer.action` — a one-click "sync now" button that sits in the
 *    sidebar's account row, immediately before the restart button, and opens a
 *    completion dialog when the manual run finishes.
 */
window.__ModuleLoader__.load({
  id: 'dsh-plugin-dir-sync',
  factory(require) {
    const React = require('react')
    const ReactDOM = (() => {
      try {
        return require('react-dom')
      } catch {
        return null
      }
    })()
    const h = React.createElement

    /** Keyed row identity: `<package name>#<patch row id>`. */
    const ROW_KEY = 'dsh-plugin-dir-sync#dsh-dir-sync'
    const ROUTE_BASE = '/plugins-local/dsh-dir-sync'
    const ROUTES = {
      state: `${ROUTE_BASE}/state`,
      save: `${ROUTE_BASE}/save`,
      toggle: `${ROUTE_BASE}/toggle`,
      run: `${ROUTE_BASE}/run`,
      status: `${ROUTE_BASE}/status`,
    }
    const MAX_RULES = 30
    /** The slot anchor of the account row; its parent is the flex row that also
     * holds the settings launcher and the restart button. */
    const ROW_ANCHOR = '[data-slot="settings.launcher"]'
    const STATE_POLL_MS = 4000
    const RUN_POLL_MS = 700
    const ROW_FALLBACK_MS = 4000
    const CRON_INPUT_ID = 'dsh-dir-sync-cron-hints'
    const CRON_HINTS = [
      ['0 3 * * *', '每天 03:00'],
      ['0 * * * *', '每小时整点'],
      ['*/30 * * * *', '每 30 分钟'],
      ['*/10 * * * *', '每 10 分钟'],
      ['0 9 * * 1-5', '工作日 09:00'],
      ['0 0 * * 0', '每周日 00:00'],
      ['0 0 1 * *', '每月 1 日 00:00'],
    ]
    const JSON_POST = { method: 'POST', headers: { 'content-type': 'application/json' } }

    /* ---------------------------------------------------------------------- */
    /* transport                                                              */
    /* ---------------------------------------------------------------------- */

    async function call(path, init = {}) {
      let response
      try {
        response = await fetch(path, { credentials: 'same-origin', cache: 'no-store', ...init })
      } catch {
        throw new Error('无法连接 DSH 本地服务，请确认插件已随应用启动。')
      }
      const text = await response.text()
      let payload = null
      if (text !== '') {
        try {
          payload = JSON.parse(text)
        } catch {
          payload = null
        }
      }
      if (!response.ok) {
        const failure = new Error(payload?.error ?? payload?.message ?? `请求失败（HTTP ${response.status}）`)
        failure.problems = Array.isArray(payload?.problems) ? payload.problems : []
        throw failure
      }
      return payload ?? {}
    }

    function postJson(path, body) {
      return call(path, { ...JSON_POST, body: JSON.stringify(body ?? {}) })
    }

    /* ---------------------------------------------------------------------- */
    /* formatting                                                             */
    /* ---------------------------------------------------------------------- */

    function pad2(value) {
      return String(value).padStart(2, '0')
    }

    function formatBytes(value) {
      const size = Number(value) || 0
      if (size < 1024) return `${size} B`
      const units = ['KB', 'MB', 'GB', 'TB']
      let scaled = size / 1024
      let index = 0
      while (scaled >= 1024 && index < units.length - 1) {
        scaled /= 1024
        index += 1
      }
      return `${scaled >= 10 ? Math.round(scaled) : scaled.toFixed(1)} ${units[index]}`
    }

    function formatTime(value) {
      if (typeof value !== 'string') return '—'
      const time = new Date(value)
      if (Number.isNaN(time.getTime())) return '—'
      const now = new Date()
      const sameDay =
        time.getFullYear() === now.getFullYear() &&
        time.getMonth() === now.getMonth() &&
        time.getDate() === now.getDate()
      const clock = `${pad2(time.getHours())}:${pad2(time.getMinutes())}`
      return sameDay ? clock : `${pad2(time.getMonth() + 1)}-${pad2(time.getDate())} ${clock}`
    }

    function formatDuration(value) {
      const ms = Number(value) || 0
      if (ms < 1000) return `${ms} 毫秒`
      return `${(ms / 1000).toFixed(1)} 秒`
    }

    function ruleStateText(rule, running) {
      if (running) return '正在同步…'
      if (rule.enabled !== true) return '已停止，打开开关后按计划同步'
      const last = rule.lastRun
      if (last === null || last === undefined) return '等待首次同步'
      const when = `${last.reason === 'manual' ? '手动' : '定时'} ${formatTime(last.at)}`
      if (last.ok !== true) return `${when}失败${typeof last.error === 'string' ? `：${last.error}` : ''}`
      const parts = [`${Number(last.files) || 0} 个文件`, formatBytes(last.bytes)]
      if (Number(last.deleted) > 0) parts.push(`删除 ${last.deleted} 项`)
      if (Number(last.skipped) > 0) parts.push(`跳过 ${last.skipped} 项`)
      return `${when}成功 · ${parts.join(' · ')}`
    }

    function summaryText(state) {
      if (state === null) return '正在读取同步规则…'
      const rules = Array.isArray(state.rules) ? state.rules : []
      if (rules.length === 0) return '还没有同步规则，点击右侧「配置」添加。'
      const active = rules.filter((rule) => rule.enabled === true).length
      const busy = Array.isArray(state.running) && state.running.length > 0
      return `${rules.length}/${MAX_RULES} 条规则 · ${active} 条已启动${busy ? ' · 正在同步…' : ''}`
    }

    /* ---------------------------------------------------------------------- */
    /* draft model                                                            */
    /* ---------------------------------------------------------------------- */

    let rowCounter = 0

    function nextKey() {
      rowCounter += 1
      return `row-${rowCounter}`
    }

    function toDraft(rules) {
      return (Array.isArray(rules) ? rules : []).map((rule) => ({
        clientKey: typeof rule?.id === 'string' && rule.id !== '' ? rule.id : nextKey(),
        id: typeof rule?.id === 'string' ? rule.id : null,
        source: typeof rule?.source === 'string' ? rule.source : '',
        target: typeof rule?.target === 'string' ? rule.target : '',
        cron: typeof rule?.cron === 'string' ? rule.cron : '',
        enabled: rule?.enabled === true,
        mirror: rule?.mirror === true,
        lastRun: rule?.lastRun ?? null,
      }))
    }

    function serializable(rules) {
      return (Array.isArray(rules) ? rules : []).map((rule) => ({
        id: typeof rule?.id === 'string' ? rule.id : null,
        source: String(rule?.source ?? '').trim(),
        target: String(rule?.target ?? '').trim(),
        cron: String(rule?.cron ?? '').trim(),
        enabled: rule?.enabled === true,
        mirror: rule?.mirror === true,
      }))
    }

    function signature(rules) {
      return JSON.stringify(serializable(rules))
    }

    function ruleFields(rule) {
      return {
        source: String(rule?.source ?? '').trim(),
        target: String(rule?.target ?? '').trim(),
        cron: String(rule?.cron ?? '').trim(),
        mirror: rule?.mirror === true,
      }
    }

    function sameFields(a, b) {
      return JSON.stringify(ruleFields(a)) === JSON.stringify(ruleFields(b))
    }

    /* ---------------------------------------------------------------------- */
    /* shared atoms                                                           */
    /* ---------------------------------------------------------------------- */

    function SyncIcon(props) {
      const size = props?.size ?? 16
      return h(
        'svg',
        {
          className: 'ds-icon',
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 2,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
        },
        h('path', { d: 'M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8' }),
        h('path', { d: 'M21 3v5h-5' }),
        h('path', { d: 'M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16' }),
        h('path', { d: 'M8 16H3v5' }),
      )
    }

    function Switch(props) {
      return h(
        'button',
        {
          type: 'button',
          role: 'switch',
          className: 'ds-switch',
          'aria-checked': props.checked === true ? 'true' : 'false',
          'aria-label': props.label,
          title: props.label,
          onClick: () => props.onChange(props.checked !== true),
        },
        h('span', null),
      )
    }

    function RuleCard(props) {
      const { index, row, running, problems, warnings } = props
      const update = (patch) => props.onChange(index, patch)
      const failures = (problems ?? []).filter((problem) => problem.index === index)
      const notes = (warnings ?? []).filter((warning) => warning.index === index)
      const path = (key, label, placeholder) =>
        h(
          'label',
          { className: 'ds-field' },
          h('span', { className: 'ds-field-label' }, label),
          h('input', {
            className: 'ds-input',
            value: row[key],
            spellCheck: false,
            autoComplete: 'off',
            placeholder,
            onChange: (event) => update({ [key]: event.target.value }),
          }),
        )
      return h(
        'div',
        { className: 'ds-card' },
        h(
          'div',
          { className: 'ds-card-head' },
          h('span', { className: 'ds-card-index' }, `#${index + 1}`),
          h(Switch, {
            checked: row.enabled === true,
            label: `第 ${index + 1} 条规则：${row.enabled === true ? '已启动，点击停止' : '已停止，点击启动'}`,
            onChange: (value) => props.onToggle(index, value),
          }),
          h('span', { className: 'ds-card-state' }, ruleStateText(row, running)),
          h('span', { className: 'ds-grow' }),
          h('button', { type: 'button', className: 'ds-link', onClick: () => props.onRemove(index) }, '删除'),
        ),
        path('source', '源目录', 'D:\\photo'),
        path('target', '目标目录', 'E:\\backup\\photo'),
        h(
          'div',
          { className: 'ds-inline-field' },
          h('span', { className: 'ds-field-label' }, '同步间隔'),
          h('input', {
            className: 'ds-input ds-cron-input',
            value: row.cron,
            spellCheck: false,
            autoComplete: 'off',
            list: CRON_INPUT_ID,
            placeholder: '0 3 * * *',
            onChange: (event) => update({ cron: event.target.value }),
          }),
          h(
            'label',
            { className: 'ds-check' },
            h('input', {
              type: 'checkbox',
              checked: row.mirror === true,
              onChange: (event) => update({ mirror: event.target.checked }),
            }),
            '镜像：删除目标目录里源目录没有的文件',
          ),
        ),
        failures.length === 0
          ? null
          : h(
              'div',
              { className: 'ds-error' },
              failures.map((failure) => h('div', { key: failure.message }, failure.message)),
            ),
        notes.length === 0
          ? null
          : h(
              'div',
              { className: 'ds-warn' },
              notes.map((note) => h('div', { key: note.message }, note.message)),
            ),
      )
    }

    /* ---------------------------------------------------------------------- */
    /* configuration page                                                     */
    /* ---------------------------------------------------------------------- */

    function useSyncState(enabled) {
      const [state, setState] = React.useState(null)
      const alive = React.useRef(true)
      React.useEffect(
        () => () => {
          alive.current = false
        },
        [],
      )
      const refresh = React.useCallback(async () => {
        const payload = await call(ROUTES.state)
        if (alive.current) setState(payload)
        return payload
      }, [])
      React.useEffect(() => {
        if (enabled !== true) return undefined
        let timer = null
        const poll = async () => {
          try {
            await refresh()
          } catch {
            // Keep showing the last good snapshot; the page reports errors on demand.
          }
          if (alive.current) timer = window.setTimeout(poll, STATE_POLL_MS)
        }
        void poll()
        return () => {
          if (timer !== null) window.clearTimeout(timer)
        }
      }, [enabled, refresh])
      return state
    }

    function SyncSettingsPanel(props) {
      const summaryOnly = props?.view === 'summary'
      const state = useSyncState(true)
      const [draft, setDraft] = React.useState(null)
      const [savedRules, setSavedRules] = React.useState([])
      const [problems, setProblems] = React.useState([])
      const [warnings, setWarnings] = React.useState([])
      const [error, setError] = React.useState('')
      const [notice, setNotice] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      const seeded = React.useRef(false)

      React.useEffect(() => {
        if (state === null) return
        setSavedRules(Array.isArray(state.rules) ? state.rules : [])
        if (seeded.current) return
        seeded.current = true
        setDraft(toDraft(state.rules))
      }, [state])

      const running = Array.isArray(state?.running) ? state.running : []
      const dirty = draft !== null && signature(draft) !== signature(savedRules)
      const generalProblems = (problems ?? []).filter((problem) => problem.index < 0)

      const clearFeedback = () => {
        setError('')
        setNotice('')
        setProblems([])
      }

      const change = (index, patch) => {
        clearFeedback()
        setDraft((current) =>
          current === null ? current : current.map((row, position) => (position === index ? { ...row, ...patch } : row)),
        )
      }

      const add = () => {
        clearFeedback()
        setDraft((current) => {
          if (current === null) return current
          if (current.length >= MAX_RULES) {
            setError(`最多只能添加 ${MAX_RULES} 条同步规则。`)
            return current
          }
          return [
            ...current,
            { clientKey: nextKey(), id: null, source: '', target: '', cron: '', enabled: false, mirror: false, lastRun: null },
          ]
        })
      }

      const remove = (index) => {
        clearFeedback()
        setDraft((current) => (current === null ? current : current.filter((row, position) => position !== index)))
      }

      const reset = () => {
        clearFeedback()
        setWarnings([])
        setDraft(toDraft(savedRules))
      }

      const toggle = async (index, value) => {
        const row = draft?.[index]
        if (row === undefined) return
        clearFeedback()
        setDraft((current) =>
          current === null
            ? current
            : current.map((item, position) => (position === index ? { ...item, enabled: value === true } : item)),
        )
        const saved = savedRules.find((candidate) => candidate.id === row.id)
        if (saved === undefined || row.id === null || !sameFields(saved, row)) {
          setNotice(value === true ? '已打开开关，保存规则后开始定时同步。' : '已关闭开关，保存规则后停止定时同步。')
          return
        }
        try {
          const payload = await postJson(ROUTES.toggle, { id: row.id, enabled: value === true })
          if (Array.isArray(payload.rules)) setSavedRules(payload.rules)
          setNotice(value === true ? '已启动这条规则。' : '已停止这条规则。')
        } catch (failure) {
          setDraft((current) =>
            current === null
              ? current
              : current.map((item, position) => (position === index ? { ...item, enabled: row.enabled === true } : item)),
          )
          setError(failure.message)
        }
      }

      const save = async () => {
        if (draft === null || busy) return
        setBusy(true)
        clearFeedback()
        setWarnings([])
        try {
          const payload = await postJson(ROUTES.save, { rules: serializable(draft) })
          const rules = Array.isArray(payload.rules) ? payload.rules : []
          setSavedRules(rules)
          setDraft(toDraft(rules))
          setWarnings(Array.isArray(payload.warnings) ? payload.warnings : [])
          setNotice(rules.length === 0 ? '已保存，当前没有同步规则。' : `已保存 ${rules.length} 条规则。`)
        } catch (failure) {
          setError(failure.message)
          setProblems(Array.isArray(failure.problems) ? failure.problems : [])
        } finally {
          setBusy(false)
        }
      }

      if (summaryOnly) return h('span', { className: 'ds-summary' }, summaryText(state))

      if (draft === null) {
        return h(
          'div',
          { className: 'ds-page' },
          h('div', { className: 'ds-hint' }, error === '' ? '正在读取同步规则…' : error),
        )
      }

      const cards = draft.map((row, index) => {
        const savedRow = savedRules.find((candidate) => candidate.id !== null && candidate.id === row.id)
        const statusRow = savedRow === undefined ? row : { ...row, lastRun: savedRow.lastRun ?? row.lastRun }
        return h(RuleCard, {
          key: row.clientKey,
          index,
          row: statusRow,
          running: running.includes(row.id),
          problems,
          warnings,
          onChange: change,
          onToggle: toggle,
          onRemove: remove,
        })
      })

      return h(
        'div',
        { className: 'ds-page' },
        h('datalist', { id: CRON_INPUT_ID }, CRON_HINTS.map(([value, label]) => h('option', { key: value, value }, label))),
        h(
          'div',
          { className: 'ds-intro' },
          '把源目录的整个内容按 cron 定时复制到目标目录（目标目录不存在时会自动创建）。',
          h('br'),
          '已保存的规则切换开关会立刻生效；修改目录或间隔后需要点「保存规则」。最多 30 条。',
        ),
        h(
          'div',
          { className: 'ds-toolbar' },
          h(
            'button',
            {
              type: 'button',
              className: 'ds-btn ds-btn-primary',
              disabled: busy || dirty !== true,
              onClick: save,
            },
            busy ? '保存中…' : '保存规则',
          ),
          h('button', { type: 'button', className: 'ds-btn', disabled: busy || draft.length >= MAX_RULES, onClick: add }, '添加规则'),
          dirty ? h('button', { type: 'button', className: 'ds-btn', disabled: busy, onClick: reset }, '放弃修改') : null,
          h('span', { className: 'ds-grow' }),
          h('span', { className: 'ds-meta' }, `${draft.length}/${MAX_RULES} 条${dirty ? ' · 有未保存的修改' : ''}`),
        ),
        notice === '' ? null : h('div', { className: 'ds-notice' }, notice),
        error === '' ? null : h('div', { className: 'ds-error' }, error),
        generalProblems.map((problem) => h('div', { key: problem.message, className: 'ds-error' }, problem.message)),
        cards.length === 0
          ? h('div', { className: 'ds-empty' }, '还没有规则。点击「添加规则」新建一条，填好源目录、目标目录和同步间隔后保存。')
          : cards,
        h(
          'div',
          { className: 'ds-hint' },
          '同步间隔是 5 段 cron：分 时 日 月 周。日和周同时指定时按「或」匹配。常用写法：0 3 * * * 每天 03:00，*/30 * * * * 每 30 分钟，0 9 * * 1-5 工作日 09:00。',
        ),
      )
    }

    /* ---------------------------------------------------------------------- */
    /* sidebar foot: sync now + completion dialog                             */
    /* ---------------------------------------------------------------------- */

    function useSettingsRow(active) {
      const [row, setRow] = React.useState(null)
      React.useEffect(() => {
        if (active !== true || typeof document === 'undefined' || document.body === null) {
          setRow(null)
          return undefined
        }
        let observer = null
        let timeout = null
        const resolveRow = () => {
          const anchor = document.querySelector(ROW_ANCHOR)
          const parent = anchor === null ? null : anchor.parentElement
          if (!(parent instanceof HTMLElement)) return false
          setRow(parent)
          if (observer !== null) {
            observer.disconnect()
            observer = null
          }
          if (timeout !== null) {
            window.clearTimeout(timeout)
            timeout = null
          }
          return true
        }
        if (!resolveRow() && typeof MutationObserver !== 'undefined') {
          observer = new MutationObserver(() => {
            resolveRow()
          })
          observer.observe(document.body, { childList: true, subtree: true })
          timeout = window.setTimeout(() => {
            if (observer !== null) {
              observer.disconnect()
              observer = null
            }
          }, ROW_FALLBACK_MS)
        }
        return () => {
          if (observer !== null) observer.disconnect()
          if (timeout !== null) window.clearTimeout(timeout)
        }
      }, [active])
      return row
    }

    function createPortal(node, container) {
      if (container === null) return null
      if (ReactDOM === null || typeof ReactDOM.createPortal !== 'function') return node
      return ReactDOM.createPortal(node, container)
    }

    function RunDialog(props) {
      const { phase, run, message: failure } = props
      const closeRef = React.useRef(null)
      React.useEffect(() => {
        if (closeRef.current !== null) closeRef.current.focus()
      }, [])
      React.useEffect(() => {
        const onKey = (event) => {
          if (event.key === 'Escape') props.onClose()
        }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
      }, [props])

      const results = Array.isArray(run?.results) ? run.results : []
      const total = Number(run?.total) || 0
      const failed = results.filter((result) => result.ok !== true)
      const files = results.reduce((sum, result) => sum + (Number(result.files) || 0), 0)
      const bytes = results.reduce((sum, result) => sum + (Number(result.bytes) || 0), 0)
      const deleted = results.reduce((sum, result) => sum + (Number(result.deleted) || 0), 0)

      let title = '正在同步目录…'
      if (phase === 'error') title = '同步失败'
      else if (phase === 'empty') title = '没有可同步的规则'
      else if (phase === 'done') title = failed.length === 0 ? '同步完成' : '同步完成，但有失败项'

      let body = ''
      if (phase === 'running' || phase === 'done') {
        body =
          phase === 'running'
            ? `共 ${total} 条规则，已处理 ${results.length} 条。`
            : `${total} 条规则：${total - failed.length} 条成功${failed.length === 0 ? '' : `，${failed.length} 条失败`} · 复制 ${files} 个文件（${formatBytes(bytes)}）${deleted === 0 ? '' : ` · 删除 ${deleted} 项`}`
      } else {
        body = failure
      }

      return h(
        'div',
        {
          className: 'ds-scrim',
          onMouseDown: (event) => {
            if (event.target === event.currentTarget) props.onClose()
          },
        },
        h(
          'div',
          { className: 'ds-dialog', role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
          h('div', { className: 'ds-dialog-title' }, title),
          body === '' ? null : h('div', { className: 'ds-dialog-body' }, body),
          results.length === 0
            ? null
            : h(
                'div',
                { className: 'ds-run-list' },
                results.map((result) =>
                  h(
                    'div',
                    { key: `${result.id}-${result.at}`, className: 'ds-run-item' },
                    h('div', { className: 'ds-run-path' }, `${result.source} → ${result.target}`),
                    h(
                      'div',
                      { className: `ds-run-meta ${result.ok === true ? 'ds-ok' : 'ds-fail'}` },
                      result.ok === true
                        ? `成功 · ${Number(result.files) || 0} 个文件 · ${formatBytes(result.bytes)}${Number(result.deleted) > 0 ? ` · 删除 ${result.deleted} 项` : ''} · ${formatDuration(result.durationMs)}`
                        : `失败：${typeof result.error === 'string' ? result.error : '未知错误'}`,
                    ),
                  ),
                ),
              ),
          h(
            'div',
            { className: 'ds-dialog-actions' },
            h('button', { type: 'button', className: 'ds-btn', ref: closeRef, onClick: props.onClose }, '关闭'),
          ),
        ),
      )
    }

    function SyncNowAction(props) {
      const wide = props?.wide === true
      const row = useSettingsRow(wide)
      const [phase, setPhase] = React.useState('idle')
      const [run, setRun] = React.useState(null)
      const [message, setMessage] = React.useState('')
      const [open, setOpen] = React.useState(false)
      const [late, setLate] = React.useState(false)
      const alive = React.useRef(true)
      const timer = React.useRef(null)

      React.useEffect(
        () => () => {
          alive.current = false
          if (timer.current !== null) window.clearTimeout(timer.current)
        },
        [],
      )

      React.useEffect(() => {
        if (wide !== true) return undefined
        const handle = window.setTimeout(() => setLate(true), ROW_FALLBACK_MS)
        return () => window.clearTimeout(handle)
      }, [wide])

      const settle = (next) => {
        if (next === null || typeof next !== 'object') return
        setRun(next)
        setPhase(next.running === true ? 'running' : 'done')
      }

      const schedule = (id) => {
        if (timer.current !== null) window.clearTimeout(timer.current)
        timer.current = window.setTimeout(() => {
          void poll(id)
        }, RUN_POLL_MS)
      }

      const poll = async (id) => {
        if (!alive.current) return
        try {
          const payload = await postJson(ROUTES.status, { id })
          if (!alive.current) return
          const next = payload?.run
          if (next === null || next === undefined) {
            setPhase('error')
            setMessage('找不到这次同步记录，可能应用已经重启过。')
            return
          }
          settle(next)
          if (next.running === true) schedule(id)
        } catch (failure) {
          if (!alive.current) return
          setPhase('error')
          setMessage(failure.message)
        }
      }

      const start = async () => {
        setOpen(true)
        if (phase === 'running') return
        setPhase('starting')
        setMessage('')
        try {
          const payload = await postJson(ROUTES.run, {})
          const runId = typeof payload?.runId === 'string' ? payload.runId : ''
          if (runId === '') {
            setPhase('empty')
            setMessage('没有已启动的同步规则。请先打开插件配置，给至少一条规则打开开关并保存。')
            return
          }
          setRun({ id: runId, total: Number(payload.total) || 0, done: 0, results: [], running: true })
          setPhase('running')
          await poll(runId)
        } catch (failure) {
          setPhase('error')
          setMessage(failure.message)
        }
      }

      const label = phase === 'running' ? '正在同步目录…' : '立即同步目录'
      const busy = phase === 'running' || phase === 'starting'
      const hostRef = React.useRef(null)

      // The restart button keeps its own portal span in the account row. Portals
      // append, so a later mount lands on its right; move this span in front of
      // the restart span to sit immediately to its left.
      React.useEffect(() => {
        const node = hostRef.current
        if (node === null || row === null) return undefined
        const place = () => {
          const parent = node.parentElement
          if (parent === null || parent !== row) return
          const restart = parent.querySelector(':scope > .dsh-restart-inline')
          if (restart === null || restart === node || restart.previousElementSibling === node) return
          parent.insertBefore(node, restart)
        }
        place()
        if (typeof MutationObserver === 'undefined') return undefined
        const observer = new MutationObserver(place)
        observer.observe(row, { childList: true })
        return () => observer.disconnect()
      }, [row])

      const trigger = (className, size) =>
        h(
          'button',
          {
            type: 'button',
            className,
            'data-busy': busy ? 'true' : 'false',
            title: label,
            'aria-label': label,
            onClick: start,
          },
          h(SyncIcon, { size }),
        )

      const dialog = open
        ? h(RunDialog, {
            phase,
            run,
            message,
            onClose: () => {
              setOpen(false)
            },
          })
        : null

      if (wide === true && row !== null) {
        return h(
          React.Fragment,
          null,
          createPortal(
            h('span', { className: 'ds-inline', ref: hostRef }, trigger('ds-icon-btn', 16)),
            row,
          ),
          dialog,
        )
      }

      if (wide === true && !late) return dialog

      return h(
        React.Fragment,
        null,
        h(
          'div',
          { className: wide === true ? 'ds-layer' : 'ds-layer ds-rail' },
          trigger(wide === true ? 'ds-icon-btn' : 'ds-rail-btn', wide === true ? 16 : 18),
        ),
        dialog,
      )
    }

    /* ---------------------------------------------------------------------- */
    /* styles                                                                 */
    /* ---------------------------------------------------------------------- */

    const CSS = `
.ds-page{display:flex;flex-direction:column;gap:8px;padding:2px 0 10px;font-size:13px;color:var(--dsw-alias-label-primary)}
.ds-intro{font-size:12px;line-height:1.7;color:var(--dsw-alias-label-secondary)}
.ds-toolbar{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.ds-grow{flex:1 1 auto}
.ds-meta{font-size:12px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}
.ds-summary{font-size:12px;color:var(--dsw-alias-label-secondary)}
.ds-btn{display:inline-flex;align-items:center;gap:6px;height:30px;padding:0 14px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-primary);font-family:inherit;font-size:13px;line-height:1;white-space:nowrap;cursor:pointer}
.ds-btn:hover:not(:disabled){background:color-mix(in srgb,var(--dsw-alias-label-primary) 7%,transparent)}
.ds-btn:disabled{opacity:.45;cursor:default}
.ds-btn-primary{border-color:var(--dsw-alias-brand-primary);background:var(--dsw-alias-brand-primary);color:var(--dsw-alias-bg-base)}
.ds-btn-primary:hover:not(:disabled){background:color-mix(in srgb,var(--dsw-alias-brand-primary) 86%,var(--dsw-alias-label-primary))}
.ds-link{border:none;background:none;padding:0 2px;color:var(--dsw-alias-label-secondary);font-family:inherit;font-size:12px;cursor:pointer}
.ds-link:hover{color:var(--dsw-alias-label-primary);text-decoration:underline}
.ds-card{display:flex;flex-direction:column;gap:8px;padding:10px 12px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px}
.ds-card-head{display:flex;align-items:center;gap:8px}
.ds-card-index{min-width:22px;font-size:12px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}
.ds-card-state{font-size:12px;line-height:1.5;color:var(--dsw-alias-label-secondary)}
.ds-field{display:flex;align-items:center;gap:8px}
.ds-field-label{flex:none;width:64px;text-align:right;font-size:12px;color:var(--dsw-alias-label-secondary)}
.ds-input{flex:1 1 auto;min-width:0;height:28px;padding:0 8px;border-radius:6px;border:1px solid var(--dsw-alias-border-l1);background:transparent;color:var(--dsw-alias-label-primary);font-family:inherit;font-size:13px}
.ds-input:focus{outline:none;border-color:var(--dsw-alias-brand-primary)}
.ds-input::placeholder{color:color-mix(in srgb,var(--dsw-alias-label-secondary) 72%,transparent)}
.ds-cron-input{flex:0 0 176px}
.ds-inline-field{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.ds-check{display:inline-flex;align-items:center;gap:6px;font-size:12px;color:var(--dsw-alias-label-secondary);cursor:pointer;user-select:none}
.ds-error{font-size:12px;line-height:1.7;color:var(--dsw-alias-state-error-primary)}
.ds-warn{font-size:12px;line-height:1.7;color:var(--dsw-alias-state-warn-primary)}
.ds-notice{font-size:12px;line-height:1.7;color:var(--dsw-alias-state-success-primary)}
.ds-hint{font-size:12px;line-height:1.7;color:var(--dsw-alias-label-secondary)}
.ds-empty{padding:18px 12px;border:1px dashed var(--dsw-alias-border-l1);border-radius:10px;text-align:center;font-size:12px;color:var(--dsw-alias-label-secondary)}
.ds-switch{position:relative;flex:none;width:36px;height:20px;padding:0;border:none;border-radius:10px;background:var(--dsw-alias-border-l2);cursor:pointer;transition:background 120ms ease}
.ds-switch[aria-checked="true"]{background:var(--dsw-alias-brand-primary)}
.ds-switch>span{position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:var(--dsw-alias-bg-base);box-shadow:0 1px 2px rgba(0,0,0,.28);transition:left 120ms ease}
.ds-switch[aria-checked="true"]>span{left:18px}
.ds-inline{margin-left:auto;display:flex;align-items:center}
.ds-icon-btn{display:inline-flex;align-items:center;justify-content:center;width:30px;height:30px;padding:0;border:none;border-radius:9px;background:transparent;color:var(--dsw-alias-label-primary);cursor:pointer}
.ds-icon-btn:hover{background:color-mix(in srgb,var(--dsw-alias-label-primary) 8%,transparent)}
.ds-icon-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}
.ds-layer{flex:none;display:flex;align-items:center;justify-content:center}
.ds-layer.ds-rail{width:36px;height:36px}
.ds-rail-btn{display:inline-flex;align-items:center;justify-content:center;width:36px;height:36px;padding:0;border:none;border-radius:50%;background:transparent;color:var(--dsw-alias-label-primary);cursor:pointer}
.ds-rail-btn:hover{background:color-mix(in srgb,var(--dsw-alias-label-primary) 8%,transparent)}
.ds-icon-btn[data-busy="true"] .ds-icon,.ds-rail-btn[data-busy="true"] .ds-icon{animation:ds-spin 900ms linear infinite}
@keyframes ds-spin{from{transform:rotate(0)}to{transform:rotate(360deg)}}
.ds-scrim{position:fixed;inset:0;z-index:2147483100;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.32)}
.ds-dialog{display:flex;flex-direction:column;gap:10px;width:min(440px,calc(100vw - 48px));max-height:76vh;overflow:auto;padding:18px;border-radius:14px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-overlay);color:var(--dsw-alias-label-primary);box-shadow:0 18px 48px rgba(0,0,0,.28)}
.ds-dialog-title{font-size:15px;font-weight:600;line-height:1.4}
.ds-dialog-body{font-size:13px;line-height:1.7;color:var(--dsw-alias-label-secondary)}
.ds-dialog-actions{display:flex;justify-content:flex-end;gap:8px;padding-top:2px}
.ds-run-list{display:flex;flex-direction:column;gap:6px}
.ds-run-item{display:flex;flex-direction:column;gap:3px;padding:7px 9px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px}
.ds-run-path{font-size:12px;line-height:1.5;color:var(--dsw-alias-label-primary);word-break:break-all}
.ds-run-meta{font-size:12px;line-height:1.5;color:var(--dsw-alias-label-secondary);word-break:break-word}
.ds-ok{color:var(--dsw-alias-state-success-primary)}
.ds-fail{color:var(--dsw-alias-state-error-primary)}
`

    function insertStyles() {
      const tag = document.createElement('style')
      tag.dataset.plugin = 'dsh-plugin-dir-sync'
      tag.textContent = CSS
      document.head.appendChild(tag)
      return () => {
        tag.remove()
      }
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        // Everything below is registered through slots; the shell owns the rest.
        const disposeStyles = insertStyles()
        ctx.effect(() => () => disposeStyles())
        ctx.slots.inject('plugins.row.config', () =>
          ctx.slots.register({ name: 'plugins.row.config', key: ROW_KEY, order: 41 }, SyncSettingsPanel),
        )
        ctx.slots.inject('sidebar.footer.action', () =>
          ctx.slots.register({ name: 'sidebar.footer.action', id: 'dsh-dir-sync', order: 80 }, SyncNowAction),
        )
      },
    }
  },
})
