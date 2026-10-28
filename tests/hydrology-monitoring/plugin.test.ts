import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse } from 'yaml'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import LlmRuntime, { createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import Sessions, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import PresetRegistry, { type PresetDefinition } from '@deepseek-ai/dsh-agent-preset-registry'
import AgentPreset from '@deepseek-ai/dsh-agent-preset'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import WorkingDirectory from '@deepseek-ai/dsh-working-directory'
import SessionQuery from '@deepseek-ai/dsh-session-query'
import * as JsonlPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import * as Spawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import * as charts from 'dsh-agent-charts'
import type { ChartSource } from 'dsh-agent-charts'
import { HydrologyAdapter } from '../fixtures/hydrology-model.ts'
import { HISTORY, REALTIME, queryFor, startCubeFixture, type CubeFixtureOptions } from '../fixtures/hydrology.ts'

class ExactSessionQuery extends SessionQuery {
  searchSessions(): Promise<never> { return Promise.reject(new Error('本测试只使用会话精确读取。')) }
  searchEvents(): Promise<never> { return Promise.reject(new Error('本测试只使用会话精确读取。')) }
}

async function harness(cubeUrl: string, iterations = 6) {
  const root = await mkdtemp(join(tmpdir(), 'hydrology-harness-'))
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
  await ctx.plugin(JsonlPersistence, { root })
  await ctx.plugin(ExactSessionQuery)
  await ctx.plugin(PresetRegistry, { default: 'water-hazard' })
  await ctx.plugin(SubagentRuntime)
  await ctx.plugin(Spawn, { providerName: 'spawn' })
  await ctx.plugin(charts)
  const patch: { insert?: { config: PresetDefinition }[] }[] = parse(await readFile(new URL('../../cordis.patch.yml', import.meta.url), 'utf8'))
  for (const row of patch.flatMap(item => item.insert ?? []).filter(row => row.config?.id?.startsWith('hydrology-'))) {
    await ctx.plugin(AgentPreset, { ...row.config, plugins: row.config.plugins.map(entry => {
      if (entry.name === 'dsh-agent-scenarios/hydrology-monitoring') return { ...entry, name: new URL('../../src/scenarios/hydrology-monitoring/index.ts', import.meta.url).href }
      if (entry.name === 'dsh-agent-scenarios/hydrology-monitoring/query-child') return { ...entry, name: new URL('../../src/scenarios/hydrology-monitoring/query-child/index.ts', import.meta.url).href, config: { cubeUrl, maxAgentIterations: iterations } }
      return entry
    }) })
  }
  const create = (id: string, preset = 'hydrology-monitoring') => ctx.agents.create({ sessionId: SessionId(id), agentOptions: { provider: 'recorded-hydrology', model: 'fixture' },
    setup: async agentCtx => { await ctx.agentPresets.mount(agentCtx, preset) } })
  return { ctx, create, close: async () => { await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) } }
}

