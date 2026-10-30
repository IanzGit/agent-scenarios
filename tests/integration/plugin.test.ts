import test from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import LlmRuntime, { createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import Sessions, { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import PresetRegistry from '@deepseek-ai/dsh-agent-preset-registry'
import AgentPreset from '@deepseek-ai/dsh-agent-preset'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import WorkingDirectory from '@deepseek-ai/dsh-working-directory'
import * as charts from 'dsh-agent-charts'
import type { ChartSource } from 'dsh-agent-charts'
import * as chartTools from 'dsh-agent-charts/tools'
import * as plugin from 'dsh-agent-water-hazard'
import { TOOL_NAMES } from '../../packages/water-hazard/src/tools/index.ts'
import { CHART_TOOL_NAMES } from 'dsh-agent-charts/tools'
import { startFixtureServer } from '../fixtures/server.ts'
import { RecordedAdapter, recordings } from '../fixtures/recorded-model.ts'
import { readBundlePatches } from '../fixtures/bundle.ts'

async function harness() {
  const ctx = new Context()
  ctx.baseUrl = new URL('../../', import.meta.url).href
  await ctx.plugin(Loader)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(Sessions)
  await ctx.plugin(SessionProjections)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(SkillRegistry)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(LocalFileSystem)
  await ctx.plugin(WorkingDirectory, {})
  await ctx.plugin(PresetRegistry, { default: 'water-hazard' })
  await ctx.plugin(charts)
  return ctx
}

async function declareWaterHazard(ctx: Context, apiBaseUrl: string) {
  const patch = await readBundlePatches()
  const row = patch.flatMap(item => item.insert ?? []).find(item => item.id === 'preset-water-hazard')
  assert.ok(row)
  return ctx.plugin(AgentPreset, {
    ...row.config,
    plugins: row.config.plugins.map(entry => entry.name === 'dsh-agent-water-hazard'
      ? { ...entry, config: { apiBaseUrl } }
      : entry),
  })
}

async function agentOn(ctx: Context, id: string, preset = 'water-hazard') {
  return ctx.agents.create({
    sessionId: SessionId(id), agentOptions: { provider: 'recorded', model: 'fixture' },
    setup: async agentCtx => { await ctx.agentPresets.mount(agentCtx, preset) },
  })
}

test('水害包入口、参数校验、完整 Markdown 结果和插件卸载均通过原生管线', async () => {
  const fixture = await startFixtureServer()
  const ctx = await harness()
  try {
    const fiber = ctx.plugin(plugin, { apiBaseUrl: fixture.url })
    await fiber
    const chartFiber = ctx.plugin(chartTools)
    await chartFiber
    assert.deepEqual(ctx.tools.schemas().map(tool => tool.name), [...TOOL_NAMES, ...CHART_TOOL_NAMES])
    assert.deepEqual((await ctx.skills.list()).map(skill => skill.name), ['water-hazard-emergency', 'water-hazard-focus', 'water-hazard-overview', 'water-hazard-review', 'water-hazard-roof', 'water-hazard-trend'])
    const invalid = await ctx.tools.execute({ callId: ToolCallId('invalid'), name: 'get_hydrological_trend', arguments: { start_time: 123 }, signal: new AbortController().signal })
    assert.equal(invalid.isError, true)
    assert.equal(fixture.requests.length, 0)
    for (const name of TOOL_NAMES.slice(0, 5)) {
      const executed = await ctx.tools.execute({ callId: ToolCallId(name), name, arguments: {}, signal: new AbortController().signal })
      assert.equal(executed.isError, false, name)
      assert.equal(executed.meta, undefined)
      const content = executed.content.filter(block => block.type === 'text').map(block => block.text).join('')
      if (name === 'get_warning_statistics') {
        assert.equal(/\| .+ \|/.test(content), false)
        assert.match(content, /网页预警统计/)
      } else {
        assert.match(content, /\| .+ \|/)
      }
      assert.equal(content.includes('series'), false)
      assert.equal(content.includes('1.234567'), false)
    }
    await fiber.dispose()
    await chartFiber.dispose()
    assert.equal(ctx.tools.schemas().length, 0)
    assert.equal((await ctx.skills.list()).length, 0)
  } finally { await ctx.fiber.dispose(); await fixture.close() }
})

test('preset 只向本领域暴露工具、技能和日期，释放后撤销全部注册', async () => {
  const ctx = await harness()
  try {
    const declaration = await declareWaterHazard(ctx, 'http://fixture')
    await ctx.plugin(AgentPreset, { id: 'other', plugins: [] })
    const waterHandle = await agentOn(ctx, 'water')
    const otherHandle = await agentOn(ctx, 'other', 'other')
    const water = waterHandle.agent
    const other = otherHandle.agent
    assert.deepEqual(ctx.tools.schemas(water).map(tool => tool.name), [...TOOL_NAMES, ...CHART_TOOL_NAMES, 'skill'])
    assert.deepEqual((await ctx.skills.list({ scope: water })).map(skill => skill.name), ['water-hazard-emergency', 'water-hazard-focus', 'water-hazard-overview', 'water-hazard-review', 'water-hazard-roof', 'water-hazard-trend'])
    assert.deepEqual(ctx.tools.schemas(other), [])
    assert.deepEqual(await ctx.skills.list({ scope: other }), [])
    assert.deepEqual(ctx.tools.schemas(), [])
    assert.deepEqual(await ctx.skills.list(), [])
    const waterPrompt = ctx.systemPrompt.assemble({ scope: water })
    const otherPrompt = ctx.systemPrompt.assemble({ scope: other })
    assert.ok((await waterPrompt).sections.some(section => section.name === 'water-hazard:reference-date'))
    assert.ok(!(await otherPrompt).sections.some(section => section.name === 'water-hazard:reference-date'))
    const denied = await ctx.tools.execute({ callId: ToolCallId('outside'), name: 'get_device_status', arguments: {}, agent: other, signal: new AbortController().signal })
    assert.equal(denied.isError, true)
    await waterHandle.dispose()
    await declaration.dispose()
    assert.equal(ctx.agentPresets.inspectCompositions().some(item => item.id === 'water-hazard'), false)
    assert.deepEqual(ctx.tools.schemas(water), [])
    assert.deepEqual(await ctx.skills.list({ scope: water }), [])
  } finally { await ctx.fiber.dispose() }
})

test('两个场景共享图表服务，但工具与数据来源隔离，卸载一个场景不影响另一个', async () => {
  const fixture = await startFixtureServer()
  const ctx = await harness()
  try {
    await declareWaterHazard(ctx, fixture.url)
    await ctx.plugin(AgentPreset, { id: 'second', plugins: [{ id: 'chart-tools', name: 'dsh-agent-charts/tools' }] })
    const water = await agentOn(ctx, 'water-shared')
    const second = await ctx.agents.create({
      sessionId: SessionId('second-shared'), agentOptions: { provider: 'recorded', model: 'fixture' },
      setup: async agentCtx => {
        await ctx.agentPresets.mount(agentCtx, 'second')
        await agentCtx.plugin({ inject: ['tools', 'chartSources'], apply(sourceCtx: Context) {
          sourceCtx.tools.register(defineTool({
          name: 'query_second', description: '第二场景的固定统计数据。', parameters: {},
          output: { schema: { type: 'object', additionalProperties: false, properties: { chart_source: charts.chartSourceSchema } }, render: () => [] },
          execute: async (_args, exec) => {
            const chart_source = sourceCtx.chartSources.prepare(exec, [{
              id: 'device_types', title: '第二场景统计',
              columns: [{ name: 'category', type: 'category' }, { name: 'value', type: 'number', unit: '个' }],
              rows: [{ category: '设备', value: 7 }],
            }])
            return chart_source ? { chart_source } : {}
          },
          }))
        } })
      },
    })
    water.agent.session.append('turn/start', { turn: 1 })
    second.agent.session.append('turn/start', { turn: 1 })
    const run = (agent: typeof water.agent, name: string, args: object) => ctx.tools.execute({
      callId: ToolCallId(name), name, arguments: args, agent, signal: new AbortController().signal,
    })
    const sourceId = (result: ToolExecutionResult) => {
      assert.ok(!result.isError, JSON.stringify(result))
      return (result.value as { chart_source: ChartSource }).chart_source.source_id
    }
    const waterSource = sourceId(await run(water.agent, 'get_device_status', {}))
    const secondSource = sourceId(await run(second.agent, 'query_second', {}))
    const args = { source_id: secondSource, dataset_id: 'device_types', title: '第二场景统计', x_field: 'category', value_field: 'value' }
    assert.equal((await run(second.agent, 'render_pie_chart', { ...args, source_id: waterSource })).isError, true)
    assert.equal((await run(water.agent, 'render_pie_chart', args)).isError, true)
    assert.equal((await run(second.agent, 'get_device_status', {})).isError, true)
    await water.dispose()
    assert.ok(ctx.chartSources)
    assert.equal((await run(second.agent, 'render_pie_chart', args)).isError, false)
    assert.deepEqual(ctx.tools.schemas(), [])
    await second.dispose()
  } finally { await ctx.fiber.dispose(); await fixture.close() }
})

for (const scenario of ['overview', 'trend']) test(`固定模型响应驱动 ${scenario}，完整表格及四张图表可回放`, async () => {
  const fixture = await startFixtureServer()
  const ctx = await harness()
  try {
    await declareWaterHazard(ctx, fixture.url)
    const adapter = new RecordedAdapter()
    ctx.llm.registerAdapter(['recorded'], adapter)
    const handle = await agentOn(ctx, scenario)
    const agent = handle.agent
    const events: SessionEvent[] = []
    ctx.on('session/event', (session, event) => { if (session === agent.session) events.push(event) })
    agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: scenario === 'trend' ? '近30天关键水文指标的变化趋势' : '当前矿井总体水害监测预警情况汇总分析' }] }))
    await agent.whenIdle()
    const calls = events.filter(event => event.type === 'tool/call')
    assert.deepEqual(calls.map(event => event.data.name), recordings[scenario].filter(step => 'tool' in step).map(step => step.tool))
    const results = events.filter(event => event.type === 'tool/result')
    assert.ok(results.every(event => !event.data.message.isError))
    const charts = results.filter(event => event.data.meta !== undefined)
    assert.equal(charts.length, 4)
    assert.deepEqual(JSON.parse(JSON.stringify(charts)), charts)
    assert.ok(charts.every(event => !JSON.stringify(event.data.message.content).includes('option')))
    const businessCalls = new Map(calls.filter(event => TOOL_NAMES.some(name => name === event.data.name)).map(event => [event.data.callId, event.data.name]))
    const tableResults = results.filter(event => businessCalls.has(event.data.message.source.callId))
    assert.ok(tableResults.every(event => {
      const hasTable = event.data.message.content.some(block => block.type === 'text' && block.text.includes('| --- |'))
      return businessCalls.get(event.data.message.source.callId) === 'get_warning_statistics' ? !hasTable : hasTable
    }))
    assert.equal(tableResults.length, scenario === 'trend' ? 1 : 4)
    assert.equal(adapter.requests.length, recordings[scenario].length)
    assert.ok(events.some(event => event.type === 'turn/end'))
    assert.deepEqual(JSON.parse(JSON.stringify(tableResults)), tableResults)
    await handle.dispose()
  } finally { await ctx.fiber.dispose(); await fixture.close() }
})

