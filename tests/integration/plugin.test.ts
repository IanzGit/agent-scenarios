import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { parse } from 'yaml'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import LlmRuntime, { createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import Sessions, { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import PresetRegistry, { type PresetDefinition } from '@deepseek-ai/dsh-agent-preset-registry'
import AgentPreset from '@deepseek-ai/dsh-agent-preset'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import WorkingDirectory from '@deepseek-ai/dsh-working-directory'
import * as plugin from '../../src/index.ts'
import { TOOL_NAMES } from '../../src/scenarios/water-hazard/tools.ts'
import { startFixtureServer } from '../fixtures/server.ts'
import { RecordedAdapter, recordings } from '../fixtures/recorded-model.ts'

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
  return ctx
}

async function declareWaterHazard(ctx: Context, apiBaseUrl: string) {
  const patch: { insert?: { id: string; config: PresetDefinition }[] }[] = parse(await readFile(new URL('../../cordis.patch.yml', import.meta.url), 'utf8'))
  const row = patch.flatMap(item => item.insert ?? []).find(item => item.id === 'preset-water-hazard')
  assert.ok(row)
  return ctx.plugin(AgentPreset, {
    ...row.config,
    plugins: row.config.plugins.map(entry => entry.name === 'dsh-agent-scenarios/water-hazard'
      ? { ...entry, name: new URL('../../src/scenarios/water-hazard/index.ts', import.meta.url).href, config: { apiBaseUrl } }
      : entry),
  })
}

async function agentOn(ctx: Context, id: string, preset = 'water-hazard') {
  return ctx.agents.create({
    sessionId: SessionId(id), agentOptions: { provider: 'recorded', model: 'fixture' },
    setup: async agentCtx => { await ctx.agentPresets.mount(agentCtx, preset) },
  })
}

test('根入口、参数校验、完整 Markdown 结果和插件卸载均通过原生管线', async () => {
  const fixture = await startFixtureServer()
  const ctx = await harness()
  try {
    const fiber = ctx.plugin(plugin, { apiBaseUrl: fixture.url })
    await fiber
    assert.deepEqual(ctx.tools.schemas().map(tool => tool.name), [...TOOL_NAMES])
    assert.deepEqual((await ctx.skills.list()).map(skill => skill.name), ['water-hazard-overview', 'water-hazard-trend'])
    const invalid = await ctx.tools.execute({ callId: ToolCallId('invalid'), name: 'get_hydrological_trend', arguments: { start_time: 123 }, signal: new AbortController().signal })
    assert.equal(invalid.isError, true)
    assert.equal(fixture.requests.length, 0)
    for (const name of TOOL_NAMES) {
      const executed = await ctx.tools.execute({ callId: ToolCallId(name), name, arguments: {}, signal: new AbortController().signal })
      assert.equal(executed.isError, false, name)
      assert.equal(executed.meta, undefined)
      const content = executed.content.filter(block => block.type === 'text').map(block => block.text).join('')
      assert.match(content, /\| .+ \|/)
      assert.equal(content.includes('series'), false)
      assert.equal(content.includes('1.234567'), false)
    }
    await fiber.dispose()
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
    assert.deepEqual(ctx.tools.schemas(water).map(tool => tool.name), [...TOOL_NAMES, 'skill'])
    assert.deepEqual((await ctx.skills.list({ scope: water })).map(skill => skill.name), ['water-hazard-overview', 'water-hazard-trend'])
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

for (const scenario of ['overview', 'trend']) test(`固定模型响应驱动 ${scenario}，默认会话内容保存 Markdown 而无展示元数据`, async () => {
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
    assert.ok(results.every(event => !event.data.message.isError && event.data.meta === undefined))
    const tableResults = results.filter(event => event.data.message.content.some(block => block.type === 'text' && block.text.includes('| --- |')))
    assert.equal(tableResults.length, scenario === 'trend' ? 1 : 4)
    assert.equal(adapter.requests.length, recordings[scenario].length)
    assert.ok(events.some(event => event.type === 'turn/end'))
    assert.deepEqual(JSON.parse(JSON.stringify(tableResults)), tableResults)
    await handle.dispose()
  } finally { await ctx.fiber.dispose(); await fixture.close() }
})
