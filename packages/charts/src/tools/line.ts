/** 时间趋势折线图工具。 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ChartSources } from '../service.ts'
import type { ChartDataset, ChartResult, ChartSelection } from '../types.ts'
import { chartOption, noData, numberValue, output, parameters, prepareChart, rendered, seriesRows } from './common.ts'

export const name = 'render_line_chart'

/** 保留时间、重复点及空值断点，生成独立的时间轴和缩放配置。 */
export function renderLine(args: ChartSelection, dataset: ChartDataset): ChartResult {
  const data = prepareChart('line', args, dataset)
  if (data.x.type !== 'time') throw new Error('折线图的 x_field 必须是时间字段。')
  if (!data.valid.length) return noData(data)
  if (data.rows.some(row => typeof row[args.x_field] !== 'string'
    || !Number.isFinite(Date.parse(String(row[args.x_field]).replace(' ', 'T'))))) {
    throw new Error('折线图包含无效时间。')
  }
  const option = chartOption(args.title)
  option.grid = { left: 24, right: 24, top: 60, bottom: 90, containLabel: true }
  option.xAxis = { type: 'time' }
  option.yAxis = { type: 'value', name: data.label, scale: true }
  option.dataZoom = [{ type: 'inside', filterMode: 'none' }, { type: 'slider', bottom: 30, filterMode: 'none' }]
  option.series = [...seriesRows(data)].map(([name, rows]) => ({
    name, type: 'line', connectNulls: false, showSymbol: true,
    data: rows.map(row => [row[args.x_field] as string, numberValue(row, args.value_field)]),
  }))
  const result = rendered(data, option)
  const invalid = data.dataset.rows.length - data.valid.length
  if (invalid) result.summary = `${data.valid.length}条有效记录，单位：${data.unit}。保留空值断点，有效数值以外共${invalid}条。`
  return result
}

/** 创建原生折线工具；业务数据通过共享服务授权读取。 */
export function createTool(sources: ChartSources) {
  return defineTool({
    name,
    description: '使用本轮授权数据生成时间趋势折线图；x_field 必须为时间字段，保留原始数据、重复时间和空值断点。',
    parameters: { ...parameters, series_field: { type: 'string', description: '数据集中的系列分类字段。' } },
    output,
    execute: async (args, exec) => {
      exec.signal.throwIfAborted()
      return renderLine(args, sources.resolve(exec, args.source_id, args.dataset_id))
    },
  })
}
