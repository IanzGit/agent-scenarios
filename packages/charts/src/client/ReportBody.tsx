/** 使用报告自身图表快照的正文 Factory，不读取 Turn 数据。 */
import { MarkdownText } from '@deepseek-ai/dsh-client-ui-primitives'
import type { FactoryComponentPropsOf } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from './report-contract.ts'
import { chartReferences } from './chart-references.ts'
import { chartFromMeta } from './chart-meta.ts'
import { InteractiveChart } from './Charts.tsx'

/** 图表只从当前报告的不可变快照查找，跨轮及刷新不重新取数。 */
export function ReportBody({ markdown, charts, labels }: FactoryComponentPropsOf<'agent-scenarios.report.body'>) {
  return <div className="agent-scenarios-chart-response" data-answer-chart-body>
    {chartReferences(markdown).map(part => {
      if (part.kind === 'text') return <MarkdownText key={part.key} text={part.text} labels={labels} />
      if (part.kind !== 'chart') return null
      const chart = chartFromMeta({ agentScenariosChart: { version: 1, chart: charts.find(chart => chart.chart_id === part.id) } })
      return chart ? <InteractiveChart key={part.key} chart={chart} /> : <p key={part.key} role="status">图表暂不可用：{part.id}</p>
    })}
  </div>
}
