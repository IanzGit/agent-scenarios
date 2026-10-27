/** 五类工具共用的参数、输出及数据校验，不包含图表类型分发。 */
import { createHash } from 'node:crypto'
import type { InferValue } from '@deepseek-ai/dsh-tools'
import { chartResultSchema } from '../schemas.ts'
import type { ChartColumn, ChartDataset, ChartOption, ChartResult, ChartRow, ChartSelection, ChartType, Json } from '../types.ts'

export const parameters = {
  source_id: { type: 'string', required: true, description: '本轮成功业务工具返回的 chart_source.source_id。' },
  dataset_id: { type: 'string', required: true, description: '该来源目录中实际存在的数据集 id。' },
  title: { type: 'string', required: true, description: '反映真实指标和时间范围的中文标题。' },
  x_field: { type: 'string', required: true, description: '数据集的时间或分类字段；散点图用于纵轴分类。' },
  value_field: { type: 'string', required: true, description: '目录中的数值字段，单位由数据源提供。' },
} as const

export const output = {
  schema: chartResultSchema,
  render: (_args: object, value: InferValue<typeof chartResultSchema>) => [{
    type: 'text' as const,
    text: `${value.title}：${value.summary}\n图表ID：${value.chart_id}；状态：${value.status}`,
  }],
  presentationMeta: (_args: object, value: InferValue<typeof chartResultSchema>): Json =>
    value.status === 'rendered' ? { agentScenariosChart: { version: 1, chart: value } } : null,
}

type PreparedChart = {
  args: ChartSelection
  dataset: ChartDataset
  x: ChartColumn
  rows: ChartRow[]
  valid: ChartRow[]
  unit: string
  label: string
  base: Omit<ChartResult, 'status' | 'summary' | 'option'>
}

/** 非有限值和空值保留为断点，零为有效数值。 */
export function numberValue(row: ChartRow, field: string): number | null {
  const value = row[field]
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/** 校验字段选择，生成稳定标识，并保留有横轴值的原始记录顺序。 */
export function prepareChart(type: ChartType, args: ChartSelection, dataset: ChartDataset): PreparedChart {
  if (!args.title.trim()) throw new Error('图表标题不能为空。')
  const column = (field: string) => {
    const found = dataset.columns.find(item => item.name === field)
    if (!found) throw new Error(`数据集中不存在字段：${field}`)
    return found
  }
  const x = column(args.x_field)
  const value = column(args.value_field)
  if (value.type !== 'number') throw new Error('value_field 必须是数值字段。')
  if (args.series_field) column(args.series_field)
  const rows = dataset.rows.filter(row => row[args.x_field] != null && String(row[args.x_field]).trim() !== '')
  const unit = value.unit?.trim() || '单位未提供'
  const id = createHash('sha256').update(JSON.stringify([
    type, args.source_id, args.dataset_id, args.title, args.x_field, args.value_field, args.series_field ?? null,
  ])).digest('hex').slice(0, 24)
  return {
    args, dataset, x, rows, unit,
    valid: rows.filter(row => numberValue(row, args.value_field) !== null),
    label: `${value.title || dataset.title}（${unit}）`,
    base: { chart_id: id, chart_type: type, title: args.title, source_id: args.source_id, dataset_id: args.dataset_id },
  }
}

/** 标题、提示框及图例的公共配置；各工具自行补充坐标轴和系列。 */
export function chartOption(title: string, trigger: 'axis' | 'item' = 'axis'): ChartOption {
  return {
    title: { text: title, left: 'center', textStyle: { fontSize: 15 } },
    tooltip: { trigger, renderMode: 'richText' },
    legend: { bottom: 0, type: 'scroll' },
    grid: { left: 24, right: 24, top: 60, bottom: 60, containLabel: true },
    aria: { enabled: true },
  }
}

/** 空数据是明确的领域结果，不伪造配置或重试取数。 */
export function noData(data: PreparedChart, summary = '没有可绘图的有效数值。'): ChartResult {
  return { ...data.base, status: 'no_data', summary }
}

/** 生成规范结果，并解释没有参与有效数值统计的记录。 */
export function rendered(data: PreparedChart, option: ChartOption, summary = `${data.valid.length}条有效记录，单位：${data.unit}。`): ChartResult {
  const invalid = data.dataset.rows.length - data.valid.length
  if (invalid) summary += `未绘制${invalid}条无效记录。`
  return { ...data.base, status: 'rendered', summary, option }
}

/** 按已选系列字段分组，不重排、聚合或采样原始记录。 */
export function seriesRows(data: PreparedChart): Map<string, ChartRow[]> {
  const groups = new Map<string, ChartRow[]>()
  for (const row of data.rows) {
    const name = data.args.series_field ? String(row[data.args.series_field] ?? '未提供') : data.dataset.title
    if (!groups.has(name)) groups.set(name, [])
    groups.get(name)!.push(row)
  }
  return groups
}

/** 为普通和堆叠柱状图对齐类别，缺失组合保持空值。 */
export function categorySeries(data: PreparedChart) {
  const categories = [...new Set(data.rows.map(row => String(row[data.args.x_field])))]
  const series = [...seriesRows(data)].map(([name, rows]) => {
    const values = new Map(rows.map(row => [String(row[data.args.x_field]), numberValue(row, data.args.value_field)]))
    if (values.size !== rows.length) throw new Error('同一系列包含重复类别，请使用业务工具已汇总的数据集。')
    return { name, data: categories.map(category => values.get(category) ?? null) }
  })
  return { categories, series }
}
