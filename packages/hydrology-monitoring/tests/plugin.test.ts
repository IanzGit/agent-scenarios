import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm, writeFile, stat } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import LlmRuntime, { createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import Sessions, { SessionId, appendPluginRecord } from '@deepseek-ai/dsh-session'
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import PresetRegistry from '@deepseek-ai/dsh-agent-preset-registry'
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
import QueryResults from '../src/infrastructure/results.ts'
import ParentTasks from '../src/application/parent-tasks.ts'
import { taskRecord, TASK_RECORD } from '../src/domain/task-protocol.ts'
import { readQueryResult } from '../src/application/query-result.ts'
import { receiptFromMeta } from '../src/domain/protocol.ts'
import type { ChartResult, ChartSource } from 'dsh-agent-charts'
import { HydrologyAdapter, hydrologyPlan } from '../../../tests/fixtures/hydrology-model.ts'
import { HISTORY, REALTIME, queryFor, startCubeFixture, type CubeFixtureOptions } from '../../../tests/fixtures/hydrology.ts'
import { readBundlePatches } from '../../../tests/fixtures/bundle.ts'

class ExactSessionQuery extends SessionQuery {
  searchSessions(): Promise<never> { return Promise.reject(new Error('本测试只使用会话精确读取。')) }
  searchEvents(): Promise<never> { return Promise.reject(new Error('本测试只使用会话精确读取。')) }
}

async function harness(cubeUrl: string, iterations = 6, options: { spill?: boolean; invalidResultDirectory?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'hydrology-harness-'))
  const ctx = new Context()
  ctx.baseUrl = new URL('../../../', import.meta.url).href
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
  await ctx.plugin(ParentTasks, { retryDelayMs: 0 })
  if (options.spill) {
    await ctx.plugin(LocalSpillStore, { root: join(root, 'spill'), cleanupPeriodDays: 0 })
    await ctx.plugin(SpillPolicy, { maxInlineTokens: 12500 })
  }
  const patch = await readBundlePatches()
  for (const row of patch.flatMap(item => item.insert ?? []).filter(row => row.config?.id?.startsWith('hydrology-'))) {
    await ctx.plugin(AgentPreset, { ...row.config, plugins: row.config.plugins.map(entry => {
      if (entry.name === 'dsh-agent-hydrology-monitoring/tools') return { ...entry, name: new URL('../src/tools/index.ts', import.meta.url).href }
      if (entry.name === 'dsh-agent-hydrology-monitoring/query-child') return { ...entry, name: new URL('../src/agents/query-child/index.ts', import.meta.url).href, config: { cubeUrl, maxAgentIterations: iterations } }
      return entry
    }) })
  }
  const create = (id: string, preset = 'hydrology-monitoring') => ctx.agents.create({ sessionId: SessionId(id), meta: { agentPreset: preset }, agentOptions: { provider: 'recorded-hydrology', model: 'fixture' },
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
    await agent.whenIdle(); await h.ctx.hydrologyParentTasks.whenIdle(agent.id); await agent.whenIdle()
    const events = agent.session.ownEvents()
    const calls = events.filter(event => event.type === 'tool/call')
    assert.deepEqual(calls.map(event => event.data.name), ['skill', 'query_hydrology', 'get_hydrology_query_result', 'publish_hydrology_report'])
    const results = events.filter(event => event.type === 'tool/result')
    assert.ok(results.every(event => !event.data.message.isError), JSON.stringify(results))
    const children = await h.ctx.subagents.listChildren(agent.id)
    assert.equal(children.length, 'failModel' in options ? 2 : 1)
    using child = await h.ctx.sessionQuery.observeSession(children[0].id)
    assert.equal(child.header.agentPreset, 'hydrology-query')
    assert.equal(child.header.parentSession, agent.id)
    assert.ok(!events.some(event => event.type === 'user/message' && event.data.source.kind === 'subagent-settled'))
    assert.equal(events.filter(event => event.type === 'user/message' && event.data.source.kind === 'hydrology-task-ready').length, 1)
    const publication = events.map(taskRecord).find(record => record?.kind === 'published')
    assert.ok(publication)
    const task = publication.task
    assert.equal(task.phase, 'published')
    const outcome = 'empty' in options ? 'no_data' : 'status' in options ? 'error' : 'success'
    assert.equal(task.queries.history.status, outcome)
    assert.equal(task.charts.filter(item => item.status === 'rendered').length, outcome === 'success' ? 2 : 0)
    assert.match(task.markdown!, /^# 主斜井水位监测分析\n/)
    assert.match(task.markdown!, /## 历史变化[\s\S]*## 综合结论/)
    assert.equal(h.ctx.hydrologyParentTasks.status(agent, task.id).report_id, task.report_id)
    assert.deepEqual(JSON.parse(JSON.stringify(events)), events)
    const other = await h.create('other')
    other.agent.session.append('turn/start', { turn: 1 })
    const denied = await h.ctx.tools.execute({ callId: ToolCallId('foreign'), name: 'get_hydrology_query_result', arguments: { task_id: task.id }, agent: other.agent, signal: new AbortController().signal })
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

test('服务解析真实上游字段后执行依赖，父会话的原始查询和绘图入口均不可绕过', async () => {
  const fixture = await startCubeFixture()
  const h = await harness(fixture.url)
  try {
    h.ctx.llm.registerAdapter(['recorded-hydrology'], new HydrologyAdapter())
    const parent = await h.create('dependency-parent')
    h.ctx.on('agent/pre-step', ({ agent }, next) => agent.id === parent.agent.id ? Promise.resolve({ kind: 'reject' as const }) : next())
    parent.agent.session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '按上游结果查询实时状态' }] }), { surfaceOp: 'append' })
    const plan = hydrologyPlan(true)
    plan.queries[1].depends_on = ['history']
    plan.queries[1].inputs = [{ query_id: 'history', columns: [`${HISTORY}.point_name_code`] }]
    const result = await h.ctx.tools.execute({ callId: ToolCallId('plan'), name: 'query_hydrology', arguments: { plan }, agent: parent.agent, signal: new AbortController().signal })
    assert.ok(!result.isError, JSON.stringify(result))
    await h.ctx.hydrologyParentTasks.whenIdle(parent.agent.id); await parent.agent.whenIdle()
    const task = parent.agent.session.ownEvents().map(taskRecord).filter(Boolean).at(-1)!.task
    assert.equal(task.phase, 'composing')
    assert.equal(task.queries.realtime.status, 'success')
    const attempt = task.queries.realtime.attempts[0]
    assert.match(attempt.prompt, /已验证的依赖输入/)
    assert.match(attempt.prompt, /主斜井水位（P1）/)
    using child = await h.ctx.sessionQuery.observeSession(SessionId(attempt.child_id))
    assert.ok(child.events.some(event => event.type === 'user/message' && JSON.stringify(event.data.content).includes('已验证的依赖输入')))
    assert.ok(!h.ctx.tools.schemas(parent.agent).some(tool => ['render_line_chart', 'run_semantic_query', 'subagent'].includes(tool.name)))
    await parent.dispose()
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
      const read = await readQueryResult(h.ctx, parent.agent.id, activation.childId, new AbortController().signal)
      assert.equal(read.receipt, undefined)
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
    await parent.agent.whenIdle(); await h.ctx.hydrologyParentTasks.whenIdle(parent.agent.id); await parent.agent.whenIdle()
    const events = parent.agent.session.ownEvents()
    assert.ok(events.filter(event => event.type === 'tool/result').every(event => !event.data.message.isError))
    const task = events.map(taskRecord).find(record => record?.kind === 'published')!.task
    assert.equal(task.phase, 'published')
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
    const readEvent = events.find(event => event.type === 'tool/result' && event.data.message.content.some(block => block.type === 'text' && block.text.includes('"phase":"composing"')))
    assert.ok(readEvent?.type === 'tool/result')
    const displayed = JSON.parse(readEvent.data.message.content.filter(block => block.type === 'text').map(block => block.text).join(''))
    const details = displayed.queries[0].result.tables[0]
    assert.equal(details.rows.length, Math.min(rowCount, 50))
    assert.deepEqual(details.rows.map((row: Record<string, string>) => row['监测时间']), record.rows.slice(0, 50).map(row => row[`${HISTORY}.observed_at`]))
    const chart = task.charts.find(item => item.status === 'rendered')!.chart!
    const series = chart.option!.series as { data: unknown[] }[]
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
    await parent.agent.whenIdle(); await h.ctx.hydrologyParentTasks.whenIdle(parent.agent.id); await parent.agent.whenIdle()
    const results = parent.agent.session.ownEvents().filter(event => event.type === 'tool/result')
    assert.ok(results.some(event => JSON.stringify(event.data.message.content).includes('error')))
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

async function manualParent(h: Awaited<ReturnType<typeof harness>>, id: string) {
  const handle = await h.create(id)
  h.ctx.on('agent/pre-step', ({ agent }, next) => agent.id === handle.agent.id ? Promise.resolve({ kind: 'reject' as const }) : next())
  handle.agent.session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '执行水文任务' }] }), { surfaceOp: 'append' })
  return handle
}
const latestTask = (agent: import('@deepseek-ai/dsh-agent').Agent) =>
  agent.session.ownEvents().map(taskRecord).filter(record => record !== undefined).at(-1)!.task
