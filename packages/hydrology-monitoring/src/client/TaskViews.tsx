/** 执行状态和已发布报告分别渲染，报告不包含工具分组。 */
import type { ChatNodeViewProps } from '@deepseek-ai/dsh-client-ui-chat/client'
import type {} from 'dsh-agent-charts/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from './task-nodes.ts'

const phases = { querying: '查询中', charting: '绘图中', composing: '等待报告发布', published: '报告已发布', cancelled: '已取消', blocked: '需要处理' }
const outcomes = { pending: '等待', running: '执行中', success: '成功', no_data: '无数据', error: '失败', skipped: '已跳过' }

export function ParentTaskView({ node }: ChatNodeViewProps<'hydrology-parent-task'>) {
  const task = node.data
  return <aside className="hydrology-task" data-hydrology-task-id={task.id} data-task-phase={task.phase}>
    <div>{task.plan.title} · <strong>{phases[task.phase]}</strong></div>
    <ul>{task.plan.queries.map((query, index) => <li key={query.id}>查询{index + 1}：{outcomes[task.queries[query.id].status]}</li>)}</ul>
    {task.problem ? <p role="status">{task.problem}</p> : null}
  </aside>
}

export function ReportView({ node, renderFactorySlot, t }: ChatNodeViewProps<'hydrology-report'>) {
  const task = node.data
  return <article className="hydrology-report" data-hydrology-report-id={task.report_id} data-report-task-id={task.id}>
    {renderFactorySlot('agent-scenarios.report.body', {
      markdown: task.markdown!, charts: task.charts.flatMap(item => item.chart?.status === 'rendered' ? [item.chart] : []),
      labels: { code: { copyLabel: t('copy'), copiedLabel: t('copied'), toolbarLabels: { codeLabel: t('codeBlock.title'), wrapLabel: t('codeBlock.wrap'), unwrapLabel: t('codeBlock.unwrap') } }, footnotes: t('markdown.footnotes') },
    })}
  </article>
}
