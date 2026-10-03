import { defineStore } from 'pinia'

// 换热站值班员可切换所属片区：室温采集报送与挂起复核只允许操作本片区监测点。
export const DUTY_AREAS = ['城东片区', '城西片区', '城南片区', '城北片区']

export const useSessionStore = defineStore('session', {
  state: () => ({
    operator: '值班管理员',
    shiftLabel: '白班 08:00-20:00',
    scope: '城市集中供热管网与换热站运行管理平台',
    area: '城南片区',
  }),
  getters: {
    canOperate: (state) => state.operator.length > 0,
  },
  actions: {
    setShift(label: string) {
      this.shiftLabel = label
    },
    setArea(area: string) {
      this.area = area
    },
  },
})
