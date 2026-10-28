/** 水文监测查数 preset 的技能和结果读取插件。 */
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-query'
import type {} from '@deepseek-ai/dsh-subagent'
import * as filesystemSkills from '@deepseek-ai/dsh-skill-filesystem'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type {} from 'dsh-agent-charts'
import { chartResultSchema, renderChartResult, withChartSource } from '../../shared/chart-result.ts'
import { parseRecord, type QueryRecord } from './protocol.ts'
import { presentQuery } from './presentation.ts'

export const name = 'hydrology-monitoring'
export const inject = ['tools', 'skills', 'systemPrompt', 'chartSources', 'sessionQuery', 'subagents']

export function apply(ctx: Context): void {
  ctx.tools.presentAs('native')
  ctx.plugin(filesystemSkills, { providerName: 'hydrology-monitoring', includeDefaultRoots: false,
    customSkillDirs: [fileURLToPath(new URL('../../../skills/hydrology-monitoring/', import.meta.url))] })
  ctx.tools.register(defineTool({
    name: 'get_hydrology_query_result',
    description: '在收到查询子智能体完成通知后，读取其真实工具记录，返回全部查询表格、确定性统计和当前轮图表来源目录。只接受本会话直接创建的 hydrology-query 子会话；不重新取数。',
    parameters: { subagent_id: { type: 'string', required: true, description: 'query_hydrology 返回的 subagentId。' } },
    output: { schema: { ...chartResultSchema, properties: { ...chartResultSchema.properties,
      outcome: { type: 'string', enum: ['success', 'no_data', 'error'], required: true },
    } }, render: (args, value) => [{ type: 'text', text: `查询状态：${value.outcome}` }, ...renderChartResult(args, value)] },
    async execute(args, exec) {
      if (!exec.agent) throw new Error('结果读取需要活动主会话。')
      const id = SessionId(args.subagent_id)
      const children = await ctx.subagents.listChildren(exec.agent.id, exec.signal)
      if (!children.some(child => child.id === id)) throw new Error('只能读取本会话直接创建的查询子智能体。')
      using child = await ctx.sessionQuery.observeSession(id, { signal: exec.signal })
      if (child.header.parentSession !== exec.agent.id || child.header.agentPreset !== 'hydrology-query') throw new Error('子会话归属或查询 preset 不匹配。')
      const events = child.events.slice(Number(child.inheritedEventCount))
      const lastEnd = events.findLast(event => event.type === 'turn/end')
      const lastStart = events.findLast(event => event.type === 'turn/start')
      if (!lastEnd || !lastStart || lastEnd.seq < lastStart.seq) throw new Error('查询子智能体仍在运行，请等待完成通知，不要轮询。')
      if (lastEnd.type !== 'turn/end' || lastEnd.data.reason.kind !== 'completed') throw new Error('查询子智能体未正常完成，可能达到迭代上限、被取消或执行失败；不能使用其部分结果。')
      const calls = new Set(events.filter(event => event.type === 'tool/call' && ['run_semantic_query', 'search_semantic_catalog'].includes(event.data.name)).map(event => event.type === 'tool/call' ? event.data.callId : ''))
      let record: QueryRecord | undefined
      for (const event of events) {
        if (event.type !== 'tool/result' || event.data.message.isError || !calls.has(event.data.message.toolCallId)) continue
        const texts = event.data.message.content.filter(block => block.type === 'text')
        if (texts.length !== 1) continue
        const value: unknown = JSON.parse(texts[0].text)
        if (!value || typeof value !== 'object' || !('version' in value) || !('terminal' in value) || value.terminal !== true) continue
        if (record) throw new Error('一个查询子智能体包含多个最终结果，拒绝混用。')
        record = parseRecord(value)
      }
      if (!record) throw new Error('子智能体没有提交可用的最终查询记录。')
      const presented = presentQuery(record)
      const value = record.outcome === 'success' && presented.datasets.length
        ? withChartSource(presented.value, exec, ctx.chartSources, presented.datasets) : presented.value
      return { ...value, outcome: record.outcome }
    },
  }))
}
