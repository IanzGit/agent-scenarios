/** 真实业务接口的可选冒烟，不调用模型、不写入业务系统。 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import * as plugin from 'dsh-agent-water-hazard'
import { TOOL_NAMES } from '../../packages/water-hazard/src/tools/index.ts'

test('五个工具通过真实接口与原生校验，返回 Markdown 表格', { timeout: 180000 }, async () => {
  const ctx = new Context()
  try {
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(SkillRegistry)
    await ctx.plugin(plugin)
    for (const name of TOOL_NAMES) {
      const executed = await ctx.tools.execute({ name, callId: ToolCallId(name), arguments: {}, signal: AbortSignal.timeout(120000) })
      assert.equal(executed.isError, false, JSON.stringify(executed.content))
      assert.equal(executed.meta, undefined)
      const content = executed.content.filter(block => block.type === 'text').map(block => block.text).join('')
      assert.match(content, /\| .+ \|/)
      console.log(`${name}: ${content.split('\n')[0]}`)
    }
  } finally { await ctx.fiber.dispose() }
})
