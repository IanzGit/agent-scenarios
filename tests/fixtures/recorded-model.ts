/** 无密钥的固定模型响应，用于真实 Harness 循环的工具调用测试。 */
import { LlmAdapter, ToolCallId, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'

type Step = { tool: string; args: Record<string, string> } | { text: string }
const chart = (tool: string, dataset_id: string, title: string, x_field = 'category'): Step => ({ tool, args: { source_id: '$source', dataset_id, title, x_field, value_field: 'value' } })
export const recordings: Record<string, Step[]> = {
  overview: [
    { tool: 'skill', args: { name: 'water-hazard-overview' } },
    ...['get_device_status', 'get_device_alarm', 'get_model_warning', 'get_warning_statistics'].map(tool => ({ tool, args: {} })),
    chart('render_pie_chart', 'device_types', '水文监测设备类型数量占比'),
    chart('render_pie_chart', 'warning_types', '预警事件类型占比'),
    chart('render_pie_chart', 'warning_levels', '预警事件等级占比'),
    chart('render_bar_chart', 'warning_daily', '每日预警事件数量', 'time'),
    { text: '# 矿井水文监测总体分析\n\n## 1. 监测设备情况\n\n设备共2套，在线1套，离线1套。\n\n[图表:$chart0]\n\n## 2. 预警报警情况\n\n### 单因素超限报警\n\n单因素报警1条。\n\n### 多因素模型预警\n\n模型预警1条。\n\n### 预警报警统计\n\n预警共2条，统计分布以图表呈现。\n\n类型分布：\n\n[图表:$chart1]\n\n等级分布：\n\n[图表:$chart2]\n\n每日数量：\n\n[图表:$chart3]' },
  ],
  trend: [
    { tool: 'skill', args: { name: 'water-hazard-trend' } },
    { tool: 'get_hydrological_trend', args: {} },
    ...[['inflow', '矿井涌水量'], ['drainage', '矿井排水量'], ['borehole', 'ZK4长观孔水位'], ['sump', '中央水仓水位']].map(([id, title]) => chart('render_line_chart', id, `近30天${title}趋势图`, 'time')),
    { text: '# 近30天水文监测指标趋势分析\n\n## 1. 监测时间范围\n\n2026-08-03 至 2026-09-01。\n\n## 2. 历史趋势\n\n四项水文指标均有2条有效记录，均值2.35m，最小值1.23m，最大值3.46m，预警0次。指标统计以工具返回的 Markdown 表格为准。\n\n矿井涌水量：\n\n[图表:$chart0]\n\n矿井排水量：\n\n[图表:$chart1]\n\nZK4长观孔水位：\n\n[图表:$chart2]\n\n中央水仓水位：\n\n[图表:$chart3]' },
  ],
}

/** 从真实的模型可见目录取来源 ID，固定响应也不能绕过数据授权。 */
export function recordedArgs(args: Record<string, string>, observations: string[]): Record<string, string> {
  if (args.source_id !== '$source') return args
  const marker = '可绘图数据集（使用来源ID调用图表工具）：\n'
  for (const text of observations.toReversed()) {
    const offset = text.indexOf(marker)
    if (offset < 0) continue
    const catalog = JSON.parse(text.slice(offset + marker.length)) as { source_id: string; datasets: { id: string }[] }
    if (catalog.datasets.some(dataset => dataset.id === args.dataset_id)) return { ...args, source_id: catalog.source_id }
  }
  throw new Error(`模型未收到数据集目录：${args.dataset_id}`)
}

/** 固定模型同样从实际可见的成功工具结果复制图表 ID。 */
export function recordedText(text: string, observations: string[]): string {
  const ids = observations.flatMap(text => [...text.matchAll(/图表ID：([a-f0-9]{24})；状态：rendered/g)].map(match => match[1]))
  return text.replace(/\$chart(\d+)/g, (_match, index: string) => {
    const id = ids[Number(index)]
    if (!id) throw new Error(`模型未收到成功图表：${index}`)
    return id
  })
}

export class RecordedAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  private positions = new Map<string, number>()
  override listModels(provider: string) { return Promise.resolve([{ provider, id: 'fixture', name: 'Water hazard fixture' }]) }
  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    options.signal?.throwIfAborted()
    this.requests.push(options)
    const user = options.messages.find(message => message.role === 'user' && message.source?.kind === 'user')
    const prompt = user?.content.filter(block => block.type === 'text').map(block => block.text).join('') ?? ''
    const key = prompt.includes('趋势') ? 'trend' : 'overview'
    const position = this.positions.get(prompt) ?? 0
    this.positions.set(prompt, position + 1)
    const step = recordings[key][position]
    if (!step) throw new Error('固定模型响应已耗尽')
    if ('tool' in step) {
      const id = ToolCallId(`${key}-${position}`)
      const args = JSON.stringify(recordedArgs(step.args, options.messages.filter(message => message.role === 'tool').map(message => message.content.filter(block => block.type === 'text').map(block => block.text).join(''))))
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id, name: step.tool, argumentsDelta: args }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: step.tool, arguments: args } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
    } else {
      const text = recordedText(step.text, options.messages.filter(message => message.role === 'tool').map(message => message.content.filter(block => block.type === 'text').map(block => block.text).join('')))
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text }
      yield { type: 'block-end', index: 0, block: { type: 'text', text } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
}
