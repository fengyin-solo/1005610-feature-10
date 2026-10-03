<template>
  <section class="page" data-module="roomtemp">
    <header class="page-head">
      <div>
        <h2>室温监测管理</h2>
        <p class="page-desc">按采集时间时间加权的室温达标监测：住户地址、所属片区登记后不变，达标判定随每次报送自动重算。</p>
      </div>
      <div class="page-actions">
        <button class="btn" type="button" @click="exportRows">导出室温监测清单</button>
      </div>
    </header>

    <div class="rule-card">
      <strong>达标口径（2026 供暖季）</strong>
      <ul class="rule-list">
        <li>合格范围：当日按采集时间时间加权值在 <b>18℃～24℃</b>（含边界）为达标，不在范围内不允许保存成「已达标」。</li>
        <li>一天多次采集按采集时间分段加权；同一天重复报送只记一次（同一采集时间覆盖原读数）。</li>
        <li>室温读数超出量程 <b>-20℃～60℃</b> 先挂起，由换热站值班员按所属片区复核后重新判定。</li>
        <li>判定为不达标自动生成入户服务单，进入入户服务「待上门清单」。</li>
      </ul>
      <div class="duty-bar">
        <label class="filter-item">
          <span>换热站值班片区（复核权限）</span>
          <select v-model="store.area" @change="reload">
            <option v-for="area in DUTY_AREAS" :key="area" :value="area">{{ area }}</option>
          </select>
        </label>
        <span class="duty-tip">值班员：{{ store.operator }}，仅可报送/复核本片区监测点</span>
      </div>
    </div>

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
          <td v-for="column in columns" :key="column">
            <template v-if="column === '采集明细'">
              <span class="reading-lines">{{ formatReadings(String(row[column] ?? '')) }}</span>
            </template>
            <template v-else>{{ row[column] === '' || row[column] == null ? '—' : row[column] }}</template>
          </td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button class="link" type="button" @click="openSubmit(row)">报送读数</button>
            <button
              v-if="String(row.status) === '已采集'"
              class="link"
              type="button"
              @click="runAction('判定达标', row)"
            >
              判定达标
            </button>
            <button
              v-if="String(row.status) === '已采集'"
              class="link"
              type="button"
              @click="runAction('标记不达标', row)"
            >
              标记不达标
            </button>
            <button
              v-if="String(row.status) === '已挂起' && inMyArea(row)"
              class="link"
              type="button"
              @click="openReview(row)"
            >
              片区复核
            </button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无室温监测数据</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条室温监测记录</span>
      <span v-if="message" :class="messageOk ? 'ok-text' : 'error-text'">{{ message }}</span>
    </footer>

    <div v-if="submitTarget" class="modal-mask" @click.self="closeDialogs">
      <form class="modal" @submit.prevent="confirmSubmit">
        <h3>报送室温读数</h3>
        <p class="modal-desc">
          {{ submitTarget['监测编号'] }} · {{ submitTarget['住户地址'] }} · {{ submitTarget['所属片区'] }}
        </p>
        <label class="modal-field">
          <span>采集时间</span>
          <input v-model="submitTime" type="datetime-local" required />
        </label>
        <label class="modal-field">
          <span>室温读数（℃，量程 -20～60）</span>
          <input v-model.number="submitValue" type="number" step="0.1" required />
        </label>
        <p class="modal-tip">同一采集时间重复报送将覆盖原读数，只记一次；提交后自动按当日时间加权重算。</p>
        <div class="modal-actions">
          <button class="btn" type="button" @click="closeDialogs">取消</button>
          <button class="btn primary" type="submit">提交报送</button>
        </div>
      </form>
    </div>

    <div v-if="reviewTarget" class="modal-mask" @click.self="closeDialogs">
      <form class="modal" @submit.prevent="confirmReview">
        <h3>片区复核（{{ store.area }}）</h3>
        <p class="modal-desc">
          {{ reviewTarget['监测编号'] }} · {{ reviewTarget['住户地址'] }} · 当前判定：{{ reviewTarget['达标判定'] }}
        </p>
        <label class="modal-field">
          <span>复核后采集明细（每行一条：采集时间=读数，删除异常读数行即剔除）</span>
          <textarea v-model="reviewText" rows="6"></textarea>
        </label>
        <p class="modal-tip">仍保留超出量程（-20℃～60℃）读数的监测点会继续挂起。</p>
        <div class="modal-actions">
          <button class="btn" type="button" @click="closeDialogs">取消</button>
          <button class="btn primary" type="submit">确认复核并重判</button>
        </div>
      </form>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  downloadEntries,
  listEntries,
  moduleMeta,
  reviewSuspendedReading,
  runAction as applyAction,
  submitRoomReading,
} from '@/api/local-service'
import { useSessionStore, DUTY_AREAS } from '@/stores/session'
import {
  STATUS_FAIL,
  STATUS_MEET,
  STATUS_PENDING,
} from '@/data/roomtemp'
import type { EntryRow } from '@/data/types'

const store = useSessionStore()
const meta = moduleMeta('roomtemp')
const columns = ["监测编号", "住户地址", "所属片区", "室温读数", "采集时间", "达标判定", "处理人", "监测状态", "采集明细"]
const statuses = ["待采集", "已采集", "已挂起", "已达标", "不达标"]