for (const options of [{}, { empty: true }, { status: 401 }, { failModel: REALTIME }] satisfies CubeFixtureOptions[]) test(`原生 spawn→完成通知→结果读取→图表正文：${JSON.stringify(options)}`, { timeout: 15000 }, async () => {
  const fixture = await startCubeFixture(options)
  const h = await harness(fixture.url)
  try {
    const adapter = new HydrologyAdapter()
    h.ctx.llm.registerAdapter(['recorded-hydrology'], adapter)
    const handle = await h.create('parent')
    const agent = handle.agent
    agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'failModel' in options ? '主斜井水位部分失败分析' : '分析主斜井水位历史情况' }] }))
    do { await agent.whenIdle() } while (await h.ctx.subagents.waitForChildren(agent))
    const events = agent.session.ownEvents()
    const calls = events.filter(event => event.type === 'tool/call')
    assert.deepEqual(calls.map(event => event.data.name), ['skill', 'query_hydrology', ...('failModel' in options ? ['query_hydrology'] : []), 'get_hydrology_query_result', ...('failModel' in options ? ['get_hydrology_query_result'] : []), ...('empty' in options || 'status' in options ? [] : ['render_line_chart'])])
    const results = events.filter(event => event.type === 'tool/result')
    assert.ok(results.every(event => !event.data.message.isError), JSON.stringify(results))
    const children = await h.ctx.subagents.listChildren(agent.id)
    assert.equal(children.length, 'failModel' in options ? 2 : 1)
    using child = await h.ctx.sessionQuery.observeSession(children[0].id)
    assert.equal(child.header.agentPreset, 'hydrology-query')
    assert.equal(child.header.parentSession, agent.id)
    const queries = child.events.filter(event => event.type === 'tool/call' && event.data.name === 'run_semantic_query')
    assert.equal(queries.length, 'status' in options ? 0 : 1)
    assert.equal(adapter.requests.filter(request => request.tools?.some(tool => tool.name === 'run_semantic_query')).length, 'status' in options ? 1 : 'failModel' in options ? 6 : 3)
    const outcome = 'empty' in options ? 'no_data' : 'status' in options ? 'error' : 'success'
    assert.ok(results.some(event => event.data.message.content.some(block => block.type === 'text' && block.text === `查询状态：${outcome}`)))
    assert.equal(results.filter(event => event.data.meta !== undefined).length, outcome === 'success' ? 1 : 0)
    const final = events.findLast(event => event.type === 'assistant/message')
    assert.ok(final?.type === 'assistant/message')
    assert.match(JSON.stringify(final.data.message.content), outcome === 'success' ? /\[图表:[a-f0-9]{24}\]/ : /没有可展示的历史趋势/)
    assert.deepEqual(JSON.parse(JSON.stringify(events)), events)
    const other = await h.create('other')
    other.agent.session.append('turn/start', { turn: 1 })
    const denied = await h.ctx.tools.execute({ callId: ToolCallId('foreign'), name: 'get_hydrology_query_result', arguments: { subagent_id: children[0].id }, agent: other.agent, signal: new AbortController().signal })
    assert.equal(denied.isError, true)
    other.agent.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    await other.dispose()
    await handle.dispose()
    using restored = await h.ctx.sessionQuery.observeSession(agent.id)
    assert.ok(restored.events.some(event => event.type === 'tool/result'))
  } finally { await h.close(); await fixture.close() }
})

test('查询 preset 隔离技能和工具，先检索目录，成功后禁止第二次查询', async () => {
  const fixture = await startCubeFixture()
  const h = await harness(fixture.url)
  try {
    const child = await h.create('child-scope', 'hydrology-query')
    assert.deepEqual(h.ctx.tools.schemas(child.agent).map(tool => tool.name), ['search_semantic_catalog', 'run_semantic_query'])
    assert.deepEqual(await h.ctx.skills.list({ scope: child.agent }), [])
    const main = await h.create('main-scope')
    assert.equal((await h.ctx.skills.list({ scope: main.agent })).length, 6)
    assert.ok(!h.ctx.tools.schemas(main.agent).some(tool => tool.name === 'run_semantic_query'))
    const run = (name: string, args: object) => h.ctx.tools.execute({ callId: ToolCallId(name), name, arguments: args, agent: child.agent, signal: new AbortController().signal })
    assert.equal((await run('run_semantic_query', { query_goal: '历史', semantic_query: queryFor() })).isError, true)
    assert.equal(fixture.requests.length, 0)
    assert.equal((await run('search_semantic_catalog', { model_names: [HISTORY] })).isError, false)
    assert.equal((await run('run_semantic_query', { query_goal: '历史', semantic_query: queryFor() })).isError, false)
    assert.equal((await run('run_semantic_query', { query_goal: '第二次', semantic_query: queryFor() })).isError, true)
    await child.dispose(); await main.dispose()
    assert.deepEqual(h.ctx.tools.schemas(), [])
  } finally { await h.close(); await fixture.close() }
})

