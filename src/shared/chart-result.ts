/** 业务结果与公共图表插件之间的输出适配。 */
import type { InferValue, ToolRunContext } from '@deepseek-ai/dsh-tools'
import { chartSourceSchema, renderChartSource, type ChartDataset, type ChartSources } from 'dsh-agent-charts'
import { resultSchema, renderResult, type ToolResult } from './result.ts'

/** 图表目录只扩展需要绘图的业务工具，不进入通用表格协议。 */
export const chartResultSchema = {
  ...resultSchema,
  properties: { ...resultSchema.properties, chart_source: chartSourceSchema },
} as const

/** 保持完整业务表格，并附加插件定义的来源目录。 */
export function renderChartResult(args: object, value: InferValue<typeof chartResultSchema>) {
  return [...renderResult(args, value), ...renderChartSource(value.chart_source)]
}

/** 将当前工具的业务数据交给图表服务，查询本身不生成图表。 */
export function withChartSource<T extends ToolResult>(value: T, exec: ToolRunContext, sources: ChartSources | undefined, datasets: ChartDataset[]) {
  const chart_source = sources?.prepare(exec, datasets)
  return chart_source ? { ...value, chart_source } : value
}
