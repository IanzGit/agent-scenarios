/** 新场景共用的原始历史读取与每日末条有效值，保留真实监测范围。 */
import { WaterHazardAPI, calendarDate, requiredText, rows, supplement, text } from '../infrastructure/api.ts'
import { monitoringValue } from './trends.ts'
import type { Period } from 'dsh-agent-shared'

export type History = { date: string; value: number | null; metric: string; source: string; sensor: string; unit: string; scope: string }
export const FACE_SENSORS: Record<string, string> = { '45208': '2c90478e9a60dd10019aa593f9aa0f42', '85211': '297ed74695fa70690195fa8010060000' }
export const EXTRA_SENSORS = {
  quality: '53f74d3f400844daab4144abeadc14a3', pressure: '433f2709f7a54e4ab4bc555f66a58262',
  sealed: 'a134c5e188ef47439f98d40174fce1c3', river: '6d42fc28114b40aab27a6d89edae1fc3', rain: '53305d98ce004958977ced01122949ae',
}
export async function history(api: WaterHazardAPI, id: string, period: Period, signal: AbortSignal, metric: string, source: string, sensor: string, scope: string): Promise<History[]> {
  const data = await api.history(id, period, signal)
  let unit = text(data.unit, '').trim()
  const values = rows(data.data, '历史曲线 data').map(row => {
    const date = requiredText(row.time, 'time')
    const day = calendarDate(date)
    if (day < period.start || day > period.end) throw new Error('历史曲线返回了查询周期之外的数据')
    return { date, value: monitoringValue(row.value), metric, source, sensor, unit, scope }
  }).sort((a, b) => a.date.replace(' ', 'T').localeCompare(b.date.replace(' ', 'T')))
  if (!unit && values.some(row => row.value !== null)) {
    unit = text((await supplement(() => api.realtime(signal), [], signal)).find(row => row.valueId === id)?.unit, '').trim()
    values.forEach(row => { row.unit = unit })
  }
  return values
}
export function dailyLast(values: History[]): (History & { value: number })[] {
  const byDay = new Map<string, History & { value: number }>()
  for (const row of [...values].sort((a, b) => a.date.replace(' ', 'T').localeCompare(b.date.replace(' ', 'T')))) if (row.value !== null) byDay.set(`${row.metric}\0${row.date.slice(0, 10)}`, { ...row, value: row.value })
  return [...byDay.values()]
}
