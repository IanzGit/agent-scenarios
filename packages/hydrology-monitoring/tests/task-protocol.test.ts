/** 父任务协议、发布条件及真实 Conversation 投影的无密钥回归。 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { Session, SessionId, appendPluginRecord } from '@deepseek-ai/dsh-session'
import { renderChart } from 'dsh-agent-charts'
import { parsePlan, taskRecord, TASK_RECORD, type ParentTask, type TaskRecord } from '../src/domain/task-protocol.ts'
import { validateReport } from '../src/domain/report-validation.ts'
import { hydrologyPlan } from '../../../tests/fixtures/hydrology-model.ts'
import { parentTaskDefinition, reportDefinition } from '../src/client/task-nodes.ts'
import { ConversationNodeAssembler } from '../../../../deepseek-harness/packages/client/ui-conversation/src/client/conversation/assembler.ts'
import type { ConversationViewDefinition, ConversationViewNode } from '@deepseek-ai/dsh-client-ui-conversation/client'

function task(): ParentTask {
  return { id: 'business-task', parent_id: 'parent', report_id: 'report', origin_message_id: 'origin', phase: 'composing', plan: hydrologyPlan(),
    queries: { history: { status: 'success', attempts: [] } }, charts: [] }
}
const body = '# 主斜井水位监测分析\n\n## 历史变化\n\n已有真实历史记录。\n\n## 综合结论\n\n结论仅依据已取得记录。'

test('计划拒绝重复ID、缺失依赖、依赖环及越界输入绑定', () => {
  assert.doesNotThrow(() => parsePlan(hydrologyPlan()))
  const plan = hydrologyPlan(true)
  for (const invalid of [
    { ...plan, queries: [plan.queries[0], plan.queries[0]] },
    { ...plan, charts: [plan.charts[0], plan.charts[0]] },
    { ...plan, queries: [{ ...plan.queries[0], depends_on: ['absent'] }] },
    { ...plan, queries: [{ ...plan.queries[0], depends_on: ['history'] }] },
    { ...plan, queries: [{ ...plan.queries[0], depends_on: ['realtime'] }, { ...plan.queries[1], depends_on: ['history'] }] },
    { ...plan, queries: [{ ...plan.queries[0], inputs: [{ query_id: 'realtime', columns: ['point'] }] }, plan.queries[1]] },
    { ...plan, charts: [{ ...plan.charts[0], query_id: 'absent' }] },
  ]) assert.throws(() => parsePlan(invalid))
})

test('发布要求真实章节正文和顺序，代码里的标题不能冒充章节', () => {
  assert.doesNotThrow(() => validateReport(task(), body))
  for (const invalid of [body.replace('# 主斜井水位监测分析', '# 其他报告'), body.replace('## 历史变化', '## 其他章节'),
    body.replace('已有真实历史记录。', ''), body.replace('## 综合结论', '### 综合结论'),
    '# 主斜井水位监测分析\n\n```md\n## 历史变化\n## 综合结论\n```',
  ]) assert.throws(() => validateReport(task(), invalid))
})

test('报告只引用本任务成功图表一次，代码示例及重复引用不能通过发布', () => {
  const state = task()
  const chart = renderChart('line', { source_id: 'task:query:checksum', dataset_id: 'history', title: '历史', x_field: 'time', value_field: 'value' },
    { id: 'history', title: '液位', columns: [{ name: 'time', type: 'time' }, { name: 'value', type: 'number', unit: 'm' }], rows: [{ time: '2025-09-01', value: 1 }] })
  state.charts = [{ intent_id: 'history-chart', status: 'rendered', summary: chart.summary, chart }]
  const marker = `[图表:${chart.chart_id}]`
  assert.doesNotThrow(() => validateReport(state, body + '\n\n' + marker))
  for (const invalid of [body, body + '\n\n[图表:foreign]', body + '\n\n' + marker + '\n\n' + marker,
    body + '\n\n```\n' + marker + '\n```', body + '\n\n文字中的' + marker]) assert.throws(() => validateReport(state, invalid))
})

test('外部记录验证版本和完整载荷，已发布报告仅凭尾页记录即可独立回放', () => {
  const session = Session.create(SessionId('report-replay'))
  const state: ParentTask = { ...task(), phase: 'published', markdown: body }
  const publication: TaskRecord = { version: 1, kind: 'published', task: state }
  appendPluginRecord(session, TASK_RECORD, publication)
  const event = session.ownEvents().at(-1)!
  assert.equal(taskRecord(event)?.task.report_id, 'report')
  assert.throws(() => taskRecord({ ...event, data: { ...publication, version: 2 } }))
  assert.throws(() => taskRecord({ type: TASK_RECORD, data: publication }))
  const nodes = new Map<string, ConversationViewNode>()
  const view: ConversationViewDefinition = { target: 'chat', create: () => ({
    empty: nodes,
    replace(input) { nodes.clear(); for (const node of input.nodes) nodes.set(node.key, node); return nodes },
    apply(input) { for (const node of input.upserts) nodes.set(node.key, node); return nodes },
  }) }
  const assembler = new ConversationNodeAssembler({ entries: () => [parentTaskDefinition, reportDefinition], fallbackEntry: () => undefined }, { entries: () => [view] })
  assembler.replaceWindow([{ type: 'event', event }], true)
  assembler.activateTarget('chat')
  const before = [...nodes.values()].find(node => node.kind === 'hydrology-report')!
  assert.ok(before)
  assert.ok('groupTree' in before && before.groupTree === 'turn')
  appendPluginRecord(session, TASK_RECORD, { ...publication, kind: 'phase-changed', task: { ...state, problem: '迟到的状态更新' } })
  assembler.replaceWindow(session.ownEvents().map(event => ({ type: 'event' as const, event })), false)
  const after = [...nodes.values()].find(node => node.kind === 'hydrology-report')!
  assert.equal(after.key, before.key)
  assert.ok('anchorSeq' in before && 'anchorSeq' in after)
  assert.equal(after.anchorSeq, before.anchorSeq)
  assert.deepEqual(after.data, state)
})
