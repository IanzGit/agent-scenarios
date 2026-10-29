/** 通用图表插件的 Host 入口：只注册服务，模型工具由 preset 显式启用。 */
import type { Context } from '@deepseek-ai/cordis'
import { ChartSources } from './service.ts'

export { ChartSources }
export { renderChart } from './render.ts'
export { chartSourceSchema, renderChartSource } from './schemas.ts'
export type { ChartColumn, ChartDataset, ChartOption, ChartResult, ChartRow, ChartSelection, ChartSource, ChartType } from './types.ts'

export const name = 'charts'
export const inject = ChartSources.inject

/** 挂载图表服务；卸载时自动释放缓存及监听。 */
export function apply(ctx: Context): void {
  ctx.plugin(ChartSources)
}
