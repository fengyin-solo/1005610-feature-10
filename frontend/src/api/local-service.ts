import { MODULE_BY_KEY } from '@/data/modules'
import { allRows, listRows, resetRows, saveRows } from '@/data/local-store'
import type { ActionResult, EntryRow, ModuleMeta, OverviewResult, PageResult } from '@/data/types'
import {
  ROOMTEMP_DETAIL_FIELD,
  ROOMTEMP_SOURCE_FIELD,
  ROOMTEMP_STATUS_COLLECTED,
  ROOMTEMP_STATUS_QUALIFIED,
  ROOMTEMP_STATUS_REVIEWING,
  ROOMTEMP_STATUS_SUSPENDED,
  ROOMTEMP_STATUS_UNQUALIFIED,
  buildHouseholdVisit,
  deriveRoomTempRow,
  householdVisitSource,
  latestDaySummary,
  outcomeForSummary,
  parseReadings,
  roomtempFlags,
  sameCollectItems,
  serializeReadings,
} from '@/data/roomtemp-rules'
import type { CollectItem, StoredReading } from '@/data/roomtemp-rules'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

const ROOMTEMP_KEY = 'roomtemp'
const HOUSEHOLD_KEY = 'householdservice'

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

// 室温台账的室温读数、采集时间、达标判定不入库，每次读取都按新口径统一派生，台账与导出天然一致。
function presentRows(key: string, rows: EntryRow[]): EntryRow[] {
  return key === ROOMTEMP_KEY ? rows.map(deriveRoomTempRow) : rows
}

export function listEntries(key: string, filters: Record<string, string> = {}): PageResult {
  const matched = filterRows(listRows(key), filters)
  const items = presentRows(key, matched)
  return { items, total: items.length, page: 1, size: items.length }
}

function saveRoomTempRow(index: number, updated: EntryRow): void {
  const rows = listRows(ROOMTEMP_KEY)
  const next = [...rows]
  next[index] = updated
  saveRows(ROOMTEMP_KEY, next)
}

// 不达标自动落到入户服务待上门清单：同一监测点同一天只挂一张单。
function ensureHouseholdVisit(monitorRow: EntryRow): ActionResult | null {
  const readings = parseReadings(monitorRow)
  const summary = latestDaySummary(readings)
  if (!summary || String(monitorRow.status) !== ROOMTEMP_STATUS_UNQUALIFIED) {
    return null
  }
  const source = householdVisitSource(String(monitorRow.监测编号 ?? ''), summary.day)
  const visits = listRows(HOUSEHOLD_KEY)
  if (visits.some((row) => row[ROOMTEMP_SOURCE_FIELD] === source)) {
    return null
  }
  const nextId = visits.reduce((max, row) => Math.max(max, Number(row.id)), 0) + 1
  saveRows(HOUSEHOLD_KEY, [...visits, buildHouseholdVisit(monitorRow, summary, nextId)])
  return { ok: true, message: '已自动生成入户服务待上门单' }
}

// 判定口径写死：只有日加权值落在 18~24℃ 才允许保存为已达标；挂起、未采集、超量程一律挡住。
function manualJudge(
  index: number,
  row: EntryRow,
  target: typeof ROOMTEMP_STATUS_QUALIFIED | typeof ROOMTEMP_STATUS_UNQUALIFIED,
  reviewer: string,
): ActionResult {
  const summary = latestDaySummary(parseReadings(row))
  if (!summary) {
    return { ok: false, message: '该监测点还没有采集读数，不能判定' }
  }
  if (summary.outOfRange) {
    return { ok: false, message: '最新一天存在超出量程的读数，按规则先挂起，不能判定' }
  }
  if (summary.weighted === null) {
    return { ok: false, message: '缺少有效读数，无法计算日加权值' }
  }
  const qualified = summary.weighted >= 18 && summary.weighted <= 24
  if (target === ROOMTEMP_STATUS_QUALIFIED && !qualified) {
    return {
      ok: false,
      message: `日加权值 ${summary.weighted.toFixed(1)}℃ 不在合格范围 18~24℃，不允许保存为已达标`,
    }
  }
  if (target === ROOMTEMP_STATUS_UNQUALIFIED && qualified) {
    return { ok: false, message: `日加权值 ${summary.weighted.toFixed(1)}℃ 在合格范围 18~24℃，不能标记不达标` }
  }
  const readings = parseReadings(row).map((item) =>
    item.day === summary.day ? { ...item, reviewed: true } : item,
  )
  const flags = roomtempFlags(target)
  const updated: EntryRow = {
    ...row,
    status: target,
    pending: flags.pending,
    abnormal: flags.abnormal,
    处理人: reviewer || String(row.处理人 ?? ''),
    监测状态: target,
    [ROOMTEMP_DETAIL_FIELD]: serializeReadings(readings),
  }
  saveRoomTempRow(index, updated)
  const visit = ensureHouseholdVisit(updated)
  return {
    ok: true,
    message: `日加权值 ${summary.weighted.toFixed(1)}℃，已保存为「${target}」${visit ? `；${visit.message}` : ''}`,
  }
}

