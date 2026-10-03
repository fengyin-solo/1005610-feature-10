import type { EntryRow } from './types'

/**
 * 室温监测的判定口径（2026 供暖季调整）：
 * - 不再按单次读数判定，按一天内各采集时间做时间加权，取当日加权值；
 * - 合格范围 18℃（含）至 24℃（含），加权值落在闭区间内才允许判定「已达标」；
 * - 室温读数超出仪表量程（-20℃～60℃）先挂起，不参与加权、不允许保存成已达标；
 * - 同一天重复采集报送只记一次（同一采集时间的读数覆盖，不新增）。
 * 台账列表与导出表都经由本文件同一组纯函数取达标判定，保证两处一致。
 */

// 合格范围（闭区间，单位 ℃）
export const TEMP_LOWER = 18
export const TEMP_UPPER = 24
// 室温采集仪表量程（闭区间），落外即视为超出量程
export const RANGE_LOWER = -20
export const RANGE_UPPER = 60

export type Reading = {
  /** ISO 形式的采集时间，YYYY-MM-DD HH:mm */
  time: string
  value: number
}

export type Verdict =
  | '达标' // 当日时间加权值落在 [18, 24]
  | '不达标' // 加权值低于 18 或高于 24
  | '超量程挂起' // 当日存在超出 -20～60 的读数，先挂起
  | '数据不足' // 当日没有可参与加权的有效读数

export type DayEvaluate = {
  date: string
  verdict: Verdict
  /** 当日时间加权值，超量程或数据不足时为 null */
  weighted: number | null
  readings: Reading[]
  /** 参与加权的有效读数（量程内） */
  validReadings: Reading[]
  outOfRange: Reading[]
}

export const VERDICT_MEET = '达标'
export const VERDICT_FAIL = '不达标'
export const VERDICT_SUSPENDED = '超量程挂起'
export const VERDICT_NODATA = '数据不足'

export function parseReadings(raw: unknown): Reading[] {
  if (typeof raw !== 'string' || raw.trim() === '') {
    return []
  }
  const list: Reading[] = []
  for (const piece of raw.split('\n')) {
    const line = piece.trim()
    if (!line) {
      continue
    }
    // 形如「2026-10-02 08:00=20.5」
    const sep = line.indexOf('=')
    if (sep < 0) {
      continue
    }
    const time = line.slice(0, sep).trim().replace('T', ' ')
    const value = Number(line.slice(sep + 1).trim())
    if (!time || !Number.isFinite(value)) {
      continue
    }
    list.push({ time, value })
  }
  return list
}

export function serializeReadings(readings: Reading[]): string {
  return readings.map((item) => `${item.time}=${item.value}`).join('\n')
}

function minutesOfDay(time: string): number {
  const clock = time.includes(' ') ? time.slice(time.indexOf(' ') + 1) : '00:00'
  const [hourText, minuteText = '0'] = clock.split(':')
  const hour = Number(hourText)
  const minute = Number(minuteText)
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) {
    return 0
  }
  return hour * 60 + minute
}

/**
 * 一天内按采集时间做时间加权：以相邻两次采集的中点划分各读数的代表时段
 * （首条到当日 00:00、末条到 24:00 各取半段），加权值 = Σ读数×代表分钟 / 1440。
 * 仅量程内的读数参与加权；当天只有一条有效读数时，该读数即当日代表值。
 */
export function weightedAverage(dayReadings: Reading[]): number | null {
  const valid = dayReadings
    .filter((item) => item.value >= RANGE_LOWER && item.value <= RANGE_UPPER)
    .slice()
    .sort((a, b) => minutesOfDay(a.time) - minutesOfDay(b.time))
  if (valid.length === 0) {
    return null
  }
  if (valid.length === 1) {
    return round1(valid[0].value)
  }
  const marks = valid.map((item) => minutesOfDay(item.time))
  let weightedSum = 0
  for (let i = 0; i < valid.length; i += 1) {
    const left = i === 0 ? 0 : (marks[i - 1] + marks[i]) / 2
    const right = i === valid.length - 1 ? 24 * 60 : (marks[i] + marks[i + 1]) / 2
    weightedSum += valid[i].value * (right - left)
  }
  return round1(weightedSum / (24 * 60))
}

