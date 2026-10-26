import test from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import LlmRuntime, { createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import Sessions, { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import * as SkillTool from '@deepseek-ai/dsh-tool-skill'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import WorkingDirectory from '@deepseek-ai/dsh-working-directory'
import * as plugin from '../src/index.ts'
import { parseReport, TOOL_NAMES } from '../src/shared.ts'
import { startFixtureServer } from './fixture-server.ts'
import { RecordedAdapter, recordings } from './recorded-model.ts'

test('原生注册、参数校验、元数据和卸载均通过 Harness 管线', async () => {
  const fixture = await startFixtureServer()
  const ctx = new Context()
  try {
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(SkillRegistry)
    const fiber = ctx.plugin(plugin, { apiBaseUrl: fixture.url })
    await fiber
    assert.deepEqual(ctx.tools.schemas().map(tool => tool.name), [...TOOL_NAMES])
    assert.deepEqual((await ctx.skills.list()).map(skill => skill.name), ['water-hazard-overview', 'water-hazard-trend'])
    assert.match((await ctx.skills.get('water-hazard-trend'))?.content ?? '', /get_hydrological_trend/)
    const invalid = await ctx.tools.execute({ callId: ToolCallId('invalid'), name: 'get_hydrological_trend', arguments: { start_time: 123 }, signal: new AbortController().signal })
    assert.equal(invalid.isError, true)
    assert.equal(fixture.requests.length, 0)
    for (const name of TOOL_NAMES) {
      const executed = await ctx.tools.execute({ callId: ToolCallId(name), name, arguments: {}, signal: new AbortController().signal })
      assert.equal(executed.isError, false, name)
      assert.ok(parseReport(executed.meta), name)
      assert.equal(JSON.stringify(executed.content).includes('series'), false)
    }
    await fiber.dispose()
    assert.equal(ctx.tools.schemas().length, 0)
    assert.equal((await ctx.skills.list()).length, 0)
  } finally { await ctx.fiber.dispose(); await fixture.close() }
})

for (const scenario of ['overview', 'trend']) test(`固定模型响应驱动完整 ${scenario} 场景，并在日志中保留展示结果`, async () => {
  const fixture = await startFixtureServer()
  const ctx = new Context()
  try {
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
    await ctx.plugin(SkillTool)
    await ctx.plugin(plugin, { apiBaseUrl: fixture.url })
    const adapter = new RecordedAdapter()
    ctx.llm.registerAdapter(['recorded'], adapter)
    const agent = await ctx.agentLoop.create(SessionId(scenario), { provider: 'recorded', model: 'fixture' })
    const events: SessionEvent[] = []
    ctx.on('session/event', (session, event) => { if (session === agent.session) events.push(event) })
    agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: scenario === 'trend' ? '近30天关键水文指标的变化趋势' : '当前矿井总体水害监测预警情况汇总分析' }] }))
    await agent.whenIdle()
    const calls = events.filter(event => event.type === 'tool/call')
    assert.deepEqual(calls.map(event => event.data.name), recordings[scenario].filter(step => 'tool' in step).map(step => step.tool))
    const results = events.filter(event => event.type === 'tool/result')
    assert.ok(results.every(event => !event.data.message.isError))
    assert.equal(results.filter(event => parseReport(event.data.meta)).length, scenario === 'trend' ? 1 : 4)
    assert.equal(adapter.requests.length, recordings[scenario].length)
    assert.ok(events.some(event => event.type === 'turn/end'))
  } finally { await ctx.fiber.dispose(); await fixture.close() }
})
