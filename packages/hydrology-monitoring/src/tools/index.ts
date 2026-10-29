/** 水文主智能体只提交计划、读取父任务及发布报告，不直接派发子查询。 */
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import * as filesystemSkills from '@deepseek-ai/dsh-skill-filesystem'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { InferValue } from '@deepseek-ai/dsh-tools'
import { z } from 'zod'
import type {} from '../application/parent-tasks.ts'
import type { ParentTask } from '../domain/task-protocol.ts'

export const name = 'hydrology-monitoring'
export const inject = ['tools', 'skills', 'hydrologyParentTasks']
const string = { type: 'string' } as const
const strings = { type: 'array', items: string } as const
const plan = { type: 'object', additionalProperties: false, required: true, properties: {
  title: { ...string, required: true },
  queries: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
    id: { ...string, required: true }, prompt: { ...string, required: true }, depends_on: strings,
    inputs: { type: 'array', items: { type: 'object', additionalProperties: false, properties: {
      query_id: { ...string, required: true }, columns: { ...strings, required: true },
    } } },
  } } },
  charts: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
    id: { ...string, required: true }, query_id: { ...string, required: true }, dataset: { ...string, required: true, description: '实际数据集ID，或 history / realtime 数据集族；族按真实类型及单位分别绘图。' },
    type: { type: 'string', enum: ['line', 'bar', 'pie', 'scatter', 'stacked_bar'], required: true },
    title: { ...string, required: true }, x_field: { ...string, required: true }, value_field: { ...string, required: true }, series_field: string,
  } } },
  report: { type: 'object', required: true, additionalProperties: false, properties: {
    title: { ...string, required: true }, sections: { ...strings, required: true, description: '最终报告必须按顺序包含的二级章节标题。' },
  } },
} } as const
const output = { schema: { type: 'json' } as const,
  render: (_args: object, value: InferValue<{ type: 'json' }>) => [{ type: 'text' as const, text: JSON.stringify(value) }] }
const json = (value: object) => z.json().parse(JSON.parse(JSON.stringify(value)))
const reply = (task: ParentTask) => ({ task_id: task.id, report_id: task.report_id, phase: task.phase })

/** 工具管线最终接受后，父任务服务才提交持久化事实和执行副作用。 */
export function apply(ctx: Context): void {
  ctx.tools.presentAs('native')
  ctx.plugin(filesystemSkills, { providerName: 'hydrology-monitoring', includeDefaultRoots: false,
    customSkillDirs: [fileURLToPath(new URL('../../skills/', import.meta.url))] })
  ctx.tools.register(defineTool({
    name: 'query_hydrology', description: '提交一次完整水文业务计划。服务管理依赖、并发、查询重试及绘图；返回任务ID后等待集中就绪通知，不逐项派发或轮询。',
    parameters: { plan }, output,
    async execute(args, exec) { return json(reply(ctx.hydrologyParentTasks.submit(exec, args.plan))) },
  }))
  ctx.tools.register(defineTool({
    name: 'get_hydrology_query_result', description: '按父任务ID读取真实查询结果、失败或无数据状态、图表ID及固定报告章节；不重新查询。',
    parameters: { task_id: { ...string, required: true } }, output,
    async execute(args, exec) {
      if (!exec.agent) throw new Error('读取任务需要活动主会话。')
      const result = await ctx.hydrologyParentTasks.read(exec.agent, args.task_id, exec.signal)
      if (result.phase === 'querying' || result.phase === 'charting') exec.concludeTurn()
      return json(result)
    },
  }))
  ctx.tools.register(defineTool({
    name: 'publish_hydrology_report', description: '提交完整Markdown报告。必须包含计划标题、全部二级章节及全部成功图表的独立段落引用。服务校验后发布固定ID的独立报告，普通助手回复不算发布。',
    parameters: { task_id: { ...string, required: true }, markdown: { ...string, required: true } }, output,
    async execute(args, exec) { return json(reply(ctx.hydrologyParentTasks.publish(exec, args.task_id, args.markdown))) },
  }))
  ctx.tools.register(defineTool({
    name: 'cancel_hydrology_task', description: '仅在用户明确要求取消时终止未发布父任务及其在途查询。已发布报告不可取消或覆盖。',
    parameters: { task_id: { ...string, required: true } }, output,
    async execute(args, exec) { return json(reply(ctx.hydrologyParentTasks.cancel(exec, args.task_id))) },
  }))
}