// 换热站值班员按片区复核：复核即沿用既有监测判定规则自动落达标/不达标/挂起。
function reviewPoint(index: number, row: EntryRow, reviewer: string): ActionResult {
  if (String(row.status) !== ROOMTEMP_STATUS_REVIEWING) {
    return { ok: false, message: '只有待复核的监测点能执行片区复核' }
  }
  const summary = latestDaySummary(parseReadings(row))
  if (!summary) {
    return { ok: false, message: '该监测点没有可复核的采集读数' }
  }
  if (summary.outOfRange) {
    return { ok: false, message: '最新一天存在超出量程的读数，按规则先挂起，不能复核判定' }
  }
  const readings = parseReadings(row).map((item) =>
    item.day === summary.day ? { ...item, reviewed: true } : item,
  )
  const target = outcomeForSummary(summary)
  const flags = roomtempFlags(target)
  const updated: EntryRow = {
    ...row,
    status: target,
    pending: flags.pending,
    abnormal: flags.abnormal,
    处理人: reviewer,
    监测状态: target,
    [ROOMTEMP_DETAIL_FIELD]: serializeReadings(readings),
  }
  saveRoomTempRow(index, updated)
  const visit = ensureHouseholdVisit(updated)
  const basis =
    summary.outOfRange || summary.weighted === null
      ? '存在超出量程的读数，已挂起'
      : `日加权值 ${summary.weighted.toFixed(1)}℃，判定「${target}」`
  return { ok: true, message: `${String(updated.监测编号)} 复核完成：${basis}${visit ? `；${visit.message}` : ''}` }
}

export function runAction(key: string, id: number, action: string): ActionResult {
  const meta = moduleMeta(key)
  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }
  const rows = listRows(key)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }
  const row = rows[index]
  const current = String(row.status)
  if (current === target) {
    return { ok: false, message: `${meta.entity}已经是「${target}」，不用重复操作` }
  }

  // 室温监测走新口径：合格范围、挂起、复核都在领域规则里，页面不做业务判断。
  if (key === ROOMTEMP_KEY) {
    if (action === '提交采集') {
      return { ok: false, message: '采集报送请使用「提交采集」填报入口，支持一天多条采集时间' }
    }
    if (action === '片区复核') {
      return reviewPoint(index, row, '换热站值班员')
    }
    if (action === '解除挂起') {
      if (current !== ROOMTEMP_STATUS_SUSPENDED) {
        return { ok: false, message: '只有已挂起的监测点能解除挂起' }
      }
      const summary = latestDaySummary(parseReadings(row))
      if (summary?.outOfRange) {
        return { ok: false, message: '最新一天仍有超出量程的读数，请重新采集有效读数后再解除挂起' }
      }
      const flags = roomtempFlags(ROOMTEMP_STATUS_REVIEWING)
      saveRoomTempRow(index, {
        ...row,
        status: ROOMTEMP_STATUS_REVIEWING,
        pending: flags.pending,
        abnormal: flags.abnormal,
        监测状态: ROOMTEMP_STATUS_REVIEWING,
      })
      return { ok: true, message: '已解除挂起，监测点回到待复核' }
    }
    if (action === '判定达标') {
      return manualJudge(index, row, ROOMTEMP_STATUS_QUALIFIED, String(row.处理人 ?? '换热站值班员'))
    }
    if (action === '标记不达标') {
      return manualJudge(index, row, ROOMTEMP_STATUS_UNQUALIFIED, String(row.处理人 ?? '换热站值班员'))
    }
  }

  const lastStatus = meta.statuses[meta.statuses.length - 1]
  const updated: EntryRow = {
    ...row,
    status: target,
    pending: target !== lastStatus,
    abnormal: NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb)),
  }
  const next = [...rows]
  next[index] = updated
  saveRows(key, next)
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」` }
}

function normalizeCollectItems(items: CollectItem[]): CollectItem[] | null {
  const normalized = items
    .map((item) => ({
      time: String(item.time ?? '').trim(),
      value: Number(item.value),
    }))
    .filter((item) => item.time !== '' || Number.isFinite(item.value))
  if (!normalized.length) {
    return null
  }
  const timePattern = /^([01]\d|2[0-3]):[0-5]\d$/
  if (normalized.some((item) => !timePattern.test(item.time) || !Number.isFinite(item.value))) {
    return null
  }
  return normalized.sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : 0))
}

// 采集报送：同一监测点同一天重复提交完全相同的读数只记一次；改数重报按最新一次覆盖并重新复核。
// 读数超出 0~50℃ 量程：记录保留但监测点先挂起，不允许直接进入达标判定。
export function submitRoomTempCollection(
  id: number,
  day: string,
  items: CollectItem[],
  handler: string,
): ActionResult {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
    return { ok: false, message: '采集日期格式应为 YYYY-MM-DD' }
  }
  const normalized = normalizeCollectItems(items)
  if (!normalized) {
    return { ok: false, message: '请填写有效的采集时间（HH:mm）与室温读数' }
  }
  const rows = listRows(ROOMTEMP_KEY)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的室温监测点` }
  }
  const row = rows[index]
  const stored = parseReadings(row)
  const sameDay = stored.filter((item) => item.day === day)
  const sameDayItems = sameDay.map((item) => ({ time: item.time, value: item.value }))
  if (sameDay.length > 0 && sameCollectItems(sameDayItems, normalized)) {
    return { ok: false, message: `${day} 的采集数据与已报送内容完全一致，重复报送只记一次` }
  }

  const outOfRange = normalized.some((item) => item.value < 0 || item.value > 50)
  const merged: StoredReading[] = [
    ...stored.filter((item) => item.day !== day),
    ...normalized.map((item) => ({ day, time: item.time, value: item.value, reviewed: false })),
  ]

  const previousStatus = String(row.status)
  let target: string
  if (outOfRange) {
    target = ROOMTEMP_STATUS_SUSPENDED
  } else if (previousStatus === ROOMTEMP_STATUS_SUSPENDED) {
    // 挂起期间补采的有效读数先记录，值班员解除挂起后再进复核队列。
    target = ROOMTEMP_STATUS_SUSPENDED
  } else {
    target = ROOMTEMP_STATUS_REVIEWING
  }
  const flags = roomtempFlags(target)
  const updated: EntryRow = {
    ...row,
    status: target,
    pending: flags.pending,
    abnormal: flags.abnormal,
    处理人: handler || String(row.处理人 ?? ''),
    监测状态: target,
    [ROOMTEMP_DETAIL_FIELD]: serializeReadings(merged),
  }
  saveRoomTempRow(index, updated)

  const summary = latestDaySummary(merged)
  if (outOfRange) {
    const badValues = normalized.filter((item) => item.value < 0 || item.value > 50).map((item) => item.value)
    return {
      ok: true,
      message: `已记录 ${normalized.length} 条采集，读数 ${badValues.join('、')}℃ 超出 0~50℃ 量程，监测点先挂起`,
    }
  }
  const weightedText = summary?.weighted === undefined || summary?.weighted === null ? '—' : summary.weighted.toFixed(1)
  if (target === ROOMTEMP_STATUS_SUSPENDED) {
    return { ok: true, message: `已补记有效读数（日加权 ${weightedText}℃），请值班员解除挂起后进入片区复核` }
  }
  return { ok: true, message: `已记录 ${normalized.length} 条采集，日加权 ${weightedText}℃，已进入待片区复核队列` }
}