const runParentTool = (h: Awaited<ReturnType<typeof harness>>, agent: import('@deepseek-ai/dsh-agent').Agent, name: string, args: object) =>
  h.ctx.tools.execute({ callId: ToolCallId(randomUUID()), name, arguments: args, agent, signal: new AbortController().signal })

for (const rejected of [false, true]) test(`父计划工具最终${rejected ? '拒绝' : '取消'}时不创建任务或子会话`, async () => {
  const fixture = await startCubeFixture()
  const h = await harness(fixture.url)
  try {
    const parent = await manualParent(h, 'unaccepted-parent')
    const controller = new AbortController()
    h.ctx.on('tools/post-execute', async (exec, result, next) => {
      if (exec.name !== 'query_hydrology') return next()
      if (!rejected) { controller.abort(); return next() }
      return { kind: 'block', feedback: [{ type: 'text', text: '拒绝提交' }] }
    })
    const result = await h.ctx.tools.execute({ callId: ToolCallId('unaccepted'), name: 'query_hydrology', arguments: { plan: hydrologyPlan() }, agent: parent.agent, signal: controller.signal })
    assert.equal(result.isError, true)
    assert.equal(parent.agent.session.ownEvents().map(taskRecord).filter(Boolean).length, 0)
    assert.equal((await h.ctx.subagents.listChildren(parent.agent.id)).length, 0)
    assert.equal(fixture.requests.length, 0)
    await parent.dispose()
  } finally { await h.close(); await fixture.close() }
})

