/** 分类数值的逐行散点图工具。 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ChartSources } from '../service.ts'
import type { ChartDataset, ChartResult, ChartSelection } from '../types.ts'
import { chartOption, noData, output, parameters, prepareChart, rendered } from './common.ts'

export const name = 'render_scatter_chart'

/** 数值绘制在横轴，分类绘制在纵轴，不聚合或采样。 */
export function renderScatter(args: ChartSelection, dataset: ChartDataset): ChartResult {
  const data = prepareChart('scatter', args, dataset)
  if (data.x.type !== 'category') throw new Error('散点图的 x_field 必须是分类字段。')
  if (args.series_field) throw new Error('此图表不接受 series_field。')
  if (!data.valid.length) return noData(data)
  const option = chartOption(args.title, 'item')
  option.xAxis = { type: 'value', name: data.label, scale: true }
  option.yAxis = { type: 'category', name: data.x.title || dataset.title, data: [...new Set(data.valid.map(row => String(row[args.x_field])))] }
  option.series = [{
    name: args.title, type: 'scatter', symbolSize: 9,
    data: data.valid.map(row => [row[args.value_field] as number, String(row[args.x_field])]),
  }]
  return rendered(data, option)
}

/** 创建原生散点图工具。 */
export function createTool(sources: ChartSources) {
  return defineTool({
    name,
    description: '使用本轮授权数据生成逐行散点分布图；x_field 选择分类字段，value_field 的数值绘制在横轴，不聚合或采样。',
    parameters, output,
    execute: async (args, exec) => {
      exec.signal.throwIfAborted()
      return renderScatter(args, sources.resolve(exec, args.source_id, args.dataset_id))
    },
  })
}