const rows = ref<EntryRow[]>([])
const total = ref(0)
const message = ref('')
const messageOk = ref(false)
const filters = ref<Record<string, string>>({})
const filterFields = ["监测编号", "住户地址", "所属片区", "达标判定"]
const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

// 本月达标率：最近采集日落在当月且已确认达标的监测点 / 当月已有判定结论的监测点。
const stats = computed(() => {
  const month = new Date().toISOString().slice(0, 7)
  const judged = rows.value.filter(
    (row) =>
      String(row['采集时间'] ?? '').startsWith(month) &&
      [STATUS_MEET, STATUS_FAIL].includes(String(row.status)),
  )
  const meet = judged.filter((row) => String(row.status) === STATUS_MEET).length
  const rate = judged.length === 0 ? '—' : `${Math.round((meet / judged.length) * 100)}%`
  return [
    { label: '待采集点位', value: rows.value.filter((row) => String(row.status) === STATUS_PENDING).length },
    { label: '不达标点位', value: rows.value.filter((row) => String(row.status) === STATUS_FAIL).length },
    { label: '本月达标率', value: rate },
  ]
})

const submitTarget = ref<EntryRow | null>(null)
const submitTime = ref('')
const submitValue = ref<number | null>(null)
const reviewTarget = ref<EntryRow | null>(null)
const reviewText = ref('')

function inMyArea(row: EntryRow): boolean {
  return String(row['所属片区'] ?? '') === store.area
}

function formatReadings(text: string): string {
  if (!text) {
    return '—'
  }
  return text.split('\n').filter((line) => line.trim()).join('；')
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function setMessage(ok: boolean, text: string) {
  messageOk.value = ok
  message.value = text
}

function openSubmit(row: EntryRow) {
  if (!inMyArea(row)) {
    setMessage(false, `该监测点属于${row['所属片区']}，当前值班片区为${store.area}，不能跨片区报送`)
    return
  }
  submitTarget.value = row
  submitTime.value = ''
  submitValue.value = null
}

function confirmSubmit() {
  if (!submitTarget.value || submitValue.value === null || !submitTime.value) {
    return
  }
  const result = submitRoomReading(
    Number(submitTarget.value.id),
    Number(submitValue.value),
    submitTime.value,
    { operator: store.operator, area: store.area },
  )
  setMessage(result.ok, result.message)
  closeDialogs()
  reload()
}

function openReview(row: EntryRow) {
  reviewTarget.value = row
  reviewText.value = String(row['采集明细'] ?? '')
}

function confirmReview() {
  if (!reviewTarget.value) {
    return
  }
  const result = reviewSuspendedReading(
    Number(reviewTarget.value.id),
    reviewText.value,
    { operator: store.operator, area: store.area },
  )
  setMessage(result.ok, result.message)
  closeDialogs()
  reload()
}

function closeDialogs() {
  submitTarget.value = null
  reviewTarget.value = null
}

function runAction(action: string, row: EntryRow) {
  const result = applyAction(meta.key, Number(row.id), action, {
    operator: store.operator,
    area: store.area,
  })
  setMessage(result.ok, result.message)
  if (result.ok && result.ticketId) {
    message.value += '（可到「入户服务」待上门清单查看）'
  }
  reload()
}

function reload() {
  message.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
  } catch (error) {
    setMessage(false, error instanceof Error ? error.message : '室温监测列表读取失败')
  }
}

onMounted(reload)
</script>

<style scoped>
.rule-card {
  background: #fff;
  border: 1px solid var(--border);
  border-left: 4px solid var(--brand);
  border-radius: 8px;
  padding: 10px 14px;
  margin-bottom: 12px;
  font-size: 13px;
}
.rule-list {
  margin: 6px 0 8px;
  padding-left: 18px;
  display: grid;
  gap: 2px;
  color: #334155;
}
.duty-bar {
  display: flex;
  align-items: flex-end;
  gap: 12px;
  border-top: 1px dashed var(--border);
  padding-top: 8px;
}
.duty-tip {
  color: var(--muted);
  font-size: 12px;
}
.ok-text {
  color: #027a48;
}
.reading-lines {
  white-space: pre-line;
  color: #475569;
}
.modal-mask {
  position: fixed;
  inset: 0;
  background: rgba(15, 23, 42, 0.45);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 50;
}
.modal {
  background: #fff;
  border-radius: 10px;
  padding: 18px 20px;
  width: 420px;
  max-width: 92vw;
}
.modal h3 {
  margin: 0 0 4px;
  font-size: 16px;
}
.modal-desc {
  color: var(--muted);
  font-size: 12px;
  margin: 0 0 10px;
}
.modal-field {
  display: block;
  margin-bottom: 10px;
  font-size: 13px;
}
.modal-field span {
  display: block;
  color: var(--muted);
  font-size: 12px;
  margin-bottom: 4px;
}
.modal-field input,
.modal-field textarea,
.modal-field select {
  width: 100%;
  box-sizing: border-box;
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 6px 8px;
  font-size: 13px;
  font-family: inherit;
}
.modal-tip {
  font-size: 12px;
  color: var(--muted);
  margin: 0 0 10px;
}
.modal-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
</style>