test('重复计划幂等、并发受限、成文前不能发布，失败依赖跳过', async () => {
  const fixture = await startCubeFixture({ delay: 15, failModel: REALTIME })
  const h = await harness(fixture.url)
  try {
    h.ctx.llm.registerAdapter(['recorded-hydrology'], new HydrologyAdapter())
    const parent = await manualParent(h, 'scheduler-parent')
    const plan = hydrologyPlan()
    plan.queries = Array.from({ length: 6 }, (_, index) => ({ id: `q${index}`, prompt: index === 0 ? '查询实时状态' : '查询历史', depends_on: [], inputs: [] }))
    plan.queries.push({ id: 'dependent', prompt: '查询历史', depends_on: ['q0'], inputs: [] })
    plan.queries.unshift({ id: 'downstream', prompt: '查询历史', depends_on: ['dependent'], inputs: [] })
    plan.charts = []
    const [first, repeat] = await Promise.all([runParentTool(h, parent.agent, 'query_hydrology', { plan }), runParentTool(h, parent.agent, 'query_hydrology', { plan })])
    assert.ok(!first.isError && !repeat.isError)
    assert.deepEqual(first.value, repeat.value)
    const taskId = latestTask(parent.agent).id
    const early = await runParentTool(h, parent.agent, 'publish_hydrology_report', { task_id: taskId, markdown: '# 主斜井水位监测分析' })
    assert.equal(early.isError, true)
    const different = await runParentTool(h, parent.agent, 'query_hydrology', { plan: { ...plan, title: '另一计划' } })
    assert.equal(different.isError, true)
    await h.ctx.hydrologyParentTasks.whenIdle(parent.agent.id); await parent.agent.whenIdle()
    const task = latestTask(parent.agent)
    assert.equal((await h.ctx.subagents.listChildren(parent.agent.id)).length, 6)
    assert.equal(task.queries.dependent.status, 'skipped')
    assert.equal(task.queries.downstream.status, 'skipped')
    assert.equal(task.phase, 'composing')
    const states = parent.agent.session.ownEvents().map(taskRecord).filter(record => record !== undefined).map(record => record.task)
    assert.ok(states.every(state => Object.values(state.queries).filter(query => query.status === 'running').length <= 3))
    assert.equal(states.filter(state => state.wake).at(-1)!.report_id, task.report_id)
    assert.equal(parent.agent.session.ownEvents().map(taskRecord).filter(record => record?.kind === 'accepted').length, 1)
    await parent.dispose()
  } finally { await h.close(); await fixture.close() }
})

