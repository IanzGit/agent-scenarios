/** Host 调用的确定性绘图入口，不依赖活动轮次或工具来源缓存。 */
import type { ChartDataset, ChartResult, ChartSelection, ChartType } from './types.ts'
import { renderLine } from './tools/line.ts'
import { renderBar } from './tools/bar.ts'
import { renderPie } from './tools/pie.ts'
import { renderScatter } from './tools/scatter.ts'
import { renderStackedBar } from './tools/stacked-bar.ts'

/** 从已授权的数据集构建图表；数据授权由调用服务负责。 */
export function renderChart(type: ChartType, selection: ChartSelection, dataset: ChartDataset): ChartResult {
  const renderers = { line: renderLine, bar: renderBar, pie: renderPie, scatter: renderScatter, stacked_bar: renderStackedBar }
  return renderers[type](selection, dataset)
}
