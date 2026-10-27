/** 分类对比柱状图工具。 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ChartSources } from '../service.ts'
import type { ChartDataset, ChartResult, ChartSelection } from '../types.ts'
import { categorySeries, chartOption, noData, output, parameters, prepareChart, rendered } from './common.ts'

export const name = 'render_bar_chart'

/** 直接绘制业务已汇总的数据，不重新计算分类数量。 */
export function renderBar(args: ChartSelection, dataset: ChartDataset): ChartResult {
  const data = prepareChart('bar', args, dataset)
  if (!data.valid.length) return noData(data)
  const { categories, series } = categorySeries(data)
  const option = chartOption(args.title)
  option.xAxis = { type: 'category', data: categories }
  option.yAxis = { type: 'value', name: data.label, scale: false }
  option.series = series.map(item => ({ ...item, type: 'bar' }))
  return rendered(data, option)
}

/** 创建原生柱状图工具。 */
export function createTool(sources: ChartSources) {
  return defineTool({
    name,
    description: '使用本轮授权的已汇总数据生成分类对比柱状图，可选择系列字段；不重新聚合数据。',
    parameters: { ...parameters, series_field: { type: 'string', description: '数据集中的系列分类字段。' } },
    output,
    execute: async (args, exec) => {
      exec.signal.throwIfAborted()
      return renderBar(args, sources.resolve(exec, args.source_id, args.dataset_id))
    },
  })
}
