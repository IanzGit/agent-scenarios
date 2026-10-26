/** 无密钥的固定模型响应，用于真实 Harness 循环的工具调用测试。 */
import { LlmAdapter, ToolCallId, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'

type Step = { tool: string; args: Record<string, string> } | { text: string }
export const recordings: Record<string, Step[]> = {
  overview: [
    { tool: 'skill', args: { name: 'water-hazard-overview' } },
    ...['get_device_status', 'get_device_alarm', 'get_model_warning', 'get_warning_statistics'].map(tool => ({ tool, args: {} })),
    { text: '# 矿井水文监测总体分析\n\n## 1. 监测设备情况\n\n设备共2套，在线1套，离线1套。\n\n## 2. 预警报警情况\n\n### 单因素超限报警\n\n单因素报警1条。\n\n### 多因素模型预警\n\n模型预警1条。\n\n### 预警报警统计\n\n预警共2条。明细以工具返回的完整 Markdown 表格为准。' },
  ],
  trend: [
    { tool: 'skill', args: { name: 'water-hazard-trend' } },
    { tool: 'get_hydrological_trend', args: {} },
    { text: '# 近30天水文监测指标趋势分析\n\n## 1. 监测时间范围\n\n2026-08-03 至 2026-09-01。\n\n## 2. 历史趋势\n\n四项水文指标均有2条有效记录，均值2.35m，最小值1.23m，最大值3.46m，预警0次。指标统计以工具返回的 Markdown 表格为准。' },
  ],
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
      const args = JSON.stringify(step.args)
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id, name: step.tool, argumentsDelta: args }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: step.tool, arguments: args } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
    } else {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: step.text }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: step.text } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
}
