/**
 * dsh-quick-run — host half.
 *
 * Serves the Run configurations API used by the conversation-header widget:
 *
 *   POST /dsh-quick-run/api/config.list   { sessionId }                 -> { cwd, configFile, exists, configs }
 *   POST /dsh-quick-run/api/config.save   { sessionId, text }           -> same shape (writes <cwd>/.dsh-quick-run.json)
 *   POST /dsh-quick-run/api/run.start     { sessionId, configId }       -> { runId, configId, name }
 *   POST /dsh-quick-run/api/run.poll      { runId, offset }             -> { chunk, offset, state, code, ... }
 *   POST /dsh-quick-run/api/run.stop      { runId }                     -> { ok }
 *   POST /dsh-quick-run/api/run.active    { sessionId }                 -> { run | null }
 *
 * Runs are plain child processes inside the Session working directory. Output is
 * kept in a bounded in-memory buffer and streamed to the client by offset, so the
 * panel shows live output without touching the Session log.
 */

import { spawn } from 'node:child_process'
import { readFile, readdir, unlink, writeFile } from 'node:fs/promises'
import { StringDecoder } from 'node:string_decoder'
import { isAbsolute, join, normalize, resolve } from 'node:path'

const API_PATH = '/dsh-quick-run/api'
const CONFIG_FILE = '.dsh-quick-run.json'
const MAX_TEXT = 200 * 1024
const MAX_RUNS = 20
const RUN_TTL_MS = 10 * 60 * 1000

export const inject = ['webServer', 'sessions', 'workingDirectory']

/** An API failure carrying the HTTP status the client should see. */
class RunError extends Error {
  constructor(code, message, status = 400) {
    super(message)
    this.code = code
    this.status = status
  }
}

const RUNS = new Map()

function send(res, status, value) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(value))
}

function sendError(res, error) {
  const known = error instanceof RunError ? error : new RunError('internal', error instanceof Error ? error.message : String(error), 500)
  send(res, known.status, { ok: false, error: { code: known.code, message: known.message } })
}

async function readBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += value.length
    if (size > 512 * 1024) throw new RunError('too-large', '请求体太大', 413)
    chunks.push(value)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  if (text.trim() === '') return {}
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new RunError('bad-json', '请求体不是合法的 JSON')
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new RunError('bad-json', '请求体必须是 JSON 对象')
  return parsed
}

function stringField(body, key) {
  const value = body[key]
  if (typeof value !== 'string' || value === '') throw new RunError('bad-request', `${key} 必须是非空字符串`)
  return value
}

/**
 * Reuse Harness authentication and its Host/Origin fence when the service is present.
 * `ctx.get` is used instead of `ctx.connection`: Cordis throws `cannot get property
 * "connection" without inject` for an undeclared service, and `connection` stays
 * optional so the plugin also loads where the fence is not mounted.
 */
function authorize(ctx, req, res) {
  let connection
  try {
    connection = typeof ctx.get === 'function' ? ctx.get('connection') : undefined
  } catch {
    connection = undefined
  }
  if (!connection || typeof connection.requestRejection !== 'function') return true
  const rejection = connection.requestRejection(req)
  if (rejection === undefined) return true
  send(res, rejection, { ok: false, error: { code: rejection === 401 ? 'unauthorized' : 'forbidden', message: '未授权' } })
  return false
}

/** Resolve the Session working directory, which is the base every config runs from. */
function cwdOf(ctx, sessionId) {
  const session = ctx.sessions.get(sessionId)
  if (session === undefined) throw new RunError('session-not-found', '找不到这个会话', 404)
  const cwd = ctx.workingDirectory.get(session)
  if (typeof cwd !== 'string' || !isAbsolute(cwd)) throw new RunError('cwd-invalid', '会话的工作目录还不是一个绝对路径', 409)
  return normalize(cwd)
}

// ── config model ──────────────────────────────────────────────────────────────

function slugOf(name, fallback) {
  const slug = String(name)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug === '' ? fallback : slug
}

/** Turn a script filename into the shell command that runs it. */
function scriptCommand(file) {
  const lower = file.toLowerCase()
  const quoted = /\s/.test(file) ? `"${file}"` : file
  if (lower.endsWith('.ps1')) return `powershell -NoProfile -ExecutionPolicy Bypass -File ${quoted}`
  if (lower.endsWith('.bat') || lower.endsWith('.cmd')) return quoted
  if (lower.endsWith('.sh')) return `bash ${quoted}`
  return quoted
}

/**
 * Normalize one entry from .dsh-quick-run.json (or one discovered entry).
 * Accepts { command } (run through a shell) or { program, args } (exec directly).
 */
