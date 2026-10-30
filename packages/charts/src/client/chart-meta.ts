/** 从工具结果的持久化元数据解析图表，不依赖运行中的会话或来源缓存。 */
import type { ChartResult, HtmlChartResult } from '../types.ts'

export type NumericChartCard = ChartResult & { status: 'rendered'; option: NonNullable<ChartResult['option']> }
export type ChartCard = NumericChartCard | (HtmlChartResult & { option?: never })

/** 只接受本插件已声明版本的成功绘图元数据，旧结果保持原有展示。 */
export function chartFromMeta(meta: unknown): ChartCard | undefined {
  if (!meta || typeof meta !== 'object' || !('agentScenariosChart' in meta)) return undefined
  const envelope = meta.agentScenariosChart
  if (!envelope || typeof envelope !== 'object' || !('version' in envelope) || (envelope.version !== 1 && envelope.version !== 2) || !('chart' in envelope)) return undefined
  if (envelope.version === 2) {
    const chart = envelope.chart as Partial<HtmlChartResult> | null
    return chart?.chart_type === 'html' && chart.status === 'rendered' && typeof chart.chart_id === 'string'
      && typeof chart.title === 'string' && typeof chart.summary === 'string' && typeof chart.html === 'string'
      && typeof chart.source_id === 'string' && typeof chart.document_id === 'string' ? chart as HtmlChartResult : undefined
  }
  const chart = envelope.chart as Partial<NumericChartCard> | null
  if (!chart || chart.status !== 'rendered' || typeof chart.chart_id !== 'string' || typeof chart.title !== 'string' || typeof chart.summary !== 'string'
    || !chart.option || typeof chart.option !== 'object' || !Array.isArray(chart.option.series)
    || !['line', 'bar', 'pie', 'stacked_bar', 'scatter'].includes(chart.chart_type ?? '')) return undefined
  return chart as ChartCard
}
