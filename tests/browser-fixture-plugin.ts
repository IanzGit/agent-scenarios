/** 仅测试加载：固定模型响应和独立的空工作区。 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-workspace'
import { RecordedAdapter } from './recorded-model.ts'
import { appendFileSync } from 'node:fs'

export const inject = ['llm', 'workspaceRegistry']
export async function apply(ctx: Context, config: { workspacePath: string; tracePath: string; recordedModel?: boolean }): Promise<void> {
  if (config.recordedModel !== false) ctx.llm.registerAdapter(['water-hazard-fixture'], new RecordedAdapter())
  ctx.on('tools/result', (exec, result) => {
    const args = exec.arguments
    const skill = exec.name === 'skill' && typeof args === 'object' && args !== null && 'name' in args && typeof args.name === 'string' ? args.name : undefined
    appendFileSync(config.tracePath, `${JSON.stringify({ tool: exec.name, skill, isError: result.isError })}\n`)
    return undefined
  })
  await ctx.workspaceRegistry.create(config.workspacePath, '水害场景验证')
}
