/** 正文使用图表 ID 引用本轮已持久化的结果，普通片段保留原生 Markdown。 */
import { MarkdownText } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-chat/client'
import type {} from './chart-data.ts'
import { InteractiveChart } from './Charts.tsx'
import { chartReferences } from './chart-references.ts'

export function ChartResponseBody(props: PropsRuntime<'conversation.chat.response.body'>) {
  const charts = props.useTurnData('agent-scenarios-charts') ?? []
  const tail = props.useTurnData('turn-tail')
  const parts = chartReferences(props.text, props.streaming)
  const legacy = props.lastText && tail?.closing?.step === props.step
    && !chartReferences(tail.closing.blocks.filter(block => block.kind === 'text').map(block => block.text).join('\n')).some(part => part.kind === 'chart')
    ? charts : []

  return <div className="agent-scenarios-chart-response" data-answer-chart-body data-answer-turn={props.turn}>
    {parts.map(part => {
      if (part.kind === 'text') return <MarkdownText key={part.key} text={part.text} streaming={props.streaming} labels={props.labels} fileMentions={props.fileMentions} pathImages={props.pathImages} />
      if (part.kind === 'pending') return <p key={part.key} role="status">正在准备图表…</p>
      const chart = charts.find(chart => chart.chart_id === part.id)
      return chart ? <InteractiveChart key={part.key} chart={chart} /> : <p key={part.key} role="status">图表暂不可用：{part.id}</p>
    })}
    {legacy.map(chart => <InteractiveChart key={chart.chart_id} chart={chart} />)}
  </div>
}