function normalizeConfig(raw, index, seen) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new RunError('bad-config', `configs[${index}] 必须是对象`)
  }
  const name = typeof raw.name === 'string' && raw.name.trim() !== '' ? raw.name.trim() : undefined
  let command
  let program
  let args
  if (typeof raw.command === 'string' && raw.command.trim() !== '') {
    command = raw.command.trim()
  } else if (typeof raw.script === 'string' && raw.script.trim() !== '') {
    command = scriptCommand(raw.script.trim())
  } else if (typeof raw.program === 'string' && raw.program.trim() !== '') {
    program = raw.program.trim()
    args = Array.isArray(raw.args) ? raw.args.map(String) : []
  } else {
    throw new RunError('bad-config', `configs[${index}] 需要 command / script / program 之一`)
  }
  const label = name ?? (command ?? `${program} ${args.join(' ')}`).slice(0, 48)
  let id = typeof raw.id === 'string' && raw.id.trim() !== '' ? raw.id.trim() : slugOf(label, `config-${index + 1}`)
  if (seen.has(id)) {
    let n = 2
    while (seen.has(`${id}-${n}`)) n += 1
    id = `${id}-${n}`
  }
  seen.add(id)
  const config = {
    id,
    name: label,
    cwd: typeof raw.cwd === 'string' && raw.cwd !== '' ? raw.cwd : undefined,
    env: raw.env !== null && typeof raw.env === 'object' && !Array.isArray(raw.env) ? Object.fromEntries(Object.entries(raw.env).map(([k, v]) => [k, String(v)])) : undefined,
    shell: raw.shell === false ? false : undefined,
    command,
    program,
    args,
  }
  config.detail = command !== undefined ? command : `${program} ${args.join(' ')}`.trim()
  return config
}

function publicConfig(config) {
  return { id: config.id, name: config.name, detail: config.detail ?? '', cwd: config.cwd ?? '' }
}

function normalizeFileConfigs(value) {
  const list = Array.isArray(value) ? value : value !== null && typeof value === 'object' ? value.configs : undefined
  if (!Array.isArray(list)) throw new RunError('bad-config', '配置里需要有 configs 数组')
  const seen = new Set()
  return list.map((raw, index) => normalizeConfig(raw, index, seen))
}

// ── discovery (used only when the workspace has no .dsh-quick-run.json) ─────────────

const SCRIPT_EXT = /\.(ps1|bat|cmd|sh)$/i

async function discover(cwd) {
  const out = []
  let entries = []
  try {
    entries = await readdir(cwd, { withFileTypes: true })
  } catch {
    entries = []
  }
  // package.json scripts first: the most common "run something" entry point.
  const packageEntry = entries.find(entry => entry.isFile() && entry.name === 'package.json')
  if (packageEntry !== undefined) {
    try {
      const parsed = JSON.parse(await readFile(join(cwd, 'package.json'), 'utf8'))
      const scripts = parsed !== null && typeof parsed === 'object' && parsed.scripts !== null && typeof parsed.scripts === 'object' ? parsed.scripts : {}
      for (const key of Object.keys(scripts)) {
        out.push({ id: `npm-${slugOf(key, key)}`, name: `npm: ${key}`, command: `npm run ${key}`, group: 'package.json' })
      }
    } catch {
      // A broken package.json is not our error to surface here.
    }
  }
  const scripts = entries
    .filter(entry => entry.isFile() && SCRIPT_EXT.test(entry.name))
    .map(entry => entry.name)
    .sort((a, b) => a.localeCompare(b))
  for (const file of scripts) {
    out.push({ id: `script-${slugOf(file, file)}`, name: file, command: scriptCommand(file), group: 'scripts' })
  }
  const seen = new Set()
  const configs = []
  for (const [index, raw] of out.entries()) {
    try {
      const config = normalizeConfig({ ...raw, id: undefined }, index, seen)
      config.group = raw.group
      configs.push(config)
    } catch {
      // Skip entries that cannot be represented.
    }
  }
  return configs
}

async function resolveConfigs(cwd) {
  const file = join(cwd, CONFIG_FILE)
  let text
  try {
    text = await readFile(file, 'utf8')
  } catch {
    text = undefined
  }
  if (text !== undefined) {
    let parsed
    try {
      parsed = JSON.parse(text)
    } catch (error) {
      throw new RunError('bad-config', `${CONFIG_FILE} 不是合法的 JSON：${error instanceof Error ? error.message : String(error)}`, 422)
    }
    const configs = normalizeFileConfigs(parsed)
    if (parsed !== null && typeof parsed === 'object' && parsed.includeDiscovered === true) {
      const extra = await discover(cwd)
      const used = new Set(configs.map(config => config.id))
      for (const config of extra) if (!used.has(config.id)) configs.push(config)
    }
    return { cwd, configFile: file, exists: true, configs, text }
  }
  const configs = await discover(cwd)
  return { cwd, configFile: file, exists: false, configs, text: undefined }
}

