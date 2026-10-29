/** 父任务的版本化 Session 记录及 Host/Client 共用校验。 */
import { z } from 'zod'
import type { ChartResult } from 'dsh-agent-charts'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import { MessageId } from '@deepseek-ai/dsh-llm/brand'

const id = z.string().min(1)
const inputSchema = z.object({ query_id: id, columns: z.array(id).min(1) }).strict()
export const planSchema = z.object({
  title: id,
  queries: z.array(z.object({ id, prompt: id, depends_on: z.array(id).default([]), inputs: z.array(inputSchema).default([]) }).strict()).min(1),
  charts: z.array(z.object({
    id, query_id: id, dataset: id,
    type: z.enum(['line', 'bar', 'pie', 'scatter', 'stacked_bar']), title: id,
    x_field: id, value_field: id, series_field: id.optional(),
  }).strict()),
  report: z.object({ title: id, sections: z.array(id).min(1) }).strict(),
}).strict()
export type TaskPlan = z.infer<typeof planSchema>

const errorSchema = z.object({ stage: id, code: id, message: id, retryable: z.boolean() }).strict()
const refSchema = z.object({ id: z.uuid(), bytes: z.number().int().positive(), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict()
const receiptSchema = z.object({
  version: z.literal(2), outcome: z.enum(['success', 'no_data', 'error']), terminal: z.literal(true),
  query_goal: z.string(), row_count: z.number().int().nonnegative(), error: errorSchema.optional(), result_ref: refSchema.optional(),
}).strict()
const attemptSchema = z.object({
  child_id: id, number: z.number().int().positive(), prompt: id,
  status: z.enum(['reserved', 'running', 'settled', 'interrupted']),
  receipt: receiptSchema.optional(), error: errorSchema.optional(),
}).strict()
export type TaskAttempt = z.infer<typeof attemptSchema>
export const chartSchema = z.object({
  chart_id: id, chart_type: z.enum(['line', 'bar', 'pie', 'stacked_bar', 'scatter']),
  title: id, source_id: id, dataset_id: id, status: z.enum(['rendered', 'no_data']),
  summary: z.string(), option: z.record(z.string(), z.json()).optional(),
}).strict() satisfies z.ZodType<ChartResult>
const phaseSchema = z.enum(['querying', 'charting', 'composing', 'published', 'cancelled', 'blocked'])
export const taskSchema = z.object({
  id, parent_id: id, report_id: id, origin_message_id: id, plan: planSchema,
  phase: phaseSchema, problem: z.string().optional(),
  queries: z.record(z.string(), z.object({
    status: z.enum(['pending', 'running', 'success', 'no_data', 'error', 'skipped']),
    attempts: z.array(attemptSchema), reason: z.string().optional(),
  }).strict()),
  charts: z.array(z.object({ intent_id: id, status: z.enum(['rendered', 'no_data', 'error', 'skipped']), summary: z.string(), chart: chartSchema.optional() }).strict()),
  markdown: z.string().optional(),
  wake: z.object({ message: z.json(), consumed: z.boolean() }).strict().optional(),
}).strict()
export type ParentTask = z.infer<typeof taskSchema>
export type TaskPhase = ParentTask['phase']
export const taskRecordSchema = z.object({
  version: z.literal(1),
  kind: z.enum(['accepted', 'attempt-reserved', 'attempt-running', 'attempt-settled', 'query-skipped', 'chart-settled', 'phase-changed', 'wake-prepared', 'cancelled', 'published']),
  task: taskSchema,
}).strict()
export type TaskRecord = z.infer<typeof taskRecordSchema>
export const TASK_RECORD = 'plugin:dsh-agent-scenarios/parent-task' as const

declare module '@deepseek-ai/dsh-session' {
  interface PluginRecordMap { 'plugin:dsh-agent-scenarios/parent-task': TaskRecord }
}
declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'hydrology-task-ready': { kind: 'hydrology-task-ready'; taskId: string; reportId: string }
  }
}

/** 只处理本插件记录；未来版本或损坏的记录明确失败。 */
export function taskRecord(event: { type: string; data: unknown; ignorable?: true }): TaskRecord | undefined {
  if (event.type !== TASK_RECORD) return undefined
  if (event.ignorable !== true) throw new Error('水文父任务记录缺少 ignorable 标记。')
  return taskRecordSchema.parse(event.data)
}

/** 校验静态依赖及字段绑定，拒绝重复身份和依赖环。 */
export function parsePlan(value: unknown): TaskPlan {
  const plan = planSchema.parse(value)
  const unique = (values: string[], label: string) => {
    if (new Set(values).size !== values.length) throw new Error(`${label}不能重复。`)
  }
  unique(plan.queries.map(query => query.id), '查询ID')
  unique(plan.charts.map(chart => chart.id), '图表意图ID')
  unique(plan.report.sections, '报告章节')
  const queries = new Map(plan.queries.map(query => [query.id, query]))
  const visiting = new Set<string>(), visited = new Set<string>()
  const visit = (queryId: string): void => {
    if (visiting.has(queryId)) throw new Error('查询依赖不能成环。')
    if (visited.has(queryId)) return
    const query = queries.get(queryId)
    if (!query) throw new Error(`依赖查询不存在：${queryId}`)
    visiting.add(queryId)
    unique(query.depends_on, '依赖ID')
    for (const dependency of query.depends_on) visit(dependency)
    for (const input of query.inputs) {
      if (!query.depends_on.includes(input.query_id)) throw new Error('输入绑定必须指向已声明的依赖。')
      unique(input.columns, '输入字段')
    }
    visiting.delete(queryId); visited.add(queryId)
  }
  for (const query of plan.queries) visit(query.id)
  for (const chart of plan.charts) if (!queries.has(chart.query_id)) throw new Error(`图表引用了不存在的查询：${chart.query_id}`)
  return plan
}

/** 用于恢复通知的已标识消息；在持久化边界验证后恢复品牌类型。 */
export function wakeMessage(task: ParentTask): UserMessage | undefined {
  if (!task.wake) return undefined
  const value = task.wake.message
  const parsed = z.object({ id, role: z.literal('user'), content: z.array(z.object({ type: z.literal('text'), text: z.string() })),
    source: z.object({ kind: z.literal('hydrology-task-ready'), taskId: id, reportId: id }) }).strict().parse(value)
  return { ...parsed, id: MessageId(parsed.id) }
}
