/** 无密钥模型录制，驱动原生父子会话及最终图表引用。 */
import { LlmAdapter, ToolCallId, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { HISTORY, REALTIME, queryFor } from './hydrology.ts'
import type { TaskPlan } from '../../src/scenarios/hydrology-monitoring/task-protocol.ts'

export function hydrologyStep(messages: { role: string; text: string; name?: string }[], tools: string[]): { tool: string; args: Record<string, unknown> } | { text: string } {
  const observations = messages.filter(message => message.role === 'tool').map(message => message.text)
  if (tools.includes('run_semantic_query')) {
    const prompt = messages.find(message => message.role === 'user')?.text ?? ''
    const model = prompt.includes('实时') ? REALTIME : HISTORY
    if (!observations.length) return { tool: 'search_semantic_catalog', args: {} }
    if (observations.length === 1) return { tool: 'search_semantic_catalog', args: { model_names: [model] } }
    if (prompt.includes('纠错回归') && observations.length === 2) return { tool: 'run_semantic_query', args: { query_goal: prompt, semantic_query: {
      ...queryFor(model), filters: [{ [`${model}.point_name`]: ['主斜井水位'] }], time_dimensions: [{ dimension: `${model}.observed_at`, date_range: ['2025-09-01', '2025-09-07'] }],
    } } }
    return { tool: 'run_semantic_query', args: { query_goal: prompt, semantic_query: { ...queryFor(model),
      ...(prompt.includes('纠错回归') ? { filters: [{ member: `${model}.point_name`, operator: 'equals', values: ['主斜井水位'] }, { member: `${model}.value_type_id`, operator: 'equals', values: ['12001'] }, { member: `${model}.point_name`, operator: 'notEquals', values: ['排除测点'] }] } : {}),
      ...(model === HISTORY ? { time_dimensions: [{ dimension: `${model}.observed_at`, date_range: ['2025-09-01', '2025-09-07'] }], order: [{ member: `${model}.observed_at`, direction: 'asc' }] } : {}) } } }
  }
  const prompt = messages.find(message => message.role === 'user')?.text ?? ''
  const partial = prompt.includes('部分失败')
  if (!observations.length) return { tool: 'skill', args: { name: 'hydrology-single-point-recent' } }
  const values = observations.flatMap(text => {
    try { const value: unknown = JSON.parse(text); return value && typeof value === 'object' && 'task_id' in value ? [value as { task_id: string; phase: string; queries?: unknown[]; charts?: { status: string; chart_id?: string }[] }] : [] }
    catch { return [] }
  })
  const task = values.at(-1)
  if (task?.phase === 'published' || task?.phase === 'cancelled') return { text: '收到状态更新，已发布报告保持不变。' }
  if (!task) return { tool: 'query_hydrology', args: { plan: hydrologyPlan(partial) } }
  if (task.phase === 'composing' && task.queries) {
    const charts = task.charts?.filter(chart => chart.status === 'rendered').map(chart => `[图表:${chart.chart_id}]`).join('\n\n') ?? ''
    return { tool: 'publish_hydrology_report', args: { task_id: task.task_id, markdown: `# 主斜井水位监测分析\n\n## 历史变化\n\n${charts ? `历史采样与统计已取得，曲线按实际单位展示。\n\n${charts}` : '没有可展示的历史趋势；以查询状态说明为准。'}${partial ? '\n\n## 当前状态\n\n实时查询认证失败，保留已成功的历史分析，不据此判断运行正常。' : ''}\n\n## 综合结论\n\n${charts ? '历史观测以已取得的采样和统计为准，不据此判断当前运行状态。' : '本次缺少可用历史数据，不能据此判断趋势或运行状态。'}` } }
  }
  return { tool: 'get_hydrology_query_result', args: { task_id: task.task_id } }

}

export function hydrologyPlan(partial = false): TaskPlan {
  return { title: '主斜井水位分析', queries: [
    { id: 'history', prompt: '查询主斜井水位2025年9月前七天历史采样，返回测点、单位和监测时间，按时间升序。', depends_on: [], inputs: [] },
    ...(partial ? [{ id: 'realtime', prompt: '查询主斜井水位实时值和状态，不附加历史时间过滤。', depends_on: [], inputs: [] }] : []),
  ], charts: [{ id: 'history-chart', query_id: 'history', dataset: 'history', type: 'line', title: '主斜井水位历史趋势', x_field: 'time', value_field: 'value', series_field: 'point' }],
  report: { title: '主斜井水位监测分析', sections: ['历史变化', ...(partial ? ['当前状态'] : []), '综合结论'] } }
}

export class HydrologyAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  override listModels(provider: string) { return Promise.resolve([{ provider, id: 'fixture', name: 'Hydrology fixture' }]) }
  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const step = hydrologyStep(options.messages.map(message => ({ role: message.role, text: message.content.filter(block => block.type === 'text').map(block => block.text).join('\n') })), options.tools?.map(tool => tool.name) ?? [])
    if ('tool' in step) {
      const id = ToolCallId(`hydrology-${this.requests.length}`)
      const args = JSON.stringify(step.args)
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: step.tool, arguments: args } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
    } else {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: step.text } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
}
