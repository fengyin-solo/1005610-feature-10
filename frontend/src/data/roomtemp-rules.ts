import type { EntryRow } from './types'

// 室温达标判定口径（2026 年调整）：
// 不再按单次读数判定，而是按一天内的采集时间做时间加权平均，加权值落在合格范围内才算达标。
// 合格范围：18℃~24℃（含边界），低于 18℃ 或高于 24℃ 均判不达标；
// 采集设备量程：0℃~50℃，超出量程的读数视为异常，监测点先挂起，不参与判定、不得保存为已达标。
export const ROOMTEMP_QUALIFIED_MIN = 18
export const ROOMTEMP_QUALIFIED_MAX = 24
export const ROOMTEMP_SENSOR_MIN = 0
export const ROOMTEMP_SENSOR_MAX = 50

export const ROOMTEMP_DETAIL_FIELD = '采集明细'
export const ROOMTEMP_SOURCE_FIELD = '来源监测'

export const ROOMTEMP_STATUS_COLLECTED = '待采集'
export const ROOMTEMP_STATUS_REVIEWING = '待复核'
export const ROOMTEMP_STATUS_QUALIFIED = '已达标'
export const ROOMTEMP_STATUS_UNQUALIFIED = '不达标'
export const ROOMTEMP_STATUS_SUSPENDED = '已挂起'

// 仍需继续处理的状态（待上门、待复核等都算未办结）。
const PENDING_STATUSES = new Set([
  ROOMTEMP_STATUS_COLLECTED,
  ROOMTEMP_STATUS_REVIEWING,
  ROOMTEMP_STATUS_UNQUALIFIED,
  ROOMTEMP_STATUS_SUSPENDED,
])
const ABNORMAL_STATUSES = new Set([ROOMTEMP_STATUS_UNQUALIFIED, ROOMTEMP_STATUS_SUSPENDED])

export type StoredReading = {
  day: string
  time: string
  value: number
  reviewed: boolean
}

export type DayReading = { time: string; value: number }

export type DaySummary = {
  day: string
  readings: DayReading[]
  reviewed: boolean
  outOfRange: boolean
  outValues: number[]
  weighted: number | null
}

export type CollectItem = { time: string; value: number }

function toMinutes(time: string): number {
  const [hour, minute] = time.split(':').map((part) => Number(part))
  return hour * 60 + minute
}

export function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

export function inSensorRange(value: number): boolean {
  return value >= ROOMTEMP_SENSOR_MIN && value <= ROOMTEMP_SENSOR_MAX
}

export function isQualifiedWeighted(value: number): boolean {
  return value >= ROOMTEMP_QUALIFIED_MIN && value <= ROOMTEMP_QUALIFIED_MAX
}

export function roomtempFlags(status: string): { pending: boolean; abnormal: boolean } {
  return {
    pending: PENDING_STATUSES.has(status),
    abnormal: ABNORMAL_STATUSES.has(status),
  }
}

// 时间加权平均：读数按采集时间排序，每条读数的权重取它到下一条读数之间的分钟数，
// 当天最后一条读数的权重取到 24:00；只有一条时权重为整天 1440 分钟。
export function weightedAverage(readings: DayReading[]): number | null {
  if (!readings.length) {
    return null
  }
  const sorted = [...readings].sort((a, b) => toMinutes(a.time) - toMinutes(b.time))
  let weightedSum = 0
  let totalWeight = 0
  for (let i = 0; i < sorted.length; i += 1) {
    const start = toMinutes(sorted[i].time)
    const end = i < sorted.length - 1 ? toMinutes(sorted[i + 1].time) : 24 * 60
    const weight = Math.max(end - start, 0)
    weightedSum += sorted[i].value * weight
    totalWeight += weight
  }
  if (totalWeight === 0) {
    return sorted[sorted.length - 1].value
  }
  return weightedSum / totalWeight
}

export function serializeReadings(readings: StoredReading[]): string {
  return JSON.stringify(readings)
}