for (const failLoads of [1, 5]) test(`瞬时5xx仅追加一次尝试：${failLoads}`, async () => {
  const fixture = await startCubeFixture({ failLoads })
  const h = await harness(fixture.url)
  try {
    h.ctx.llm.registerAdapter(['recorded-hydrology'], new HydrologyAdapter())
    const parent = await manualParent(h, 'retry-parent')
    assert.ok(!(await runParentTool(h, parent.agent, 'query_hydrology', { plan: hydrologyPlan() })).isError)
    await h.ctx.hydrologyParentTasks.whenIdle(parent.agent.id); await parent.agent.whenIdle()
    const task = latestTask(parent.agent)
    assert.equal(task.queries.history.attempts.length, 2)
    assert.equal(task.queries.history.status, failLoads === 1 ? 'success' : 'error')
    assert.equal(fixture.requests.filter(request => request.path === 'load').length, 2)
    assert.equal(parent.agent.session.ownEvents().filter(event => event.type === 'agent/inbox/spliced' && event.data.inserted.some(message => message.source.kind === 'hydrology-task-ready')).length, 1)
    await parent.dispose()
  } finally { await h.close(); await fixture.close() }
})

test('发布校验、重复发布幂等、晚到通知和恢复均不替换报告或重新取数', async () => {
  const fixture = await startCubeFixture()
  const h = await harness(fixture.url)
  try {
    h.ctx.llm.registerAdapter(['recorded-hydrology'], new HydrologyAdapter())
    const parent = await h.create('publication-parent')
    parent.agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '分析主斜井水位历史情况' }] }))
    await parent.agent.whenIdle(); await h.ctx.hydrologyParentTasks.whenIdle(parent.agent.id); await parent.agent.whenIdle()
    const task = latestTask(parent.agent)
    assert.equal(task.phase, 'published')
    const before = fixture.requests.length
    assert.ok(!(await runParentTool(h, parent.agent, 'publish_hydrology_report', { task_id: task.id, markdown: task.markdown })).isError)
    assert.equal((await runParentTool(h, parent.agent, 'publish_hydrology_report', { task_id: task.id, markdown: task.markdown + '\n改写' })).isError, true)
    parent.agent.followup(createUserMessage({ source: { kind: 'subagent-settled', form: 'notice', summary: '迟到状态通知', senderSessionId: SessionId('unrelated') }, content: [{ type: 'text', text: '之前任务的完成状态' }] }))
    await parent.agent.whenIdle()
    assert.equal(latestTask(parent.agent).report_id, task.report_id)
    assert.equal(latestTask(parent.agent).markdown, task.markdown)
    assert.equal(parent.agent.session.ownEvents().map(taskRecord).filter(record => record?.kind === 'published').length, 1)
    await parent.dispose()
    const resumed = await h.ctx.agents.resume({ resumeSessionId: parent.agent.id, agentOptions: { provider: 'recorded-hydrology', model: 'fixture' }, setup: async ctx => { await h.ctx.agentPresets.mount(ctx, 'hydrology-monitoring') } })
    await h.ctx.hydrologyParentTasks.whenIdle(resumed.agent.id)
    assert.equal(latestTask(resumed.agent).markdown, task.markdown)
    assert.equal(fixture.requests.length, before)
    await resumed.dispose()
  } finally { await h.close(); await fixture.close() }
})

test('取消在途任务后迟到结果不推进阶段，取消不会自动恢复', async () => {
  const fixture = await startCubeFixture({ delay: 50 })
  const h = await harness(fixture.url)
  try {
    h.ctx.llm.registerAdapter(['recorded-hydrology'], new HydrologyAdapter())
    const parent = await manualParent(h, 'cancel-parent')
    assert.ok(!(await runParentTool(h, parent.agent, 'query_hydrology', { plan: hydrologyPlan() })).isError)
    const taskId = latestTask(parent.agent).id
    assert.ok(!(await runParentTool(h, parent.agent, 'cancel_hydrology_task', { task_id: taskId })).isError)
    await h.ctx.hydrologyParentTasks.whenIdle(parent.agent.id)
    assert.equal(latestTask(parent.agent).phase, 'cancelled')
    assert.ok(Object.values(latestTask(parent.agent).queries).every(query => query.status !== 'pending' && query.status !== 'running'))
    assert.ok(!parent.agent.session.ownEvents().some(event => event.type === 'user/message' && event.data.source.kind === 'hydrology-task-ready'))
    const before = fixture.requests.length
    h.ctx.hydrologyParentTasks.recover(parent.agent)
    await h.ctx.hydrologyParentTasks.whenIdle(parent.agent.id)
    assert.equal(fixture.requests.length, before)
    await parent.dispose()
  } finally { await h.close(); await fixture.close() }
})

