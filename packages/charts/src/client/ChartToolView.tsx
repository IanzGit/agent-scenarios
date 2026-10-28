/** 按调用阶段显示图表状态，完成后只读取持久化元数据。 */
import type { ToolCallViewProps } from '@deepseek-ai/dsh-client-ui-tool/client'
import { chartFromMeta } from './chart-meta.ts'

const titles: Record<string, string> = {
  render_line_chart: '折线图',
  render_bar_chart: '柱状图',
  render_pie_chart: '饼图',
  render_stacked_bar_chart: '堆叠柱状图',
  render_scatter_chart: '散点图',
}

// 仅保留 wire 名称，浏览器不导入 Host 工具或来源服务。
export const CHART_TOOL_NAMES = Object.keys(titles)

/** 每次调用独立展示；成功后只显示摘要，交互图表由正文引用展示。 */
export function ChartToolView({ toolName, callId, phase, block }: ToolCallViewProps) {
  const state = phase === 'preparing' ? 'preparing' : phase === 'start' ? 'running' : block.isError ? 'error' : 'complete'
  const status = { preparing: '准备绘图', running: '正在生成图表', error: '生成失败', complete: '已完成' }[state]
  const chart = phase === 'result' && !block.isError ? chartFromMeta(block.meta) : undefined
  const title = chart?.title || block.args.text('title')?.trim() || titles[toolName]
  const output = phase === 'result' ? block.content.filter(item => item.type === 'text').map(item => item.text).join('\n') : ''
  const message = chart?.summary || output || (phase === 'result' && block.error?.reason) || (state === 'error' ? '图表生成失败。' : '绘图完成，暂无可展示的图表。')

  return <section className="agent-scenarios-chart-call" data-chart-call-id={callId} data-chart-state={state} data-chart-tool={toolName} aria-label={title}>
    <header className="agent-scenarios-chart-call-header">
      <strong>{title}</strong>
      <span role="status">{status}</span>
    </header>
    {phase === 'result' ? <p className="agent-scenarios-chart-call-output">{message}</p> : null}
  </section>
}
