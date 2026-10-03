import { MODULE_BY_KEY } from '@/data/modules'
import { allRows, listRows, resetRows, saveRows } from '@/data/local-store'
import {
  STATUS_COLLECTED,
  STATUS_FAIL,
  STATUS_MEET,
  STATUS_PENDING,
  STATUS_SUSPENDED,
  VERDICT_FAIL,
  VERDICT_MEET,
  VERDICT_NODATA,
  VERDICT_SUSPENDED,
  evaluateDetail,
  evaluateRow,
  isOpenStatus,
  normalizeRow,
  parseReadings,
  serializeReadings,
} from '@/data/roomtemp'
import type {
  ActionContext,
  ActionResult,
  EntryRow,
  ModuleMeta,
  OverviewResult,
  PageResult,
} from '@/data/types'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

export function moduleMeta(key: string): ModuleMeta {
  const meta = MODULE_BY_KEY.get(key)
  if (!meta) {
    throw new Error(`没有登记名为 ${key} 的业务模块`)
  }
  return meta
}

export function filterRows(rows: EntryRow[], filters: Record<string, string>): EntryRow[] {
  const pairs = Object.entries(filters).filter(([, value]) => value.trim() !== '')
  if (pairs.length === 0) {
    return rows
  }
  return rows.filter((row) =>
    pairs.every(([field, value]) => String(row[field] ?? '').includes(value.trim())),
  )
}

export function listEntries(key: string, filters: Record<string, string> = {}): PageResult {
  const matched = filterRows(listRows(key), filters)
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

function findRow(key: string, id: number): { rows: EntryRow[]; index: number; meta: ModuleMeta } | null {
  const meta = moduleMeta(key)
  const rows = listRows(key)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return null
  }
  return { rows, index, meta }
}

function deny(message: string): ActionResult {
  return { ok: false, message }
}

function sameArea(row: EntryRow, ctx?: ActionContext): boolean {
  if (!ctx?.area) {
    return true
  }
  return String(row['所属片区'] ?? '') === ctx.area
}

// ---------------------------------------------------------------------------
// 室温监测：新口径（按采集时间时间加权）专属流转
// ---------------------------------------------------------------------------

function nextServiceId(rows: EntryRow[]): number {
  return rows.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1
}

/**
 * 不达标结论落到入户服务的待上门清单：同一监测点已有待受理/已安排的上门单就沿用，
 * 不重复造单。
 */
function ensureHouseholdVisit(row: EntryRow, ctx?: ActionContext): { ticketId: number; created: boolean } {
  const rows = listRows('householdservice')
  const sourceId = Number(row.id)
  const existing = rows.find(
    (item) =>
      Number(item['室温监测点id'] ?? 0) === sourceId &&
      (String(item.status) === '待受理' || String(item.status) === '已安排'),
  )
  if (existing) {
    return { ticketId: Number(existing.id), created: false }
  }
  const id = nextServiceId(rows)
  const weighted = evaluateRow(row)?.weighted ?? null
  const ticket: EntryRow = {
    id,
    status: '待受理',
    pending: true,
    abnormal: false,
    服务单号: `HOUS-${String(id).padStart(4, '0')}`,
    报修用户: String(row['住户地址'] ?? ''),
    服务内容: `室温不达标上门排查（监测点 ${row['监测编号'] ?? id}，当日加权 ${weighted === null ? '—' : `${weighted.toFixed(1)}℃`}，不在合格范围18℃～24℃）`,
    受理人: ctx?.operator ?? '',
    上门时间: '',
    处理结果: '',
    回访日期: '',
    服务状态: '待受理',
    室温监测点id: sourceId,
  }
  saveRows('householdservice', [...rows, ticket])
  return { ticketId: id, created: true }
}

function persistRoomtemp(rows: EntryRow[], index: number, next: EntryRow): void {
  // 保存前统一走一次口径归一化，不在合格范围内的判定不可能落成「已达标」。
  const updated = normalizeRow({ ...next, pending: isOpenStatus(String(next.status)) })
  const all = [...rows]
  all[index] = updated
  saveRows('roomtemp', all)
}

/**
 * 室温采集报送：
 * - 同一监测点、同一采集时间重复报送只记一次（覆盖读数，不新增条目）；
 * - 读数超出量程 -20℃～60℃，监测点先挂起，等待换热站值班员按片区复核；
 * - 报送后立即按当日时间加权值重算达标判定，住户地址与所属片区不变。
 */
