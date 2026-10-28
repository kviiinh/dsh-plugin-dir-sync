/**
 * Host half of `dsh-plugin-dir-sync`.
 *
 * One plugin row owns the whole feature: rule validation, the cron scheduler,
 * the directory copy engine and the HTTP routes the browser half talks to.
 * All state lives in a single JSON file under
 * `<DSH_HOME>/plugin-data/dsh-plugin-dir-sync/rules.json`, so nothing here
 * depends on the profile patch or on private Host APIs.
 *
 * Copy semantics: the *contents* of the source directory are copied into the
 * target directory. Files whose size and mtime already match are skipped, and
 * the optional `mirror` flag deletes entries in the target that no longer
 * exist in the source (only after a copy pass with no errors).
 */
import {
  copyFile,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  utimes,
  writeFile,
} from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, parse as parsePath, relative, resolve } from 'node:path'

export const name = 'dsh-dir-sync'
export const inject = ['webServer']

/** Hard ceiling on how many rule pairs the page and the Host accept. */
const MAX_RULES = 30
/** Requests only ever carry a rule table, so a small cap is plenty. */
const MAX_BODY = 256 * 1024
/** Minute-aligned cron only needs a second of granularity to never miss a slot. */
const TICK_MS = 1000

const ROUTE_STATE = '/plugins-local/dsh-dir-sync/state'
const ROUTE_SAVE = '/plugins-local/dsh-dir-sync/save'
const ROUTE_TOGGLE = '/plugins-local/dsh-dir-sync/toggle'
const ROUTE_RUN = '/plugins-local/dsh-dir-sync/run'
const ROUTE_STATUS = '/plugins-local/dsh-dir-sync/status'

/* -------------------------------------------------------------------------- */
/* cron                                                                       */
/* -------------------------------------------------------------------------- */

const CRON_ALIASES = {
  '@hourly': '0 * * * *',
  '@daily': '0 0 * * *',
  '@midnight': '0 0 * * *',
  '@weekly': '0 0 * * 0',
  '@monthly': '0 0 1 * *',
  '@yearly': '0 0 1 1 *',
  '@annually': '0 0 1 1 *',
}

const MONTH_NAMES = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
const WEEKDAY_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']

const CRON_FIELDS = [
  { key: 'minutes', label: '分', min: 0, max: 59 },
  { key: 'hours', label: '时', min: 0, max: 23 },
  { key: 'days', label: '日', min: 1, max: 31 },
  { key: 'months', label: '月', min: 1, max: 12, names: MONTH_NAMES, namesFrom: 1 },
  { key: 'weekdays', label: '周', min: 0, max: 7, names: WEEKDAY_NAMES, namesFrom: 0 },
]

/**
 * Parse one cron field (`*`, `a`, `a-b`, `*\/n`, `a/n`, comma separated).
 * @param {string} text
 * @param {{ label: string, min: number, max: number, names?: string[], namesFrom?: number }} field
 * @returns {Set<number>}
 */
function parseCronField(text, field) {
  const values = new Set()
  for (const part of text.split(',')) {
    if (part === '') {
      throw new Error(`cron 的「${field.label}」段有空项：${text}`)
    }
    const segments = part.split('/')
    if (segments.length > 2) {
      throw new Error(`cron 的「${field.label}」段「${part}」里只能有一个斜杠步长。`)
    }
    const [base, stepText] = segments
    const step = stepText === undefined ? 1 : Number(stepText)
    if (!Number.isInteger(step) || step < 1) {
      throw new Error(`cron 的「${field.label}」段「${part}」的步长必须是正整数。`)
    }
    if (base === '') {
      throw new Error(`cron 的「${field.label}」段「${part}」缺少起始值。`)
    }
    if (base === '*') {
      for (let value = field.min; value <= field.max; value += step) values.add(value)
      continue
    }
    const dash = base.indexOf('-')
    if (dash > 0) {
      const from = parseCronValue(base.slice(0, dash), field, part)
      const to = parseCronValue(base.slice(dash + 1), field, part)
      if (from > to) {
        throw new Error(`cron 的「${field.label}」段「${part}」的范围起点大于终点。`)
      }
      for (let value = from; value <= to; value += step) values.add(value)
      continue
    }
    const single = parseCronValue(base, field, part)
    if (step === 1) {
      values.add(single)
      continue
    }
    for (let value = single; value <= field.max; value += step) values.add(value)
  }
  if (values.size === 0) {
    throw new Error(`cron 的「${field.label}」段没有匹配值：${text}`)
  }
  return values
}

