/** 类别构成饼图工具。 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ChartSources } from '../service.ts'
import type { ChartDataset, ChartResult, ChartSelection } from '../types.ts'
import { chartOption, noData, output, parameters, prepareChart, rendered } from './common.ts'

export const name = 'render_pie_chart'

/** 检查类别唯一性及非负总量，允许单类别占比。 */
export function renderPie(args: ChartSelection, dataset: ChartDataset): ChartResult {
  const data = prepareChart('pie', args, dataset)
  if (args.series_field) throw new Error('此图表不接受 series_field。')
  if (!data.valid.length) return noData(data)
  if (data.valid.some(row => Number(row[args.value_field]) < 0)) throw new Error('饼图不能包含负值。')
  const names = data.valid.map(row => String(row[args.x_field]))
  if (new Set(names).size !== names.length) throw new Error('饼图类别重复，请使用业务工具按类别汇总的数据集。')
  const total = data.valid.reduce((sum, row) => sum + Number(row[args.value_field]), 0)
  if (!Number.isFinite(total)) throw new Error('饼图总值超出有限数值范围。')
  if (total === 0) return noData(data, '类别总值为0，不生成占比图。')
  const option = chartOption(args.title, 'item')
  option.series = [{
    name: data.label, type: 'pie', radius: ['0%', '65%'], center: ['50%', '48%'],
    data: data.valid.map(row => ({ name: String(row[args.x_field]), value: row[args.value_field] as number })),
  }]
  return rendered(data, option, `共${data.valid.length}个类别，总量${Number(total.toFixed(2))}${data.unit}。`)
}

/** 创建原生饼图工具。 */
export function createTool(sources: ChartSources) {
  return defineTool({
    name,
    description: '使用本轮授权的类别汇总生成占比饼图；数值非负且总值大于0，不接受系列字段。',
    parameters, output,
    execute: async (args, exec) => {
      exec.signal.throwIfAborted()
      return renderPie(args, sources.resolve(exec, args.source_id, args.dataset_id))
    },
  })
}