// 换热站值班员按片区批量复核：只处理本片区待复核的监测点。
export function reviewRoomTempDistrict(district: string, reviewer: string): ActionResult {
  const rows = listRows(ROOMTEMP_KEY)
  const queue = rows
    .map((row, index) => ({ row, index }))
    .filter(
      ({ row }) =>
        String(row.所属片区 ?? '') === district && String(row.status) === ROOMTEMP_STATUS_REVIEWING,
    )
  if (!queue.length) {
    return { ok: false, message: `${district}当前没有待复核的监测点` }
  }
  let qualified = 0
  let unqualified = 0
  for (const { row, index } of queue) {
    const result = reviewPoint(index, row, reviewer)
    if (result.message.includes('「已达标」')) {
      qualified += 1
    } else if (result.message.includes('「不达标」')) {
      unqualified += 1
    }
  }
  return {
    ok: true,
    message: `${district}复核完成：共 ${queue.length} 个监测点，达标 ${qualified} 个、不达标 ${unqualified} 个；不达标已转入入户服务待上门清单`,
  }
}

export function roomtempDistrictQueue(district: string): EntryRow[] {
  return presentRows(
    ROOMTEMP_KEY,
    listRows(ROOMTEMP_KEY).filter(
      (row) =>
        String(row.所属片区 ?? '') === district &&
        [ROOMTEMP_STATUS_REVIEWING, ROOMTEMP_STATUS_SUSPENDED].includes(String(row.status)),
    ),
  )
}

export function roomtempMetrics(): { label: string; value: number }[] {
  const rows = listRows(ROOMTEMP_KEY)
  const count = (status: string) => rows.filter((row) => String(row.status) === status).length
  return [
    { label: '待采集点位', value: count(ROOMTEMP_STATUS_COLLECTED) },
    { label: '待复核点位', value: count(ROOMTEMP_STATUS_REVIEWING) },
    { label: '不达标点位', value: count(ROOMTEMP_STATUS_UNQUALIFIED) },
    { label: '已挂起点位', value: count(ROOMTEMP_STATUS_SUSPENDED) },
  ]
}

export function resetModule(key: string): PageResult {
  resetRows(key)
  return listEntries(key)
}

export function exportEntries(key: string): { filename: string; content: string } {
  const meta = moduleMeta(key)
  const header = ['编号', ...meta.fields, '当前状态']
  const lines = [header.join(',')]
  // 室温导出表与台账共用同一份派生结果，达标判定不可能出现两套口径。
  for (const row of presentRows(key, listRows(key))) {
    lines.push([row.id, ...meta.fields.map((field) => row[field] ?? ''), row.status].join(','))
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
    const entries = rows[meta.key] ?? []
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
