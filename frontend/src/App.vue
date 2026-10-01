<template>
  <div class="app-shell">
    <aside class="app-side">
      <h1 class="app-title">城市集中供热管网与换热站运行管理平台</h1>
      <nav class="nav-list">
        <RouterLink v-for="item in navItems" :key="item.path" :to="item.path" class="nav-item">
          {{ item.label }}
        </RouterLink>
      </nav>
    </aside>
    <main class="app-main">
      <header class="app-head">
        <span class="head-desc">面向一次二次管网台账、换热站运行、水力平衡调节、热计量抄表、抢修处置、停暖通知与热费结算的一体化城市集中供热运行管理工作台。</span>
        <span class="head-user">当前值班：{{ store.operator }} · {{ store.shiftLabel }}</span>
      </header>
      <RouterView />
    </main>
  </div>
</template>

<script setup lang="ts">
import { useSessionStore } from '@/stores/session'

const store = useSessionStore()

const navItems = [{ label: "运营概览", path: "/" }, { label: "换热站台账", path: "/heatstation" }, { label: "一次管网", path: "/primarynet" }, { label: "二次管网", path: "/secondarynet" }, { label: "站点巡检", path: "/stationpatrol" }, { label: "室温监测", path: "/roomtemp" }, { label: "水力平衡", path: "/hydraulic" }, { label: "热计量抄表", path: "/heatmeter" }, { label: "抢修处置", path: "/emergencyrepair" }, { label: "阀门井维护", path: "/valvewell" }, { label: "循环泵运维", path: "/circpump" }, { label: "补水定压", path: "/makeupwater" }, { label: "换热器清洗", path: "/hxclean" }, { label: "锅炉房运行", path: "/boilerroom" }, { label: "管网探漏", path: "/leakdetect" }, { label: "补偿器检查", path: "/compensator" }, { label: "停暖通知", path: "/heatnotice" }, { label: "热费结算", path: "/heatbilling" }, { label: "入户服务", path: "/householdservice" }]
</script>
