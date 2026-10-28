import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm, writeFile, stat } from 'node:fs/promises'
import { createHash } from 'node:crypto'
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
import LocalSpillStore from '@deepseek-ai/dsh-spill-local'
import * as SpillPolicy from '@deepseek-ai/dsh-spill-policy'
import QueryResults from '../../src/scenarios/hydrology-monitoring/results.ts'
import { receiptFromMeta } from '../../src/scenarios/hydrology-monitoring/protocol.ts'
import type { ChartResult, ChartSource } from 'dsh-agent-charts'
import { HydrologyAdapter } from '../fixtures/hydrology-model.ts'
import { HISTORY, REALTIME, queryFor, startCubeFixture, type CubeFixtureOptions } from '../fixtures/hydrology.ts'

class ExactSessionQuery extends SessionQuery {
  searchSessions(): Promise<never> { return Promise.reject(new Error('本测试只使用会话精确读取。')) }
  searchEvents(): Promise<never> { return Promise.reject(new Error('本测试只使用会话精确读取。')) }
}

async function harness(cubeUrl: string, iterations = 6, options: { spill?: boolean; invalidResultDirectory?: boolean } = {}) {
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
  await ctx.plugin(JsonlPersistence, { root: join(root, 'sessions') })
  await ctx.plugin(ExactSessionQuery)
  await ctx.plugin(PresetRegistry, { default: 'water-hazard' })
  await ctx.plugin(SubagentRuntime)
  await ctx.plugin(Spawn, { providerName: 'spawn' })
  await ctx.plugin(charts)
  if (options.invalidResultDirectory) await writeFile(join(root, 'blocked-results'), 'not a directory')
  await ctx.plugin(QueryResults, { resultsDirectory: join(root, options.invalidResultDirectory ? 'blocked-results' : 'results') })
  if (options.spill) {
    await ctx.plugin(LocalSpillStore, { root: join(root, 'spill'), cleanupPeriodDays: 0 })
    await ctx.plugin(SpillPolicy, { maxInlineTokens: 12500 })
  }
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
  return { ctx, create, root, close: async () => { await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) } }
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