for (const gap of ['reserved', 'result-committed', 'transient-result'] as const) test(`恢复核对 ${gap} 窗口，不重复已提交查询并保留预留身份`, async () => {
  const fixture = await startCubeFixture({ failLoads: gap === 'transient-result' ? 1 : 0 })
  const h = await harness(fixture.url)
  try {
    h.ctx.llm.registerAdapter(['recorded-hydrology'], new HydrologyAdapter())
    const parent = await manualParent(h, 'recovery-parent')
    const reservedId = randomUUID()
    if (gap === 'result-committed') {
      assert.ok(!(await runParentTool(h, parent.agent, 'query_hydrology', { plan: hydrologyPlan() })).isError)
      await h.ctx.hydrologyParentTasks.whenIdle(parent.agent.id); await parent.agent.whenIdle()
      const snapshot = structuredClone(latestTask(parent.agent))
      snapshot.phase = 'querying'; snapshot.charts = []; delete snapshot.wake
      snapshot.queries.history.status = 'running'
      snapshot.queries.history.attempts[0].status = 'running'
      delete snapshot.queries.history.attempts[0].receipt
      appendPluginRecord(parent.agent.session, TASK_RECORD, { version: 1, kind: 'attempt-running', task: snapshot })
    } else {
      if (gap === 'transient-result') {
        const activation = await h.ctx.subagents.startActivation({ provider: 'spawn', childId: SessionId(reservedId), label: 'history', delivery: 'caller', signal: new AbortController().signal,
          request: { parent: parent.agent, agentPreset: 'hydrology-query', prompt: [{ type: 'text', text: hydrologyPlan().queries[0].prompt }] } })
        await activation.result; await activation.dispose()
      }
      const origin = parent.agent.session.ownEvents().find(event => event.type === 'user/message')!
      assert.ok(origin.type === 'user/message')
      appendPluginRecord(parent.agent.session, TASK_RECORD, { version: 1, kind: 'attempt-reserved', task: {
        id: randomUUID(), parent_id: parent.agent.id, report_id: randomUUID(), origin_message_id: origin.data.id,
        plan: hydrologyPlan(), phase: 'querying', charts: [], queries: { history: { status: 'running', attempts: [
          { child_id: reservedId, number: 1, prompt: hydrologyPlan().queries[0].prompt, status: gap === 'reserved' ? 'reserved' : 'running' },
        ] } },
      } })
    }
    const before = fixture.requests.length
    await parent.dispose()
    const resumed = await h.ctx.agents.resume({ resumeSessionId: parent.agent.id, agentOptions: { provider: 'recorded-hydrology', model: 'fixture' }, setup: async ctx => { await h.ctx.agentPresets.mount(ctx, 'hydrology-monitoring') } })
    await h.ctx.hydrologyParentTasks.whenIdle(resumed.agent.id); await resumed.agent.whenIdle()
    const task = latestTask(resumed.agent)
    assert.equal(task.phase, 'composing')
    assert.equal(task.queries.history.status, 'success')
    assert.equal(task.queries.history.attempts.length, gap === 'transient-result' ? 2 : 1)
    if (gap === 'result-committed') assert.equal(fixture.requests.length, before)
    else assert.equal(task.queries.history.attempts[0].child_id, reservedId)
    await resumed.dispose()
  } finally { await h.close(); await fixture.close() }
})

