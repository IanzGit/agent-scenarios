import test from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Sessions, { SessionId, type Session } from '@deepseek-ai/dsh-session'
import Projections from '@deepseek-ai/dsh-session-projection'
import { turnBoundaryProjectionDefinition } from '@deepseek-ai/dsh-agent-loop'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import * as charts from '../src/index.ts'
import * as tools from '../src/tools/index.ts'
import { renderLine } from '../src/tools/line.ts'
import { renderBar } from '../src/tools/bar.ts'
import { renderPie } from '../src/tools/pie.ts'
import { renderStackedBar } from '../src/tools/stacked-bar.ts'
import { renderScatter } from '../src/tools/scatter.ts'
import { chartFromMeta } from '../src/client/chart-meta.ts'
import type { ChartDataset, ChartResult, ChartSelection, ChartSource, Json } from '../src/types.ts'

const selection: ChartSelection = { source_id: 'source', dataset_id: 'values', title: '测试图', x_field: 'category', value_field: 'value' }
const dataset: ChartDataset = {
  id: 'values', title: '分类统计',
  columns: [{ name: 'category', type: 'category' }, { name: 'value', type: 'number', unit: '条' }],
  rows: [{ category: '甲', value: 0 }, { category: '乙', value: 2.123456789 }],
}
const series = (chart: ChartResult) => chart.option!.series as { data: Json; connectNulls?: boolean; stack?: string }[]

test('饼图保留精度、允许单类别，拒绝负值与重复类别，空数据和全零不伪造占比', () => {
  const chart = renderPie(selection, dataset)
  assert.equal(chart.status, 'rendered')
  assert.deepEqual(series(chart)[0].data, [{ name: '甲', value: 0 }, { name: '乙', value: 2.123456789 }])
  assert.equal(renderPie(selection, { ...dataset, rows: [dataset.rows[1]] }).status, 'rendered')
  assert.equal(renderPie(selection, { ...dataset, rows: [dataset.rows[0]] }).status, 'no_data')
  assert.equal(renderPie(selection, { ...dataset, rows: [] }).status, 'no_data')
  assert.throws(() => renderPie(selection, { ...dataset, rows: [{ category: '甲', value: -1 }] }), /负值/)
  assert.throws(() => renderPie(selection, { ...dataset, rows: [dataset.rows[1], dataset.rows[1]] }), /重复/)
})

test('折线保留重复时间、零和空值断点；时间轴与单位来自真实字段', () => {
  const rows = [{ time: '2026-08-01 00:00:00', value: 1.23456789 }, { time: '2026-08-01 00:00:00', value: 0 }, { time: '2026-08-02 00:00:00', value: null }]
  const chart = renderLine({ ...selection, x_field: 'time' }, {
    ...dataset, columns: [{ name: 'time', type: 'time' }, { name: 'value', type: 'number', unit: 'm' }], rows,
  })
  assert.deepEqual(series(chart)[0].data, rows.map(row => [row.time, row.value]))
  assert.equal(series(chart)[0].connectNulls, false)
  assert.match(chart.summary, /单位：m/)
  assert.equal((chart.option!.dataZoom as Json[]).length, 2)
  assert.throws(() => renderLine(selection, dataset), /时间字段/)
})

test('柱状保留零，堆叠对齐系列但不将缺失值填零，散点不聚合重复分类', () => {
  assert.deepEqual(series(renderBar(selection, dataset))[0].data, [0, 2.123456789])
  const multi: ChartDataset = {
    ...dataset, columns: [...dataset.columns, { name: 'group', type: 'category' }],
    rows: [{ category: '甲', group: '一', value: 1 }, { category: '乙', group: '一', value: 2 }, { category: '甲', group: '二', value: 3 }],
  }
  const stack = renderStackedBar({ ...selection, series_field: 'group' }, multi)
  assert.deepEqual(series(stack).map(item => [item.stack, item.data]), [['total', [1, 2]], ['total', [3, null]]])
  assert.throws(() => renderStackedBar(selection, multi), /series_field/)
  assert.deepEqual(series(renderScatter(selection, { ...dataset, rows: [...dataset.rows, dataset.rows[1]] }))[0].data, [[0, '甲'], [2.123456789, '乙'], [2.123456789, '乙']])
  assert.throws(() => renderBar({ ...selection, value_field: 'missing' }, dataset), /不存在字段/)
})