function listPayload(resolved) {
  const payload = {
    cwd: resolved.cwd,
    configFile: resolved.configFile,
    exists: resolved.exists,
    text: resolved.text ?? '',
    configs: resolved.configs.map(config => ({ ...publicConfig(config), group: config.group ?? '' })),
  }
  return payload
}

// ── runs ──────────────────────────────────────────────────────────────────────

class Run {
  constructor(sessionId, config, cwd) {
    this.id = `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
    this.sessionId = sessionId
    this.configId = config.id
    this.name = config.name
    this.command = config.detail
    this.cwd = config.cwd === undefined ? cwd : resolve(cwd, config.cwd)
    this.state = 'running'
    this.code = null
    this.signal = null
    this.startedAt = Date.now()
    this.endedAt = null
    this.text = ''
    this.base = 0
    this.cleanupTimer = null
  }

  get total() {
    return this.base + this.text.length
  }

  append(value) {
    if (value === '') return
    this.text += value
    const overflow = this.text.length - MAX_TEXT
    if (overflow > 0) {
      this.text = this.text.slice(overflow)
      this.base += overflow
    }
  }

  summary() {
    return {
      runId: this.id,
      configId: this.configId,
      name: this.name,
      command: this.command,
      cwd: this.cwd,
      state: this.state,
      code: this.code,
      signal: this.signal,
      startedAt: this.startedAt,
      endedAt: this.endedAt,
      durationMs: (this.endedAt ?? Date.now()) - this.startedAt,
    }
  }
}

function sweep() {
  const ended = [...RUNS.values()].filter(run => run.state !== 'running').sort((a, b) => (a.endedAt ?? 0) - (b.endedAt ?? 0))
  while (RUNS.size > MAX_RUNS && ended.length > 0) {
    const run = ended.shift()
    RUNS.delete(run.id)
  }
}

function killTree(child) {
  if (child === undefined || child.pid === undefined) return
  if (process.platform === 'win32') {
    try {
      const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
      killer.on('error', () => {})
    } catch {
      // ignore: the process may already be gone
    }
    return
  }
  try {
    process.kill(-child.pid, 'SIGTERM')
  } catch {
    try {
      child.kill('SIGTERM')
    } catch {
      // ignore
    }
  }
}

function startRun(ctx, sessionId, configId) {
  const cwd = cwdOf(ctx, sessionId)
  return resolveConfigs(cwd).then(resolved => {
    const config = resolved.configs.find(candidate => candidate.id === configId)
    if (config === undefined) throw new RunError('unknown-config', `找不到运行配置「${configId}」，可能在别的目录或已被改掉`, 404)
    for (const existing of RUNS.values()) {
      if (existing.sessionId === sessionId && existing.configId === configId && existing.state === 'running') {
        return { runId: existing.id, configId, name: existing.name, reused: true }
      }
    }
    const run = new Run(sessionId, config, cwd)
    RUNS.set(run.id, run)
    sweep()

    const env = { ...process.env, ...(config.env ?? {}) }
    const stdio = ['ignore', 'pipe', 'pipe']
    const options = { cwd: run.cwd, env, windowsHide: true, stdio }
    let child
    try {
      if (config.program !== undefined) {
        child = spawn(config.program, config.args ?? [], options)
      } else if (process.platform === 'win32' && config.shell !== false) {
        const shell = process.env.ComSpec ?? 'cmd.exe'
        child = spawn(shell, ['/d', '/s', '/c', `chcp 65001>nul & ${config.command}`], options)
      } else if (config.shell === false) {
        child = spawn(config.command, [], { ...options, shell: false })
      } else {
        child = spawn(config.command, { ...options, shell: true, detached: process.platform !== 'win32' })
      }
    } catch (error) {
      run.state = 'failed'
      run.endedAt = Date.now()
      run.append(`启动失败：${error instanceof Error ? error.message : String(error)}\n`)
      return { runId: run.id, configId, name: run.name }
    }
    run.child = child

    const outDecoder = new StringDecoder('utf8')
    const errDecoder = new StringDecoder('utf8')
    child.stdout?.on('data', chunk => { run.append(outDecoder.write(chunk)) })
    child.stderr?.on('data', chunk => { run.append(errDecoder.write(chunk)) })
    child.on('error', error => {
      run.state = 'failed'
      run.endedAt = Date.now()
      run.append(`\n[启动失败] ${error instanceof Error ? error.message : String(error)}\n`)
    })
    child.on('close', (code, signal) => {
      run.append(outDecoder.end())
      run.append(errDecoder.end())
      if (run.state === 'running') {
        run.state = 'exited'
        run.code = code
        run.signal = signal
      } else if (run.state === 'stopping') {
        run.state = 'stopped'
        run.code = code
        run.signal = signal
      }
      run.endedAt = Date.now()
      if (run.cleanupTimer !== null) clearTimeout(run.cleanupTimer)
      run.cleanupTimer = setTimeout(() => RUNS.delete(run.id), RUN_TTL_MS)
      if (typeof run.cleanupTimer.unref === 'function') run.cleanupTimer.unref()
    })
    run.append(`$ ${config.detail}\n`)
    return { runId: run.id, configId, name: run.name }
  })
}

function pollRun(runId, offset) {
  const run = RUNS.get(runId)
  if (run === undefined) throw new RunError('run-gone', '这次运行已经结束并清理了', 404)
  let from = Number.isFinite(offset) ? Math.max(0, Math.floor(offset)) : 0
  let truncated = false
  if (from < run.base) {
    from = run.base
    truncated = true
  }
  const chunk = run.text.slice(from - run.base)
  return { ...run.summary(), chunk, offset: run.total, truncated }
}

function stopRun(runId) {
  const run = RUNS.get(runId)
  if (run === undefined) throw new RunError('run-gone', '这次运行已经结束并清理了', 404)
  if (run.state !== 'running') return { ok: true, state: run.state }
  run.state = 'stopping'
  killTree(run.child)
  const timer = setTimeout(() => {
    if (run.state === 'stopping') {
      run.state = 'stopped'
      run.endedAt = Date.now()
    }
  }, 4000)
  if (typeof timer.unref === 'function') timer.unref()
  return { ok: true, state: 'stopping' }
}

/**
 * The latest run of a Session, whatever state it is in. The widget uses this to
 * pick up a run that is still going (or one that just finished) after a remount.
 */
function activeRun(sessionId) {
  let latest
  for (const run of RUNS.values()) {
    if (run.sessionId !== sessionId) continue
    if (latest === undefined || run.startedAt > latest.startedAt) latest = run
  }
  return { run: latest === undefined ? null : latest.summary() }
}

// ── routes ────────────────────────────────────────────────────────────────────

async function dispatch(ctx, method, body) {
  switch (method) {
    case 'config.list':
      return listPayload(await resolveConfigs(cwdOf(ctx, stringField(body, 'sessionId'))))
    case 'config.save': {
      const sessionId = stringField(body, 'sessionId')
      const text = typeof body.text === 'string' ? body.text : ''
      const cwd = cwdOf(ctx, sessionId)
      let parsed
      try {
        parsed = JSON.parse(text)
      } catch (error) {
        throw new RunError('bad-json', `不是合法的 JSON：${error instanceof Error ? error.message : String(error)}`, 422)
      }
      const configs = normalizeFileConfigs(parsed)
      const payload = { version: 1, configs }
      if (parsed !== null && typeof parsed === 'object' && parsed.includeDiscovered === true) payload.includeDiscovered = true
      await writeFile(join(cwd, CONFIG_FILE), `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
      return listPayload(await resolveConfigs(cwd))
    }
    case 'config.reset': {
      const cwd = cwdOf(ctx, stringField(body, 'sessionId'))
      try {
        await unlink(join(cwd, CONFIG_FILE))
      } catch (error) {
        if (error === null || typeof error !== 'object' || error.code !== 'ENOENT') throw error
      }
      return listPayload(await resolveConfigs(cwd))
    }
    case 'run.start':
      return startRun(ctx, stringField(body, 'sessionId'), stringField(body, 'configId'))
    case 'run.poll': {
      const offset = typeof body.offset === 'number' ? body.offset : 0
      return pollRun(stringField(body, 'runId'), offset)
    }
    case 'run.stop':
      return stopRun(stringField(body, 'runId'))
    case 'run.active':
      return activeRun(stringField(body, 'sessionId'))
    default:
      throw new RunError('not-found', `未知的接口 ${method}`, 404)
  }
}

export function apply(ctx) {
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: API_PATH,
    handler: async (req, res) => {
      try {
        if (!authorize(ctx, req, res)) return
        if (req.method !== 'POST') {
          send(res, 405, { ok: false, error: { code: 'method', message: '只接受 POST' } })
          return
        }
        const path = new URL(req.url ?? '/', 'http://dsh.local').pathname
        const method = path.slice(API_PATH.length).replace(/^\/+/, '')
        const body = await readBody(req)
        send(res, 200, { ok: true, value: await dispatch(ctx, method, body) })
      } catch (error) {
        // Never let a throw escape: the transport answers an escaped handler with a
        // bare 400, which hides the reason from the client and from the log file.
        if (!res.headersSent) sendError(res, error)
        else res.destroy()
      }
    },
  }), 'dsh-quick-run: run configuration api')
}