test('恢复发现已提交结果文件缺失时阻塞，不重新查询或发布', async () => {
  const fixture = await startCubeFixture()
  const h = await harness(fixture.url)
  try {
    h.ctx.llm.registerAdapter(['recorded-hydrology'], new HydrologyAdapter())
    const parent = await manualParent(h, 'missing-result-parent')
    assert.ok(!(await runParentTool(h, parent.agent, 'query_hydrology', { plan: hydrologyPlan() })).isError)
    await h.ctx.hydrologyParentTasks.whenIdle(parent.agent.id); await parent.agent.whenIdle()
    const task = latestTask(parent.agent), attempt = task.queries.history.attempts[0]
    await rm(join(h.ctx.hydrologyQueryResults.directory, createHash('sha256').update(attempt.child_id).digest('hex'), `${attempt.receipt!.result_ref!.id}.json`))
    const before = fixture.requests.length
    await parent.dispose()
    const resumed = await h.ctx.agents.resume({ resumeSessionId: parent.agent.id, agentOptions: { provider: 'recorded-hydrology', model: 'fixture' }, setup: async ctx => { await h.ctx.agentPresets.mount(ctx, 'hydrology-monitoring') } })
    await h.ctx.hydrologyParentTasks.whenIdle(resumed.agent.id)
    assert.equal(latestTask(resumed.agent).phase, 'blocked')
    assert.match(latestTask(resumed.agent).problem!, /文件不可用/)
    assert.equal(fixture.requests.length, before)
    assert.equal((await runParentTool(h, resumed.agent, 'publish_hydrology_report', { task_id: task.id, markdown: '# 不完整报告' })).isError, true)
    await resumed.dispose()
  } finally { await h.close(); await fixture.close() }
})

for (const rejected of [false, true]) test(`发布工具最终${rejected ? '拒绝' : '取消'}时不生成报告节点`, async () => {
  const fixture = await startCubeFixture()
  const h = await harness(fixture.url)
  try {
    h.ctx.llm.registerAdapter(['recorded-hydrology'], new HydrologyAdapter())
    const parent = await manualParent(h, 'unaccepted-report-parent')
    const plan = hydrologyPlan(); plan.charts = []
    assert.ok(!(await runParentTool(h, parent.agent, 'query_hydrology', { plan })).isError)
    await h.ctx.hydrologyParentTasks.whenIdle(parent.agent.id); await parent.agent.whenIdle()
    const task = latestTask(parent.agent), controller = new AbortController()
    h.ctx.on('tools/post-execute', async (exec, _result, next) => {
      if (exec.name !== 'publish_hydrology_report') return next()
      if (!rejected) { controller.abort(); return next() }
      return { kind: 'block', feedback: [{ type: 'text', text: '拒绝发布' }] }
    })
    const result = await h.ctx.tools.execute({ callId: ToolCallId('unaccepted-report'), name: 'publish_hydrology_report',
      arguments: { task_id: task.id, markdown: '# 主斜井水位监测分析\n\n## 历史变化\n\n历史数据已取得。\n\n## 综合结论\n\n依据实际记录。' }, agent: parent.agent, signal: controller.signal })
    assert.equal(result.isError, true)
    assert.equal(latestTask(parent.agent).phase, 'composing')
    assert.equal(parent.agent.session.ownEvents().map(taskRecord).filter(record => record?.kind === 'published').length, 0)
    await parent.dispose()
  } finally { await h.close(); await fixture.close() }
})

test('父会话释放收敛在途查询，恢复时仅重试确认中断的尝试', { timeout: 10000 }, async () => {
  let releaseResponse!: () => void
  const responseGate = new Promise<void>(resolve => { releaseResponse = resolve })
  const fixture = await startCubeFixture({ responseGate })
  const h = await harness(fixture.url)
  try {
    h.ctx.llm.registerAdapter(['recorded-hydrology'], new HydrologyAdapter())
    const parent = await manualParent(h, 'interrupted-parent')
    assert.ok(!(await runParentTool(h, parent.agent, 'query_hydrology', { plan: hydrologyPlan() })).isError)
    for (let index = 0; index < 100 && fixture.requests.length === 0; index++) await new Promise(resolve => setTimeout(resolve, 2))
    assert.ok(fixture.requests.length > 0)
    await parent.dispose()
    delete fixture.options.responseGate
    releaseResponse()
    const resumed = await h.ctx.agents.resume({ resumeSessionId: parent.agent.id, agentOptions: { provider: 'recorded-hydrology', model: 'fixture' }, setup: async ctx => { await h.ctx.agentPresets.mount(ctx, 'hydrology-monitoring') } })
    await h.ctx.hydrologyParentTasks.whenIdle(resumed.agent.id); await resumed.agent.whenIdle()
    const task = latestTask(resumed.agent)
    assert.equal(task.phase, 'composing')
    assert.equal(task.queries.history.status, 'success')
    assert.equal(task.queries.history.attempts.length, 2)
    assert.equal(task.queries.history.attempts[0].status, 'interrupted')
    await resumed.dispose()
  } finally { releaseResponse(); await h.close(); await fixture.close() }
})
