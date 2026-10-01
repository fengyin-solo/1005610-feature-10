import { createRouter, createWebHistory } from 'vue-router'

import Dashboard from '@/views/Dashboard.vue'
const Heatstation = () => import('@/views/heatstation/index.vue')
const Primarynet = () => import('@/views/primarynet/index.vue')
const Secondarynet = () => import('@/views/secondarynet/index.vue')
const Stationpatrol = () => import('@/views/stationpatrol/index.vue')
const Roomtemp = () => import('@/views/roomtemp/index.vue')
const Hydraulic = () => import('@/views/hydraulic/index.vue')
const Heatmeter = () => import('@/views/heatmeter/index.vue')
const Emergencyrepair = () => import('@/views/emergencyrepair/index.vue')
const Valvewell = () => import('@/views/valvewell/index.vue')
const Circpump = () => import('@/views/circpump/index.vue')
const Makeupwater = () => import('@/views/makeupwater/index.vue')
const Hxclean = () => import('@/views/hxclean/index.vue')
const Boilerroom = () => import('@/views/boilerroom/index.vue')
const Leakdetect = () => import('@/views/leakdetect/index.vue')
const Compensator = () => import('@/views/compensator/index.vue')
const Heatnotice = () => import('@/views/heatnotice/index.vue')
const Heatbilling = () => import('@/views/heatbilling/index.vue')
const Householdservice = () => import('@/views/householdservice/index.vue')

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', name: 'dashboard', component: Dashboard },
    { path: '/heatstation', name: 'heatstation', component: Heatstation },
    { path: '/primarynet', name: 'primarynet', component: Primarynet },
    { path: '/secondarynet', name: 'secondarynet', component: Secondarynet },
    { path: '/stationpatrol', name: 'stationpatrol', component: Stationpatrol },
    { path: '/roomtemp', name: 'roomtemp', component: Roomtemp },
    { path: '/hydraulic', name: 'hydraulic', component: Hydraulic },
    { path: '/heatmeter', name: 'heatmeter', component: Heatmeter },
    { path: '/emergencyrepair', name: 'emergencyrepair', component: Emergencyrepair },
    { path: '/valvewell', name: 'valvewell', component: Valvewell },
    { path: '/circpump', name: 'circpump', component: Circpump },
    { path: '/makeupwater', name: 'makeupwater', component: Makeupwater },
    { path: '/hxclean', name: 'hxclean', component: Hxclean },
    { path: '/boilerroom', name: 'boilerroom', component: Boilerroom },
    { path: '/leakdetect', name: 'leakdetect', component: Leakdetect },
    { path: '/compensator', name: 'compensator', component: Compensator },
    { path: '/heatnotice', name: 'heatnotice', component: Heatnotice },
    { path: '/heatbilling', name: 'heatbilling', component: Heatbilling },
    { path: '/householdservice', name: 'householdservice', component: Householdservice },
  ],
})

export default router
