import { SEED_ROWS } from './seed'
import { STATUS_FAIL, normalizeRow, reconcileStatus } from './roomtemp'
import type { EntryRow } from './types'

// 本地持久化：数据放在 localStorage 里，刷新、关掉再打开都还在。
const STORAGE_KEY = 'district-heating:entries'
const VERSION_KEY = 'district-heating:version'
// 室温口径升级：旧库按新口径（按采集时间时间加权）重算一次。
const DATA_VERSION = 2

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

/**
 * 旧室温监测点迁移到新口径：
 * - 住户地址、所属片区等登记信息照旧，只把旧的单次「室温读数 + 采集时间」折成一条采集明细；
 * - 派生字段（室温读数/采集时间/达标判定）统一由采集明细重算；
 * - 挂在旧口径上的「已达标/不达标」人工结论保留沿用，其余状态按新口径结论归位
 *   （无数据→待采集，超量程→已挂起，有有效读数→已采集）。
 */
function migrateLegacyRow(row: EntryRow): EntryRow {
  let next: EntryRow = { ...row }
    if (typeof next['采集明细'] !== 'string' || next['采集明细'].trim() === '') {
    const value = Number.parseFloat(String(next['室温读数'] ?? ''))
    const rawTime = String(next['采集时间'] ?? '').trim()
    const time = rawTime ? rawTime.replace('T', ' ').slice(0, 16) : ''
    if (Number.isFinite(value) && /^\d{4}-\d{2}-\d{2}/.test(time)) {
      // 旧数据只记了日期没有时刻的，按日间 10:00 折成单次采集参与重算。
      const clock = time.length === 10 ? `${time} 10:00` : time
      next['采集明细'] = `${clock}=${value}`
    } else {
      next['采集明细'] = ''
    }
  }
  next = reconcileStatus(next)
  return next
}

function migrateRoomtemp(rows: EntryRow[]): EntryRow[] {
  return rows.map((row) => migrateLegacyRow(row))
}

/**
 * 旧监测点重算为不达标的，按新口径落到入户服务的待上门清单；
 * 同一监测点已有待受理/已安排上门单的沿用，不重复造单。
 */
function syncVisitTickets(
  data: Record<string, EntryRow[]>,
  roomRows: EntryRow[],
): Record<string, EntryRow[]> {
  const tickets = Array.isArray(data.householdservice) ? [...data.householdservice] : []
  const failed = roomRows.filter((row) => String(row.status) === STATUS_FAIL)
  let changed = false
  for (const row of failed) {
    const sourceId = Number(row.id)
    const exists = tickets.some(
      (item) =>
        Number(item['室温监测点id'] ?? 0) === sourceId &&
        (String(item.status) === '待受理' || String(item.status) === '已安排'),
    )
    if (exists) {
      continue
    }
    const id = tickets.reduce((max, item) => Math.max(max, Number(item.id) || 0), 0) + 1
    tickets.push({
      id,
      status: '待受理',
      pending: true,
      abnormal: false,
      服务单号: `HOUS-${String(id).padStart(4, '0')}`,
      报修用户: String(row['住户地址'] ?? ''),
      服务内容: `室温不达标上门排查（监测点 ${row['监测编号'] ?? id}，${row['达标判定']}，不在合格范围18℃～24℃）`,
      受理人: '',
      上门时间: '',
      处理结果: '',
      回访日期: '',
      服务状态: '待受理',
      室温监测点id: sourceId,
    })
    changed = true
  }
  return changed ? { ...data, householdservice: tickets } : data
}

/**
 * 读取期归一化：台账与导出都经由这里取室温数据，达标判定只能由采集明细按同一口径算出，
 * 避免两处读到不一致的结论。归一化是幂等的，字段真有出入时顺手回写。
 */
function normalizeRoomtemp(rows: EntryRow[]): EntryRow[] {
  let changed = false
  const normalized = rows.map((row) => {
    const next = normalizeRow(row)
    if (
      next['室温读数'] !== row['室温读数'] ||
      next['采集时间'] !== row['采集时间'] ||
      next['达标判定'] !== row['达标判定']
    ) {
      changed = true
    }
    return next
  })
  if (changed && typeof window !== 'undefined' && window.localStorage) {
    const all = cache ?? {}
    const merged = { ...all, roomtemp: normalized }
    cache = merged
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(merged))
  }
  return normalized
}

function applyVersionMigrations(
  data: Record<string, EntryRow[]>,
): Record<string, EntryRow[]> {
  if (typeof window === 'undefined' || !window.localStorage) {
    return data
  }
  const previous = Number(window.localStorage.getItem(VERSION_KEY) ?? '1')
  if (previous >= DATA_VERSION) {
    return data
  }
  let next = data
  if (previous < 2 && Array.isArray(next.roomtemp)) {
    const roomRows = migrateRoomtemp(next.roomtemp)
    next = { ...next, roomtemp: roomRows }
    next = syncVisitTickets(next, roomRows)
  }
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  window.localStorage.setItem(VERSION_KEY, String(DATA_VERSION))
  return next
}

function readStorage(): Record<string, EntryRow[]> {
  const fallback = clone(SEED_ROWS)
  if (typeof window === 'undefined' || !window.localStorage) {
    return fallback
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    window.localStorage.setItem(VERSION_KEY, String(DATA_VERSION))
    return fallback
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, EntryRow[]>
    const merged = applyVersionMigrations({ ...fallback, ...parsed })
    return merged
  } catch {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    window.localStorage.setItem(VERSION_KEY, String(DATA_VERSION))
    return fallback
  }
}

let cache: Record<string, EntryRow[]> | null = null

export function allRows(): Record<string, EntryRow[]> {
  if (cache === null) {
    cache = readStorage()
  }
  return cache
}

export function listRows(key: string): EntryRow[] {
  const rows = allRows()[key] ?? []
  if (key === 'roomtemp') {
    return normalizeRoomtemp(rows)
  }
  return rows
}

export function saveRows(key: string, rows: EntryRow[]): void {
  const next = { ...allRows(), [key]: rows }
  cache = next
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  }
}

export function resetRows(key: string): EntryRow[] {
  const rows = clone(SEED_ROWS[key] ?? [])
  saveRows(key, rows)
  return rows
}

export function storageKey(): string {
  return STORAGE_KEY
}