export function parseReadings(row: EntryRow): StoredReading[] {
  const raw = row[ROOMTEMP_DETAIL_FIELD]
  if (typeof raw !== 'string' || raw.trim() === '') {
    return []
  }
  try {
    const parsed = JSON.parse(raw) as Array<Partial<StoredReading>>
    if (!Array.isArray(parsed)) {
      return []
    }
    return parsed
      .filter(
        (item): item is StoredReading =>
          typeof item?.day === 'string' &&
          typeof item.time === 'string' &&
          isFiniteNumber(item.value),
      )
      .map((item) => ({ ...item, reviewed: item.reviewed === true }))
  } catch {
    return []
  }
}

export function latestDaySummary(readings: StoredReading[]): DaySummary | null {
  if (!readings.length) {
    return null
  }
  const days = [...new Set(readings.map((item) => item.day))].sort()
  const day = days[days.length - 1]
  const sameDay = readings.filter((item) => item.day === day)
  const outValues = sameDay.filter((item) => !inSensorRange(item.value)).map((item) => item.value)
  const inRangeReadings = sameDay
    .filter((item) => inSensorRange(item.value))
    .map((item) => ({ time: item.time, value: item.value }))
  return {
    day,
    readings: sameDay
      .slice()
      .sort((a, b) => toMinutes(a.time) - toMinutes(b.time))
      .map((item) => ({ time: item.time, value: item.value })),
    reviewed: sameDay.every((item) => item.reviewed),
    outOfRange: outValues.length > 0,
    outValues,
    weighted: outValues.length > 0 ? null : weightedAverage(inRangeReadings),
  }
}

// 台账列表与导出表都走这里，保证两处读到的室温读数、采集时间、达标判定完全一致。
export function deriveRoomTempRow(row: EntryRow): EntryRow {
  const next: EntryRow = { ...row }
  const summary = latestDaySummary(parseReadings(row))
  if (!summary) {
    next.室温读数 = '—'
    next.采集时间 = '—'
    next.达标判定 = '未采集'
    next.监测状态 = row.status
    return next
  }
  const lastTime = summary.readings[summary.readings.length - 1]?.time ?? ''
  next.采集时间 = `${summary.day} ${lastTime}`.trim()
  if (summary.outOfRange) {
    next.室温读数 = `超量程：${summary.outValues.map((value) => `${value}℃`).join('、')}`
    next.达标判定 = `已挂起（读数超出${ROOMTEMP_SENSOR_MIN}~${ROOMTEMP_SENSOR_MAX}℃量程，暂不判定）`
  } else if (summary.weighted !== null) {
    const weighted = summary.weighted
    const qualified = isQualifiedWeighted(weighted)
    const weightedText = weighted.toFixed(1)
    next.室温读数 = `${weightedText}℃（日加权）`
    const basis = `日加权${weightedText}℃，合格范围${ROOMTEMP_QUALIFIED_MIN}~${ROOMTEMP_QUALIFIED_MAX}℃`
    next.达标判定 =
      row.status === ROOMTEMP_STATUS_REVIEWING
        ? `待片区复核（建议判定：${qualified ? '达标' : '不达标'}；${basis}）`
        : `${qualified ? '达标' : '不达标'}（${basis}）`
  }
  next.监测状态 = row.status
  return next
}

// 按读数给出判定结果：超量程挂起，否则按日加权值落到达标/不达标。
export function outcomeForSummary(summary: DaySummary): string {
  if (summary.outOfRange || summary.weighted === null) {
    return ROOMTEMP_STATUS_SUSPENDED
  }
  return isQualifiedWeighted(summary.weighted)
    ? ROOMTEMP_STATUS_QUALIFIED
    : ROOMTEMP_STATUS_UNQUALIFIED
}

export function sameCollectItems(a: CollectItem[], b: CollectItem[]): boolean {
  if (a.length !== b.length) {
    return false
  }
  const key = (item: CollectItem) => `${item.time}/${Number(item.value).toFixed(2)}`
  const left = a.map(key).sort()
  const right = b.map(key).sort()
  return left.every((value, index) => value === right[index])
}

// 不达标判定自动落到入户服务的待上门清单：同一监测点同一天只生成一张服务单。
export function householdVisitSource(monitorId: string, day: string): string {
  return `${monitorId}@${day}`
}