for (const rowCount of [5, 50, 193, 77, 10000]) test(`真实 spill 策略下正文最多展示50行，完整保留${rowCount}行供读取和绘图`, { timeout: 30000 }, async () => {
  const fixture = await startCubeFixture({ rowCount })
  const h = await harness(fixture.url, 6, { spill: true })
  try {
    h.ctx.llm.registerAdapter(['recorded-hydrology'], new HydrologyAdapter())
    const parent = await h.create('large-parent')
    if (rowCount === 10000) h.ctx.on('tools/post-execute', async (exec, result, next) => {
      const decision = await next()
      if (exec.name !== 'run_semantic_query' || result.isError || decision.kind !== 'accept' || Object.hasOwn(decision, 'value')) return decision
      // 用真实 spill 策略截断展示文本，结构化回执和独立文件应照常可读。
      return { kind: 'accept', content: [...result.content, { type: 'text', text: '查询补充展示信息'.repeat(20000) }], additionalContexts: decision.additionalContexts }
    })
    parent.agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '分析主斜井水位历史情况' }] }))
    do { await parent.agent.whenIdle() } while (await h.ctx.subagents.waitForChildren(parent.agent))
    const events = parent.agent.session.ownEvents()
    assert.ok(events.filter(event => event.type === 'tool/result').every(event => !event.data.message.isError))
    assert.equal(events.filter(event => event.type === 'tool/result' && event.data.meta !== undefined).length, 1)
    const [child] = await h.ctx.subagents.listChildren(parent.agent.id)
    using observed = await h.ctx.sessionQuery.observeSession(child.id)
    const final = observed.events.findLast(event => event.type === 'tool/result' && receiptFromMeta(event.data.meta)?.terminal)
    assert.ok(final?.type === 'tool/result')
    const receipt = receiptFromMeta(final.data.meta)!
    assert.equal(receipt.version, 2)
    assert.equal(receipt.row_count, rowCount)
    assert.ok(JSON.stringify(receipt).length < 2500)
    assert.ok(!JSON.stringify(final.data).includes('"rows":'))
    const record = await h.ctx.hydrologyQueryResults.read(child.id, parent.agent.id, receipt.result_ref!, new AbortController().signal)
    assert.equal(record.rows.length, rowCount)
    assert.equal(record.rows[0][`${HISTORY}.value`], null)
    assert.equal(record.rows.at(-1)?.[`${HISTORY}.value`], (rowCount - 1) % 7 === 0 ? null : (rowCount - 1) / 100)
    const file = join(h.ctx.hydrologyQueryResults.directory, createHash('sha256').update(child.id).digest('hex'), `${receipt.result_ref!.id}.json`)
    assert.equal((await stat(file)).size, receipt.result_ref!.bytes)
    if (rowCount === 10000) {
      assert.ok(receipt.result_ref!.bytes > 5_000_000)
      assert.match(JSON.stringify(final.data.message.content), /\(Omitted /)
      assert.throws(() => JSON.parse(final.data.message.content.filter(block => block.type === 'text').map(block => block.text).join('')))
    }
    const displayed = events.filter(event => event.type === 'tool/result').filter(event => event.data.message.content.some(block => block.type === 'text' && block.text.startsWith('查询状态：')))
    const modelText = displayed.flatMap(event => event.data.message.content.filter(block => block.type === 'text').map(block => block.text)).join('')
    const details = modelText.split('### 查询明细\n\n')[1]?.split('\n\n')[0]
    assert.ok(details, '正文应始终展示查询明细表')
    const lines = details.split('\n')
    const timeColumn = lines[0].split('|').indexOf(' 监测时间 ')
    assert.ok(timeColumn > 0)
    assert.equal(lines.length - 2, Math.min(rowCount, 50))
    assert.deepEqual(lines.slice(2).map(line => line.split('|')[timeColumn].trim()), record.rows.slice(0, 50).map(row => row[`${HISTORY}.observed_at`]))
    const source = JSON.parse(modelText.split('可绘图数据集（使用来源ID调用图表工具）：\n')[1]) as ChartSource
    assert.equal(source.datasets.length, 1)
    assert.match(source.datasets[0].id, /^history_/)
    assert.equal(source.datasets[0].row_count, rowCount)
    if (rowCount > 50) {
      assert.ok(modelText.includes(`明细共 ${rowCount} 行，正文仅展示前 50 行，完整数据已保留在图表数据集 ${source.datasets[0].id} 中`))
      assert.ok(!modelText.includes(String(record.rows[50][`${HISTORY}.observed_at`])))
    } else {
      assert.doesNotMatch(modelText, /正文仅展示前/)
      assert.match(modelText, /2025-09-01T00:00:00\.000Z/)
      if (rowCount === 5) assert.match(modelText, /2025-09-01T00:02:00\.000Z/)
    }
    assert.match(modelText, /历史指标统计/)
    assert.match(modelText, /可绘图数据集/)
    assert.match(modelText, /实际查询条件：.*2025-09-01.*2025-09-07/)
    const chartEvent = events.filter(event => event.type === 'tool/result').find(event => event.data.meta !== undefined)
    const chartMeta = chartEvent?.data.meta as { agentScenariosChart: { chart: ChartResult } } | undefined
    assert.equal(chartMeta?.agentScenariosChart.chart.chart_type, 'line')
    const series = chartMeta!.agentScenariosChart.chart.option!.series as { data: unknown[] }[]
    assert.equal(series.reduce((sum, item) => sum + item.data.length, 0), rowCount)
    await parent.dispose()
    assert.equal((await h.ctx.hydrologyQueryResults.read(child.id, parent.agent.id, receipt.result_ref!, new AbortController().signal)).row_count, rowCount)
    // 新服务实例仍从同一结果目录读取，结果不依赖内存缓存。
    const restarted = new Context()
    await restarted.plugin(SystemPrompt); await restarted.plugin(ToolRuntime)
    await restarted.plugin(QueryResults, { resultsDirectory: h.ctx.hydrologyQueryResults.directory })
    try { assert.equal((await restarted.hydrologyQueryResults.read(child.id, parent.agent.id, receipt.result_ref!, new AbortController().signal)).row_count, rowCount) }
    finally { await restarted.fiber.dispose() }
  } finally { await h.close(); await fixture.close() }
})

test('原生子智能体按具体错误路径纠正参数，最终 Cube 请求保留日期、AND及排除条件', async () => {
  const fixture = await startCubeFixture()
  const h = await harness(fixture.url)
  try {
    h.ctx.llm.registerAdapter(['recorded-hydrology'], new HydrologyAdapter())
    const parent = await h.create('repair-parent')
    const activation = await h.ctx.subagents.startActivation({ provider: 'spawn', label: '纠错', delivery: 'caller', signal: new AbortController().signal,
      request: { parent: parent.agent, agentPreset: 'hydrology-query', prompt: [{ type: 'text', text: '纠错回归：查询主斜井水位液位2025年9月前7天的历史，排除排除测点。' }] } })
    assert.equal((await activation.result).stopReason, 'completed')
    using child = await h.ctx.sessionQuery.observeSession(activation.childId)
    const failed = child.events.find(event => event.type === 'tool/result' && event.data.message.isError)
    assert.ok(failed?.type === 'tool/result')
    assert.match(JSON.stringify(failed.data.message.content), /semantic_query.filters\[0\].member/)
    assert.match(JSON.stringify(failed.data.message.content), /semantic_query.filters\[0\].operator/)
    assert.deepEqual(fixture.requests.map(request => request.path), ['meta', 'sql', 'load'])
    const query = fixture.requests.at(-1)!.query!
    assert.deepEqual(query.filters, [{ member: `${HISTORY}.point_name`, operator: 'equals', values: ['主斜井水位'] }, { member: `${HISTORY}.value_type_id`, operator: 'equals', values: ['12001'] }, { member: `${HISTORY}.point_name`, operator: 'notEquals', values: ['排除测点'] }])
    assert.deepEqual(query.timeDimensions, [{ dimension: `${HISTORY}.observed_at`, dateRange: ['2025-09-01', '2025-09-07'] }])
    await activation.dispose(); await parent.dispose()
  } finally { await h.close(); await fixture.close() }
})

