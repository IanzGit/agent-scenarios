/** 无密钥模型录制，驱动原生父子会话及最终图表引用。 */
import { LlmAdapter, ToolCallId, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { HISTORY, REALTIME, queryFor } from './hydrology.ts'

export function hydrologyStep(messages: { role: string; text: string; name?: string }[], tools: string[]): { tool: string; args: Record<string, unknown> } | { text: string } {
  const observations = messages.filter(message => message.role === 'tool').map(message => message.text)
  if (tools.includes('run_semantic_query')) {
    const prompt = messages.find(message => message.role === 'user')?.text ?? ''
    const model = prompt.includes('实时') ? REALTIME : HISTORY
    if (!observations.length) return { tool: 'search_semantic_catalog', args: {} }
    if (observations.length === 1) return { tool: 'search_semantic_catalog', args: { model_names: [model] } }
    return { tool: 'run_semantic_query', args: { query_goal: prompt, semantic_query: { ...queryFor(model),
      ...(model === HISTORY ? { time_dimensions: [{ dimension: `${model}.observed_at`, date_range: ['2025-09-01', '2025-09-07'] }], order: [{ member: `${model}.observed_at`, direction: 'asc' }] } : {}) } } }
  }
  const prompt = messages.find(message => message.role === 'user')?.text ?? ''
  const partial = prompt.includes('部分失败')
  if (!observations.length) return { tool: 'skill', args: { name: 'hydrology-single-point-recent' } }
  const ids = observations.flatMap(text => [...text.matchAll(/started subagent ([^\s]+)/g)].map(match => match[1]))
  if (!ids.length) return { tool: 'query_hydrology', args: { description: '主斜井水位历史', prompt: '查询主斜井水位2025年9月前七天历史采样，返回测点、单位和监测时间，按时间升序。' } }
  if (partial && ids.length < 2) return { tool: 'query_hydrology', args: { description: '主斜井水位实时', prompt: '查询主斜井水位实时值和状态，不附加历史时间过滤。' } }
  const completed = messages.filter(message => message.role === 'user' && message.text.includes('subagent') && /completed|finished|ended/.test(message.text)).map(message => message.text).join('\n')
  if (!ids.every(id => completed.includes(id))) return { text: '正在等待查询完成通知。' }
  const collected = observations.filter(text => text.includes('查询状态：'))
  if (collected.length < ids.length) return { tool: 'get_hydrology_query_result', args: { subagent_id: ids[collected.length] } }
  const available = observations.flatMap(text => {
    const marker = '可绘图数据集（使用来源ID调用图表工具）：\n'
    const position = text.indexOf(marker)
    if (position < 0) return []
    const source = JSON.parse(text.slice(position + marker.length)) as { source_id: string; datasets: { id: string; title: string }[] }
    return source.datasets.filter(dataset => dataset.id.startsWith('history_') && dataset.title.includes('（m）')).map(dataset => ({ source_id: source.source_id, dataset_id: dataset.id }))
  })
  const chart = observations.map(text => /图表ID：([a-f0-9]{24})；状态：rendered/.exec(text)).find(Boolean)?.[1]
  if (available.length && !chart) return { tool: 'render_line_chart', args: { ...available[0], title: '主斜井水位历史趋势', x_field: 'time', value_field: 'value', series_field: 'point' } }
  return { text: `# 主斜井水位监测分析\n\n## 历史变化\n\n${available.length ? `有效记录2条，最小值0m，最大值1.23m，均值0.62m。\n\n[图表:${chart}]` : '没有可展示的历史趋势；以查询状态说明为准。'}${partial ? '\n\n## 当前状态\n\n实时查询认证失败，保留已成功的历史分析，不据此判断运行正常。' : ''}` }
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