/**
 * @param {string} text
 * @param {{ label: string, min: number, max: number, names?: string[], namesFrom?: number }} field
 * @param {string} part
 * @returns {number}
 */
function parseCronValue(text, field, part) {
  const lower = text.toLowerCase()
  const nameIndex = field.names === undefined ? -1 : field.names.indexOf(lower)
  let value
  if (nameIndex >= 0) value = nameIndex + field.namesFrom
  else if (/^\d+$/.test(text)) value = Number(text)
  else {
    throw new Error(`cron 的「${field.label}」段「${part}」含有无法识别的值「${text}」。`)
  }
  if (value < field.min || value > field.max) {
    throw new Error(`cron 的「${field.label}」段数值 ${value} 超出范围 ${field.min}-${field.max}。`)
  }
  return value
}

/**
 * Parse a five-field cron expression (minute hour day month weekday).
 * Day-of-month and day-of-week are OR-ed together when both are restricted,
 * which is the usual crontab behaviour.
 * @param {string} text
 * @returns {{ minutes: Set<number>, hours: Set<number>, days: Set<number>, months: Set<number>, weekdays: Set<number>, dayRestricted: boolean, weekdayRestricted: boolean, text: string }}
 */
export function parseCron(text) {
  const source = typeof text === 'string' ? text.trim() : ''
  if (source === '') {
    throw new Error('同步间隔不能为空，请填写 cron 表达式，例如 0 3 * * *（每天 03:00）。')
  }
  const expanded = CRON_ALIASES[source.toLowerCase()] ?? source
  const parts = expanded.split(/\s+/)
  if (parts.length !== 5) {
    throw new Error(`cron 表达式需要 5 段（分 时 日 月 周），当前是 ${parts.length} 段：${source}`)
  }
  const parsed = {
    minutes: new Set(),
    hours: new Set(),
    days: new Set(),
    months: new Set(),
    weekdays: new Set(),
    dayRestricted: false,
    weekdayRestricted: false,
    text: source,
  }
  CRON_FIELDS.forEach((field, index) => {
    const raw = parts[index]
    const values = parseCronField(raw, field)
    if (field.key === 'weekdays') {
      for (const value of values) parsed.weekdays.add(value === 7 ? 0 : value)
      parsed.weekdayRestricted = raw !== '*'
      return
    }
    parsed[field.key] = values
    if (field.key === 'days') parsed.dayRestricted = raw !== '*'
  })
  return parsed
}

/**
 * @param {ReturnType<typeof parseCron>} cron
 * @param {Date} date
 * @returns {boolean}
 */
export function cronMatches(cron, date) {
  if (!cron.minutes.has(date.getMinutes())) return false
  if (!cron.hours.has(date.getHours())) return false
  if (!cron.months.has(date.getMonth() + 1)) return false
  const dayOk = cron.days.has(date.getDate())
  const weekdayOk = cron.weekdays.has(date.getDay())
  if (cron.dayRestricted && cron.weekdayRestricted) return dayOk || weekdayOk
  if (cron.dayRestricted) return dayOk
  if (cron.weekdayRestricted) return weekdayOk
  return true
}

/* -------------------------------------------------------------------------- */
/* paths and rules                                                            */
/* -------------------------------------------------------------------------- */

const CASE_INSENSITIVE = process.platform === 'win32'

/** @param {string} value @returns {string} */
function pathKey(value) {
  return CASE_INSENSITIVE ? value.toLowerCase() : value
}

/** @param {string} a @param {string} b @returns {boolean} */
function samePath(a, b) {
  return pathKey(a) === pathKey(b)
}

