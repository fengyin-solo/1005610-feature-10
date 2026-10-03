# 城市集中供热管网与换热站运行管理平台

面向一次二次管网台账、换热站运行、水力平衡调节、热计量抄表、抢修处置、停暖通知与热费结算的一体化城市集中供热运行管理工作台。

这是一个**纯前端**管理平台：Vue 3 + Vite + TypeScript，仓库里没有后端服务。业务数据由
`frontend/src/data/` 下的本地数据层提供：首次打开用示例数据播种，之后的登记、筛选与状态流转
结果都持久化在浏览器 `localStorage` 里，刷新或重开浏览器都还在。dev server 已关掉自动打开页面，
启动后按终端打印的地址手工打开。

## 目录结构

```text
.
├── frontend/                 Vue 3 + Vite + TypeScript 前端（唯一运行单元）
│   ├── src/views/            每个业务模块一个页面
│   ├── src/api/local-service.ts   本地数据服务：列表、筛选、动作流转、导出
│   ├── src/data/             模块元数据 / 示例数据 / localStorage 持久化
│   ├── src/stores/           会话与筛选状态
│   └── vite.config.ts        dev server 配置（open: false，无 /api 代理）
├── .gitignore
└── docker-compose.yml
```

## 启动

```bash
cd frontend
npm install
npm run dev
```

前端默认监听 `http://127.0.0.1:5173/`，dev server 不会自动打开浏览器，需要自己访问。

生产构建：

```bash
cd frontend
npm run build
```

## 业务模块

| 模块 | 目录 | 业务对象 | 主要字段 |
| --- | --- | --- | --- |
| 换热站台账 | `heatstation` | 换热站 | 站名、所属片区、供热面积 |
| 一次管网 | `primarynet` | 一次管网管段 | 管段编号、起点、终点 |
| 二次管网 | `secondarynet` | 二次管网管段 | 管段编号、所属片区、公称管径 |
| 站点巡检 | `stationpatrol` | 巡检记录 | 巡检编号、巡检站点、巡检路线 |
| 室温监测 | `roomtemp` | 室温监测点 | 监测编号、住户地址、所属片区、加权室温读数、采集明细 |
| 水力平衡 | `hydraulic` | 平衡调节记录 | 调节编号、换热站、调节回路 |
| 热计量抄表 | `heatmeter` | 热计量抄表记录 | 抄表编号、计量表号、用户名称 |
| 抢修处置 | `emergencyrepair` | 抢修记录 | 抢修编号、故障管段、故障类型 |
| 阀门井维护 | `valvewell` | 阀门井 | 井编号、所属管段、井盖状况 |
| 循环泵运维 | `circpump` | 循环泵 | 泵编号、所属换热站、泵型号 |
| 补水定压 | `makeupwater` | 补水定压记录 | 记录编号、换热站、补水量 |
| 换热器清洗 | `hxclean` | 清洗记录 | 清洗编号、换热器编号、所属站点 |
| 锅炉房运行 | `boilerroom` | 锅炉运行记录 | 锅炉编号、锅炉吨位、燃烧方式 |
| 管网探漏 | `leakdetect` | 探漏记录 | 探漏编号、探测管段、探测方法 |
| 补偿器检查 | `compensator` | 补偿器检查记录 | 检查编号、所属管段、补偿器型号 |
| 停暖通知 | `heatnotice` | 停暖通知单 | 通知编号、影响片区、停暖原因 |
| 热费结算 | `heatbilling` | 热费结算单 | 结算编号、用户名称、用热面积 |
| 入户服务 | `householdservice` | 入户服务单 | 服务单号、报修用户、服务内容 |

## 约定

- 每个模块的页面在 `frontend/src/views/<模块>/index.vue`，页面只负责渲染，读写统一走
  `frontend/src/api/local-service.ts`。
- 字段、状态、动作与流转目标集中在 `frontend/src/data/modules.ts`；示例数据在
  `frontend/src/data/seed.ts`。
- 状态流转只允许在 `local-service.ts` 里改，页面组件不做业务判断。
- 室温达标口径（规则集中在 `src/data/roomtemp.ts`）：按一天内各采集时间做时间加权，
  加权值在合格范围 18℃～24℃（含边界）才允许保存为「已达标」；读数超出量程
  -20℃～60℃ 先挂「已挂起」，由换热站值班员按所属片区复核；同一采集时间重复报送
  覆盖原读数，只记一次；判定不达标自动生成入户服务单进入待上门清单。台账与导出共用
  同一判定函数，旧库首次打开自动按新口径重算（localStorage 版本号迁移）。
- 想回到初始数据：清掉浏览器里 `district-heating:entries` 这一项，或调用 `resetModule(模块)`。