export function submitRoomReading(
  id: number,
  value: number,
  time: string,
  ctx?: ActionContext,
): ActionResult {
  const found = findRow('roomtemp', id)
  if (!found) {
    return deny(`没有找到编号为 ${id} 的室温监测点`)
  }
  const { rows, index } = found
  const row = rows[index]
  if (!sameArea(row, ctx)) {
    return deny(`监测点 ${row['监测编号']} 不属于${ctx?.area}，本片区值班员不能报送`)
  }
  if (!Number.isFinite(value)) {
    return deny('室温读数不是有效数字，无法报送')
  }
  const stamp = String(time ?? '').trim().replace('T', ' ').slice(0, 16)
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(stamp)) {
    return deny('采集时间格式应为 YYYY-MM-DD HH:mm')
  }

  const readings = parseReadings(String(row['采集明细'] ?? ''))
  const existedIndex = readings.findIndex((item) => item.time === stamp)
  if (existedIndex >= 0) {
    readings[existedIndex] = { time: stamp, value }
  } else {
    readings.push({ time: stamp, value })
  }
  const evaluated = evaluateDetail(serializeReadings(readings))
  const status =
    evaluated?.verdict === VERDICT_SUSPENDED
      ? STATUS_SUSPENDED
      : evaluated === null
        ? STATUS_PENDING
        : STATUS_COLLECTED
  persistRoomtemp(rows, index, {
    ...row,
    采集明细: serializeReadings(readings),
    status,
    abnormal: false,
    处理人: ctx?.operator ?? row['处理人'],
  })
  if (existedIndex >= 0) {
    return { ok: true, message: `监测点 ${row['监测编号']} ${stamp} 已有报送，已按本次读数更新，只记一次` }
  }
  if (status === STATUS_SUSPENDED) {
    return { ok: true, message: `监测点 ${row['监测编号']} 读数 ${value}℃ 超出量程，已挂起，等待片区复核` }
  }
  return { ok: true, message: `监测点 ${row['监测编号']} 采集已记录，达标判定已按当日时间加权重算` }
}

/**
 * 换热站值班员按片区复核挂起读数：只能复核本片区、已挂起的监测点。
 * readings 为复核后确认保留的采集明细（剔除异常读数），随后按新口径重新判定。
 */
export function reviewSuspendedReading(
  id: number,
  readingsText: string,
  ctx?: ActionContext,
): ActionResult {
  const found = findRow('roomtemp', id)
  if (!found) {
    return deny(`没有找到编号为 ${id} 的室温监测点`)
  }
  const { rows, index } = found
  const row = rows[index]
  if (String(row.status) !== STATUS_SUSPENDED) {
    return deny(`监测点 ${row['监测编号']} 当前不是挂起状态，无需片区复核`)
  }
  if (!ctx?.area) {
    return deny('未指定值班片区，不能执行片区复核')
  }
  if (!sameArea(row, ctx)) {
    return deny(`监测点 ${row['监测编号']} 不属于${ctx.area}，应由${row['所属片区']}片区值班员复核`)
  }
  const readings = parseReadings(readingsText)
  const evaluated = evaluateDetail(serializeReadings(readings))
  if (evaluated?.verdict === VERDICT_SUSPENDED) {
    persistRoomtemp(rows, index, {
      ...row,
      采集明细: serializeReadings(readings),
      status: STATUS_SUSPENDED,
      abnormal: true,
      处理人: ctx.operator ?? row['处理人'],
    })
    return deny('复核后仍保留超出量程的读数，监测点继续挂起')
  }
  const status = evaluated === null ? STATUS_PENDING : STATUS_COLLECTED
  persistRoomtemp(rows, index, {
    ...row,
    采集明细: serializeReadings(readings),
    status,
    abnormal: false,
    处理人: ctx.operator ?? row['处理人'],
  })
  return { ok: true, message: `监测点 ${row['监测编号']} 已由${ctx.area}片区复核，重新判定：${evaluated ? evaluated.verdict : '无有效读数'}` }
}