export function evaluateDay(readings: Reading[], date: string): DayEvaluate {
  const dayReadings = readings.filter((item) => item.time.slice(0, 10) === date)
  const validReadings = dayReadings.filter(
    (item) => item.value >= RANGE_LOWER && item.value <= RANGE_UPPER,
  )
  const outOfRange = dayReadings.filter(
    (item) => item.value < RANGE_LOWER || item.value > RANGE_UPPER,
  )
  if (outOfRange.length > 0) {
    return { date, verdict: VERDICT_SUSPENDED, weighted: null, readings: dayReadings, validReadings, outOfRange }
  }
  if (validReadings.length === 0) {
    return { date, verdict: VERDICT_NODATA, weighted: null, readings: dayReadings, validReadings, outOfRange }
  }
  const weighted = weightedAverage(dayReadings)
  const verdict: Verdict =
    weighted !== null && weighted >= TEMP_LOWER && weighted <= TEMP_UPPER ? VERDICT_MEET : VERDICT_FAIL
  return { date, verdict, weighted, readings: dayReadings, validReadings, outOfRange }
}

/** 取最近一个有报送数据的采集日；无报送时返回空串。 */
export function latestDate(readings: Reading[]): string {
  return readings.reduce((acc, item) => (item.time.slice(0, 10) > acc ? item.time.slice(0, 10) : acc), '')
}

/** 按采集明细文本评估最近采集日（报送/复核流程在数据落库前先用它预判结论）。 */
export function evaluateDetail(detail: string): DayEvaluate | null {
  const readings = parseReadings(detail)
  const date = latestDate(readings)
  if (!date) {
    return null
  }
  return evaluateDay(readings, date)
}

/**
 * 按新口径评估一个监测点最近采集日：先超量程挂起，再算时间加权值比对合格范围。
 */
export function evaluateRow(row: EntryRow): DayEvaluate | null {
  return evaluateDetail(String(row['采集明细'] ?? ''))
}

function round1(value: number): number {
  return Math.round(value * 10) / 10
}

/** 台账与导出共用的达标判定文案。 */
export function verdictLabel(result: DayEvaluate | null): string {
  if (!result) {
    return '待采集'
  }
  if (result.verdict === VERDICT_MEET || result.verdict === VERDICT_FAIL) {
    return `${result.verdict}（加权${result.weighted?.toFixed(1)}℃）`
  }
  return result.verdict
}

export function readingDisplay(result: DayEvaluate | null): string {
  if (!result) {
    return '—'
  }
  if (result.verdict === VERDICT_SUSPENDED) {
    const bad = result.outOfRange.map((item) => item.value.toFixed(1)).join('、')
    return `超量程 ${bad}℃`
  }
  if (result.weighted === null) {
    return '—'
  }
  return `${result.weighted.toFixed(1)}℃`
}

export const STATUS_PENDING = '待采集'
export const STATUS_COLLECTED = '已采集'
export const STATUS_MEET = '已达标'
export const STATUS_FAIL = '不达标'
export const STATUS_SUSPENDED = '已挂起'

/** 监测状态仍允许后续动作的为「待处理」，看板与统计共用。 */
const OPEN_STATUSES = new Set([STATUS_PENDING, STATUS_COLLECTED, STATUS_SUSPENDED])

export function isOpenStatus(status: string): boolean {
  return OPEN_STATUSES.has(status)
}

/**
 * 依据监测点的报送数据按新口径重算派生字段（室温读数 / 采集时间 / 达标判定 / 采集明细），
 * 住户地址、所属片区、处理人等登记信息保持不变。返回的是新行，不就地修改。
 */
export function normalizeRow(row: EntryRow): EntryRow {
  const readings = parseReadings(String(row.采集明细 ?? ''))
  const date = latestDate(readings)
  const result = date ? evaluateDay(readings, date) : null
  const next: EntryRow = { ...row }
  next['采集时间'] = date || '—'
  next['室温读数'] = readingDisplay(result)
  next['达标判定'] = verdictLabel(result)
  return next
}

/**
 * 已登监测点旧结论重算：状态严格按新口径结论归位（旧口径下的人工结论不再保留）：
 * 无数据→待采集；存在超量程读数→已挂起；加权值在合格范围→已达标；否则→不达标。
 * 住户地址、所属片区、处理人等登记信息保持不变。
 */
export function reconcileStatus(row: EntryRow): EntryRow {
  const result = evaluateRow(row)
  if (!result) {
    return { ...normalizeRow(row), status: STATUS_PENDING, pending: true, abnormal: false }
  }
  if (result.verdict === VERDICT_SUSPENDED) {
    return { ...normalizeRow(row), status: STATUS_SUSPENDED, pending: true, abnormal: true }
  }
  if (result.verdict === VERDICT_MEET) {
    return { ...normalizeRow(row), status: STATUS_MEET, pending: false, abnormal: false }
  }
  return { ...normalizeRow(row), status: STATUS_FAIL, pending: false, abnormal: false }
}
