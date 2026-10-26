/** 真实系统只读冒烟；只输出数量和日期，不输出凭据或完整业务数据。 */
import { resolveSettings } from '../src/water-hazard/config.ts'
import { WaterHazardAPI } from '../src/water-hazard/api.ts'
import { WaterHazardBusiness } from '../src/water-hazard/business.ts'

const business = new WaterHazardBusiness(new WaterHazardAPI(resolveSettings()))
const signal = AbortSignal.timeout(120000)
const results = await Promise.all([
  business.deviceStatus(signal), business.deviceAlarm(signal), business.modelWarning(signal),
  business.warningStatistics(signal), business.hydrologicalTrend(signal),
])
for (const result of results) console.log(JSON.stringify({ title: result.title, period: result.period, tableRows: result.tables.map(table => ({ key: table.key, rows: table.rows.length })), charts: result.charts.length, summary: result.summary }))