function runRoomtempAction(id: number, action: string, ctx?: ActionContext): ActionResult {
  const found = findRow('roomtemp', id)
  if (!found) {
    return deny(`没有找到编号为 ${id} 的室温监测点`)
  }
  const { rows, index, meta } = found
  const row = rows[index]
  const current = String(row.status)

  if (action === '判定达标') {
    if (current === STATUS_MEET) {
      return deny('监测点已经是「已达标」，不用重复操作')
    }
    if (current !== STATUS_COLLECTED) {
      return deny(`监测点当前为「${current}」，完成采集并算出加权值后才能判定达标`)
    }
    const result = evaluateRow(row)
    // 合格范围与判定条件：加权值必须落在 [18℃, 24℃]，否则不允许保存成已达标。
    if (!result || result.verdict !== VERDICT_MEET || result.weighted === null) {
      const reason =
        result?.verdict === VERDICT_NODATA
          ? '当日没有有效读数'
          : result?.verdict === VERDICT_SUSPENDED
            ? '存在超出量程的读数，已挂起'
            : `当日时间加权值 ${result?.weighted?.toFixed(1) ?? '—'}℃ 不在合格范围 18℃～24℃`
      return deny(`不允许判定达标：${reason}`)
    }
    persistRoomtemp(rows, index, { ...row, status: STATUS_MEET, abnormal: false, 处理人: ctx?.operator ?? row['处理人'] })
    return { ok: true, message: `监测点 ${row['监测编号']} 当日加权 ${result.weighted.toFixed(1)}℃，已达标` }
  }

  if (action === '标记不达标') {
    if (current === STATUS_FAIL) {
      return deny('监测点已经是「不达标」，不用重复操作')
    }
    if (current !== STATUS_COLLECTED) {
      return deny(`监测点当前为「${current}」，不能直接标记不达标`)
    }
    const result = evaluateRow(row)
    if (!result || (result.verdict !== VERDICT_FAIL && result.verdict !== VERDICT_MEET)) {
      return deny('监测点读数尚未形成有效判定，不能标记不达标')
    }
    // 规则拦截：加权值在合格范围内，不允许落成不达标。
    if (result.verdict === VERDICT_MEET) {
      return deny(`当日时间加权值 ${result.weighted?.toFixed(1)}℃ 在合格范围 18℃～24℃，不能标记不达标`)
    }
    persistRoomtemp(rows, index, { ...row, status: STATUS_FAIL, abnormal: false, 处理人: ctx?.operator ?? row['处理人'] })
    const visit = ensureHouseholdVisit(row, ctx)
    return {
      ok: true,
      ticketId: visit.ticketId,
      message: visit.created
        ? `监测点 ${row['监测编号']} 加权 ${result.weighted?.toFixed(1)}℃ 不达标，已生成入户服务单 HOUS-${String(visit.ticketId).padStart(4, '0')} 进入待上门清单`
        : `监测点 ${row['监测编号']} 不达标，既有入户服务单 HOUS-${String(visit.ticketId).padStart(4, '0')} 仍在待上门清单`,
    }
  }

  if (action === '片区复核') {
    return reviewSuspendedReading(id, String(row['采集明细'] ?? ''), ctx)
  }

  if (action === '提交采集') {
    return deny('采集请通过「报送读数」填写采集时间与室温读数，系统会自动按新口径判定')
  }

  return deny(`${meta.entity}没有登记「${action}」这个动作`)
}

export function runAction(key: string, id: number, action: string, ctx?: ActionContext): ActionResult {
  const meta = moduleMeta(key)
  if (key === 'roomtemp') {
    return runRoomtempAction(id, action, ctx)
  }
  const target = meta.actionTargets[action]
  if (!target) {
    return deny(`${meta.entity}没有登记「${action}」这个动作`)
  }
  const rows = listRows(key)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return deny(`没有找到编号为 ${id} 的${meta.entity}`)
  }
  const current = String(rows[index].status)
  if (current === target) {
    return deny(`${meta.entity}已经是「${target}」，不用重复操作`)
  }
  const lastStatus = meta.statuses[meta.statuses.length - 1]
  const updated: EntryRow = {
    ...rows[index],
    status: target,
    pending: target !== lastStatus,
    abnormal: NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb)),
  }
  const next = [...rows]
  next[index] = updated
  saveRows(key, next)
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」` }
}

export function resetModule(key: string): PageResult {
  resetRows(key)
  return listEntries(key)
}

// CSV 单元格转义：含逗号、引号或换行（室温采集明细有多行）时按 RFC 4180 加双引号。
function csvCell(value: unknown): string {
  const text = String(value ?? '')
  if (/[",\n\r]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`
  }
  return text
}

export function exportEntries(key: string): { filename: string; content: string } {
  const meta = moduleMeta(key)
  const header = ['编号', ...meta.fields, '当前状态']
  const lines = [header.map(csvCell).join(',')]
  // 与台账同一路径取数：listRows 对室温数据做口径归一化，导出的达标判定与页面一致。
  for (const row of listRows(key)) {
    lines.push([row.id, ...meta.fields.map((field) => csvCell(row[field])), csvCell(row.status)].join(','))
  }
  return { filename: `${meta.name}-清单.csv`, content: `﻿${lines.join('\n')}` }
}

export function downloadEntries(key: string): void {
  const { filename, content } = exportEntries(key)
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

export function loadOverview(): OverviewResult {
  const rows = allRows()
  const modules = [...MODULE_BY_KEY.values()].map((meta) => {
    const entries = listRows(meta.key)
    return {
      name: meta.name,
      created: entries.length,
      pending: entries.filter((row) => row.pending).length,
      abnormal: entries.filter((row) => row.abnormal).length,
    }
  })
  const cards = [
    { label: '业务模块', value: modules.length },
    { label: '登记总量', value: modules.reduce((sum, item) => sum + item.created, 0) },
    { label: '待处理', value: modules.reduce((sum, item) => sum + item.pending, 0) },
    { label: '异常量', value: modules.reduce((sum, item) => sum + item.abnormal, 0) },
  ]
  return { cards, modules }
}