test('依赖任务使用上游结果，展示轮重新登记来源，旧轮及其他会话来源不可用', async () => {
  const fixture = await startCubeFixture()
  const h = await harness(fixture.url)
  try {
    h.ctx.llm.registerAdapter(['recorded-hydrology'], new HydrologyAdapter())
    const parent = await h.create('dependency-parent')
    const run = (name: string, args: object) => h.ctx.tools.execute({ callId: ToolCallId(`${name}-${Math.random()}`), name, arguments: args, agent: parent.agent, signal: new AbortController().signal })
    const delegate = (prompt: string) => h.ctx.subagents.startActivation({ provider: 'spawn', label: '依赖查询', delivery: 'caller', signal: new AbortController().signal,
      request: { parent: parent.agent, agentPreset: 'hydrology-query', maxDepth: 1, prompt: [{ type: 'text', text: prompt }] } })
    const first = await delegate('查询主斜井水位2025年9月前七天历史。')
    assert.equal((await first.result).stopReason, 'completed')
    parent.agent.session.append('turn/start', { turn: 1 })
    const upstream = await run('get_hydrology_query_result', { subagent_id: first.childId })
    assert.ok(!upstream.isError)
    const value = upstream.value as { tables: { rows: Record<string, string>[] }[]; chart_source: ChartSource }
    const point = value.tables[0].rows[0]['名称及编码']
    const second = await delegate(`查询上游返回的${point}实时状态，不附加历史日期过滤。`)
    assert.equal((await second.result).stopReason, 'completed')
    using child = await h.ctx.sessionQuery.observeSession(second.childId)
    assert.ok(child.events.some(event => event.type === 'user/message' && JSON.stringify(event.data.content).includes(point)))
    parent.agent.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    parent.agent.session.append('turn/start', { turn: 2 })
    const chartArgs = { source_id: value.chart_source.source_id, dataset_id: value.chart_source.datasets[0].id, title: '历史', x_field: 'time', value_field: 'value', series_field: 'point' }
    assert.equal((await run('render_line_chart', chartArgs)).isError, true)
    const reread = await run('get_hydrology_query_result', { subagent_id: first.childId })
    assert.ok(!reread.isError)
    const fresh = (reread.value as { chart_source: ChartSource }).chart_source
    assert.notEqual(fresh.source_id, value.chart_source.source_id)
    assert.equal((await run('render_line_chart', { ...chartArgs, source_id: fresh.source_id })).isError, false)
    assert.equal((await run('get_hydrology_query_result', { subagent_id: second.childId })).isError, false)
    parent.agent.session.append('turn/end', { turn: 2, reason: { kind: 'completed' } })
    await first.dispose(); await second.dispose()
    const beforeResume = fixture.requests.length
    const resumed = await h.ctx.agents.resume({ resumeSessionId: first.childId, parentAgent: parent.agent,
      agentOptions: { provider: 'recorded-hydrology', model: 'fixture' },
      setup: async agentCtx => { await h.ctx.agentPresets.mount(agentCtx, 'hydrology-query') } })
    resumed.agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '再查询一次历史' }] }))
    await resumed.agent.whenIdle()
    assert.equal(fixture.requests.length, beforeResume)
    assert.equal(resumed.agent.session.ownEvents().filter(event => event.type === 'tool/call' && event.data.name === 'run_semantic_query').length, 1)
    await resumed.dispose(); await parent.dispose()
  } finally { await h.close(); await fixture.close() }
})

test('迭代上限和取消不会留下可冒充成功的查询结果', async () => {
  for (const cancelled of [false, true]) {
    const fixture = await startCubeFixture(cancelled ? { delay: 100 } : {})
    const h = await harness(fixture.url, cancelled ? 6 : 2)
    try {
      h.ctx.llm.registerAdapter(['recorded-hydrology'], new HydrologyAdapter())
      const parent = await h.create('bounded-parent')
      const activation = await h.ctx.subagents.startActivation({ provider: 'spawn', label: '有限查询', delivery: 'caller', signal: new AbortController().signal,
        request: { parent: parent.agent, agentPreset: 'hydrology-query', prompt: [{ type: 'text', text: '查询历史情况' }] } })
      if (cancelled) await activation.dispose()
      assert.notEqual((await activation.result).stopReason, 'completed')
      parent.agent.session.append('turn/start', { turn: 1 })
      const read = await h.ctx.tools.execute({ callId: ToolCallId('failed-result'), name: 'get_hydrology_query_result', arguments: { subagent_id: activation.childId }, agent: parent.agent, signal: new AbortController().signal })
      assert.equal(read.isError, true)
      assert.ok(!fixture.requests.some(request => request.path === 'load'))
      parent.agent.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
      await activation.dispose(); await parent.dispose()
    } finally { await h.close(); await fixture.close() }
  }
})
