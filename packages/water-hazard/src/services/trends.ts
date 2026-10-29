/** 四个水文测点的原始历史、周期统计及预警次数。 */
import type { ChartDataset } from 'dsh-agent-charts'
import { result, table, type Row, type ToolResult } from 'dsh-agent-shared'
import { WaterHazardAPI, calendarDate, requiredText, resolvePeriod, rows, supplement, text } from '../infrastructure/api.ts'
import { dateValue } from '../config.ts'

/** 原始曲线仅供程序使用，保留时间、精度、重复点及空值。 */
export type TimeSeries = {
  name: string
  unit: string
  source: string
  sensor: string
  points: { time: string; value: number | null }[]
}
export type TrendResult = ToolResult & { series: TimeSeries[] }

const metrics = [
  { key: 'inflow', metric: '涌水量', label: '矿井涌水量', device: '矿井总涌水量', sensor: '涌水量' },
  { key: 'drainage', metric: '排水量', label: '矿井排水量', device: '八盘区水泵房', sensor: '中央平泵房排水量' },
  { key: 'borehole', metric: '长观孔水位', label: '长观孔水位', device: '第四系钻孔ZK4', sensor: '水位' },
  { key: 'sump', metric: '中央水仓水位', label: '中央水仓水位', device: '八盘区水泵房', sensor: '1号液位' },
] as const

export async function hydrologicalTrend(api: WaterHazardAPI, signal: AbortSignal, start = '', end = ''): Promise<TrendResult> {
  const period = resolvePeriod(api.settings, start, end)
  const days = (dateValue(period.end) - dateValue(period.start)) / 86400000 + 1
  const label = `近${days}天`
  const histories = await Promise.all(metrics.map(async metric => {
    const data = await api.history(api.settings.sensors[metric.key], period, signal)
    const points = rows(data.data, '历史曲线 data').map(item => {
      const date = requiredText(item.time, 'time')
      calendarDate(date)
      return { date, value: monitoringValue(item.value) }
    }).sort((a, b) => a.date.replace(' ', 'T').localeCompare(b.date.replace(' ', 'T')))
    return { metric, points, unit: text(data.unit, '').trim() }
  }))
  if (!histories.some(history => history.points.some(point => point.value !== null))) throw new Error(`${period.start}至${period.end}指定周期无有效水文监测数据`)
  if (histories.some(history => !history.unit && history.points.some(point => point.value !== null))) {
    const realtime = await supplement(() => api.realtime(signal), [], signal)
    for (const history of histories) if (!history.unit) history.unit = text(realtime.find(item => item.valueId === api.settings.sensors[history.metric.key])?.unit, '').trim()
  }
  const events = await api.events(period, signal)
  const statistics: Row[] = []
  const summaries: string[] = []
  const series: TimeSeries[] = []
  for (const { metric, points, unit } of histories) {
    const values = points.map(point => point.value).filter((value): value is number => value !== null)
    const warnings = events.filter(event => String(event.sourceType) === '1' && event.sourceId === api.settings.sensors[metric.key]).length
    let min: number | null = null, max: number | null = null, mean: number | null = null
    if (values.length) {
      min = values.reduce((a, b) => Math.min(a, b))
      max = values.reduce((a, b) => Math.max(a, b))
      mean = values.reduce((sum, value) => sum + value / values.length, 0)
      const format = (value: number) => `${Number(value.toFixed(2))}${unit || '（单位未提供）'}`
      summaries.push(`${metric.label}：${label}平均值${format(mean)}，最小值${format(min)}，最大值${format(max)}，预警${warnings}次；`)
      series.push({ name: metric.metric, unit, source: metric.device, sensor: metric.sensor, points: points.map(point => ({ time: point.date, value: point.value })) })
    } else summaries.push(`${metric.label}：查询周期内无有效监测数据，预警${warnings}次；`)
    statistics.push({ 指标: metric.label, 监测点: metric.device, 有效记录数: values.length, 单位: unit || '单位未提供', 均值: mean, 最小值: min, 最大值: max, 首个有效值: values[0] ?? null, 末个有效值: values.at(-1) ?? null, 预警次数: warnings })
  }
  const title = `${label}水文监测指标趋势分析`
  const summary = `# ${title}\n\n## 1. 监测时间范围\n\n${period.start} 00:00:00 至 ${period.end} 23:59:59（${label}）。\n\n## 2. 历史趋势\n\n${summaries.join('\n\n')}`
  return {
    ...result(title, summary, [table('水文指标周期统计', ['指标', '监测点', '有效记录数', '单位', '均值', '最小值', '最大值', '首个有效值', '末个有效值', '预警次数'], statistics)], period),
    series,
  }
}

/** 空值、非数值和非有限值转为断点，零为有效值。 */
export function monitoringValue(value: unknown): number | null {
  if (typeof value !== 'number' && typeof value !== 'string') return null
  if (typeof value === 'string' && !value.trim()) return null
  if (typeof value === 'string' && !/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(value.trim())) return null
  const number = Number(value)
  return Number.isFinite(number) ? (Object.is(number, -0) ? 0 : number) : null
}

/** 一项指标对应一个数据集，防止两项水位或不同单位混为一图。 */
export function trendDatasets(value: TrendResult): ChartDataset[] {
  const ids: Record<string, string> = { 涌水量: 'inflow', 排水量: 'drainage', 长观孔水位: 'borehole', 中央水仓水位: 'sump' }
  return value.series.map(series => ({ id: ids[series.name], title: `${series.source} ${series.sensor}趋势`,
    columns: [{ name: 'time', title: '时间', type: 'time' }, { name: 'value', title: series.name, type: 'number', unit: series.unit }],
    rows: series.points.map(point => ({ time: point.time, value: point.value })),
  }))
}
