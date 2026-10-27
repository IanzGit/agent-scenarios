/** 同单位多系列的堆叠柱状图工具。 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ChartSources } from '../service.ts'
import type { ChartDataset, ChartResult, ChartSelection } from '../types.ts'
import { categorySeries, chartOption, noData, output, parameters, prepareChart, rendered } from './common.ts'

export const name = 'render_stacked_bar_chart'

/** 按系列对齐已汇总的分类数据，缺失组合保留为空值。 */
export function renderStackedBar(args: ChartSelection, dataset: ChartDataset): ChartResult {
  if (!args.series_field) throw new Error('堆叠柱状图必须提供 series_field。')
  const data = prepareChart('stacked_bar', args, dataset)
  if (!data.valid.length) return noData(data)
  const { categories, series } = categorySeries(data)
  const option = chartOption(args.title)
  option.xAxis = { type: 'category', data: categories }
  option.yAxis = { type: 'value', name: data.label, scale: false }
  option.series = series.map(item => ({ ...item, type: 'bar', stack: 'total' }))
  return rendered(data, option)
}

/** 创建必须选择系列字段的原生堆叠图工具。 */
export function createTool(sources: ChartSources) {
  return defineTool({
    name,
    description: '使用本轮授权数据生成堆叠柱状图；必须选择系列字段，数值字段各系列使用同一单位。',
    parameters: { ...parameters, series_field: { type: 'string', required: true, description: '数据集中的系列分类字段，所有系列使用数值字段声明的同一单位。' } },
    output,
    execute: async (args, exec) => {
      exec.signal.throwIfAborted()
      return renderStackedBar(args, sources.resolve(exec, args.source_id, args.dataset_id))
    },
  })
}
