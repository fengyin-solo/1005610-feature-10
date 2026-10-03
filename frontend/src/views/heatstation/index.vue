<template>
  <section class="page" data-module="heatstation">
    <header class="page-head">
      <div>
        <h2>换热站台账管理</h2>
        <p class="page-desc">维护换热站，围绕站名、所属片区、供热面积、换热机组数做登记、筛选与状态流转。换热站值班员按所属片区复核室温监测读数。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记换热站</button>
        <button class="btn" type="button" @click="exportRows">导出换热站台账清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
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
            <button
              v-for="action in actions"
              :key="action"
              class="link"
              type="button"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
            <button class="link" type="button" @click="openReview(row)">片区复核室温读数</button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无换热站台账数据，可先登记换热站</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条换热站台账记录</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
      <span v-else-if="successMessage" class="success-text">{{ successMessage }}</span>
    </footer>

    <div v-if="reviewOpen" class="modal-mask" @click.self="closeReview">
      <div class="modal wide">
        <h3>片区复核室温读数 · {{ reviewDistrict }}</h3>
        <p class="page-desc">
          复核人：{{ reviewer }}。复核按新口径自动落判定：日加权 18~24℃ 判达标，其余判不达标；
          读数超 0~50℃ 量程的保持挂起；不达标自动转入入户服务待上门清单。
        </p>
        <table class="data-table">
          <thead>
            <tr>
              <th>监测编号</th>
              <th>住户地址</th>
              <th>室温读数</th>
              <th>采集时间</th>
              <th>达标判定</th>
              <th>当前状态</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in reviewQueue" :key="String(row.id)">
              <td>{{ row.监测编号 }}</td>
              <td>{{ row.住户地址 }}</td>
              <td>{{ row.室温读数 }}</td>
              <td>{{ row.采集时间 }}</td>
              <td>{{ row.达标判定 }}</td>
              <td>{{ row.status }}</td>
              <td class="row-actions">
                <button
                  v-if="String(row.status) === '待复核'"
                  class="link"
                  type="button"
                  @click="reviewOne(row)"
                >
                  通过复核
                </button>
                <span v-else class="muted-text">已挂起，待有效补采</span>
              </td>
            </tr>
            <tr v-if="!reviewQueue.length">
              <td colspan="7" class="empty-state">该片区当前没有待复核或已挂起的监测点</td>
            </tr>
          </tbody>
        </table>
        <div class="modal-actions">
          <button class="btn primary" type="button" @click="reviewAll">一键复核本片区全部待复核点位</button>
          <span class="spacer"></span>
          <button class="btn ghost" type="button" @click="closeReview">关闭</button>
        </div>
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
  reviewRoomTempDistrict,
  roomtempDistrictQueue,
  runAction as applyAction,
} from '@/api/local-service'
import { useSessionStore } from '@/stores/session'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('heatstation')
const columns = ["站名", "所属片区", "供热面积", "换热机组数", "投运日期", "站长", "设计负荷", "站点状态"]
const actions = ["提交投运", "登记停运", "办理移交"]
const statuses = ["待投运", "运行中", "已停运", "已移交"]
const stats = [{"label": "运行中站点", "value": 0}, {"label": "待投运站点", "value": 0}, {"label": "累计供热面积", "value": 0}]

const session = useSessionStore()
const reviewer = computed(() => `${session.operator}（换热站值班员）`)

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const successMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

const reviewOpen = ref(false)
const reviewDistrict = ref('')
const reviewQueue = ref<EntryRow[]>([])

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '换热站登记入口尚未接入审批流'
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

function openReview(row: EntryRow) {
  reviewDistrict.value = String(row.所属片区 ?? '')
  errorMessage.value = ''
  refreshReviewQueue()
  reviewOpen.value = true
}

function refreshReviewQueue() {
  reviewQueue.value = roomtempDistrictQueue(reviewDistrict.value)
}

function closeReview() {
  reviewOpen.value = false
  reviewDistrict.value = ''
  reviewQueue.value = []
  reload()
}

function reviewOne(row: EntryRow) {
  errorMessage.value = ''
  successMessage.value = ''
  const result = applyAction('roomtemp', Number(row.id), '片区复核')
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  successMessage.value = result.message
  refreshReviewQueue()
}

function reviewAll() {
  errorMessage.value = ''
  const result = reviewRoomTempDistrict(reviewDistrict.value, reviewer.value)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  successMessage.value = result.message
  refreshReviewQueue()
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '换热站台账列表读取失败'
  }
}

onMounted(reload)
</script>