export function buildHouseholdVisit(monitorRow: EntryRow, summary: DaySummary, id: number): EntryRow {
  const weightedText = summary.weighted === null ? '—' : summary.weighted.toFixed(1)
  return {
    id,
    status: '待受理',
    pending: true,
    abnormal: false,
    服务单号: `HOUS-${String(id).padStart(4, '0')}`,
    报修用户: String(monitorRow.住户地址 ?? ''),
    服务内容: `室温不达标入户服务（监测编号${String(monitorRow.监测编号 ?? '')}，${summary.day} 日加权${weightedText}℃，低于合格范围${ROOMTEMP_QUALIFIED_MIN}~${ROOMTEMP_QUALIFIED_MAX}℃）`,
    受理人: '待派单',
    上门时间: '',
    处理结果: '',
    回访日期: '',
    服务状态: '待受理',
    [ROOMTEMP_SOURCE_FIELD]: householdVisitSource(String(monitorRow.监测编号 ?? ''), summary.day),
  }
}

// 旧口径数据迁移：住户地址、所属片区保持不变；旧的单次读数当作一条全天权重的采集记录，
// 已经判过（已采集/已达标/不达标）的监测点按新口径重新判一遍。
export function migrateLegacyRoomTempRow(old: EntryRow): EntryRow {
  const monitorId = String(old.监测编号 ?? `ROOM-${String(old.id).padStart(4, '0')}`)
  const base: EntryRow = {
    id: Number(old.id),
    status: ROOMTEMP_STATUS_COLLECTED,
    pending: true,
    abnormal: false,
    监测编号: monitorId,
    住户地址: String(old.住户地址 ?? ''),
    所属片区: String(old.所属片区 ?? ''),
    室温读数: '—',
    采集时间: '—',
    达标判定: '未采集',
    处理人: '',
    监测状态: ROOMTEMP_STATUS_COLLECTED,
    [ROOMTEMP_DETAIL_FIELD]: '[]',
  }
  const rawValue = Number(String(old.室温读数 ?? '').replace(/[℃°\s]/g, ''))
  if (!Number.isFinite(rawValue)) {
    return base
  }
  const wasJudged = ['已达标', '不达标'].includes(String(old.status))
  const day = String(old.采集时间 ?? '').slice(0, 10) || '2026-09-03'
  const readings: StoredReading[] = [
    { day, time: '08:00', value: rawValue, reviewed: wasJudged },
  ]
  base[ROOMTEMP_DETAIL_FIELD] = serializeReadings(readings)
  if (!wasJudged) {
    // 旧口径的“已采集”尚未判定，新口径下进入待片区复核队列，沿用既有监测判定。
    base.status = ROOMTEMP_STATUS_REVIEWING
    base.监测状态 = ROOMTEMP_STATUS_REVIEWING
    return base
  }
  const summary = latestDaySummary(readings)
  const status = summary ? outcomeForSummary(summary) : ROOMTEMP_STATUS_COLLECTED
  const flags = roomtempFlags(status)
  base.status = status
  base.监测状态 = status
  base.pending = flags.pending
  base.abnormal = flags.abnormal
  if (typeof old.处理人 === 'string' && !old.处理人.includes('样例')) {
    base.处理人 = old.处理人
  }
  return base
}

// 迁移后为所有不达标监测点补待上门服务单，已存在来源记录的不重复生成。
export function buildMigrationVisits(
  roomtempRows: EntryRow[],
  householdRows: EntryRow[],
): EntryRow[] {
  const existed = new Set(
    householdRows
      .map((row) => row[ROOMTEMP_SOURCE_FIELD])
      .filter((value): value is string => typeof value === 'string'),
  )
  let nextId = householdRows.reduce((max, row) => Math.max(max, Number(row.id)), 0)
  const visits: EntryRow[] = []
  for (const row of roomtempRows) {
    if (String(row.status) !== ROOMTEMP_STATUS_UNQUALIFIED) {
      continue
    }
    const summary = latestDaySummary(parseReadings(row))
    if (!summary) {
      continue
    }
    const source = householdVisitSource(String(row.监测编号 ?? ''), summary.day)
    if (existed.has(source)) {
      continue
    }
    nextId += 1
    visits.push(buildHouseholdVisit(row, summary, nextId))
    existed.add(source)
  }
  return visits
}