/** 用真实工具管线和轮次投影验证服务，不绕过 prepare/accept 边界。 */
async function harness() {
  const ctx = new Context()
  await ctx.plugin(Sessions)
  await ctx.plugin(Projections)
  ctx.sessionProjections.register(turnBoundaryProjectionDefinition)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  const host = ctx.plugin(charts)
  await host
  assert.deepEqual(ctx.tools.schemas(), [])
  const toolPlugin = ctx.plugin(tools)
  await toolPlugin
  let lastSource: ChartSource | undefined
  let cancel: AbortController | undefined
  ctx.tools.register(defineTool({
    name: 'query_fixture', description: '返回固定数据集。',
    parameters: { fail: { type: 'boolean' }, cancel: { type: 'boolean' } },
    output: { schema: { type: 'object', additionalProperties: false, properties: { chart_source: charts.chartSourceSchema } }, render: () => [] },
    execute: async (args, exec) => {
      lastSource = ctx.chartSources.prepare(exec, [dataset])
      if (args.fail) throw new Error('查询失败')
      if (args.cancel) cancel!.abort()
      return lastSource ? { chart_source: lastSource } : {}
    },
  }))
  const session = ctx.sessions.create(SessionId('charts'))
  const other = ctx.sessions.create(SessionId('other'))
  // 工具管线只需要 agent 的会话身份；无需模型或运行中的 driver。
  const agent = (session: Session) => ({ session }) as Agent
  const execute = (owner: Session, name: string, args: object, signal = new AbortController().signal) => ctx.tools.execute({
    callId: ToolCallId('fixture'), name, arguments: args, agent: agent(owner), signal,
  })
  return { ctx, host, toolPlugin, session, other, execute, source: () => lastSource!, cancel: (controller: AbortController) => { cancel = controller } }
}

test('服务仅发布成功结果，拒绝跨会话和跨轮来源，并在取消与卸载后释放', async () => {
  const fixture = await harness()
  const { ctx, session, other, execute } = fixture
  try {
    session.append('turn/start', { turn: 1 })
    other.append('turn/start', { turn: 1 })
    assert.equal((await execute(session, 'query_fixture', {})).isError, false)
    const args = { ...selection, source_id: fixture.source().source_id }
    assert.equal((await execute(session, 'render_pie_chart', args)).isError, false)
    assert.equal((await execute(other, 'render_pie_chart', args)).isError, true)
    assert.equal((await execute(session, 'query_fixture', { fail: true })).isError, true)
    assert.equal((await execute(session, 'render_pie_chart', { ...args, source_id: fixture.source().source_id })).isError, true)
    const controller = new AbortController()
    fixture.cancel(controller)
    assert.equal((await execute(session, 'query_fixture', { cancel: true }, controller.signal)).isError, true)
    assert.equal((await execute(session, 'render_pie_chart', { ...args, source_id: fixture.source().source_id })).isError, true)
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    session.append('turn/start', { turn: 2 })
    assert.equal((await execute(session, 'render_pie_chart', args)).isError, true)
    await fixture.toolPlugin.dispose()
    assert.deepEqual(ctx.tools.schemas().map(tool => tool.name), ['query_fixture'])
    await fixture.host.dispose()
    assert.equal(ctx.chartSources, undefined)
  } finally { await ctx.fiber.dispose() }
})

test('原生图表参数校验、持久协议与旧版本1元数据回放保持兼容', async () => {
  const fixture = await harness()
  const { ctx, session, execute } = fixture
  try {
    session.append('turn/start', { turn: 1 })
    await execute(session, 'query_fixture', {})
    const args = { ...selection, source_id: fixture.source().source_id }
    const first = await execute(session, 'render_pie_chart', args)
    const second = await execute(session, 'render_pie_chart', args)
    assert.equal(first.isError, false)
    assert.equal(first.content.some(block => block.type === 'text' && block.text.includes('series')), false)
    const meta = JSON.parse(JSON.stringify(first.meta))
    assert.ok(chartFromMeta(meta)?.option.series)
    assert.deepEqual(chartFromMeta(second.meta), chartFromMeta(meta))
    assert.equal(chartFromMeta({ agentScenariosChart: { version: 2, chart: {} } }), undefined)
    assert.equal((await execute(session, 'render_pie_chart', { ...args, source_id: 'forged' })).isError, true)
    assert.equal((await execute(session, 'render_pie_chart', { ...args, value_field: 123 })).isError, true)
  } finally { await ctx.fiber.dispose() }
})
