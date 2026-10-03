import { SEED_ROWS } from './seed'
import type { EntryRow } from './types'
import { buildMigrationVisits, migrateLegacyRoomTempRow } from './roomtemp-rules'

// 本地持久化：数据放在 localStorage 里，刷新、关掉再打开都还在。
// 版本号随口径调整而提高：v2 室温达标改按日内采集时间加权，旧数据要重算。
const STORAGE_KEY = 'district-heating:entries'
const VERSION_KEY = 'district-heating:entries-version'
const STORAGE_VERSION = 2

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

// 旧口径室温数据迁移：地址、片区照旧，读数按新口径重判；不达标补待上门服务单。
function migrateStored(data: Record<string, EntryRow[]>): Record<string, EntryRow[]> {
  const next: Record<string, EntryRow[]> = { ...data }
  if (Array.isArray(data.roomtemp)) {
    next.roomtemp = data.roomtemp.map(migrateLegacyRoomTempRow)
    next.householdservice = [
      ...(Array.isArray(data.householdservice) ? data.householdservice : []),
      ...buildMigrationVisits(next.roomtemp, Array.isArray(data.householdservice) ? data.householdservice : []),
    ]
  }
  return next
}

function persist(data: Record<string, EntryRow[]>): void {
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(data))
    window.localStorage.setItem(VERSION_KEY, String(STORAGE_VERSION))
  }
}

function readStorage(): Record<string, EntryRow[]> {
  const fallback = clone(SEED_ROWS)
  if (typeof window === 'undefined' || !window.localStorage) {
    return fallback
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    persist(fallback)
    return fallback
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, EntryRow[]>
    const version = Number(window.localStorage.getItem(VERSION_KEY) ?? '1')
    const merged = { ...fallback, ...parsed }
    if (version < STORAGE_VERSION) {
      const migrated = migrateStored(merged)
      persist(migrated)
      return migrated
    }
    return merged
  } catch {
    persist(fallback)
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
  return allRows()[key] ?? []
}

export function saveRows(key: string, rows: EntryRow[]): void {
  const next = { ...allRows(), [key]: rows }
  cache = next
  persist(next)
}

export function resetRows(key: string): EntryRow[] {
  const rows = clone(SEED_ROWS[key] ?? [])
  saveRows(key, rows)
  return rows
}

export function storageKey(): string {
  return STORAGE_KEY
}
