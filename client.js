/**
 * dsh-quick-run — client half.
 *
 * 会话标题栏右侧（conversation.session.header.utilities）的「运行配置」小部件：
 * 下拉选配置 → ▶ 一键运行 → 浮层面板里看实时输出。配置默认来自会话工作目录里
 * 自动发现的 npm scripts / 脚本文件，也可以在面板里编辑 <cwd>/.dsh-quick-run.json 固定下来。
 *
 * 数据都走同源 HTTP（host 半边见 index.js）：POST /dsh-quick-run/api/*
 */

window.__ModuleLoader__.load({
  id: 'dsh-quick-run',
  factory(require) {
    const react = require('react')
    const { useState, useEffect, useRef, useCallback } = react
    const h = react.createElement

    const NS = 'dsh-quick-run'
    const API = '/dsh-quick-run/api/'
    const LAST_KEY = 'dsh-quick-run:last'
    const MAX_OUTPUT = 400 * 1000
    const POLL_MS = 350

    const ZH = {
      config: '运行配置',
      run: '运行',
      runTip: '运行当前配置',
      stop: '停止',
      stopTip: '停止运行',
      menuTip: '选择运行配置',
      viewOutput: '查看运行输出',
      edit: '编辑配置…',
      refresh: '刷新',
      reset: '重置为自动发现',
      resetConfirm: '删掉 .dsh-quick-run.json，回到自动发现？',
      resetDone: '已回到自动发现',
      noConfigs: '没有运行配置',
      emptyTitle: '还没有可运行的配置',
      emptyHint: '在这个目录里放 npm scripts、或者 .ps1 / .bat / .cmd / .sh 脚本，会自动出现在这里；也可以在 .dsh-quick-run.json 里写死。',
      autoHint: '自动发现 · 写 .dsh-quick-run.json 可自定义',
      fixedHint: '来自 .dsh-quick-run.json',
      directory: '目录',
      statusRunning: '运行中',
      statusStopping: '正在停止',
      statusStopped: '已停止',
      statusFailed: '启动失败',
      statusGone: '运行已结束并清理',
      statusOk: '完成',
      statusFail: '失败（退出码 {code}）',
      statusCode: '退出码 {code}',
      lastRun: '上次运行：{name}',
      waiting: '等输出…',
      clear: '清空',
      close: '关闭',
      save: '保存',
      cancel: '取消',
      saving: '保存中…',
      output: '运行输出',
      editorTitle: '编辑 .dsh-quick-run.json',
      editorHint: 'configs 数组，每项 { name, command }（走 shell）或 { name, script }（.ps1 / .bat / .cmd / .sh）或 { name, program, args }（直接执行）。可选 cwd、env。',
      editorPlaceholder: '{\n  "configs": [\n    { "name": "启动", "command": "npm run dev" }\n  ]\n}',
      saveFailed: '保存失败',
      copyHint: '配置路径',
    }

    const EN = {
      config: 'Run configuration',
      run: 'Run',
      runTip: 'Run the selected configuration',
      stop: 'Stop',
      stopTip: 'Stop the running process',
      menuTip: 'Choose a run configuration',
      viewOutput: 'Show run output',
      edit: 'Edit configurations…',
      refresh: 'Refresh',
      reset: 'Reset to discovery',
      resetConfirm: 'Delete .dsh-quick-run.json and go back to auto-discovery?',
      resetDone: 'Back to auto-discovery',
      noConfigs: 'No run configuration',
      emptyTitle: 'No runnable configuration yet',
      emptyHint: 'Put npm scripts or .ps1 / .bat / .cmd / .sh scripts in this directory and they show up here, or pin them in .dsh-quick-run.json.',
      autoHint: 'Auto-discovered · write .dsh-quick-run.json to customize',
      fixedHint: 'From .dsh-quick-run.json',
      directory: 'Directory',
      statusRunning: 'Running',
      statusStopping: 'Stopping',
      statusStopped: 'Stopped',
      statusFailed: 'Failed to start',
      statusGone: 'Run finished and was cleaned up',
      statusOk: 'Done',
      statusFail: 'Failed (exit {code})',
      statusCode: 'exit {code}',
      lastRun: 'Last run: {name}',
      waiting: 'Waiting for output…',
      clear: 'Clear',
      close: 'Close',
      save: 'Save',
      cancel: 'Cancel',
      saving: 'Saving…',
      output: 'Run output',
      editorTitle: 'Edit .dsh-quick-run.json',
      editorHint: 'A configs array. Each item is { name, command } (through a shell), { name, script } (.ps1 / .bat / .cmd / .sh) or { name, program, args } (exec directly). Optional cwd and env.',
      editorPlaceholder: '{\n  "configs": [\n    { "name": "dev", "command": "npm run dev" }\n  ]\n}',
      saveFailed: 'Could not save',
      copyHint: 'Config file',
    }

    const TEMPLATE = `${JSON.stringify({
      configs: [
        { name: '启动', command: 'npm run dev' },
        { name: '构建', command: 'npm run build' },
      ],
    }, null, 2)}\n`

    function makeT(ctx) {
      let bound = null
      try {
        bound = ctx.locale && typeof ctx.locale.bind === 'function' ? ctx.locale.bind(NS) : null
      } catch {
        bound = null
      }
      return (key, vars) => {
        let text = ''
        try {
          text = bound ? bound(key) : ''
        } catch {
          text = ''
        }
        if (!text || text === key || text === `${NS}.${key}`) text = ZH[key] || key
        if (vars) text = text.replace(/\{(\w+)\}/g, (match, name) => (Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : match))
        return text
      }
    }

    // ── 样式（跟 DSH 设计变量走，深浅主题自动适配）────────────────────────────

    const STYLES = `
.drc-wrap{position:relative;display:inline-flex;align-items:center;min-width:0}
.drc-widget{display:inline-flex;align-items:center;min-width:0;max-width:230px;height:28px;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.28));border-radius:var(--dsw-radius-md,8px);background:transparent;overflow:hidden}
.drc-widget:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12))}
.drc-run,.drc-name{border:0;background:transparent;color:var(--dsw-alias-label-secondary,#8a8a8a);cursor:pointer;display:inline-flex;align-items:center;font:inherit;height:26px;padding:0}
.drc-run{width:26px;justify-content:center;flex:0 0 auto}
.drc-name{gap:4px;min-width:0;padding:0 7px 0 0;flex:0 1 auto}
.drc-run:hover,.drc-name:hover{color:var(--dsw-alias-label-primary,#e6e6e6)}
.drc-run svg{width:13px;height:13px;flex:0 0 auto}
.drc-chev{width:11px;height:11px;flex:0 0 auto;opacity:.7}
.drc-name-text{font-size:12px;line-height:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}
.drc-live .drc-run{color:var(--dsw-alias-accent-primary,#4d6bfe)}
.drc-live .drc-run svg{animation:drc-pulse 1.5s ease-in-out infinite}
@keyframes drc-pulse{0%,100%{opacity:1}50%{opacity:.4}}
.drc-float{display:contents}
.drc-menu{position:fixed;z-index:2147483000;box-sizing:border-box;width:340px;max-width:calc(100vw - 24px);max-height:min(62vh,520px);overflow:auto;padding:6px;border-radius:12px;background:var(--dsw-alias-bg-layer-1,#26282c);border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.26));box-shadow:0 14px 36px rgba(0,0,0,.28),0 2px 8px rgba(0,0,0,.12);color:var(--dsw-alias-label-primary,#e6e6e6)}
.drc-mi{display:flex;align-items:center;gap:8px;width:100%;box-sizing:border-box;border:0;background:transparent;color:inherit;font:inherit;text-align:left;padding:7px 8px;border-radius:8px;cursor:pointer}
.drc-mi:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.14))}
.drc-mi-current{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.1))}
.drc-mi-dot{width:13px;flex:0 0 auto;display:inline-flex;justify-content:center;color:var(--dsw-alias-accent-primary,#4d6bfe)}
.drc-mi-body{min-width:0;flex:1 1 auto;display:flex;flex-direction:column;gap:1px}
.drc-mi-name{font-size:13px;line-height:1.35;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.drc-mi-detail{font-size:11px;line-height:1.35;color:var(--dsw-alias-label-tertiary,#7d7d7d);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
.drc-mi-go{width:22px;height:22px;flex:0 0 auto;display:inline-flex;align-items:center;justify-content:center;border-radius:6px;color:var(--dsw-alias-label-tertiary,#7d7d7d);opacity:0}
.drc-mi:hover .drc-mi-go{opacity:1}
.drc-mi-go svg{width:11px;height:11px}
.drc-sep{height:1px;margin:5px 4px;background:var(--dsw-alias-border-l2,rgba(127,127,127,.2))}
.drc-menu-foot{display:flex;align-items:center;gap:4px;padding:2px 2px}
.drc-foot-btn{display:inline-flex;align-items:center;gap:5px;height:26px;padding:0 8px;border:0;border-radius:7px;background:transparent;color:var(--dsw-alias-label-secondary,#8a8a8a);font:inherit;font-size:12px;cursor:pointer}
.drc-foot-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.14));color:var(--dsw-alias-label-primary,#e6e6e6)}
.drc-foot-btn svg{width:12px;height:12px}
.drc-menu-hint{padding:4px 8px 6px;font-size:11px;line-height:1.5;color:var(--dsw-alias-label-tertiary,#7d7d7d);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.drc-empty{padding:10px 8px;font-size:12px;line-height:1.55;color:var(--dsw-alias-label-secondary,#8a8a8a)}
.drc-empty-title{color:var(--dsw-alias-label-primary,#e6e6e6);font-size:13px;margin-bottom:4px}
.drc-panel{position:fixed;z-index:2147483001;box-sizing:border-box;display:flex;flex-direction:column;border-radius:12px;overflow:hidden;background:var(--dsw-alias-bg-layer-1,#26282c);border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.26));box-shadow:0 18px 48px rgba(0,0,0,.32),0 2px 10px rgba(0,0,0,.14);color:var(--dsw-alias-label-primary,#e6e6e6)}
.drc-phead{display:flex;align-items:center;gap:8px;padding:8px 8px 8px 12px;border-bottom:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.2));flex:0 0 auto}
.drc-ptitle{display:flex;align-items:center;gap:7px;min-width:0;flex:1 1 auto}
.drc-pname{font-size:13px;line-height:1.3;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.drc-pstatus{font-size:11px;line-height:1.3;color:var(--dsw-alias-label-tertiary,#7d7d7d);white-space:nowrap;flex:0 0 auto}
.drc-dot{width:7px;height:7px;border-radius:50%;flex:0 0 auto;background:var(--dsw-alias-label-tertiary,#7d7d7d)}
.drc-dot.drc-on{background:var(--dsw-alias-accent-primary,#4d6bfe);animation:drc-pulse 1.5s ease-in-out infinite}
.drc-dot.drc-ok{background:var(--dsw-alias-state-success-primary,#2ea043)}
.drc-dot.drc-bad{background:var(--dsw-alias-state-error-primary,#e5534b)}
.drc-dot.drc-warn{background:var(--dsw-alias-state-warn-primary,#d29922)}
.drc-pactions{display:flex;align-items:center;gap:4px;flex:0 0 auto}
.drc-btn{display:inline-flex;align-items:center;gap:5px;height:26px;padding:0 9px;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.3));border-radius:7px;background:transparent;color:var(--dsw-alias-label-secondary,#8a8a8a);font:inherit;font-size:12px;cursor:pointer}
.drc-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.14));color:var(--dsw-alias-label-primary,#e6e6e6)}
.drc-btn svg{width:12px;height:12px}
.drc-btn-primary{background:var(--dsw-alias-accent-primary,#4d6bfe);border-color:transparent;color:#fff}
.drc-btn-primary:hover{background:var(--dsw-alias-accent-primary,#4d6bfe);color:#fff;opacity:.9}
.drc-btn:disabled{opacity:.5;cursor:default}
.drc-x{width:26px;justify-content:center;padding:0;font-size:15px;line-height:1}
.drc-out{margin:0;padding:10px 12px;flex:1 1 auto;min-height:80px;max-height:calc(62vh - 46px);overflow:auto;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,'Cascadia Mono',monospace;font-size:12px;line-height:1.5;white-space:pre-wrap;word-break:break-word;background:var(--dsw-alias-bg-base,rgba(0,0,0,.22));color:var(--dsw-alias-label-primary,#e6e6e6);tab-size:4}
.drc-out.drc-editor{background:transparent;padding:10px 12px 4px}
.drc-muted{color:var(--dsw-alias-label-tertiary,#7d7d7d)}
.drc-textarea{width:100%;box-sizing:border-box;min-height:190px;flex:1 1 auto;resize:vertical;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.3));border-radius:8px;background:var(--dsw-alias-bg-base,rgba(0,0,0,.2));color:var(--dsw-alias-label-primary,#e6e6e6);font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;line-height:1.55;padding:8px 10px;outline:none}
.drc-textarea:focus{border-color:var(--dsw-alias-accent-primary,#4d6bfe)}
.drc-pbody{display:flex;flex-direction:column;gap:8px;padding:10px 12px;flex:1 1 auto;min-height:0}
.drc-pfoot{display:flex;align-items:center;gap:8px;padding:8px 12px 10px;flex:0 0 auto}
.drc-pfoot .drc-grow{flex:1 1 auto}
.drc-note{padding:6px 12px;font-size:11px;line-height:1.5;color:var(--dsw-alias-state-error-primary,#e5534b);border-top:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.2))}
.drc-toast{position:fixed;z-index:2147483002;max-width:320px;padding:7px 10px;border-radius:8px;font-size:12px;line-height:1.5;background:var(--dsw-alias-bg-layer-1,#26282c);border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.26));box-shadow:0 10px 28px rgba(0,0,0,.28);color:var(--dsw-alias-label-primary,#e6e6e6)}
`

    function ensureStyle() {
      const id = `${NS}:styles`
      const existing = document.getElementById(id)
      let node = existing
      if (node === null) {
        node = document.createElement('style')
        node.id = id
        document.head.appendChild(node)
      }
      if (node.textContent !== STYLES) node.textContent = STYLES
      return () => {
        if (node !== null && node.parentNode !== null) node.parentNode.removeChild(node)
      }
    }

    // ── HTTP ─────────────────────────────────────────────────────────────────

    async function call(method, body) {
      const response = await fetch(API + method, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body ?? {}),
      })
      let payload = null
      try {
        payload = await response.json()
      } catch {
        payload = null
      }
      if (payload === null || payload.ok !== true) {
        const message = payload && payload.error && payload.error.message ? payload.error.message : `请求失败（${response.status}）`
        throw new Error(message)
      }
      return payload.value
    }

    function fmtDuration(ms) {
      if (typeof ms !== 'number' || ms < 0) return ''
      if (ms < 1000) return `${Math.round(ms)}ms`
      if (ms < 60000) return `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)}s`
      const minutes = Math.floor(ms / 60000)
      const seconds = Math.round((ms % 60000) / 1000)
      return `${minutes}m ${String(seconds).padStart(2, '0')}s`
    }

    // ── 图标 ─────────────────────────────────────────────────────────────────

    function IconPlay() {
      return h('svg', { viewBox: '0 0 16 16', fill: 'currentColor', 'aria-hidden': 'true' }, h('path', { d: 'M4.5 3.2c0-.5.5-.8.9-.5l7.1 4.8c.4.3.4.8 0 1l-7.1 4.8c-.4.3-.9 0-.9-.5z' }))
    }

    function IconStop() {
      return h('svg', { viewBox: '0 0 16 16', fill: 'currentColor', 'aria-hidden': 'true' }, h('rect', { x: 4, y: 4, width: 8, height: 8, rx: 1.4 }))
    }

    function IconChevron() {
      return h('svg', { className: 'drc-chev', viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true' }, h('path', { d: 'M4.5 6.5L8 10l3.5-3.5' }))
    }

    function IconEdit() {
      return h('svg', { viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true' }, h('path', { d: 'M3 13h3l7-7a1.5 1.5 0 0 0-3-3l-7 7z' }))
    }

    function IconRefresh() {
      return h('svg', { viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true' }, h('path', { d: 'M13 8a5 5 0 1 1-1.5-3.5M13 3v2.5h-2.5' }))
    }

    function IconDot() {
      return h('svg', { viewBox: '0 0 16 16', fill: 'currentColor', 'aria-hidden': 'true' }, h('circle', { cx: 8, cy: 8, r: 3 }))
    }

    // ── 小部件 ───────────────────────────────────────────────────────────────

    function statusOf(run, t) {
      if (run === null) return ''
      switch (run.state) {
        case 'running':
          return t('statusRunning')
        case 'stopping':
          return t('statusStopping')
        case 'stopped':
          return t('statusStopped')
        case 'failed':
          return t('statusFailed')
        case 'gone':
          return t('statusGone')
        default:
          return run.code === 0 ? t('statusOk') : run.code === null || run.code === undefined ? t('statusOk') : t('statusFail', { code: run.code })
      }
    }

    function statusClass(run) {
      if (run === null) return ''
      if (run.state === 'running' || run.state === 'stopping') return 'drc-on'
      if (run.state === 'failed' || run.state === 'stopped') return 'drc-bad'
      if (run.state === 'gone') return 'drc-warn'
      return run.code === 0 || run.code === null || run.code === undefined ? 'drc-ok' : 'drc-bad'
    }

    function RunConfigWidget(props) {
      const sid = props.sid || props.sessionId
      const t = props.t || ((key) => key)

      const [snapshot, setSnapshot] = useState(null)
      const [loadError, setLoadError] = useState('')
      const [selectedId, setSelectedId] = useState('')
      const [menuOpen, setMenuOpen] = useState(false)
      const [panel, setPanel] = useState(null)
      const [anchor, setAnchor] = useState(null)
      const [run, setRun] = useState(null)
      const [output, setOutput] = useState('')
      const [editorText, setEditorText] = useState('')
      const [editorError, setEditorError] = useState('')
      const [saving, setSaving] = useState(false)
      const [notice, setNotice] = useState('')
      const [busy, setBusy] = useState(false)

      const wrapRef = useRef(null)
      const floatRef = useRef(null)
      const outputRef = useRef(null)
      const stickRef = useRef(true)
      const offsetRef = useRef(0)
      const configRef = useRef(null)

      useEffect(() => {
        try {
          const saved = localStorage.getItem(LAST_KEY)
          if (typeof saved === 'string' && saved !== '') setSelectedId(saved)
        } catch {
          // ignore storage failures
        }
      }, [])

      const configs = snapshot !== null && Array.isArray(snapshot.configs) ? snapshot.configs : []
      const selected = configs.find((config) => config.id === selectedId) ?? configs[0] ?? null
      configRef.current = selected

      useEffect(() => {
        if (selected !== null && selected.id !== selectedId) setSelectedId(selected.id)
      }, [snapshot])

      const remember = useCallback((id) => {
        try {
          localStorage.setItem(LAST_KEY, id)
        } catch {
          // ignore
        }
      }, [])

      const load = useCallback(async () => {
        if (!sid) return
        try {
          const value = await call('config.list', { sessionId: sid })
          setSnapshot(value)
          setLoadError('')
        } catch (error) {
          setLoadError(error instanceof Error ? error.message : String(error))
        }
      }, [sid])

      useEffect(() => {
        setSnapshot(null)
        setRun(null)
        setOutput('')
        offsetRef.current = 0
        load()
      }, [sid])

      // 会话切回来时把还在跑（或刚跑完）的那次运行捡回来
      useEffect(() => {
        if (!sid) return
        let alive = true
        call('run.active', { sessionId: sid })
          .then((value) => {
            if (!alive || value === null || value.run === undefined || value.run === null) return
            setRun((previous) => (previous === null ? value.run : previous))
          })
          .catch(() => {})
        return () => {
          alive = false
        }
      }, [sid])

      const measure = useCallback(() => {
        const element = wrapRef.current
        if (element === null) return null
        const rect = element.getBoundingClientRect()
        setAnchor({ right: rect.right, bottom: rect.bottom, left: rect.left })
        return rect
      }, [])

      const openMenu = useCallback(() => {
        measure()
        setMenuOpen(true)
        setPanel((current) => (current === 'editor' ? current : null))
        load()
      }, [load, measure])

      const openEditor = useCallback(() => {
        measure()
        setMenuOpen(false)
        setEditorError('')
        const text = snapshot !== null && typeof snapshot.text === 'string' && snapshot.text !== '' ? snapshot.text : TEMPLATE
        setEditorText(text)
        setPanel('editor')
      }, [measure, snapshot])

      // 点外面关掉下拉
      useEffect(() => {
        if (!menuOpen) return
        const onPointer = (event) => {
          const target = event.target
          if (wrapRef.current !== null && wrapRef.current.contains(target)) return
          if (floatRef.current !== null && floatRef.current.contains(target)) return
          setMenuOpen(false)
        }
        const onKey = (event) => {
          if (event.key === 'Escape') setMenuOpen(false)
        }
        window.addEventListener('pointerdown', onPointer, true)
        window.addEventListener('keydown', onKey)
        return () => {
          window.removeEventListener('pointerdown', onPointer, true)
          window.removeEventListener('keydown', onKey)
        }
      }, [menuOpen])

      useEffect(() => {
        if (panel === null) return
        const onKey = (event) => {
          if (event.key === 'Escape') {
            setPanel(null)
          }
        }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
      }, [panel])

      useEffect(() => {
        if (notice === '') return
        const timer = setTimeout(() => setNotice(''), 6000)
        return () => clearTimeout(timer)
      }, [notice])

      const running = run !== null && (run.state === 'running' || run.state === 'stopping')

      const startWith = useCallback(async (config) => {
        if (!sid || config === null) {
          setEditorError('')
          openEditor()
          return
        }
        if (busy) return
        setBusy(true)
        setNotice('')
        try {
          const value = await call('run.start', { sessionId: sid, configId: config.id })
          offsetRef.current = 0
          setOutput('')
          setRun({ runId: value.runId, name: value.name, configId: value.configId, state: 'running', code: null, durationMs: 0 })
          setMenuOpen(false)
          setPanel('output')
        } catch (error) {
          setNotice(error instanceof Error ? error.message : String(error))
        } finally {
          setBusy(false)
        }
      }, [busy, openEditor, sid])

      const start = useCallback(() => {
        if (running) return
        startWith(configRef.current)
      }, [running, startWith])

      const stop = useCallback(async () => {
        if (run === null) return
        try {
          await call('run.stop', { runId: run.runId })
          setRun((previous) => (previous === null ? previous : { ...previous, state: 'stopping' }))
        } catch (error) {
          setNotice(error instanceof Error ? error.message : String(error))
        }
      }, [run])

      // 轮询输出
      const active = run !== null && (run.state === 'running' || run.state === 'stopping')
      useEffect(() => {
        if (!active || run === null) return
        let cancelled = false
        let timer = null
        const tick = async () => {
          try {
            const value = await call('run.poll', { runId: run.runId, offset: offsetRef.current })
            if (cancelled) return
            offsetRef.current = value.offset
            if (typeof value.chunk === 'string' && value.chunk !== '') {
              setOutput((previous) => {
                const next = previous + value.chunk
                return next.length > MAX_OUTPUT ? next.slice(next.length - MAX_OUTPUT) : next
              })
            }
            setRun((previous) => (previous === null ? previous : { ...previous, state: value.state, code: value.code, signal: value.signal, durationMs: value.durationMs, name: value.name }))
            if (value.state === 'running' || value.state === 'stopping') timer = setTimeout(tick, POLL_MS)
          } catch (error) {
            if (cancelled) return
            setRun((previous) => (previous === null ? previous : { ...previous, state: 'gone' }))
            setNotice(error instanceof Error ? error.message : String(error))
          }
        }
        tick()
        return () => {
          cancelled = true
          if (timer !== null) clearTimeout(timer)
        }
      }, [active, run === null ? null : run.runId])

      useEffect(() => {
        const element = outputRef.current
        if (element === null) return
        if (stickRef.current) element.scrollTop = element.scrollHeight
      }, [output, panel])

      const onScroll = useCallback(() => {
        const element = outputRef.current
        if (element === null) return
        stickRef.current = element.scrollHeight - element.scrollTop - element.clientHeight < 28
      }, [])

      const save = useCallback(async () => {
        if (!sid || saving) return
        setSaving(true)
        setEditorError('')
        try {
          const value = await call('config.save', { sessionId: sid, text: editorText })
          setSnapshot(value)
          setPanel(null)
          const next = Array.isArray(value.configs) && value.configs.length > 0 ? value.configs[0].id : ''
          setSelectedId((previous) => (Array.isArray(value.configs) && value.configs.some((config) => config.id === previous) ? previous : next))
          setNotice('')
        } catch (error) {
          setEditorError(error instanceof Error ? error.message : String(error))
        } finally {
          setSaving(false)
        }
      }, [editorText, saving, sid])

      const resetFile = useCallback(async () => {
        if (!sid) return
        if (!window.confirm(t('resetConfirm'))) return
        try {
          const value = await call('config.reset', { sessionId: sid })
          setSnapshot(value)
          setMenuOpen(false)
          setNotice(t('resetDone'))
        } catch (error) {
          setNotice(error instanceof Error ? error.message : String(error))
        }
      }, [sid, t])

      const rect = anchor
      const right = rect === null ? 12 : Math.max(8, window.innerWidth - rect.right)
      const top = rect === null ? 64 : Math.round(rect.bottom + 6)

      const statusText = statusOf(run, t)
      const duration = run !== null && typeof run.durationMs === 'number' ? fmtDuration(run.durationMs) : ''
      const statusLine = statusText === '' ? '' : duration === '' ? statusText : `${statusText} · ${duration}`

      const dotClass = statusClass(run)

      const menu = menuOpen
        ? h('div', { className: 'drc-menu', style: { right, top }, role: 'menu', 'aria-label': t('menuTip') },
          run !== null
            ? h('button', { className: 'drc-mi', role: 'menuitem', onClick: () => { setMenuOpen(false); setPanel('output') } },
              h('span', { className: 'drc-mi-dot' }, h('span', { className: `drc-dot ${dotClass}`, style: { display: 'inline-block' } })),
              h('span', { className: 'drc-mi-body' },
                h('span', { className: 'drc-mi-name' }, t('viewOutput')),
                h('span', { className: 'drc-mi-detail' }, `${run.name}${statusLine === '' ? '' : ` · ${statusLine}`}`)),
              h('span', { className: 'drc-mi-go' }, h(IconPlay)))
            : null,
          run !== null ? h('div', { className: 'drc-sep' }) : null,
          configs.length === 0
            ? h('div', { className: 'drc-empty' },
              h('div', { className: 'drc-empty-title' }, t('emptyTitle')),
              h('div', null, t('emptyHint')))
            : configs.map((config) => h('button', {
              key: config.id,
              className: `drc-mi${config.id === (selected === null ? '' : selected.id) ? ' drc-mi-current' : ''}`,
              role: 'menuitem',
              title: config.detail,
              onClick: () => {
                setSelectedId(config.id)
                remember(config.id)
                startWith(config)
              },
            },
            h('span', { className: 'drc-mi-dot' }, config.id === (selected === null ? '' : selected.id) ? h(IconDot) : null),
            h('span', { className: 'drc-mi-body' },
              h('span', { className: 'drc-mi-name' }, config.name),
              h('span', { className: 'drc-mi-detail' }, config.detail)),
            h('span', { className: 'drc-mi-go' }, h(IconPlay)))),
          h('div', { className: 'drc-sep' }),
          h('div', { className: 'drc-menu-foot' },
            h('button', { className: 'drc-foot-btn', onClick: openEditor }, h(IconEdit), t('edit')),
            h('button', { className: 'drc-foot-btn', onClick: () => { load() } }, h(IconRefresh), t('refresh')),
            snapshot !== null && snapshot.exists === true
              ? h('button', { className: 'drc-foot-btn', onClick: resetFile }, t('reset'))
              : null),
          snapshot !== null
            ? h('div', { className: 'drc-menu-hint', title: snapshot.configFile },
              `${snapshot.exists === true ? t('fixedHint') : t('autoHint')} · ${snapshot.cwd}`)
            : null,
          loadError !== '' ? h('div', { className: 'drc-note' }, loadError) : null)
        : null

      const outputPanel = panel === 'output'
        ? h('section', { className: 'drc-panel', style: { right, top, width: Math.min(680, Math.max(300, window.innerWidth - 24)) }, role: 'dialog', 'aria-label': t('output') },
          h('header', { className: 'drc-phead' },
            h('div', { className: 'drc-ptitle' },
              h('span', { className: `drc-dot ${dotClass}` }),
              h('span', { className: 'drc-pname' }, run === null ? (selected === null ? t('noConfigs') : selected.name) : run.name),
              h('span', { className: 'drc-pstatus' }, statusLine)),
            h('div', { className: 'drc-pactions' },
              running ? h('button', { className: 'drc-btn', onClick: stop }, h(IconStop), t('stop')) : null,
              !running && run !== null ? h('button', { className: 'drc-btn', onClick: () => { setPanel(null); openMenu() } }, t('config')) : null,
              h('button', { className: 'drc-btn', onClick: () => { setOutput(''); stickRef.current = true } }, t('clear')),
              h('button', { className: 'drc-btn drc-x', onClick: () => setPanel(null), title: t('close'), 'aria-label': t('close') }, '×'))),
          h('pre', { className: 'drc-out', ref: outputRef, onScroll, onWheel: onScroll, onKeyDown: onScroll },
            output !== '' ? output : h('span', { className: 'drc-muted' }, t('waiting'))),
          notice !== '' ? h('div', { className: 'drc-note' }, notice) : null)
        : null

      const editorPanel = panel === 'editor'
        ? h('section', { className: 'drc-panel', style: { right, top, width: Math.min(600, Math.max(300, window.innerWidth - 24)) }, role: 'dialog', 'aria-label': t('editorTitle') },
          h('header', { className: 'drc-phead' },
            h('div', { className: 'drc-ptitle' },
              h('span', { className: 'drc-pname' }, t('editorTitle')),
              snapshot !== null ? h('span', { className: 'drc-pstatus', title: snapshot.configFile }, '.dsh-quick-run.json') : null),
            h('div', { className: 'drc-pactions' },
              h('button', { className: 'drc-btn drc-x', onClick: () => setPanel(null), title: t('close'), 'aria-label': t('close') }, '×'))),
          h('div', { className: 'drc-pbody' },
            h('div', { className: 'drc-muted', style: { fontSize: '11px', lineHeight: 1.55 } }, t('editorHint')),
            h('textarea', {
              className: 'drc-textarea',
              spellCheck: false,
              value: editorText,
              placeholder: t('editorPlaceholder'),
              onChange: (event) => setEditorText(event.target.value),
            })),
          editorError !== '' ? h('div', { className: 'drc-note' }, editorError) : null,
          h('footer', { className: 'drc-pfoot' },
            snapshot !== null ? h('span', { className: 'drc-muted drc-grow', style: { fontSize: '11px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }, title: snapshot.configFile }, snapshot.cwd) : h('span', { className: 'drc-grow' }),
            h('button', { className: 'drc-btn', onClick: () => setPanel(null) }, t('cancel')),
            h('button', { className: 'drc-btn drc-btn-primary', disabled: saving, onClick: save }, saving ? t('saving') : t('save'))))
        : null

      const toast = notice !== '' && panel !== 'output'
        ? h('div', { className: 'drc-toast', style: { right, top } }, notice)
        : null

      const name = running ? run.name : selected === null ? t('noConfigs') : selected.name

      return h('div', { className: 'drc-wrap', ref: wrapRef },
        h('div', { className: `drc-widget${running ? ' drc-live' : ''}` },
          h('button', {
            className: 'drc-run',
            title: running ? t('stopTip') : t('runTip'),
            'aria-label': running ? t('stopTip') : t('runTip'),
            onClick: running ? stop : start,
            onMouseDown: (event) => event.preventDefault(),
          }, running ? h(IconStop) : h(IconPlay)),
          h('button', {
            className: 'drc-name',
            title: `${t('menuTip')}${selected !== null ? `\n${selected.detail}` : ''}`,
            'aria-label': t('menuTip'),
            onClick: () => (menuOpen ? setMenuOpen(false) : openMenu()),
            onMouseDown: (event) => event.preventDefault(),
          },
          h('span', { className: 'drc-name-text' }, name),
          h(IconChevron))),
        rect === null ? null : h('div', { className: 'drc-float', ref: floatRef }, menu, outputPanel, editorPanel, toast))
    }

    // ── 注册 ─────────────────────────────────────────────────────────────────

    function apply(ctx) {
      try {
        ctx.effect(() => ensureStyle(), `${NS}: styles`)
      } catch (error) {
        console.warn('[dsh-quick-run] styles', error)
      }
      const t = makeT(ctx)
      try {
        ctx.effect(() => ctx.locale.register(NS, { zh: ZH, en: EN }), `${NS}: copy`)
      } catch (error) {
        console.warn('[dsh-quick-run] locale', error)
      }
      ctx.effect(() => ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({
        name: 'conversation.session.header.utilities',
        id: NS,
        order: -18,
        locale: NS,
        inject: (sessionId) => ({ sid: sessionId, t }),
      }, RunConfigWidget)), `${NS}: header widget`)
    }

    return {
      inject: ['slots', 'locale'],
      apply,
    }
  },
})