test('结果文件丢失、损坏、错误归属和非法引用均明确失败', async () => {
  const fixture = await startCubeFixture()
  const h = await harness(fixture.url)
  try {
    h.ctx.llm.registerAdapter(['recorded-hydrology'], new HydrologyAdapter())
    const parent = await h.create('integrity-parent')
    const activation = await h.ctx.subagents.startActivation({ provider: 'spawn', label: '文件校验', delivery: 'caller', signal: new AbortController().signal,
      request: { parent: parent.agent, agentPreset: 'hydrology-query', prompt: [{ type: 'text', text: '查询主斜井水位历史' }] } })
    await activation.result
    using observed = await h.ctx.sessionQuery.observeSession(activation.childId)
    const final = observed.events.findLast(event => event.type === 'tool/result' && receiptFromMeta(event.data.meta)?.terminal)
    assert.ok(final?.type === 'tool/result')
    const ref = receiptFromMeta(final.data.meta)!.result_ref!
    const store = h.ctx.hydrologyQueryResults
    await assert.rejects(store.read(activation.childId, SessionId('other-parent'), ref, new AbortController().signal), /归属无效/)
    await assert.rejects(store.read(activation.childId, parent.agent.id, { ...ref, id: '../foreign' }, new AbortController().signal), /引用无效/)
    const file = join(store.directory, createHash('sha256').update(activation.childId).digest('hex'), `${ref.id}.json`)
    const original = await readFile(file)
    await writeFile(file, 'corrupted')
    await assert.rejects(store.read(activation.childId, parent.agent.id, ref, new AbortController().signal), /损坏/)
    await writeFile(file, original)
    assert.equal((await store.read(activation.childId, parent.agent.id, ref, new AbortController().signal)).outcome, 'success')
    await rm(file)
    await assert.rejects(store.read(activation.childId, parent.agent.id, ref, new AbortController().signal), /文件不可用/)
    await activation.dispose(); await parent.dispose()
  } finally { await h.close(); await fixture.close() }
})

test('写入失败返回终止错误回执，不把查询成功当成已保存', async () => {
  const fixture = await startCubeFixture()
  const h = await harness(fixture.url, 6, { invalidResultDirectory: true })
  try {
    h.ctx.llm.registerAdapter(['recorded-hydrology'], new HydrologyAdapter())
    const parent = await h.create('write-failure-parent')
    parent.agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '分析主斜井水位历史情况' }] }))
    do { await parent.agent.whenIdle() } while (await h.ctx.subagents.waitForChildren(parent.agent))
    const results = parent.agent.session.ownEvents().filter(event => event.type === 'tool/result')
    assert.ok(results.some(event => event.data.message.content.some(block => block.type === 'text' && block.text === '查询状态：error')))
    assert.ok(results.some(event => JSON.stringify(event.data.message.content).includes('保存失败')))
    assert.ok(!parent.agent.session.ownEvents().some(event => event.type === 'tool/call' && event.data.name === 'render_line_chart'))
    await parent.dispose()
  } finally { await h.close(); await fixture.close() }
})

for (const cancelled of [false, true]) test(`工具最终${cancelled ? '取消' : '拒绝'}后清理未提交结果文件`, async () => {
  const fixture = await startCubeFixture()
  const h = await harness(fixture.url)
  try {
    const child = await h.create('cleanup-child', 'hydrology-query')
    const controller = new AbortController()
    const run = (name: string, args: object) => h.ctx.tools.execute({ callId: ToolCallId(name), name, arguments: args, agent: child.agent, signal: controller.signal })
    await run('search_semantic_catalog', { model_names: [HISTORY] })
    h.ctx.on('tools/post-execute', async (exec, result, next) => {
      if (exec.name !== 'run_semantic_query' || result.isError) return next()
      if (cancelled) { controller.abort(); return next() }
      return { kind: 'block', feedback: [{ type: 'text', text: '测试拒绝最终结果' }] }
    })
    const result = await run('run_semantic_query', { query_goal: '历史', semantic_query: queryFor() })
    assert.equal(result.isError, true)
    await h.ctx.fiber.dispose()
    assert.equal((await readdir(join(h.root, 'results'), { recursive: true })).filter(path => path.endsWith('.json') || path.endsWith('.tmp')).length, 0)
  } finally { await h.close(); await fixture.close() }
})
