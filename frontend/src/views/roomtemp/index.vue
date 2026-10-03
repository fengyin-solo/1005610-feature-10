<template>
  <section class="page" data-module="roomtemp">
    <header class="page-head">
      <div>
        <h2>室温监测管理</h2>
        <p class="page-desc">维护室温监测点，围绕监测编号、住户地址、所属片区、室温读数做登记、筛选与状态流转。室温读数按一天内采集时间加权平均后判定，住户地址与所属片区不随重算变化。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记室温监测点</button>
        <button class="btn" type="button" @click="exportRows">导出室温监测清单</button>
      </div>
    </header>

    <div class="rule-banner">
      达标口径：按一天内各条采集时间计算时间加权平均室温，<strong>18℃~24℃（含边界）为达标</strong>，
      低于 18℃ 或高于 24℃ 为不达标；读数超出设备量程 <strong>0℃~50℃</strong> 的监测点先挂起，
      不在合格范围内的不允许保存为已达标。不达标结果自动转入入户服务待上门清单。
    </div>

    <div class="stat-row">
      <article v-for="item in metricCards" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button class="link" type="button" @click="openCollect(row)">提交采集</button>
            <template v-if="String(row.status) === '待复核'">
              <button class="link" type="button" @click="runAction('判定达标', row)">判定达标</button>
              <button class="link" type="button" @click="runAction('标记不达标', row)">标记不达标</button>
            </template>
            <button
              v-if="String(row.status) === '已挂起'"
              class="link"
              type="button"
              @click="runAction('解除挂起', row)"
            >
              解除挂起
            </button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无室温监测数据，可先登记室温监测点</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条室温监测记录</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
      <span v-else-if="successMessage" class="success-text">{{ successMessage }}</span>
    </footer>

    <div v-if="collectOpen" class="modal-mask" @click.self="closeCollect">
      <div class="modal">
        <h3>提交采集报送 · {{ String(collectRow?.监测编号 ?? '') }}</h3>
        <p class="page-desc">{{ String(collectRow?.住户地址 ?? '') }}（{{ String(collectRow?.所属片区 ?? '') }}）</p>
        <p class="page-desc">
          同一监测点同一天重复报送相同读数只记一次；改数重报按最新一次覆盖并重新进入片区复核。
          读数超出 0~50℃ 量程，监测点先挂起。
        </p>
        <div class="modal-form">
          <label class="filter-item">
            <span>采集日期</span>
            <input v-model="collectDay" type="date" />
          </label>
          <label class="filter-item">
            <span>报送人</span>
            <input v-model="collectHandler" placeholder="采集/报送人" />
          </label>
        </div>
        <table class="data-table collect-table">
          <thead>
            <tr><th>采集时间</th><th>室温读数(℃)</th><th>操作</th></tr>
          </thead>
          <tbody>
            <tr v-for="(item, index) in collectItems" :key="index">
              <td><input v-model="item.time" type="time" /></td>
              <td><input v-model.number="item.value" type="number" step="0.1" min="-50" max="100" /></td>
              <td>
                <button class="link" type="button" @click="removeCollectItem(index)">删除</button>
              </td>
            </tr>
          </tbody>
        </table>
        <div class="modal-actions">
          <button class="btn" type="button" @click="addCollectItem">增加一条读数</button>
          <span class="spacer"></span>
          <button class="btn ghost" type="button" @click="closeCollect">取消</button>
          <button class="btn primary" type="button" @click="submitCollect">提交采集报送</button>
        </div>
        <p v-if="collectError" class="error-text">{{ collectError }}</p>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  downloadEntries,
  listEntries,
  moduleMeta,
  roomtempMetrics,
  runAction as applyAction,
  submitRoomTempCollection,
} from '@/api/local-service'
import type { CollectItem } from '@/data/roomtemp-rules'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('roomtemp')
const columns = ["监测编号", "住户地址", "所属片区", "室温读数", "采集时间", "达标判定", "处理人", "监测状态"]
const statuses = ["待采集", "待复核", "已达标", "不达标", "已挂起"]

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const successMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
const metricCards = ref<{ label: string; value: number }[]>([])
const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

const collectOpen = ref(false)
const collectRow = ref<EntryRow | null>(null)
const collectDay = ref('2026-10-02')
const collectHandler = ref('')
const collectItems = ref<CollectItem[]>([])
const collectError = ref('')

function todayText(): string {
  const date = new Date()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '室温监测点登记入口尚未接入审批流'
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  successMessage.value = ''
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  successMessage.value = result.message
  reload()
}

function openCollect(row: EntryRow) {
  errorMessage.value = ''
  collectError.value = ''
  collectRow.value = row
  collectDay.value = todayText()
  collectHandler.value = String(row.处理人 ?? '') === '待派单' ? '' : String(row.处理人 ?? '')
  collectItems.value = [{ time: '08:00', value: 19 }]
  collectOpen.value = true
}

function closeCollect() {
  collectOpen.value = false
  collectRow.value = null
  collectItems.value = []
  collectError.value = ''
}

function addCollectItem() {
  collectItems.value.push({ time: '20:00', value: 19 })
}

function removeCollectItem(index: number) {
  collectItems.value.splice(index, 1)
}

function submitCollect() {
  if (!collectRow.value) {
    return
  }
  collectError.value = ''
  const result = submitRoomTempCollection(
    Number(collectRow.value.id),
    collectDay.value,
    collectItems.value,
    collectHandler.value,
  )
  if (!result.ok) {
    collectError.value = result.message
    return
  }
  closeCollect()
  successMessage.value = result.message
  reload()
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
    metricCards.value = roomtempMetrics()
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '室温监测列表读取失败'
  }
}

onMounted(reload)
</script>