/** @param {string} child @param {string} parent @returns {boolean} */
function isInsidePath(child, parent) {
  const rel = relative(parent, child)
  if (rel === '' || isAbsolute(rel)) return false
  return rel.split(/[\\/]/)[0] !== '..'
}

/** @param {string} value @returns {boolean} */
function isRootPath(value) {
  return parsePath(value).root === value
}

/**
 * @param {string} value
 * @returns {string | null} the absolute path, or null when the input is not absolute
 */
function normalizePath(value) {
  const text = typeof value === 'string' ? value.trim() : ''
  if (text === '') return ''
  if (!isAbsolute(text)) return null
  return resolve(text)
}

/** @param {string} messageText @returns {{ at: string, ok: boolean, files: number, dirs: number, bytes: number, skipped: number, deleted: number, durationMs: number, error: string | null, reason: 'manual' | 'schedule' } | null} */
function normalizeLastRun(value) {
  if (value === null || typeof value !== 'object') return null
  if (typeof value.at !== 'string' || Number.isNaN(Date.parse(value.at))) return null
  return {
    at: value.at,
    ok: value.ok === true,
    files: Number.isFinite(value.files) ? value.files : 0,
    dirs: Number.isFinite(value.dirs) ? value.dirs : 0,
    bytes: Number.isFinite(value.bytes) ? value.bytes : 0,
    skipped: Number.isFinite(value.skipped) ? value.skipped : 0,
    deleted: Number.isFinite(value.deleted) ? value.deleted : 0,
    durationMs: Number.isFinite(value.durationMs) ? value.durationMs : 0,
    error: typeof value.error === 'string' ? value.error : null,
    reason: value.reason === 'manual' ? 'manual' : 'schedule',
  }
}