const newScenarios: Record<string, { question: string; charts: number; tool: string }> = {
  focus: { question: '近期需要关注的防治水重点问题', charts: 0, tool: 'get_report_summary' },
  roof: { question: '分析85211工作面顶板水害预警情况', charts: 1, tool: 'analyze_roof_water_warning' },
  emergency: { question: '生成85211工作面突水仿真与处置预案', charts: 2, tool: 'get_inrush_simulation' },
  review: { question: '根据水文多维数据生成85211工作面防治水周期报告', charts: 0, tool: 'get_hydrological_review' },
}
for (const [scenario, expected] of Object.entries(newScenarios)) test(`固定模型驱动 ${scenario}，工具、技能、表格与HTML展示经过完整Harness管线`, async () => {
  const fixture = await startFixtureServer()
  const ctx = await harness()
  try {
    await declareWaterHazard(ctx, fixture.url)
    const adapter = new RecordedAdapter()
    ctx.llm.registerAdapter(['recorded'], adapter)
    const handle = await agentOn(ctx, scenario)
    const events: SessionEvent[] = []
    ctx.on('session/event', (session, event) => { if (session === handle.agent.session) events.push(event) })
    handle.agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: expected.question }] }))
    await handle.agent.whenIdle()
    const calls = events.filter(event => event.type === 'tool/call')
    assert.deepEqual(calls.map(event => event.data.name), recordings[scenario].filter(step => 'tool' in step).map(step => step.tool))
    const results = events.filter(event => event.type === 'tool/result')
    assert.ok(results.every(event => !event.data.message.isError), JSON.stringify(results.filter(event => event.data.message.isError)))
    const images = results.filter(event => event.data.meta !== undefined)
    assert.equal(images.length, expected.charts)
    assert.ok(images.every(event => {
      const meta = event.data.meta as { agentScenariosChart: { version: number; chart: { html: string } } }
      return meta.agentScenariosChart.version === 2 && meta.agentScenariosChart.chart.html.includes('<svg')
        && !JSON.stringify(event.data.message.content).includes('<svg')
    }))
    const businessCall = calls.find(event => event.data.name === expected.tool)!
    const businessResult = results.find(event => event.data.message.source.callId === businessCall.data.callId)!
    const observed = businessResult.data.message.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
    assert.match(observed, /\| --- \|/)
    assert.ok(!observed.includes('<!DOCTYPE html>'))
    assert.deepEqual(JSON.parse(JSON.stringify(images)), images)
    assert.equal(adapter.requests.length, recordings[scenario].length)
    assert.ok(events.some(event => event.type === 'turn/end'))
    await handle.dispose()
  } finally { await ctx.fiber.dispose(); await fixture.close() }
})