/** @param {Set<string>} used @returns {string} */
function newRuleId(used) {
  let candidate = ''
  do {
    candidate = `rule-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
  } while (used.has(candidate))
  return candidate
}

/**
 * Validate a rule table coming from the page (or from disk) and normalise it.
 * Rows that are completely empty are dropped; rows with a problem are skipped
 * and reported so the page can point at the offending input.
 * @param {unknown} input
 * @param {Array<{ id: string, lastRun?: unknown }>} [previous]
 * @returns {{ rules: Array<Record<string, any>>, problems: Array<{ index: number, field: string, message: string }>, warnings: Array<{ index: number, message: string }> }}
 */
export function normalizeRules(input, previous = []) {
  const problems = []
  const warnings = []
  const rules = []
  if (!Array.isArray(input)) {
    return { rules, problems: [{ index: -1, field: 'general', message: '同步规则数据格式不正确。' }], warnings }
  }
  if (input.length > MAX_RULES) {
    problems.push({ index: -1, field: 'general', message: `最多只能保存 ${MAX_RULES} 条同步规则，当前有 ${input.length} 条。` })
  }
  const previousById = new Map()
  for (const rule of previous) {
    if (rule && typeof rule.id === 'string') previousById.set(rule.id, rule)
  }
  const usedIds = new Set()
  const limit = Math.min(input.length, MAX_RULES)

  for (let index = 0; index < limit; index += 1) {
    const before = problems.length
    const raw = input[index] !== null && typeof input[index] === 'object' ? input[index] : {}
    const sourceText = typeof raw.source === 'string' ? raw.source.trim() : ''
    const targetText = typeof raw.target === 'string' ? raw.target.trim() : ''
    const cronText = typeof raw.cron === 'string' ? raw.cron.trim() : ''
    if (sourceText === '' && targetText === '' && cronText === '') continue

    const source = normalizePath(sourceText)
    const target = normalizePath(targetText)
    if (sourceText === '') {
      problems.push({ index, field: 'source', message: `第 ${index + 1} 条：请填写源目录。` })
    } else if (source === null) {
      problems.push({ index, field: 'source', message: `第 ${index + 1} 条：源目录需要是完整路径，例如 D:\\data\\照片。` })
    }
    if (targetText === '') {
      problems.push({ index, field: 'target', message: `第 ${index + 1} 条：请填写目标目录。` })
    } else if (target === null) {
      problems.push({ index, field: 'target', message: `第 ${index + 1} 条：目标目录需要是完整路径，例如 E:\\backup\\照片。` })
    }
    if (source !== null && source !== '' && isRootPath(source)) {
      problems.push({ index, field: 'source', message: `第 ${index + 1} 条：不能把磁盘根目录整个作为源目录。` })
    }
    if (target !== null && target !== '' && isRootPath(target)) {
      problems.push({ index, field: 'target', message: `第 ${index + 1} 条：不能把磁盘根目录作为目标目录。` })
    }
    if (source !== null && target !== null && source !== '' && target !== '' && !isRootPath(source) && !isRootPath(target)) {
      if (samePath(source, target)) {
        problems.push({ index, field: 'target', message: `第 ${index + 1} 条：源目录与目标目录不能相同。` })
      } else if (isInsidePath(target, source)) {
        problems.push({ index, field: 'target', message: `第 ${index + 1} 条：目标目录不能位于源目录内部，否则会越复制越多。` })
      } else if (isInsidePath(source, target)) {
        problems.push({ index, field: 'source', message: `第 ${index + 1} 条：源目录不能位于目标目录内部，同步会覆盖源目录。` })
      }
    }
    let cron = null
    try {
      cron = parseCron(cronText)
    } catch (error) {
      problems.push({ index, field: 'cron', message: `第 ${index + 1} 条：${message(error)}` })
    }
    if (problems.length > before) continue

    let id = typeof raw.id === 'string' ? raw.id.trim() : ''
    if (id === '' || usedIds.has(id)) id = newRuleId(usedIds)
    usedIds.add(id)
    rules.push({
      id,
      source,
      target,
      cron: cron === null ? '' : cron.text,
      enabled: raw.enabled === true,
      mirror: raw.mirror === true,
      lastRun: normalizeLastRun(previousById.get(id)?.lastRun),
    })
  }
  return { rules, problems, warnings }
}

/**
 * Cheap filesystem sanity checks that are worth surfacing without blocking the
 * save: a missing source is re-checked at run time, so it is only a warning.
 * @param {Array<Record<string, any>>} rules
 * @returns {Promise<Array<{ index: number, message: string }>>}
 */
async function ruleWarnings(rules) {
  const warnings = []
  for (let index = 0; index < rules.length; index += 1) {
    const rule = rules[index]
    const sourceInfo = await statMaybe(rule.source)
    if (sourceInfo === null) {
      warnings.push({ index, message: `第 ${index + 1} 条：源目录当前不存在，同步时会跳过并报错。` })
    } else if (!sourceInfo.isDirectory()) {
      warnings.push({ index, message: `第 ${index + 1} 条：源路径存在但不是目录。` })
    }
    const targetInfo = await statMaybe(rule.target)
    if (targetInfo !== null && !targetInfo.isDirectory()) {
      warnings.push({ index, message: `第 ${index + 1} 条：目标路径已存在但不是目录。` })
    }
  }
  return warnings
}

/* -------------------------------------------------------------------------- */
/* persisted state                                                            */
/* -------------------------------------------------------------------------- */

/** @returns {string} */
function dshHome() {
  const value = process.env.DSH_HOME
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : join(homedir(), '.dsh')
}

/** @returns {string} */
function dataDir() {
  return join(dshHome(), 'plugin-data', 'dsh-plugin-dir-sync')
}

/** @returns {string} */
function dataFile() {
  return join(dataDir(), 'rules.json')
}

const runtime = {
  loaded: false,
  loading: null,
  rules: [],
  savedAt: null,
  /** @type {Map<string, ReturnType<typeof parseCron>>} */
  cron: new Map(),
  /** @type {Map<string, Promise<void>>} rule id -> tail of its run chain */
  locks: new Map(),
  lastMinute: null,
  manualRun: null,
}

/** @returns {number} */
function nowMinuteKey(date = new Date()) {
  return Math.floor(date.getTime() / 60000)
}

async function loadState() {
  if (runtime.loaded) return
  if (runtime.loading === null) {
    runtime.loading = (async () => {
      let raw = null
      try {
        raw = JSON.parse(await readFile(dataFile(), 'utf8'))
      } catch (error) {
        if (error?.code !== 'ENOENT') {
          // Keep an unreadable file for inspection instead of silently losing it.
          await rename(dataFile(), `${dataFile()}.broken-${Date.now()}`).catch(() => {})
          raw = null
        }
      }
      const checked = normalizeRules(raw?.rules ?? [], [])
      runtime.rules = checked.rules
      runtime.cron = new Map()
      for (const rule of runtime.rules) {
        try {
          runtime.cron.set(rule.id, parseCron(rule.cron))
        } catch {
          runtime.cron.delete(rule.id)
        }
      }
      runtime.savedAt = typeof raw?.savedAt === 'string' ? raw.savedAt : null
      runtime.lastMinute = nowMinuteKey() - 1
      runtime.loaded = true
    })().finally(() => {
      runtime.loading = null
    })
  }
  await runtime.loading
}

async function persist() {
  await mkdir(dataDir(), { recursive: true })
  const payload = { version: 1, savedAt: runtime.savedAt, rules: runtime.rules }
  const temporary = `${dataFile()}.tmp`
  await writeFile(temporary, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
  await rename(temporary, dataFile())
}

/** @returns {Array<Record<string, any>>} */
function rulesView() {
  return runtime.rules.map((rule) => ({
    id: rule.id,
    source: rule.source,
    target: rule.target,
    cron: rule.cron,
    enabled: rule.enabled === true,
    mirror: rule.mirror === true,
    lastRun: rule.lastRun ?? null,
  }))
}

/* -------------------------------------------------------------------------- */
/* copy engine                                                                */
/* -------------------------------------------------------------------------- */

/** @param {string} target @returns {Promise<import('node:fs').Stats | null>} */
async function statMaybe(target) {
  try {
    return await stat(target)
  } catch {
    return null
  }
}

/**
 * Replace an existing entry when its type does not match what is about to be
 * written (file where a directory belongs, or the other way round).
 * @param {string} target
 * @param {boolean} wantDirectory
 */
async function preparePath(target, wantDirectory) {
  const info = await statMaybe(target)
  if (info === null) return
  const matches = wantDirectory ? info.isDirectory() : info.isFile()
  if (!matches) await rm(target, { recursive: true, force: true })
}

/**
 * @param {string} srcDir
 * @param {string} dstDir
 * @param {string} rel
 * @param {Record<string, any>} stats
 * @param {Set<string>} seen
 */
async function copyTree(srcDir, dstDir, rel, stats, seen) {
  let entries
  try {
    entries = await readdir(srcDir, { withFileTypes: true })
  } catch (error) {
    stats.errors.push(`${rel === '' ? srcDir : rel}: ${message(error)}`)
    return
  }
  for (const entry of entries) {
    const childRel = rel === '' ? entry.name : `${rel}/${entry.name}`
    seen.add(pathKey(childRel))
    const from = join(srcDir, entry.name)
    const to = join(dstDir, entry.name)
    try {
      if (entry.isDirectory()) {
        await preparePath(to, true)
        await mkdir(to, { recursive: true })
        stats.dirs += 1
        await copyTree(from, to, childRel, stats, seen)
        continue
      }
      if (entry.isFile()) {
        const sourceInfo = await stat(from)
        const existing = await statMaybe(to)
        if (
          existing !== null &&
          existing.isFile() &&
          existing.size === sourceInfo.size &&
          Math.abs(existing.mtimeMs - sourceInfo.mtimeMs) < 1000
        ) {
          stats.skipped += 1
          continue
        }
        await preparePath(to, false)
        await copyFile(from, to)
        // Preserve mtime so the next run can skip unchanged files.
        await utimes(to, sourceInfo.atime, sourceInfo.mtime).catch(() => {})
        stats.files += 1
        stats.bytes += sourceInfo.size
        continue
      }
      // Symlinks, junctions, sockets and other special entries are left alone.
      stats.skipped += 1
    } catch (error) {
      stats.errors.push(`${childRel}: ${message(error)}`)
    }
  }
}

/**
 * @param {string} dstDir
 * @param {string} rel
 * @param {Record<string, any>} stats
 * @param {Set<string>} seen
 */
async function pruneTree(dstDir, rel, stats, seen) {
  let entries
  try {
    entries = await readdir(dstDir, { withFileTypes: true })
  } catch (error) {
    stats.errors.push(`${rel === '' ? dstDir : rel}: ${message(error)}`)
    return
  }
  for (const entry of entries) {
    const childRel = rel === '' ? entry.name : `${rel}/${entry.name}`
    const full = join(dstDir, entry.name)
    if (!seen.has(pathKey(childRel))) {
      try {
        await rm(full, { recursive: true, force: true })
        stats.deleted += 1
      } catch (error) {
        stats.errors.push(`${childRel}: ${message(error)}`)
      }
      continue
    }
    if (entry.isDirectory()) await pruneTree(full, childRel, stats, seen)
  }
}

/**
 * Copy the contents of `source` into `target`.
 * @param {string} source
 * @param {string} target
 * @param {boolean} [mirror] delete target entries the source no longer has
 * @returns {Promise<{ files: number, dirs: number, bytes: number, skipped: number, deleted: number, errors: string[] }>}
 */
export async function syncDirectory(source, target, mirror = false) {
  const stats = { files: 0, dirs: 0, bytes: 0, skipped: 0, deleted: 0, errors: [] }
  const info = await stat(source)
  if (!info.isDirectory()) throw new Error(`源路径不是目录：${source}`)
  // Catch the obvious nesting before the target directory is created inside it.
  if (isInsidePath(target, source)) {
    throw new Error('目标目录位于源目录内部，已停止同步以避免递归复制。')
  }
  await mkdir(target, { recursive: true })
  const sourceReal = await realpath(source)
  const targetReal = await realpath(target)
  if (pathKey(sourceReal) === pathKey(targetReal)) {
    throw new Error('源目录与目标目录指向同一个位置，已停止同步。')
  }
  if (isInsidePath(targetReal, sourceReal)) {
    throw new Error('目标目录位于源目录内部，已停止同步以避免递归复制。')
  }
  const seen = new Set()
  await copyTree(source, target, '', stats, seen)
  if (mirror && stats.errors.length === 0) await pruneTree(target, '', stats, seen)
  return stats
}

/** @param {unknown} error @param {{ source: string }} rule @returns {string} */
function explainSyncError(error, rule) {
  if (error?.code === 'ENOENT') return `源目录不存在：${rule.source}`
  if (error?.code === 'EACCES' || error?.code === 'EPERM') return `没有权限访问：${message(error)}`
  return message(error)
}

/* -------------------------------------------------------------------------- */
/* scheduling and runs                                                        */
/* -------------------------------------------------------------------------- */

/**
 * @template T
 * @param {string} key
 * @param {() => Promise<T>} task
 * @returns {Promise<T>}
 */
function runExclusive(key, task) {
  const previous = runtime.locks.get(key)
  const started = (previous === undefined ? Promise.resolve() : previous.catch(() => {})).then(task)
  const settled = started.then(
    () => undefined,
    () => undefined,
  )
  runtime.locks.set(key, settled)
  settled.then(() => {
    if (runtime.locks.get(key) === settled) runtime.locks.delete(key)
  })
  return started
}

/**
 * Run one rule and record the outcome on the stored rule.
 * @param {Record<string, any>} rule
 * @param {'manual' | 'schedule'} reason
 */
async function runRule(rule, reason) {
  const started = Date.now()
  const snapshot = { id: rule.id, source: rule.source, target: rule.target, mirror: rule.mirror === true }
  return runExclusive(snapshot.id, async () => {
    let stats
    let failure = null
    try {
      stats = await syncDirectory(snapshot.source, snapshot.target, snapshot.mirror)
    } catch (error) {
      failure = explainSyncError(error, snapshot)
      stats = { files: 0, dirs: 0, bytes: 0, skipped: 0, deleted: 0, errors: [failure] }
    }
    const lastRun = {
      at: new Date().toISOString(),
      ok: failure === null && stats.errors.length === 0,
      files: stats.files,
      dirs: stats.dirs,
      bytes: stats.bytes,
      skipped: stats.skipped,
      deleted: stats.deleted,
      durationMs: Date.now() - started,
      error: failure ?? stats.errors[0] ?? null,
      reason,
    }
    const current = runtime.rules.find((candidate) => candidate.id === snapshot.id)
    if (current !== undefined) current.lastRun = lastRun
    await persist().catch(() => {})
    return { id: snapshot.id, source: snapshot.source, target: snapshot.target, ...lastRun }
  })
}

/** @param {Record<string, any>} rule @returns {number} */
function lastRunMinute(rule) {
  const at = rule.lastRun?.at
  if (typeof at !== 'string') return -1
  const time = Date.parse(at)
  return Number.isFinite(time) ? Math.floor(time / 60000) : -1
}

async function startManualRun() {
  const targets = runtime.rules.filter((rule) => rule.enabled === true)
  if (targets.length === 0) {
    return { started: false, total: 0, runId: null, alreadyRunning: false }
  }
  const active = runtime.manualRun
  if (active !== null && active.finishedAt === null) {
    return { started: false, total: active.ids.length, runId: active.id, alreadyRunning: true }
  }
  const run = {
    id: `run-${Date.now().toString(36)}`,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    ids: targets.map((rule) => rule.id),
    results: [],
  }
  runtime.manualRun = run
  void executeManualRun(run)
  return { started: true, total: run.ids.length, runId: run.id, alreadyRunning: false }
}

/** @param {{ id: string, ids: string[], startedAt: string, finishedAt: string | null, results: Array<Record<string, any>> }} run */
async function executeManualRun(run) {
  try {
    for (const id of run.ids) {
      const rule = runtime.rules.find((candidate) => candidate.id === id)
      if (rule === undefined) continue
      run.results.push(await runRule(rule, 'manual'))
    }
  } finally {
    run.finishedAt = new Date().toISOString()
  }
}

/** @param {Record<string, any> | null} run */
function manualRunView(run) {
  if (run === null) return null
  return {
    id: run.id,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    running: run.finishedAt === null,
    total: run.ids.length,
    done: run.results.length,
    results: run.results,
  }
}

async function tick() {
  await loadState()
  const now = new Date()
  const minute = nowMinuteKey(now)
  if (runtime.lastMinute === minute) return
  runtime.lastMinute = minute
  for (const rule of runtime.rules) {
    if (rule.enabled !== true) continue
    const cron = runtime.cron.get(rule.id)
    if (cron === undefined || !cronMatches(cron, now)) continue
    if (lastRunMinute(rule) === minute) continue
    if (runtime.locks.has(rule.id)) continue
    void runRule(rule, 'schedule').catch(() => {})
  }
}

/* -------------------------------------------------------------------------- */
/* HTTP                                                                       */
/* -------------------------------------------------------------------------- */

/** @param {unknown} error @returns {string} */
function message(error) {
  if (error instanceof Error && typeof error.message === 'string' && error.message !== '') return error.message
  if (typeof error === 'string' && error !== '') return error
  return '未知错误'
}

function report(ctx, error) {
  const text = `[dsh-dir-sync] ${message(error)}`
  try {
    const logger = typeof ctx.get === 'function' ? ctx.get('logger') : null
    if (logger !== null && typeof logger?.warn === 'function') {
      logger.warn(text)
      return
    }
  } catch {
    // fall through to console
  }
  console.warn(text)
}

function reply(res, status, body) {
  const text = JSON.stringify(body ?? {})
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(text),
  })
  res.end(text)
}

/** @param {import('node:http').IncomingMessage} req @returns {Promise<any>} */
function readBody(req) {
  return new Promise((resolveBody, rejectBody) => {
    let text = ''
    let settled = false
    const fail = (error) => {
      if (settled) return
      settled = true
      rejectBody(error)
    }
    req.setEncoding('utf8')
    req.on('data', (chunk) => {
      if (settled) return
      text += chunk
      if (text.length > MAX_BODY) {
        fail(new Error('请求内容过大。'))
        req.destroy?.()
      }
    })
    req.on('error', () => fail(new Error('读取请求内容失败。')))
    req.on('end', () => {
      if (settled) return
      settled = true
      if (text.trim() === '') {
        resolveBody({})
        return
      }
      try {
        const parsed = JSON.parse(text)
        resolveBody(parsed !== null && typeof parsed === 'object' ? parsed : {})
      } catch {
        rejectBody(new Error('请求内容不是有效的 JSON。'))
      }
    })
  })
}

async function handleState() {
  await loadState()
  return {
    status: 200,
    body: {
      ok: true,
      maxRules: MAX_RULES,
      savedAt: runtime.savedAt,
      rules: rulesView(),
      running: [...runtime.locks.keys()],
      run: manualRunView(runtime.manualRun),
    },
  }
}

async function handleSave(body) {
  await loadState()
  const checked = normalizeRules(body?.rules, runtime.rules)
  if (checked.problems.length > 0) {
    return {
      status: 400,
      body: { ok: false, error: checked.problems[0].message, problems: checked.problems },
    }
  }
  runtime.rules = checked.rules
  runtime.cron = new Map()
  for (const rule of runtime.rules) {
    try {
      runtime.cron.set(rule.id, parseCron(rule.cron))
    } catch {
      runtime.cron.delete(rule.id)
    }
  }
  runtime.savedAt = new Date().toISOString()
  await persist()
  const warnings = await ruleWarnings(runtime.rules)
  return { status: 200, body: { ok: true, savedAt: runtime.savedAt, rules: rulesView(), warnings } }
}

async function handleToggle(body) {
  await loadState()
  const id = typeof body?.id === 'string' ? body.id : ''
  const enabled = body?.enabled === true
  const rule = runtime.rules.find((candidate) => candidate.id === id)
  if (rule === undefined) {
    return { status: 404, body: { ok: false, error: '找不到这条同步规则，它可能已经被删除了。' } }
  }
  rule.enabled = enabled
  runtime.savedAt = new Date().toISOString()
  await persist()
  return {
    status: 200,
    body: { ok: true, savedAt: runtime.savedAt, rules: rulesView(), running: [...runtime.locks.keys()] },
  }
}

async function handleRun() {
  await loadState()
  const outcome = await startManualRun()
  return { status: 200, body: { ok: true, ...outcome } }
}

async function handleStatus(body) {
  await loadState()
  const id = typeof body?.id === 'string' ? body.id : ''
  const run = runtime.manualRun
  if (run === null || run.id !== id) {
    return { status: 404, body: { ok: false, error: '找不到这次同步记录，可能应用已经重启过。' } }
  }
  return { status: 200, body: { ok: true, run: manualRunView(run) } }
}

/**
 * @param {any} ctx
 * @param {string} path
 * @param {'GET' | 'POST'} method
 * @param {(body: any) => Promise<{ status?: number, body: any }>} handler
 */
function mount(ctx, path, method, handler) {
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path,
        handler: (req, res) => {
          Promise.resolve()
            .then(async () => {
              if ((req.method ?? 'GET') !== method) {
                return { status: 405, body: { ok: false, error: `只支持 ${method} 请求。` } }
              }
              const body = method === 'POST' ? await readBody(req) : {}
              return handler(body)
            })
            .then((outcome) => reply(res, outcome?.status ?? 200, outcome?.body ?? {}))
            .catch((error) => {
              report(ctx, error)
              reply(res, 500, { ok: false, error: message(error) })
            })
        },
      }),
    `dsh-dir-sync: ${path}`,
  )
}

/**
 * @param {any} ctx
 */
export function apply(ctx) {
  mount(ctx, ROUTE_STATE, 'GET', () => handleState())
  mount(ctx, ROUTE_SAVE, 'POST', (body) => handleSave(body))
  mount(ctx, ROUTE_TOGGLE, 'POST', (body) => handleToggle(body))
  mount(ctx, ROUTE_RUN, 'POST', () => handleRun())
  mount(ctx, ROUTE_STATUS, 'POST', (body) => handleStatus(body))

  ctx.effect(() => {
    loadState().catch((error) => report(ctx, error))
    const timer = setInterval(() => {
      tick().catch((error) => report(ctx, error))
    }, TICK_MS)
    timer.unref?.()
    return () => clearInterval(timer)
  }, 'dsh-dir-sync: scheduler')
}
